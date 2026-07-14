import { useRef, useState } from 'react';
import type { ComposerDefaults } from './composer-defaults';
import {
  createAppShellProjectActions,
  type AppShellProjectActions,
  type RendererAppInfo,
} from './app-shell-project-actions';

type RefBox<T> = { current: T };

type ToastApi = {
  success(title: string, description?: string): void;
  error(title: string, description?: string): void;
};

/**
 * Owns the workspace / project-picker cluster: the resolved app info
 * (project path + git status), the branch list + its in-flight flag, the
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
  persistedComposerDefaults: ComposerDefaults | null;
  rendererMountedRef: RefBox<boolean>;
  toastApi: ToastApi;
}): AppShellProjectActions & {
  appInfo: RendererAppInfo | null;
  branchList: { branches: string[]; current?: string } | null;
  branchPending: boolean;
  recentProjectPaths: string[];
  projectPickerPending: boolean;
  projectPickerPendingRef: RefBox<boolean>;
  projectPickerRequestRef: RefBox<number>;
} {
  const { persistedComposerDefaults, rendererMountedRef, toastApi } = options;
  const [appInfo, setAppInfo] = useState<RendererAppInfo | null>(
    persistedComposerDefaults?.projectPath
      ? { projectPath: persistedComposerDefaults.projectPath, projectGit: { isGitRepo: false } }
      : null,
  );
  const [branchList, setBranchList] = useState<{ branches: string[]; current?: string } | null>(null);
  const [branchPending, setBranchPending] = useState(false);
  const [recentProjectPaths, setRecentProjectPaths] = useState<string[]>(
    persistedComposerDefaults?.recentProjectPaths ?? [],
  );
  const [projectPickerPending, setProjectPickerPending] = useState(false);
  const projectPickerPendingRef = useRef(false);
  const projectPickerRequestRef = useRef(0);

  const actions = createAppShellProjectActions({
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
  });

  return {
    appInfo,
    branchList,
    branchPending,
    recentProjectPaths,
    projectPickerPending,
    projectPickerPendingRef,
    projectPickerRequestRef,
    ...actions,
  };
}
