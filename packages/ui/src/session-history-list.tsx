import { memo, useEffect, useRef, useState, type FocusEvent, type KeyboardEvent } from 'react';
import type { SessionSummary } from '@maka/core';
import { formatCompactTimestamp } from '@maka/core';
import {
  Archive,
  ArchiveRestore,
  Ban,
  ChevronRight,
  CircleCheckBig,
  Eye,
  FolderOpen,
  Hourglass,
  Loader2,
  MessageSquare,
  MoreHorizontal,
  Pencil,
  Pin,
  PinOff,
  ShieldAlert,
  Trash2,
} from './icons.js';
import { EmptyState } from './empty-state.js';
import { OverlayScrollArea } from './overlay-scroll-area.js';
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from './primitives/menu.js';
import { Button as UiButton } from './ui.js';

type SessionRowActionId = 'flag' | 'archive' | 'rename' | 'delete';
type SessionHistoryGroupVariant = 'status' | 'project';
const PROJECT_GROUP_PREVIEW_LIMIT = 4;

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

export interface SessionHistoryStatusGroup {
  id: string;
  label: string;
  sessions: SessionSummary[];
  collapsible: boolean;
  defaultExpanded: boolean;
}

export function SessionHistoryList(props: {
  sessions: SessionSummary[];
  activeId?: string;
  /**
   * Per-session-id boolean flag: true when the session has a live streaming
   * delta in flight. Rendered as a small pulsing accent dot on the row.
   * Caller derives this from the live-turn projection so the sidebar
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
  statusGroups?: ReadonlyArray<SessionHistoryStatusGroup>;
  groupVariant?: SessionHistoryGroupVariant;
  onSelectSession(sessionId: string): void;
  rowActions?: SessionRowActions;
}) {
  // 参考实现 keeps the lower sidebar region as stable chat history
  // even when Skills / Scheduled Tasks are open in the main pane.
  const sessionListTitle = '会话';
  // PR-UX-POLISH-1 commit 4 (WAWQAQ msg `e0dbad11` + kenji msg
  // `2844f64f`): in-list `筛选会话` filter input removed. All search
  // capability lives in the top-level `搜索` modal (PR-SEARCH-MODAL-
  // REAL-0 wires it to `window.maka.search.thread()` in the same PR).
  // The previous `searchQuery` state + `searchInputRef` + ⌘F/Ctrl+F
  // focus binding are gone with it; ⌘F is freed for future use.
  // `filteredSessions` collapses to a direct passthrough of
  // `props.sessions` — group rendering downstream still partitions
  // by status / time / filter.

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

  return (
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
                : groupSessionsForHistory(props.sessions).map((g) => ({
                    key: g.label,
                    label: g.label,
                    sessions: g.sessions,
                    collapsible: false,
                    defaultExpanded: true,
                  }))
            }
            groupVariant={props.groupVariant ?? 'status'}
            activeId={props.activeId}
            streamingSessionIds={props.streamingSessionIds}
            staleSessionIds={props.staleSessionIds}
            onSelectSession={props.onSelectSession}
            rowActions={props.rowActions}
          />
        </OverlayScrollArea>
      )}
    </section>
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
  groupVariant: SessionHistoryGroupVariant;
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
        if (props.groupVariant === 'project') {
          return (
            <ProjectSessionGroup
              key={group.key}
              groupKey={group.key}
              label={group.label}
              sessions={group.sessions}
              activeId={props.activeId}
              streamingSessionIds={props.streamingSessionIds}
              staleSessionIds={props.staleSessionIds}
              onSelectSession={props.onSelectSession}
              rowActions={props.rowActions}
            />
          );
        }
        return (
          <div key={group.key} className="maka-list-group" data-variant="status" data-collapsible={group.collapsible || undefined}>
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

function ProjectSessionGroup(props: {
  groupKey: string;
  label: string;
  sessions: SessionSummary[];
  activeId?: string;
  streamingSessionIds?: Set<string>;
  staleSessionIds?: Set<string>;
  onSelectSession(sessionId: string): void;
  rowActions?: SessionRowActions;
}) {
  const [revealed, setRevealed] = useState(false);
  const [expanded, setExpanded] = useState(true);
  const activeIsHidden = props.activeId
    ? props.sessions.findIndex((session) => session.id === props.activeId) >= PROJECT_GROUP_PREVIEW_LIMIT
    : false;
  const showAll = revealed || activeIsHidden;
  const visibleSessions = showAll
    ? props.sessions
    : props.sessions.slice(0, PROJECT_GROUP_PREVIEW_LIMIT);
  const hiddenCount = props.sessions.length - visibleSessions.length;

  return (
    <div className="maka-list-group" data-variant="project">
      <UiButton
        type="button"
        variant="quiet"
        size="nav"
        className="maka-list-project-heading"
        onClick={() => setExpanded((current) => !current)}
        aria-expanded={expanded}
        aria-controls={`maka-list-group-body-${props.groupKey}`}
      >
        <FolderOpen size={14} aria-hidden="true" />
        <span>{props.label}</span>
      </UiButton>
      {expanded && (
        <>
          <div id={`maka-list-group-body-${props.groupKey}`}>
            {visibleSessions.map((session) => (
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
          {hiddenCount > 0 && (
            <UiButton
              type="button"
              variant="quiet"
              size="nav"
              className="maka-list-project-more"
              onClick={() => setRevealed(true)}
              aria-label={`显示 ${hiddenCount} 条更多对话`}
            >
              显示更多
            </UiButton>
          )}
        </>
      )}
    </div>
  );
}

/**
 * Small inline icon next to the session name representing its
 * lifecycle status. Hidden for `active`
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
      <Icon size={12} aria-hidden="true" />
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

const SessionRow = memo(function SessionRow(props: {
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
  const [menuOpen, setMenuOpen] = useState(false);
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
  const actionTriggerVisible = actionsVisible || menuOpen;

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

  function startRename() {
    if (!actions || pendingActionRef.current) return;
    setEditing(true);
  }

  function runRowAction(actionId: SessionRowActionId, action: () => void | Promise<void>) {
    if (pendingActionRef.current) return;
    pendingActionRef.current = actionId;
    setPendingAction(actionId);
    void (async () => {
      try {
        await action();
      } catch {
        // The AppShell row-action owner reports the visible failure toast.
      } finally {
        pendingActionRef.current = null;
        if (rowMountedRef.current) setPendingAction(null);
      }
    })();
  }

  function commitRename(rawValue: string) {
    const trimmed = rawValue.trim();
    setEditing(false);
    if (!trimmed || trimmed === session.name) return;
    if (!actions) return;
    runRowAction('rename', () => actions.onRename(session.id, trimmed));
  }

  function handleDelete() {
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
      data-menu-open={menuOpen ? 'true' : undefined}
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
        <Menu open={menuOpen} onOpenChange={setMenuOpen}>
          <MenuTrigger
            aria-label="对话操作"
            aria-hidden={actionTriggerVisible ? undefined : 'true'}
            className="maka-list-row-menu-trigger"
            data-visible={actionTriggerVisible ? 'true' : undefined}
            disabled={actionBusy}
            tabIndex={actionTriggerVisible ? 0 : -1}
          >
            <MoreHorizontal size={16} aria-hidden="true" />
          </MenuTrigger>
          <MenuPopup align="end" side="bottom">
            <MenuItem
              disabled={actionBusy}
              onClick={() => runRowAction('flag', () => actions.onToggleFlag(session.id, !session.isFlagged))}
            >
              {session.isFlagged
                ? <PinOff size={16} aria-hidden="true" />
                : <Pin size={16} aria-hidden="true" />}
              {session.isFlagged ? '取消置顶' : '置顶'}
            </MenuItem>
            <MenuItem disabled={actionBusy} onClick={startRename}>
              <Pencil size={16} aria-hidden="true" />
              重命名
            </MenuItem>
            <MenuItem
              disabled={actionBusy}
              onClick={() => runRowAction('archive', () => (
                session.isArchived
                  ? actions.onUnarchive(session.id)
                  : actions.onArchive(session.id)
              ))}
            >
              {session.isArchived
                ? <ArchiveRestore size={16} aria-hidden="true" />
                : <Archive size={16} aria-hidden="true" />}
              {session.isArchived ? '取消归档' : '归档'}
            </MenuItem>
            <MenuSeparator />
            <MenuItem
              variant="destructive"
              disabled={actionBusy}
              onClick={handleDelete}
            >
              <Trash2 size={16} aria-hidden="true" />
              删除
            </MenuItem>
          </MenuPopup>
        </Menu>
      )}
    </div>
  );
});

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
function groupSessionsForHistory(sessions: SessionSummary[]): SessionGroup[] {
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
  return formatCompactTimestamp(session.lastMessageAt);
}
