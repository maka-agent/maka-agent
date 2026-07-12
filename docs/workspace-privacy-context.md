# Workspace Privacy Context

PR-INCOGNITO-0 is a **contract-only** package. It declares the typed shape any Maka surface MUST consume when checking incognito state. It does NOT add settings UI, storage, IPC, renderer toggles, or runtime enforcement. Downstream lanes (PR-SEARCH-2.5, future MEMORY read gate, PR-VOICE-1) consume this type without re-inventing the flag.

Anchors:

- `notes/pr-search-1-report.md` G3 (incognito gate, deferred to PR-SEARCH-2.5).
- `MemoryWriteRequestContext.incognitoActive` (PR-MEMORY-1 forward-looking field).
- `docs/archive/voice-threat-model-pr-voice-0.md` (historical PR-VOICE-0 rationale for incognito refusal).

Thread anchors: xuan msg `0f1a3a2b` (lane assignment + scope), `ece30c92` (review pre-conditions).

## Authority rules

The contract surface is small precisely because the authority story is strict.

1. **`incognitoActive` source-of-truth is main / session / workspace owner.** Not the renderer.
2. **The renderer can REQUEST or DISPLAY the current context but CANNOT submit a context to prove its state in either direction.** A renderer payload claiming `incognitoActive: false` is just as unauthoritative as one claiming `true`. Incognito is a privacy contract, never a renderer self-attestation.
3. **Default state is `incognitoActive: false`, produced ONLY by `defaultWorkspacePrivacyContext()`.** The validator never invents a default for malformed input — a missing or non-boolean `incognitoActive` is a typed reject, not a silent false. This guards against a regression where an IPC boundary silently accepts a broken payload and proceeds as if the workspace were not incognito.
4. **Future extensions to the shape (e.g. per-session incognito, time-bounded incognito) are explicit contract changes.** Adding a field requires updating this doc, every consumer lane, and the test catalog.

## Shape

```ts
export interface WorkspacePrivacyContext {
  incognitoActive: boolean;
}
```

Today there is exactly one field. The implementation is intentionally minimal so consumers can wire up enforcement without waiting for a richer model.

## Default factory

```ts
export function defaultWorkspacePrivacyContext(): WorkspacePrivacyContext {
  return { incognitoActive: false };
}
```

A fresh workspace, or any path that has not yet resolved an authoritative privacy snapshot, MUST use this factory. Never leave `incognitoActive` undefined; never assume `true` unless main has confirmed.

**Important: `incognitoActive: false` does NOT mean "writes are allowed".** Per kenji msg `64ba21cb`, the default value represents "no privacy mode is currently in effect". Whether a consumer lane allows memory writes, telemetry emission, or search-index appends is still decided by that lane's own policy gate. `WorkspacePrivacyContext` is a *necessary-but-not-sufficient* input to every privacy-sensitive operation:

- MEMORY-1 `validateMemoryWriteRequest` still requires `mode !== 'off'`, `manual_confirm`, etc. The incognito gate is one of many; if `incognitoActive: false` and mode is `'off'`, the write still fails as `mode_off`.
- Future SEARCH index writes still consult their own settings + per-source policy.
- Telemetry still respects per-event opt-outs.

Consumers MUST NOT treat `incognitoActive: false` as a green light. Treat it as "the *incognito* gate did not block; consult my other gates next."

## Validator

```ts
validateWorkspacePrivacyContext(input: unknown): WorkspacePrivacyContextResult
```

Pipeline:

1. typeof object guard (rejects `null`, array, primitive, function).
2. `incognitoActive` typeof boolean guard.
3. Strip extra fields on canonical return.

**The validator does NOT default for missing or non-boolean fields.** A reject reason from `WORKSPACE_PRIVACY_CONTEXT_INVALID_REASONS` is returned. Callers that want a default MUST explicitly call `defaultWorkspacePrivacyContext()`.

## Closed reason enum

```ts
WORKSPACE_PRIVACY_CONTEXT_INVALID_REASONS = ['not_object', 'incognito_active_invalid']
```

Pattern-match-friendly for IPC handler error envelopes. Adding a reason is a contract change.

## Consumer obligations

When a consumer lane reads `WorkspacePrivacyContext`, these are the contracts it MUST honor when `incognitoActive === true`:

### SEARCH (PR-SEARCH-2.5)

- Exclude all sessions / threads / memory entries / activity records from results.
- A query issued during incognito MUST return an empty result set or a typed `disabled` envelope, NOT a partial set with redactions.
- Search index writes (if any future packet adds them) MUST refuse incognito-mode sessions at the write boundary.

### MEMORY (existing forward-looking in PR-MEMORY-1)

- `MemoryWriteRequestContext.incognitoActive` should align to this type. A future cleanup packet may swap the inline field for `WorkspacePrivacyContext`-typed import without changing semantics.
- All writes return `MemoryBlockReason='incognito_active'`.
- Future read paths MUST refuse to return any durable entry.

### VOICE (PR-VOICE-1 deferred)

- Mic capture MUST refuse with `VoiceReadinessReason='incognito_active'` (extend the reason union when wiring).
- An in-flight capture MUST be aborted when the workspace toggles into incognito mid-stream (future runtime concern).
- Transcripts produced just before the toggle MUST NOT be persisted.

### TELEMETRY

- Per-action records MUST NOT be emitted while incognito is active.
- This includes usage logs, error reports, performance probes, and PR-HEALTH-1 runtime probe rows for actions taken during the incognito session.

### LOGS

- Diagnostic emissions during incognito MUST redact session ids and user content.
- Generalized error messages remain acceptable (no provider raw responses).

## Out of scope for PR-INCOGNITO-0

The following are explicitly future work and require separate sign-off:

- Settings UI toggle for entering/leaving incognito.
- Storage representation of incognito mode (per-session flag vs workspace-level flag).
- IPC channels for renderer to subscribe to incognito state changes.
- Runtime enforcement at any consumer lane (those wire in PR-SEARCH-2.5 / future MEMORY / VOICE-1).
- Per-session vs workspace-wide scoping of incognito.
- Time-bounded incognito (auto-exit after N minutes).
- Privacy-mode variants beyond `incognitoActive` (e.g. `screenRecordingPaused`).

## Forbidden surfaces in PR-INCOGNITO-0

Reviewer source-grep MUST NOT find these in the PR:

- `ipcMain.handle` — no IPC handler.
- `BrowserWindow` / renderer imports — no renderer code path.
- `fetch(` / `XMLHttpRequest` — no network.
- Storage repo names (`telemetryRepo`, `connectionStore`, `sessionStore`, etc.) — no persistence.
- `electron` import — no Electron surface.
- Settings shape additions — `AppSettings` is not touched.

## Migration path for consumers

When `PR-INCOGNITO-0` lands, downstream lanes update like this (no behavior change, just type alignment):

- **PR-MEMORY-2** (or follow-up cleanup): change `MemoryWriteRequestContext.incognitoActive: boolean` to import the contract:
  ```ts
  import type { WorkspacePrivacyContext } from './incognito.js';
  // ...
  privacy: WorkspacePrivacyContext;
  // ...consume via context.privacy.incognitoActive
  ```
  Or keep the inline boolean and document the alignment without a code change.

- **PR-SEARCH-2.5**: extend `ThreadSearchDeps` with `getPrivacyContext()`, refuse query when `incognitoActive`.

- **PR-VOICE-1**: capture path consults `WorkspacePrivacyContext` at the IPC boundary; refuse with typed reason.
