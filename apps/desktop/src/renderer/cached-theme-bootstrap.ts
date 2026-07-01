import { safeLocalStorageGet } from './browser-storage';

// Apply the cached theme before React mounts so dark-theme users don't get
// a brief light-mode flash while settings.json loads. We persist the resolved
// theme to localStorage on every change (theme.ts), and this entry point
// reads it synchronously before the first paint. This is the standard
// "FOUC prevention via inline-script" pattern, but here it runs in the same
// JS bundle as the rest of the renderer so we don't need to relax the CSP
// `script-src 'self'` rule.
export function applyCachedThemeBeforeMount(): void {
  const cachedThemePreference = safeLocalStorageGet('maka-theme-v1');
  const shouldApplyDarkTheme =
    cachedThemePreference === 'dark' ||
    (cachedThemePreference !== 'light' && window.matchMedia('(prefers-color-scheme: dark)').matches);
  if (shouldApplyDarkTheme) {
    document.documentElement.classList.add('dark');
    document.documentElement.style.colorScheme = 'dark';
  } else {
    document.documentElement.style.colorScheme = 'light';
  }
}
