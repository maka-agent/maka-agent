import { useEffect, useMemo, useRef, useState } from 'react';
import type { AppSettings, LocalMemoryState, UpdateAppSettingsResult } from '@maka/core';
import {
  LOCAL_MEMORY_PROMPT_MAX_CHARS,
  appendManualLocalMemoryEntryDraft,
  buildLocalMemoryPromptBody,
  findLocalMemoryEntryDraftRange,
  parseLocalMemoryMarkdown,
  setLocalMemoryEntryStatusDraft,
} from '@maka/core';
import { Button, Chip, Input, RelativeTime, SettingsSwitch as Switch, Textarea, redactSecrets, useToast } from '@maka/ui';
import { openPathFailureCopy, openPathActionLabel } from '../open-path';
import { settingsActionErrorMessage } from './settings-error-copy';
import { SettingsRows } from './settings-rows';

export function MemorySettingsPage(props: {
  settings: AppSettings;
  onUpdate(patch: Parameters<typeof window.maka.settings.update>[0]): Promise<UpdateAppSettingsResult>;
  onReloadSettings(): Promise<void>;
}) {
  type MemoryWriteAction =
    | 'reload'
    | 'enable'
    | 'agent-read'
    | 'workspace-instructions'
    | 'save'
    | 'reset'
    | 'restore'
    | 'entry-status'
    | 'instruction-create';

  const [state, setState] = useState<LocalMemoryState | null>(null);
  const [workspaceInstructionState, setWorkspaceInstructionState] = useState<Awaited<
    ReturnType<typeof window.maka.workspaceInstructions.getState>
  > | null>(null);
  const [draft, setDraft] = useState('');
  const [newMemoryTitle, setNewMemoryTitle] = useState('');
  const [newMemoryTags, setNewMemoryTags] = useState('');
  const [newMemoryContent, setNewMemoryContent] = useState('');
  const [memoryEntryQuery, setMemoryEntryQuery] = useState('');
  const [lastSaveSummary, setLastSaveSummary] = useState<{ title: string; detail: string; savedAt: number } | null>(null);
  const [loadingMemory, setLoadingMemory] = useState(true);
  const [busy, setBusy] = useState(false);
  const [pendingMemoryWriteAction, setPendingMemoryWriteAction] = useState<MemoryWriteAction | null>(null);
  const [pendingMemoryActions, setPendingMemoryActions] = useState<Set<string>>(() => new Set());
  const editorRef = useRef<HTMLTextAreaElement | null>(null);
  const memoryWriteBusyRef = useRef(false);
  const pendingMemoryActionKeysRef = useRef<Set<string>>(new Set());
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
      memoryWriteBusyRef.current = false;
      pendingMemoryActionKeysRef.current.clear();
    };
  }, []);

  function isMemoryPageCurrent(lifecycle: number): boolean {
    return memoryPageMountedRef.current && memoryPageLifecycleRef.current === lifecycle;
  }

  async function runMemoryWriteAction<T>(
    action: MemoryWriteAction,
    run: (isCurrent: () => boolean) => Promise<T>,
  ): Promise<T | undefined> {
    if (memoryWriteBusyRef.current) return undefined;
    const lifecycle = memoryPageLifecycleRef.current;
    memoryWriteBusyRef.current = true;
    setPendingMemoryWriteAction(action);
    setBusy(true);
    try {
      return await run(() => isMemoryPageCurrent(lifecycle));
    } catch (error) {
      if (!isMemoryPageCurrent(lifecycle)) return undefined;
      throw error;
    } finally {
      memoryWriteBusyRef.current = false;
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
    if (pendingMemoryActionKeysRef.current.has(key)) return undefined;
    const lifecycle = memoryPageLifecycleRef.current;
    pendingMemoryActionKeysRef.current.add(key);
    setPendingMemoryActions((current) => new Set(current).add(key));
    try {
      return await action(() => isMemoryPageCurrent(lifecycle));
    } catch (error) {
      if (!isMemoryPageCurrent(lifecycle)) return undefined;
      throw error;
    } finally {
      pendingMemoryActionKeysRef.current.delete(key);
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
      const [next, instructions] = await Promise.all([
        window.maka.memory.getState(),
        window.maka.workspaceInstructions.getState(),
      ]);
      if (!isMemoryPageCurrent(lifecycle) || ticket !== memoryReloadTicketRef.current) return false;
      setState(next);
      setWorkspaceInstructionState(instructions);
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

  async function setWorkspaceInstructionsEnabled(enabled: boolean) {
    try {
      await runMemoryWriteAction('workspace-instructions', async () => {
        await props.onUpdate({ workspaceInstructions: { enabled } });
        await props.onReloadSettings();
      });
    } catch (error) {
      toast.error('更新项目指令开关失败', settingsActionErrorMessage(error));
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
          setLastSaveSummary({ title: '已保存并遮蔽敏感字段', detail, savedAt: Date.now() });
          toast.success('已保存并遮蔽敏感字段', detail);
        } else {
          const detail = formatLocalMemorySaveSummary(next);
          setLastSaveSummary({ title: '已保存 MEMORY.md', detail, savedAt: Date.now() });
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
        if (isCurrent()) toast.error(`打开${localMemoryBackupKindLabel(backup.kind)}失败`, settingsActionErrorMessage(error));
      }
    });
  }

  async function openFolder() {
    await runMemoryAction('memory:folder:open', async (isCurrent) => {
      try {
        const result = await window.maka.app.openPath('memory');
        if (!isCurrent()) return;
        if (!result.ok) {
          toast.error(`打开${openPathActionLabel('memory')}失败`, openPathFailureCopy(result.reason));
        }
      } catch (error) {
        if (isCurrent()) toast.error(`打开${openPathActionLabel('memory')}失败`, settingsActionErrorMessage(error));
      }
    });
  }

  async function openWorkspaceInstructionFile(file: string) {
    await runMemoryAction(`instruction:${file}:open`, async (isCurrent) => {
      try {
        const result = await window.maka.workspaceInstructions.openFile(file);
        if (!isCurrent()) return;
        if (!result.ok) {
          toast.error('打开项目指令失败', result.message);
        }
      } catch (error) {
        if (isCurrent()) toast.error('打开项目指令失败', settingsActionErrorMessage(error));
      }
    });
  }

  async function createWorkspaceInstructionFile(file: string) {
    await runMemoryAction(`instruction:${file}:create`, async (isActionCurrent) => {
      try {
        await runMemoryWriteAction('instruction-create', async (isCurrent) => {
          const result = await window.maka.workspaceInstructions.createFile(file);
          if (!isCurrent()) return;
          if (!result.ok) {
            toast.error('创建项目指令失败', result.message);
            return;
          }
          const instructions = await window.maka.workspaceInstructions.getState();
          if (!isCurrent()) return;
          setWorkspaceInstructionState(instructions);
          toast.success('已创建项目指令', file);
          await openWorkspaceInstructionFile(file);
        });
      } catch (error) {
        if (isActionCurrent()) toast.error('创建项目指令失败', settingsActionErrorMessage(error));
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
      ].filter(Boolean).join('\n');
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
      editorRef.current?.scrollIntoView({ block: 'center', behavior: 'smooth' });
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

  async function updateMemoryEntryStatus(entry: LocalMemoryState['activeEntries'][number], status: 'active' | 'archived') {
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

  const effective = state ?? {
    path: '',
    enabled: props.settings.localMemory.enabled,
    agentReadEnabled: props.settings.localMemory.agentReadEnabled,
    status: 'disabled',
    content: '',
    entryCount: 0,
    activeEntryCount: 0,
    archivedEntryCount: 0,
    entries: [],
    activeEntries: [],
    archivedEntries: [],
  } satisfies LocalMemoryState;
  const memoryDraftDirty = draft !== effective.content;
  const draftMemoryEntries = useMemo(() => parseLocalMemoryMarkdown(draft), [draft]);
  const visibleMemoryEntries = memoryDraftDirty ? draftMemoryEntries : effective;
  const memoryEntryPreviewBlockedReason =
    memoryDraftDirty && draftMemoryEntries.safeMode
      ? '草稿过大，条目预览已暂停；保存前请先删减 MEMORY.md 内容。'
      : '';
  const normalizedMemoryEntryQuery = memoryEntryQuery.trim();
  const filteredActiveEntries = useMemo(
    () => filterLocalMemoryEntries(visibleMemoryEntries.activeEntries, normalizedMemoryEntryQuery),
    [visibleMemoryEntries.activeEntries, normalizedMemoryEntryQuery],
  );
  const filteredArchivedEntries = useMemo(
    () => filterLocalMemoryEntries(visibleMemoryEntries.archivedEntries, normalizedMemoryEntryQuery),
    [visibleMemoryEntries.archivedEntries, normalizedMemoryEntryQuery],
  );
  const filteredEntryCount = filteredActiveEntries.length + filteredArchivedEntries.length;
  const localMemoryPromptPreview = useMemo(() => buildLocalMemoryPromptBody(draft) ?? '', [draft]);
  const promptPreviewBlockedReason = localMemoryPromptPreviewBlockedReason(effective);
  const promptPreviewWillInject = localMemoryPromptPreview.length > 0 && !promptPreviewBlockedReason;
  const localMemoryPromptPreviewTruncated = localMemoryPromptPreview.includes('[本地记忆已按长度截断]');
  const localMemoryPromptPreviewBudgetLabel = localMemoryPromptPreview
    ? localMemoryPromptPreviewTruncated
      ? `预览已按 ${LOCAL_MEMORY_PROMPT_MAX_CHARS.toLocaleString('zh-CN')} 字符上限截断`
      : `预览 ${localMemoryPromptPreview.length.toLocaleString('zh-CN')} / ${LOCAL_MEMORY_PROMPT_MAX_CHARS.toLocaleString('zh-CN')} 字符`
    : `prompt 上限 ${LOCAL_MEMORY_PROMPT_MAX_CHARS.toLocaleString('zh-CN')} 字符`;
  const memoryDraftHasSensitiveFields = useMemo(() => redactSecrets(draft) !== draft, [draft]);
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

  return (
    <div className="settingsStructuredPage">
      <SettingsRows>
        <div className="settingsFormRow">
          <div>
            <strong>本地 MEMORY.md</strong>
            <small>透明 Markdown 文件，保存在当前本机工作区。这里的内容不会自动从聊天里抽取。</small>
          </div>
          <Chip variant={memoryStatusTone(effective.status)}>
            {memoryStatusLabel(effective.status)}
          </Chip>
          <Switch
            ariaLabel="启用本地 MEMORY.md"
            checked={effective.enabled}
            disabled={memoryControlsDisabled}
            onChange={(enabled) => void setEnabled(enabled)}
          />
        </div>

        <div className="settingsFormRow">
          <div>
            <strong>模型上下文可读取</strong>
            <small>默认关闭。开启后才允许发送消息时把本地记忆加入 prompt；隐身模式下仍会禁用。</small>
          </div>
          <Switch
            ariaLabel="允许模型上下文读取本地记忆"
            checked={effective.agentReadEnabled}
            disabled={memoryControlsDisabled || !effective.enabled}
            onChange={(enabled) => void setAgentReadEnabled(enabled)}
          />
        </div>

        <div className="settingsFormRow">
          <div>
            <strong>项目指令文件</strong>
            <small>读取当前工作区的 AGENTS.md / CLAUDE.md / GEMINI.md；按低优先级指令注入，可随时关闭。</small>
          </div>
          <Switch
            ariaLabel="启用项目指令文件"
            checked={props.settings.workspaceInstructions.enabled}
            disabled={memoryControlsDisabled}
            onChange={(enabled) => void setWorkspaceInstructionsEnabled(enabled)}
          />
        </div>
      </SettingsRows>

      {workspaceInstructionState && (
        <div className="settingsMemoryPreview">
          <strong>
            检测到 {workspaceInstructionState.detectedCount} 个项目指令文件
          </strong>
          <small>
            单文件最多读取 {workspaceInstructionState.fileCharLimit.toLocaleString('zh-CN')} 字符；只显示状态，不在这里展示内容。
          </small>
          <div className="settingsConnectionMeta">
            {workspaceInstructionState.files.map((file) => (
              <span key={file.file} className="settingsInlineFileState">
                <span>{file.file} · {workspaceInstructionStatusLabel(file.status, file.chars, file.truncated)}</span>
                {(file.status === 'available' || file.status === 'empty') && (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="min-w-[4rem]"
                    aria-label={`打开项目指令文件 ${file.file}`}
                    disabled={memoryControlsDisabled || isMemoryActionPending(`instruction:${file.file}:open`)}
                    onClick={() => void openWorkspaceInstructionFile(file.file)}
                  >
                    {isMemoryActionPending(`instruction:${file.file}:open`) ? '打开中…' : '打开'}
                  </Button>
                )}
                {file.status === 'missing' && (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="min-w-[4rem]"
                    aria-label={`创建项目指令文件 ${file.file}`}
                    disabled={memoryControlsDisabled || isMemoryActionPending(`instruction:${file.file}:create`)}
                    onClick={() => void createWorkspaceInstructionFile(file.file)}
                  >
                    {isMemoryActionPending(`instruction:${file.file}:create`) ? '创建中…' : '创建'}
                  </Button>
                )}
              </span>
            ))}
          </div>
        </div>
      )}

      <div className="settingsConnectionMeta settingsMemoryMeta">
        <span className="settingsMemoryPath" title={effective.path || undefined}>
          {effective.path ? displayMemoryPath(effective.path) : '等待创建 MEMORY.md'}
        </span>
        {effective.latestBackup ? (
          <span className="settingsMemoryBackupState">
            上一版 {localMemoryBackupKindLabel(effective.latestBackup.kind)} · {localMemoryBackupSummary(effective.latestBackup)} · <RelativeTime ts={effective.latestBackup.updatedAt} />
          </span>
        ) : (
          <span className="settingsMemoryBackupState" data-empty="true">等待生成上一版备份</span>
        )}
        <span className="settingsMemoryDirtyState" data-dirty={memoryDraftDirty ? 'true' : 'false'}>
          {memoryDraftDirty ? '有未保存修改' : '草稿已保存'}
        </span>
        <span>
          {memoryDraftDirty ? '草稿 ' : ''}
          {visibleMemoryEntries.activeEntries.length} 条生效
        </span>
        {visibleMemoryEntries.archivedEntries.length > 0 && (
          <span>
            {memoryDraftDirty ? '草稿 ' : ''}
            {visibleMemoryEntries.archivedEntries.length} 条已归档
          </span>
        )}
      </div>

      {effective.backups && effective.backups.length > 1 && (
        <div className="settingsMemoryBackupList" role="status">
          <strong>备份候选</strong>
          {/* PR-MEMORY-BACKUP-LIST-A11Y-0 (round 16/30): same
              fix as round-7 daily-review archive list. Was
              `<div role="list">` with `<span role="listitem">`
              children — invalid layering (a span is not a list,
              and a listitem on a span has no list context to
              attach to). Switched to semantic <ul>/<li> so
              screen readers get the relationship from the
              elements themselves. */}
          <ul className="settingsMemoryBackupCandidates" aria-label="本地记忆备份候选列表">
            {effective.backups.map((backup) => {
              const backupCandidateLabel = `${localMemoryBackupKindLabel(backup.kind)} · ${localMemoryBackupSummary(backup)}`;
              return (
                <li key={`${backup.kind}:${backup.path}`} className="settingsMemoryBackupCandidate">
                  <span>{backupCandidateLabel} · <RelativeTime ts={backup.updatedAt} /></span>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="min-w-[4rem]"
                    aria-label={`打开备份候选 ${backupCandidateLabel}`}
                    disabled={memoryControlsDisabled || !effective.enabled || isMemoryActionPending(`backup:${backup.kind}:open`)}
                    onClick={() => void openBackupCandidate(backup)}
                  >
                    {isMemoryActionPending(`backup:${backup.kind}:open`) ? '打开中…' : '打开'}
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="min-w-[4rem]"
                    aria-label={`恢复备份候选 ${backupCandidateLabel}`}
                    disabled={memoryControlsDisabled || !effective.enabled || isMemoryActionPending(`backup:${backup.kind}:restore`)}
                    onClick={() => void restoreBackupCandidate(backup)}
                  >
                    {isMemoryActionPending(`backup:${backup.kind}:restore`) ? '恢复中…' : '恢复'}
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="min-w-[4rem]"
                    aria-label={`复制备份候选引用 ${backupCandidateLabel}`}
                    disabled={isMemoryActionPending(`backup:${backup.kind}:copy`)}
                    onClick={() => void copyBackupReference(backup)}
                  >
                    {isMemoryActionPending(`backup:${backup.kind}:copy`) ? '复制中…' : '复制引用'}
                  </Button>
                </li>
              );
            })}
          </ul>
          <small>上一版操作会使用最近的候选；这里只显示 metadata，不展示备份正文。</small>
        </div>
      )}

      {lastSaveSummary && !memoryDraftDirty && (
        <div className="settingsMemorySaveSummary" role="status">
          <strong>{lastSaveSummary.title}</strong>
          <small className="settingsMemorySaveSummaryTime">
            保存于 <RelativeTime ts={lastSaveSummary.savedAt} />
          </small>
          <small>{lastSaveSummary.detail}</small>
        </div>
      )}

      {memoryEntryPreviewBlockedReason && (
        <div className="settingsMemoryEntryPreviewNotice" role="status">
          <strong>草稿条目预览暂停</strong>
          <small>{memoryEntryPreviewBlockedReason}</small>
        </div>
      )}

      <div className="settingsMemoryPromptPreview" data-active={promptPreviewWillInject ? 'true' : 'false'}>
        <div className="settingsMemoryPromptPreviewHeader">
          <strong>模型上下文预览</strong>
          <div>
            <span>{promptPreviewWillInject ? '发送时会注入' : '当前不会注入'}</span>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="min-w-[5rem]"
              disabled={!localMemoryPromptPreview || isMemoryActionPending('memory:prompt-preview:copy')}
              onClick={() => void copyLocalMemoryPromptPreview()}
            >
              {isMemoryActionPending('memory:prompt-preview:copy') ? '复制中…' : '复制上下文'}
            </Button>
          </div>
        </div>
        <small>只展示生效记忆会进入 prompt 的内容；已归档条目不会注入，疑似密钥会遮蔽。</small>
        <small className="settingsMemoryPromptPreviewBudget">{localMemoryPromptPreviewBudgetLabel}</small>
        {localMemoryPromptPreview ? (
          <pre>{localMemoryPromptPreview}</pre>
        ) : (
          <p>{effective.status === 'safe_mode' ? 'MEMORY.md 过大，当前不会生成模型上下文预览。' : '没有生效记忆会进入 prompt。'}</p>
        )}
        {promptPreviewBlockedReason && localMemoryPromptPreview && (
          <small>{promptPreviewBlockedReason}</small>
        )}
      </div>

      {visibleMemoryEntries.entries.length > 0 && (
        <>
          <div className="settingsMemoryFilter">
            <Input
              type="search"
              value={memoryEntryQuery}
              onChange={(event) => setMemoryEntryQuery(event.currentTarget.value)}
              aria-label="筛选本地记忆"
              placeholder="筛选标题、内容、ID 或标签"
            />
            {normalizedMemoryEntryQuery ? (
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => setMemoryEntryQuery('')}
              >
                清除
              </Button>
            ) : null}
            <small>
              {normalizedMemoryEntryQuery
                ? `${filteredEntryCount} / ${visibleMemoryEntries.entries.length} 条匹配`
                : `${visibleMemoryEntries.entries.length} 条记忆`}
            </small>
          </div>
          {normalizedMemoryEntryQuery && filteredEntryCount === 0 ? (
            <div className="settingsMemoryFilterEmpty" role="status">
              <strong>没有匹配的记忆条目</strong>
              <small>筛选不会修改 MEMORY.md；清除筛选后会恢复显示全部条目。</small>
            </div>
          ) : (
            <div className="settingsMemoryEntryGroups">
              <MemoryEntryList
                title="生效记忆"
                entries={filteredActiveEntries}
                filtered={normalizedMemoryEntryQuery.length > 0}
                draftDirty={memoryDraftDirty}
                busy={memoryControlsDisabled || effective.status === 'incognito_blocked' || !effective.enabled}
                pendingCopyIds={pendingMemoryActions}
                onCopyReference={copyMemoryEntryReference}
                onFocusDraft={focusMemoryEntryInDraft}
                onStatusChange={updateMemoryEntryStatus}
              />
              {visibleMemoryEntries.archivedEntries.length > 0 && (
                <MemoryEntryList
                  title="已归档记忆"
                  entries={filteredArchivedEntries}
                  filtered={normalizedMemoryEntryQuery.length > 0}
                  archived
                  draftDirty={memoryDraftDirty}
                  busy={memoryControlsDisabled || effective.status === 'incognito_blocked' || !effective.enabled}
                  pendingCopyIds={pendingMemoryActions}
                  onCopyReference={copyMemoryEntryReference}
                  onFocusDraft={focusMemoryEntryInDraft}
                  onStatusChange={updateMemoryEntryStatus}
                />
              )}
            </div>
          )}
        </>
      )}

      {visibleMemoryEntries.entries.length === 0 && !memoryEntryPreviewBlockedReason && (
        <div className="settingsMemoryListEmpty" role="status">
          <strong>等待添加记忆条目</strong>
          <small>手动添加会先进入下方草稿；保存后才会写入 MEMORY.md。</small>
        </div>
      )}

      <div className="settingsMemoryManualAdd" role="group" aria-label="手动添加本地记忆">
        <div className="settingsMemoryManualAddHeader">
          <strong>手动添加记忆</strong>
          <small>只追加到下方草稿；保存前仍可检查和修改 Markdown。</small>
        </div>
        <div className="settingsMemoryManualAddGrid">
          <Input
            type="text"
            value={newMemoryTitle}
            onChange={(event) => setNewMemoryTitle(event.currentTarget.value)}
            aria-label="记忆标题"
            placeholder="标题"
            disabled={memoryControlsDisabled || effective.status === 'incognito_blocked' || !effective.enabled}
          />
          <Input
            type="text"
            value={newMemoryTags}
            onChange={(event) => setNewMemoryTags(event.currentTarget.value)}
            aria-label="记忆标签"
            placeholder="标签（逗号分隔，可选）"
            disabled={memoryControlsDisabled || effective.status === 'incognito_blocked' || !effective.enabled}
          />
          <Textarea
            value={newMemoryContent}
            onChange={(event) => setNewMemoryContent(event.currentTarget.value)}
            aria-label="记忆内容"
            placeholder="内容"
            rows={3}
            disabled={memoryControlsDisabled || effective.status === 'incognito_blocked' || !effective.enabled}
          />
        </div>
        <Button
          type="button"
          variant="secondary"
          disabled={memoryControlsDisabled || effective.status === 'incognito_blocked' || !effective.enabled}
          onClick={addManualMemoryDraftEntry}
        >
          添加到草稿
        </Button>
      </div>

      {memoryDraftHasSensitiveFields && (
        <div className="settingsMemoryDraftWarning" role="status">
          <strong>草稿含疑似敏感字段</strong>
          <small>保存时会先遮蔽疑似 token、API key 或密码，再写入 MEMORY.md。</small>
        </div>
      )}

      <label className="settingsMemoryEditor">
        <span>文件内容</span>
        <Textarea
          ref={editorRef}
          value={draft}
          onChange={(event) => setDraft(event.currentTarget.value)}
          disabled={memoryControlsDisabled || effective.status === 'incognito_blocked' || !effective.enabled}
          rows={12}
          spellCheck={false}
          aria-label="MEMORY.md 内容"
        />
      </label>

      {effective.reason && (
        <div className="settingsNotice" data-tone="passive" role="status">
          {effective.reason}
        </div>
      )}

      <div className="settingsActionRow" role="group" aria-label="MEMORY.md 文件操作">
        <Button type="button" className="min-w-[3.5rem]" disabled={memoryControlsDisabled || !effective.enabled || !memoryDraftDirty} onClick={() => void save()}>
          {pendingMemoryWriteAction === 'save' ? '保存中…' : memoryDraftDirty ? '保存' : '已保存'}
        </Button>
        <Button type="button" variant="ghost" className="min-w-[7.5rem]" disabled={memoryControlsDisabled || !effective.enabled || isMemoryActionPending('memory:file:open')} onClick={() => void openFile()}>
          {isMemoryActionPending('memory:file:open') ? '打开中…' : '打开 MEMORY.md'}
        </Button>
        <Button type="button" variant="ghost" className="min-w-[6rem]" disabled={memoryControlsDisabled || !effective.enabled || isMemoryActionPending('memory:folder:open')} onClick={() => void openFolder()}>
          {isMemoryActionPending('memory:folder:open') ? '打开中…' : '打开所在目录'}
        </Button>
        <Button type="button" variant="ghost" className="min-w-[4rem]" disabled={memoryControlsDisabled || !effective.enabled} onClick={() => void reloadDraftFromDisk()}>
          {pendingMemoryWriteAction === 'reload' ? '载入中…' : '重新载入'}
        </Button>
        <Button type="button" variant="ghost" className="min-w-[5rem]" disabled={memoryControlsDisabled || !effective.enabled || !effective.latestBackup || isMemoryActionPending('backup:latest:open')} onClick={() => void openLatestBackup()}>
          {isMemoryActionPending('backup:latest:open') ? '打开中…' : '打开上一版'}
        </Button>
        <Button type="button" variant="ghost" className="min-w-[4rem]" disabled={!effective.path || isMemoryActionPending('memory:path:copy')} onClick={() => void copyPath()}>
          {isMemoryActionPending('memory:path:copy') ? '复制中…' : '复制路径'}
        </Button>
        <Button type="button" variant="ghost" className="min-w-[7rem]" disabled={!effective.latestBackup || (effective.latestBackup ? isMemoryActionPending(`backup:${effective.latestBackup.kind}:copy`) : false)} onClick={() => void copyLatestBackupReference()}>
          {effective.latestBackup && isMemoryActionPending(`backup:${effective.latestBackup.kind}:copy`) ? '复制中…' : '复制上一版引用'}
        </Button>
        <Button type="button" variant="ghost" className="min-w-[5rem]" disabled={memoryControlsDisabled || !effective.enabled} onClick={() => void reset()}>
          {pendingMemoryWriteAction === 'reset' ? '重置中…' : '重置并备份'}
        </Button>
        <Button type="button" variant="ghost" className="min-w-[5rem]" disabled={memoryControlsDisabled || !effective.enabled || !effective.latestBackup || isMemoryActionPending('backup:latest:restore')} onClick={() => void restoreLatestBackup()}>
          {isMemoryActionPending('backup:latest:restore') ? '恢复中…' : '恢复上一版'}
        </Button>
      </div>
    </div>
  );
}

function MemoryEntryList(props: {
  title: string;
  entries: LocalMemoryState['activeEntries'];
  filtered?: boolean;
  archived?: boolean;
  draftDirty?: boolean;
  busy?: boolean;
  pendingCopyIds?: ReadonlySet<string>;
  onCopyReference?(entry: LocalMemoryState['activeEntries'][number]): void | Promise<void>;
  onFocusDraft?(entry: LocalMemoryState['activeEntries'][number]): void | Promise<void>;
  onStatusChange?(entry: LocalMemoryState['activeEntries'][number], status: 'active' | 'archived'): void | Promise<void>;
}) {
  return (
    <section className="settingsMemoryEntryGroup" data-archived={props.archived ? 'true' : 'false'}>
      <div className="settingsMemoryEntryGroupHeader">
        <strong>{props.title}</strong>
        <span>{props.entries.length} 条</span>
      </div>
      {props.draftDirty && props.onStatusChange && (
        <p className="settingsMemoryEntryDraftNotice" role="status">
          当前归档/恢复操作只更新草稿，保存后才会写入 MEMORY.md。
        </p>
      )}
      {props.entries.length === 0 ? (
        <p className="settingsMemoryEntryEmpty">{props.filtered ? '无匹配条目。' : '暂无条目。'}</p>
      ) : (
        /* PR-MEMORY-ENTRY-LIST-A11Y-0 (round 18/30): fourth
           application of the same ARIA list fix. Was `<div
           role="list">` with `<article role="listitem">` rows —
           semantic `<ul>` / `<li>` so screen readers get the
           relationship from the elements themselves. The inner
           `<article>` per entry stays — articles are valid
           sectioning content inside list items. */
        <ul className="settingsMemoryEntryList" aria-label={`${props.title}列表`}>
          {props.entries.map((entry) => {
            const copyPending = props.pendingCopyIds?.has(`entry:${entry.id}:copy`) ?? false;
            const statusActionLabel = props.draftDirty
              ? props.archived
                ? '恢复到草稿'
                : '归档到草稿'
              : props.archived
                ? '恢复'
                : '归档';
            const statusActionAriaLabel = props.draftDirty
              ? `${statusActionLabel}，保存前不会写入 MEMORY.md`
              : undefined;
            return (
              <li key={entry.id}>
                <article className="settingsMemoryEntryCard">
                <strong>{entry.title}</strong>
                <small className="settingsMemoryEntryMeta">
                  {memoryOriginLabel(entry.origin)}
                  {entry.tags.length > 0 ? ` · ${entry.tags.join(' / ')}` : ''}
                </small>
                <small className="settingsMemoryEntryFacts">
                  <span>ID {entry.id}</span>
                  {entry.createdAt !== undefined && (
                    <span>
                      创建 <RelativeTime ts={entry.createdAt} className="settingsHelpInlineTime" />
                    </span>
                  )}
                  {entry.updatedAt !== undefined && (
                    <span>
                      更新 <RelativeTime ts={entry.updatedAt} className="settingsHelpInlineTime" />
                    </span>
                  )}
                </small>
                <span className="settingsMemoryPromptScope" data-active={props.archived ? 'false' : 'true'}>
                  {props.archived ? '已归档，不进入 prompt' : '生效条目，会进入本地记忆 prompt'}
                </span>
                <p>{entry.content}</p>
                {(props.onCopyReference || props.onFocusDraft || props.onStatusChange) && (
                  <div className="settingsMemoryEntryActions" role="group" aria-label={`${entry.title}记忆操作`}>
                    {props.onCopyReference && (
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        className="min-w-[4rem]"
                        disabled={copyPending}
                        onClick={() => void props.onCopyReference?.(entry)}
                      >
                        {copyPending ? '复制中…' : '复制引用'}
                      </Button>
                    )}
                    {props.onFocusDraft && (
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={() => void props.onFocusDraft?.(entry)}
                      >
                        定位草稿
                      </Button>
                    )}
                    {props.onStatusChange && (
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        className="min-w-[5rem]"
                        aria-label={statusActionAriaLabel}
                        disabled={props.busy}
                        onClick={() => void props.onStatusChange?.(entry, props.archived ? 'active' : 'archived')}
                      >
                        {statusActionLabel}
                      </Button>
                    )}
                  </div>
                )}
                </article>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

function filterLocalMemoryEntries(
  entries: LocalMemoryState['activeEntries'],
  query: string,
): LocalMemoryState['activeEntries'] {
  if (!query) return entries;
  const needle = query.toLocaleLowerCase('zh-CN');
  return entries.filter((entry) => {
    const haystack = [
      entry.id,
      entry.title,
      entry.content,
      entry.origin,
      memoryOriginLabel(entry.origin),
      entry.createdAt === undefined ? '' : String(entry.createdAt),
      entry.updatedAt === undefined ? '' : String(entry.updatedAt),
      ...entry.tags,
    ].join('\n').toLocaleLowerCase('zh-CN');
    return haystack.includes(needle);
  });
}

function memoryOriginLabel(origin: NonNullable<LocalMemoryState['latestEntry']>['origin']): string {
  switch (origin) {
    case 'manual': return '手动记录';
    case 'imported': return '导入记录';
    case 'extracted': return '确认提取';
    case 'unknown': return '手写条目';
  }
}

function memoryEntryStatusLabel(status: LocalMemoryState['entries'][number]['status']): string {
  switch (status) {
    case 'draft': return '草稿';
    case 'review_required': return '待确认';
    case 'active': return '生效';
    case 'archived': return '已归档';
    case 'rejected': return '已拒绝';
    case 'unknown': return '未识别';
  }
}

function formatLocalMemorySaveSummary(state: LocalMemoryState): string {
  const archived = state.archivedEntryCount > 0 ? ` / ${state.archivedEntryCount} 条已归档` : '';
  return `当前 ${state.activeEntryCount} 条生效${archived}；已保留上一版备份。`;
}

/** Display-only path shortening: the full absolute MEMORY.md path used
 * to render as a full-width mono line that shoved the sibling status
 * words into a cramped stack (and leaked the raw absolute path into
 * the renderer, against the UI quality plan). Show the meaningful
 * trailing segments; the full path stays available via title= and the
 * copy-path action. */
function displayMemoryPath(path: string): string {
  const parts = path.split('/').filter(Boolean);
  if (parts.length <= 3) return path;
  return `…/${parts.slice(-3).join('/')}`;
}

function localMemoryBackupKindLabel(kind: NonNullable<LocalMemoryState['latestBackup']>['kind']): string {
  switch (kind) {
    case 'reset': return '重置前备份';
    case 'restore': return '恢复前备份';
    case 'save': return '保存前备份';
  }
}

function localMemoryBackupSummary(backup: NonNullable<LocalMemoryState['latestBackup']>): string {
  if (backup.safeMode) return '备份过大，无法预览条目';
  const archived = backup.archivedEntryCount > 0 ? ` / ${backup.archivedEntryCount} 条已归档` : '';
  return `${backup.activeEntryCount} 条生效${archived}`;
}

function memoryStatusLabel(status: LocalMemoryState['status']): string {
  switch (status) {
    case 'ok': return '本地文件已就绪';
    case 'disabled': return '已关闭';
    case 'safe_mode': return '安全模式';
    case 'incognito_blocked': return '隐身禁用';
    case 'error': return '读取失败';
  }
}

function localMemoryPromptPreviewBlockedReason(state: LocalMemoryState): string {
  if (!state.enabled) return '本地记忆已关闭。';
  if (state.status === 'incognito_blocked') return '隐身模式下不会注入本地记忆。';
  if (state.status === 'safe_mode') return 'MEMORY.md 过大，当前不会注入。';
  if (!state.agentReadEnabled) return '模型上下文读取未开启。';
  return '';
}

function workspaceInstructionStatusLabel(status: string, chars: number, truncated: boolean): string {
  switch (status) {
    case 'available':
      return `${chars.toLocaleString('zh-CN')} 字符${truncated ? '，已截断' : ''}`;
    case 'missing':
      return '未找到';
    case 'blocked':
      return '路径被拦截';
    case 'empty':
      return '空文件';
    case 'unreadable':
      return '无法读取';
    default:
      return '未知状态';
  }
}

function memoryStatusTone(status: LocalMemoryState['status']): 'success' | 'info' | 'warning' | 'destructive' {
  switch (status) {
    case 'ok': return 'success';
    case 'disabled': return 'info';
    case 'safe_mode':
    case 'incognito_blocked': return 'warning';
    case 'error': return 'destructive';
  }
}
