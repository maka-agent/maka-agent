import {
  CombinedAutocompleteProvider,
  Container,
  Editor,
  Key,
  ProcessTerminal,
  SelectList,
  TUI,
  matchesKey,
  truncateToWidth,
  visibleWidth,
  type AutocompleteItem,
  type AutocompleteProvider,
  type AutocompleteSuggestions,
  type Component,
  type EditorTheme,
  type OverlayHandle,
  type SelectItem,
  type SelectListTheme,
  type Terminal,
} from '@earendil-works/pi-tui';
import { PERMISSION_MODES, isPermissionMode, type PermissionMode } from '@maka/core/permission';
import type { MakaSessionDriver } from './session-driver.js';
import {
  createMakaPiTranscriptState,
  renderMakaPiStatusLine,
  renderMakaPiTranscript,
  submitPromptToTranscript,
  toggleLatestToolExpansion,
  type MakaPiTranscriptMetadata,
  type MakaPiTranscriptState,
} from './pi-transcript.js';

export interface MakaPiTuiInput {
  title: string;
  driver: MakaSessionDriver;
  cwd: string;
  model: string;
  models?: readonly string[];
  connectionSlug: string;
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
  let busy = false;
  let closed = false;
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

  const close = async () => {
    if (closed) return;
    closed = true;
    try {
      await input.driver.stop();
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
    if (!request) return false;
    state.pendingPermission = undefined;
    state.entries.push({
      kind: 'notice',
      level: 'info',
      text: `Permission ${decision}ed for ${request.toolName}`,
    });
    requestRender();
    void input.driver.respondToPermission({
      requestId: request.requestId,
      decision,
      ...(decision === 'allow' ? { rememberForTurn: true } : {}),
    }).catch((error) => {
      state.entries.push({
        kind: 'notice',
        level: 'error',
        text: error instanceof Error ? error.message : String(error),
      });
      requestRender();
    });
    return true;
  };

  editor.onSubmit = (prompt) => {
    if (busy || !prompt.trim()) {
      requestRender();
      return;
    }
    if (handleSlashCommand(prompt)) return;

    busy = true;
    editor.disableSubmit = true;
    terminal.setProgress(true);
    requestRender();

    void submitPromptToTranscript({
      state,
      driver: input.driver,
      prompt,
      onChange: requestRender,
    }).finally(() => {
      busy = false;
      editor.disableSubmit = false;
      terminal.setProgress(false);
      requestRender();
    });
  };

  const setModel = async (nextModel: string) => {
    await input.driver.setModel(nextModel);
    model = nextModel;
    state.entries.push({
      kind: 'notice',
      level: 'info',
      text: `Model: ${nextModel}`,
    });
    requestRender();
  };

  const switchSession = async (sessionId: string) => {
    const summary = await input.driver.switchSession(sessionId);
    cwd = summary.cwd ?? cwd;
    model = summary.model;
    connectionSlug = summary.llmConnectionSlug;
    permissionMode = summary.permissionMode;
    state.entries.push({
      kind: 'notice',
      level: 'info',
      text: `Session: ${summary.id}`,
    });
    requestRender();
  };

  const showSessionList = async () => {
    const sessions = await input.driver.listSessions();
    const currentCwdSessions = sessions.filter((session) => session.cwd === cwd);
    if (currentCwdSessions.length === 0) {
      state.entries.push({
        kind: 'notice',
        level: 'info',
        text: 'No sessions found for this folder.',
      });
      requestRender();
      return;
    }

    const items: SelectItem[] = currentCwdSessions.slice(0, 10).map((session) => ({
      value: session.id,
      label: session.id,
      description: `${session.name} ${session.model}`,
    }));
    const list = new SelectList(items, 10, selectListTheme(), {
      minPrimaryColumnWidth: 24,
      maxPrimaryColumnWidth: 40,
    });
    const picker = new PickerOverlay(list, {
      title: 'Resume Session (Current Folder)',
      rightLabel: 'Current Folder',
    });
    let overlay: OverlayHandle | undefined;
    list.onSelect = (item) => {
      overlay?.hide();
      void switchSession(item.value).catch((error) => {
        state.entries.push({
          kind: 'notice',
          level: 'error',
          text: error instanceof Error ? error.message : String(error),
        });
        requestRender();
      });
    };
    list.onCancel = () => {
      overlay?.hide();
    };
    overlay = tui.showOverlay(picker, {
      anchor: 'top-left',
      row: 0,
      col: 0,
      width: '100%',
      maxHeight: '100%',
    });
  };

  const showModelList = async () => {
    const items = modelPickerItems(model, input.models);
    const list = new SelectList(items, 10, selectListTheme(), {
      minPrimaryColumnWidth: 24,
      maxPrimaryColumnWidth: 48,
    });
    const picker = new PickerOverlay(list, {
      title: 'Select Model',
      rightLabel: connectionSlug,
    });
    let overlay: OverlayHandle | undefined;
    list.onSelect = (item) => {
      overlay?.hide();
      void setModel(item.value).catch((error) => {
        state.entries.push({
          kind: 'notice',
          level: 'error',
          text: error instanceof Error ? error.message : String(error),
        });
        requestRender();
      });
    };
    list.onCancel = () => {
      overlay?.hide();
    };
    overlay = tui.showOverlay(picker, {
      anchor: 'top-left',
      row: 0,
      col: 0,
      width: '100%',
      maxHeight: '100%',
    });
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

  const slashCommands: MakaSlashCommand[] = [
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
          void showModelList().catch((error) => {
            state.entries.push({
              kind: 'notice',
              level: 'error',
              text: error instanceof Error ? error.message : String(error),
            });
            requestRender();
          });
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
        void setModel(nextModel).catch((error) => {
          state.entries.push({
            kind: 'notice',
            level: 'error',
            text: error instanceof Error ? error.message : String(error),
          });
          requestRender();
        });
      },
    },
    {
      name: 'permissions',
      description: 'Set permission mode',
      run: (parts: string[]) => {
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
        void setPermissionMode(mode).catch((error) => {
          state.entries.push({
            kind: 'notice',
            level: 'error',
            text: error instanceof Error ? error.message : String(error),
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
          void showSessionList().catch((error) => {
            state.entries.push({
              kind: 'notice',
              level: 'error',
              text: error instanceof Error ? error.message : String(error),
            });
            requestRender();
          });
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
        void switchSession(sessionId).catch((error) => {
          state.entries.push({
            kind: 'notice',
            level: 'error',
            text: error instanceof Error ? error.message : String(error),
          });
          requestRender();
        });
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
    if (tui.hasOverlay()) return undefined;
    if (matchesKey(data, Key.ctrl('o'))) {
      if (toggleLatestToolExpansion(state)) {
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
    return renderMakaPiTranscript(this.state, this.metadata(), width);
  }
}

class MakaStatusLineComponent implements Component {
  constructor(private readonly metadata: () => MakaPiTranscriptMetadata) {}

  invalidate(): void {}

  render(width: number): string[] {
    return [renderMakaPiStatusLine(this.metadata(), width)];
  }
}

class MakaPiLayoutComponent extends Container {
  constructor(
    private readonly transcript: Component,
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
    const transcriptLines = this.transcript.render(width);
    const editorLines = this.editor.render(width);
    const statusLines = this.statusLine.render(width);
    const transcriptRows = Math.max(0, this.terminal.rows - editorLines.length - statusLines.length);
    const paddingRows = Math.max(0, transcriptRows - transcriptLines.length);
    return [
      ...transcriptLines,
      ...Array.from({ length: paddingRows }, () => ''),
      ...editorLines,
      ...statusLines,
    ];
  }
}

class MakaAutocompleteAboveEditorComponent implements Component {
  constructor(private readonly editor: Editor) {}

  get focused(): boolean {
    return this.editor.focused;
  }

  set focused(value: boolean) {
    this.editor.focused = value;
  }

  invalidate(): void {
    this.editor.invalidate();
  }

  handleInput(data: string): void {
    this.editor.handleInput(data);
  }

  render(width: number): string[] {
    const lines = this.editor.render(width);
    if (!this.editor.isShowingAutocomplete()) return lines;
    return moveTrailingAutocompleteAboveEditor(lines);
  }
}

function moveTrailingAutocompleteAboveEditor(lines: string[]): string[] {
  const bottomBorderIndex = findLastIndex(lines, isEditorChromeLine);
  if (bottomBorderIndex < 1 || bottomBorderIndex === lines.length - 1) return lines;
  const topBorderIndex = findLastIndex(lines.slice(0, bottomBorderIndex), isEditorChromeLine);
  if (topBorderIndex < 0) return lines;

  return [
    ...lines.slice(bottomBorderIndex + 1),
    ...lines.slice(0, bottomBorderIndex + 1),
  ];
}

function isEditorChromeLine(line: string): boolean {
  const text = stripAnsi(line);
  return /^─+$/.test(text) || /^─── [↑↓] \d+ more ─*$/.test(text);
}

function findLastIndex<T>(items: readonly T[], predicate: (item: T) => boolean): number {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    if (predicate(items[index]!)) return index;
  }
  return -1;
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
    const lines = [
      alignColumns(this.input.title, ansi.accent(this.input.rightLabel), safeWidth),
      padLine(ansi.dim('enter select / esc close'), safeWidth),
      padLine('', safeWidth),
      ...this.list.render(safeWidth).map((line) => formatPickerItemLine(line, safeWidth)),
      padLine(ansi.accent('-'.repeat(safeWidth)), safeWidth),
    ];
    while (lines.length < PICKER_SURFACE_ROWS) {
      lines.push(' '.repeat(safeWidth));
    }
    return lines;
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

function alignColumns(left: string, right: string, width: number): string {
  const safeWidth = Math.max(1, width);
  const rightWidth = visibleWidth(right);
  if (rightWidth + 1 >= safeWidth) return padLine(left, safeWidth);
  const leftMaxWidth = Math.max(1, safeWidth - rightWidth - 1);
  const clippedLeft = visibleWidth(left) > leftMaxWidth ? truncateToWidth(left, leftMaxWidth, '') : left;
  const gap = Math.max(1, safeWidth - visibleWidth(clippedLeft) - rightWidth);
  return `${clippedLeft}${' '.repeat(gap)}${right}`;
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

function stripAnsi(text: string): string {
  return text.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '');
}

function editorTheme(): EditorTheme {
  return {
    borderColor: ansi.accent,
    selectList: selectListTheme(),
  };
}

function selectListTheme(): SelectListTheme {
  return {
    selectedPrefix: ansi.accent,
    selectedText: ansi.bold,
    description: ansi.dim,
    scrollInfo: ansi.dim,
    noMatch: ansi.dim,
  };
}

// PR #496: desktop --accent = oklch(0.70 0.135 250), rendered here as truecolor ANSI.
const MAKA_LOGO_BLUE_RGB = [87, 163, 239] as const;

const ansi = {
  bold: style(1, 22),
  dim: style(2, 22),
  accent: rgb(...MAKA_LOGO_BLUE_RGB),
  reverse: style(7, 27),
};

const PICKER_SURFACE_ROWS = 200;

function style(open: number, close: number): (text: string) => string {
  return (text) => `\x1b[${open}m${text}\x1b[${close}m`;
}

function rgb(red: number, green: number, blue: number): (text: string) => string {
  return (text) => `\x1b[38;2;${red};${green};${blue}m${text}\x1b[39m`;
}
