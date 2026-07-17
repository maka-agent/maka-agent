import type { Dispatch, SetStateAction } from 'react';
import type { UiLocale } from '@maka/core';
import { basenameFromPath, openPathActionErrorMessage, selectProjectDirectoryFailureCopy } from './app-shell-copy';
import { openPathActionLabel, openPathFailureCopy } from './open-path';
import { getShellCopy, localizedShellErrorMessage } from './locales/shell-copy.js';
import { MAX_RECENT_PATHS, saveComposerDefaults } from './composer-defaults';
import { isSessionWorkspaceUnavailableError, showSessionWorkspaceUnavailableToast } from './session-workspace-errors';

export interface RendererAppInfo {
  projectPath: string;
  projectGit: { isGitRepo: boolean; branch?: string };
}

export interface SessionProjectInfoState extends RendererAppInfo {
  sessionId: string;
}

export interface ProjectBranchListState {
  contextKey: string | null;
  branches: string[];
  current?: string;
}

type RefBox<T> = { current: T };

type ToastApi = {
  success(title: string, description?: string): void;
  error(title: string, description?: string): void;
};

export interface AppShellProjectActions {
  refreshAppInfo(): Promise<void>;
  selectProjectDirectory(): Promise<void>;
  selectRecentProjectDirectory(path: string): Promise<void>;
  openProjectFolder(): Promise<void>;
  openWorkspaceFolder(): Promise<void>;
  openSkillsFolder(): Promise<void>;
  listGitBranches(sessionId?: string): Promise<{ branches: string[]; current?: string } | null>;
  checkoutGitBranch(branch: string, sessionId?: string): Promise<void>;
}

export function createAppShellProjectActions(deps: {
  uiLocale: UiLocale;
  projectPickerPendingRef: RefBox<boolean>;
  projectPickerRequestRef: RefBox<number>;
  rendererMountedRef: RefBox<boolean>;
  setAppInfo: Dispatch<SetStateAction<RendererAppInfo | null>>;
  setSessionProjectInfo: Dispatch<SetStateAction<SessionProjectInfoState | null>>;
  setProjectPickerPending: Dispatch<SetStateAction<boolean>>;
  setBranchPending: Dispatch<SetStateAction<boolean>>;
  setBranchList: Dispatch<SetStateAction<ProjectBranchListState | null>>;
  setRecentProjectPaths: Dispatch<SetStateAction<string[]>>;
  recentProjectPaths: string[];
  projectInfo: RendererAppInfo | null;
  sessionId?: string;
  onProjectSelected(ownerSessionId?: string): void;
  toastApi: ToastApi;
}): AppShellProjectActions {
  const {
    uiLocale,
    projectPickerPendingRef,
    projectPickerRequestRef,
    rendererMountedRef,
    setAppInfo,
    setSessionProjectInfo,
    setProjectPickerPending,
    setBranchPending,
    setBranchList,
    setRecentProjectPaths,
    recentProjectPaths,
    projectInfo,
    sessionId,
    onProjectSelected,
    toastApi,
  } = deps;
  const copy = getShellCopy(uiLocale).projectActions;

  async function refreshAppInfo() {
    try {
      const next = await window.maka.app.info();
      setAppInfo({
        projectPath: next.projectPath,
        projectGit: next.projectGit,
      });
    } catch (error) {
      toastApi.error(
        copy.readPathFailedTitle,
        localizedShellErrorMessage(error, copy.readPathFailedFallback, uiLocale),
      );
    }
  }

  function addRecentProjectPath(path: string): void {
    const next = [path, ...recentProjectPaths.filter((p) => p !== path)].slice(0, MAX_RECENT_PATHS);
    setRecentProjectPaths(next);
    saveComposerDefaults({ recentProjectPaths: next });
  }

  async function selectProjectDirectory() {
    if (projectPickerPendingRef.current) return;
    const requestId = projectPickerRequestRef.current + 1;
    projectPickerRequestRef.current = requestId;
    projectPickerPendingRef.current = true;
    setProjectPickerPending(true);
    const isCurrentProjectPickerRequest = () =>
      rendererMountedRef.current && projectPickerRequestRef.current === requestId;
    try {
      const result = await window.maka.app.selectProjectDirectory();
      if (!isCurrentProjectPickerRequest()) return;
      if (!result.ok) {
        if (result.reason !== 'cancelled') {
          toastApi.error(copy.selectDirectoryFailedTitle, selectProjectDirectoryFailureCopy(result.reason, uiLocale));
        }
        return;
      }
      setAppInfo({
        projectPath: result.projectPath,
        projectGit: result.projectGit,
      });
      setBranchList(null);
      // Persist so the next "新任务" inherits the folder (and it survives reload).
      saveComposerDefaults({ projectPath: result.projectPath });
      addRecentProjectPath(result.projectPath);
      onProjectSelected(sessionId);
      toastApi.success(copy.directorySwitchedTitle, basenameFromPath(result.projectPath, uiLocale));
    } catch (error) {
      if (isCurrentProjectPickerRequest()) {
        toastApi.error(
          copy.selectDirectoryFailedTitle,
          localizedShellErrorMessage(error, copy.readPathFailedFallback, uiLocale),
        );
      }
    } finally {
      if (projectPickerRequestRef.current === requestId) {
        projectPickerPendingRef.current = false;
        if (rendererMountedRef.current) setProjectPickerPending(false);
      }
    }
  }

  async function selectRecentProjectDirectory(path: string) {
    if (projectPickerPendingRef.current) return;
    const requestId = projectPickerRequestRef.current + 1;
    projectPickerRequestRef.current = requestId;
    projectPickerPendingRef.current = true;
    setProjectPickerPending(true);
    const isCurrentProjectPickerRequest = () =>
      rendererMountedRef.current && projectPickerRequestRef.current === requestId;
    try {
      const result = await window.maka.app.selectProjectRoot(path);
      if (!isCurrentProjectPickerRequest()) return;
      if (!result.ok) {
        toastApi.error(copy.selectDirectoryFailedTitle, copy.selectedPathUnreadable);
        return;
      }
      setAppInfo({
        projectPath: result.projectPath,
        projectGit: result.projectGit,
      });
      setBranchList(null);
      saveComposerDefaults({ projectPath: result.projectPath });
      addRecentProjectPath(result.projectPath);
      onProjectSelected(sessionId);
      toastApi.success(copy.directorySwitchedTitle, basenameFromPath(result.projectPath, uiLocale));
    } catch (error) {
      if (isCurrentProjectPickerRequest()) {
        toastApi.error(
          copy.selectDirectoryFailedTitle,
          localizedShellErrorMessage(error, copy.readPathFailedFallback, uiLocale),
        );
      }
    } finally {
      if (projectPickerRequestRef.current === requestId) {
        projectPickerPendingRef.current = false;
        if (rendererMountedRef.current) setProjectPickerPending(false);
      }
    }
  }

  async function openSkillsFolder() {
    try {
      const result = await window.maka.app.openPath('skills');
      if (!result.ok) {
        toastApi.error(
          copy.openFailedTitle(openPathActionLabel('skills', uiLocale)),
          openPathFailureCopy(result.reason, uiLocale),
        );
      }
    } catch (error) {
      toastApi.error(
        copy.openFailedTitle(openPathActionLabel('skills', uiLocale)),
        openPathActionErrorMessage(error, 'skills', uiLocale),
      );
    }
  }

  async function openProjectFolder() {
    try {
      const result = await window.maka.app.openPath('project', sessionId);
      if (!result.ok) {
        toastApi.error(
          copy.openFailedTitle(openPathActionLabel('project', uiLocale)),
          openPathFailureCopy(result.reason, uiLocale),
        );
      }
    } catch (error) {
      if (isSessionWorkspaceUnavailableError(error)) {
        showSessionWorkspaceUnavailableToast(toastApi, uiLocale);
      } else {
        toastApi.error(
          copy.openFailedTitle(openPathActionLabel('project', uiLocale)),
          openPathActionErrorMessage(error, 'project', uiLocale),
        );
      }
    }
  }

  async function openWorkspaceFolder() {
    try {
      const result = await window.maka.app.openPath('workspace');
      if (!result.ok) {
        toastApi.error(
          copy.openFailedTitle(openPathActionLabel('workspace', uiLocale)),
          openPathFailureCopy(result.reason, uiLocale),
        );
      }
    } catch (error) {
      toastApi.error(
        copy.openFailedTitle(openPathActionLabel('workspace', uiLocale)),
        openPathActionErrorMessage(error, 'workspace', uiLocale),
      );
    }
  }

  async function listGitBranches(sessionId?: string): Promise<{ branches: string[]; current?: string } | null> {
    try {
      const result = await window.maka.app.listGitBranches(sessionId);
      if (!result.ok || !result.branches) {
        if (result.reason && result.reason !== 'not-a-repo') {
          toastApi.error(copy.branchListFailedTitle, result.message ?? copy.branchListFallback);
        }
        return null;
      }
      const next = { branches: result.branches, current: result.current };
      setBranchList({ contextKey: sessionId ?? null, ...next });
      return next;
    } catch (error) {
      if (isSessionWorkspaceUnavailableError(error)) {
        showSessionWorkspaceUnavailableToast(toastApi, uiLocale);
      } else {
        toastApi.error(
          copy.branchListFailedTitle,
          localizedShellErrorMessage(error, copy.branchListFallback, uiLocale),
        );
      }
      return null;
    }
  }

  async function checkoutGitBranch(branch: string, sessionId?: string): Promise<void> {
    if (!branch) return;
    setBranchPending(true);
    try {
      const result = await window.maka.app.checkoutGitBranch(branch, sessionId);
      if (!result.ok) {
        toastApi.error(copy.branchCheckoutFailedTitle, result.message ?? copy.branchCheckoutFallback(branch));
        return;
      }
      const nextBranch = result.branch ?? branch;
      setAppInfo((prev) =>
        prev && prev.projectPath === projectInfo?.projectPath
          ? { ...prev, projectGit: { isGitRepo: true, branch: nextBranch } }
          : prev,
      );
      setSessionProjectInfo((prev) =>
        prev && prev.projectPath === projectInfo?.projectPath
          ? { ...prev, projectGit: { isGitRepo: true, branch: nextBranch } }
          : prev,
      );
      setBranchList((prev) => (prev?.contextKey === (sessionId ?? null) ? { ...prev, current: nextBranch } : prev));
      toastApi.success(copy.branchCheckoutSuccessTitle, nextBranch);
    } catch (error) {
      if (isSessionWorkspaceUnavailableError(error)) {
        showSessionWorkspaceUnavailableToast(toastApi, uiLocale);
      } else {
        toastApi.error(
          copy.branchCheckoutFailedTitle,
          localizedShellErrorMessage(error, copy.branchCheckoutFallback(branch), uiLocale),
        );
      }
    } finally {
      setBranchPending(false);
    }
  }

  return {
    refreshAppInfo,
    selectProjectDirectory,
    selectRecentProjectDirectory,
    openProjectFolder,
    openWorkspaceFolder,
    openSkillsFolder,
    listGitBranches,
    checkoutGitBranch,
  };
}
