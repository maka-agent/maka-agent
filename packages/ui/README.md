# @maka/ui

Shared UI layer for the Maka desktop app: React + Tailwind v4 + shadcn (base-nova) + `@base-ui/react`, bound to Maka's token system. Consumed by `apps/desktop`'s renderer, and only that today.

This package is the **target carrier of the frontend convergence**: hand-rolled renderer CSS recipes are being retired onto primitives exported here. When in doubt, extend a primitive rather than add CSS at the call site.

## Layer map

Four export surfaces, in the order to look:

| Surface | Role | Status |
|---|---|---|
| `src/primitives/` | One file per primitive (accordion, alert, badge, card, chip, dialog-header, empty, input, input-group, item, kbd, menu, number-field, page-header, scroll-area, section-header, settings-segmented/select/switch, spinner, stat-tile, tabs, textarea, toolbar, tooltip, …). **New primitives go here.** | target layer |
| `src/ui.tsx` | Earlier Base UI wrappers + `buttonVariants` (cva) in one file: Button, Checkbox, Dialog/AlertDialog, Select, Switch, Toggle, Radio, Progress, Separator, Field/Label. | transitional — wrappers migrate into `primitives/` as touched (Badge moved to `primitives/badge.tsx` earlier; Button/Select/etc. still live here) |
| `src/*.tsx` / `src/*.ts` (top-level) | Feature components + pure logic: `chat-view.tsx`, `composer.tsx`, `tool-activity.tsx`, `permission-dialog.tsx`, `search-modal.tsx`, `session-list-panel.tsx`, `skills-panel.tsx`, `plan-reminder-panel.tsx`, `daily-review-panel.tsx`, plus pure helpers (`materialize.ts`, `redact.ts`, `smooth-stream.ts`, `stream-fade.ts`, `live-turn-projection.ts`, …). | stable |
| `src/components.tsx` | Re-export barrel for the feature components above (ChatView, Composer, ToolActivity, PermissionDialog, SearchModal, SessionListPanel, RelativeTime, …). | stable |

`src/index.ts` is the package barrel. It follows an **off-barrel convention**: internal styling tables and single-consumer dots (`markerVariants`, `streamVariants`, `toolVariants`, `LiveIndicator`) are deliberately *not* re-exported, so they stay renamable/removable without a public-API break. A symbol earns barrel export when it has a second consumer or a cross-package consumer (the promotion condition is documented inline in `index.ts`). Don't add to the barrel speculatively.

## `data-slot` hooks

Most primitives expose a stable `data-slot="<name>"` attribute so renderer CSS can target a slot (e.g. `[data-slot="dialog-header"]`) rather than a drifting class. Exceptions without one: `choice-card`, `spinner`, `scroll-area`, `settings-segmented` — their styling lives on the consumer's class or an underlying Base UI component, so a `[data-slot="..."]` selector won't match. New primitives should still expose a `data-slot`.

## Consuming

```ts
import { Button, ChatView, Composer, Badge, Chip, PageHeader, useToast } from '@maka/ui';
import { ProviderLogo } from '@maka/ui/icons';
```

Sub-path exports (declared in `package.json` `exports`): `@maka/ui/artifact-preview-registry`, `@maka/ui/assistant-stream`, `@maka/ui/icons`, `@maka/ui/maka-uri`, `@maka/ui/smooth-stream`.

Renderer CSS may target a primitive via its `data-slot` attribute, never by overriding the primitive's own utility classes.

## Where new code goes

- **New primitive** (button-like, dialog-like, form control) → a new file in `src/primitives/`, exposing `data-slot`, re-exported from `index.ts`.
- **New feature component** → top-level `src/<name>.tsx`, re-exported from `src/components.tsx` and `index.ts`.
- **Don't** add a per-surface hand-rolled CSS recipe in the renderer if a primitive can carry it — extend the primitive's API/slots instead.
- **Don't** re-export a single-consumer symbol from the barrel; keep it a relative import until a second consumer appears.

## Convergence direction (transitional surfaces)

Acknowledged transitional states — not TODOs; track actual work in issues/PRs.

- `ui.tsx` ↔ `primitives/`: end state is one primitive layer in `primitives/`. Wrappers in `ui.tsx` move over when touched (Badge is the precedent). `buttonVariants` has external consumers, so its move is a coordinated rename, not a silent one.

## Contracts & guardrails

Component contracts (5-state, ARIA, keyboard, tone/token per component), the token registry, and anti-patterns live in `docs/design-system.md`. Where that doc disagrees with the code or the contract tests (`*-converge-contract.test.ts`, `state-token-governance-*`, `tab-spec-*`, …), the code and the tests are the source of truth.

Stories (`stories/`) and unit tests (`src/__tests__/`) exist per primitive/feature. Build/test entry points are in the root `AGENTS.md`.