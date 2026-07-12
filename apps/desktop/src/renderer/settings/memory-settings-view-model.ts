import type { AppSettings, LocalMemoryState } from '@maka/core';
import {
  LOCAL_MEMORY_PROMPT_MAX_CHARS,
  buildLocalMemoryPromptBody,
  parseLocalMemoryMarkdown,
} from '@maka/core';
import { redactSecrets } from '@maka/ui';
import { filterLocalMemoryEntries, localMemoryPromptPreviewBlockedReason } from './memory-settings-labels.js';

export function deriveMemorySettingsViewModel(input: {
  state: LocalMemoryState | null;
  localMemorySettings: AppSettings['localMemory'];
  draft: string;
  query: string;
}) {
  const effective = input.state ?? {
    path: '',
    enabled: input.localMemorySettings.enabled,
    agentReadEnabled: input.localMemorySettings.agentReadEnabled,
    status: 'disabled',
    content: '',
    entryCount: 0,
    activeEntryCount: 0,
    archivedEntryCount: 0,
    entries: [],
    activeEntries: [],
    archivedEntries: [],
  } satisfies LocalMemoryState;
  const memoryDraftDirty = input.draft !== effective.content;
  const draftMemoryEntries = parseLocalMemoryMarkdown(input.draft);
  const visibleMemoryEntries = memoryDraftDirty ? draftMemoryEntries : effective;
  const memoryEntryPreviewBlockedReason = memoryDraftDirty && draftMemoryEntries.safeMode
    ? '草稿过大，条目预览已暂停；保存前请先删减 MEMORY.md 内容。'
    : '';
  const normalizedMemoryEntryQuery = input.query.trim();
  const filteredActiveEntries = filterLocalMemoryEntries(
    visibleMemoryEntries.activeEntries,
    normalizedMemoryEntryQuery,
  );
  const filteredArchivedEntries = filterLocalMemoryEntries(
    visibleMemoryEntries.archivedEntries,
    normalizedMemoryEntryQuery,
  );
  const localMemoryPromptPreview = buildLocalMemoryPromptBody(input.draft) ?? '';
  const promptPreviewBlockedReason = localMemoryPromptPreviewBlockedReason(effective);
  const localMemoryPromptPreviewTruncated = localMemoryPromptPreview.includes('[本地记忆已按长度截断]');

  return {
    effective,
    memoryDraftDirty,
    visibleMemoryEntries,
    memoryEntryPreviewBlockedReason,
    normalizedMemoryEntryQuery,
    filteredActiveEntries,
    filteredArchivedEntries,
    filteredEntryCount: filteredActiveEntries.length + filteredArchivedEntries.length,
    localMemoryPromptPreview,
    promptPreviewBlockedReason,
    promptPreviewWillInject: localMemoryPromptPreview.length > 0 && !promptPreviewBlockedReason,
    localMemoryPromptPreviewBudgetLabel: localMemoryPromptPreview
      ? localMemoryPromptPreviewTruncated
        ? `预览已按 ${LOCAL_MEMORY_PROMPT_MAX_CHARS.toLocaleString('zh-CN')} 字符上限截断`
        : `预览 ${localMemoryPromptPreview.length.toLocaleString('zh-CN')} / ${LOCAL_MEMORY_PROMPT_MAX_CHARS.toLocaleString('zh-CN')} 字符`
      : `prompt 上限 ${LOCAL_MEMORY_PROMPT_MAX_CHARS.toLocaleString('zh-CN')} 字符`,
    memoryDraftHasSensitiveFields: redactSecrets(input.draft) !== input.draft,
  };
}
