import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type {
  AppSettings,
  OpenGatewayRuntimeStatus,
  OpenGatewaySettings,
  SearchErrorReason,
  SearchResult,
  SessionSummary,
  StoredMessage,
} from '@maka/core';

export type OpenGatewayStatus = OpenGatewayRuntimeStatus;

export interface OpenGatewayDeps {
  getSettings(): Promise<AppSettings>;
  listSessions(): Promise<SessionSummary[]>;
  readMessages(sessionId: string): Promise<StoredMessage[]>;
  searchThread(query: string): Promise<SearchResult[] | { ok: false; reason: SearchErrorReason; message: string }>;
  now?(): number;
}

export class OpenGatewayService {
  private server: Server | null = null;
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
    if (!server) return;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    res.setHeader('Access-Control-Allow-Origin', 'http://127.0.0.1');
    res.setHeader('Access-Control-Allow-Headers', 'authorization, content-type');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    if (req.method === 'OPTIONS') {
      writeJson(res, 204, {});
      return;
    }
    if (req.method !== 'GET') {
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
      writeJson(res, 200, {
        ok: true,
        capabilities: ['sessions.list', 'sessions.messages.read', 'search.thread'],
      });
      return;
    }
    if (url.pathname === '/v1/sessions') {
      writeJson(res, 200, { ok: true, sessions: await this.deps.listSessions() });
      return;
    }
    const messageMatch = url.pathname.match(/^\/v1\/sessions\/([^/]+)\/messages$/);
    if (messageMatch) {
      writeJson(res, 200, { ok: true, messages: await this.deps.readMessages(decodeURIComponent(messageMatch[1]!)) });
      return;
    }
    if (url.pathname === '/v1/search/thread') {
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
