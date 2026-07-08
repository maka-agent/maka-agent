import {
  CombinedAutocompleteProvider,
  Container,
  Editor,
  Key,
  ProcessTerminal,
  SelectList,
  TUI,
  isKeyRelease,
  isKeyRepeat,
  matchesKey,
  truncateToWidth,
  visibleWidth,
  type AutocompleteItem,
  type AutocompleteProvider,
  type AutocompleteSuggestions,
  type Component,
  type OverlayHandle,
  type SelectItem,
  type Terminal,
} from '@earendil-works/pi-tui';
import { PERMISSION_MODES, isPermissionMode, type PermissionMode } from '@maka/core/permission';
import { isThinkingLevel, thinkingVariantsForModel, type ThinkingLevel } from '@maka/core/model-thinking';
import type { ProviderType } from '@maka/core/llm-connections';
import type { MakaSessionDriver } from './session-driver.js';
import {
  createMakaPiTranscriptState,
  renderMakaPiStatusLine,
  renderMakaPiTranscriptSource,
  replaceTranscriptWithStoredMessages,
  submitCompactToTranscript,
  submitPromptToTranscript,
  toggleAllThinkingExpansion,
  toggleAllToolExpansion,
  windowTranscriptLines,
  type MakaPiTranscriptMetadata,
  type MakaPiTranscriptState,
  type RenderedTranscript,
  type TranscriptLineOwner,
} from './pi-transcript.js';
import { ansi, editorTheme, selectListTheme, stripAnsi } from './tui-ansi.js';
import { MakaAutocompleteAboveEditorComponent } from './tui-autocomplete-layout.js';

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
  const editor = new Editor(tui, editorTheme(), { paddingX: 1, autocompleteMaxVisible: 8 });
  const editorSurface = new MakaAutocompleteAboveEditorComponent(editor);
  const layout = new MakaPiLayoutComponent(transcript, editorSurface, statusLine, terminal);

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
    requestRender();
    try {
      await action();
    } catch (error) {
      reportError(error);
    } finally {
      busy = false;
      editor.disableSubmit = false;
      terminal.setProgress(false);
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
    tui.stop();
    resolveClosed();
  };

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

    busy = true;
    turnRunning = true;
    interruptRequested = false;
    lastTurnEscapeAt = 0;
    editor.disableSubmit = true;
    terminal.setProgress(true);
    requestRender();

    let permissionSnapped = false;
    void submitPromptToTranscript({
      state,
      driver: input.driver,
      prompt,
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
      requestRender();
    });
  };

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

  // Folder/connection safety is enforced inside driver.switchSession(),
  // before it commits any internal state, so a rejected switch leaves the
  // active session untouched and the next prompt still lands on the old one.
  const switchSession = async (sessionId: string) => {
    const { summary, messages } = await input.driver.switchSession(sessionId);
    model = summary.model;
    connectionSlug = summary.llmConnectionSlug;
    permissionMode = summary.permissionMode;
    thinkingLevel = summary.thinkingLevel;
    thinkingLevels = input.providerType ? thinkingVariantsForModel(input.providerType, summary.model) : [];
    replaceTranscriptWithStoredMessages(state, messages);
    // The transcript is a different document now; drop any scroll position so the
    // resumed session opens following its latest messages, not mid-history.
    layout.followTailNow();
    if (messages.length === 0) {
      state.entries.push({
        kind: 'notice',
        level: 'info',
        text: `Resumed session "${summary.name}"`,
      });
    }
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

    const items: SelectItem[] = currentSessions.slice(0, 10).map((session) => ({
      value: session.id,
      label: session.id,
      description: `${session.name} ${session.model}`,
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
    // Kitty keyboard protocol terminals (Ghostty/Kitty) emit separate press and
    // release events. pi-tui only filters releases on the focused-component
    // path, but this raw listener runs before that, so a release would
    // immediately undo a Ctrl+O/Ctrl+T toggle and a single Escape's
    // press+release pair could count as a double Escape. We never act on
    // releases here; returning undefined lets the TUI apply its own filtering.
    if (isKeyRelease(data)) return undefined;
    if (tui.hasOverlay()) return undefined;
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
    if (matchesKey(data, Key.ctrl('c')) || matchesKey(data, Key.ctrl('d'))) {
      void close();
      return { consume: true };
    }
    return undefined;
  });

  terminal.setTitle(input.title);
  tui.addChild(layout);
  tui.setFocus(editorSurface);
  tui.start();

  return closedPromise;
}

class MakaTranscriptComponent implements Component {
  constructor(
    private readonly state: MakaPiTranscriptState,
    private readonly metadata: () => MakaPiTranscriptMetadata,
  ) {}

  invalidate(): void {}

  render(width: number): string[] {
    return this.renderSource(width).lines;
  }

  renderSource(width: number): RenderedTranscript {
    return renderMakaPiTranscriptSource(this.state, this.metadata(), width);
  }
}

class MakaStatusLineComponent implements Component {
  constructor(private readonly metadata: () => MakaPiTranscriptMetadata) {}

  invalidate(): void {}

  render(width: number): string[] {
    return [renderMakaPiStatusLine(this.metadata(), width)];
  }
}

/**
 * Row of the line the scroll anchor points at in a freshly rendered transcript,
 * or -1 when the anchored entry is gone entirely (e.g. compaction replaced the
 * transcript). If the entry survives but its block shrank past the anchored row,
 * fall back to the entry's last remaining row so the viewport stays on that
 * entry instead of jumping.
 */
function findAnchorRow(owners: readonly (TranscriptLineOwner | null)[], anchor: TranscriptLineOwner): number {
  let lastRowOfEntry = -1;
  for (let i = 0; i < owners.length; i++) {
    const owner = owners[i];
    if (!owner || owner.entry !== anchor.entry) continue;
    if (owner.row === anchor.row) return i;
    lastRowOfEntry = i; // rows are emitted in order, so this tracks the max seen
  }
  return lastRowOfEntry;
}

/** The owner of the first content line at or after `start` (skipping spacers). */
function anchorOwnerAt(owners: readonly (TranscriptLineOwner | null)[], start: number): TranscriptLineOwner | null {
  for (let i = Math.max(0, start); i < owners.length; i++) {
    if (owners[i]) return owners[i];
  }
  for (let i = Math.min(start, owners.length) - 1; i >= 0; i--) {
    if (owners[i]) return owners[i];
  }
  return null;
}

class MakaPiLayoutComponent extends Container {
  // Scroll position as lines hidden below the viewport bottom; 0 = following the
  // live tail. `followTail` re-pins to the bottom as new output streams in, so a
  // user reading history is only ever moved by an explicit scroll, never by the
  // agent's next line.
  private scrollOffset = 0;
  private followTail = true;
  private lastTotalLines = 0;
  private lastViewportRows = 0;
  private lastWidth = 0;
  // The content the top of the viewport is pinned to while scrolled. Anchoring to
  // a piece of content (an entry + row) rather than a line offset keeps the
  // reader on the same text no matter how blocks re-render between frames —
  // growing or shrinking, above or below the fold, or several at once in one
  // coalesced paint. Null while following the tail.
  private anchor: TranscriptLineOwner | null = null;
  // Set by an explicit scroll so the next render honours the new offset verbatim
  // instead of re-deriving it from the (now stale) anchor.
  private pendingUserScroll = false;

  constructor(
    private readonly transcript: MakaTranscriptComponent,
    private readonly editor: Component,
    private readonly statusLine: Component,
    private readonly terminal: Terminal,
  ) {
    super();
    this.addChild(transcript);
    this.addChild(editor);
    this.addChild(statusLine);
  }

  render(width: number): string[] {
    const source = this.transcript.renderSource(width);
    const transcriptLines = source.lines;
    const editorLines = this.editor.render(width);
    const statusLines = this.statusLine.render(width);
    const viewportRows = Math.max(0, this.terminal.rows - editorLines.length - statusLines.length);

    if (width !== this.lastWidth) {
      // Rewrapping at a new width invalidates every line offset, so re-pin to the
      // tail rather than land the viewport on an arbitrary mid-message row.
      this.followTail = true;
      this.scrollOffset = 0;
      this.anchor = null;
    } else if (this.pendingUserScroll) {
      // An explicit scroll already set scrollOffset; honour it as-is, then re-derive
      // the anchor from the resulting window below.
    } else if (!this.followTail && this.anchor) {
      // A re-render (stream delta, expansion toggle, ...). Recompute the offset so
      // the anchored content line is back at the top of the viewport. Deriving it
      // from the anchor's live position — rather than nudging the old offset by a
      // line delta — is correct for every kind of change at once: only the anchor's
      // current row matters, not where or how the transcript grew or shrank.
      const anchorRow = findAnchorRow(source.owners, this.anchor);
      if (anchorRow < 0) {
        // The anchored entry is gone (e.g. a session switch replaced the
        // transcript); fall back to the tail rather than a stale position.
        this.followTail = true;
        this.scrollOffset = 0;
        this.anchor = null;
      } else {
        const contentRows = viewportRows >= 2 ? viewportRows - 1 : viewportRows;
        this.scrollOffset = Math.max(0, transcriptLines.length - anchorRow - contentRows);
      }
    }

    const windowed = windowTranscriptLines(
      transcriptLines,
      viewportRows,
      this.followTail ? 0 : this.scrollOffset,
      width,
    );
    this.scrollOffset = windowed.scrollOffset;
    this.followTail = windowed.scrollOffset === 0;
    this.anchor = this.followTail ? null : anchorOwnerAt(source.owners, windowed.hiddenAbove);
    this.pendingUserScroll = false;
    this.lastTotalLines = transcriptLines.length;
    this.lastViewportRows = viewportRows;
    this.lastWidth = width;

    const paddingRows = Math.max(0, viewportRows - windowed.lines.length);
    return [
      ...windowed.lines,
      ...Array.from({ length: paddingRows }, () => ''),
      ...editorLines,
      ...statusLines,
    ];
  }

  /** One indicator row is reserved when scrolling, so a page is that many content rows. */
  private pageSize(): number {
    return Math.max(1, this.lastViewportRows - 1);
  }

  private scrollBy(offsetDelta: number): boolean {
    if (this.lastTotalLines <= this.lastViewportRows) return false; // nothing hidden
    const maxOffset = Math.max(0, this.lastTotalLines - this.pageSize());
    const current = this.followTail ? 0 : this.scrollOffset;
    const next = Math.min(Math.max(0, current + offsetDelta), maxOffset);
    if (next === current) return false;
    this.scrollOffset = next;
    this.followTail = next === 0;
    // The user moved the viewport; the next render must apply this offset, not the
    // old anchor. The render then re-anchors to whatever is now on top.
    this.pendingUserScroll = true;
    return true;
  }

  /** Scroll toward older output by one page. Returns false when already at the top. */
  scrollUp(): boolean {
    return this.scrollBy(this.pageSize());
  }

  /** Scroll toward newer output by one page. Returns false when already following the tail. */
  scrollDown(): boolean {
    return this.scrollBy(-this.pageSize());
  }

  /**
   * True when the transcript overflows the viewport, i.e. paging keys should
   * scroll it. When false the transcript fits and PageUp/PageDown page the
   * editor's own multi-line input buffer instead. A zero-row viewport (the
   * editor and status filled a very short terminal) renders no transcript at
   * all, so paging must fall through to the editor even with content buffered.
   */
  isScrollable(): boolean {
    return this.lastViewportRows > 0 && this.lastTotalLines > this.lastViewportRows;
  }

  /**
   * Re-pin to the live tail. Call when the transcript is replaced wholesale (a
   * session switch) or the user submits, so the viewport follows the newest
   * output instead of holding a now-irrelevant scroll position.
   */
  followTailNow(): void {
    this.followTail = true;
    this.scrollOffset = 0;
    this.anchor = null;
    this.pendingUserScroll = false;
  }
}

class MakaAutocompleteProvider implements AutocompleteProvider {
  private readonly fileProvider: CombinedAutocompleteProvider;
  private readonly slashCommands: readonly MakaSlashCommandMetadata[];

  constructor(basePath: string, slashCommands: readonly MakaSlashCommandMetadata[]) {
    this.fileProvider = new CombinedAutocompleteProvider([], basePath);
    this.slashCommands = slashCommands;
  }

  async getSuggestions(
    lines: string[],
    cursorLine: number,
    cursorCol: number,
    options: { signal: AbortSignal; force?: boolean },
  ): Promise<AutocompleteSuggestions | null> {
    const slashPrefix = slashCommandPrefix(lines, cursorLine, cursorCol);
    if (slashPrefix !== null && !options.force) {
      const query = slashPrefix.slice(1).toLowerCase();
      const items = this.slashCommands
        .filter((command) => command.name.startsWith(query))
        .map((command) => ({
          value: command.name,
          label: `/${command.name}`,
          description: command.description,
        }));
      return items.length > 0 ? { items, prefix: slashPrefix } : null;
    }
    return this.fileProvider.getSuggestions(lines, cursorLine, cursorCol, options);
  }

  applyCompletion(
    lines: string[],
    cursorLine: number,
    cursorCol: number,
    item: AutocompleteItem,
    prefix: string,
  ): { lines: string[]; cursorLine: number; cursorCol: number } {
    const currentLine = lines[cursorLine] || '';
    const beforePrefix = currentLine.slice(0, cursorCol - prefix.length);
    if (prefix.startsWith('/') && beforePrefix.trim() === '') {
      const nextLines = [...lines];
      nextLines[cursorLine] = `${beforePrefix}/${item.value} ${currentLine.slice(cursorCol)}`;
      return {
        lines: nextLines,
        cursorLine,
        cursorCol: beforePrefix.length + item.value.length + 2,
      };
    }
    return this.fileProvider.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
  }

  shouldTriggerFileCompletion(lines: string[], cursorLine: number, cursorCol: number): boolean {
    return this.fileProvider.shouldTriggerFileCompletion(lines, cursorLine, cursorCol);
  }
}

interface MakaSlashCommandMetadata {
  name: string;
  description: string;
}

interface MakaSlashCommand extends MakaSlashCommandMetadata {
  run(parts: string[]): void;
}

function slashCommandPrefix(lines: string[], cursorLine: number, cursorCol: number): string | null {
  const currentLine = lines[cursorLine] || '';
  const textBeforeCursor = currentLine.slice(0, cursorCol);
  return textBeforeCursor.startsWith('/') && !textBeforeCursor.includes(' ') ? textBeforeCursor : null;
}

class PickerOverlay implements Component {
  constructor(
    private readonly list: SelectList,
    private readonly input: { title: string; rightLabel: string },
  ) {}

  invalidate(): void {
    this.list.invalidate();
  }

  handleInput(data: string): void {
    this.list.handleInput(data);
  }

  render(width: number): string[] {
    const safeWidth = Math.max(1, width);
    return [
      padLine(`${this.input.title} ${ansi.accent(this.input.rightLabel)}`, safeWidth),
      padLine(ansi.dim('enter select / esc close'), safeWidth),
      padLine('', safeWidth),
      ...this.list.render(safeWidth).map((line) => formatPickerItemLine(line, safeWidth)),
      padLine(ansi.accent('-'.repeat(safeWidth)), safeWidth),
    ];
  }
}

function modelPickerItems(currentModel: string, models: readonly string[] | undefined): SelectItem[] {
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const candidate of [currentModel, ...(models ?? [])]) {
    const id = candidate.trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  return ids.map((id) => ({
    value: id,
    label: id,
    ...(id === currentModel ? { description: 'current' } : {}),
  }));
}

function permissionModePickerItems(currentMode: PermissionMode): SelectItem[] {
  return PERMISSION_MODES.map((mode) => ({
    value: mode,
    label: mode,
    ...(mode === currentMode ? { description: 'current' } : {}),
  }));
}

const THINKING_LEVEL_LABELS: Record<ThinkingLevel, string> = {
  off: '关',
  minimal: '最小',
  low: '低',
  medium: '中',
  high: '高',
  xhigh: '超高',
  max: '最高',
};

function thinkingLevelPickerItems(
  levels: readonly ThinkingLevel[],
  current: ThinkingLevel | undefined,
): SelectItem[] {
  return [
    { value: 'default', label: '默认', ...(current === undefined ? { description: 'current' } : {}) },
    ...levels.map((level) => ({
      value: level,
      label: THINKING_LEVEL_LABELS[level],
      ...(level === current ? { description: 'current' } : {}),
    })),
  ];
}

function formatPickerItemLine(line: string, width: number): string {
  const padded = padLine(line, width);
  return stripAnsi(line).startsWith('→ ') ? ansi.reverse(padded) : padded;
}

function padLine(text: string, width: number): string {
  const safeWidth = Math.max(1, width);
  const trimmed = visibleWidth(text) > safeWidth ? truncateToWidth(text, safeWidth, '') : text;
  return `${trimmed}${' '.repeat(Math.max(0, safeWidth - visibleWidth(trimmed)))}`;
}

const BOTTOM_PICKER_MARGIN_ROWS = 4;

// Two Escapes this close together read as one deliberate "stop the turn".
const DOUBLE_ESCAPE_INTERRUPT_WINDOW_MS = 600;
