import {
  CombinedAutocompleteProvider,
  Editor,
  Key,
  ProcessTerminal,
  TUI,
  matchesKey,
  type Component,
  type EditorTheme,
  type SelectListTheme,
  type Terminal,
} from '@earendil-works/pi-tui';
import type { MakaSessionDriver } from './session-driver.js';
import {
  createMakaPiTranscriptState,
  renderMakaPiTranscript,
  submitPromptToTranscript,
  type MakaPiTranscriptMetadata,
  type MakaPiTranscriptState,
} from './pi-transcript.js';

export interface MakaPiTuiInput {
  title: string;
  driver: MakaSessionDriver;
  cwd: string;
  model: string;
  connectionSlug: string;
  permissionMode: string;
  terminal?: Terminal;
}

export async function runMakaPiTui(input: MakaPiTuiInput): Promise<void> {
  const terminal = input.terminal ?? new ProcessTerminal();
  const tui = new TUI(terminal);
  const state = createMakaPiTranscriptState();
  let busy = false;
  let closed = false;
  let resolveClosed: () => void;
  const closedPromise = new Promise<void>((resolve) => {
    resolveClosed = resolve;
  });

  const metadata = (): MakaPiTranscriptMetadata => ({
    title: input.title,
    cwd: input.cwd,
    model: input.model,
    connectionSlug: input.connectionSlug,
    permissionMode: input.permissionMode,
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

  editor.onSubmit = (prompt) => {
    if (busy || !prompt.trim()) {
      requestRender();
      return;
    }

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

  tui.addInputListener((data) => {
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
