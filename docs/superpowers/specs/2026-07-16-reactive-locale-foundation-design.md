# Reactive Locale Foundation Design

## Scope

This change implements only PR 1 from issue #1052. It establishes the reactive locale authority needed by later translation slices without translating the remaining desktop shell, settings, conversation, or tool copy.

The foundation must provide:

- one persisted preference: `personalization.uiLocale`;
- one derived runtime locale: `zh | en`;
- a temporary `auto -> zh` policy until desktop coverage is complete;
- a test-only override that wins over the persisted preference;
- reactive React rendering with no reload;
- synchronized `<html lang>` and locale-sensitive `Intl` formatting;
- compile-time-complete `zh` and `en` catalogs;
- no DOM-reading localization path alongside React context.

CLI localization, additional locales, translation infrastructure, and translation of user/model/generated content remain out of scope.

## Architecture

### `@maka/core`: canonical locale contract

Create a focused `ui-locale.ts` module that owns:

- `UiLocale = 'zh' | 'en'`;
- `UiLocalePreference = 'auto' | UiLocale`;
- the ordered supported locale and preference constants;
- runtime guards for both closed unions;
- `UiCatalog<T> = Record<UiLocale, T>`;
- a pure `resolveUiLocale(preference, override?)` policy;
- `uiLocaleToIntlLocale(locale)` for the `zh -> zh-CN`, `en -> en` mapping.

The resolver precedence is:

1. valid test override;
2. explicit `zh` or `en` preference;
3. `auto -> zh`.

`settings.ts` imports these definitions instead of declaring a second preference union. `@maka/core` re-exports the complete locale contract from its public index.

### `@maka/ui`: reactive provider and typed catalogs

Replace `detectUiLocale()` with a React context:

- `<LocaleProvider preference override>` derives the locale through `resolveUiLocale()`;
- `useUiLocale()` returns that derived locale and fails clearly outside a provider;
- the provider updates `<html lang>` whenever the resolved locale changes;
- the provider exposes the locale through React state/context only, not by reading DOM attributes.

Existing shared UI catalogs use `UiCatalog<T>` (or an equivalent `satisfies UiCatalog<T>` constraint), so omitting either locale is a type error. Existing components that currently call `detectUiLocale()` switch to `useUiLocale()`. Non-component presentation helpers receive `UiLocale` explicitly from their React owner.

The legacy `detectUiLocale()` export is removed once all current consumers are migrated. This prevents a non-reactive DOM path from surviving beside the provider.

### Desktop renderer: preference and override state

`AppShell` owns two runtime inputs:

- `uiLocalePreference`, initialized as `auto` and refreshed from persisted settings;
- `uiLocaleOverride`, initialized as `null` and populated only by the visual-smoke fixture.

The returned desktop tree is wrapped in `LocaleProvider`. Settings updates continue to persist through the existing `window.maka.settings.update()` path. After a locale patch is accepted, the settings surface notifies `AppShell`, which updates the preference state and triggers an immediate React rerender without reloading.

The visual-smoke action updates `uiLocaleOverride` rather than only writing a DOM attribute. The provider resolves the override, rerenders consumers, and synchronizes `<html lang>`. Test attributes may remain as observable fixture markers, but no production copy or formatter reads them as locale authority.

## Data flow

Startup:

1. Desktop starts with preference `auto` and no override, resolving to `zh`.
2. `refreshShellSettings()` loads the persisted preference and visual-smoke state.
3. React state receives both inputs.
4. `LocaleProvider` derives one locale and publishes it.
5. Consumers rerender; `<html lang>` and `Intl` receive the same locale.

Runtime preference change:

1. The user selects `auto`, `zh`, or `en`.
2. The existing settings update path persists `personalization.uiLocale`.
3. On success, the desktop preference state updates.
4. The provider derives the new locale and React consumers rerender immediately.
5. `<html lang>` changes in the same commit/effect cycle; no reload occurs.

Test override:

1. The visual-smoke fixture provides `zh` or `en`.
2. Desktop stores it in override state.
3. The override wins over every persisted preference.
4. Clearing the override reveals the persisted preference again.

## `Intl` behavior

Locale-sensitive formatters must not inspect `document`. Pure formatter functions accept `UiLocale` explicitly (with a Chinese default only where a non-React compatibility call requires one). React formatter components call `useUiLocale()` and pass the resolved value. Formatter caches are keyed by the mapped `Intl` locale, so runtime switching selects a new formatter without reload.

## Error handling

- Persisted unknown preferences continue to normalize to `auto` at the settings boundary.
- Invalid visual-smoke values continue to normalize to no override before reaching React.
- `useUiLocale()` outside a provider throws an actionable error instead of silently selecting a language.
- A failed settings write leaves the runtime authority unchanged and preserves the existing sanitized failure toast.

## Testing

Tests are added before implementation and cover:

- core union guards, constants, `auto -> zh`, explicit preference resolution, override precedence, catalog completeness, and `Intl` mapping;
- provider rendering in both locales, runtime prop switching, missing-provider failure, and `<html lang>` synchronization;
- existing localized shared components consuming context rather than DOM detection;
- desktop startup hydration from the persisted preference;
- successful locale persistence updating desktop React state;
- failed persistence not changing the runtime locale;
- visual-smoke override precedence and synchronization;
- relative/absolute time formatting using the resolved locale;
- source/compile contracts proving the duplicate locale types and `detectUiLocale()` path are gone.

Verification includes focused red/green tests, `@maka/core`, `@maka/ui`, and desktop tests, workspace typechecking, build checks, `git diff --check`, and a requirement-by-requirement audit against PR 1.

## Delivery boundary

PR 1 makes every already-localized surface reactive and establishes compile-time-safe catalogs. It does not claim that the entire English desktop renderer is translated; that issue-level completion condition depends on PRs 2–4. The temporary `auto -> zh` behavior is intentional in this slice even though the final issue outcome will later make “Follow system” inspect the supported system language.
