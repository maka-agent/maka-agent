import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { expect } from '../../test-helpers.js';
import { PROXY_DEFAULTS } from '@maka/core/settings/network-settings';
import { testProxyConnection } from '../proxy-test.js';

describe('testProxyConnection', () => {
  test('returns disabled error when proxy is disabled', async () => {
    const result = await testProxyConnection({});
    expect(result.ok).toBe(false);
    expect(result.error).toBe('Proxy disabled');
  });

  test('returns missing host/port error when enabled but empty', async () => {
    const result = await testProxyConnection({
      proxy: { ...PROXY_DEFAULTS, enabled: true, host: '', port: 0 },
    });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/host.*port/i);
  });

  test('returns an error when the proxy host refuses connections', async () => {
    const result = await testProxyConnection({
      proxy: { ...PROXY_DEFAULTS, enabled: true, type: 'http', host: '127.0.0.1', port: 1 },
      url: 'http://example.com',
      timeoutMs: 1_000,
    });

    expect(result.ok).toBe(false);
    expect(result.error ?? '').toMatch(/ECONNREFUSED|fetch failed|bad port|timeout/i);
  });

  test('times out when the proxy accepts TCP but never responds', async () => {
    const sockets = new Set<net.Socket>();
    const server = net.createServer((socket) => {
      sockets.add(socket);
      socket.on('close', () => sockets.delete(socket));
      socket.on('error', () => sockets.delete(socket));
      // Intentionally never write an HTTP response. This is a
      // deterministic proxy timeout fixture; DNS failures can return
      // "fetch failed" before the timeout on some machines.
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => resolve());
    });
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    const started = Date.now();
    try {
      const result = await testProxyConnection({
        proxy: {
          ...PROXY_DEFAULTS,
          enabled: true,
          type: 'http',
          host: '127.0.0.1',
          port: address.port,
        },
        url: 'http://example.com',
        timeoutMs: 100,
      });

      expect(result.ok).toBe(false);
      expect(result.error ?? '').toMatch(/timeout|fetch failed/i);
      assert.ok(Date.now() - started < 2_000);
    } finally {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
