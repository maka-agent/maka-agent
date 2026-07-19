import { useState, type Dispatch, type SetStateAction } from 'react';
import type {
  ChatDefaultPermissionMode,
  ThemePalette,
  ThemePreference,
  UiLocale,
  UiLocalePreference,
} from '@maka/core';
import { createUiLocaleUpdateGate } from './settings/ui-locale-update-gate';
import { applyTheme, applyThemePalette } from './theme';
import { getShellCopy, localizedShellErrorMessage } from './locales/shell-copy';

type ToastApi = {
  error(title: string, description?: string): void;
};

/**
 * Owns the appearance / personalization / default-permission-mode slice
 * (issue #1043): the theme + palette + UI-locale + user-label + default
 * permission mode state, plus the `refreshShellSettings` IPC pull that
 * hydrates them from `window.maka.settings` / `visualSmoke` on mount and on
 * close-settings re-reads.
 *
 * `closeSettings` stays in AppShell: on close it re-reads just the default
 * permission mode (cross-slice orchestration with onboarding / memory). The
 * full settings hydration lives here.
 */
export function useShellAppearance({
  toastApi,
  uiLocale,
  setUiLocaleOverride,
  setUiLocalePreference,
}: {
  toastApi: ToastApi;
  uiLocale: UiLocale;
  setUiLocaleOverride: Dispatch<SetStateAction<UiLocale | null>>;
  setUiLocalePreference: Dispatch<SetStateAction<UiLocalePreference>>;
}) {
  const [themePref, setThemePref] = useState<ThemePreference>('auto');
  const [themePalette, setThemePalette] = useState<ThemePalette>('default');
  const [uiLocaleUpdateGate] = useState(createUiLocaleUpdateGate);
  const [userLabel, setUserLabel] = useState<string>('');
  // Settings -> 通用 -> 默认权限模式 - DISPLAY-ONLY mirror. The composer's
  // picker shows it before the user makes a per-session choice; the actual
  // authority for a new session's mode is main.ts's sessions:create fallback
  // (the renderer omits permissionMode unless the user explicitly picked),
  // so a stale value here can briefly mislabel the chip but never changes
  // which mode a session is created with.
  const [defaultPermissionMode, setDefaultPermissionMode] = useState<ChatDefaultPermissionMode>('ask');

  async function refreshShellSettings() {
    const uiLocaleHydration = uiLocaleUpdateGate.beginHydration();
    try {
      const next = await window.maka.settings.get();
      const smoke = await window.maka.visualSmoke.getState();
      const pref = smoke?.theme ?? next.appearance?.theme ?? 'auto';
      const palette = next.appearance?.palette ?? 'default';
      const name = next.personalization?.displayName ?? '';
      const uiLocale = next.personalization?.uiLocale ?? 'auto';
      setUiLocaleOverride(smoke?.locale ?? null);
      uiLocaleUpdateGate.commitHydration(
        uiLocaleHydration,
        uiLocale,
        (preference) => setUiLocalePreference(preference),
      );
      setThemePref(pref);
      setThemePalette(palette);
      setUserLabel(name);
      setDefaultPermissionMode(next.chatDefaults?.permissionMode ?? 'ask');
      applyTheme(pref);
      applyThemePalette(palette);
    } catch (error) {
      const copy = getShellCopy(uiLocale).app;
      toastApi.error(
        copy.appearanceLoadErrorTitle,
        localizedShellErrorMessage(error, copy.appearanceLoadErrorFallback, uiLocale),
      );
    }
  }

  return {
    themePref,
    setThemePref,
    themePalette,
    setThemePalette,
    uiLocaleUpdateGate,
    userLabel,
    setUserLabel,
    defaultPermissionMode,
    setDefaultPermissionMode,
    refreshShellSettings,
  };
}
