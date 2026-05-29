import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type {
  AppSettings,
  OpenGatewayRuntimeStatus,
  OpenGatewaySettings,
  SearchErrorReason,
  SearchResult,
  SessionEvent,
  SessionSummary,
  StoredMessage,
} from '@maka/core';

export type OpenGatewayStatus = OpenGatewayRuntimeStatus;

export interface OpenGatewayDeps {
  getSettings(): Promise<AppSettings>;
  listSessions(): Promise<SessionSummary[]>;
  readMessages(sessionId: string): Promise<StoredMessage[]>;
  sendMessage?(sessionId: string, input: { text: string }): Promise<{ turnId: string }>;
  searchThread(query: string): Promise<SearchResult[] | { ok: false; reason: SearchErrorReason; message: string }>;
  now?(): number;
}

export class OpenGatewayService {
  private server: Server | null = null;
  private activeToken: string | null = null;
  private readonly eventClients = new Map<string, Set<GatewayEventClient>>();
  private status: OpenGatewayStatus = {
    enabled: false,
    running: false,
    host: '127.0.0.1',
    port: 3939,
    baseUrl: null,
    tokenConfigured: false,
  };

  constructor(private readonly deps: OpenGatewayDeps) {}

  getStatus(): OpenGatewayStatus {
    return { ...this.status };
  }

  publishSessionEvent(sessionId: string, event: SessionEvent): void {
    const clients = this.eventClients.get(sessionId);
    if (!clients || clients.size === 0) return;
    const payload = formatSseEvent({
      id: event.id,
      event: event.type,
      data: event,
    });
    for (const client of clients) {
      client.write(payload);
    }
  }

  async sync(settings: OpenGatewaySettings): Promise<OpenGatewayStatus> {
    const tokenConfigured = settings.token.trim().length > 0;
    if (!settings.enabled || !tokenConfigured) {
      await this.stop();
      this.status = {
        enabled: settings.enabled,
        running: false,
        host: settings.host,
        port: settings.port,
        baseUrl: null,
        tokenConfigured,
        ...(settings.enabled && !tokenConfigured ? { lastError: 'missing_token' } : {}),
      };
      return this.getStatus();
    }

    if (
      this.server &&
      this.status.running &&
      this.status.host === settings.host &&
      this.status.port === settings.port
    ) {
      if (this.activeToken !== settings.token) {
        this.closeEventClients();
      }
      this.activeToken = settings.token;
      this.status = {
        ...this.status,
        enabled: true,
        tokenConfigured,
        lastError: undefined,
      };
      return this.getStatus();
    }

    await this.stop();
    const server = createServer((req, res) => {
      void this.handle(req, res).catch((error) => {
        writeJson(res, 500, { ok: false, error: 'internal_error', message: error instanceof Error ? error.message : 'Gateway error' });
      });
    });
    this.server = server;
    try {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(settings.port, settings.host, () => {
          server.off('error', reject);
          resolve();
        });
      });
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : settings.port;
      this.activeToken = settings.token;
      this.status = {
        enabled: true,
        running: true,
        host: settings.host,
        port,
        baseUrl: `http://${settings.host}:${port}`,
        startedAt: this.now(),
        tokenConfigured,
      };
    } catch (error) {
      await this.stop();
      this.activeToken = null;
      this.status = {
        enabled: true,
        running: false,
        host: settings.host,
        port: settings.port,
        baseUrl: null,
        tokenConfigured,
        lastError: error instanceof Error ? error.message : 'gateway_start_failed',
      };
    }
    return this.getStatus();
  }

  async stop(): Promise<void> {
    const server = this.server;
    this.server = null;
    this.activeToken = null;
    this.closeEventClients();
    if (!server) return;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    res.setHeader('Access-Control-Allow-Origin', 'http://127.0.0.1');
    res.setHeader('Access-Control-Allow-Headers', 'authorization, content-type');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    if (req.method === 'OPTIONS') {
      writeJson(res, 204, {});
      return;
    }
    if (req.method !== 'GET' && req.method !== 'POST') {
      writeJson(res, 405, { ok: false, error: 'method_not_allowed' });
      return;
    }

    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (url.pathname === '/health') {
      writeJson(res, 200, { ok: true, gateway: this.getStatus() });
      return;
    }

    const settings = (await this.deps.getSettings()).openGateway;
    if (!this.isAuthorized(req, settings.token)) {
      writeJson(res, 401, { ok: false, error: 'unauthorized' });
      return;
    }

    if (url.pathname === '/v1/capabilities') {
      if (req.method !== 'GET') {
        writeJson(res, 405, { ok: false, error: 'method_not_allowed' });
        return;
      }
      writeJson(res, 200, {
        ok: true,
        capabilities: [
          'sessions.list',
          'sessions.messages.read',
          ...(this.deps.sendMessage ? ['sessions.messages.send'] : []),
          'sessions.events.stream',
          'search.thread',
        ],
      });
      return;
    }
    if (url.pathname === '/v1/sessions') {
      if (req.method !== 'GET') {
        writeJson(res, 405, { ok: false, error: 'method_not_allowed' });
        return;
      }
      writeJson(res, 200, { ok: true, sessions: await this.deps.listSessions() });
      return;
    }
    const messageMatch = url.pathname.match(/^\/v1\/sessions\/([^/]+)\/messages$/);
    if (messageMatch) {
      const sessionId = decodeURIComponent(messageMatch[1]!);
      if (req.method === 'GET') {
        writeJson(res, 200, { ok: true, messages: await this.deps.readMessages(sessionId) });
        return;
      }
      if (!this.deps.sendMessage) {
        writeJson(res, 503, { ok: false, error: 'send_unavailable' });
        return;
      }
      const body = await readJsonBody(req);
      if (!body.ok) {
        writeJson(res, body.status, { ok: false, error: body.error });
        return;
      }
      const input = parseSendMessageBody(body.value);
      if (!input.ok) {
        writeJson(res, 400, { ok: false, error: input.error });
        return;
      }
      const result = await this.deps.sendMessage(sessionId, { text: input.text });
      writeJson(res, 202, { ok: true, turnId: result.turnId });
      return;
    }
    const eventsMatch = url.pathname.match(/^\/v1\/sessions\/([^/]+)\/events$/);
    if (eventsMatch) {
      if (req.method !== 'GET') {
        writeJson(res, 405, { ok: false, error: 'method_not_allowed' });
        return;
      }
      const sessionId = decodeURIComponent(eventsMatch[1]!);
      this.openSessionEventStream(sessionId, req, res);
      return;
    }
    if (url.pathname === '/v1/search/thread') {
      if (req.method !== 'GET') {
        writeJson(res, 405, { ok: false, error: 'method_not_allowed' });
        return;
      }
      const query = url.searchParams.get('q') ?? '';
      writeJson(res, 200, { ok: true, result: await this.deps.searchThread(query) });
      return;
    }
    writeJson(res, 404, { ok: false, error: 'not_found' });
  }

  private isAuthorized(req: IncomingMessage, token: string): boolean {
    const expected = `Bearer ${token}`;
    return token.length > 0 && req.headers.authorization === expected;
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  private openSessionEventStream(sessionId: string, req: IncomingMessage, res: ServerResponse): void {
    res.statusCode = 200;
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.write('retry: 1000\n');
    res.write(`: session ${sessionId} connected\n\n`);

    const client: GatewayEventClient = {
      response: res,
      heartbeat: setInterval(() => {
        res.write(`: heartbeat ${this.now()}\n\n`);
      }, OPEN_GATEWAY_EVENT_HEARTBEAT_MS),
      write(chunk) {
        res.write(chunk);
      },
    };
    const clients = this.eventClients.get(sessionId) ?? new Set<GatewayEventClient>();
    clients.add(client);
    this.eventClients.set(sessionId, clients);

    req.on('close', () => this.removeEventClient(sessionId, client));
  }

  private removeEventClient(sessionId: string, client: GatewayEventClient): void {
    clearInterval(client.heartbeat);
    const clients = this.eventClients.get(sessionId);
    if (clients) {
      clients.delete(client);
      if (clients.size === 0) this.eventClients.delete(sessionId);
    }
    if (!client.response.writableEnded) client.response.end();
  }

  private closeEventClients(): void {
    for (const [sessionId, clients] of [...this.eventClients]) {
      for (const client of [...clients]) this.removeEventClient(sessionId, client);
    }
    this.eventClients.clear();
  }
}

function writeJson(res: ServerResponse, statusCode: number, payload: unknown): void {
  res.statusCode = statusCode;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  if (statusCode === 204) {
    res.end();
    return;
  }
  res.end(JSON.stringify(payload));
}

type JsonBodyResult =
  | { ok: true; value: unknown }
  | { ok: false; status: number; error: string };

const OPEN_GATEWAY_MAX_BODY_BYTES = 16 * 1024;
const OPEN_GATEWAY_EVENT_HEARTBEAT_MS = 15_000;

interface GatewayEventClient {
  response: ServerResponse;
  heartbeat: ReturnType<typeof setInterval>;
  write(chunk: string): void;
}

function formatSseEvent(input: { id: string; event: string; data: unknown }): string {
  const data = JSON.stringify(input.data);
  return [
    `id: ${input.id}`,
    `event: ${input.event}`,
    `data: ${data}`,
    '',
    '',
  ].join('\n');
}

async function readJsonBody(req: IncomingMessage): Promise<JsonBodyResult> {
  const declared = Number(req.headers['content-length'] ?? 0);
  if (Number.isFinite(declared) && declared > OPEN_GATEWAY_MAX_BODY_BYTES) {
    drainRequest(req);
    return { ok: false, status: 413, error: 'payload_too_large' };
  }

  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.byteLength;
    if (total > OPEN_GATEWAY_MAX_BODY_BYTES) {
      drainRequest(req);
      return { ok: false, status: 413, error: 'payload_too_large' };
    }
    chunks.push(buffer);
  }

  try {
    return { ok: true, value: JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') };
  } catch {
    return { ok: false, status: 400, error: 'invalid_json' };
  }
}

function drainRequest(req: IncomingMessage): void {
  req.resume();
}

function parseSendMessageBody(value: unknown): { ok: true; text: string } | { ok: false; error: string } {
  if (!value || typeof value !== 'object') return { ok: false, error: 'invalid_body' };
  const text = (value as { text?: unknown }).text;
  if (typeof text !== 'string') return { ok: false, error: 'invalid_text' };
  if (text.trim().length === 0) return { ok: false, error: 'empty_text' };
  if (text.length > 8_000) return { ok: false, error: 'text_too_large' };
  return { ok: true, text };
}
