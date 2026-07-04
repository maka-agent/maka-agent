import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { describe, test } from 'node:test';
import { visibleWidth, type Terminal } from '@earendil-works/pi-tui';
import type { PermissionMode, PermissionResponse, SessionEvent, SessionSummary } from '@maka/core';
import type { MakaSessionDriver } from '../session-driver.js';
import { runMakaPiTui } from '../pi-tui-runner.js';

describe('Maka Pi TUI runner', () => {
  test('restores the terminal when driver stop rejects during close', async () => {
    const terminal = new FakeTerminal();
    const driver = new RejectingStopDriver();
    const run = runMakaPiTui({
      title: 'Maka',
      driver,
      cwd: '/repo',
      model: 'claude-sonnet-4-5',
      connectionSlug: 'claude-subscription',
      permissionMode: 'bypass',
      terminal,
    });

    terminal.input('\x03');

    await Promise.race([
      run,
      delay(50).then(() => {
        throw new Error('TUI did not close after Ctrl-C');
      }),
    ]);

    assert.equal(driver.stopCalls, 1);
    assert.equal(terminal.stopCalls, 1);
    assert.equal(terminal.progressStates.at(-1), false);
  });

  test('allows a pending permission request from the terminal', async () => {
    const terminal = new FakeTerminal();
    const driver = new PermissionPromptDriver();
    const run = runMakaPiTui({
      title: 'Maka',
      driver,
      cwd: '/repo',
      model: 'claude-sonnet-4-5',
      connectionSlug: 'claude-subscription',
      permissionMode: 'ask',
      terminal,
    });

    terminal.input('r');
    terminal.input('u');
    terminal.input('n');
    terminal.input('\r');

    await waitFor(() => driver.permissionRequests === 1);
    await delay(20);
    terminal.input('y');
    await waitFor(() => driver.permissionResponses.length === 1);

    assert.deepEqual(driver.permissionResponses, [{
      requestId: 'permission-1',
      decision: 'allow',
      rememberForTurn: true,
    }]);

    terminal.input('\x03');
    await Promise.race([
      run,
      delay(50).then(() => {
        throw new Error('TUI did not close after Ctrl-C');
      }),
    ]);
  });

  test('denies a pending permission request from the terminal', async () => {
    const terminal = new FakeTerminal();
    const driver = new PermissionPromptDriver();
    const run = runMakaPiTui({
      title: 'Maka',
      driver,
      cwd: '/repo',
      model: 'claude-sonnet-4-5',
      connectionSlug: 'claude-subscription',
      permissionMode: 'ask',
      terminal,
    });

    terminal.input('r');
    terminal.input('u');
    terminal.input('n');
    terminal.input('\r');

    await waitFor(() => driver.permissionRequests === 1);
    await delay(20);
    terminal.input('n');
    await waitFor(() => driver.permissionResponses.length === 1);

    assert.deepEqual(driver.permissionResponses, [{
      requestId: 'permission-1',
      decision: 'deny',
    }]);

    terminal.input('\x03');
    await Promise.race([
      run,
      delay(50).then(() => {
        throw new Error('TUI did not close after Ctrl-C');
      }),
    ]);
  });

  test('toggles the latest tool detail with Ctrl-O', async () => {
    const terminal = new FakeTerminal();
    const driver = new ToolOutputDriver();
    const run = runMakaPiTui({
      title: 'Maka',
      driver,
      cwd: '/repo',
      model: 'claude-sonnet-4-5',
      connectionSlug: 'claude-subscription',
      permissionMode: 'ask',
      terminal,
    });

    terminal.input('r');
    terminal.input('u');
    terminal.input('n');
    terminal.input('\r');

    await waitFor(() => terminal.output().includes('Ctrl+O expand'));
    assert.equal(terminal.output().includes('expanded-tail'), false);

    terminal.input('\x0f');
    await waitFor(() => terminal.output().includes('expanded-tail'));

    terminal.input('\x03');
    await Promise.race([
      run,
      delay(50).then(() => {
        throw new Error('TUI did not close after Ctrl-C');
      }),
    ]);
  });

  test('renders the statusline below the input editor', async () => {
    const terminal = new FakeTerminal();
    const driver = new SlashCommandDriver();
    const run = runMakaPiTui({
      title: 'Maka',
      driver,
      cwd: '/repo',
      model: 'deepseek-v4-flash',
      connectionSlug: 'deepseek',
      permissionMode: 'ask',
      terminal,
    });

    await waitFor(() => plainTerminalOutput(terminal.output()).includes('Maka deepseek-v4-flash deepseek ask /repo'));

    const lines = plainTerminalOutput(terminal.output()).split(/\r?\n/);
    const statusLineIndex = lines.findIndex((line) => line.includes('Maka deepseek-v4-flash deepseek ask /repo'));
    const editorBorderIndexes = lines
      .map((line, index) => (/^─+$/.test(line) ? index : -1))
      .filter((index) => index >= 0);

    assert.ok(editorBorderIndexes.length >= 2);
    assert.ok(statusLineIndex > editorBorderIndexes[editorBorderIndexes.length - 1]!);

    terminal.input('\x03');
    await Promise.race([
      run,
      delay(50).then(() => {
        throw new Error('TUI did not close after Ctrl-C');
      }),
    ]);
  });

  test('uses logo blue for TUI accent chrome', async () => {
    const terminal = new FakeTerminal();
    const driver = new SlashCommandDriver();
    const run = runMakaPiTui({
      title: 'Maka',
      driver,
      cwd: '/repo',
      model: 'deepseek-v4-flash',
      connectionSlug: 'deepseek',
      permissionMode: 'ask',
      terminal,
    });

    await waitFor(() => terminal.output().includes('\x1b[38;2;87;163;239m'));

    assert.doesNotMatch(terminal.output(), /\x1b\[36m─/);

    terminal.input('\x03');
    await Promise.race([
      run,
      delay(50).then(() => {
        throw new Error('TUI did not close after Ctrl-C');
      }),
    ]);
  });

  test('keeps the input editor and statusline at the terminal bottom', async () => {
    const terminal = new FakeTerminal();
    const driver = new SlashCommandDriver();
    const run = runMakaPiTui({
      title: 'Maka',
      driver,
      cwd: '/repo',
      model: 'deepseek-v4-flash',
      connectionSlug: 'deepseek',
      permissionMode: 'ask',
      terminal,
    });

    await waitFor(() => plainTerminalOutput(terminal.output()).includes('Maka deepseek-v4-flash deepseek ask /repo'));

    const lines = plainTerminalOutput(terminal.output()).split(/\r?\n/);
    const statusLineIndex = lines.findIndex((line) => line.includes('Maka deepseek-v4-flash deepseek ask /repo'));
    const editorBorderIndexes = lines
      .map((line, index) => (/^─+$/.test(line) ? index : -1))
      .filter((index) => index >= 0);

    assert.equal(statusLineIndex, terminal.rows - 1);
    assert.equal(editorBorderIndexes[editorBorderIndexes.length - 1], terminal.rows - 2);

    terminal.input('\x03');
    await Promise.race([
      run,
      delay(50).then(() => {
        throw new Error('TUI did not close after Ctrl-C');
      }),
    ]);
  });

  test('shows slash commands alphabetically when typing /', async () => {
    const terminal = new FakeTerminal();
    const driver = new SlashCommandDriver();
    const run = runMakaPiTui({
      title: 'Maka',
      driver,
      cwd: '/repo',
      model: 'deepseek-v4-flash',
      connectionSlug: 'deepseek',
      permissionMode: 'ask',
      terminal,
    });

    terminal.input('/');

    await waitFor(() => plainTerminalOutput(terminal.output()).includes('/session'));
    const output = plainTerminalOutput(terminal.output());
    const modelIndex = output.indexOf('/model');
    const permissionsIndex = output.indexOf('/permissions');
    const sessionIndex = output.indexOf('/session');

    assert.ok(modelIndex >= 0);
    assert.ok(permissionsIndex >= 0);
    assert.ok(sessionIndex >= 0);
    assert.ok(modelIndex < permissionsIndex);
    assert.ok(permissionsIndex < sessionIndex);

    terminal.input('\x03');
    await Promise.race([
      run,
      delay(50).then(() => {
        throw new Error('TUI did not close after Ctrl-C');
      }),
    ]);
  });

  test('renders slash autocomplete above the input editor', async () => {
    const terminal = new FakeTerminal();
    const driver = new SlashCommandDriver();
    const run = runMakaPiTui({
      title: 'Maka',
      driver,
      cwd: '/repo',
      model: 'deepseek-v4-flash',
      connectionSlug: 'deepseek',
      permissionMode: 'ask',
      terminal,
    });

    terminal.input('/');

    await waitFor(() => plainTerminalOutput(terminal.output()).includes('/session'));
    const lines = plainTerminalOutput(terminal.output()).split(/\r?\n/);
    const suggestionIndex = lines.findIndex((line) => line.includes('/model'));
    const statusLineIndex = lines.findIndex((line) => line.includes('Maka deepseek-v4-flash deepseek ask /repo'));
    const editorBorderIndexes = lines
      .map((line, index) => (/^─+$/.test(line) ? index : -1))
      .filter((index) => index >= 0);

    assert.ok(suggestionIndex >= 0);
    assert.ok(editorBorderIndexes.length >= 2);
    assert.ok(suggestionIndex < editorBorderIndexes[editorBorderIndexes.length - 2]!);
    assert.equal(editorBorderIndexes[editorBorderIndexes.length - 1], statusLineIndex - 1);

    terminal.input('\x03');
    await Promise.race([
      run,
      delay(50).then(() => {
        throw new Error('TUI did not close after Ctrl-C');
      }),
    ]);
  });

  test('applies the selected slash command from autocomplete', async () => {
    const terminal = new FakeTerminal();
    const driver = new SlashCommandDriver();
    const run = runMakaPiTui({
      title: 'Maka',
      driver,
      cwd: '/repo',
      model: 'deepseek-v4-flash',
      models: ['deepseek-v4-flash', 'gpt-5.3-codex-spark'],
      connectionSlug: 'deepseek',
      permissionMode: 'ask',
      terminal,
    });

    terminal.input('/');

    await waitFor(() => plainTerminalOutput(terminal.output()).includes('/session'));
    terminal.input('\r');
    await waitFor(() => terminal.output().includes('Select Model'));

    assert.deepEqual(driver.prompts, []);

    terminal.input('\x1b');
    terminal.input('\x03');
    await Promise.race([
      run,
      delay(50).then(() => {
        throw new Error('TUI did not close after Ctrl-C');
      }),
    ]);
  });

  test('handles /permissions without sending a prompt', async () => {
    const terminal = new FakeTerminal();
    const driver = new SlashCommandDriver();
    const run = runMakaPiTui({
      title: 'Maka',
      driver,
      cwd: '/repo',
      model: 'claude-sonnet-4-5',
      connectionSlug: 'claude-subscription',
      permissionMode: 'ask',
      terminal,
    });

    terminal.input('/permissions execute');
    terminal.input('\r');

    await waitFor(() => driver.permissionModes.length === 1);
    await waitFor(() => terminal.output().includes('Permission mode: execute'));

    assert.deepEqual(driver.permissionModes, ['execute']);
    assert.deepEqual(driver.prompts, []);

    terminal.input('\x03');
    await Promise.race([
      run,
      delay(50).then(() => {
        throw new Error('TUI did not close after Ctrl-C');
      }),
    ]);
  });

  test('handles /model without sending a prompt', async () => {
    const terminal = new FakeTerminal();
    const driver = new SlashCommandDriver();
    const run = runMakaPiTui({
      title: 'Maka',
      driver,
      cwd: '/repo',
      model: 'claude-sonnet-4-5',
      connectionSlug: 'claude-subscription',
      permissionMode: 'ask',
      terminal,
    });

    terminal.input('/model claude-opus-4-1');
    terminal.input('\r');

    await waitFor(() => driver.models.length === 1);
    await waitFor(() => terminal.output().includes('Model: claude-opus-4-1'));

    assert.deepEqual(driver.models, ['claude-opus-4-1']);
    assert.deepEqual(driver.prompts, []);

    terminal.input('\x03');
    await Promise.race([
      run,
      delay(50).then(() => {
        throw new Error('TUI did not close after Ctrl-C');
      }),
    ]);
  });

  test('selects a model from /model', async () => {
    const terminal = new FakeTerminal();
    const driver = new SlashCommandDriver();
    const run = runMakaPiTui({
      title: 'Maka',
      driver,
      cwd: '/repo',
      model: 'deepseek-v4-flash',
      models: ['deepseek-v4-flash', 'gpt-5.3-codex-spark'],
      connectionSlug: 'deepseek',
      permissionMode: 'ask',
      terminal,
    });

    terminal.input('/model');
    terminal.input('\r');

    await waitFor(() => terminal.output().includes('Select Model'));
    await waitFor(() => terminal.output().includes('gpt-5.3-codex-spark'));
    const titleLine = latestPlainLineContaining(terminal.output(), 'Select Model');
    assert.equal(titleLine.startsWith('Select Model'), true);
    assert.equal(visibleWidth(titleLine), terminal.columns);
    terminal.input('\x1b[B');
    terminal.input('\r');
    await waitFor(() => driver.models.length === 1);
    await waitFor(() => terminal.output().includes('Model: gpt-5.3-codex-spark'));

    assert.deepEqual(driver.models, ['gpt-5.3-codex-spark']);
    assert.deepEqual(driver.prompts, []);

    terminal.input('\x03');
    await Promise.race([
      run,
      delay(50).then(() => {
        throw new Error('TUI did not close after Ctrl-C');
      }),
    ]);
  });

  test('handles /session without sending a prompt', async () => {
    const terminal = new FakeTerminal();
    const driver = new SlashCommandDriver([fakeSessionSummary('session-2', '/other-repo')]);
    const run = runMakaPiTui({
      title: 'Maka',
      driver,
      cwd: '/repo',
      model: 'claude-sonnet-4-5',
      connectionSlug: 'claude-subscription',
      permissionMode: 'ask',
      terminal,
    });

    terminal.input('/session session-2');
    terminal.input('\r');

    await waitFor(() => driver.sessionIds.length === 1);
    await waitFor(() => terminal.output().includes('Session: session-2'));
    await waitFor(() => plainTerminalOutput(terminal.output()).includes('/other-repo'));

    assert.deepEqual(driver.sessionIds, ['session-2']);
    assert.deepEqual(driver.prompts, []);

    terminal.input('\x03');
    await Promise.race([
      run,
      delay(50).then(() => {
        throw new Error('TUI did not close after Ctrl-C');
      }),
    ]);
  });

  test('selects a session from /session', async () => {
    const terminal = new FakeTerminal();
    const driver = new SlashCommandDriver();
    const run = runMakaPiTui({
      title: 'Maka',
      driver,
      cwd: '/repo',
      model: 'claude-sonnet-4-5',
      connectionSlug: 'claude-subscription',
      permissionMode: 'ask',
      terminal,
    });

    terminal.input('/session');
    terminal.input('\r');

    await waitFor(() => terminal.output().includes('Resume Session (Current Folder)'));
    await waitFor(() => terminal.output().includes('session-2'));
    const titleLine = latestPlainLineContaining(terminal.output(), 'Resume Session (Current Folder)');
    assert.equal(titleLine.startsWith('Resume Session (Current Folder)'), true);
    assert.equal(visibleWidth(titleLine), terminal.columns);
    terminal.input('\r');
    await waitFor(() => driver.sessionIds.length === 1);
    await waitFor(() => terminal.output().includes('Session: session-2'));

    assert.deepEqual(driver.sessionIds, ['session-2']);
    assert.deepEqual(driver.prompts, []);

    terminal.input('\x03');
    await Promise.race([
      run,
      delay(50).then(() => {
        throw new Error('TUI did not close after Ctrl-C');
      }),
    ]);
  });

  test('shows only current-cwd sessions in the session picker', async () => {
    const terminal = new FakeTerminal();
    const driver = new SlashCommandDriver([
      fakeSessionSummary('session-current', '/repo'),
      fakeSessionSummary('session-other', '/elsewhere'),
    ]);
    const run = runMakaPiTui({
      title: 'Maka',
      driver,
      cwd: '/repo',
      model: 'claude-sonnet-4-5',
      connectionSlug: 'claude-subscription',
      permissionMode: 'ask',
      terminal,
    });

    terminal.input('/session');
    terminal.input('\r');

    await waitFor(() => terminal.output().includes('session-current'));
    const output = plainTerminalOutput(terminal.output());
    assert.equal(output.includes('session-other'), false);

    terminal.input('\x1b');
    terminal.input('\x03');
    await Promise.race([
      run,
      delay(50).then(() => {
        throw new Error('TUI did not close after Ctrl-C');
      }),
    ]);
  });

});

class RejectingStopDriver implements MakaSessionDriver {
  stopCalls = 0;

  async listSessions(): Promise<SessionSummary[]> {
    return [];
  }

  async *sendPrompt(_prompt: string): AsyncIterable<never> {}

  async stop(): Promise<void> {
    this.stopCalls += 1;
    throw new Error('stop failed');
  }

  async respondToPermission(_response: PermissionResponse): Promise<void> {}
  async setModel(): Promise<void> {}
  async setPermissionMode(): Promise<void> {}
  async switchSession(sessionId: string): Promise<SessionSummary> {
    return fakeSessionSummary(sessionId);
  }

  getSessionId(): string {
    return 'session-1';
  }
}

class PermissionPromptDriver implements MakaSessionDriver {
  readonly permissionResponses: PermissionResponse[] = [];
  permissionRequests = 0;
  private continueAfterPermission: (() => void) | null = null;

  async listSessions(): Promise<SessionSummary[]> {
    return [];
  }

  async *sendPrompt(_prompt: string): AsyncIterable<SessionEvent> {
    this.permissionRequests += 1;
    yield {
      type: 'permission_request',
      id: 'event-permission',
      turnId: 'turn-1',
      ts: 1,
      requestId: 'permission-1',
      toolUseId: 'tool-1',
      toolName: 'Bash',
      category: 'shell_unsafe',
      reason: 'shell_dangerous',
      args: { command: 'npm test' },
    };
    await new Promise<void>((resolve) => {
      this.continueAfterPermission = resolve;
    });
    yield {
      type: 'permission_decision_ack',
      id: 'event-decision',
      turnId: 'turn-1',
      ts: 2,
      requestId: 'permission-1',
      toolUseId: 'tool-1',
      decision: 'allow',
      rememberForTurn: true,
    };
    yield {
      type: 'complete',
      id: 'event-complete',
      turnId: 'turn-1',
      ts: 3,
      stopReason: 'end_turn',
    };
  }

  async stop(): Promise<void> {}

  async respondToPermission(response: PermissionResponse): Promise<void> {
    this.permissionResponses.push(response);
    this.continueAfterPermission?.();
  }
  async setModel(): Promise<void> {}
  async setPermissionMode(): Promise<void> {}
  async switchSession(sessionId: string): Promise<SessionSummary> {
    return fakeSessionSummary(sessionId);
  }

  getSessionId(): string {
    return 'session-1';
  }
}

class ToolOutputDriver implements MakaSessionDriver {
  async listSessions(): Promise<SessionSummary[]> {
    return [];
  }

  async *sendPrompt(_prompt: string): AsyncIterable<SessionEvent> {
    yield {
      type: 'tool_start',
      id: 'event-tool-start',
      turnId: 'turn-1',
      ts: 1,
      toolUseId: 'tool-1',
      toolName: 'Bash',
      args: { command: 'npm test' },
    };
    yield {
      type: 'tool_result',
      id: 'event-tool-result',
      turnId: 'turn-1',
      ts: 2,
      toolUseId: 'tool-1',
      isError: false,
      content: {
        kind: 'terminal',
        cwd: '/repo',
        cmd: 'npm test',
        exitCode: 0,
        stdout: `${'x'.repeat(900)}\nexpanded-tail`,
        stderr: '',
      },
    };
    yield {
      type: 'complete',
      id: 'event-complete',
      turnId: 'turn-1',
      ts: 3,
      stopReason: 'end_turn',
    };
  }

  async stop(): Promise<void> {}
  async respondToPermission(_response: PermissionResponse): Promise<void> {}
  async setModel(): Promise<void> {}
  async setPermissionMode(): Promise<void> {}
  async switchSession(sessionId: string): Promise<SessionSummary> {
    return fakeSessionSummary(sessionId);
  }
  getSessionId(): string {
    return 'session-1';
  }
}

class SlashCommandDriver implements MakaSessionDriver {
  readonly prompts: string[] = [];
  readonly models: string[] = [];
  readonly permissionModes: PermissionMode[] = [];
  readonly sessionIds: string[] = [];
  private sessionId = 'session-1';

  constructor(private readonly sessions: SessionSummary[] = [fakeSessionSummary('session-2', '/repo')]) {}

  async listSessions(): Promise<SessionSummary[]> {
    return this.sessions;
  }

  async *sendPrompt(prompt: string): AsyncIterable<SessionEvent> {
    this.prompts.push(prompt);
    yield {
      type: 'complete',
      id: 'event-complete',
      turnId: 'turn-1',
      ts: 1,
      stopReason: 'end_turn',
    };
  }

  async stop(): Promise<void> {}
  async respondToPermission(_response: PermissionResponse): Promise<void> {}
  async setModel(model: string): Promise<void> {
    this.models.push(model);
  }
  async setPermissionMode(mode: PermissionMode): Promise<void> {
    this.permissionModes.push(mode);
  }
  async switchSession(sessionId: string): Promise<SessionSummary> {
    this.sessionIds.push(sessionId);
    this.sessionId = sessionId;
    const summary = this.sessions.find((session) => session.id === sessionId);
    return summary ?? fakeSessionSummary(sessionId);
  }
  getSessionId(): string {
    return this.sessionId;
  }
}

function fakeSessionSummary(sessionId: string, cwd = '/repo'): SessionSummary {
  return {
    id: sessionId,
    cwd,
    name: 'Existing chat',
    isFlagged: false,
    isArchived: false,
    labels: [],
    hasUnread: false,
    status: 'active',
    backend: 'ai-sdk',
    llmConnectionSlug: 'claude-subscription',
    model: 'claude-sonnet-4-5',
    permissionMode: 'ask',
  };
}

function latestPlainLineContaining(output: string, text: string): string {
  const line = plainTerminalOutput(output)
    .split(/\r?\n/)
    .reverse()
    .find((candidate) => candidate.includes(text));
  assert.ok(line, `Expected terminal output to contain ${text}`);
  return line;
}

function plainTerminalOutput(output: string): string {
  return output
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b_pi:c\x07/g, '')
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '');
}

class FakeTerminal implements Terminal {
  readonly columns = 80;
  readonly rows = 24;
  readonly kittyProtocolActive = false;
  readonly progressStates: boolean[] = [];
  readonly writes: string[] = [];
  stopCalls = 0;
  private onInput: ((data: string) => void) | null = null;

  start(onInput: (data: string) => void, _onResize: () => void): void {
    this.onInput = onInput;
  }

  stop(): void {
    this.stopCalls += 1;
  }

  drainInput(): Promise<void> {
    return Promise.resolve();
  }

  write(data: string): void {
    this.writes.push(data);
  }
  moveBy(_lines: number): void {}
  hideCursor(): void {}
  showCursor(): void {}
  clearLine(): void {}
  clearFromCursor(): void {}
  clearScreen(): void {}
  setTitle(_title: string): void {}

  setProgress(active: boolean): void {
    this.progressStates.push(active);
  }

  input(data: string): void {
    this.onInput?.(data);
  }

  output(): string {
    return this.writes.join('');
  }
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 250;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await delay(5);
  }
  assert.equal(predicate(), true);
}
