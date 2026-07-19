/** Resolved locales supported by the desktop renderer. */
export const UI_LOCALES = ['zh', 'en'] as const;

export type UiLocale = (typeof UI_LOCALES)[number];

/** The only persisted locale preference. The resolved locale is never stored. */
export type UiLocalePreference = 'auto' | UiLocale;

export const UI_LOCALE_PREFERENCES = ['auto', ...UI_LOCALES] as const;

/** A catalog must carry copy for every supported resolved locale. */
export type UiCatalog<T> = Record<UiLocale, T>;

export function isUiLocale(value: unknown): value is UiLocale {
  return value === 'zh' || value === 'en';
}

export function isUiLocalePreference(value: unknown): value is UiLocalePreference {
  return value === 'auto' || isUiLocale(value);
}

/**
 * Derive the single renderer locale.
 *
 * Visual/test overrides are deliberately highest priority. `auto` remains
 * Chinese-first until the remaining desktop translation slices are complete.
 */
export function resolveUiLocale(
  preference: UiLocalePreference,
  override?: UiLocale | null,
): UiLocale {
  if (override) return override;
  return preference === 'auto' ? 'zh' : preference;
}

/** Locale identifier used by every locale-sensitive Intl formatter. */
export function uiLocaleToIntlLocale(locale: UiLocale): 'zh-CN' | 'en' {
  return locale === 'zh' ? 'zh-CN' : 'en';
}
