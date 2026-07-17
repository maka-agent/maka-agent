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

test('provider auth proxy supports Anthropic x-api-key without replacing the client user agent', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'maka-provider-proxy-anthropic-'));
  const providerKey = 'anthropic-provider-secret';
  let upstreamApiKey = '';
  let upstreamAuthorization = '';
  let upstreamUserAgent = '';
  const upstream = createServer((request, response) => {
    upstreamApiKey = String(request.headers['x-api-key'] ?? '');
    upstreamAuthorization = request.headers.authorization ?? '';
    upstreamUserAgent = request.headers['user-agent'] ?? '';
    response.writeHead(200).end('ok');
  });
  await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  const address = upstream.address();
  assert.ok(address && typeof address !== 'string');
  const keyFile = join(dir, 'provider-key');
  await writeFile(keyFile, `${providerKey}\n`, 'utf8');
  const proxy = await startProviderAuthProxy({
    upstreamBaseUrl: `http://127.0.0.1:${address.port}/coding/v1`,
    apiKeyFile: keyFile,
    advertisedHost: '127.0.0.1',
    authMode: 'x-api-key',
  });

  try {
    const response = await fetch(`${proxy.baseUrl}/messages`, {
      method: 'POST',
      headers: {
        'x-api-key': proxy.token,
        'user-agent': 'opencode/1.17.18 ai-sdk/6',
      },
      body: '{}',
    });
    assert.equal(response.status, 200);
    assert.equal(upstreamApiKey, providerKey);
    assert.equal(upstreamAuthorization, '');
    assert.equal(upstreamUserAgent, 'opencode/1.17.18 ai-sdk/6');
  } finally {
    await proxy.close();
    await new Promise<void>((resolve, reject) => upstream.close((error) => error ? reject(error) : resolve()));
    await rm(dir, { recursive: true, force: true });
  }
});

test('provider auth proxy totals Anthropic streaming usage without changing the response bytes', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'maka-provider-proxy-usage-'));
  const stream = [
    'event: message_start',
    'data: {"type":"message_start","message":{"usage":{"input_tokens":70,"cache_creation_input_tokens":10,"cache_read_input_tokens":20,"output_tokens":1}}}',
    '',
    'event: message_delta',
    'data: {"type":"message_delta","usage":{"output_tokens":25}}',
    '',
  ].join('\n');
  const upstream = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.write(stream.slice(0, 91));
    response.end(stream.slice(91));
  });
  await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  const address = upstream.address();
  assert.ok(address && typeof address !== 'string');
  const keyFile = join(dir, 'provider-key');
  await writeFile(keyFile, 'provider-secret-key\n', 'utf8');
  const proxy = await startProviderAuthProxy({
    upstreamBaseUrl: `http://127.0.0.1:${address.port}`,
    apiKeyFile: keyFile,
    advertisedHost: '127.0.0.1',
    usageProtocol: 'anthropic-sse',
  });

  try {
    const response = await fetch(`${proxy.baseUrl}/messages`, {
      method: 'POST',
      headers: { authorization: `Bearer ${proxy.token}` },
      body: '{}',
    });
    assert.equal(await response.text(), stream);
    assert.deepEqual(proxy.usage(), {
      input: 100,
      cacheRead: 20,
      cacheWrite: 10,
      output: 25,
    });
  } finally {
    await proxy.close();
    await new Promise<void>((resolve, reject) => upstream.close((error) => error ? reject(error) : resolve()));
    await rm(dir, { recursive: true, force: true });
  }
});

test('provider auth proxy totals OpenAI chat streaming usage without changing the response bytes', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'maka-provider-proxy-openai-usage-'));
  const stream = [
    'data: {"id":"chatcmpl-1","choices":[],"usage":{"prompt_tokens":100,"completion_tokens":25,"prompt_tokens_details":{"cached_tokens":20}}}',
    '',
    'data: [DONE]',
    '',
  ].join('\n');
  const upstream = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.write(stream.slice(0, 73));
    response.end(stream.slice(73));
  });
  await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  const address = upstream.address();
  assert.ok(address && typeof address !== 'string');
  const keyFile = join(dir, 'provider-key');
  await writeFile(keyFile, 'provider-secret-key\n', 'utf8');
  const proxy = await startProviderAuthProxy({
    upstreamBaseUrl: `http://127.0.0.1:${address.port}`,
    apiKeyFile: keyFile,
    advertisedHost: '127.0.0.1',
    usageProtocol: 'openai-chat-sse',
  });

  try {
    const response = await fetch(`${proxy.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${proxy.token}` },
      body: '{}',
    });
    assert.equal(await response.text(), stream);
    assert.deepEqual(proxy.usage(), {
      input: 100,
      cacheRead: 20,
      cacheWrite: 0,
      output: 25,
    });
  } finally {
    await proxy.close();
    await new Promise<void>((resolve, reject) => upstream.close((error) => error ? reject(error) : resolve()));
    await rm(dir, { recursive: true, force: true });
  }
});

test('provider auth proxy forwards streaming response headers before the first body chunk', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'maka-provider-proxy-stream-headers-'));
  let upstreamHeadersSent!: () => void;
  let releaseBody!: () => void;
  const headersSent = new Promise<void>((resolve) => { upstreamHeadersSent = resolve; });
  const bodyReleased = new Promise<void>((resolve) => { releaseBody = resolve; });
  const upstream = createServer(async (_request, response) => {
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.flushHeaders();
    upstreamHeadersSent();
    await bodyReleased;
    response.end('data: [DONE]\n\n');
  });
  await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  const address = upstream.address();
  assert.ok(address && typeof address !== 'string');
  const keyFile = join(dir, 'provider-key');
  await writeFile(keyFile, 'provider-secret-key\n', 'utf8');
  const proxy = await startProviderAuthProxy({
    upstreamBaseUrl: `http://127.0.0.1:${address.port}`,
    apiKeyFile: keyFile,
    advertisedHost: '127.0.0.1',
  });
  const pendingResponse = fetch(`${proxy.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { authorization: `Bearer ${proxy.token}` },
    body: '{}',
  });

  try {
    await headersSent;
    const headersForwarded = await Promise.race([
      pendingResponse.then(() => true),
      new Promise<false>((resolve) => setTimeout(() => resolve(false), 250)),
    ]);
    releaseBody();
    const response = await pendingResponse;
    assert.equal(headersForwarded, true, 'proxy held response headers until the first body chunk');
    assert.equal(await response.text(), 'data: [DONE]\n\n');
  } finally {
    releaseBody();
    await proxy.close();
    await new Promise<void>((resolve, reject) => upstream.close((error) => error ? reject(error) : resolve()));
    await rm(dir, { recursive: true, force: true });
  }
});

test('provider auth proxy keeps unknown streaming usage schemas missing', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'maka-provider-proxy-unknown-usage-'));
  const upstream = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.end('data: {"choices":[],"usage":{"unknown_tokens":99}}\n\n');
  });
  await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  const address = upstream.address();
  assert.ok(address && typeof address !== 'string');
  const keyFile = join(dir, 'provider-key');
  await writeFile(keyFile, 'provider-secret-key\n', 'utf8');
  const proxy = await startProviderAuthProxy({
    upstreamBaseUrl: `http://127.0.0.1:${address.port}`,
    apiKeyFile: keyFile,
    advertisedHost: '127.0.0.1',
    usageProtocol: 'openai-chat-sse',
  });

  try {
    const response = await fetch(`${proxy.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${proxy.token}` },
      body: '{}',
    });
    await response.text();
    assert.equal(proxy.usage(), null);
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
