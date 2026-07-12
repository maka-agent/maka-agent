import { useCallback, useMemo, useRef, type ReactNode } from 'react';
import {
  AlertTriangle,
  ArrowDown,
  BookOpen,
  GitBranch,
  Target,
  Sparkles,
} from './icons.js';
import { DeepResearchEmptyHero, EmptyChatHero } from './chat-empty-hero.js';
import type { ChatModelChoice } from './chat-model-helpers.js';
import { OverlayScrollArea } from './overlay-scroll-area.js';
import { PromptAnchorRail } from './prompt-anchor-rail.js';
import type { ProviderType, SessionSummary, StoredMessage } from '@maka/core';
import { isDeepResearchSession } from '@maka/core';
import { materializeChat, materializeTurns, overlayLiveTurn } from './materialize.js';
import type { LiveTurnProjection } from './live-turn-projection.js';
import { Button as UiButton } from './ui.js';
import { Alert, AlertDescription } from './primitives/alert.js';
import { Message } from './primitives/chat.js';
import { EmptyState } from './empty-state.js';
import {
  ModelContinuingIndicator,
  ModelProcessingIndicator,
  TurnView,
  type TurnFooterActionMeta,
  type TurnLineageBadge,
} from './chat-turn.js';
import { useChatScroll } from './use-chat-scroll.js';

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
  liveTurn?: LiveTurnProjection;
  /** Called once the streaming bubble has displayed the final text and can hand off to history. */
  onStreamingSettled?(messageId?: string): void;
  /**
   * #646: true while the first-token wait indicator ("正在处理…") should show —
   * the turn is armed at send with no content event yet. Rendered as a transient
   * trailing entry of the tail turn, covering only the connect-to-first-token gap.
   */
  processingIndicator?: boolean;
  /**
   * #646: true while the calm mid-turn hint ("继续中…") should show — the turn has
   * already produced content and is in a step-to-step lull (a tool settled / a
   * step's text finished) with nothing streaming while the model works on the next
   * step. Deliberately quieter than the first-token indicator so it never reads as
   * the live thinking being swallowed.
   */
  continuingIndicator?: boolean;
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
  /**
   * Active autonomous-goal indicator for the session, or undefined when no
   * goal is running. Surfaces the loop (turn counter) with a one-click clear
   * affordance so a token-burning goal is never invisible or unstoppable —
   * this IS the desktop kill switch. `onClear` stops autonomous continuation.
   */
  goalIndicator?: {
    condition: string;
    status: string;
    iterations: number;
    maxIterations: number;
    onClear: () => void;
  };
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
  // Persisted history and the live overlay are separate projections. Plain-text
  // deltas only clone the active turn; settled turn identities stay stable so
  // memoized TurnViews skip reconciliation on the hottest update path.
  const drainingMessageIdsKey = JSON.stringify(
    props.liveTurn?.steps.flatMap((step) => step.text ? [step.stepId] : []) ?? [],
  );
  const drainingMessageIds = useMemo(
    () => new Set<string>(JSON.parse(drainingMessageIdsKey) as string[]),
    [drainingMessageIdsKey],
  );
  const visibleMessages = useMemo(
    () => drainingMessageIds.size > 0
      ? props.messages.filter((message) => !(message.type === 'assistant' && drainingMessageIds.has(message.id)))
      : props.messages,
    [drainingMessageIds, props.messages],
  );
  const chat = useMemo(() => materializeChat(visibleMessages), [visibleMessages]);
  const settledTurns = useMemo(
    () => materializeTurns(visibleMessages),
    [visibleMessages],
  );
  const turns = useMemo(
    () => overlayLiveTurn(settledTurns, props.liveTurn),
    [settledTurns, props.liveTurn],
  );
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
  // footer on a still-running answer (review P2-B). A tool-only tail renders the
  // running tool from its timeline with no empty live bubble.
  // The model-wait indicator keeps the tail turn "live" too, so its footer stays
  // the non-actionable placeholder and the indicator injects into the tail turn
  // (not the fallback section) — it is, by derivation, only ever true when text /
  // thinking / tools are all absent.
  //
  // Terminal liveTurn is evidence overlay only (e.g. empty shell_run still needs
  // pre-yield chunks). It must NOT block footer actions — keeping evidence and
  // being in-flight are separate signals. Wait indicators alone still mark
  // streaming, but delayed flags can lag one frame past complete; terminal
  // evidence must outrank them so copy/regenerate stay actionable.
  const liveInFlight = !!(props.liveTurn && !props.liveTurn.terminal);
  const waitIndicators = !!(props.processingIndicator || props.continuingIndicator);
  const streamingActive = liveInFlight || (!props.liveTurn?.terminal && waitIndicators);
  const tailTurnId = liveInFlight
    ? props.liveTurn!.turnId
    : (streamingActive ? turns[turns.length - 1]?.turnId : undefined);
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
  const {
    highlightedTurnId,
    onScroll,
    pinnedToBottom,
    scrollToBottom,
    viewportRef: scrollRef,
  } = useChatScroll({
    sessionId: props.activeSession?.id,
    hasTurns: turns.length > 0,
    messages: props.messages,
    target: props.scrollTargetTurn,
    behavior: props.scrollBehavior,
  });

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
        {props.goalIndicator && (
          /* Goal kill-switch pill: an active autonomous loop must be visible and
             stoppable. Reuses the mode-pill styling; clicking it clears the goal
             (the shell confirms), so the user always has a one-click stop. */
          <UiButton
            type="button"
            variant="quiet"
            className="maka-chat-header-mode-pill"
            data-mode="goal"
            onClick={() => props.goalIndicator?.onClear()}
            title={`自主执行目标进行中：「${props.goalIndicator.condition}」（第 ${props.goalIndicator.iterations}/${props.goalIndicator.maxIterations} 轮，${props.goalIndicator.status}）。系统每轮后自动续行；点击可清除目标、停止续行。`}
            aria-label={`清除自主执行目标（已进行 ${props.goalIndicator.iterations}/${props.goalIndicator.maxIterations} 轮）`}
          >
            <Target size={12} aria-hidden="true" />
            <span>目标 {props.goalIndicator.iterations}/{props.goalIndicator.maxIterations} · 清除</span>
          </UiButton>
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
          {chat.length === 0 && !streamingActive && (
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
                        onStreamingSettled: props.onStreamingSettled,
                        processingIndicator: props.processingIndicator,
                        continuingIndicator: props.continuingIndicator,
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
                  {props.processingIndicator && <ModelProcessingIndicator />}
                  {props.continuingIndicator && !props.processingIndicator && <ModelContinuingIndicator />}
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

const noMessagesYet = '暂无消息';
