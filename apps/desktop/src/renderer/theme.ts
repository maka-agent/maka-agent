// apps/desktop/src/renderer/theme.ts
//
// Tiny client-side helper that resolves a ThemePreference ('light' | 'dark' |
// 'auto') to an actual mode and toggles `.dark` on <html>. When the preference
// is `auto`, the helper subscribes to the system `prefers-color-scheme` media
// query so the app follows OS-level Light/Dark switches in real time.
//
// Also exposes `applyDensity()` which sets `data-ui-density` on <html>; CSS
// reads the attribute to swap a coherent set of `--ui-density-*` tokens.

import type { ThemePalette, ThemePreference, UiDensity } from '@maka/core';

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
  try {
    localStorage.setItem('maka-theme-v1', pref);
  } catch {
    /* localStorage unavailable; cached preference will fall back to default */
  }

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

/**
 * What the user would actually see for a given preference right now. Useful
 * for inline previews in the Settings UI ("Auto · currently Light").
 */
export function resolveTheme(pref: ThemePreference): 'light' | 'dark' {
  if (pref === 'auto') {
    return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }
  return pref;
}

function setDarkClass(isDark: boolean): void {
  const root = document.documentElement;
  root.classList.toggle(DARK_CLASS, isDark);
  // Lets native form controls and scrollbars pick up the right base colors per
  // the Vercel Web Interface Guidelines dark-mode rule.
  root.style.colorScheme = isDark ? 'dark' : 'light';
}

export function applyDensity(density: UiDensity): void {
  document.documentElement.setAttribute('data-ui-density', density);
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
  try {
    localStorage.setItem('maka-theme-palette-v1', palette);
  } catch {
    /* localStorage unavailable; pre-React paint will fall back to default */
  }
}
