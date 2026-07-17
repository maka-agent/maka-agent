# Conversation, Session, and Tool Localization Design

## Scope

This change implements only PR 3 from issue #1052. It migrates the complete desktop fake-backend conversation journey after the reactive locale foundation from PR 1, while remaining independent from PR 2's shell, onboarding, and Settings translation slice.

The localized journey includes:

- empty conversation and deep-research states;
- composer controls, import/mention states, model and permission hints;
- user and assistant message chrome, reasoning, lineage, copy feedback, truncation, and accessibility labels;
- permission and user-question prompts;
- session navigation, history rows, status, blocked reasons, health notices, timestamps, and counts;
- tool-group summaries, tool rows, live output, errors, and built-in result previews;
- desktop chat/session action errors that surface inside the same journey.

User-authored content, model output, tool arguments/results, file paths, model/provider names, brands, commands, and generated content remain verbatim. CLI localization, Settings pages, additional locales, Follow-system resolution, and translation infrastructure remain out of scope.

## Chosen approach

Use compile-time-complete typed catalogs close to their rendering owners, with one catalog module for the conversation/session family and one for tool activity. This follows the existing `UiCatalog<T>` and `useUiLocale()` pattern introduced by PR 1 while avoiding a second locale authority.

Two alternatives were rejected:

- A single desktop-wide catalog would make ownership unclear and force unrelated PR 2/PR 4 surfaces into this branch.
- Inline `locale === 'en'` conditionals would make missing English copy easy to hide and would scatter plural/count grammar through JSX.

## Architecture

### Shared conversation catalog

Create `packages/ui/src/conversation-copy.ts` as a leaf module that exports:

- a `getConversationCopy(locale)` selector backed by `UiCatalog<ConversationCopy>`;
- typed nested copy for empty/deep-research states, composer, messages, permissions, questions, session navigation/history, status, health, and accessibility;
- pure formatting functions for counts and variable-bearing sentences where English and Chinese grammar differ;
- locale-aware deep-research display arrays that are separate from the core agent prompt constants.

Every English entry is mandatory because the catalog is a `UiCatalog<ConversationCopy>`. No lookup falls back from English to Chinese.

### Tool activity catalog

Create `packages/ui/src/tool-activity/copy.ts` for tool-specific presentation copy:

- statuses and grouped activity counts;
- live-output, truncation, redaction, copy, and raw-diagnostic controls;
- built-in preview labels for terminal, automation, office documents, web search, and agent/explore results;
- pure helpers that accept `UiLocale` explicitly when they run outside React.

`ToolActivity`, result previews, and agent previews read `useUiLocale()` at React ownership boundaries and pass the resolved locale to pure projection helpers. Raw tool output is never translated; only Maka-owned labels around it change.

### Desktop action copy

Create `apps/desktop/src/renderer/locales/conversation-copy.ts` for renderer-owned chat/session failure titles and safe fallback messages. `createAppShellChatActions`, session settings actions, row actions, and session health presentation receive the already-resolved `UiLocale` from their owner. They continue to sanitize errors before selecting localized Maka-owned fallback copy.

### Existing locale authority

PR 1 remains the only authority:

1. `personalization.uiLocale` is persisted once.
2. `LocaleProvider` derives `zh | en` once.
3. React surfaces call `useUiLocale()`.
4. Pure presenters receive that locale explicitly.
5. `<html lang>` and `Intl` continue to use the same resolved locale.

PR 3 does not add settings, DOM, global-variable, or browser-language locale detection. The temporary `auto -> zh` policy remains unchanged.

## Data flow

At runtime, a locale preference change updates the existing provider. Conversation components rerender immediately and select a complete catalog for the new locale. Session timestamps and relative labels receive the same locale; no reload, session refetch, or message rematerialization is required.

Dynamic values flow through typed formatter functions:

- user labels, session names, paths, branches, provider/model names, and tool names are interpolated unchanged;
- counts are formatted by locale-owned functions;
- timestamps use the existing `UiLocale -> Intl locale` mapping;
- raw errors and tool output remain sanitized or redacted by existing logic before display.

## Error handling

- Desktop action failures keep the current state rollback and pending-action behavior.
- Sanitized error classification remains semantic; only the selected user-facing title/fallback changes by locale.
- Unknown tool payloads continue to use defensive generic previews, now with locale-aware labels.
- Missing provider/context usage still fails through the PR 1 `useUiLocale()` invariant rather than silently selecting Chinese.
- Catalog access is direct and total; English never falls back to Chinese.

## Testing

Tests are written before each implementation slice and cover:

- compile-time-complete catalog shapes and an AST gate for migrated visible literals;
- Chinese and English empty state, composer, message, permission, question, session, and tool renderings;
- runtime provider switching without remounting or reload;
- session status/blocked-reason, timestamp, duration, and count presentation in both locales;
- preservation of user/model/path/tool-output values across localization;
- localized safe errors without exposing raw exception text;
- representative fake-backend conversation states in both locales, including permission waiting, tool activity, failure, and completed output.

Verification runs the focused UI and desktop tests, build, typecheck, lint, exact CI-compatible `npm ci`, `git diff --check`, and a source audit of the PR 3 file list.

## Delivery boundary

PR 3 delivers a coherent bilingual conversation/session/tool journey and presentation helpers. It intentionally does not localize remaining specialized Settings or desktop surfaces, does not change `auto -> zh`, and does not add the representative end-to-end locale matrix reserved for PR 4. It is based directly on upstream `main`, so PR 2 and PR 3 can be reviewed and merged independently.
