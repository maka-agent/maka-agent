import type { Dispatch, SetStateAction } from 'react';
import type { UiLocale } from '@maka/core';
import type { BundledSkillCatalogEntry, SkillEntry } from '@maka/ui';
import { createOpenSkillAction } from './app-shell-open-skill-action';
import { getShellCopy, localizedShellErrorMessage } from './locales/shell-copy.js';

type ToastApi = {
  success(title: string, description?: string): void;
  error(title: string, description?: string): void;
};

export interface AppShellSkillActions {
  refreshSkills(options?: { shouldShowError?: () => boolean }): Promise<void>;
  refreshBundledSkillCatalog(options?: { shouldShowError?: () => boolean }): Promise<void>;
  activateBundledSkill(id: string): Promise<boolean>;
  setSkillEnabled(entryKey: string, enabled: boolean): Promise<boolean>;
  openSkill(entryKey: string, repairTarget: SkillEntry['repairTarget']): Promise<void>;
}

export function createAppShellSkillActions(deps: {
  uiLocale: UiLocale;
  isSkillsSurfaceActive: () => boolean;
  getActiveSessionId: () => string | undefined;
  setSkills: Dispatch<SetStateAction<SkillEntry[]>>;
  setSkillHostBasis: Dispatch<SetStateAction<'session' | 'desktop_default'>>;
  setBundledSkillCatalog: Dispatch<SetStateAction<BundledSkillCatalogEntry[]>>;
  toastApi: ToastApi;
}): AppShellSkillActions {
  const {
    uiLocale,
    isSkillsSurfaceActive,
    getActiveSessionId,
    setBundledSkillCatalog,
    setSkillHostBasis,
    setSkills,
    toastApi,
  } = deps;
  const copy = getShellCopy(uiLocale).skillActions;
  const openSkill = createOpenSkillAction({
    uiLocale,
    isSkillsSurfaceActive,
    getActiveSessionId,
    toastApi,
  });

  async function refreshSkills(options: { shouldShowError?: () => boolean } = {}) {
    try {
      const next = await window.maka.skills.list({ sessionId: getActiveSessionId() });
      setSkills(next.entries);
      setSkillHostBasis(next.hostBasis);
    } catch (error) {
      if (options.shouldShowError?.() === true) {
        toastApi.error(
          copy.refreshSkillsFailedTitle,
          localizedShellErrorMessage(error, copy.refreshSkillsFallback, uiLocale),
        );
      }
    }
  }

  async function refreshBundledSkillCatalog(options: { shouldShowError?: () => boolean } = {}) {
    try {
      const next = await window.maka.skills.catalog.list();
      setBundledSkillCatalog(next);
    } catch (error) {
      if (options.shouldShowError?.() === true) {
        toastApi.error(
          copy.refreshBundledFailedTitle,
          localizedShellErrorMessage(error, copy.refreshBundledFallback, uiLocale),
        );
      }
    }
  }

  async function activateBundledSkill(id: string) {
    try {
      const result = await window.maka.skills.catalog.activate(id);
      if (!result.ok) {
        if (isSkillsSurfaceActive()) {
          toastApi.error(copy.installBundledFailedTitle, copy.installFailures[result.reason]);
        }
        return false;
      }
      await refreshSkills({ shouldShowError: isSkillsSurfaceActive });
      await refreshBundledSkillCatalog({ shouldShowError: isSkillsSurfaceActive });
      if (isSkillsSurfaceActive()) {
        toastApi.success(copy.installedBundledTitle, copy.installedDescription(result.skill.id));
      }
      return true;
    } catch (error) {
      if (isSkillsSurfaceActive()) {
        toastApi.error(
          copy.installBundledFailedTitle,
          localizedShellErrorMessage(error, copy.installBundledFallback, uiLocale),
        );
      }
      return false;
    }
  }

  async function setSkillEnabled(entryKey: string, enabled: boolean) {
    try {
      const result = await window.maka.skills.setEnabled({
        entryKey,
        enabled,
        sessionId: getActiveSessionId(),
      });
      if (!result.ok) {
        if (isSkillsSurfaceActive()) {
          toastApi.error(copy.toggleFailedTitle, copy.runtimeFailures[result.reason]);
        }
        return false;
      }
      setSkills(result.inventory.entries);
      setSkillHostBasis(result.inventory.hostBasis);
      await refreshBundledSkillCatalog({ shouldShowError: isSkillsSurfaceActive });
      if (isSkillsSurfaceActive()) {
        const toggled = result.inventory.entries.find((entry) => entry.entryKey === entryKey);
        toastApi.success(
          enabled ? copy.enabledTitle : copy.disabledTitle,
          copy.runtimeDescription(toggled?.name ?? entryKey),
        );
      }
      return true;
    } catch (error) {
      if (isSkillsSurfaceActive()) {
        toastApi.error(
          copy.toggleFailedTitle,
          localizedShellErrorMessage(error, copy.toggleFallback, uiLocale),
        );
      }
      return false;
    }
  }

  return {
    refreshSkills,
    refreshBundledSkillCatalog,
    activateBundledSkill,
    setSkillEnabled,
    openSkill,
  };
}
