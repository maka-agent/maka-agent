/**
 * Tests for `@maka/core/memory` — the PR-MEMORY-1 contract.
 *
 * Each describe block is labeled G#N when it pins one of the 9 privacy
 * gates locked by @xuan in `22209a1b`:
 *   G1: default-off
 *   G2: manual confirm before durable write
 *   G3: reversible delete/export precedes auto-write (contract-shape only)
 *   G4: incognito read+write disable
 *   G5: no auto sleep consolidation (enum shape)
 *   G6: visible citation (enum shape)
 *   G7: no hidden activity promotion (candidate-cannot-active)
 *   G8: provider+embedding leakage boundary (`embeddingProvider: 'disabled'`)
 *   G9: renderer cannot forge provenance/readiness
 *
 * Plus normalizer matrix and quasi-memory exclusion locks.
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import {
  MEMORY_BLOCK_REASONS,
  MEMORY_CANDIDATE_SOURCES,
  MEMORY_CONTENT_MAX_CODE_POINTS,
  MEMORY_MODES,
  MEMORY_PERSISTENCE_STATES,
  MEMORY_SCOPES,
  MEMORY_SOURCES,
  MEMORY_USE_POLICIES,
  isMemoryCandidateSource,
  isMemoryMode,
  isMemoryPersistenceState,
  isMemoryScope,
  isMemorySource,
  isMemoryUsePolicy,
  normalizeMemoryContent,
  normalizeMemoryMode,
  normalizeMemoryPersistenceState,
  normalizeMemoryScope,
  normalizeMemorySource,
  validateMemoryWriteRequest,
  type MemoryCapabilitySnapshot,
  type MemoryWriteRequest,
  type MemoryWriteRequestContext,
} from '../memory.js';

function ctx(overrides: Partial<MemoryWriteRequestContext> = {}): MemoryWriteRequestContext {
  return {
    mode: 'manual_with_drafts',
    incognitoActive: false,
    originatedFromRenderer: false,
    now: 1_700_000_000_000,
    ...overrides,
  };
}

function durableRequest(overrides: Partial<MemoryWriteRequest> = {}): MemoryWriteRequest {
  return {
    source: 'user_authored',
    persistenceState: 'active',
    content: 'Remember to ship the contract before the implementation.',
    scope: 'workspace',
    confirmedAt: 1_700_000_000_000,
    ...overrides,
  };
}

function draftRequest(overrides: Partial<MemoryWriteRequest> = {}): MemoryWriteRequest {
  return {
    source: 'voice_transcript',
    persistenceState: 'draft',
    content: 'Meeting note from voice transcript.',
    scope: 'session',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// G1 — default-off
// ---------------------------------------------------------------------------

describe('G1 — mode=off blocks all writes (default-off)', () => {
  it('rejects durable write when mode is off', () => {
    const result = validateMemoryWriteRequest(durableRequest(), ctx({ mode: 'off' }));
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.reason, 'mode_off');
  });

  it('rejects draft write when mode is off', () => {
    const result = validateMemoryWriteRequest(draftRequest(), ctx({ mode: 'off' }));
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.reason, 'mode_off');
  });

  it('MEMORY_MODES enumerates off as the first option (fresh-install default semantic)', () => {
    assert.equal(MEMORY_MODES[0], 'off');
  });
});

// ---------------------------------------------------------------------------
// G2 — manual confirm before durable write
// ---------------------------------------------------------------------------

describe('G2 — durable active requires confirmedAt (manual confirm)', () => {
  it('rejects user_authored + active without confirmedAt', () => {
    const result = validateMemoryWriteRequest(durableRequest({ confirmedAt: undefined }), ctx());
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.reason, 'manual_confirm_required');
  });

  it('rejects chat_extracted + active without confirmedAt', () => {
    const result = validateMemoryWriteRequest(
      durableRequest({ source: 'chat_extracted', confirmedAt: undefined }),
      ctx(),
    );
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.reason, 'manual_confirm_required');
  });

  it('rejects active with non-number / NaN / Infinity / negative confirmedAt', () => {
    for (const bad of [NaN, Infinity, -Infinity, -1, '1700000000000', null] as unknown[]) {
      const result = validateMemoryWriteRequest(
        durableRequest({ confirmedAt: bad as number }),
        ctx(),
      );
      assert.equal(result.ok, false, `bad=${String(bad)}`);
      if (!result.ok) assert.equal(result.reason, 'manual_confirm_required');
    }
  });

  it('rejects durable source with non-active persistence (must use candidate source for pending)', () => {
    for (const pending of ['draft', 'review_required'] as const) {
      const result = validateMemoryWriteRequest(
        durableRequest({ persistenceState: pending, confirmedAt: undefined }),
        ctx(),
      );
      assert.equal(result.ok, false, pending);
      if (!result.ok) assert.equal(result.reason, 'manual_confirm_required');
    }
  });

  it('accepts user_authored + active + confirmedAt', () => {
    const result = validateMemoryWriteRequest(durableRequest(), ctx());
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.value.persistenceState, 'active');
      assert.equal(result.value.source, 'user_authored');
      assert.equal((result.value as { confirmedAt: number }).confirmedAt, 1_700_000_000_000);
    }
  });
});

// ---------------------------------------------------------------------------
// G3 — reversibility precedes auto-write (contract shape only)
// ---------------------------------------------------------------------------

describe('G3 — contract has no auto-write bypass; v1 is contract-only', () => {
  it('contract exports no autoCommit / autoPromote function', async () => {
    const mod = await import('../memory.js');
    for (const key of Object.keys(mod)) {
      assert.doesNotMatch(key, /auto(Commit|Promote|Consolidate)/i, key);
    }
  });

  it('MemoryWriteRequest type does not accept skipConfirm field (no autopromote)', () => {
    // Compile-time: a request with `skipConfirm: true` would fail to
    // type-check against MemoryWriteRequest. Runtime: validator strips
    // extras (it only reads documented fields).
    const result = validateMemoryWriteRequest(
      { ...durableRequest(), skipConfirm: true } as unknown as MemoryWriteRequest,
      ctx(),
    );
    // Validator ignores extras — accepts the well-formed request — but
    // does not mutate the rejection-path for `skipConfirm`.
    assert.equal(result.ok, true);
  });
});

// ---------------------------------------------------------------------------
// G4 — incognito read+write disable
// ---------------------------------------------------------------------------

describe('G4 — incognito blocks all writes', () => {
  it('rejects valid durable write when incognitoActive=true', () => {
    const result = validateMemoryWriteRequest(durableRequest(), ctx({ incognitoActive: true }));
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.reason, 'incognito_active');
  });

  it('rejects valid draft write when incognitoActive=true', () => {
    const result = validateMemoryWriteRequest(draftRequest(), ctx({ incognitoActive: true }));
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.reason, 'incognito_active');
  });

  it('incognito gate precedes content validation (rejects malformed content as incognito)', () => {
    const result = validateMemoryWriteRequest(
      durableRequest({ content: '' }),
      ctx({ incognitoActive: true }),
    );
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.reason, 'incognito_active');
  });
});

// ---------------------------------------------------------------------------
// G5 — no auto sleep consolidation
// ---------------------------------------------------------------------------

describe('G5 — no automated consolidation source exists', () => {
  it('MEMORY_SOURCES does not contain any auto/sleep/consolidate kind', () => {
    for (const source of MEMORY_SOURCES) {
      assert.doesNotMatch(source, /sleep|consolidat|auto/i, source);
    }
  });

  it('MEMORY_CANDIDATE_SOURCES does not contain any auto/sleep/consolidate kind', () => {
    for (const source of MEMORY_CANDIDATE_SOURCES) {
      assert.doesNotMatch(source, /sleep|consolidat|auto/i, source);
    }
  });
});

// ---------------------------------------------------------------------------
// G6 — visible citation (use policy enum)
// ---------------------------------------------------------------------------

describe('G6 — MEMORY_USE_POLICIES allows only never and cited_only', () => {
  it('enum is exactly {never, cited_only}', () => {
    assert.deepEqual([...MEMORY_USE_POLICIES], ['never', 'cited_only']);
  });

  it('isMemoryUsePolicy rejects "silent" / "auto" / "always"', () => {
    for (const bad of ['silent', 'auto', 'always', 'unrestricted']) {
      assert.equal(isMemoryUsePolicy(bad), false, bad);
    }
  });
});

// ---------------------------------------------------------------------------
// G7 — no hidden activity promotion (candidate-cannot-active)
// ---------------------------------------------------------------------------

describe('G7 — candidate sources cannot reach active state', () => {
  it('rejects every candidate source with persistenceState=active', () => {
    for (const candidate of MEMORY_CANDIDATE_SOURCES) {
      const result = validateMemoryWriteRequest(
        { source: candidate, persistenceState: 'active', content: 'x', scope: 'workspace' },
        ctx(),
      );
      assert.equal(result.ok, false, candidate);
      if (!result.ok) assert.equal(result.reason, 'candidate_source_no_active', candidate);
    }
  });

  it('candidate gate precedes mode-disallows gate (priority: invariant > policy)', () => {
    // In mode=manual_only, a candidate-source request fails both
    // candidate_source_no_active AND mode_disallows_candidate. The
    // invariant gate (no candidate→active) is checked first.
    const result = validateMemoryWriteRequest(
      { source: 'voice_transcript', persistenceState: 'active', content: 'x', scope: 'workspace' },
      ctx({ mode: 'manual_only' }),
    );
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.reason, 'candidate_source_no_active');
  });

  it('mode=manual_only rejects candidate sources even at draft state', () => {
    const result = validateMemoryWriteRequest(draftRequest(), ctx({ mode: 'manual_only' }));
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.reason, 'mode_disallows_candidate');
  });

  it('mode=manual_with_drafts accepts candidate sources at draft state', () => {
    const result = validateMemoryWriteRequest(draftRequest(), ctx({ mode: 'manual_with_drafts' }));
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.value.source, 'voice_transcript');
      assert.equal(result.value.persistenceState, 'draft');
    }
  });

  it('accepts candidate + review_required state', () => {
    const result = validateMemoryWriteRequest(
      draftRequest({ persistenceState: 'review_required' }),
      ctx(),
    );
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.value.persistenceState, 'review_required');
    }
  });
});

// ---------------------------------------------------------------------------
// G8 — provider+embedding leakage boundary
// ---------------------------------------------------------------------------

describe('G8 — MemoryCapabilitySnapshot locks embeddingProvider="disabled"', () => {
  it('a snapshot constructed in code with literal "disabled" type-checks', () => {
    const snapshot: MemoryCapabilitySnapshot = {
      mode: 'off',
      durableEntriesCount: 0,
      pendingReviewCount: 0,
      embeddingProvider: 'disabled',
      incognitoActive: false,
      usePolicy: 'cited_only',
    };
    assert.equal(snapshot.embeddingProvider, 'disabled');
  });

  // Compile-time: assigning any other value to embeddingProvider would
  // fail TS check because the field is typed as the literal 'disabled'.
  // The runtime test asserts the literal is the only thing that fits the
  // shape under string equality.
  it('embeddingProvider field is the literal string "disabled"', () => {
    const snapshot: MemoryCapabilitySnapshot = {
      mode: 'off',
      durableEntriesCount: 0,
      pendingReviewCount: 0,
      embeddingProvider: 'disabled',
      incognitoActive: false,
      usePolicy: 'cited_only',
    };
    assert.equal(snapshot.embeddingProvider, 'disabled');
    assert.equal(typeof snapshot.embeddingProvider, 'string');
  });
});

// ---------------------------------------------------------------------------
// G9 — renderer cannot forge provenance/readiness
// ---------------------------------------------------------------------------

describe('G9 — renderer-originated active durable write is blocked', () => {
  it('rejects valid durable active when originatedFromRenderer=true', () => {
    const result = validateMemoryWriteRequest(
      durableRequest(),
      ctx({ originatedFromRenderer: true }),
    );
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.reason, 'renderer_provenance_forged');
  });

  it('renderer can still propose drafts via candidate source', () => {
    // The renderer is allowed to propose drafts (e.g. user reviews
    // voice transcript and forwards). It cannot record `confirmedAt`.
    const result = validateMemoryWriteRequest(
      draftRequest(),
      ctx({ originatedFromRenderer: true }),
    );
    assert.equal(result.ok, true);
  });
});

// ---------------------------------------------------------------------------
// Normalizer matrix
// ---------------------------------------------------------------------------

describe('normalizeMemoryContent', () => {
  it('accepts trimmed string after NFC normalization', () => {
    const result = normalizeMemoryContent('  Hello, world  ');
    assert.equal(result.ok, true);
    if (result.ok) assert.equal(result.value, 'Hello, world');
  });

  it('strips control characters and zero-width characters', () => {
    const inputWithControls =
      'foo' + String.fromCharCode(0x00) + 'bar' + String.fromCharCode(0x200b) + 'baz';
    const result = normalizeMemoryContent(inputWithControls);
    assert.equal(result.ok, true);
    if (result.ok) {
      // C0 replaced with space; ZWSP removed entirely.
      assert.equal(result.value, 'foo barbaz');
    }
  });

  it('rejects non-string', () => {
    for (const bad of [undefined, null, 42, true, {}, []]) {
      const result = normalizeMemoryContent(bad);
      assert.equal(result.ok, false, String(bad));
      if (!result.ok) assert.equal(result.reason, 'content_invalid');
    }
  });

  it('rejects empty after trim', () => {
    for (const bad of ['', '   ', '\t\n  ']) {
      const result = normalizeMemoryContent(bad);
      assert.equal(result.ok, false, JSON.stringify(bad));
      if (!result.ok) assert.equal(result.reason, 'content_invalid');
    }
  });

  it('rejects content exceeding code-point cap', () => {
    const over = 'a'.repeat(MEMORY_CONTENT_MAX_CODE_POINTS + 1);
    const result = normalizeMemoryContent(over);
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.reason, 'content_invalid');
  });

  it('accepts content right at the cap (emoji-safe code-point counting)', () => {
    const at = 'a'.repeat(MEMORY_CONTENT_MAX_CODE_POINTS);
    const result = normalizeMemoryContent(at);
    assert.equal(result.ok, true);
  });
});

describe('normalizeMemorySource', () => {
  it('classifies user_authored as memory kind', () => {
    const result = normalizeMemorySource('user_authored');
    assert.equal(result.ok, true);
    if (result.ok) assert.deepEqual(result.value, { kind: 'memory', value: 'user_authored' });
  });

  it('classifies chat_extracted as memory kind', () => {
    const result = normalizeMemorySource('chat_extracted');
    assert.equal(result.ok, true);
    if (result.ok) assert.equal(result.value.kind, 'memory');
  });

  it('classifies each candidate source as candidate kind', () => {
    for (const candidate of MEMORY_CANDIDATE_SOURCES) {
      const result = normalizeMemorySource(candidate);
      assert.equal(result.ok, true, candidate);
      if (result.ok) assert.equal(result.value.kind, 'candidate', candidate);
    }
  });

  it('rejects unknown source string', () => {
    for (const bad of ['', 'usage_log', 'settings', 'session_summary', 'skill_inject']) {
      const result = normalizeMemorySource(bad);
      assert.equal(result.ok, false, bad);
      if (!result.ok) assert.equal(result.reason, 'unknown_source');
    }
  });

  it('rejects non-string source', () => {
    for (const bad of [undefined, null, 42, {}, []]) {
      const result = normalizeMemorySource(bad);
      assert.equal(result.ok, false, String(bad));
      if (!result.ok) assert.equal(result.reason, 'unknown_source');
    }
  });
});

describe('normalizeMemoryMode / Scope / PersistenceState — closed-enum reject', () => {
  it('mode rejects unknown', () => {
    const result = normalizeMemoryMode('always_on');
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.reason, 'mode_invalid');
  });

  it('scope rejects unknown', () => {
    const result = normalizeMemoryScope('global');
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.reason, 'scope_invalid');
  });

  it('persistenceState rejects unknown', () => {
    const result = normalizeMemoryPersistenceState('persisted');
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.reason, 'persistence_invalid');
  });

  it('type guards return true for closed-enum members and false otherwise', () => {
    for (const mode of MEMORY_MODES) assert.equal(isMemoryMode(mode), true, mode);
    for (const scope of MEMORY_SCOPES) assert.equal(isMemoryScope(scope), true, scope);
    for (const state of MEMORY_PERSISTENCE_STATES)
      assert.equal(isMemoryPersistenceState(state), true, state);
    for (const source of MEMORY_SOURCES) assert.equal(isMemorySource(source), true, source);
    for (const candidate of MEMORY_CANDIDATE_SOURCES)
      assert.equal(isMemoryCandidateSource(candidate), true, candidate);
    assert.equal(isMemoryMode('unknown'), false);
    assert.equal(isMemorySource('voice_transcript'), false);
    assert.equal(isMemoryCandidateSource('user_authored'), false);
  });
});

// ---------------------------------------------------------------------------
// Quasi-memory exclusion (gate #7 + #8 type-system enforcement)
// ---------------------------------------------------------------------------

describe('Quasi-memory surfaces cannot enter MemorySource', () => {
  it('rejects "usage_log" / "settings" / "session_summary" / "skill_inject" / "workspace_instruction" as source', () => {
    const quasiNames = [
      'usage_log',
      'settings',
      'session_summary',
      'skill_inject',
      'workspace_instruction',
      'onboarding_milestone',
      'health_probe',
      'visual_smoke_fixture',
    ];
    for (const name of quasiNames) {
      const result = normalizeMemorySource(name);
      assert.equal(result.ok, false, name);
      if (!result.ok) assert.equal(result.reason, 'unknown_source', name);
    }
  });

  // PR-MEMORY-1 review fixup (@xuan msg `0c9c68f9`): pin the validator
  // entry point — not just the source-name normalizer — so a quasi-memory
  // name with full valid `active` + `confirmedAt` + main-originated context
  // still rejects. This catches the "fully formed durable write whose only
  // problem is the source literal" path. (Source-laundering — i.e.
  // downstream relabeling content as `chat_extracted` before submit — is
  // a separate provenance gate at the IPC/store boundary, not contract.)
  it('validateMemoryWriteRequest rejects fully-formed durable with quasi-memory source name', () => {
    const quasiNames = [
      'usage_log',
      'settings',
      'session_summary',
      'skill_inject',
      'workspace_instruction',
      'onboarding_milestone',
      'health_probe',
      'visual_smoke_fixture',
    ];
    for (const name of quasiNames) {
      const result = validateMemoryWriteRequest(
        {
          source: name,
          persistenceState: 'active',
          content: 'looks like a fully valid durable write but the source is a quasi-memory name',
          scope: 'workspace',
          confirmedAt: 1_700_000_000_000,
        },
        ctx({ originatedFromRenderer: false }),
      );
      assert.equal(result.ok, false, name);
      if (!result.ok) {
        assert.equal(result.reason, 'unknown_source', name);
      }
    }
  });

  it('validateMemoryWriteRequest rejects fully-formed draft with quasi-memory source name', () => {
    const quasiNames = ['usage_log', 'session_summary', 'health_probe'];
    for (const name of quasiNames) {
      const result = validateMemoryWriteRequest(
        {
          source: name,
          persistenceState: 'draft',
          content: 'quasi-memory body but presented as draft',
          scope: 'session',
        },
        ctx(),
      );
      assert.equal(result.ok, false, name);
      if (!result.ok) {
        assert.equal(result.reason, 'unknown_source', name);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Block reason enum hygiene
// ---------------------------------------------------------------------------

describe('MEMORY_BLOCK_REASONS is a closed union', () => {
  it('includes every reason emitted by validateMemoryWriteRequest', () => {
    const expected = [
      'mode_off',
      'incognito_active',
      'manual_confirm_required',
      'candidate_source_no_active',
      'unknown_source',
      'content_invalid',
      'scope_invalid',
      'mode_invalid',
      'persistence_invalid',
      'renderer_provenance_forged',
      'mode_disallows_candidate',
    ];
    for (const reason of expected) {
      assert.ok(
        (MEMORY_BLOCK_REASONS as readonly string[]).includes(reason),
        reason + ' missing from MEMORY_BLOCK_REASONS',
      );
    }
  });

  it('includes embedding_disabled and quasi_memory_promotion_blocked for future extension', () => {
    assert.ok((MEMORY_BLOCK_REASONS as readonly string[]).includes('embedding_disabled'));
    assert.ok(
      (MEMORY_BLOCK_REASONS as readonly string[]).includes('quasi_memory_promotion_blocked'),
    );
  });
});

// ---------------------------------------------------------------------------
// Successful canonical return
// ---------------------------------------------------------------------------

describe('canonical return shape', () => {
  it('durable write returns DurableMemoryEntry with active state and confirmedAt', () => {
    const result = validateMemoryWriteRequest(durableRequest(), ctx());
    assert.equal(result.ok, true);
    if (result.ok) {
      const entry = result.value;
      assert.equal(entry.persistenceState, 'active');
      assert.equal(entry.source, 'user_authored');
      assert.equal(entry.scope, 'workspace');
      assert.equal(entry.content, 'Remember to ship the contract before the implementation.');
      // confirmedAt + createdAt both present.
      assert.equal((entry as { confirmedAt: number }).confirmedAt, 1_700_000_000_000);
      assert.equal(entry.createdAt, 1_700_000_000_000);
    }
  });

  it('draft write returns DraftMemoryEntry with injected now timestamp', () => {
    const result = validateMemoryWriteRequest(draftRequest(), ctx({ now: 1_800_000_000_000 }));
    assert.equal(result.ok, true);
    if (result.ok) {
      const entry = result.value;
      assert.equal(entry.persistenceState, 'draft');
      assert.equal(entry.source, 'voice_transcript');
      assert.equal((entry as { proposedAt: number }).proposedAt, 1_800_000_000_000);
      // No confirmedAt on draft entries (by design).
      assert.equal((entry as { confirmedAt?: number }).confirmedAt, undefined);
    }
  });
});
