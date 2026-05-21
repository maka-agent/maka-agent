/**
 * Tests for the onboarding state machine + milestone schema (PR110a).
 *
 * Locks the 15-case matrix @kenji + @xuan signed off on plus the
 * milestone validator gates.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  deriveOnboardingState,
  isOnboardingMilestone,
  ONBOARDING_MILESTONE_IDS,
  sanitizeOnboardingMilestones,
  type DeriveOnboardingStateInput,
  type OnboardingMilestone,
  type OnboardingState,
} from '../onboarding.js';
import { isConnectionReady, isRealConnection } from '../connection-readiness.js';
import type { LlmConnection } from '../llm-connections.js';
import type { SessionSummary } from '../session.js';

// ---------------------------------------------------------------------------
// Test factories — keep them minimal so each test row reads as data.
// ---------------------------------------------------------------------------

function realConnection(overrides: Partial<LlmConnection> = {}): LlmConnection {
  return {
    slug: overrides.slug ?? 'anthropic-live',
    name: overrides.name ?? 'Anthropic Live',
    providerType: overrides.providerType ?? 'anthropic',
    defaultModel: overrides.defaultModel ?? 'claude-sonnet-4-5-20250929',
    enabled: overrides.enabled ?? true,
    models: overrides.models ?? [
      { id: 'claude-sonnet-4-5-20250929', capabilities: { vision: true, reasoning: true, functionCalling: true }, contextWindow: 200_000 },
    ],
    modelSource: overrides.modelSource ?? 'fetched',
    createdAt: overrides.createdAt ?? 1,
    updatedAt: overrides.updatedAt ?? 1,
    ...overrides,
  } as LlmConnection;
}

function fakeConnection(overrides: Partial<LlmConnection> = {}): LlmConnection {
  return {
    slug: overrides.slug ?? 'fake-demo',
    name: overrides.name ?? 'Fake Demo',
    providerType: 'fake' as LlmConnection['providerType'],
    defaultModel: 'fake-model',
    enabled: overrides.enabled ?? true,
    models: [{ id: 'fake-model', capabilities: {}, contextWindow: 1_000 }],
    modelSource: 'fallback',
    createdAt: 1,
    updatedAt: 1,
    lastTestStatus: overrides.lastTestStatus ?? 'verified',
    ...overrides,
  } as LlmConnection;
}

function session(id: string, overrides: Partial<SessionSummary> = {}): SessionSummary {
  return {
    id,
    name: overrides.name ?? id,
    isFlagged: false,
    isArchived: overrides.isArchived ?? false,
    labels: [],
    hasUnread: false,
    status: overrides.status ?? 'active',
    backend: 'ai-sdk',
    llmConnectionSlug: 'anthropic-live',
    permissionMode: 'ask',
    ...overrides,
  };
}

function derive(input: Partial<DeriveOnboardingStateInput> = {}): OnboardingState {
  return deriveOnboardingState({
    connections: input.connections ?? [],
    defaultSlug: input.defaultSlug,
    sessions: input.sessions ?? [],
    secrets: input.secrets ?? {},
  });
}

// ---------------------------------------------------------------------------
// 15-case derive matrix
// ---------------------------------------------------------------------------

describe('deriveOnboardingState — 15-case matrix (@kenji + @xuan PR110a)', () => {
  it('case 1: 0 connections → needs_connection', () => {
    assert.deepEqual(derive(), { kind: 'needs_connection' });
  });

  it('case 2: only fake (verified, defaultSlug→fake) → needs_connection (isRealConnection ignores telemetry)', () => {
    const fake = fakeConnection({ slug: 'fake-x', lastTestStatus: 'verified' });
    assert.deepEqual(
      derive({ connections: [fake], defaultSlug: 'fake-x', secrets: { 'fake-x': true } }),
      { kind: 'needs_connection' },
    );
    // Regression: isRealConnection MUST NOT look at lastTestStatus.
    assert.equal(isRealConnection(fake), false);
  });

  it('case 3: 1 real ready, defaultSlug=real, 0 sessions → ready_empty', () => {
    const conn = realConnection({ slug: 'anthropic-live' });
    assert.deepEqual(
      derive({ connections: [conn], defaultSlug: 'anthropic-live', secrets: { 'anthropic-live': true } }),
      {
        kind: 'ready_empty',
        defaultConnectionSlug: 'anthropic-live',
        defaultModel: 'claude-sonnet-4-5-20250929',
      },
    );
  });

  it('case 4: 1 real ready, defaultSlug=real, ≥1 active session → ready_with_history', () => {
    const conn = realConnection({ slug: 'anthropic-live' });
    const result = derive({
      connections: [conn],
      defaultSlug: 'anthropic-live',
      secrets: { 'anthropic-live': true },
      sessions: [session('s1')],
    });
    assert.deepEqual(result, {
      kind: 'ready_with_history',
      defaultConnectionSlug: 'anthropic-live',
      defaultModel: 'claude-sonnet-4-5-20250929',
    });
  });

  it('case 5: ≥1 archived session counts as history (must not regress to ready_empty)', () => {
    const conn = realConnection({ slug: 'anthropic-live' });
    const result = derive({
      connections: [conn],
      defaultSlug: 'anthropic-live',
      secrets: { 'anthropic-live': true },
      sessions: [session('s1', { isArchived: true, status: 'archived' })],
    });
    assert.equal(result.kind, 'ready_with_history');
  });

  it('case 6: 1 aborted session counts as history', () => {
    const conn = realConnection({ slug: 'anthropic-live' });
    const result = derive({
      connections: [conn],
      defaultSlug: 'anthropic-live',
      secrets: { 'anthropic-live': true },
      sessions: [session('s1', { status: 'aborted' })],
    });
    assert.equal(result.kind, 'ready_with_history');
  });

  it('case 7: 1 real, defaultSlug unset → needs_default_connection', () => {
    const conn = realConnection({ slug: 'anthropic-live' });
    assert.deepEqual(
      derive({ connections: [conn], secrets: { 'anthropic-live': true } }),
      { kind: 'needs_default_connection' },
    );
  });

  it('case 8: 1 real ready, defaultSlug points to deleted conn → needs_default_connection', () => {
    const conn = realConnection({ slug: 'anthropic-live' });
    assert.deepEqual(
      derive({ connections: [conn], defaultSlug: 'deleted-slug', secrets: { 'anthropic-live': true } }),
      { kind: 'needs_default_connection' },
    );
  });

  it('case 9: 1 real ready + 1 fake, defaultSlug=fake → needs_default_connection', () => {
    const conn = realConnection({ slug: 'anthropic-live' });
    const fake = fakeConnection({ slug: 'fake-x' });
    assert.deepEqual(
      derive({
        connections: [conn, fake],
        defaultSlug: 'fake-x',
        secrets: { 'anthropic-live': true },
      }),
      { kind: 'needs_default_connection' },
    );
  });

  it('case 10: 1 real, defaultSlug=real, missing API key → needs_connection_credentials', () => {
    const conn = realConnection({ slug: 'anthropic-live' });
    assert.deepEqual(
      derive({ connections: [conn], defaultSlug: 'anthropic-live', secrets: {} }),
      { kind: 'needs_connection_credentials', connectionSlug: 'anthropic-live' },
    );
  });

  it('case 11: 1 real, has key, no defaultModel → needs_default_model', () => {
    const conn = realConnection({
      slug: 'anthropic-live',
      defaultModel: '',
      models: undefined, // no enumerated list — falls through to missing_model
    });
    assert.deepEqual(
      derive({ connections: [conn], defaultSlug: 'anthropic-live', secrets: { 'anthropic-live': true } }),
      { kind: 'needs_default_model', connectionSlug: 'anthropic-live' },
    );
  });

  it('case 12: 1 real, has key, defaultModel not_enabled → needs_default_model', () => {
    const conn = realConnection({
      slug: 'anthropic-live',
      defaultModel: 'stale-model-id',
      models: [{ id: 'claude-sonnet-4-5-20250929', capabilities: {}, contextWindow: 200_000 }],
    });
    assert.deepEqual(
      derive({ connections: [conn], defaultSlug: 'anthropic-live', secrets: { 'anthropic-live': true } }),
      { kind: 'needs_default_model', connectionSlug: 'anthropic-live' },
    );
  });

  it('case 13: 1 real, has key, empty_model_list → needs_default_model', () => {
    const conn = realConnection({ slug: 'anthropic-live', defaultModel: 'something', models: [] });
    assert.deepEqual(
      derive({ connections: [conn], defaultSlug: 'anthropic-live', secrets: { 'anthropic-live': true } }),
      { kind: 'needs_default_model', connectionSlug: 'anthropic-live' },
    );
  });

  it('case 14: 1 real disabled, no ready alt → blocked: all_connections_unhealthy', () => {
    const conn = realConnection({ slug: 'anthropic-live', enabled: false });
    assert.deepEqual(
      derive({ connections: [conn], defaultSlug: 'anthropic-live', secrets: { 'anthropic-live': true } }),
      { kind: 'blocked', reason: 'all_connections_unhealthy' },
    );
  });

  it('case 15: 2 real both disabled → blocked: all_connections_unhealthy', () => {
    const a = realConnection({ slug: 'conn-a', enabled: false });
    const b = realConnection({ slug: 'conn-b', enabled: false });
    assert.deepEqual(
      derive({
        connections: [a, b],
        defaultSlug: 'conn-a',
        secrets: { 'conn-a': true, 'conn-b': true },
      }),
      { kind: 'blocked', reason: 'all_connections_unhealthy' },
    );
  });
});

// ---------------------------------------------------------------------------
// Cross-cutting invariants
// ---------------------------------------------------------------------------

describe('deriveOnboardingState invariants', () => {
  it('does NOT actively produce blocked: no_real_connection (only-fake rolls back to needs_connection)', () => {
    // @kenji + @xuan PR110a gate: `no_real_connection` is reserved for
    // send-path/readiness reason codes; onboarding derive never emits
    // it because the actionable fix path is `needs_connection`.
    const fake = fakeConnection({ slug: 'fake-only' });
    const result = derive({ connections: [fake], defaultSlug: 'fake-only', secrets: { 'fake-only': true } });
    assert.notDeepEqual(result, { kind: 'blocked', reason: 'no_real_connection' });
    assert.deepEqual(result, { kind: 'needs_connection' });
  });

  it('isConnectionReady is the single source of truth (helper reuse, @kenji review #1)', () => {
    // Locks the integration: deriveOnboardingState must reach a ready
    // state if and only if isConnectionReady() returns ready for the
    // default connection with the same secret presence.
    const conn = realConnection({ slug: 'shared-slug' });
    const ready = isConnectionReady({ connection: conn, hasSecret: true });
    assert.equal(ready.ready, true);
    const result = derive({ connections: [conn], defaultSlug: 'shared-slug', secrets: { 'shared-slug': true } });
    assert.equal(result.kind, 'ready_empty');

    // Flipping hasSecret to false flips both helpers consistently.
    const notReady = isConnectionReady({ connection: conn, hasSecret: false });
    assert.equal(notReady.ready, false);
    if (!notReady.ready) {
      assert.equal(notReady.reason, 'missing_api_key');
    }
    const result2 = derive({ connections: [conn], defaultSlug: 'shared-slug', secrets: {} });
    assert.equal(result2.kind, 'needs_connection_credentials');
  });

  it('is pure: same input always produces same output (deep-equal)', () => {
    const conn = realConnection({ slug: 'a' });
    const input: DeriveOnboardingStateInput = {
      connections: [conn],
      defaultSlug: 'a',
      sessions: [session('s1')],
      secrets: { a: true },
    };
    assert.deepEqual(deriveOnboardingState(input), deriveOnboardingState(input));
  });

  it('does not mutate inputs', () => {
    const conn = realConnection({ slug: 'a' });
    const connections = [conn];
    const sessions = [session('s1')];
    const secrets = { a: true };
    const before = JSON.stringify({ connections, sessions, secrets });
    deriveOnboardingState({ connections, defaultSlug: 'a', sessions, secrets });
    assert.equal(JSON.stringify({ connections, sessions, secrets }), before);
  });
});

// ---------------------------------------------------------------------------
// Milestone validator + sanitizer
// ---------------------------------------------------------------------------

describe('isOnboardingMilestone', () => {
  it('accepts a bare placeholder {id} (not yet completed / skipped)', () => {
    for (const id of ONBOARDING_MILESTONE_IDS) {
      assert.equal(isOnboardingMilestone({ id }), true);
    }
  });

  it('accepts {id, completedAt}', () => {
    assert.equal(isOnboardingMilestone({ id: 'first_chat_sent', completedAt: 1_700_000_000_000 }), true);
  });

  it('accepts {id, skippedAt}', () => {
    assert.equal(isOnboardingMilestone({ id: 'first_chat_sent', skippedAt: 1_700_000_000_000 }), true);
  });

  it('rejects entries with BOTH completedAt and skippedAt (at-most-one terminal)', () => {
    assert.equal(
      isOnboardingMilestone({
        id: 'first_chat_sent',
        completedAt: 1_700_000_000_000,
        skippedAt: 1_700_000_001_000,
      }),
      false,
    );
  });

  it('rejects unknown milestone ids', () => {
    assert.equal(isOnboardingMilestone({ id: 'first_made_up_milestone' }), false);
    assert.equal(isOnboardingMilestone({ id: '' }), false);
    assert.equal(isOnboardingMilestone({ id: 42 }), false);
  });

  it('rejects extra fields (no prompt/provider error/user content leakage)', () => {
    assert.equal(
      isOnboardingMilestone({ id: 'first_chat_sent', prompt: 'hello world' } as unknown),
      false,
    );
    assert.equal(
      isOnboardingMilestone({
        id: 'first_chat_sent',
        completedAt: 1_700_000_000_000,
        providerError: 'rate limited',
      } as unknown),
      false,
    );
  });

  it('rejects non-finite timestamps (NaN, Infinity, -Infinity)', () => {
    for (const ts of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      assert.equal(isOnboardingMilestone({ id: 'first_chat_sent', completedAt: ts }), false);
      assert.equal(isOnboardingMilestone({ id: 'first_chat_sent', skippedAt: ts }), false);
    }
  });

  it('rejects negative timestamps', () => {
    assert.equal(isOnboardingMilestone({ id: 'first_chat_sent', completedAt: -1 }), false);
    assert.equal(isOnboardingMilestone({ id: 'first_chat_sent', skippedAt: -1 }), false);
  });

  it('rejects string / boolean timestamps', () => {
    for (const ts of ['1700000000000', '0', '', true, false]) {
      assert.equal(isOnboardingMilestone({ id: 'first_chat_sent', completedAt: ts } as unknown), false);
    }
  });

  it('rejects null / undefined / primitives / arrays / Date / Map / Set', () => {
    for (const value of [null, undefined, 1, 'string', true, false, [], [{ id: 'first_chat_sent' }], new Date(), new Map(), new Set()]) {
      assert.equal(isOnboardingMilestone(value), false, `should reject ${String(value)}`);
    }
  });

  it('accepts an entry from an Object.create(null) "plain" dict', () => {
    const dict = Object.create(null) as Record<string, unknown>;
    dict.id = 'first_chat_sent';
    dict.completedAt = 1_700_000_000_000;
    assert.equal(isOnboardingMilestone(dict), true);
  });
});

describe('sanitizeOnboardingMilestones', () => {
  it('returns [] for non-array input (no value-digging)', () => {
    for (const value of [null, undefined, {}, { foo: { id: 'first_chat_sent' } }, 'string', 42, true, false]) {
      assert.deepEqual(sanitizeOnboardingMilestones(value), []);
    }
  });

  it('keeps valid entries, drops invalid ones (no fail-empty)', () => {
    const result = sanitizeOnboardingMilestones([
      { id: 'first_chat_sent', completedAt: 1_700_000_000_000 },
      { id: 'first_personalization', completedAt: 'oops' }, // bad timestamp
      { id: 'first_model_swap', skippedAt: 1_700_000_001_000 },
      { id: 'first_artifact_open', completedAt: 1, skippedAt: 2 }, // both set
      { id: 'unknown_id', completedAt: 1_700_000_000_000 }, // unknown id
      { id: 'first_chat_sent', extra: 'leak' }, // extra field
    ] as unknown[]);

    assert.deepEqual<OnboardingMilestone[]>(result, [
      { id: 'first_chat_sent', completedAt: 1_700_000_000_000 },
      { id: 'first_model_swap', skippedAt: 1_700_000_001_000 },
    ]);
  });

  it('de-duplicates by id, keeping the first valid entry', () => {
    const result = sanitizeOnboardingMilestones([
      { id: 'first_chat_sent', completedAt: 1 },
      { id: 'first_chat_sent', completedAt: 2 },
      { id: 'first_chat_sent', skippedAt: 3 },
    ]);
    assert.deepEqual<OnboardingMilestone[]>(result, [{ id: 'first_chat_sent', completedAt: 1 }]);
  });

  it('returns [] when input is an empty array', () => {
    assert.deepEqual(sanitizeOnboardingMilestones([]), []);
  });
});
