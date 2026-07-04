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
  connectionSlug: string;
  permissionMode: PermissionMode;
  terminal?: Terminal;
}

export async function runMakaPiTui(input: MakaPiTuiInput): Promise<void> {
  const terminal = input.terminal ?? new ProcessTerminal();
  const tui = new TUI(terminal);
  const state = createMakaPiTranscriptState();
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
    cwd: input.cwd,
    model,
    connectionSlug,
    permissionMode,
    sessionId: input.driver.getSessionId(),
    busy,
  });

  const transcript = new MakaTranscriptComponent(state, metadata);
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
    if (sessions.length === 0) {
      state.entries.push({
        kind: 'notice',
        level: 'info',
        text: 'No sessions found.',
      });
      requestRender();
      return;
    }

    const items: SelectItem[] = sessions.slice(0, 10).map((session) => ({
      value: session.id,
      label: `${session.cwd === input.cwd ? '* ' : ''}${session.id}`,
      description: `${session.name} ${session.model}`,
    }));
    const list = new SelectList(items, 10, selectListTheme(), {
      minPrimaryColumnWidth: 24,
      maxPrimaryColumnWidth: 40,
    });
    const picker = new SessionPickerOverlay(list);
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
      anchor: 'top-center',
      row: 5,
      width: '80%',
      maxHeight: 12,
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

class SessionPickerOverlay implements Component {
  constructor(private readonly list: SelectList) {}

  invalidate(): void {
    this.list.invalidate();
  }

  handleInput(data: string): void {
    this.list.handleInput(data);
  }

  render(width: number): string[] {
    const safeWidth = Math.max(12, width);
    const innerWidth = Math.max(1, safeWidth - 4);
    const border = `+${'-'.repeat(safeWidth - 2)}+`;
    const lines = [
      border,
      framedLine('Select session', safeWidth),
      framedLine('', safeWidth),
      ...this.list.render(innerWidth).map((line) => framedLine(line, safeWidth)),
      border,
    ];
    return lines;
  }
}

function framedLine(text: string, width: number): string {
  const innerWidth = Math.max(1, width - 4);
  const trimmed = visibleWidth(text) > innerWidth ? truncateToWidth(text, innerWidth, '') : text;
  const padding = Math.max(0, innerWidth - visibleWidth(trimmed));
  return `| ${trimmed}${' '.repeat(padding)} |`;
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
};

function style(open: number, close: number): (text: string) => string {
  return (text) => `\x1b[${open}m${text}\x1b[${close}m`;
}
