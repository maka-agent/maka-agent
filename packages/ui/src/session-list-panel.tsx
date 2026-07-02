import { useEffect, useRef, useState, type FocusEvent, type KeyboardEvent, type MouseEvent } from 'react';
import type { PlanReminder, SessionSummary } from '@maka/core';
import { formatRelativeTimestamp } from '@maka/core';
import {
  Archive,
  ArchiveRestore,
  Ban,
  ChevronRight,
  CircleCheckBig,
  Clock,
  Eye,
  Hourglass,
  LineChart,
  Loader2,
  MessageSquare,
  Pencil,
  Pin,
  PinOff,
  Settings,
  ShieldAlert,
  Sparkles,
  SquarePen,
  Trash2,
} from './icons.js';
import type { NavSelection, SessionFilter } from './nav-selection.js';
import type {
  DailyReviewBridge,
  DailyReviewMarkdownActionInput,
  PlanReminderDraftInput,
  PlanReminderUpdatePatch,
  SkillEntry,
} from './module-panel-types.js';
import { EmptyState } from './empty-state.js';
import { OverlayScrollArea } from './overlay-scroll-area.js';
import { Button as UiButton, cn } from './ui.js';
import { cva, type VariantProps } from 'class-variance-authority';

const navRowVariants = cva(
  [
    'min-h-[30px] gap-2 rounded-sm border-0 bg-transparent px-1.5 py-[3px]',
    'text-left text-sm leading-[1.43] text-[var(--foreground-80)]',
    'transition-[background-color,color] duration-[var(--duration-base)] ease-[var(--ease-out-strong)]',
    'hover:bg-foreground/6 hover:text-foreground',
    'data-[active=true]:bg-foreground/9 data-[active=true]:font-semibold data-[active=true]:text-foreground data-[active=true]:shadow-none',
    'data-[active=true]:[&_.maka-nav-icon]:text-foreground',
    '[&_.maka-nav-count]:bg-foreground/6 [&_.maka-nav-count]:text-[var(--foreground-40)]',
    'data-[active=true]:[&_.maka-nav-count]:bg-foreground/8 data-[active=true]:[&_.maka-nav-count]:text-foreground',
    'aria-disabled:cursor-not-allowed aria-disabled:opacity-55 aria-disabled:hover:bg-transparent',
    'data-[disabled=true]:cursor-not-allowed data-[disabled=true]:opacity-55 data-[disabled=true]:hover:bg-transparent',
  ],
  {
    variants: {
      tone: {
        default: '',
        newTask: 'text-foreground [&_.maka-nav-icon]:text-[var(--foreground-70)]',
      },
    },
    defaultVariants: {
      tone: 'default',
    },
  },
);

type NavRowVariants = VariantProps<typeof navRowVariants>;

const settingsButtonClass =
  'w-full min-w-0 gap-2 rounded-sm border-0 bg-transparent px-2 py-1.5 ' +
  'text-left text-sm font-medium text-[var(--foreground-60)] ' +
  'transition-[background-color,color] duration-[var(--duration-base)] ease-[var(--ease-out-strong)] ' +
  'hover:bg-foreground/6 hover:text-foreground';

const rowActionVariants = cva(
  [
    'grid h-[26px] w-[26px] place-items-center rounded-sm border-0 bg-transparent',
    'text-[var(--foreground-60)]',
    'transition-[background-color,color,box-shadow] duration-[var(--duration-quick)] ease-[var(--ease-out-strong)]',
    'hover:bg-foreground/5 hover:text-foreground',
    'focus-visible:outline-none focus-visible:bg-foreground/5 focus-visible:text-foreground focus-visible:ring-[3px] focus-visible:ring-accent/14',
    'disabled:cursor-default disabled:bg-transparent disabled:text-[var(--foreground-40)] disabled:shadow-none',
    'disabled:hover:bg-transparent disabled:hover:text-[var(--foreground-40)]',
    'data-[active=true]:text-accent',
    'data-[pending=true]:cursor-progress data-[pending=true]:bg-foreground/5 data-[pending=true]:text-foreground data-[pending=true]:opacity-78',
  ],
  {
    variants: {
      tone: {
        default: '',
        danger: [
          'hover:bg-destructive/10 hover:text-destructive-text',
          'focus-visible:bg-destructive/10 focus-visible:text-destructive-text focus-visible:ring-destructive/18',
        ],
      },
    },
    defaultVariants: {
      tone: 'default',
    },
  },
);

/**
 * Sidebar module ids. "sessions" is still the lower history region label,
 * but it is no longer rendered as a top-level nav row: "新任务" creates
 * the chat/task, while the history list below shows prior sessions.
 *
 */
type ModuleNavId = NavSelection['section'];

/**
 * Top-level module nav labels. Chinese-first per xuan `47e204f2` #5.
 */
const MODULE_NAV_LABEL: Record<ModuleNavId, string> = {
  sessions: '会话',
  automations: '定时任务',
  skills: '技能',
  'daily-review': '每日回顾',
};

type SessionRowActionId = 'flag' | 'archive' | 'rename' | 'delete';

interface SessionRowActions {
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
  userLabel?: string;
  onNew(): void;
  onOpenSkill?(skillId: string): void;
  onRefreshPlanReminders?(): void | Promise<void>;
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
  sidebarCollapsed?: boolean;
}) {
  // 参考实现 keeps the lower sidebar region as stable chat history
  // even when Skills / Scheduled Tasks are open in the main pane.
  const sessionListTitle = MODULE_NAV_LABEL.sessions;
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

  // PR-PARCHMENT-HOME-9 (WAWQAQ msg `781852eb`): restored module nav
  // helpers. Plan count shows unread reminders as a small chip.
  const isModuleActive = (id: ModuleNavId) => {
    return props.selection.section === id;
  };
  const activePlanReminderCount = (props.planReminders ?? [])
    .filter((reminder) => reminder.status !== 'completed')
    .length;
  function selectModule(id: ModuleNavId) {
    if (id === 'sessions') {
      props.onSelect({ section: 'sessions', filter: 'chats' });
      return;
    }
    if (id === 'automations') props.onSelect({ section: 'automations' });
    else if (id === 'skills') props.onSelect({ section: 'skills' });
    else if (id === 'daily-review') props.onSelect({ section: 'daily-review' });
  }

  return (
    <aside
      className="maka-session-panel agents-sidebar"
      aria-label="对话列表"
      data-collapsed={props.sidebarCollapsed ? 'true' : undefined}
    >
      <header className="maka-session-panel-header">
        <div className="maka-sidebar-drag-strip" />
      </header>

      {/*
        内部参考式 IA: the primary rail is a flat list of actions/modules.
        "会话" is the lower history region, not a second top-level page entry.
      */}
      {/* PR-SIDEBAR-NAV-ROWS-PRIMITIVE-0 (round 13/30): the 4
          main nav rows (新任务 / 每日回顾 / 技能 / 定时任务) were
          all raw <button>. Routed through UiButton with the
          newly-introduced size="nav" variant — `size="nav"`
          contributes no layout utilities so .maka-nav-row's
          tight 30px min-height + 3px 6px padding + 14px font +
          grid-template-columns stays the source of truth. The
          primitive contributes `:active scale` + focus-visible
          + disabled-state contract uniformly with the rest of
          the panel. */}
      <nav className="maka-sidebar-modules" aria-label="主导航">
        <UiButton
          variant="quiet"
          size="nav"
          className={cn('maka-nav-row maka-nav-new-task', navRowVariants({ tone: 'newTask' }))}
          aria-label="新任务"
          type="button"
          onClick={props.onNew}
        >
          <SquarePen className="maka-nav-icon" strokeWidth={1.5} aria-hidden="true" />
          <span>新任务</span>
        </UiButton>
        {/* PR-UI-PIXEL-5 (2026-06-21): the standalone 搜索 nav row was
            removed — search is reachable from the shell topbar button and
            ⌘K/Ctrl+K, so a second entry point was redundant. The `search`
            module id + label are kept for those triggers. */}
        <UiButton
          variant="quiet"
          size="nav"
          className={cn('maka-nav-row', navRowVariants())}
          data-active={isModuleActive('daily-review')}
          aria-current={isModuleActive('daily-review') ? 'page' : undefined}
          aria-label={MODULE_NAV_LABEL['daily-review']}
          type="button"
          onClick={() => selectModule('daily-review')}
        >
          <LineChart className="maka-nav-icon" strokeWidth={1.5} aria-hidden="true" />
          <span>{MODULE_NAV_LABEL['daily-review']}</span>
        </UiButton>
        <UiButton
          variant="quiet"
          size="nav"
          className={cn('maka-nav-row', navRowVariants())}
          data-active={isModuleActive('skills')}
          aria-current={isModuleActive('skills') ? 'page' : undefined}
          aria-label={MODULE_NAV_LABEL.skills}
          type="button"
          onClick={() => selectModule('skills')}
        >
          <Sparkles className="maka-nav-icon" strokeWidth={1.5} aria-hidden="true" />
          <span>{MODULE_NAV_LABEL.skills}</span>
        </UiButton>
        <UiButton
          variant="quiet"
          size="nav"
          className={cn('maka-nav-row', navRowVariants())}
          data-active={isModuleActive('automations')}
          aria-current={isModuleActive('automations') ? 'page' : undefined}
          type="button"
          onClick={() => selectModule('automations')}
          aria-label={activePlanReminderCount > 0 ? `定时任务，${activePlanReminderCount} 个未完成提醒` : MODULE_NAV_LABEL.automations}
        >
          <Clock className="maka-nav-icon" strokeWidth={1.5} aria-hidden="true" />
          <span>{MODULE_NAV_LABEL.automations}</span>
          {activePlanReminderCount > 0 && (
            <small className="maka-nav-count" aria-hidden="true">{activePlanReminderCount}</small>
          )}
        </UiButton>
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

      <section className="maka-session-list" aria-label={sessionListTitle}>
        {props.sessions.length === 0 ? (
          // WAWQAQ msg `f56f38c1` (2026-06-20): the create-session CTA
          // belongs in the sidebar header / nav rail, never in the
          // bottom session-history empty state. The empty state here is
          // pure "no sessions yet" copy — no inline CTA. The top-of-
          // sidebar `+ 新任务` button is the only create-session entry.
          <EmptyState
            Icon={MessageSquare}
            title="等待开始对话"
            body="和 Maka 的对话会出现在这里。"
            extraClassName="maka-session-empty-state"
          />
        ) : (
          <OverlayScrollArea
            className="maka-list-stack"
            viewportClassName="maka-list-stackViewport"
            contentClassName="maka-list-stackContent"
            onKeyDown={handleListKeyDown}
          >
            <SessionListGroups
              groups={
                props.statusGroups
                  ? props.statusGroups.map((g) => ({
                      key: g.id,
                      label: g.label,
                      sessions: g.sessions,
                      collapsible: g.collapsible,
                      defaultExpanded: g.defaultExpanded,
                    }))
                  : groupSessionsForFilter(filteredSessions, { section: 'sessions', filter: 'chats' }).map((g) => ({
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
          </OverlayScrollArea>
        )}
      </section>

      <footer className="maka-session-panel-footer">
        {/* Maka has no account system — the sidebar footer is a thin
            settings affordance only. The earlier `.maka-sidebar-account`
            "Free Plan" widget falsely implied a subscription model and
            was removed per WAWQAQ msg cad3dec4. About / version info
            still reachable via Settings → 关于. */}
        {/* PR-SIDEBAR-SETTINGS-BUTTON-PRIMITIVE-0 (round 4/30):
            was a raw <button>. Route through UiButton so the
            sidebar footer respects the same :active scale,
            hover token, focus-visible, and `data-pressed`
            contract as every other interactive element in
            this panel. The custom class still owns the
            full-width grid layout (24px icon + 1fr label). */}
        <UiButton
          className={cn('maka-sidebar-settings-button', settingsButtonClass)}
          variant="quiet"
          size="nav"
          type="button"
          onClick={props.onOpenSettings}
          aria-label="设置"
          title="设置"
        >
          <Settings className="maka-nav-icon" strokeWidth={1.5} aria-hidden="true" />
          <span>设置</span>
        </UiButton>
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
              /* PR-LIST-GROUP-TOGGLE-PRIMITIVE-0 (round 10/30):
                 disclosure-pattern toggle (aria-expanded +
                 aria-controls). Routed through UiButton so the
                 collapsible group header shares the same
                 focus-visible + `:active` contract as every
                 other interactive surface in the session list. */
              <UiButton
                type="button"
                variant="quiet"
                size="nav"
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
                {/* Collapsed history buckets keep a subdued count so users
                  can tell whether expanding the group is worth it. Open
                  groups intentionally omit counts to keep the rail flat. */}
                <span className="maka-list-group-count">（{group.sessions.length}）</span>
              </UiButton>
            ) : (
              <div className="maka-list-group-label">
                <span>{group.label}</span>
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

// `blocked` was 'destructive' (red), which read as a hard error in the
// chat header even when the session was just waiting on permission or a
// connection retry. The chat top-right cluster sits visually alongside
// monochrome quiet-icon buttons, so the bright red pill clashed. Most
// blocked sessions are recoverable (permission_required, auth retry,
// missing connection), so 'warning' (warm yellow) is the honest tone —
// "you need to do something" rather than "this failed". The destructive
// red is reserved for hard failures (e.g. permanent connection / auth
// rejection), which surface through ChatHeaderAlertBadge instead.
const STATUS_TONE_BY_STATUS = {
  running: 'accent',
  waiting_for_user: 'warning',
  blocked: 'warning',
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
  const rowMountedRef = useRef(true);
  const pendingActionRef = useRef<SessionRowActionId | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  // PR-FE-BUG-HUNT-11: Escape on the rename input has to suppress the
  // blur-fires-on-unmount commit. Without this ref, the sequence
  //   type → Escape → setEditing(false) → input unmounts → blur fires
  //   with the typed value → commitRename(typed) → rename happens
  // would silently commit the user's typed value despite the cancel.
  const escapeCancelledRef = useRef(false);
  const actionBusy = pendingAction !== null;
  const actionTabIndex = actionsVisible ? 0 : -1;

  useEffect(() => {
    rowMountedRef.current = true;
    return () => {
      rowMountedRef.current = false;
      pendingActionRef.current = null;
    };
  }, []);

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
      if (rowMountedRef.current) setPendingAction(null);
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
              onBlur={(event) => {
                // PR-FE-BUG-HUNT-11: skip the commit when the blur was
                // caused by Escape cancelling edit mode (input unmounts
                // → blur fires with the typed value otherwise).
                if (escapeCancelledRef.current) {
                  escapeCancelledRef.current = false;
                  return;
                }
                commitRename(event.currentTarget.value);
              }}
              onKeyDown={(event) => {
                // IME guard so committing CJK characters with Enter doesn't
                // submit the rename before the user is done.
                if (event.nativeEvent.isComposing || event.key === 'Process') return;
                if (event.key === 'Escape') {
                  event.preventDefault();
                  escapeCancelledRef.current = true;
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
        /* PR-SESSION-ROW-MAIN-PRIMITIVE-0 (round 14/30): the
           single most-clicked button in the app — every session
           row's main click target. Routed through UiButton with
           size="nav" (round-12 enabler) so the bespoke
           `.maka-list-row-main` density (32-40px height, custom
           padding, grid layout with text/meta columns) stays the
           source of truth, while the primitive contributes the
           shared `:active scale`, focus-visible, and
           disabled-state contract. */
        <UiButton
          variant="quiet"
          size="nav"
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
        </UiButton>
      )}
      {actions && !editing && (
        <div
          className="maka-list-row-actions"
          aria-label="对话操作"
          aria-hidden={actionsVisible ? undefined : 'true'}
          data-visible={actionsVisible ? 'true' : undefined}
        >
          {/* PR-SESSION-ROW-ACTIONS-PRIMITIVE-0 (round 8/30):
              four hover-revealed action buttons routed through
              UiButton variant="quiet" size="icon-sm". Custom
              `.maka-list-row-action` still owns the overlay
              positioning + reveal animation; primitive carries
              the disabled, focus-visible, and `:active` contract.
              The danger variant only adds a destructive color
              tint via class override, not a different primitive
              variant — keeps the overlay shape uniform. */}
          <UiButton
            type="button"
            variant="quiet"
            size="nav"
            className={cn('maka-list-row-action', rowActionVariants())}
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
          </UiButton>
          <UiButton
            type="button"
            variant="quiet"
            size="nav"
            className={cn('maka-list-row-action', rowActionVariants())}
            tabIndex={actionTabIndex}
            onClick={startRename}
            aria-label="重命名对话"
            aria-busy={pendingAction === 'rename' ? 'true' : undefined}
            data-pending={pendingAction === 'rename' ? 'true' : undefined}
            disabled={actionBusy}
            title="重命名（双击行名也可）"
          >
            <Pencil size={14} strokeWidth={1.75} aria-hidden="true" />
          </UiButton>
          <UiButton
            type="button"
            variant="quiet"
            size="nav"
            className={cn('maka-list-row-action', rowActionVariants())}
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
          </UiButton>
          <UiButton
            type="button"
            variant="quiet"
            size="nav"
            className={cn('maka-list-row-action', rowActionVariants({ tone: 'danger' }))}
            tabIndex={actionTabIndex}
            onClick={handleDelete}
            aria-label="删除对话"
            aria-busy={pendingAction === 'delete' ? 'true' : undefined}
            data-pending={pendingAction === 'delete' ? 'true' : undefined}
            disabled={actionBusy}
            title="删除"
          >
            <Trash2 size={14} strokeWidth={1.75} aria-hidden="true" />
          </UiButton>
        </div>
      )}
    </div>
  );
}

interface SessionGroup {
  label: string;
  sessions: SessionSummary[];
}

const noMessagesYet = '暂无消息';

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
