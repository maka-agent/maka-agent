import React, { forwardRef, memo, useEffect, useImperativeHandle, useMemo, useRef, useState, type FormEvent, type KeyboardEvent, type MouseEvent, type ReactNode, type RefObject } from 'react';
import {
  AlertOctagon,
  AlertTriangle,
  Archive,
  ArchiveRestore,
  ArrowDown,
  Ban,
  Check,
  ChevronRight,
  CircleCheckBig,
  Copy,
  Eye,
  FileEdit,
  Flag,
  GitBranch,
  GitMerge,
  HelpCircle,
  Hourglass,
  Loader2,
  MessageSquare,
  Pencil,
  Pin,
  PinOff,
  Plus,
  RefreshCcw,
  Repeat,
  Search,
  Settings,
  ShieldAlert,
  Sparkles,
  SquarePen,
  Terminal,
  Trash2,
  Wifi,
} from 'lucide-react';
import { redactSecrets } from './redact.js';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkBreaks from 'remark-breaks';
import rehypeHighlight from 'rehype-highlight';
import type {
  PermissionMode,
  PermissionRequestEvent,
  PermissionResponse,
  ProviderType,
  SessionSummary,
  StoredMessage,
  ToolResultContent,
} from '@maka/core';
import {
  materializeChat,
  materializeTools,
  materializeTurns,
  type ToolActivityItem,
  type TurnViewModel,
} from './materialize.js';

export type NavSelection =
  | { section: 'sessions'; filter: SessionFilter }
  | { section: 'skills' };

export type SessionFilter = 'chats' | 'flagged' | 'archived';

const FILTER_LABEL: Record<SessionFilter, string> = {
  chats: 'Chats',
  flagged: 'Flagged',
  archived: 'Archived',
};

/**
 * Hook for accessible modal dialogs.
 *
 * - Saves the element that had focus before the modal opened.
 * - Moves focus to the first focusable element inside the modal on mount
 *   (or the container itself if no focusable child exists).
 * - Traps Tab/Shift+Tab inside the modal.
 * - Optionally closes the modal on Escape.
 * - Restores focus to the previously-focused element on unmount.
 *
 * Implements rule "3. focus and dialogs (critical)" from the
 * fixing-accessibility skill.
 */
export function useModalA11y(
  containerRef: RefObject<HTMLElement | null>,
  onEscape?: () => void,
): void {
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const previouslyFocused = document.activeElement as HTMLElement | null;

    const initial = getFocusable(container);
    if (initial.length > 0) {
      initial[0]!.focus({ preventScroll: true });
    } else {
      if (!container.hasAttribute('tabindex')) container.setAttribute('tabindex', '-1');
      container.focus({ preventScroll: true });
    }

    function onKeyDown(event: globalThis.KeyboardEvent) {
      if (!container) return;
      if (event.key === 'Escape' && onEscape) {
        event.stopPropagation();
        event.preventDefault();
        onEscape();
        return;
      }
      if (event.key !== 'Tab') return;
      const items = getFocusable(container);
      if (items.length === 0) {
        event.preventDefault();
        return;
      }
      const first = items[0]!;
      const last = items[items.length - 1]!;
      const active = document.activeElement;
      if (event.shiftKey && (active === first || !container.contains(active))) {
        event.preventDefault();
        last.focus({ preventScroll: true });
      } else if (!event.shiftKey && (active === last || !container.contains(active))) {
        event.preventDefault();
        first.focus({ preventScroll: true });
      }
    }

    container.addEventListener('keydown', onKeyDown);
    return () => {
      container.removeEventListener('keydown', onKeyDown);
      // Defer restoration so any in-flight focus changes (e.g. clicking a
      // button that unmounts the modal) settle before we yank focus back.
      queueMicrotask(() => {
        if (previouslyFocused && document.contains(previouslyFocused)) {
          previouslyFocused.focus?.({ preventScroll: true });
        }
      });
    };
  }, [containerRef, onEscape]);
}

const FOCUSABLE_SELECTOR =
  'a[href], area[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), button:not([disabled]), iframe, [tabindex]:not([tabindex="-1"])';

function getFocusable(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
    (element) => !element.hasAttribute('inert') && isVisible(element),
  );
}

function isVisible(element: HTMLElement): boolean {
  if (element.hidden) return false;
  // offsetParent is null for display:none ancestors and fixed-positioned roots,
  // but our modal elements are always rendered visible — so this is a sufficient
  // approximation without forcing layout.
  return element.offsetParent !== null || element === document.activeElement;
}

function Count(props: { value: number }) {
  if (props.value <= 0) return null;
  return <small>{props.value}</small>;
}

export interface SkillEntry {
  id: string;
  name: string;
  description: string;
  path: string;
  /**
   * Tools the skill *declares* it would like to use. This is a request, not
   * a grant — PermissionEngine still applies. We surface the list so users
   * can see what a skill is asking for before they install / enable it.
   */
  declaredTools?: string[];
}

export interface SessionRowActions {
  /** Flag (pin) state toggle. */
  onToggleFlag(sessionId: string, next: boolean): void;
  /** Move to / out of the archive bucket. */
  onArchive(sessionId: string): void;
  onUnarchive(sessionId: string): void;
  /** Rename via inline prompt. Receives the new (trimmed) name. */
  onRename(sessionId: string, name: string): void;
  /** Permanent removal — caller is responsible for the confirm gate. */
  onDelete(sessionId: string): void;
}

export function SessionListPanel(props: {
  selection: NavSelection;
  sessionCounts: Record<SessionFilter, number>;
  sessions: SessionSummary[];
  activeId?: string;
  skills?: SkillEntry[];
  /**
   * Per-session-id boolean flag: true when the session has a live streaming
   * delta in flight. Rendered as a small pulsing accent dot on the row.
   * Caller (main.tsx) derives this from `streamingBySession` so the sidebar
   * shows live activity without subscribing to the stream itself.
   */
  streamingSessionIds?: Set<string>;
  /**
   * Per-session-id boolean flag: true when the session's backend / connection
   * is stale (`backend='fake'` or `llmConnectionSlug` no longer resolves).
   * The row dims + shows a small "已过期" pill so users notice in the list
   * before clicking in and seeing the chat header banner. Caller derives this
   * by joining `sessions` against `connections` — keeps SessionListPanel
   * unaware of the connection store.
   */
  staleSessionIds?: Set<string>;
  /**
   * Pre-computed status-driven groups for the session list (PR109b).
   * When provided, replaces the date-bucket grouping for the `chats`
   * filter. Caller derives this via `deriveSessionStatusGroups()` from
   * `apps/desktop/src/renderer/session-status-grouping.ts`. Each group
   * carries its own collapsible/defaultExpanded flag so the panel
   * doesn't have to know about Archived being closed by default.
   */
  statusGroups?: ReadonlyArray<{
    id: string;
    label: string;
    sessions: SessionSummary[];
    collapsible: boolean;
    defaultExpanded: boolean;
  }>;
  onSelectSession(sessionId: string): void;
  onSelect(selection: NavSelection): void;
  onOpenSettings(): void;
  onNew(): void;
  onOpenSkillFolder?(path: string): void;
  rowActions?: SessionRowActions;
}) {
  const isSessionFilter = (filter: SessionFilter) => props.selection.section === 'sessions' && props.selection.filter === filter;
  const title = props.selection.section === 'sessions' ? FILTER_LABEL[props.selection.filter] : 'Skills';
  const [searchQuery, setSearchQuery] = useState('');
  const searchInputRef = useRef<HTMLInputElement>(null);

  // Filter the incoming sessions by name. Case-insensitive substring is
  // enough for chats — most users name them with the topic. Falls back to
  // showing everything when the query is empty.
  const filteredSessions = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return props.sessions;
    return props.sessions.filter((session) => session.name.toLowerCase().includes(q));
  }, [props.sessions, searchQuery]);

  // ⌘F / Ctrl+F focuses the search field instead of triggering Electron's
  // page find. Limit to the sessions section so it doesn't fight the chat.
  useEffect(() => {
    function onKeyDown(event: globalThis.KeyboardEvent) {
      if (!(event.metaKey || event.ctrlKey)) return;
      if (event.key !== 'f' && event.key !== 'F') return;
      if (props.selection.section !== 'sessions') return;
      event.preventDefault();
      searchInputRef.current?.focus();
      searchInputRef.current?.select();
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [props.selection.section]);

  // List of filter ids in display order — used by Left/Right keyboard cycle.
  const filterCycle: SessionFilter[] = ['chats', 'flagged', 'archived'];

  function handleListKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      // Left/Right inside the list cycles filter buckets (per @kenji's
      // session-list-lifecycle contract). Only fires when the section is
      // already `sessions` (skills section has its own logic).
      if (props.selection.section !== 'sessions') return;
      const current = filterCycle.indexOf(props.selection.filter);
      if (current < 0) return;
      const delta = event.key === 'ArrowRight' ? 1 : -1;
      const next = filterCycle[(current + delta + filterCycle.length) % filterCycle.length];
      if (next && next !== props.selection.filter) {
        event.preventDefault();
        props.onSelect({ section: 'sessions', filter: next });
      }
      return;
    }
    if (event.key === 'Delete' || event.key === 'Backspace') {
      // Delete on a focused row opens the App-level confirmation (which
      // toast.confirm()s); we do not delete silently per the lifecycle
      // contract.
      const active = document.activeElement as HTMLElement | null;
      const row = active?.closest('.maka-list-row');
      const sessionId = row?.querySelector<HTMLButtonElement>('.maka-list-row-main')?.dataset.sessionId;
      if (sessionId && props.rowActions) {
        event.preventDefault();
        props.rowActions.onDelete(sessionId);
      }
      return;
    }
    if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown' && event.key !== 'Home' && event.key !== 'End') {
      return;
    }
    const list = event.currentTarget;
    const focusables = Array.from(
      list.querySelectorAll<HTMLButtonElement>('.maka-list-row-main'),
    );
    if (focusables.length === 0) return;
    const active = document.activeElement as HTMLElement | null;
    const currentIndex = active ? focusables.indexOf(active as HTMLButtonElement) : -1;
    let nextIndex = currentIndex;
    switch (event.key) {
      case 'ArrowDown':
        nextIndex = currentIndex < 0 ? 0 : Math.min(focusables.length - 1, currentIndex + 1);
        break;
      case 'ArrowUp':
        nextIndex = currentIndex <= 0 ? 0 : currentIndex - 1;
        break;
      case 'Home':
        nextIndex = 0;
        break;
      case 'End':
        nextIndex = focusables.length - 1;
        break;
    }
    if (nextIndex === currentIndex) return;
    event.preventDefault();
    focusables[nextIndex]?.focus({ preventScroll: false });
    focusables[nextIndex]?.scrollIntoView({ block: 'nearest' });
  }

  return (
    <aside className="maka-session-panel" aria-label="对话列表">
      <header className="maka-session-panel-header">
        <div className="maka-window-drag-strip" aria-hidden="true" />
        <button className="maka-nav-primary" type="button" onClick={props.onNew}>
          <SquarePen className="maka-nav-primary-icon" strokeWidth={1.5} />
          <span>新建对话</span>
        </button>
      </header>

      <div className="maka-session-filter">
        <button
          className="maka-nav-row"
          data-active={isSessionFilter('chats')}
          type="button"
          onClick={() => props.onSelect({ section: 'sessions', filter: 'chats' })}
        >
          <MessageSquare className="maka-nav-icon" strokeWidth={1.5} />
          <span>Chats</span>
          <Count value={props.sessionCounts.chats} />
        </button>
        <button
          className="maka-nav-row"
          data-active={isSessionFilter('flagged')}
          type="button"
          onClick={() => props.onSelect({ section: 'sessions', filter: 'flagged' })}
        >
          <Flag className="maka-nav-icon" strokeWidth={1.5} />
          <span>Pinned</span>
          <Count value={props.sessionCounts.flagged} />
        </button>
        <button
          className="maka-nav-row"
          data-active={isSessionFilter('archived')}
          type="button"
          onClick={() => props.onSelect({ section: 'sessions', filter: 'archived' })}
        >
          <Archive className="maka-nav-icon" strokeWidth={1.5} />
          <span>Archived</span>
          <Count value={props.sessionCounts.archived} />
        </button>
      </div>

      <div className="maka-session-search">
        <Search strokeWidth={1.5} aria-hidden="true" />
        <input
          ref={searchInputRef}
          type="search"
          value={searchQuery}
          onChange={(event) => setSearchQuery(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (event.key === 'Escape' && searchQuery) {
              event.preventDefault();
              setSearchQuery('');
            }
          }}
          placeholder="搜索会话…  F 聚焦"
          aria-label="搜索会话"
          autoComplete="off"
          spellCheck={false}
        />
        {searchQuery && (
          <button
            type="button"
            className="maka-session-search-clear"
            onClick={() => {
              setSearchQuery('');
              searchInputRef.current?.focus();
            }}
            aria-label="清空搜索"
          >
            ×
          </button>
        )}
      </div>

      <section className="maka-session-list" aria-label={title}>
        <div className="maka-session-list-title">{title}</div>
        {props.selection.section === 'skills' ? (
          (props.skills && props.skills.length > 0) ? (
            <div className="maka-list-stack">
              {props.skills.map((skill) => {
                const tools = skill.declaredTools ?? [];
                const toolsLabel = tools.length > 0 ? tools.join(', ') : '';
                const hoverText = tools.length > 0
                  ? `${skill.path}\n\nRequests: ${toolsLabel}\nPermissionEngine still applies — this is a declaration, not a grant.`
                  : skill.path;
                return (
                  <button
                    key={skill.id}
                    type="button"
                    className="maka-list-row maka-skill-row"
                    onClick={() => props.onOpenSkillFolder?.(skill.path)}
                    title={hoverText}
                  >
                    <div className="maka-list-row-text">
                      <div className="maka-list-row-name">{skill.name}</div>
                      {skill.description && (
                        <div className="maka-list-row-preview">{skill.description}</div>
                      )}
                      <div className="maka-list-row-meta">
                        {skill.id}
                        {tools.length > 0 && (
                          <span className="maka-skill-tools" aria-label="声明的工具">
                            <span className="maka-skill-tools-label">requests</span>
                            <span>{toolsLabel}</span>
                          </span>
                        )}
                      </div>
                    </div>
                  </button>
                );
              })}
            </div>
          ) : (
            <div className="maka-empty-state">
              <Sparkles className="maka-empty-state-icon" strokeWidth={1.5} />
              <div className="maka-empty-state-title">还没有 Skill</div>
              <div className="maka-empty-state-body">
                把一个含 <code className="maka-empty-state-code">SKILL.md</code> 的文件夹放到工作区的
                {' '}<code className="maka-empty-state-code">skills/</code> 目录下，重启 Maka 后会出现在这里。
                工作区路径在 设置 · 关于 · 工作区。
              </div>
            </div>
          )
        ) : props.sessions.length === 0 ? (
          <div className="maka-empty-state">
            <MessageSquare className="maka-empty-state-icon" strokeWidth={1.5} />
            <div className="maka-empty-state-title">还没有对话</div>
            <div className="maka-empty-state-body">和 Maka 的对话会出现在这里。点下面开始第一条。</div>
            <button className="maka-button maka-empty-state-cta" type="button" onClick={props.onNew}>
              新建对话
            </button>
          </div>
        ) : filteredSessions.length === 0 ? (
          <div className="maka-empty-state">
            <Search className="maka-empty-state-icon" strokeWidth={1.5} />
            <div className="maka-empty-state-title">没有匹配的会话</div>
            <div className="maka-empty-state-body">没有名字包含 “{searchQuery}” 的会话。换个关键词，或者按 Esc 清空搜索。</div>
          </div>
        ) : (
          <div className="maka-list-stack" onKeyDown={handleListKeyDown}>
            <SessionListGroups
              groups={
                props.statusGroups && props.selection.section === 'sessions' && props.selection.filter === 'chats'
                  ? props.statusGroups.map((g) => ({
                      key: g.id,
                      label: g.label,
                      sessions: g.sessions,
                      collapsible: g.collapsible,
                      defaultExpanded: g.defaultExpanded,
                    }))
                  : groupSessionsForFilter(filteredSessions, props.selection).map((g) => ({
                      key: g.label,
                      label: g.label,
                      sessions: g.sessions,
                      collapsible: false,
                      defaultExpanded: true,
                    }))
              }
              activeId={props.activeId}
              streamingSessionIds={props.streamingSessionIds}
              staleSessionIds={props.staleSessionIds}
              onSelectSession={props.onSelectSession}
              rowActions={props.rowActions}
            />
          </div>
        )}
      </section>

      <footer className="maka-session-panel-footer">
        <button
          className="maka-nav-row"
          data-active={props.selection.section === 'skills'}
          type="button"
          onClick={() => props.onSelect({ section: 'skills' })}
        >
          <Sparkles className="maka-nav-icon" strokeWidth={1.5} />
          <span>Skills</span>
        </button>
        <button
          className="maka-nav-row"
          type="button"
          onClick={props.onOpenSettings}
        >
          <Settings className="maka-nav-icon" strokeWidth={1.5} />
          <span>Settings</span>
        </button>
      </footer>
    </aside>
  );
}

/**
 * Render an ordered list of session groups, supporting collapsibility
 * per group. Used by SessionListPanel for both the legacy date-bucket
 * grouping and the new status-driven grouping (PR109b).
 *
 * Each group has a header row with the group label + count. Collapsible
 * groups show a chevron and toggle expanded state via local state.
 * Expanded state is keyed on group `key` so the same group keeps its
 * state across re-renders (e.g., archived stays collapsed even when
 * sidebar refreshes).
 */
function SessionListGroups(props: {
  groups: ReadonlyArray<{
    key: string;
    label: string;
    sessions: SessionSummary[];
    collapsible: boolean;
    defaultExpanded: boolean;
  }>;
  activeId?: string;
  streamingSessionIds?: Set<string>;
  staleSessionIds?: Set<string>;
  onSelectSession(sessionId: string): void;
  rowActions?: SessionRowActions;
}) {
  const [expandedByKey, setExpandedByKey] = useState<Record<string, boolean>>(() => {
    const out: Record<string, boolean> = {};
    for (const g of props.groups) out[g.key] = g.defaultExpanded;
    return out;
  });
  // Ensure newly-appearing groups inherit their defaultExpanded value
  // without overriding user-toggled state.
  useEffect(() => {
    setExpandedByKey((current) => {
      const next = { ...current };
      let changed = false;
      for (const g of props.groups) {
        if (!(g.key in next)) {
          next[g.key] = g.defaultExpanded;
          changed = true;
        }
      }
      return changed ? next : current;
    });
  }, [props.groups]);
  return (
    <>
      {props.groups.map((group) => {
        const expanded = expandedByKey[group.key] ?? group.defaultExpanded;
        const toggle = () =>
          setExpandedByKey((current) => ({ ...current, [group.key]: !expanded }));
        return (
          <div key={group.key} className="maka-list-group" data-collapsible={group.collapsible || undefined}>
            {group.collapsible ? (
              <button
                type="button"
                className="maka-list-group-label maka-list-group-toggle"
                onClick={toggle}
                aria-expanded={expanded}
                aria-controls={`maka-list-group-body-${group.key}`}
              >
                <ChevronRight
                  size={12}
                  strokeWidth={2}
                  aria-hidden="true"
                  style={{
                    transform: expanded ? 'rotate(90deg)' : undefined,
                    transition: 'transform 140ms var(--ease-out-strong)',
                  }}
                />
                <span>{group.label}</span>
                <span className="maka-list-group-count">{group.sessions.length}</span>
              </button>
            ) : (
              <div className="maka-list-group-label">
                <span>{group.label}</span>
                {group.sessions.length > 1 && (
                  <span className="maka-list-group-count">{group.sessions.length}</span>
                )}
              </div>
            )}
            {expanded && (
              <div id={`maka-list-group-body-${group.key}`}>
                {group.sessions.map((session) => (
                  <SessionRow
                    key={session.id}
                    session={session}
                    active={session.id === props.activeId}
                    streaming={props.streamingSessionIds?.has(session.id) ?? false}
                    stale={props.staleSessionIds?.has(session.id) ?? false}
                    onSelect={props.onSelectSession}
                    actions={props.rowActions}
                  />
                ))}
              </div>
            )}
          </div>
        );
      })}
    </>
  );
}

/**
 * Small inline icon next to the session name representing its
 * lifecycle status (PR109b, design-system §9.8). Hidden for `active`
 * since that's the default and would add visual noise to most rows.
 *
 * `aborted` is rendered as muted history: not an error, not active,
 * and not silently swallowed.
 *
 * Caller is expected to pass a session with a SessionStatus from
 * `@maka/core` — typed as the SessionSummary from props avoids
 * pulling the core type into this file's import list.
 */
function SessionStatusIcon(props: { session: SessionSummary }) {
  const { session } = props;
  const status = session.status;
  // Active is the default; no icon to reduce noise. Aborted retains a
  // muted icon (per @kenji review on PR109b — aborted is dormant
  // history that must remain visible, not silently swallowed as active).
  if (status === 'active') return null;
  const Icon = STATUS_ICON_BY_STATUS[status as keyof typeof STATUS_ICON_BY_STATUS];
  if (!Icon) return null;
  const label = STATUS_LABEL_BY_STATUS[status as keyof typeof STATUS_LABEL_BY_STATUS];
  const tone = STATUS_TONE_BY_STATUS[status as keyof typeof STATUS_TONE_BY_STATUS];
  // `blocked` may attach a reason; we surface the generalized text in
  // the tooltip without exposing the raw enum identifier (per @kenji
  // i18n contract). The reason mapping lives in the renderer side; this
  // file knows only the status itself, so the tooltip is just the
  // status label.
  const blockedDetail = status === 'blocked' && session.blockedReason
    ? BLOCKED_REASON_TOOLTIP[session.blockedReason as keyof typeof BLOCKED_REASON_TOOLTIP] ?? null
    : null;
  const title = blockedDetail ? `${label} · ${blockedDetail}` : label;
  return (
    <span
      className="maka-list-row-status-icon"
      data-tone={tone}
      data-status={status}
      aria-label={title}
      title={title}
    >
      <Icon size={12} strokeWidth={2} aria-hidden="true" />
    </span>
  );
}

/**
 * Lifecycle status badge in the chat header (PR109b §9.8). Visual
 * tone matches the SessionStatusIcon mapping so the sidebar row icon
 * and the header badge read as the same status.
 */
function SessionStatusBadge(props: {
  badge: {
    status: string;
    label: string;
    tone: 'accent' | 'warning' | 'destructive' | 'info' | 'success' | 'muted' | 'neutral';
    tooltip?: string;
  };
}) {
  return (
    <span
      className="maka-chat-header-status"
      data-tone={props.badge.tone}
      data-status={props.badge.status}
      role="status"
      aria-label={props.badge.tooltip ?? props.badge.label}
      title={props.badge.tooltip ?? props.badge.label}
    >
      <span>{props.badge.label}</span>
    </span>
  );
}

// Keep these maps in sync with `apps/desktop/src/renderer/session-status-presentation.ts`.
// The presentation helper is the authoritative source; we duplicate the
// minimum subset here to keep @maka/ui independent of the renderer
// workspace.
const STATUS_ICON_BY_STATUS = {
  running: Loader2,
  waiting_for_user: Hourglass,
  blocked: ShieldAlert,
  review: Eye,
  done: CircleCheckBig,
  archived: Archive,
  aborted: Ban,
} as const;

const STATUS_LABEL_BY_STATUS = {
  running: '进行中',
  waiting_for_user: '等你确认',
  blocked: '已阻塞',
  review: '待审核',
  done: '已完成',
  archived: '已归档',
  aborted: '已中止',
} as const;

const STATUS_TONE_BY_STATUS = {
  running: 'accent',
  waiting_for_user: 'warning',
  blocked: 'destructive',
  review: 'info',
  done: 'success',
  archived: 'muted',
  aborted: 'muted',
} as const;

const BLOCKED_REASON_TOOLTIP = {
  NO_REAL_CONNECTION: '缺少可用模型连接',
  auth: '需要重新登录',
  permission_required: '等待权限确认',
  tool_failed: '工具调用失败',
  unknown: '未知阻塞',
} as const;

const SCROLL_BOTTOM_THRESHOLD = 64; // px

const PROMPT_SUGGESTIONS: Array<{ label: string; prompt: string }> = [
  { label: '总结代码库', prompt: '帮我总结当前代码库的目录结构和关键模块。' },
  { label: '解释这段代码', prompt: '我贴一段代码进来，请帮我逐行解释它做什么、有没有坑：\n\n```\n\n```' },
  { label: '规划一个新功能', prompt: '我想实现以下功能，请帮我拆任务、列依赖、估算工作量：\n\n' },
  { label: '调试一个 bug', prompt: '我遇到一个 bug，现象是 ____，复现步骤是 ____，已经尝试过 ____。可能的原因是？' },
  { label: '写单元测试', prompt: '请为下面这个模块写 node:test 覆盖关键路径：\n\n```ts\n\n```' },
  { label: 'Code review', prompt: '请帮我 review 这段代码，重点关注可读性、错误处理和潜在性能问题：\n\n```\n\n```' },
];

function SessionRow(props: {
  session: SessionSummary;
  active: boolean;
  /** This session has a live streaming delta in flight. */
  streaming?: boolean;
  /**
   * This session's backend / connection is stale (FakeBackend or a removed
   * connection slug). Dims the row + renders a small "已过期" pill so the
   * user can spot broken sessions in the list before clicking in.
   */
  stale?: boolean;
  onSelect(sessionId: string): void;
  actions?: SessionRowActions;
}) {
  const { session, active, streaming, stale, actions, onSelect } = props;
  const [editing, setEditing] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  // Auto-focus + select-all when the row enters edit mode so the user can
  // overwrite the current name without an extra Cmd+A.
  useEffect(() => {
    if (!editing) return;
    const input = inputRef.current;
    if (!input) return;
    input.focus();
    input.select();
  }, [editing]);

  const stopPropagation = (event: MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation();
  };

  function startRename(event: MouseEvent<HTMLButtonElement>) {
    stopPropagation(event);
    if (!actions) return;
    setEditing(true);
  }

  function commitRename(rawValue: string) {
    const trimmed = rawValue.trim();
    setEditing(false);
    if (!trimmed || trimmed === session.name) return;
    actions?.onRename(session.id, trimmed);
  }

  function handleDelete(event: MouseEvent<HTMLButtonElement>) {
    stopPropagation(event);
    if (!actions) return;
    // Delegation: the App-level handler owns the confirmation flow via the
    // toast system (PR24), so SessionRow stays presentation-only.
    actions.onDelete(session.id);
  }

  return (
    <div
      className="maka-list-row"
      data-active={active}
      data-editing={editing}
      data-streaming={streaming ? 'true' : undefined}
      data-stale={stale ? 'true' : undefined}
    >
      {editing ? (
        <form
          className="maka-list-row-main"
          onSubmit={(event) => {
            event.preventDefault();
            commitRename(inputRef.current?.value ?? '');
          }}
        >
          <div>
            <input
              ref={inputRef}
              className="maka-list-row-rename-input"
              defaultValue={session.name}
              maxLength={80}
              aria-label="重命名对话"
              onBlur={(event) => commitRename(event.currentTarget.value)}
              onKeyDown={(event) => {
                // IME guard so committing CJK characters with Enter doesn't
                // submit the rename before the user is done.
                if (event.nativeEvent.isComposing || event.key === 'Process') return;
                if (event.key === 'Escape') {
                  event.preventDefault();
                  setEditing(false);
                }
              }}
              autoComplete="off"
              spellCheck={false}
            />
            <div className="maka-list-row-meta">{formatSessionMeta(session)}</div>
          </div>
        </form>
      ) : (
        <button
          className="maka-list-row-main"
          type="button"
          data-session-id={session.id}
          onClick={() => onSelect(session.id)}
          onDoubleClick={(event) => {
            event.stopPropagation();
            if (actions) setEditing(true);
          }}
        >
          <div className="maka-list-row-text">
            <div className="maka-list-row-name">
              {streaming && (
                <span
                  className="maka-list-row-streaming-dot"
                  aria-label="正在响应"
                  title="对话正在流式响应中"
                />
              )}
              <SessionStatusIcon session={session} />
              <span>{session.name}</span>
              {stale && (
                <span
                  className="maka-list-row-stale-pill"
                  // The pill semantics match the chat-header banner: the
                  // session uses a backend / connection that no longer exists,
                  // but @xuan's send-path silent rebind will swap to the
                  // default on send. Tooltip explains why.
                  title="此会话使用的 backend / 连接已不可用，发送时会切换到默认连接"
                  aria-label="会话已过期"
                >
                  已过期
                </span>
              )}
            </div>
            {streaming ? (
              <div className="maka-list-row-preview" data-streaming="true">
                Maka 正在思考…
              </div>
            ) : session.lastMessagePreview ? (
              <div className="maka-list-row-preview" title={session.lastMessagePreview}>
                {session.lastMessagePreview}
              </div>
            ) : null}
            <div className="maka-list-row-meta">{formatSessionMeta(session)}</div>
          </div>
          {session.hasUnread && !streaming && <span className="maka-list-row-unread" />}
        </button>
      )}
      {actions && !editing && (
        <div className="maka-list-row-actions" aria-label="对话操作">
          <button
            type="button"
            className="maka-list-row-action"
            onClick={(event) => {
              stopPropagation(event);
              actions.onToggleFlag(session.id, !session.isFlagged);
            }}
            aria-label={session.isFlagged ? 'Unpin chat' : 'Pin chat'}
            data-active={session.isFlagged}
            title={session.isFlagged ? 'Unpin chat' : 'Pin chat'}
          >
            {session.isFlagged
              ? <PinOff size={14} strokeWidth={1.75} aria-hidden="true" />
              : <Pin size={14} strokeWidth={1.75} aria-hidden="true" />}
          </button>
          <button
            type="button"
            className="maka-list-row-action"
            onClick={startRename}
            aria-label="重命名对话"
            title="重命名（双击行名也可）"
          >
            <Pencil size={14} strokeWidth={1.75} aria-hidden="true" />
          </button>
          <button
            type="button"
            className="maka-list-row-action"
            onClick={(event) => {
              stopPropagation(event);
              session.isArchived
                ? actions.onUnarchive(session.id)
                : actions.onArchive(session.id);
            }}
            aria-label={session.isArchived ? '取消归档对话' : '归档对话'}
            title={session.isArchived ? '取消归档' : '归档'}
          >
            {session.isArchived
              ? <ArchiveRestore size={14} strokeWidth={1.75} aria-hidden="true" />
              : <Archive size={14} strokeWidth={1.75} aria-hidden="true" />}
          </button>
          <button
            type="button"
            className="maka-list-row-action maka-list-row-action-danger"
            onClick={handleDelete}
            aria-label="删除对话"
            title="删除"
          >
            <Trash2 size={14} strokeWidth={1.75} aria-hidden="true" />
          </button>
        </div>
      )}
    </div>
  );
}

interface PermissionModeMeta {
  label: string;
  hint: string;
  tone: 'info' | 'accent' | 'caution';
}

const PERMISSION_MODE_META: Record<PermissionMode, PermissionModeMeta> = {
  explore: {
    label: 'Explore',
    hint: '只读模式：read/list/grep 直通，写入或网络仍需明确确认。',
    tone: 'info',
  },
  ask: {
    label: 'Ask',
    hint: '平衡模式：敏感工具调用前必须 allow / deny。',
    tone: 'accent',
  },
  execute: {
    label: 'Execute',
    hint: '执行模式：信任的工具调用直通；破坏性操作仍会拦截。',
    tone: 'caution',
  },
};

const PERMISSION_MODE_ORDER: PermissionMode[] = ['explore', 'ask', 'execute'];

export interface ChatHeaderAlert {
  /** Visual tone — drives badge color in the chat header. */
  tone: 'info' | 'warning' | 'destructive';
  /** Short label shown inside the chat header (e.g. "需要重新登录"). */
  label: string;
  /**
   * Optional longer explanation rendered as the badge's `title` attribute
   * (native browser tooltip). Use this to explain WHY the badge is up
   * without bloating the label — e.g. "原会话使用演示 backend，发送时
   * 会切换到默认连接".
   */
  tooltip?: string;
  /** Optional click handler — e.g. open Settings · 账号 to fix it. */
  onClick?(): void;
}

export function ChatView(props: {
  messages: StoredMessage[];
  streamingText: string;
  tools: ToolActivityItem[];
  activeSession?: SessionSummary;
  activeConnectionLabel?: string;
  activeModelLabel?: string;
  /** Renders a provider brand mark next to the model name in the chat tab. */
  activeProviderType?: ProviderType;
  /** Optional renderer for the provider mark; supplied by the desktop app to
   *  avoid bringing the full provider SVG library into @maka/ui. */
  renderProviderMark?(type: ProviderType): ReactNode;
  /** Personalized user label shown on user messages. Falls back to "你". */
  userLabel?: string;
  mode: NavSelection['section'];
  /**
   * When the user has no real LLM connection configured, the empty state
   * defers to this slot. App renders `<OnboardingHero>` here; if undefined,
   * the regular prompt-suggestion hero shows.
   */
  emptyOverride?: ReactNode;
  /**
   * Surfaces a small status pill in the chat header — used to expose a
   * `needs_reauth` / `error` connection state from the credential
   * lifecycle directly into the chat surface so the user notices before
   * sending another doomed message.
   */
  connectionAlert?: ChatHeaderAlert;
  /**
   * Lifecycle status badge for the active session (PR109b, design-system
   * §9.8). Separate from `connectionAlert` because the alert is an
   * ephemeral fault signal while status is the session's settled
   * lifecycle position. Hidden for `active` (default) to reduce noise.
   */
  sessionStatusBadge?: {
    status: string;
    label: string;
    tone: 'accent' | 'warning' | 'destructive' | 'info' | 'success' | 'muted' | 'neutral';
    tooltip?: string;
  };
  /**
   * PR109d-b: footer actions per turn, keyed by turnId. The renderer
   * (apps/desktop/src/renderer/main.tsx) computes these from
   * `deriveTurnFooterActions()` over each turn's `TurnStatus` + lineage
   * state, then hands them in. Keeps the action policy with the
   * consumer that has visibility into the full turn list.
   */
  turnFooterActionsByTurn?: Record<string, ReadonlyArray<TurnFooterActionMeta>>;
  onTurnFooterAction?: (turnId: string, actionId: TurnFooterActionMeta['id']) => void;
  /**
   * PR109e-d/e: per-turn metadata for failed banner + lineage badges.
   * Renderer computes from materialized turns + lineage map + the
   * generalized error-class mapping (`describeTurnErrorClass()`),
   * keeping enum-to-Chinese translation outside @maka/ui.
   */
  turnFailedReasonLabels?: Record<string, string>;
  turnLineageBadgesByTurn?: Record<string, TurnLineageBadge[]>;
  onLineageBadgeClick?: (targetTurnId: string) => void;
  onNew(): void;
  onPromptSuggestion?(prompt: string): void;
  onPermissionModeChange?(mode: PermissionMode): void;
}) {
  // chat + storedTools survive for the empty-state and streaming-bubble
  // paths; the main message log is now driven by `turns` (per @kenji UI-04
  // turn-grouping projection).
  const chat = materializeChat(props.messages);
  const storedTools = materializeTools(props.messages);
  const tools = mergeTools(storedTools, props.tools);
  const turns = materializeTurns(props.messages, props.tools);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [pinnedToBottom, setPinnedToBottom] = useState(true);

  // Reset to "pinned at bottom" whenever the active session changes. Without
  // this, switching from a long history to a fresh chat would keep the
  // previous scrollTop and the user wouldn't see their last message.
  useEffect(() => {
    setPinnedToBottom(true);
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [props.activeSession?.id]);

  // Auto-scroll on new content if the user is already at (or near) the
  // bottom. If they've scrolled up to read history we don't yank them back.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || !pinnedToBottom) return;
    el.scrollTop = el.scrollHeight;
  }, [chat.length, props.streamingText, tools.length, pinnedToBottom]);

  function onScroll() {
    const el = scrollRef.current;
    if (!el) return;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    setPinnedToBottom(distanceFromBottom <= SCROLL_BOTTOM_THRESHOLD);
  }

  function scrollToBottom() {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
    setPinnedToBottom(true);
  }

  if (props.mode === 'skills') {
    return (
      <main className="maka-main detailPane">
        <div className="maka-center-state">No skill selected</div>
      </main>
    );
  }

  const streaming = props.streamingText.length > 0;
  const switcherDisabled = streaming || !props.activeSession || !props.onPermissionModeChange;

  if (!props.activeSession) {
    return (
      <main className="maka-main detailPane">
        <header className="maka-chat-header">
          <ChatTab title="新建对话" />
          <button className="maka-chat-tab-plus" type="button" aria-label="新建对话" onClick={props.onNew}>
            <Plus strokeWidth={1.5} />
          </button>
          <span className="maka-chat-header-spacer" />
          <PermissionModeSwitcher mode="ask" disabled disabledReason="新建对话后再切换模式。" />
        </header>
        <div className="maka-chat messages">
          {props.emptyOverride ?? <EmptyChatHero onPromptSuggestion={props.onPromptSuggestion} userLabel={props.userLabel} />}
        </div>
      </main>
    );
  }

  const isFakeBackend = props.activeSession.backend === 'fake';

  return (
    <main className="maka-main detailPane">
      <header className="maka-chat-header">
        <ChatTab
          title={props.activeSession.name}
          subtitle={props.activeModelLabel ?? props.activeConnectionLabel}
          subtitleHint={props.activeConnectionLabel && props.activeModelLabel
            ? `${props.activeConnectionLabel} · ${props.activeModelLabel}`
            : undefined}
          providerMark={props.activeProviderType && props.renderProviderMark
            ? props.renderProviderMark(props.activeProviderType)
            : undefined}
        />
        <button className="maka-chat-tab-plus" type="button" aria-label="新建对话" onClick={props.onNew}>
          <Plus strokeWidth={1.5} />
        </button>
        <span className="maka-chat-header-spacer" />
        {props.sessionStatusBadge && <SessionStatusBadge badge={props.sessionStatusBadge} />}
        {props.connectionAlert && <ChatHeaderAlertBadge alert={props.connectionAlert} />}
        <PermissionModeSwitcher
          mode={props.activeSession.permissionMode}
          disabled={switcherDisabled}
          disabledReason={streaming ? '当前对话正在流式输出，等结束后再切换权限模式。' : undefined}
          onChange={props.onPermissionModeChange}
        />
      </header>
      {isFakeBackend && (
        <div className="maka-fake-backend-banner" role="status">
          <AlertTriangle size={14} strokeWidth={1.75} aria-hidden="true" />
          <span>当前会话用的是 FakeBackend（echo 模拟）。要拿到真实 LLM 回复，请到 <strong>设置 · 模型</strong> 添加 Anthropic / OpenAI / GLM 等 API key。</span>
        </div>
      )}
      <div className="maka-chat-shell">
        <div ref={scrollRef} className="maka-chat messages" onScroll={onScroll}>
          {chat.length === 0 && !props.streamingText && (
            props.emptyOverride ?? <EmptyChatHero onPromptSuggestion={props.onPromptSuggestion} userLabel={props.userLabel} />
          )}
          {turns.map((turn) => (
            <TurnView
              key={turn.turnId}
              turn={turn}
              userLabel={props.userLabel}
              footerActions={props.turnFooterActionsByTurn?.[turn.turnId]}
              onFooterAction={(actionId) => props.onTurnFooterAction?.(turn.turnId, actionId)}
              failedReasonLabel={props.turnFailedReasonLabels?.[turn.turnId]}
              lineageBadges={props.turnLineageBadgesByTurn?.[turn.turnId]}
              onLineageBadgeClick={props.onLineageBadgeClick}
            />
          ))}
          {props.streamingText && (
            <article className="maka-message-row maka-turn-streaming message assistant streaming">
              <MessageMeta role="assistant" userLabel={props.userLabel} />
              <div className="maka-bubble-assistant maka-bubble-streaming">
                <Markdown text={props.streamingText} />
              </div>
            </article>
          )}
          {/* Defensive: if any tool ended up outside a turn (e.g. legacy
              sessions without turnId), render those at the very end so they
              still appear instead of vanishing. materializeTurns already
              folds these into the `__loose` turn, so this is normally a
              no-op. */}
        </div>
        {!pinnedToBottom && (
          <button
            type="button"
            className="maka-chat-jump-bottom"
            onClick={scrollToBottom}
            aria-label="跳到最新消息"
          >
            <ArrowDown size={16} strokeWidth={2} aria-hidden="true" />
          </button>
        )}
      </div>
    </main>
  );
}

/**
 * Renders an individual chat message body.
 *
 * - `user` messages stay verbatim (whitespace + line breaks preserved); the
 *   user's literal input shouldn't be reinterpreted as markdown.
 * - `assistant` / `system` (and anything else) flow through the markdown
 *   renderer so code fences, lists, tables, and links display natively.
 *
 * Assistant messages get a hover Copy button that yanks the raw markdown
 * source to the clipboard.
 *
 * Memoized because chat scroll re-renders the whole list on every streaming
 * delta; this keeps already-final bubbles from re-parsing markdown.
 */
const MessageBody = memo(function MessageBody(props: { role: string; text: string }) {
  if (props.role === 'user') {
    return <div className="maka-bubble-user">{props.text}</div>;
  }
  return (
    <div className="maka-bubble-assistant maka-bubble-with-actions">
      <Markdown text={props.text} />
      <MessageCopyButton text={props.text} />
    </div>
  );
});

function MessageCopyButton(props: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(props.text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1400);
    } catch {
      /* clipboard unavailable — silently fail, button stays in default state */
    }
  }

  const baseLabel = props.label ?? '复制消息';
  return (
    <button
      type="button"
      className="maka-message-copy"
      onClick={copy}
      aria-label={copied ? `已复制 · ${baseLabel}` : baseLabel}
      data-copied={copied}
      data-labelled={props.label ? 'true' : undefined}
    >
      {copied ? <Check size={14} strokeWidth={2} aria-hidden="true" /> : <Copy size={14} strokeWidth={1.75} aria-hidden="true" />}
      {props.label && <span>{copied ? '已复制' : props.label}</span>}
    </button>
  );
}

const MARKDOWN_REMARK_PLUGINS = [remarkGfm, remarkBreaks];
const MARKDOWN_REHYPE_PLUGINS = [
  // `detect: true` lets hljs guess the language when the fence didn't tag one;
  // `ignoreMissing: true` keeps bogus tags like ```mermaid from throwing.
  [rehypeHighlight, { detect: true, ignoreMissing: true }],
] as const;

function Markdown(props: { text: string }) {
  return (
    <ReactMarkdown
      remarkPlugins={MARKDOWN_REMARK_PLUGINS}
      rehypePlugins={MARKDOWN_REHYPE_PLUGINS as never}
      components={{
        // Force external links to open in a new window — Electron will route
        // through the OS default browser when the renderer is configured to.
        a: ({ children, href, ...rest }) => (
          <a {...rest} href={href} target="_blank" rel="noreferrer noopener">
            {children}
          </a>
        ),
        // Inline `code` keeps the bubble's foreground color; only block code
        // gets the framed treatment via `pre > code` in CSS.
        code: ({ children, className, ...rest }) => (
          <code {...rest} className={className}>
            {children}
          </code>
        ),
        // Wrap block code with a language pill header + copy affordance.
        // The pill is alma-inspired (40-markdown-deep §7a) — surfaces the
        // detected language so users can verify hljs got it right.
        pre: ({ children, ...rest }) => <CodeBlock {...rest}>{children}</CodeBlock>,
      }}
    >
      {props.text}
    </ReactMarkdown>
  );
}

function CodeBlock({ children, ...rest }: { children?: ReactNode }) {
  // Extract the language from the inner <code class="language-xxx hljs"> if
  // there is one. react-markdown's `pre` always receives a single `code`
  // child, but downstream rehype plugins may have layered classes on it.
  const code = isElementWithClassName(children) ? children : null;
  const lang = code?.props.className?.match(/language-([A-Za-z0-9_+-]+)/)?.[1]?.toLowerCase();
  const [copied, setCopied] = useState(false);

  async function copy() {
    const text = collectCodeText(code?.props.children);
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1400);
    } catch {
      /* clipboard unavailable */
    }
  }

  return (
    <div className="maka-code-block">
      <div className="maka-code-block-header">
        <span className="maka-code-block-lang">{lang ?? 'code'}</span>
        <button
          type="button"
          className="maka-code-block-copy"
          onClick={copy}
          aria-label={copied ? 'Copied' : 'Copy code'}
          data-copied={copied}
        >
          {copied
            ? <Check size={12} strokeWidth={2} aria-hidden="true" />
            : <Copy size={12} strokeWidth={1.75} aria-hidden="true" />}
        </button>
      </div>
      <pre {...rest}>{children}</pre>
    </div>
  );
}

function isElementWithClassName(node: ReactNode): node is React.ReactElement<{ className?: string; children?: ReactNode }> {
  return typeof node === 'object' && node !== null && 'props' in node;
}

function collectCodeText(children: ReactNode): string {
  if (typeof children === 'string') return children;
  if (Array.isArray(children)) return children.map(collectCodeText).join('');
  if (isElementWithClassName(children)) return collectCodeText(children.props.children);
  return '';
}

function EmptyChatHero(props: { onPromptSuggestion?(prompt: string): void; userLabel?: string }) {
  // Greet the user by name when they've set one in Personalization Settings.
  // Falls back to a neutral title so first-run users don't see "Hi 你, …".
  const label = props.userLabel?.trim();
  return (
    <div className="emptyChat compact">
      <span className="eyebrow">Maka</span>
      <h1>
        {label
          ? `${label}，今天想一起做点什么？`
          : '想一起做点什么？'}
      </h1>
      <p>说一下你要改的、想问的、想查的；下面是几个常用起点。</p>
      {props.onPromptSuggestion && (
        <ul className="maka-prompt-suggestions" aria-label="提示建议">
          {PROMPT_SUGGESTIONS.map((suggestion) => (
            <li key={suggestion.label}>
              <button
                type="button"
                className="maka-prompt-chip"
                onClick={() => props.onPromptSuggestion?.(suggestion.prompt)}
              >
                <span className="maka-prompt-chip-label">{suggestion.label}</span>
                <span className="maka-prompt-chip-hint">{suggestion.prompt.split('\n')[0]?.slice(0, 60)}…</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * Small actionable pill that surfaces a credential / readiness issue
 * inline in the chat header. Kept neutral about the source — it just
 * renders a tone + label and an optional click handler. The connection
 * lifecycle helper in the desktop renderer decides when to mount this.
 */
function ChatHeaderAlertBadge(props: { alert: ChatHeaderAlert }) {
  const { tone, label, tooltip, onClick } = props.alert;
  const Tag = onClick ? 'button' : 'span';
  return (
    <Tag
      className="maka-chat-header-alert"
      data-tone={tone}
      type={onClick ? 'button' : undefined}
      onClick={onClick}
      aria-label={tooltip ?? label}
      title={tooltip}
    >
      <AlertTriangle size={12} strokeWidth={2} aria-hidden="true" />
      <span>{label}</span>
    </Tag>
  );
}

function PermissionModeSwitcher(props: {
  mode: PermissionMode;
  disabled?: boolean;
  disabledReason?: string;
  onChange?(mode: PermissionMode): void;
}) {
  const active = PERMISSION_MODE_META[props.mode];
  return (
    <div
      className="maka-mode-switcher"
      role="radiogroup"
      aria-label="权限模式"
      data-disabled={props.disabled || undefined}
      title={props.disabledReason ?? active.hint}
    >
      {PERMISSION_MODE_ORDER.map((mode) => {
        const meta = PERMISSION_MODE_META[mode];
        const isActive = mode === props.mode;
        return (
          <button
            key={mode}
            type="button"
            role="radio"
            aria-checked={isActive}
            disabled={props.disabled || !props.onChange}
            data-active={isActive}
            data-tone={meta.tone}
            className="maka-mode-switcher-option"
            onClick={() => {
              if (!props.disabled && props.onChange && mode !== props.mode) {
                props.onChange(mode);
              }
            }}
            title={meta.hint}
          >
            {meta.label}
          </button>
        );
      })}
    </div>
  );
}

const messageTimeFormat = (() => {
  if (typeof Intl === 'undefined' || typeof Intl.RelativeTimeFormat !== 'function') {
    return { format: (n: number, unit: Intl.RelativeTimeFormatUnit) => `${n}${unit[0]}` } as unknown as Intl.RelativeTimeFormat;
  }
  return new Intl.RelativeTimeFormat(
    typeof navigator !== 'undefined' ? navigator.language : 'en',
    { numeric: 'auto', style: 'narrow' },
  );
})();

const absoluteTimeFormat = (() => {
  if (typeof Intl === 'undefined' || typeof Intl.DateTimeFormat !== 'function') {
    return { format: (d: Date) => d.toISOString() } as unknown as Intl.DateTimeFormat;
  }
  return new Intl.DateTimeFormat(
    typeof navigator !== 'undefined' ? navigator.language : 'en',
    { dateStyle: 'medium', timeStyle: 'short' },
  );
})();

function formatRelativeTimestamp(ts: number): string {
  const diffMs = Date.now() - ts;
  const diffSeconds = Math.round(diffMs / 1000);
  if (diffSeconds < 60) return messageTimeFormat.format(-Math.max(1, diffSeconds), 'second');
  const diffMinutes = Math.round(diffSeconds / 60);
  if (diffMinutes < 60) return messageTimeFormat.format(-diffMinutes, 'minute');
  const diffHours = Math.round(diffMinutes / 60);
  if (diffHours < 24) return messageTimeFormat.format(-diffHours, 'hour');
  return messageTimeFormat.format(-Math.round(diffHours / 24), 'day');
}

function formatAbsoluteTimestamp(ts: number): string {
  return absoluteTimeFormat.format(new Date(ts));
}

function messageRoleLabel(role: string, userLabel?: string): string {
  if (role === 'user') {
    const trimmed = userLabel?.trim();
    return trimmed && trimmed.length > 0 ? trimmed : '你';
  }
  if (role === 'assistant') return 'Maka';
  return role;
}

/**
 * Initial-glyph derivation for the message avatar. Uses the first non-ASCII
 * codepoint or first ASCII letter so a userLabel like "JK" → "J", a Chinese
 * userLabel like "建文" → "建", an emoji name like "🦊 fox" → "🦊".
 */
function avatarInitial(label: string): string {
  const trimmed = label.trim();
  if (trimmed.length === 0) return '你';
  // Pull the first codepoint so we don't slice an emoji surrogate pair.
  const [first] = trimmed;
  return first ?? '?';
}

/**
 * Compact summary strip rendered between the user message and the tools/
 * answer for the current turn. Surfaces the @kenji UI-04 follow-up
 * questions: which model, how many tools, how long. Only renders when at
 * least one signal is present so an in-flight first-render doesn't show
 * an empty chip strip.
 */
function TurnSummary(props: { turn: TurnViewModel }) {
  const { turn } = props;
  const hasModel = Boolean(turn.modelId);
  const hasTools = turn.tools.length > 0;
  // Show duration only when the assistant has actually landed (durationMs
  // is computed from assistant.ts). For in-progress turns we render an
  // "进行中" pill instead of a number that would tick up forever — per
  // @kenji's PR82 review.
  const hasDuration = turn.durationMs !== undefined && turn.durationMs > 0;
  const inProgress = turn.user !== undefined && turn.assistant === undefined;
  const hasTokens = Boolean(turn.tokens && (turn.tokens.input > 0 || turn.tokens.output > 0));
  // costUsd is only meaningful when present AND > 0 — never fabricate a
  // "$0.00" hover, that reads as false precision (also @kenji PR82 review).
  const hasCost = turn.tokens?.costUsd !== undefined && turn.tokens.costUsd > 0;
  if (!hasModel && !hasTools && !hasDuration && !hasTokens && !inProgress) return null;
  return (
    <div className="maka-turn-summary" aria-label="本轮对话摘要">
      {hasModel && (
        <span className="maka-turn-summary-chip" data-kind="model" title={turn.modelId}>
          <code>{turn.modelId}</code>
        </span>
      )}
      {hasTools && (
        <span className="maka-turn-summary-chip" data-kind="tools">
          {turn.tools.length} 个工具
        </span>
      )}
      {hasDuration ? (
        <span className="maka-turn-summary-chip" data-kind="duration">
          {formatTurnDuration(turn.durationMs!)}
        </span>
      ) : inProgress ? (
        <span className="maka-turn-summary-chip" data-kind="duration" data-state="in-progress">
          进行中
        </span>
      ) : null}
      {hasTokens && (
        <span
          className="maka-turn-summary-chip"
          data-kind="tokens"
          title={hasCost ? `$${turn.tokens!.costUsd!.toFixed(4)}` : undefined}
        >
          {turn.tokens!.input.toLocaleString()} → {turn.tokens!.output.toLocaleString()} tok
        </span>
      )}
    </div>
  );
}

function formatTurnDuration(ms: number): string {
  if (ms < 1000) return `${ms} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)} s`;
  const m = Math.floor(ms / 60_000);
  const s = Math.round((ms % 60_000) / 1000);
  return `${m} m ${s} s`;
}

/**
 * Renders one conversational turn: user message → tools used → assistant
 * answer, in that order, as a single visual unit. Replaces the previous
 * "message stack + tools panel at end" layout so the user sees the
 * narrative of "ask → tools fired → answer" as one work unit.
 */
function TurnView(props: {
  turn: TurnViewModel;
  userLabel?: string;
  /**
   * PR109d-b: footer actions derived from `TurnStatus` + lineage map
   * by the consumer (renderer/main.tsx). Each action carries its
   * own `enabled` flag + tooltip; @maka/ui doesn't compute these
   * itself so the policy stays in the renderer where the lineage
   * map is built.
   */
  footerActions?: ReadonlyArray<TurnFooterActionMeta>;
  onFooterAction?: (actionId: TurnFooterActionMeta['id']) => void;
  /**
   * PR109e-d: pre-translated Chinese phrase for a failed turn's
   * `errorClass`. Caller computes via `describeTurnErrorClass()`.
   * Undefined for non-failed turns or when the runtime didn't
   * populate `errorClass`. UI never sees the raw enum identifier.
   */
  failedReasonLabel?: string;
  /**
   * PR109e-e: forward + reverse lineage badges. The renderer
   * computes the labels (with short turn ids) and click targets;
   * @maka/ui just renders the badge UI.
   */
  lineageBadges?: TurnLineageBadge[];
  /** PR109e-e: invoked when the user clicks a lineage badge. The
   *  renderer scrolls the target turn into view. */
  onLineageBadgeClick?: (targetTurnId: string) => void;
}) {
  const { turn } = props;
  const forwardBadges = props.lineageBadges?.filter((b) => b.direction === 'forward') ?? [];
  const reverseBadges = props.lineageBadges?.filter((b) => b.direction === 'reverse') ?? [];
  return (
    <section className="maka-turn" data-turn-id={turn.turnId}>
      {forwardBadges.length > 0 && (
        <div className="maka-turn-lineage-row" aria-label="本轮回答的来源">
          {forwardBadges.map((badge) => (
            <button
              key={badge.id}
              type="button"
              className="maka-turn-lineage-badge"
              data-direction="forward"
              title={badge.tooltip ?? badge.label}
              onClick={() => props.onLineageBadgeClick?.(badge.targetTurnId)}
            >
              <GitBranch size={11} strokeWidth={2} aria-hidden="true" />
              <span>{badge.label}</span>
            </button>
          ))}
        </div>
      )}
      {turn.user && (
        <article
          className="maka-message-row message user"
          title={turn.user.ts ? formatAbsoluteTimestamp(turn.user.ts) : undefined}
        >
          <MessageMeta role="user" userLabel={props.userLabel} ts={turn.user.ts} />
          <MessageBody role="user" text={turn.user.text} />
        </article>
      )}
      <TurnSummary turn={turn} />

      {turn.notes.map((note) => (
        <article
          key={note.id}
          className="maka-message-row message system"
          title={note.ts ? formatAbsoluteTimestamp(note.ts) : undefined}
        >
          <MessageMeta role="system" userLabel={props.userLabel} ts={note.ts} />
          <MessageBody role="system" text={note.text} />
        </article>
      ))}
      {turn.tools.length > 0 && (
        <div className="maka-turn-tools">
          <ToolActivity items={turn.tools} />
        </div>
      )}
      {turn.assistant && (
        <article
          className="maka-message-row message assistant"
          data-turn-status={turn.status}
          title={turn.assistant.ts ? formatAbsoluteTimestamp(turn.assistant.ts) : undefined}
        >
          <MessageMeta role="assistant" userLabel={props.userLabel} ts={turn.assistant.ts} />
          <div className="maka-bubble-assistant-stack">
            {turn.assistantThinking && (
              <details className="maka-turn-thinking">
                <summary>
                  <span>查看思考过程</span>
                  <span className="maka-turn-thinking-note">模型推理草稿，不是最终答案</span>
                </summary>
                <div className="maka-turn-thinking-body">
                  <Markdown text={turn.assistantThinking} />
                  <div className="maka-turn-thinking-actions">
                    <MessageCopyButton text={turn.assistantThinking} label="复制思考过程" />
                  </div>
                </div>
              </details>
            )}
            {/* PR109d-c: aborted turn body gets a muted "(已中断)" prefix
                + Ban icon so the user can see this turn was cancelled
                without it looking like a fault state (which is reserved
                for `failed`). Lives in the message body wrapper so the
                Copy button below still copies the assistant text without
                the prefix. */}
            {turn.status === 'aborted' && (
              <div className="maka-turn-aborted-marker" role="status">
                <Ban size={12} strokeWidth={2} aria-hidden="true" />
                <em>(已中断)</em>
              </div>
            )}
            {/* PR109e-d: failed turn AlertOctagon banner with generalized
                Chinese copy (no raw `errorClass` leak per @kenji gate #3).
                Caller passes the pre-translated `failedReasonLabel` —
                @maka/ui doesn't know how to translate the runtime enum;
                that mapping lives in `session-status-presentation.ts`
                via `describeTurnErrorClass()`. */}
            {turn.status === 'failed' && props.failedReasonLabel && (
              <div className="maka-turn-failed-banner" role="alert">
                <span className="maka-turn-failed-icon" aria-hidden="true">
                  <AlertOctagon size={14} strokeWidth={2} />
                </span>
                <span>{props.failedReasonLabel}</span>
              </div>
            )}
            <MessageBody role="assistant" text={turn.assistant.text} />
          </div>
          {reverseBadges.length > 0 && (
            <div className="maka-turn-lineage-row maka-turn-lineage-row-reverse" aria-label="本轮回答的衍生">
              {reverseBadges.map((badge) => (
                <button
                  key={badge.id}
                  type="button"
                  className="maka-turn-lineage-badge"
                  data-direction="reverse"
                  title={badge.tooltip ?? badge.label}
                  onClick={() => props.onLineageBadgeClick?.(badge.targetTurnId)}
                >
                  <GitBranch size={11} strokeWidth={2} aria-hidden="true" />
                  <span>{badge.label}</span>
                </button>
              ))}
            </div>
          )}
          {props.footerActions && props.footerActions.length > 0 && (
            <TurnFooterActions
              actions={props.footerActions}
              onAction={props.onFooterAction}
              assistantText={turn.assistant.text}
            />
          )}
        </article>
      )}
    </section>
  );
}

/**
 * Turn footer actions row (PR109d-b). Renders icon+text buttons for
 * `重试 / 重新生成 / 分支 / 复制` driven by the pure helper's enabled
 * matrix. Disabled buttons stay rendered so the user can see what
 * actions exist on the turn; click handlers no-op when disabled.
 *
 * Copy action is handled locally (write to clipboard) so the
 * consumer doesn't need a clipboard IPC for it. Other actions
 * (retry / regenerate / branch) bubble up via `onAction`.
 */
export interface TurnFooterActionMeta {
  id: 'retry' | 'regenerate' | 'branch' | 'copy';
  label: string;
  enabled: boolean;
  tooltip?: string;
}

/**
 * Lineage badge rendered on a turn, either pointing to its origin
 * ("重试自 turn ${id}") or to a descendant ("已重试 → turn ${id}").
 * Renderer (main.tsx) computes the labels and targets from the lineage
 * map; @maka/ui renders the badge UI. PR109e-e.
 */
export interface TurnLineageBadge {
  /** Stable key for React. */
  id: string;
  /** Chinese label. UI surfaces it verbatim — caller is responsible for
   *  generalized phrasing (never expose enum identifiers). */
  label: string;
  /** Optional tooltip / aria-label override. Falls back to `label`. */
  tooltip?: string;
  /** Click target turn id. Renderer scrolls + highlights that turn. */
  targetTurnId: string;
  /**
   * Forward = "this turn was retried/regenerated from another";
   * reverse = "another turn descends from this one". UI shows them
   * in different positions (forward at top, reverse at bottom).
   */
  direction: 'forward' | 'reverse';
}

function TurnFooterActions(props: {
  actions: ReadonlyArray<TurnFooterActionMeta>;
  onAction?: (actionId: TurnFooterActionMeta['id']) => void;
  /** Assistant text used by the inline copy action. */
  assistantText?: string;
}) {
  async function handleClick(action: TurnFooterActionMeta) {
    if (!action.enabled) return;
    if (action.id === 'copy') {
      if (!props.assistantText) return;
      try {
        await navigator.clipboard.writeText(props.assistantText);
      } catch {
        /* silent — clipboard may be unavailable; UI Copy doesn't toast here */
      }
      return;
    }
    props.onAction?.(action.id);
  }
  return (
    <div className="maka-turn-footer" role="toolbar" aria-label="本轮回答操作">
      {props.actions.map((action) => {
        // Per @kenji review: pending state must keep the original button
        // label visible (not a spinner-only) so screen readers can hear
        // which action is processing. `aria-busy="true"` is the AT signal.
        const isPending = action.tooltip === '正在处理…';
        return (
          <button
            key={action.id}
            type="button"
            className="maka-turn-footer-action"
            data-action={action.id}
            data-pending={isPending || undefined}
            disabled={!action.enabled}
            aria-disabled={!action.enabled}
            aria-busy={isPending || undefined}
            title={action.tooltip ?? action.label}
            onClick={() => void handleClick(action)}
          >
            {STATUS_FOOTER_ICON[action.id]}
            <span>{action.label}</span>
          </button>
        );
      })}
    </div>
  );
}

const STATUS_FOOTER_ICON: Record<TurnFooterActionMeta['id'], ReactNode> = {
  retry: <Repeat size={12} strokeWidth={2} aria-hidden="true" />,
  regenerate: <RefreshCcw size={12} strokeWidth={2} aria-hidden="true" />,
  branch: <GitBranch size={12} strokeWidth={2} aria-hidden="true" />,
  copy: <Copy size={12} strokeWidth={2} aria-hidden="true" />,
};

function MessageMeta(props: { role: string; userLabel?: string; ts?: number }) {
  const label = messageRoleLabel(props.role, props.userLabel);
  const initial = props.role === 'assistant' ? 'M' : avatarInitial(label);
  return (
    <span className="maka-message-meta">
      <span className="maka-message-avatar" data-role={props.role} aria-hidden="true">
        {initial}
      </span>
      <span className="maka-message-name">{label}</span>
      {props.ts !== undefined && (
        <small className="maka-message-time" aria-hidden="true">
          {formatRelativeTimestamp(props.ts)}
        </small>
      )}
    </span>
  );
}

function ChatTab(props: {
  title: string;
  subtitle?: string;
  subtitleHint?: string;
  providerMark?: ReactNode;
}) {
  return (
    <div className="maka-chat-tab" title={props.subtitleHint ? `${props.title} · ${props.subtitleHint}` : props.title}>
      {props.providerMark
        ? <span className="maka-chat-tab-provider" aria-hidden="true">{props.providerMark}</span>
        : <MessageSquare className="maka-chat-tab-icon" strokeWidth={1.5} />}
      <span>{props.title}</span>
      {props.subtitle && <span className="maka-chat-tab-backend">{props.subtitle}</span>}
    </div>
  );
}

const COMPOSER_MAX_HEIGHT = 240;

export interface ComposerHandle {
  /** Replace the textarea value and resize, leaving focus on the input. */
  setText(text: string): void;
  /** Move focus to the textarea without changing its content. */
  focus(): void;
}

export const Composer = forwardRef<
  ComposerHandle,
  {
    disabled?: boolean;
    hidden?: boolean;
    /**
     * When true, the assistant is currently streaming a response.
     * Toolbar swaps to a "Maka 正在思考…" hint and the Stop button is
     * the only visible action — Send is hidden because the model is busy.
     */
    streaming?: boolean;
    onSend(text: string): boolean | void | Promise<boolean | void>;
    onStop(): void;
  }
>(function Composer(props, ref) {
  const formRef = useRef<HTMLFormElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  function autoResize() {
    const el = textareaRef.current;
    if (!el) return;
    // Standard "reset to auto, then set to scrollHeight" trick so the
    // textarea can both grow and shrink as the user edits. Cap at
    // COMPOSER_MAX_HEIGHT so it never pushes the chat surface off-screen;
    // overflow becomes an internal scroll past that.
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, COMPOSER_MAX_HEIGHT)}px`;
  }

  useImperativeHandle(
    ref,
    () => ({
      setText(text: string) {
        const el = textareaRef.current;
        if (!el) return;
        el.value = text;
        autoResize();
        el.focus();
        // Move caret to end so the user can keep typing.
        const length = el.value.length;
        el.setSelectionRange(length, length);
      },
      focus() {
        textareaRef.current?.focus();
      },
    }),
    [],
  );

  async function sendCurrent() {
    if (props.disabled) return;
    const textarea = textareaRef.current;
    const form = formRef.current;
    const text = (textarea?.value ?? '').trim();
    if (!text) return;
    const sent = await props.onSend(text);
    if (sent === false) return;
    form?.reset();
    // form.reset() empties the textarea but doesn't fire input — collapse
    // manually so the composer snaps back to its single-row footprint.
    if (textarea) {
      textarea.style.height = '';
      autoResize();
    }
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void sendCurrent();
  }

  function onTextareaKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    // Skip when an IME composition is active so CJK input isn't interrupted.
    if (event.nativeEvent.isComposing || event.key === 'Process') return;
    // Esc during streaming interrupts the model. We don't preventDefault
    // unconditionally so Esc still works to close modals when the composer
    // happens to be focused outside a streaming turn.
    if (event.key === 'Escape' && props.streaming) {
      event.preventDefault();
      props.onStop();
      return;
    }
    if (event.key !== 'Enter') return;
    if (event.shiftKey || event.altKey) return; // Shift+Enter / Alt+Enter inserts a newline.
    event.preventDefault();
    void sendCurrent();
  }

  if (props.hidden) return null;

  return (
    <form ref={formRef} className="maka-composer composer" onSubmit={submit}>
      <div className="maka-composer-inner composerInner">
        <textarea
          ref={textareaRef}
          name="text"
          placeholder="给 Maka 发消息…"
          disabled={props.disabled}
          onKeyDown={onTextareaKeyDown}
          onInput={autoResize}
          rows={1}
          autoComplete="off"
          spellCheck={false}
        />
        <div className="maka-composer-toolbar composerActions" data-streaming={props.streaming ? 'true' : undefined}>
          <span>
            {props.disabled ? (
              '等待你确认权限…'
            ) : props.streaming ? (
              <span className="maka-composer-streaming-hint">
                <span className="maka-composer-streaming-dot" aria-hidden="true" />
                Maka 正在思考… <kbd>Esc</kbd> 或点 Stop 中断
              </span>
            ) : (
              <><kbd>Enter</kbd> 发送 · <kbd>Shift</kbd>+<kbd>Enter</kbd> 换行</>
            )}
          </span>
          <div>
            {props.streaming ? (
              <button className="maka-button" data-variant="primary" type="button" onClick={props.onStop}>
                Stop
              </button>
            ) : (
              <button className="maka-button" data-variant="primary" type="submit" disabled={props.disabled}>
                Send
              </button>
            )}
          </div>
        </div>
      </div>
    </form>
  );
});

const STATUS_LABEL: Record<ToolActivityItem['status'], string> = {
  pending: '排队中',
  waiting_permission: '等待权限',
  running: '运行中',
  completed: '已完成',
  errored: '失败',
  interrupted: '已中断',
};

function isOpenByDefault(status: ToolActivityItem['status']): boolean {
  // Show details inline while the call is in flight or blocking the user; also
  // for errored calls so the failure is visible without an extra click. Settled
  // success / interruption collapse so completed history doesn't drown the chat.
  return (
    status === 'pending' ||
    status === 'waiting_permission' ||
    status === 'running' ||
    status === 'errored'
  );
}

function extractErrorText(result: ToolActivityItem['result']): string {
  if (!result) return '';
  switch (result.kind) {
    case 'text':
      return result.text;
    case 'json':
      try {
        return JSON.stringify(result.value, null, 2);
      } catch {
        return String(result.value);
      }
    case 'terminal':
      return result.stderr || result.stdout || `exit ${result.exitCode}`;
    case 'file_diff':
      return result.diff;
    default:
      return result.kind;
  }
}

function formatDuration(ms: number | undefined): string | null {
  if (ms === undefined || ms < 0) return null;
  if (ms < 1000) return `${ms} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)}s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1000);
  return `${minutes}m ${seconds}s`;
}

export function ToolActivity(props: { items: ToolActivityItem[] }) {
  return (
    <section className="toolInline" aria-label="工具调用记录">
      <header>
        <strong>工具调用</strong>
        <span className="maka-tool-count" aria-label={`${props.items.length} 次调用`}>{props.items.length}</span>
      </header>
      {props.items.map((item) => {
        const duration = formatDuration(item.durationMs);
        const errored = item.status === 'errored';
        return (
          <details
            key={item.toolUseId}
            className="maka-tool toolItem"
            data-status={item.status}
            open={isOpenByDefault(item.status)}
          >
            <summary className="maka-tool-header">
              <span className="maka-tool-status-dot" data-status={item.status} aria-hidden="true" />
              <span className="maka-tool-name">{item.displayName ?? item.toolName}</span>
              <span className="maka-tool-meta">
                {duration && <span className="maka-tool-duration">{duration}</span>}
                <span className="maka-tool-status-label">{STATUS_LABEL[item.status]}</span>
              </span>
            </summary>
            <div className="maka-tool-body">
              {errored && <ToolErrorBanner result={item.result} />}
              {item.intent && <p className="maka-tool-intent">{item.intent}</p>}
              {item.args !== undefined && (
                <pre className="maka-code toolArgs">{JSON.stringify(item.args, null, 2)}</pre>
              )}
              {item.result && <OverlayPreview content={item.result} />}
            </div>
          </details>
        );
      })}
    </section>
  );
}

function ToolErrorBanner(props: { result: ToolActivityItem['result'] }) {
  // Tool stderr / raw provider errors occasionally slip credential paths,
  // bearer tokens, or API keys through main-side redaction. Apply a
  // defensive UI-level mask before display *and* before clipboard copy so
  // the user can't accidentally paste a credential into a bug report.
  const errorText = redactSecrets(extractErrorText(props.result));
  const [copied, setCopied] = useState(false);

  async function copy() {
    if (!errorText) return;
    try {
      await navigator.clipboard.writeText(errorText);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard unavailable */
    }
  }

  return (
    <div className="maka-tool-error" role="alert">
      <span className="maka-tool-error-icon" aria-hidden="true">
        <AlertOctagon size={16} strokeWidth={2} />
      </span>
      <div className="maka-tool-error-body">
        <strong className="maka-tool-error-title">工具调用失败</strong>
        {errorText && (
          <p className="maka-tool-error-text">{errorText.length > 240 ? `${errorText.slice(0, 240)}…` : errorText}</p>
        )}
      </div>
      {errorText && (
        <button
          type="button"
          className="maka-button maka-tool-error-copy"
          data-size="sm"
          aria-label={copied ? '已复制错误信息' : '复制错误信息'}
          onClick={() => void copy()}
        >
          {copied ? <Check size={14} /> : <Copy size={14} />}
          <span>{copied ? '已复制' : '复制'}</span>
        </button>
      )}
    </div>
  );
}

export function OverlayHost(props: { content?: ToolResultContent; onClose(): void }) {
  if (!props.content) return null;
  return (
    <div className="maka-modal-backdrop overlay">
      <button className="maka-button" onClick={props.onClose}>Close</button>
      <OverlayPreview content={props.content} />
    </div>
  );
}

// Per-reason presentation hints. Drives icon + headline + risk tone in the
// dialog so the user can scan the modal in 1-2 seconds before reading the
// args block.
type ReasonKind = PermissionRequestEvent['reason'];

interface ReasonPreset {
  label: string;
  Icon: typeof AlertTriangle;
  tone: 'info' | 'caution' | 'destructive';
}

const REASON_PRESETS: Record<ReasonKind, ReasonPreset> = {
  shell_dangerous: { label: '高风险 shell 命令 · 请仔细确认', Icon: Terminal, tone: 'caution' },
  file_write: { label: '写入或创建文件', Icon: FileEdit, tone: 'info' },
  fs_destructive: { label: '不可恢复的文件系统操作', Icon: AlertOctagon, tone: 'destructive' },
  git_destructive: { label: '不可恢复的 Git 操作', Icon: GitMerge, tone: 'destructive' },
  network: { label: '对外网络请求', Icon: Wifi, tone: 'info' },
  privileged: { label: '特权操作 (sudo / su)', Icon: ShieldAlert, tone: 'destructive' },
  custom: { label: '自定义请求', Icon: HelpCircle, tone: 'info' },
};

export function PermissionDialog(props: {
  request: PermissionRequestEvent;
  onRespond(response: PermissionResponse): void;
}) {
  const [rememberForTurn, setRememberForTurn] = useState(false);
  const dialogRef = useRef<HTMLElement>(null);
  // No onEscape — a permission request requires an explicit allow/deny decision.
  useModalA11y(dialogRef);

  function submit(decision: PermissionResponse['decision']) {
    props.onRespond({
      requestId: props.request.requestId,
      decision,
      rememberForTurn: decision === 'allow' ? rememberForTurn : false,
    });
  }

  const preset = REASON_PRESETS[props.request.reason] ?? REASON_PRESETS.custom;
  const summary = renderPermissionSummary(props.request);
  const isDestructive = preset.tone === 'destructive';

  return (
    <div className="maka-modal-backdrop permissionBackdrop">
      <section
        ref={dialogRef}
        className="maka-modal permissionDialog"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="permissionTitle"
        data-tone={preset.tone}
      >
        <div className="maka-modal-header maka-permission-header">
          <span className="maka-permission-icon" aria-hidden="true">
            <preset.Icon size={20} strokeWidth={1.75} />
          </span>
          <div>
            <h2 className="maka-modal-title" id="permissionTitle">需要确认权限</h2>
            <p className="maka-modal-subtitle">
              <code className="maka-permission-tool">{props.request.toolName}</code>
              <span aria-hidden="true"> · </span>
              <span className="maka-reason-text" data-reason={props.request.reason}>{preset.label}</span>
            </p>
          </div>
        </div>
        <div className="maka-modal-body maka-permission-body">
          {summary && <div className="maka-permission-summary">{summary}</div>}
          {props.request.hint && (
            <div className="maka-permission-hint" role="note">{props.request.hint}</div>
          )}
          <details className="maka-permission-raw">
            <summary>查看完整参数</summary>
            <pre className="maka-code">{JSON.stringify(props.request.args, null, 2)}</pre>
          </details>
          <label className="permissionRemember">
            <input
              type="checkbox"
              checked={rememberForTurn}
              onChange={(event) => setRememberForTurn(event.currentTarget.checked)}
            />
            本轮对话内记住选择（同类型工具不再询问，关闭/切换对话后失效）
          </label>
          {isDestructive && (
            <p className="maka-permission-danger-note" role="note">
              这类操作不可恢复，确认前请再读一遍上面的参数。
            </p>
          )}
        </div>
        <div className="maka-modal-footer permissionActions">
          <button className="maka-button" data-variant="ghost" type="button" onClick={() => submit('deny')}>拒绝</button>
          <button
            className="maka-button"
            data-variant={isDestructive ? 'destructive' : 'primary'}
            type="button"
            onClick={() => submit('allow')}
          >
            {isDestructive ? '我已确认，允许' : '允许'}
          </button>
        </div>
      </section>
    </div>
  );
}

/**
 * Per-tool human-readable summary of what the request will do, used at the
 * top of the permission dialog body. Falls back to undefined if we can't
 * recognize the tool — the raw args `<details>` block is always available.
 */
function renderPermissionSummary(request: PermissionRequestEvent): ReactNode | undefined {
  const args = (request.args ?? {}) as Record<string, unknown>;
  switch (request.toolName) {
    case 'Bash': {
      const command = typeof args.command === 'string' ? args.command : undefined;
      if (!command) return undefined;
      const timeout = typeof args.timeout_ms === 'number' ? args.timeout_ms : undefined;
      return (
        <>
          <p className="maka-permission-line">即将运行 shell 命令：</p>
          <pre className="maka-code maka-permission-command">{command}</pre>
          {timeout !== undefined && (
            <p className="maka-permission-meta">超时 <strong>{timeout} ms</strong></p>
          )}
        </>
      );
    }
    case 'Write': {
      const path = typeof args.path === 'string' ? args.path : undefined;
      const content = typeof args.content === 'string' ? args.content : '';
      if (!path) return undefined;
      const bytes = new TextEncoder().encode(content).length;
      const lines = content.split('\n').length;
      const preview = content.length > 600 ? `${content.slice(0, 600)}…` : content;
      return (
        <>
          <p className="maka-permission-line">即将写入文件：</p>
          <p className="maka-permission-path"><code>{path}</code></p>
          <p className="maka-permission-meta">
            <strong>{bytes}</strong> 字节 · <strong>{lines}</strong> 行
          </p>
          <pre className="maka-code maka-permission-preview">{preview}</pre>
        </>
      );
    }
    case 'Edit': {
      const path = typeof args.path === 'string' ? args.path : undefined;
      const oldString = typeof args.old_string === 'string' ? args.old_string : '';
      const newString = typeof args.new_string === 'string' ? args.new_string : '';
      if (!path) return undefined;
      return (
        <>
          <p className="maka-permission-line">即将修改文件：</p>
          <p className="maka-permission-path"><code>{path}</code></p>
          <div className="maka-permission-diff">
            <div>
              <span className="maka-permission-diff-tag" data-side="old">删除</span>
              <pre className="maka-code">{oldString.length > 400 ? `${oldString.slice(0, 400)}…` : oldString}</pre>
            </div>
            <div>
              <span className="maka-permission-diff-tag" data-side="new">写入</span>
              <pre className="maka-code">{newString.length > 400 ? `${newString.slice(0, 400)}…` : newString}</pre>
            </div>
          </div>
        </>
      );
    }
    default:
      return undefined;
  }
}

/**
 * Renders a ToolResultContent payload with kind-specific presentation:
 * - `file_diff`: line-level red/green diff coloring
 * - `terminal`: stdout + stderr split with exit-code badge + stderr in
 *   destructive tone
 * - `json`: pretty-printed in a code block
 * - `text` / others: plain `<pre>` fallback
 *
 * All variants are height-bounded by `.maka-overlay-preview` to keep kilobyte
 * outputs from pushing the composer off-screen.
 */
/**
 * Cap displayed line count to keep a giant tool output (10k-line stderr from
 * a failing test run) from creating 10k React elements and from drowning the
 * chat surface visually. We slice, then append a single explainer line that
 * lets the user know the rest exists.
 */
const TOOL_LINE_CAP = 500;

function capLines(text: string): { body: string; capped: number } {
  const lines = text.split('\n');
  if (lines.length <= TOOL_LINE_CAP) return { body: text, capped: 0 };
  return {
    body: lines.slice(0, TOOL_LINE_CAP).join('\n'),
    capped: lines.length - TOOL_LINE_CAP,
  };
}

function OverlayPreview(props: { content: ToolResultContent }) {
  const { content } = props;

  if (content.kind === 'file_diff') {
    return <FileDiffPreview diff={content.diff} paths={content.paths} />;
  }

  if (content.kind === 'terminal') {
    return (
      <TerminalPreview
        cwd={content.cwd}
        cmd={content.cmd}
        exitCode={content.exitCode}
        stdout={content.stdout}
        stderr={content.stderr}
      />
    );
  }

  if (content.kind === 'json') {
    let body: string;
    try {
      body = JSON.stringify(content.value, null, 2);
    } catch {
      body = String(content.value);
    }
    // JSON shouldn't contain secrets persisted by Maka (settings + telemetry
    // are sanitized at write-time), but apply the renderer redactor as a
    // second-layer defense in case a tool returned raw provider response.
    return <pre className="maka-overlay-preview" data-kind="json">{redactSecrets(body)}</pre>;
  }

  if (content.kind === 'text') {
    const { body, capped } = capLines(redactSecrets(content.text));
    return (
      <pre className="maka-overlay-preview" data-kind="text">
        {body}
        {capped > 0 && `\n\n… ${capped} more lines hidden`}
      </pre>
    );
  }

  // file_write / image / summary / unknown — show a compact descriptor so the
  // user knows what kind landed without dumping binary or storage refs.
  return (
    <pre className="maka-overlay-preview" data-kind={content.kind}>
      [{content.kind}]
    </pre>
  );
}

/**
 * Line-level diff coloring. Splits the unified-diff text on newlines and
 * tags each line with `data-line="add" | "del" | "hunk" | "meta" | "ctx"`
 * for CSS to color. Doesn't try to parse the hunk semantics — we leave
 * that to a future inline editor view; this is just a readable preview.
 */
function FileDiffPreview(props: { diff: string; paths: string[] }) {
  // Apply UI-level redaction then cap the displayed lines. Both are
  // @kenji's PR76 review items: never echo a token a tool happened to dump
  // into a diff (commit body, .env file diff, etc.), and never let a
  // 10k-line diff create 10k React elements.
  const { body, capped } = capLines(redactSecrets(props.diff));
  const lines = body.split('\n');
  return (
    <div className="maka-overlay-preview maka-tool-diff" data-kind="file_diff">
      {props.paths.length > 0 && (
        <div className="maka-tool-diff-paths">
          {props.paths.map((path) => (
            <code key={path}>{path}</code>
          ))}
        </div>
      )}
      <pre className="maka-tool-diff-body">
        {lines.map((line, index) => (
          <span
            key={`${index}:${line.slice(0, 16)}`}
            className="maka-tool-diff-line"
            data-line={diffLineKind(line)}
          >
            {line || ' '}
            {'\n'}
          </span>
        ))}
        {capped > 0 && (
          <span className="maka-tool-diff-line" data-line="meta">
            {`\n… ${capped} more lines hidden\n`}
          </span>
        )}
      </pre>
    </div>
  );
}

function diffLineKind(line: string): 'add' | 'del' | 'hunk' | 'meta' | 'ctx' {
  if (line.startsWith('+++') || line.startsWith('---')) return 'meta';
  if (line.startsWith('@@')) return 'hunk';
  if (line.startsWith('+')) return 'add';
  if (line.startsWith('-')) return 'del';
  return 'ctx';
}

/**
 * Terminal output preview. Shows the command + working directory header,
 * an exit-code badge tinted by success/failure, then stdout and stderr
 * in separate blocks (stderr only rendered when non-empty, in destructive
 * tone). Empty output gets an explicit "(no output)" placeholder so a
 * silent successful command doesn't look like a render bug.
 */
function TerminalPreview(props: {
  cwd: string;
  cmd: string;
  exitCode: number;
  stdout: string;
  stderr: string;
}) {
  const succeeded = props.exitCode === 0;
  const hasOutput = props.stdout.length > 0 || props.stderr.length > 0;
  // Redact + cap stdout/stderr independently. `npm test` against a misconfigured
  // provider can dump megabytes of stderr; we keep the first TOOL_LINE_CAP
  // lines and append a hidden-count marker.
  const stdout = capLines(redactSecrets(props.stdout));
  const stderr = capLines(redactSecrets(props.stderr));
  // The cmd line is also user-runtime text — don't echo a `--api-key=...`
  // arg into the chat without masking it.
  const safeCmd = redactSecrets(props.cmd);
  return (
    <div className="maka-overlay-preview maka-tool-terminal" data-kind="terminal">
      <header className="maka-tool-terminal-head">
        <code className="maka-tool-terminal-cwd">{props.cwd}</code>
        <code className="maka-tool-terminal-cmd">$ {safeCmd}</code>
        <span
          className="maka-tool-terminal-exit"
          data-ok={succeeded ? 'true' : 'false'}
          aria-label={`exit code ${props.exitCode}`}
        >
          exit {props.exitCode}
        </span>
      </header>
      {!hasOutput && <p className="maka-tool-terminal-empty">(no output)</p>}
      {props.stdout.length > 0 && (
        <pre className="maka-tool-terminal-stream" data-stream="stdout">
          {stdout.body}
          {stdout.capped > 0 && `\n\n… ${stdout.capped} more stdout lines hidden`}
        </pre>
      )}
      {props.stderr.length > 0 && (
        <pre className="maka-tool-terminal-stream" data-stream="stderr">
          {stderr.body}
          {stderr.capped > 0 && `\n\n… ${stderr.capped} more stderr lines hidden`}
        </pre>
      )}
    </div>
  );
}

function mergeTools(stored: ToolActivityItem[], live: ToolActivityItem[]): ToolActivityItem[] {
  const byId = new Map(stored.map((item) => [item.toolUseId, item]));
  for (const item of live) byId.set(item.toolUseId, { ...byId.get(item.toolUseId), ...item });
  return [...byId.values()];
}

// One shared formatter per renderer instance — `Intl.RelativeTimeFormat` is
// cheap to allocate but pinning it avoids reading `navigator.language` on
// every list render.
const relativeTimeFormat: Intl.RelativeTimeFormat =
  typeof Intl !== 'undefined' && typeof Intl.RelativeTimeFormat === 'function'
    ? new Intl.RelativeTimeFormat(
        typeof navigator !== 'undefined' ? navigator.language : 'en',
        { numeric: 'auto', style: 'narrow' },
      )
    : ({ format: (n: number, unit: Intl.RelativeTimeFormatUnit) => `${n}${unit[0]}` } as unknown as Intl.RelativeTimeFormat);

const noMessagesYet =
  typeof navigator !== 'undefined' && navigator.language?.toLowerCase().startsWith('zh')
    ? '暂无消息'
    : 'No messages yet';

interface SessionGroup {
  label: string;
  sessions: SessionSummary[];
}

/**
 * In the Chats filter, pinned (flagged) sessions float to the top in their
 * own section per the session-list-lifecycle contract, separate from the
 * date-bucketed remainder. Other filters keep the date-bucket layout.
 */
function groupSessionsForFilter(sessions: SessionSummary[], selection: NavSelection): SessionGroup[] {
  if (selection.section !== 'sessions' || selection.filter !== 'chats') {
    return groupSessionsByTime(sessions);
  }
  const pinned = sessions.filter((session) => session.isFlagged);
  const rest = sessions.filter((session) => !session.isFlagged);
  const groups: SessionGroup[] = [];
  if (pinned.length > 0) {
    groups.push({ label: '已置顶', sessions: pinned });
  }
  return [...groups, ...groupSessionsByTime(rest)];
}

/**
 * Cluster the session list into Today / Yesterday / Past 7 days / Past 30 days
 * / Older buckets. Sorted by lastMessageAt descending within each group. Falls
 * back to a single bucket if every session lacks a timestamp.
 */
function groupSessionsByTime(sessions: SessionSummary[]): SessionGroup[] {
  const now = Date.now();
  const startOfToday = new Date(now);
  startOfToday.setHours(0, 0, 0, 0);
  const todayMs = startOfToday.getTime();
  const yesterdayMs = todayMs - 24 * 60 * 60 * 1000;
  const sevenDaysMs = todayMs - 7 * 24 * 60 * 60 * 1000;
  const thirtyDaysMs = todayMs - 30 * 24 * 60 * 60 * 1000;

  const buckets: SessionGroup[] = [
    { label: '今天', sessions: [] },
    { label: '昨天', sessions: [] },
    { label: '过去 7 天', sessions: [] },
    { label: '过去 30 天', sessions: [] },
    { label: '更早', sessions: [] },
    { label: '尚未发送', sessions: [] },
  ];

  for (const session of sessions) {
    const at = session.lastMessageAt;
    if (!at) {
      buckets[5]!.sessions.push(session);
      continue;
    }
    if (at >= todayMs) buckets[0]!.sessions.push(session);
    else if (at >= yesterdayMs) buckets[1]!.sessions.push(session);
    else if (at >= sevenDaysMs) buckets[2]!.sessions.push(session);
    else if (at >= thirtyDaysMs) buckets[3]!.sessions.push(session);
    else buckets[4]!.sessions.push(session);
  }

  return buckets.filter((group) => group.sessions.length > 0);
}

function formatSessionMeta(session: SessionSummary): string {
  if (!session.lastMessageAt) return noMessagesYet;
  const diffMs = Date.now() - session.lastMessageAt;
  const diffMinutes = Math.max(1, Math.round(diffMs / 60_000));
  if (diffMinutes < 60) return relativeTimeFormat.format(-diffMinutes, 'minute');
  const diffHours = Math.round(diffMinutes / 60);
  if (diffHours < 24) return relativeTimeFormat.format(-diffHours, 'hour');
  return relativeTimeFormat.format(-Math.round(diffHours / 24), 'day');
}
