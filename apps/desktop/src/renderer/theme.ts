// apps/desktop/src/renderer/theme.ts
//
// Tiny client-side helper that resolves a ThemePreference ('light' | 'dark' |
// 'auto') to an actual mode and toggles `.dark` on <html>. When the preference
// is `auto`, the helper subscribes to the system `prefers-color-scheme` media
// query so the app follows OS-level Light/Dark switches in real time.
//
import type { ThemePalette, ThemePreference } from '@maka/core';
import { safeLocalStorageSet } from './browser-storage';

const DARK_CLASS = 'dark';

let unsubscribeMediaQuery: (() => void) | null = null;

/**
 * Apply a theme preference to <html>. Returns an unsubscribe function for the
 * caller; we also memoize the active subscription internally so re-applying a
 * different preference cleanly tears down the previous listener.
 *
 * Also persists the preference to `maka-theme-v1` in localStorage so the
 * pre-React paint in `main.tsx` can apply `.dark` synchronously on next
 * launch, eliminating the brief light-mode flash for dark-theme users.
 */
export function applyTheme(pref: ThemePreference): () => void {
  unsubscribeMediaQuery?.();
  unsubscribeMediaQuery = null;

  // Cache the user-facing preference (not the resolved light/dark). The
  // pre-React paint reapplies the auto → system-matchMedia branch itself.
  safeLocalStorageSet('maka-theme-v1', pref);

  // Also syncs Electron's own native chrome (nativeTheme.themeSource) --
  // see toNativeThemeSource() in main-window.ts for why this DOM-only flip
  // isn't enough on its own.
  void window.maka.appWindow.setThemeSource(pref).catch(() => {});

  if (pref === 'auto') {
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    setDarkClass(mq.matches);
    const onChange = (event: MediaQueryListEvent) => setDarkClass(event.matches);
    mq.addEventListener('change', onChange);
    unsubscribeMediaQuery = () => mq.removeEventListener('change', onChange);
  } else {
    setDarkClass(pref === 'dark');
  }

  return () => {
    unsubscribeMediaQuery?.();
    unsubscribeMediaQuery = null;
  };
}

function setDarkClass(isDark: boolean): void {
  const root = document.documentElement;
  root.classList.toggle(DARK_CLASS, isDark);
  // Lets native form controls and scrollbars pick up the right base colors per
  // the Vercel Web Interface Guidelines dark-mode rule.
  root.style.colorScheme = isDark ? 'dark' : 'light';
  // PR-WINDOW-TITLEBAR-0: keep the native Windows titleBarOverlay color in
  // sync with the resolved theme. The IPC handler is a no-op on non-Windows,
  // and `window.maka` is only defined in the Electron renderer, so guard for
  // both. Swallowed errors (window torn down mid-toggle, etc.) never block
  // the in-app `.dark` toggle above.
  void window.maka?.appWindow?.setTitleBarOverlayTheme?.(isDark).catch(() => {});
}

/**
 * PR-UI-2 (@yuejing 2026-05-22): apply a base46 palette by writing
 * `data-maka-theme="<palette>"` on `<html>`. CSS variable overrides
 * live in `maka-tokens.css`. `default` removes the attribute so the
 * original Maka palette renders.
 *
 * Light/dark variants of each palette switch automatically with the
 * existing `.dark` class — no separate IPC needed.
 */
export function applyThemePalette(palette: ThemePalette): void {
  const root = document.documentElement;
  if (palette === 'default') {
    root.removeAttribute('data-maka-theme');
  } else {
    root.setAttribute('data-maka-theme', palette);
  }
  safeLocalStorageSet('maka-theme-palette-v1', palette);
}

/**
 * PR-LANG-PREF-0: apply persisted UI locale preference to `<html>`.
 *
 * - `'auto'`  → remove `data-maka-locale`; UI components fall back to
 *               the Chinese-first product default.
 * - `'zh'` / `'en'` → set `data-maka-locale=<value>` so
 *               `detectUiLocale()` returns the user choice synchronously
 *               on every read.
 *
 * Also updates `<html lang>` so screen readers and CSS `:lang()` rules
 * see the right language code. The visual-smoke override
 * (`data-maka-visual-smoke-locale`) still wins over this attribute
 * in `detectUiLocale()` so fixture screenshots stay deterministic.
 */
export type UiLocalePreference = 'auto' | 'zh' | 'en';

export function applyUiLocale(preference: UiLocalePreference): void {
  const root = document.documentElement;
  if (preference === 'auto') {
    root.removeAttribute('data-maka-locale');
    // Keep the default shell coherent for assistive tech. Explicit
    // English still sets both `data-maka-locale` and `lang` below.
    root.setAttribute('lang', 'zh');
  } else {
    root.setAttribute('data-maka-locale', preference);
    root.setAttribute('lang', preference);
  }
}
