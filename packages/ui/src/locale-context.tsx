import {
  createContext,
  useContext,
  useLayoutEffect,
  type ReactNode,
} from 'react';
import {
  resolveUiLocale,
  type UiLocale,
  type UiLocalePreference,
} from '@maka/core';

const UiLocaleContext = createContext<UiLocale | undefined>(undefined);

export function syncUiLocaleDocument(
  locale: UiLocale,
  override?: UiLocale | null,
): void {
  if (typeof document === 'undefined') return;

  const root = document.documentElement;
  root.setAttribute('lang', locale);
  root.setAttribute('data-maka-locale', locale);
  if (override) {
    root.setAttribute('data-maka-visual-smoke-locale', override);
  } else {
    root.removeAttribute('data-maka-visual-smoke-locale');
  }
}

export function LocaleProvider(props: {
  preference: UiLocalePreference;
  override?: UiLocale | null;
  children: ReactNode;
}) {
  const locale = resolveUiLocale(props.preference, props.override);

  useLayoutEffect(() => {
    syncUiLocaleDocument(locale, props.override);
  }, [locale, props.override]);

  return (
    <UiLocaleContext.Provider value={locale}>
      {props.children}
    </UiLocaleContext.Provider>
  );
}

export function useUiLocale(): UiLocale {
  const locale = useContext(UiLocaleContext);
  if (!locale) {
    throw new Error('useUiLocale must be used within LocaleProvider');
  }
  return locale;
}
