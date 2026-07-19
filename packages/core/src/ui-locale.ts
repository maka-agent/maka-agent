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

/** Resolve the first supported language in the operating system preference list. */
export function resolveSystemUiLocale(languages: readonly string[] | null | undefined): UiLocale {
  for (const language of languages ?? []) {
    const normalized = language.trim();
    if (/^zh(?:[-_]|$)/iu.test(normalized)) return 'zh';
    if (/^en(?:[-_]|$)/iu.test(normalized)) return 'en';
  }
  return 'en';
}

/**
 * Derive the single renderer locale.
 *
 * Visual/test overrides are deliberately highest priority. Explicit persisted
 * preferences beat the system locale; `auto` follows the supported system
 * locale without persisting the derived value.
 */
export function resolveUiLocale(
  preference: UiLocalePreference,
  systemLocale: UiLocale,
  override?: UiLocale | null,
): UiLocale {
  if (override) return override;
  return preference === 'auto' ? systemLocale : preference;
}

/** Locale identifier used by every locale-sensitive Intl formatter. */
export function uiLocaleToIntlLocale(locale: UiLocale): 'zh-CN' | 'en' {
  return locale === 'zh' ? 'zh-CN' : 'en';
}
