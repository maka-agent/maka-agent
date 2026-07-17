import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { Socket } from 'node:net';

export interface ProviderAuthProxy {
  baseUrl: string;
  token: string;
  usage(): ProviderTokenUsage | null;
  close(): Promise<void>;
}

export interface ProviderTokenUsage {
  input: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
}

export type ProviderAuthProxyMode = 'bearer' | 'x-api-key';
export type ProviderUsageProtocol = 'anthropic-sse' | 'openai-chat-sse';

export async function startProviderAuthProxy(input: {
  upstreamBaseUrl: string;
  apiKeyFile: string;
  advertisedHost?: string;
  authMode?: ProviderAuthProxyMode;
  usageProtocol?: ProviderUsageProtocol;
}): Promise<ProviderAuthProxy> {
  const upstreamBaseUrl = new URL(input.upstreamBaseUrl);
  if (upstreamBaseUrl.protocol !== 'https:' && upstreamBaseUrl.protocol !== 'http:') {
    throw new Error(`provider auth proxy requires an HTTP(S) upstream: ${upstreamBaseUrl.protocol}`);
  }
  const providerKey = (await readFile(input.apiKeyFile, 'utf8')).trim();
  if (providerKey.length === 0) throw new Error('provider API key file is empty');
  const authMode = input.authMode ?? 'bearer';
  const token = randomBytes(32).toString('hex');
  const usage = new ProviderUsageAccumulator();
  const activeRequests = new Set<AbortController>();
  const sockets = new Set<Socket>();
  const server = createServer((request, response) => {
    const controller = new AbortController();
    activeRequests.add(controller);
    void forwardProviderRequest({
      request,
      response,
      upstreamBaseUrl,
      providerKey,
      token,
      authMode,
      usageProtocol: input.usageProtocol,
      usage,
      signal: controller.signal,
    }).finally(() => activeRequests.delete(controller));
  });
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '0.0.0.0', () => {
      server.off('error', reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    server.close();
    throw new Error('provider auth proxy did not bind a TCP port');
  }
  const advertisedHost = input.advertisedHost ?? 'host.docker.internal';
  return {
    baseUrl: `http://${advertisedHost}:${address.port}`,
    token,
    usage: () => usage.snapshot(),
    close: async () => {
      const closed = new Promise<void>((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
      });
      for (const controller of activeRequests) controller.abort();
      for (const socket of sockets) socket.destroy();
      await closed;
    },
  };
}

async function forwardProviderRequest(input: {
  request: IncomingMessage;
  response: ServerResponse;
  upstreamBaseUrl: URL;
  providerKey: string;
  token: string;
  authMode: ProviderAuthProxyMode;
  usageProtocol?: ProviderUsageProtocol;
  usage: ProviderUsageAccumulator;
  signal: AbortSignal;
}): Promise<void> {
  try {
    const presentedCredential = input.authMode === 'x-api-key'
      ? input.request.headers['x-api-key']
      : input.request.headers.authorization;
    if (!authorized(presentedCredential, input.token, input.authMode)) {
      input.response.writeHead(401).end('unauthorized');
      return;
    }
    const incomingUrl = new URL(input.request.url ?? '/', 'http://provider-proxy');
    const upstreamUrl = new URL(input.upstreamBaseUrl);
    upstreamUrl.pathname = `${upstreamUrl.pathname.replace(/\/$/, '')}/${incomingUrl.pathname.replace(/^\//, '')}`;
    upstreamUrl.search = incomingUrl.search;
    const headers = new Headers();
    for (const [name, value] of Object.entries(input.request.headers)) {
      if (value === undefined || REQUEST_HEADER_DENYLIST.has(name.toLowerCase())) continue;
      if (Array.isArray(value)) value.forEach((item) => headers.append(name, item));
      else headers.set(name, value);
    }
    if (input.authMode === 'x-api-key') headers.set('x-api-key', input.providerKey);
    else headers.set('authorization', `Bearer ${input.providerKey}`);
    const body = input.request.method === 'GET' || input.request.method === 'HEAD'
      ? undefined
      : await readRequestBody(input.request);
    const upstreamResponse = await fetch(upstreamUrl, {
      method: input.request.method,
      headers,
      signal: input.signal,
      ...(body ? { body: new Uint8Array(body) } : {}),
    });
    const responseHeaders: Record<string, string> = {};
    upstreamResponse.headers.forEach((value, name) => {
      if (!HOP_BY_HOP_HEADERS.has(name.toLowerCase())) responseHeaders[name] = value;
    });
    input.response.writeHead(upstreamResponse.status, responseHeaders);
    input.response.flushHeaders();
    const responseUsage = input.usageProtocol
      && upstreamResponse.headers.get('content-type')?.includes('text/event-stream')
      ? new SseUsageParser(input.usageProtocol)
      : null;
    if (upstreamResponse.body) {
      for await (const chunk of upstreamResponse.body) {
        responseUsage?.push(chunk);
        input.response.write(chunk);
      }
    }
    if (upstreamResponse.ok && responseUsage) input.usage.add(responseUsage.finish());
    input.response.end();
  } catch {
    if (input.response.destroyed) return;
    if (!input.response.headersSent) input.response.writeHead(502);
    input.response.end('provider proxy request failed');
  }
}

class ProviderUsageAccumulator {
  private readonly total: ProviderTokenUsage = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 };
  private sawUsage = false;

  add(usage: ProviderTokenUsage | null): void {
    if (!usage) return;
    this.sawUsage = true;
    this.total.input += usage.input;
    this.total.cacheRead += usage.cacheRead;
    this.total.cacheWrite += usage.cacheWrite;
    this.total.output += usage.output;
  }

  snapshot(): ProviderTokenUsage | null {
    return this.sawUsage ? { ...this.total } : null;
  }
}

class SseUsageParser {
  private readonly decoder = new TextDecoder();
  private buffer = '';
  private readonly usage: ProviderTokenUsage = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 };
  private sawUsage = false;

  constructor(private readonly protocol: ProviderUsageProtocol) {}

  push(chunk: Uint8Array): void {
    this.buffer += this.decoder.decode(chunk, { stream: true });
    this.consumeCompleteLines();
  }

  finish(): ProviderTokenUsage | null {
    this.buffer += this.decoder.decode();
    this.consumeCompleteLines(true);
    return this.sawUsage ? { ...this.usage } : null;
  }

  private consumeCompleteLines(flush = false): void {
    const lines = this.buffer.split(/\r?\n/);
    this.buffer = flush ? '' : lines.pop() ?? '';
    for (const line of lines) {
      if (!line.startsWith('data:')) continue;
      const raw = line.slice('data:'.length).trim();
      if (!raw || raw === '[DONE]') continue;
      let event: unknown;
      try {
        event = JSON.parse(raw);
      } catch {
        continue;
      }
      if (!isRecord(event)) continue;
      const usage = this.protocol === 'anthropic-sse'
        ? anthropicUsage(event)
        : openAiChatUsage(event);
      if (!usage) continue;
      this.sawUsage = true;
      this.usage.input = Math.max(this.usage.input, usage.input);
      this.usage.cacheRead = Math.max(this.usage.cacheRead, usage.cacheRead);
      this.usage.cacheWrite = Math.max(this.usage.cacheWrite, usage.cacheWrite);
      this.usage.output = Math.max(this.usage.output, usage.output);
    }
  }
}

function anthropicUsage(event: Record<string, unknown>): ProviderTokenUsage | null {
  const usage = isRecord(event.usage)
    ? event.usage
    : isRecord(event.message) && isRecord(event.message.usage)
      ? event.message.usage
      : null;
  if (!usage || !hasAnyNumber(usage, [
    'input_tokens',
    'cache_read_input_tokens',
    'cache_creation_input_tokens',
    'output_tokens',
  ])) return null;
  const cacheRead = nonNegativeNumber(usage.cache_read_input_tokens);
  const cacheWrite = nonNegativeNumber(usage.cache_creation_input_tokens);
  return {
    input: nonNegativeNumber(usage.input_tokens) + cacheRead + cacheWrite,
    cacheRead,
    cacheWrite,
    output: nonNegativeNumber(usage.output_tokens),
  };
}

function openAiChatUsage(event: Record<string, unknown>): ProviderTokenUsage | null {
  if (!isRecord(event.usage) || !hasAnyNumber(event.usage, ['prompt_tokens', 'completion_tokens'])) return null;
  const details = isRecord(event.usage.prompt_tokens_details) ? event.usage.prompt_tokens_details : null;
  return {
    input: nonNegativeNumber(event.usage.prompt_tokens),
    cacheRead: nonNegativeNumber(details?.cached_tokens),
    cacheWrite: 0,
    output: nonNegativeNumber(event.usage.completion_tokens),
  };
}

function hasAnyNumber(record: Record<string, unknown>, keys: readonly string[]): boolean {
  return keys.some((key) => (
    typeof record[key] === 'number'
    && Number.isFinite(record[key])
    && (record[key] as number) >= 0
  ));
}

function nonNegativeNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function authorized(
  header: string | string[] | undefined,
  token: string,
  authMode: ProviderAuthProxyMode,
): boolean {
  if (typeof header !== 'string') return false;
  const value = authMode === 'bearer'
    ? header.startsWith('Bearer ')
      ? header.slice('Bearer '.length)
      : undefined
    : header;
  if (value === undefined) return false;
  const presented = Buffer.from(value);
  const expected = Buffer.from(token);
  return presented.length === expected.length && timingSafeEqual(presented, expected);
}

async function readRequestBody(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks);
}

const HOP_BY_HOP_HEADERS = new Set([
  'accept-encoding',
  'authorization',
  'connection',
  'content-encoding',
  'content-length',
  'host',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

const REQUEST_HEADER_DENYLIST = new Set([
  ...HOP_BY_HOP_HEADERS,
  'x-api-key',
]);
