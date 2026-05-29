import { strict as assert } from 'node:assert';
import { afterEach, describe, test } from 'node:test';
import type { AppSettings, SearchResult, SessionEvent, SessionSummary, StoredMessage } from '@maka/core';
import { createDefaultSettings } from '@maka/core/settings';
import { OpenGatewayService } from '../open-gateway.js';

const activeServices: OpenGatewayService[] = [];

afterEach(async () => {
  await Promise.all(activeServices.splice(0).map((service) => service.stop()));
});

describe('OpenGatewayService', () => {
  test('stays stopped when disabled or missing token', async () => {
    const service = makeService();
    activeServices.push(service);
    const disabled = createGatewaySettings({ enabled: false, token: 'dev-token' });

    assert.equal((await service.sync(disabled.openGateway)).running, false);

    const missingToken = createGatewaySettings({ enabled: true, token: '' });
    const status = await service.sync(missingToken.openGateway);

    assert.equal(status.running, false);
    assert.equal(status.lastError, 'missing_token');
    assert.equal(status.tokenConfigured, false);
  });

  test('serves health without auth and protects v1 endpoints with bearer token', async () => {
    const service = makeService();
    activeServices.push(service);
    const status = await service.sync(createGatewaySettings({ enabled: true, port: 0, token: 'dev-token' }).openGateway);
    assert.equal(status.running, true);
    assert.ok(status.baseUrl);

    const health = await fetchJson(`${status.baseUrl}/health`);
    assert.equal(health.status, 200);
    assert.equal(health.body.ok, true);
    assert.equal(health.body.gateway.running, true);

    const unauthorized = await fetchJson(`${status.baseUrl}/v1/capabilities`);
    assert.equal(unauthorized.status, 401);
    assert.equal(unauthorized.body.error, 'unauthorized');

    const authorized = await fetchJson(`${status.baseUrl}/v1/capabilities`, 'dev-token');
    assert.equal(authorized.status, 200);
    assert.deepEqual(authorized.body.capabilities, [
      'sessions.list',
      'sessions.messages.read',
      'sessions.messages.send',
      'sessions.events.stream',
      'sessions.events.replay',
      'sessions.events.replay_miss',
      'sessions.incidents.read',
      'search.thread',
    ]);
    assert.deepEqual(authorized.body.sessionEvents, {
      stream: true,
      cursor: {
        header: 'Last-Event-ID',
        query: 'after',
        maxLength: 256,
      },
      replay: {
        limit: 100,
        missEvent: 'gateway_replay_miss',
        missAdvancesCursor: false,
        partialReplayOnMiss: false,
      },
    });
  });

  test('exposes local sessions, messages, and thread search read APIs', async () => {
    const sessions = [session({ id: 's1', name: 'Alpha' })];
    const messages = [userMessage('hello gateway')];
    let searchedFor = '';
    const service = makeService({
      listSessions: async () => sessions,
      readMessages: async (sessionId) => (sessionId === 's1' ? messages : []),
      searchThread: async (query) => {
        searchedFor = query;
        return [searchResult({ sessionId: 's1', snippet: 'hello gateway' })];
      },
    });
    activeServices.push(service);
    const status = await service.sync(createGatewaySettings({ enabled: true, port: 0, token: 'dev-token' }).openGateway);
    assert.ok(status.baseUrl);

    const sessionResponse = await fetchJson(`${status.baseUrl}/v1/sessions`, 'dev-token');
    assert.equal(sessionResponse.status, 200);
    assert.equal(sessionResponse.body.sessions[0].id, 's1');

    const messageResponse = await fetchJson(`${status.baseUrl}/v1/sessions/s1/messages`, 'dev-token');
    assert.equal(messageResponse.status, 200);
    assert.equal(messageResponse.body.messages[0].text, 'hello gateway');

    const searchResponse = await fetchJson(`${status.baseUrl}/v1/search/thread?q=gateway`, 'dev-token');
    assert.equal(searchResponse.status, 200);
    assert.equal(searchedFor, 'gateway');
    assert.equal(searchResponse.body.result[0].target.sessionId, 's1');
  });

  test('accepts token-protected session sends and returns the turn id', async () => {
    let sent: { sessionId: string; text: string } | null = null;
    const service = makeService({
      sendMessage: async (sessionId, input) => {
        sent = { sessionId, text: input.text };
        return { turnId: 'turn-gateway' };
      },
    });
    activeServices.push(service);
    const status = await service.sync(createGatewaySettings({ enabled: true, port: 0, token: 'dev-token' }).openGateway);
    assert.ok(status.baseUrl);

    const unauthorized = await fetchJson(`${status.baseUrl}/v1/sessions/s1/messages`, {
      method: 'POST',
      body: { text: 'hello from gateway' },
    });
    assert.equal(unauthorized.status, 401);
    assert.equal(sent, null);

    const response = await fetchJson(`${status.baseUrl}/v1/sessions/s1/messages`, {
      token: 'dev-token',
      method: 'POST',
      body: { text: 'hello from gateway' },
    });

    assert.equal(response.status, 202);
    assert.equal(response.body.turnId, 'turn-gateway');
    assert.deepEqual(sent, { sessionId: 's1', text: 'hello from gateway' });
  });

  test('streams token-protected live session events as SSE', async () => {
    const statusChanges: number[] = [];
    const service = makeService({
      onStatusChanged: (status) => {
        statusChanges.push(status.activeEventStreams);
      },
    });
    activeServices.push(service);
    const status = await service.sync(createGatewaySettings({ enabled: true, port: 0, token: 'dev-token' }).openGateway);
    assert.ok(status.baseUrl);
    assert.equal(status.activeEventStreams, 0);

    const unauthorized = await fetch(`${status.baseUrl}/v1/sessions/s1/events`);
    assert.equal(unauthorized.status, 401);
    assert.equal((await unauthorized.json()).error, 'unauthorized');

    const controller = new AbortController();
    const response = await fetch(`${status.baseUrl}/v1/sessions/s1/events`, {
      headers: { Authorization: 'Bearer dev-token' },
      signal: controller.signal,
    });
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type') ?? '', /^text\/event-stream/);
    assert.equal(service.getStatus().activeEventStreams, 1);
    assert.ok(statusChanges.includes(1), 'opening an SSE stream should publish activeEventStreams=1');

    const health = await fetchJson(`${status.baseUrl}/health`);
    assert.equal(health.body.gateway.activeEventStreams, 1);

    const reader = response.body!.getReader();
    service.publishSessionEvent('s1', textDeltaEvent({ id: 'event-1', turnId: 'turn-1', text: 'hello gateway stream' }));
    const chunk = await readUntil(reader, 'event: text_delta');
    controller.abort();
    await waitFor(() => service.getStatus().activeEventStreams === 0);

    assert.match(chunk, /id: event-1/);
    assert.match(chunk, /event: text_delta/);
    assert.match(chunk, /data: \{"type":"text_delta"/);
    assert.match(chunk, /hello gateway stream/);
    assert.ok(statusChanges.includes(0), 'closing an SSE stream should publish activeEventStreams=0');
  });

  test('replays recent SSE events after Last-Event-ID cursor', async () => {
    const service = makeService();
    activeServices.push(service);
    const status = await service.sync(createGatewaySettings({ enabled: true, port: 0, token: 'dev-token' }).openGateway);
    assert.ok(status.baseUrl);

    service.publishSessionEvent('s1', textDeltaEvent({ id: 'event-1', turnId: 'turn-1', text: 'already seen' }));
    service.publishSessionEvent('s1', textDeltaEvent({ id: 'event-2', turnId: 'turn-1', text: 'replay me' }));

    const controller = new AbortController();
    const response = await fetch(`${status.baseUrl}/v1/sessions/s1/events`, {
      headers: {
        Authorization: 'Bearer dev-token',
        'Last-Event-ID': 'event-1',
      },
      signal: controller.signal,
    });
    assert.equal(response.status, 200);

    const reader = response.body!.getReader();
    const chunk = await readUntil(reader, 'replay me');
    controller.abort();

    assert.doesNotMatch(chunk, /already seen/);
    assert.match(chunk, /id: event-2/);
    assert.match(chunk, /event: text_delta/);
    assert.match(chunk, /replay me/);
  });

  test('surfaces replay cursor misses as structured SSE events', async () => {
    const service = makeService();
    activeServices.push(service);
    const status = await service.sync(createGatewaySettings({ enabled: true, port: 0, token: 'dev-token' }).openGateway);
    assert.ok(status.baseUrl);

    service.publishSessionEvent('s1', textDeltaEvent({ id: 'event-2', turnId: 'turn-1', text: 'newer event' }));

    const controller = new AbortController();
    const response = await fetch(`${status.baseUrl}/v1/sessions/s1/events`, {
      headers: {
        Authorization: 'Bearer dev-token',
        'Last-Event-ID': 'event-missing',
      },
      signal: controller.signal,
    });
    assert.equal(response.status, 200);

    const reader = response.body!.getReader();
    const chunk = await readUntil(reader, 'gateway_replay_miss');
    controller.abort();

    assert.match(chunk, /event: gateway_replay_miss/);
    assert.match(chunk, /"type":"gateway_replay_miss"/);
    assert.match(chunk, /"reason":"cursor_not_found"/);
    assert.match(chunk, /"requestedEventId":"event-missing"/);
    assert.match(chunk, /"replayLimit":100/);
    assert.doesNotMatch(chunk, /id:/, 'replay-miss diagnostics must not advance Last-Event-ID');
    assert.doesNotMatch(chunk, /newer event/, 'cursor miss requires client resync instead of partial replay');
  });

  test('exposes bounded redacted recent run incidents without event payload replay', async () => {
    const service = makeService();
    activeServices.push(service);
    const status = await service.sync(createGatewaySettings({ enabled: true, port: 0, token: 'dev-token' }).openGateway);
    assert.ok(status.baseUrl);

    service.publishSessionEvent('s1', textDeltaEvent({ id: 'event-ok', turnId: 'turn-1', text: 'normal stream' }));
    service.publishSessionEvent('s1', errorEvent({
      id: 'event-error',
      turnId: 'turn-1',
      message: 'Provider failed with Authorization: Bearer sk-live-secret-token-value',
      reason: 'provider_error',
      code: 'upstream_500',
    }));
    service.publishSessionEvent('s1', abortEvent({ id: 'event-abort', turnId: 'turn-2', reason: 'timeout' }));

    const response = await fetchJson(`${status.baseUrl}/v1/sessions/s1/incidents`, 'dev-token');
    assert.equal(response.status, 200);
    assert.equal(response.body.ok, true);
    assert.equal(response.body.incidents.length, 2);
    assert.deepEqual(response.body.incidents.map((item: any) => item.type), ['error', 'abort']);
    assert.equal(response.body.incidents[0].id, 'incident:event-error');
    assert.equal(response.body.incidents[0].eventId, 'event-error');
    assert.equal(response.body.incidents[0].turnId, 'turn-1');
    assert.match(response.body.incidents[0].message, /\[redacted\]/);
    assert.doesNotMatch(JSON.stringify(response.body.incidents), /sk-live-secret-token-value/);
    assert.equal(response.body.incidents[1].reason, 'timeout');

    const unauthorized = await fetchJson(`${status.baseUrl}/v1/sessions/s1/incidents`);
    assert.equal(unauthorized.status, 401);
  });

  test('caps gateway incidents to the most recent entries', async () => {
    const service = makeService();
    activeServices.push(service);
    const status = await service.sync(createGatewaySettings({ enabled: true, port: 0, token: 'dev-token' }).openGateway);
    assert.ok(status.baseUrl);

    for (let index = 0; index < 25; index += 1) {
      service.publishSessionEvent('s1', errorEvent({
        id: `event-error-${index}`,
        turnId: `turn-${index}`,
        message: `failure ${index}`,
      }));
    }

    const response = await fetchJson(`${status.baseUrl}/v1/sessions/s1/incidents`, 'dev-token');
    assert.equal(response.status, 200);
    assert.equal(response.body.incidents.length, 20);
    assert.equal(response.body.incidents[0].eventId, 'event-error-5');
    assert.equal(response.body.incidents[19].eventId, 'event-error-24');
  });

  test('closes existing SSE clients when the gateway token rotates', async () => {
    let settings = createGatewaySettings({ enabled: true, port: 0, token: 'old-token' });
    const service = makeService({
      getSettings: async () => settings,
    });
    activeServices.push(service);
    const status = await service.sync(settings.openGateway);
    assert.ok(status.baseUrl);

    const response = await fetch(`${status.baseUrl}/v1/sessions/s1/events`, {
      headers: { Authorization: 'Bearer old-token' },
    });
    assert.equal(response.status, 200);
    const reader = response.body!.getReader();

    settings = createGatewaySettings({
      enabled: true,
      host: status.host,
      port: status.port,
      token: 'new-token',
    });
    await service.sync(settings.openGateway);

    const closed = await readUntilClosed(reader);
    assert.match(closed, /session s1 connected/);

    const oldToken = await fetchJson(`${status.baseUrl}/v1/capabilities`, 'old-token');
    assert.equal(oldToken.status, 401);
    const newToken = await fetchJson(`${status.baseUrl}/v1/capabilities`, 'new-token');
    assert.equal(newToken.status, 200);
  });

  test('rejects invalid gateway send bodies before calling runtime send', async () => {
    let calls = 0;
    const service = makeService({
      sendMessage: async () => {
        calls += 1;
        return { turnId: 'turn-never' };
      },
    });
    activeServices.push(service);
    const status = await service.sync(createGatewaySettings({ enabled: true, port: 0, token: 'dev-token' }).openGateway);
    assert.ok(status.baseUrl);

    const empty = await fetchJson(`${status.baseUrl}/v1/sessions/s1/messages`, {
      token: 'dev-token',
      method: 'POST',
      body: { text: '   ' },
    });
    assert.equal(empty.status, 400);
    assert.equal(empty.body.error, 'empty_text');

    const oversize = await fetchJson(`${status.baseUrl}/v1/sessions/s1/messages`, {
      token: 'dev-token',
      method: 'POST',
      body: { text: 'x'.repeat(8_001) },
    });
    assert.equal(oversize.status, 400);
    assert.equal(oversize.body.error, 'text_too_large');
    assert.equal(calls, 0);
  });
});

function makeService(overrides: Partial<ConstructorParameters<typeof OpenGatewayService>[0]> = {}): OpenGatewayService {
  let settings = createGatewaySettings({ enabled: true, port: 0, token: 'dev-token' });
  return new OpenGatewayService({
    getSettings: async () => settings,
    listSessions: async () => [],
    readMessages: async () => [],
    sendMessage: async () => ({ turnId: 'turn-1' }),
    searchThread: async () => [],
    now: () => 1_700_000_000_000,
    ...overrides,
    ...(overrides.getSettings
      ? {}
      : {
          getSettings: async () => settings,
        }),
  });
}

function createGatewaySettings(patch: Partial<AppSettings['openGateway']>): AppSettings {
  const settings = createDefaultSettings();
  settings.openGateway = {
    ...settings.openGateway,
    ...patch,
  };
  return settings;
}

async function fetchJson(
  url: string,
  input?: string | { token?: string; method?: string; body?: unknown },
): Promise<{ status: number; body: any }> {
  const token = typeof input === 'string' ? input : input?.token;
  const response = await fetch(url, {
    method: typeof input === 'string' ? undefined : input?.method,
    headers: token ? { Authorization: `Bearer ${token}` } : undefined,
    body: typeof input === 'string' || input?.body === undefined ? undefined : JSON.stringify(input.body),
  });
  return {
    status: response.status,
    body: await response.json(),
  };
}

function session(overrides: Partial<SessionSummary> & { id: string }): SessionSummary {
  return {
    name: overrides.id,
    isFlagged: false,
    isArchived: false,
    labels: [],
    hasUnread: false,
    status: 'active',
    backend: 'ai-sdk',
    llmConnectionSlug: 'anthropic',
    model: 'claude-sonnet-4-5-20250929',
    permissionMode: 'ask',
    lastMessageAt: 1_700_000_000_000,
    ...overrides,
  };
}

function userMessage(text: string): StoredMessage {
  return { type: 'user', id: 'm1', turnId: 't1', ts: 1_700_000_000_000, text };
}

function textDeltaEvent(input: { id: string; turnId: string; text: string }): SessionEvent {
  return {
    type: 'text_delta',
    id: input.id,
    turnId: input.turnId,
    messageId: 'assistant-1',
    ts: 1_700_000_000_000,
    text: input.text,
  };
}

function errorEvent(input: {
  id: string;
  turnId: string;
  message: string;
  recoverable?: boolean;
  code?: string;
  reason?: string;
}): SessionEvent {
  return {
    type: 'error',
    id: input.id,
    turnId: input.turnId,
    ts: 1_700_000_000_000,
    recoverable: input.recoverable ?? false,
    message: input.message,
    ...(input.code ? { code: input.code } : {}),
    ...(input.reason ? { reason: input.reason } : {}),
  };
}

function abortEvent(input: {
  id: string;
  turnId: string;
  reason: 'user_stop' | 'redirect' | 'timeout' | 'crash';
}): SessionEvent {
  return {
    type: 'abort',
    id: input.id,
    turnId: input.turnId,
    ts: 1_700_000_000_001,
    reason: input.reason,
  };
}

async function readUntil(reader: ReadableStreamDefaultReader<Uint8Array>, needle: string): Promise<string> {
  const decoder = new TextDecoder();
  let text = '';
  const deadline = Date.now() + 2_000;
  while (!text.includes(needle)) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${needle}. Received: ${text}`);
    const read = await reader.read();
    if (read.done) break;
    text += decoder.decode(read.value, { stream: true });
  }
  return text;
}

async function readUntilClosed(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<string> {
  const decoder = new TextDecoder();
  let text = '';
  const deadline = Date.now() + 2_000;
  while (true) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for SSE close. Received: ${text}`);
    const read = await reader.read();
    if (read.done) return text;
    text += decoder.decode(read.value, { stream: true });
  }
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('Timed out waiting for predicate');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function searchResult(overrides: { sessionId: string; snippet?: string }): SearchResult {
  return {
    source: 'thread',
    title: 'Alpha',
    snippet: overrides.snippet ?? 'gateway',
    target: { kind: 'thread', sessionId: overrides.sessionId, turnId: 't1' },
  };
}
