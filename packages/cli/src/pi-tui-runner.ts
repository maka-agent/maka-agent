import { basename } from 'node:path';
import {
  Editor,
  Key,
  ProcessTerminal,
  SelectList,
  TUI,
  isKeyRelease,
  isKeyRepeat,
  matchesKey,
  type Component,
  type OverlayHandle,
  type SelectItem,
  type Terminal,
} from '@earendil-works/pi-tui';
import { PERMISSION_MODES, isPermissionMode, type PermissionMode } from '@maka/core/permission';
import { isThinkingLevel, thinkingVariantsForModel, type ThinkingLevel } from '@maka/core/model-thinking';
import type { ProviderType } from '@maka/core/llm-connections';
import {
  ShellRunUpdateBuffer,
  mergeShellRunUpdate,
  projectShellRunUpdateForSession,
  type ShellRunUpdate,
} from '@maka/core';
import type { ModelChoice } from './connection-target.js';
import {
  inspectSessionResumeAvailability,
  type MakaSessionDriver,
  type MakaSessionSwitchResult,
} from './session-driver.js';
import {
  createMakaPiTranscriptState,
  activePermissionRequest,
  activeUserQuestionRequest,
  completePendingInteraction,
  applyShellRunViewUpdateToTranscript,
  replaceTranscriptWithStoredMessages,
  submitCompactToTranscript,
  submitPromptToTranscript,
  toggleAllThinkingExpansion,
  toggleAllToolExpansion,
  togglePendingPermissionDetails,
  type MakaPiTranscriptMetadata,
  type TurnOutcome,
} from './pi-transcript.js';
import { editorTheme, selectListTheme } from './tui-ansi.js';
import { MakaAutocompleteAboveEditorComponent } from './tui-autocomplete-layout.js';
import { createShellRunElapsedTicker } from './shell-run-elapsed-ticker.js';
import {
  AttentionController,
  DISABLE_FOCUS_REPORTING,
  ENABLE_FOCUS_REPORTING,
  FOCUS_IN_SEQUENCE,
  FOCUS_OUT_SEQUENCE,
} from './tui-attention.js';
import {
  MakaActivityStripComponent,
  MakaPendingQueueComponent,
  MakaPiLayoutComponent,
  MakaStatusLineComponent,
  MakaTranscriptComponent,
} from './pi-tui-layout.js';
import {
  MakaAutocompleteProvider,
  PickerOverlay,
  UserQuestionOverlay,
  modelChoicePickerItems,
  modelPickerItems,
  permissionModePickerItems,
  thinkingLevelPickerItems,
  type MakaSlashCommand,
} from './pi-tui-pickers.js';

export interface MakaPiTuiInput {
  title: string;
  driver: MakaSessionDriver;
  cwd: string;
  model: string;
  models?: readonly string[];
  /**
   * Every selectable model across all ready connections. When present, `/model`
   * lists these (grouped by connection) and selecting one rebinds the session to
   * that connection + model. Falls back to `models` (current connection only)
   * when absent.
   */
  modelChoices?: readonly ModelChoice[];
  connectionSlug: string;
  providerType?: ProviderType;
  permissionMode: PermissionMode;
  /** Maximum context tokens for the active model, for the statusline ctx segment. */
  modelContextWindow?: number;
  terminal?: Terminal;
  /** Starts the CLI process-exit deadline after terminal restore, before outer cleanup. */
  onProcessExit?: (exitCode: number, error?: Error) => void;
  /**
   * How long a prompt turn must run before its completion rings the terminal
   * BEL when unfocused. Injectable so tests exercise the long / short split
   * without waiting real seconds; defaults to the attention layer's own value.
   */
  attentionLongTurnThresholdMs?: number;
  subscribeShellRunUpdates?: (listener: (update: ShellRunUpdate) => void) => () => void;
  listShellRunUpdates?: (sessionId: string) => Promise<ShellRunUpdate[]>;
  /**
   * Called after each agent turn settles. Receives an `injectTurn` that runs a
   * new turn rendered in the transcript — used for goal auto-continuation so
   * continuation turns are visible and chain correctly.
   */
  onTurnComplete?: (turnId: string, injectTurn: (text: string) => void) => void;
}

export async function runMakaPiTui(input: MakaPiTuiInput): Promise<void> {
  const terminal = input.terminal ?? new ProcessTerminal();
  const tui = new TUI(terminal);
  const state = createMakaPiTranscriptState();
  let cwd = input.cwd;
  let model = input.model;
  let connectionSlug = input.connectionSlug;
  // Mutable: a cross-connection /model switch rebinds the provider, which changes
  // both the connection and the thinking variants the new model supports.
  let providerType = input.providerType;
  let modelContextWindow = input.modelContextWindow;
  let permissionMode = input.permissionMode;
  let thinkingLevel: ThinkingLevel | undefined = undefined;
  let thinkingLevels: readonly ThinkingLevel[] = providerType
    ? thinkingVariantsForModel(providerType, input.model)
    : [];
  let sessionListScope: 'current' | 'all' = 'current';
  let busy = false;
  let closed = false;
  let permissionResponseInFlightRequestId: string | null = null;
  let userQuestionInFlight = false;
  let userQuestionOverlay: OverlayHandle | undefined;
  let userQuestionProgress: {
    requestId: string;
    index: number;
    answers: Array<string | null>;
  } | undefined;
  let turnRunning = false;
  let turnStartedAt: number | undefined;
  let interruptRequested = false;
  let lastTurnEscapeAt = 0;
  let lastIdleEscapeAt = 0;
  let lastIdleCtrlCAt = 0;
  let resolveClosed: () => void;
  let rejectClosed: (error: Error) => void;
  const closedPromise = new Promise<void>((resolve, reject) => {
    resolveClosed = resolve;
    rejectClosed = reject;
  });

  const metadata = (): MakaPiTranscriptMetadata => ({
    title: input.title,
    cwd,
    model,
    connectionSlug,
    permissionMode,
    thinkingLevel,
    thinkingLevels,
    sessionId: input.driver.getSessionId(),
    busy,
    usage: state.usage,
    modelContextWindow,
    turnElapsedMs: turnStartedAt !== undefined ? Date.now() - turnStartedAt : undefined,
  });

  const transcript = new MakaTranscriptComponent(state, metadata);
  const activityStrip = new MakaActivityStripComponent(metadata);
  const pendingQueue = new MakaPendingQueueComponent(state);
  const statusLine = new MakaStatusLineComponent(metadata);
  // Show the whole slash-command set at once — discoverability is the point of
  // the menu. Keep a little headroom above the current command count.
  const editor = new Editor(tui, editorTheme(), { paddingX: 1, autocompleteMaxVisible: EDITOR_AUTOCOMPLETE_MAX_VISIBLE });
  let refreshEditorCwd: ((cwd: string) => void) | undefined;
  const editorSurface = new MakaAutocompleteAboveEditorComponent(editor);
  const layout = new MakaPiLayoutComponent(state, transcript, activityStrip, pendingQueue, editorSurface, statusLine, terminal);
  const attention = new AttentionController(terminal, {
    baseTitle: input.title,
    ...(input.attentionLongTurnThresholdMs !== undefined
      ? { longTurnThresholdMs: input.attentionLongTurnThresholdMs }
      : {}),
  });

  const requestRender = () => {
    transcript.invalidate();
    tui.requestRender();
  };
  const shellRunElapsedTicker = createShellRunElapsedTicker({
    state,
    onTick: requestRender,
  });
  // 1-second heartbeat that re-renders the activity strip's elapsed counter
  // while a turn runs. Stopped on turn end and disposed on teardown.
  let turnElapsedInterval: ReturnType<typeof setInterval> | undefined;
  const startTurnElapsedTicker = () => {
    if (turnElapsedInterval) return;
    turnElapsedInterval = setInterval(() => requestRender(), 1_000);
    turnElapsedInterval.unref();
  };
  const stopTurnElapsedTicker = () => {
    if (turnElapsedInterval) {
      clearInterval(turnElapsedInterval);
      turnElapsedInterval = undefined;
    }
  };
  let shellRunOwnerMappings: ShellRunUpdate[] = [];
  let hydratingShellRunsFor: string | undefined;
  let shellRunHydrationEpoch = 0;
  let shellRunHydrationRetryTimer: ReturnType<typeof setTimeout> | undefined;
  const pendingShellRunUpdates = new ShellRunUpdateBuffer('cli.pi-tui-hydration-buffer');
  const applyShellRunViewUpdate = (
    candidate: ShellRunUpdate,
    options?: { announceSettle?: boolean },
  ): boolean => {
    const index = shellRunOwnerMappings.findIndex((update) => (
      update.sessionId === candidate.sessionId
      && update.sourceToolCallId === candidate.sourceToolCallId
    ));
    const merged = mergeShellRunUpdate(
      index >= 0 ? shellRunOwnerMappings[index] : undefined,
      candidate,
      'cli.pi-tui-runner',
    );
    const retainOwnerMapping = merged.update.ownership.kind === 'source_owned'
      && merged.update.result.status === 'running';
    if (index >= 0 && retainOwnerMapping) shellRunOwnerMappings[index] = merged.update;
    else if (index >= 0) shellRunOwnerMappings.splice(index, 1);
    else if (retainOwnerMapping) shellRunOwnerMappings.push(merged.update);
    return applyShellRunViewUpdateToTranscript(state, merged.update, options);
  };
  const replayPendingShellRunUpdates = (sessionId: string): boolean => {
    const buffered = pendingShellRunUpdates.drain();
    for (const update of buffered.updates) {
      const projected = projectShellRunUpdateForSession(sessionId, shellRunOwnerMappings, update);
      for (const viewUpdate of projected) applyShellRunViewUpdate(viewUpdate);
    }
    return buffered.overflowed;
  };
  const resetShellRunSessionState = (): void => {
    shellRunOwnerMappings = [];
    shellRunHydrationEpoch += 1;
    if (shellRunHydrationRetryTimer !== undefined) clearTimeout(shellRunHydrationRetryTimer);
    shellRunHydrationRetryTimer = undefined;
    hydratingShellRunsFor = undefined;
    pendingShellRunUpdates.clear();
  };
  const hydrateShellRuns = async (
    sessionId: string,
    epoch: number,
    retryDelayMs = 250,
  ): Promise<void> => {
    try {
      const updates = await input.listShellRunUpdates?.(sessionId);
      if (closed || epoch !== shellRunHydrationEpoch || input.driver.getSessionId() !== sessionId) return;
      // Catch-up replays durable state, not a live event: flip cards silently.
      // Updates buffered from the live subscription during the await are
      // genuinely live and stay announceable in the drain below.
      for (const update of updates ?? []) applyShellRunViewUpdate(update, { announceSettle: false });
      const overflowed = replayPendingShellRunUpdates(sessionId);
      shellRunElapsedTicker.sync();
      requestRender();
      if (overflowed) {
        void hydrateShellRuns(sessionId, epoch);
        return;
      }
      hydratingShellRunsFor = undefined;
    } catch {
      if (closed || epoch !== shellRunHydrationEpoch || input.driver.getSessionId() !== sessionId) return;
      shellRunHydrationRetryTimer = setTimeout(() => {
        shellRunHydrationRetryTimer = undefined;
        void hydrateShellRuns(sessionId, epoch, Math.min(retryDelayMs * 2, 5_000));
      }, retryDelayMs);
    }
  };
  const unsubscribeShellRunUpdates = input.subscribeShellRunUpdates?.((update) => {
    const sessionId = input.driver.getSessionId();
    if (closed || !sessionId) return;
    if (hydratingShellRunsFor === sessionId) {
      pendingShellRunUpdates.add(update);
      return;
    }
    const projected = projectShellRunUpdateForSession(sessionId, shellRunOwnerMappings, update);
    let changed = false;
    for (const viewUpdate of projected) {
      if (applyShellRunViewUpdate(viewUpdate)) changed = true;
    }
    if (!changed) return;
    shellRunElapsedTicker.sync();
    requestRender();
  });

  const reportError = (error: unknown) => {
    state.entries.push({
      kind: 'notice',
      level: 'error',
      text: error instanceof Error ? error.message : String(error),
    });
    // An error is worth pulling the user back to a background tab.
    attention.attentionNeeded();
    requestRender();
  };

  // Control commands (model/session/permission switches) mutate session state.
  // Run them through a single serial lock so a prompt submitted mid-switch can
  // not race the switch and land on the old session/model/permission mode.
  const runControl = async (action: () => Promise<void>): Promise<void> => {
    // Refuse nested control actions: an overlay onSelect bypasses editor.onSubmit,
    // so without this guard a switch could start while a prompt is still running.
    if (busy) return;
    busy = true;
    editor.disableSubmit = true;
    terminal.setProgress(true);
    attention.controlStarted();
    requestRender();
    try {
      await action();
    } catch (error) {
      reportError(error);
    } finally {
      busy = false;
      editor.disableSubmit = false;
      terminal.setProgress(false);
      attention.controlEnded();
      requestRender();
    }
  };

  const removeProcessHandlers = () => {
    process.off('SIGINT', handleSigint);
    process.off('SIGTERM', handleSigterm);
    process.off('SIGHUP', handleSighup);
    process.off('uncaughtException', handleUncaughtException);
    process.off('unhandledRejection', handleUnhandledRejection);
  };

  const restoreTerminal = () => {
    removeProcessHandlers();
    unsubscribeShellRunUpdates?.();
    resetShellRunSessionState();
    shellRunElapsedTicker.dispose();
    stopTurnElapsedTicker();
    stopFallbackRetry();
    terminal.setProgress(false);
    // Drop the busy / attention title marker so the tab is not handed back to
    // the shell still marked busy when the session exits.
    attention.reset();
    // Stop asking the terminal for focus reports before handing it back.
    terminal.write(DISABLE_FOCUS_REPORTING);
    tui.stop();
  };

  const beginClose = (error?: Error) => {
    if (closed) return;
    closed = true;
    restoreTerminal();
    if (error) rejectClosed(error);
    else resolveClosed();
    // Runtime stop is best-effort after the shell has its terminal back. A
    // double-Escape/Ctrl-C interrupt may already have one in flight; reuse it.
    if (!interruptRequested) void input.driver.stop().catch(() => {});
  };

  const handleProcessExit = (exitCode: number, error?: Error): void => {
    process.exitCode = exitCode;
    beginClose(input.onProcessExit ? undefined : error);
    input.onProcessExit?.(exitCode, error);
  };

  const beginGracefulClose = () => beginClose();

  function handleSigint(): void {
    handleProcessExit(128 + 2);
  }

  function handleSigterm(): void {
    handleProcessExit(128 + 15);
  }

  function handleSighup(): void {
    handleProcessExit(128 + 1);
  }

  function handleUncaughtException(error: Error): void {
    handleProcessExit(1, error);
  }

  function handleUnhandledRejection(reason: unknown): void {
    handleProcessExit(1, reason instanceof Error ? reason : new Error(String(reason)));
  }

  process.once('SIGINT', handleSigint);
  process.once('SIGTERM', handleSigterm);
  process.once('SIGHUP', handleSighup);
  process.once('uncaughtException', handleUncaughtException);
  process.once('unhandledRejection', handleUnhandledRejection);

  const respondToPendingPermission = (
    decision: 'allow' | 'deny',
    rememberForTurn = false,
  ): boolean => {
    const request = activePermissionRequest(state);
    if (!request || permissionResponseInFlightRequestId !== null) return false;
    permissionResponseInFlightRequestId = request.requestId;
    // Keep the prompt visible until the driver accepts the response. If it
    // rejects, the user can retry with y/n instead of being stuck. A resolved
    // call only means the response was submitted; the event stream owns dequeue.
    void input.driver.respondToPermission({
      requestId: request.requestId,
      decision,
      ...(decision === 'allow' && request.rememberForTurnAllowed
        ? { rememberForTurn }
        : {}),
    })
      .catch((error) => {
        if (permissionResponseInFlightRequestId === request.requestId) {
          permissionResponseInFlightRequestId = null;
        }
        reportError(error);
      });
    return true;
  };

  // Refill the editor from a retract result, prepended to any current draft.
  // Shared by the interrupt path and the alt+↑ path. The text always comes
  // from `driver.retractQueued()` — a synchronous in-process read of the
  // runtime's authoritative queues — never from the render mirror, which can
  // lag a step-boundary consumption and would resurrect an already-consumed
  // steering message for a double execution. Clears the local mirror.
  const refillEditorFromQueues = (joined: string) => {
    state.steering = [];
    state.followup = [];
    if (!joined) return;
    const draft = editor.getText();
    editor.setText(draft ? `${joined}\n\n${draft}` : joined);
  };

  const requestTurnInterrupt = () => {
    if (interruptRequested) return;
    interruptRequested = true;
    // The convergence window (stop issued, turn not yet terminal) accepts no
    // new input: submits would race the abort and could open work the user
    // just cancelled. The normal turn finally restores submit; a rejected
    // stop restores it here.
    editor.disableSubmit = true;
    // Retract synchronously from the authoritative queue before stop() clears
    // it: only messages still queued come back for re-editing; anything the
    // turn already consumed stays consumed (it is in the transcript/ledger).
    // CLI-held fallback texts (never reached the runtime) come back too.
    refillEditorFromQueues(
      [takePendingFallback(), input.driver.retractQueued?.() ?? '']
        .filter(Boolean)
        .join('\n\n'),
    );
    requestRender();
    void input.driver.stop().catch((error) => {
      interruptRequested = false;
      editor.disableSubmit = false;
      reportError(error);
    });
  };

  // Open a fresh turn from a submitted prompt (idle path). Control actions hold
  // `busy`, so a prompt typed mid-switch is ignored rather than racing it.
  const submitPrompt = (prompt: string) => {
    if (busy || !prompt.trim()) {
      requestRender();
      return;
    }
    editor.addToHistory(prompt);
    if (handleSlashCommand(prompt)) return;
    runAgentTurn(prompt);
  };

  // Fallback handoff owner. A `fallback` outcome while the turn is running
  // means the runtime has no live steering owner YET (the begin window) or
  // just lost it; the runtime keeps no record of the text, so the CLI owns
  // delivery: retry the SAME enqueue until the owner appears, and flush any
  // remainder into the next turn at the turn boundary. Never a bounded wait —
  // a normal turn outlives any fixed budget and the text must not vanish.
  const FALLBACK_RETRY_MS = 100;
  let fallbackRetryTimer: ReturnType<typeof setInterval> | null = null;

  const stopFallbackRetry = () => {
    if (fallbackRetryTimer === null) return;
    clearInterval(fallbackRetryTimer);
    fallbackRetryTimer = null;
  };

  const retryPendingFallback = () => {
    if (closed || !turnRunning || state.pendingFallback.length === 0) {
      stopFallbackRetry();
      return;
    }
    const remaining: typeof state.pendingFallback = [];
    for (const entry of state.pendingFallback) {
      const outcome = entry.enqueue === 'steer'
        ? input.driver.steer?.(entry.text)
        : input.driver.queueMessage?.(entry.text);
      if (outcome?.kind !== 'queued') remaining.push(entry);
    }
    if (remaining.length === state.pendingFallback.length) return;
    state.pendingFallback = remaining;
    if (remaining.length === 0) stopFallbackRetry();
    // The queue mirror updates only from `queue_update` events (single path);
    // this render just drops the delivered entries from the fallback list.
    requestRender();
  };

  const deferFallback = (text: string, enqueue: 'steer' | 'queue') => {
    state.pendingFallback.push({ text, enqueue });
    fallbackRetryTimer ??= setInterval(retryPendingFallback, FALLBACK_RETRY_MS);
    requestRender();
  };

  /** Drain the CLI-held fallback texts (delivery order), stopping the retry loop. */
  const takePendingFallback = (): string => {
    stopFallbackRetry();
    if (state.pendingFallback.length === 0) return '';
    const joined = state.pendingFallback.map((entry) => entry.text).join('\n\n');
    state.pendingFallback = [];
    return joined;
  };

  // Enter during a turn steers it (inject at the next step boundary); the
  // runtime falls back to a fresh turn if the run already ended.
  const steerRunningTurn = (text: string) => {
    if (!text.trim()) {
      requestRender();
      return;
    }
    editor.addToHistory(text);
    const outcome = input.driver.steer?.(text);
    if (!outcome || outcome.kind === 'fallback') {
      if (turnRunning) deferFallback(text, 'steer');
      else submitPrompt(text);
      return;
    }
    // Queued: the runtime's `queue_update` event refreshes the mirror.
    requestRender();
  };

  // Alt+Enter: during a turn, queue the text to open the next turn; when idle,
  // it submits like Enter.
  const handleAltEnter = () => {
    // Mirror Enter's control-busy guard BEFORE touching the editor: during a
    // control action (busy without a running turn) submitPrompt would drop the
    // prompt, so keep the draft in place instead of clearing it into the void.
    if (busy && !turnRunning) return;
    // Interrupt convergence window: the turn is being stopped, so nothing may
    // be queued onto it and no fresh turn may open — keep the draft.
    if (interruptRequested) return;
    const text = editor.getExpandedText().trim();
    if (!text) return;
    editor.setText('');
    if (!turnRunning) {
      submitPrompt(text);
      return;
    }
    editor.addToHistory(text);
    const outcome = input.driver.queueMessage?.(text);
    if (!outcome || outcome.kind === 'fallback') {
      if (turnRunning) deferFallback(text, 'queue');
      else submitPrompt(text);
      return;
    }
    // Queued: the runtime's `queue_update` event refreshes the mirror.
    requestRender();
  };

  // Alt+↑: take back every queued message (both queues plus CLI-held fallback
  // texts), joined and prepended to the current draft for re-editing.
  const retractQueuedMessages = () => {
    refillEditorFromQueues(
      [takePendingFallback(), input.driver.retractQueued?.() ?? '']
        .filter(Boolean)
        .join('\n\n'),
    );
    requestRender();
  };

  editor.onSubmit = (prompt) => {
    if (turnRunning) {
      steerRunningTurn(prompt);
      return;
    }
    submitPrompt(prompt);
  };

  // Runs one agent turn rendered in the transcript, then lets the host decide
  // whether to auto-continue (goal). Shared by user submits and goal injections.
  function runAgentTurn(prompt: string): void {
    busy = true;
    turnRunning = true;
    turnStartedAt = Date.now();
    startTurnElapsedTicker();
    interruptRequested = false;
    lastTurnEscapeAt = 0;
    // The editor stays submittable during a turn so Enter steers the running
    // turn (see editor.onSubmit) instead of being swallowed.
    terminal.setProgress(true);
    attention.promptTurnStarted();
    requestRender();

    let permissionAlerted = false;
    let turnOutcome: TurnOutcome | undefined;
    void submitPromptToTranscript({
      state,
      driver: input.driver,
      prompt,
      // A turn failing is worth pulling the user back, regardless of how long it
      // ran — a quick failure in a background tab would otherwise stay silent.
      onError: () => attention.attentionNeeded(),
      onChange: () => {
        if (
          permissionResponseInFlightRequestId !== null
          && activePermissionRequest(state)?.requestId !== permissionResponseInFlightRequestId
        ) {
          permissionResponseInFlightRequestId = null;
        }
        // A pending decision blocks the turn; ring an unfocused terminal once when
        // the prompt first appears (not on every render) so the user is not left
        // waiting on a prompt they cannot see.
        if (state.pendingInteraction) {
          if (!permissionAlerted) {
            permissionAlerted = true;
            attention.attentionNeeded();
          }
        } else {
          permissionAlerted = false;
        }
        shellRunElapsedTicker.sync();
        syncUserQuestionOverlay();
        requestRender();
      },
    }).then((outcome) => {
      turnOutcome = outcome;
    }).finally(() => {
      busy = false;
      turnRunning = false;
      turnStartedAt = undefined;
      stopTurnElapsedTicker();
      interruptRequested = false;
      editor.disableSubmit = false;
      terminal.setProgress(false);
      attention.promptTurnEnded();
      requestRender();
      if (closed) return;
      // Turn boundary flush: CLI-held fallback texts that never reached the
      // runtime (the enqueue retry never found a live owner) are delivered
      // FIRST, then queued followups (alt+Enter) — both open the next turn
      // before any goal auto-continuation. Consumed here outside the turn
      // stream, so clear the local mirror explicitly.
      const fallbackText = takePendingFallback();
      const followup = input.driver.takePendingFollowup?.();
      const nextPrompt = [fallbackText, followup ?? ''].filter(Boolean).join('\n\n');
      if (nextPrompt) {
        state.steering = [];
        state.followup = [];
        if (turnOutcome?.kind !== 'completed') {
          // The turn was aborted or errored: auto-opening a turn would defeat
          // the interrupt (or hammer a failure). Keep the undelivered text as
          // an editable draft instead, merged ahead of any current draft.
          refillEditorFromQueues(nextPrompt);
          requestRender();
          return;
        }
        requestRender();
        runAgentTurn(nextPrompt);
        return;
      }
      // Do not auto-continue (goal) if the user interrupted the turn
      // (double-Escape → driver.stop() → user_stop/abort) or it ended in error.
      // An autonomous loop MUST halt on the Stop affordance and must not hammer
      // a failing turn — mirrors the desktop `turnAborted` guard.
      if (turnOutcome?.kind === 'completed') {
        input.onTurnComplete?.(turnOutcome.turnId, (text) => runAgentTurn(text));
      }
    });
  }

  const setModel = async (nextModel: string) => {
    await input.driver.setModel(nextModel);
    model = nextModel;
    const match = input.modelChoices?.find((choice) => choice.model === nextModel);
    if (match) modelContextWindow = match.contextWindow;
    thinkingLevel = undefined;
    thinkingLevels = providerType ? thinkingVariantsForModel(providerType, nextModel) : [];
    state.entries.push({
      kind: 'notice',
      level: 'info',
      text: `Model: ${nextModel}`,
    });
    requestRender();
  };

  // Cross-connection /model: rebind the session to the chosen connection + model.
  // Updates the provider (and thus the thinking variants) and the status line.
  const setModelChoice = async (choice: ModelChoice) => {
    await input.driver.setModel(choice.model, choice.connectionSlug);
    model = choice.model;
    connectionSlug = choice.connectionSlug;
    providerType = choice.providerType;
    modelContextWindow = choice.contextWindow;
    thinkingLevel = undefined;
    thinkingLevels = thinkingVariantsForModel(choice.providerType, choice.model);
    state.entries.push({
      kind: 'notice',
      level: 'info',
      text: `Model: ${choice.model} (${choice.connectionName || choice.connectionSlug})`,
    });
    requestRender();
  };

  const setThinkingLevel = async (nextLevel: ThinkingLevel | undefined) => {
    await input.driver.setThinkingLevel(nextLevel);
    thinkingLevel = nextLevel;
    state.entries.push({
      kind: 'notice',
      level: 'info',
      text: nextLevel ? `Thinking: ${nextLevel}` : 'Thinking: default',
    });
    requestRender();
  };

  // Adopt a switch/rewind result: the active session is now `summary` with
  // `messages`. Shared by switchSession and rewindToTurn so both land the same
  // runner state (model/connection/thinking/transcript/scroll).
  const applySwitchResult = async ({ summary, messages }: MakaSessionSwitchResult): Promise<void> => {
    cwd = summary.cwd ?? cwd;
    model = summary.model;
    const previousConnectionSlug = connectionSlug;
    connectionSlug = summary.llmConnectionSlug;
    providerType = input.modelChoices?.find((choice) => (
      choice.connectionSlug === summary.llmConnectionSlug
    ))?.providerType ?? (previousConnectionSlug === summary.llmConnectionSlug ? providerType : undefined);
    permissionMode = summary.permissionMode;
    thinkingLevel = summary.thinkingLevel;
    thinkingLevels = providerType ? thinkingVariantsForModel(providerType, summary.model) : [];
    refreshEditorCwd?.(cwd);
    replaceTranscriptWithStoredMessages(state, messages);
    resetShellRunSessionState();
    if (input.listShellRunUpdates) {
      const sessionId = summary.id;
      hydratingShellRunsFor = sessionId;
      await hydrateShellRuns(sessionId, shellRunHydrationEpoch);
    } else {
      hydratingShellRunsFor = undefined;
    }
    shellRunElapsedTicker.sync();
  };

  // The driver validates the durable cwd before adopting the resumed session.
  // A failure leaves the active session untouched and the next prompt still
  // lands on the old one.
  const switchSession = async (sessionId: string) => {
    const result = await input.driver.switchSession(sessionId);
    await applySwitchResult(result);
    if (result.messages.length === 0) {
      state.entries.push({
        kind: 'notice',
        level: 'info',
        text: `Resumed session "${result.summary.name}"`,
      });
    }
    requestRender();
  };

  // Rewind branches the active session to just before the chosen turn and
  // switches onto the branch (driver.rewindToTurn), then refills the editor with
  // that turn's prompt. The original session is left intact, so this is
  // non-destructive and inherits the branch's resume guarantees.
  const rewindToTurn = async (turnId: string) => {
    const result = await input.driver.rewindToTurn(turnId);
    await applySwitchResult(result);
    // Refill the editor with the discarded turn's prompt so the user can edit
    // and resend it. The picker only arms when the editor is neutral (empty
    // draft, no autocomplete), so overwriting the text loses no in-progress work.
    editor.setText(result.prompt);
    state.entries.push({
      kind: 'notice',
      level: 'info',
      text: '已回退到该轮之前（分支为新会话，原会话保留），该轮 prompt 已回填输入框，可修改后重新发送。',
    });
    requestRender();
  };

  const showBottomPicker = (picker: Component): OverlayHandle => tui.showOverlay(picker, {
    anchor: 'bottom-left',
    width: '100%',
    maxHeight: Math.max(1, terminal.rows - BOTTOM_PICKER_MARGIN_ROWS),
    margin: { bottom: BOTTOM_PICKER_MARGIN_ROWS },
  });

  const closeUserQuestionOverlay = (): void => {
    userQuestionOverlay?.hide();
    userQuestionOverlay = undefined;
  };

  const finishUserQuestion = (requestId: string, answers: Array<string | null>): void => {
    if (userQuestionInFlight) return;
    const respond = input.driver.respondToUserQuestion;
    if (!respond) {
      reportError(new Error('User questions are unavailable on this driver.'));
      return;
    }
    userQuestionInFlight = true;
    closeUserQuestionOverlay();
    void respond.call(input.driver, { requestId, answers })
      .then(() => {
        userQuestionInFlight = false;
        if (activeUserQuestionRequest(state)?.requestId === requestId) {
          completePendingInteraction(state, requestId);
        }
        userQuestionProgress = undefined;
        syncUserQuestionOverlay();
        requestRender();
      })
      .catch((error) => {
        userQuestionInFlight = false;
        reportError(error);
        syncUserQuestionOverlay();
      });
  };

  const showUserQuestion = (): void => {
    const request = activeUserQuestionRequest(state);
    const progress = userQuestionProgress;
    if (!request || !progress || progress.requestId !== request.requestId) return;
    const question = request.questions[progress.index];
    if (!question) {
      finishUserQuestion(request.requestId, progress.answers);
      return;
    }
    closeUserQuestionOverlay();
    const advance = (answer: string | null): void => {
      progress.answers[progress.index] = answer;
      progress.index += 1;
      showUserQuestion();
    };
    userQuestionOverlay = showBottomPicker(new UserQuestionOverlay(tui, {
      title: question.question,
      rightLabel: `${progress.index + 1} / ${request.questions.length}`,
      hint: '↑↓ move · type to answer · Enter select · Esc unanswered · Ctrl+C stop',
      placeholder: 'Other: type your answer…',
      options: question.options,
      onSelectOption: (index) => advance(question.options[index]?.label ?? null),
      onSubmitText: (value) => advance(value),
      onSkip: () => advance(null),
    }));
  };

  const syncUserQuestionOverlay = (): void => {
    const request = activeUserQuestionRequest(state);
    if (!request) {
      closeUserQuestionOverlay();
      userQuestionProgress = undefined;
      return;
    }
    if (userQuestionInFlight) return;
    if (userQuestionProgress?.requestId !== request.requestId) {
      userQuestionProgress = {
        requestId: request.requestId,
        index: 0,
        answers: Array.from({ length: request.questions.length }, () => null),
      };
      showUserQuestion();
    }
  };

  const showSelectPicker = (
    title: string,
    rightLabel: string,
    items: SelectItem[],
    onSelect: (item: SelectItem) => void,
    options: { minPrimaryColumnWidth: number; maxPrimaryColumnWidth: number; selectedIndex?: number; hint?: string },
  ): void => {
    const list = new SelectList(items, 10, selectListTheme(), {
      minPrimaryColumnWidth: options.minPrimaryColumnWidth,
      maxPrimaryColumnWidth: options.maxPrimaryColumnWidth,
    });
    if (options.selectedIndex !== undefined) list.setSelectedIndex(options.selectedIndex);
    const picker = new PickerOverlay(list, { title, rightLabel, hint: options.hint });
    let overlay: OverlayHandle | undefined;
    list.onSelect = (item) => {
      overlay?.hide();
      onSelect(item);
    };
    list.onCancel = () => {
      overlay?.hide();
    };
    overlay = showBottomPicker(picker);
  };

  const compactSession = async () => {
    state.entries.push({
      kind: 'notice',
      level: 'info',
      text: 'Compacting context…',
    });
    requestRender();
    await submitCompactToTranscript({
      state,
      driver: input.driver,
      onChange: requestRender,
    });
  };

  const showSessionList = async () => {
    const sessions = await input.driver.listSessions();
    const availability = new Map(await Promise.all(sessions.map(async (session) => {
      return [
        session.id,
        await input.driver.getSessionResumeAvailability?.(session)
          ?? await inspectSessionResumeAvailability(session),
      ] as const;
    })));
    const renderScope = (): void => {
      const visibleSessions = sessionListScope === 'current'
        ? sessions.filter((session) => session.cwd === cwd)
        : sessions;
      const items: SelectItem[] = visibleSessions.map((session) => {
        const state = availability.get(session.id);
        const location = sessionListScope === 'all' && session.cwd ? ` ${basename(session.cwd)}` : '';
        return {
          value: session.id,
          label: session.name || session.id,
          description: state?.available === false
            ? `${shortSessionId(session.id)} ${state.reason}`
            : `${shortSessionId(session.id)}${location} ${session.llmConnectionSlug} ${session.model}`,
        };
      });
      const list = new SelectList(items, 10, selectListTheme(), {
        minPrimaryColumnWidth: 20,
        maxPrimaryColumnWidth: Math.max(20, terminal.columns - 30),
      });
      let overlay: OverlayHandle | undefined;
      list.onSelect = (item) => {
        if (availability.get(item.value)?.available === false) return;
        overlay?.hide();
        void runControl(() => switchSession(item.value));
      };
      list.onCancel = () => overlay?.hide();
      overlay = showBottomPicker(new PickerOverlay(list, {
        title: 'Resume Session',
        rightLabel: sessionListScope === 'current' ? 'Current' : 'All',
        hint: 'Tab scope · ↑↓ move · Enter select · Esc close',
        onInput: (data) => {
          if (!matchesKey(data, Key.tab) || isKeyRelease(data) || isKeyRepeat(data)) return false;
          sessionListScope = sessionListScope === 'current' ? 'all' : 'current';
          overlay?.hide();
          renderScope();
          return true;
        },
      }));
    };
    renderScope();
  };

  const showRewindPicker = async () => {
    const targets = await input.driver.listRewindTargets();
    if (targets.length === 0) {
      state.entries.push({
        kind: 'notice',
        level: 'info',
        text: '没有可回退的轮次。',
      });
      requestRender();
      return;
    }
    const items: SelectItem[] = targets.map((target) => ({
      value: target.turnId,
      label: target.label,
    }));
    showSelectPicker(
      'Rewind',
      'Rewind',
      items,
      (item) => {
        void runControl(() => rewindToTurn(item.value));
      },
      { minPrimaryColumnWidth: 24, maxPrimaryColumnWidth: 48, hint: '回到选定轮次之前（丢弃该轮及之后，prompt 回填输入框） · enter 选择 / esc 取消' },
    );
  };

  const newSession = () => {
    input.driver.startNewSession();
    resetShellRunSessionState();
    // Fresh transcript for the fresh session; the next prompt creates it on disk.
    // Leave the transcript empty (no confirmation notice) so /new opens on the
    // same welcome block as a cold start — the welcome block is the "fresh
    // session, send a prompt to begin" cue. A notice here would make entries
    // non-empty and suppress it.
    replaceTranscriptWithStoredMessages(state, []);
    shellRunElapsedTicker.sync();
    requestRender();
  };

  const showHelp = () => {
    // Derive the command list from the registry so /help never drifts from the
    // real commands. Keybindings are not commands, so they are listed by hand.
    const commands = slashCommands
      .map((command) => `  /${command.name} — ${command.description}`)
      .join('\n');
    const keybindings = [
      '  Ctrl+O — expand or collapse all tool output',
      '  Ctrl+T — expand or collapse the latest thinking block',
      '  Scroll the transcript with your terminal or trackpad',
      '  Enter (during a turn) — steer: inject a message into the running turn',
      '  Alt+Enter (during a turn) — queue a message for the next turn',
      '  Alt+↑ — take queued messages back into the editor to re-edit',
      '  Esc Esc (during a turn) — interrupt the turn',
      '  Esc Esc (when idle) — rewind to an earlier turn',
      '  Ctrl+C — stop the turn, clear input, or press twice to exit',
      '  Ctrl+D — exit when input is empty',
    ].join('\n');
    state.entries.push({
      kind: 'notice',
      level: 'info',
      text: `Commands\n${commands}\n\nKeybindings\n${keybindings}`,
    });
    requestRender();
  };

  const showModelList = () => {
    const choices = input.modelChoices;
    // Cross-connection picker when the caller supplied choices across all ready
    // connections; otherwise the single-connection list (typed /model, tests).
    if (choices && choices.length > 0) {
      const selectedIndex = choices.findIndex(
        (choice) => choice.model === model && choice.connectionSlug === connectionSlug,
      );
      showSelectPicker(
        'Select Model',
        connectionSlug,
        modelChoicePickerItems(choices, { model, connectionSlug }),
        (item) => {
          const choice = choices[Number(item.value)];
          if (!choice) return;
          void runControl(() => setModelChoice(choice));
        },
        {
          minPrimaryColumnWidth: 24,
          maxPrimaryColumnWidth: 48,
          ...(selectedIndex >= 0 ? { selectedIndex } : {}),
        },
      );
      return;
    }
    showSelectPicker(
      'Select Model',
      connectionSlug,
      modelPickerItems(model, input.models),
      (item) => {
        void runControl(() => setModel(item.value));
      },
      { minPrimaryColumnWidth: 24, maxPrimaryColumnWidth: 48 },
    );
  };

  const showThinkingLevelList = () => {
    const items = thinkingLevelPickerItems(thinkingLevels, thinkingLevel);
    showSelectPicker(
      'Select Thinking Level',
      thinkingLevel ?? 'default',
      items,
      (item) => {
        const level = item.value === 'default' ? undefined : (item.value as ThinkingLevel);
        if (level !== undefined && !isThinkingLevel(level)) return;
        void runControl(() => setThinkingLevel(level));
      },
      {
        minPrimaryColumnWidth: 16,
        maxPrimaryColumnWidth: 24,
        selectedIndex: items.findIndex((item) => item.value === (thinkingLevel ?? 'default')),
      },
    );
  };

  const setPermissionMode = async (mode: PermissionMode) => {
    await input.driver.setPermissionMode(mode);
    permissionMode = mode;
    state.entries.push({
      kind: 'notice',
      level: 'info',
      text: `Permission mode: ${mode}`,
    });
    requestRender();
  };

  const showPermissionModeList = () => {
    const items = permissionModePickerItems(permissionMode);
    showSelectPicker(
      'Select Permission Mode',
      permissionMode,
      items,
      (item) => {
        if (!isPermissionMode(item.value)) return;
        const mode = item.value;
        void runControl(() => setPermissionMode(mode));
      },
      {
        minPrimaryColumnWidth: 16,
        maxPrimaryColumnWidth: 24,
        selectedIndex: items.findIndex((item) => item.value === permissionMode),
      },
    );
  };

  const slashCommands: MakaSlashCommand[] = [
    {
      name: 'compact',
      description: 'Compact session context',
      run: (parts: string[]) => {
        if (parts.length !== 1) {
          state.entries.push({
            kind: 'notice',
            level: 'error',
            text: 'Usage: /compact',
          });
          requestRender();
          return;
        }
        void runControl(compactSession);
      },
    },
    {
      name: 'exit',
      description: 'Exit Maka',
      run: () => {
        beginGracefulClose();
      },
    },
    {
      name: 'help',
      description: 'Show commands and keybindings',
      run: () => {
        void runControl(async () => showHelp());
      },
    },
    {
      name: 'new',
      description: 'Start a new session',
      run: () => {
        void runControl(async () => newSession());
      },
    },
    {
      name: 'model',
      description: 'Select model',
      run: (parts: string[]) => {
        if (parts.length === 1) {
          showModelList();
          return;
        }
        const nextModel = parts.length === 2 ? parts[1] : undefined;
        if (!nextModel) {
          state.entries.push({
            kind: 'notice',
            level: 'error',
            text: 'Usage: /model <model-id>',
          });
          requestRender();
          return;
        }
        void runControl(() => setModel(nextModel));
      },
    },
    {
      name: 'thinking',
      description: 'Set thinking level',
      run: (parts: string[]) => {
        if (parts.length === 1) {
          if (thinkingLevels.length === 0) {
            state.entries.push({
              kind: 'notice',
              level: 'info',
              text: '当前模型不支持思考级别切换。',
            });
            requestRender();
            return;
          }
          showThinkingLevelList();
          return;
        }
        const token = parts.length === 2 ? parts[1] : undefined;
        // `off` is a real level now (maps to reasoningEffort:'none' / thinking
        // disabled), not a synonym for 默认. Only `default` clears the override.
        const level = token === 'default' ? undefined : token;
        // Reject levels the current model does not support (P2-1): the picker
        // already restricts to `thinkingLevels`, but the typed command path
        // must too so the statusbar never advertises a level the runtime drops.
        if (level !== undefined && (!isThinkingLevel(level) || !thinkingLevels.includes(level))) {
          state.entries.push({
            kind: 'notice',
            level: 'error',
            text: thinkingLevels.length === 0
              ? '当前模型不支持思考级别切换。'
              : `Usage: /thinking ${['default', ...thinkingLevels].join('|')}`,
          });
          requestRender();
          return;
        }
        void runControl(() => setThinkingLevel(level));
      },
    },
    {
      name: 'permissions',
      description: 'Set permission mode',
      run: (parts: string[]) => {
        if (parts.length === 1) {
          showPermissionModeList();
          return;
        }
        const mode = parts.length === 2 ? parts[1] : undefined;
        if (!isPermissionMode(mode)) {
          state.entries.push({
            kind: 'notice',
            level: 'error',
            text: `Usage: /permissions ${PERMISSION_MODES.join('|')}`,
          });
          requestRender();
          return;
        }
        void runControl(() => setPermissionMode(mode));
      },
    },
    {
      name: 'rename',
      description: 'Rename current session',
      run: (parts: string[]) => {
        const name = parts.slice(1).join(' ').trim();
        if (!name) {
          state.entries.push({
            kind: 'notice',
            level: 'error',
            text: 'Usage: /rename <new name>',
          });
          requestRender();
          return;
        }
        void runControl(async () => {
          await input.driver.renameSession(name);
          state.entries.push({
            kind: 'notice',
            level: 'info',
            text: `Session renamed to "${name}"`,
          });
          requestRender();
        });
      },
    },
    {
      name: 'rewind',
      description: 'Rewind to an earlier turn',
      run: () => {
        void runControl(showRewindPicker);
      },
    },
    {
      name: 'session',
      description: 'Resume session',
      run: (parts: string[]) => {
        if (parts.length === 1) {
          void runControl(showSessionList);
          return;
        }
        const sessionId = parts.length === 2 ? parts[1] : undefined;
        if (!sessionId) {
          state.entries.push({
            kind: 'notice',
            level: 'error',
            text: 'Usage: /session <session-id>',
          });
          requestRender();
          return;
        }
        void runControl(() => switchSession(sessionId));
      },
    },
  ].sort((left, right) => left.name.localeCompare(right.name));

  const handleSlashCommand = (prompt: string): boolean => {
    const parts = prompt.trim().split(/\s+/);
    const command = slashCommands.find((candidate) => `/${candidate.name}` === parts[0]);
    if (!command) return false;
    command.run(parts);
    return true;
  };

  refreshEditorCwd = (nextCwd) => {
    editor.setAutocompleteProvider(new MakaAutocompleteProvider(nextCwd, slashCommands));
  };
  refreshEditorCwd(cwd);

  tui.addInputListener((data) => {
    // Once closing has begun, swallow any buffered input that reaches the
    // listener while the terminal is being torn down.
    if (closed) return { consume: true };
    // DEC 1004 focus reports drive the attention layer. Consume them so they
    // never reach the editor as stray input; they are not user keystrokes.
    if (data === FOCUS_IN_SEQUENCE) {
      attention.focusChanged(true);
      return { consume: true };
    }
    if (data === FOCUS_OUT_SEQUENCE) {
      attention.focusChanged(false);
      return { consume: true };
    }
    // Kitty keyboard protocol terminals (Ghostty/Kitty) emit separate press and
    // release events. pi-tui only filters releases on the focused-component
    // path, but this raw listener runs before that, so a release would
    // immediately undo a Ctrl+O/Ctrl+T toggle and a single Escape's
    // press+release pair could count as a double Escape. We never act on
    // releases here; returning undefined lets the TUI apply its own filtering.
    if (isKeyRelease(data)) return undefined;
    if (
      activeUserQuestionRequest(state)
      && turnRunning
      && matchesKey(data, Key.ctrl('c'))
      && !isKeyRepeat(data)
    ) {
      if (interruptRequested) handleProcessExit(0);
      else requestTurnInterrupt();
      return { consume: true };
    }
    if (tui.hasOverlay()) return undefined;
    // Alt+Enter: queue a followup (during a turn) or submit (when idle). Alt+↑:
    // take back the queued messages to re-edit. Neither is an editor binding
    // (newline is shift+enter/ctrl+j; history is plain up), so intercepting
    // here does not collide with the editor's own keys.
    if (matchesKey(data, Key.alt('enter')) && !isKeyRepeat(data)) {
      handleAltEnter();
      return { consume: true };
    }
    if (matchesKey(data, Key.alt('up')) && !isKeyRepeat(data)) {
      // Always retract from the authority: the render mirror lags the
      // queue_update event, so an enqueue followed by Alt+Up in the same
      // tick would see an empty mirror while the runtime holds the message.
      // Alt+Up is not an editor binding, and an empty retract refill is a
      // no-op, so consuming unconditionally loses nothing.
      retractQueuedMessages();
      return { consume: true };
    }
    if (matchesKey(data, Key.ctrl('c')) && isKeyRepeat(data)) return { consume: true };
    if (!matchesKey(data, Key.ctrl('c'))) lastIdleCtrlCAt = 0;
    // The idle rewind gesture requires two *consecutive* Escapes. Any other key
    // in between breaks it, so a stale first Escape never pairs with a much later
    // one (e.g. `Esc`, type, `Esc`).
    if (!matchesKey(data, Key.escape)) lastIdleEscapeAt = 0;
    if (matchesKey(data, Key.ctrl('o')) && !isKeyRepeat(data)) {
      if (togglePendingPermissionDetails(state)) {
        requestRender();
        return { consume: true };
      }
      if (toggleAllToolExpansion(state)) {
        requestRender();
        return { consume: true };
      }
    }
    if (matchesKey(data, Key.ctrl('t')) && !isKeyRepeat(data)) {
      if (toggleAllThinkingExpansion(state)) {
        requestRender();
        return { consume: true };
      }
    }
    const pendingPermission = activePermissionRequest(state);
    if (pendingPermission) {
      if (matchesKey(data, 'y') || matchesKey(data, Key.enter) || matchesKey(data, Key.return)) {
        respondToPendingPermission('allow', false);
        return { consume: true };
      }
      if (
        matchesKey(data, 'a')
        && pendingPermission.rememberForTurnAllowed
      ) {
        respondToPendingPermission('allow', true);
        return { consume: true };
      }
      if (matchesKey(data, 'n') || matchesKey(data, Key.escape)) {
        respondToPendingPermission('deny');
        return { consume: true };
      }
    }
    if (turnRunning && matchesKey(data, Key.ctrl('c'))) {
      if (interruptRequested) handleProcessExit(0);
      else requestTurnInterrupt();
      return { consume: true };
    }
    // Double Escape interrupts the running turn. This must sit below the
    // permission branch so Escape keeps meaning "deny" while a prompt is
    // pending, and it only arms while a prompt turn is actually running.
    if (turnRunning && matchesKey(data, Key.escape)) {
      // Once an interrupt is issued, swallow further Escapes until the turn
      // ends so a still-settling stop is not requested twice. A rejected stop
      // re-arms interruption so the user can retry within the same turn.
      if (interruptRequested) return { consume: true };
      const now = Date.now();
      if (now - lastTurnEscapeAt <= DOUBLE_ESCAPE_INTERRUPT_WINDOW_MS) {
        lastTurnEscapeAt = 0;
        requestTurnInterrupt();
      } else {
        lastTurnEscapeAt = now;
      }
      return { consume: true };
    }
    // Idle double Escape opens the rewind picker (the same gesture that
    // interrupts a running turn). This sits below the turnRunning branch, so it
    // only arms when nothing is running. It engages only when the editor has no
    // Escape work of its own — empty draft, no autocomplete popup — so the
    // editor keeps owning Escape for clearing input and closing autocomplete.
    // The first Escape falls through to the editor; only the second, within the
    // window, consumes and opens the picker.
    if (!busy && !turnRunning && matchesKey(data, Key.escape)) {
      const editorNeutral = editor.getText().length === 0 && !editor.isShowingAutocomplete();
      if (!editorNeutral) {
        lastIdleEscapeAt = 0;
        return undefined;
      }
      const now = Date.now();
      if (lastIdleEscapeAt && now - lastIdleEscapeAt <= DOUBLE_ESCAPE_INTERRUPT_WINDOW_MS) {
        lastIdleEscapeAt = 0;
        void runControl(showRewindPicker);
        return { consume: true };
      }
      lastIdleEscapeAt = now;
      return undefined;
    }
    if (!turnRunning && matchesKey(data, Key.ctrl('c')) && editor.getText().length > 0) {
      lastIdleCtrlCAt = 0;
      editor.setText('');
      requestRender();
      return { consume: true };
    }
    if (!turnRunning && matchesKey(data, Key.ctrl('c'))) {
      const now = Date.now();
      if (lastIdleCtrlCAt && now - lastIdleCtrlCAt <= DOUBLE_CTRL_C_EXIT_WINDOW_MS) {
        lastIdleCtrlCAt = 0;
        handleProcessExit(0);
      } else {
        lastIdleCtrlCAt = now;
        state.entries.push({ kind: 'notice', level: 'info', text: 'Press Ctrl+C again to exit.' });
        requestRender();
      }
      return { consume: true };
    }
    if (matchesKey(data, Key.ctrl('d'))) {
      if (busy || turnRunning) return { consume: true };
      if (editor.getText().length === 0) {
        beginGracefulClose();
        return { consume: true };
      }
      return undefined;
    }
    return undefined;
  });

  // Keep older output in the terminal's own scrollback: the transcript is never
  // windowed, so when it shrinks (collapsing tool output, a thinking block
  // re-wrapping) a full clear would wipe the scrollback the user scrolls through.
  // Differential rendering clears the vacated rows without the wipe.
  //
  // The Ctrl+O / Ctrl+T toggles are viewport-anchored for the same reason: an
  // entry above the live viewport lives in terminal scrollback, which cannot
  // be rewritten, so resizing it would push pi-tui's differential renderer
  // into a scrollback-clearing full redraw (its `firstChanged < viewportTop`
  // path). The toggles therefore retarget only entries inside the viewport;
  // see entryInLiveViewport in pi-transcript.ts (#1097). A block whose own
  // expansion pushed its head above the viewport can consequently never be
  // collapsed in place (#1134): the toggles still flip the default and append
  // a notice, and the expanded content stays readable in scrollback.
  tui.setClearOnShrink(false);
  tui.addChild(layout);
  tui.setFocus(editorSurface);
  try {
    tui.start();
    // The AttentionController set the initial title in its constructor. Enable
    // focus reporting so it learns when the terminal is backgrounded; the input
    // listener forwards the `\x1b[I` / `\x1b[O` reports. This must run *after*
    // tui.start() puts the terminal in raw mode — otherwise the terminal's reply
    // to the enable sequence (a focus-in `\x1b[I`) is echoed by the cooked-mode
    // line discipline and leaks onto the screen as a stray `^[[I` on launch.
    terminal.write(ENABLE_FOCUS_REPORTING);
  } catch (error) {
    beginClose(error instanceof Error ? error : new Error(String(error)));
  }

  return closedPromise;
}

const BOTTOM_PICKER_MARGIN_ROWS = 4;

// The editor's autocomplete window height. Sized to fit the whole slash-command
// menu (10 today) with headroom, so a bare `/` shows every command rather than
// scrolling a subset.
const EDITOR_AUTOCOMPLETE_MAX_VISIBLE = 12;

// A short, stable slice of a session id — enough to tell two same-named
// sessions apart in the picker without showing the full unreadable uuid.
function shortSessionId(id: string): string {
  return id.slice(0, 8);
}

// Two Escapes this close together read as one deliberate "stop the turn".
const DOUBLE_ESCAPE_INTERRUPT_WINDOW_MS = 600;
const DOUBLE_CTRL_C_EXIT_WINDOW_MS = 1_000;
