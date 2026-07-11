# Computer Use Audit Progress

## 2026-07-11

- Inspected branch, remotes, working tree, and repository instruction files.
- Fetched `origin` and `fork`; `origin/main` advanced from `1075b62` to `d07cdf8`.
- Ran `git pull --ff-only`; current feature tracking branch was already current.
- Traced Computer Use code through core contracts, runtime tool wiring, shared
  backend selection, desktop startup/overlay, CLI opt-in, build scripts, and
  local diagnostic scripts.
- Ran a non-mutating synthetic merge against latest `origin/main`; found one
  conflict in `packages/cli/src/runtime-bootstrap.ts`.
- Confirmed the bundled `cua-driver` is present and reports version `0.7.1`.
- Passed focused Computer Use package, core/runtime contract, desktop overlay,
  build, and typecheck verification.
- Confirmed live backend selection, TCC grants, and screenshot capture.
- Reproduced the release checksum failure and proved its root cause by downloading
  the official release archive into a temporary directory:
  archive checksum matches the manifest; extracted binary matches the local binary.
- Checked GitHub PR #699: draft/open, old CI green, current merge state conflicting.
- Audited model wiring and confirmed it uses a custom AI SDK tool rather than the
  exported native Anthropic Computer Use tool type/header.
- Parallel research compared Codex/Sky, cua-driver, macOS AX/CGEvent/SkyLight,
  Peekaboo, BackgroundComputerUse, computer-use-mcp, and rejected foreground or
  browser-only alternatives.
- Wrote the detailed refactor plan:
  `docs/superpowers/plans/2026-07-11-codex-style-background-computer-use-refactor.md`.
- Implemented and verified:
  - runtime session/turn/tool context propagation
  - honest cua-driver path/effect/verification normalization
  - separate action/capture driver children with isolated HOME
  - fresh window snapshot coordinate conversion and AX hit testing
  - backend-wide FIFO plus runtime preflight/run FIFO
  - session/turn target isolation and cleanup generations
  - AX-first click and same-snapshot pixel fallback
  - strict AX-click role allowlist
  - native AXValue text fill with fresh readback
  - pre-dispatch refusal for Electron/unknown text and every key chord
  - foreground-path rejection
  - zoom, packaging dual hashes, capability readiness, cursor tip/pulse geometry
- Resolved read-only review blockers:
  - parallel click/type target race
  - failed click retaining old target
  - pid-scoped resize registry versus per-window lock
  - abort killing another in-flight request
  - structured escalation object loss
  - AX double-click incorrectly routed through `click{count:2}`
  - dispose/start child-spawn race
- Replaced the disruptive TextEdit E2E fixture with two self-owned inactive
  Electron windows and a launcher-level Swift focus/pointer monitor.
- Real-machine E2E findings:
  - pointer actions and overlay stayed background-safe
  - generic Electron AX nodes rejected `AXPress` with `-25206`; fixed via role allowlist
  - Electron `key_events` returned unverified and lost renderer focus under normal
    user interaction; removed from the backend success path
  - final E2E passed 25/25 with both documents untouched after refused keyboard actions
- Verification completed:
  - core: 809/809
  - runtime: 1141/1141, 2 skipped
  - computer-use: 58/58
  - runtime Computer Use focused: 18/18
  - Desktop focused contracts: 23/23
  - E2E safety contract: 5/5
  - real-machine E2E: 25/25
  - cua-driver bundle check: passed
- Remaining current phase:
  - update durable docs and shared memory
  - merge latest `origin/main`
  - run full repository verification after the merge
