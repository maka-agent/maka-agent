import { useEffect, useRef, useState } from 'react';
import type { UpdateAppSettingsResult } from '@maka/core';
import { useToast } from '@maka/ui';
import { settingsActionErrorMessage } from './settings-error-copy';

type WorkspaceInstructionState = Awaited<ReturnType<typeof window.maka.workspaceInstructions.getState>>;

export interface WorkspaceInstructionsControllerProps {
  onUpdate(patch: Parameters<typeof window.maka.settings.update>[0]): Promise<UpdateAppSettingsResult>;
  onReloadSettings(): Promise<void>;
}

export function useWorkspaceInstructionsController(props: WorkspaceInstructionsControllerProps) {
  const [state, setState] = useState<WorkspaceInstructionState | null>(null);
  const [loading, setLoading] = useState(true);
  const [pendingActions, setPendingActions] = useState<Set<string>>(() => new Set());
  const mountedRef = useRef(false);
  const lifecycleRef = useRef(0);
  const pendingActionOwnersRef = useRef<Map<string, number>>(new Map());
  const actionOwnerSequenceRef = useRef(0);
  const writeOwnerRef = useRef<number | null>(null);
  const toast = useToast();

  useEffect(() => {
    const lifecycle = ++lifecycleRef.current;
    mountedRef.current = true;
    void reload(lifecycle);
    return () => {
      if (lifecycleRef.current !== lifecycle) return;
      mountedRef.current = false;
      pendingActionOwnersRef.current.clear();
      writeOwnerRef.current = null;
    };
  }, []);

  function isCurrent(lifecycle: number): boolean {
    return mountedRef.current && lifecycleRef.current === lifecycle;
  }

  async function reload(lifecycle = lifecycleRef.current): Promise<void> {
    try {
      const next = await window.maka.workspaceInstructions.getState();
      if (isCurrent(lifecycle)) setState(next);
    } catch (error) {
      if (isCurrent(lifecycle)) toast.error('载入项目指令失败', settingsActionErrorMessage(error));
    } finally {
      if (isCurrent(lifecycle)) setLoading(false);
    }
  }

  async function runAction(key: string, action: (isActionCurrent: () => boolean) => Promise<void>): Promise<void> {
    if (pendingActionOwnersRef.current.has(key)) return;
    const lifecycle = lifecycleRef.current;
    const owner = ++actionOwnerSequenceRef.current;
    pendingActionOwnersRef.current.set(key, owner);
    setPendingActions((current) => new Set(current).add(key));
    try {
      await action(() => isCurrent(lifecycle));
    } finally {
      if (pendingActionOwnersRef.current.get(key) === owner) {
        pendingActionOwnersRef.current.delete(key);
      }
      if (isCurrent(lifecycle)) {
        setPendingActions((current) => {
          const next = new Set(current);
          next.delete(key);
          return next;
        });
      }
    }
  }

  async function runWriteAction(
    key: string,
    action: (isActionCurrent: () => boolean) => Promise<void>,
  ): Promise<void> {
    if (writeOwnerRef.current !== null) return;
    const owner = ++actionOwnerSequenceRef.current;
    writeOwnerRef.current = owner;
    try {
      await runAction(key, action);
    } finally {
      if (writeOwnerRef.current === owner) writeOwnerRef.current = null;
    }
  }

  async function setEnabled(enabled: boolean): Promise<void> {
    await runWriteAction('instruction:settings:update', async (isActionCurrent) => {
      try {
        await props.onUpdate({ workspaceInstructions: { enabled } });
        await props.onReloadSettings();
      } catch (error) {
        if (isActionCurrent()) toast.error('更新项目指令开关失败', settingsActionErrorMessage(error));
      }
    });
  }

  async function openFile(file: string): Promise<void> {
    await runAction(`instruction:${file}:open`, async (isActionCurrent) => {
      try {
        const result = await window.maka.workspaceInstructions.openFile(file);
        if (isActionCurrent() && !result.ok) toast.error('打开项目指令失败', result.message);
      } catch (error) {
        if (isActionCurrent()) toast.error('打开项目指令失败', settingsActionErrorMessage(error));
      }
    });
  }

  async function createFile(file: string): Promise<void> {
    await runWriteAction(`instruction:${file}:create`, async (isActionCurrent) => {
      try {
        const result = await window.maka.workspaceInstructions.createFile(file);
        if (!isActionCurrent()) return;
        if (!result.ok) {
          toast.error('创建项目指令失败', result.message);
          return;
        }
        await reload();
        if (!isActionCurrent()) return;
        toast.success('已创建项目指令', file);
        await openFile(file);
      } catch (error) {
        if (isActionCurrent()) toast.error('创建项目指令失败', settingsActionErrorMessage(error));
      }
    });
  }

  return {
    state,
    busy: loading || pendingActions.has('instruction:settings:update')
      || Array.from(pendingActions).some((key) => key.endsWith(':create')),
    pendingActions,
    isActionPending: (key: string) => pendingActions.has(key),
    setEnabled,
    openFile,
    createFile,
  };
}
