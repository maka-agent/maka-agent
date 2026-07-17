import { useEffect, useRef, useState } from 'react';
import type { UiLocale } from '@maka/core';
import type { ComposerDefaults } from './composer-defaults';
import {
  createAppShellProjectActions,
  type AppShellProjectActions,
  type ProjectBranchListState,
  type RendererAppInfo,
  type SessionProjectInfoState,
} from './app-shell-project-actions';

type RefBox<T> = { current: T };

type ToastApi = {
  success(title: string, description?: string): void;
  error(title: string, description?: string): void;
};

/**
 * Owns the workspace / project-picker cluster: the new-task project, active
 * session project projection, branch list + its in-flight flag, the
 * recent-workspace history, and the project-picker pending state / dedup
 * refs. Seeds appInfo + recentProjectPaths from the persisted composer
 * defaults so the home view is populated before the async `app:info`
 * round-trip completes on mount.
 *
 * The picker refs are returned so AppShell can hand them to the bootstrap
 * unmount cleanup (which cancels an in-flight pick), and the action helpers
 * (createAppShellProjectActions) are created here so their setters never
 * have to be threaded back out through AppShell.
 */
export function useAppShellProjectContext(options: {
  uiLocale: UiLocale;
  persistedComposerDefaults: ComposerDefaults | null;
  rendererMountedRef: RefBox<boolean>;
  sessionId?: string;
  sessionCwd?: string;
  onProjectSelected(ownerSessionId?: string): void;
  toastApi: ToastApi;
}): AppShellProjectActions & {
  projectInfo: RendererAppInfo | null;
  branchList: { branches: string[]; current?: string } | null;
  branchPending: boolean;
  recentProjectPaths: string[];
  projectPickerPending: boolean;
  projectPickerPendingRef: RefBox<boolean>;
  projectPickerRequestRef: RefBox<number>;
} {
  const {
    uiLocale,
    persistedComposerDefaults,
    rendererMountedRef,
    sessionId,
    sessionCwd,
    onProjectSelected,
    toastApi,
  } = options;
  const [appInfo, setAppInfo] = useState<RendererAppInfo | null>(
    persistedComposerDefaults?.projectPath
      ? {
          projectPath: persistedComposerDefaults.projectPath,
          projectGit: { isGitRepo: false },
        }
      : null,
  );
  const [sessionProjectInfo, setSessionProjectInfo] = useState<SessionProjectInfoState | null>(null);
  const [branchListState, setBranchList] = useState<ProjectBranchListState | null>(null);
  const [branchPending, setBranchPending] = useState(false);
  const [recentProjectPaths, setRecentProjectPaths] = useState<string[]>(
    persistedComposerDefaults?.recentProjectPaths ?? [],
  );
  const [projectPickerPending, setProjectPickerPending] = useState(false);
  const projectPickerPendingRef = useRef(false);
  const projectPickerRequestRef = useRef(0);

  useEffect(() => {
    if (!sessionId) return;
    let cancelled = false;
    void window.maka.app.sessionProjectInfo(sessionId).then(
      (info) => {
        if (!cancelled) setSessionProjectInfo({ sessionId, ...info });
      },
      () => {
        // The persisted cwd below remains visible when the directory vanished;
        // operations and send surface the actionable error at their boundaries.
      },
    );
    return () => {
      cancelled = true;
    };
  }, [sessionId, sessionCwd]);

  const resolvedSessionProjectInfo =
    sessionId &&
    sessionProjectInfo?.sessionId === sessionId &&
    (!sessionCwd || sessionProjectInfo.projectPath === sessionCwd)
      ? sessionProjectInfo
      : null;
  const projectInfo = sessionId
    ? (resolvedSessionProjectInfo ??
      (sessionCwd ? { projectPath: sessionCwd, projectGit: { isGitRepo: false } } : null))
    : appInfo;
  const branchList =
    branchListState?.contextKey === (sessionId ?? null)
    ? { branches: branchListState.branches, current: branchListState.current }
    : null;

  const actions = createAppShellProjectActions({
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
  });

  return {
    projectInfo,
    branchList,
    branchPending,
    recentProjectPaths,
    projectPickerPending,
    projectPickerPendingRef,
    projectPickerRequestRef,
    ...actions,
  };
}
