/**
 * Memory core contract (PR-MEMORY-1).
 *
 * Anchors:
 *   - Audit report: external memory-reverse note 2026-05-25 (kenji msg `66fd3eab`).
 *   - Gate review:  `22209a1b` (xuan, MEMORY-0 audit sign-off + scope adjust).
 *   - Scope lock:   `e5072f5b` (yuejing accepting xuan adjust + kenji `fb95a158`).
 *
 * Pattern mirror: `@maka/core/search` (PR-SEARCH-0) + `@maka/core/llm-connections`
 * (IPC-1) Result-typed normalizers. Same audit-lane reflex from PR-HEALTH-0/1.
 *
 * Scope: this module is **contract-only**. It declares the closed enums,
 * snapshot/entry shapes, and normalizers that any future Maka memory
 * surface MUST honor. It does NOT implement persistence, embedding,
 * recall, IPC, renderer UI, or settings flags. The 9 privacy gates locked
 * by @xuan (`22209a1b`) are encoded as either:
 *   (a) type system constraints — durable `MemorySource` is disjoint from
 *       `MemoryCandidateSource` so a `voice_transcript` source cannot
 *       reach `'active'` persistence by typing alone, OR
 *   (b) normalizer rejection — `validateMemoryWriteRequest` returns a
 *       `MemoryBlockReason` for any attempt that violates the gates.
 *
 * Hard no-go (enforced by source gate at review): this file MUST NOT
 *   import from IPC / storage / runtime / electron / renderer surfaces.
 *
 * Source hygiene: regex character classes use the `new RegExp` constructor
 * with `String.fromCharCode` bounds rather than `/[...]/` literals. This
 * keeps the source file plain ASCII — same lesson from PR-UI-IPC-2 review
 * fixup (@kenji msg `f5daa4d4`). Literal control bytes in source make git
 * treat the .ts file as binary and break diff / merge gate source grep.
 *
 * @see docs/archive/memory-threat-model-pr-memory-1.md for the historical
 *      9-gate rationale and external negative-reference list (sleep cycle / auto-extract /
 *      automatic LLM-mediated forget / activity-derived memory /
 *      unauthenticated local route / cloud embedding fallback / Soul tree).
 */

// ---------------------------------------------------------------------------
// Caps (numeric)
// ---------------------------------------------------------------------------

/**
 * Max code-points for a memory entry's content body. Bounded so adversarial
 * input (or accidental large paste) cannot land in the durable contract
 * shape. Larger than typical user notes (a few sentences) but small enough
 * that a forgotten clipboard never becomes a permanent record.
 */
export const MEMORY_CONTENT_MAX_CODE_POINTS = 2000;

// ---------------------------------------------------------------------------
// Closed enums (9-gate vocabulary)
// ---------------------------------------------------------------------------

/**
 * Mode of the entire memory subsystem.
 *
 *   - `off` — default. No memory operations. All reads/writes return a
 *     `MemoryBlockReason='mode_off'`. The contract requires this to be
 *     the fresh-install default (gate #1).
 *   - `manual_only` — user can write durable memory by explicit user
 *     action. Candidate sources (voice / activity / cu) are NOT accepted;
 *     drafts are rejected at the normalizer.
 *   - `manual_with_drafts` — user can write durable memory by explicit
 *     action AND candidate sources may produce `'draft'` /
 *     `'review_required'` entries for user review. Drafts NEVER auto-
 *     promote to `'active'` (gate #6 reversible-before-auto-write).
 */
export const MEMORY_MODES = ['off', 'manual_only', 'manual_with_drafts'] as const;
export type MemoryMode = (typeof MEMORY_MODES)[number];

/**
 * Sources allowed to create a DURABLE (`'active'`) memory entry. Disjoint
 * from `MemoryCandidateSource`. Per @xuan `22209a1b`: voice transcripts /
 * activity / CU / search recall / daily review are NOT in this union and
 * cannot reach `'active'` through any code path.
 *
 *   - `user_authored` — user typed the memory body directly. Highest
 *     provenance.
 *   - `chat_extracted` — assistant suggested an extraction; **only**
 *     valid after explicit manual confirmation event recorded in the
 *     entry's `confirmedAt`.
 */
export const MEMORY_SOURCES = ['user_authored', 'chat_extracted'] as const;
export type MemorySource = (typeof MEMORY_SOURCES)[number];

/**
 * Non-durable candidate sources that can only produce `'draft'` /
 * `'review_required'` entries. Per @xuan `22209a1b` + @kenji `fb95a158`,
 * the type system separates them from `MemorySource` so a quasi-memory
 * surface cannot accidentally become a `MemorySource` in code.
 *
 *   - `voice_transcript`         — STT output (post-PR-VOICE-*).
 *   - `activity_observation`     — Activity recorder (post-Activity audit).
 *   - `cu_observation`           — Computer Use observed state.
 *   - `search_recall`            — A search result the user found
 *                                  noteworthy; not auto-promoted.
 *   - `daily_review`             — Daily Review aggregated candidates.
 *
 * Adding a new candidate kind is a contract change: must extend this
 * enum AND `MEMORY_BLOCK_REASONS` if a new failure mode emerges.
 */
export const MEMORY_CANDIDATE_SOURCES = [
  'voice_transcript',
  'activity_observation',
  'cu_observation',
  'search_recall',
  'daily_review',
] as const;
export type MemoryCandidateSource = (typeof MEMORY_CANDIDATE_SOURCES)[number];

/**
 * Persistence state of a memory entry.
 *
 *   - `draft` — proposed by a candidate source; user has NOT reviewed.
 *     Never injected into prompts; never cited.
 *   - `review_required` — surfaced in the review queue; awaiting user
 *     decision. Still NOT injected. The state exists separately from
 *     `draft` so the UI can distinguish "waiting in queue" from "deep
 *     in queue".
 *   - `active` — user has explicitly confirmed. ONLY entries with this
 *     state may be prompt-injected (and only with visible citation).
 *
 * Per @xuan + @kenji: a candidate source's entry cannot transition
 * directly to `'active'` without an explicit user confirmation event.
 * `validateMemoryWriteRequest` rejects any such attempt.
 */
export const MEMORY_PERSISTENCE_STATES = ['draft', 'review_required', 'active'] as const;
export type MemoryPersistenceState = (typeof MEMORY_PERSISTENCE_STATES)[number];

/**
 * Policy for HOW an `'active'` memory entry may be consumed.
 *
 *   - `never` — even active entries are not injected. (Useful for an
 *     export-only mode.)
 *   - `cited_only` — entries may be injected into prompts ONLY when the
 *     UI / assistant surfaces a visible citation alongside the use
 *     (gate #4: visible citation).
 *
 * `cited_only` is the strictest contract that still allows the feature
 * to be useful. No `silent` policy exists — that would violate the gate.
 */
export const MEMORY_USE_POLICIES = ['never', 'cited_only'] as const;
export type MemoryUsePolicy = (typeof MEMORY_USE_POLICIES)[number];

/**
 * Closed enum of reasons a memory operation is blocked.
 *
 * Mirrors the external memory-reverse audit catalog 2026-05-25
 * (kenji msg `66fd3eab`) + xuan's 9-gate list (`22209a1b`).
 */
export const MEMORY_BLOCK_REASONS = [
  'mode_off',
  'incognito_active',
  'manual_confirm_required',
  'candidate_source_no_active',
  'unknown_source',
  'embedding_disabled',
  'quasi_memory_promotion_blocked',
  'content_invalid',
  'scope_invalid',
  'mode_invalid',
  'persistence_invalid',
  'renderer_provenance_forged',
  'mode_disallows_candidate',
] as const;
export type MemoryBlockReason = (typeof MEMORY_BLOCK_REASONS)[number];

/**
 * Scope of a memory entry — which conversations / sessions can see it.
 *
 *   - `workspace` — visible to every session in the workspace (subject
 *     to `MemoryUsePolicy` and incognito gating).
 *   - `session`   — visible only inside the originating session.
 */
export const MEMORY_SCOPES = ['workspace', 'session'] as const;
export type MemoryScope = (typeof MEMORY_SCOPES)[number];

// ---------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------

/**
 * Capability snapshot for the memory subsystem.
 *
 * Aligned with the existing `CapabilityMemoryAcceptanceSignal` per @xuan
 * `22209a1b` + `68a1bcb5`. The shape stays intentionally minimal — adding
 * `embeddingProvider: 'disabled'` as a literal lock makes the v1 contract
 * self-documenting: no provider fallback is allowed at this layer.
 */
export interface MemoryCapabilitySnapshot {
  mode: MemoryMode;
  /** Total durable entries (state === 'active'). Never reflects drafts. */
  durableEntriesCount: number;
  /** Draft + review_required combined. Shown in the review queue. */
  pendingReviewCount: number;
  /** Hard-coded `'disabled'` for v1 — no embedding provider in this contract. */
  embeddingProvider: 'disabled';
  /** True when incognito is active. Read/write both blocked. */
  incognitoActive: boolean;
  /** Use policy applied to active entries. `'never'` short-circuits all reads. */
  usePolicy: MemoryUsePolicy;
}

/**
 * Durable memory entry. The `source` field is `MemorySource` — i.e. the
 * candidate sources cannot type-check into this shape.
 */
export interface DurableMemoryEntry {
  id: string;
  source: MemorySource;
  /** Always `'active'` for durable entries — encoded as a literal. */
  persistenceState: 'active';
  content: string;
  scope: MemoryScope;
  createdAt: number;
  /**
   * Required confirmation timestamp. Per gate #2 (manual confirm before
   * durable write), an entry cannot reach `'active'` without this
   * timestamp. The normalizer enforces presence + finite + non-negative.
   */
  confirmedAt: number;
  /** Optional opaque reference back to the surface that requested write. */
  sourceTurnId?: string;
}

/**
 * Non-durable memory entry. The `source` field is `MemoryCandidateSource`
 * — disjoint from `MemorySource`. The persistence state is constrained
 * to `'draft'` or `'review_required'` — there is no `'active'` overload
 * at the type level.
 */
export interface DraftMemoryEntry {
  id: string;
  source: MemoryCandidateSource;
  persistenceState: 'draft' | 'review_required';
  content: string;
  scope: MemoryScope;
  proposedAt: number;
  /** No `confirmedAt` here by design — draft state means not confirmed. */
}

/**
 * Discriminated union for any memory entry. Consumers pattern-match on
 * `persistenceState` (or equivalently on the `source` enum membership).
 */
export type MemoryEntry = DurableMemoryEntry | DraftMemoryEntry;

/**
 * Write request received by a (future) MemoryStore boundary. The
 * normalizer applies all 9 privacy gates; on `ok: false` the caller
 * MUST throw before any persistence occurs.
 */
export interface MemoryWriteRequest {
  source: MemorySource | MemoryCandidateSource | string;
  /** Required target state. Candidate sources MUST request `'draft'` or `'review_required'`. */
  persistenceState: MemoryPersistenceState | string;
  content: string;
  scope: MemoryScope | string;
  /** Required when `source` is a `MemorySource` AND `persistenceState === 'active'`. */
  confirmedAt?: number;
  sourceTurnId?: string;
}

/**
 * Result envelope for normalizers. Same Result-typed pattern as
 * `@maka/core/search` and `@maka/core/llm-connections`.
 */
export type MemoryResult<T> =
  | { ok: true; value: T }
  | { ok: false; reason: MemoryBlockReason; message: string };

// ---------------------------------------------------------------------------
// Normalizers
// ---------------------------------------------------------------------------

// Source-hygiene: build regex character classes from String.fromCharCode
// so the .ts source stays plain ASCII. Same lesson from PR-UI-IPC-2
// review fixup (@kenji msg f5daa4d4) — literal control bytes in source
// make git treat the file as binary and break diff/merge gate source grep.

// C0 / DEL / C1 control characters: U+0000..U+001F, U+007F, U+0080..U+009F.
// Replaced with space (not removed) so multi-line input becomes readable
// single-line.
const CONTROL_CHARS_REGEX = new RegExp(
  '[' +
    String.fromCharCode(0x00) +
    '-' +
    String.fromCharCode(0x1f) +
    String.fromCharCode(0x7f) +
    '-' +
    String.fromCharCode(0x9f) +
    ']',
  'g',
);

// Zero-width format characters: U+200B (ZWSP), U+200C (ZWNJ), U+200D (ZWJ),
// U+FEFF (BOM). Removed entirely (no space replacement) because they're
// meant to be invisible.
const ZERO_WIDTH_REGEX = new RegExp(
  '[' +
    String.fromCharCode(0x200b) +
    '-' +
    String.fromCharCode(0x200d) +
    String.fromCharCode(0xfeff) +
    ']',
  'g',
);

/**
 * Validate + canonicalize a memory entry body.
 *
 * Pipeline:
 *   1. typeof string guard (IPC payload defense — TS shape is compile-time only).
 *   2. NFC normalize.
 *   3. Strip C0/C1 control chars + zero-width chars (gate #4 visibility
 *      requires content that the user can actually read in citations).
 *   4. Trim.
 *   5. Reject empty after trim.
 *   6. Reject > `MEMORY_CONTENT_MAX_CODE_POINTS` code points (emoji-safe).
 */
export function normalizeMemoryContent(input: unknown): MemoryResult<string> {
  if (typeof input !== 'string') {
    return invalid('content_invalid', 'memory content must be a string');
  }
  const normalized = input
    .normalize('NFC')
    .replace(CONTROL_CHARS_REGEX, ' ')
    .replace(ZERO_WIDTH_REGEX, '');
  const trimmed = normalized.trim();
  if (trimmed === '') {
    return invalid('content_invalid', 'memory content cannot be empty');
  }
  if (Array.from(trimmed).length > MEMORY_CONTENT_MAX_CODE_POINTS) {
    return invalid(
      'content_invalid',
      'memory content must be ' + MEMORY_CONTENT_MAX_CODE_POINTS + ' code points or fewer',
    );
  }
  return { ok: true, value: trimmed };
}

/** Closed-enum membership check for `MemorySource`. */
export function isMemorySource(value: unknown): value is MemorySource {
  return typeof value === 'string' && (MEMORY_SOURCES as readonly string[]).includes(value);
}

/** Closed-enum membership check for `MemoryCandidateSource`. */
export function isMemoryCandidateSource(value: unknown): value is MemoryCandidateSource {
  return (
    typeof value === 'string' && (MEMORY_CANDIDATE_SOURCES as readonly string[]).includes(value)
  );
}

/** Closed-enum membership check for `MemoryMode`. */
export function isMemoryMode(value: unknown): value is MemoryMode {
  return typeof value === 'string' && (MEMORY_MODES as readonly string[]).includes(value);
}

/** Closed-enum membership check for `MemoryPersistenceState`. */
export function isMemoryPersistenceState(value: unknown): value is MemoryPersistenceState {
  return (
    typeof value === 'string' && (MEMORY_PERSISTENCE_STATES as readonly string[]).includes(value)
  );
}

/** Closed-enum membership check for `MemoryScope`. */
export function isMemoryScope(value: unknown): value is MemoryScope {
  return typeof value === 'string' && (MEMORY_SCOPES as readonly string[]).includes(value);
}

/** Closed-enum membership check for `MemoryUsePolicy`. */
export function isMemoryUsePolicy(value: unknown): value is MemoryUsePolicy {
  return typeof value === 'string' && (MEMORY_USE_POLICIES as readonly string[]).includes(value);
}

/**
 * Validate + canonicalize a `MemoryScope`.
 */
export function normalizeMemoryScope(input: unknown): MemoryResult<MemoryScope> {
  if (!isMemoryScope(input)) {
    return invalid('scope_invalid', 'memory scope is not a recognized value');
  }
  return { ok: true, value: input };
}

/**
 * Validate + canonicalize a `MemoryMode`.
 */
export function normalizeMemoryMode(input: unknown): MemoryResult<MemoryMode> {
  if (!isMemoryMode(input)) {
    return invalid('mode_invalid', 'memory mode is not a recognized value');
  }
  return { ok: true, value: input };
}

/**
 * Validate + canonicalize a `MemoryPersistenceState`.
 */
export function normalizeMemoryPersistenceState(
  input: unknown,
): MemoryResult<MemoryPersistenceState> {
  if (!isMemoryPersistenceState(input)) {
    return invalid('persistence_invalid', 'memory persistenceState is not a recognized value');
  }
  return { ok: true, value: input };
}

/**
 * Resolved source descriptor — telling the caller whether the source is
 * durable-capable or candidate-only, plus the canonical string value.
 */
export interface MemorySourceResolution {
  kind: 'memory' | 'candidate';
  value: MemorySource | MemoryCandidateSource;
}

/**
 * Classify + canonicalize a memory source string. Rejects unknown values.
 */
export function normalizeMemorySource(input: unknown): MemoryResult<MemorySourceResolution> {
  if (isMemorySource(input)) {
    return { ok: true, value: { kind: 'memory', value: input } };
  }
  if (isMemoryCandidateSource(input)) {
    return { ok: true, value: { kind: 'candidate', value: input } };
  }
  return invalid('unknown_source', 'memory source is not in MemorySource or MemoryCandidateSource');
}

/**
 * Context the caller MUST supply when validating a write request. The
 * `mode` + `incognitoActive` flags are consulted FIRST so a request that
 * the subsystem mode would have blocked never reveals further details
 * about its other fields (defensive). Caller is responsible for resolving
 * mode + incognito from settings/runtime before calling.
 *
 * `originatedFromRenderer` enforces gate #9 (renderer-forged provenance):
 * a renderer-originated payload may NOT include a `confirmedAt` claim —
 * confirmation must be recorded by the main / storage boundary, not the
 * renderer. Setting this flag in tests / main-internal code is allowed
 * because those callers are inside the trust boundary.
 *
 * `now` is injected so tests can pin timestamps; runtime callers should
 * pass `Date.now()`.
 */
export interface MemoryWriteRequestContext {
  mode: MemoryMode;
  incognitoActive: boolean;
  /** Whether the request originated from the renderer (untrusted). */
  originatedFromRenderer: boolean;
  /** Injected clock; defaults to Date.now() if not supplied. */
  now?: number;
}

/**
 * The single gate function: validate + canonicalize a `MemoryWriteRequest`.
 *
 * Order of checks is significant — earlier checks block on coarser policy
 * so misuse with rich payloads doesn't leak structure through error
 * messages.
 *
 *   1. mode === 'off'                                   → `mode_off`
 *   2. incognito                                        → `incognito_active`
 *   3. content normalize                                → `content_invalid`
 *   4. scope normalize                                  → `scope_invalid`
 *   5. persistence normalize                            → `persistence_invalid`
 *   6. source classify (memory vs candidate vs unknown) → `unknown_source`
 *   7. candidate + persistenceState === 'active'        → `candidate_source_no_active`
 *   8. mode === 'manual_only' + candidate source        → `mode_disallows_candidate`
 *   9. memory source + non-active state                 → `manual_confirm_required`
 *  10. memory source + active state without confirmedAt → `manual_confirm_required`
 *  11. renderer + memory source + active                → `renderer_provenance_forged`
 *
 * Returns a canonical `MemoryEntry` (durable or draft variant) ready for
 * the next layer to persist. No layer below this should accept any value
 * that did not pass through here.
 */
export function validateMemoryWriteRequest(
  request: MemoryWriteRequest,
  context: MemoryWriteRequestContext,
): MemoryResult<MemoryEntry> {
  // 1. mode gate.
  if (context.mode === 'off') {
    return invalid('mode_off', 'memory subsystem is off');
  }
  // 2. incognito gate.
  if (context.incognitoActive) {
    return invalid('incognito_active', 'memory writes are blocked while incognito is active');
  }
  // 3. content.
  const content = normalizeMemoryContent(request.content);
  if (!content.ok) return content;
  // 4. scope.
  const scope = normalizeMemoryScope(request.scope);
  if (!scope.ok) return scope;
  // 5. persistence.
  const persistence = normalizeMemoryPersistenceState(request.persistenceState);
  if (!persistence.ok) return persistence;
  // 6. source.
  const source = normalizeMemorySource(request.source);
  if (!source.ok) return source;

  // 7. candidate-cannot-active invariant (xuan `22209a1b` + kenji `fb95a158`).
  if (source.value.kind === 'candidate' && persistence.value === 'active') {
    return invalid(
      'candidate_source_no_active',
      'candidate sources cannot transition directly to active; they must pass through draft / review_required',
    );
  }

  // 8. mode `manual_only` disallows candidate sources.
  if (context.mode === 'manual_only' && source.value.kind === 'candidate') {
    return invalid(
      'mode_disallows_candidate',
      'mode manual_only does not accept candidate sources; switch to manual_with_drafts to enable review queue',
    );
  }

  // 9 + 10 + 11. Durable source path.
  if (source.value.kind === 'memory') {
    if (persistence.value !== 'active') {
      // MemorySource entries must be written as active with confirmedAt.
      // For pending state, use a candidate source instead.
      return invalid(
        'manual_confirm_required',
        'MemorySource entries must be written as active with confirmedAt; use a candidate source for pending state',
      );
    }
    const confirmedAt = request.confirmedAt;
    if (typeof confirmedAt !== 'number' || !Number.isFinite(confirmedAt) || confirmedAt < 0) {
      return invalid(
        'manual_confirm_required',
        'durable active memory entries require a finite non-negative confirmedAt',
      );
    }
    // Renderer-forged provenance defense (gate #9).
    if (context.originatedFromRenderer) {
      return invalid(
        'renderer_provenance_forged',
        'renderer is not allowed to record an active durable entry; main must record confirmation',
      );
    }
    const entry: DurableMemoryEntry = {
      // `id` is intentionally elided here — the store boundary owns id
      // minting. Callers downstream attach `id` before persisting.
      id: '',
      source: source.value.value as MemorySource,
      persistenceState: 'active',
      content: content.value,
      scope: scope.value,
      createdAt: confirmedAt,
      confirmedAt,
      sourceTurnId: request.sourceTurnId,
    };
    return { ok: true, value: entry };
  }

  // Candidate source path — persistence is draft or review_required
  // (checked at step 7 already). Build draft entry.
  const draft: DraftMemoryEntry = {
    id: '',
    source: source.value.value as MemoryCandidateSource,
    persistenceState: persistence.value as 'draft' | 'review_required',
    content: content.value,
    scope: scope.value,
    proposedAt: context.now ?? Date.now(),
  };
  return { ok: true, value: draft };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function invalid<T>(reason: MemoryBlockReason, message: string): MemoryResult<T> {
  return { ok: false, reason, message };
}
