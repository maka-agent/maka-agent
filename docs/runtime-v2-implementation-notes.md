# Runtime v2 implementation notes

Status: Phase 1–4 skeleton landed (compile-safe, tested). The production
`SessionManager.sendMessage` hot path is **unchanged**; the v2 seam exists
in parallel so future work can migrate onto it incrementally.

Source plan: `docs/runtime-v2-architecture-evolution.md`.

## What landed

### Core contract (`@maka/core`)

- `packages/core/src/runtime-event.ts` — the canonical `RuntimeEvent` fact
  model (role / author / status enums, content discriminated union, actions,
  refs, pure helpers `isTerminalRuntimeEvent` /
  `runtimeEventHasModelVisibleContent` / `createRuntimeEventId`).
- `packages/core/src/__tests__/runtime-event.test.ts` — focused contract
  tests.
- New subpath export `@maka/core/runtime-event`, plus a barrel re-export of
  the public surface from `packages/core/src/index.ts`.

### Runtime v2 seam (`@maka/runtime`)

Five new modules, each importable via its canonical subpath AND re-exported
(selectively) from the runtime barrel:

| Module | Subpath | Role |
|---|---|---|
| `runtime-event-adapters.ts` | `@maka/runtime/runtime-event-adapters` | Legacy `StoredMessage` ↔ `RuntimeEvent` bridge (user/assistant/system_note text + thinking; tool/permission/tokenUsage return `null`). |
| `model-history.ts` | `@maka/runtime/model-history` | Policy-driven `buildModelHistoryFromRuntimeEvents()` replacing ad-hoc `StoredMessage` filtering. |
| `invocation-context.ts` | `@maka/runtime/invocation-context` | `InvocationRequest` / `InvocationContext` spine, injectable `newId`/`now` providers, `InvocationResult` envelope. |
| `runtime-runner.ts` | `@maka/runtime/runtime-runner` | `RuntimeRunner.run()` collecting shell: preflight gate → context → user event → flow dispatch → terminal collection. |
| `agent-flow.ts` | `@maka/runtime/agent-flow` | Formal `AgentFlow` / `AgentFlowControl` / `FlowInput` seam. |
| `ai-sdk-flow.ts` | `@maka/runtime/ai-sdk-flow` | `AiSdkFlow` wrapping an `AgentBackend`; `mapSessionEventToRuntimeEvent()` placeholder mapping. |

Each module ships a co-located test suite
(`runtime-event-adapters.test.ts`, `runtime-runner.test.ts`,
`ai-sdk-flow.test.ts`).

### Exports consolidated by the steward

- `packages/core/package.json` — added `"./runtime-event"`.
- `packages/core/src/index.ts` — re-exports the `RuntimeEvent` surface.
- `packages/runtime/package.json` — added six subpath exports.
- `packages/runtime/src/index.ts` — selective barrel re-exports.

## Reconciled: single `InvocationContext` type

`InvocationContext` is now owned by `invocation-context.ts` and reused by the
formal flow seam:

- `invocation-context.ts` — the canonical runner/flow spine (required
  `source`, `startedAt`, `request`, `newId`, `now`).
- `agent-flow.ts` — imports and re-exports that canonical type for the
  `AgentFlow.run(ctx, input)` contract.

The runtime barrel re-exports the canonical `InvocationContext` from
`invocation-context.ts`; the previous duplicate flow-local context has been
removed so runner and flow code share the same identity/provider spine.

## What remains (by phase)

- **Phase 5 — Tool-event actions:** promote `tool_output_delta` /
  `tool_progress` `SessionEvent`s to a dedicated tool-progress runtime
  action (currently partial tool-role heartbeats). Refine
  `mapSessionEventToRuntimeEvent` role/author policy.
- **Phase 6 — RuntimeGate:** implement the real preflight (connection
  readiness/rebind, blocked/running/waiting guards) behind `RuntimeGate`
  and inject it into desktop + bot/gateway entrypoints.
- **Phase 7 — Projection:** drive `StoredMessage` / `TurnRecord` /
  `SessionHeader` / `AgentRunStore` / `RunTrace` / `TelemetryRepo` writes
  from `InvocationResult.events`. Wire
  `buildModelHistoryFromRuntimeEvents()` into the live
  `AiSdkBackend.materializePriorMessages` path.
- **SessionManager delegation:** replace the body of
  `SessionManager.sendMessage` with `RuntimeRunner.run(...)` behind a
  feature flag, mapping `InvocationResult.events` → existing
  `SessionEvent` projection. A streaming `async *stream()` variant may be
  added then if the renderer needs live deltas. Today `RuntimeRunner.run()`
  is **collecting** (returns `Promise<InvocationResult>`), not streaming.
- **`abort` + `complete` coalescing:** `AiSdkFlow` is a faithful translator
  (the backend emits `abort` then a trailing `complete`, and the flow emits
  both). Coalescing into a single terminal event is a runner/projection
  concern.
- **`AgentFlowLike` vs `AgentFlow`:** the runner defines a local
  `AgentFlowLike` (`run(ctx, request)`) that predates the formal
  `AgentFlow` (`run(ctx, input: FlowInput)`). Their second parameters
  differ, so they are not cleanly assignable today. Convergence is a
  SessionManager-delegation task.

## Verification snapshot

All commands run from the repository root (`$RIVE_WORKSPACE`):

```
npm run build                                    # all workspaces — clean
npm run typecheck                                # all workspaces — clean
npm --workspace @maka/core   run test            # 613 pass / 0 fail
npm --workspace @maka/runtime run test           # 384 pass / 0 fail
git diff --check                                 # clean
```

No production source (`session-manager.ts`, `ai-sdk-backend.ts`,
`agent-run.ts`, `materializer.ts`) was modified. The v2 seam is purely
additive.
