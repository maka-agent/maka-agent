import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { after, describe, test } from 'node:test';
import {
  OpenAIResponsesTransport,
  createOpenAIResponsesTransport,
} from '../openai-responses-transport.js';
import type { OpenAIComputerRequest } from '../openai-computer-codec.js';

const servers: Array<{ close(): Promise<void> }> = [];
const request = (over: Partial<OpenAIComputerRequest> = {}): OpenAIComputerRequest => ({
  ...over,
  model: over.model ?? 'gpt-test',
  instructions: over.instructions ?? 'test policy',
  tools: over.tools ?? [{ type: 'computer' }],
  input: over.input ?? 'hello',
  parallel_tool_calls: false,
  store: false,
});

after(async () => {
  await Promise.all(servers.map((server) => server.close()));
});

describe('OpenAIResponsesTransport', () => {
  test('posts JSON to /v1/responses with auth, custom headers, and query params', async () => {
    let observedBody: unknown;
    const server = await startServer(async (request, response) => {
      observedBody = JSON.parse(await readBody(request));
      assert.equal(request.method, 'POST');
      assert.equal(request.url, '/v1/responses?existing=yes&region=us&store=false');
      assert.equal(request.headers.authorization, 'Bearer test-api-key');
      assert.equal(request.headers['content-type'], 'application/json');
      assert.equal(request.headers['x-client'], 'maka');
      respond(response, 200, JSON.stringify({ id: 'resp_1', output: [] }));
    });
    const transport = createOpenAIResponsesTransport({
      baseUrl: `${server.url}/v1?existing=yes`,
      apiKey: 'test-api-key',
      headers: { 'x-client': 'maka' },
      queryParams: { region: 'us', store: false, omitted: undefined },
    });

    const result = await transport.create(request(), new AbortController().signal);

    assert.deepEqual(observedBody, request());
    assert.deepEqual(result, { id: 'resp_1', output: [] });
  });

  test('accepts a root base URL, bearer token, and a custom authorization header', async () => {
    const observedAuth: string[] = [];
    const server = await startServer((request, response) => {
      observedAuth.push(request.headers.authorization ?? '');
      assert.equal(request.url, '/v1/responses');
      respond(response, 200, '{}');
    });

    const bearerTransport = new OpenAIResponsesTransport({
      baseUrl: server.url,
      bearerToken: 'bearer-token',
    });
    await bearerTransport.create(request(), new AbortController().signal);

    const headerTransport = new OpenAIResponsesTransport({
      baseUrl: `${server.url}/v1/responses`,
      headers: { authorization: 'Bearer custom-token' },
    });
    await headerTransport.create(request(), new AbortController().signal);

    assert.deepEqual(observedAuth, ['Bearer bearer-token', 'Bearer custom-token']);
  });

  test('throws a bounded, redacted error for non-2xx responses', async () => {
    const apiKey = 'sk-live-secret-value';
    const querySecret = 'query-secret-value';
    const server = await startServer((_request, response) => {
      response.statusCode = 401;
      response.statusMessage = `Unauthorized ${apiKey}`;
      response.end(
        JSON.stringify({
          error: `authorization Bearer ${apiKey}`,
          query: querySecret,
          padding: 'x'.repeat(2_000),
        }),
      );
    });
    const transport = new OpenAIResponsesTransport({
      baseUrl: server.url,
      apiKey,
      queryParams: { api_key: querySecret },
    });

    await assert.rejects(
      () => transport.create(request(), new AbortController().signal),
      (error) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /^openai_responses_http_error: 401 Unauthorized \[redacted\]:/);
        assert.match(error.message, /\[redacted\]/);
        assert.match(error.message, /\[truncated\]$/);
        assert.doesNotMatch(error.message, new RegExp(apiKey));
        assert.doesNotMatch(error.message, new RegExp(querySecret));
        assert.ok(error.message.length < 1_100);
        return true;
      },
    );
  });

  test('rejects malformed success JSON without including the response body', async () => {
    const server = await startServer((_request, response) => {
      respond(response, 200, 'not-json secret=must-not-leak');
    });
    const transport = new OpenAIResponsesTransport({ baseUrl: server.url });

    await assert.rejects(
      () => transport.create(request(), new AbortController().signal),
      (error) => {
        assert.ok(error instanceof Error);
        assert.equal(error.message, 'openai_responses_malformed_json');
        assert.doesNotMatch(error.message, /must-not-leak/);
        return true;
      },
    );
  });

  test('passes AbortSignal to fetch', async () => {
    const server = await startServer((_request, response) => {
      setTimeout(() => respond(response, 200, '{}'), 1_000);
    });
    const transport = new OpenAIResponsesTransport({ baseUrl: server.url });
    const controller = new AbortController();
    const pending = transport.create(request(), controller.signal);
    controller.abort();

    await assert.rejects(pending, (error) => {
      assert.ok(error instanceof Error);
      assert.equal(error.name, 'AbortError');
      return true;
    });
  });

  test('rejects an oversized response before parsing or logging it', async () => {
    const server = await startServer((_request, response) => {
      response.setHeader('content-length', String(17 * 1024 * 1024));
      response.end('{}');
    });
    const transport = new OpenAIResponsesTransport({ baseUrl: server.url });

    await assert.rejects(() => transport.create(request(), new AbortController().signal), {
      message: 'openai_responses_body_too_large',
    });
  });
});

async function startServer(
  handler: (request: IncomingMessage, response: ServerResponse) => void | Promise<void>,
): Promise<{ url: string; close(): Promise<void> }> {
  const server = createServer((request, response) => {
    void Promise.resolve(handler(request, response)).catch((error) => {
      response.destroy(error instanceof Error ? error : new Error(String(error)));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('test server did not bind');
  const tracked = {
    url: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
  servers.push(tracked);
  return tracked;
}

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8');
}

function respond(
  response: ServerResponse,
  status: number,
  body: string,
  statusMessage?: string,
): void {
  response.statusCode = status;
  if (statusMessage) response.statusMessage = statusMessage;
  response.setHeader('content-type', 'application/json');
  response.end(body);
}
