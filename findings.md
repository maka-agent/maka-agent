# Computer Use Findings

## Repository State

- Current branch: `feat/cu-runtime-helper`.
- Tracking branch: `fork/feat/cu-runtime-helper`.
- Latest `origin/main` is `d736901d`; merge commit `675e0395` is complete.
- The feature branch is 34 commits ahead and 0 behind latest `origin/main`.
- The only merge conflict was `packages/cli/src/runtime-bootstrap.ts`; the
  resolution preserves latest-main Goal/shell-run wiring plus opt-in CLI
  Computer Use and cua-driver disposal.
- Existing local WIP must be preserved:
  - seven untracked legacy `scripts/cu-diag-*` / `scripts/cu-keyboard-*` scripts
  - untracked `.claude/` worktree metadata

## Architecture

- `packages/core/src/computer-use.ts` defines normalized actions, typed errors,
  frame limits, and dispatch tiers.
- `packages/runtime/src/computer-use-tools.ts` exposes the model-facing
  `computer` tool, performs per-action TCC checks, maps Anthropic-shaped actions,
  serializes full invocations, emits privacy-safe evidence summaries, and returns
  screenshot image blocks to the model.
- `packages/computer-use` selects and owns the macOS `cua-driver` backend.
- The bundled helper exists at `apps/desktop/resources/bin/cua-driver`, is a
  universal x86_64/arm64 Mach-O, and reports version `0.7.1`.
- Desktop wires the backend by default, compresses large screenshots at native
  resolution, and displays a click-through agent cursor overlay.
- CLI support is opt-in through `MAKA_CLI_COMPUTER_USE=1` and intentionally has
  no overlay.

## 2026-07-11 Architecture Decision

- Keep `cua-driver v0.7.1` as the sole open-source execution engine.
- Do not depend on OpenAI `@oai/sky` or redistribute `SkyComputerUseService`;
  both are proprietary/private distribution components.
- Reproduce the Codex/Sky product architecture above cua-driver:
  - app/window-scoped target identity
  - fresh window snapshot before every action
  - immediate element token consumption
  - AX-first dispatch
  - same-snapshot window-local pixel fallback
  - per-session and per-turn target ownership
  - software cursor separate from the real pointer
  - explicit foreground escalation only; never automatic
- Keyboard is stricter than pointer dispatch:
  - no `type_text`, `press_key`, or foreground delivery is emitted
  - Electron/unknown targets fail before keyboard dispatch
  - native text fill is allowed only for an empty AX-addressable field
  - text uses `set_value`, then a fresh snapshot must read back the exact value
  - key chords remain unsupported because the driver cannot verify them
- Split cua-driver into two isolated children:
  - action child: `capture_scope=window`
  - capture child: `capture_scope=desktop`
  Each child has its own temporary HOME, so desktop scope cannot enable
  window-less input in the action process or mutate user config.
- Strictly unsupported in PR #699: cursor position, split mouse-down/up,
  hold-key, Canvas/raw-HID guarantees, and automatic foreground dispatch.

## Current Capability Shape

- Implemented backend actions: screenshot, click variants, scroll, same-window
  drag, verified native AX text fill, wait, zoom, and overlay-only mouse move.
- Fail-closed behavior: no backend off macOS/missing binary, no click/scroll on
  empty desktop, no cross-window drag, and no keyboard action before a target
  window has been established. Electron/unknown text, non-empty-field overwrite,
  unverified AX writes, and all key chords are refused.
- Actions declared by core but not mapped by the backend fall through to
  `unsupported_action`, including cursor position, mouse down/up, and hold key.
- The model integration is a normal AI SDK function tool named `computer`; image
  results return through `toModelOutput`. The exported Anthropic native-tool type
  and beta-header constants are not wired into provider request construction.

## Verification

- `@maka/computer-use`: 58/58 tests passed.
- Runtime Computer Use focused tests: 18/18 passed.
- Desktop cursor engine/overlay window tests: 11/11 passed.
- Full workspace TypeScript typecheck passed after latest-main dependency rebuild.
- Live backend selection returned `cua-driver` with the `computer` tool.
- Live TCC preflight returned Accessibility=true and Screen Recording=true.
- A live screenshot action succeeded at 1920x1200 PNG, 1,170,441 bytes.
- Real-machine E2E uses two accessory-process BrowserWindows revealed with
  `showInactive()`. It touches no existing app or document and passed 25/25.
- The monitor starts before Electron, samples every 5 ms, holds the original
  frontmost PID invariant, and distinguishes normal HID pointer input from
  synthetic pointer jumps.
- New focused state after refactor:
  - runtime Computer Use tests: 18/18
  - computer-use package: 58/58
  - result normalizer: 8/8
  - E2E safety contract: 5/5
  - real-machine E2E: 25/25
  - Desktop and package typechecks passed
  - cua-driver prepare/check bundle passed twice (second prepare up-to-date)
- Final post-merge repository verification:
  - scripts: 7/7
  - core: 812/812
  - storage: 206/206
  - runtime: 1246/1246, 2 skipped
  - computer-use: 58/58
  - headless: 776/776, 1 skipped
  - CLI: 248/248
  - UI: 104/104
  - Desktop: 2329/2329
  - full build: passed
  - cua-driver bundle check: passed
  - real-machine E2E: 25/25

## Resolved Defects

- Release gate was structurally broken:
  - manifest `sha256` equals the official release tar.gz checksum
    `43a78c...76d4`
  - the extracted, signed Mach-O checksum is `66775d...3dfb0a`
  - fixed by pinning and checking the archive and extracted binary separately
- The frame-cap test title said 2 MB while the source/assertion use 8 MB; corrected.

## Remaining Gaps

- No background-safe implementation exists for cursor position, split
  mouse-down/up, hold-key, Electron/unknown text without an explicit page/CDP
  target, or key chords.
- PR #699 is open as a draft with merge state `CLEAN`.
- The PR title/body reflect the verified focus-safe boundary.
- GitHub CI is green: typecheck, test, and e2e all passed.

## Local WIP Signal

- Legacy diagnostic scripts remain untracked and are intentionally excluded from
  the PR because they contain superseded TextEdit/foreground experiments.

## Focus Root Cause

- Background window-routed pointer events do not require the target to remain
  frontmost and passed real-machine focus/pointer monitoring.
- cua-driver `type_text` can fall back to `path:"key_events"`. That delivery
  depends on the renderer retaining keyboard focus; a normal user click can take
  it away between focus establishment and character delivery.
- This is not fixed by shorter delays, stronger focus restoration, or automatic
  foreground assist. Those approaches either remain racy or visibly interrupt
  the user.
- The root fix is to remove unverifiable key-event delivery from Maka's success
  path. Native AXValue fill is accepted only with fresh readback; all other
  keyboard paths fail closed.

## 2026-07-12 Semantic Electron Extension

- Root cause of the multi-window pointer failures:
  - Maka uniquely resolved the correct Electron CDP page.
  - cua-driver v0.7.1 did not accept `cdp_port` or
    `target_url_contains` for `page.execute_javascript`.
  - Its Electron path could execute on the first page target.
  - A supplied URL hint also silently fell back when absent.
- Root correction:
  - source commit `adef3e87405986cc82df52ae59aef4c32e08a082`
  - upstream proposal `trycua/cua#2166`
  - compatibility release
    `hqhq1025/cua@cua-driver-rs-v0.7.1-maka.1`
  - exact ports, unique URL hints, and checked `1..=65535` port parsing
- cua-driver remains the sole execution engine:
  - Maka only discovers a PID-owned listening CDP port and unique page identity.
  - semantic pointer actions, input preparation/readback, `Input.insertText`,
    and post-action verification are cua-driver `page` tool calls.
  - Maka does not open a CDP WebSocket or execute page JavaScript directly.
- Effect verification:
  - editable click requires target DOM focus
  - checkbox requires checked-state change
  - button/double click requires downstream DOM mutation
  - right click requires a consumed context menu or mutation
  - range drag requires a persistent value after input/change settle
  - an executed semantic action with no observable effect fails closed and is
    never followed by a pixel double-dispatch
- Text ownership:
  - only enabled, writable textarea, contenteditable, and text-like input types
    establish Electron text ownership
  - non-text, disabled, readonly, and sensitive controls do not
  - click and type reuse the same resolved page identity
- Final real-machine evidence (`semantic-targeting-v5`):
  - 10/10 runs green, 39/39 checks each
  - zero fallback, wrong-target, no-op, or duplicate-effect cases
  - p50/p90/max latency:
    - left click: 84/87/102 ms
    - checkbox: 70/77/77 ms
    - range drag: 96/102/127 ms
    - right click: 74/80/85 ms
    - double click: 74/78/98 ms
- Remaining release gap:
  - this repository has no production Electron packaging, Developer ID
    signing, notarization, or post-package app verification workflow
  - the compatibility Mach-O is ad-hoc signed and byte/provenance pinned

## PR Split Decision

- Keep #699 reviewable as a backend-validity PR. Scripted actions are the
  deterministic oracle for transport, targeting, dispatch evidence, and DOM
  effect readback; they are not presented as model-autonomy evidence.
- Move the real Maka model loop into a second PR. That PR must use Maka's
  SessionManager + ai-sdk backend + configured model and report model latency,
  emitted tool arguments, backend latency, display lag, and final state
  separately.
- Move cursor phase reconciliation and path-shape changes into the second PR.
  Backend execution remains immediate; presentation follows backend completion.
- Saved follow-up branch: `codex/cu-model-loop-ux`.
