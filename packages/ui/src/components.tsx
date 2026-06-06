import React, { createContext, forwardRef, memo, useContext, useEffect, useImperativeHandle, useMemo, useRef, useState, type ClipboardEvent, type DragEvent, type FocusEvent, type FormEvent, type KeyboardEvent, type MouseEvent, type ReactNode, type RefObject } from 'react';
import {
  AlertOctagon,
  AlertTriangle,
  Archive,
  ArchiveRestore,
  ArrowDown,
  Ban,
  BookOpen,
  CalendarDays,
  Check,
  ChevronRight,
  CircleCheckBig,
  Clock,
  Copy,
  DownloadCloud,
  Eye,
  FileEdit,
  Flag,
  FolderOpen,
  GitBranch,
  GitMerge,
  HelpCircle,
  Hourglass,
  Loader2,
  MessageSquare,
  Paperclip,
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
  X,
} from 'lucide-react';
import { redactSecrets } from './redact.js';
import {
  isMakaUriCandidate,
  isSafeExternalScheme,
  parseMakaUri,
  type MakaUriDest,
} from './maka-uri.js';
import { prepareSmoothStreamText, useSmoothStreamContent } from './smooth-stream.js';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkBreaks from 'remark-breaks';
import rehypeHighlight from 'rehype-highlight';
import type {
  PermissionMode,
  PermissionRequestEvent,
  PermissionResponse,
  BotProvider,
  PlanReminder,
  PlanReminderDeliveryTarget,
  PlanReminderRecurrence,
  PlanReminderStatus,
  ProviderType,
  SearchErrorReason,
  SearchRequest,
  SearchResult,
  SessionSummary,
  StoredMessage,
  ToolResultContent,
} from '@maka/core';
import {
  derivePermissionRequestHealth,
  BOT_DELIVERY_PROVIDERS,
  botDisplayLabel,
  formatPlanReminderDeliveryTarget,
  formatPermissionRequestWait,
  formatRelativeTimestamp,
  generalizedErrorMessageChinese,
  DEEP_RESEARCH_EVIDENCE_CHECKLIST,
  DEEP_RESEARCH_PROGRESS_CHECKPOINTS,
  DEEP_RESEARCH_REPORT_SECTIONS,
  DEEP_RESEARCH_SCOPE_OPTIONS,
  DEEP_RESEARCH_STARTER_PROMPTS,
  DEEP_RESEARCH_WORKFLOW_STEPS,
  isDeepResearchSession,
  normalizeSearchUrl,
  nextRelativeRefreshDelay,
} from '@maka/core';
import type { DailyReviewSummary, DailyReviewTopEntry } from '@maka/core';
import {
  materializeChat,
  materializeTools,
  materializeTurns,
  type ToolActivityItem,
  type ToolOutputChunk,
  type TurnViewModel,
} from './materialize.js';

/**
 * PR-SIDEBAR-IA-0 Phase 2 + fixup (xuan msg `47e204f2`, `91401163`;
 * WAWQAQ `b86b47d1`, `4259bf8c`; kenji `9f683ea8`, `6465cf22`).
 *
 * Left sidebar's second part is a 5-button module nav. Four of those
 * buttons select a content section (`sessions`, `automations`,
 * `skills`, `daily-review`); the fifth (`搜索`) is a **transient
 * modal trigger** and does NOT have a `NavSelection` section variant.
 * Clicking `搜索` opens a Search modal overlay; the underlying
 * `NavSelection` stays on whatever section was active.
 *
 * Module labels are Chinese-first per xuan `47e204f2` #5:
 *   - sessions     → 会话
 *   - search       → 搜索   (modal trigger; NOT a section)
 *   - automations  → 计划   (local reminder MVP; no arbitrary automation execution)
 *   - skills       → 技能   (reuses the existing skills view)
 *   - daily-review → 每日回顾  (PR-DAILY-REVIEW-MVP-0: real panel reading local telemetry + sessions)
 */
export type NavSelection =
  | { section: 'sessions'; filter: SessionFilter }
  | { section: 'automations' }
  | { section: 'skills' }
  | { section: 'daily-review' };

export type SessionFilter = 'chats' | 'flagged' | 'archived';

/**
 * Identifier set for the sidebar module nav. Includes `search` even
 * though it is not a `NavSelection.section` — `search` is a modal
 * trigger and needs a label/icon but no underlying section.
 */
type ModuleNavId = NavSelection['section'] | 'search';

/**
 * Top-level module nav labels. Chinese-first per xuan `47e204f2` #5;
 * English keywords stay accessible via the command-palette `keywords`
 * field but are not surfaced in the sidebar UI itself.
 *
 * Keyed by `ModuleNavId` so the `search` modal trigger gets a label
 * even though it is not a `NavSelection.section`.
 */
const MODULE_NAV_LABEL: Record<ModuleNavId, string> = {
  sessions: '会话',
  search: '搜索',
  automations: '计划',
  skills: '技能',
  'daily-review': '每日回顾',
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
  initialFocusRef?: RefObject<HTMLElement | null>,
): void {
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const previouslyFocused = document.activeElement as HTMLElement | null;

    const preferredInitial = initialFocusRef?.current;
    const initial = preferredInitial && container.contains(preferredInitial)
      ? preferredInitial
      : getFocusable(container)[0];
    if (initial) {
      initial.focus({ preventScroll: true });
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
        if (document.contains(container)) return;
        if (previouslyFocused && document.contains(previouslyFocused)) {
          previouslyFocused.focus?.({ preventScroll: true });
        }
      });
    };
  }, [containerRef, onEscape, initialFocusRef]);
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

type PlanReminderDraftInput = {
  title: string;
  note?: string;
  runAt: number;
  recurrence?: PlanReminderRecurrence;
  cronExpression?: string;
  delivery?: PlanReminderDeliveryTarget;
};

type PlanReminderUpdatePatch = {
  title?: string;
  note?: string;
  runAt?: number;
  recurrence?: PlanReminderRecurrence;
  cronExpression?: string;
  delivery?: PlanReminderDeliveryTarget;
  enabled?: boolean;
};

type SessionRowActionId = 'flag' | 'archive' | 'rename' | 'delete';

export interface SessionRowActions {
  /** Flag (pin) state toggle. */
  onToggleFlag(sessionId: string, next: boolean): void | Promise<void>;
  /** Move to / out of the archive bucket. */
  onArchive(sessionId: string): void | Promise<void>;
  onUnarchive(sessionId: string): void | Promise<void>;
  /** Rename via inline prompt. Receives the new (trimmed) name. */
  onRename(sessionId: string, name: string): void | Promise<void>;
  /** Permanent removal — caller is responsible for the confirm gate. */
  onDelete(sessionId: string): void | Promise<void>;
}

export function SessionListPanel(props: {
  selection: NavSelection;
  sessionCounts: Record<SessionFilter, number>;
  sessions: SessionSummary[];
  activeId?: string;
  projectBadge?: {
    label: string;
    path: string;
    branch?: string;
    onOpen(): void;
  };
  skills?: SkillEntry[];
  onRefreshSkills?(): void | Promise<void>;
  onCreateSkillTemplate?(): void | Promise<void>;
  planReminders?: PlanReminder[];
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
  onOpenSkill?(skillId: string): void;
  /** Opens the local version/build information surface. */
  onOpenUpdate(): void;
  /**
   * PR-SIDEBAR-IA-0 Phase 2 fixup (xuan `91401163` + `94c7bf0f`):
   * Sidebar `搜索` nav row click handler. Opens a dedicated Search
   * modal hosted by the application shell; does NOT change
   * `selection`. The shell owns the real search backend and modal
   * lifecycle behind this callback.
   */
  onOpenSearchModal?(): void;
  onCreatePlanReminder?(input: PlanReminderDraftInput): boolean | Promise<boolean> | void | Promise<void>;
  onUpdatePlanReminder?(id: string, patch: PlanReminderUpdatePatch): boolean | Promise<boolean> | void | Promise<void>;
  onTogglePlanReminder?(id: string, enabled: boolean): void | Promise<void>;
  onTriggerPlanReminderNow?(id: string): void | Promise<void>;
  onSnoozePlanReminder?(id: string): void | Promise<void>;
  onClearPlanReminderRunHistory?(id: string): void | Promise<void>;
  onDeletePlanReminder?(id: string): void | Promise<void>;
  onCopyDailyReviewMarkdown?(input: DailyReviewMarkdownActionInput): Promise<void> | void;
  onSaveDailyReviewMarkdown?(input: DailyReviewMarkdownActionInput): Promise<void> | void;
  /**
   * PR-DAILY-REVIEW-MVP-0: bridge for the `每日回顾` panel. When
   * provided, the daily-review section renders the real panel instead
   * of the fallback view. When `undefined` (e.g. in visual-smoke
   * fixtures without an IPC layer), it falls back to an explicit
   * bridge-missing state.
   */
  dailyReviewBridge?: DailyReviewBridge;
  rowActions?: SessionRowActions;
}) {
  // PR-SIDEBAR-IA-0 Phase 2 fixup (WAWQAQ `49309559` + kenji
  // `9f683ea8` + xuan `71687cc7`): the title is the Chinese module
  // label only. The previous Chats/Pinned/Archived switcher was
  // removed from the sidebar entirely — no visible filter tabs, no
  // hidden ArrowLeft/Right cycle, no "查看已归档对话" link. Future
  // Pinned/Archived access (if/when needed) will be a deliberate,
  // visible, lightweight control in a separate PR. `NavSelection.filter`
  // stays in the type for storage continuity but is internal-only.
  const title = MODULE_NAV_LABEL[props.selection.section];
  // PR-UX-POLISH-1 commit 4 (WAWQAQ msg `e0dbad11` + kenji msg
  // `2844f64f`): in-list `筛选会话` filter input removed. All search
  // capability lives in the top-level `搜索` modal (PR-SEARCH-MODAL-
  // REAL-0 wires it to `window.maka.search.thread()` in the same PR).
  // The previous `searchQuery` state + `searchInputRef` + ⌘F/Ctrl+F
  // focus binding are gone with it; ⌘F is freed for future use.
  // `filteredSessions` collapses to a direct passthrough of
  // `props.sessions` — group rendering downstream still partitions
  // by status / time / filter.
  const filteredSessions = props.sessions;

  function handleListKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    // PR-SIDEBAR-IA-0 Phase 2 fixup (xuan `71687cc7`): the
    // ArrowLeft/ArrowRight filter cycle was REMOVED. Hidden state
    // without visible UI is harder for users to discover and harder
    // for review to verify. If we re-introduce Pinned/Archived
    // access in the future it will be a deliberate, visible,
    // lightweight control (per kenji `9f683ea8`).
    if (event.key === 'Delete' || event.key === 'Backspace') {
      // Delete on a focused row opens the App-level confirmation (which
      // toast.confirm()s); we do not delete silently per the lifecycle
      // contract.
      const active = document.activeElement as HTMLElement | null;
      const row = active?.closest('.maka-list-row');
      const sessionId = row?.querySelector<HTMLButtonElement>('.maka-list-row-main')?.dataset.sessionId;
      if (sessionId && props.rowActions) {
        event.preventDefault();
        void props.rowActions.onDelete(sessionId);
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

  // PR-SIDEBAR-IA-0 Phase 2 module nav order is FIXED per WAWQAQ
  // `b86b47d1` + xuan `47e204f2`. Sessions first (most-used), then
  // Search (modal trigger), then Automations / Skills / Daily
  // Review. Order is part of the contract — do not reorder without
  // an explicit IA review.
  //
  // PR-SIDEBAR-IA-0 Phase 2 fixup (WAWQAQ `4259bf8c` + `49309559`,
  // xuan `91401163`, kenji `6465cf22`): the `搜索` nav button is a
  // transient modal trigger, NOT a section. It calls
  // `onOpenSearchModal()` and does NOT touch `selection`. Selected
  // state never sticks to `搜索`.
  const isModuleActive = (id: ModuleNavId) => {
    if (id === 'search') return false; // transient — never "active"
    return props.selection.section === id;
  };
  const activePlanReminderCount = (props.planReminders ?? [])
    .filter((reminder) => reminder.status !== 'completed')
    .length;
  function selectModule(id: ModuleNavId) {
    if (id === 'search') {
      // Opens the dedicated Search modal hosted by main.tsx. If no
      // handler is wired (older callers / tests), the click is inert.
      props.onOpenSearchModal?.();
      return;
    }
    if (id === 'sessions') {
      props.onSelect({ section: 'sessions', filter: 'chats' });
      return;
    }
    if (id === 'automations') props.onSelect({ section: 'automations' });
    else if (id === 'skills') props.onSelect({ section: 'skills' });
    else if (id === 'daily-review') props.onSelect({ section: 'daily-review' });
  }

  return (
    <aside className="maka-session-panel" aria-label="对话列表">
      <header className="maka-session-panel-header">
        <div className="maka-window-drag-strip" aria-hidden="true" />
        <button className="maka-nav-primary" type="button" onClick={props.onNew}>
          <SquarePen className="maka-nav-primary-icon" strokeWidth={1.5} />
          <span>新建对话</span>
        </button>
        {props.projectBadge && (
          <button
            type="button"
            className="maka-project-badge"
            onClick={props.projectBadge.onOpen}
            title={props.projectBadge.branch ? `打开项目目录 · ${props.projectBadge.branch}` : '打开项目目录'}
            aria-label={props.projectBadge.branch
              ? `打开项目目录：${props.projectBadge.label}，当前分支 ${props.projectBadge.branch}`
              : `打开项目目录：${props.projectBadge.label}`}
          >
            <FolderOpen size={14} strokeWidth={1.6} aria-hidden="true" />
            <span>项目 · {props.projectBadge.label}{props.projectBadge.branch ? ` · ${props.projectBadge.branch}` : ''}</span>
          </button>
        )}
      </header>

      {/*
        PR-SIDEBAR-IA-0 Phase 2 (xuan msg `47e204f2`): top-level module
        nav. Chinese-first labels; lightweight visual hierarchy reusing
        `.maka-nav-row` (transparent bg, accent on selected). Pinned /
        Archived / Recent are NOT here — they live as filter chips
        inside the Sessions module content below.
      */}
      <nav className="maka-sidebar-modules" aria-label="主导航">
        <button
          className="maka-nav-row"
          data-active={isModuleActive('sessions')}
          aria-current={isModuleActive('sessions') ? 'page' : undefined}
          type="button"
          onClick={() => selectModule('sessions')}
        >
          <MessageSquare className="maka-nav-icon" strokeWidth={1.5} aria-hidden="true" />
          <span>{MODULE_NAV_LABEL.sessions}</span>
        </button>
        <button
          className="maka-nav-row"
          type="button"
          data-maka-search-trigger="true"
          onClick={() => selectModule('search')}
          aria-haspopup="dialog"
        >
          <Search className="maka-nav-icon" strokeWidth={1.5} aria-hidden="true" />
          <span>{MODULE_NAV_LABEL.search}</span>
        </button>
        <button
          className="maka-nav-row"
          data-active={isModuleActive('automations')}
          aria-current={isModuleActive('automations') ? 'page' : undefined}
          type="button"
          onClick={() => selectModule('automations')}
          aria-label={activePlanReminderCount > 0 ? `计划，${activePlanReminderCount} 个未完成提醒` : undefined}
        >
          <Clock className="maka-nav-icon" strokeWidth={1.5} aria-hidden="true" />
          <span>{MODULE_NAV_LABEL.automations}</span>
          {activePlanReminderCount > 0 && (
            <small className="maka-nav-count" aria-hidden="true">{activePlanReminderCount}</small>
          )}
        </button>
        <button
          className="maka-nav-row"
          data-active={isModuleActive('skills')}
          aria-current={isModuleActive('skills') ? 'page' : undefined}
          type="button"
          onClick={() => selectModule('skills')}
        >
          <Sparkles className="maka-nav-icon" strokeWidth={1.5} aria-hidden="true" />
          <span>{MODULE_NAV_LABEL.skills}</span>
        </button>
        <button
          className="maka-nav-row"
          data-active={isModuleActive('daily-review')}
          aria-current={isModuleActive('daily-review') ? 'page' : undefined}
          type="button"
          onClick={() => selectModule('daily-review')}
        >
          <CalendarDays className="maka-nav-icon" strokeWidth={1.5} aria-hidden="true" />
          <span>{MODULE_NAV_LABEL['daily-review']}</span>
        </button>
      </nav>

      {/*
        PR-UX-POLISH-1 commit 4 (WAWQAQ msg `e0dbad11` + kenji msg
        `2844f64f` blocker #2): the in-list `筛选会话` filter input
        is REMOVED entirely. Search capability lives only in the
        top-level `搜索` modal (Cmd-click / sidebar nav → modal),
        which the same PR wires to real `window.maka.search.thread()`
        backend. No more duplicated search affordances; one canonical
        entry point.

        Removed with it:
        - `searchQuery` state + `searchInputRef`
        - `useMemo(() => filter sessions by name)` — sessions pass
          through unchanged; group rendering still partitions.
        - `useEffect(⌘F focuses input)` — ⌘F is freed.
        - `.maka-session-search` JSX block + clear button.
        - "没有匹配的会话" empty state (the only consumer was
          `filteredSessions.length === 0 && searchQuery.length > 0`).
      */}

      <section className="maka-session-list" aria-label={title}>
        <div className="maka-session-list-title" aria-hidden="true">{title}</div>
        {props.selection.section === 'skills' ? (
          <SidebarModuleHint
            Icon={Sparkles}
            title="技能库"
            body="已在右侧内容栏打开。"
          />
        ) : props.selection.section === 'automations' ? (
          <SidebarModuleHint
            Icon={Clock}
            title="计划"
            body="已在右侧内容栏打开。"
          />
        ) : props.selection.section === 'sessions' ? (
          props.sessions.length === 0 ? (
            <EmptyState
              Icon={MessageSquare}
              title="等待开始对话"
              body="和 Maka 的对话会出现在这里。点下面开始第一条。"
              cta={{ label: '新建对话', onClick: props.onNew }}
            />
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
          )
        ) : props.selection.section === 'daily-review' ? (
          <SidebarModuleHint
            Icon={CalendarDays}
            title="每日回顾"
            body="已在右侧内容栏打开。"
          />
        ) : (
          null
        )}
      </section>

      <footer className="maka-session-panel-footer">
        <button
          className="maka-nav-row"
          type="button"
          onClick={props.onOpenUpdate}
          aria-label="版本信息"
        >
          <DownloadCloud className="maka-nav-icon" strokeWidth={1.5} aria-hidden="true" />
          <span>版本信息</span>
        </button>
        <button
          className="maka-nav-row"
          type="button"
          onClick={props.onOpenSettings}
        >
          <Settings className="maka-nav-icon" strokeWidth={1.5} aria-hidden="true" />
          <span>设置</span>
        </button>
        {/*
          PR-UX-POLISH-1 commit 4 (WAWQAQ msg `e0dbad11` + kenji
          msg `2844f64f` blocker #1): the `? 快捷键` chip in the
          sidebar footer is removed. The sidebar footer is for
          product nav/state, not help affordances. Keyboard
          shortcut discoverability moves to Command Palette
          (`查看快捷键` entry) and the existing global `?` keydown
          listener stays — power users still hit `?` to open the
          modal; new users find it via Command Palette.
        */}
      </footer>
    </aside>
  );
}

/**
 * PR-EMPTY-STATE-COMPONENT-0: shared empty-state container. Folds the
 * 4 visual duplicates (skills empty / sessions empty / module fallbacks /
 * plan reminders empty) into a single declaration so the next empty
 * surface lands consistent by default and the icon-sizing /
 * paragraph-spacing / CTA-placement decisions only live in one
 * place. The `.maka-empty-state*` CSS family is unchanged.
 *
 * Body accepts `ReactNode` so callers can keep inline `<code>` for
 * the skills install instructions; CTAs are rendered as the canonical
 * `.maka-button.maka-empty-state-cta` so we never grow a competing
 * pile of "empty-state action variants".
 */
export interface EmptyStateProps {
  Icon: typeof Search;
  title: string;
  body: ReactNode;
  cta?: { label: string; onClick: () => void; disabled?: boolean };
  secondaryCta?: { label: string; onClick: () => void; disabled?: boolean };
  /** Optional extra class on the container (e.g. `maka-plan-empty`). */
  extraClassName?: string;
  /** Optional `data-empty-view` passthrough for visual-smoke selectors. */
  dataEmptyView?: string;
}

export function EmptyState(props: EmptyStateProps) {
  const className = props.extraClassName
    ? `maka-empty-state ${props.extraClassName}`
    : 'maka-empty-state';
  return (
    <div className={className} data-empty-view={props.dataEmptyView}>
      <props.Icon className="maka-empty-state-icon" strokeWidth={1.5} />
      <div className="maka-empty-state-title">{props.title}</div>
      <div className="maka-empty-state-body">{props.body}</div>
      {(props.cta || props.secondaryCta) && (
        <div className="maka-empty-state-actions">
          {props.cta && (
            <button
              className="maka-button maka-empty-state-cta"
              type="button"
              onClick={props.cta.onClick}
              disabled={props.cta.disabled}
            >
              {props.cta.label}
            </button>
          )}
          {props.secondaryCta && (
            <button
              className="maka-button maka-empty-state-cta"
              data-variant="ghost"
              type="button"
              onClick={props.secondaryCta.onClick}
              disabled={props.secondaryCta.disabled}
            >
              {props.secondaryCta.label}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function SidebarModuleHint(props: { Icon: EmptyStateProps['Icon']; title: string; body: string }) {
  return (
    <div className="maka-sidebar-module-hint">
      <props.Icon className="maka-sidebar-module-hint-icon" strokeWidth={1.5} />
      <strong>{props.title}</strong>
      <span>{props.body}</span>
    </div>
  );
}

function SkillLibraryPanel(props: {
  skills?: SkillEntry[];
  onRefreshSkills?(): void | Promise<void>;
  onCreateSkillTemplate?(): void | Promise<void>;
  onOpenSkill?(skillId: string): void | Promise<void>;
  actionBusy?: boolean;
  refreshPending?: boolean;
  createPending?: boolean;
  openingSkillId?: string | null;
}) {
  if (!props.skills || props.skills.length === 0) {
    return (
      <EmptyState
        Icon={Sparkles}
        title="等待添加 Skill"
        body={
          <>
            把一个含 <code className="maka-empty-state-code">SKILL.md</code> 的文件夹放到工作区的
            {' '}<code className="maka-empty-state-code">skills/</code> 目录下，刷新后会出现在这里。
            工作区路径在 设置 · 关于 · 工作区。
          </>
        }
        cta={props.onCreateSkillTemplate ? {
          label: props.createPending ? '创建中…' : '创建示例技能',
          onClick: props.onCreateSkillTemplate,
          disabled: props.actionBusy,
        } : undefined}
        secondaryCta={props.onRefreshSkills ? {
          label: props.refreshPending ? '刷新中…' : '刷新技能',
          onClick: props.onRefreshSkills,
          disabled: props.actionBusy,
        } : undefined}
      />
    );
  }

  return (
    <ul className="maka-skill-library-list" aria-label="技能列表" aria-busy={props.actionBusy ? 'true' : undefined}>
      {props.skills.map((skill) => {
        const tools = skill.declaredTools ?? [];
        const toolsLabel = tools.length > 0 ? tools.join(', ') : '';
        const description = formatSkillLibraryDescription(skill);
        const opening = props.openingSkillId === skill.id;
        const hoverText = tools.length > 0
          ? `打开技能文件：${skill.id}\n\n声明工具：${toolsLabel}\n权限仍按当前会话策略判断；这里不是授权。`
          : `打开技能文件：${skill.id}`;
        return (
          <li key={skill.id} className="maka-skill-library-item">
            <button
              type="button"
              className="maka-skill-library-row"
              onClick={() => props.onOpenSkill?.(skill.id)}
              disabled={props.actionBusy}
              title={hoverText}
            >
              <span className="maka-skill-library-name">{skill.name}</span>
              {description && (
                <span className="maka-skill-library-description">{description}</span>
              )}
              <span className="maka-skill-library-meta">
                <span>{skill.id}</span>
                {opening && <span>打开中…</span>}
                {tools.length > 0 && (
                  <span className="maka-skill-tools" aria-label="声明的工具">
                    <span className="maka-skill-tools-label">工具</span>
                    <span>{toolsLabel}</span>
                  </span>
                )}
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}

function formatSkillLibraryDescription(skill: SkillEntry): string | undefined {
  const raw = skill.description?.trim();
  if (!raw) return undefined;
  if (/[\u3400-\u9fff]/.test(raw)) return raw;

  const source = `${skill.id} ${skill.name} ${raw}`.toLowerCase();
  if (source.includes('docx') || source.includes('word') || source.includes('google docs')) {
    return '创建、编辑、检查文档内容。';
  }
  if (source.includes('ppt') || source.includes('powerpoint') || source.includes('slide') || source.includes('presentation')) {
    return '创建、编辑、检查演示文稿。';
  }
  if (source.includes('spreadsheet') || source.includes('excel') || source.includes('csv') || source.includes('xlsx')) {
    return '创建、编辑、分析表格数据。';
  }
  if (source.includes('image') || source.includes('photo') || source.includes('bitmap')) {
    return '生成或编辑图片素材。';
  }
  if (source.includes('browser') || source.includes('chrome') || source.includes('web target')) {
    return '打开、检查、操作网页界面。';
  }
  if (source.includes('macos') || source.includes('swiftui') || source.includes('appkit')) {
    return '辅助构建和调试 macOS 应用。';
  }
  return '打开技能文件查看适用场景。';
}

/**
 * PR-DAILY-REVIEW-MVP-0: bridge handed in by `main.tsx`. Keeps
 * `@maka/ui` out of `window.maka` — the renderer wires
 * `(offsetDays) => window.maka.dailyReview.day(offsetDays)` and the
 * UI layer is reusable in fixtures / visual smoke / future surfaces
 * (e.g. a desktop notification renderer).
 */
export interface DailyReviewBridge {
  fetchDay(offsetDays: number, daySpan?: number): Promise<DailyReviewSummary>;
}

/**
 * Local-only daily summary view. Renders today by default; the
 * left/right arrows step through `offsetDays`. No LLM call — the
 * bullet list of sessions / top tools / top models is the whole
 * value-prop. Future PR can layer a generated narrative on top.
 *
 * borrow: external "today" digest concept (read-only summary).
 * diverge: no cron, no auto-push, no memory promotion (privacy default).
 */
type DailyReviewRange = 1 | 7 | 30;
type DailyReviewMarkdownActionInput = {
  markdown: string;
  label: string;
  summary: DailyReviewSummary;
};

function DailyReviewPanel(props: {
  bridge: DailyReviewBridge;
  onSelectSession?: (sessionId: string) => void;
  onCopyMarkdown?: (input: DailyReviewMarkdownActionInput) => Promise<void> | void;
  onAppendMarkdown?: (input: DailyReviewMarkdownActionInput) => Promise<void> | void;
  onSaveMarkdown?: (input: DailyReviewMarkdownActionInput) => Promise<void> | void;
}) {
  const [offsetDays, setOffsetDays] = useState(0);
  // PR-DAILY-REVIEW-RANGE-0: 今日 / 本周 / 本月 tabs that map to a
  // 1 / 7 / 30 day aggregation. When span > 1, the day-stepper
  // navigates by the same span (一个 30 天 window steps back 30 days).
  const [range, setRange] = useState<DailyReviewRange>(1);
  const [summary, setSummary] = useState<DailyReviewSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [reloadToken, setReloadToken] = useState(0);
  const [pendingDailyReviewAction, setPendingDailyReviewAction] = useState<string | null>(null);
  const pendingDailyReviewActionRef = useRef<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    props.bridge
      .fetchDay(offsetDays, range)
      .then((next) => {
        if (cancelled) return;
        setSummary(next);
        setLoading(false);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setSummary(null);
        setError(dailyReviewPanelErrorMessage(err));
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [offsetDays, range, reloadToken, props.bridge]);

  const dayLabel = (() => {
    if (range === 1) {
      if (offsetDays === 0) return '今天';
      if (offsetDays === -1) return '昨天';
      return `${-offsetDays} 天前`;
    }
    const rangeText = range === 7 ? '最近 7 天' : '最近 30 天';
    if (offsetDays === 0) return rangeText;
    return `${rangeText}（往前 ${-offsetDays} 天）`;
  })();

  // Stepper step matches the range size — for 7-day mode the user
  // skips a whole week at a time, not a single day.
  const stepperLabel = range === 1 ? '天' : range === 7 ? '周' : '月';
  const emptyActivityTitle = offsetDays === 0 && range === 1
    ? '等待记录今天活动'
    : `${dayLabel}无活动`;
  const emptyActivityBody = range === 1
    ? '这一天没有发起对话，也没有调用模型。'
    : `${dayLabel}范围内没有发起对话，也没有调用模型。`;

  async function runDailyReviewAction(actionKey: string, action: () => void | Promise<void>) {
    if (pendingDailyReviewActionRef.current !== null) return;
    pendingDailyReviewActionRef.current = actionKey;
    setPendingDailyReviewAction(actionKey);
    try {
      await action();
    } finally {
      if (pendingDailyReviewActionRef.current === actionKey) {
        pendingDailyReviewActionRef.current = null;
        setPendingDailyReviewAction(null);
      }
    }
  }

  const dailyReviewActionBusy = pendingDailyReviewAction !== null;
  const hasDailyReviewActions = Boolean(props.onCopyMarkdown || props.onAppendMarkdown || props.onSaveMarkdown);

  return (
    <div className="maka-daily-review-panel" data-loading={loading ? 'true' : undefined}>
      <header className="maka-daily-review-header">
        <button
          type="button"
          className="maka-button maka-button-ghost"
          onClick={() => setOffsetDays((n) => n - range)}
          aria-label={`查看更早一${stepperLabel}`}
        >
          ‹
        </button>
        <div className="maka-daily-review-day">{dayLabel}</div>
        <button
          type="button"
          className="maka-button maka-button-ghost"
          onClick={() => setOffsetDays((n) => Math.min(0, n + range))}
          disabled={offsetDays >= 0}
          aria-label={`查看更晚一${stepperLabel}`}
        >
          ›
        </button>
      </header>
      <nav className="maka-daily-review-range" aria-label="时间范围切换">
        <div className="maka-daily-review-range-tabs">
          {([1, 7, 30] as const).map((option) => (
            <button
              key={option}
              type="button"
              className="maka-button maka-button-ghost"
              data-active={range === option ? 'true' : undefined}
              aria-pressed={range === option}
              onClick={() => {
                setRange(option);
                setOffsetDays(0);
              }}
            >
              {option === 1 ? '今日' : option === 7 ? '本周' : '本月'}
            </button>
          ))}
        </div>
        {summary && summary.totals.sessionCount + summary.totals.requestCount > 0 && hasDailyReviewActions && (
          <div className="maka-daily-review-actions" aria-label="回顾导出操作">
            {props.onCopyMarkdown && (
              <button
                type="button"
                className="maka-button maka-button-ghost maka-daily-review-copy"
                onClick={() => void runDailyReviewAction('copy', async () => {
                  const md = formatDailyReviewMarkdown(summary, dayLabel);
                  await props.onCopyMarkdown?.({ markdown: md, label: dayLabel, summary });
                })}
                disabled={dailyReviewActionBusy}
                data-pending={pendingDailyReviewAction === 'copy' ? 'true' : undefined}
                aria-busy={pendingDailyReviewAction === 'copy' ? 'true' : undefined}
                title="复制为 Markdown 摘要，方便分享 / 贴到笔记"
              >
                {pendingDailyReviewAction === 'copy' ? '复制中…' : '复制'}
              </button>
            )}
            {props.onAppendMarkdown && (
              <button
                type="button"
                className="maka-button maka-button-ghost maka-daily-review-append"
                onClick={() => void runDailyReviewAction('append', async () => {
                  const md = formatDailyReviewMarkdown(summary, dayLabel);
                  await props.onAppendMarkdown?.({ markdown: md, label: dayLabel, summary });
                })}
                disabled={dailyReviewActionBusy}
                data-pending={pendingDailyReviewAction === 'append' ? 'true' : undefined}
                aria-busy={pendingDailyReviewAction === 'append' ? 'true' : undefined}
                title="追加到当前输入框草稿"
              >
                {pendingDailyReviewAction === 'append' ? '追加中…' : '粘到输入框'}
              </button>
            )}
            {props.onSaveMarkdown && (
              <button
                type="button"
                className="maka-button maka-button-ghost maka-daily-review-save"
                onClick={() => void runDailyReviewAction('save', async () => {
                  const md = formatDailyReviewMarkdown(summary, dayLabel);
                  await props.onSaveMarkdown?.({ markdown: md, label: dayLabel, summary });
                })}
                disabled={dailyReviewActionBusy}
                data-pending={pendingDailyReviewAction === 'save' ? 'true' : undefined}
                aria-busy={pendingDailyReviewAction === 'save' ? 'true' : undefined}
                title="保存为 Markdown 文件"
              >
                {pendingDailyReviewAction === 'save' ? '保存中…' : '保存'}
              </button>
            )}
          </div>
        )}
      </nav>

      {error ? (
        <EmptyState
          Icon={CalendarDays}
          title="读取失败"
          body={error}
          cta={{ label: '重试', onClick: () => setReloadToken((n) => n + 1) }}
        />
      ) : loading || !summary ? (
        <div className="maka-daily-review-loading" aria-busy="true">
          <div className="maka-skeleton maka-skeleton-line" style={{ width: '60%' }} />
          <div className="maka-skeleton maka-skeleton-line" style={{ width: '90%' }} />
          <div className="maka-skeleton maka-skeleton-line" style={{ width: '75%' }} />
        </div>
      ) : summary.totals.sessionCount === 0 && summary.totals.requestCount === 0 ? (
        <EmptyState
          Icon={CalendarDays}
          title={emptyActivityTitle}
          body={emptyActivityBody}
        />
      ) : (
        <>
          <section className="maka-daily-review-totals" aria-label={`${dayLabel}总览`}>
            <DailyReviewTotalsCell label="对话" value={summary.totals.sessionCount.toString()} />
            <DailyReviewTotalsCell label="请求" value={summary.totals.requestCount.toString()} />
            <DailyReviewTotalsCell
              label="Token"
              value={summary.totals.totalTokens.toLocaleString()}
            />
            <DailyReviewTotalsCell
              label="费用"
              value={`$${summary.totals.costUsd.toFixed(2)}`}
            />
            {summary.totals.errorCount > 0 && (
              <DailyReviewTotalsCell
                label="错误"
                value={summary.totals.errorCount.toString()}
                tone="error"
              />
            )}
          </section>

          {summary.sessions.length > 0 && (
            <section className="maka-daily-review-section" aria-label="活跃对话">
              <h4 className="maka-daily-review-section-title">活跃对话</h4>
              <ul className="maka-daily-review-list" aria-label="活跃对话列表">
                {summary.sessions.map((session) => (
                  <li key={session.id} className="maka-daily-review-list-item">
                    <button
                      type="button"
                      className="maka-daily-review-session-button"
                      onClick={() => props.onSelectSession?.(session.id)}
                      disabled={!props.onSelectSession}
                    >
                      <span className="maka-daily-review-session-name">{session.name}</span>
                      <RelativeTime
                        ts={session.lastMessageAt}
                        className="maka-daily-review-session-time"
                      />
                    </button>
                    {session.lastMessagePreview && (
                      <span className="maka-daily-review-session-preview">
                        {session.lastMessagePreview}
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            </section>
          )}

          {summary.topModels.length > 0 && (
            <DailyReviewTopList title="模型使用" entries={summary.topModels} />
          )}

          {summary.topTools.length > 0 && (
            <DailyReviewTopList title="工具调用" entries={summary.topTools} />
          )}
        </>
      )}
    </div>
  );
}

function dailyReviewPanelErrorMessage(error: unknown): string {
  return generalizedErrorMessageChinese(error, '每日回顾暂时不可用，请稍后重试。');
}

/**
 * PR-DAILY-REVIEW-COPY-0: produce a Markdown summary of the current
 * Daily Review for clipboard share. Sessions list is title-only —
 * we deliberately skip lastMessagePreview because the message body
 * may contain content the user does not want in a shared note.
 */
export function formatDailyReviewMarkdown(
  summary: DailyReviewSummary,
  dayLabel: string,
): string {
  const lines: string[] = [];
  lines.push(`# Maka · 每日回顾 · ${dayLabel}`);
  lines.push('');
  lines.push(`- 对话：${summary.totals.sessionCount}`);
  lines.push(`- 请求：${summary.totals.requestCount}`);
  lines.push(`- Token：${summary.totals.totalTokens.toLocaleString()}`);
  lines.push(`- 费用：$${summary.totals.costUsd.toFixed(2)}`);
  if (summary.totals.errorCount > 0) {
    lines.push(`- 错误：${summary.totals.errorCount}`);
  }
  if (summary.sessions.length > 0) {
    lines.push('');
    lines.push('## 活跃对话');
    for (const session of summary.sessions) {
      lines.push(`- ${session.name}`);
    }
  }
  if (summary.topModels.length > 0) {
    lines.push('');
    lines.push('## 模型使用');
    for (const entry of summary.topModels) {
      const cost = entry.costUsd > 0 ? ` · $${entry.costUsd.toFixed(2)}` : '';
      lines.push(`- ${entry.label}：${entry.requests} 次 · ${entry.totalTokens.toLocaleString()} tok${cost}`);
    }
  }
  if (summary.topTools.length > 0) {
    lines.push('');
    lines.push('## 工具调用');
    for (const entry of summary.topTools) {
      lines.push(`- ${entry.label}：${entry.requests} 次`);
    }
  }
  return lines.join('\n');
}

function DailyReviewTotalsCell(props: { label: string; value: string; tone?: 'error' }) {
  return (
    <div className="maka-daily-review-totals-cell" data-tone={props.tone}>
      <span className="maka-daily-review-totals-value">{props.value}</span>
      <span className="maka-daily-review-totals-label">{props.label}</span>
    </div>
  );
}

function DailyReviewTopList(props: { title: string; entries: ReadonlyArray<DailyReviewTopEntry> }) {
  return (
    <section className="maka-daily-review-section" aria-label={props.title}>
      <h4 className="maka-daily-review-section-title">{props.title}</h4>
      <ul className="maka-daily-review-list" aria-label={`${props.title}列表`}>
        {props.entries.map((entry) => (
          <li key={entry.key} className="maka-daily-review-list-item">
            <span className="maka-daily-review-top-label">{entry.label}</span>
            <span className="maka-daily-review-top-meta">
              {entry.requests} 次 · {entry.totalTokens.toLocaleString()} tok
              {entry.costUsd > 0 ? ` · $${entry.costUsd.toFixed(2)}` : ''}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

function PlanReminderPanel(props: {
  reminders: PlanReminder[];
  onCreate?(input: PlanReminderDraftInput): boolean | Promise<boolean> | void | Promise<void>;
  onUpdate?(id: string, patch: PlanReminderUpdatePatch): boolean | Promise<boolean> | void | Promise<void>;
  onToggle?(id: string, enabled: boolean): void | Promise<void>;
  onTriggerNow?(id: string): void | Promise<void>;
  onSnooze?(id: string): void | Promise<void>;
  onClearRunHistory?(id: string): void | Promise<void>;
  onDelete?(id: string): void | Promise<void>;
}) {
  type PlanReminderListFilter = 'all' | PlanReminderStatus;
  const [title, setTitle] = useState('');
  const [note, setNote] = useState('');
  const [runAtLocal, setRunAtLocal] = useState(() => toPlanReminderDateTimeInputValue(Date.now() + 60 * 60 * 1000));
  const [recurrence, setRecurrence] = useState<PlanReminderRecurrence>('none');
  const [cronExpression, setCronExpression] = useState('0 9 * * 1-5');
  const [deliveryChannel, setDeliveryChannel] = useState<PlanReminderDeliveryTarget['channel']>('local');
  const [deliveryPlatform, setDeliveryPlatform] = useState<BotProvider>('telegram');
  const [deliveryChatId, setDeliveryChatId] = useState('');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [submitPending, setSubmitPending] = useState(false);
  const [pendingActionKeys, setPendingActionKeys] = useState<ReadonlySet<string>>(() => new Set());
  const pendingActionKeysRef = useRef<Set<string>>(new Set());
  const [listFilter, setListFilter] = useState<PlanReminderListFilter>('all');
  const [listQuery, setListQuery] = useState('');
  const parsedRunAt = Date.parse(runAtLocal);
  const normalizedListQuery = normalizePlanReminderSearchQuery(listQuery);
  const searchMatchedReminders = normalizedListQuery
    ? props.reminders.filter((reminder) => planReminderMatchesSearch(reminder, normalizedListQuery))
    : props.reminders;
  const visibleReminders = listFilter === 'all'
    ? searchMatchedReminders
    : searchMatchedReminders.filter((reminder) => reminder.status === listFilter);
  const sortedReminders = [...visibleReminders].sort(comparePlanReminderForDisplay);
  const filterCounts: Record<PlanReminderListFilter, number> = {
    all: searchMatchedReminders.length,
    scheduled: searchMatchedReminders.filter((reminder) => reminder.status === 'scheduled').length,
    paused: searchMatchedReminders.filter((reminder) => reminder.status === 'paused').length,
    completed: searchMatchedReminders.filter((reminder) => reminder.status === 'completed').length,
  };
  const delivery: PlanReminderDeliveryTarget = deliveryChannel === 'bot'
    ? { channel: 'bot', platform: deliveryPlatform, chatId: deliveryChatId.trim() }
    : { channel: 'local' };
  const validationMessage = planReminderFormValidationMessage({
    title,
    parsedRunAt,
    recurrence,
    cronExpression,
    delivery,
    now: Date.now(),
  });
  const canCreate = validationMessage === null;
  const submitDisabled = !canCreate || submitPending;
  const formInteractionDisabled = submitPending;
  const isEditing = editingId !== null;

  useEffect(() => {
    if (editingId && !props.reminders.some((reminder) => reminder.id === editingId)) resetForm();
  }, [editingId, props.reminders]);

  function resetForm() {
    setTitle('');
    setNote('');
    setRecurrence('none');
    setCronExpression('0 9 * * 1-5');
    setDeliveryChannel('local');
    setDeliveryPlatform('telegram');
    setDeliveryChatId('');
    setRunAtLocal(toPlanReminderDateTimeInputValue(Date.now() + 60 * 60 * 1000));
    setEditingId(null);
  }

  function editReminder(reminder: PlanReminder) {
    setEditingId(reminder.id);
    setTitle(reminder.title);
    setNote(reminder.note);
    setRunAtLocal(toPlanReminderDateTimeInputValue(planReminderEditableRunAt(reminder)));
    setRecurrence(planReminderRecurrenceValue(reminder));
    setCronExpression(reminder.schedule.kind === 'cron' ? reminder.schedule.expression : '0 9 * * 1-5');
    setDeliveryChannel(reminder.delivery.channel);
    if (reminder.delivery.channel === 'bot') {
      setDeliveryPlatform(reminder.delivery.platform);
      setDeliveryChatId(reminder.delivery.chatId);
    } else {
      setDeliveryPlatform('telegram');
      setDeliveryChatId('');
    }
  }

  function duplicateReminder(reminder: PlanReminder) {
    setEditingId(null);
    setTitle(duplicatePlanReminderTitle(reminder.title));
    setNote(reminder.note);
    setRunAtLocal(toPlanReminderDateTimeInputValue(planReminderEditableRunAt(reminder)));
    setRecurrence(planReminderRecurrenceValue(reminder));
    setCronExpression(reminder.schedule.kind === 'cron' ? reminder.schedule.expression : '0 9 * * 1-5');
    setDeliveryChannel(reminder.delivery.channel);
    if (reminder.delivery.channel === 'bot') {
      setDeliveryPlatform(reminder.delivery.platform);
      setDeliveryChatId(reminder.delivery.chatId);
    } else {
      setDeliveryPlatform('telegram');
      setDeliveryChatId('');
    }
  }

  function applyRunAtPreset(preset: 'ten-minutes' | 'one-hour' | 'tomorrow-morning' | 'next-monday') {
    setRunAtLocal(toPlanReminderDateTimeInputValue(planReminderPresetRunAt(preset)));
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitDisabled) return;
    const input = {
      title: title.trim(),
      note: note.trim(),
      runAt: parsedRunAt,
      recurrence,
      ...(recurrence === 'cron' ? { cronExpression: cronExpression.trim() } : {}),
      delivery,
    };
    setSubmitPending(true);
    try {
      const result = editingId
        ? await props.onUpdate?.(editingId, input)
        : await props.onCreate?.({
          ...input,
          ...(input.note ? { note: input.note } : {}),
        });
      if (result !== false) resetForm();
    } finally {
      setSubmitPending(false);
    }
  }

  async function runPlanReminderAction(
    actionKey: string,
    action: (() => void | Promise<void>) | undefined,
  ) {
    if (!action || pendingActionKeysRef.current.has(actionKey)) return;
    const pendingWithAction = new Set(pendingActionKeysRef.current);
    pendingWithAction.add(actionKey);
    pendingActionKeysRef.current = pendingWithAction;
    setPendingActionKeys(pendingWithAction);
    try {
      await action();
    } finally {
      const pendingWithoutAction = new Set(pendingActionKeysRef.current);
      pendingWithoutAction.delete(actionKey);
      pendingActionKeysRef.current = pendingWithoutAction;
      setPendingActionKeys(pendingWithoutAction);
    }
  }

  return (
    <div className="maka-plan-panel">
      <form className="maka-plan-form" onSubmit={submit} aria-busy={submitPending ? 'true' : undefined}>
        <div className="maka-plan-form-title">{isEditing ? '编辑提醒' : '新建提醒'}</div>
        <label className="maka-plan-field">
          <span>标题</span>
          <input
            value={title}
            onChange={(event) => setTitle(event.currentTarget.value)}
            maxLength={120}
            data-maka-plan-title-input="true"
            placeholder="例如：明天复盘项目进度"
            disabled={formInteractionDisabled}
          />
        </label>
        <label className="maka-plan-field">
          <span>时间</span>
          <input
            value={runAtLocal}
            onChange={(event) => setRunAtLocal(event.currentTarget.value)}
            type="text"
            inputMode="numeric"
            autoComplete="off"
            spellCheck={false}
            placeholder="2026-06-05 13:44"
            aria-label="提醒时间"
            disabled={formInteractionDisabled}
          />
        </label>
        <div className="maka-plan-presets" aria-label="快速设置提醒时间">
          {[
            ['ten-minutes', '10 分钟后'],
            ['one-hour', '1 小时后'],
            ['tomorrow-morning', '明天 9 点'],
            ['next-monday', '下周一 9 点'],
          ].map(([preset, label]) => (
            <button
              key={preset}
              type="button"
              className="maka-plan-preset"
              onClick={() => applyRunAtPreset(preset as 'ten-minutes' | 'one-hour' | 'tomorrow-morning' | 'next-monday')}
              disabled={formInteractionDisabled}
            >
              {label}
            </button>
          ))}
        </div>
        <label className="maka-plan-field">
          <span>重复</span>
          <select
            value={recurrence}
            onChange={(event) => setRecurrence(event.currentTarget.value as PlanReminderRecurrence)}
            disabled={formInteractionDisabled}
          >
            <option value="none">不重复</option>
            <option value="daily">每天</option>
            <option value="weekly">每周</option>
            <option value="monthly">每月</option>
            <option value="cron">Cron</option>
          </select>
        </label>
        {recurrence === 'cron' && (
          <label className="maka-plan-field">
            <span>Cron</span>
            <input
              value={cronExpression}
              onChange={(event) => setCronExpression(event.currentTarget.value)}
              maxLength={80}
              placeholder="例如 0 9 * * 1-5"
              disabled={formInteractionDisabled}
            />
          </label>
        )}
        <div className="maka-plan-delivery-grid">
          <label className="maka-plan-field">
            <span>投递</span>
            <select
              value={deliveryChannel}
              onChange={(event) => setDeliveryChannel(event.currentTarget.value as PlanReminderDeliveryTarget['channel'])}
              disabled={formInteractionDisabled}
            >
              <option value="local">本地提醒</option>
              <option value="bot">机器人聊天</option>
            </select>
          </label>
          {deliveryChannel === 'bot' && (
            <label className="maka-plan-field">
              <span>平台</span>
              <select
                value={deliveryPlatform}
                onChange={(event) => setDeliveryPlatform(event.currentTarget.value as BotProvider)}
                disabled={formInteractionDisabled}
              >
                {BOT_DELIVERY_PROVIDERS.map((provider) => (
                  <option key={provider} value={provider}>{botDisplayLabel(provider)}</option>
                ))}
              </select>
            </label>
          )}
        </div>
        {deliveryChannel === 'bot' && (
          <>
            <p className="maka-plan-delivery-help">
              当前可投递到 {formatPlanDeliveryProviderList()}；其它机器人平台不会出现在投递目标里。
            </p>
            <label className="maka-plan-field">
              <span>Chat ID</span>
              <input
                value={deliveryChatId}
                onChange={(event) => setDeliveryChatId(event.currentTarget.value)}
                maxLength={160}
                placeholder="例如 Telegram chat_id"
                disabled={formInteractionDisabled}
              />
            </label>
          </>
        )}
        <label className="maka-plan-field">
          <span>备注</span>
          <textarea
            value={note}
            onChange={(event) => setNote(event.currentTarget.value)}
            maxLength={1000}
            rows={3}
            placeholder="可选：补充需要提醒的上下文"
            disabled={formInteractionDisabled}
          />
        </label>
        {validationMessage && (
          <p className="maka-plan-validation" role="status" aria-live="polite">
            {validationMessage}
          </p>
        )}
        <button className="maka-button maka-plan-submit" type="submit" disabled={submitDisabled}>
          {isEditing ? <Check size={14} strokeWidth={1.75} aria-hidden="true" /> : <Plus size={14} strokeWidth={1.75} aria-hidden="true" />}
          <span>{submitPending ? (isEditing ? '保存中…' : '创建中…') : (isEditing ? '保存提醒' : '创建提醒')}</span>
        </button>
        {isEditing && (
          <button
            className="maka-button secondary maka-plan-submit"
            type="button"
            onClick={resetForm}
            disabled={formInteractionDisabled}
          >
            取消编辑
          </button>
        )}
      </form>

      <div className="maka-plan-list" aria-label="计划提醒列表">
        <label className="maka-plan-search">
          <span>搜索计划提醒</span>
          <input
            value={listQuery}
            onChange={(event) => setListQuery(event.currentTarget.value)}
            maxLength={120}
            placeholder="搜索标题、备注、投递或执行记录…"
          />
        </label>
        {normalizedListQuery && (
          <div className="maka-plan-search-summary" role="status" aria-live="polite">
            <span>找到 {searchMatchedReminders.length} 个匹配提醒</span>
            <button type="button" onClick={() => setListQuery('')}>清除搜索</button>
          </div>
        )}
        <div className="maka-plan-filters" aria-label="计划提醒筛选">
          {[
            ['all', '全部'],
            ['scheduled', '待触发'],
            ['paused', '已暂停'],
            ['completed', '已完成'],
          ].map(([value, label]) => (
            <button
              key={value}
              type="button"
              className="maka-plan-filter"
              data-active={listFilter === value ? 'true' : 'false'}
              aria-pressed={listFilter === value}
              onClick={() => setListFilter(value as PlanReminderListFilter)}
            >
              <span>{label}</span>
              <span>{filterCounts[value as PlanReminderListFilter]}</span>
            </button>
          ))}
        </div>
        {props.reminders.length === 0 ? (
          <EmptyState
            Icon={Clock}
            title="等待创建计划提醒"
            body="创建一次性或重复提醒；Maka 会持久化并在到点时记录执行结果。"
            extraClassName="maka-plan-empty"
          />
        ) : sortedReminders.length === 0 ? (
          <EmptyState
            Icon={Clock}
            title={normalizedListQuery ? '没有匹配的提醒' : '当前筛选没有提醒'}
            body={normalizedListQuery ? '调整搜索词，或切换状态筛选查看其他提醒。' : '切换筛选查看其他状态，或创建新的计划提醒。'}
            extraClassName="maka-plan-empty"
          />
        ) : (
          planReminderDisplayRows(listFilter, sortedReminders).map((row) => {
            if (row.kind === 'group') {
              return (
                <div key={row.key} className="maka-plan-group-header" aria-label={`${row.label}，${row.count} 个提醒`}>
                  <span>{row.label}</span>
                  <span>{row.count}</span>
                </div>
              );
            }
            const reminder = row.reminder;
            const reminderActionPrefix = `${reminder.id}:`;
            const reminderActionPending = Array.from(pendingActionKeys).some((key) => key.startsWith(reminderActionPrefix));
            return (
            <article key={reminder.id} className="maka-plan-card" data-status={reminder.status}>
              <div className="maka-plan-card-main">
                <div className="maka-plan-card-title">{reminder.title}</div>
                <div className="maka-plan-card-time">
                  {reminder.nextRunAt ? (
                    <>
                      下次触发：{formatReminderTime(reminder.nextRunAt)}
                      <span className="maka-plan-card-countdown">
                        {formatReminderCountdown(reminder.nextRunAt)}
                      </span>
                    </>
                  ) : reminder.lastRun ? (
                    `最近执行：${formatReminderTime(reminder.lastRun.at)} · ${runStatusLabel(reminder.lastRun.status)}`
                  ) : (
                    '未安排'
                  )}
                </div>
                <div className="maka-plan-card-repeat">{formatPlanRecurrence(reminder)}</div>
                <div className="maka-plan-card-delivery">{formatPlanReminderDeliveryTarget(reminder.delivery)}</div>
                {reminder.note && <div className="maka-plan-card-note">{reminder.note}</div>}
                {reminder.lastRun && (
                  <div className="maka-plan-card-run">
                    {runStatusLabel(reminder.lastRun.status)}：{reminder.lastRun.message}
                  </div>
                )}
                {reminder.runs.length > 1 && (
                  <div className="maka-plan-card-history" aria-label="最近执行记录">
                    <div className="maka-plan-card-history-title">最近执行</div>
                    {reminder.runs.slice(0, 3).map((run) => (
                      <div key={run.id} className="maka-plan-card-history-row">
                        <span>{formatReminderTime(run.at)}</span>
                        <span>{runStatusLabel(run.status)}</span>
                        <span>{run.message}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
              <div className="maka-plan-card-actions">
                <button
                  type="button"
                  className="maka-plan-action"
                  onClick={() => editReminder(reminder)}
                  disabled={submitPending || reminderActionPending || reminder.status === 'completed'}
                  title="编辑提醒"
                >
                  编辑
                </button>
                <button
                  type="button"
                  className="maka-plan-action"
                  onClick={() => duplicateReminder(reminder)}
                  disabled={submitPending || reminderActionPending}
                  title="复制为新提醒"
                >
                  复制
                </button>
                <button
                  type="button"
                  className="maka-plan-action"
                  onClick={() => void runPlanReminderAction(`${reminder.id}:trigger`, () => props.onTriggerNow?.(reminder.id))}
                  disabled={reminderActionPending || !reminder.enabled}
                  title="立即触发一次"
                >
                  {pendingActionKeys.has(`${reminder.id}:trigger`) ? '触发中…' : '立即触发'}
                </button>
                <button
                  type="button"
                  className="maka-plan-action"
                  onClick={() => void runPlanReminderAction(`${reminder.id}:snooze`, () => props.onSnooze?.(reminder.id))}
                  disabled={reminderActionPending || !reminder.enabled || reminder.status !== 'scheduled' || typeof reminder.nextRunAt !== 'number'}
                  title="延后 10 分钟"
                >
                  {pendingActionKeys.has(`${reminder.id}:snooze`) ? '延后中…' : '延后 10 分钟'}
                </button>
                <button
                  type="button"
                  className="maka-plan-action"
                  onClick={() => void runPlanReminderAction(`${reminder.id}:clear-runs`, () => props.onClearRunHistory?.(reminder.id))}
                  disabled={reminderActionPending || reminder.runs.length === 0 || reminder.status === 'completed'}
                  title="清空最近执行记录"
                >
                  {pendingActionKeys.has(`${reminder.id}:clear-runs`) ? '清空中…' : '清空记录'}
                </button>
                <button
                  type="button"
                  className="maka-plan-action"
                  onClick={() => void runPlanReminderAction(`${reminder.id}:toggle`, () => props.onToggle?.(reminder.id, !reminder.enabled))}
                  disabled={reminderActionPending || reminder.status === 'completed'}
                  title={reminder.enabled ? '暂停提醒' : '启用提醒'}
                >
                  {pendingActionKeys.has(`${reminder.id}:toggle`) ? (reminder.enabled ? '暂停中…' : '启用中…') : (reminder.enabled ? '暂停' : '启用')}
                </button>
                <button
                  type="button"
                  className="maka-plan-action maka-plan-action-danger"
                  onClick={() => void runPlanReminderAction(`${reminder.id}:delete`, () => props.onDelete?.(reminder.id))}
                  disabled={reminderActionPending}
                  title="删除提醒"
                >
                  {pendingActionKeys.has(`${reminder.id}:delete`) ? '删除中…' : '删除'}
                </button>
              </div>
            </article>
            );
          })
        )}
      </div>
    </div>
  );
}

function toPlanReminderDateTimeInputValue(ts: number): string {
  const date = new Date(ts);
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function planReminderPresetRunAt(preset: 'ten-minutes' | 'one-hour' | 'tomorrow-morning' | 'next-monday', now: number = Date.now()): number {
  if (preset === 'ten-minutes') return now + 10 * 60 * 1000;
  if (preset === 'one-hour') return now + 60 * 60 * 1000;
  const date = new Date(now);
  if (preset === 'tomorrow-morning') {
    date.setDate(date.getDate() + 1);
    date.setHours(9, 0, 0, 0);
    return date.getTime();
  }
  const day = date.getDay();
  const daysUntilNextMonday = ((8 - day) % 7) || 7;
  date.setDate(date.getDate() + daysUntilNextMonday);
  date.setHours(9, 0, 0, 0);
  return date.getTime();
}

function planReminderFormValidationMessage(input: {
  title: string;
  parsedRunAt: number;
  recurrence: PlanReminderRecurrence;
  cronExpression: string;
  delivery: PlanReminderDeliveryTarget;
  now: number;
}): string | null {
  if (input.title.trim().length === 0) return '填写标题后才能保存提醒。';
  if (!Number.isFinite(input.parsedRunAt)) return '选择有效的提醒时间。';
  if (input.parsedRunAt < input.now) return '提醒时间必须晚于当前时间。';
  if (input.recurrence === 'cron' && input.cronExpression.trim().split(/\s+/).length !== 5) {
    return 'Cron 需要 5 段表达式，例如 0 9 * * 1-5。';
  }
  if (input.delivery.channel === 'bot' && input.delivery.chatId.length === 0) {
    return '选择机器人聊天时需要填写 Chat ID。';
  }
  return null;
}

function formatPlanDeliveryProviderList(): string {
  return BOT_DELIVERY_PROVIDERS.map((provider) => botDisplayLabel(provider)).join(' / ');
}

function comparePlanReminderForDisplay(a: PlanReminder, b: PlanReminder): number {
  const statusDelta = planReminderStatusDisplayRank(a) - planReminderStatusDisplayRank(b);
  if (statusDelta !== 0) return statusDelta;
  if (a.status === 'scheduled' && b.status === 'scheduled') {
    return planReminderNextRunSortValue(a) - planReminderNextRunSortValue(b);
  }
  if (a.status === 'completed' && b.status === 'completed') {
    return planReminderLastRunSortValue(b) - planReminderLastRunSortValue(a);
  }
  return a.title.localeCompare(b.title, 'zh-Hans-CN');
}

function planReminderStatusDisplayRank(reminder: PlanReminder): number {
  if (reminder.status === 'scheduled') return 0;
  if (reminder.status === 'paused') return 1;
  if (reminder.status === 'completed') return 2;
  return 3;
}

function planReminderNextRunSortValue(reminder: PlanReminder): number {
  return typeof reminder.nextRunAt === 'number' ? reminder.nextRunAt : Number.MAX_SAFE_INTEGER;
}

function planReminderLastRunSortValue(reminder: PlanReminder): number {
  return reminder.lastRun?.at ?? 0;
}

function normalizePlanReminderSearchQuery(query: string): string {
  return query.trim().toLocaleLowerCase();
}

function planReminderMatchesSearch(reminder: PlanReminder, query: string): boolean {
  return planReminderSearchText(reminder).toLocaleLowerCase().includes(query);
}

function planReminderSearchText(reminder: PlanReminder): string {
  return [
    reminder.title,
    reminder.note,
    reminder.status,
    formatPlanRecurrence(reminder),
    formatPlanReminderDeliveryTarget(reminder.delivery),
    reminder.lastRun?.message,
    ...reminder.runs.map((run) => `${runStatusLabel(run.status)} ${run.message}`),
  ].filter(Boolean).join('\n');
}

type PlanReminderDisplayRow =
  | { kind: 'group'; key: string; label: string; count: number }
  | { kind: 'reminder'; reminder: PlanReminder };

function planReminderDisplayRows(filter: 'all' | PlanReminderStatus, reminders: PlanReminder[]): PlanReminderDisplayRow[] {
  if (filter !== 'all') return reminders.map((reminder) => ({ kind: 'reminder', reminder }));
  const rows: PlanReminderDisplayRow[] = [];
  for (const status of ['scheduled', 'paused', 'completed'] satisfies PlanReminderStatus[]) {
    const group = reminders.filter((reminder) => reminder.status === status);
    if (group.length === 0) continue;
    rows.push({ kind: 'group', key: `group-${status}`, label: planReminderStatusGroupLabel(status), count: group.length });
    rows.push(...group.map((reminder) => ({ kind: 'reminder' as const, reminder })));
  }
  return rows;
}

function planReminderStatusGroupLabel(status: PlanReminderStatus): string {
  if (status === 'scheduled') return '待触发';
  if (status === 'paused') return '已暂停';
  return '已完成';
}

function planReminderEditableRunAt(reminder: PlanReminder, now: number = Date.now()): number {
  if (typeof reminder.nextRunAt === 'number' && reminder.nextRunAt > now) return reminder.nextRunAt;
  const scheduledAt = reminder.schedule.kind === 'once' ? reminder.schedule.runAt : reminder.schedule.startAt;
  return scheduledAt > now ? scheduledAt : now + 60 * 60 * 1000;
}

function planReminderRecurrenceValue(reminder: PlanReminder): PlanReminderRecurrence {
  if (reminder.schedule.kind === 'once') return 'none';
  if (reminder.schedule.kind === 'cron') return 'cron';
  return reminder.schedule.recurrence;
}

function duplicatePlanReminderTitle(title: string): string {
  const suffix = ' 副本';
  if (title.endsWith(suffix)) return title;
  return `${title}${suffix}`.slice(0, 120);
}

function formatReminderTime(ts: number): string {
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(ts));
}

/**
 * PR-PLAN-NEXT-RUN-COUNTDOWN-0: small chip next to the absolute
 * next-run time so the user sees both "what" and "when from now"
 * in one glance. Past-due reminders read as "已过期"; very near
 * (< 60s) reads "马上"; the rest read in minute / hour / day
 * buckets so screen-reader users get a single self-contained
 * label.
 */
function formatReminderCountdown(ts: number, now: number = Date.now()): string {
  const diffMs = ts - now;
  if (diffMs <= -60_000) return '已过期';
  if (diffMs < 60_000) return '马上';
  const diffMin = Math.round(diffMs / 60_000);
  if (diffMin < 60) return `${diffMin} 分钟后`;
  const diffHour = Math.round(diffMin / 60);
  if (diffHour < 24) return `${diffHour} 小时后`;
  const diffDay = Math.round(diffHour / 24);
  if (diffDay === 1) return '明天';
  if (diffDay < 7) return `${diffDay} 天后`;
  if (diffDay < 30) return `${Math.round(diffDay / 7)} 周后`;
  return `${Math.round(diffDay / 30)} 个月后`;
}

function formatPlanRecurrence(reminder: PlanReminder): string {
  if (reminder.schedule.kind === 'once') return '一次性提醒';
  if (reminder.schedule.kind === 'cron') return `Cron：${reminder.schedule.expression}`;
  if (reminder.schedule.recurrence === 'daily') return '重复：每天';
  if (reminder.schedule.recurrence === 'weekly') return '重复：每周';
  return '重复：每月';
}

function runStatusLabel(status: NonNullable<PlanReminder['lastRun']>['status']): string {
  if (status === 'triggered') return '已触发';
  if (status === 'blocked') return '已阻止';
  return '失败';
}

/**
 * PR-SIDEBAR-IA-0 Phase 2 fixup (xuan `91401163` + kenji `6465cf22`,
 * `7c320898`) + Phase 3 P0 fixup (WAWQAQ msg `d53852ac`, xuan
 * `558f1356`, kenji `3ddc91fe`): Search modal SHELL.
 *
 * Renders the real thread-search dialog: local query state,
 * debounced `search:thread` IPC, result list, incognito/error states,
 * and shell-owned navigation. It never writes history and never
 * constructs `maka://session` URIs.
 *
 * Lifecycle contract: SearchModal MUST be conditionally mounted by
 * the parent (`{open && <SearchModal onClose={...} />}`), NOT
 * always-mounted with an `open` prop. The previous pattern
 * (`<SearchModal open=... />` with an internal `if (!open) return
 * null`) sat hooks before a conditional return; while React allows
 * this in principle, in production WAWQAQ hit a React #310 hook
 * order mismatch via the same surface (msg `d53852ac`). Matching
 * `KeyboardHelpModal`'s conditional-mount pattern eliminates the
 * "hooks before early return" class of bug entirely — there's no
 * way for a future hook addition to drift past a stale return
 * statement.
 *
 * Gate per kenji `7c320898`:
 *   - role="dialog" / aria-modal="true" / explicit title.
 *   - Esc and close button close the modal.
 *   - Focus enters the modal on open; returns to the trigger on close.
 *   - Modal calls injected `searchThread` only; it does NOT store
 *     the query, write history, or route via internal URI strings.
 */
/**
 * Dependency-injected search interface. Production wiring binds this
 * to `window.maka.search.thread`; tests pass an in-memory fake.
 *
 * The return type matches the IPC envelope exactly: either an array
 * of `SearchResult` (success path) or a `{ ok: false, reason, message }`
 * error envelope. Renderer never throws across the IPC boundary —
 * fail-closed paths return the error envelope and the modal renders
 * them as user-facing copy.
 */
export interface SearchModalDeps {
  searchThread(request: SearchRequest): Promise<
    | SearchResult[]
    | { ok: false; reason: SearchErrorReason; message: string }
  >;
}

function searchModalThrownErrorMessage(error: unknown): string {
  return generalizedErrorMessageChinese(error, '搜索服务需要刷新，请重试。');
}

export function SearchModal(props: {
  onClose(): void;
  /**
   * Navigate to a session (optionally scrolling to a specific turn).
   * Provided by the application shell so the modal stays portable —
   * navigation lives in the shell, not in @maka/ui.
   *
   * Per kenji `2844f64f` SEARCH gate: navigation MUST NOT construct
   * `maka://session/<id>` URIs. The callback receives raw ids; the
   * shell handles routing via existing session-pane state.
   */
  onNavigateToSession?(sessionId: string, turnId?: string): void;
  /**
   * Injected `search:thread` IPC. Production binds to
   * `window.maka.search.thread`; tests supply a fake.
   *
   * Optional so the modal renders a degraded "search unavailable"
   * state when the renderer cannot bind to the IPC (legacy / smoke
   * fixture / preload not loaded). Without an injected deps the
   * modal does NOT crash.
   */
  deps?: SearchModalDeps;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);

  // PR-UX-POLISH-1 commit 5 (kenji `2844f64f` SEARCH gate):
  //   - `query` is local state ONLY (no localStorage / no IPC echo).
  //   - `results` is the most recent successful response; older
  //     responses are discarded by the inflight ticket guard so the
  //     UI never shows stale data behind a newer query.
  //   - `error` carries the IPC error envelope when present. We do
  //     NOT raise it as a JS throw — the modal renders the message
  //     copy and the gate's `incognito_active` / `invalid_query`
  //     reasons trigger specific UI states (privacy banner / empty).
  //   - `pending` reflects whether ANY IPC call is in flight. We do
  //     NOT show a spinner if the query is empty (avoids flashing
  //     loading state during typing).
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SearchResult[]>([]);
  const [error, setError] = useState<{ reason: SearchErrorReason; message: string } | null>(null);
  const [pending, setPending] = useState(false);
  const [activeResultIndex, setActiveResultIndex] = useState(-1);
  const inputRef = useRef<HTMLInputElement>(null);
  const resultRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const ticketRef = useRef(0);
  const keyboardSelectionHandledRef = useRef(false);
  const searchThread = props.deps?.searchThread;
  useModalA11y(dialogRef, props.onClose, inputRef);

  // Debounced search: ~180ms after the user stops typing, send the
  // request. Empty query clears state without an IPC roundtrip.
  useEffect(() => {
    if (!searchThread) return;
    const trimmed = query.trim();
    if (trimmed.length === 0) {
      ticketRef.current += 1;
      setResults([]);
      setError(null);
      setPending(false);
      setActiveResultIndex(-1);
      return;
    }
    const ticket = ++ticketRef.current;
    setPending(true);
    const handle = window.setTimeout(async () => {
      try {
        const response = await searchThread({
          source: 'thread',
          query: trimmed,
          limit: 10,
        });
        if (ticket !== ticketRef.current) return; // newer query in flight
        if (Array.isArray(response)) {
          setResults(response);
          setError(null);
          setActiveResultIndex(-1);
        } else {
          setResults([]);
          setError({ reason: response.reason, message: response.message });
          setActiveResultIndex(-1);
        }
      } catch (err) {
        if (ticket !== ticketRef.current) return;
        // IPC layer should never throw, but defend anyway. Render as a
        // generic provider_error so the user sees a coherent state.
        setResults([]);
        setError({
          reason: 'provider_error',
          message: searchModalThrownErrorMessage(err),
        });
        setActiveResultIndex(-1);
      } finally {
        if (ticket === ticketRef.current) setPending(false);
      }
    }, 180);
    return () => window.clearTimeout(handle);
  }, [query, searchThread]);

  useEffect(() => {
    if (activeResultIndex < 0) return;
    resultRefs.current[activeResultIndex]?.scrollIntoView({ block: 'nearest' });
  }, [activeResultIndex]);

  function selectResult(result: SearchResult) {
    if (!props.onNavigateToSession) return;
    if (result.target?.kind !== 'thread') return;
    props.onNavigateToSession(result.target.sessionId, result.target.turnId);
    props.onClose();
  }

  function selectKeyboardResult() {
    if (!showResults) return;
    selectResult(results[activeResultIndex >= 0 ? activeResultIndex : 0]!);
  }

  function clearSearchState() {
    ticketRef.current += 1;
    setResults([]);
    setError(null);
    setPending(false);
    setActiveResultIndex(-1);
  }

  function updateSearchQuery(nextQuery: string) {
    setQuery(nextQuery);
    if (nextQuery.trim().length === 0) {
      clearSearchState();
    }
  }

  function clearSearchQuery() {
    setQuery('');
    clearSearchState();
    inputRef.current?.focus();
  }

  function focusSearchResult(index: number) {
    window.requestAnimationFrame(() => {
      resultRefs.current[index]?.focus({ preventScroll: true });
    });
  }

  function moveActiveResult(delta: 1 | -1, options?: { focusResult?: boolean }) {
    if (results.length === 0) return;
    const next = activeResultIndex < 0
      ? (delta > 0 ? 0 : results.length - 1)
      : (activeResultIndex + delta + results.length) % results.length;
    setActiveResultIndex(next);
    if (options?.focusResult) focusSearchResult(next);
  }

  function jumpActiveResult(index: number, options?: { focusResult?: boolean }) {
    if (results.length === 0) return;
    const next = Math.max(0, Math.min(results.length - 1, index));
    setActiveResultIndex(next);
    if (options?.focusResult) focusSearchResult(next);
  }

  function keyboardKey(event: KeyboardEvent, keys: string[]) {
    return keys.includes(event.key) || keys.includes(event.code);
  }

  function handleResultKeyDown(event: KeyboardEvent<HTMLButtonElement>, index: number, result: SearchResult) {
    if (keyboardKey(event, ['Enter', 'Return', 'Space', ' '])) {
      event.preventDefault();
      selectResult(result);
      return;
    }
    if (keyboardKey(event, ['ArrowDown', 'Down'])) {
      event.preventDefault();
      moveActiveResult(1, { focusResult: true });
      return;
    }
    if (keyboardKey(event, ['ArrowUp', 'Up'])) {
      event.preventDefault();
      moveActiveResult(-1, { focusResult: true });
      return;
    }
    if (keyboardKey(event, ['Home'])) {
      event.preventDefault();
      jumpActiveResult(0, { focusResult: true });
      return;
    }
    if (keyboardKey(event, ['End'])) {
      event.preventDefault();
      jumpActiveResult(results.length - 1, { focusResult: true });
      return;
    }
    if (keyboardKey(event, ['Escape'])) {
      event.preventDefault();
      props.onClose();
      return;
    }
    if (index !== activeResultIndex) {
      setActiveResultIndex(index);
    }
  }

  const incognitoBlocked = error?.reason === 'incognito_active';
  const trimmed = query.trim();
  const showResults = !error && trimmed.length > 0 && !pending && results.length > 0;
  const showEmpty = !error && trimmed.length > 0 && !pending && results.length === 0;
  const activeResultId = showResults && activeResultIndex >= 0 ? `maka-search-modal-result-${activeResultIndex}` : undefined;
  const resultsTruncated = showResults && results.some((result) => result.truncated === true);

  return (
    <div
      className="maka-modal-backdrop maka-search-modal-backdrop"
      role="presentation"
      onClick={props.onClose}
    >
      <div
        ref={dialogRef}
        className="maka-modal maka-search-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="maka-search-modal-title"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="maka-search-modal-header">
          <h2 id="maka-search-modal-title" className="maka-search-modal-title">搜索</h2>
          <button
            type="button"
            className="maka-search-modal-close"
            onClick={props.onClose}
            aria-label="关闭搜索"
          >
            ×
          </button>
        </header>
        <div className="maka-search-modal-input-row">
          <Search size={16} strokeWidth={1.75} aria-hidden="true" className="maka-search-modal-input-icon" />
          <input
            ref={inputRef}
            type="search"
            className="maka-search-modal-input"
            placeholder="搜索会话标题和内容…"
            aria-label="搜索会话标题和内容"
            aria-controls={showResults ? 'maka-search-modal-results' : undefined}
            aria-activedescendant={activeResultId}
            value={query}
            onChange={(event) => updateSearchQuery(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (keyboardKey(event, ['Escape']) && query) {
                event.preventDefault();
                clearSearchQuery();
                return;
              }
              if (keyboardKey(event, ['ArrowDown', 'Down']) && showResults) {
                event.preventDefault();
                moveActiveResult(1, { focusResult: true });
                return;
              }
              if (keyboardKey(event, ['ArrowUp', 'Up']) && showResults) {
                event.preventDefault();
                moveActiveResult(-1, { focusResult: true });
                return;
              }
              if (keyboardKey(event, ['Home']) && showResults) {
                event.preventDefault();
                jumpActiveResult(0, { focusResult: true });
                return;
              }
              if (keyboardKey(event, ['End']) && showResults) {
                event.preventDefault();
                jumpActiveResult(results.length - 1, { focusResult: true });
                return;
              }
              if (keyboardKey(event, ['Enter', 'Return']) && showResults) {
                event.preventDefault();
                keyboardSelectionHandledRef.current = true;
                selectKeyboardResult();
              }
            }}
            onKeyUp={(event) => {
              if (keyboardKey(event, ['Enter', 'Return']) && keyboardSelectionHandledRef.current) {
                if (showResults) event.preventDefault();
                keyboardSelectionHandledRef.current = false;
                return;
              }
              if (keyboardKey(event, ['Enter', 'Return']) && showResults) {
                event.preventDefault();
                selectKeyboardResult();
              }
            }}
            autoComplete="off"
            spellCheck={false}
          />
          {query.length > 0 && (
            <button
              type="button"
              className="maka-search-modal-clear"
              aria-label="清空搜索"
              onClick={clearSearchQuery}
            >
              <X size={14} strokeWidth={1.8} aria-hidden="true" />
            </button>
          )}
        </div>
        <div className="maka-search-modal-body" role="region" aria-label="搜索状态和结果" aria-live="polite">
          {!searchThread && (
            <p className="maka-search-modal-placeholder">
              当前环境无法连接搜索后端，请稍后重试。
            </p>
          )}
          {searchThread && incognitoBlocked && (
            <div className="maka-search-modal-state" data-tone="info">
              <p>隐私模式已关闭搜索。</p>
              <p className="maka-search-modal-state-detail">
                关闭隐私模式后可以继续按关键词查找历史对话。
              </p>
            </div>
          )}
          {searchThread && !incognitoBlocked && error && (
            <div className="maka-search-modal-state" data-tone="warning">
              <p>搜索暂时无法完成。</p>
              <p className="maka-search-modal-state-detail">{error.message}</p>
            </div>
          )}
          {searchThread && !error && trimmed.length === 0 && (
            <p className="maka-search-modal-placeholder">
              开始输入以按关键词查找历史对话。结果只包含会话标题和内容文本，不进入网络。
            </p>
          )}
          {searchThread && pending && trimmed.length > 0 && (
            <p className="maka-search-modal-placeholder" aria-live="polite">
              正在搜索…
            </p>
          )}
          {showEmpty && (
            <p className="maka-search-modal-placeholder">
              没有匹配的会话标题或内容。换个关键词试试。
            </p>
          )}
          {showResults && (
            <>
              <div className="maka-search-modal-result-summary" aria-live="polite">
                <span>找到 {results.length} 条匹配</span>
                {resultsTruncated && <span>结果较多，已显示前 {results.length} 条</span>}
              </div>
              <ul id="maka-search-modal-results" className="maka-search-modal-results" role="listbox" aria-label="搜索结果">
                {results.map((result, index) => (
                  <li key={`${result.target?.kind === 'thread' ? result.target.sessionId : index}-${index}`}>
                    <button
                      ref={(node) => { resultRefs.current[index] = node; }}
                      id={`maka-search-modal-result-${index}`}
                      type="button"
                      role="option"
                      aria-selected={activeResultIndex === index}
                      tabIndex={-1}
                      className="maka-search-modal-result"
                      data-active={activeResultIndex === index ? 'true' : undefined}
                      onClick={() => selectResult(result)}
                      onKeyDown={(event) => handleResultKeyDown(event, index, result)}
                      onFocus={() => setActiveResultIndex(index)}
                      onMouseEnter={() => setActiveResultIndex(index)}
                      disabled={!props.onNavigateToSession || result.target?.kind !== 'thread'}
                    >
                      <div className="maka-search-modal-result-title">{result.title}</div>
                      {result.summary && <div className="maka-search-modal-result-meta">{result.summary}</div>}
                      {result.snippet && (
                        // Plain text only — IPC already redacts secrets
                        // and the snippet is bounded by SNIPPET_MAX_CODE_POINTS.
                        // No markdown rendering, no <img>, no <a href> —
                        // per kenji SEARCH gate (no path / no URL exposure).
                        <div className="maka-search-modal-result-snippet">{renderSearchSnippet(result.snippet, trimmed)}</div>
                      )}
                    </button>
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function renderSearchSnippet(snippet: string, query: string): ReactNode {
  const needle = query.trim();
  if (!needle) return snippet;
  const haystack = snippet.toLocaleLowerCase();
  const lowerNeedle = needle.toLocaleLowerCase();
  const parts: ReactNode[] = [];
  let cursor = 0;
  let matchIndex = haystack.indexOf(lowerNeedle);
  while (matchIndex !== -1) {
    if (matchIndex > cursor) {
      parts.push(snippet.slice(cursor, matchIndex));
    }
    const end = matchIndex + needle.length;
    parts.push(
      <mark key={`${matchIndex}-${end}`} className="maka-search-modal-snippet-hit">
        {snippet.slice(matchIndex, end)}
      </mark>,
    );
    cursor = end;
    matchIndex = haystack.indexOf(lowerNeedle, cursor);
  }
  if (cursor < snippet.length) parts.push(snippet.slice(cursor));
  return parts.length > 0 ? parts : snippet;
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
                {/* PR-UX-POLISH-1 commit 3 (kenji `66123c95`): use
                  full-width Chinese parens `（N）` instead of middle-
                  dot separator. Reads as natural Chinese count
                  notation (`会话（65）`) rather than label+meta
                  pair (`会话 · 65`). The count is part of the
                  group label's semantic, not separate metadata. */}
                <span className="maka-list-group-count">（{group.sessions.length}）</span>
              </button>
            ) : (
              <div className="maka-list-group-label">
                <span>{group.label}</span>
                {group.sessions.length > 1 && (
                  <span className="maka-list-group-count">（{group.sessions.length}）</span>
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
 * PawWork-style sidebar attention priority: asking/busy/error outrank unread,
 * and unread outranks plain time. The status icon beside the name already
 * carries asking/busy/error in Maka, so the right slot only shows the unread
 * dot when no higher-priority row state is active.
 */
function shouldShowSessionUnreadDot(session: SessionSummary, streaming: boolean, active: boolean): boolean {
  if (active) return false;
  if (!session.hasUnread) return false;
  if (streaming) return false;
  return !SIDEBAR_UNREAD_SUPPRESSED_STATUSES.has(session.status);
}

const SIDEBAR_UNREAD_SUPPRESSED_STATUSES = new Set<string>([
  'running',
  'waiting_for_user',
  'blocked',
]);

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
  NO_REAL_CONNECTION: '等待配置可用模型连接',
  auth: '需要重新登录',
  permission_required: '等待权限确认',
  tool_failed: '工具调用失败',
  unknown: '运行中断，可重试',
} as const;

const SCROLL_BOTTOM_THRESHOLD = 64; // px

/**
 * PR-UI-14 (@yuejing 2026-05-22): locale-aware prompt suggestions.
 *
 * Audit §3.7 — the v1 chip set was 6 dev-heavy zh prompts (code review,
 * unit tests, debugging…). Two problems:
 *   1. English-locale users saw a wall of Chinese chips on first run.
 *   2. Non-developer users (PMs, writers, students) saw nothing
 *      universally relevant — the chips read as "Maka is only for
 *      programmers".
 *
 * Fix: detect locale family (zh / en) via `navigator.language` and
 * return a balanced mix of dev + general starting points. Each locale
 * keeps 3 dev chips (codebase summary / explain code / Code review)
 * for the power-user path and adds 3 general chips (read a long doc,
 * translate, draft a message) so the empty-chat surface reads as a
 * general assistant first, a coding assistant second.
 */
type PromptSuggestionLocale = 'zh' | 'en';
type PromptSuggestion = { label: string; prompt: string };

const PROMPT_SUGGESTIONS_BY_LOCALE: Record<PromptSuggestionLocale, PromptSuggestion[]> = {
  zh: [
    { label: '总结代码库', prompt: '帮我总结当前代码库的目录结构和关键模块。' },
    { label: '解释这段代码', prompt: '我贴一段代码进来，请帮我逐行解释它做什么、有没有坑：\n\n```\n\n```' },
    { label: '读一份长文', prompt: '我贴一篇文章/文档过来，请帮我提炼核心观点、列出关键事实、找出我可能漏看的地方：\n\n' },
    { label: '翻译并润色', prompt: '把下面这段翻译成英文，保持原意，语气专业自然：\n\n' },
    { label: '起草一条消息', prompt: '帮我起草一条 ____ 风格的消息，对象是 ____，目的是 ____：\n\n要点：\n- \n- ' },
    { label: '代码审查', prompt: '请帮我审查这段代码，重点关注可读性、错误处理和潜在性能问题：\n\n```\n\n```' },
  ],
  en: [
    { label: 'Summarize codebase', prompt: 'Help me map this codebase: directory layout, key modules, and how they fit together.' },
    { label: 'Explain code', prompt: 'Paste a snippet — explain it line by line and flag any pitfalls:\n\n```\n\n```' },
    { label: 'Read a long doc', prompt: 'Here\'s an article or doc — pull out the core argument, list the key facts, and tell me what I might be missing:\n\n' },
    { label: 'Translate & polish', prompt: 'Translate the text below into Chinese; keep the meaning, tone should stay natural and professional:\n\n' },
    { label: 'Draft message', prompt: 'Help me draft a ____ message to ____, with the goal of ____:\n\nPoints to cover:\n- \n- ' },
    { label: 'Review code', prompt: 'Please review this code — readability, error handling, performance concerns:\n\n```\n\n```' },
  ],
};

/**
 * Detects the renderer-side UI locale family. Used by EmptyChatHero
 * chips + hero copy (PR-UI-14) and Composer / OnboardingHero quickChat
 * placeholders (PR-UI-15). Centralized here so all UI surfaces fall
 * onto the same `zh` / `en` split — there's no per-component drift.
 */
export type UiLocale = PromptSuggestionLocale;

export function detectUiLocale(): UiLocale {
  if (typeof document !== 'undefined') {
    // Precedence (highest to lowest), per kenji `7e532892` +
    // xuan `54b56858` acceptance criteria:
    //   1. visual-smoke fixture override (deterministic baselines).
    //   2. user preference (PR-LANG-PREF-0): persisted in
    //      `personalization.uiLocale`; the renderer mirrors a
    //      resolved-value attribute (`data-maka-locale="zh|en"`)
    //      to `<html>` on mount and on every settings save so we
    //      can read it synchronously here without an async
    //      settings round-trip.
    //   3. Chinese-first product fallback. Most app chrome is already
    //      Chinese, and Electron's `navigator.language` can be `en-US`
    //      on this dev machine, which produced a visibly mixed shell.
    //
    // Real users can still choose English explicitly in Settings; `auto`
    // should not make the default Chinese shell read half-English.
    const smokeOverride = document.documentElement.dataset.makaVisualSmokeLocale;
    if (smokeOverride === 'zh' || smokeOverride === 'en') return smokeOverride;
    const userPref = document.documentElement.dataset.makaLocale;
    if (userPref === 'zh' || userPref === 'en') return userPref;
  }
  return 'zh';
}

// Back-compat alias for the helper introduced in PR-UI-14.
const detectPromptSuggestionLocale = detectUiLocale;

export function getPromptSuggestions(locale?: PromptSuggestionLocale): PromptSuggestion[] {
  return PROMPT_SUGGESTIONS_BY_LOCALE[locale ?? detectUiLocale()];
}

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
  const [actionsVisible, setActionsVisible] = useState(false);
  const [pendingAction, setPendingAction] = useState<SessionRowActionId | null>(null);
  const pendingActionRef = useRef<SessionRowActionId | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const actionBusy = pendingAction !== null;
  const actionTabIndex = actionsVisible ? 0 : -1;

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
    if (!actions || pendingActionRef.current) return;
    setEditing(true);
  }

  function runRowAction(actionId: SessionRowActionId, action: () => void | Promise<void>) {
    if (pendingActionRef.current) return;
    pendingActionRef.current = actionId;
    setPendingAction(actionId);
    void Promise.resolve().then(action).finally(() => {
      pendingActionRef.current = null;
      setPendingAction(null);
    });
  }

  function commitRename(rawValue: string) {
    const trimmed = rawValue.trim();
    setEditing(false);
    if (!trimmed || trimmed === session.name) return;
    if (!actions) return;
    runRowAction('rename', () => actions.onRename(session.id, trimmed));
  }

  function handleDelete(event: MouseEvent<HTMLButtonElement>) {
    stopPropagation(event);
    if (!actions) return;
    // Delegation: the App-level handler owns the confirmation flow via the
    // toast system (PR24), so SessionRow stays presentation-only.
    runRowAction('delete', () => actions.onDelete(session.id));
  }

  function handleRowBlur(event: FocusEvent<HTMLDivElement>) {
    if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
    setActionsVisible(false);
  }

  return (
    <div
      className="maka-list-row"
      data-active={active}
      data-editing={editing}
      data-streaming={streaming ? 'true' : undefined}
      data-stale={stale ? 'true' : undefined}
      onMouseEnter={() => setActionsVisible(true)}
      onMouseLeave={(event) => {
        if (event.currentTarget.contains(document.activeElement)) return;
        setActionsVisible(false);
      }}
      onFocus={() => setActionsVisible(true)}
      onBlur={handleRowBlur}
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
        // PR-SIDEBAR-IA-0 Phase 3 (WAWQAQ `14ed98b5` "list 很丑、很肥很
        // 臃肿"; xuan `6b28984e` Phase 2 sign-off + Phase 3 32-40px
        // target; xuan `2d4526b5` tightening: NO native title= snippet,
        // title is ONLY for name truncation): slim row.
        //
        // The button is the row's hit target. The native `title=`
        // attribute carries ONLY the session name so it serves as a
        // truncation tooltip when the name overflows the row. The
        // `lastMessagePreview` snippet is intentionally NOT exposed
        // here — per xuan `2d4526b5`, snippet visibility is a
        // separate, deliberate design (future PR), not a Phase 3
        // afterthought via native tooltip.
        //
        // `data-active` on the row controls the active-state accent
        // rail + bg tint via CSS; the row's `name` cluster also
        // recolors to accent on selected so the row reads as
        // "current" without a heavy full-bg pill.
        <button
          className="maka-list-row-main"
          type="button"
          data-session-id={session.id}
          aria-current={active ? 'true' : undefined}
          title={session.name}
          onClick={() => onSelect(session.id)}
          onDoubleClick={(event) => {
            event.stopPropagation();
            if (actions && !pendingActionRef.current) setEditing(true);
          }}
        >
          {/*
            PR-SIDEBAR-IA-0 Phase 3 layout (xuan `2d4526b5`):
              [.maka-list-row-text  (col 1: minmax(0,1fr))] [meta/unread  (col 2: auto)]
            The text container holds the name cluster (status icons +
            name + stale pill) and truncates via min-width: 0. The
            meta column sits at the inline-end with a clear gap so
            "会话 02" doesn't run into "0m ago".
          */}
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
                  title="此会话使用的模型连接已不可用，发送时会切换到默认连接"
                  aria-label="会话已过期"
                >
                  已过期
                </span>
              )}
            </div>
          </div>
          {/*
            PR-SIDEBAR-IA-0 Phase 3 (xuan `2d4526b5`): snippet preview
            (`.maka-list-row-preview`) is no longer rendered in the
            default DOM AND is no longer exposed via native `title=`
            tooltip. Snippet visibility is deliberately deferred to a
            future PR with its own hover/focus detail design.
            `formatSessionMeta` shows the relative time inline in the
            row's `auto` grid column (sibling of `.maka-list-row-text`,
            not nested inside it — required for proper gap + alignment).
            The unread dot replaces the time only when no higher-priority
            row state is active. Borrowed from PawWork's sidebar priority:
            asking/busy/error outrank unread; unread outranks plain time.
          */}
          {shouldShowSessionUnreadDot(session, Boolean(streaming), active) ? (
            <span className="maka-list-row-unread" aria-label="未读消息" />
          ) : (
            <span className="maka-list-row-meta">{formatSessionMeta(session)}</span>
          )}
        </button>
      )}
      {actions && !editing && (
        <div
          className="maka-list-row-actions"
          aria-label="对话操作"
          aria-hidden={actionsVisible ? undefined : 'true'}
          data-visible={actionsVisible ? 'true' : undefined}
        >
          <button
            type="button"
            className="maka-list-row-action"
            tabIndex={actionTabIndex}
            onClick={(event) => {
              stopPropagation(event);
              runRowAction('flag', () => actions.onToggleFlag(session.id, !session.isFlagged));
            }}
            aria-label={session.isFlagged ? '取消置顶对话' : '置顶对话'}
            aria-busy={pendingAction === 'flag' ? 'true' : undefined}
            data-active={session.isFlagged}
            data-pending={pendingAction === 'flag' ? 'true' : undefined}
            disabled={actionBusy}
            title={session.isFlagged ? '取消置顶对话' : '置顶对话'}
          >
            {session.isFlagged
              ? <PinOff size={14} strokeWidth={1.75} aria-hidden="true" />
              : <Pin size={14} strokeWidth={1.75} aria-hidden="true" />}
          </button>
          <button
            type="button"
            className="maka-list-row-action"
            tabIndex={actionTabIndex}
            onClick={startRename}
            aria-label="重命名对话"
            aria-busy={pendingAction === 'rename' ? 'true' : undefined}
            data-pending={pendingAction === 'rename' ? 'true' : undefined}
            disabled={actionBusy}
            title="重命名（双击行名也可）"
          >
            <Pencil size={14} strokeWidth={1.75} aria-hidden="true" />
          </button>
          <button
            type="button"
            className="maka-list-row-action"
            tabIndex={actionTabIndex}
            onClick={(event) => {
              stopPropagation(event);
              runRowAction('archive', () => (
                session.isArchived
                  ? actions.onUnarchive(session.id)
                  : actions.onArchive(session.id)
              ));
            }}
            aria-label={session.isArchived ? '取消归档对话' : '归档对话'}
            aria-busy={pendingAction === 'archive' ? 'true' : undefined}
            data-pending={pendingAction === 'archive' ? 'true' : undefined}
            disabled={actionBusy}
            title={session.isArchived ? '取消归档' : '归档'}
          >
            {session.isArchived
              ? <ArchiveRestore size={14} strokeWidth={1.75} aria-hidden="true" />
              : <Archive size={14} strokeWidth={1.75} aria-hidden="true" />}
          </button>
          <button
            type="button"
            className="maka-list-row-action maka-list-row-action-danger"
            tabIndex={actionTabIndex}
            onClick={handleDelete}
            aria-label="删除对话"
            aria-busy={pendingAction === 'delete' ? 'true' : undefined}
            data-pending={pendingAction === 'delete' ? 'true' : undefined}
            disabled={actionBusy}
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
    label: '只读',
    hint: '只读模式：读取、列表、搜索直通，写入或网络仍需明确确认。',
    tone: 'info',
  },
  ask: {
    label: '确认',
    hint: '平衡模式：敏感工具调用前必须允许或拒绝。',
    tone: 'accent',
  },
  execute: {
    label: '执行',
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

export interface ChatModelChoice {
  connectionSlug: string;
  connectionLabel: string;
  providerType: ProviderType;
  model: string;
  label?: string;
}

export function ChatView(props: {
  messages: StoredMessage[];
  streamingText: string;
  /**
   * PR-UI-LAYOUT-42: Anthropic extended-thinking stream from
   * `ThinkingDeltaEvent` (`@maka/core/events`). When non-empty, a
   * collapsible "Reasoning" panel renders above the streaming text
   * so users with thinking models see the live reasoning while the
   * answer is being composed. Empty string = no thinking active.
   */
  thinkingText?: string;
  /**
   * PR-UI-C0 review fixup (@kenji msg 7885a347): true when the
   * renderer's `applyThinkingDelta` / `applyThinkingComplete` helper
   * dropped or truncated content (per-delta cap, per-session total
   * cap). `<ReasoningPanel>` renders a "已截断" pill in the header
   * when true so the user knows the visible reasoning is bounded.
   */
  thinkingTruncated?: boolean;
  /**
   * PR-UI-Cx (@kenji msg cd09bcac): true when the renderer's
   * `applyAssistantDelta` chokepoint either tail-kept a single
   * oversize delta or head-capped the per-session total. The
   * streaming bubble renders a small "已截断" affordance so the
   * user knows the visible answer is bounded.
   */
  streamingTruncated?: boolean;
  tools: ToolActivityItem[];
  activeSession?: SessionSummary;
  activeConnectionLabel?: string;
  activeModelLabel?: string;
  /** Renders a provider brand mark next to the model name in the chat tab. */
  activeProviderType?: ProviderType;
  /** Optional renderer for the provider mark; supplied by the desktop app to
   *  avoid bringing the full provider SVG library into @maka/ui. */
  renderProviderMark?(type: ProviderType): ReactNode;
  modelChoices?: ChatModelChoice[];
  onModelChange?(input: { llmConnectionSlug: string; model: string }): void | Promise<void>;
  /** Personalized user label shown on user messages. Falls back to "你". */
  userLabel?: string;
  /**
   * PR-MEMORY-VISIBILITY-INDICATOR-0 — true when the agent is reading
   * local MEMORY.md content into the system prompt this session.
   * Drives a subtle pill in the chat header so the user remembers
   * memory is in effect (kenji `19b0996f` boundary: no implicit
   * durable memory; xuan `c06e13f` MVP + yuejing PR-MEMORY-PROMPT-
   * INJECT-0 wiring).
   */
  memoryActive?: boolean;
  /** Click target for the memory pill — usually opens Settings · 记忆. */
  onOpenMemorySettings?(): void;
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
   * Visible health for the renderer's live session-event subscription.
   * Used when the stream goes stale and the desktop shell is refreshing
   * from persisted messages/session state.
   */
  eventStreamAlert?: ChatHeaderAlert;
  /** Error from loading the active session's persisted message log. */
  messageLoadError?: string;
  messageLoadRetryPending?: boolean;
  onRetryMessages?(): void;
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
  turnFailedRecoveryLabels?: Record<string, string>;
  turnLineageBadgesByTurn?: Record<string, TurnLineageBadge[]>;
  onLineageBadgeClick?: (targetTurnId: string) => void;
  skills?: SkillEntry[];
  onRefreshSkills?(): void | Promise<void>;
  onCreateSkillTemplate?(): void | Promise<void>;
  onOpenSkill?(skillId: string): void | Promise<void>;
  planReminders?: PlanReminder[];
  onCreatePlanReminder?(input: PlanReminderDraftInput): boolean | Promise<boolean> | void | Promise<void>;
  onUpdatePlanReminder?(id: string, patch: PlanReminderUpdatePatch): boolean | Promise<boolean> | void | Promise<void>;
  onTogglePlanReminder?: (id: string, enabled: boolean) => void | Promise<void>;
  onTriggerPlanReminderNow?: (id: string) => void | Promise<void>;
  onSnoozePlanReminder?: (id: string) => void | Promise<void>;
  onClearPlanReminderRunHistory?: (id: string) => void | Promise<void>;
  onDeletePlanReminder?: (id: string) => void | Promise<void>;
  dailyReviewBridge?: DailyReviewBridge;
  onCopyDailyReviewMarkdown?: (input: DailyReviewMarkdownActionInput) => Promise<void> | void;
  onAppendDailyReviewMarkdown?: (input: DailyReviewMarkdownActionInput) => Promise<void> | void;
  onSaveDailyReviewMarkdown?: (input: DailyReviewMarkdownActionInput) => Promise<void> | void;
  onSelectSession?: (sessionId: string) => void;
  /**
   * Search-result navigation target. The desktop shell owns session
   * switching and hands the matched turn id here after selection; the
   * chat view only scrolls/highlights the already-rendered turn.
   */
  scrollTargetTurn?: { turnId: string; nonce: number };
  scrollBehavior?: ScrollBehavior;
  /**
   * PR109f: when the active session is a branched session
   * (`parentSessionId` set on its summary), show a banner above the
   * chat surface so the user knows they're in a derived conversation
   * and can jump back to the parent.
   *
   * Renderer (main.tsx) resolves the parent name from the connections /
   * sessions list — @maka/ui never queries the storage layer directly.
   */
  branchBanner?: {
    parentSessionId: string;
    parentSessionName: string;
    /**
     * Set when the branch starting point was an aborted turn. UI shows
     * "从中断前分支" copy so the user understands the branch starts
     * from before the cancel point, not from the abort itself.
     */
    fromAbortedTurn?: boolean;
  };
  onBranchBannerClick?: (parentSessionId: string) => void;
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
  const [highlightedTurnId, setHighlightedTurnId] = useState<string | null>(null);
  const [pendingSkillAction, setPendingSkillAction] = useState<string | null>(null);
  const pendingSkillActionRef = useRef<string | null>(null);

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

  useEffect(() => {
    const target = props.scrollTargetTurn;
    if (!target?.turnId) return;
    const frame = window.requestAnimationFrame(() => {
      const root = scrollRef.current;
      if (!root) return;
      const el = root.querySelector(`[data-turn-id="${CSS.escape(target.turnId)}"]`);
      if (!el || !('scrollIntoView' in el)) return;
      (el as HTMLElement).scrollIntoView({
        behavior: props.scrollBehavior ?? 'smooth',
        block: 'center',
      });
      setPinnedToBottom(false);
      setHighlightedTurnId(target.turnId);
    });
    const clear = window.setTimeout(() => {
      setHighlightedTurnId((current) => (current === target.turnId ? null : current));
    }, 2200);
    return () => {
      window.cancelAnimationFrame(frame);
      window.clearTimeout(clear);
    };
  }, [props.scrollTargetTurn?.turnId, props.scrollTargetTurn?.nonce, props.scrollBehavior, props.activeSession?.id, props.messages]);

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

  async function runSkillAction(
    actionKey: string,
    action: (() => void | Promise<void>) | undefined,
  ) {
    if (!action || pendingSkillActionRef.current !== null) return;
    pendingSkillActionRef.current = actionKey;
    setPendingSkillAction(actionKey);
    try {
      await action();
    } finally {
      if (pendingSkillActionRef.current === actionKey) {
        pendingSkillActionRef.current = null;
        setPendingSkillAction(null);
      }
    }
  }

  if (props.mode === 'skills') {
    const skillActionBusy = pendingSkillAction !== null;
    return (
      <main className="maka-main detailPane maka-module-main" aria-label="技能">
        <header className="maka-module-main-header">
          <div>
            <h2>技能</h2>
            <p>管理工作区里的 Skill 指令文件。</p>
          </div>
          <button
            className="maka-button maka-button-ghost"
            type="button"
            onClick={() => void runSkillAction('refresh', props.onRefreshSkills)}
            disabled={!props.onRefreshSkills || skillActionBusy}
          >
            {pendingSkillAction === 'refresh' ? '刷新中…' : '刷新'}
          </button>
        </header>
        <SkillLibraryPanel
          skills={props.skills}
          onRefreshSkills={props.onRefreshSkills ? () => runSkillAction('refresh', props.onRefreshSkills) : undefined}
          onCreateSkillTemplate={props.onCreateSkillTemplate ? () => runSkillAction('create', props.onCreateSkillTemplate) : undefined}
          onOpenSkill={props.onOpenSkill ? (skillId) => runSkillAction(`open:${skillId}`, () => props.onOpenSkill?.(skillId)) : undefined}
          actionBusy={skillActionBusy}
          refreshPending={pendingSkillAction === 'refresh'}
          createPending={pendingSkillAction === 'create'}
          openingSkillId={pendingSkillAction?.startsWith('open:') ? pendingSkillAction.slice('open:'.length) : null}
        />
      </main>
    );
  }

  if (props.mode === 'automations') {
    return (
      <main className="maka-main detailPane maka-module-main" aria-label="计划">
        <header className="maka-module-main-header">
          <div>
            <h2>计划</h2>
            <p>创建和管理本机计划提醒。</p>
          </div>
        </header>
        <PlanReminderPanel
          reminders={props.planReminders ?? []}
          onCreate={props.onCreatePlanReminder}
          onUpdate={props.onUpdatePlanReminder}
          onToggle={props.onTogglePlanReminder}
          onTriggerNow={props.onTriggerPlanReminderNow}
          onSnooze={props.onSnoozePlanReminder}
          onClearRunHistory={props.onClearPlanReminderRunHistory}
          onDelete={props.onDeletePlanReminder}
        />
      </main>
    );
  }

  if (props.mode === 'daily-review') {
    return (
      <main className="maka-main detailPane maka-module-main" aria-label="每日回顾">
        <header className="maka-module-main-header">
          <div>
            <h2>每日回顾</h2>
            <p>查看本机对话、请求、Token、费用和工具调用汇总。</p>
          </div>
        </header>
        {props.dailyReviewBridge ? (
          <DailyReviewPanel
            bridge={props.dailyReviewBridge}
            onSelectSession={props.onSelectSession}
            onCopyMarkdown={props.onCopyDailyReviewMarkdown}
            onAppendMarkdown={props.onAppendDailyReviewMarkdown}
            onSaveMarkdown={props.onSaveDailyReviewMarkdown}
          />
        ) : (
          <EmptyState
            Icon={CalendarDays}
            title="等待连接每日回顾数据"
            body="桌面端数据桥当前未连接。"
          />
        )}
      </main>
    );
  }

  const streaming = props.streamingText.length > 0;
  const permissionModeDisabledReason = streaming
    ? '当前对话正在流式输出，等结束后再切换权限模式。'
    : props.activeSession?.status === 'running'
      ? '当前对话正在运行，等结束后再切换权限模式。'
      : props.activeSession?.status === 'waiting_for_user'
        ? '当前有工具调用正在等待确认，处理后再切换权限模式。'
        : undefined;
  const switcherDisabled = Boolean(permissionModeDisabledReason) || !props.activeSession || !props.onPermissionModeChange;
  const modelSwitcherDisabledReason = streaming
    ? '当前对话正在流式输出，等结束后再切换模型。'
    : props.activeSession?.status === 'running'
      ? '当前对话正在运行，等结束后再切换模型。'
      : props.activeSession?.status === 'waiting_for_user'
        ? '当前有工具调用正在等待确认，处理后再切换模型。'
        : undefined;

  if (!props.activeSession) {
    return (
      <main className="maka-main detailPane">
        <header className="maka-chat-header">
          <ChatTab title="新建对话" />
          <button className="maka-chat-tab-plus" type="button" aria-label="新建对话" onClick={props.onNew}>
            <Plus strokeWidth={1.5} aria-hidden="true" />
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

  const isLocalSimulationBackend = props.activeSession.backend === 'fake';
  const deepResearchActive = isDeepResearchSession(props.activeSession.labels);

  return (
    <main className="maka-main detailPane">
      <header className="maka-chat-header">
        <ChatTab
          title={props.activeSession.name}
          subtitle={props.activeModelLabel ?? props.activeConnectionLabel}
          subtitleHint={props.activeConnectionLabel && props.activeModelLabel
            ? `本会话固定模型：${props.activeConnectionLabel} · ${props.activeModelLabel}。设置里的默认模型只影响新建会话。`
            : undefined}
          providerMark={props.activeProviderType && props.renderProviderMark
            ? props.renderProviderMark(props.activeProviderType)
            : undefined}
        />
        <button className="maka-chat-tab-plus" type="button" aria-label="新建对话" onClick={props.onNew}>
          <Plus strokeWidth={1.5} aria-hidden="true" />
        </button>
        <span className="maka-chat-header-spacer" />
        <ChatModelSwitcher
          activeSession={props.activeSession}
          activeModel={props.activeModelLabel}
          choices={props.modelChoices ?? []}
          disabledReason={modelSwitcherDisabledReason}
          onChange={props.onModelChange}
        />
        {props.memoryActive && (
          <button
            type="button"
            className="maka-chat-header-memory-pill"
            data-active="true"
            onClick={() => props.onOpenMemorySettings?.()}
            title="本地 MEMORY.md 已加入 agent 系统提示。点击进入设置 · 记忆 管理。"
            aria-label="本地记忆已启用"
          >
            <BookOpen size={12} strokeWidth={1.75} aria-hidden="true" />
            <span>记忆</span>
          </button>
        )}
        {deepResearchActive && (
          <span
            className="maka-chat-header-mode-pill"
            data-mode="deep-research"
            title="深度研究会话使用只读探索边界：先阅读和分析，默认不改文件。"
            aria-label="深度研究，只读探索"
          >
            <Sparkles size={12} strokeWidth={1.75} aria-hidden="true" />
            <span>深度研究</span>
          </span>
        )}
        {props.sessionStatusBadge && <SessionStatusBadge badge={props.sessionStatusBadge} />}
        {props.connectionAlert && <ChatHeaderAlertBadge alert={props.connectionAlert} />}
        {props.eventStreamAlert && <ChatHeaderAlertBadge alert={props.eventStreamAlert} />}
        <PermissionModeSwitcher
          mode={props.activeSession.permissionMode}
          disabled={switcherDisabled}
          disabledReason={permissionModeDisabledReason}
          onChange={props.onPermissionModeChange}
        />
      </header>
      {isLocalSimulationBackend && (
        <div className="maka-fake-backend-banner" role="status">
          <AlertTriangle size={14} strokeWidth={1.75} aria-hidden="true" />
          <span>当前会话来自旧的本地模拟连接。要拿到真实 LLM 回复，请到 <strong>设置 · 模型</strong> 添加 Anthropic / OpenAI / GLM 等 API key。</span>
        </div>
      )}
      <div className="maka-chat-shell">
        {props.branchBanner && (
          <SessionBranchBanner
            banner={props.branchBanner}
            onClick={props.onBranchBannerClick}
          />
        )}
        <div ref={scrollRef} className="maka-chat messages" onScroll={onScroll}>
          {chat.length === 0 && !props.streamingText && (
            props.messageLoadError ? (
              <div role="alert" aria-busy={props.messageLoadRetryPending ? 'true' : undefined}>
                <EmptyState
                  Icon={AlertTriangle}
                  title="对话载入失败"
                  body={props.messageLoadError}
                  cta={props.onRetryMessages ? {
                    label: props.messageLoadRetryPending ? '载入中…' : '重试载入',
                    onClick: props.onRetryMessages,
                    disabled: props.messageLoadRetryPending,
                  } : undefined}
                />
              </div>
            ) : props.emptyOverride ?? (
              deepResearchActive ? (
                <DeepResearchEmptyHero onPromptSuggestion={props.onPromptSuggestion} />
              ) : (
                <EmptyChatHero onPromptSuggestion={props.onPromptSuggestion} userLabel={props.userLabel} />
              )
            )
          )}
          {turns.map((turn, idx) => {
            // PR-CHAT-NON-DEFAULT-MODEL-CHIP-0 (kenji `af77f61`
            // session-sticky merge): prefer comparing against the
            // session's sticky model when available, falling back
            // to the previous turn's modelId for older sessions
            // that pre-date the sticky-model field. Either way,
            // TurnSummary flags the chip when this turn departs
            // from the expected baseline.
            const expectedModelId =
              (props.activeSession?.model && props.activeSession.model.length > 0
                ? props.activeSession.model
                : undefined)
              ?? (() => {
                for (let i = idx - 1; i >= 0; i--) {
                  const earlier = turns[i];
                  if (earlier && earlier.modelId) return earlier.modelId;
                }
                return undefined;
              })();
            return (
              <TurnView
                key={turn.turnId}
                turn={turn}
                userLabel={props.userLabel}
                footerActions={props.turnFooterActionsByTurn?.[turn.turnId]}
                onFooterAction={(actionId) => props.onTurnFooterAction?.(turn.turnId, actionId)}
                failedReasonLabel={props.turnFailedReasonLabels?.[turn.turnId]}
                failedRecoveryLabel={props.turnFailedRecoveryLabels?.[turn.turnId]}
                lineageBadges={props.turnLineageBadgesByTurn?.[turn.turnId]}
                onLineageBadgeClick={props.onLineageBadgeClick}
                previousModelId={expectedModelId}
                searchHighlighted={highlightedTurnId === turn.turnId}
              />
            );
          })}
          {(props.streamingText || props.thinkingText) && (
            <article className="maka-message-row maka-turn-streaming message assistant streaming">
              <MessageMeta role="assistant" userLabel={props.userLabel} />
              {/* PR-UI-LAYOUT-42: Reasoning panel for Anthropic-style
               * extended thinking. Renders ABOVE the streaming
               * answer because thinking always precedes the
               * answer. Default-open during streaming so the user
               * sees the model reasoning; users can collapse it
               * if too verbose. The panel disappears entirely on
               * text_complete / abort / error (parent clears the
               * thinkingBySession entry). */}
              {props.thinkingText && (
                <ReasoningPanel
                  text={props.thinkingText}
                  live={!props.streamingText}
                  truncated={props.thinkingTruncated === true}
                />
              )}
              {props.streamingText && (
                <StreamingAssistantBubble
                  text={props.streamingText}
                  truncated={props.streamingTruncated === true}
                />
              )}
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

function ChatModelSwitcher(props: {
  activeSession: SessionSummary;
  activeModel?: string;
  choices: ChatModelChoice[];
  disabledReason?: string;
  onChange?(input: { llmConnectionSlug: string; model: string }): void | Promise<void>;
}) {
  const [pending, setPending] = useState(false);
  const pendingRef = useRef(false);
  const currentModel = props.activeModel ?? props.activeSession.model;
  const currentValue = modelChoiceValue(props.activeSession.llmConnectionSlug, currentModel);
  const disabled = pending || Boolean(props.disabledReason) || !props.onChange || props.choices.length === 0;
  const grouped = groupModelChoices(props.choices);
  const title = pending
    ? '正在切换当前会话模型…'
    : props.disabledReason ?? '切换当前会话使用的模型。设置里的默认模型只影响新建会话；这里会更新当前会话。';

  return (
    <label
      className="maka-model-switcher"
      title={title}
      data-disabled={disabled ? 'true' : undefined}
      data-pending={pending ? 'true' : undefined}
      aria-busy={pending ? 'true' : undefined}
    >
      <span className="maka-model-switcher-label">{pending ? '切换中' : '模型'}</span>
      <select
        className="maka-model-switcher-select"
        aria-label="切换当前会话模型"
        value={currentValue}
        disabled={disabled}
        onChange={(event) => {
          if (pendingRef.current) return;
          const next = parseModelChoiceValue(event.currentTarget.value);
          if (!next) return;
          if (
            next.llmConnectionSlug === props.activeSession.llmConnectionSlug &&
            next.model === currentModel
          ) {
            return;
          }
          pendingRef.current = true;
          setPending(true);
          void Promise.resolve()
            .then(() => props.onChange?.(next))
            .finally(() => {
              pendingRef.current = false;
              setPending(false);
            });
        }}
      >
        {!props.choices.some((choice) => modelChoiceValue(choice.connectionSlug, choice.model) === currentValue) && (
          <option value={currentValue}>{currentModel}</option>
        )}
        {grouped.map((group) => (
          <optgroup key={group.connectionSlug} label={group.connectionLabel}>
            {group.choices.map((choice) => (
              <option
                key={modelChoiceValue(choice.connectionSlug, choice.model)}
                value={modelChoiceValue(choice.connectionSlug, choice.model)}
              >
                {choice.label ?? choice.model}
              </option>
            ))}
          </optgroup>
        ))}
      </select>
    </label>
  );
}

function groupModelChoices(choices: ChatModelChoice[]): Array<{
  connectionSlug: string;
  connectionLabel: string;
  choices: ChatModelChoice[];
}> {
  const bySlug = new Map<string, { connectionSlug: string; connectionLabel: string; choices: ChatModelChoice[] }>();
  for (const choice of choices) {
    const group = bySlug.get(choice.connectionSlug);
    if (group) {
      group.choices.push(choice);
    } else {
      bySlug.set(choice.connectionSlug, {
        connectionSlug: choice.connectionSlug,
        connectionLabel: choice.connectionLabel,
        choices: [choice],
      });
    }
  }
  return [...bySlug.values()];
}

function modelChoiceValue(connectionSlug: string, model: string): string {
  return `${encodeURIComponent(connectionSlug)}:${encodeURIComponent(model)}`;
}

function parseModelChoiceValue(value: string): { llmConnectionSlug: string; model: string } | undefined {
  const idx = value.indexOf(':');
  if (idx <= 0) return undefined;
  try {
    const llmConnectionSlug = decodeURIComponent(value.slice(0, idx));
    const model = decodeURIComponent(value.slice(idx + 1));
    if (!llmConnectionSlug || !model) return undefined;
    return { llmConnectionSlug, model };
  } catch {
    return undefined;
  }
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
  const copyFeedback = useClipboardCopyFeedback(1400, { redact: false });
  const copyPhase = copyFeedback.phaseFor('message');
  const copyPending = copyPhase === 'pending';
  const copied = copyPhase === 'copied';

  async function copy() {
    await copyFeedback.copy('message', props.text);
  }

  const baseLabel = props.label ?? '复制消息';
  const actionLabel = copyPhase === 'pending'
    ? '复制中'
    : copyPhase === 'copied'
      ? '已复制'
      : copyPhase === 'failed'
        ? '复制失败'
        : baseLabel;
  return (
    <button
      type="button"
      className="maka-message-copy"
      onClick={() => void copy()}
      aria-label={copyPhase ? `${actionLabel} · ${baseLabel}` : baseLabel}
      aria-busy={copyPending ? 'true' : undefined}
      disabled={copyPending}
      data-copied={copied}
      data-copy-feedback={copyPhase ?? undefined}
      data-pending={copyPending ? 'true' : undefined}
      data-labelled={props.label ? 'true' : undefined}
    >
      {copied ? <Check size={14} strokeWidth={2} aria-hidden="true" /> : <Copy size={14} strokeWidth={1.75} aria-hidden="true" />}
      {props.label && <span>{copyPhase === 'pending' ? '复制中…' : copyPhase === 'failed' ? '复制失败' : copied ? '已复制' : props.label}</span>}
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
        // PR-UI-RENDER-2: route `maka://` links through the internal
        // URI parser so the assistant can drop in-app navigation
        // affordances ("用账号登录 Settings → Account"). The parser
        // is a strict allowlist; anything outside (`maka://tool/`,
        // `maka://auth/`, malformed sections) renders as a
        // non-clickable broken-link inline error. NEVER falls back
        // to `openExternal` — internal-link routing must not become
        // a hidden external-URL escape.
        a: ({ children, href, ...rest }) => (
          <MarkdownLink href={href} {...rest}>
            {children}
          </MarkdownLink>
        ),
        // Inline `code` keeps the bubble's foreground color; only block code
        // gets the framed treatment via `pre > code` in CSS.
        code: ({ children, className, ...rest }) => (
          <code {...rest} className={className}>
            {children}
          </code>
        ),
        // Wrap block code with a language pill header + copy affordance.
        // The pill is from an external design reference (40-markdown-deep §7a) — surfaces the
        // detected language so users can verify hljs got it right.
        pre: ({ children, ...rest }) => <CodeBlock {...rest}>{children}</CodeBlock>,
      }}
    >
      {props.text}
    </ReactMarkdown>
  );
}

/**
 * PR-UI-RENDER-2 — Markdown link router.
 *
 * Routes by parser result, NOT by string inspection in JSX:
 *
 *   parseMakaUri(href)
 *     ├─ MakaUriDest      → <button onClick={dispatch(dest)}>
 *     ├─ null AND isMakaUri  → broken-link inline error <span>
 *     │                        (NOT a clickable element; NOT openExternal)
 *     └─ null AND !isMakaUri → ordinary external link (Electron OS browser)
 *
 * The `MakaUriContext` provider in `main.tsx` injects the dispatcher
 * once at the App root; consumers read it via `useContext`. If a
 * Markdown island renders without a provider, valid `maka://` links
 * still get the broken-link treatment (we don't trigger uninstalled
 * navigation).
 */
function MarkdownLink(props: {
  href?: string;
  children?: ReactNode;
  [key: string]: unknown;
}) {
  const { href, children, ...rest } = props;
  const dispatch = useContext(MakaUriContext);

  // PR-UI-C2 review fixup (@kenji msg 7fb8d15c): case-insensitive
  // candidate probe so `Maka://` / `MAKA://` / `MaKa://` route to
  // the broken-link inline error rather than falling through to
  // the external `<a target=_blank>` path. `parseMakaUri` still
  // strictly accepts only lowercase `maka:`, so case-variants
  // hit the `internal-link-broken` rendering with the "内部链接
  // 无效" copy.
  if (typeof href === 'string' && isMakaUriCandidate(href)) {
    const dest = parseMakaUri(href);
    if (dest && dispatch) {
      // Valid internal link with an installed dispatcher.
      // Render as a button (not <a>) so screen readers announce
      // "button" rather than "link" — this is in-app navigation,
      // not a hyperlink to a URL.
      return (
        <button
          type="button"
          className="maka-markdown-link maka-markdown-link-internal"
          data-maka-uri-kind={dest.kind}
          onClick={() => dispatch(dest)}
        >
          {children}
        </button>
      );
    }
    // Either parseMakaUri returned null (unsupported namespace /
    // malformed section / case-variant scheme) OR no dispatcher
    // is installed. Render as a non-clickable broken-link inline
    // error. Plain `<span>` (no role) so screen readers do not
    // announce it as a link or button.
    return (
      <span
        className="maka-markdown-link maka-markdown-link-broken"
        data-reason="internal-invalid"
        title="内部链接无效"
        aria-label="内部链接无效"
      >
        {children}
      </span>
    );
  }

  // PR-UI-C2 review fixup (@kenji msg 7fb8d15c): explicit safe-
  // scheme gate on the external path. Only `http:` / `https:` /
  // `mailto:` are rendered as `<a target=_blank>`. Anything else
  // (`javascript:`, `data:`, `file:`, `vbscript:`, custom schemes,
  // garbage / unparseable hrefs) renders as a non-clickable
  // "link unsafe" inline error. Distinct copy + data-reason from
  // the internal-invalid case so visual-smoke baselines can
  // distinguish which gate fired.
  if (typeof href === 'string' && isSafeExternalScheme(href)) {
    return (
      <a {...rest} href={href} className="maka-markdown-link maka-markdown-link-external" target="_blank" rel="noreferrer noopener">
        {children}
      </a>
    );
  }
  return (
    <span
      className="maka-markdown-link maka-markdown-link-broken"
      data-reason="unsafe-scheme"
      title="链接不安全"
      aria-label="链接不安全"
    >
      {children}
    </span>
  );
}

/**
 * PR-UI-RENDER-2 — context for the internal-link dispatcher.
 *
 * The desktop renderer installs the dispatcher once at the App root
 * (see `apps/desktop/src/renderer/main.tsx`). The dispatcher takes a
 * typed `MakaUriDest` and routes to whatever real navigation surface
 * the app uses (e.g. `setNavSelection({section: 'settings', tab: ...})`
 * for `kind: 'settings'`, or `composer.prefill(text)` for `kind:
 * 'compose'`). The Markdown link renderer never invokes navigation
 * directly — that's the dispatcher's job, and the dispatcher is the
 * single chokepoint to add observability / consent prompts later.
 */
export const MakaUriContext = createContext<((dest: MakaUriDest) => void) | undefined>(undefined);

function CodeBlock({ children, ...rest }: { children?: ReactNode }) {
  // Extract the language from the inner <code class="language-xxx hljs"> if
  // there is one. react-markdown's `pre` always receives a single `code`
  // child, but downstream rehype plugins may have layered classes on it.
  const code = isElementWithClassName(children) ? children : null;
  const lang = code?.props.className?.match(/language-([A-Za-z0-9_+-]+)/)?.[1]?.toLowerCase();
  const copyFeedback = useClipboardCopyFeedback(1400, { redact: false });
  const copyPhase = copyFeedback.phaseFor('code');
  const copyPending = copyPhase === 'pending';
  const copied = copyPhase === 'copied';

  async function copy() {
    const text = collectCodeText(code?.props.children);
    await copyFeedback.copy('code', text);
  }

  return (
    <div className="maka-code-block">
      <div className="maka-code-block-header">
        <span className="maka-code-block-lang">{lang ?? 'code'}</span>
        <button
          type="button"
          className="maka-code-block-copy"
          onClick={() => void copy()}
          aria-label={copyPhase === 'pending' ? '复制代码中' : copyPhase === 'copied' ? '已复制代码' : copyPhase === 'failed' ? '复制代码失败' : '复制代码'}
          aria-busy={copyPending ? 'true' : undefined}
          disabled={copyPending}
          data-copied={copied}
          data-copy-feedback={copyPhase ?? undefined}
          data-pending={copyPending ? 'true' : undefined}
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

/**
 * Locale-aware copy bundle for the empty-chat hero. Mirrors the
 * locale split applied to `PROMPT_SUGGESTIONS_BY_LOCALE` (PR-UI-14)
 * so the eyebrow, headline, and intro paragraph don't fall back to
 * Chinese while the chips switch to English.
 *
 * PR-UI-LAYOUT-4 (@yuejing 2026-05-22): time-of-day greeting in the
 * headline, matching the reference screenshot 1 ("晚上好，安静的夜晚适合
 * 深度思考"). The greeting hook is a tiny calm touch but it makes
 * the empty-chat surface read as a welcoming space rather than a
 * generic "start typing" prompt. We bucket the local hour into four
 * windows (morning / noon / afternoon / evening) and render
 * `${greeting}{label}` if the user set a display name, otherwise
 * just the greeting + a softer fallback line.
 */
type DayPeriod = 'morning' | 'noon' | 'afternoon' | 'evening';

/**
 * PR-UI-LAYOUT-4 / B1-a1 review fixup (@kenji msg 1d7ba56c):
 * Compute the day-period bucket from a millisecond epoch timestamp,
 * not from `new Date()`. Visual-smoke fixtures freeze `Date.now()`
 * to a deterministic value (see `applyVisualSmokeFixture` in
 * `apps/desktop/src/renderer/main.tsx`) but do NOT freeze the
 * `Date` constructor itself; reading `new Date()` directly would
 * pick up the host clock and let screenshot baselines drift at the
 * 11:00 / 14:00 / 18:00 boundaries.
 *
 * Default arg is `Date.now()`, which the visual-smoke renderer
 * replaces with `state.now`. Tests pass an explicit timestamp.
 * Exported so the day-period boundary contract is reachable from
 * `apps/desktop/src/main/__tests__/empty-hero-day-period.test.ts`.
 */
export function detectDayPeriod(nowMs: number = Date.now()): DayPeriod {
  const hour = new Date(nowMs).getHours();
  if (hour < 5) return 'evening';
  if (hour < 11) return 'morning';
  if (hour < 14) return 'noon';
  if (hour < 18) return 'afternoon';
  return 'evening';
}

const EMPTY_HERO_COPY_BY_LOCALE: Record<PromptSuggestionLocale, {
  ariaLabel: string;
  eyebrow: string;
  /** Time-of-day prefix: "早上好" / "Good morning" etc. */
  greeting: Record<DayPeriod, string>;
  /** Soft contextual phrase appended when no userLabel is set
   *  (e.g. "安静的夜晚适合深度思考"). */
  greetingTail: Record<DayPeriod, string>;
  /** Compose the headline when the user has a display name. */
  headlineWithLabel: (greeting: string, label: string) => string;
  /** Compose the headline when no name (greeting + tail). */
  headlineFallback: (greeting: string, tail: string) => string;
  intro: string;
  /** PR-UI-LAYOUT-5: small discoverability hint for ⌘K command
   *  palette — analog of the reference design's "Space 可以随时唤起 AI 输入".
   *  We use ⌘K rather than Space because Cmd+K is the actual
   *  Maka shortcut and Space conflicts with normal typing in
   *  the composer. */
  paletteHint: string;
  promptListLabel: string;
}> = {
  zh: {
    ariaLabel: '开始对话',
    // PR-SIDEBAR-IA-0 Phase 3 P0 fixup v2 (kenji `08be08d8` +
    // `e2f932d7`): dropped the all-caps English prefix that read
    // inconsistently against the rest of this Chinese-first surface.
    eyebrow: '准备就绪 · 想一起做点什么？',
    greeting: {
      morning: '早上好',
      noon: '中午好',
      afternoon: '下午好',
      evening: '晚上好',
    },
    greetingTail: {
      morning: '清醒的早晨适合理清思路',
      noon: '专注的午间适合一鼓作气',
      afternoon: '舒缓的下午适合慢慢推进',
      evening: '安静的夜晚适合深度思考',
    },
    headlineWithLabel: (greeting, label) => `${greeting} ${label}，今天想做点什么？`,
    headlineFallback: (greeting, tail) => `${greeting}，${tail}。`,
    intro: '说一下你要改的、想问的、想查的；下面是几个常用起点，也可以直接在下方输入框里描述需求。',
    paletteHint: '唤起命令面板：搜索 · 设置 · 模型 · 主题 · 新对话 都在这里',
    promptListLabel: '提示建议',
  },
  en: {
    ariaLabel: 'Start a conversation',
    eyebrow: 'READY · What shall we work on?',
    greeting: {
      morning: 'Good morning',
      noon: 'Good afternoon',
      afternoon: 'Good afternoon',
      evening: 'Good evening',
    },
    greetingTail: {
      morning: 'A clear morning is good for untangling ideas',
      noon: 'A focused midday is good for a single big push',
      afternoon: 'A calm afternoon is good for steady progress',
      evening: 'A quiet evening is good for deep thinking',
    },
    headlineWithLabel: (greeting, label) => `${greeting} ${label} — what shall we tackle today?`,
    headlineFallback: (greeting, tail) => `${greeting} — ${tail}.`,
    intro: 'Describe what you want to change, ask, or look up. Here are a few common starting points — or just type in the composer below.',
    paletteHint: 'Open the command palette: search · settings · models · theme · new chat',
    promptListLabel: 'Prompt suggestions',
  },
};

function EmptyChatHero(props: { onPromptSuggestion?(prompt: string): void; userLabel?: string }) {
  // Greet the user by name when they've set one in Personalization Settings.
  // Falls back to a neutral title so first-run users don't see "Hi 你, …".
  //
  // PR-UI-1 (@yuejing 2026-05-22): visual unification with OnboardingHero
  // ReadyEmptyHero. Both heroes now use the same Sparkles-eyebrow chrome,
  // same headline scale, same chip suggestion grid — so users don't see
  // a jarring visual switch between "first-run" and "empty session" surfaces.
  //
  // PR-UI-14 (@yuejing 2026-05-22): locale-aware chips + hero copy. We
  // detect `navigator.language` once per render and use it to pick both
  // the prompt suggestion set and the surrounding copy bundle, so users
  // on en locale never see a mixed-language hero.
  const label = props.userLabel?.trim();
  const locale = detectPromptSuggestionLocale();
  const copy = EMPTY_HERO_COPY_BY_LOCALE[locale];
  const suggestions = getPromptSuggestions(locale);
  // PR-UI-LAYOUT-4: time-of-day greeting prefix. `detectDayPeriod`
  // reads the user's local clock at render time; we don't memo
  // because the hero is short-lived and React will re-render when
  // the user navigates back into it.
  const period = detectDayPeriod();
  const greeting = copy.greeting[period];
  const greetingTail = copy.greetingTail[period];
  return (
    <section className="maka-hero maka-hero-empty-chat" aria-label={copy.ariaLabel}>
      <header>
        <span className="maka-hero-eyebrow">
          <Sparkles size={12} strokeWidth={2} aria-hidden="true" />
          <span>{copy.eyebrow}</span>
        </span>
        <h1>
          {label ? copy.headlineWithLabel(greeting, label) : copy.headlineFallback(greeting, greetingTail)}
        </h1>
        <p>{copy.intro}</p>
        {/* PR-UI-LAYOUT-5b / B1-a1 review fixup (@kenji msg 708255f3):
         *   - Outer wrapper is NOT `aria-hidden` — the hint copy
         *     announces a real keyboard shortcut and command-palette
         *     entrypoint to assistive tech users; hiding it strips
         *     real navigation info from the AT tree.
         *   - Only the visual `<kbd>` glyphs are aria-hidden (their
         *     content reads noisily as "command K"); the textual hint
         *     stays in the AT tree.
         *   - `aria-keyshortcuts` lets AT users know the chord without
         *     parsing the visual `<kbd>` glyphs. */}
        <span className="maka-hero-palette-hint" aria-keyshortcuts="Meta+K">
          <kbd aria-hidden="true">⌘</kbd><kbd aria-hidden="true">K</kbd>
          <span>{copy.paletteHint}</span>
        </span>
      </header>
      {props.onPromptSuggestion && (
        <ul className="maka-prompt-suggestions" aria-label={copy.promptListLabel}>
          {suggestions.map((suggestion) => (
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
    </section>
  );
}

function DeepResearchEmptyHero(props: { onPromptSuggestion?(prompt: string): void }) {
  return (
    <section className="maka-hero maka-hero-empty-chat maka-hero-deep-research" aria-label="深度研究空会话">
      <header>
        <span className="maka-hero-eyebrow">
          <Sparkles size={12} strokeWidth={2} aria-hidden="true" />
          <span>深度研究 · 只读探索</span>
        </span>
        <h1>先把项目读透，再决定怎么改。</h1>
        <p>
          这个会话固定在只读权限：优先阅读、搜索和分析代码；需要动手实现时，先输出文件、风险和验证命令。
        </p>
      </header>
      <ol className="maka-deep-research-workflow" aria-label="深度研究流程">
        {DEEP_RESEARCH_WORKFLOW_STEPS.map((step) => (
          <li key={step.title}>
            <span className="maka-deep-research-workflow-title">{step.title}</span>
            <span className="maka-deep-research-workflow-body">{step.body}</span>
          </li>
        ))}
      </ol>
      <section className="maka-deep-research-report" aria-label="深度研究输出结构">
        <h2>输出必须能直接落地</h2>
        <ul>
          {DEEP_RESEARCH_REPORT_SECTIONS.map((section) => (
            <li key={section.title}>
              <span className="maka-deep-research-report-title">{section.title}</span>
              <span className="maka-deep-research-report-body">{section.body}</span>
            </li>
          ))}
        </ul>
      </section>
      <section className="maka-deep-research-scope" aria-label="深度研究范围">
        <h2>默认按标准深度研究</h2>
        <ul>
          {DEEP_RESEARCH_SCOPE_OPTIONS.map((option) => (
            <li key={option.label}>
              <span className="maka-deep-research-scope-label">{option.label}</span>
              <span className="maka-deep-research-scope-body">{option.body}</span>
            </li>
          ))}
        </ul>
      </section>
      <section className="maka-deep-research-evidence" aria-label="深度研究证据清单">
        <h2>每次研究都要留证据</h2>
        <ul>
          {DEEP_RESEARCH_EVIDENCE_CHECKLIST.map((item) => (
            <li key={item.title}>
              <span className="maka-deep-research-evidence-title">{item.title}</span>
              <span className="maka-deep-research-evidence-body">{item.body}</span>
            </li>
          ))}
        </ul>
      </section>
      <section className="maka-deep-research-progress" aria-label="深度研究检查点">
        <h2>多步研究要按检查点推进</h2>
        <ul>
          {DEEP_RESEARCH_PROGRESS_CHECKPOINTS.map((item) => (
            <li key={item.title}>
              <span className="maka-deep-research-progress-title">{item.title}</span>
              <span className="maka-deep-research-progress-body">{item.body}</span>
            </li>
          ))}
        </ul>
      </section>
      {props.onPromptSuggestion && (
        <ul className="maka-prompt-suggestions" aria-label="深度研究起手式">
          {DEEP_RESEARCH_STARTER_PROMPTS.map((suggestion) => (
            <li key={suggestion.label}>
              <button
                type="button"
                className="maka-prompt-chip"
                onClick={() => props.onPromptSuggestion?.(suggestion.prompt)}
              >
                <span className="maka-prompt-chip-label">{suggestion.label}</span>
                <span className="maka-prompt-chip-hint">{suggestion.prompt.slice(0, 60)}…</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
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
  const changeModeByKeyboard = (event: KeyboardEvent<HTMLDivElement>) => {
    if (props.disabled || !props.onChange) return;
    const currentIndex = PERMISSION_MODE_ORDER.indexOf(props.mode);
    if (currentIndex === -1) return;
    let nextIndex: number | null = null;
    switch (event.key) {
      case 'ArrowRight':
      case 'ArrowDown':
        nextIndex = (currentIndex + 1) % PERMISSION_MODE_ORDER.length;
        break;
      case 'ArrowLeft':
      case 'ArrowUp':
        nextIndex = (currentIndex - 1 + PERMISSION_MODE_ORDER.length) % PERMISSION_MODE_ORDER.length;
        break;
      case 'Home':
        nextIndex = 0;
        break;
      case 'End':
        nextIndex = PERMISSION_MODE_ORDER.length - 1;
        break;
      default:
        return;
    }
    event.preventDefault();
    const group = event.currentTarget;
    const nextMode = PERMISSION_MODE_ORDER[nextIndex];
    if (!nextMode || nextMode === props.mode) return;
    props.onChange(nextMode);
    requestAnimationFrame(() => {
      group
        .querySelector<HTMLButtonElement>(`[data-mode="${nextMode}"]`)
        ?.focus({ preventScroll: true });
    });
  };
  return (
    <div
      className="maka-mode-switcher"
      role="radiogroup"
      aria-label="权限模式"
      data-disabled={props.disabled || undefined}
      title={props.disabledReason ?? active.hint}
      onKeyDown={changeModeByKeyboard}
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
            data-mode={mode}
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

function createAbsoluteTimeFormat(): Intl.DateTimeFormat {
  if (typeof Intl === 'undefined' || typeof Intl.DateTimeFormat !== 'function') {
    return { format: (d: Date) => d.toISOString() } as unknown as Intl.DateTimeFormat;
  }
  return new Intl.DateTimeFormat(
    detectUiLocale() === 'en' ? 'en' : 'zh-CN',
    { dateStyle: 'medium', timeStyle: 'short' },
  );
}

function formatAbsoluteTimestamp(ts: number): string {
  return createAbsoluteTimeFormat().format(new Date(ts));
}

/**
 * PR-RELATIVE-TIME-0: a self-refreshing relative-time label. Sidebar +
 * message rows stay correct even when the window has been open for
 * hours without re-rendering on their own. The tick cadence comes from
 * `nextRelativeRefreshDelay` so we tick every second within the first
 * minute, every minute within the first hour, then every 10 minutes;
 * past the 7-day horizon we stop ticking and show the absolute date.
 */
export function RelativeTime(props: { ts: number; className?: string; suppressTitle?: boolean }) {
  const [, setTick] = useState(0);
  useEffect(() => {
    const delay = nextRelativeRefreshDelay(props.ts);
    if (delay === null) return;
    const id = setTimeout(() => setTick((n) => n + 1), delay);
    return () => clearTimeout(id);
  });
  return (
    <small
      className={props.className ?? 'maka-message-time'}
      aria-hidden="true"
      title={props.suppressTitle ? undefined : formatAbsoluteTimestamp(props.ts)}
    >
      {formatRelativeTimestamp(props.ts)}
    </small>
  );
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
 * Chinese userLabel like "用户" → "用", an emoji name like "🦊 fox" → "🦊".
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
function TurnSummary(props: { turn: TurnViewModel; previousModelId?: string }) {
  const { turn } = props;
  const hasModel = Boolean(turn.modelId);
  // PR-CHAT-NON-DEFAULT-MODEL-CHIP-0: per-turn override is allowed
  // but must be visible (kenji 3-way decision lock 7749c411).
  // When the prior turn used a different model, mark this turn's
  // model chip with a "切换" pill so the user notices.
  const modelSwitched =
    hasModel
    && typeof props.previousModelId === 'string'
    && props.previousModelId.length > 0
    && props.previousModelId !== turn.modelId;
  const hasTools = turn.tools.length > 0;
  // Show duration only when the assistant has actually landed (durationMs
  // is computed from assistant.ts). For in-progress turns we render an
  // "进行中" pill instead of a number that would tick up forever — per
  // @kenji's PR82 review.
  const hasDuration = turn.durationMs !== undefined && turn.durationMs > 0;
  const inProgress = turn.status === 'running' && turn.user !== undefined && turn.assistant === undefined;
  const hasTokens = Boolean(turn.tokens && (turn.tokens.input > 0 || turn.tokens.output > 0));
  // costUsd is only meaningful when present AND > 0 — never fabricate a
  // "$0.00" hover, that reads as false precision (also @kenji PR82 review).
  const hasCost = turn.tokens?.costUsd !== undefined && turn.tokens.costUsd > 0;
  if (!hasModel && !hasTools && !hasDuration && !hasTokens && !inProgress) return null;
  return (
    <div className="maka-turn-summary" aria-label="本轮对话摘要">
      {hasModel && (
        <span
          className="maka-turn-summary-chip"
          data-kind="model"
          data-switched={modelSwitched ? 'true' : undefined}
          title={
            modelSwitched
              ? `本轮使用 ${turn.modelId}，session 期望 ${props.previousModelId}`
              : turn.modelId
          }
        >
          <code>{turn.modelId}</code>
          {modelSwitched && (
            <span className="maka-turn-summary-chip-switched" aria-label="本轮切换了模型">
              切换
            </span>
          )}
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
   * PR-PawWork-run-incident-lite: pre-derived recovery guidance for a failed
   * turn. Caller computes this from error class, retained partial output, and
   * tool activity so the banner can distinguish "retry" from "inspect tool
   * output first".
   */
  failedRecoveryLabel?: string;
  /**
   * PR109e-e: forward + reverse lineage badges. The renderer
   * computes the labels (with short turn ids) and click targets;
   * @maka/ui just renders the badge UI.
   */
  lineageBadges?: TurnLineageBadge[];
  /** PR109e-e: invoked when the user clicks a lineage badge. The
   *  renderer scrolls the target turn into view. */
  onLineageBadgeClick?: (targetTurnId: string) => void;
  /**
   * PR-CHAT-NON-DEFAULT-MODEL-CHIP-0: the most-recent prior turn's
   * assistant modelId, used by TurnSummary to flag a per-turn
   * model switch (kenji `7749c411` lock decision: per-turn override
   * is allowed but MUST be visible).
   */
  previousModelId?: string;
  /** True when a search result just navigated to this turn. */
  searchHighlighted?: boolean;
}) {
  const { turn } = props;
  const forwardBadges = props.lineageBadges?.filter((b) => b.direction === 'forward') ?? [];
  const reverseBadges = props.lineageBadges?.filter((b) => b.direction === 'reverse') ?? [];
  return (
    <section
      className="maka-turn"
      data-turn-id={turn.turnId}
      data-search-highlight={props.searchHighlighted ? 'true' : undefined}
    >
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
      <TurnSummary turn={turn} previousModelId={props.previousModelId} />

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
                <em>{turnAbortMarkerLabel(turn.abortSource)}</em>
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
                {props.failedRecoveryLabel && (
                  <span className="maka-turn-failed-recovery">{props.failedRecoveryLabel}</span>
                )}
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
 * Branched session banner (PR109f). Surfaces above the chat surface
 * when the active session has `parentSessionId` set. Click jumps the
 * user back to the parent session.
 */
function SessionBranchBanner(props: {
  banner: {
    parentSessionId: string;
    parentSessionName: string;
    fromAbortedTurn?: boolean;
  };
  onClick?: (parentSessionId: string) => void;
}) {
  const { banner } = props;
  return (
    <button
      type="button"
      className="maka-session-branch-banner"
      data-from-aborted={banner.fromAbortedTurn || undefined}
      onClick={() => props.onClick?.(banner.parentSessionId)}
      aria-label={banner.fromAbortedTurn
        ? `从中断前分支自 ${banner.parentSessionName} · 点击跳回原会话`
        : `分自 ${banner.parentSessionName} · 点击跳回原会话`}
    >
      <GitBranch size={12} strokeWidth={2} aria-hidden="true" />
      <span>
        {banner.fromAbortedTurn
          ? `从中断前分支自 ${banner.parentSessionName}`
          : `分自 ${banner.parentSessionName}`}
      </span>
    </button>
  );
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

function turnAbortMarkerLabel(abortSource: string | undefined) {
  switch (abortSource) {
    case 'renderer.stop_button': return '(已中断 · 由停止按钮触发)';
    default: return '(已中断)';
  }
}

type ClipboardCopyPhase = 'pending' | 'copied' | 'failed';

function useClipboardCopyFeedback(resetDelay = 1400, options: { redact?: boolean } = {}) {
  const [copyState, setCopyState] = useState<{ key: string; phase: ClipboardCopyPhase } | null>(null);
  const pendingCopyRef = useRef<string | null>(null);
  const resetTimerRef = useRef<number | null>(null);

  function clearResetTimer() {
    if (resetTimerRef.current === null) return;
    window.clearTimeout(resetTimerRef.current);
    resetTimerRef.current = null;
  }

  useEffect(() => clearResetTimer, []);

  function settle(key: string, phase: Exclude<ClipboardCopyPhase, 'pending'>) {
    setCopyState({ key, phase });
    resetTimerRef.current = window.setTimeout(() => {
      setCopyState((current) => current?.key === key ? null : current);
      resetTimerRef.current = null;
    }, resetDelay);
  }

  async function copy(key: string, text: string) {
    if (text.length === 0 || pendingCopyRef.current) return;
    pendingCopyRef.current = key;
    clearResetTimer();
    setCopyState({ key, phase: 'pending' });
    try {
      await navigator.clipboard.writeText(options.redact === false ? text : redactSecrets(text));
      settle(key, 'copied');
    } catch {
      settle(key, 'failed');
    } finally {
      pendingCopyRef.current = null;
    }
  }

  function phaseFor(key: string): ClipboardCopyPhase | null {
    return copyState?.key === key ? copyState.phase : null;
  }

  return { copy, phaseFor, isPending: copyState?.phase === 'pending' };
}

function TurnFooterActions(props: {
  actions: ReadonlyArray<TurnFooterActionMeta>;
  onAction?: (actionId: TurnFooterActionMeta['id']) => void;
  /** Assistant text used by the inline copy action. */
  assistantText?: string;
}) {
  const [copyPhase, setCopyPhase] = useState<ClipboardCopyPhase | null>(null);
  const copyPendingRef = useRef(false);
  const copyResetTimerRef = useRef<number | null>(null);
  const copyMountedRef = useRef(true);

  function clearCopyResetTimer() {
    if (copyResetTimerRef.current === null) return;
    window.clearTimeout(copyResetTimerRef.current);
    copyResetTimerRef.current = null;
  }

  useEffect(() => () => {
    copyMountedRef.current = false;
    clearCopyResetTimer();
  }, []);

  function settleCopy(phase: Exclude<ClipboardCopyPhase, 'pending'>) {
    if (!copyMountedRef.current) return;
    setCopyPhase(phase);
    copyResetTimerRef.current = window.setTimeout(() => {
      if (!copyMountedRef.current) return;
      setCopyPhase(null);
      copyResetTimerRef.current = null;
    }, 1400);
  }

  async function copyAssistantText() {
    if (!props.assistantText || copyPendingRef.current) return;
    copyPendingRef.current = true;
    clearCopyResetTimer();
    setCopyPhase('pending');
    try {
      await navigator.clipboard.writeText(props.assistantText);
      settleCopy('copied');
    } catch {
      settleCopy('failed');
    } finally {
      copyPendingRef.current = false;
    }
  }

  async function handleClick(action: TurnFooterActionMeta) {
    if (!action.enabled) return;
    if (action.id === 'copy') {
      await copyAssistantText();
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
        // PR-UI-17 (@yuejing 2026-05-22): action priority is presentation
        // only — has NO bearing on the lifecycle/status semantics encoded
        // by `deriveTurnFooterActions`. Pending state always forces
        // priority back to "primary" so the user sees full label + icon
        // while the action processes.
        const isCopyAction = action.id === 'copy';
        const copyIsPending = isCopyAction && copyPhase === 'pending';
        const copyFeedbackLabel = copyPhase === 'pending'
          ? '复制中…'
          : copyPhase === 'copied'
            ? '已复制'
            : copyPhase === 'failed'
              ? '复制失败'
              : action.label;
        const isActionPending = isPending || copyIsPending;
        const priority = isActionPending ? 'primary' : STATUS_FOOTER_PRIORITY[action.id];
        return (
          <button
            key={action.id}
            type="button"
            className="maka-turn-footer-action"
            data-action={action.id}
            data-priority={priority}
            data-pending={isActionPending || undefined}
            data-copy-feedback={isCopyAction && copyPhase ? copyPhase : undefined}
            disabled={!action.enabled || copyIsPending}
            aria-disabled={!action.enabled || copyIsPending}
            aria-busy={isActionPending || undefined}
            title={action.tooltip ?? action.label}
            onClick={() => void handleClick(action)}
          >
            {isCopyAction && copyPhase === 'copied' ? <Check size={12} strokeWidth={2} aria-hidden="true" /> : STATUS_FOOTER_ICON[action.id]}
            <span>{isCopyAction ? copyFeedbackLabel : action.label}</span>
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

/**
 * PR-UI-17 (audit §3.4): action priority controls visual density —
 * `primary` actions render with full icon+label always; `secondary`
 * actions render icon-only by default with a hover/focus-within
 * expansion that reveals the label. This addresses the noise complaint
 * "重试 + 重新生成 + 分支 + 复制 buttons accumulate visually when
 * combined with lineage badges + status pills" without dropping any
 * functionality or changing the lifecycle semantics encoded by
 * `deriveTurnFooterActions`. The action label is always present in
 * the DOM (aria + visually-hidden when collapsed) so screen readers
 * read it identically regardless of presentation state.
 */
const STATUS_FOOTER_PRIORITY: Record<TurnFooterActionMeta['id'], 'primary' | 'secondary'> = {
  retry: 'primary',
  regenerate: 'primary',
  branch: 'secondary',
  copy: 'secondary',
};

/**
 * PR-UI-LAYOUT-42 — ReasoningPanel: collapsible "thinking" panel for
 * Anthropic-style extended thinking. Renders the live
 * `ThinkingDeltaEvent.text` (or final `ThinkingCompleteEvent.text`)
 * accumulated by the renderer in `thinkingBySession`.
 *
 * Default-open during streaming so the user sees the live reasoning;
 * collapses to a single-line summary if user clicks the header. The
 * panel itself is wrapped in a `<details>` for native keyboard a11y
 * (Space/Enter toggles).
 *
 * `live=true` means thinking is still streaming (no text yet). Adds
 * a small pulse dot in the header so users see motion.
 *
 * The text inside is rendered as `<pre>` so the model's
 * step-by-step reasoning preserves indentation / line breaks. We
 * don't pipe through Markdown — thinking is usually plain prose +
 * occasional code, and full markdown would slow the streaming.
 */
/**
 * PR-UI-RENDER-1 — streaming assistant bubble.
 *
 * Wraps the live `streamingText` in `useSmoothStreamContent` so the
 * visible text grows at the EMA-tracked arrival CPS instead of
 * lurching with each network chunk. The bubble itself unmounts on
 * `text_complete` / abort / error (parent clears `streamingText`), so
 * the smoother only has to handle the live phase — settled history
 * messages render via the regular Markdown path with no smoothing.
 *
 * `streaming=true` while this component is mounted: by construction
 * the parent only renders it when the stream is in progress.
 */
function StreamingAssistantBubble(props: { text: string; truncated?: boolean }) {
  // PR-UI-C1 review fixup (@kenji msg fbb8f119): the smoother
  // typewriters PREFIXES of its input string. If the raw text
  // contains a mid-delta secret like `Authorization: Bearer sk-...`,
  // prefixes such as `Authorization: Bearer s` don't match any
  // redaction pattern by themselves and would leak to the DOM for
  // a frame or two before the downstream Markdown redactor sees
  // the full token. `prepareSmoothStreamText` runs `redactSecrets`
  // on the FULL raw text BEFORE the smoother sees it, so every
  // displayed prefix is guaranteed secret-free.
  //
  // PR-UI-Cx (@kenji msg cd09bcac): `props.text` is already the
  // post-redaction post-cap output of `applyAssistantDelta` (parent
  // ran the chokepoint inside `setStreamingBySession` updater),
  // so the smoother only sees safe text. `prepareSmoothStreamText`
  // here is defense-in-depth — `redactSecrets` is idempotent on
  // already-masked text, and the gate guarantees the smoother
  // contract holds even if a future caller forgets the chokepoint.
  const snap = useStreamSnap();
  const safeText = prepareSmoothStreamText(props.text);
  const { displayed } = useSmoothStreamContent(safeText, {
    streaming: true,
    snap,
  });
  return (
    <div className="maka-bubble-assistant maka-bubble-streaming">
      <Markdown text={displayed} />
      {props.truncated && (
        <div
          className="maka-bubble-truncated"
          role="status"
          aria-live="polite"
          title="助手输出已超过单次回合上限，超出部分未渲染。如需完整内容请重新生成或查看持久化的会话日志。"
        >
          已截断
        </div>
      )}
    </div>
  );
}

function ReasoningPanel(props: { text: string; live: boolean; truncated: boolean }) {
  // PR-UI-RENDER-1 + PR-UI-C0: smooth-stream the thinking text on top
  // of the C0 redaction/cap chokepoint. `props.text` is the already-
  // redacted-and-capped buffer (renderer ran it through
  // `applyThinkingDelta` / `applyThinkingComplete` before passing
  // here), so the smoother is purely a visual frame-pacing layer.
  //
  // C1 review fixup (@kenji msg fbb8f119) — defense in depth: even
  // though C0 already redacted, we run `prepareSmoothStreamText`
  // again before the smoother. `redactSecrets` is idempotent on
  // already-masked text, and the gate guarantees the smoother
  // contract ("smoother never sees raw secrets") holds even if a
  // future change accidentally bypasses the C0 chokepoint.
  //
  // `live=true` means thinking is still flowing (no answer yet) →
  // streaming=true so the smoother typewriters. `live=false` means
  // `thinking_complete` already fired (caller passes a settled blob)
  // → streaming=false, hook snaps. Reduced-motion / visual-smoke
  // also forces snap so deterministic capture sees the final text
  // immediately.
  const snap = useStreamSnap();
  const safeText = prepareSmoothStreamText(props.text);
  const { displayed } = useSmoothStreamContent(safeText, {
    streaming: props.live,
    snap,
  });
  // PR-UI-RENDER-1 @kenji review concern #4 — explicitly controlled
  // open state. With a raw `open` JSX attribute, React's reconciler
  // could re-assert the open state and undo the user's manual collapse
  // on the next stream-driven re-render (the smoother re-renders at
  // ~60Hz while the stream is live, so any reconciliation drift is
  // immediately visible to the user). Owning the open state via
  // useState + onToggle makes the panel uncontrolled-from-React's-view:
  // the user's collapse sticks because we only write `open` from our
  // own state, which we only mutate from the onToggle callback.
  // Default-open at mount so users see the reasoning by default; first
  // click toggles to closed and that sticks.
  const [open, setOpen] = useState(true);
  return (
    <details
      className="maka-reasoning-panel"
      data-live={props.live ? 'true' : undefined}
      open={open}
      onToggle={(e) => setOpen((e.currentTarget as HTMLDetailsElement).open)}
    >
      <summary className="maka-reasoning-panel-header">
        {props.live && <span className="maka-reasoning-panel-dot" aria-hidden="true" />}
        <span className="maka-reasoning-panel-label">
          {props.live ? '正在思考…' : '思考过程'}
        </span>
        {/* PR-UI-C0 review fixup (@kenji msg 7885a347): "已截断" pill
            fires when `applyThinkingDelta` / `applyThinkingComplete`
            dropped content (per-delta cap or per-session total cap).
            Same chrome family as the A3 tool-output truncated pill. */}
        {props.truncated && (
          <span
            className="maka-reasoning-panel-truncated"
            data-truncated="true"
            title="部分 reasoning 已截断；显示的是最近的内容"
          >
            已截断
          </span>
        )}
        <span className="maka-reasoning-panel-chevron" aria-hidden="true">›</span>
      </summary>
      <pre className="maka-reasoning-panel-body">{displayed}</pre>
    </details>
  );
}

/**
 * PR-UI-RENDER-1 — reduced-motion / visual-smoke probe for the
 * streaming smoother.
 *
 * Three triggers force the smoother to snap (mirroring the rule in
 * `apps/desktop/src/renderer/scroll-motion-policy.ts`):
 *
 *   1. `data-maka-reduced-motion="true"` — set by the PR-IR-04
 *      reduced variant of the visual-smoke fixture.
 *   2. `data-maka-visual-smoke="true"` — set by ANY visual-smoke
 *      capture so screenshots see the final text on the first paint.
 *   3. OS-level `prefers-reduced-motion: reduce`.
 *
 * The hook reads the dataset attributes once on mount (they're set
 * pre-React in main.tsx and don't toggle during a session) but
 * subscribes to `matchMedia` for the OS preference so a mid-session
 * toggle reaches the running stream.
 */
function useStreamSnap(): boolean {
  const [snap, setSnap] = useState(() => readStreamSnap());
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    const onChange = () => setSnap(readStreamSnap());
    // Initial read (in case dataset attrs landed after first paint).
    setSnap(readStreamSnap());
    if (typeof mq.addEventListener === 'function') {
      mq.addEventListener('change', onChange);
      return () => mq.removeEventListener('change', onChange);
    }
    return undefined;
  }, []);
  return snap;
}

function readStreamSnap(): boolean {
  if (typeof document === 'undefined' || typeof window === 'undefined') return true;
  const root = document.documentElement;
  if (root.dataset.makaReducedMotion === 'true') return true;
  if (root.dataset.makaVisualSmoke === 'true') return true;
  if (typeof window.matchMedia === 'function') {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  }
  return false;
}

function MessageMeta(props: { role: string; userLabel?: string; ts?: number }) {
  const label = messageRoleLabel(props.role, props.userLabel);
  const initial = props.role === 'assistant' ? 'M' : avatarInitial(label);
  // PR-CHAT-META-POLISH-0 (kenji `bd58fcb6`): when the user has no
  // configured displayName, both `avatarInitial` and
  // `messageRoleLabel` fall back to `'你'`, producing the visual
  // duplicate `你 你`. Suppress the text name in this case — the
  // avatar carries the role signal on its own, and screen readers
  // still get the label via `aria-label` on the row. For assistant
  // (`M` + `Maka`) and for users with a real displayName
  // (`JK` + `Jakevin`) we keep both because they aren't redundant.
  const isAnonymousUser = props.role === 'user' && (!props.userLabel || !props.userLabel.trim());
  return (
    <span className="maka-message-meta" aria-label={label}>
      <span className="maka-message-avatar" data-role={props.role} aria-hidden="true">
        {initial}
      </span>
      {!isAnonymousUser && <span className="maka-message-name">{label}</span>}
      {props.ts !== undefined && <RelativeTime ts={props.ts} />}
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

/**
 * PR-UI-15 (@yuejing 2026-05-22): Composer copy is locale-aware.
 *
 * Audit §3.5 — placeholder + state copy were hardcoded zh and drifted
 * stylistically from OnboardingHero's quickChat input (which used a
 * long example sentence as the placeholder). Unified style: both
 * surfaces show the same short action-oriented placeholder, and
 * OnboardingHero gets a separate `<small>` example hint below the
 * textarea so first-run users still know what to type.
 */
const COMPOSER_COPY_BY_LOCALE: Record<UiLocale, {
  placeholder: string;
  textareaAriaLabel: string;
  awaitingPermission: string;
  sending: string;
  streamingHintPrefix: string;
  streamingHintInterrupt: string;
}> = {
  zh: {
    placeholder: '给 Maka 发消息…',
    textareaAriaLabel: '消息输入框',
    awaitingPermission: '等待你确认权限…',
    sending: '正在发送…',
    // PR-UX-POLISH-1 (yuejing UX audit msg `9c779b56`): composer streaming
    // hint now reads `正在回答` so it doesn't conflict with the
    // ReasoningPanel's `正在思考` (which displays the model's actual
    // extended-thinking stream). Composer = output-streaming;
    // ReasoningPanel = reasoning-streaming; distinct signals, distinct copy.
    streamingHintPrefix: 'Maka 正在回答…',
    streamingHintInterrupt: '或点停止中断',
  },
  en: {
    placeholder: 'Message Maka…',
    textareaAriaLabel: 'Message input',
    awaitingPermission: 'Waiting for your permission decision…',
    sending: 'Sending…',
    // PR-UX-POLISH-1: parallel en-locale fix — `is responding` instead of
    // `is thinking`, so it doesn't collide with the ReasoningPanel's
    // `Thinking…` label.
    streamingHintPrefix: 'Maka is responding…',
    streamingHintInterrupt: 'or click Stop to interrupt',
  },
};

const COMPOSER_BUTTON_COPY_BY_LOCALE: Record<UiLocale, { sendLabel: string; stopLabel: string }> = {
  zh: { sendLabel: '发送', stopLabel: '停止' },
  en: { sendLabel: 'Send', stopLabel: 'Stop' },
};

export interface ComposerHandle {
  /** Replace the textarea value and resize, leaving focus on the input. */
  setText(text: string): void;
  /** Append a prompt/context fragment after the existing draft instead of replacing it. */
  appendText(text: string): void;
  /** Move focus to the textarea without changing its content. */
  focus(): void;
}

export function appendPromptContextDraft(current: string, fragment: string): string {
  const base = current.trimEnd();
  const next = fragment.trim();
  if (!base) return next;
  if (!next) return base;
  return `${base}\n\n${next}`;
}

const COMPOSER_DRAFT_MAX_CHARS = 120_000;
const COMPOSER_DRAFT_MAX_ENTRIES = 32;
const COMPOSER_HISTORY_MAX_ENTRIES = 50;

export function rememberComposerDraft(store: Map<string, string>, key: string | undefined, value: string): void {
  if (!key) return;
  const trimmed = value.trim();
  if (!trimmed) {
    store.delete(key);
    return;
  }

  const bounded = value.length > COMPOSER_DRAFT_MAX_CHARS
    ? value.slice(value.length - COMPOSER_DRAFT_MAX_CHARS)
    : value;
  store.delete(key);
  store.set(key, bounded);

  while (store.size > COMPOSER_DRAFT_MAX_ENTRIES) {
    const oldest = store.keys().next().value;
    if (typeof oldest !== 'string') break;
    if (oldest === key && store.size === 1) break;
    store.delete(oldest);
  }
}

export function readComposerDraft(store: Map<string, string>, key: string | undefined): string {
  if (!key) return '';
  return store.get(key) ?? '';
}

export interface ComposerHistoryState {
  entries: string[];
  index: number;
  savedDraft: string;
}

export function rememberComposerHistoryEntry(entries: string[], text: string): string[] {
  const trimmed = text.trim();
  if (!trimmed) return entries;
  const next = entries.filter((entry) => entry !== trimmed);
  next.push(trimmed);
  if (next.length > COMPOSER_HISTORY_MAX_ENTRIES) {
    return next.slice(next.length - COMPOSER_HISTORY_MAX_ENTRIES);
  }
  return next;
}

export function navigateComposerHistory(
  state: ComposerHistoryState,
  direction: 'previous' | 'next',
  currentValue: string,
): { state: ComposerHistoryState; value: string; changed: boolean } {
  if (state.entries.length === 0) return { state, value: currentValue, changed: false };

  if (direction === 'previous') {
    const savedDraft = state.index < 0 ? currentValue : state.savedDraft;
    const index = state.index < 0
      ? state.entries.length - 1
      : Math.max(0, state.index - 1);
    return {
      state: { entries: state.entries, index, savedDraft },
      value: state.entries[index] ?? currentValue,
      changed: true,
    };
  }

  if (state.index < 0) return { state, value: currentValue, changed: false };
  const index = state.index + 1;
  if (index >= state.entries.length) {
    return {
      state: { entries: state.entries, index: -1, savedDraft: '' },
      value: state.savedDraft,
      changed: true,
    };
  }
  return {
    state: { entries: state.entries, index, savedDraft: state.savedDraft },
    value: state.entries[index] ?? currentValue,
    changed: true,
  };
}

export const Composer = forwardRef<
  ComposerHandle,
  {
    disabled?: boolean;
    hidden?: boolean;
    /**
     * When true, the assistant is currently streaming a response.
     * Toolbar swaps to a "Maka 正在回答…" hint and the Stop button is
     * the only visible action — Send is hidden because the model is busy.
     */
    streaming?: boolean;
    /** Runtime-only key used to keep unsent drafts isolated per session. */
    draftKey?: string;
    onSend(text: string): boolean | void | Promise<boolean | void>;
    onStop(): void;
    onImportTextFile?(): void;
    onImportFolderOutline?(): void;
    onImportDroppedTextFiles?(files: File[]): void | Promise<void>;
  }
>(function Composer(props, ref) {
  const formRef = useRef<HTMLFormElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [dragActive, setDragActive] = useState(false);
  const [sendPending, setSendPending] = useState(false);
  const [hasDraftText, setHasDraftText] = useState(false);
  const draftStoreRef = useRef<Map<string, string>>(new Map());
  const activeDraftKeyRef = useRef<string | undefined>(props.draftKey);
  const sendPendingRef = useRef(false);
  const promptHistoryRef = useRef<ComposerHistoryState>({ entries: [], index: -1, savedDraft: '' });
  // PR-UI-15: locale-aware copy for placeholder + toolbar states. We
  // detect once per render (cheap) rather than memoizing — the locale
  // is effectively constant for the lifetime of the renderer but the
  // few ns of detection cost beats wiring up a context provider just
  // for this bundle.
  const locale = detectUiLocale();
  const copy = COMPOSER_COPY_BY_LOCALE[locale];
  const buttonCopy = COMPOSER_BUTTON_COPY_BY_LOCALE[locale];

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

  function saveCurrentDraft(value?: string) {
    const nextValue = value ?? textareaRef.current?.value ?? '';
    rememberComposerDraft(draftStoreRef.current, activeDraftKeyRef.current, nextValue);
    setHasDraftText(Boolean(nextValue.trim()));
  }

  function resetPromptHistoryNavigation() {
    promptHistoryRef.current = {
      entries: promptHistoryRef.current.entries,
      index: -1,
      savedDraft: '',
    };
  }

  useEffect(() => {
    const el = textareaRef.current;
    const previousKey = activeDraftKeyRef.current;
    const nextKey = props.draftKey;

    if (previousKey !== nextKey) {
      rememberComposerDraft(draftStoreRef.current, previousKey, el?.value ?? '');
      activeDraftKeyRef.current = nextKey;
      resetPromptHistoryNavigation();
      if (el) {
        const nextDraft = readComposerDraft(draftStoreRef.current, nextKey);
        el.value = nextDraft;
        setHasDraftText(Boolean(nextDraft.trim()));
        autoResize();
        const length = el.value.length;
        el.setSelectionRange(length, length);
      }
    }
  }, [props.draftKey]);

  useImperativeHandle(
    ref,
    () => ({
      setText(text: string) {
        const el = textareaRef.current;
        if (!el) return;
        resetPromptHistoryNavigation();
        el.value = text;
        saveCurrentDraft(text);
        autoResize();
        el.focus();
        // Move caret to end so the user can keep typing.
        const length = el.value.length;
        el.setSelectionRange(length, length);
      },
      appendText(text: string) {
        const el = textareaRef.current;
        if (!el) return;
        resetPromptHistoryNavigation();
        el.value = appendPromptContextDraft(el.value, text);
        saveCurrentDraft(el.value);
        autoResize();
        el.focus();
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
    if (props.disabled || sendPendingRef.current) return;
    const textarea = textareaRef.current;
    const form = formRef.current;
    const text = (textarea?.value ?? '').trim();
    if (!text) return;
    const submittedDraftKey = activeDraftKeyRef.current;
    sendPendingRef.current = true;
    setSendPending(true);
    let sent: boolean | void;
    try {
      sent = await props.onSend(text);
    } finally {
      sendPendingRef.current = false;
      setSendPending(false);
    }
    if (sent === false) return;
    promptHistoryRef.current = {
      entries: rememberComposerHistoryEntry(promptHistoryRef.current.entries, text),
      index: -1,
      savedDraft: '',
    };
    rememberComposerDraft(draftStoreRef.current, submittedDraftKey, '');
    saveCurrentDraft('');
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
    // Esc while a drag-active highlight is showing should clear it
    // immediately. The existing useEffect listens for blur/dragend/drop
    // but not keydown, so a user who hits Esc to cancel a stuck drag
    // gesture would otherwise see the highlight linger until they
    // blurred the window or completed a real drop somewhere.
    if (event.key === 'Escape' && dragActive) {
      setDragActive(false);
    }
    // Esc during streaming interrupts the model. We don't preventDefault
    // unconditionally so Esc still works to close modals when the composer
    // happens to be focused outside a streaming turn.
    if (event.key === 'Escape' && props.streaming) {
      event.preventDefault();
      props.onStop();
      return;
    }
    if ((event.key === 'ArrowUp' || event.key === 'ArrowDown') && !event.shiftKey && !event.altKey && !event.metaKey && !event.ctrlKey) {
      const el = textareaRef.current;
      const isNavigatingHistory = promptHistoryRef.current.index >= 0;
      const canStartHistory = Boolean(el && !el.value.trim());
      if (el && (isNavigatingHistory || canStartHistory)) {
        const next = navigateComposerHistory(
          promptHistoryRef.current,
          event.key === 'ArrowUp' ? 'previous' : 'next',
          el.value,
        );
        if (next.changed) {
          event.preventDefault();
          promptHistoryRef.current = next.state;
          el.value = next.value;
          saveCurrentDraft(next.value);
          autoResize();
          const length = el.value.length;
          el.setSelectionRange(length, length);
          return;
        }
      }
    }
    if (event.key !== 'Enter') return;
    if (event.shiftKey || event.altKey) return; // Shift+Enter / Alt+Enter inserts a newline.
    event.preventDefault();
    void sendCurrent();
  }

  function onTextareaInput() {
    resetPromptHistoryNavigation();
    autoResize();
    saveCurrentDraft();
  }

  function canAcceptDroppedTextFiles(): boolean {
    return Boolean(props.onImportDroppedTextFiles && !props.disabled && !props.streaming);
  }

  function hasDraggedFiles(event: DragEvent<HTMLFormElement>): boolean {
    return Array.from(event.dataTransfer.types).includes('Files');
  }

  function hasPastedFiles(event: ClipboardEvent<HTMLTextAreaElement>): boolean {
    return Array.from(event.clipboardData.types).includes('Files') || event.clipboardData.files.length > 0;
  }

  function onComposerDragOver(event: DragEvent<HTMLFormElement>) {
    if (!canAcceptDroppedTextFiles() || !hasDraggedFiles(event)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
    setDragActive(true);
  }

  function onComposerDragLeave(event: DragEvent<HTMLFormElement>) {
    if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
    setDragActive(false);
  }

  function onComposerDrop(event: DragEvent<HTMLFormElement>) {
    if (!hasDraggedFiles(event)) return;
    event.preventDefault();
    setDragActive(false);
    if (!canAcceptDroppedTextFiles()) return;
    const files = Array.from(event.dataTransfer.files);
    if (files.length === 0) return;
    void props.onImportDroppedTextFiles?.(files);
  }

  function onTextareaPaste(event: ClipboardEvent<HTMLTextAreaElement>) {
    if (!hasPastedFiles(event)) return;
    if (!canAcceptDroppedTextFiles()) return;
    const files = Array.from(event.clipboardData.files);
    if (files.length === 0) return;
    event.preventDefault();
    void props.onImportDroppedTextFiles?.(files);
  }

  useEffect(() => {
    if (!dragActive) return undefined;
    const clearDragActive = () => setDragActive(false);
    window.addEventListener('blur', clearDragActive);
    window.addEventListener('dragend', clearDragActive);
    window.addEventListener('drop', clearDragActive);
    return () => {
      window.removeEventListener('blur', clearDragActive);
      window.removeEventListener('dragend', clearDragActive);
      window.removeEventListener('drop', clearDragActive);
    };
  }, [dragActive]);

  if (props.hidden) return null;
  const sendDisabled = props.disabled || sendPending || !hasDraftText;

  return (
    <form
      ref={formRef}
      className="maka-composer composer"
      data-drag-active={dragActive ? 'true' : undefined}
      onDragOver={onComposerDragOver}
      onDragLeave={onComposerDragLeave}
      onDrop={onComposerDrop}
      onSubmit={submit}
    >
      <div className="maka-composer-inner composerInner">
        <textarea
          ref={textareaRef}
          name="text"
          placeholder={copy.placeholder}
          aria-label={copy.textareaAriaLabel}
          disabled={props.disabled}
          onKeyDown={onTextareaKeyDown}
          onPaste={onTextareaPaste}
          onInput={onTextareaInput}
          rows={1}
          autoComplete="off"
          spellCheck={false}
        />
        {dragActive && (
          <span className="maka-visually-hidden" role="status" aria-live="polite">
            松开以导入文件内容
          </span>
        )}
        <div className="maka-composer-toolbar composerActions" data-streaming={props.streaming ? 'true' : undefined}>
          <span>
            {props.disabled ? (
              copy.awaitingPermission
            ) : sendPending ? (
              copy.sending
            ) : props.streaming ? (
              <span className="maka-composer-streaming-hint">
                <span className="maka-composer-streaming-dot" aria-hidden="true" />
                {copy.streamingHintPrefix} <kbd>Esc</kbd> {copy.streamingHintInterrupt}
              </span>
            ) : (
              null
            )}
          </span>
          <div>
            {!props.streaming && props.onImportTextFile && (
              <button
                className="maka-composer-tool-button"
                type="button"
                disabled={props.disabled}
                onClick={props.onImportTextFile}
                aria-label="导入文件内容"
                title="导入文件内容"
              >
                <Paperclip size={14} strokeWidth={1.75} aria-hidden="true" />
              </button>
            )}
            {!props.streaming && props.onImportFolderOutline && (
              <button
                className="maka-composer-tool-button"
                type="button"
                disabled={props.disabled}
                onClick={props.onImportFolderOutline}
                aria-label="导入文件夹目录"
                title="导入文件夹目录"
              >
                <FolderOpen size={14} strokeWidth={1.75} aria-hidden="true" />
              </button>
            )}
            {props.streaming ? (
              <button className="maka-button" data-variant="primary" type="button" onClick={props.onStop}>
                {buttonCopy.stopLabel}
              </button>
            ) : (
              <button className="maka-button" data-variant="primary" type="submit" disabled={sendDisabled}>
                {buttonCopy.sendLabel}
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

function formatUserVisibleToolText(text: string): string {
  return text.replace(/\bUser denied permission\b/g, '用户已拒绝权限请求');
}

function isPermissionDeniedToolResult(result: ToolActivityItem['result']): boolean {
  return result?.kind === 'text' && formatUserVisibleToolText(result.text).trim() === '用户已拒绝权限请求';
}

export function formatRedactedJson(value: unknown): string {
  try {
    return redactSecrets(JSON.stringify(value, null, 2));
  } catch {
    return redactSecrets(String(value));
  }
}

export function formatToolIntent(intent: string): string {
  const safe = redactSecrets(intent.replace(/\s+/g, ' ').trim());
  return safe.length > 240 ? `${safe.slice(0, 240)}…` : safe;
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
        const permissionDenied = isPermissionDeniedToolResult(item.result);
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
              {item.intent && !permissionDenied && <p className="maka-tool-intent">{formatToolIntent(item.intent)}</p>}
              {item.args !== undefined && !permissionDenied && (
                <pre className="maka-code toolArgs">{formatRedactedJson(item.args)}</pre>
              )}
              {item.outputChunks && item.outputChunks.length > 0 && (
                <ToolOutputStream
                  chunks={item.outputChunks}
                  live={item.status === 'running' || item.status === 'pending'}
                  interrupted={item.status === 'interrupted'}
                  truncated={item.outputTruncated === true}
                />
              )}
              {item.result && !permissionDenied && <OverlayPreview content={item.result} />}
            </div>
          </details>
        );
      })}
    </section>
  );
}

/**
 * PR-UI-12 — live stdout/stderr stream from PR-REAL-4 `tool_output_delta`.
 *
 * Renders chunks in their original seq order (already sorted in main.tsx
 * before this component sees them) so interleaved stdout+stderr reads
 * the way a human would expect from a real terminal. Each chunk keeps
 * its stream tag so stderr can render in a destructive tone — a
 * single mono `<pre>` would lose that visual signal.
 *
 * `redacted: true` chunks render as a small inline hint "[已脱敏]"
 * instead of pretending the chunk arrived clean. Empty redacted
 * chunks (runtime suppressed everything) collapse to just the hint.
 *
 * `truncated: true` (PR-UI-12 fixup #2, @kenji A3 msg 365ff8b9) flips
 * a "已截断" pill in the header counts row. This means
 * `applyToolOutputChunk` dropped chunks (per-tool count or
 * total-char cap) or tail-truncated a single oversize chunk. Users
 * see explicitly that the displayed stream is bounded — they should
 * use Finder / external viewer if they need the full output.
 *
 * Auto-scroll: while `live` is true, we anchor to the bottom on every
 * chunk update so users see the latest output. Once the tool reaches
 * terminal (`tool_result`), auto-scroll stops so users can scroll up
 * to read history without being yanked back.
 */
function ToolOutputStream(props: {
  chunks: ToolOutputChunk[];
  live: boolean;
  interrupted: boolean;
  truncated: boolean;
}) {
  const preRef = useRef<HTMLPreElement>(null);
  useEffect(() => {
    if (!props.live) return;
    const el = preRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [props.chunks, props.live]);

  const stdoutCount = props.chunks.filter((c) => c.stream === 'stdout').length;
  const stderrCount = props.chunks.filter((c) => c.stream === 'stderr').length;
  const redactedCount = props.chunks.filter((c) => c.redacted).length;

  return (
    <div className="maka-tool-output-stream" data-live={props.live ? 'true' : undefined}>
      <header className="maka-tool-output-stream-header">
        <span className="maka-tool-output-stream-label">
          {props.live ? (
            <>
              <span className="maka-tool-output-stream-dot" aria-hidden="true" />
              <span>实时输出</span>
            </>
          ) : props.interrupted ? (
            <span>已中断 · 已收到的输出</span>
          ) : (
            <span>工具输出</span>
          )}
        </span>
        <span className="maka-tool-output-stream-counts">
          {stdoutCount > 0 && <span>stdout {stdoutCount}</span>}
          {stderrCount > 0 && <span data-stream="stderr">stderr {stderrCount}</span>}
          {redactedCount > 0 && <span data-redacted="true">已脱敏 {redactedCount}</span>}
          {props.truncated && (
            <span
              className="maka-tool-output-stream-truncated-tag"
              data-truncated="true"
              title="部分输出已截断；如需完整输出请查看对应工具结果或生成的 artifact"
            >
              已截断
            </span>
          )}
        </span>
      </header>
      <pre ref={preRef} className="maka-tool-output-stream-body">
        {props.chunks.map((chunk) => (
          <span
            key={chunk.seq}
            className="maka-tool-output-stream-chunk"
            data-stream={chunk.stream}
            data-redacted={chunk.redacted ? 'true' : undefined}
          >
            {chunk.text}
            {chunk.redacted && (
              <span className="maka-tool-output-stream-redacted-tag" aria-label="已脱敏">
                {' '}[已脱敏]
              </span>
            )}
          </span>
        ))}
      </pre>
    </div>
  );
}

function ToolErrorBanner(props: { result: ToolActivityItem['result'] }) {
  // Tool stderr / raw provider errors occasionally slip credential paths,
  // bearer tokens, or API keys through main-side redaction. Apply a
  // defensive UI-level mask before display *and* before clipboard copy so
  // the user can't accidentally paste a credential into a bug report.
  const errorText = formatUserVisibleToolText(redactSecrets(extractErrorText(props.result)));
  const copyFeedback = useClipboardCopyFeedback();
  const copyPhase = copyFeedback.phaseFor('tool-error');
  const copyPending = copyPhase === 'pending';
  const copyLabel = copyPhase === 'pending'
    ? '复制中…'
    : copyPhase === 'copied'
      ? '已复制'
      : copyPhase === 'failed'
        ? '复制失败'
        : '复制';

  async function copy() {
    if (!errorText) return;
    await copyFeedback.copy('tool-error', errorText);
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
          data-pending={copyPending ? 'true' : undefined}
          data-copy-feedback={copyPhase ?? undefined}
          aria-label={`${copyLabel}错误信息`}
          aria-busy={copyPending ? 'true' : undefined}
          disabled={copyPending}
          onClick={() => void copy()}
        >
          {copyPhase === 'copied' ? <Check size={14} aria-hidden="true" /> : <Copy size={14} aria-hidden="true" />}
          <span>{copyLabel}</span>
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
  // Accept Promise-returning impls so the dialog can await the IPC
  // and reset its own pending state when it resolves OR rejects.
  // The renderer's `respondToPermission` is async but was typed as
  // void by the legacy signature, which made `submit()` strand
  // `responsePending=true` if the IPC failed silently.
  onRespond(response: PermissionResponse): void | Promise<void>;
}) {
  const [rememberForTurn, setRememberForTurn] = useState(false);
  const [responsePending, setResponsePending] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const dialogRef = useRef<HTMLElement>(null);
  const responsePendingRef = useRef(false);
  // No onEscape — a permission request requires an explicit allow/deny decision.
  useModalA11y(dialogRef);

  useEffect(() => {
    setRememberForTurn(false);
    setResponsePending(false);
    responsePendingRef.current = false;
    setNow(Date.now());
  }, [props.request.requestId]);

  useEffect(() => {
    const tick = () => setNow(Date.now());
    const interval = window.setInterval(tick, 30_000);
    return () => window.clearInterval(interval);
  }, [props.request.requestId]);

  async function submit(decision: PermissionResponse['decision']) {
    if (responsePendingRef.current) return;
    responsePendingRef.current = true;
    setResponsePending(true);
    try {
      // PR-PERMISSION-UI-CLEANUP-0: await so the pending state
      // resets when the IPC settles. Previously a Promise-returning
      // onRespond would let the try/catch miss async rejections,
      // and on success the parent normally unmounts us — but if the
      // parent's own try/catch swallows the IPC error (PR-STOP-
      // ERROR-SURFACE-0 does exactly this), we'd stay mounted with
      // `responsePending=true` and the buttons would lock up.
      await props.onRespond({
        requestId: props.request.requestId,
        decision,
        rememberForTurn: decision === 'allow' ? rememberForTurn : false,
      });
    } finally {
      responsePendingRef.current = false;
      setResponsePending(false);
    }
  }

  const preset = REASON_PRESETS[props.request.reason] ?? REASON_PRESETS.custom;
  const summary = renderPermissionSummary(props.request);
  const isDestructive = preset.tone === 'destructive';
  const health = derivePermissionRequestHealth({ requestedAt: props.request.ts, now });
  const waitLabel = formatPermissionRequestWait(health.ageMs);

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
              <span aria-hidden="true"> · </span>
              <span className="maka-permission-age" data-status={health.status}>
                已等待 {waitLabel}
              </span>
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
            <pre className="maka-code">{formatRedactedJson(props.request.args)}</pre>
          </details>
          <label className="permissionRemember">
            <input
              type="checkbox"
              checked={rememberForTurn}
              disabled={responsePending}
              onChange={(event) => setRememberForTurn(event.currentTarget.checked)}
            />
            本轮对话内记住选择（同类型工具不再询问，关闭/切换对话后失效）
          </label>
          {isDestructive && (
            <p className="maka-permission-danger-note" role="note">
              这类操作不可恢复，确认前请再读一遍上面的参数。
            </p>
          )}
          {health.status !== 'fresh' && (
            <p className="maka-permission-stale-note" role="note" data-status={health.status}>
              这个请求已经等待较久。允许前请重新确认工具名和参数；如果上下文已经变了，直接拒绝后重新发送。
            </p>
          )}
        </div>
        <div className="maka-modal-footer permissionActions">
          <button className="maka-button" data-variant="ghost" type="button" disabled={responsePending} onClick={() => submit('deny')}>拒绝</button>
          <button
            className="maka-button"
            data-variant={isDestructive ? 'destructive' : 'primary'}
            type="button"
            disabled={responsePending}
            onClick={() => submit('allow')}
          >
            {responsePending ? '正在提交…' : isDestructive ? '我已确认，允许' : '允许'}
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
          <pre className="maka-code maka-permission-command">{redactSecrets(command)}</pre>
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
      const preview = permissionTextPreview(content, 600);
      return (
        <>
          <p className="maka-permission-line">即将写入文件：</p>
          <p className="maka-permission-path"><code>{redactSecrets(path)}</code></p>
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
          <p className="maka-permission-path"><code>{redactSecrets(path)}</code></p>
          <div className="maka-permission-diff">
            <div>
              <span className="maka-permission-diff-tag" data-side="old">删除</span>
              <pre className="maka-code">{permissionTextPreview(oldString, 400)}</pre>
            </div>
            <div>
              <span className="maka-permission-diff-tag" data-side="new">写入</span>
              <pre className="maka-code">{permissionTextPreview(newString, 400)}</pre>
            </div>
          </div>
        </>
      );
    }
    case 'OfficeDocumentEdit': {
      const path = typeof args.path === 'string' ? args.path : undefined;
      const operation = typeof args.operation === 'string' ? args.operation : undefined;
      if (!path || !operation) return undefined;
      const target = typeof args.target === 'string' ? args.target : undefined;
      const elementType = typeof args.elementType === 'string' ? args.elementType : undefined;
      const index = typeof args.index === 'number' ? args.index : undefined;
      const propsArg = args.props && typeof args.props === 'object' && !Array.isArray(args.props)
        ? args.props as Record<string, unknown>
        : {};
      const propEntries = Object.entries(propsArg).slice(0, 6);
      const hiddenProps = Math.max(0, Object.keys(propsArg).length - propEntries.length);
      return (
        <>
          <p className="maka-permission-line">即将编辑 Office 文档：</p>
          <p className="maka-permission-path"><code>{redactSecrets(path)}</code></p>
          <p className="maka-permission-meta">
            操作 <strong>{redactSecrets(operation)}</strong>
            {target && <> · 目标 <code>{redactSecrets(target)}</code></>}
            {elementType && <> · 元素 <code>{redactSecrets(elementType)}</code></>}
            {index !== undefined && <> · 位置 <strong>{index}</strong></>}
          </p>
          {propEntries.length > 0 && (
            <pre className="maka-code maka-permission-preview">
              {propEntries.map(([key, value]) => `${redactSecrets(key)}=${permissionValuePreview(value)}`).join('\n')}
              {hiddenProps > 0 && `\n… 另有 ${hiddenProps} 个属性`}
            </pre>
          )}
        </>
      );
    }
    default:
      return undefined;
  }
}

function permissionTextPreview(value: string, maxChars: number): string {
  const safe = redactSecrets(value);
  return safe.length > maxChars ? `${safe.slice(0, maxChars)}…` : safe;
}

function permissionValuePreview(value: unknown): string {
  if (typeof value === 'string') {
    const safe = redactSecrets(value);
    return safe.length > 160 ? `${safe.slice(0, 160)}…` : safe;
  }
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  return '不支持的属性值';
}

/**
 * Renders a ToolResultContent payload with kind-specific presentation:
 * - `file_diff`: line-level red/green diff coloring
 * - `terminal`: stdout + stderr split with exit-code badge + stderr in
 *   destructive tone
 * - `office_document`: Office adapter stdout/stderr/diagnostic cards
 * - `explore_agent`: bounded read-only subagent findings
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

  if (content.kind === 'web_search') {
    return (
      <WebSearchPreview query={content.query} provider={content.provider} rows={content.rows} />
    );
  }

  if (content.kind === 'web_search_error') {
    return (
      <WebSearchErrorPreview
        query={content.query}
        provider={content.provider}
        reason={content.reason}
        message={content.message}
        credentialSource={content.credentialSource}
      />
    );
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

  if (content.kind === 'office_document') {
    return <OfficeDocumentPreview result={content} />;
  }

  if (content.kind === 'explore_agent') {
    return <ExploreAgentPreview result={content} />;
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
    return <pre className="maka-overlay-preview" data-kind="json">{formatUserVisibleToolText(redactSecrets(body))}</pre>;
  }

  if (content.kind === 'text') {
    const { body, capped } = capLines(formatUserVisibleToolText(redactSecrets(content.text)));
    return (
      <pre className="maka-overlay-preview" data-kind="text">
        {body}
        {capped > 0 && `\n\n… 已隐藏 ${capped} 行`}
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

function ExploreAgentPreview(props: {
  result: Extract<ToolResultContent, { kind: 'explore_agent' }>;
}) {
  const { result } = props;
  const copyFeedback = useClipboardCopyFeedback();
  const candidateFiles = result.candidateFiles.slice(0, 8);
  const matches = result.matches.slice(0, 8);
  const processLines = Array.isArray(result.recentEvents) && result.recentEvents.length > 0
    ? result.recentEvents.slice(0, 20).map((event) => formatExploreAgentEvent(event, result.startedAt))
    : (result.progress ?? []).slice(0, 12);
  const progress = processLines.slice(0, 6);
  const evidence = (result.evidence ?? []).slice(0, 6);
  const resultSummary = typeof result.summary === 'string' ? result.summary.trim() : '';
  const reportText = typeof result.report === 'string' ? result.report.trim() : '';
  const terminalStatus = presentExploreAgentTerminalStatus(result.terminalStatus, result.ok, result.partial === true, result.reason);
  const status = result.ok
    ? '已完成'
    : result.reason === 'aborted' && result.partial === true
      ? '已取消 · 保留部分结果'
      : presentExploreAgentReason(result.reason) ?? '未完成';
  const reportLines = reportText.split('\n').filter((line) => line.trim().length > 0).slice(0, 8);
  const notes = result.notes.slice(0, 4);
  const roots = result.roots.length > 0 ? result.roots.join(', ') : '.';
  const queries = result.queries.length > 0 ? result.queries.join(', ') : '未指定';
  const ignoredPaths = Array.isArray(result.ignoredPaths) && result.ignoredPaths.length > 0
    ? result.ignoredPaths.join(', ')
    : '';
  const stoppingCondition = typeof result.stoppingCondition === 'string'
    ? result.stoppingCondition.trim()
    : '';
  const limitReasons = Array.isArray(result.limitReasons)
    ? result.limitReasons.map(presentExploreAgentLimitReason).filter(Boolean).join('、')
    : '';
  const filesDiscovered = typeof result.filesDiscovered === 'number' && Number.isFinite(result.filesDiscovered)
    ? Math.max(0, Math.floor(result.filesDiscovered))
    : result.filesInspected;
  const skippedSummary = result.sensitiveFilesSkipped && result.sensitiveFilesSkipped > 0
    ? `跳过 ${result.filesSkipped} 个（含敏感 ${result.sensitiveFilesSkipped} 个）`
    : `跳过 ${result.filesSkipped} 个`;
  const duration = formatDuration(result.durationMs);
  const summaryText = resultSummary.length > 0
    ? [
      `状态：${status}`,
      `终态：${terminalStatus}`,
      `目标：${result.objective || '只读探索'}`,
      `摘要：${resultSummary}`,
      `范围：${roots}`,
      `查询：${queries}`,
      `发现/读取：${filesDiscovered} / ${result.filesInspected} 个文件`,
      duration ? `耗时：${duration}` : '',
      ignoredPaths ? `忽略：${ignoredPaths}` : '',
      stoppingCondition ? `停止条件：${stoppingCondition}` : '',
      limitReasons ? `预算边界：${limitReasons}` : '',
    ].filter((line) => line.length > 0).join('\n')
    : '';
  const processText = [
    summaryText,
    processLines.length > 0 ? `事件：${processLines.length}` : '',
    processLines.join('\n'),
  ].filter((line) => line.trim().length > 0).join('\n').trim();
  const evidenceText = evidence.length > 0
    ? [
      `状态：${status}`,
      `终态：${terminalStatus}`,
      `目标：${result.objective || '只读探索'}`,
      `证据：${evidence.length}`,
      ...evidence.map((item) => [
        `- ${item.path}${typeof item.line === 'number' ? `:${item.line}` : ''}`,
        item.label,
        typeof item.score === 'number' ? `分数 ${item.score}` : '',
      ].filter(Boolean).join(' — ')),
    ].join('\n')
    : '';
  const candidateText = candidateFiles.length > 0
    ? [
      `状态：${status}`,
      `终态：${terminalStatus}`,
      `目标：${result.objective || '只读探索'}`,
      `发现/读取：${filesDiscovered} / ${result.filesInspected} 个文件`,
      `候选：${candidateFiles.length}`,
      ...candidateFiles.map((file) => [
        `- ${file.path}`,
        `分数 ${file.score}`,
        file.reasons.length > 0 ? presentExploreAgentCandidateReasons(file.reasons) : '',
      ].filter(Boolean).join(' — ')),
    ].join('\n')
    : '';
  const matchesText = matches.length > 0
    ? [
      `状态：${status}`,
      `终态：${terminalStatus}`,
      `目标：${result.objective || '只读探索'}`,
      `查询：${queries}`,
      `命中片段：${matches.length}`,
      ...matches.map((match) => `- ${match.path}:${match.line} [${match.query}] ${match.snippet}`),
    ].join('\n')
    : '';
  const needsContinuation =
    result.partial === true ||
    !result.ok ||
    Boolean(limitReasons) ||
    result.terminalStatus === 'completed_empty';
  const continuationReason = needsContinuation
    ? presentExploreAgentContinuationReason({
      partial: result.partial === true,
      ok: result.ok,
      hasLimitReasons: Boolean(limitReasons),
      terminalStatus: result.terminalStatus,
    })
    : '';
  const continuationText = needsContinuation
    ? [
      '继续这次只读探索，不要修改文件。',
      continuationReason ? `续研原因：${continuationReason}` : '',
      `上一轮状态：${status}`,
      `上一轮终态：${terminalStatus}`,
      `目标：${result.objective || '只读探索'}`,
      `范围：${roots}`,
      `查询：${queries}`,
      `发现/读取：${filesDiscovered} / ${result.filesInspected} 个文件`,
      duration ? `上一轮耗时：${duration}` : '',
      ignoredPaths ? `继续忽略：${ignoredPaths}` : '',
      stoppingCondition ? `停止条件：${stoppingCondition}` : '',
      limitReasons ? `上一轮预算边界：${limitReasons}` : '',
      resultSummary ? `上一轮摘要：${resultSummary}` : '',
      candidateFiles.length > 0
        ? [
          '优先补读候选：',
          ...candidateFiles.slice(0, 5).map((file) => `- ${file.path}（分数 ${file.score}）`),
        ].join('\n')
        : '',
      matches.length > 0
        ? [
          '已有命中片段：',
          ...matches.slice(0, 5).map((match) => `- ${match.path}:${match.line} [${match.query}] ${match.snippet}`),
        ].join('\n')
        : '',
      '请只读检查仍缺证据的部分，输出新的证据锚点、候选文件、结论和下一步 gate。',
    ].filter((line) => line.trim().length > 0).join('\n')
    : '';

  function copyButtonState(key: string, idleLabel: string, copiedAria: string) {
    const phase = copyFeedback.phaseFor(key);
    return {
      phase,
      disabled: copyFeedback.isPending,
      label: phase === 'pending'
        ? '复制中…'
        : phase === 'copied'
          ? '已复制'
          : phase === 'failed'
            ? '复制失败'
            : idleLabel,
      ariaLabel: phase === 'pending'
        ? `${idleLabel}中`
        : phase === 'copied'
          ? copiedAria
          : phase === 'failed'
            ? `${idleLabel}失败`
            : idleLabel,
    };
  }

  const summaryCopy = copyButtonState('summary', '复制摘要', '已复制探索摘要');
  const continuationCopy = copyButtonState('continuation', '复制续研提示', '已复制续研提示');
  const processCopy = copyButtonState('process', '复制过程', '已复制探索过程');
  const evidenceCopy = copyButtonState('evidence', '复制证据', '已复制证据锚点');
  const reportCopy = copyButtonState('report', '复制报告', '已复制研究报告');
  const candidateCopy = copyButtonState('candidate', '复制候选', '已复制候选文件');
  const matchesCopy = copyButtonState('matches', '复制片段', '已复制命中片段');

  return (
    <div className="maka-overlay-preview maka-explore-agent-preview" data-kind="explore_agent" data-ok={result.ok ? 'true' : 'false'}>
      <header className="maka-explore-agent-head">
        <strong>{redactSecrets(result.objective || '只读探索')}</strong>
        <small>
          {status} · 发现/读 {filesDiscovered} / {result.filesInspected} 个文件 · {skippedSummary} · {formatBytes(result.bytesRead)}
          {limitReasons ? ' · 受预算限制' : ''}
          {continuationReason ? ` · 建议续研：${continuationReason}` : ''}
          {duration ? ` · 耗时 ${duration}` : ''}
        </small>
        {resultSummary.length > 0 && (
          <div className="maka-explore-agent-summary-line">
            <small>{redactSecrets(resultSummary)}</small>
            <button
              type="button"
              className="maka-button maka-button-ghost maka-explore-agent-copy"
              data-size="sm"
              onClick={() => void copyFeedback.copy('summary', summaryText)}
              disabled={summaryCopy.disabled}
              aria-label={summaryCopy.ariaLabel}
              aria-busy={summaryCopy.phase === 'pending' ? 'true' : undefined}
              data-pending={summaryCopy.phase === 'pending' ? 'true' : undefined}
              data-copied={summaryCopy.phase === 'copied' ? 'true' : 'false'}
              data-copy-error={summaryCopy.phase === 'failed' ? 'true' : undefined}
            >
              {summaryCopy.phase === 'copied' ? <Check size={13} strokeWidth={2} aria-hidden="true" /> : <Copy size={13} strokeWidth={1.75} aria-hidden="true" />}
              <span>{summaryCopy.label}</span>
            </button>
          </div>
        )}
        {continuationText.length > 0 && (
          <div className="maka-explore-agent-actions" aria-label="只读探索后续操作">
            <button
              type="button"
              className="maka-button maka-button-ghost maka-explore-agent-copy"
              data-size="sm"
              onClick={() => void copyFeedback.copy('continuation', continuationText)}
              disabled={continuationCopy.disabled}
              aria-label={continuationCopy.ariaLabel}
              aria-busy={continuationCopy.phase === 'pending' ? 'true' : undefined}
              data-pending={continuationCopy.phase === 'pending' ? 'true' : undefined}
              data-copied={continuationCopy.phase === 'copied' ? 'true' : 'false'}
              data-copy-error={continuationCopy.phase === 'failed' ? 'true' : undefined}
              title="复制一段可继续只读探索的提示"
            >
              {continuationCopy.phase === 'copied' ? <Check size={13} strokeWidth={2} aria-hidden="true" /> : <Copy size={13} strokeWidth={1.75} aria-hidden="true" />}
              <span>{continuationCopy.label}</span>
            </button>
          </div>
        )}
      </header>
      {!result.ok && (
        <div className="maka-explore-agent-message" role="note">
          {redactSecrets(result.message ?? '只读探索未完成。')}
        </div>
      )}
      <dl className="maka-explore-agent-meta">
        <div>
          <dt>终态</dt>
          <dd>{terminalStatus}</dd>
        </div>
        <div>
          <dt>发现/读</dt>
          <dd>{filesDiscovered} / {result.filesInspected} 个文件</dd>
        </div>
        <div>
          <dt>范围</dt>
          <dd>{redactSecrets(roots)}</dd>
        </div>
        <div>
          <dt>查询</dt>
          <dd>{redactSecrets(queries)}</dd>
        </div>
        {ignoredPaths && (
          <div>
            <dt>忽略</dt>
            <dd>{redactSecrets(ignoredPaths)}</dd>
          </div>
        )}
        {stoppingCondition && (
          <div>
            <dt>停止</dt>
            <dd>{redactSecrets(stoppingCondition)}</dd>
          </div>
        )}
        {limitReasons && (
          <div>
            <dt>边界</dt>
            <dd>{redactSecrets(limitReasons)}</dd>
          </div>
        )}
        {continuationReason && (
          <div>
            <dt>后续</dt>
            <dd>建议续研：{redactSecrets(continuationReason)}</dd>
          </div>
        )}
      </dl>
      {progress.length > 0 && (
        <section className="maka-explore-agent-section" aria-label="探索过程">
          <div className="maka-explore-agent-section-head">
            <strong>过程</strong>
            <button
              type="button"
              className="maka-button maka-button-ghost maka-explore-agent-copy"
              data-size="sm"
              onClick={() => void copyFeedback.copy('process', processText)}
              disabled={processCopy.disabled}
              aria-label={processCopy.ariaLabel}
              aria-busy={processCopy.phase === 'pending' ? 'true' : undefined}
              data-pending={processCopy.phase === 'pending' ? 'true' : undefined}
              data-copied={processCopy.phase === 'copied' ? 'true' : 'false'}
              data-copy-error={processCopy.phase === 'failed' ? 'true' : undefined}
            >
              {processCopy.phase === 'copied' ? <Check size={13} strokeWidth={2} aria-hidden="true" /> : <Copy size={13} strokeWidth={1.75} aria-hidden="true" />}
              <span>{processCopy.label}</span>
            </button>
          </div>
          <ul>
            {progress.map((item, index) => (
              <li key={`${index}:${item.slice(0, 24)}`}>
                <span>{redactSecrets(item)}</span>
              </li>
            ))}
          </ul>
        </section>
      )}
      {evidence.length > 0 && (
        <section className="maka-explore-agent-section" aria-label="证据锚点">
          <div className="maka-explore-agent-section-head">
            <strong>证据锚点</strong>
            <button
              type="button"
              className="maka-button maka-button-ghost maka-explore-agent-copy"
              data-size="sm"
              onClick={() => void copyFeedback.copy('evidence', evidenceText)}
              disabled={evidenceCopy.disabled}
              aria-label={evidenceCopy.ariaLabel}
              aria-busy={evidenceCopy.phase === 'pending' ? 'true' : undefined}
              data-pending={evidenceCopy.phase === 'pending' ? 'true' : undefined}
              data-copied={evidenceCopy.phase === 'copied' ? 'true' : 'false'}
              data-copy-error={evidenceCopy.phase === 'failed' ? 'true' : undefined}
            >
              {evidenceCopy.phase === 'copied' ? <Check size={13} strokeWidth={2} aria-hidden="true" /> : <Copy size={13} strokeWidth={1.75} aria-hidden="true" />}
              <span>{evidenceCopy.label}</span>
            </button>
          </div>
          <ul>
            {evidence.map((item, index) => (
              <li key={`${item.path}:${item.line ?? 'file'}:${index}`}>
                <code>
                  {redactSecrets(item.path)}
                  {typeof item.line === 'number' ? `:${item.line}` : ''}
                </code>
                <small>
                  {redactSecrets(item.label)}
                  {typeof item.score === 'number' ? ` · 分数 ${item.score}` : ''}
                </small>
              </li>
            ))}
          </ul>
        </section>
      )}
      {reportLines.length > 0 && (
        <section className="maka-explore-agent-section" aria-label="研究报告">
          <div className="maka-explore-agent-section-head">
            <strong>研究报告</strong>
            <button
              type="button"
              className="maka-button maka-button-ghost maka-explore-agent-copy"
              data-size="sm"
              onClick={() => void copyFeedback.copy('report', reportText)}
              disabled={reportCopy.disabled}
              aria-label={reportCopy.ariaLabel}
              aria-busy={reportCopy.phase === 'pending' ? 'true' : undefined}
              data-pending={reportCopy.phase === 'pending' ? 'true' : undefined}
              data-copied={reportCopy.phase === 'copied' ? 'true' : 'false'}
              data-copy-error={reportCopy.phase === 'failed' ? 'true' : undefined}
            >
              {reportCopy.phase === 'copied' ? <Check size={13} strokeWidth={2} aria-hidden="true" /> : <Copy size={13} strokeWidth={1.75} aria-hidden="true" />}
              <span>{reportCopy.label}</span>
            </button>
          </div>
          <ul>
            {reportLines.map((line, index) => (
              <li key={`${index}:${line.slice(0, 24)}`}>
                <span>{redactSecrets(line)}</span>
              </li>
            ))}
          </ul>
        </section>
      )}
      {candidateFiles.length > 0 && (
        <section className="maka-explore-agent-section" aria-label="候选文件">
          <div className="maka-explore-agent-section-head">
            <strong>候选文件</strong>
            <button
              type="button"
              className="maka-button maka-button-ghost maka-explore-agent-copy"
              data-size="sm"
              onClick={() => void copyFeedback.copy('candidate', candidateText)}
              disabled={candidateCopy.disabled}
              aria-label={candidateCopy.ariaLabel}
              aria-busy={candidateCopy.phase === 'pending' ? 'true' : undefined}
              data-pending={candidateCopy.phase === 'pending' ? 'true' : undefined}
              data-copied={candidateCopy.phase === 'copied' ? 'true' : 'false'}
              data-copy-error={candidateCopy.phase === 'failed' ? 'true' : undefined}
            >
              {candidateCopy.phase === 'copied' ? <Check size={13} strokeWidth={2} aria-hidden="true" /> : <Copy size={13} strokeWidth={1.75} aria-hidden="true" />}
              <span>{candidateCopy.label}</span>
            </button>
          </div>
          <ul>
            {candidateFiles.map((file) => (
              <li key={file.path}>
                <code>{redactSecrets(file.path)}</code>
                <small>
                  分数 {file.score}
                  {file.reasons.length > 0 ? ` · ${presentExploreAgentCandidateReasons(file.reasons)}` : ''}
                </small>
              </li>
            ))}
          </ul>
        </section>
      )}
      {matches.length > 0 && (
        <section className="maka-explore-agent-section" aria-label="命中片段">
          <div className="maka-explore-agent-section-head">
            <strong>命中片段</strong>
            <button
              type="button"
              className="maka-button maka-button-ghost maka-explore-agent-copy"
              data-size="sm"
              onClick={() => void copyFeedback.copy('matches', matchesText)}
              disabled={matchesCopy.disabled}
              aria-label={matchesCopy.ariaLabel}
              aria-busy={matchesCopy.phase === 'pending' ? 'true' : undefined}
              data-pending={matchesCopy.phase === 'pending' ? 'true' : undefined}
              data-copied={matchesCopy.phase === 'copied' ? 'true' : 'false'}
              data-copy-error={matchesCopy.phase === 'failed' ? 'true' : undefined}
            >
              {matchesCopy.phase === 'copied' ? <Check size={13} strokeWidth={2} aria-hidden="true" /> : <Copy size={13} strokeWidth={1.75} aria-hidden="true" />}
              <span>{matchesCopy.label}</span>
            </button>
          </div>
          <ul>
            {matches.map((match, index) => (
              <li key={`${match.path}:${match.line}:${index}`}>
                <code>{redactSecrets(match.path)}:{match.line}</code>
                <small>{redactSecrets(match.query)}</small>
                <p>{redactSecrets(match.snippet)}</p>
              </li>
            ))}
          </ul>
        </section>
      )}
      {notes.length > 0 && (
        <section className="maka-explore-agent-section" aria-label="探索说明">
          <strong>说明</strong>
          <ul>
            {notes.map((note, index) => (
              <li key={`${index}:${note.slice(0, 24)}`}>
                <span>{redactSecrets(note)}</span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

function presentExploreAgentTerminalStatus(
  terminalStatus: Extract<ToolResultContent, { kind: 'explore_agent' }>['terminalStatus'],
  ok: boolean,
  partial: boolean,
  reason: Extract<ToolResultContent, { kind: 'explore_agent' }>['reason'],
): string {
  switch (terminalStatus) {
    case 'completed':
      return '完成，有证据';
    case 'completed_empty':
      return '完成，无证据';
    case 'failed':
      return '失败';
    case 'canceled':
      return '已取消';
    case 'canceled_partial':
      return '已取消，有部分结果';
    case undefined:
      if (reason === 'aborted' && partial) return '已取消，有部分结果';
      if (reason === 'aborted') return '已取消';
      if (!ok) return '失败';
      return '完成';
    default:
      return '未知终态';
  }
}

function presentExploreAgentReason(
  reason: Extract<ToolResultContent, { kind: 'explore_agent' }>['reason'],
): string | undefined {
  switch (reason) {
    case 'invalid_objective':
      return '目标无效';
    case 'invalid_root':
      return '范围无效';
    case 'no_readable_roots':
      return '没有可读取范围';
    case 'aborted':
      return '已取消';
    case undefined:
      return undefined;
    default:
      return '未知诊断';
  }
}

function presentExploreAgentLimitReason(reason: string): string {
  switch (reason) {
    case 'candidate_budget':
      return '候选文件预算已满';
    case 'file_budget':
      return '读取文件预算已满';
    case 'match_budget':
      return '命中预算已满';
    case 'byte_budget':
      return '读取字节预算已满';
    default:
      return '';
  }
}

function presentExploreAgentContinuationReason(input: {
  partial: boolean;
  ok: boolean;
  hasLimitReasons: boolean;
  terminalStatus: Extract<ToolResultContent, { kind: 'explore_agent' }>['terminalStatus'];
}): string {
  if (input.partial) return '已有部分结果，仍需补证据';
  if (!input.ok) return '上一轮未完成';
  if (input.hasLimitReasons) return '达到预算边界';
  if (input.terminalStatus === 'completed_empty') return '没有找到证据';
  return '仍缺证据';
}

function formatExploreAgentEvent(event: { type: string; message: string; at?: number }, startedAt?: number): string {
  const label = presentExploreAgentEventType(event.type);
  const message = typeof event.message === 'string' ? event.message.trim() : '';
  const offset = formatExploreAgentEventOffset(event.at, startedAt);
  const prefix = [label, offset].filter(Boolean).join(' ');
  return prefix ? `${prefix}：${message}` : message;
}

function formatExploreAgentEventOffset(at: number | undefined, startedAt: number | undefined): string {
  if (typeof at !== 'number' || typeof startedAt !== 'number') return '';
  if (!Number.isFinite(at) || !Number.isFinite(startedAt)) return '';
  const delta = Math.max(0, Math.floor(at - startedAt));
  const formatted = formatDuration(delta);
  return formatted ? `+${formatted}` : '';
}

function presentExploreAgentEventType(type: string): string {
  switch (type) {
    case 'started':
      return '开始';
    case 'scope_resolved':
      return '范围';
    case 'scan':
      return '扫描';
    case 'read':
      return '读取';
    case 'checkpoint':
      return '进度';
    case 'completed':
      return '完成';
    case 'failed':
      return '失败';
    case 'aborted':
      return '取消';
    default:
      return '';
  }
}

function presentExploreAgentCandidateReasons(reasons: string[]): string {
  return reasons.map((reason) => {
    if (reason === 'content match') return '内容命中';
    if (reason === 'project manifest') return '项目配置';
    if (reason === 'project documentation') return '项目文档';
    if (reason === 'project entrypoint') return '入口文件';
    if (reason === 'project test surface') return '测试线索';
    if (reason === 'project source surface') return '源码线索';
    const pathMatch = reason.match(/^path contains "(.+)"$/);
    if (pathMatch) return `路径命中 ${redactSecrets(pathMatch[1] ?? '')}`;
    return '探索线索';
  }).join(', ');
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

function OfficeDocumentPreview(props: {
  result: Extract<ToolResultContent, { kind: 'office_document' }>;
}) {
  const { result } = props;
  const stdout = capLines(redactSecrets(result.stdout ?? ''));
  const stderr = capLines(redactSecrets(result.stderr ?? ''));
  const message = result.message ? redactSecrets(result.message) : '';
  const args = result.args?.map((arg) => redactSecrets(arg)).join(' ');
  const title = result.path ? redactSecrets(result.path) : 'Office 文档';
  const operation = result.operation ? redactSecrets(result.operation) : '未执行';
  const reason = presentOfficeDocumentReason(result.reason);
  const hasOutput = stdout.body.length > 0 || stderr.body.length > 0;

  return (
    <div className="maka-overlay-preview maka-office-document-preview" data-kind="office_document" data-ok={result.ok ? 'true' : 'false'}>
      <header className="maka-office-document-head">
        <strong>{title}</strong>
        <small>
          {operation}
          {result.ok ? ' · 已完成' : ' · 未完成'}
          {result.truncated ? ' · 输出已截断' : ''}
        </small>
      </header>
      {args && <code className="maka-office-document-args">officecli {args}</code>}
      {!result.ok && (
        <div className="maka-office-document-message" role="note">
          <span>{message || 'Office 文档操作未完成。'}</span>
          {reason && <small>诊断：{reason}</small>}
        </div>
      )}
      {result.ok && !hasOutput && <p className="maka-office-document-empty">（无输出）</p>}
      {stdout.body.length > 0 && (
        <pre className="maka-office-document-stream" data-stream="stdout">
          {stdout.body}
          {stdout.capped > 0 && `\n\n… stdout 已隐藏 ${stdout.capped} 行`}
        </pre>
      )}
      {stderr.body.length > 0 && (
        <pre className="maka-office-document-stream" data-stream="stderr">
          {stderr.body}
          {stderr.capped > 0 && `\n\n… stderr 已隐藏 ${stderr.capped} 行`}
        </pre>
      )}
    </div>
  );
}

function presentOfficeDocumentReason(reason: string | undefined): string | undefined {
  switch (reason) {
    case 'invalid_operation':
      return '操作不支持';
    case 'invalid_path':
      return '路径无效';
    case 'unsupported_extension':
      return '文件类型不支持';
    case 'missing_file':
      return '文件不存在';
    case 'not_file':
      return '不是文件';
    case 'symlink_escape':
      return '符号链接被拒绝';
    case 'invalid_selector':
      return '选择器无效';
    case 'invalid_query':
      return '查询表达式无效';
    case 'invalid_props':
      return '属性无效';
    case 'file_exists':
      return '文件已存在';
    case 'officecli_missing':
      return 'officecli 未安装';
    case 'officecli_timeout':
      return '操作超时';
    case 'officecli_failed':
      return '操作失败';
    case undefined:
      return undefined;
    default:
      return '未知诊断';
  }
}

/**
 * Line-level diff coloring. Splits the unified-diff text on newlines and
 * tags each line with `data-line="add" | "del" | "hunk" | "meta" | "ctx"`
 * for CSS to color. Doesn't try to parse the hunk semantics — we leave
 * that to a future inline editor view; this is just a readable preview.
 */
/**
 * PR-CHAT-WEB-SEARCH-RENDER-0 — plain-text card list for the gated
 * WebSearch agent tool result. Matches the Settings → 联网搜索 live-query
 * verification layout so the user gets the same shape whether the search came
 * from a manual verification run or the agent. Never renders markdown / HTML;
 * each cell is `redactSecrets`'d as a belt-and-braces guard against
 * a provider response that happened to echo a token.
 */
function WebSearchPreview(props: {
  query: string;
  provider: string;
  rows: ReadonlyArray<{ title: string; url: string; snippet: string; source: string }>;
}) {
  const rows = props.rows
    .map((row) => {
      const normalizedUrl = normalizeSearchUrl(row.url);
      if (!normalizedUrl.ok) return null;
      return { ...row, url: redactSecrets(normalizedUrl.value) };
    })
    .filter((row): row is { title: string; url: string; snippet: string; source: string } => row !== null);

  if (rows.length === 0) {
    return (
      <div className="maka-overlay-preview maka-web-search-preview" data-kind="web_search">
        <header>
          <strong>{redactSecrets(props.query)}</strong>
          <small>{props.provider} · 没有结果</small>
        </header>
      </div>
    );
  }
  return (
    <div className="maka-overlay-preview maka-web-search-preview" data-kind="web_search">
      <header>
        <strong>{redactSecrets(props.query)}</strong>
        <small>
          {props.provider} · {rows.length} 条结果
        </small>
      </header>
      <ul>
        {rows.map((row, idx) => (
          <li key={`${row.url}-${idx}`}>
            <a href={row.url} target="_blank" rel="noreferrer">
              {redactSecrets(row.title)}
            </a>
            <small>{redactSecrets(row.source)}</small>
            <p>{redactSecrets(row.snippet)}</p>
          </li>
        ))}
      </ul>
    </div>
  );
}

function WebSearchErrorPreview(props: {
  query?: string;
  provider: string;
  reason: string;
  message: string;
  credentialSource?: string;
}) {
  const sourceCopy =
    props.credentialSource === 'env'
      ? '环境变量'
      : props.credentialSource === 'saved'
        ? '本机已保存 key'
        : props.credentialSource === 'none'
          ? '未配置'
          : '来源未知';
  const repairCopy =
    props.reason === 'invalid_credentials' && props.credentialSource === 'env'
      ? '请检查 TAVILY_API_KEY / MAKA_TAVILY_API_KEY 后重启。'
      : props.reason === 'invalid_credentials'
        ? '请在 设置 · 联网搜索 中更新 Tavily key。'
        : props.reason === 'rate_limited'
          ? 'Tavily 当前限流，请稍后重试或更换可用凭据。'
          : props.reason === 'not_configured'
            ? '请先完成联网搜索配置后再重试。'
            : props.reason === 'timeout'
              ? '请求超时，请稍后重试。'
              : props.reason === 'incognito_active'
                ? '隐私模式下不会发起联网搜索。'
                : '请检查网络或稍后重试。';
  return (
    <div className="maka-overlay-preview maka-web-search-preview maka-web-search-error" data-kind="web_search_error">
      <header>
        <strong>{redactSecrets(props.query ?? '联网搜索')}</strong>
        <small>{redactSecrets(props.provider)} · 搜索失败 · {sourceCopy}</small>
      </header>
      <p className="maka-web-search-error-message">{redactSecrets(props.message)}</p>
      <p className="maka-web-search-error-repair">{repairCopy}</p>
    </div>
  );
}

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
            {`\n… 已隐藏 ${capped} 行\n`}
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
  const copyFeedback = useClipboardCopyFeedback();
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
  const safeCwd = redactSecrets(props.cwd);
  const hiddenLines = stdout.capped + stderr.capped;
  const handoffText = [
    '终端输出需要继续研读',
    `工作目录：${safeCwd}`,
    `命令：${safeCmd}`,
    `退出码：${props.exitCode}`,
    `截断：stdout 已隐藏 ${stdout.capped} 行，stderr 已隐藏 ${stderr.capped} 行`,
    stdout.body.length > 0 ? `stdout 预览：\n${stdout.body}` : '',
    stderr.body.length > 0 ? `stderr 预览：\n${stderr.body}` : '',
    '请在深度研究 / 只读探索里结合相关路径确认完整输出影响和下一步。',
  ].filter((line) => line.length > 0).join('\n\n');

  const handoffCopyPhase = copyFeedback.phaseFor('handoff');
  const handoffCopyLabel = handoffCopyPhase === 'pending'
    ? '复制中…'
    : handoffCopyPhase === 'copied'
      ? '已复制'
      : handoffCopyPhase === 'failed'
        ? '复制失败'
        : '复制研读提示';
  const handoffCopyAria = handoffCopyPhase === 'pending'
    ? '复制终端研读提示中'
    : handoffCopyPhase === 'copied'
      ? '已复制终端研读提示'
      : handoffCopyPhase === 'failed'
        ? '复制终端研读提示失败'
        : '复制终端研读提示';

  return (
    <div className="maka-overlay-preview maka-tool-terminal" data-kind="terminal">
      <header className="maka-tool-terminal-head">
        <code className="maka-tool-terminal-cwd">{safeCwd}</code>
        <code className="maka-tool-terminal-cmd">$ {safeCmd}</code>
        <span
          className="maka-tool-terminal-exit"
          data-ok={succeeded ? 'true' : 'false'}
          aria-label={`退出码 ${props.exitCode}`}
        >
          退出码 {props.exitCode}
        </span>
      </header>
      {!hasOutput && <p className="maka-tool-terminal-empty">（无输出）</p>}
      {props.stdout.length > 0 && (
        <pre className="maka-tool-terminal-stream" data-stream="stdout">
          {stdout.body}
          {stdout.capped > 0 && `\n\n… stdout 已隐藏 ${stdout.capped} 行`}
        </pre>
      )}
      {props.stderr.length > 0 && (
        <pre className="maka-tool-terminal-stream" data-stream="stderr">
          {stderr.body}
          {stderr.capped > 0 && `\n\n… stderr 已隐藏 ${stderr.capped} 行`}
        </pre>
      )}
      {hiddenLines > 0 && (
        <div className="maka-tool-terminal-truncated-note">
          <span>
            输出较长，当前只展示每路输出的前 {TOOL_LINE_CAP} 行。需要继续研读时，可以切到深度研究并把命令、相关路径和想确认的问题交给只读探索。
          </span>
          <button
            type="button"
            className="maka-button maka-button-ghost maka-tool-terminal-copy"
            data-size="sm"
            onClick={() => void copyFeedback.copy('handoff', handoffText)}
            disabled={handoffCopyPhase === 'pending'}
            aria-label={handoffCopyAria}
            aria-busy={handoffCopyPhase === 'pending' ? 'true' : undefined}
            data-pending={handoffCopyPhase === 'pending' ? 'true' : undefined}
            data-copied={handoffCopyPhase === 'copied' ? 'true' : 'false'}
            data-copy-error={handoffCopyPhase === 'failed' ? 'true' : undefined}
          >
            {handoffCopyPhase === 'copied' ? <Check size={13} strokeWidth={2} aria-hidden="true" /> : <Copy size={13} strokeWidth={1.75} aria-hidden="true" />}
            <span>{handoffCopyLabel}</span>
          </button>
        </div>
      )}
    </div>
  );
}

function mergeTools(stored: ToolActivityItem[], live: ToolActivityItem[]): ToolActivityItem[] {
  const byId = new Map(stored.map((item) => [item.toolUseId, item]));
  for (const item of live) byId.set(item.toolUseId, { ...byId.get(item.toolUseId), ...item });
  return [...byId.values()];
}

const noMessagesYet = '暂无消息';

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
    { label: '待发送', sessions: [] },
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
  return formatRelativeTimestamp(session.lastMessageAt);
}
