# Documentation archive

Files here are retained for historical context. They are not current contracts, roadmaps, or implementation instructions.

## Frontend

- `design-system-v0.2-wave-10.md` — the former design-system document; retired because stable rules, implementation snapshots, and future PR plans had become inseparable.
- `full-product-test-plan-2026-05.md` — a completed one-month delivery plan.
- `ui-quality-plan-2026-05.md` — a time-sensitive rollout and coverage snapshot.
- `design-refinement-roadmap-2026-07.md` — completed design decisions and an obsolete documentation backlog.

The root `DESIGN.md` owns shared product design intent. `docs/frontend-css-governance.md`, local frontend READMEs, source, and contract tests own implementation rules and executable behavior.

## Audits

- `maka-capability-audit-v1-2026-05.md` — a point-in-time capability and release-gate audit whose frontend authority references are no longer current.

## Former repository notes

Tracked `notes/` files were retired as an undocumented parallel authority. Point-in-time audits, migration plans, reference reverse-engineering, and design research remain here only for provenance. Current rules live in `AGENTS.md`, `ARCHITECTURE.md`, `DESIGN.md`, active cross-cutting contracts, local READMEs, source, and tests.

## Security contract snapshots

- `memory-threat-model-pr-memory-1.md` — the contract-only PR-MEMORY-1 boundary, superseded as a description of the current product.
- `search-service-threat-model-pr-search-0.md` — the PR-SEARCH-0/1.5 boundary, superseded as a description of current search.
- `voice-threat-model-pr-voice-0.md` — the docs/core-only PR-VOICE-0 boundary, superseded as a description of current voice.

## Implementation plans

The dated runtime and sandbox files are completed execution plans. Each file records the pull request that landed its implementation.

`runtime-kernel.md` and `runtime-v2-architecture-evolution.md` preserve the extraction rationale and evolution proposal that led to the current runtime. Current authority starts at `ARCHITECTURE.md`.

`runtime-v2-implementation-notes.md` records the initial Phase 1–4 runtime skeleton and is superseded by the backend architecture chapters and current source.

`agent-runtime-codex-sandbox-alignment.md` and `agent-runtime-codex-sandbox-todo.md` preserve the original sandbox discussion and phased checklist. Stable boundaries now live beside the runtime implementation; remaining work is tracked in issue #843.
