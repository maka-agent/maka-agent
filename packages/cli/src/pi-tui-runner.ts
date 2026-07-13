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
import type { MakaSessionDriver, MakaSessionSwitchResult } from './session-driver.js';
import {
  createMakaPiTranscriptState,
  applyShellRunViewUpdateToTranscript,
  replaceTranscriptWithStoredMessages,
  submitCompactToTranscript,
  submitPromptToTranscript,
  toggleAllThinkingExpansion,
  toggleAllToolExpansion,
  type MakaPiTranscriptMetadata,
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
  MakaPiLayoutComponent,
  MakaStatusLineComponent,
  MakaTranscriptComponent,
} from './pi-tui-layout.js';
import {
  MakaAutocompleteProvider,
  PickerOverlay,
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
  onTurnComplete?: (injectTurn: (text: string) => void) => void;
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
  let permissionMode = input.permissionMode;
  let thinkingLevel: ThinkingLevel | undefined = undefined;
  let thinkingLevels: readonly ThinkingLevel[] = providerType
    ? thinkingVariantsForModel(providerType, input.model)
    : [];
  let busy = false;
  let closed = false;
  let permissionInFlight = false;
  let turnRunning = false;
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
  });

  const transcript = new MakaTranscriptComponent(state, metadata);
  const statusLine = new MakaStatusLineComponent(metadata);
  // Show the whole slash-command set at once — discoverability is the point of
  // the menu. Keep a little headroom above the current command count.
  const editor = new Editor(tui, editorTheme(), { paddingX: 1, autocompleteMaxVisible: EDITOR_AUTOCOMPLETE_MAX_VISIBLE });
  const editorSurface = new MakaAutocompleteAboveEditorComponent(editor);
  const layout = new MakaPiLayoutComponent(transcript, editorSurface, statusLine, terminal);
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
  let shellRunOwnerMappings: ShellRunUpdate[] = [];
  let hydratingShellRunsFor: string | undefined;
  let shellRunHydrationEpoch = 0;
  let shellRunHydrationRetryTimer: ReturnType<typeof setTimeout> | undefined;
  const pendingShellRunUpdates = new ShellRunUpdateBuffer('cli.pi-tui-hydration-buffer');
  const applyShellRunViewUpdate = (candidate: ShellRunUpdate): boolean => {
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
    return applyShellRunViewUpdateToTranscript(state, merged.update);
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
      for (const update of updates ?? []) applyShellRunViewUpdate(update);
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

  const respondToPendingPermission = (decision: 'allow' | 'deny'): boolean => {
    const request = state.pendingPermission;
    if (!request || permissionInFlight) return false;
    permissionInFlight = true;
    // Keep the prompt visible until the driver accepts the response. If it
    // rejects, the user can retry with y/n instead of being stuck.
    void input.driver.respondToPermission({
      requestId: request.requestId,
      decision,
      ...(decision === 'allow' ? { rememberForTurn: true } : {}),
    })
      .then(() => {
        permissionInFlight = false;
        // The turn may have ended (error/abort/complete) and cleared the pending
        // prompt while this response was in flight; only record success if the
        // request is still the active one.
        if (state.pendingPermission?.requestId !== request.requestId) return;
        state.pendingPermission = undefined;
        state.entries.push({
          kind: 'notice',
          level: 'info',
          text: `Permission ${decision}ed for ${request.toolName}`,
        });
        requestRender();
      })
      .catch((error) => {
        permissionInFlight = false;
        reportError(error);
      });
    return true;
  };

  const requestTurnInterrupt = () => {
    if (interruptRequested) return;
    interruptRequested = true;
    void input.driver.stop().catch((error) => {
      interruptRequested = false;
      reportError(error);
    });
  };

  editor.onSubmit = (prompt) => {
    if (busy || !prompt.trim()) {
      requestRender();
      return;
    }
    if (handleSlashCommand(prompt)) return;

    runAgentTurn(prompt);
  };

  // Runs one agent turn rendered in the transcript, then lets the host decide
  // whether to auto-continue (goal). Shared by user submits and goal injections.
  function runAgentTurn(prompt: string): void {
    busy = true;
    turnRunning = true;
    interruptRequested = false;
    lastTurnEscapeAt = 0;
    editor.disableSubmit = true;
    terminal.setProgress(true);
    attention.promptTurnStarted();
    requestRender();

    let permissionAlerted = false;
    let turnOutcome = { aborted: false, errored: false };
    void submitPromptToTranscript({
      state,
      driver: input.driver,
      prompt,
      // A turn failing is worth pulling the user back, regardless of how long it
      // ran — a quick failure in a background tab would otherwise stay silent.
      onError: () => attention.attentionNeeded(),
      onChange: () => {
        // A pending decision blocks the turn; ring an unfocused terminal once when
        // the prompt first appears (not on every render) so the user is not left
        // waiting on a prompt they cannot see.
        if (state.pendingPermission) {
          if (!permissionAlerted) {
            permissionAlerted = true;
            attention.attentionNeeded();
          }
        } else {
          permissionAlerted = false;
        }
        shellRunElapsedTicker.sync();
        requestRender();
      },
    }).then((outcome) => {
      turnOutcome = outcome;
    }).finally(() => {
      busy = false;
      turnRunning = false;
      interruptRequested = false;
      editor.disableSubmit = false;
      terminal.setProgress(false);
      attention.promptTurnEnded();
      requestRender();
      // Do not auto-continue (goal) if teardown began (`closed`), the user
      // interrupted the turn (double-Escape → driver.stop() → user_stop/abort),
      // or it ended in error. An autonomous loop MUST halt on the Stop
      // affordance and must not hammer a failing turn — mirrors the desktop
      // `turnAborted` guard.
      if (!closed && !turnOutcome.aborted && !turnOutcome.errored) {
        input.onTurnComplete?.((text) => runAgentTurn(text));
      }
    });
  }

  const setModel = async (nextModel: string) => {
    await input.driver.setModel(nextModel);
    model = nextModel;
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
    model = summary.model;
    connectionSlug = summary.llmConnectionSlug;
    permissionMode = summary.permissionMode;
    thinkingLevel = summary.thinkingLevel;
    thinkingLevels = providerType ? thinkingVariantsForModel(providerType, summary.model) : [];
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

  // Folder/connection safety is enforced inside driver.switchSession(),
  // before it commits any internal state, so a rejected switch leaves the
  // active session untouched and the next prompt still lands on the old one.
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

  const showSelectPicker = (
    title: string,
    rightLabel: string,
    items: SelectItem[],
    onSelect: (item: SelectItem) => void,
    options: { minPrimaryColumnWidth: number; maxPrimaryColumnWidth: number; selectedIndex?: number },
  ): void => {
    const list = new SelectList(items, 10, selectListTheme(), {
      minPrimaryColumnWidth: options.minPrimaryColumnWidth,
      maxPrimaryColumnWidth: options.maxPrimaryColumnWidth,
    });
    if (options.selectedIndex !== undefined) list.setSelectedIndex(options.selectedIndex);
    const picker = new PickerOverlay(list, { title, rightLabel });
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
    const currentSessions = sessions.filter(
      (session) => session.cwd === cwd && session.llmConnectionSlug === connectionSlug,
    );
    if (currentSessions.length === 0) {
      state.entries.push({
        kind: 'notice',
        level: 'info',
        text: 'No sessions found for this folder.',
      });
      requestRender();
      return;
    }

    // Recency-sorted. Label each row by its human name (the id is the selection
    // value, not something the user should have to read) and disambiguate
    // same-named sessions with a short id in the description. The list scrolls,
    // so every session stays reachable — nothing is capped or hidden.
    const items: SelectItem[] = currentSessions.map((session) => ({
      value: session.id,
      label: session.name || session.id,
      description: `${shortSessionId(session.id)} ${session.model}`,
    }));
    showSelectPicker(
      'Resume Session (Current Folder)',
      'Current Folder',
      items,
      (item) => {
        void runControl(() => switchSession(item.value));
      },
      { minPrimaryColumnWidth: 24, maxPrimaryColumnWidth: 40 },
    );
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
      'Rewind — 回到选定轮次之前（丢弃该轮及之后，prompt 回填输入框）',
      'Rewind',
      items,
      (item) => {
        void runControl(() => rewindToTurn(item.value));
      },
      { minPrimaryColumnWidth: 24, maxPrimaryColumnWidth: 48 },
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

  editor.setAutocompleteProvider(new MakaAutocompleteProvider(input.cwd, slashCommands));

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
    if (tui.hasOverlay()) return undefined;
    if (matchesKey(data, Key.ctrl('c')) && isKeyRepeat(data)) return { consume: true };
    if (!matchesKey(data, Key.ctrl('c'))) lastIdleCtrlCAt = 0;
    // The idle rewind gesture requires two *consecutive* Escapes. Any other key
    // in between breaks it, so a stale first Escape never pairs with a much later
    // one (e.g. `Esc`, type, `Esc`).
    if (!matchesKey(data, Key.escape)) lastIdleEscapeAt = 0;
    if (matchesKey(data, Key.ctrl('o')) && !isKeyRepeat(data)) {
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
    if (state.pendingPermission) {
      if (matchesKey(data, 'y') || matchesKey(data, Key.enter) || matchesKey(data, Key.return)) {
        respondToPendingPermission('allow');
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
  // Known limit: a global Ctrl+O / Ctrl+T toggle that resizes a block sitting
  // *above* the live viewport top makes pi-tui's differential renderer fall back
  // to a full redraw (its `firstChanged < viewportTop` path), which does emit a
  // scrollback-clearing sequence. That path re-emits the whole transcript, so no
  // transcript content is lost — the tail is rebuilt into fresh scrollback — but
  // the scroll position resets and any pre-Maka scrollback is cleared. Fully
  // avoiding it would require a preserve-scrollback render path inside pi-tui,
  // which we do not own; setClearOnShrink only governs the shrink path above.
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
