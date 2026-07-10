/**
 * Pure helpers for the Codex-style tool "trow" summary (issue: streaming UI
 * rework). A trow groups a contiguous run of tool activity into one collapsed
 * row; when every tool in the group has settled, the summary line buckets them
 * by activity kind and prints a compact Chinese count phrase like
 * "读取 3 个文件，搜索 2 次". Modeled on pawwork's `contextTrowSummaryText`,
 * translated to maka's canonical tool names + inline Chinese strings (no i18n
 * catalog dependency).
 *
 * Kept pure + separately unit-tested; the React trow renders it and maps the
 * kind to an icon.
 */

import type { ToolActivityKind } from '@maka/core';
import type { ToolActivityItem } from '../materialize.js';

export type TrowActivityKind = ToolActivityKind;

/**
 * Prefer a declared semantic category. Legacy rows fall back to the canonical
 * tool name (case-insensitive); unknown names use the generic `tool` bucket.
 */
const KNOWN_ACTIVITY_KINDS: ReadonlySet<string> = new Set<TrowActivityKind>([
  'read',
  'search',
  'websearch',
  'webfetch',
  'edit',
  'command',
  'explore',
  'browser',
  'tool',
]);

export function trowActivityKind(
  toolName: string,
  activityKind?: ToolActivityKind,
): TrowActivityKind {
  // Trust only known kinds — corrupted/future persisted values must not crash
  // KIND_CLAUSE[kind] during summarize.
  if (activityKind && KNOWN_ACTIVITY_KINDS.has(activityKind)) return activityKind;
  const name = toolName.toLowerCase();
  if (name.startsWith('browser_')) return 'browser';
  switch (name) {
    case 'read':
    case 'list':
      return 'read';
    case 'glob':
    case 'grep':
      return 'search';
    case 'websearch':
    case 'web_search':
      return 'websearch';
    case 'webfetch':
    case 'web_fetch':
      return 'webfetch';
    case 'write':
    case 'edit':
    case 'multiedit':
    case 'apply_patch':
      return 'edit';
    case 'bash':
    case 'shell':
    case 'stopbackgroundtask':
    case 'stop_background_task':
      return 'command';
    case 'exploreagent':
    case 'explore_agent':
      return 'explore';
    default:
      return 'tool';
  }
}

/** Chinese count clause per bucket, e.g. read(3) → "读取 3 个文件". */
const KIND_CLAUSE: Record<TrowActivityKind, (n: number) => string> = {
  read: (n) => `读取 ${n} 个文件`,
  search: (n) => `搜索 ${n} 次`,
  websearch: (n) => `联网搜索 ${n} 次`,
  webfetch: (n) => `抓取 ${n} 个网页`,
  edit: (n) => `编辑 ${n} 个文件`,
  command: (n) => `运行 ${n} 条命令`,
  explore: (n) => `探索 ${n} 次`,
  browser: (n) => `浏览器操作 ${n} 次`,
  tool: (n) => `调用 ${n} 个工具`,
};

function isFailed(status: ToolActivityItem['status']): boolean {
  return status === 'errored';
}

/**
 * Build the settled-state summary line for a trow: one clause per distinct
 * activity kind in first-seen order, joined with "，", then a trailing
 * "N 个失败" clause when any tool errored. A failed tool still counts toward
 * its type bucket (a failed read is "读取 1 个文件" + "1 个失败").
 */
export function summarizeTrowTools(items: readonly ToolActivityItem[]): string {
  const order: TrowActivityKind[] = [];
  const counts = new Map<TrowActivityKind, number>();
  let failed = 0;
  for (const item of items) {
    const kind = trowActivityKind(item.toolName, item.activityKind);
    if (!counts.has(kind)) order.push(kind);
    counts.set(kind, (counts.get(kind) ?? 0) + 1);
    if (isFailed(item.status)) failed += 1;
  }
  const clauses = order.map((kind) => KIND_CLAUSE[kind](counts.get(kind) ?? 0));
  if (failed > 0) clauses.push(`${failed} 个失败`);
  return clauses.join('，');
}

/**
 * The "active" tool in a running trow — the last one still in flight
 * (running / pending / waiting_permission). Its description drives the
 * shimmering summary line while the group is working. Falls back to the last
 * item so the summary is never empty.
 */
export function activeTrowTool(items: readonly ToolActivityItem[]): ToolActivityItem | undefined {
  for (let i = items.length - 1; i >= 0; i -= 1) {
    const status = items[i]!.status;
    if (status === 'running' || status === 'pending' || status === 'waiting_permission') {
      return items[i];
    }
  }
  return items[items.length - 1];
}

/** True when any tool in the group is still in flight. */
export function isTrowRunning(items: readonly ToolActivityItem[]): boolean {
  return items.some(
    (item) =>
      item.status === 'running' || item.status === 'pending' || item.status === 'waiting_permission',
  );
}

/**
 * True when the group must force itself open: a permission prompt or an error
 * banner is inside. Both are actionable/diagnostic content that a collapsed
 * summary line would hide — the old boxed cards kept errored tools expanded,
 * and the trow keeps that behavior.
 */
export function trowNeedsAttention(items: readonly ToolActivityItem[]): boolean {
  return items.some(
    (item) => item.status === 'waiting_permission' || item.status === 'errored',
  );
}
