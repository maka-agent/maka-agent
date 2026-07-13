import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { startProviderAuthProxy } from '../provider-auth-proxy.js';

test('provider auth proxy keeps the provider key host-side', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'maka-provider-proxy-'));
  const providerKey = 'provider-secret-key';
  let upstreamAuthorization = '';
  let upstreamPath = '';
  const upstream = createServer((request, response) => {
    upstreamAuthorization = request.headers.authorization ?? '';
    upstreamPath = request.url ?? '';
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end('{"ok":true}');
  });
  await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  const address = upstream.address();
  assert.ok(address && typeof address !== 'string');
  const keyFile = join(dir, 'provider-key');
  await writeFile(keyFile, `${providerKey}\n`, 'utf8');
  const proxy = await startProviderAuthProxy({
    upstreamBaseUrl: `http://127.0.0.1:${address.port}/api/v4`,
    apiKeyFile: keyFile,
    advertisedHost: '127.0.0.1',
  });

  try {
    assert.notEqual(proxy.token, providerKey);
    const unauthorized = await fetch(`${proxy.baseUrl}/chat/completions`, {
      method: 'POST',
      body: '{}',
    });
    assert.equal(unauthorized.status, 401);
    assert.equal(upstreamAuthorization, '');

    const response = await fetch(`${proxy.baseUrl}/chat/completions?stream=true`, {
      method: 'POST',
      headers: { authorization: `Bearer ${proxy.token}`, 'content-type': 'application/json' },
      body: '{}',
    });
    assert.equal(response.status, 200);
    assert.equal(await response.text(), '{"ok":true}');
    assert.equal(upstreamAuthorization, `Bearer ${providerKey}`);
    assert.equal(upstreamPath, '/api/v4/chat/completions?stream=true');
  } finally {
    await proxy.close();
    await new Promise<void>((resolve, reject) => upstream.close((error) => error ? reject(error) : resolve()));
    await rm(dir, { recursive: true, force: true });
  }
});

test('provider auth proxy aborts an in-flight upstream request on close', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'maka-provider-proxy-close-'));
  let received!: () => void;
  const requestReceived = new Promise<void>((resolve) => { received = resolve; });
  const upstream = createServer(() => { received(); });
  await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  const address = upstream.address();
  assert.ok(address && typeof address !== 'string');
  const keyFile = join(dir, 'provider-key');
  await writeFile(keyFile, 'provider-secret-key\n', 'utf8');
  const proxy = await startProviderAuthProxy({
    upstreamBaseUrl: `http://127.0.0.1:${address.port}/api/v4`,
    apiKeyFile: keyFile,
    advertisedHost: '127.0.0.1',
  });
  const pending = fetch(`${proxy.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { authorization: `Bearer ${proxy.token}` },
    body: '{}',
  });

  try {
    await requestReceived;
    await Promise.race([
      proxy.close(),
      new Promise((_, reject) => setTimeout(() => reject(new Error('proxy close timed out')), 1_000)),
    ]);
    await assert.rejects(pending);
  } finally {
    upstream.closeAllConnections();
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
  }
});
