import type { UiLocale } from '@maka/core';
import { openSkillFailureCopy } from './app-shell-copy';
import { getShellCopy, localizedShellErrorMessage } from './locales/shell-copy.js';

type ToastApi = {
  error(title: string, description?: string): void;
};

export function createOpenSkillAction(deps: {
  uiLocale: UiLocale;
  isSkillsSurfaceActive: () => boolean;
  getActiveSessionId: () => string | undefined;
  toastApi: ToastApi;
}): (entryKey: string, repairTarget: 'skill_file' | 'state_file' | null) => Promise<void> {
  const { uiLocale, isSkillsSurfaceActive, getActiveSessionId, toastApi } = deps;
  const copy = getShellCopy(uiLocale).skillActions;

  async function openSkill(entryKey: string, repairTarget: 'skill_file' | 'state_file' | null) {
    try {
      const result = repairTarget === 'state_file'
        ? await window.maka.skills.openRepairTarget({ entryKey, sessionId: getActiveSessionId() })
        : await window.maka.skills.openEntry({
            entryKey,
            sessionId: getActiveSessionId(),
            target: 'file',
          });
      if (!result.ok) {
        if (isSkillsSurfaceActive())
          toastApi.error(copy.openFailedTitle, openSkillFailureCopy(result.reason, uiLocale));
      }
    } catch (error) {
      if (isSkillsSurfaceActive()) {
        toastApi.error(copy.openFailedTitle, localizedShellErrorMessage(error, copy.openFallback, uiLocale));
      }
    }
  }

  return openSkill;
}
