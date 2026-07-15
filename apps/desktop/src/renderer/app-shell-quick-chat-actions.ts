import type { QuickChatMode } from '@maka/core';
import { generalizedErrorMessageChinese } from '@maka/core';
import { saveGlobalInputHistoryEntry } from '@maka/ui';
import type { NavSelection } from '@maka/ui';

type ComposerImportOwner = {
  sessionId: string | undefined;
  navSection: NavSelection['section'];
};

type RefBox<T> = { current: T };

type ComposerFocusHandle = {
  focus(): void;
};

type ToastApi = {
  error(title: string, description?: string): void;
};

export interface AppShellQuickChatActions {
  handleQuickChatSubmit(prompt: string, mode?: QuickChatMode): Promise<boolean>;
  /** Start a new expert-team session (from the composer "+" menu). */
  handleExpertTeamStart(teamId: string, prompt?: string): Promise<boolean>;
}

export function createAppShellQuickChatActions(deps: {
  activeIdRef: RefBox<string | undefined>;
  captureComposerImportOwner: () => ComposerImportOwner;
  composerRef: RefBox<ComposerFocusHandle | null>;
  isShellSurfaceOwnerActive: (owner: ComposerImportOwner) => boolean;
  openSessionInChat: (sessionId: string, turnId?: string) => void;
  quickChatPendingRef: RefBox<boolean>;
  refreshOnboarding: () => void;
  refreshSessions: () => Promise<unknown>;
  setQuickChatPending: (pending: boolean) => void;
  toastApi: ToastApi;
}): AppShellQuickChatActions {
  const {
    activeIdRef,
    captureComposerImportOwner,
    composerRef,
    isShellSurfaceOwnerActive,
    openSessionInChat,
    quickChatPendingRef,
    refreshOnboarding,
    refreshSessions,
    setQuickChatPending,
    toastApi,
  } = deps;

  async function handleQuickChatSubmit(prompt: string, mode?: QuickChatMode): Promise<boolean> {
    if (quickChatPendingRef.current) return false;
    const owner = captureComposerImportOwner();
    quickChatPendingRef.current = true;
    setQuickChatPending(true);
    try {
      const result = await window.maka.quickChat.start({ prompt, mode });
      if (result.ok) {
        // Save to global input history so the prompt is recallable
        // from the main Composer via up-arrow navigation.
        saveGlobalInputHistoryEntry(prompt);
        if (isShellSurfaceOwnerActive(owner)) {
          openSessionInChat(result.sessionId);
        }
        await refreshSessions();
        if (!prompt.trim() && activeIdRef.current === result.sessionId) {
          composerRef.current?.focus();
        }
        // Best-effort: mark onboarding completed. Failure must not
        // turn a successful chat into a failure — backfill covers it.
        void window.maka.onboarding.setMilestone('initial_onboarding', 'completed').catch(() => {});
        return true;
      } else if (result.reason === 'setup_required') {
        refreshOnboarding();
        return false;
      } else {
        await refreshSessions();
        if (isShellSurfaceOwnerActive(owner)) {
          toastApi.error('开始对话失败', result.message);
        }
        return false;
      }
    } catch (error) {
      if (isShellSurfaceOwnerActive(owner)) {
        toastApi.error('开始对话失败', generalizedErrorMessageChinese(error, '对话暂时无法开始，请稍后重试。'));
      }
      return false;
    } finally {
      quickChatPendingRef.current = false;
      setQuickChatPending(false);
    }
  }

  async function handleExpertTeamStart(teamId: string, prompt?: string): Promise<boolean> {
    if (quickChatPendingRef.current) return false;
    const owner = captureComposerImportOwner();
    quickChatPendingRef.current = true;
    setQuickChatPending(true);
    try {
      const result = await window.maka.expertTeam.start({ teamId, prompt: prompt ?? '' });
      if (result.ok) {
        if (prompt && prompt.trim()) saveGlobalInputHistoryEntry(prompt);
        if (isShellSurfaceOwnerActive(owner)) {
          openSessionInChat(result.sessionId);
        }
        await refreshSessions();
        if (activeIdRef.current === result.sessionId) {
          composerRef.current?.focus();
        }
        void window.maka.onboarding.setMilestone('initial_onboarding', 'completed').catch(() => {});
        return true;
      } else if (result.reason === 'setup_required') {
        refreshOnboarding();
        return false;
      } else {
        await refreshSessions();
        if (isShellSurfaceOwnerActive(owner)) {
          toastApi.error(
            '开始专家团失败',
            result.reason === 'unknown_team' ? '找不到该专家团。' : result.message,
          );
        }
        return false;
      }
    } catch (error) {
      if (isShellSurfaceOwnerActive(owner)) {
        toastApi.error('开始专家团失败', generalizedErrorMessageChinese(error, '专家团暂时无法开始，请稍后重试。'));
      }
      return false;
    } finally {
      quickChatPendingRef.current = false;
      setQuickChatPending(false);
    }
  }

  return { handleQuickChatSubmit, handleExpertTeamStart };
}
