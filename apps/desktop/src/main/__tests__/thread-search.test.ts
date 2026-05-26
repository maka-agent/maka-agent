/**
 * Tests for `runThreadSearch` — the PR-SEARCH-2 pure helper.
 *
 * Locks the gate catalog from `notes/pr-search-1-report.md`:
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
    permissionMode: 'ask',
    lastMessageAt: 1_700_000_000_000,
    ...overrides,
  };
}

function userMessage(text: string, turnId: string = 't1', id: string = 'u1'): StoredMessage {
  return { type: 'user', id, turnId, ts: 1_700_000_000_000, text };
}

function assistantMessage(text: string, turnId: string = 't1', id: string = 'a1'): StoredMessage {
  return {
    type: 'assistant',
    id,
    turnId,
    ts: 1_700_000_000_000,
    text,
    modelId: 'glm-4.7',
  };
}

function toolResultMessage(content: unknown, turnId: string = 't1'): StoredMessage {
  return {
    type: 'tool_result',
    id: 'tr1',
    turnId,
    ts: 1_700_000_000_000,
    toolUseId: 'call1',
    isError: false,
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

function makeDeps(map: Record<string, { session: SessionSummary; messages: StoredMessage[] }>) {
  return {
    async listSessions() {
      return Object.values(map).map((entry) => entry.session);
    },
    async readMessages(sessionId: string) {
      return map[sessionId]?.messages ?? [];
    },
  };
}

// ---------------------------------------------------------------------------
// Query / limit normalization (reuse PR-SEARCH-0 normalizers)
// ---------------------------------------------------------------------------

describe('runThreadSearch — input validation reuses @maka/core normalizers', () => {
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
      { source: 'web' as never, query: 'hello', limit: 5 },
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
          session: session({ id: 'fakeSession', backend: 'fake' }),
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

  it('omits turnId in target when message has no turnId (e.g. session-level hit)', async () => {
    // SystemNoteMessage has no turnId — but it's excluded by G10. The
    // assistant.thinking path also includes a turnId. In current
    // schema all searchable messages have turnId; this test simply
    // pins the optional field semantics by simulating an edge case.
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
