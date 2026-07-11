# Renderer (`apps/desktop/src/renderer`)

The Electron renderer process: the React UI body of the Maka desktop app. React + Vite + Tailwind v4, consuming `@maka/ui` primitives. This is the **frontend governance hot zone** — most of the hand-rolled CSS and primitive-override transitional debt lives here.

For the main/preload/renderer split and the IPC contract, see `apps/desktop/README.md`. This file covers the renderer interior.

## Entry

`main.tsx` → `app.tsx` → `AppShell` (`app-shell.tsx`). `index.html` is the Vite HTML shell. `main.tsx` prefetches the onboarding snapshot before mounting React so the first commit paints the real surface (no loading flash); `app.tsx` wraps `AppShell` in `ToastProvider` + `ErrorBoundary`.

`styles.css` is the **only** style entry: it `@import`s Tailwind, fonts, `maka-tokens.css`, `reference-shell.css`, and every `styles/*.css`. Per CSS governance, `styles.css` may only contain `@import` / `@source` / `@theme` / top-level orchestration — real selector rules go in `styles/*.css`.

## AppShell + the action modules

`app-shell.tsx` is the shell component: owns session state, wires the `@maka/ui` panels (SessionListPanel, ChatView, Composer, ToolActivity), and mounts lazy panels (ArtifactPane, BrowserPanel). It is supported by a set of `app-shell-<scope>-<action>.ts(x)` modules, each a narrow slice of shell logic split by concern:

| Prefix | Concern |
|---|---|
| `app-shell-session-*` | session list / row / settings / UI-state / events |
| `app-shell-chat-actions`, `app-shell-turn-*` | send / stop / regenerate, turn view-model |
| `app-shell-plan-*`, `app-shell-daily-review-*`, `app-shell-skill-*` | module panes |
| `app-shell-project-*` | project / workspace selection |
| `app-shell-command-actions`, `app-shell-quick-chat-actions` | command palette, quick chat |
| `app-shell-effects` | the effect / `effectEvent` wiring |
| `app-shell-overlays`, `app-shell-chrome-actions`, `app-shell-layout-actions` | overlays, window chrome, layout |
| `app-shell-visual-smoke`, `app-shell-pending-attachments`, `app-shell-copy` | fixture capture, attachments, clipboard |

Naming convention for a new slice: `app-shell-<scope>-<action>.ts`. Keep a slice to one concern; if it grows, split along the same `app-shell-<scope>-<action>` seam.

`settings/` holds the settings pages and the `SettingsModal` shell — one page per section (about, account, appearance, bot-chat, daily-review, data, general, health, memory, open-gateway, permission, usage, voice, web-search), plus the `provider-*` files and the shared `settings-rows` / `settings-skeleton` / `settings-surface` helpers.

## Styles & tokens

| File | Role |
|---|---|
| `maka-tokens.css` | Single source of CSS tokens (color / shadow / typography / radius / spacing / motion / z / layout) **and** a few component-recipe fallbacks at the tail. Transitional: tokens and recipes coexist in one file. |
| `reference-shell.css` | A target-layout shell rebuild, hand-authored from a reference-implementation extract (see its header comment). **Transitional** — meant to be folded back into the token/style system and removed. |
| `styles/*.css` | Per-surface hand-written recipes (`chat-*`, `sidebar`, `composer`, `palette`, `settings/*`, `module-pages/*`, …). |

Token authoring rule: custom CSS variables go in `maka-tokens.css`; only component-local vars are excepted and must carry `/* local: ... */`. No new hardcoded color / radius / z-index.

Note the `--foreground-N` split: the wash stops (`-2/-3/-5/-8/-10`) are surface fills for backgrounds and borders, **not** text. The 3-tier semantic aliases (`--foreground` / `--foreground-secondary` / `--muted-foreground`) are the text-color vocabulary. They are separate concerns — don't collapse the wash stops into the text aliases.

## New code: primitive first, CSS last

1. Reach for a `@maka/ui` primitive or a Tailwind utility class first.
2. Only if no primitive carries it, write CSS in the matching `styles/<surface>.css`, following `docs/frontend-css-governance.md` (layer rules, the unlayered override list, the `!important` audit, the dead-CSS allowlist).
3. Don't add a token without registering it in `maka-tokens.css`.

## Convergence direction (transitional surfaces)

Acknowledged transitional states — not TODOs; track work in issues/PRs.

- Hand-written `styles/*.css` recipes + overrides on `@maka/ui` primitives: end state is structure carried by primitives, renderer CSS left only with layout primitives can't cover. Per-recipe retirement is mapped in `notes/ui-convergence-map-2026-07-09.md` (Chip / Item / PageHeader / StatTile / SectionHeader already converged).
- `reference-shell.css`: end state is folded into the token/style system and the file removed.
- `maka-tokens.css` mixing tokens + recipes: end state is tokens-only here, recipes living on primitives / `styles/`.

## Contracts & guardrails

- CSS cascade / layer / `!important` / dead-CSS / token rules: `docs/frontend-css-governance.md`. The dead-CSS check runs from the repo root via `check:release` (`scripts/check-dead-css.mjs --check`); its baseline is `scripts/check-dead-css-baseline.json`.
- Component 5-state / ARIA / token / copy contracts: `docs/design-system.md`.
- Where either doc disagrees with the code or the contract tests, the code and the tests are the source of truth. Key guardrail tests live in `apps/desktop/src/main/__tests__/` (renderer-style-layer-cascade-contract, renderer-important-audit-contract, typography / spacing / radius / state-token / foreground-tier governance, dead-css baseline). Build/test entry points are in the root `AGENTS.md`.