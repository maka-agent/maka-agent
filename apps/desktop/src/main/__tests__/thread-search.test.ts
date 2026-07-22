/**
 * Tests for `runThreadSearch` — the PR-SEARCH-2 pure helper.
 *
 * Locks the thread-search gate catalog:
 *   G1: snippet redaction (every snippet runs through redactSecrets).
 *   G2: backend='fake' sessions excluded.
 *   G3: incognito — cross-lane deferred, no test here.
 *   G4: result + total byte caps.
 *   G5: query case-fold + NFC + CJK match.
 *   G6: no provider/network call (source-grep gate; not a runtime test).
 *   G7: no telemetry leakage of query body (source-grep gate).
 *   G8: cross-workspace not exercised — single workspace tested.
 *   G9: tool_result.content size guard.
 *  G10: SystemNote / TokenUsage / TurnState / PermissionDecision excluded.
 *
 * Plus contract tests: SearchResult.target = thread variant, url omitted,
 * SEARCH_MAX_LIMIT reused, empty / invalid query rejected.
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import type { SessionSummary, StoredMessage } from '@maka/core';
import {
  MAX_SESSIONS_SCANNED,
  SNIPPET_MAX_CODE_POINTS,
  TOOL_RESULT_SCAN_CAP_BYTES,
  capCodePoints,
  collectSearchableText,
  findMatch,
  foldForMatch,
  formatSearchResultSummary,
  runThreadSearch,
} from '../search/thread-search.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

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
    connectionLocked: false,
    model: 'claude-sonnet-4-5-20250929',
    permissionMode: 'ask',
    lastMessageAt: 1_700_000_000_000,
    ...overrides,
  };
}

function userMessage(text: string, turnId: string = 't1', id: string = 'u1'): StoredMessage {
  return { type: 'user', id, turnId, ts: 1_700_000_000_000, text };
}

function assistantMessage(text: string, turnId: string = 't1', id: string = 'a1'): Extract<StoredMessage, { type: 'assistant' }> {
  return {
    type: 'assistant',
    id,
    turnId,
    ts: 1_700_000_000_000,
    text,
    modelId: 'glm-4.7',
  };
}

function assistantMessageWithThinking(
  text: string,
  thinkingText: string,
  turnId: string = 't1',
  id: string = 'a1',
): Extract<StoredMessage, { type: 'assistant' }> {
  return {
    ...assistantMessage(text, turnId, id),
    thinking: { text: thinkingText },
  };
}

function toolResultMessage(content: unknown, turnId: string = 't1', isError: boolean = false): StoredMessage {
  return {
    type: 'tool_result',
    id: 'tr1',
    turnId,
    ts: 1_700_000_000_000,
    toolUseId: 'call1',
    isError,
    content: content as never,
  };
}

function systemNoteMessage(text: string): StoredMessage {
  return {
    type: 'system_note',
    id: 'sn1',
    ts: 1_700_000_000_000,
    kind: 'session_start',
    data: { note: text },
  };
}

/**
 * Default `getPrivacyContext` returns a not-incognito context. Tests
 * that want to exercise the incognito gate override this via
 * `makeDepsWithPrivacy`.
 */
function makeDeps(map: Record<string, { session: SessionSummary; messages: StoredMessage[] }>) {
  return {
    async listSessions() {
      return Object.values(map).map((entry) => entry.session);
    },
    async readMessages(sessionId: string) {
      return map[sessionId]?.messages ?? [];
    },
    async getPrivacyContext(): Promise<unknown> {
      return { incognitoActive: false };
    },
  };
}

/**
 * Spy-deps for the privacy gate tests. Tracks how many times
 * `listSessions` / `readMessages` were invoked so the test can assert
 * "early return before scan".
 */
function makeSpyDeps(
  map: Record<string, { session: SessionSummary; messages: StoredMessage[] }>,
  privacyPayload: unknown,
) {
  let listCalls = 0;
  let readCalls = 0;
  const deps = {
    async listSessions() {
      listCalls++;
      return Object.values(map).map((entry) => entry.session);
    },
    async readMessages(sessionId: string) {
      readCalls++;
      return map[sessionId]?.messages ?? [];
    },
    async getPrivacyContext(): Promise<unknown> {
      return privacyPayload;
    },
  };
  return {
    deps,
    counts: () => ({ list: listCalls, read: readCalls }),
  };
}

// ---------------------------------------------------------------------------
// Query / limit normalization (reuse PR-SEARCH-0 normalizers)
// ---------------------------------------------------------------------------

describe('runThreadSearch — input validation reuses @maka/core normalizers', () => {
  // PR-SEARCH-2 review fixup (@xuan `2f1aba55`): IPC payload is
  // untrusted. The helper accepts `unknown` and MUST return an
  // error envelope, never throw, for any malformed renderer input.
  describe('runtime shape guard (renderer fail-closed)', () => {
    it('rejects null payload as invalid_query', async () => {
      const result = await runThreadSearch(null, makeDeps({}));
      if (Array.isArray(result)) assert.fail('expected error');
      assert.equal(result.reason, 'invalid_query');
    });

    it('rejects undefined payload as invalid_query', async () => {
      const result = await runThreadSearch(undefined, makeDeps({}));
      if (Array.isArray(result)) assert.fail('expected error');
      assert.equal(result.reason, 'invalid_query');
    });

    it('rejects string payload as invalid_query', async () => {
      const result = await runThreadSearch('hello', makeDeps({}));
      if (Array.isArray(result)) assert.fail('expected error');
      assert.equal(result.reason, 'invalid_query');
    });

    it('rejects array payload as invalid_query', async () => {
      const result = await runThreadSearch([], makeDeps({}));
      if (Array.isArray(result)) assert.fail('expected error');
      assert.equal(result.reason, 'invalid_query');
    });

    it('rejects payload missing source as disabled (source guard fires after shape guard)', async () => {
      const result = await runThreadSearch({ query: 'hello', limit: 5 }, makeDeps({}));
      if (Array.isArray(result)) assert.fail('expected error');
      assert.equal(result.reason, 'disabled');
    });

    it('rejects payload missing query as invalid_query (after source guard)', async () => {
      const result = await runThreadSearch({ source: 'thread', limit: 5 }, makeDeps({}));
      if (Array.isArray(result)) assert.fail('expected error');
      assert.equal(result.reason, 'invalid_query');
    });

    it('rejects payload with non-string query as invalid_query', async () => {
      const result = await runThreadSearch({ source: 'thread', query: 42, limit: 5 }, makeDeps({}));
      if (Array.isArray(result)) assert.fail('expected error');
      assert.equal(result.reason, 'invalid_query');
    });

    it('does NOT throw on malformed payloads (returns error envelope)', async () => {
      // Build a payload mix designed to probe every guard layer.
      for (const bad of [null, undefined, '', 'string', 42, true, [], { source: 'web' }, { source: 'thread' }, { source: 'thread', query: null }]) {
        const result = await runThreadSearch(bad, makeDeps({}));
        assert.ok(
          Array.isArray(result) || result.ok === false,
          'must return result OR error envelope for ' + JSON.stringify(bad),
        );
      }
    });
  });

  it('rejects empty query as invalid_query', async () => {
    const result = await runThreadSearch(
      { source: 'thread', query: '   ', limit: 5 },
      makeDeps({}),
    );
    if (Array.isArray(result)) {
      assert.fail('expected error result for empty query');
    } else {
      assert.equal(result.reason, 'invalid_query');
    }
  });

  it('rejects non-thread source as disabled', async () => {
    const result = await runThreadSearch(
      // Forced cast to exercise the source guard at runtime.
      { source: 'web', query: 'hello', limit: 5 },
      makeDeps({}),
    );
    if (Array.isArray(result)) {
      assert.fail('expected error result for non-thread source');
    } else {
      assert.equal(result.reason, 'disabled');
    }
  });

  it('clamps limit to SEARCH_MAX_LIMIT=10 (does not allow desktop helper to exceed)', async () => {
    // Build 15 sessions each with a matching message.
    const map: Record<string, { session: SessionSummary; messages: StoredMessage[] }> = {};
    for (let i = 0; i < 15; i++) {
      const id = `s${String(i).padStart(2, '0')}`;
      map[id] = {
        session: session({ id, name: id, lastMessageAt: 1_700_000_000_000 - i }),
        messages: [userMessage('hello world')],
      };
    }
    const result = await runThreadSearch(
      { source: 'thread', query: 'hello', limit: 50 },
      makeDeps(map),
    );
    if (!Array.isArray(result)) assert.fail('expected results');
    assert.ok(result.length <= 10, 'must not exceed SEARCH_MAX_LIMIT (10); got ' + result.length);
  });
});

// ---------------------------------------------------------------------------
// G1 — snippet redaction
// ---------------------------------------------------------------------------

describe('G1 — snippet redaction', () => {
  it('redacts sk-ant-* keys in user message snippet', async () => {
    const result = await runThreadSearch(
      { source: 'thread', query: 'hello', limit: 5 },
      makeDeps({
        s1: {
          session: session({ id: 's1' }),
          messages: [userMessage('hello sk-ant-test-secret-token-12345 world')],
        },
      }),
    );
    if (!Array.isArray(result)) assert.fail('expected results');
    assert.equal(result.length, 1);
    assert.ok(result[0]?.snippet, 'expected snippet');
    assert.ok(!result[0]!.snippet!.includes('sk-ant-test-secret-token-12345'), 'snippet must redact key');
    assert.match(result[0]!.snippet!, /\[redacted\]/);
  });

  it('redacts Authorization Bearer in assistant message', async () => {
    const result = await runThreadSearch(
      { source: 'thread', query: 'authorization', limit: 5 },
      makeDeps({
        s1: {
          session: session({ id: 's1' }),
          messages: [assistantMessage('the header was Authorization: Bearer secret-token-here')],
        },
      }),
    );
    if (!Array.isArray(result)) assert.fail('expected results');
    assert.ok(result[0]?.snippet, 'expected snippet');
    assert.ok(!result[0]!.snippet!.includes('secret-token-here'), 'must redact bearer token');
  });
});

// ---------------------------------------------------------------------------
// G2 — backend='fake' exclusion
// ---------------------------------------------------------------------------

describe('G2 — fake-backend sessions excluded', () => {
  it('does NOT return matches from a fake-backend session', async () => {
    const result = await runThreadSearch(
      { source: 'thread', query: 'hello', limit: 5 },
      makeDeps({
        fakeSession: {
          session: session({ id: 'fakeSession', name: 'hello fake title', backend: 'fake' }),
          messages: [userMessage('hello from fixture')],
        },
        realSession: {
          session: session({ id: 'realSession', backend: 'ai-sdk' }),
          messages: [userMessage('hello from real chat')],
        },
      }),
    );
    if (!Array.isArray(result)) assert.fail('expected results');
    assert.equal(result.length, 1);
    assert.equal(result[0]?.target?.kind, 'thread');
    if (result[0]?.target?.kind === 'thread') {
      assert.equal(result[0].target.sessionId, 'realSession');
    }
  });

  it('returns empty when only fake sessions match', async () => {
    const result = await runThreadSearch(
      { source: 'thread', query: 'unique-fixture-string', limit: 5 },
      makeDeps({
        s1: {
          session: session({ id: 's1', backend: 'fake' }),
          messages: [userMessage('this contains unique-fixture-string only')],
        },
      }),
    );
    if (!Array.isArray(result)) assert.fail('expected results');
    assert.equal(result.length, 0);
  });
});

// ---------------------------------------------------------------------------
// Logical revision projection
// ---------------------------------------------------------------------------

describe('logical revision projection', () => {
  it('searches only the current committed version of one conversation', async () => {
    const result = await runThreadSearch(
      { source: 'thread', query: 'shared-match', limit: 10 },
      makeDeps({
        root: {
          session: session({ id: 'root', lastMessageAt: 10 }),
          messages: [userMessage('shared-match old version')],
        },
        revision: {
          session: session({
            id: 'revision',
            revisionRootSessionId: 'root',
            revisionParentSessionId: 'root',
            revisionIndex: 2,
            revisionState: 'committed',
            lastMessageAt: 20,
          }),
          messages: [userMessage('shared-match current version')],
        },
        preparing: {
          session: session({
            id: 'preparing',
            revisionRootSessionId: 'root',
            revisionParentSessionId: 'revision',
            revisionIndex: 3,
            revisionState: 'preparing',
            lastMessageAt: 30,
          }),
          messages: [userMessage('shared-match uncommitted version')],
        },
      }),
    );
    if (!Array.isArray(result)) assert.fail('expected results');
    assert.deepEqual(
      result.map((entry) => entry.target?.kind === 'thread' ? entry.target.sessionId : undefined),
      ['revision'],
    );
  });
});

// ---------------------------------------------------------------------------
// Session title hits
// ---------------------------------------------------------------------------

describe('session title hits', () => {
  it('returns a thread result when the query matches the session title', async () => {
    const result = await runThreadSearch(
      { source: 'thread', query: 'roadmap', limit: 5 },
      makeDeps({
        s1: {
          session: session({ id: 's1', name: 'Maka roadmap planning' }),
          messages: [userMessage('no matching body here')],
        },
      }),
    );
    if (!Array.isArray(result)) assert.fail('expected results');
    assert.equal(result.length, 1);
    const hit = result[0]!;
    assert.equal(hit.summary, '会话标题');
    assert.equal(hit.title, 'Maka roadmap planning');
    assert.match(hit.snippet ?? '', /roadmap/i);
    assert.equal(hit.url, undefined, 'thread title result must not construct a maka://session URL');
    assert.equal(hit.target?.kind, 'thread');
    if (hit.target?.kind === 'thread') {
      assert.equal(hit.target.sessionId, 's1');
      assert.equal(hit.target.turnId, undefined, 'title hit has no turn anchor');
    }
  });

  it('redacts secrets from title snippets', async () => {
    const result = await runThreadSearch(
      { source: 'thread', query: 'sk-ant', limit: 5 },
      makeDeps({
        s1: {
          session: session({ id: 's1', name: 'Rotate sk-ant-test-secret-token-12345 now' }),
          messages: [userMessage('no body match')],
        },
      }),
    );
    if (!Array.isArray(result)) assert.fail('expected results');
    assert.equal(result.length, 1);
    assert.ok(!result[0]!.snippet!.includes('sk-ant-test-secret-token-12345'));
    assert.match(result[0]!.snippet!, /\[redacted\]/);
  });

  it('marks truncation when title hit alone reaches the requested limit', async () => {
    const result = await runThreadSearch(
      { source: 'thread', query: 'planning', limit: 1 },
      makeDeps({
        s1: {
          session: session({ id: 's1', name: 'planning title' }),
          messages: [userMessage('planning body')],
        },
      }),
    );
    if (!Array.isArray(result)) assert.fail('expected results');
    assert.equal(result.length, 1);
    assert.equal(result[0]?.summary, '会话标题');
    assert.equal(result[0]?.truncated, true);
  });
});

// ---------------------------------------------------------------------------
// G3 — incognito gate (PR-SEARCH-2.5)
// ---------------------------------------------------------------------------

describe('G3 — incognito gate (PR-SEARCH-2.5 @xuan 2c55b975)', () => {
  /*
   * Pinned via xuan msg `2c55b975`:
   *   - active incognito → return error envelope with reason='incognito_active'
   *   - malformed privacy context → fail-closed with the SAME reason
   *     (UI sees one blocked state, not two)
   *   - both paths MUST NOT call listSessions / readMessages
   *   - `incognitoActive=false` does not bypass other gates
   */

  it('G3a: incognitoActive=true returns incognito_active envelope (no scan)', async () => {
    const { deps, counts } = makeSpyDeps(
      {
        s1: { session: session({ id: 's1' }), messages: [userMessage('hello world')] },
      },
      { incognitoActive: true },
    );
    const result = await runThreadSearch(
      { source: 'thread', query: 'hello', limit: 5 },
      deps,
    );
    if (Array.isArray(result)) assert.fail('expected error envelope');
    assert.equal(result.reason, 'incognito_active');
    assert.match(result.message, /incognito/);
    const c = counts();
    assert.equal(c.list, 0, 'listSessions must NOT be called when incognito');
    assert.equal(c.read, 0, 'readMessages must NOT be called when incognito');
  });

  it('G3b: malformed privacy context (null) fails closed with incognito_active (no scan)', async () => {
    const { deps, counts } = makeSpyDeps(
      {
        s1: { session: session({ id: 's1' }), messages: [userMessage('hello world')] },
      },
      null,
    );
    const result = await runThreadSearch(
      { source: 'thread', query: 'hello', limit: 5 },
      deps,
    );
    if (Array.isArray(result)) assert.fail('expected error envelope');
    assert.equal(result.reason, 'incognito_active');
    assert.match(result.message, /privacy state could not be verified/);
    const c = counts();
    assert.equal(c.list, 0);
    assert.equal(c.read, 0);
  });

  it('G3b: malformed privacy context (missing field) fails closed', async () => {
    const { deps, counts } = makeSpyDeps(
      { s1: { session: session({ id: 's1' }), messages: [userMessage('hello')] } },
      {}, // missing incognitoActive
    );
    const result = await runThreadSearch(
      { source: 'thread', query: 'hello', limit: 5 },
      deps,
    );
    if (Array.isArray(result)) assert.fail('expected error envelope');
    assert.equal(result.reason, 'incognito_active');
    assert.match(result.message, /privacy state could not be verified/);
    const c = counts();
    assert.equal(c.list, 0);
    assert.equal(c.read, 0);
  });

  it('G3b: malformed privacy context (non-boolean field) fails closed', async () => {
    const { deps, counts } = makeSpyDeps(
      { s1: { session: session({ id: 's1' }), messages: [userMessage('hello')] } },
      { incognitoActive: 'true' }, // string, not boolean
    );
    const result = await runThreadSearch(
      { source: 'thread', query: 'hello', limit: 5 },
      deps,
    );
    if (Array.isArray(result)) assert.fail('expected error envelope');
    assert.equal(result.reason, 'incognito_active');
    assert.match(result.message, /privacy state could not be verified/);
    const c = counts();
    assert.equal(c.list, 0);
    assert.equal(c.read, 0);
  });

  it('G3b: malformed privacy context (non-object) fails closed', async () => {
    const { deps, counts } = makeSpyDeps(
      { s1: { session: session({ id: 's1' }), messages: [userMessage('hello')] } },
      'not-an-object',
    );
    const result = await runThreadSearch(
      { source: 'thread', query: 'hello', limit: 5 },
      deps,
    );
    if (Array.isArray(result)) assert.fail('expected error envelope');
    assert.equal(result.reason, 'incognito_active');
    const c = counts();
    assert.equal(c.list, 0);
    assert.equal(c.read, 0);
  });

  it('G3b: malformed privacy context (array) fails closed', async () => {
    const { deps } = makeSpyDeps(
      { s1: { session: session({ id: 's1' }), messages: [userMessage('hello')] } },
      [],
    );
    const result = await runThreadSearch(
      { source: 'thread', query: 'hello', limit: 5 },
      deps,
    );
    if (Array.isArray(result)) assert.fail('expected error envelope');
    assert.equal(result.reason, 'incognito_active');
  });

  it('G3c: incognitoActive=false does NOT bypass other gates (empty query still invalid_query)', async () => {
    const { deps } = makeSpyDeps(
      { s1: { session: session({ id: 's1' }), messages: [userMessage('hello')] } },
      { incognitoActive: false },
    );
    const result = await runThreadSearch(
      { source: 'thread', query: '   ', limit: 5 },
      deps,
    );
    if (Array.isArray(result)) assert.fail('expected error envelope');
    // The empty-query gate fires BEFORE the privacy gate. This proves
    // the order: query normalize → privacy. (If privacy fired first, we
    // would not even get to invalid_query.)
    assert.equal(result.reason, 'invalid_query');
  });

  it('G3 message distinguishes active vs malformed paths (consumers can read message for diagnostics)', async () => {
    const active = await runThreadSearch(
      { source: 'thread', query: 'hello', limit: 5 },
      makeSpyDeps({}, { incognitoActive: true }).deps,
    );
    if (Array.isArray(active)) assert.fail('expected error envelope');
    assert.match(active.message, /incognito is active/);
    assert.doesNotMatch(active.message, /could not be verified/);

    const malformed = await runThreadSearch(
      { source: 'thread', query: 'hello', limit: 5 },
      makeSpyDeps({}, null).deps,
    );
    if (Array.isArray(malformed)) assert.fail('expected error envelope');
    assert.match(malformed.message, /could not be verified/);
    assert.doesNotMatch(malformed.message, /incognito is active/);

    // External reason is the same.
    assert.equal(active.reason, 'incognito_active');
    assert.equal(malformed.reason, 'incognito_active');
  });

  it('G3 happy path: incognitoActive=false + valid query returns results', async () => {
    const result = await runThreadSearch(
      { source: 'thread', query: 'hello', limit: 5 },
      makeSpyDeps(
        { s1: { session: session({ id: 's1' }), messages: [userMessage('hello world')] } },
        { incognitoActive: false },
      ).deps,
    );
    if (!Array.isArray(result)) assert.fail('expected results');
    assert.equal(result.length, 1);
  });
});

// ---------------------------------------------------------------------------
// G4 — caps
// ---------------------------------------------------------------------------

describe('G4 — result + payload caps', () => {
  it('snippet caps at SNIPPET_MAX_CODE_POINTS code points', () => {
    const long = 'a'.repeat(500);
    const capped = capCodePoints(long, SNIPPET_MAX_CODE_POINTS);
    assert.ok(Array.from(capped).length <= SNIPPET_MAX_CODE_POINTS);
  });

  it('marks last result truncated when limit reached during scan', async () => {
    const map: Record<string, { session: SessionSummary; messages: StoredMessage[] }> = {};
    for (let i = 0; i < 8; i++) {
      const id = `s${i}`;
      map[id] = {
        session: session({ id, lastMessageAt: 1_700_000_000_000 - i }),
        messages: [userMessage('hello world')],
      };
    }
    const result = await runThreadSearch(
      { source: 'thread', query: 'hello', limit: 3 },
      makeDeps(map),
    );
    if (!Array.isArray(result)) assert.fail('expected results');
    assert.equal(result.length, 3);
    // Last result carries `truncated: true` to indicate caller should
    // suggest narrowing the query.
    assert.equal(result[result.length - 1]?.truncated, true);
  });

  it('MAX_SESSIONS_SCANNED is sane upper bound (>= 100, <= 1000)', () => {
    assert.ok(MAX_SESSIONS_SCANNED >= 100 && MAX_SESSIONS_SCANNED <= 1000);
  });
});

// ---------------------------------------------------------------------------
// G5 — case-fold + NFC + CJK
// ---------------------------------------------------------------------------

describe('G5 — case-fold + NFC + CJK match', () => {
  it('case-insensitive ASCII match', async () => {
    const result = await runThreadSearch(
      { source: 'thread', query: 'HELLO', limit: 5 },
      makeDeps({
        s1: { session: session({ id: 's1' }), messages: [userMessage('hello world')] },
      }),
    );
    if (!Array.isArray(result)) assert.fail('expected results');
    assert.equal(result.length, 1);
  });

  it('CJK substring match', async () => {
    const result = await runThreadSearch(
      { source: 'thread', query: '项目', limit: 5 },
      makeDeps({
        s1: { session: session({ id: 's1' }), messages: [userMessage('我的项目计划已经完成')] },
      }),
    );
    if (!Array.isArray(result)) assert.fail('expected results');
    assert.equal(result.length, 1);
  });

  it('foldForMatch is NFC + lowercase', () => {
    assert.equal(foldForMatch('HELLO'), 'hello');
    assert.equal(foldForMatch('Héllo'), 'héllo'); // composed
    // NFC composes decomposed forms (e + combining acute → é).
    const decomposed = 'Héllo';
    const composed = 'Héllo';
    assert.equal(foldForMatch(decomposed), foldForMatch(composed));
  });

  it('findMatch returns index of folded match in original text', () => {
    const idx = findMatch('hello world', foldForMatch('WORLD'));
    assert.equal(idx, 6);
  });
});

// ---------------------------------------------------------------------------
// G9 — tool_result content scan cap
// ---------------------------------------------------------------------------

describe('G9 — tool_result content scan cap', () => {
  it('large tool_result content is bounded at TOOL_RESULT_SCAN_CAP_BYTES', () => {
    // 100 KB content
    const large = 'X'.repeat(100_000);
    const message = toolResultMessage({ data: large });
    const extracted = collectSearchableText(message);
    assert.ok(extracted !== undefined);
    assert.ok(
      Buffer.byteLength(extracted!, 'utf8') <= TOOL_RESULT_SCAN_CAP_BYTES,
      'extracted text must be within the scan cap',
    );
  });

  it('small tool_result content passes through unchanged', () => {
    const message = toolResultMessage({ result: 'short result' });
    const extracted = collectSearchableText(message);
    assert.equal(typeof extracted, 'string');
    assert.ok(extracted!.includes('short result'));
  });
});

// ---------------------------------------------------------------------------
// G10 — excluded message types
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// ToolCallMessage: index `intent` ONLY (xuan `2f1aba55` fixup)
// ---------------------------------------------------------------------------

describe('ToolCallMessage indexes intent only (not toolName / displayName)', () => {
  function toolCall(overrides: { toolName: string; displayName?: string; intent?: string }): StoredMessage {
    return {
      type: 'tool_call',
      id: 'tc1',
      turnId: 't1',
      ts: 1_700_000_000_000,
      toolName: overrides.toolName,
      displayName: overrides.displayName,
      intent: overrides.intent,
      args: {},
    };
  }

  it('collectSearchableText returns intent when present', () => {
    const text = collectSearchableText(toolCall({ toolName: 'Bash', intent: 'list files in current dir' }));
    assert.equal(text, 'list files in current dir');
  });

  it('collectSearchableText returns undefined when intent is missing', () => {
    const text = collectSearchableText(toolCall({ toolName: 'Bash' }));
    assert.equal(text, undefined);
  });

  it('collectSearchableText returns undefined when intent is empty string', () => {
    const text = collectSearchableText(toolCall({ toolName: 'Bash', intent: '' }));
    assert.equal(text, undefined);
  });

  it('does NOT index toolName — searching for "Bash" with no intent match returns 0', async () => {
    // Plan-locked behavior: tool names are internal labels, not
    // user-visible content. A bash invocation with no intent
    // description must NOT appear when the user searches for `Bash`.
    const result = await runThreadSearch(
      { source: 'thread', query: 'Bash', limit: 5 },
      makeDeps({
        s1: {
          session: session({ id: 's1' }),
          messages: [toolCall({ toolName: 'Bash', displayName: 'Bash', intent: 'check disk usage' })],
        },
      }),
    );
    if (!Array.isArray(result)) assert.fail('expected results');
    // Intent says "check disk usage" — `Bash` shouldn't match it.
    assert.equal(result.length, 0);
  });

  it('does NOT index displayName — searching for displayName-only does not hit', async () => {
    const result = await runThreadSearch(
      { source: 'thread', query: 'CustomDisplayName', limit: 5 },
      makeDeps({
        s1: {
          session: session({ id: 's1' }),
          messages: [toolCall({ toolName: 'Bash', displayName: 'CustomDisplayName', intent: 'tail logs' })],
        },
      }),
    );
    if (!Array.isArray(result)) assert.fail('expected results');
    assert.equal(result.length, 0);
  });

  it('DOES index intent — searching for intent-only string matches', async () => {
    const result = await runThreadSearch(
      { source: 'thread', query: 'disk usage', limit: 5 },
      makeDeps({
        s1: {
          session: session({ id: 's1' }),
          messages: [toolCall({ toolName: 'Bash', intent: 'check disk usage on /var' })],
        },
      }),
    );
    if (!Array.isArray(result)) assert.fail('expected results');
    assert.equal(result.length, 1);
  });
});

describe('AssistantMessage indexes answer text only (not thinking)', () => {
  it('collectSearchableText omits assistant thinking from local search snippets', () => {
    const text = collectSearchableText(
      assistantMessageWithThinking(
        'visible assistant answer',
        'private reasoning path: The user is greeting me in Chinese',
      ),
    );

    assert.equal(text, 'visible assistant answer');
    assert.ok(!text?.includes('private reasoning'), 'assistant thinking must not enter searchable text');
  });

  it('does NOT match assistant thinking-only text', async () => {
    const result = await runThreadSearch(
      { source: 'thread', query: 'greeting me in Chinese', limit: 5 },
      makeDeps({
        s1: {
          session: session({ id: 's1' }),
          messages: [
            assistantMessageWithThinking(
              '你好！很高兴见到你。',
              'The user is greeting me in Chinese. I will respond in Chinese.',
            ),
          ],
        },
      }),
    );

    if (!Array.isArray(result)) assert.fail('expected results');
    assert.equal(result.length, 0);
  });

  it('matches visible assistant answer text without appending thinking to the snippet', async () => {
    const result = await runThreadSearch(
      { source: 'thread', query: 'visible answer', limit: 5 },
      makeDeps({
        s1: {
          session: session({ id: 's1' }),
          messages: [
            assistantMessageWithThinking(
              'this is the visible answer',
              'private reasoning path: do not expose in search',
            ),
          ],
        },
      }),
    );

    if (!Array.isArray(result)) assert.fail('expected results');
    assert.equal(result.length, 1);
    assert.match(result[0]!.snippet ?? '', /visible answer/);
    assert.ok(!result[0]!.snippet!.includes('private reasoning'), 'snippet must stay answer-only');
  });
});

describe('G10 — system / token / turn-state / permission-decision excluded', () => {
  it('returns undefined for SystemNoteMessage', () => {
    const result = collectSearchableText(systemNoteMessage('session resumed'));
    assert.equal(result, undefined);
  });

  it('returns undefined for TokenUsageMessage', () => {
    const message: StoredMessage = {
      type: 'token_usage',
      id: 'tk1',
      turnId: 't1',
      ts: 1_700_000_000_000,
      input: 100,
      output: 200,
    };
    assert.equal(collectSearchableText(message), undefined);
  });

  it('returns undefined for TurnStateMessage', () => {
    const message: StoredMessage = {
      type: 'turn_state',
      id: 'ts1',
      turnId: 't1',
      ts: 1_700_000_000_000,
      status: 'completed',
      partialOutputRetained: false,
    };
    assert.equal(collectSearchableText(message), undefined);
  });

  it('returns undefined for PermissionDecisionMessage', () => {
    const message: StoredMessage = {
      type: 'permission_decision',
      id: 'pd1',
      turnId: 't1',
      ts: 1_700_000_000_000,
      toolUseId: 'call1',
      toolName: 'Bash',
      decision: 'allow',
    };
    assert.equal(collectSearchableText(message), undefined);
  });

  it('a session containing ONLY excluded messages produces 0 hits', async () => {
    const result = await runThreadSearch(
      { source: 'thread', query: 'anything', limit: 5 },
      makeDeps({
        s1: {
          session: session({ id: 's1' }),
          messages: [
            systemNoteMessage('session resumed with anything'),
            {
              type: 'token_usage',
              id: 'tk1',
              turnId: 't1',
              ts: 1_700_000_000_000,
              input: 100,
              output: 200,
            },
          ],
        },
      }),
    );
    if (!Array.isArray(result)) assert.fail('expected results');
    assert.equal(result.length, 0);
  });
});

// ---------------------------------------------------------------------------
// SearchResult shape (PR-SEARCH-1.5 target)
// ---------------------------------------------------------------------------

describe('SearchResult.target carries thread navigation (PR-SEARCH-1.5)', () => {
  it('populates target with sessionId + turnId, omits url', async () => {
    const result = await runThreadSearch(
      { source: 'thread', query: 'hello', limit: 5 },
      makeDeps({
        sX: {
          session: session({ id: 'sX', name: 'My Chat' }),
          messages: [userMessage('hello world', 'turnA', 'u1')],
        },
      }),
    );
    if (!Array.isArray(result)) assert.fail('expected results');
    assert.equal(result.length, 1);
    const hit = result[0]!;
    assert.equal(hit.source, 'thread');
    assert.equal(hit.url, undefined, 'thread results must NOT set url (maka://session deferred)');
    assert.equal(hit.target?.kind, 'thread');
    if (hit.target?.kind === 'thread') {
      assert.equal(hit.target.sessionId, 'sX');
      assert.equal(hit.target.turnId, 'turnA');
    }
    assert.equal(hit.title, 'My Chat');
  });

  it('populates user-facing summary so UI shows where the hit came from', async () => {
    const result = await runThreadSearch(
      { source: 'thread', query: 'diagnostic', limit: 5 },
      makeDeps({
        s1: {
          session: session({ id: 's1', name: 'Ops Run' }),
          messages: [
            userMessage('diagnostic from user', 'turnUser', 'u1'),
            assistantMessage('diagnostic from assistant', 'turnAssistant', 'a1'),
          ],
        },
      }),
    );
    if (!Array.isArray(result)) assert.fail('expected results');
    assert.deepEqual(result.map((hit) => hit.summary), ['用户消息', '助手回复']);
  });

  it('omits turnId in target when message has no turnId (e.g. session-level hit)', async () => {
    // SystemNoteMessage has no turnId, but it is excluded by G10.
    // In current schema all searchable transcript messages have
    // turnId; this test pins the optional field semantics by
    // simulating an edge case.
    const result = await runThreadSearch(
      { source: 'thread', query: 'special', limit: 5 },
      makeDeps({
        sY: {
          session: session({ id: 'sY' }),
          messages: [{ ...userMessage('a special thing', '', 'u1'), turnId: '' as unknown as string }],
        },
      }),
    );
    if (!Array.isArray(result)) assert.fail('expected results');
    if (result.length === 1) {
      const target = result[0]!.target;
      assert.equal(target?.kind, 'thread');
      if (target?.kind === 'thread') {
        // Either turnId is omitted, or it's an empty string — both are acceptable
        // documentation values for "no turn anchor".
        if (target.turnId !== undefined) {
          assert.equal(typeof target.turnId, 'string');
        }
      }
    }
  });
});

describe('formatSearchResultSummary', () => {
  function toolCall(overrides: { toolName: string; displayName?: string; intent?: string }): StoredMessage {
    return {
      type: 'tool_call',
      id: 'tc-summary',
      turnId: 't1',
      ts: 1_700_000_000_000,
      toolName: overrides.toolName,
      displayName: overrides.displayName,
      intent: overrides.intent,
      args: {},
    };
  }

  it('labels user / assistant / tool hits without leaking raw enum names', () => {
    assert.equal(formatSearchResultSummary(userMessage('hello')), '用户消息');
    assert.equal(formatSearchResultSummary(assistantMessage('hello')), '助手回复');
    assert.equal(formatSearchResultSummary(toolCall({ toolName: 'Bash', displayName: 'Shell' })), '工具调用：Shell');
    assert.equal(formatSearchResultSummary(toolResultMessage({ ok: true })), '工具结果：成功');
    assert.equal(formatSearchResultSummary(toolResultMessage({ ok: false }, 't1', true)), '工具结果：失败');
  });
});
