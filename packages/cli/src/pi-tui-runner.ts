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
import type { MakaSessionDriver, MakaSessionSwitchResult } from './session-driver.js';
import {
  createMakaPiTranscriptState,
  replaceTranscriptWithStoredMessages,
  submitCompactToTranscript,
  submitPromptToTranscript,
  toggleAllThinkingExpansion,
  toggleAllToolExpansion,
  type MakaPiTranscriptMetadata,
} from './pi-transcript.js';
import { editorTheme, selectListTheme } from './tui-ansi.js';
import { MakaAutocompleteAboveEditorComponent } from './tui-autocomplete-layout.js';
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
  connectionSlug: string;
  providerType?: ProviderType;
  permissionMode: PermissionMode;
  terminal?: Terminal;
  /**
   * How long a prompt turn must run before its completion rings the terminal
   * BEL when unfocused. Injectable so tests exercise the long / short split
   * without waiting real seconds; defaults to the attention layer's own value.
   */
  attentionLongTurnThresholdMs?: number;
}

export async function runMakaPiTui(input: MakaPiTuiInput): Promise<void> {
  const terminal = input.terminal ?? new ProcessTerminal();
  const tui = new TUI(terminal);
  const state = createMakaPiTranscriptState();
  let cwd = input.cwd;
  let model = input.model;
  let connectionSlug = input.connectionSlug;
  let permissionMode = input.permissionMode;
  let thinkingLevel: ThinkingLevel | undefined = undefined;
  let thinkingLevels: readonly ThinkingLevel[] = input.providerType
    ? thinkingVariantsForModel(input.providerType, input.model)
    : [];
  let busy = false;
  let closed = false;
  let permissionInFlight = false;
  let turnRunning = false;
  let interruptRequested = false;
  let lastTurnEscapeAt = 0;
  let lastIdleEscapeAt = 0;
  let resolveClosed: () => void;
  const closedPromise = new Promise<void>((resolve) => {
    resolveClosed = resolve;
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
    // Control actions are user-initiated and append their result (a notice, a
    // compaction summary); follow the tail so it is visible even if the user had
    // scrolled up.
    layout.followTailNow();
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

  const close = async () => {
    if (closed) return;
    closed = true;
    try {
      // A double-Escape interrupt may already have a stop in flight for this
      // turn; reuse it instead of firing a second stopSession that would append
      // a duplicate abort note. Otherwise stop the runtime as part of closing.
      if (!interruptRequested) {
        await input.driver.stop();
      }
    } catch {
      // Closing the terminal must win even if the runtime stop path
      // has already failed or the session never fully started.
    }
    terminal.setProgress(false);
    // Drop the busy / attention title marker so the tab is not handed back to
    // the shell still marked busy when Ctrl-C exits mid-turn (before the turn
    // finalizer runs). reset() also makes the controller inert.
    attention.reset();
    // Stop asking the terminal for focus reports before handing it back.
    terminal.write(DISABLE_FOCUS_REPORTING);
    tui.stop();
    resolveClosed();
  };

  const respondToPendingPermission = (decision: 'allow' | 'deny'): boolean => {
    const request = state.pendingPermission;
    if (!request || permissionInFlight) return false;
    permissionInFlight = true;
    // Answering is the user acting; the decision resumes the turn at the tail
    // (tool output, the next reply, or an error). Snap back to the tail so that
    // continuation is visible even if the user had paged up past the prompt to
    // read context before deciding — otherwise the session looks stuck.
    layout.followTailNow();
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

  editor.onSubmit = (prompt) => {
    if (busy || !prompt.trim()) {
      requestRender();
      return;
    }
    // A submission is the user acting; snap back to the tail so their prompt and
    // its response are visible, rather than treating the appended rows as
    // background stream output and preserving a scrolled-up position.
    layout.followTailNow();
    if (handleSlashCommand(prompt)) return;

    runAgentTurn(prompt);
  };

  // Runs one agent turn rendered in the transcript. Shared by user submits.
  function runAgentTurn(prompt: string): void {
    busy = true;
    turnRunning = true;
    interruptRequested = false;
    lastTurnEscapeAt = 0;
    editor.disableSubmit = true;
    terminal.setProgress(true);
    attention.promptTurnStarted();
    requestRender();

    let permissionSnapped = false;
    void submitPromptToTranscript({
      state,
      driver: input.driver,
      prompt,
      // A turn failing is worth pulling the user back, regardless of how long it
      // ran — a quick failure in a background tab would otherwise stay silent.
      onError: () => attention.attentionNeeded(),
      onChange: () => {
        // A newly raised permission prompt renders at the transcript tail. If the
        // user has paged up, it would land below the fold and the session would
        // look stuck waiting for a y/n they cannot see. Snap to the tail once when
        // the prompt first appears — not on every render, so the user can still
        // page up to read context before answering.
        if (state.pendingPermission) {
          if (!permissionSnapped) {
            permissionSnapped = true;
            layout.followTailNow();
            // A pending decision blocks the turn; ring an unfocused terminal so
            // the user is not left waiting on a prompt they cannot see.
            attention.attentionNeeded();
          }
        } else {
          permissionSnapped = false;
        }
        requestRender();
      },
    }).finally(() => {
      busy = false;
      turnRunning = false;
      interruptRequested = false;
      editor.disableSubmit = false;
      terminal.setProgress(false);
      attention.promptTurnEnded();
      requestRender();
    });
  }

  const setModel = async (nextModel: string) => {
    await input.driver.setModel(nextModel);
    model = nextModel;
    thinkingLevel = undefined;
    thinkingLevels = input.providerType ? thinkingVariantsForModel(input.providerType, nextModel) : [];
    state.entries.push({
      kind: 'notice',
      level: 'info',
      text: `Model: ${nextModel}`,
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
  const applySwitchResult = ({ summary, messages }: MakaSessionSwitchResult): void => {
    model = summary.model;
    connectionSlug = summary.llmConnectionSlug;
    permissionMode = summary.permissionMode;
    thinkingLevel = summary.thinkingLevel;
    thinkingLevels = input.providerType ? thinkingVariantsForModel(input.providerType, summary.model) : [];
    replaceTranscriptWithStoredMessages(state, messages);
    // The transcript is a different document now; drop any scroll position so the
    // resumed session opens following its latest messages, not mid-history.
    layout.followTailNow();
  };

  // Folder/connection safety is enforced inside driver.switchSession(),
  // before it commits any internal state, so a rejected switch leaves the
  // active session untouched and the next prompt still lands on the old one.
  const switchSession = async (sessionId: string) => {
    const result = await input.driver.switchSession(sessionId);
    applySwitchResult(result);
    if (result.messages.length === 0) {
      state.entries.push({
        kind: 'notice',
        level: 'info',
        text: `Resumed session "${result.summary.name}"`,
      });
    }
    requestRender();
  };

  // Rewind branches the active session through the chosen turn and switches onto
  // the branch (driver.rewindToTurn). The original session is left intact, so
  // this is non-destructive and inherits the branch's resume guarantees.
  const rewindToTurn = async (turnId: string) => {
    const result = await input.driver.rewindToTurn(turnId);
    applySwitchResult(result);
    state.entries.push({
      kind: 'notice',
      level: 'info',
      text: '已回退到选定轮次（分支为新会话，原会话保留）。',
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
      'Rewind — 回到选定轮次（保留到此轮，丢弃之后）',
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
    // Fresh transcript for the fresh session; the next prompt creates it on disk.
    replaceTranscriptWithStoredMessages(state, []);
    layout.followTailNow();
    state.entries.push({
      kind: 'notice',
      level: 'info',
      text: 'Started a new session. Send a prompt to begin.',
    });
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
      '  PageUp / PageDown — scroll the transcript',
      '  Esc Esc (during a turn) — interrupt the turn',
      '  Esc Esc (when idle) — rewind to an earlier turn',
      '  Ctrl+C / Ctrl+D — exit Maka',
    ].join('\n');
    state.entries.push({
      kind: 'notice',
      level: 'info',
      text: `Commands\n${commands}\n\nKeybindings\n${keybindings}`,
    });
    requestRender();
  };

  const showModelList = () => {
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
        void close();
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
    // Once closing has begun, swallow every key. A half-closed TUI still has a
    // live listener while close() awaits the runtime stop; letting Escape or any
    // other key through here would mutate state or fire a second stop.
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
    // Page through transcript scrollback — but only when there is scrollback to
    // page. PageUp/PageDown also page the editor's own multi-line input buffer,
    // so when the transcript fits the viewport we let the key fall through to the
    // editor instead of swallowing it.
    if (matchesKey(data, Key.pageUp)) {
      if (!layout.isScrollable()) return undefined;
      if (layout.scrollUp()) tui.requestRender();
      return { consume: true };
    }
    if (matchesKey(data, Key.pageDown)) {
      if (!layout.isScrollable()) return undefined;
      if (layout.scrollDown()) tui.requestRender();
      return { consume: true };
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
        interruptRequested = true;
        void input.driver.stop().catch((error) => {
          interruptRequested = false;
          reportError(error);
        });
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
    if (matchesKey(data, Key.ctrl('c')) || matchesKey(data, Key.ctrl('d'))) {
      void close();
      return { consume: true };
    }
    return undefined;
  });

  // The AttentionController set the initial title in its constructor. Enable
  // focus reporting so it learns when the terminal is backgrounded; the input
  // listener forwards the `\x1b[I` / `\x1b[O` reports.
  terminal.write(ENABLE_FOCUS_REPORTING);
  tui.addChild(layout);
  tui.setFocus(editorSurface);
  tui.start();

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
