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
- Pushed `feat/cu-runtime-helper` to the fork.
- Updated draft PR #699 title/body to remove the obsolete claim that Electron
  `type/key` can succeed in the background.
- Refreshed GitHub CI passed: typecheck, test, and e2e.
- PR merge state is `CLEAN`; Draft status is intentionally preserved.

## 2026-07-12

- Committed the focus-safe refactor as `5024aa00`.
- Fetched latest `origin/main` at `d736901d`.
- Resolved the sole merge conflict in `packages/cli/src/runtime-bootstrap.ts`,
  preserving:
  - GoalManager / goal tools / continuation deps
  - ShellRun update subscriptions and inherited readback
  - `MAKA_CLI_COMPUTER_USE=1` opt-in tool registration
  - shell listener cleanup and cua-driver disposal
- Completed merge commit `675e0395`.
- Installed the latest-main dependency graph (`streamdown`) and rebuilt
  core/runtime/UI before verification.
- Final post-merge verification:
  - full typecheck passed
  - full test suite passed: scripts 7, core 812, storage 206, runtime 1246,
    computer-use 58, headless 776, CLI 248, UI 104, Desktop 2329
  - full build passed
  - cua-driver bundle check passed
  - real-machine E2E passed 25/25
- One pre-merge full-suite run exposed existing short-timeout shell-test
  flakiness under load; isolated runtime and the final full-suite rerun passed.
- Diagnosed the complex 31/36 matrix:
  - button, checkbox, and range were real no-ops
  - right click duplicated `contextmenu`
  - double click succeeded but its absolute assertion was contaminated by the
    earlier single-click failure
- Proved from the v0.7.1 schema and source that
  `page.execute_javascript` discarded exact CDP targeting.
- Forked `trycua/cua`, implemented the root fix, and opened upstream draft
  PR `trycua/cua#2166`.
- Built, ad-hoc signed, and released universal arm64/x86_64
  `cua-driver-rs-v0.7.1-maka.1`.
- Strengthened bundle gates with archive/binary/license/SOURCE hashes, exact
  commits, Cargo.lock, version, architectures, signature, and provenance.
- Implemented exact Electron page targeting, effect-grounded pointer
  verification, strict text-input ownership, page identity reuse, correlated
  traces, and explicit fallback reasons.
- Removed Maka's direct CDP execution path; prepare/read/insert/readback now
  all execute through cua-driver.
- Reworked E2E with read-only target checks, dynamic safe layouts,
  non-overlapping A/B stages, timestamped reports, and repeat aggregation.
- Final focused state:
  - `@maka/computer-use`: 71/71
  - real-machine E2E: 39/39
  - `semantic-targeting-v5`: 10/10 green runs, every semantic case 10/10,
    zero fallback
- Merged latest `origin/main` at `e715e7f8` without conflicts.
- Final post-merge verification:
  - typecheck passed
  - build passed
  - tests passed: scripts 7, core 812, storage 212, runtime 1284
    (2 skipped), computer-use 71, headless 776 (1 skipped), CLI 249,
    UI 105, Desktop 2329
  - cua-driver bundle gate passed
  - real-machine E2E passed 39/39
- Pushed `feat/cu-runtime-helper` through `67a1fe15`.
- Refreshed draft PR #699 title/body with the exact page-targeting architecture,
  `semantic-targeting-v5` evidence, and the remaining production packaging gap.
- Remote CI passed: typecheck, test, and e2e.
