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
- [ ] **B — app-shell.tsx decomposition (flagship)** — measured: 31 useState + 36 fns
  in 1733 lines; the lower half already consumes extracted hooks, so this finishes a
  half-done decomposition. Blade lines (state-cluster → new hook):
  1. use-shell-navigation: navSelection + settings/search/help overlay state + funnel
     bridge callbacks (L195-266, 668-693)
  2. use-pending-action-registry: ONE generic keyed registry replacing the four
     hand-rolled sets/timers (pendingTurnActions/timers, sessionRowActions,
     permissionModeChanges, sessionModelChanges; L495-553)
  3. use-project-context: appInfo, branchList/pending, recentProjectPaths,
     projectPicker refs (L240-250)
  4. use-module-data: skills, managedSkillSources, bundledSkillCatalog, planReminders
     + refreshers (L229-232)
  5. use-shell-connections: connections/defaultConnection/theme/userLabel/
     defaultPermissionMode (L215-228)
  Preserve PR-FE-BUG-HUNT-0 stable identities; re-pin app-shell-effect-stability
  contracts per move. Target: app-shell.tsx < 900 lines, zero behavior change.
- [x] **C — SHIPPED (refactor/css-token-consolidation): CSS strata consolidation.**
  Census (machine-generated, var() consumers across all CSS+TSX): reference-shell.css
  23 defined → 16 dead (removed), 3 live color-aliases moved to maka-tokens
  (--color-bg-container/--color-border-tertiary/--color-text-quaternary), 4 live
  layout-locals kept in-file (--agents-layout-bg/--agents-content-area-bg/-gap,
  --sidebar-width). theme-glass.css 2 token overrides (darwin --color-bg-container light+dark,
  --color-text-quaternary) relocated to maka-tokens; glass-material + text/label RULES stay.
  maka-tokens.css: added token-authority README (authoritative --background family vs
  compatibility --color-* aliases, alias policy) + condensed the superseded hue-80 archaeology
  (it named deleted tokens). Both themes migrated (light :root + .dark + darwin light/dark).
  NO computed value changed — pure reorg; the shipped `--color-bg-container: var(--background)`
  exception kept as-is. maka-tokens internal 0-consumer tokens are all governance-contract
  scale members (z-index/control-height/spacing/radius/406) — re-pinned, NOT deleted.
  Gates: desktop 2397/2397, ui 125/125, typecheck 0, check-dead-css clean, knip desktop+ui 0,
  auditor exit 0. CDP light+dark captures (turn-narrative/module-skills/settings-general/first-run)
  before/after — no visual diff.
- [x] **D-1 — SHIPPED: shared useMountedRef + last formatBytes fork.** Case-insensitive
  re-census found the mounted-guard boilerplate at ×38 (not ×6 — the first grep missed
  `fooMountedRef` casings). Shipped: `useMountedRef` lives in @maka/ui (exported from
  index) so both workspaces reach it; converted the 6 canonical `mountedRef/
  onboardingMountedRef` sites (OnboardingHero ×2, password-input, daily-review/
  general/permission-center settings pages) and re-pinned 5 contracts to the
  shared-hook form; voice formatVoiceBytes (last formatBytes fork) deleted in favor
  of the @maka/ui helper. Deliberately NOT converted: use-workspace-instructions-
  controller (lifecycle-counter variant, not boilerplate) and app-shell.tsx
  rendererMountedRef (Round B owns that file).
- [ ] **D-2 — mounted-guard long tail**: ~30 remaining `*MountedRef` sites across
  renderer settings pages and packages/ui panels (see `grep -ri "mountedref = useRef"`).
  Mechanical agent sweep: swap to useMountedRef, keep per-site companion-ref cleanup
  effects, re-pin any contract that quotes the old shape. Watch the useRef(false)
  variants — verify no pre-effect reads before flipping initial value semantics.

Update checkboxes as rounds ship. Every round: suite + typecheck + dead-css +
alignment auditor + CDP spot captures, exit-code gated.
