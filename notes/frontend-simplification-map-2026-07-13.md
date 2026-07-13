# Frontend simplification map — 2026-07-13

Living map for the frontend dead-code / dependency / config cleanup campaign.
Gate on suite exit codes (desktop, `@maka/ui`, full `npm run typecheck`) plus
`check-dead-css` / `check-console` / `check-a11y` / `check-copy` and
`AUDIT_PORT_BASE=19100 node scripts/audit-alignment.mjs`. No behavior changes:
pure dead-code / deps / config only.

## Round A — safe deletions + dependency hygiene + knip governance — [x] DONE

Summary: introduced `knip.json` (entry points + reasoned ignores) so
`npx knip --workspace apps/desktop` and `--workspace packages/ui` both exit 0;
added the missing direct deps desktop actually imports; deleted the truly-dead
exports/files and demoted/tagged the rest per the rules. Test totals unchanged:
desktop 2397/2397, `@maka/ui` 125/125, full typecheck clean, all check scripts
+ alignment audit clean. knip added to CI (typecheck job).

### Per-symbol action table

| Symbol | File | Action | Reason |
|---|---|---|---|
| `localMemoryDirForWorkspace` | main/local-memory-service.ts | delete | truly dead (0 refs incl. tests) |
| `bundledOfficeCliToolsDir` | main/officecli-env.ts | delete | truly dead; sibling `bundledOfficeCliToolsDirs` still used |
| `droppedTextFilePreflightFailureCopy` | renderer/app-shell-copy.ts | delete | truly dead |
| `blockedStateLabel` | renderer/use-thread-search.ts | delete | truly dead |
| `blockedStateHint` | renderer/use-thread-search.ts | delete | truly dead |
| `OpenPathResult` (type) | renderer/open-path.ts | delete | dead duplicate; main side owns its own `OpenPathResult` in open-path-guard.ts |
| `formatBuiltinJsonResult` | ui tool-activity/builtin-preview.ts | delete | `@deprecated` wrapper; `formatQuietJsonValue` has other callers |
| `planReminderDisplayRows` | ui plan-reminder-helpers.ts | demote (`export`→ file-local) | no external consumer; demote keeps its sibling display helpers "used-in-file" so knip stays green with no cascade delete |
| `cleanErrorMessage` | renderer/model-connection-errors.ts | keep + `@knipignore` | no live call site by design; ~10 fail-soft contract tests `assert.doesNotMatch` on `cleanErrorMessage(error)` in visible toasts, so it is referenced by name across the suite |
| `buildExploreAgentCopyPayloads` | ui tool-activity/agent-preview.tsx | keep + `@knipignore` | consumed via dynamic `await import(uiModuleUrl)` in tool-activity-result-preview-contract.test.ts; knip can't trace the runtime URL |
| ~34 desktop + ~8 ui exports "used in own file" | various | retained via `ignoreExportsUsedInFile: true` | precise config lever = the maintainer's "used only within its own file → keep the symbol" bucket, applied without 40+ risky keyword edits |
| re-export facades (codex/cursor/antigravity oauth, command-palette, etc.) + IPC-mirror types (global.d.ts/preload.ts) + contract-pinned exports (`STATUS`, `safeSendToRenderer`, `providerDisplay`, …) | various | left as-is; resolved by entry points + `ignoreExportsUsedInFile` | all are consumed via their canonical path or pinned by `/export .../` contract asserts; entry-point config makes knip trace them correctly |

### Files deleted
- `apps/desktop/scripts/dev-hmr.mjs` — orphaned launcher superseded by
  `scripts/dev.mjs` (its own header says it runs inside the `dev:hmr` npm
  script, but `dev:hmr` now points at `dev.mjs`; commit b784226b). Zero refs.

### SKIPPED deletions (with reason)
- **`packages/ui/src/primitives/scroll-area.tsx` — NOT deleted.** Zero
  production imports, but `apps/desktop/src/main/__tests__/overlay-scrollbars-contract.test.ts`
  (the "backs shared primitive ScrollArea" case) `readFile`s this exact path
  and asserts its content. Deleting it breaks test coverage (prohibited).
  Resolved for knip via a scoped `ignore` (see below). Candidate for a later
  behavior-review round that removes file + that one `it()` together.

### Dependencies added (desktop)
- `@base-ui/react: ^1.5.0` → **dependencies** — imported by production renderer
  (`command-palette.tsx`, `settings/provider-config-sheet.tsx`).
- `streamdown: ^2.5.0` → **devDependencies** — only `streamdown-markdown-contract.test.ts`
  imports the runtime package; `@maka/ui` owns the production usage. Classified
  as test-only (deviation from the "add to dependencies" instruction, on
  correctness grounds).
- **`overlayscrollbars` — deliberately NOT added** (deviation from the Round A
  brief). `overlay-scrollbars-contract.test.ts` asserts
  `desktopPackage.dependencies.overlayscrollbars === undefined` ("desktop should
  consume the @maka/ui primitive, not own a second direct dependency"). Adding
  it breaks that contract. Desktop only `@import`s the vendor CSS, so it is
  handled via `ignoreDependencies` instead.
- `knip: ^6.26.0` → root **devDependencies** (pins the governance tool for CI).

### knip config summary (`knip.json` — reasons here because JSON has no comments)
- `ignoreExportsUsedInFile: true` — keeps exports consumed within their own file
  (the "demote/keep" bucket) out of the report.
- `tags: ["-knipignore"]` — lets a `/** @knipignore … */` JSDoc tag suppress a
  single export with its reason inline (used on `cleanErrorMessage`,
  `buildExploreAgentCopyPayloads`).
- **apps/desktop**
  - `entry`: `src/main/main.ts`, `src/preload/preload.ts`,
    `src/renderer/main.tsx`, `src/main/**/*.test.ts`,
    `src/renderer/**/*.test.ts`, `e2e/**/*.spec.ts` + `e2e/playwright.config.ts`,
    `.storybook/main.ts` (+ preview), `stories/**`, `scripts/dev.mjs`,
    `scripts/browser-observe-act-smoke.mjs` (used by `smoke:browser`).
  - `ignoreDependencies`: `overlayscrollbars`, `@fontsource-variable/geist`,
    `@fontsource-variable/geist-mono` — all loaded via renderer CSS `@import`,
    which knip does not parse (overlayscrollbars is additionally contract-owned
    by `@maka/ui`).
  - `ignoreBinaries`: `taskkill` — Windows-only branch inside `scripts/dev.mjs`.
- **packages/ui**
  - `entry`: `src/index.ts`, `src/icons.tsx`, and the four subpath-export
    sources (`artifact-preview-registry.ts`, `assistant-stream.ts`,
    `maka-uri.ts`, `smooth-stream.ts`), `src/**/*.test.ts(x)`, `stories/**`.
  - `ignoreDependencies`: `@storybook/react-vite` — ui stories are built by
    `apps/desktop/.storybook`, which owns the storybook toolchain.
  - `ignore`: `src/primitives/scroll-area.tsx` — contract-retained (see SKIPPED
    above).

### CI
Added two steps to the `typecheck` job in `.github/workflows/ci.yml` (after
`npm run typecheck`, so the build exists): `npx knip --workspace apps/desktop`
and `npx knip --workspace packages/ui`. Both must stay at zero findings.

### Test totals (before → after, identical)
- desktop: 2397 pass / 0 fail → 2397 / 0
- `@maka/ui`: 125 pass / 0 fail → 125 / 0
- full `npm run typecheck`: clean → clean
- check-dead-css / check-console / check-a11y / check-copy: clean
- `AUDIT_PORT_BASE=19100 audit-alignment.mjs`: all fixtures clean
