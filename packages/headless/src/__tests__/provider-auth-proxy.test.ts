import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { startProviderAuthProxy, summarizeProviderTelemetry } from '../provider-auth-proxy.js';

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
    await new Promise<void>((resolve, reject) =>
      upstream.close((error) => (error ? reject(error) : resolve())),
    );
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
    await new Promise<void>((resolve, reject) =>
      upstream.close((error) => (error ? reject(error) : resolve())),
    );
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
    await new Promise<void>((resolve, reject) =>
      upstream.close((error) => (error ? reject(error) : resolve())),
    );
    await rm(dir, { recursive: true, force: true });
  }
});

test('provider auth proxy totals OpenAI chat streaming usage without changing the response bytes', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'maka-provider-proxy-openai-usage-'));
  const stream = [
    'data: {"id":"chatcmpl-1","choices":[],"usage":{"prompt_tokens":100,"completion_tokens":25,"prompt_tokens_details":{"cached_tokens":20},"completion_tokens_details":{"reasoning_tokens":15}}}',
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
      reasoning: 15,
    });
  } finally {
    await proxy.close();
    await new Promise<void>((resolve, reject) =>
      upstream.close((error) => (error ? reject(error) : resolve())),
    );
    await rm(dir, { recursive: true, force: true });
  }
});

test('provider telemetry summarizes output, reasoning, and stream-stall evidence', () => {
  assert.deepEqual(
    summarizeProviderTelemetry([
      {
        requestId: 1,
        method: 'POST',
        path: '/chat/completions',
        protocol: 'openai-chat-sse',
        status: 200,
        outcome: 'completed',
        firstOutputTokenMs: 250,
        lastOutputTokenMs: 350,
        firstReasoningTokenMs: 250,
        lastReasoningTokenMs: 300,
        reasoningEndMs: 450,
        maxBodyChunkGapMs: 175,
        durationMs: 500,
        bodyChunks: 4,
        responseBytes: 254,
        terminalEvent: true,
        usage: { input: 100, cacheRead: 0, cacheWrite: 0, output: 25, reasoning: 15 },
      },
    ]),
    {
      requests: 1,
      completed: 1,
      interrupted: 0,
      failed: 0,
      aborted: 0,
      inputTokens: 100,
      outputTokens: 25,
      reasoningTokens: 15,
      usageMeasuredRequests: 1,
      reasoningMeasuredRequests: 1,
      outputTokensPerSecond: 250,
      reasoningTokensPerSecond: 300,
      maxBodyChunkGapMs: 175,
    },
  );
});

test('provider auth proxy records token timing, stream stalls, and clean completion', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'maka-provider-proxy-telemetry-'));
  let clock = 1_000;
  const upstream = createServer(async (_request, response) => {
    clock = 1_100;
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.flushHeaders();
    await new Promise<void>((resolve) => setImmediate(resolve));
    clock = 1_250;
    response.write('data: {"choices":[{"delta":{"reasoning_content":"think"}}]}\n\n');
    await new Promise<void>((resolve) => setImmediate(resolve));
    clock = 1_500;
    response.write('data: {"choices":[{"delta":{"content":"answer"}}]}\n\n');
    await new Promise<void>((resolve) => setImmediate(resolve));
    clock = 1_700;
    response.write(
      'data: {"choices":[],"usage":{"prompt_tokens":100,"completion_tokens":25,"completion_tokens_details":{"reasoning_tokens":15}}}\n\n',
    );
    await new Promise<void>((resolve) => setImmediate(resolve));
    clock = 1_750;
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
    usageProtocol: 'openai-chat-sse',
    now: () => clock,
  });

  try {
    const response = await fetch(`${proxy.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${proxy.token}` },
      body: '{}',
    });
    await response.text();
    const [request] = proxy.telemetry();
    assert.ok(request);
    assert.equal(request.outcome, 'completed');
    assert.equal(request.terminalEvent, true);
    assert.ok(request.responseHeadersMs! <= request.firstBodyChunkMs!);
    assert.ok(request.firstBodyChunkMs! <= request.firstOutputTokenMs!);
    assert.ok(request.firstOutputTokenMs! <= request.lastOutputTokenMs!);
    assert.ok(request.firstReasoningTokenMs! <= request.lastReasoningTokenMs!);
    assert.ok(request.lastOutputTokenMs! <= request.durationMs);
    assert.ok(request.maxBodyChunkGapMs! >= 0);
    assert.deepEqual(request.usage, {
      input: 100,
      cacheRead: 0,
      cacheWrite: 0,
      output: 25,
      reasoning: 15,
    });
  } finally {
    await proxy.close();
    await new Promise<void>((resolve, reject) =>
      upstream.close((error) => (error ? reject(error) : resolve())),
    );
    await rm(dir, { recursive: true, force: true });
  }
});

test('provider auth proxy marks a stream without its terminal event as interrupted', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'maka-provider-proxy-interrupted-'));
  const upstream = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.end('data: {"choices":[{"delta":{"content":"partial"}}]}\n\n');
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
    assert.equal(proxy.telemetry()[0]?.outcome, 'interrupted');
  } finally {
    await proxy.close();
    await new Promise<void>((resolve, reject) =>
      upstream.close((error) => (error ? reject(error) : resolve())),
    );
    await rm(dir, { recursive: true, force: true });
  }
});

test('provider auth proxy marks an upstream HTTP error as failed', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'maka-provider-proxy-http-error-'));
  const upstream = createServer((_request, response) => {
    response.writeHead(429, { 'content-type': 'application/json' });
    response.end('{"error":"rate_limited"}');
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

  try {
    const response = await fetch(`${proxy.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${proxy.token}` },
      body: '{}',
    });
    assert.equal(response.status, 429);
    await response.text();
    assert.equal(proxy.telemetry()[0]?.outcome, 'failed');
  } finally {
    await proxy.close();
    await new Promise<void>((resolve, reject) =>
      upstream.close((error) => (error ? reject(error) : resolve())),
    );
    await rm(dir, { recursive: true, force: true });
  }
});

test('provider auth proxy forwards streaming response headers before the first body chunk', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'maka-provider-proxy-stream-headers-'));
  let upstreamHeadersSent!: () => void;
  let releaseBody!: () => void;
  const headersSent = new Promise<void>((resolve) => {
    upstreamHeadersSent = resolve;
  });
  const bodyReleased = new Promise<void>((resolve) => {
    releaseBody = resolve;
  });
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
    await new Promise<void>((resolve, reject) =>
      upstream.close((error) => (error ? reject(error) : resolve())),
    );
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
    await new Promise<void>((resolve, reject) =>
      upstream.close((error) => (error ? reject(error) : resolve())),
    );
    await rm(dir, { recursive: true, force: true });
  }
});

test('provider auth proxy aborts an in-flight upstream request on close', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'maka-provider-proxy-close-'));
  let received!: () => void;
  const requestReceived = new Promise<void>((resolve) => {
    received = resolve;
  });
  const upstream = createServer(() => {
    received();
  });
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
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('proxy close timed out')), 1_000),
      ),
    ]);
    await assert.rejects(pending);
    assert.equal(proxy.telemetry()[0]?.outcome, 'aborted');
  } finally {
    upstream.closeAllConnections();
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
  }
});

test('provider auth proxy aborts the upstream stream when its client disconnects', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'maka-provider-proxy-client-disconnect-'));
  let upstreamClosed!: () => void;
  const upstreamResponseClosed = new Promise<void>((resolve) => {
    upstreamClosed = resolve;
  });
  const upstream = createServer((_request, response) => {
    response.once('close', upstreamClosed);
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.write('data: {"choices":[{"delta":{"content":"partial"}}]}\n\n');
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
  const controller = new AbortController();

  try {
    const response = await fetch(`${proxy.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${proxy.token}` },
      body: '{}',
      signal: controller.signal,
    });
    const firstChunk = await response.body?.getReader().read();
    assert.equal(firstChunk?.done, false);
    controller.abort();
    await Promise.race([
      upstreamResponseClosed,
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('upstream stream was not aborted')), 1_000),
      ),
    ]);
    assert.equal(proxy.telemetry()[0]?.outcome, 'aborted');
  } finally {
    controller.abort();
    await proxy.close();
    upstream.closeAllConnections();
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
  }
});
