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
import { redactSecrets } from '@maka/core/redaction';

export type OpenGatewayStatus = OpenGatewayRuntimeStatus;

export interface OpenGatewayDeps {
  getSettings(): Promise<AppSettings>;
  listSessions(): Promise<SessionSummary[]>;
  readMessages(sessionId: string): Promise<StoredMessage[]>;
  sendMessage?(sessionId: string, input: { text: string }): Promise<{ turnId: string }>;
  searchThread(query: string): Promise<SearchResult[] | { ok: false; reason: SearchErrorReason; message: string }>;
  onStatusChanged?(status: OpenGatewayStatus): void;
  now?(): number;
}

export class OpenGatewayService {
  private server: Server | null = null;
  private activeToken: string | null = null;
  private readonly eventClients = new Map<string, Set<GatewayEventClient>>();
  private readonly recentEvents = new Map<string, SessionEvent[]>();
  private status: OpenGatewayStatus = {
    enabled: false,
    running: false,
    host: '127.0.0.1',
    port: 3939,
    baseUrl: null,
    tokenConfigured: false,
    activeEventStreams: 0,
  };

  constructor(private readonly deps: OpenGatewayDeps) {}

  getStatus(): OpenGatewayStatus {
    return { ...this.status, activeEventStreams: this.countEventClients() };
  }

  publishSessionEvent(sessionId: string, event: SessionEvent): void {
    this.recordRecentEvent(sessionId, event);
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
        activeEventStreams: 0,
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
        activeEventStreams: this.countEventClients(),
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
        activeEventStreams: 0,
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
        activeEventStreams: 0,
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
    this.recentEvents.clear();
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
        capabilities: buildGatewayCapabilities(Boolean(this.deps.sendMessage)),
        sessions: {
          state: {
            endpoint: '/v1/sessions/state',
            includesPreviews: false,
          },
        },
        sessionMessages: {
          pagination: {
            limitQuery: 'limit',
            beforeQuery: 'before',
            maxLimit: OPEN_GATEWAY_MESSAGE_PAGE_MAX_LIMIT,
          },
          state: {
            endpoint: '/v1/sessions/{sessionId}/messages/state',
            includesText: false,
          },
        },
        sessionEvents: {
          stream: true,
          cursor: {
            header: 'Last-Event-ID',
            query: 'after',
            maxLength: OPEN_GATEWAY_REPLAY_CURSOR_LIMIT,
          },
          replay: {
            limit: OPEN_GATEWAY_EVENT_REPLAY_LIMIT,
            missEvent: OPEN_GATEWAY_REPLAY_MISS_EVENT,
            missAdvancesCursor: false,
            partialReplayOnMiss: false,
          },
          state: {
            endpoint: '/v1/sessions/{sessionId}/events/state',
            includesPayloads: false,
          },
        },
      });
      return;
    }
    if (url.pathname === '/v1/sessions/state') {
      if (req.method !== 'GET') {
        writeJson(res, 405, { ok: false, error: 'method_not_allowed' });
        return;
      }
      writeJson(res, 200, { ok: true, state: buildGatewaySessionsState(await this.deps.listSessions()) });
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
        const messages = await this.deps.readMessages(sessionId);
        const page = paginateMessages(messages, url);
        if (!page.ok) {
          writeJson(res, 400, { ok: false, error: page.error });
          return;
        }
        writeJson(res, 200, page.response);
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
    const messageStateMatch = url.pathname.match(/^\/v1\/sessions\/([^/]+)\/messages\/state$/);
    if (messageStateMatch) {
      if (req.method !== 'GET') {
        writeJson(res, 405, { ok: false, error: 'method_not_allowed' });
        return;
      }
      const sessionId = decodeURIComponent(messageStateMatch[1]!);
      writeJson(res, 200, { ok: true, state: buildGatewayMessageState(await this.deps.readMessages(sessionId)) });
      return;
    }
    const eventsMatch = url.pathname.match(/^\/v1\/sessions\/([^/]+)\/events$/);
    if (eventsMatch) {
      if (req.method !== 'GET') {
        writeJson(res, 405, { ok: false, error: 'method_not_allowed' });
        return;
      }
      const sessionId = decodeURIComponent(eventsMatch[1]!);
      this.openSessionEventStream(sessionId, readReplayCursor(req, url), req, res);
      return;
    }
    const eventStateMatch = url.pathname.match(/^\/v1\/sessions\/([^/]+)\/events\/state$/);
    if (eventStateMatch) {
      if (req.method !== 'GET') {
        writeJson(res, 405, { ok: false, error: 'method_not_allowed' });
        return;
      }
      const sessionId = decodeURIComponent(eventStateMatch[1]!);
      writeJson(res, 200, { ok: true, state: this.buildReplayState(sessionId) });
      return;
    }
    const incidentsMatch = url.pathname.match(/^\/v1\/sessions\/([^/]+)\/incidents$/);
    if (incidentsMatch) {
      if (req.method !== 'GET') {
        writeJson(res, 405, { ok: false, error: 'method_not_allowed' });
        return;
      }
      const sessionId = decodeURIComponent(incidentsMatch[1]!);
      writeJson(res, 200, { ok: true, incidents: buildGatewayIncidents(this.recentEvents.get(sessionId) ?? []) });
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

  private openSessionEventStream(
    sessionId: string,
    replayAfterEventId: string | undefined,
    req: IncomingMessage,
    res: ServerResponse,
  ): void {
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
    this.emitStatusChanged();
    this.replayRecentEvents(sessionId, replayAfterEventId, client);

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
    this.emitStatusChanged();
  }

  private closeEventClients(): void {
    for (const [sessionId, clients] of [...this.eventClients]) {
      for (const client of [...clients]) this.removeEventClient(sessionId, client);
    }
    this.eventClients.clear();
  }

  private countEventClients(): number {
    let count = 0;
    for (const clients of this.eventClients.values()) count += clients.size;
    return count;
  }

  private emitStatusChanged(): void {
    this.deps.onStatusChanged?.(this.getStatus());
  }

  private recordRecentEvent(sessionId: string, event: SessionEvent): void {
    const events = this.recentEvents.get(sessionId) ?? [];
    events.push(event);
    if (events.length > OPEN_GATEWAY_EVENT_REPLAY_LIMIT) {
      events.splice(0, events.length - OPEN_GATEWAY_EVENT_REPLAY_LIMIT);
    }
    this.recentEvents.set(sessionId, events);
  }

  private replayRecentEvents(
    sessionId: string,
    replayAfterEventId: string | undefined,
    client: GatewayEventClient,
  ): void {
    if (!replayAfterEventId) return;
    const events = this.recentEvents.get(sessionId);
    if (!events || events.length === 0) {
      client.write(formatReplayMissEvent('empty_buffer', replayAfterEventId));
      return;
    }
    const index = events.findIndex((event) => event.id === replayAfterEventId);
    if (index < 0) {
      client.write(formatReplayMissEvent('cursor_not_found', replayAfterEventId));
      return;
    }
    for (const event of events.slice(index + 1)) {
      client.write(formatSseEvent({ id: event.id, event: event.type, data: event }));
    }
  }

  private buildReplayState(sessionId: string): GatewayReplayState {
    const events = this.recentEvents.get(sessionId) ?? [];
    const activeStreams = this.eventClients.get(sessionId)?.size ?? 0;
    const oldest = events[0];
    const newest = events.at(-1);
    return {
      replayLimit: OPEN_GATEWAY_EVENT_REPLAY_LIMIT,
      bufferedEvents: events.length,
      activeStreams,
      hasReplayBuffer: events.length > 0,
      includesPayloads: false,
      ...(oldest
        ? {
            oldestEvent: summarizeReplayEvent(oldest),
          }
        : {}),
      ...(newest
        ? {
            newestEvent: summarizeReplayEvent(newest),
          }
        : {}),
    };
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
const OPEN_GATEWAY_MESSAGE_PAGE_DEFAULT_LIMIT = 100;
const OPEN_GATEWAY_MESSAGE_PAGE_MAX_LIMIT = 200;
const OPEN_GATEWAY_EVENT_HEARTBEAT_MS = 15_000;
const OPEN_GATEWAY_EVENT_REPLAY_LIMIT = 100;
const OPEN_GATEWAY_REPLAY_CURSOR_LIMIT = 256;
const OPEN_GATEWAY_REPLAY_MISS_EVENT = 'gateway_replay_miss';
const OPEN_GATEWAY_INCIDENT_LIMIT = 20;
const OPEN_GATEWAY_INCIDENT_TEXT_LIMIT = 500;

interface GatewayEventClient {
  response: ServerResponse;
  heartbeat: ReturnType<typeof setInterval>;
  write(chunk: string): void;
}

type GatewayIncidentSummary =
  | {
      id: string;
      eventId: string;
      type: 'error';
      turnId: string;
      ts: number;
      recoverable: boolean;
      message: string;
      code?: string;
      reason?: string;
    }
  | {
      id: string;
      eventId: string;
      type: 'abort';
      turnId: string;
      ts: number;
      reason: 'user_stop' | 'redirect' | 'timeout' | 'crash';
    };

function buildGatewayCapabilities(sendAvailable: boolean): string[] {
  return [
    'sessions.list',
    'sessions.state',
    'sessions.messages.read',
    'sessions.messages.page',
    'sessions.messages.state',
    ...(sendAvailable ? ['sessions.messages.send'] : []),
    'sessions.events.stream',
    'sessions.events.replay',
    'sessions.events.replay_miss',
    'sessions.events.state',
    'sessions.incidents.read',
    'search.thread',
  ];
}

interface GatewaySessionsState {
  sessionCount: number;
  archivedCount: number;
  unreadCount: number;
  flaggedCount: number;
  includesPreviews: false;
  byStatus: Record<string, number>;
  newestSession?: GatewaySessionSummary;
  oldestSession?: GatewaySessionSummary;
}

interface GatewaySessionSummary {
  id: string;
  status: string;
  lastMessageAt?: number;
}

function buildGatewaySessionsState(sessions: SessionSummary[]): GatewaySessionsState {
  const newest = sessions[0];
  const oldest = sessions.at(-1);
  const byStatus: Record<string, number> = {};
  for (const session of sessions) {
    byStatus[session.status] = (byStatus[session.status] ?? 0) + 1;
  }
  return {
    sessionCount: sessions.length,
    archivedCount: sessions.filter((session) => session.isArchived).length,
    unreadCount: sessions.filter((session) => session.hasUnread).length,
    flaggedCount: sessions.filter((session) => session.isFlagged).length,
    includesPreviews: false,
    byStatus,
    ...(newest ? { newestSession: summarizeGatewaySession(newest) } : {}),
    ...(oldest ? { oldestSession: summarizeGatewaySession(oldest) } : {}),
  };
}

function summarizeGatewaySession(session: SessionSummary): GatewaySessionSummary {
  return {
    id: capReplayCursor(redactSecrets(session.id)),
    status: session.status,
    ...(session.lastMessageAt ? { lastMessageAt: session.lastMessageAt } : {}),
  };
}

interface GatewayMessageState {
  messageCount: number;
  includesText: false;
  oldestMessage?: GatewayMessageSummary;
  newestMessage?: GatewayMessageSummary;
}

interface GatewayMessageSummary {
  id: string;
  type: string;
  turnId?: string;
  ts?: number;
}

function buildGatewayMessageState(messages: StoredMessage[]): GatewayMessageState {
  const oldest = messages[0];
  const newest = messages.at(-1);
  return {
    messageCount: messages.length,
    includesText: false,
    ...(oldest ? { oldestMessage: summarizeGatewayMessage(oldest) } : {}),
    ...(newest ? { newestMessage: summarizeGatewayMessage(newest) } : {}),
  };
}

function summarizeGatewayMessage(message: StoredMessage): GatewayMessageSummary {
  return {
    id: capReplayCursor(redactSecrets(message.id)),
    type: message.type,
    ...('turnId' in message && message.turnId ? { turnId: capReplayCursor(redactSecrets(message.turnId)) } : {}),
    ...('ts' in message ? { ts: message.ts } : {}),
  };
}

type MessagePaginationResult =
  | { ok: true; response: { ok: true; messages: StoredMessage[]; pagination?: MessagePagination } }
  | { ok: false; error: 'invalid_limit' | 'invalid_before_cursor' };

interface MessagePagination {
  limit: number;
  before: string | null;
  nextBefore: string | null;
  hasMoreBefore: boolean;
}

function paginateMessages(messages: StoredMessage[], url: URL): MessagePaginationResult {
  const hasLimit = url.searchParams.has('limit');
  const before = normalizeMessageCursor(url.searchParams.get('before'));
  if (!hasLimit && before === null) return { ok: true, response: { ok: true, messages } };

  const limit = parseMessagePageLimit(url.searchParams.get('limit'));
  if (limit === null) return { ok: false, error: 'invalid_limit' };
  if (url.searchParams.has('before') && before === undefined) return { ok: false, error: 'invalid_before_cursor' };
  const beforeCursor = before ?? null;

  const end = beforeCursor === null
    ? messages.length
    : messages.findIndex((message) => message.id === beforeCursor);
  if (end < 0) return { ok: false, error: 'invalid_before_cursor' };

  const start = Math.max(0, end - limit);
  const page = messages.slice(start, end);
  return {
    ok: true,
    response: {
      ok: true,
      messages: page,
      pagination: {
        limit,
        before: beforeCursor,
        nextBefore: page[0]?.id ?? null,
        hasMoreBefore: start > 0,
      },
    },
  };
}

function parseMessagePageLimit(value: string | null): number | null {
  if (value === null || value.trim().length === 0) return OPEN_GATEWAY_MESSAGE_PAGE_DEFAULT_LIMIT;
  if (!/^\d+$/.test(value.trim())) return null;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > OPEN_GATEWAY_MESSAGE_PAGE_MAX_LIMIT) return null;
  return parsed;
}

function normalizeMessageCursor(value: string | null): string | null | undefined {
  if (value === null) return null;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > 256) return undefined;
  if (/[\r\n]/.test(trimmed)) return undefined;
  return trimmed;
}

interface GatewayReplayState {
  replayLimit: number;
  bufferedEvents: number;
  activeStreams: number;
  hasReplayBuffer: boolean;
  includesPayloads: false;
  oldestEvent?: GatewayReplayEventSummary;
  newestEvent?: GatewayReplayEventSummary;
}

interface GatewayReplayEventSummary {
  id: string;
  type: string;
  turnId?: string;
  ts?: number;
}

function summarizeReplayEvent(event: SessionEvent): GatewayReplayEventSummary {
  return {
    id: capReplayCursor(redactSecrets(event.id)),
    type: event.type,
    ...('turnId' in event ? { turnId: capReplayCursor(redactSecrets(event.turnId)) } : {}),
    ...('ts' in event ? { ts: event.ts } : {}),
  };
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

function formatReplayMissEvent(reason: 'empty_buffer' | 'cursor_not_found', requestedEventId: string): string {
  return [
    `event: ${OPEN_GATEWAY_REPLAY_MISS_EVENT}`,
    `data: ${JSON.stringify({
      type: OPEN_GATEWAY_REPLAY_MISS_EVENT,
      reason,
      requestedEventId: capReplayCursor(redactSecrets(requestedEventId)),
      replayLimit: OPEN_GATEWAY_EVENT_REPLAY_LIMIT,
    })}`,
    '',
    '',
  ].join('\n');
}

function buildGatewayIncidents(events: readonly SessionEvent[]): GatewayIncidentSummary[] {
  const incidents: GatewayIncidentSummary[] = [];
  for (const event of events) {
    if (event.type === 'error') {
      incidents.push({
        id: `incident:${event.id}`,
        eventId: event.id,
        type: 'error',
        turnId: event.turnId,
        ts: event.ts,
        recoverable: event.recoverable,
        message: capIncidentText(redactSecrets(event.message)),
        ...(event.code ? { code: capIncidentText(redactSecrets(event.code)) } : {}),
        ...(event.reason ? { reason: capIncidentText(redactSecrets(event.reason)) } : {}),
      });
    } else if (event.type === 'abort') {
      incidents.push({
        id: `incident:${event.id}`,
        eventId: event.id,
        type: 'abort',
        turnId: event.turnId,
        ts: event.ts,
        reason: event.reason,
      });
    }
  }
  return incidents.slice(-OPEN_GATEWAY_INCIDENT_LIMIT);
}

function capIncidentText(value: string): string {
  if (value.length <= OPEN_GATEWAY_INCIDENT_TEXT_LIMIT) return value;
  return `${value.slice(0, OPEN_GATEWAY_INCIDENT_TEXT_LIMIT - 1)}…`;
}

function readReplayCursor(req: IncomingMessage, url: URL): string | undefined {
  const header = Array.isArray(req.headers['last-event-id'])
    ? req.headers['last-event-id'][0]
    : req.headers['last-event-id'];
  return normalizeReplayCursor(header ?? url.searchParams.get('after'));
}

function normalizeReplayCursor(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > OPEN_GATEWAY_REPLAY_CURSOR_LIMIT) return undefined;
  if (/[\r\n]/.test(trimmed)) return undefined;
  return trimmed;
}

function capReplayCursor(value: string): string {
  return value.length <= OPEN_GATEWAY_REPLAY_CURSOR_LIMIT
    ? value
    : `${value.slice(0, OPEN_GATEWAY_REPLAY_CURSOR_LIMIT - 1)}…`;
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
