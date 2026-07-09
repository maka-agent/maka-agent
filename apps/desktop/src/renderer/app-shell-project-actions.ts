import type { Dispatch, SetStateAction } from 'react';
import { generalizedErrorMessageChinese } from '@maka/core';
import { basenameFromPath, openPathActionErrorMessage, selectProjectDirectoryFailureCopy } from './app-shell-copy';
import { openPathActionLabel, openPathFailureCopy } from './open-path';
import { MAX_RECENT_PATHS, saveComposerDefaults } from './composer-defaults';

export interface RendererAppInfo {
  projectPath: string;
  projectGit: { isGitRepo: boolean; branch?: string };
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
  listGitBranches(): Promise<{ branches: string[]; current?: string } | null>;
  checkoutGitBranch(branch: string): Promise<void>;
}

export function createAppShellProjectActions(deps: {
  projectPickerPendingRef: RefBox<boolean>;
  projectPickerRequestRef: RefBox<number>;
  rendererMountedRef: RefBox<boolean>;
  setAppInfo: Dispatch<SetStateAction<RendererAppInfo | null>>;
  setProjectPickerPending: Dispatch<SetStateAction<boolean>>;
  setBranchPending: Dispatch<SetStateAction<boolean>>;
  setBranchList: Dispatch<SetStateAction<{ branches: string[]; current?: string } | null>>;
  setRecentProjectPaths: Dispatch<SetStateAction<string[]>>;
  recentProjectPaths: string[];
  toastApi: ToastApi;
}): AppShellProjectActions {
  const {
    projectPickerPendingRef,
    projectPickerRequestRef,
    rendererMountedRef,
    setAppInfo,
    setProjectPickerPending,
    setBranchPending,
    setBranchList,
    setRecentProjectPaths,
    recentProjectPaths,
    toastApi,
  } = deps;

  async function refreshAppInfo() {
    try {
      const next = await window.maka.app.info();
      setAppInfo({ projectPath: next.projectPath, projectGit: next.projectGit });
    } catch (error) {
      toastApi.error('读取项目路径失败', generalizedErrorMessageChinese(error, '项目路径暂时无法读取，请稍后重试。'));
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
    const isCurrentProjectPickerRequest = () => rendererMountedRef.current && projectPickerRequestRef.current === requestId;
    try {
      const result = await window.maka.app.selectProjectDirectory();
      if (!isCurrentProjectPickerRequest()) return;
      if (!result.ok) {
        if (result.reason !== 'cancelled') {
          toastApi.error('选择工作目录失败', selectProjectDirectoryFailureCopy(result.reason));
        }
        return;
      }
      setAppInfo({ projectPath: result.projectPath, projectGit: result.projectGit });
      setBranchList(null);
      // Persist so the next "新任务" inherits the folder (and it survives reload).
      saveComposerDefaults({ projectPath: result.projectPath });
      addRecentProjectPath(result.projectPath);
      toastApi.success('已切换工作目录', basenameFromPath(result.projectPath));
    } catch (error) {
      if (isCurrentProjectPickerRequest()) {
        toastApi.error('选择工作目录失败', generalizedErrorMessageChinese(error, '项目路径暂时无法读取，请稍后重试。'));
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
    const isCurrentProjectPickerRequest = () => rendererMountedRef.current && projectPickerRequestRef.current === requestId;
    try {
      const result = await window.maka.app.selectProjectRoot(path);
      if (!isCurrentProjectPickerRequest()) return;
      if (!result.ok) {
        toastApi.error('选择工作目录失败', '所选路径不存在或不可读。');
        return;
      }
      setAppInfo({ projectPath: result.projectPath, projectGit: result.projectGit });
      setBranchList(null);
      saveComposerDefaults({ projectPath: result.projectPath });
      addRecentProjectPath(result.projectPath);
      toastApi.success('已切换工作目录', basenameFromPath(result.projectPath));
    } catch (error) {
      if (isCurrentProjectPickerRequest()) {
        toastApi.error('选择工作目录失败', generalizedErrorMessageChinese(error, '项目路径暂时无法读取，请稍后重试。'));
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
        toastApi.error(`无法打开${openPathActionLabel('skills')}`, openPathFailureCopy(result.reason));
      }
    } catch (error) {
      toastApi.error(`无法打开${openPathActionLabel('skills')}`, openPathActionErrorMessage(error, 'skills'));
    }
  }

  async function openProjectFolder() {
    try {
      const result = await window.maka.app.openPath('project');
      if (!result.ok) {
        toastApi.error(`无法打开${openPathActionLabel('project')}`, openPathFailureCopy(result.reason));
      }
    } catch (error) {
      toastApi.error(`无法打开${openPathActionLabel('project')}`, openPathActionErrorMessage(error, 'project'));
    }
  }

  async function openWorkspaceFolder() {
    try {
      const result = await window.maka.app.openPath('workspace');
      if (!result.ok) {
        toastApi.error(`无法打开${openPathActionLabel('workspace')}`, openPathFailureCopy(result.reason));
      }
    } catch (error) {
      toastApi.error(`无法打开${openPathActionLabel('workspace')}`, openPathActionErrorMessage(error, 'workspace'));
    }
  }

  async function listGitBranches(): Promise<{ branches: string[]; current?: string } | null> {
    try {
      const result = await window.maka.app.listGitBranches();
      if (!result.ok || !result.branches) {
        if (result.reason && result.reason !== 'not-a-repo') {
          toastApi.error('读取分支列表失败', result.message ?? '无法读取本地分支,请稍后重试。');
        }
        return null;
      }
      const next = { branches: result.branches, current: result.current };
      setBranchList(next);
      return next;
    } catch (error) {
      toastApi.error('读取分支列表失败', generalizedErrorMessageChinese(error, '无法读取本地分支,请稍后重试。'));
      return null;
    }
  }

  async function checkoutGitBranch(branch: string): Promise<void> {
    if (!branch) return;
    setBranchPending(true);
    try {
      const result = await window.maka.app.checkoutGitBranch(branch);
      if (!result.ok) {
        toastApi.error('切换分支失败', result.message ?? `无法切换到分支 ${branch}。`);
        return;
      }
      setAppInfo((prev) =>
        prev ? { ...prev, projectGit: { isGitRepo: true, branch: result.branch ?? branch } } : prev,
      );
      toastApi.success('已切换分支', result.branch ?? branch);
    } catch (error) {
      toastApi.error('切换分支失败', generalizedErrorMessageChinese(error, `无法切换到分支 ${branch}。`));
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
