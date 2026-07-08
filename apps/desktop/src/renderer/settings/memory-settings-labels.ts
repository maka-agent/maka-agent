import type { LocalMemoryState } from '@maka/core';

export function filterLocalMemoryEntries(
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

export function memoryOriginLabel(origin: NonNullable<LocalMemoryState['latestEntry']>['origin']): string {
  switch (origin) {
    case 'manual': return '手动记录';
    case 'imported': return '导入记录';
    case 'extracted': return '确认提取';
    case 'unknown': return '手写条目';
  }
}

export function memoryEntryStatusLabel(status: LocalMemoryState['entries'][number]['status']): string {
  switch (status) {
    case 'draft': return '草稿';
    case 'review_required': return '待确认';
    case 'active': return '生效';
    case 'archived': return '已归档';
    case 'rejected': return '已拒绝';
    case 'unknown': return '未识别';
  }
}

export function formatLocalMemorySaveSummary(state: LocalMemoryState): string {
  const archived = state.archivedEntryCount > 0 ? ` / ${state.archivedEntryCount} 条已归档` : '';
  return `当前 ${state.activeEntryCount} 条生效${archived}；已保留上一版备份。`;
}

/** Display-only path shortening: the full absolute MEMORY.md path used
 * to render as a full-width mono line that shoved the sibling status
 * words into a cramped stack (and leaked the raw absolute path into
 * the renderer, against the UI quality plan). Show the meaningful
 * trailing segments; the full path stays available via title= and the
 * copy-path action. */
export function displayMemoryPath(path: string): string {
  const parts = path.split('/').filter(Boolean);
  if (parts.length <= 3) return path;
  return `…/${parts.slice(-3).join('/')}`;
}

export function localMemoryBackupKindLabel(kind: NonNullable<LocalMemoryState['latestBackup']>['kind']): string {
  switch (kind) {
    case 'reset': return '重置前备份';
    case 'restore': return '恢复前备份';
    case 'save': return '保存前备份';
  }
}

export function localMemoryBackupSummary(backup: NonNullable<LocalMemoryState['latestBackup']>): string {
  if (backup.safeMode) return '备份过大，无法预览条目';
  const archived = backup.archivedEntryCount > 0 ? ` / ${backup.archivedEntryCount} 条已归档` : '';
  return `${backup.activeEntryCount} 条生效${archived}`;
}

export function memoryStatusLabel(status: LocalMemoryState['status']): string {
  switch (status) {
    case 'ok': return '本地文件已就绪';
    case 'disabled': return '已关闭';
    case 'safe_mode': return '安全模式';
    case 'incognito_blocked': return '隐身禁用';
    case 'error': return '读取失败';
  }
}

export function localMemoryPromptPreviewBlockedReason(state: LocalMemoryState): string {
  if (!state.enabled) return '本地记忆已关闭。';
  if (state.status === 'incognito_blocked') return '隐身模式下不会注入本地记忆。';
  if (state.status === 'safe_mode') return 'MEMORY.md 过大，当前不会注入。';
  if (!state.agentReadEnabled) return '模型上下文读取未开启。';
  return '';
}

export function workspaceInstructionStatusLabel(status: string, chars: number, truncated: boolean): string {
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

export function memoryStatusTone(status: LocalMemoryState['status']): 'success' | 'info' | 'warning' | 'destructive' {
  switch (status) {
    case 'ok': return 'success';
    case 'disabled': return 'info';
    case 'safe_mode':
    case 'incognito_blocked': return 'warning';
    case 'error': return 'destructive';
  }
}
