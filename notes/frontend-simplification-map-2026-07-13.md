# Frontend Simplification Map (2026-07-13)

Maintainer goal: the project has run long; prune redundant/messy frontend code at
architecture level. Method: measure first (knip + wc + grep), stage rounds, gate each
on the full suite + typecheck + dead-css + alignment auditor.

Baseline (this tip, 1301404d): 45.5K lines TS/TSX (non-test) + 22.0K lines CSS.
Hotspots: app-shell.tsx 1733 · chat-turn 970 · bot-chat 961 · OnboardingHero 955 ·
provider-oauth 870 · composer 866 · plan-reminder 865 · connection-detail 861.
CSS: maka-tokens 1509 · onboarding 916 · plan-reminders 864 · skills 833.

Knip verification notes: storybook stories + ui .test.tsx flagged "unused" are FALSE
positives (apps/desktop/.storybook globs both story roots; ui test runner executes
dist/**/*.test.js). Real finds verified by hand before acting.

## Rounds

- [x] **A — SHIPPED (b2a1afd6): knip governance + dead code + dep hygiene.** 6 symbols deleted, 1 demoted, dev-hmr.mjs removed; @base-ui/react→deps, streamdown→devDeps (test-only; deviation on correctness), overlayscrollbars NOT declared (overlay-scrollbars contract forbids it — knip ignoreDependencies instead); scroll-area.tsx retained (a contract reads its content — follow-up: remove file+test together); knip.json (entries per workspace, ignoreExportsUsedInFile, -knipignore tag) + 2 CI steps in the typecheck job; ignore reasons documented below. Gates: desktop 2397/2397, ui 125/125, typecheck, 4 static checks, auditor — all identical before/after.
  - Delete packages/ui/src/primitives/scroll-area.tsx (orphaned by overlay-scroll-area)
  - ~40 unused exports/types across desktop main+renderer and packages/ui — for each:
    grep __tests__ first (contract tests read source text; some pins assert the export
    form) — demote `export` or delete the symbol per-site, never break a pin silently
  - Declare real deps: apps/desktop needs streamdown, @base-ui/react, overlayscrollbars
    (currently resolving via hoisting — fragile)
  - Add knip.json (workspaces, storybook entry globs, test entry globs) + CI step so
    dead code cannot re-accumulate
- [~] **B — app-shell.tsx decomposition (flagship) — 4/5 blades SHIPPED (branch
  refactor/app-shell-decomposition), 1733 → 1666 lines, zero behavior change.**
  Gates identical each commit: desktop 2397/2397, ui 125/125, typecheck, dead-css,
  knip (desktop+ui); final alignment auditor (AUDIT_PORT_BASE=19300) clean on all 9
  fixtures + branch-vs-baseline CDP pixel captures identical (turn-narrative,
  module-skills, settings-general).
  1. use-pending-action-registry — SHIPPED first (only blade that removes dup). ONE
     generic useKeyedPendingRegistry replaces the four hand-rolled keyed sets
     (turnActions state+timers, sessionRow, permissionMode, sessionModel). keysRef
     stays a stable Set so factories + unmount cleanup are byte-identical. Re-pinned
     sticky-model / status-presentation / row-actions-fail-soft contracts.
  3. use-project-context — SHIPPED. appInfo, branchList/pending, recentProjectPaths,
     projectPicker pending+refs + createAppShellProjectActions wiring.
  4. use-module-data — SHIPPED. skills/managedSkillSources/bundledSkillCatalog/
     planReminders + both skill/plan action factories; surface-active predicates
     injected.
  5. use-shell-connections — SHIPPED (partial). connections/defaultConnection +
     connectionsEqual + refreshConnections + handleConnectionEvent. theme/userLabel/
     defaultPermissionMode stayed: default-permission-mode contract pins the
     defaultPermissionMode useState + refreshShellSettings + closeSettings mirror to
     app-shell.tsx specifically, and the theme setters have multiple app-shell writers
     (visual-smoke, settings-overlay onChange) — moving them needs setter injection
     with no net simplification.
  2. use-shell-navigation — SKIPPED (disproportionately risky, per the "ship what's
     done" rule). Its two anchors — openSessionInChat and closeSettings — are pinned
     to app-shell.tsx by source-slice contracts, so they cannot move. Its highest-value
     movable code (the stable bridge callbacks searchModalOnNavigate /
     paletteOnSelectSession / paletteOnOpenSearchModal / useSkillInChat) carries
     PR-FE-BUG-HUNT-0 runtime identity-stability semantics that have ZERO source-pin or
     e2e coverage — a subtle extraction error would silently regress search-during-
     stream with no gate to catch it. A state-only move nets ≈0 app-shell lines because
     every setter (setNavSelection ×15 sites, setSearchScrollTarget via the pinned
     openSessionInChat/createSession, setSettingsOpen via the pinned closeSettings) must
     be threaded straight back out. Left in place with this note.
  Note: the map's < 900 target is not reachable through the five state-cluster blades
  alone — app-shell's bulk is the derived-value block (~210 lines of model/thinking/
  alert memos) and the JSX return (~340 lines), neither of which the blade definitions
  cover; reaching < 900 would require extracting those + splitting the JSX into
  sub-components (out of scope, separate risk).
- [ ] **C — CSS strata consolidation** — maka-tokens.css 1509 lines carries historical
  strata (hue-80 era comments, reference-shell.css + theme-glass.css parallel token
  systems: --color-bg-* vs --background families). Merge the glass/reference layers'
  live tokens into maka-tokens, delete dead strata, one token README header.
- [ ] **D — duplicate helper sweep (measured SMALL — the convergence campaign paid
  off)** — real dups found: formatBytes ×3 (artifact-preview-registry.ts:317,
  tool-activity/preview-utils.ts:14, voice formatVoiceBytes) → one shared util;
  mountedRef boilerplate ×6 → useMountedRef. Domain formatters are all distinct —
  no action.

Update checkboxes as rounds ship. Every round: suite + typecheck + dead-css +
alignment auditor + CDP spot captures, exit-code gated.
