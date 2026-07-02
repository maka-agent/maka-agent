import { memo, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  AlertOctagon,
  AlertTriangle,
  ArrowDown,
  Ban,
  BookOpen,
  CalendarDays,
  Check,
  Copy,
  GitBranch,
  RefreshCcw,
  Repeat,
  Sparkles,
} from './icons.js';
import { DeepResearchEmptyHero, EmptyChatHero } from './chat-empty-hero.js';
import { type ClipboardCopyPhase, useClipboardCopyFeedback } from './clipboard-feedback.js';
import { Markdown } from './markdown.js';
import { formatAbsoluteTimestamp, formatTurnDuration, turnAbortMarkerLabel } from './chat-display-helpers.js';
import type { ChatModelChoice } from './chat-model-helpers.js';
import { prepareSmoothStreamText, useSmoothStreamContent } from './smooth-stream.js';
import { OverlayScrollArea } from './overlay-scroll-area.js';
import type { PlanReminder, ProviderType, SessionSummary, StoredMessage } from '@maka/core';
import { deriveCapabilityAuditReport, isDeepResearchSession } from '@maka/core';
import { materializeChat, materializeTools, materializeTurns, type ToolActivityItem, type TurnViewModel } from './materialize.js';
import { Button as UiButton } from './ui.js';
import { Alert, AlertDescription } from './primitives/alert.js';
import { Bubble, Marker, markerVariants, Message } from './primitives/chat.js';
import type { NavSelection } from './nav-selection.js';
import { EmptyState } from './empty-state.js';
import type {
  DailyReviewBridge,
  DailyReviewMarkdownActionInput,
  PlanReminderDraftInput,
  PlanReminderUpdatePatch,
  SkillEntry,
} from './module-panel-types.js';
import { SkillsModuleMain } from './skills-panel.js';
import { DailyReviewPanel } from './daily-review-panel.js';
import { PlanReminderPanel } from './plan-reminder-panel.js';
import { RelativeTime } from './relative-time.js';
import { ToolActivity } from './tool-activity.js';

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
  const visibleMessages = props.streamingComplete && props.streamingMessageId
    ? props.messages.filter((message) => !(message.type === 'assistant' && message.id === props.streamingMessageId))
    : props.messages;
  const chat = materializeChat(visibleMessages);
  const storedTools = materializeTools(visibleMessages);
  const tools = mergeTools(storedTools, props.tools);
  const turns = materializeTurns(visibleMessages, props.tools);
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
      <SkillsModuleMain
        skills={props.skills}
        auditReport={capabilityAuditReport}
        onRefreshSkills={props.onRefreshSkills}
        onCreateSkillTemplate={props.onCreateSkillTemplate}
        onOpenSkill={props.onOpenSkill}
        onOpenSkillsFolder={props.onOpenSkillsFolder}
      />
    );
  }

  if (props.mode === 'automations') {
    return (
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
            <BookOpen size={12} strokeWidth={1.75} aria-hidden="true" />
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
            <Sparkles size={12} strokeWidth={1.75} aria-hidden="true" />
            <span>深度研究</span>
          </span>
        )}
        {/* PR-MOVE-PERMISSION-MODE: switcher relocated into the
            composer left-controls. Header keeps the per-session status
            chips only. */}
      </header>
      {(props.sessionStatusBadge || props.connectionAlert || props.eventStreamAlert) && (
        /* In normal flow below the header (see .maka-chat-status-cluster)
           so wrapped multi-badge rows reserve space before banners and
           messages. */
        <div className="maka-chat-status-cluster">
          {props.sessionStatusBadge && <SessionStatusBadge badge={props.sessionStatusBadge} />}
          {props.connectionAlert && <ChatHeaderAlertBadge alert={props.connectionAlert} />}
          {props.eventStreamAlert && <ChatHeaderAlertBadge alert={props.eventStreamAlert} />}
        </div>
      )}
      {isLocalSimulationBackend && (
        <Alert variant="info" className="maka-fake-backend-banner" role="status">
          <AlertTriangle size={14} strokeWidth={1.75} aria-hidden="true" />
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
            // PR-STREAM-TURN-CENTER: the in-flight answer must use the SAME
            // `.maka-turn` shell a committed turn uses. `.maka-turn` owns the
            // centered 680px reading column (max-width + margin:0 auto). A bare
            // `.message.assistant` instead left-aligns — its unlayered
            // margin-right:auto outranks `.maka-message-row`'s margin:0 auto —
            // so without this wrapper the streaming answer rendered ~110px left
            // of where it lands once committed, a visible horizontal jump on
            // text_complete. Wrapping here makes streaming structurally
            // identical to TurnView's committed turn.
            <section className="maka-turn maka-turn-streaming">
              <Message variant="assistant">
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
                    live={props.streamingComplete !== true}
                    truncated={props.streamingTruncated === true}
                    onSettled={props.onStreamingSettled}
                  />
                )}
              </Message>
            </section>
          )}
          {/* Defensive: if any tool ended up outside a turn (e.g. legacy
              sessions without turnId), render those at the very end so they
              still appear instead of vanishing. materializeTurns already
              folds these into the `__loose` turn, so this is normally a
              no-op. */}
        </OverlayScrollArea>
        {!pinnedToBottom && (
          <UiButton
            type="button"
            className="maka-chat-jump-bottom"
            variant="secondary"
            size="icon-sm"
            onClick={scrollToBottom}
            aria-label="跳到最新消息"
          >
            <ArrowDown size={16} strokeWidth={2} aria-hidden="true" />
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
const MessageBody = memo(function MessageBody(props: { role: string; text: string; ts?: number }) {
  if (props.role === 'user') {
    // User turn: the message sits in a tinted, width-capped block aligned to
    // the right (so the right-anchor reads even for long messages), with a
    // quiet always-visible time + a copy affordance in a meta row beneath it.
    // The time is no longer hover-gated (was `opacity: 0` until hover, which
    // hid it from touch + assistive tech). Copy reuses MessageCopyButton in
    // `footerStyle`, so it's the same quiet ghost action as the assistant
    // turn footer's copy (same primitive + `markerVariants('footer-action')`).
    return (
      <>
        <Bubble variant="user">
          <span>{props.text}</span>
        </Bubble>
        <div className="maka-message-meta">
          {props.ts !== undefined && (
            <RelativeTime ts={props.ts} className="maka-message-time-inline" />
          )}
          <MessageCopyButton text={props.text} footerStyle />
        </div>
      </>
    );
  }
  // Assistant / system body: open prose, no bubble. Per-turn timing lives in
  // the turn summary; copy + the other actions live in the turn footer.
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
  const visibleLabel = footer ? (props.label ?? '复制') : props.label;
  const iconSize = footer ? 12 : 14;

  const baseLabel = props.label ?? (footer ? '复制' : '复制消息');
  const actionLabel = copyPhase === 'pending'
    ? '复制中'
    : copyPhase === 'copied'
      ? '已复制'
      : copyPhase === 'failed'
        ? '复制失败'
        : baseLabel;
  return (
    <UiButton
      type="button"
      className={footer ? markerVariants({ variant: 'footer-action' }) : 'maka-message-copy'}
      variant="quiet"
      // `nav` is the bare size: the footer-action marker shell owns its own
      // height/padding/font (see `markerVariants`), so it doesn't inherit —
      // and then have to merge out — `sm`'s `h-8`/`px-2.5`/`text-xs`.
      size={footer ? 'nav' : 'icon-sm'}
      onClick={() => void copy()}
      aria-label={copyPhase ? `${actionLabel} · ${baseLabel}` : baseLabel}
      aria-busy={copyPending ? 'true' : undefined}
      disabled={copyPending}
      data-copied={copied}
      data-copy-feedback={copyPhase ?? undefined}
      data-pending={copyPending ? 'true' : undefined}
      data-labelled={(!footer && props.label) ? 'true' : undefined}
    >
      {copied ? <Check size={iconSize} strokeWidth={2} aria-hidden="true" /> : <Copy size={iconSize} strokeWidth={footer ? 2 : 1.75} aria-hidden="true" />}
      {visibleLabel && <span>{copyPhase === 'pending' ? '复制中…' : copyPhase === 'failed' ? '复制失败' : copied ? '已复制' : visibleLabel}</span>}
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
        <AlertTriangle size={12} strokeWidth={2} aria-hidden="true" />
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
      <AlertTriangle size={12} strokeWidth={2} aria-hidden="true" />
      <span>{label}</span>
    </span>
  );
}

// PR-MOVE-PERMISSION-MODE: the chat-header `PermissionModeSwitcher`
// radiogroup was deleted. Mode picking now lives inside the composer's
// left-controls dropdown (see Composer + maka-composer-mode-chip / -menu)
// so the picker sits where you actually start typing, matching the
// reference product. The `radiogroup` keyboard contract was traded for
// base-ui Menu's built-in arrow/Home/End handling.

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
    <Marker variant="summary" aria-label="本轮对话摘要">
      {hasModel && (
        <Marker
          as="span"
          variant="summary-chip"
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
            <Marker as="span" variant="summary-switched" aria-label="本轮切换了模型">
              切换
            </Marker>
          )}
        </Marker>
      )}
      {hasTools && (
        <Marker as="span" variant="summary-chip" data-kind="tools">
          {turn.tools.length} 个工具
        </Marker>
      )}
      {hasDuration ? (
        <Marker as="span" variant="summary-chip" data-kind="duration">
          {formatTurnDuration(turn.durationMs!)}
        </Marker>
      ) : inProgress ? (
        <Marker as="span" variant="summary-chip" data-kind="duration" data-state="in-progress">
          进行中
        </Marker>
      ) : null}
      {hasTokens && (
        <Marker
          as="span"
          variant="summary-chip"
          data-kind="tokens"
          title={hasCost ? `$${turn.tokens!.costUsd!.toFixed(4)}` : undefined}
        >
          {turn.tokens!.input.toLocaleString()} → {turn.tokens!.output.toLocaleString()} tok
        </Marker>
      )}
    </Marker>
  );
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
              <GitBranch size={11} strokeWidth={2} aria-hidden="true" />
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
        >
          <MessageBody role="user" text={turn.user.text} ts={turn.user.ts} />
        </Message>
      )}
      <TurnSummary turn={turn} previousModelId={props.previousModelId} />

      {turn.notes.map((note) => (
        <Message
          key={note.id}
          variant="system"
          title={note.ts ? formatAbsoluteTimestamp(note.ts) : undefined}
        >
          <MessageBody role="system" text={note.text} ts={note.ts} />
        </Message>
      ))}
      {turn.tools.length > 0 && (
        <div className="maka-turn-tools">
          <ToolActivity items={turn.tools} />
        </div>
      )}
      {turn.assistant && (
        <Message
          variant="assistant"
          data-turn-status={turn.status}
          aria-label="Maka 的回答"
          title={turn.assistant.ts ? formatAbsoluteTimestamp(turn.assistant.ts) : undefined}
        >
          <div className="flex flex-col">
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
              <Marker variant="aborted" role="status">
                <Ban size={12} strokeWidth={2} aria-hidden="true" />
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
                  <AlertOctagon size={14} strokeWidth={2} />
                </Marker>
                <span>{props.failedReasonLabel}</span>
                {props.failedRecoveryLabel && (
                  <Marker as="span" variant="failed-recovery">{props.failedRecoveryLabel}</Marker>
                )}
              </Marker>
            )}
            <MessageBody role="assistant" text={turn.assistant.text} ts={turn.assistant.ts} />
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
                  <GitBranch size={11} strokeWidth={2} aria-hidden="true" />
                  <span>{badge.label}</span>
                </UiButton>
              ))}
            </Marker>
          )}
          {props.footerActions && props.footerActions.length > 0 && (
            <TurnFooterActions
              actions={props.footerActions}
              onAction={props.onFooterAction}
              assistantText={turn.assistant.text}
            />
          )}
        </Message>
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
      <GitBranch size={12} strokeWidth={2} aria-hidden="true" />
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
    props.onAction?.(action.id);
  }
  return (
    <Marker variant="footer" role="toolbar" aria-label="本轮回答操作">
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
        return (
          <UiButton
            key={action.id}
            type="button"
            className={markerVariants({ variant: 'footer-action' })}
            variant="quiet"
            size="nav"
            data-action={action.id}
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
          </UiButton>
        );
      })}
    </Marker>
  );
}

const STATUS_FOOTER_ICON: Record<TurnFooterActionMeta['id'], ReactNode> = {
  retry: <Repeat size={12} strokeWidth={2} aria-hidden="true" />,
  regenerate: <RefreshCcw size={12} strokeWidth={2} aria-hidden="true" />,
  branch: <GitBranch size={12} strokeWidth={2} aria-hidden="true" />,
  copy: <Copy size={12} strokeWidth={2} aria-hidden="true" />,
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
 * lurching with each network chunk. On `text_complete`, the parent keeps
 * the bubble mounted with `live=false` so the smoother can drain the final
 * tail before settled history takes over. Abort / error still unmount
 * immediately.
 *
 * `live=false` after `text_complete`: keep the bubble mounted until
 * the smoother catches up, then notify the parent to hand off to history.
 */
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

  return (
    <Bubble variant="assistant" className="maka-bubble-streaming">
      <Markdown text={displayed} />
      {props.truncated && (
        <div
          className="mt-1.5 inline-block cursor-help rounded-[var(--radius-control)] border border-[oklch(from_var(--warning)_l_c_h_/_0.24)] bg-[oklch(from_var(--warning)_l_c_h_/_0.05)] px-[5px] text-[10px] text-[color:var(--warning-text,var(--info-text))]"
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

function mergeTools(stored: ToolActivityItem[], live: ToolActivityItem[]): ToolActivityItem[] {
  const byId = new Map(stored.map((item) => [item.toolUseId, item]));
  for (const item of live) byId.set(item.toolUseId, { ...byId.get(item.toolUseId), ...item });
  return [...byId.values()];
}

const noMessagesYet = '暂无消息';
