import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import net from 'node:net';
import { PROXY_DEFAULTS, type ProxySettings } from '@maka/core/settings/network-settings';
import { setActiveProxy } from '../../network/active-proxy-state.js';
import { createProxiedFetchTransport, proxiedFetch } from '../proxied-fetch.js';

function listen(server: net.Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      assert.ok(address && typeof address === 'object');
      resolve(address.port);
    });
  });
}

function waitForSocketClose(socket: net.Socket): Promise<void> {
  if (socket.destroyed) return Promise.resolve();
  return new Promise((resolve) => socket.once('close', () => resolve()));
}

async function withTimeout<T>(promise: Promise<T>, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(message)), 1_000);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

describe('proxiedFetch', () => {
  test('times out and destroys stuck active proxy dispatchers', async () => {
    const sockets = new Set<net.Socket>();
    const proxy = net.createServer((socket) => {
      sockets.add(socket);
      socket.on('close', () => sockets.delete(socket));
      socket.on('error', () => sockets.delete(socket));
      // Accept the proxy TCP connection, then never respond. This
      // exercises proxiedFetch's timeout path without relying on DNS
      // behavior for invalid hostnames.
    });
    await new Promise<void>((resolve, reject) => {
      proxy.once('error', reject);
      proxy.listen(0, '127.0.0.1', () => resolve());
    });
    const address = proxy.address();
    assert.ok(address && typeof address === 'object');
    setActiveProxy({
      ...PROXY_DEFAULTS,
      enabled: true,
      type: 'http',
      host: '127.0.0.1',
      port: address.port,
    });
    const started = Date.now();

    try {
      await assert.rejects(
        () => proxiedFetch('http://example.com', { timeoutMs: 100 }),
        /timeout/i,
      );
      assert.ok(Date.now() - started < 2_000);
    } finally {
      setActiveProxy(null);
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => proxy.close(() => resolve()));
    }
  });

  test('timeoutMs 0 disables the internal timeout for streaming callers', async () => {
    const server = createServer((_req, res) => {
      setTimeout(() => {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('ok');
      }, 40);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    assert.ok(address && typeof address === 'object');

    try {
      const response = await proxiedFetch(`http://127.0.0.1:${address.port}`, { timeoutMs: 0 });
      assert.equal(response.status, 200);
      assert.equal(await response.text(), 'ok');
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });

  test('keeps a captured proxy alive until explicit close ends a streaming connection', async () => {
    const originSockets = new Set<net.Socket>();
    const origin = createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.write('first chunk');
    });
    origin.on('connection', (socket) => {
      originSockets.add(socket);
      socket.on('close', () => originSockets.delete(socket));
    });

    const proxySockets = new Set<net.Socket>();
    let capturedProxySocket: net.Socket | undefined;
    const proxy = net.createServer((client) => {
      proxySockets.add(client);
      capturedProxySocket = client;
      client.on('close', () => proxySockets.delete(client));

      let pending = Buffer.alloc(0);
      const readProxyRequest = (chunk: Buffer) => {
        pending = Buffer.concat([pending, chunk]);
        const headerEnd = pending.indexOf('\r\n\r\n');
        if (headerEnd < 0) return;
        client.pause();
        client.off('data', readProxyRequest);

        const requestHead = pending.subarray(0, headerEnd).toString('latin1');
        const requestLineEnd = requestHead.indexOf('\r\n');
        const requestLine = requestHead.slice(0, requestLineEnd);
        const [method, target, version] = requestLine.split(' ');
        assert.ok(
          method && target && /^HTTP\/1\.[01]$/.test(version ?? ''),
          `Unexpected proxy request: ${requestLine}`,
        );

        const destination = new URL(method === 'CONNECT' ? `http://${target}` : target);
        assert.equal(destination.protocol, 'http:');
        const upstream = net.connect(Number(destination.port || 80), destination.hostname, () => {
          if (method === 'CONNECT') {
            client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
          } else {
            const originTarget = `${destination.pathname}${destination.search}`;
            upstream.write(
              `${method} ${originTarget} ${version}${requestHead.slice(requestLineEnd)}\r\n\r\n`,
              'latin1',
            );
          }
          const remainder = pending.subarray(headerEnd + 4);
          if (remainder.length > 0) upstream.write(remainder);
          client.pipe(upstream).pipe(client);
          client.resume();
        });
        upstream.on('error', () => client.destroy());
        client.on('close', () => upstream.destroy());
      };
      client.on('data', readProxyRequest);
    });

    const originPort = await listen(origin);
    const proxyPort = await listen(proxy);
    const settings: ProxySettings = {
      ...PROXY_DEFAULTS,
      enabled: true,
      type: 'http',
      host: '127.0.0.1',
      port: proxyPort,
      bypassList: [],
    };
    const transport = createProxiedFetchTransport(settings);
    settings.port = 1;

    try {
      const response = await transport.fetch(`http://127.0.0.1:${originPort}/stream`);
      assert.equal(response.status, 200);
      const first = await response.body?.getReader().read();
      assert.equal(Buffer.from(first?.value ?? []).toString(), 'first chunk');
      assert.ok(capturedProxySocket && !capturedProxySocket.destroyed);

      const socketClosed = waitForSocketClose(capturedProxySocket);
      await withTimeout(
        Promise.all([transport.close(), socketClosed]),
        'Transport close deadlocked',
      );
      assert.equal(proxySockets.size, 0);
    } finally {
      await transport.close();
      for (const socket of proxySockets) socket.destroy();
      for (const socket of originSockets) socket.destroy();
      await Promise.all([
        new Promise<void>((resolve) => proxy.close(() => resolve())),
        new Promise<void>((resolve) => origin.close(() => resolve())),
      ]);
    }
  });
});
