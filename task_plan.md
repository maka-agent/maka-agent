# Codex-Style Background Computer Use Refactor

## Goal

Complete PR #699 by retaining cua-driver as the sole executor while replacing
the desktop-coordinate-first adapter with an app/window-scoped, fresh-snapshot,
AX-first background ladder modeled after Codex/Sky.

## Phases

- [x] Recover the prior Claude Code design and real-machine E2E history.
- [x] Audit current branch, latest main, packaging, capability UI, and live TCC.
- [x] Research Codex/Sky, cua-driver official ladder, macOS transports, and alternatives.
- [x] Record the detailed implementation plan.
- [x] Propagate per-action session/turn context through runtime.
- [x] Preserve cua-driver dispatch evidence and honest failure semantics.
- [x] Add fresh window snapshot and AX element hit-testing.
- [x] Split capture and action clients; permanently disable desktop input on action client.
- [x] Add session/turn target isolation and backend-wide FIFO serialization.
- [x] Implement AX-first pointer dispatch and verified native AX text fill.
- [x] Refuse Electron/unknown text and all key chords before any key event.
- [x] Replace the real-machine E2E fixture with self-owned inactive windows.
- [ ] Integrate latest `origin/main`.
- [ ] Run full repository and real-machine verification.
- [ ] Update and push draft PR #699.

## Constraints

- Preserve user and prior-agent changes.
- Never activate an application as test setup.
- Never auto-escalate to foreground input.
- Never send window-less desktop input.
- Treat driver JSON-RPC success as unverified until evidence says otherwise.
- Push only to the user's fork branch.

## Errors Encountered

| Error | Evidence | Resolution |
| --- | --- | --- |
| Initial `rg --files -g AGENTS.md` returned exit 1 | No `AGENTS.md` exists inside this repository | Used the user-provided global instructions; parent/sibling files are not applicable |
| Latest-main merge preflight returned conflict | `git merge-tree --write-tree HEAD origin/main` conflicts in `packages/cli/src/runtime-bootstrap.ts` | Kept the working tree untouched; conflict must be resolved deliberately before merging |
| `check-cua-driver-bundle` checksum mismatch | Manifest hash is the release tarball hash, while the gate compares it to the extracted Mach-O bytes | Verified the official archive and extracted binary independently; documented the schema/gate defect without changing code |
| Full `npm test` had one voice Settings contract failure | Computer Use capability copy dropped the established product boundary sentence | Kept live backend readiness while restoring the localized “独立权限确认与审计” boundary |
| Runtime test failed with every `@maka/core/*` import missing | Core and runtime workspace tests were incorrectly run in parallel; core test cleans `dist` while runtime compiles | Re-ran dependency-ordered and kept workspace clean/build tests sequential |
| First real E2E click returned AX error `-25206` | Generic indexed Electron AX nodes were treated as AX-clickable even when they did not support `AXPress` | Added a strict clickable-role allowlist; generic/editable nodes use same-snapshot window pixels |
| Electron type returned `key_events`, `verified:false`, `escalation:foreground` and no text landed | Background CGEvent typing depends on live renderer focus; normal user clicks can legally take it away | Removed `type_text`/`press_key` from the backend success path; Electron/unknown text and every key chord now fail before keyboard dispatch |
| Early E2E pointer monitor false positives | Absolute pointer equality could not distinguish normal HID input from synthetic cursor movement | Added a pre-spawn Swift monitor that uses HID event recency and fails only on non-HID pointer jumps or frontmost PID changes |
