# Frontend Architecture Map (2026-07-19)

Maintainer goal: the frontend has grown again since the 2026-07-13 simplification
campaign (#865–#887). Prune redundant/messy code at the architecture level — this time
the bulk sits in the two mega-modules that decomposition has not yet reached (main.ts,
provider-connection-detail.tsx) plus config/CSS rot. Method unchanged: measure first
(knip + wc + grep), stage rounds, gate each on the full suite + typecheck + dead-css +
alignment auditor + CDP spot captures, exit-code gated. Zero behavior change per round.

Baseline (this tip, d48183c2): 84.5K lines TS/TSX (non-test, apps/desktop/src +
packages/ui/src) + 15.1K lines CSS (all in apps/desktop/src/renderer; packages/ui ships
no CSS). Per-area non-test TS/TSX: main 28.4K · renderer 31.6K · ui/src 22.6K ·
preload 1.9K.

Top-10 hotspots (non-test TS/TSX, lines):

| Lines | File | Note |
|------:|------|------|
| 2521 | apps/desktop/src/main/visual-smoke-fixture.ts | **R3 DONE** — split into 689-line registry barrel + 6 `visual-smoke/` domain modules |
| 1871 | apps/desktop/src/main/main.ts | R4/R5/R6 targets (contract re-pins required) |
| 1686 | apps/desktop/src/renderer/app-shell.tsx | R2 target (resume cluster); down from 1733 pre-#887 |
| 1511 | apps/desktop/src/renderer/locales/shell-copy.ts | copy catalog — data, not logic |
| 1502 | apps/desktop/src/main/open-gateway.ts | — |
| 1418 | apps/desktop/src/main/skills.ts | — |
| 1141 | apps/desktop/src/main/explore-agent-tool.ts | — |
| 1114 | apps/desktop/src/preload/preload.ts | bridge surface — mostly declarations |
| 1008 | packages/ui/src/chat-turn.tsx | — |
|  983 | apps/desktop/src/renderer/settings/provider-connection-detail.tsx | R7 target (17 useState) |

CSS top files: maka-tokens 1490 · plan-reminders 824 · onboarding 809 · sidebar 787 ·
skills 691 · chat-detail 656 · mcp 626.

Knip verification notes: the 13 config hints this campaign clears (R1) are ALL
knip-reported redundant/stale config, not code finds — 7 desktop (`overlayscrollbars`
ignoreDependencies now redundant; `src/renderer/**/*.test.ts` matches nothing; 5 entry
patterns auto-detected by knip's vite/storybook/playwright/npm-scripts plugins) + 6 ui
(every explicit entry is already resolved from packages/ui `package.json#exports`). Both
workspaces are exit 0 today; R1 makes them also report ZERO hints. Storybook stories +
`.test.*` entries stay real entries and are not touched.

## Rounds

- [ ] **R1 — knip.json de-rot (this PR).** Clear the 13 config hints without weakening
  coverage: drop the now-redundant `overlayscrollbars` ignoreDependencies entry (the
  overlay-scrollbars contract forbids declaring it as a *desktop dep* — removing a
  redundant *ignore* is compatible; overlayscrollbars is owned by packages/ui), delete
  the dead `src/renderer/**/*.test.ts` entry glob (renderer has zero test files — all 338
  desktop tests live in `src/main/__tests__/*.test.ts`), and drop the 11 redundant entry
  patterns (5 desktop + 6 ui) that knip already auto-detects. Gate: `npx knip --workspace
  apps/desktop` and `packages/ui` both exit 0 AND zero config hints.
- [ ] **R2 — app-shell resume-cluster extraction (this PR, ~−45 lines).** The #1223
  safe-boundary resume cluster: state at app-shell.tsx:268–269
  (`resumePendingSessionId` + `resumeParkDescriptionBySession`) and the
  `resumeInterruptedSession` handler at :894–926. Extract into `use-shell-resume.ts`
  following the use-shell-connections / use-shell-chat-model house style (options object,
  stable identities preserved exactly, pure move, zero behavior change). JSX wiring at
  :1470–1472 (`pending` / `detail` / `onResume`) and the `safeResumeAction=` element stay
  in app-shell. Re-pin runtime-resume-routing-contract.test.ts to read the new hook file
  for the moved assertions (add `use-shell-resume.ts` to renderer-shell-source-helpers
  sourcePaths per the Round B/E precedent). CDP turn-narrative spot capture proves the
  render no-op.
- [x] **R3 — visual-smoke per-domain split behind a barrel (shipped `chore/arch-round-3`).**
  The #1 hotspot `visual-smoke-fixture.ts` (2538 lines at tip 78ac98e0) split into a thin
  registry barrel at the ORIGINAL path (689 lines: `VISUAL_SMOKE_SCENARIOS`,
  `VisualSmokeFixture`, `resolveVisualSmokeFixture`, `getVisualSmokeState`,
  `seedVisualSmokeFixture` — the 4-symbol public surface stays byte-identical for the 3
  non-test consumers) plus 6 per-domain seeder modules under `visual-smoke/`:
  `seed-helpers.ts` (145 — shared spine: `VISUAL_SMOKE_NOW`, session-id constants,
  scenario-set constants, `header`/`writeSession`/`writeJson`), `scenarios-settings.ts`
  (300 — settings/connections/plan-reminders/daily-review), `scenarios-modules.ts` (100 —
  skills-market + MCP), `scenarios-artifacts.ts` (280 — ArtifactPane seed + spec writer),
  `scenarios-chat.ts` (466 — turn/processing/streaming/permission/error + task-ledger +
  live-turn projections), `scenarios-sessions.ts` (672 — long-transcript / workstation-
  statuses / turn-control lineage / long-sidebar / stale). bot-onboarding boundary
  respected (bot-onboarding-visual-smoke.ts untouched). Tests re-pinned via new
  `__tests__/visual-smoke-fixture-source-helpers.ts` aggregator (visible-copy-hygiene +
  placeholder-copy contracts now scan all 7 fixture files); command-palette contract
  needed no change (its assertions target the barrel's scenario set + state switch). Pure
  move: desktop 2744 + ui 196 suites green, 4-tsconfig typecheck + ui typecheck clean,
  check-dead-css clean, knip ×2 exit 0 (zero hints), AUDIT_PORT_BASE=24300 alignment
  auditor exit 0 (all 11 fixtures clean). CDP byte-compare (light-1280-motion):
  module-skills IDENTICAL pre/post (sha256 796e8080…); settings-bots-onboarding is
  inherently nondeterministic at the byte level (4 captures → 4 hashes, ~1426 KB each,
  pre-existing — the onboarding modal renders a live countdown), so the auditor's
  structural walk is the meaningful proof there.
- [ ] **R4 — main.ts tool-assembly extraction (~L648–809). Requires maintainer-approved
  contract re-pin.** The deferred-tool/economy assembly block (riveTools, officeTools, the
  MakaTool catalog filter, webSearchTool, agentTeamChildTools) extracts into a
  tool-assembly module. The main-process-wiring-contract locks `registerIpc` in main.ts
  (function at L1222, invoked L1697); `startup`, `tool-assembly`, and `modelSupportsVision`
  (L964) are direct-pinned to main.ts by contract. Extraction needs the maintainer to
  re-pin those contracts first.
- [ ] **R5 — main.ts settings-runtime-effects + session-stream core splits (~L1360–1642).
  Requires maintainer-approved contract re-pin.** Same direct-pin constraint as R4.
- [ ] **R6 — main.ts startup/lifecycle module (~L1642–1865). Requires maintainer-approved
  contract re-pin.** The post-`registerIpc()` startup/lifecycle tail. Same constraint.
  (main.ts is 1871 lines total; R4–R6 line boundaries are the audit's approximate ranges
  and must be re-verified against the tip at implementation time.)
- [ ] **R7 — provider-connection-detail.tsx controller-hook decomposition.** 983 lines,
  17 useState — the renderer's densest remaining state cluster. Needs its own blade plan
  (which state clusters extract into which controller hooks, which contracts pin the file)
  before any extraction; not a mechanical move like R2.
- [ ] **R8 — CSS raw-hex residue (this PR). VERIFIED CLEAN — no residue on this tip.**
  Audit premise was stale: prose.css + sidebar.css carry NO raw hex/rgb/rgba/hsl color
  literals on d48183c2. The `#618`/`#546`/`#739` matches a naive grep surfaces are all
  GitHub issue references inside comments, not colors; #1085 (`chore(desktop): clean up
  CSS token governance`) already converted the real residue. The only raw hex anywhere in
  renderer CSS is `--brand-wechat: #07c160` in maka-tokens.css — a deliberate fixed
  external-channel brand identity, already documented in-file ("Fixed external channel
  identity; unlike palette-derived Maka accents"), correctly left as a special case.
  Inline byte-math sweep: the shared `formatBytes` (packages/ui/src/tool-activity/
  preview-utils.ts, re-exported through @maka/ui, governed by
  artifact-pane-format-dedup-contract) already owns the canonical B/KB/MB path. Two
  remaining local byte formatters are NOT trivial forks and are left in place: (1)
  `formatPreviewSize` (artifact-preview-registry.ts:315) returns a `未知大小` sentinel and
  an un-rounded `B` branch — a distinct public contract, not formatBytes; (2)
  voice-settings-page.tsx:156 renders an integer-MB cap (`Math.round(bytes/1024/1024) MB`,
  no decimal) inline with a duration — a different display format. The remaining `* 1024`
  hits are size *constants* (payload caps, stream limits), not formatting. Net: R8 needs
  no code change; recorded here for the record.

Update checkboxes as rounds ship. Every round: suite + typecheck + dead-css + alignment
auditor + CDP spot captures, exit-code gated. R4–R6 are gated additionally on
maintainer-approved contract re-pins; R7 needs its own blade plan; R3 is unblocked only
after the concurrent visual-smoke fixture branch lands.
