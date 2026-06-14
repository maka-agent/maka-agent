import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
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
  private readonly recentRequests: GatewayRequestSummary[] = [];
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
      res.setHeader(OPEN_GATEWAY_REQUEST_ID_HEADER, createGatewayRequestId());
      this.trackRequest(req, res);
      void this.handle(req, res).catch(() => {
        writeJson(res, 500, { ok: false, error: 'internal_error', message: gatewayInternalFailureMessage() });
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
    } catch {
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
        lastError: 'start_failed',
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
    this.recentRequests.splice(0);
    if (!server) return;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    res.setHeader('Access-Control-Allow-Origin', 'http://127.0.0.1');
    res.setHeader('Access-Control-Allow-Headers', 'authorization, content-type');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Expose-Headers', OPEN_GATEWAY_REQUEST_ID_HEADER);
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
        gateway: {
          requestIdHeader: OPEN_GATEWAY_REQUEST_ID_HEADER,
          state: {
            endpoint: '/v1/state',
            includesPayloads: false,
            includesPreviews: false,
          },
        },
        sessions: {
          state: {
            endpoint: '/v1/sessions/state',
            includesPreviews: false,
            includesRecentIncidentCounts: true,
          },
          detailState: {
            endpoint: '/v1/sessions/{sessionId}/state',
            includesText: false,
            includesPreviews: false,
            includesPayloads: false,
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
          recent: {
            endpoint: '/v1/sessions/{sessionId}/events/recent',
            limit: OPEN_GATEWAY_EVENT_RECENT_LIMIT,
            includesPayloads: false,
          },
          globalState: {
            endpoint: '/v1/events/state',
            includesPayloads: false,
          },
        },
        incidents: {
          endpoint: '/v1/incidents',
          stateEndpoint: '/v1/incidents/state',
          perSessionEndpoint: '/v1/sessions/{sessionId}/incidents',
          limit: OPEN_GATEWAY_INCIDENT_AGGREGATE_LIMIT,
          includesPayloads: false,
        },
        requests: {
          recent: {
            endpoint: '/v1/requests/recent',
            limit: OPEN_GATEWAY_REQUEST_RECENT_LIMIT,
            includesHeaders: false,
            includesQuery: false,
            includesPayloads: false,
          },
        },
      });
      return;
    }
    if (url.pathname === '/v1/openapi.json') {
      if (req.method !== 'GET') {
        writeJson(res, 405, { ok: false, error: 'method_not_allowed' });
        return;
      }
      writeJson(res, 200, buildGatewayOpenApiSpec(Boolean(this.deps.sendMessage)));
      return;
    }
    if (url.pathname === '/v1/state') {
      if (req.method !== 'GET') {
        writeJson(res, 405, { ok: false, error: 'method_not_allowed' });
        return;
      }
      writeJson(res, 200, {
        ok: true,
        state: buildGatewayOverviewState({
          gateway: this.getStatus(),
          sessions: await this.deps.listSessions(),
          recentEvents: this.recentEvents,
          recentRequests: this.recentRequests,
          sendAvailable: Boolean(this.deps.sendMessage),
          generatedAt: this.now(),
        }),
      });
      return;
    }
    if (url.pathname === '/v1/incidents/state') {
      if (req.method !== 'GET') {
        writeJson(res, 405, { ok: false, error: 'method_not_allowed' });
        return;
      }
      writeJson(res, 200, { ok: true, state: buildGatewayIncidentIndexState(this.recentEvents) });
      return;
    }
    if (url.pathname === '/v1/incidents') {
      if (req.method !== 'GET') {
        writeJson(res, 405, { ok: false, error: 'method_not_allowed' });
        return;
      }
      writeJson(res, 200, { ok: true, incidents: buildGatewayIncidentIndex(this.recentEvents) });
      return;
    }
    if (url.pathname === '/v1/events/state') {
      if (req.method !== 'GET') {
        writeJson(res, 405, { ok: false, error: 'method_not_allowed' });
        return;
      }
      writeJson(res, 200, { ok: true, state: this.buildGlobalEventState() });
      return;
    }

    if (url.pathname === '/v1/requests/recent') {
      if (req.method !== 'GET') {
        writeJson(res, 405, { ok: false, error: 'method_not_allowed' });
        return;
      }
      writeJson(res, 200, {
        ok: true,
        requests: [...this.recentRequests],
        limit: OPEN_GATEWAY_REQUEST_RECENT_LIMIT,
        includesHeaders: false,
        includesQuery: false,
        includesPayloads: false,
      });
      return;
    }
    if (url.pathname === '/v1/sessions/state') {
      if (req.method !== 'GET') {
        writeJson(res, 405, { ok: false, error: 'method_not_allowed' });
        return;
      }
      writeJson(res, 200, { ok: true, state: buildGatewaySessionsState(await this.deps.listSessions(), this.recentEvents) });
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
    const sessionStateMatch = url.pathname.match(/^\/v1\/sessions\/([^/]+)\/state$/);
    if (sessionStateMatch) {
      if (req.method !== 'GET') {
        writeJson(res, 405, { ok: false, error: 'method_not_allowed' });
        return;
      }
      const sessionId = decodeURIComponent(sessionStateMatch[1]!);
      const session = (await this.deps.listSessions()).find((candidate) => candidate.id === sessionId);
      if (!session) {
        writeJson(res, 404, { ok: false, error: 'session_not_found' });
        return;
      }
      writeJson(res, 200, {
        ok: true,
        state: buildGatewaySessionState({
          session,
          messages: await this.deps.readMessages(sessionId),
          replayState: this.buildReplayState(sessionId),
          incidentState: summarizeGatewaySessionIncidentState(this.recentEvents.get(sessionId) ?? []),
        }),
      });
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
    const recentEventsMatch = url.pathname.match(/^\/v1\/sessions\/([^/]+)\/events\/recent$/);
    if (recentEventsMatch) {
      if (req.method !== 'GET') {
        writeJson(res, 405, { ok: false, error: 'method_not_allowed' });
        return;
      }
      const sessionId = decodeURIComponent(recentEventsMatch[1]!);
      writeJson(res, 200, {
        ok: true,
        events: buildGatewayRecentEvents(this.recentEvents.get(sessionId) ?? []),
        includesPayloads: false,
        limit: OPEN_GATEWAY_EVENT_RECENT_LIMIT,
      });
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

  private trackRequest(req: IncomingMessage, res: ServerResponse): void {
    const requestId = String(res.getHeader(OPEN_GATEWAY_REQUEST_ID_HEADER) ?? '');
    const startedAt = this.now();
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    let recorded = false;
    const record = () => {
      if (recorded) return;
      recorded = true;
      const completedAt = this.now();
      this.recentRequests.push({
        requestId,
        method: req.method ?? 'GET',
        path: capGatewayPath(redactSecrets(url.pathname)),
        statusCode: res.statusCode,
        startedAt,
        completedAt,
        durationMs: Math.max(0, completedAt - startedAt),
      });
      if (this.recentRequests.length > OPEN_GATEWAY_REQUEST_RECENT_LIMIT) {
        this.recentRequests.splice(0, this.recentRequests.length - OPEN_GATEWAY_REQUEST_RECENT_LIMIT);
      }
    };
    res.once('finish', record);
    res.once('close', record);
  }

  private openSessionEventStream(
    sessionId: string,
    replayAfterEventId: string | undefined,
    req: IncomingMessage,
    res: ServerResponse,
  ): void {
    if (
      this.countEventClients() >= OPEN_GATEWAY_EVENT_STREAM_TOTAL_LIMIT ||
      (this.eventClients.get(sessionId)?.size ?? 0) >= OPEN_GATEWAY_EVENT_STREAM_PER_SESSION_LIMIT
    ) {
      writeJson(res, 429, { ok: false, error: 'too_many_event_streams' });
      return;
    }

    res.statusCode = 200;
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.write('retry: 1000\n');
    res.write(`: session ${sessionId} connected\n\n`);

    let client: GatewayEventClient;
    const resetIdleTimer = () => {
      clearTimeout(client.idleTimeout);
      client.idleTimeout = setTimeout(() => {
        this.removeEventClient(sessionId, client);
      }, OPEN_GATEWAY_EVENT_IDLE_TIMEOUT_MS);
    };
    client = {
      response: res,
      heartbeat: setInterval(() => {
        res.write(`: heartbeat ${this.now()}\n\n`);
      }, OPEN_GATEWAY_EVENT_HEARTBEAT_MS),
      write(chunk) {
        res.write(chunk);
        resetIdleTimer();
      },
      idleTimeout: setTimeout(() => {
        this.removeEventClient(sessionId, client);
      }, OPEN_GATEWAY_EVENT_IDLE_TIMEOUT_MS),
      closed: false,
    };
    const clients = this.eventClients.get(sessionId) ?? new Set<GatewayEventClient>();
    clients.add(client);
    this.eventClients.set(sessionId, clients);
    this.emitStatusChanged();
    this.replayRecentEvents(sessionId, replayAfterEventId, client);

    req.on('close', () => this.removeEventClient(sessionId, client));
  }

  private removeEventClient(sessionId: string, client: GatewayEventClient): void {
    if (client.closed) return;
    client.closed = true;
    clearInterval(client.heartbeat);
    clearTimeout(client.idleTimeout);
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

  private buildGlobalEventState(): GatewayGlobalEventState {
    let bufferedEvents = 0;
    let oldestEvent: GatewayGlobalReplayEventSummary | undefined;
    let newestEvent: GatewayGlobalReplayEventSummary | undefined;
    for (const [sessionId, events] of this.recentEvents) {
      bufferedEvents += events.length;
      for (const event of events) {
        const summary: GatewayGlobalReplayEventSummary = {
          sessionId: capReplayCursor(redactSecrets(sessionId)),
          ...summarizeReplayEvent(event),
        };
        if (!oldestEvent || (summary.ts ?? 0) < (oldestEvent.ts ?? 0)) oldestEvent = summary;
        if (!newestEvent || (summary.ts ?? 0) >= (newestEvent.ts ?? 0)) newestEvent = summary;
      }
    }
    return {
      replayLimitPerSession: OPEN_GATEWAY_EVENT_REPLAY_LIMIT,
      bufferedEvents,
      bufferedSessionCount: [...this.recentEvents.values()].filter((events) => events.length > 0).length,
      activeStreams: this.countEventClients(),
      includesPayloads: false,
      ...(oldestEvent ? { oldestEvent } : {}),
      ...(newestEvent ? { newestEvent } : {}),
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
  res.end(JSON.stringify(attachRequestIdToErrorPayload(res, payload)));
}

type JsonBodyResult =
  | { ok: true; value: unknown }
  | { ok: false; status: number; error: string };

const OPEN_GATEWAY_MAX_BODY_BYTES = 16 * 1024;
const OPEN_GATEWAY_MESSAGE_PAGE_DEFAULT_LIMIT = 100;
const OPEN_GATEWAY_MESSAGE_PAGE_MAX_LIMIT = 200;
const OPEN_GATEWAY_EVENT_HEARTBEAT_MS = 15_000;
const OPEN_GATEWAY_EVENT_IDLE_TIMEOUT_MS = 5 * 60 * 1_000;
const OPEN_GATEWAY_EVENT_STREAM_TOTAL_LIMIT = 10;
const OPEN_GATEWAY_EVENT_STREAM_PER_SESSION_LIMIT = 3;
const OPEN_GATEWAY_EVENT_REPLAY_LIMIT = 100;
const OPEN_GATEWAY_EVENT_RECENT_LIMIT = 50;
const OPEN_GATEWAY_REPLAY_CURSOR_LIMIT = 256;
const OPEN_GATEWAY_REPLAY_MISS_EVENT = 'gateway_replay_miss';
const OPEN_GATEWAY_INCIDENT_LIMIT = 20;
const OPEN_GATEWAY_INCIDENT_AGGREGATE_LIMIT = 50;
const OPEN_GATEWAY_INCIDENT_TEXT_LIMIT = 500;
const OPEN_GATEWAY_REQUEST_ID_HEADER = 'X-Maka-Request-Id';
const OPEN_GATEWAY_REQUEST_RECENT_LIMIT = 50;
const OPEN_GATEWAY_PATH_LIMIT = 500;

function gatewayInternalFailureMessage(): string {
  return '开放网关暂时不可用，请稍后重试。';
}

function createGatewayRequestId(): string {
  return `gw_${randomUUID()}`;
}

function attachRequestIdToErrorPayload(res: ServerResponse, payload: unknown): unknown {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return payload;
  const record = payload as Record<string, unknown>;
  if (record.ok !== false || typeof record.error !== 'string') return payload;
  const requestId = res.getHeader(OPEN_GATEWAY_REQUEST_ID_HEADER);
  if (typeof requestId !== 'string' || requestId.length === 0) return payload;
  return { ...record, requestId };
}

function capGatewayPath(value: string): string {
  if (value.length <= OPEN_GATEWAY_PATH_LIMIT) return value;
  return `${value.slice(0, OPEN_GATEWAY_PATH_LIMIT)}…`;
}

interface GatewayEventClient {
  response: ServerResponse;
  heartbeat: ReturnType<typeof setInterval>;
  idleTimeout: ReturnType<typeof setTimeout>;
  closed: boolean;
  write(chunk: string): void;
}

interface GatewayRequestSummary {
  requestId: string;
  method: string;
  path: string;
  statusCode: number;
  startedAt: number;
  completedAt: number;
  durationMs: number;
}

interface GatewayRequestIndexState {
  requestCount: number;
  errorCount: number;
  limit: number;
  includesHeaders: false;
  includesQuery: false;
  includesPayloads: false;
  byStatusCode: Record<string, number>;
  newestRequest?: GatewayRequestSummary;
  oldestRequest?: GatewayRequestSummary;
}

function buildGatewayRequestIndexState(requests: readonly GatewayRequestSummary[]): GatewayRequestIndexState {
  const byStatusCode: Record<string, number> = {};
  let errorCount = 0;
  for (const request of requests) {
    byStatusCode[String(request.statusCode)] = (byStatusCode[String(request.statusCode)] ?? 0) + 1;
    if (request.statusCode >= 400) errorCount += 1;
  }
  return {
    requestCount: requests.length,
    errorCount,
    limit: OPEN_GATEWAY_REQUEST_RECENT_LIMIT,
    includesHeaders: false,
    includesQuery: false,
    includesPayloads: false,
    byStatusCode,
    ...(requests[0] ? { oldestRequest: requests[0] } : {}),
    ...(requests.at(-1) ? { newestRequest: requests.at(-1) } : {}),
  };
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

type GatewayIncidentIndexItem = GatewayIncidentSummary & { sessionId: string };

interface GatewayIncidentIndexState {
  incidentCount: number;
  incidentSessionCount: number;
  limit: number;
  includesPayloads: false;
  newestIncident?: GatewayIncidentIndexItem;
  oldestIncident?: GatewayIncidentIndexItem;
}

function buildGatewayCapabilities(sendAvailable: boolean): string[] {
  return [
    'events.state',
    'gateway.openapi',
    'gateway.state',
    'incidents.list',
    'incidents.state',
    'requests.recent',
    'sessions.detail_state',
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
    'sessions.events.recent',
    'sessions.incidents.read',
    'search.thread',
  ];
}

function buildGatewayOpenApiSpec(sendAvailable: boolean): Record<string, unknown> {
  const bearerSecurity = [{ bearerAuth: [] }];
  return {
    openapi: '3.1.0',
    info: {
      title: 'Maka Open Gateway',
      version: '0.1.0',
      description: 'Local token-protected Maka gateway API. State endpoints avoid message text, previews, and event payloads.',
    },
    servers: [{ url: 'http://127.0.0.1:3939', description: 'Default local gateway address' }],
    security: bearerSecurity,
    paths: {
      '/health': {
        get: {
          summary: 'Gateway health',
          security: [],
          responses: jsonResponses('Gateway runtime health; does not require bearer auth.'),
        },
      },
      '/v1/openapi.json': {
        get: {
          summary: 'OpenAPI description',
          responses: jsonResponses('Machine-readable description of the token-protected gateway surface.'),
        },
      },
      '/v1/capabilities': {
        get: {
          summary: 'Gateway capabilities',
          responses: jsonResponses('Current capability keys and endpoint metadata.'),
        },
      },
      '/v1/state': {
        get: {
          summary: 'Gateway overview state',
          responses: jsonResponses('Gateway, session, incident, and capability state without payloads or previews.'),
        },
      },
      '/v1/sessions': {
        get: {
          summary: 'List sessions',
          responses: jsonResponses('Session summaries visible to the local app.'),
        },
      },
      '/v1/sessions/state': {
        get: {
          summary: 'Session aggregate state',
          responses: jsonResponses('Counts and oldest/newest session summaries without titles or previews.'),
        },
      },
      '/v1/sessions/{sessionId}/state': {
        get: {
          summary: 'Single session state',
          parameters: [pathParam('sessionId', 'Session id')],
          responses: jsonResponses('One session status, counts, replay state, and incident state without text or previews.'),
        },
      },
      '/v1/sessions/{sessionId}/messages': {
        get: {
          summary: 'Read session messages',
          parameters: [
            pathParam('sessionId', 'Session id'),
            queryParam('limit', 'Optional page size, capped at 200.'),
            queryParam('before', 'Optional message id cursor for backward pagination.'),
          ],
          responses: jsonResponses('Message page for one session.'),
        },
        ...(sendAvailable
          ? {
              post: {
                summary: 'Send a message',
                parameters: [pathParam('sessionId', 'Session id')],
                requestBody: jsonRequestBody({
                  type: 'object',
                  required: ['text'],
                  properties: { text: { type: 'string', minLength: 1, maxLength: 20000 } },
                  additionalProperties: false,
                }),
                responses: jsonResponses('Accepted turn id.'),
              },
            }
          : {}),
      },
      '/v1/sessions/{sessionId}/messages/state': {
        get: {
          summary: 'Message aggregate state',
          parameters: [pathParam('sessionId', 'Session id')],
          responses: jsonResponses('Message count and oldest/newest summaries without text.'),
        },
      },
      '/v1/sessions/{sessionId}/events': {
        get: {
          summary: 'Stream session events',
          parameters: [
            pathParam('sessionId', 'Session id'),
            queryParam('after', 'Optional event replay cursor; equivalent to Last-Event-ID.'),
          ],
          responses: {
            200: { description: 'Server-sent event stream.' },
            401: { description: 'Missing or invalid bearer token.' },
          },
        },
      },
      '/v1/sessions/{sessionId}/events/state': {
        get: {
          summary: 'Event replay state',
          parameters: [pathParam('sessionId', 'Session id')],
          responses: jsonResponses('Replay buffer and active stream state without event payloads.'),
        },
      },
      '/v1/sessions/{sessionId}/events/recent': {
        get: {
          summary: 'Recent event summaries',
          parameters: [pathParam('sessionId', 'Session id')],
          responses: jsonResponses('Bounded recent event summaries without event payloads.'),
        },
      },
      '/v1/events/state': {
        get: {
          summary: 'Global event aggregate state',
          responses: jsonResponses('Aggregate replay buffer and active stream state across sessions without event payloads.'),
        },
      },
      '/v1/requests/recent': {
        get: {
          summary: 'Recent gateway requests',
          responses: jsonResponses('Recent request metadata with request ids, methods, paths, statuses, and timings; excludes query, headers, and payloads.'),
        },
      },
      '/v1/sessions/{sessionId}/incidents': {
        get: {
          summary: 'Session incident summaries',
          parameters: [pathParam('sessionId', 'Session id')],
          responses: jsonResponses('Bounded recent error/abort summaries without event payload replay.'),
        },
      },
      '/v1/incidents': {
        get: {
          summary: 'Incident index',
          responses: jsonResponses('Bounded recent incident summaries across sessions.'),
        },
      },
      '/v1/incidents/state': {
        get: {
          summary: 'Incident aggregate state',
          responses: jsonResponses('Incident counts and oldest/newest summaries.'),
        },
      },
      '/v1/search/thread': {
        get: {
          summary: 'Thread search',
          parameters: [queryParam('q', 'Search query.')],
          responses: jsonResponses('Thread search results or normalized search failure.'),
        },
      },
    },
    components: {
      securitySchemes: {
        bearerAuth: {
          type: 'http',
          scheme: 'bearer',
        },
      },
    },
  };
}

function jsonResponses(description: string): Record<string, unknown> {
  return {
    200: {
      description,
      content: {
        'application/json': {
          schema: { type: 'object', additionalProperties: true },
        },
      },
    },
    401: { description: 'Missing or invalid bearer token.' },
  };
}

function jsonRequestBody(schema: Record<string, unknown>): Record<string, unknown> {
  return {
    required: true,
    content: {
      'application/json': { schema },
    },
  };
}

function pathParam(name: string, description: string): Record<string, unknown> {
  return {
    name,
    in: 'path',
    required: true,
    description,
    schema: { type: 'string' },
  };
}

function queryParam(name: string, description: string): Record<string, unknown> {
  return {
    name,
    in: 'query',
    required: false,
    description,
    schema: { type: 'string' },
  };
}

interface GatewayOverviewState {
  generatedAt: number;
  includesPayloads: false;
  includesPreviews: false;
  gateway: OpenGatewayStatus;
  capabilities: string[];
  sessions: GatewaySessionsState;
  incidents: GatewayIncidentIndexState;
  requests: GatewayRequestIndexState;
}

function buildGatewayOverviewState(input: {
  gateway: OpenGatewayStatus;
  sessions: SessionSummary[];
  recentEvents: ReadonlyMap<string, readonly SessionEvent[]>;
  recentRequests: readonly GatewayRequestSummary[];
  sendAvailable: boolean;
  generatedAt: number;
}): GatewayOverviewState {
  return {
    generatedAt: input.generatedAt,
    includesPayloads: false,
    includesPreviews: false,
    gateway: input.gateway,
    capabilities: buildGatewayCapabilities(input.sendAvailable),
    sessions: buildGatewaySessionsState(input.sessions, input.recentEvents),
    incidents: buildGatewayIncidentIndexState(input.recentEvents),
    requests: buildGatewayRequestIndexState(input.recentRequests),
  };
}

interface GatewaySessionsState {
  sessionCount: number;
  archivedCount: number;
  unreadCount: number;
  flaggedCount: number;
  recentIncidentCount: number;
  incidentSessionCount: number;
  includesPreviews: false;
  byStatus: Record<string, number>;
  newestSession?: GatewaySessionSummary;
  oldestSession?: GatewaySessionSummary;
}

interface GatewaySessionSummary {
  id: string;
  status: string;
  lastMessageAt?: number;
  recentIncidentCount?: number;
  lastIncidentAt?: number;
}

interface GatewaySessionState {
  session: GatewaySessionSummary & {
    isArchived: boolean;
    hasUnread: boolean;
    isFlagged: boolean;
  };
  includesText: false;
  includesPreviews: false;
  includesPayloads: false;
  messages: GatewayMessageState;
  events: GatewayReplayState;
  incidents: GatewaySessionIncidentState;
}

function buildGatewaySessionsState(
  sessions: SessionSummary[],
  recentEvents: ReadonlyMap<string, readonly SessionEvent[]>,
): GatewaySessionsState {
  const newest = sessions[0];
  const oldest = sessions.at(-1);
  const byStatus: Record<string, number> = {};
  const incidentStateBySession = new Map<string, GatewaySessionIncidentState>();
  let recentIncidentCount = 0;
  let incidentSessionCount = 0;
  for (const session of sessions) {
    byStatus[session.status] = (byStatus[session.status] ?? 0) + 1;
    const incidentState = summarizeGatewaySessionIncidentState(recentEvents.get(session.id) ?? []);
    if (incidentState.recentIncidentCount > 0) {
      incidentStateBySession.set(session.id, incidentState);
      recentIncidentCount += incidentState.recentIncidentCount;
      incidentSessionCount += 1;
    }
  }
  return {
    sessionCount: sessions.length,
    archivedCount: sessions.filter((session) => session.isArchived).length,
    unreadCount: sessions.filter((session) => session.hasUnread).length,
    flaggedCount: sessions.filter((session) => session.isFlagged).length,
    recentIncidentCount,
    incidentSessionCount,
    includesPreviews: false,
    byStatus,
    ...(newest ? { newestSession: summarizeGatewaySession(newest, incidentStateBySession) } : {}),
    ...(oldest ? { oldestSession: summarizeGatewaySession(oldest, incidentStateBySession) } : {}),
  };
}

function summarizeGatewaySession(
  session: SessionSummary,
  incidentStateBySession: ReadonlyMap<string, GatewaySessionIncidentState>,
): GatewaySessionSummary {
  const incidentState = incidentStateBySession.get(session.id);
  return {
    id: capReplayCursor(redactSecrets(session.id)),
    status: session.status,
    ...(session.lastMessageAt ? { lastMessageAt: session.lastMessageAt } : {}),
    ...(incidentState
      ? {
          recentIncidentCount: incidentState.recentIncidentCount,
          lastIncidentAt: incidentState.lastIncidentAt,
        }
      : {}),
  };
}

function buildGatewaySessionState(input: {
  session: SessionSummary;
  messages: StoredMessage[];
  replayState: GatewayReplayState;
  incidentState: GatewaySessionIncidentState;
}): GatewaySessionState {
  const incidentStateBySession = new Map([[input.session.id, input.incidentState]]);
  return {
    session: {
      ...summarizeGatewaySession(input.session, incidentStateBySession),
      isArchived: input.session.isArchived,
      hasUnread: input.session.hasUnread,
      isFlagged: input.session.isFlagged,
    },
    includesText: false,
    includesPreviews: false,
    includesPayloads: false,
    messages: buildGatewayMessageState(input.messages),
    events: input.replayState,
    incidents: input.incidentState,
  };
}

interface GatewaySessionIncidentState {
  recentIncidentCount: number;
  lastIncidentAt: number;
}

function summarizeGatewaySessionIncidentState(events: readonly SessionEvent[]): GatewaySessionIncidentState {
  let recentIncidentCount = 0;
  let lastIncidentAt = 0;
  for (const event of events) {
    if (event.type !== 'error' && event.type !== 'abort') continue;
    recentIncidentCount += 1;
    lastIncidentAt = Math.max(lastIncidentAt, event.ts);
  }
  return { recentIncidentCount, lastIncidentAt };
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

interface GatewayGlobalEventState {
  replayLimitPerSession: number;
  bufferedEvents: number;
  bufferedSessionCount: number;
  activeStreams: number;
  includesPayloads: false;
  oldestEvent?: GatewayGlobalReplayEventSummary;
  newestEvent?: GatewayGlobalReplayEventSummary;
}

type GatewayGlobalReplayEventSummary = GatewayReplayEventSummary & { sessionId: string };

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

function buildGatewayRecentEvents(events: readonly SessionEvent[]): GatewayReplayEventSummary[] {
  return events.slice(-OPEN_GATEWAY_EVENT_RECENT_LIMIT).map(summarizeReplayEvent);
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

function buildGatewayIncidentIndex(recentEvents: ReadonlyMap<string, readonly SessionEvent[]>): GatewayIncidentIndexItem[] {
  const incidents: GatewayIncidentIndexItem[] = [];
  for (const [sessionId, events] of recentEvents) {
    for (const incident of buildGatewayIncidents(events)) {
      incidents.push({
        ...incident,
        sessionId: capReplayCursor(redactSecrets(sessionId)),
      });
    }
  }
  incidents.sort((a, b) => a.ts - b.ts || a.id.localeCompare(b.id));
  return incidents.slice(-OPEN_GATEWAY_INCIDENT_AGGREGATE_LIMIT);
}

function buildGatewayIncidentIndexState(recentEvents: ReadonlyMap<string, readonly SessionEvent[]>): GatewayIncidentIndexState {
  const incidents = buildGatewayIncidentIndex(recentEvents);
  const incidentSessions = new Set(incidents.map((incident) => incident.sessionId));
  const newestIncident = incidents.at(-1);
  const oldestIncident = incidents[0];
  return {
    incidentCount: incidents.length,
    incidentSessionCount: incidentSessions.size,
    limit: OPEN_GATEWAY_INCIDENT_AGGREGATE_LIMIT,
    includesPayloads: false,
    ...(newestIncident ? { newestIncident } : {}),
    ...(oldestIncident ? { oldestIncident } : {}),
  };
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
