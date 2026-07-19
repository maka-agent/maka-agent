import { useCallback, useMemo, useRef, type ReactNode } from 'react';
import { Button as BaseButton } from '@base-ui/react/button';
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
import type { ProviderType, SessionSummary, ShellRunUpdate, StoredMessage } from '@maka/core';
import { isDeepResearchSession } from '@maka/core';
import { materializeChat, materializeTurns, overlayLiveTurn, overlayShellRunUpdates } from './materialize.js';
import type { LiveTurnProjection } from './live-turn-projection.js';
import { Message } from './primitives/chat.js';
import { EmptyState } from './empty-state.js';
import {
  ModelContinuingIndicator,
  ModelProcessingIndicator,
  TurnView,
  type ReadAttachmentBytes,
  type TurnFooterActionMeta,
  type TurnLineageBadge,
} from './chat-turn.js';
import { useChatScroll } from './use-chat-scroll.js';
import { useUiLocale } from './locale-context.js';
import { getConversationCopy } from './conversation-copy.js';

export function ChatView(props: {
  messages: StoredMessage[];
  messageLoading?: boolean;
  liveTurn?: LiveTurnProjection;
  shellRunUpdates?: readonly ShellRunUpdate[];
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
  /**
   * Host reader for image attachment bytes, threaded to each turn's user-message
   * thumbnails. The desktop shell passes its preload `attachments.readBytes`;
   * non-desktop hosts omit it and image thumbnails stay in their pending
   * skeleton. Keeps @maka/ui host-agnostic with no direct host-global access.
   * Pass an identity-stable reference so the memoized TurnViews keep skipping
   * reconciliation on the hot streaming path.
   */
  onReadAttachmentBytes?: ReadAttachmentBytes;
  onNew(): void;
  onPromptSuggestion?(prompt: string): void;
}) {
  const copy = getConversationCopy(useUiLocale()).chat;
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
  const liveTurns = useMemo(
    () => overlayLiveTurn(settledTurns, props.liveTurn),
    [settledTurns, props.liveTurn],
  );
  const turns = useMemo(
    () => overlayShellRunUpdates(liveTurns, props.shellRunUpdates ?? []),
    [liveTurns, props.shellRunUpdates],
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
  // pre-handoff chunks). It must NOT block footer actions — keeping evidence and
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
          /* This status pill is a semantic header control rather than a
             shared Button size or neutral variant. */
          <BaseButton
            type="button"
            className="maka-chat-header-memory-pill"
            data-active="true"
            onClick={() => props.onOpenMemorySettings?.()}
            title={copy.memoryTitle}
            aria-label={copy.memoryAriaLabel}
          >
            <BookOpen size={12} aria-hidden="true" />
            <span>{copy.memory}</span>
          </BaseButton>
        )}
        {deepResearchActive && (
          <span
            className="maka-chat-header-mode-pill"
            data-mode="deep-research"
            title={copy.deepResearchTitle}
            aria-label={copy.deepResearchAriaLabel}
          >
            <Sparkles size={12} aria-hidden="true" />
            <span>{copy.deepResearch}</span>
          </span>
        )}
        {props.goalIndicator && (
          /* Goal kill-switch pill: an active autonomous loop must be visible and
             stoppable. Reuses the mode-pill styling; clicking it clears the goal
             (the shell confirms), so the user always has a one-click stop. */
          <BaseButton
            type="button"
            className="maka-chat-header-mode-pill"
            data-mode="goal"
            onClick={() => props.goalIndicator?.onClear()}
            title={copy.clearGoal(props.goalIndicator.condition, props.goalIndicator.iterations, props.goalIndicator.maxIterations, props.goalIndicator.status)}
            aria-label={copy.clearGoalAriaLabel(props.goalIndicator.iterations, props.goalIndicator.maxIterations)}
          >
            <Target size={12} aria-hidden="true" />
            <span>{copy.goalLabel(props.goalIndicator.iterations, props.goalIndicator.maxIterations)}</span>
          </BaseButton>
        )}
        {/* PR-MOVE-PERMISSION-MODE: switcher relocated into the
            composer left-controls. Header keeps the per-session status
            chips only. */}
      </header>
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
                  title={copy.loadFailed}
                  body={props.messageLoadError}
                  cta={props.onRetryMessages ? {
                    label: props.messageLoadRetryPending ? copy.loading : copy.retryLoad,
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
                onReadAttachmentBytes={props.onReadAttachmentBytes}
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
          <BaseButton
            type="button"
            className="maka-chat-jump-bottom"
            onClick={scrollToBottom}
            aria-label={copy.jumpLatest}
          >
            <ArrowDown size={16} aria-hidden="true" />
          </BaseButton>
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
  const copy = getConversationCopy(useUiLocale()).chat;
  return (
    <BaseButton
      type="button"
      className="maka-session-branch-banner"
      data-from-aborted={banner.fromAbortedTurn || undefined}
      onClick={() => props.onClick?.(banner.parentSessionId)}
      aria-label={copy.branchTitle(banner.parentSessionName, Boolean(banner.fromAbortedTurn))}
    >
      <GitBranch size={12} aria-hidden="true" />
      <span>
        {copy.branchLabel(banner.parentSessionName, Boolean(banner.fromAbortedTurn))}
      </span>
    </BaseButton>
  );
}
