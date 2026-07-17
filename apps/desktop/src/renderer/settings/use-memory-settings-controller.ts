import { useEffect, useMemo, useRef, useState } from 'react';
import type { AppSettings, LocalMemoryState } from '@maka/core';
import {
  appendManualLocalMemoryEntryDraft,
  findLocalMemoryEntryDraftRange,
  setLocalMemoryEntryStatusDraft,
} from '@maka/core';
import { useToast, useUiLocale } from '@maka/ui';
import { openPathFailureCopy, openPathActionLabel } from '../open-path';
import { settingsActionErrorMessage } from './settings-error-copy';
import {
  formatLocalMemorySaveSummary,
  localMemoryBackupKindLabel,
  localMemoryBackupSummary,
  memoryEntryStatusLabel,
  memoryOriginLabel,
} from './memory-settings-labels';
import { deriveMemorySettingsViewModel } from './memory-settings-view-model';
import { useKeyedActionGuard } from './use-action-guard';

export interface MemoryDocumentControllerProps {
  settings: AppSettings;
  onReloadSettings(): Promise<void>;
}

/** Owns the MEMORY.md document lifecycle; workspace instructions have a separate authority. */
export function useMemoryDocumentController(props: MemoryDocumentControllerProps) {
  const locale = useUiLocale();
  type MemoryWriteAction = 'reload' | 'enable' | 'agent-read' | 'save' | 'reset' | 'restore' | 'entry-status';

  const [state, setState] = useState<LocalMemoryState | null>(null);
  const [draft, setDraft] = useState('');
  const [newMemoryTitle, setNewMemoryTitle] = useState('');
  const [newMemoryTags, setNewMemoryTags] = useState('');
  const [newMemoryContent, setNewMemoryContent] = useState('');
  const [memoryEntryQuery, setMemoryEntryQuery] = useState('');
  const [lastSaveSummary, setLastSaveSummary] = useState<{
    title: string;
    detail: string;
    savedAt: number;
  } | null>(null);
  const [loadingMemory, setLoadingMemory] = useState(true);
  const [busy, setBusy] = useState(false);
  const [pendingMemoryWriteAction, setPendingMemoryWriteAction] = useState<MemoryWriteAction | null>(null);
  const [pendingMemoryActions, setPendingMemoryActions] = useState<Set<string>>(() => new Set());
  const editorRef = useRef<HTMLTextAreaElement | null>(null);
  // One keyed guard holds both the single write latch (key 'write', the old
  // memoryWriteBusyRef) and the per-action latches (the old
  // pendingMemoryActionKeysRef set) with owner-checked releases.
  const memoryActionGuard = useKeyedActionGuard<string>();
  const memoryPageMountedRef = useRef(false);
  const memoryPageLifecycleRef = useRef(0);
  const memoryReloadTicketRef = useRef(0);
  const toast = useToast();

  useEffect(() => {
    memoryPageLifecycleRef.current += 1;
    memoryPageMountedRef.current = true;
    const lifecycle = memoryPageLifecycleRef.current;
    return () => {
      if (memoryPageLifecycleRef.current !== lifecycle) return;
      memoryPageMountedRef.current = false;
      memoryReloadTicketRef.current += 1;
    };
  }, []);

  function isMemoryPageCurrent(lifecycle: number): boolean {
    return memoryPageMountedRef.current && memoryPageLifecycleRef.current === lifecycle;
  }

  async function runMemoryWriteAction<T>(
    action: MemoryWriteAction,
    run: (isCurrent: () => boolean) => Promise<T>,
  ): Promise<T | undefined> {
    const releaseWrite = memoryActionGuard.begin('write');
    if (!releaseWrite) return undefined;
    const lifecycle = memoryPageLifecycleRef.current;
    setPendingMemoryWriteAction(action);
    setBusy(true);
    try {
      return await run(() => isMemoryPageCurrent(lifecycle));
    } catch (error) {
      if (!isMemoryPageCurrent(lifecycle)) return undefined;
      throw error;
    } finally {
      releaseWrite();
      if (isMemoryPageCurrent(lifecycle)) {
        setPendingMemoryWriteAction(null);
        setBusy(false);
      }
    }
  }

  async function runMemoryAction<T>(
    key: string,
    action: (isCurrent: () => boolean) => Promise<T>,
  ): Promise<T | undefined> {
    const release = memoryActionGuard.begin(key);
    if (!release) return undefined;
    const lifecycle = memoryPageLifecycleRef.current;
    setPendingMemoryActions((current) => new Set(current).add(key));
    try {
      return await action(() => isMemoryPageCurrent(lifecycle));
    } catch (error) {
      if (!isMemoryPageCurrent(lifecycle)) return undefined;
      throw error;
    } finally {
      release();
      if (isMemoryPageCurrent(lifecycle)) {
        setPendingMemoryActions((current) => {
          const next = new Set(current);
          next.delete(key);
          return next;
        });
      }
    }
  }

  async function reload(): Promise<boolean> {
    const lifecycle = memoryPageLifecycleRef.current;
    const ticket = ++memoryReloadTicketRef.current;
    try {
      const next = await window.maka.memory.getState();
      if (!isMemoryPageCurrent(lifecycle) || ticket !== memoryReloadTicketRef.current) return false;
      setState(next);
      setDraft(next.content);
      setLastSaveSummary(null);
      return true;
    } catch (error) {
      if (isMemoryPageCurrent(lifecycle) && ticket === memoryReloadTicketRef.current) {
        toast.error('载入本地记忆失败', settingsActionErrorMessage(error));
      }
      return false;
    } finally {
      if (isMemoryPageCurrent(lifecycle) && ticket === memoryReloadTicketRef.current) {
        setLoadingMemory(false);
      }
    }
  }

  async function reloadDraftFromDisk() {
    await runMemoryWriteAction('reload', async (isCurrent) => {
      const ok = await reload();
      if (ok && isCurrent()) toast.success('已重新载入 MEMORY.md', '未保存的草稿修改已丢弃。');
    });
  }

  useEffect(() => {
    void reload();
  }, []);

  async function setEnabled(enabled: boolean) {
    try {
      await runMemoryWriteAction('enable', async (isCurrent) => {
        const next = await window.maka.memory.setEnabled(enabled);
        await props.onReloadSettings();
        if (!isCurrent()) return;
        setState(next);
        setDraft(next.content);
      });
    } catch (error) {
      toast.error('更新本地记忆开关失败', settingsActionErrorMessage(error));
    }
  }

  async function setAgentReadEnabled(agentReadEnabled: boolean) {
    try {
      await runMemoryWriteAction('agent-read', async (isCurrent) => {
        const next = await window.maka.memory.setAgentReadEnabled(agentReadEnabled);
        await props.onReloadSettings();
        if (!isCurrent()) return;
        setState(next);
        setDraft(next.content);
      });
    } catch (error) {
      toast.error('更新模型读取权限失败', settingsActionErrorMessage(error));
    }
  }

  async function save() {
    try {
      await runMemoryWriteAction('save', async (isCurrent) => {
        const next = await window.maka.memory.save(draft);
        if (!isCurrent()) return;
        const redacted = next.content !== draft;
        setState(next);
        setDraft(next.content);
        if (next.status === 'safe_mode') {
          setLastSaveSummary(null);
          toast.error('保存被拦截', 'MEMORY.md 内容过大，已进入安全模式。');
        } else if (redacted) {
          const detail = `写入前已替换疑似 token、API key 或密码；${formatLocalMemorySaveSummary(next)}`;
          setLastSaveSummary({
            title: '已保存并遮蔽敏感字段',
            detail,
            savedAt: Date.now(),
          });
          toast.success('已保存并遮蔽敏感字段', detail);
        } else {
          const detail = formatLocalMemorySaveSummary(next);
          setLastSaveSummary({
            title: '已保存 MEMORY.md',
            detail,
            savedAt: Date.now(),
          });
          toast.success('已保存 MEMORY.md', detail);
        }
      });
    } catch (error) {
      toast.error('保存 MEMORY.md 失败', settingsActionErrorMessage(error));
    }
  }

  async function reset() {
    try {
      await runMemoryWriteAction('reset', async (isCurrent) => {
        const next = await window.maka.memory.reset();
        if (!isCurrent()) return;
        setState(next);
        setDraft(next.content);
        setLastSaveSummary(null);
        toast.success('已重置 MEMORY.md', '上一版已保存为备份文件。');
      });
    } catch (error) {
      toast.error('重置 MEMORY.md 失败', settingsActionErrorMessage(error));
    }
  }

  async function restoreLatestBackup() {
    await runMemoryAction('backup:latest:restore', async () => {
      try {
        await runMemoryWriteAction('restore', async (isCurrent) => {
          const backup = state?.latestBackup;
          if (!backup) {
            toast.error('没有可恢复备份', '保存或重置 MEMORY.md 后才会生成上一版备份。');
            return;
          }
          const backupLabel = `${localMemoryBackupKindLabel(backup.kind)} · ${localMemoryBackupSummary(backup)} · ${new Date(backup.updatedAt).toLocaleString()}`;
          const ok = await toast.confirm({
            title: '恢复上一版 MEMORY.md？',
            description: `会先备份当前 MEMORY.md，再用最近一次备份覆盖当前文件。将恢复：${backupLabel}`,
            confirmLabel: '恢复',
            cancelLabel: '取消',
            destructive: true,
          });
          if (!ok) return;
          if (!isCurrent()) return;
          const result = await window.maka.memory.restoreLatestBackup();
          if (!isCurrent()) return;
          setState(result.state);
          setDraft(result.state.content);
          setLastSaveSummary(null);
          if (result.ok) {
            toast.success('已恢复上一版 MEMORY.md', `${backupLabel}；恢复前的当前文件已保存为 restore.bak。`);
          } else {
            toast.error('恢复失败', result.message);
          }
        });
      } catch (error) {
        toast.error('恢复上一版失败', settingsActionErrorMessage(error));
      }
    });
  }

  async function restoreBackupCandidate(backup: NonNullable<LocalMemoryState['latestBackup']>) {
    await runMemoryAction(`backup:${backup.kind}:restore`, async () => {
      try {
        await runMemoryWriteAction('restore', async (isCurrent) => {
          const backupLabel = `${localMemoryBackupKindLabel(backup.kind)} · ${localMemoryBackupSummary(backup)} · ${new Date(backup.updatedAt).toLocaleString()}`;
          const ok = await toast.confirm({
            title: '恢复这个 MEMORY.md 备份？',
            description: `会先备份当前 MEMORY.md，再用选中的备份覆盖当前文件。将恢复：${backupLabel}`,
            confirmLabel: '恢复',
            cancelLabel: '取消',
            destructive: true,
          });
          if (!ok) return;
          if (!isCurrent()) return;
          const result = await window.maka.memory.restoreBackup(backup.kind);
          if (!isCurrent()) return;
          setState(result.state);
          setDraft(result.state.content);
          setLastSaveSummary(null);
          if (result.ok) {
            toast.success('已恢复 MEMORY.md 备份候选', `${backupLabel}；恢复前的当前文件已保存为 restore.bak。`);
          } else {
            toast.error('恢复失败', result.message);
          }
        });
      } catch (error) {
        toast.error('恢复备份失败', settingsActionErrorMessage(error));
      }
    });
  }

  async function openFile() {
    await runMemoryAction('memory:file:open', async (isCurrent) => {
      try {
        const result = await window.maka.memory.openFile();
        if (!isCurrent()) return;
        if (!result.ok) toast.error('打开失败', result.message);
      } catch (error) {
        if (isCurrent()) toast.error('打开失败', settingsActionErrorMessage(error));
      }
    });
  }

  async function openLatestBackup() {
    await runMemoryAction('backup:latest:open', async (isCurrent) => {
      try {
        const result = await window.maka.memory.openLatestBackup();
        if (!isCurrent()) return;
        if (!result.ok) toast.error('打开上一版失败', result.message);
      } catch (error) {
        if (isCurrent()) toast.error('打开上一版失败', settingsActionErrorMessage(error));
      }
    });
  }

  async function openBackupCandidate(backup: NonNullable<LocalMemoryState['latestBackup']>) {
    await runMemoryAction(`backup:${backup.kind}:open`, async (isCurrent) => {
      try {
        const result = await window.maka.memory.openBackup(backup.kind);
        if (!isCurrent()) return;
        if (!result.ok) {
          toast.error(`打开${localMemoryBackupKindLabel(backup.kind)}失败`, result.message);
        }
      } catch (error) {
        if (isCurrent())
          toast.error(`打开${localMemoryBackupKindLabel(backup.kind)}失败`, settingsActionErrorMessage(error));
      }
    });
  }

  async function openFolder() {
    await runMemoryAction('memory:folder:open', async (isCurrent) => {
      try {
        const result = await window.maka.app.openPath('memory');
        if (!isCurrent()) return;
        if (!result.ok) {
          toast.error(`打开${openPathActionLabel('memory', locale)}失败`, openPathFailureCopy(result.reason, locale));
        }
      } catch (error) {
        if (isCurrent())
          toast.error(`打开${openPathActionLabel('memory', locale)}失败`, settingsActionErrorMessage(error));
      }
    });
  }

  async function copyPath() {
    await runMemoryAction('memory:path:copy', async (isCurrent) => {
      if (!state?.path) return;
      try {
        await navigator.clipboard.writeText(state.path);
        if (isCurrent()) toast.success('已复制路径', state.path);
      } catch {
        if (isCurrent()) toast.error('复制失败', '剪贴板不可用或被系统拒绝。');
      }
    });
  }

  async function copyBackupReference(backup: NonNullable<LocalMemoryState['latestBackup']>) {
    await runMemoryAction(`backup:${backup.kind}:copy`, async (isCurrent) => {
      const reference = [
        `Memory backup: ${localMemoryBackupKindLabel(backup.kind)}`,
        `Path: ${backup.path}`,
        `Updated: ${new Date(backup.updatedAt).toISOString()}`,
        `Entries: ${localMemoryBackupSummary(backup)}`,
        `Size: ${backup.sizeBytes} bytes`,
        backup.safeMode ? `Safe mode: ${backup.reason ?? 'oversize'}` : 'Safe mode: false',
      ].join('\n');
      try {
        await navigator.clipboard.writeText(reference);
        if (isCurrent()) toast.success('已复制上一版引用', localMemoryBackupSummary(backup));
      } catch {
        if (isCurrent()) toast.error('复制失败', '剪贴板不可用或被系统拒绝。');
      }
    });
  }

  async function copyLatestBackupReference() {
    const backup = state?.latestBackup;
    if (!backup) return;
    await copyBackupReference(backup);
  }

  async function copyMemoryEntryReference(entry: LocalMemoryState['entries'][number]) {
    await runMemoryAction(`entry:${entry.id}:copy`, async (isCurrent) => {
      const reference = [
        `Memory entry: ${entry.title}`,
        `ID: ${entry.id}`,
        `Status: ${memoryEntryStatusLabel(entry.status)}`,
        `Origin: ${memoryOriginLabel(entry.origin)}`,
        entry.createdAt === undefined ? '' : `Created: ${new Date(entry.createdAt).toISOString()}`,
        entry.updatedAt === undefined ? '' : `Updated: ${new Date(entry.updatedAt).toISOString()}`,
        entry.tags.length > 0 ? `Tags: ${entry.tags.join(', ')}` : '',
      ]
        .filter(Boolean)
        .join('\n');
      try {
        await navigator.clipboard.writeText(reference);
        if (isCurrent()) toast.success('已复制记忆引用', entry.id);
      } catch {
        if (isCurrent()) toast.error('复制失败', '剪贴板不可用或被系统拒绝。');
      }
    });
  }

  function focusMemoryEntryInDraft(entry: LocalMemoryState['entries'][number]) {
    const range = findLocalMemoryEntryDraftRange(draft, entry.id);
    if (!range) {
      toast.error('无法定位记忆', '当前草稿里找不到这条记忆；请先保存或刷新后重试。');
      return;
    }
    requestAnimationFrame(() => {
      editorRef.current?.focus();
      editorRef.current?.setSelectionRange(range.start, range.end);
      editorRef.current?.scrollIntoView({
        block: 'center',
        behavior: 'smooth',
      });
    });
  }

  function addManualMemoryDraftEntry() {
    const result = appendManualLocalMemoryEntryDraft(draft, {
      title: newMemoryTitle,
      content: newMemoryContent,
      tags: newMemoryTags.split(','),
    });
    if (!result.ok) {
      switch (result.reason) {
        case 'empty_title':
          toast.error('标题不能为空', '给这条记忆起一个短标题。');
          return;
        case 'empty_content':
          toast.error('内容不能为空', '写下要保留的偏好或事实。');
          return;
        case 'oversize':
          toast.error('草稿过大', 'MEMORY.md 超出安全上限，请先删减旧内容。');
          return;
      }
    }
    setDraft(result.draft);
    setNewMemoryTitle('');
    setNewMemoryTags('');
    setNewMemoryContent('');
    toast.success('已添加到草稿', '确认文件内容后点击保存。');
    requestAnimationFrame(() => {
      editorRef.current?.focus();
      editorRef.current?.setSelectionRange(result.draft.length, result.draft.length);
    });
  }

  async function updateMemoryEntryStatus(
    entry: LocalMemoryState['activeEntries'][number],
    status: 'active' | 'archived',
  ) {
    const result = setLocalMemoryEntryStatusDraft(draft, {
      id: entry.id,
      status,
    });
    if (!result.ok) {
      switch (result.reason) {
        case 'invalid_id':
          toast.error('无法更新记忆', '这条记忆没有可识别 ID，已停止更新。');
          return;
        case 'not_found':
          toast.error('无法更新记忆', '当前草稿里找不到这条记忆；请先保存或刷新后重试。');
          return;
        case 'oversize':
          toast.error('无法更新记忆', 'MEMORY.md 超出安全上限，请先删减旧内容。');
          return;
      }
    }

    if (memoryDraftDirty) {
      setDraft(result.draft);
      toast.success(status === 'archived' ? '已在草稿中归档记忆' : '已在草稿中恢复记忆', '确认文件内容后点击保存。');
      return;
    }

    try {
      await runMemoryWriteAction('entry-status', async (isCurrent) => {
        const next = await window.maka.memory.save(result.draft);
        if (!isCurrent()) return;
        setState(next);
        setDraft(next.content);
        if (next.status === 'safe_mode') {
          toast.error('更新被拦截', 'MEMORY.md 内容过大，已进入安全模式。');
        } else {
          toast.success(status === 'archived' ? '已归档记忆' : '已恢复记忆', entry.title);
        }
      });
    } catch (error) {
      toast.error(status === 'archived' ? '归档记忆失败' : '恢复记忆失败', settingsActionErrorMessage(error));
    }
  }

  const viewModel = useMemo(
    () =>
      deriveMemorySettingsViewModel({
      state,
      localMemorySettings: props.settings.localMemory,
      draft,
      query: memoryEntryQuery,
    }),
    [state, props.settings, draft, memoryEntryQuery],
  );
  const {
    effective,
    memoryDraftDirty,
    visibleMemoryEntries,
    memoryEntryPreviewBlockedReason,
    normalizedMemoryEntryQuery,
    filteredActiveEntries,
    filteredArchivedEntries,
    filteredEntryCount,
    localMemoryPromptPreview,
    promptPreviewBlockedReason,
    promptPreviewWillInject,
    localMemoryPromptPreviewBudgetLabel,
    memoryDraftHasSensitiveFields,
  } = viewModel;
  const memoryControlsDisabled = loadingMemory || busy;
  const isMemoryActionPending = (key: string) => pendingMemoryActions.has(key);

  async function copyLocalMemoryPromptPreview() {
    if (!localMemoryPromptPreview) return;
    await runMemoryAction('memory:prompt-preview:copy', async (isCurrent) => {
      try {
        await navigator.clipboard.writeText(localMemoryPromptPreview);
        if (isCurrent()) toast.success('已复制模型上下文预览', '使用同一条 prompt 预览和遮蔽路径。');
      } catch {
        if (isCurrent()) toast.error('复制失败', '剪贴板不可用或被系统拒绝。');
      }
    });
  }

  return {
    draft,
    setDraft,
    newMemoryTitle,
    setNewMemoryTitle,
    newMemoryTags,
    setNewMemoryTags,
    newMemoryContent,
    setNewMemoryContent,
    memoryEntryQuery,
    setMemoryEntryQuery,
    lastSaveSummary,
    pendingMemoryWriteAction,
    pendingMemoryActions,
    editorRef,
    reloadDraftFromDisk,
    setEnabled,
    setAgentReadEnabled,
    save,
    reset,
    restoreLatestBackup,
    restoreBackupCandidate,
    openFile,
    openLatestBackup,
    openBackupCandidate,
    openFolder,
    copyPath,
    copyBackupReference,
    copyLatestBackupReference,
    copyMemoryEntryReference,
    focusMemoryEntryInDraft,
    addManualMemoryDraftEntry,
    updateMemoryEntryStatus,
    effective,
    memoryDraftDirty,
    visibleMemoryEntries,
    memoryEntryPreviewBlockedReason,
    normalizedMemoryEntryQuery,
    filteredActiveEntries,
    filteredArchivedEntries,
    filteredEntryCount,
    localMemoryPromptPreview,
    promptPreviewBlockedReason,
    promptPreviewWillInject,
    localMemoryPromptPreviewBudgetLabel,
    memoryDraftHasSensitiveFields,
    memoryControlsDisabled,
    isMemoryActionPending,
    copyLocalMemoryPromptPreview,
  };
}
