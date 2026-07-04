import {
  CombinedAutocompleteProvider,
  Editor,
  Key,
  ProcessTerminal,
  SelectList,
  TUI,
  matchesKey,
  truncateToWidth,
  visibleWidth,
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
  editor.setAutocompleteProvider(new CombinedAutocompleteProvider([], input.cwd));

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

  const handleSlashCommand = (prompt: string): boolean => {
    const parts = prompt.trim().split(/\s+/);
    if (parts[0] === '/model') {
      if (parts.length === 1) {
        void showModelList().catch((error) => {
          state.entries.push({
            kind: 'notice',
            level: 'error',
            text: error instanceof Error ? error.message : String(error),
          });
          requestRender();
        });
        return true;
      }
      const nextModel = parts.length === 2 ? parts[1] : undefined;
      if (!nextModel) {
        state.entries.push({
          kind: 'notice',
          level: 'error',
          text: 'Usage: /model <model-id>',
        });
        requestRender();
        return true;
      }
      void setModel(nextModel).catch((error) => {
        state.entries.push({
          kind: 'notice',
          level: 'error',
          text: error instanceof Error ? error.message : String(error),
        });
        requestRender();
      });
      return true;
    }
    if (parts[0] === '/session') {
      if (parts.length === 1) {
        void showSessionList().catch((error) => {
          state.entries.push({
            kind: 'notice',
            level: 'error',
            text: error instanceof Error ? error.message : String(error),
          });
          requestRender();
        });
        return true;
      }
      const sessionId = parts.length === 2 ? parts[1] : undefined;
      if (!sessionId) {
        state.entries.push({
          kind: 'notice',
          level: 'error',
          text: 'Usage: /session <session-id>',
        });
        requestRender();
        return true;
      }
      void switchSession(sessionId).catch((error) => {
        state.entries.push({
          kind: 'notice',
          level: 'error',
          text: error instanceof Error ? error.message : String(error),
        });
        requestRender();
      });
      return true;
    }
    if (parts[0] !== '/permissions') return false;
    const mode = parts.length === 2 ? parts[1] : undefined;
    if (!isPermissionMode(mode)) {
      state.entries.push({
        kind: 'notice',
        level: 'error',
        text: `Usage: /permissions ${PERMISSION_MODES.join('|')}`,
      });
      requestRender();
      return true;
    }
    void setPermissionMode(mode).catch((error) => {
      state.entries.push({
        kind: 'notice',
        level: 'error',
        text: error instanceof Error ? error.message : String(error),
      });
      requestRender();
    });
    return true;
  };

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
    if (matchesKey(data, Key.ctrl('c')) || matchesKey(data, Key.escape)) {
      void close();
      return { consume: true };
    }
    return undefined;
  });

  terminal.setTitle(input.title);
  tui.addChild(transcript);
  tui.addChild(editor);
  tui.addChild(statusLine);
  tui.setFocus(editor);
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
      alignColumns(this.input.title, ansi.cyan(this.input.rightLabel), safeWidth),
      padLine(ansi.dim('enter select / esc close'), safeWidth),
      padLine('', safeWidth),
      ...this.list.render(safeWidth).map((line) => formatPickerItemLine(line, safeWidth)),
      padLine(ansi.cyan('-'.repeat(safeWidth)), safeWidth),
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
    borderColor: ansi.cyan,
    selectList: selectListTheme(),
  };
}

function selectListTheme(): SelectListTheme {
  return {
    selectedPrefix: ansi.cyan,
    selectedText: ansi.bold,
    description: ansi.dim,
    scrollInfo: ansi.dim,
    noMatch: ansi.dim,
  };
}

const ansi = {
  bold: style(1, 22),
  dim: style(2, 22),
  cyan: style(36, 39),
  reverse: style(7, 27),
};

const PICKER_SURFACE_ROWS = 200;

function style(open: number, close: number): (text: string) => string {
  return (text) => `\x1b[${open}m${text}\x1b[${close}m`;
}
