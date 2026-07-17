import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { Socket } from 'node:net';

export interface ProviderAuthProxy {
  baseUrl: string;
  token: string;
  close(): Promise<void>;
}

export type ProviderAuthProxyMode = 'bearer' | 'x-api-key';

export async function startProviderAuthProxy(input: {
  upstreamBaseUrl: string;
  apiKeyFile: string;
  advertisedHost?: string;
  authMode?: ProviderAuthProxyMode;
}): Promise<ProviderAuthProxy> {
  const upstreamBaseUrl = new URL(input.upstreamBaseUrl);
  if (upstreamBaseUrl.protocol !== 'https:' && upstreamBaseUrl.protocol !== 'http:') {
    throw new Error(`provider auth proxy requires an HTTP(S) upstream: ${upstreamBaseUrl.protocol}`);
  }
  const providerKey = (await readFile(input.apiKeyFile, 'utf8')).trim();
  if (providerKey.length === 0) throw new Error('provider API key file is empty');
  const authMode = input.authMode ?? 'bearer';
  const token = randomBytes(32).toString('hex');
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
    if (upstreamResponse.body) {
      for await (const chunk of upstreamResponse.body) input.response.write(chunk);
    }
    input.response.end();
  } catch {
    if (input.response.destroyed) return;
    if (!input.response.headersSent) input.response.writeHead(502);
    input.response.end('provider proxy request failed');
  }
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
