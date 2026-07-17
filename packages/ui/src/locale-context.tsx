import {
  createContext,
  useContext,
  useLayoutEffect,
  type ReactNode,
} from 'react';
import type { UiLocale } from '@maka/core';

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
  locale: UiLocale;
  override?: UiLocale | null;
  children: ReactNode;
}) {
  useLayoutEffect(() => {
    syncUiLocaleDocument(props.locale, props.override);
  }, [props.locale, props.override]);

  return (
    <UiLocaleContext.Provider value={props.locale}>
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
