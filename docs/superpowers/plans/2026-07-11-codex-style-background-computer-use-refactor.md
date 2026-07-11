# Codex-Style Background Computer Use Refactor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Refactor Maka Computer Use so every host action follows a Codex/Sky-style app/window-scoped, fresh-snapshot, AX-first background ladder while retaining `cua-driver v0.7.1` as the sole execution engine.

**Architecture:** Maka keeps the model-facing `computer` tool and the self-drawn agent cursor, but stops treating the full desktop coordinate stream as the execution authority. Each action resolves a concrete target window, captures a fresh cua-driver window snapshot, uses an immediate element token when possible, and falls back only to the same snapshot's window-local pixels. Target state is isolated by session and turn; foreground escalation and window-less desktop input are forbidden.

**Tech Stack:** TypeScript, Electron 39, Vercel AI SDK, `@maka/core`, `@maka/runtime`, `@maka/computer-use`, `cua-driver-rs v0.7.1`, Node test runner, macOS Accessibility and ScreenCaptureKit.

---

## Product Contract

### Background-Safe Invariants

1. No action may call cua-driver without a concrete `pid + window_id`, except the dedicated capture-only client calling `get_desktop_state`.
2. No action may use `delivery_mode:"foreground"` automatically.
3. No action may move or warp the real system cursor.
4. A text action must be tied to a successful click from the same Maka session and turn.
5. `scroll`, `drag`, and failed clicks do not establish keyboard ownership.
6. Every AX token is consumed immediately after the snapshot that created it.
7. Driver success is not equivalent to UI success. Preserve `path`, `verified`, `effect`, and `escalation`.
8. `effect:"suspected_noop"` is a failure, never a success.
9. `effect:"unverifiable"` is surfaced with `verified:false`; Maka does not repeat the action automatically.
10. A snapshot/action pair for one window is serialized so another snapshot cannot invalidate its tokens mid-action.
11. Session and turn boundaries clear target state.
12. Foreground PID change or a non-HID pointer jump in E2E is a test failure.
13. Background key events are not a supported success path. Native text must
    use AXValue plus fresh readback; Electron/unknown text and all key chords fail closed.

### Explicit Non-Goals For PR #699

- Do not add Anthropic's native provider-defined computer tool.
- Do not depend on or redistribute OpenAI `@oai/sky` or `SkyComputerUseService`.
- Do not implement automatic foreground escalation.
- Do not promise background support for Canvas, WebGL, games, Blender, or raw-HID applications.
- Do not implement a VM lane in this PR.
- Do not reintroduce the removed custom Swift AX helper.

## File Ownership Map

| Responsibility | Files |
| --- | --- |
| Shared action outcome and driver diagnostics | `packages/core/src/computer-use.ts`, `packages/core/src/__tests__/computer-use.test.ts` |
| Runtime context propagation | `packages/runtime/src/computer-use-tools.ts`, `packages/runtime/src/__tests__/computer-use-tools.test.ts` |
| Driver result normalization | `packages/computer-use/src/cua-driver-result.ts`, `packages/computer-use/src/__tests__/cua-driver-result.test.ts` |
| Snapshot and hit-testing | `packages/computer-use/src/cua-driver-snapshot.ts`, `packages/computer-use/src/__tests__/cua-driver-snapshot.test.ts` |
| Transport/client isolation and background ladder | `packages/computer-use/src/cua-driver-backend.ts`, `packages/computer-use/src/__tests__/cua-driver-backend.test.ts` |
| Visual cursor correctness | `apps/desktop/src/renderer/computer-use-overlay/engine/cursor-engine.ts`, `apps/desktop/src/main/__tests__/cursor-engine.test.ts` |
| Safe real-machine verification | `scripts/cu-e2e-full.mjs`, `scripts/cu-e2e-contract.test.mjs`, `package.json` |
| Product capability and packaging | `apps/desktop/src/main/capability-snapshot.ts`, `apps/desktop/src/main/main.ts`, `apps/desktop/bundled-tools.json`, `scripts/prepare-cua-driver.mjs`, `scripts/check-cua-driver-bundle.mjs` |

## Task 1: Add Per-Action Runtime Context

**Files:**
- Modify: `packages/runtime/src/computer-use-tools.ts`
- Modify: `packages/runtime/src/__tests__/computer-use-tools.test.ts`
- Modify: `packages/runtime/src/index.ts`

- [ ] **Step 1: Write the failing context propagation test**

Add a test whose backend records:

```ts
interface CuRunContext {
  sessionId: string;
  turnId: string;
  toolCallId: string;
}
```

and assert:

```ts
assert.deepEqual(seenContext, {
  sessionId: 'session-1',
  turnId: 'turn-1',
  toolCallId: 'tool-1',
});
```

- [ ] **Step 2: Verify the test fails**

Run:

```bash
npm --workspace @maka/core run build
npm --workspace @maka/runtime run test
```

Expected: FAIL because `CuDispatchBackend.run` receives no context.

- [ ] **Step 3: Add the context type and signature**

Use:

```ts
export interface CuRunContext {
  sessionId: string;
  turnId: string;
  toolCallId: string;
}

export interface CuDispatchBackend {
  preflight(signal: AbortSignal): Promise<{ accessibility: boolean; screenRecording: boolean }>;
  run(action: CuAction, signal: AbortSignal, context: CuRunContext): Promise<CuRunResult>;
}
```

Pass the context from the Maka tool implementation:

```ts
const result = await deps.backend.run(action, abortSignal, {
  sessionId,
  turnId,
  toolCallId,
});
```

- [ ] **Step 4: Re-run runtime tests**

Expected: all runtime Computer Use tests pass.

## Task 2: Preserve Cua-Driver Result Semantics

**Files:**
- Modify: `packages/core/src/computer-use.ts`
- Modify: `packages/core/src/__tests__/computer-use.test.ts`
- Create: `packages/computer-use/src/cua-driver-result.ts`
- Create: `packages/computer-use/src/__tests__/cua-driver-result.test.ts`
- Modify: `packages/computer-use/src/index.ts`

- [ ] **Step 1: Define generic dispatch evidence**

Add:

```ts
export const COMPUTER_USE_EFFECTS = ['confirmed', 'unverifiable', 'suspected_noop'] as const;
export type ComputerUseEffect = typeof COMPUTER_USE_EFFECTS[number];

export interface ComputerUseDispatchEvidence {
  path?: string;
  effect?: ComputerUseEffect;
  escalation?: string;
}
```

Add optional `evidence?: ComputerUseDispatchEvidence` to both outcome branches.

- [ ] **Step 2: Write failing normalization tests**

Test these driver payloads:

```ts
{ path: 'ax', verified: true, effect: 'confirmed' }
{ path: 'cgevent', verified: false, effect: 'unverifiable', escalation: 'foreground' }
{ path: 'ax', verified: false, effect: 'suspected_noop', escalation: 'px' }
{ path: 'cgevent_fg', verified: false, effect: 'unverifiable' }
```

Expected normalized behavior:

```ts
ax + confirmed        -> ok:true, tier:'ax', verified:true
cgevent + unverifiable -> ok:true, tier:'coordinate-background', verified:false
suspected_noop         -> ok:false, error:'capture_failed'
*_fg                   -> ok:true, tier:'foreground-visible'
```

- [ ] **Step 3: Implement `normalizeCuaDriverOutcome`**

The helper must:

```ts
export function normalizeCuaDriverOutcome(
  result: JsonRpcToolResult | undefined,
): ComputerUseActionOutcome
```

It must preserve evidence and redact nothing; redaction remains the runtime chokepoint.

- [ ] **Step 4: Run core and computer-use tests**

Expected: all tests pass with explicit tier/effect coverage.

## Task 3: Extract Fresh Snapshot And Hit Testing

**Files:**
- Create: `packages/computer-use/src/cua-driver-snapshot.ts`
- Create: `packages/computer-use/src/__tests__/cua-driver-snapshot.test.ts`
- Modify: `packages/computer-use/src/index.ts`

- [ ] **Step 1: Define snapshot types**

```ts
export interface CuaResolvedWindow {
  pid: number;
  windowId: number;
  bounds: { x: number; y: number; width: number; height: number };
  screenPoint: { x: number; y: number };
}

export interface CuaWindowSnapshot {
  target: CuaResolvedWindow;
  screenshotWidthPx: number;
  screenshotHeightPx: number;
  windowPointPx: { x: number; y: number };
  elements: CuaSnapshotElement[];
}
```

- [ ] **Step 2: Write coordinate-space tests**

Cover:

- Retina device coordinate to logical screen point.
- Window-local screenshot coordinate derived from snapshot dimensions, not desktop scale.
- Smallest/deepest containing AX element wins.
- A stale or malformed frame is ignored.
- Editable role detection includes `AXTextArea`, `AXTextField`, `AXSearchField`, `AXComboBox`, `AXWebArea` descendants only when driver marks them editable.

- [ ] **Step 3: Implement pure helpers**

Required functions:

```ts
resolveWindowAtDeclaredPoint(...)
windowPointFromSnapshot(...)
elementAtScreenPoint(...)
editableElementAtScreenPoint(...)
```

No child-process code belongs in this module.

- [ ] **Step 4: Run snapshot tests**

Expected: pure tests pass without Electron or a real driver.

## Task 4: Isolate Action And Desktop-Capture Clients

**Files:**
- Modify: `packages/computer-use/src/cua-driver-backend.ts`
- Modify: `packages/computer-use/src/__tests__/cua-driver-backend.test.ts`

- [ ] **Step 1: Write a failing two-client handshake test**

Assert two child processes:

```text
action client  -> capture_scope=window
capture client -> capture_scope=desktop
```

Each child must have a distinct temporary `HOME`.

- [ ] **Step 2: Verify the current single-client implementation fails**

Expected: one child exists and persists desktop scope globally.

- [ ] **Step 3: Add client role options**

```ts
type CuaClientRole = 'action' | 'capture';

interface CuaDriverClientOptions extends CuaDriverBackendOptions {
  role: CuaClientRole;
  homeDir: string;
  captureScope: 'window' | 'desktop';
}
```

Spawn with:

```ts
env: {
  ...process.env,
  HOME: opts.homeDir,
}
```

- [ ] **Step 4: Route calls**

```text
capture client: check_permissions, get_desktop_state
action client: list_windows, get_window_state, click, scroll, drag, zoom, type_text, press_key
```

No action call may reach the desktop client.

- [ ] **Step 5: Dispose both clients and delete temporary homes**

Use synchronous teardown only at backend disposal so app quit remains deterministic.

## Task 5: Add Session And Turn Target Isolation

**Files:**
- Modify: `packages/computer-use/src/cua-driver-backend.ts`
- Modify: `packages/computer-use/src/__tests__/cua-driver-backend.test.ts`

- [ ] **Step 1: Write cross-session and cross-turn failure tests**

Verify:

```text
session A click -> session B type = refused
turn 1 click    -> turn 2 type    = refused
failed click    -> same-turn type = refused
scroll/drag     -> type           = refused
```

- [ ] **Step 2: Replace global `lastTarget`**

Use:

```ts
interface SessionTargetState {
  turnId: string;
  target: CuaResolvedWindow;
}

const targetsBySession = new Map<string, SessionTargetState>();
```

- [ ] **Step 3: Establish ownership only after successful click**

Do not update target state before outcome normalization.

- [ ] **Step 4: Clear stale state**

When `context.turnId` differs, delete the old target before processing the action.

## Task 6: Implement AX-First Click And Keyboard Ladder

**Files:**
- Modify: `packages/computer-use/src/cua-driver-backend.ts`
- Modify: `packages/computer-use/src/__tests__/cua-driver-backend.test.ts`
- Use: `packages/computer-use/src/cua-driver-snapshot.ts`
- Use: `packages/computer-use/src/cua-driver-result.ts`

- [ ] **Step 1: Write AX-first click tests**

Verify:

```text
fresh get_window_state
element_token click when element contains point
pixel click from same snapshot when no element
no automatic retry after suspected_noop/unverifiable
```

- [x] **Step 2: Write verified text-fill tests**

Verify:

```text
native editable token -> set_value(element_token) -> fresh readback
Electron/unknown process -> fail before dispatch
no editable token -> fail before dispatch
key chord -> fail before dispatch
type_text/press_key are never emitted
```

- [x] **Step 3: Serialize the full backend and runtime invocation**

Use a promise-chain lock:

```ts
runtime invocation FIFO: preflight -> overlay -> backend.run
backend FIFO: target read -> snapshot -> action -> target update
```

The critical section covers fresh snapshot through action response.

- [x] **Step 4: Implement click ladder**

Order:

```text
resolve window
fresh get_window_state(include_screenshot=true)
element_token click if available
otherwise same-snapshot pixel click
normalize driver result
set session target only on accepted click result
```

- [x] **Step 5: Implement verified native text fill**

Order:

```text
load session target
classify target process
require native + editable + empty AX field
set_value with fresh element token
fresh get_window_state
accept only exact AXValue readback
```

- [x] **Step 6: Keep foreground escalation unavailable**

If driver recommends `foreground`, label it disallowed and fail. Do not execute it.

## Task 7: Complete Safe Action Coverage

**Files:**
- Modify: `packages/computer-use/src/cua-driver-backend.ts`
- Modify: `packages/computer-use/src/__tests__/cua-driver-backend.test.ts`

- [x] **Step 1: Preserve zoom**

Zoom must use one concrete window and return JPEG through the screenshot result channel.

- [x] **Step 2: Keep unsupported actions honest**

Continue rejecting:

```text
cursor_position
left_mouse_down
left_mouse_up
hold_key
key
Electron/unknown type without an explicit page/CDP integration
```

Reason: cua-driver v0.7.1 has no strict no-focus/no-warp primitive matching those normalized actions.

- [x] **Step 3: Ensure scroll and drag do not establish keyboard target**

Add explicit tests.

## Task 8: Fix Agent Cursor Target Geometry

**Files:**
- Modify: `apps/desktop/src/renderer/computer-use-overlay/engine/cursor-engine.ts`
- Modify: `apps/desktop/src/main/__tests__/cursor-engine.test.ts`

- [x] **Step 1: Keep current motion fixes**

Retain:

```text
scaled turn radius
target-facing departure heading
spring snap before a new path
C=38
overshoot=0.15
```

- [x] **Step 2: Align arrow tip and pulse**

Use the arrow's actual 14px tip geometry and draw the pulse at the action coordinate, not the cursor-body center.

- [x] **Step 3: Run cursor tests and overlay build**

```bash
npm --workspace @maka/desktop run build:main
npm --workspace @maka/desktop exec -- node --test "dist/main/__tests__/cursor-engine.test.js"
npm --workspace @maka/desktop run build:overlay
```

## Task 9: Replace The Real-Machine E2E Fixture

**Files:**
- Modify: `scripts/cu-e2e-full.mjs`
- Modify: `scripts/cu-e2e-contract.test.mjs`
- Modify: `package.json`

- [x] **Step 1: Remove all foreground fixture actions**

The script must not contain:

```text
activate
app.focus
pkill
close every document
Notes
```

- [x] **Step 2: Create self-owned inactive target windows**

Use two `BrowserWindow` fixtures owned by an accessory Electron process and
reveal them with `showInactive()`. Do not use LaunchServices, TextEdit, or
pre-existing application windows.

- [x] **Step 3: Add pre-spawn foreground and pointer monitoring**

Sample every 5ms during each action:

```text
frontmost PID
NSEvent.mouseLocation
CGEventSource HID event recency
```

Fail if:

```text
frontmost PID changes
non-HID pointer jump exceeds 4px
```

- [x] **Step 4: Verify target isolation and keyboard refusal**

Two separate inactive Electron windows:

```text
pointer actions target the declared window
Electron type/key is refused before keyboard dispatch
both input fields remain untouched
foreground app remains the user's original app
```

- [x] **Step 5: Teardown only fixture windows**

Destroy only the two BrowserWindows and Maka overlay.

## Task 10: Keep Product And Packaging State Truthful

**Files:**
- Modify: `apps/desktop/src/main/capability-snapshot.ts`
- Modify: `apps/desktop/src/main/main.ts`
- Modify: `apps/desktop/src/main/__tests__/computer-use-capability.test.ts`
- Modify: `apps/desktop/bundled-tools.json`
- Modify: `scripts/prepare-cua-driver.mjs`
- Modify: `scripts/check-cua-driver-bundle.mjs`
- Modify: `apps/desktop/src/main/__tests__/build-hygiene-contract.test.ts`

- [x] **Step 1: Keep separate archive and binary hashes**

```json
{
  "archiveSha256": "43a78c...",
  "binarySha256": "66775d..."
}
```

- [x] **Step 2: Report live backend readiness**

The capability must no longer say “当前不可执行” when `backendId === "cua-driver"`.

- [x] **Step 3: Run release bundle checks**

```bash
npm run prepare:cua-driver
npm run check:cua-driver-bundle
```

Expected: both pass and a second prepare is up-to-date.

## Task 11: Merge Latest Main And Verify PR #699

**Files:**
- Resolve: `packages/cli/src/runtime-bootstrap.ts`
- Resolve any additional latest-main conflicts.

- [x] **Step 1: Preserve the dirty worktree**

Commit the completed CUA refactor before merging.

- [x] **Step 2: Merge `origin/main`**

```bash
git fetch origin
git merge origin/main
```

For `runtime-bootstrap.ts`, preserve both:

```text
latest main shell-run subscriptions/readback
MAKA_CLI_COMPUTER_USE opt-in backend wiring and disposal
```

- [x] **Step 3: Run focused verification**

```bash
npm run test:scripts
npm --workspace @maka/core test
npm --workspace @maka/runtime test
npm --workspace @maka/computer-use test
npm --workspace @maka/desktop run typecheck
npm --workspace @maka/desktop test
npm run check:cua-driver-bundle
npm run e2e:computer-use
```

- [x] **Step 4: Run repository verification**

```bash
npm run typecheck
npm test
npm run build
```

- [ ] **Step 5: Update draft PR**

Push only to `fork/feat/cu-runtime-helper`. Update PR #699 with:

```text
Sky/Codex-inspired app/window-scoped architecture
fresh snapshot + immediate element token
AX-first and same-snapshot pixel fallback
session/turn isolation
honest driver evidence
no automatic foreground escalation
real focus/pointer E2E
```

## Parallel Execution Groups

### Group A: Safe To Run In Parallel

1. Runtime context propagation.
2. Core outcome evidence + result normalizer.
3. Safe E2E fixture and focus/pointer monitor.
4. Product capability and packaging verification.

### Group B: Local Critical Path

1. Snapshot helper design.
2. Two-client transport isolation.
3. Session/turn target state.
4. AX-first click and keyboard ladder.
5. Integration and conflict resolution.

### Merge Order

```text
runtime context
→ core result evidence
→ snapshot helpers
→ two-client backend
→ session isolation
→ AX-first ladder
→ visual cursor
→ E2E
→ latest main merge
→ full verification
```

## Plan Self-Review

- Spec coverage: Codex/Sky architecture, cua-driver official ladder, strict background boundary, packaging, capability UI, and E2E are represented.
- Placeholder scan: no deferred implementation placeholders remain inside PR #699 scope.
- Type consistency: `CuRunContext`, `ComputerUseDispatchEvidence`, `CuaResolvedWindow`, and `CuaWindowSnapshot` have one canonical definition each.
- Scope: VM and automatic foreground escalation remain explicitly outside this PR.
