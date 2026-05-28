import { strict as assert } from 'node:assert';
import { afterEach, describe, test } from 'node:test';
import type { AppSettings, SearchResult, SessionSummary, StoredMessage } from '@maka/core';
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
    assert.deepEqual(authorized.body.capabilities, ['sessions.list', 'sessions.messages.read', 'search.thread']);
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
});

function makeService(overrides: Partial<ConstructorParameters<typeof OpenGatewayService>[0]> = {}): OpenGatewayService {
  let settings = createGatewaySettings({ enabled: true, port: 0, token: 'dev-token' });
  return new OpenGatewayService({
    getSettings: async () => settings,
    listSessions: async () => [],
    readMessages: async () => [],
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

async function fetchJson(url: string, token?: string): Promise<{ status: number; body: any }> {
  const response = await fetch(url, {
    headers: token ? { Authorization: `Bearer ${token}` } : undefined,
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

function searchResult(overrides: { sessionId: string; snippet?: string }): SearchResult {
  return {
    source: 'thread',
    title: 'Alpha',
    snippet: overrides.snippet ?? 'gateway',
    target: { kind: 'thread', sessionId: overrides.sessionId, turnId: 't1' },
  };
}
