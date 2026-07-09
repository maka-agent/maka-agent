import { Fragment, lazy, memo, Suspense, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  AlertOctagon,
  AlertTriangle,
  ArrowDown,
  Ban,
  BookOpen,
  Brain,
  CalendarDays,
  Check,
  ChevronRight,
  Copy,
  GitBranch,
  Info,
  Loader2,
  RefreshCcw,
  Sparkles,
} from './icons.js';
import { DeepResearchEmptyHero, EmptyChatHero } from './chat-empty-hero.js';
import { type ClipboardCopyPhase, useClipboardCopyFeedback } from './clipboard-feedback.js';
import { Markdown } from './markdown.js';
import { formatAbsoluteTimestamp, formatClockTime, turnAbortMarkerLabel } from './chat-display-helpers.js';
import type { ChatModelChoice } from './chat-model-helpers.js';
import { prepareSmoothStreamText, useSmoothStreamContent } from './smooth-stream.js';
import { tokenizeFade, useStreamFade, type StreamFade } from './stream-fade.js';
import { OverlayScrollArea } from './overlay-scroll-area.js';
import { DialogContent, DialogRoot } from './ui.js';
import { PromptAnchorRail } from './prompt-anchor-rail.js';
import type { AttachmentRef, PlanReminder, ProviderType, SessionSummary, StoredMessage } from '@maka/core';
import { deriveCapabilityAuditReport, isDeepResearchSession } from '@maka/core';
import { materializeChat, materializeTools, materializeTurns, type ToolActivityItem, type TurnTimelineItem, type TurnViewModel } from './materialize.js';
import { Button as UiButton } from './ui.js';
import { AttachmentFileCard } from './attachment-file-card.js';
import { Alert, AlertDescription } from './primitives/alert.js';
import { Collapsible, CollapsibleTrigger, CollapsiblePanel } from './primitives/collapsible.js';
import { Bubble, Marker, markerVariants, Message, TextShimmer } from './primitives/chat.js';
import { Tooltip, TooltipTrigger, TooltipContent } from './primitives/tooltip.js';
import type { NavSelection } from './nav-selection.js';
import { EmptyState } from './empty-state.js';
import type {
  DailyReviewBridge,
  DailyReviewMarkdownActionInput,
  ManagedSkillSourceEntry,
  ManagedSkillUpdatePreview,
  PlanReminderDraftInput,
  PlanReminderUpdatePatch,
  SkillEntry,
} from './module-panel-types.js';
// The Skills / Automations / Daily-Review surfaces are whole nav sections of
// their own — they only render when `mode` flips to `skills` / `automations` /
// `daily-review`, never on the default chat first paint. Loading them lazily
// keeps their code (incl. the base-ui Select primitive they pull in) out of
// the initial chunk so the chat shell mounts faster.
const SkillsModuleMain = lazy(() => import('./skills-panel.js').then((m) => ({ default: m.SkillsModuleMain })));
const DailyReviewPanel = lazy(() => import('./daily-review-panel.js').then((m) => ({ default: m.DailyReviewPanel })));
const PlanReminderPanel = lazy(() => import('./plan-reminder-panel.js').then((m) => ({ default: m.PlanReminderPanel })));

function ModulePageFallback(props: { label: string; message: string }) {
  return (
    <main className="maka-main detailPane maka-module-main agents-chat-panel" aria-label={props.label}>
      <div className="maka-lazy-fallback" data-surface="module" role="status" aria-busy="true">
        {props.message}
      </div>
    </main>
  );
}

function ModulePanelFallback(props: { message: string }) {
  return (
    <div className="maka-lazy-fallback" data-surface="module" role="status" aria-busy="true">
      {props.message}
    </div>
  );
}
import { ToolTrow } from './tool-activity.js';

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





const SCROLL_BOTTOM_THRESHOLD = 64; // px

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
  messageLoading?: boolean;
  streamingText: string;
  /** True after upstream emitted the final assistant text, while the UI is draining the smoother. */
  streamingComplete?: boolean;
  /** Assistant message id hidden while the matching streaming bubble drains. */
  streamingMessageId?: string;
  /** Called once the streaming bubble has displayed the final text and can hand off to history. */
  onStreamingSettled?(): void;
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
  activeModel?: string;
  activeModelLabel?: string;
  /** Renders a provider brand mark next to the model name in the chat tab. */
  activeProviderType?: ProviderType;
  /** Optional renderer for the provider mark; supplied by the desktop app to
   *  avoid bringing the full provider SVG library into @maka/ui. */
  renderProviderMark?(type: ProviderType): ReactNode;
  modelChoices?: ChatModelChoice[];
  modelChangePending?: boolean;
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
  onOpenSkillsFolder?(): void | Promise<void>;
  managedSkillSources?: ManagedSkillSourceEntry[];
  onRefreshManagedSkillSources?(): void | Promise<void>;
  onImportManagedSkillSource?(): void | Promise<void>;
  onInstallManagedSkill?(sourceId: string): void | Promise<void>;
  onPreviewManagedSkillUpdate?(skillId: string): Promise<ManagedSkillUpdatePreview | null>;
  onUpdateManagedSkill?(skillId: string, options?: { force?: boolean; expectedCurrentSha256?: string; expectedSourceSha256?: string }): boolean | Promise<boolean>;
  onSetSkillEnabled?(skillId: string, enabled: boolean): void | Promise<void>;
  planReminders?: PlanReminder[];
  onRefreshPlanReminders?: () => void | Promise<void>;
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
}) {
  // chat + storedTools survive for the empty-state and streaming-bubble
  // paths; the main message log is now driven by `turns` (per @kenji UI-04
  // turn-grouping projection).
  // Memoized derivation chain (vercel rerender rules): during PLAIN-TEXT
  // streaming — the hottest path, dozens of state updates per second —
  // `messages` and `tools` don't change, so every turn object keeps its
  // identity and the memoized TurnViews below skip re-rendering entirely.
  // Tool-activity updates legitimately invalidate the chain.
  const visibleMessages = useMemo(
    () =>
      props.streamingComplete && props.streamingMessageId
        ? props.messages.filter((message) => !(message.type === 'assistant' && message.id === props.streamingMessageId))
        : props.messages,
    [props.messages, props.streamingComplete, props.streamingMessageId],
  );
  const chat = useMemo(() => materializeChat(visibleMessages), [visibleMessages]);
  const storedTools = useMemo(() => materializeTools(visibleMessages), [visibleMessages]);
  const tools = useMemo(() => mergeTools(storedTools, props.tools), [storedTools, props.tools]);
  const turns = useMemo(() => materializeTurns(visibleMessages, props.tools), [visibleMessages, props.tools]);
  // #642 single render path: the in-flight answer is injected into the tail
  // turn's TurnView (the SAME node as the eventual committed turn) instead of a
  // separate streaming <section>, so live→settled is a data-source swap, not an
  // unmount/mount. The streaming turn is always the last turn: the user message
  // is committed optimistically (showOptimisticUserMessage) before streaming
  // starts, so `materializeTurns` already emits it — with an empty assistant
  // timeline — as `turns[last]`. Only the tail TurnView gets a fresh
  // `liveStreaming` object per delta (→ it alone re-renders); every sibling
  // gets a stable `undefined` and its memo skips (the plain-text perf path).
  // A turn is "still live" — and must keep its non-actionable footer placeholder
  // instead of a clickable regenerate/branch — while ANY of text, thinking, OR a
  // tool is in flight. Deriving liveness from streamingText/thinkingText alone
  // let a tool-only step (tool_start with no answer text yet) fall through to the
  // settled branch, whose derived status is `completed`, rendering an actionable
  // footer on a still-running answer (review P2-B). LiveStreamingEntries already
  // no-ops when text and thinking are both empty, so a tool-only tail renders the
  // running tool from its timeline with no empty live bubble.
  const hasInFlightTool = props.tools.some(
    (tool) =>
      tool.status === 'running' || tool.status === 'pending' || tool.status === 'waiting_permission',
  );
  const streamingActive = !!(props.streamingText || props.thinkingText || hasInFlightTool);
  const tailTurnId = streamingActive ? turns[turns.length - 1]?.turnId : undefined;
  // One rail tick per turn that carries a user prompt (Codex-style prompt
  // navigation). Memoized so the rail's IntersectionObserver isn't rebuilt
  // on every render.
  const promptRailTurns = useMemo(
    () =>
      turns
        .filter((turn) => (turn.user?.text ?? '').trim().length > 0)
        .map((turn) => ({
          turnId: turn.turnId,
          label: turn.user?.text ?? '',
          reply: turn.assistant?.text ?? '',
        })),
    [turns],
  );
  // Stable event wrappers (advanced-use-latest): parent handlers are
  // recreated per render upstream; routing through refs keeps the
  // memoized TurnView's function props identity-stable without
  // demanding useCallback discipline from every caller.
  const onTurnFooterActionRef = useRef(props.onTurnFooterAction);
  onTurnFooterActionRef.current = props.onTurnFooterAction;
  const stableTurnFooterAction = useCallback(
    (turnId: string, actionId: TurnFooterActionMeta['id']) => onTurnFooterActionRef.current?.(turnId, actionId),
    [],
  );
  const onLineageBadgeClickRef = useRef(props.onLineageBadgeClick);
  onLineageBadgeClickRef.current = props.onLineageBadgeClick;
  const stableLineageBadgeClick = useCallback(
    (targetTurnId: string) => onLineageBadgeClickRef.current?.(targetTurnId),
    [],
  );
  const capabilityAuditReport = useMemo(
    () => deriveCapabilityAuditReport({
      skills: props.skills ?? [],
      planReminders: props.planReminders ?? [],
    }),
    [props.skills, props.planReminders],
  );
  const scrollRef = useRef<HTMLDivElement>(null);
  const [pinnedToBottom, setPinnedToBottom] = useState(true);
  const [highlightedTurnId, setHighlightedTurnId] = useState<string | null>(null);

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
      const targetEl = el as HTMLElement;
      targetEl.setAttribute('tabindex', '-1');
      targetEl.scrollIntoView({
        behavior: props.scrollBehavior ?? 'smooth',
        block: 'center',
      });
      targetEl.focus({ preventScroll: true });
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
    el.scrollTo({ top: el.scrollHeight, behavior: props.scrollBehavior ?? 'smooth' });
    setPinnedToBottom(true);
  }

  if (props.mode === 'skills') {
    return (
      <Suspense fallback={<ModulePageFallback label="技能" message="正在加载技能…" />}>
        <SkillsModuleMain
          skills={props.skills}
          auditReport={capabilityAuditReport}
          onRefreshSkills={props.onRefreshSkills}
          onCreateSkillTemplate={props.onCreateSkillTemplate}
          onOpenSkill={props.onOpenSkill}
          onOpenSkillsFolder={props.onOpenSkillsFolder}
          managedSkillSources={props.managedSkillSources}
          onRefreshManagedSkillSources={props.onRefreshManagedSkillSources}
          onImportManagedSkillSource={props.onImportManagedSkillSource}
          onInstallManagedSkill={props.onInstallManagedSkill}
          onPreviewManagedSkillUpdate={props.onPreviewManagedSkillUpdate}
          onUpdateManagedSkill={props.onUpdateManagedSkill}
          onSetSkillEnabled={props.onSetSkillEnabled}
        />
      </Suspense>
    );
  }

  if (props.mode === 'automations') {
    return (
      <Suspense fallback={<ModulePageFallback label="定时任务" message="正在加载定时任务…" />}>
        <main className="maka-main detailPane maka-module-main agents-chat-panel" aria-label="定时任务">
          <PlanReminderPanel
            reminders={props.planReminders ?? []}
            auditReport={capabilityAuditReport}
            onRefresh={props.onRefreshPlanReminders}
            onCreate={props.onCreatePlanReminder}
            onUpdate={props.onUpdatePlanReminder}
            onToggle={props.onTogglePlanReminder}
            onTriggerNow={props.onTriggerPlanReminderNow}
            onSnooze={props.onSnoozePlanReminder}
            onClearRunHistory={props.onClearPlanReminderRunHistory}
            onDelete={props.onDeletePlanReminder}
          />
        </main>
      </Suspense>
    );
  }

  if (props.mode === 'daily-review') {
    return (
      <main
        className="maka-main detailPane maka-module-main agents-chat-panel"
        data-module="daily-review"
        aria-label="每日回顾"
      >
        <header className="maka-module-main-header">
          <div>
            <h2>每日回顾</h2>
            <p>自动汇总本机对话，生成摘要、遗漏提醒与深度分析；可在设置中开启定时执行。</p>
          </div>
        </header>
        {props.dailyReviewBridge ? (
          <Suspense fallback={<ModulePanelFallback message="正在加载每日回顾…" />}>
            <DailyReviewPanel
              bridge={props.dailyReviewBridge}
              onSelectSession={props.onSelectSession}
              onCopyMarkdown={props.onCopyDailyReviewMarkdown}
              onAppendMarkdown={props.onAppendDailyReviewMarkdown}
              onSaveMarkdown={props.onSaveDailyReviewMarkdown}
            />
          </Suspense>
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

  if (!props.activeSession) {
    return (
      <main className="maka-main detailPane agents-chat-panel agents-chat-view-root">
        {/* PR-REMOVE-CHAT-TAB (WAWQAQ msg d401938d 2026-06-23): the
            browser-style session tab + the duplicate "新建对话" plus
            button were removed. The session name lives in the sidebar;
            the new-task button at the top of the sidebar is the
            canonical create-session entry point. The chat header
            keeps the permission-mode switcher only. */}
        {/* PR-MOVE-PERMISSION-MODE: chat header no longer carries the
            permission-mode chips — the picker lives inside the composer's
            left controls so the new-session screen and active-session
            screen share the same "create / pick mode / send" rhythm. */}
        <header className="maka-chat-header" data-empty="true">
          <span className="maka-chat-header-spacer" />
        </header>
        <OverlayScrollArea
          className="maka-chat messages"
          viewportClassName="maka-chatViewport"
          contentClassName="maka-chatContent"
        >
          {props.emptyOverride ?? <EmptyChatHero onPromptSuggestion={props.onPromptSuggestion} userLabel={props.userLabel} />}
        </OverlayScrollArea>
      </main>
    );
  }

  const isLocalSimulationBackend = props.activeSession.backend === 'fake';
  const deepResearchActive = isDeepResearchSession(props.activeSession.labels);

  return (
    <main className="maka-main detailPane agents-chat-panel agents-chat-view-root">
      {/* PR-REMOVE-CHAT-TAB (WAWQAQ msg d401938d): no more browser-style
          session tab in the chat header. Session name + model live in
          the sidebar; the new-task button at the top of the sidebar is
          the canonical create-session entry. The chat header is now
          just a thin chrome strip carrying the permission-mode
          switcher and the per-session memory/mode chips. */}
      <header className="maka-chat-header">
        <span className="maka-chat-header-spacer" />
        {props.memoryActive && (
          /* PR-CHAT-HEADER-MEMORY-PILL-PRIMITIVE-0 (round 11/30):
             accent-tinted memory indicator pill in the chat
             header was a raw <button>. Routed through UiButton
             variant="quiet" — the bespoke `.maka-chat-header-
             memory-pill` class still owns the pill's tinted
             background, 999px border-radius, 11px font, and
             accent border. */
          <UiButton
            type="button"
            variant="quiet"
            className="maka-chat-header-memory-pill"
            data-active="true"
            onClick={() => props.onOpenMemorySettings?.()}
            title="本地 MEMORY.md 已加入 agent 系统提示。点击进入设置 · 记忆 管理。"
            aria-label="本地记忆已启用"
          >
            <BookOpen size={12} aria-hidden="true" />
            <span>记忆</span>
          </UiButton>
        )}
        {deepResearchActive && (
          <span
            className="maka-chat-header-mode-pill"
            data-mode="deep-research"
            title="深度研究会话使用只读探索边界：先阅读和分析，默认不改文件。"
            aria-label="深度研究，只读探索"
          >
            <Sparkles size={12} aria-hidden="true" />
            <span>深度研究</span>
          </span>
        )}
        {/* PR-MOVE-PERMISSION-MODE: switcher relocated into the
            composer left-controls. Header keeps the per-session status
            chips only. */}
      </header>
      {/* In normal flow below the header (see .maka-chat-status-cluster)
          so wrapped multi-badge rows reserve space before banners and
          messages. ALWAYS mounted (even with zero badges): the cluster
          collapses/expands via the CSS `:empty` height transition instead of
          conditional mount/unmount — unmounting it when a run completes used
          to snap the whole conversation column up by the badge-row height in
          a single frame (the settle "jump"). */}
      <div className="maka-chat-status-cluster">
        {props.sessionStatusBadge && <SessionStatusBadge badge={props.sessionStatusBadge} />}
        {props.connectionAlert && <ChatHeaderAlertBadge alert={props.connectionAlert} />}
        {props.eventStreamAlert && <ChatHeaderAlertBadge alert={props.eventStreamAlert} />}
      </div>
      {isLocalSimulationBackend && (
        <Alert variant="info" className="maka-fake-backend-banner" role="status">
          <AlertTriangle size={14} aria-hidden="true" />
          <AlertDescription>
            当前会话来自旧的本地模拟连接。要拿到真实 LLM 回复，请到 <strong>设置 · 模型</strong> 添加 Anthropic / OpenAI / GLM 等 API key。
          </AlertDescription>
        </Alert>
      )}
      <div className="maka-chat-shell">
        {props.branchBanner && (
          <SessionBranchBanner
            banner={props.branchBanner}
            onClick={props.onBranchBannerClick}
          />
        )}
        <OverlayScrollArea
          ref={scrollRef}
          className="maka-chat messages"
          viewportClassName="maka-chatViewport"
          contentClassName="maka-chatContent"
          onScroll={onScroll}
        >
          {chat.length === 0 && !props.streamingText && (
            props.messageLoading ? null : props.messageLoadError ? (
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
          {turns.map((turn) => {
            return (
              <TurnView
                key={turn.turnId}
                turn={turn}
                userLabel={props.userLabel}
                footerActions={props.turnFooterActionsByTurn?.[turn.turnId]}
                onFooterAction={stableTurnFooterAction}
                failedReasonLabel={props.turnFailedReasonLabels?.[turn.turnId]}
                failedRecoveryLabel={props.turnFailedRecoveryLabels?.[turn.turnId]}
                lineageBadges={props.turnLineageBadgesByTurn?.[turn.turnId]}
                onLineageBadgeClick={stableLineageBadgeClick}
                searchHighlighted={highlightedTurnId === turn.turnId}
                liveStreaming={
                  turn.turnId === tailTurnId
                    ? {
                        streamingText: props.streamingText ?? '',
                        thinkingText: props.thinkingText,
                        streamingComplete: props.streamingComplete,
                        streamingTruncated: props.streamingTruncated,
                        thinkingTruncated: props.thinkingTruncated,
                        onStreamingSettled: props.onStreamingSettled,
                      }
                    : undefined
                }
              />
            );
          })}
          {/* #642 fallback: streaming began before the optimistic user turn
              materialized (rare — e.g. an event replay while messages are still
              loading), so there is no tail turn to inject into. Render the live
              answer in a bare `.maka-turn` so it isn't dropped. Mutually
              exclusive with the tail injection above (only fires when
              `tailTurnId` is undefined), so the answer never double-renders. */}
          {streamingActive && !tailTurnId && (
            <section className="maka-turn" data-live-streaming="true">
              <Message variant="assistant" className="group/answer">
                <div className="flex flex-col gap-2">
                  <LiveStreamingEntries
                    streamingText={props.streamingText ?? ''}
                    thinkingText={props.thinkingText}
                    streamingComplete={props.streamingComplete}
                    streamingTruncated={props.streamingTruncated}
                    thinkingTruncated={props.thinkingTruncated}
                    onStreamingSettled={props.onStreamingSettled}
                  />
                </div>
                <div aria-hidden="true" className="mt-0.5 h-8" />
              </Message>
            </section>
          )}
          {/* Defensive: if any tool ended up outside a turn (e.g. legacy
              sessions without turnId), render those at the very end so they
              still appear instead of vanishing. materializeTurns already
              folds these into the `__loose` turn, so this is normally a
              no-op. */}
        </OverlayScrollArea>
        <PromptAnchorRail turns={promptRailTurns} scrollRef={scrollRef} />
        {!pinnedToBottom && (
          <UiButton
            type="button"
            className="maka-chat-jump-bottom"
            variant="secondary"
            size="icon-sm"
            onClick={scrollToBottom}
            aria-label="跳到最新消息"
          >
            <ArrowDown size={16} aria-hidden="true" />
          </UiButton>
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
function AttachmentImage(props: { attachment: AttachmentRef }) {
  const [src, setSrc] = useState<string | undefined>(undefined);
  const [lightboxOpen, setLightboxOpen] = useState(false);
  useEffect(() => {
    if (props.attachment.ref.kind !== 'session_file') return;
    const reader = (window as unknown as {
      maka?: {
        attachments?: {
          readBytes?: (
            sessionId: string,
            relativePath: string,
          ) => Promise<{ ok: true; base64: string; mimeType: string } | { ok: false }>;
        };
      };
    }).maka?.attachments?.readBytes;
    if (!reader) return;
    let cancelled = false;
    reader(props.attachment.ref.sessionId, props.attachment.ref.relativePath)
      .then((result) => {
        if (cancelled || !result.ok) return;
        setSrc(`data:${result.mimeType};base64,${result.base64}`);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [props.attachment]);
  if (!src) {
    return (
      <span className="maka-user-attachment-thumb-pending h-32 w-32 rounded-lg border border-border bg-muted grid place-items-center text-muted-foreground/60" aria-hidden="true">
        <Loader2 className="h-5 w-5 animate-spin" />
      </span>
    );
  }
  return (
    <>
      <button
        type="button"
        className="group relative inline-flex rounded-lg overflow-hidden border border-border transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
        onClick={() => setLightboxOpen(true)}
        aria-label={`查看图片 ${props.attachment.name}`}
      >
        <img className="h-32 w-32 object-cover transition group-hover:opacity-90" src={src} alt={props.attachment.name} />
      </button>
      <DialogRoot open={lightboxOpen} onOpenChange={setLightboxOpen}>
        <DialogContent className="!w-auto !max-w-[90vw] !max-h-[90vh] !bg-transparent !p-0 !shadow-none !rounded-lg overflow-visible">
          <img className="max-h-[90vh] max-w-[90vw] object-contain rounded-lg shadow-2xl" src={src} alt={props.attachment.name} />
        </DialogContent>
      </DialogRoot>
    </>
  );
}

const MessageBody = memo(function MessageBody(props: { role: string; text: string; ts?: number; attachments?: readonly AttachmentRef[] }) {
  if (props.role === 'user') {
    // User turn: the message sits in a tinted, width-capped block aligned to
    // the right (so the right-anchor reads even for long messages), with an
    // absolute HH:mm time + a copy affordance in a meta row beneath it. #642:
    // the whole meta row is hover-gated on the user bubble (`group/usermsg`) —
    // hidden at rest, revealed on hover / focus-within, matching the assistant
    // footer's hover reveal. Copy reuses MessageCopyButton in `footerStyle`, so
    // it's the same quiet ghost action as the assistant turn footer's copy
    // (same primitive + `markerVariants('footer-action')`).
    return (
      <>
        <Bubble variant="user">
          <span>{props.text}</span>
          {props.attachments && props.attachments.length > 0 ? (
            <div className="maka-user-attachments flex flex-wrap gap-1.5 mt-2">
              {props.attachments.map((attachment, index) => (
                attachment.kind === 'image' ? (
                  <AttachmentImage key={`${attachment.name}-${index}`} attachment={attachment} />
                ) : (
                  <AttachmentFileCard
                    key={`${attachment.name}-${index}`}
                    name={attachment.name}
                    kind={attachment.kind}
                    size={attachment.bytes}
                  />
                )
              ))}
            </div>
          ) : null}
        </Bubble>
        {/* #642: the whole meta row — absolute HH:mm time + copy — hides by
            default and appears when the user bubble is hovered or keyboard
            focus lands inside (keys off `group/usermsg` on the user Message).
            Absolute wall-clock time (not relative "N 小时前"); the full date
            stays on the time's `title` and the bubble's own `title`. */}
        <div className="maka-message-meta opacity-0 [transition:opacity_var(--duration-quick)_var(--ease-out-strong)] group-hover/usermsg:opacity-100 focus-within:opacity-100">
          {props.ts !== undefined && (
            <small
              className="maka-message-time-inline tabular-nums"
              aria-hidden="true"
              title={formatAbsoluteTimestamp(props.ts)}
            >
              {formatClockTime(props.ts)}
            </small>
          )}
          <MessageCopyButton text={props.text} footerStyle />
        </div>
      </>
    );
  }
  // Assistant / system body: open prose, no bubble. Per-turn meta (model ·
  // duration · cost) lives in the footer's info tooltip; copy + the other
  // actions live in the turn footer.
  return (
    <Bubble variant="assistant" className="maka-bubble-with-actions">
      <Markdown text={props.text} />
    </Bubble>
  );
});

function MessageCopyButton(props: { text: string; label?: string; footerStyle?: boolean }) {
  const copyFeedback = useClipboardCopyFeedback(1400, { redact: false });
  const copyPhase = copyFeedback.phaseFor('message');
  const copyPending = copyPhase === 'pending';
  const copied = copyPhase === 'copied';

  async function copy() {
    await copyFeedback.copy('message', props.text);
  }

  // `footerStyle` renders this copy as the SAME quiet ghost action the
  // assistant turn footer uses (`markerVariants('footer-action')` on a
  // UiButton variant="quiet" size="nav" — the bare size, with icon + "复制").
  // The user-message copy and the assistant copy then read as one button by
  // construction — same primitive, same class, same icon metrics — instead
  // of a look-alike bespoke treatment.
  const footer = props.footerStyle === true;
  const iconSize = footer ? 12 : 14;

  const baseLabel = props.label ?? (footer ? '复制' : '复制消息');
  const actionLabel = copyPhase === 'pending'
    ? '复制中'
    : copyPhase === 'copied'
      ? '已复制'
      : copyPhase === 'failed'
        ? '复制失败'
        : baseLabel;
  const icon = copied
    ? <Check size={iconSize} aria-hidden="true" />
    : <Copy size={iconSize} aria-hidden="true" />;

  if (footer) {
    // icon-only + tooltip, matching the assistant footer copy action (#546)
    // so the user-message copy and the assistant copy read as one button.
    return (
      <Tooltip>
        <TooltipTrigger
          render={
            <UiButton
              type="button"
              className={markerVariants({ variant: 'footer-action' })}
              variant="quiet"
              size="nav"
              aria-label={baseLabel}
              aria-busy={copyPending ? 'true' : undefined}
              disabled={copyPending}
              data-copied={copied}
              data-copy-feedback={copyPhase ?? undefined}
              data-pending={copyPending ? 'true' : undefined}
              onClick={() => void copy()}
            />
          }
        >
          {icon}
        </TooltipTrigger>
        <TooltipContent>{actionLabel}</TooltipContent>
      </Tooltip>
    );
  }

  return (
    <UiButton
      type="button"
      className="maka-message-copy"
      variant="quiet"
      size="icon-sm"
      onClick={() => void copy()}
      aria-label={copyPhase ? `${actionLabel} · ${baseLabel}` : baseLabel}
      aria-busy={copyPending ? 'true' : undefined}
      disabled={copyPending}
      data-copied={copied}
      data-copy-feedback={copyPhase ?? undefined}
      data-pending={copyPending ? 'true' : undefined}
      data-labelled={props.label ? 'true' : undefined}
    >
      {icon}
      {props.label && <span>{copyPhase === 'pending' ? '复制中…' : copyPhase === 'failed' ? '复制失败' : copied ? '已复制' : props.label}</span>}
    </UiButton>
  );
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

/**
 * Small actionable pill that surfaces a credential / readiness issue
 * inline in the chat header. Kept neutral about the source — it just
 * renders a tone + label and an optional click handler. The connection
 * lifecycle helper in the desktop renderer decides when to mount this.
 */
function ChatHeaderAlertBadge(props: { alert: ChatHeaderAlert }) {
  const { tone, label, tooltip, onClick } = props.alert;
  if (onClick) {
    return (
      <UiButton
        className="maka-chat-header-alert"
        variant="quiet"
        size="sm"
        data-tone={tone}
        type="button"
        onClick={onClick}
        aria-label={tooltip ?? label}
        title={tooltip}
      >
        <AlertTriangle size={12} aria-hidden="true" />
        <span>{label}</span>
      </UiButton>
    );
  }
  return (
    <span
      className="maka-chat-header-alert"
      data-tone={tone}
      aria-label={tooltip ?? label}
      title={tooltip}
    >
      <AlertTriangle size={12} aria-hidden="true" />
      <span>{label}</span>
    </span>
  );
}

// PR-MOVE-PERMISSION-MODE: the chat-header `PermissionModeSwitcher`
// radiogroup was deleted. Mode picking now lives inside the composer's
// left-controls as a Base UI Select (PermissionModeSelect), so the picker
// sits where you actually start typing, matching the reference product.
// Keyboard arrow/Home/End handling is delegated to the Select primitive.

/**
 * Renders one conversational turn: user message → tools used → assistant
 * answer, in that order, as a single visual unit. Replaces the previous
 * "message stack + tools panel at end" layout so the user sees the
 * narrative of "ask → tools fired → answer" as one work unit.
 */
const TurnView = memo(function TurnView(props: {
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
  onFooterAction?: (turnId: string, actionId: TurnFooterActionMeta['id']) => void;
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
  /** True when a search result just navigated to this turn. */
  searchHighlighted?: boolean;
  /**
   * #642 single render path: set only on the active streaming tail turn. When
   * present, the assistant `Message` renders the live 深度思考 + answer bubble as
   * the trailing entries of its timeline — the SAME node the committed turn
   * will settle into, so live→settled is a data-source swap (no unmount/mount).
   * While live the footer is a reserved-height placeholder, not the real
   * `TurnFooterActions`: the tail turn's derived status is `completed` (a live
   * turn has no `turn_state`), so rendering the real footer would offer a
   * clickable regenerate/branch on a still-streaming answer.
   */
  liveStreaming?: {
    streamingText: string;
    thinkingText?: string;
    streamingComplete?: boolean;
    streamingTruncated?: boolean;
    thinkingTruncated?: boolean;
    onStreamingSettled?: () => void;
  };
}) {
  const { turn } = props;
  const forwardBadges = props.lineageBadges?.filter((b) => b.direction === 'forward') ?? [];
  const reverseBadges = props.lineageBadges?.filter((b) => b.direction === 'reverse') ?? [];
  // The assistant `Message` mounts once the turn has any timeline content OR
  // this is the live streaming tail (a thinking-only / textless streaming turn
  // has an empty committed timeline but must still show its live answer block).
  const showAssistantMessage = turn.timeline.length > 0 || !!props.liveStreaming;
  return (
    <section
      className="maka-turn"
      data-turn-id={turn.turnId}
      data-live-streaming={props.liveStreaming ? 'true' : undefined}
      data-search-highlight={props.searchHighlighted ? 'true' : undefined}
      tabIndex={props.searchHighlighted ? -1 : undefined}
    >
      {forwardBadges.length > 0 && (
        <Marker variant="lineage-row" aria-label="本轮回答的来源">
          {forwardBadges.map((badge) => (
            <UiButton
              key={badge.id}
              type="button"
              className={markerVariants({ variant: 'lineage-badge' })}
              variant="quiet"
              size="nav"
              data-direction="forward"
              title={badge.tooltip ?? badge.label}
              onClick={() => props.onLineageBadgeClick?.(badge.targetTurnId)}
            >
              <GitBranch size={11} aria-hidden="true" />
              <span>{badge.label}</span>
            </UiButton>
          ))}
        </Marker>
      )}
      {turn.user && (
        <Message
          variant="user"
          aria-label="你发送的消息"
          title={turn.user.ts ? formatAbsoluteTimestamp(turn.user.ts) : undefined}
          className="group/usermsg"
        >
          <MessageBody role="user" text={turn.user.text} ts={turn.user.ts} attachments={turn.user.attachments} />
        </Message>
      )}
      {turn.notes.map((note) => (
        <Message
          key={note.id}
          variant="system"
          title={note.ts ? formatAbsoluteTimestamp(note.ts) : undefined}
        >
          <MessageBody role="system" text={note.text} ts={note.ts} />
        </Message>
      ))}
      {showAssistantMessage && (
        <Message
          variant="assistant"
          data-turn-status={turn.status}
          aria-label="Maka 的回答"
          className="group/answer"
        >
          <div className="flex flex-col gap-2">
            {/* PR109d-c: aborted turn gets a muted "(已中断)" marker + Ban icon
                so the user sees this turn was cancelled without it looking like
                a fault state (reserved for `failed`). Rendered as its own row so
                per-segment Copy buttons still yank clean answer text. */}
            {turn.status === 'aborted' && (
              <Marker variant="aborted" role="status">
                <Ban size={12} aria-hidden="true" />
                <em>{turnAbortMarkerLabel(turn.abortSource)}</em>
              </Marker>
            )}
            {/* PR109e-d: failed turn AlertOctagon banner with generalized
                Chinese copy (no raw `errorClass` leak per @kenji gate #3).
                Caller passes the pre-translated `failedReasonLabel` —
                @maka/ui doesn't know how to translate the runtime enum;
                that mapping lives in `session-status-presentation.ts`
                via `describeTurnErrorClass()`. */}
            {turn.status === 'failed' && props.failedReasonLabel && (
              <Marker variant="failed-banner" role="alert">
                <Marker as="span" variant="failed-icon" aria-hidden="true">
                  <AlertOctagon size={14} />
                </Marker>
                <span>{props.failedReasonLabel}</span>
                {props.failedRecoveryLabel && (
                  <Marker as="span" variant="failed-recovery">{props.failedRecoveryLabel}</Marker>
                )}
              </Marker>
            )}
            {/* The turn timeline is the rendering source of truth
                (materialize.ts): each step's 深度思考 disclosure, answer bubble,
                and Codex-style tool trow in the order the model produced them. */}
            {turn.timeline.map((item, index) => (
              <TurnTimelineEntry key={timelineEntryKey(item, index)} item={item} />
            ))}
            {/* #642: live 深度思考 + answer bubble as the trailing entries of the
                tail turn. On settle these are replaced by the committed
                timeline items above (same turnId → same node) — a data-source
                swap, not an unmount/mount. In a multi-step turn, earlier
                committed steps render above via `turn.timeline`; only the
                in-flight step rides here. */}
            {props.liveStreaming && (
              <LiveStreamingEntries
                streamingText={props.liveStreaming.streamingText}
                thinkingText={props.liveStreaming.thinkingText}
                streamingComplete={props.liveStreaming.streamingComplete}
                streamingTruncated={props.liveStreaming.streamingTruncated}
                thinkingTruncated={props.liveStreaming.thinkingTruncated}
                onStreamingSettled={props.liveStreaming.onStreamingSettled}
              />
            )}
          </div>
          {reverseBadges.length > 0 && (
            <Marker variant="lineage-row-reverse" aria-label="本轮回答的衍生">
              {reverseBadges.map((badge) => (
                <UiButton
                  key={badge.id}
                  type="button"
                  className={markerVariants({ variant: 'lineage-badge' })}
                  variant="quiet"
                  size="nav"
                  data-direction="reverse"
                  title={badge.tooltip ?? badge.label}
                  onClick={() => props.onLineageBadgeClick?.(badge.targetTurnId)}
                >
                  <GitBranch size={11} aria-hidden="true" />
                  <span>{badge.label}</span>
                </UiButton>
              ))}
            </Marker>
          )}
          {props.liveStreaming ? (
            /* #642: reserved-height footer placeholder while streaming — same
               `mt-0.5 h-8` box the real footer occupies, so the live→settled
               swap is height-neutral (the footer slot never grows/shrinks). No
               actionable footer here: the live tail's derived status is
               `completed`, so a real `TurnFooterActions` would render a
               clickable regenerate/branch on a still-streaming answer. */
            <div aria-hidden="true" className="mt-0.5 h-8" />
          ) : (
            props.footerActions && props.footerActions.length > 0 && (
              <TurnFooterActions
                actions={props.footerActions}
                onAction={props.onFooterAction ? (actionId) => props.onFooterAction?.(turn.turnId, actionId) : undefined}
                assistantText={turn.assistant?.text ?? ''}
              />
            )
          )}
        </Message>
      )}
    </section>
  );
});

/**
 * Turn footer actions row. Renders icon-only buttons (regenerate /
 * branch / copy, plus an optional info action whose tooltip carries
 * the turn meta) driven by the pure helper's enabled matrix. Disabled
 * buttons stay rendered so the user can see what actions exist on the
 * turn; click handlers no-op when disabled (#546: retry merged into
 * regenerate).
 *
 * Copy action is handled locally (write to clipboard) so the
 * consumer doesn't need a clipboard IPC for it. Other actions
 * (regenerate / branch) bubble up via `onAction`.
 */
export interface TurnFooterActionMeta {
  id: 'regenerate' | 'branch' | 'copy' | 'info';
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
    <UiButton
      type="button"
      className="maka-session-branch-banner"
      variant="quiet"
      size="sm"
      data-from-aborted={banner.fromAbortedTurn || undefined}
      onClick={() => props.onClick?.(banner.parentSessionId)}
      aria-label={banner.fromAbortedTurn
        ? `从中断前分支自 ${banner.parentSessionName} · 点击跳回原会话`
        : `分自 ${banner.parentSessionName} · 点击跳回原会话`}
    >
      <GitBranch size={12} aria-hidden="true" />
      <span>
        {banner.fromAbortedTurn
          ? `从中断前分支自 ${banner.parentSessionName}`
          : `分自 ${banner.parentSessionName}`}
      </span>
    </UiButton>
  );
}

/**
 * Lineage badge rendered on a turn, either pointing to its origin
 * ("重新生成自 turn ${id}") or to a descendant ("已重新生成 → turn ${id}").
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
  const [copyPhase, setCopyPhase] = useState<ClipboardCopyPhase | null>(null);
  const copyPendingRef = useRef(false);
  const copyResetTimerRef = useRef<number | null>(null);
  const copyMountedRef = useRef(true);

  function clearCopyResetTimer() {
    if (copyResetTimerRef.current === null) return;
    window.clearTimeout(copyResetTimerRef.current);
    copyResetTimerRef.current = null;
  }

  useEffect(() => {
    copyMountedRef.current = true;
    return () => {
      copyMountedRef.current = false;
      clearCopyResetTimer();
    };
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
    if (action.id === 'info') return; // tooltip-only meta display, no action
    props.onAction?.(action.id);
  }
  return (
    <Marker
      variant="footer"
      role="toolbar"
      aria-label="本轮回答操作"
    >
      {props.actions.map((action) => {
        // Per @kenji review: pending state must keep the original button
        // label visible (not a spinner-only) so screen readers can hear
        // which action is processing. `data-pending` + `aria-busy="true"`
        // are the signals — the `footer-action` marker shell renders as a
        // bare `quiet` button in every state, so pending never keys off the
        // Button `variant`, and no presentation-priority hook is emitted.
        const isPending = action.tooltip === '正在处理…';
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
        // Copy's tooltip comes from the helper (enabled affordance vs disabled
        // reason). Only while clipboard feedback is active do we surface that
        // transient state; otherwise the helper's tooltip wins.
        const tooltipText = isCopyAction
          ? (copyPhase ? copyFeedbackLabel : (action.tooltip ?? action.label))
          : (action.tooltip ?? action.label);
        const icon = isCopyAction && copyPhase === 'copied'
          ? <Check size={12} aria-hidden="true" />
          : STATUS_FOOTER_ICON[action.id];
        return (
          <Tooltip key={action.id}>
            <TooltipTrigger
              render={
                <UiButton
                  type="button"
                  className={markerVariants({ variant: 'footer-action' })}
                  variant="quiet"
                  size="nav"
                  aria-label={action.label}
                  data-action={action.id}
                  data-pending={isActionPending || undefined}
                  data-copy-feedback={isCopyAction && copyPhase ? copyPhase : undefined}
                  aria-disabled={!action.enabled || copyIsPending}
                  aria-busy={isActionPending || undefined}
                  onClick={() => void handleClick(action)}
                />
              }
            >
              {icon}
            </TooltipTrigger>
            <TooltipContent>{tooltipText}</TooltipContent>
          </Tooltip>
        );
      })}
    </Marker>
  );
}

const STATUS_FOOTER_ICON: Record<TurnFooterActionMeta['id'], ReactNode> = {
  regenerate: <RefreshCcw size={12} aria-hidden="true" />,
  branch: <GitBranch size={12} aria-hidden="true" />,
  copy: <Copy size={12} aria-hidden="true" />,
  info: <Info size={12} aria-hidden="true" />,
};

/**
 * PR-UI-RENDER-1 — streaming assistant bubble.
 *
 * Wraps the live `streamingText` in `useSmoothStreamContent` so the
 * visible text grows at the EMA-tracked arrival CPS instead of
 * lurching with each network chunk. On `text_complete`, the parent keeps
 * the bubble mounted with `live=false` so the smoother can drain the final
 * tail before settled history takes over. Abort / error still unmount
 * immediately.
 *
 * `live=false` after `text_complete`: keep the bubble mounted until
 * the smoother catches up, then notify the parent to hand off to history.
 */
/**
 * #642 single render path: the live 深度思考 + streaming answer, rendered as the
 * trailing entries of the active tail turn. Shared by `TurnView` (the normal
 * path — injected into the committed tail turn's timeline) and the ChatView
 * fallback (rare: streaming began before the optimistic user turn materialized).
 * Thinking renders above the answer (it always precedes it) and is `live` only
 * until the answer text starts; the answer bubble fires `onStreamingSettled`
 * once it finishes catching up.
 */
function LiveStreamingEntries(props: {
  streamingText: string;
  thinkingText?: string;
  streamingComplete?: boolean;
  streamingTruncated?: boolean;
  thinkingTruncated?: boolean;
  onStreamingSettled?: () => void;
}) {
  return (
    <>
      {props.thinkingText && (
        <DeepThinking
          text={props.thinkingText}
          live={!props.streamingText}
          truncated={props.thinkingTruncated === true}
        />
      )}
      {props.streamingText && (
        <StreamingAssistantBubble
          text={props.streamingText}
          live={props.streamingComplete !== true}
          truncated={props.streamingTruncated === true}
          onSettled={props.onStreamingSettled}
        />
      )}
    </>
  );
}

function StreamingAssistantBubble(props: { text: string; live: boolean; truncated?: boolean; onSettled?: () => void }) {
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
  const { displayed, catchingUp } = useSmoothStreamContent(safeText, {
    streaming: props.live,
    snap,
  });
  const settledRef = useRef(false);

  useEffect(() => {
    settledRef.current = false;
  }, [safeText, props.live]);

  useEffect(() => {
    if (props.live || catchingUp || settledRef.current) return;
    settledRef.current = true;
    props.onSettled?.();
  }, [props.live, catchingUp, props.onSettled]);

  // Per-word fade-in over the freshly revealed tail (replaces the ▎ caret).
  // Skipped under snap (reduced-motion / visual-smoke) so the deterministic
  // capture shows the final text at full opacity with no fade spans.
  const streamFade = useStreamFade(displayed, !snap);

  return (
    <Bubble variant="assistant" className="maka-bubble-streaming">
      <Markdown text={displayed} streamFade={streamFade} />
      {props.truncated && (
        <div
          className="mt-1.5 inline-block cursor-help rounded-[var(--radius-control)] border border-[oklch(from_var(--warning)_l_c_h_/_0.24)] bg-[oklch(from_var(--warning)_l_c_h_/_0.05)] px-1 text-xs text-[color:var(--warning-text,var(--info-text))]"
          role="status"
          aria-live="polite"
          title="助手输出已超过单次回合上限，超出部分未渲染。如需完整内容请重新生成或查看持久化的会话日志。"
        >
          已截断
        </div>
      )}
    </Bubble>
  );
}

/**
 * Stable key for a timeline entry. Thinking/text keys use the source step's
 * messageId (one thinking + one text per step, so kind+messageId is unique
 * across the turn); tools use the first tool's id (unique per merged group).
 * No index component: a semantic key survives a group being inserted or
 * re-positioned mid-timeline without remounting — and thereby collapsing —
 * the disclosures after it.
 */
function timelineEntryKey(item: TurnTimelineItem, index: number): string {
  if (item.kind === 'tools') return `tools-${item.items[0]?.toolUseId ?? index}`;
  return `${item.kind}-${item.messageId}`;
}

/** Render one timeline entry: reasoning disclosure / answer bubble / tool trow. */
function TurnTimelineEntry({ item }: { item: TurnTimelineItem }) {
  if (item.kind === 'thinking') return <DeepThinking text={item.text} live={false} />;
  if (item.kind === 'tools') return <ToolTrow items={item.items} />;
  return <MessageBody role="assistant" text={item.text} ts={item.ts} />;
}

/**
 * "深度思考" — the unified reasoning disclosure for both live streaming and
 * committed history (replaces ReasoningPanel + the retired `.maka-turn-thinking`
 * disclosure). Controlled Collapsible, collapsed by default (no defaultOpen —
 * disclosure-collapsible-contract), fixed title "深度思考".
 *
 * `live=true` (thinking still flowing): the title shimmers (TextShimmer) and the
 * expanded body streams plain redacted text through `useSmoothStreamContent`
 * (non-Markdown for the same frame-pacing reason as the old ReasoningPanel),
 * auto-following the tail. `live=false` (settled / committed): plain title,
 * Markdown render + a "复制思考过程" button.
 *
 * `props.text` is the already-redacted-and-capped buffer (C0 chokepoint);
 * `prepareSmoothStreamText` re-runs `redactSecrets` (idempotent) as
 * defense-in-depth so the smoother never sees a raw secret. The "已截断" pill
 * fires when the thinking cap dropped content.
 */
function DeepThinking(props: { text: string; live: boolean; truncated?: boolean }) {
  const snap = useStreamSnap();
  const safeText = prepareSmoothStreamText(props.text);
  const { displayed } = useSmoothStreamContent(safeText, { streaming: props.live, snap });
  // Per-word fade over the freshly revealed reasoning tail — same entrance as the
  // main answer bubble (replaces the old caret). Plain-text path (no Markdown),
  // so we tokenize `displayed` directly and wrap post-boundary tokens. Inactive
  // (returns undefined) when settled or under snap.
  const streamFade = useStreamFade(displayed, props.live && !snap);
  // Controlled open (see ReasoningPanel history: a raw `open` attribute lets the
  // ~60Hz stream re-render re-assert open state and undo a manual collapse).
  // Collapsed by default so the answer reads cleanly; the click sticks.
  const [open, setOpen] = useState(false);
  const bodyRef = useRef<HTMLPreElement>(null);
  useEffect(() => {
    if (!props.live || !open) return;
    const el = bodyRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [displayed, props.live, open]);
  return (
    <Collapsible
      className="flex flex-col"
      data-deep-thinking={props.live ? 'live' : undefined}
      open={open}
      onOpenChange={setOpen}
    >
      {/* Structurally identical to a tool trow row: [16px icon slot] + [label]
          + [hover-reveal trailing chevron]. One font size (base 13px), one
          weight (normal), muted color — the whole folded timeline reads as a
          single tier, hierarchy carried by color, not by size/weight jitter. */}
      <CollapsibleTrigger className="group flex w-full items-center gap-2 py-0.5 text-left">
        <Brain
          size={16}
          aria-hidden="true"
          className="shrink-0 text-[color:var(--muted-foreground)]"
        />
        {props.live ? (
          <TextShimmer active={!snap} className="min-w-0 truncate text-[length:var(--font-size-base)]">深度思考</TextShimmer>
        ) : (
          <span className="min-w-0 truncate text-[length:var(--font-size-base)] text-[color:var(--muted-foreground)]">深度思考</span>
        )}
        {/* "已截断" pill: the thinking cap (applyThinkingDelta /
            applyThinkingComplete) dropped content; same chrome as the
            tool-output truncated pill. */}
        {props.truncated && (
          <span
            className="rounded-[var(--radius-control)] border border-[oklch(from_var(--warning)_l_c_h_/_0.30)] bg-[oklch(from_var(--warning)_l_c_h_/_0.06)] px-1 text-[length:var(--font-size-caption)] text-[color:var(--warning-text,var(--info-text))]"
            data-truncated="true"
            title="部分 reasoning 已截断；显示的是最近的内容"
          >
            已截断
          </span>
        )}
        {/* Quiet chevron sits right after the label (near the text, not pinned
            to the far edge), rides in on hover / open, matching the tool trow
            rows. No always-on affordance so the folded row stays calm. */}
        <span className="inline-flex shrink-0 items-center text-[color:var(--muted-foreground)] opacity-0 [transition:opacity_var(--duration-quick)_var(--ease-out-strong)] group-hover:opacity-100 group-data-[panel-open]:opacity-100">
          <ChevronRight
            size={14}
            aria-hidden="true"
            className="[transition:transform_var(--duration-quick)_var(--ease-out-strong)] group-data-[panel-open]:rotate-90"
          />
        </span>
      </CollapsibleTrigger>
      <CollapsiblePanel>
        {/* Left-border-indented quiet detail block, one language with the tool
            trow's expanded body. `live` and settled render the SAME plain-text
            body at the caption tier so the two states never jump size; settled
            is muted + regular weight (long reasoning in italic reads poorly).
            The copy action is an icon-only hover affordance pinned top-right so
            it never squeezes the reading column into a vertical char stack. */}
        <div className="group/reasoning relative mt-1 ml-2 border-l border-[var(--border)] pl-2.5 pr-7">
          {props.live ? (
            <pre
              ref={bodyRef}
              className="m-0 max-h-64 overflow-y-auto whitespace-pre-wrap [word-break:break-word] [font-family:inherit] text-[length:var(--font-size-caption)] leading-normal text-[color:var(--muted-foreground)] [scroll-behavior:auto]"
            >
              <DeepThinkingBody text={displayed} streamFade={streamFade} />
            </pre>
          ) : (
            <>
              {/* Same `max-h-64 overflow-y-auto` bound as the live `<pre>` above
                  so an expanded panel doesn't jump taller the frame thinking
                  settles (live→settled swaps this body in place). Long reasoning
                  stays a compact scroll box in both states. */}
              <div className="max-h-64 overflow-y-auto whitespace-pre-wrap [word-break:break-word] text-[length:var(--font-size-caption)] leading-normal text-[color:var(--muted-foreground)]">
                {props.text}
              </div>
              <div className="absolute right-0 top-0 opacity-0 [transition:opacity_var(--duration-quick)_var(--ease-out-strong)] group-hover/reasoning:opacity-100 focus-within:opacity-100">
                <MessageCopyButton text={props.text} label="复制思考过程" footerStyle />
              </div>
            </>
          )}
        </div>
      </CollapsiblePanel>
    </Collapsible>
  );
}

/**
 * Plain-text reasoning body with the same per-word fade as the answer bubble.
 * When `streamFade` is absent (settled / snap) it renders the raw string so the
 * deterministic capture shows the full text with no spans. Otherwise it splits
 * the whole buffer at grapheme 0 and wraps each post-boundary token in a
 * `.maka-stream-fade` span with a negative `animation-delay` (= -age) so the
 * entrance resumes mid-flight across the ~60Hz streaming re-renders.
 */
function DeepThinkingBody(props: { text: string; streamFade?: StreamFade }) {
  const fade = props.streamFade;
  if (!fade) return <>{props.text}</>;
  const { tokens } = tokenizeFade(props.text, 0, fade.boundaryOffset);
  return (
    <>
      {tokens.map((token, index) =>
        token.fade ? (
          <span
            key={index}
            className="maka-stream-fade"
            style={{ animationDelay: `-${Math.round(fade.ageAt(token.offset))}ms` }}
          >
            {token.text}
          </span>
        ) : (
          <Fragment key={index}>{token.text}</Fragment>
        ),
      )}
    </>
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

function mergeTools(stored: ToolActivityItem[], live: ToolActivityItem[]): ToolActivityItem[] {
  const byId = new Map(stored.map((item) => [item.toolUseId, item]));
  for (const item of live) byId.set(item.toolUseId, { ...byId.get(item.toolUseId), ...item });
  return [...byId.values()];
}

const noMessagesYet = '暂无消息';
