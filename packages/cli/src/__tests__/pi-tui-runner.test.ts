import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { describe, test } from 'node:test';
import { visibleWidth } from '@earendil-works/pi-tui';
import {
  SHELL_RUN_UPDATE_BUFFER_MAX_ENTRIES,
  type PermissionMode,
  type PermissionResponse,
  type SessionEvent,
  type SessionSummary,
  type StoredMessage,
  type ThinkingLevel,
  type UserQuestionResponse,
} from '@maka/core';
import type { ShellRunUpdate } from '@maka/runtime';
import type {
  MakaSessionDriver,
  MakaSessionRewindResult,
  MakaSessionSwitchResult,
  RewindTarget,
  SessionResumeAvailability,
} from '../session-driver.js';
import { runMakaPiTui } from '../pi-tui-runner.js';
import { BUSY_SPINNER_FRAMES } from '../tui-attention.js';
import { arrangeAutocompleteAboveEditor } from '../tui-autocomplete-layout.js';
import {
  assertBottomPickerPlacement,
  FakeTerminal,
  inputSurfaceRows,
  latestPlainLineContaining,
  plainTerminalOutput,
  waitFor,
} from './tui-terminal-mock.js';

describe('Maka Pi TUI runner', () => {
  test('restores the terminal before exiting on SIGTERM', async () => {
    const { code, signal, stdout } = await runSignalExitProbe('SIGTERM');

    assert.equal(signal, null);
    assert.equal(code, 143);
    assert.match(stdout, /TERMINAL_STOP/);
    assert.match(stdout, /CLOSED/);
  });

  test('restores the terminal before exiting on SIGHUP', async () => {
    const { code, signal, stdout } = await runSignalExitProbe('SIGHUP');

    assert.equal(signal, null);
    assert.equal(code, 129);
    assert.match(stdout, /TERMINAL_STOP/);
    assert.match(stdout, /CLOSED/);
  });

  test('restores the terminal before exiting on SIGINT', async () => {
    const { code, signal, stdout } = await runSignalExitProbe('SIGINT');

    assert.equal(signal, null);
    assert.equal(code, 130);
    assert.match(stdout, /TERMINAL_STOP/);
    assert.match(stdout, /CLOSED/);
  });

  test('forces signal exit when outer cleanup never settles after terminal restoration', async () => {
    const { code, signal, stdout } = await runSignalExitProbe('SIGTERM', true);

    assert.equal(signal, null);
    assert.equal(code, 143);
    assert.match(stdout, /TERMINAL_STOP/);
    assert.match(stdout, /CLOSED/);
  });

  test('restores the terminal before reporting an uncaught exception', async () => {
    const { code, signal, stdout, stderr } = await runFatalExitProbe('uncaughtException');

    assert.equal(signal, null);
    assert.equal(code, 1);
    assert.match(stdout, /TERMINAL_STOP/);
    assert.match(stdout, /CLOSED/);
    assert.match(stderr, /fatal probe/);
  });

  test('reports and forces fatal exit when outer cleanup never settles', async () => {
    const { code, signal, stdout, stderr } = await runFatalExitProbe('uncaughtException', true);

    assert.equal(signal, null);
    assert.equal(code, 1);
    assert.match(stdout, /TERMINAL_STOP/);
    assert.match(stdout, /CLOSED/);
    assert.match(stderr, /fatal probe/);
  });

  test('restores the terminal before reporting an unhandled rejection', async () => {
    const { code, signal, stdout, stderr } = await runFatalExitProbe('unhandledRejection');

    assert.equal(signal, null);
    assert.equal(code, 1);
    assert.match(stdout, /TERMINAL_STOP/);
    assert.match(stdout, /CLOSED/);
    assert.match(stderr, /fatal probe/);
  });

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

    exitMaka(terminal);

    await Promise.race([
      run,
      delay(50).then(() => {
        throw new Error('TUI did not close during test cleanup');
      }),
    ]);

    assert.equal(driver.stopCalls, 1);
    assert.equal(terminal.stopCalls, 1);
    assert.equal(terminal.progressStates.at(-1), false);
  });

  test('restores the terminal before a slow driver stop settles', async () => {
    const terminal = new FakeTerminal();
    const driver = new HangingCloseDriver();
    const run = runMakaPiTui({
      title: 'Maka',
      driver,
      cwd: '/repo',
      model: 'claude-sonnet-4-5',
      connectionSlug: 'claude-subscription',
      permissionMode: 'bypass',
      terminal,
    });

    terminal.input('/exit');
    terminal.input('\r');
    await waitFor(() => driver.stopCalls === 1);
    try {
      assert.equal(terminal.stopCalls, 1);
    } finally {
      driver.releaseStop();
      await run;
    }
  });

  test('restores the terminal when focus reporting fails after TUI start', async () => {
    const terminal = new ThrowingFocusReportTerminal();
    const driver = new SlashCommandDriver();
    const previousExitCode = process.exitCode;

    try {
      await assert.rejects(runMakaPiTui({
        title: 'Maka',
        driver,
        cwd: '/repo',
        model: 'deepseek-v4-flash',
        connectionSlug: 'deepseek',
        permissionMode: 'ask',
        terminal,
      }), /focus reporting failed/);
      assert.equal(terminal.stopCalls, 1);
    } finally {
      if (terminal.stopCalls === 0) process.emit('SIGTERM');
      process.exitCode = previousExitCode;
    }
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
      rememberForTurn: false,
    }]);

    exitMaka(terminal);
    await Promise.race([
      run,
      delay(50).then(() => {
        throw new Error('TUI did not close during test cleanup');
      }),
    ]);
  });

  test('allows a pending permission request for the turn with a', async () => {
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
    terminal.input('a');
    await waitFor(() => driver.permissionResponses.length === 1);

    assert.deepEqual(driver.permissionResponses, [{
      requestId: 'permission-1',
      decision: 'allow',
      rememberForTurn: true,
    }]);

    exitMaka(terminal);
    await Promise.race([
      run,
      delay(50).then(() => {
        throw new Error('TUI did not close during test cleanup');
      }),
    ]);
  });

  test('allows additional permissions once and ignores the turn-wide approval key', async () => {
    const terminal = new FakeTerminal();
    const driver = new PermissionPromptDriver(['write outside'], async () => {}, true);
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
    terminal.input('a');
    await delay(20);
    assert.equal(driver.permissionResponses.length, 0);
    terminal.input('y');
    await waitFor(() => driver.permissionResponses.length === 1);
    assert.deepEqual(driver.permissionResponses, [{
      requestId: 'permission-1',
      decision: 'allow',
    }]);

    exitMaka(terminal);
    await Promise.race([
      run,
      delay(50).then(() => { throw new Error('TUI did not close during test cleanup'); }),
    ]);
  });

  test('inspects exact WriteStdin input and allows it without turn memory', async () => {
    const terminal = new FakeTerminal();
    const hiddenSuffix = '\u001b[31mrm -rf /tmp/hidden-suffix\r';
    const driver = new PermissionPromptDriver([{
      toolName: 'WriteStdin',
      args: {
        ref: 'maka://runtime/background-tasks/pty-1',
        input: `password=super-secret ${'x'.repeat(200)}${hiddenSuffix}`,
        size: { cols: 120, rows: 40 },
      },
      rememberForTurnAllowed: false,
    }]);
    const run = runMakaPiTui({
      title: 'Maka',
      driver,
      cwd: '/repo',
      model: 'claude-sonnet-4-5',
      connectionSlug: 'claude-subscription',
      permissionMode: 'ask',
      terminal,
    });

    terminal.input('run');
    terminal.input('\r');
    await waitFor(() => driver.permissionRequests === 1);
    await waitFor(() => plainTerminalOutput(terminal.screenOutput()).includes('Ctrl+O show full parameters'));
    const collapsed = plainTerminalOutput(terminal.screenOutput());
    assert.doesNotMatch(collapsed, /super-secret/);
    assert.doesNotMatch(collapsed, /hidden-suffix/);
    assert.doesNotMatch(collapsed, /allow for turn/);

    terminal.input('\x0f');
    await waitFor(() => plainTerminalOutput(terminal.output()).includes('hidden-suffix\\r'));
    const expanded = plainTerminalOutput(terminal.output());
    assert.match(expanded, /super-secret/);
    assert.match(expanded, /\\u\{001B\}\[31mrm -rf/);
    assert.match(expanded, /\/tmp\/hidden-suffix\\r/);
    assert.doesNotMatch(terminal.output(), /\u001b\[31mrm -rf/);

    terminal.input('y');
    await waitFor(() => driver.permissionResponses.length === 1);
    assert.deepEqual(driver.permissionResponses, [{
      requestId: 'permission-1',
      decision: 'allow',
    }]);

    exitMaka(terminal);
    await Promise.race([
      run,
      delay(50).then(() => {
        throw new Error('TUI did not close during test cleanup');
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

    exitMaka(terminal);
    await Promise.race([
      run,
      delay(50).then(() => {
        throw new Error('TUI did not close during test cleanup');
      }),
    ]);
  });

  test('waits for permission acknowledgement before advancing concurrent requests', async () => {
    const terminal = new FakeTerminal();
    let releaseFirstAck!: () => void;
    const firstAck = new Promise<void>((resolve) => {
      releaseFirstAck = resolve;
    });
    const driver = new PermissionPromptDriver(
      ['printf first', 'printf second'],
      async (index) => {
        if (index === 0) await firstAck;
      },
    );
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

    await waitFor(() => driver.permissionRequests === 2);
    await waitFor(() => plainTerminalOutput(terminal.screenOutput()).includes('printf first'));
    assert.doesNotMatch(plainTerminalOutput(terminal.screenOutput()), /printf second/);

    terminal.input('n');
    await waitFor(() => driver.permissionResponses.length === 1);
    terminal.input('y');
    await delay(0);
    assert.equal(driver.permissionResponses.length, 1);
    assert.match(plainTerminalOutput(terminal.screenOutput()), /printf first/);
    assert.doesNotMatch(plainTerminalOutput(terminal.screenOutput()), /printf second/);

    releaseFirstAck();
    await waitFor(() => plainTerminalOutput(terminal.screenOutput()).includes('printf second'));

    terminal.input('y');
    await waitFor(() => driver.permissionResponses.length === 2);
    assert.deepEqual(driver.permissionResponses, [
      { requestId: 'permission-1', decision: 'deny' },
      { requestId: 'permission-2', decision: 'allow', rememberForTurn: false },
    ]);

    exitMaka(terminal);
    await Promise.race([
      run,
      delay(50).then(() => {
        throw new Error('TUI did not close during test cleanup');
      }),
    ]);
  });

  test('answers sequential questions with a choice, Escape, and Other input', async () => {
    const terminal = new FakeTerminal();
    const driver = new UserQuestionPromptDriver();
    const run = runMakaPiTui({
      title: 'Maka', driver, cwd: '/repo', model: 'claude-sonnet-4-5',
      connectionSlug: 'claude-subscription', permissionMode: 'ask', terminal,
    });

    terminal.input('choose');
    terminal.input('\r');
    await waitFor(() => plainTerminalOutput(terminal.screenOutput()).includes('Choose an approach'));
    assertBottomPickerPlacement(
      terminal,
      'Choose an approach',
      'Maka · ask · claude-sonnet-4-5 · claude-subscription · /repo',
    );
    assert.ok(plainTerminalOutput(terminal.screenOutput()).includes('Ctrl+C stop'));

    terminal.input('\r');
    await waitFor(() => plainTerminalOutput(terminal.screenOutput()).includes('Keep the default'));
    terminal.input('\x1b');
    await waitFor(() => plainTerminalOutput(terminal.screenOutput()).includes('Anything else'));
    terminal.input('\x1b[B');
    terminal.input('\x1b[B');
    terminal.input('\r');
    await waitFor(() => plainTerminalOutput(terminal.screenOutput()).includes('Type another answer'));
    assert.ok(plainTerminalOutput(terminal.screenOutput()).includes('Ctrl+C stop'));
    terminal.input('Use the existing seam');
    terminal.input('\r');

    await waitFor(() => driver.responses.length === 1);
    assert.deepEqual(driver.responses, [{
      requestId: 'question-1',
      answers: ['Extend', null, 'Use the existing seam'],
    }]);

    exitMaka(terminal);
    await run;
  });

  test('Ctrl-C stops a turn while a user-question overlay is open', async () => {
    const terminal = new FakeTerminal();
    const driver = new UserQuestionPromptDriver();
    const run = runMakaPiTui({
      title: 'Maka', driver, cwd: '/repo', model: 'claude-sonnet-4-5',
      connectionSlug: 'claude-subscription', permissionMode: 'ask', terminal,
    });

    terminal.input('choose');
    terminal.input('\r');
    await waitFor(() => plainTerminalOutput(terminal.screenOutput()).includes('Choose an approach'));
    terminal.input('\x03');

    await waitFor(() => driver.stopCalls === 1);
    assert.deepEqual(driver.responses, []);
    exitMaka(terminal);
    await run;
  });

  test('toggles tool detail globally with Ctrl-O', async () => {
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

    await waitFor(() => terminal.output().includes('(Ctrl+O)'));
    assert.equal(terminal.output().includes('expanded-tail'), false);

    terminal.input('\x0f');
    // Expanding the 31-line result overflows the viewport; the transcript is not
    // windowed, so its head line `expanded-tail` scrolls into the terminal's own
    // scrollback. The cumulative write stream is what was drawn, so it records the
    // expanded content even once it has scrolled above the fold.
    await waitFor(() => plainTerminalOutput(terminal.output()).includes('expanded-tail'));

    exitMaka(terminal);
    await Promise.race([
      run,
      delay(50).then(() => {
        throw new Error('TUI did not close during test cleanup');
      }),
    ]);
  });

  test('renders a background ShellRun terminal update after the agent turn ends', async () => {
    const terminal = new FakeTerminal();
    const driver = new BackgroundShellRunDriver();
    let listener: ((update: ShellRunUpdate) => void) | undefined;
    let unsubscribed = false;
    const run = runMakaPiTui({
      title: 'Maka', driver, cwd: '/repo', model: 'claude-sonnet-4-5',
      connectionSlug: 'claude-subscription', permissionMode: 'ask', terminal,
      subscribeShellRunUpdates: (next) => {
        listener = next;
        return () => { listener = undefined; unsubscribed = true; };
      },
    });

    terminal.input('run');
    terminal.input('\r');
    await waitFor(() => plainTerminalOutput(terminal.screenOutput()).includes('running'));
    assert.ok(listener);
    listener({
      sessionId: 'session-1', ownership: { kind: 'local' }, sourceTurnId: 'turn-1', sourceToolCallId: 'tool-bg',
      result: {
        kind: 'shell_run', ref: 'maka://runtime/background-tasks/bg-1',
        mode: 'pipes',
        status: 'completed', cwd: '/repo', cmd: 'build',
        startedAt: 1_000, updatedAt: 5_000, completedAt: 5_000, exitCode: 0,
        revision: 5_000,
        output: pipeOutput('done\n'),
      },
    });
    await waitFor(() => plainTerminalOutput(terminal.screenOutput()).includes('done 4000ms'));

    exitMaka(terminal);
    await run;
    assert.equal(unsubscribed, true);
  });

  test('keeps tool expansion when kitty protocol reports the Ctrl-O release', async () => {
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

    terminal.input('run');
    terminal.input('\r');
    await waitFor(() => terminal.output().includes('(Ctrl+O)'));

    // Kitty keyboard protocol terminals (Ghostty/Kitty) send one event for the
    // key press and another for the release. The release must not undo the
    // toggle, or expansion only lasts while the key is physically held.
    terminal.input('\x1b[111;5u');
    terminal.input('\x1b[111;5:3u');

    // The compact-only (Ctrl+O) hint leaving the screen proves the card is
    // still expanded after the release event.
    await waitFor(() => !plainTerminalOutput(terminal.screenOutput()).includes('(Ctrl+O)'));
    await delay(20);
    assert.equal(plainTerminalOutput(terminal.screenOutput()).includes('(Ctrl+O)'), false);

    exitMaka(terminal);
    await Promise.race([
      run,
      delay(50).then(() => {
        throw new Error('TUI did not close during test cleanup');
      }),
    ]);
  });

  test('does not treat a kitty Escape press+release as a double Escape', async () => {
    const terminal = new FakeTerminal();
    const driver = new InterruptibleTurnDriver();
    const run = runMakaPiTui({
      title: 'Maka',
      driver,
      cwd: '/repo',
      model: 'claude-sonnet-4-5',
      connectionSlug: 'claude-subscription',
      permissionMode: 'ask',
      terminal,
    });

    terminal.input('run');
    terminal.input('\r');
    await waitFor(() => terminal.progressStates.at(-1) === true);

    // One physical Esc keypress arrives as a press + release pair under the
    // kitty protocol; it must count as a single Escape, not an interrupt.
    terminal.input('\x1b[27u');
    terminal.input('\x1b[27;1:3u');
    await delay(20);
    assert.equal(driver.stopCalls, 0);

    // A real second press still interrupts the running turn.
    terminal.input('\x1b[27u');
    await waitFor(() => driver.stopCalls === 1);
    await waitFor(() => terminal.progressStates.at(-1) === false);

    exitMaka(terminal);
    await Promise.race([
      run,
      delay(50).then(() => {
        throw new Error('TUI did not close during test cleanup');
      }),
    ]);
  });

  test('toggles thinking visibility with Ctrl-T', async () => {
    const terminal = new FakeTerminal();
    const driver = new ThinkingOutputDriver();
    const run = runMakaPiTui({
      title: 'Maka',
      driver,
      cwd: '/repo',
      model: 'claude-sonnet-4-5',
      connectionSlug: 'claude-subscription',
      permissionMode: 'ask',
      terminal,
    });

    terminal.input('run');
    terminal.input('\r');

    await waitFor(() => plainTerminalOutput(terminal.output()).includes('思考（Ctrl+T 展开）'));
    assert.equal(plainTerminalOutput(terminal.output()).includes('secret reasoning tail'), false);

    terminal.input('\x14');
    await waitFor(() => plainTerminalOutput(terminal.output()).includes('secret reasoning tail'));

    terminal.input('\x14');
    await waitFor(() => !plainTerminalOutput(terminal.screenOutput()).includes('secret reasoning tail'));

    exitMaka(terminal);
    await Promise.race([
      run,
      delay(50).then(() => {
        throw new Error('TUI did not close during test cleanup');
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

    await waitFor(() => plainTerminalOutput(terminal.output()).includes('Maka · ask · deepseek-v4-flash · deepseek · /repo'));

    const lines = plainTerminalOutput(terminal.output()).split(/\r?\n/);
    const statusLineIndex = lines.findIndex((line) => line.includes('Maka · ask · deepseek-v4-flash · deepseek · /repo'));
    const editorBorderIndexes = lines
      .map((line, index) => (/^─+$/.test(line) ? index : -1))
      .filter((index) => index >= 0);

    assert.ok(editorBorderIndexes.length >= 2);
    assert.ok(statusLineIndex > editorBorderIndexes[editorBorderIndexes.length - 1]!);

    exitMaka(terminal);
    await Promise.race([
      run,
      delay(50).then(() => {
        throw new Error('TUI did not close during test cleanup');
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

    exitMaka(terminal);
    await Promise.race([
      run,
      delay(50).then(() => {
        throw new Error('TUI did not close during test cleanup');
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

    await waitFor(() => plainTerminalOutput(terminal.output()).includes('Maka · ask · deepseek-v4-flash · deepseek · /repo'));

    const lines = plainTerminalOutput(terminal.output()).split(/\r?\n/);
    const statusLineIndex = lines.findIndex((line) => line.includes('Maka · ask · deepseek-v4-flash · deepseek · /repo'));
    const editorBorderIndexes = lines
      .map((line, index) => (/^─+$/.test(line) ? index : -1))
      .filter((index) => index >= 0);

    assert.equal(statusLineIndex, terminal.rows - 1);
    assert.equal(editorBorderIndexes[editorBorderIndexes.length - 1], terminal.rows - 2);

    exitMaka(terminal);
    await Promise.race([
      run,
      delay(50).then(() => {
        throw new Error('TUI did not close during test cleanup');
      }),
    ]);
  });

  test('flows a transcript taller than the viewport into scrollback, untruncated and un-paged', async () => {
    const terminal = new FakeTerminal();
    const driver = new LongTranscriptDriver();
    const run = runMakaPiTui({
      title: 'Maka',
      driver,
      cwd: '/repo',
      model: 'deepseek-v4-flash',
      connectionSlug: 'deepseek',
      permissionMode: 'ask',
      terminal,
    });

    terminal.input('fill');
    terminal.input('\r');
    // The whole 40-line reply is drawn — head and tail both reach the terminal,
    // so nothing is capped to one screen the way the old windowing did.
    await waitFor(() => plainTerminalOutput(terminal.output()).includes('filler line 40'));
    const cumulative = plainTerminalOutput(terminal.output());
    assert.ok(cumulative.includes('filler line 1'), 'the head of a tall reply must still be written out');

    // No in-app pager: the removed scroll indicator and its PgUp/PgDn hint never
    // appear. History is scrolled through the terminal's own scrollback instead.
    assert.doesNotMatch(cumulative, /PgUp|PgDn|\d+ more/);

    // The visible screen follows the tail: the last reply line and the status
    // line are on screen (status pinned to the bottom row), while the scrolled-off
    // head is not — it now lives in the terminal's native scrollback.
    const screen = plainTerminalOutput(terminal.screenOutput()).split(/\r?\n/);
    assert.ok(screen.some((line) => line.includes('filler line 40')), 'the live tail should be on screen');
    assert.equal(screen.some((line) => line.includes('filler line 1')), false, 'the head should have scrolled off');
    assert.equal(screen[terminal.rows - 1]?.includes('Maka · ask · deepseek-v4-flash · deepseek · /repo'), true);

    exitMaka(terminal);
    await Promise.race([
      run,
      delay(50).then(() => {
        throw new Error('TUI did not close during test cleanup');
      }),
    ]);
  });

  test('does not close the main TUI on Escape', async () => {
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

    await waitFor(() => plainTerminalOutput(terminal.output()).includes('Maka · ask · deepseek-v4-flash · deepseek · /repo'));

    terminal.input('\x1b');
    await delay(30);

    assert.equal(terminal.stopCalls, 0);

    exitMaka(terminal);
    await Promise.race([
      run,
      delay(50).then(() => {
        throw new Error('TUI did not close during test cleanup');
      }),
    ]);
  });

  test('clears an unsent draft on Ctrl-C without closing Maka', async () => {
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

    terminal.input('unsent draft');
    await waitFor(() => plainTerminalOutput(terminal.screenOutput()).includes('unsent draft'));
    terminal.input('\x03');
    await delay(20);

    assert.equal(terminal.stopCalls, 0);
    assert.doesNotMatch(plainTerminalOutput(terminal.screenOutput()), /unsent draft/);
    terminal.input('/exit');
    terminal.input('\r');
    await run;
  });

  test('requires a second idle Ctrl-C to exit Maka', async () => {
    const terminal = new FakeTerminal();
    const driver = new SlashCommandDriver();
    const processExitCodes: number[] = [];
    const run = runMakaPiTui({
      title: 'Maka',
      driver,
      cwd: '/repo',
      model: 'deepseek-v4-flash',
      connectionSlug: 'deepseek',
      permissionMode: 'ask',
      terminal,
      onProcessExit: (exitCode) => processExitCodes.push(exitCode),
    });

    terminal.input('\x03');
    await waitFor(() => plainTerminalOutput(terminal.screenOutput()).includes('Press Ctrl+C again to exit.'));
    assert.equal(terminal.stopCalls, 0);

    terminal.input('\x03');
    await run;
    assert.equal(terminal.stopCalls, 1);
    assert.deepEqual(processExitCodes, [0]);
  });

  test('does not count a Kitty Ctrl-C repeat as the second press', async () => {
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

    terminal.input('\x1b[99;5u');
    await waitFor(() => plainTerminalOutput(terminal.screenOutput()).includes('Press Ctrl+C again to exit.'));
    terminal.input('\x1b[99;5:2u');
    await delay(20);

    assert.equal(terminal.stopCalls, 0);
    terminal.input('\x1b[99;5u');
    await run;
  });

  test('keeps Maka open when Ctrl-D is pressed with a draft', async () => {
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

    terminal.input('draft');
    terminal.input('\x04');
    await delay(20);

    assert.equal(terminal.stopCalls, 0);
    terminal.input('\x03');
    exitMaka(terminal);
    await run;
  });

  test('keeps Maka open when Ctrl-D is pressed during a turn', async () => {
    const terminal = new FakeTerminal();
    const driver = new InterruptibleTurnDriver();
    const run = runMakaPiTui({
      title: 'Maka',
      driver,
      cwd: '/repo',
      model: 'deepseek-v4-flash',
      connectionSlug: 'deepseek',
      permissionMode: 'ask',
      terminal,
    });

    terminal.input('run');
    terminal.input('\r');
    await waitFor(() => terminal.progressStates.at(-1) === true);
    terminal.input('\x04');
    await delay(20);

    assert.equal(terminal.stopCalls, 0);
    assert.equal(driver.stopCalls, 0);
    terminal.input('\x1b');
    terminal.input('\x1b');
    await waitFor(() => terminal.progressStates.at(-1) === false);
    terminal.input('/exit');
    terminal.input('\r');
    await run;
  });

  test('closes the main TUI on Ctrl-D', async () => {
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

    terminal.input('\x04');

    await Promise.race([
      run,
      delay(50).then(() => {
        throw new Error('TUI did not close after Ctrl-D');
      }),
    ]);
    assert.equal(terminal.stopCalls, 1);
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
    const exitIndex = output.indexOf('/exit');
    const modelIndex = output.indexOf('/model');
    const permissionsIndex = output.indexOf('/permissions');
    const sessionIndex = output.indexOf('/session');

    assert.ok(exitIndex >= 0);
    assert.ok(modelIndex >= 0);
    assert.ok(permissionsIndex >= 0);
    assert.ok(sessionIndex >= 0);
    assert.ok(exitIndex < modelIndex);
    assert.ok(modelIndex < permissionsIndex);
    assert.ok(permissionsIndex < sessionIndex);
    // The whole menu is visible at once — including the last command
    // alphabetically — so new commands don't push older ones below the fold.
    assert.ok(output.indexOf('/thinking') > sessionIndex);

    exitMaka(terminal);
    await Promise.race([
      run,
      delay(50).then(() => {
        throw new Error('TUI did not close during test cleanup');
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
    const statusLineIndex = lines.findIndex((line) => line.includes('Maka · ask · deepseek-v4-flash · deepseek · /repo'));
    const editorBorderIndexes = lines
      .map((line, index) => (/^─+$/.test(line) ? index : -1))
      .filter((index) => index >= 0);

    assert.ok(suggestionIndex >= 0);
    assert.ok(editorBorderIndexes.length >= 2);
    assert.ok(suggestionIndex < editorBorderIndexes[editorBorderIndexes.length - 2]!);
    assert.equal(editorBorderIndexes[editorBorderIndexes.length - 1], statusLineIndex - 1);

    exitMaka(terminal);
    await Promise.race([
      run,
      delay(50).then(() => {
        throw new Error('TUI did not close during test cleanup');
      }),
    ]);
  });

  test('keeps slash autocomplete filtering anchored to the input editor', async () => {
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

    await waitFor(() => plainTerminalOutput(terminal.screenOutput()).includes('/session'));
    const beforeLines = plainTerminalOutput(terminal.screenOutput()).split(/\r?\n/);
    const beforeRows = inputSurfaceRows(beforeLines);
    const beforeSessionRow = beforeLines.findIndex((line) => line.includes('/session'));

    terminal.input('s');

    await waitFor(() => {
      const output = plainTerminalOutput(terminal.screenOutput());
      return output.includes('/session') && !output.includes('/model');
    });
    const afterLines = plainTerminalOutput(terminal.screenOutput()).split(/\r?\n/);
    const afterRows = inputSurfaceRows(afterLines);
    const afterSessionRow = afterLines.findIndex((line) => line.includes('/session'));

    assert.ok(beforeSessionRow >= 0);
    assert.deepEqual(afterRows, beforeRows);
    assert.equal(afterSessionRow, afterRows[0] - 1);

    exitMaka(terminal);
    await Promise.race([
      run,
      delay(50).then(() => {
        throw new Error('TUI did not close during test cleanup');
      }),
    ]);
  });

  test('keeps slash autocomplete filtering pinned to the bottom after scrollback', async () => {
    const terminal = new FakeTerminal();
    const driver = new LongTranscriptDriver();
    const run = runMakaPiTui({
      title: 'Maka',
      driver,
      cwd: '/repo',
      model: 'deepseek-v4-flash',
      connectionSlug: 'deepseek',
      permissionMode: 'ask',
      terminal,
    });

    terminal.input('fill');
    terminal.input('\r');

    await waitFor(() => driver.prompts.length === 1);
    await waitFor(() => terminal.progressStates.at(-1) === false);
    await waitFor(() => plainTerminalOutput(terminal.output()).includes('filler line 40'));

    terminal.input('/');

    await waitFor(() => plainTerminalOutput(terminal.output()).includes('/session'));
    const beforeLines = plainTerminalOutput(terminal.screenOutput()).split(/\r?\n/);
    const beforeRows = inputSurfaceRows(beforeLines);

    terminal.input('s');

    await waitFor(() => {
      const output = plainTerminalOutput(terminal.screenOutput());
      return output.includes('/session') && !output.includes('/model');
    });
    const afterLines = plainTerminalOutput(terminal.screenOutput()).split(/\r?\n/);
    const afterRows = inputSurfaceRows(afterLines);
    const afterSessionRow = afterLines.findIndex((line) => line.includes('/session'));

    assert.deepEqual(afterRows, beforeRows);
    assert.equal(afterRows[1], terminal.rows - 2);
    assert.equal(afterSessionRow, afterRows[0] - 1);

    exitMaka(terminal);
    await Promise.race([
      run,
      delay(50).then(() => {
        throw new Error('TUI did not close during test cleanup');
      }),
    ]);
  });

  test('bottom-aligns filtered autocomplete inside a stable slot', () => {
    const expanded = arrangeAutocompleteAboveEditor({
      lines: [
        '────────',
        '/ ',
        '────────',
        '→ /exit',
        '  /model',
        '  /permissions',
        '  /session',
      ],
      autocompleteShowing: true,
      autocompleteSlotRows: 0,
    });

    const filtered = arrangeAutocompleteAboveEditor({
      lines: [
        '────────',
        '/s ',
        '────────',
        '→ /session',
      ],
      autocompleteShowing: true,
      autocompleteSlotRows: expanded.autocompleteSlotRows,
    });

    assert.equal(filtered.lines.length, expanded.lines.length);
    assert.deepEqual(filtered.lines.slice(0, 4), ['', '', '', '→ /session']);
    assert.deepEqual(filtered.lines.slice(4), ['────────', '/s ', '────────']);
  });

  test('handles /exit without sending a prompt', async () => {
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

    terminal.input('/exit');
    terminal.input('\r');

    await Promise.race([
      run,
      delay(50).then(() => {
        throw new Error('TUI did not close after /exit');
      }),
    ]);

    assert.deepEqual(driver.prompts, []);
    assert.equal(terminal.stopCalls, 1);
  });

  test('keeps Maka open when Ctrl-D is pressed during a control command', async () => {
    const terminal = new FakeTerminal();
    const driver = new DeferredControlDriver();
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
    terminal.input('\x04');
    await delay(20);

    try {
      assert.equal(terminal.stopCalls, 0);
    } finally {
      driver.releaseSetModel();
      if (terminal.stopCalls === 0) exitMaka(terminal);
      await run;
    }
  });

  test('exits on the second Ctrl-C during a control command', async () => {
    const terminal = new FakeTerminal();
    const driver = new DeferredControlDriver();
    const processExitCodes: number[] = [];
    const run = runMakaPiTui({
      title: 'Maka',
      driver,
      cwd: '/repo',
      model: 'claude-sonnet-4-5',
      connectionSlug: 'claude-subscription',
      permissionMode: 'ask',
      terminal,
      onProcessExit: (exitCode) => processExitCodes.push(exitCode),
    });

    terminal.input('/model claude-opus-4-1');
    terminal.input('\r');
    await waitFor(() => driver.models.length === 1);
    terminal.input('\x03');
    await delay(20);

    try {
      assert.equal(terminal.stopCalls, 0);
      terminal.input('\x03');
      await Promise.race([
        run,
        delay(50).then(() => {
          throw new Error('TUI did not close after the second Ctrl-C');
        }),
      ]);
      assert.equal(terminal.stopCalls, 1);
      assert.deepEqual(processExitCodes, [0]);
    } finally {
      driver.releaseSetModel();
      if (terminal.stopCalls === 0) exitMaka(terminal);
      await run;
    }
  });

  test('handles /compact through the runtime compact API and progress loader', async () => {
    const terminal = new FakeTerminal();
    const driver = new DeferredCompactDriver();
    const run = runMakaPiTui({
      title: 'Maka',
      driver,
      cwd: '/repo',
      model: 'deepseek-v4-flash',
      connectionSlug: 'deepseek',
      permissionMode: 'ask',
      terminal,
    });

    for (const char of '/compact') terminal.input(char);
    terminal.input('\r');

    await waitFor(() => driver.compactCalls === 1);
    await waitFor(() => plainTerminalOutput(terminal.output()).includes('Compacting context'));

    assert.deepEqual(driver.prompts, []);
    assert.equal(terminal.progressStates.at(-1), true);

    driver.releaseCompact();
    await waitFor(() => terminal.progressStates.at(-1) === false);
    await waitFor(() => plainTerminalOutput(terminal.output()).includes('Context compacted'));

    exitMaka(terminal);
    await Promise.race([
      run,
      delay(50).then(() => {
        throw new Error('TUI did not close during test cleanup');
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

    terminal.input('/m');

    await waitFor(() => plainTerminalOutput(terminal.output()).includes('/model'));
    terminal.input('\r');
    await waitFor(() => terminal.output().includes('Select Model'));

    assert.deepEqual(driver.prompts, []);

    terminal.input('\x1b');
    exitMaka(terminal);
    await Promise.race([
      run,
      delay(50).then(() => {
        throw new Error('TUI did not close during test cleanup');
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

    exitMaka(terminal);
    await Promise.race([
      run,
      delay(50).then(() => {
        throw new Error('TUI did not close during test cleanup');
      }),
    ]);
  });

  test('handles /thinking high without sending a prompt', async () => {
    const terminal = new FakeTerminal();
    const driver = new SlashCommandDriver();
    const run = runMakaPiTui({
      title: 'Maka',
      driver,
      cwd: '/repo',
      model: 'gpt-5.5',
      connectionSlug: 'openai',
      providerType: 'openai',
      permissionMode: 'ask',
      terminal,
    });

    terminal.input('/thinking high');
    terminal.input('\r');

    await waitFor(() => driver.thinkingLevelUpdates.length === 1);
    assert.deepEqual(driver.thinkingLevelUpdates, ['high']);
    assert.deepEqual(driver.prompts, []);

    exitMaka(terminal);
    await Promise.race([
      run,
      delay(50).then(() => {
        throw new Error('TUI did not close during test cleanup');
      }),
    ]);
  });

  test('handles /thinking off when the current model exposes a real off wire', async () => {
    const terminal = new FakeTerminal();
    const driver = new SlashCommandDriver();
    const run = runMakaPiTui({
      title: 'Maka',
      driver,
      cwd: '/repo',
      model: 'gpt-5.5',
      connectionSlug: 'openai',
      providerType: 'openai',
      permissionMode: 'ask',
      terminal,
    });

    terminal.input('/thinking off');
    terminal.input('\r');

    await waitFor(() => driver.thinkingLevelUpdates.length === 1);
    assert.deepEqual(driver.thinkingLevelUpdates, ['off']);
    assert.deepEqual(driver.prompts, []);

    exitMaka(terminal);
    await Promise.race([
      run,
      delay(50).then(() => {
        throw new Error('TUI did not close during test cleanup');
      }),
    ]);
  });

  test('rejects unsupported /thinking levels with usage instead of sending an update', async () => {
    const terminal = new FakeTerminal();
    const driver = new SlashCommandDriver();
    const run = runMakaPiTui({
      title: 'Maka',
      driver,
      cwd: '/repo',
      model: 'gpt-5',
      connectionSlug: 'openai',
      providerType: 'openai',
      permissionMode: 'ask',
      terminal,
    });

    terminal.input('/thinking off');
    terminal.input('\r');

    await waitFor(() => plainTerminalOutput(terminal.output()).includes('Usage: /thinking default|minimal|low|medium|high'));
    assert.deepEqual(driver.thinkingLevelUpdates, []);
    assert.deepEqual(driver.prompts, []);

    exitMaka(terminal);
    await Promise.race([
      run,
      delay(50).then(() => {
        throw new Error('TUI did not close during test cleanup');
      }),
    ]);
  });

  test('handles /thinking default by clearing the override', async () => {
    const terminal = new FakeTerminal();
    const driver = new SlashCommandDriver();
    const run = runMakaPiTui({
      title: 'Maka',
      driver,
      cwd: '/repo',
      model: 'gpt-5.5',
      connectionSlug: 'openai',
      providerType: 'openai',
      permissionMode: 'ask',
      terminal,
    });

    terminal.input('/thinking default');
    terminal.input('\r');

    await waitFor(() => driver.thinkingLevelUpdates.length === 1);
    assert.deepEqual(driver.thinkingLevelUpdates, [undefined]);
    assert.deepEqual(driver.prompts, []);

    exitMaka(terminal);
    await Promise.race([
      run,
      delay(50).then(() => {
        throw new Error('TUI did not close during test cleanup');
      }),
    ]);
  });

  test('selects a permission mode from /permissions', async () => {
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

    terminal.input('/permissions');
    terminal.input('\r');

    await waitFor(() => terminal.output().includes('Select Permission Mode'));
    assertBottomPickerPlacement(
      terminal,
      'Select Permission Mode',
      'Maka · ask · claude-sonnet-4-5 · claude-subscription · /repo',
    );
    terminal.input('\x1b[B');
    terminal.input('\r');
    await waitFor(() => driver.permissionModes.length === 1);
    await waitFor(() => terminal.output().includes('Permission mode: execute'));

    assert.deepEqual(driver.permissionModes, ['execute']);
    assert.deepEqual(driver.prompts, []);

    exitMaka(terminal);
    await Promise.race([
      run,
      delay(50).then(() => {
        throw new Error('TUI did not close during test cleanup');
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

    exitMaka(terminal);
    await Promise.race([
      run,
      delay(50).then(() => {
        throw new Error('TUI did not close during test cleanup');
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
    assertBottomPickerPlacement(terminal, 'Select Model', 'Maka · ask · deepseek-v4-flash · deepseek · /repo');
    terminal.input('\x1b[B');
    terminal.input('\r');
    await waitFor(() => driver.models.length === 1);
    await waitFor(() => terminal.output().includes('Model: gpt-5.3-codex-spark'));

    assert.deepEqual(driver.models, ['gpt-5.3-codex-spark']);
    assert.deepEqual(driver.prompts, []);

    exitMaka(terminal);
    await Promise.race([
      run,
      delay(50).then(() => {
        throw new Error('TUI did not close during test cleanup');
      }),
    ]);
  });

  test('switches connection and model together from a cross-connection /model', async () => {
    const terminal = new FakeTerminal();
    const driver = new SlashCommandDriver();
    const run = runMakaPiTui({
      title: 'Maka',
      driver,
      cwd: '/repo',
      model: 'gpt-5.5',
      connectionSlug: 'openai',
      providerType: 'openai',
      modelChoices: [
        { connectionSlug: 'openai', connectionName: 'OpenAI', providerType: 'openai', model: 'gpt-5.5', isDefaultConnection: true },
        { connectionSlug: 'zai', connectionName: 'Z.ai', providerType: 'openai', model: 'glm-5.2', isDefaultConnection: false },
      ],
      permissionMode: 'ask',
      terminal,
    });

    terminal.input('/model');
    terminal.input('\r');

    await waitFor(() => terminal.output().includes('Select Model'));
    await waitFor(() => terminal.output().includes('glm-5.2'));
    // The picker opens on the current model (gpt-5.5); move down to the choice on
    // the other connection and select it.
    terminal.input('\x1b[B');
    terminal.input('\r');
    await waitFor(() => driver.models.length === 1);

    assert.deepEqual(driver.models, ['glm-5.2']);
    assert.deepEqual(driver.modelConnections, ['zai']);
    // The status line now reflects both the new model and the new connection.
    await waitFor(() => plainTerminalOutput(terminal.output()).includes('Maka · ask · glm-5.2 · zai · /repo'));

    exitMaka(terminal);
    await Promise.race([
      run,
      delay(50).then(() => {
        throw new Error('TUI did not close during test cleanup');
      }),
    ]);
  });

  test('handles /rename without sending a prompt', async () => {
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

    terminal.input('/rename PR 946 修复');
    terminal.input('\r');

    await waitFor(() => driver.renames.length === 1);
    await waitFor(() => plainTerminalOutput(terminal.output()).includes('Session renamed to "PR 946 修复"'));

    assert.deepEqual(driver.renames, ['PR 946 修复']);
    assert.deepEqual(driver.prompts, []);

    exitMaka(terminal);
    await Promise.race([
      run,
      delay(50).then(() => {
        throw new Error('TUI did not close during test cleanup');
      }),
    ]);
  });

  test('rejects /rename without a new name', async () => {
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

    terminal.input('/rename');
    terminal.input('\r');

    await waitFor(() => plainTerminalOutput(terminal.output()).includes('Usage: /rename <new name>'));
    assert.deepEqual(driver.renames, []);
    assert.deepEqual(driver.prompts, []);

    exitMaka(terminal);
    await Promise.race([
      run,
      delay(50).then(() => {
        throw new Error('TUI did not close during test cleanup');
      }),
    ]);
  });

  test('handles /session without sending a prompt', async () => {
    const terminal = new FakeTerminal();
    const driver = new SlashCommandDriver([fakeSessionSummary('session-2', '/repo')]);
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
    await waitFor(() => terminal.output().includes('Resumed session "Existing chat"'));

    assert.deepEqual(driver.sessionIds, ['session-2']);
    assert.deepEqual(driver.prompts, []);

    exitMaka(terminal);
    await Promise.race([
      run,
      delay(50).then(() => {
        throw new Error('TUI did not close during test cleanup');
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

    await waitFor(() => plainTerminalOutput(terminal.output()).includes('Resume Session Current'));
    // The picker labels rows by human name, not the raw session id.
    await waitFor(() => terminal.output().includes('Existing chat'));
    const titleLine = latestPlainLineContaining(terminal.output(), 'Resume Session Current');
    assert.equal(titleLine.startsWith('Resume Session Current'), true);
    assert.equal(visibleWidth(titleLine), terminal.columns);
    assertBottomPickerPlacement(
      terminal,
      'Resume Session Current',
      'Maka · ask · claude-sonnet-4-5 · claude-subscription · /repo',
    );
    terminal.input('\r');
    await waitFor(() => driver.sessionIds.length === 1);
    await waitFor(() => terminal.output().includes('Resumed session "Existing chat"'));

    assert.deepEqual(driver.sessionIds, ['session-2']);
    assert.deepEqual(driver.prompts, []);

    exitMaka(terminal);
    await Promise.race([
      run,
      delay(50).then(() => {
        throw new Error('TUI did not close during test cleanup');
      }),
    ]);
  });

  test('renders switched session history instead of a session id note', async () => {
    const terminal = new FakeTerminal();
    const driver = new SlashCommandDriver(
      [fakeSessionSummary('session-2', '/repo')],
      new Map([
        ['session-2', [
          storedUserMessage('user-1', 'turn-1', 'previous question'),
          storedAssistantMessage('assistant-1', 'turn-1', 'previous answer'),
        ]],
      ]),
    );
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

    await waitFor(() => plainTerminalOutput(terminal.output()).includes('previous question'));
    await waitFor(() => plainTerminalOutput(terminal.output()).includes('previous answer'));
    const output = plainTerminalOutput(terminal.output());
    assert.equal(output.includes('Session: session-2'), false);

    exitMaka(terminal);
    await Promise.race([
      run,
      delay(50).then(() => {
        throw new Error('TUI did not close during test cleanup');
      }),
    ]);
  });

  test('hydrates a resumed background Bash card from durable shell-run state', async () => {
    const terminal = new FakeTerminal();
    const ref = 'maka://runtime/background-tasks/bg-1';
    const driver = new SlashCommandDriver(
      [fakeSessionSummary('session-2', '/repo')],
      new Map([
        ['session-2', [
          {
            type: 'tool_call', id: 'tool-bg', turnId: 'turn-1', ts: 1,
            toolName: 'Bash', args: { command: 'build' },
          },
          {
            type: 'tool_result', id: 'result-bg', turnId: 'turn-1', ts: 2,
            toolUseId: 'tool-bg', isError: false,
            content: {
              kind: 'shell_run', ref, mode: 'pipes', status: 'running', cwd: '/repo', cmd: 'build',
              startedAt: 1_000, updatedAt: 2_000,
              revision: 2_000,
              output: pipeOutput('starting\n'),
            },
          },
        ] satisfies StoredMessage[]],
      ]),
    );
    const reads: string[] = [];
    const run = runMakaPiTui({
      title: 'Maka', driver, cwd: '/repo', model: 'claude-sonnet-4-5',
      connectionSlug: 'claude-subscription', permissionMode: 'ask', terminal,
      listShellRunUpdates: async (sessionId) => {
        reads.push(sessionId);
        return [{
          sessionId,
          ownership: { kind: 'local' },
          sourceTurnId: 'turn-1',
          sourceToolCallId: 'tool-bg',
          result: {
            kind: 'shell_run', ref, mode: 'pipes', status: 'completed', cwd: '/repo', cmd: 'build',
            startedAt: 1_000, updatedAt: 5_000, completedAt: 5_000, exitCode: 0,
            revision: 5_000,
            output: pipeOutput('starting\ndone\n'),
          },
        }];
      },
    });

    terminal.input('/session session-2');
    terminal.input('\r');

    await waitFor(() => plainTerminalOutput(terminal.screenOutput()).includes('done 4000ms'));
    assert.deepEqual(reads, ['session-2']);

    exitMaka(terminal);
    await run;
  });

  test('shows every connection in Current while hiding other cwd sessions', async () => {
    const terminal = new FakeTerminal();
    const driver = new SlashCommandDriver([
      fakeSessionSummary('session-current', '/repo', 'Current chat'),
      { ...fakeSessionSummary('session-other-connection', '/repo', 'Other connection chat'), llmConnectionSlug: 'zai' },
      fakeSessionSummary('session-other', '/elsewhere', 'Other chat'),
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

    await waitFor(() => terminal.output().includes('Current chat'));
    const output = plainTerminalOutput(terminal.output());
    assert.equal(output.includes('Other connection chat'), true);
    assert.equal(output.includes('Other chat'), false);

    terminal.input('\x1b');
    exitMaka(terminal);
    await Promise.race([
      run,
      delay(50).then(() => {
        throw new Error('TUI did not close during test cleanup');
      }),
    ]);
  });

  test('toggles the session picker from Current to All with Tab', async () => {
    const terminal = new FakeTerminal();
    const driver = new SlashCommandDriver([
      fakeSessionSummary('session-current', '/repo', 'Current chat'),
      fakeSessionSummary('session-other', '/elsewhere', 'Other chat'),
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
    await waitFor(() => terminal.output().includes('Current chat'));
    assert.equal(plainTerminalOutput(terminal.screenOutput()).includes('Other chat'), false);

    terminal.input('\t');
    await waitFor(() => plainTerminalOutput(terminal.screenOutput()).includes('Other chat'));
    assert.match(plainTerminalOutput(terminal.screenOutput()), /Resume Session.*All/);
    assert.match(plainTerminalOutput(terminal.screenOutput()), /Other chat.*elsewhere/);

    terminal.input('\x1b');
    exitMaka(terminal);
    await run;
  });

  test('adopts a resumed cwd and remembers the All scope for the TUI process', async () => {
    const terminal = new FakeTerminal();
    const driver = new SlashCommandDriver([
      fakeSessionSummary('session-current', '/repo', 'Current chat'),
      fakeSessionSummary('session-other', '/elsewhere', 'Other chat'),
    ]);
    const run = runMakaPiTui({
      title: 'Maka', driver, cwd: '/repo', model: 'claude-sonnet-4-5',
      connectionSlug: 'claude-subscription', permissionMode: 'ask', terminal,
    });

    terminal.input('/session');
    terminal.input('\r');
    await waitFor(() => terminal.output().includes('Current chat'));
    terminal.input('\t');
    await waitFor(() => plainTerminalOutput(terminal.screenOutput()).includes('Other chat'));
    terminal.input('\x1b[B');
    terminal.input('\r');
    await waitFor(() => driver.sessionIds.includes('session-other'));
    await waitFor(() => plainTerminalOutput(terminal.screenOutput()).includes('/elsewhere'));

    terminal.input('/session');
    terminal.input('\r');
    await waitFor(() => plainTerminalOutput(terminal.screenOutput()).includes('Resume Session All'));
    terminal.input('\t');
    await waitFor(() => plainTerminalOutput(terminal.screenOutput()).includes('Resume Session Current'));
    const currentOutput = plainTerminalOutput(terminal.screenOutput());
    assert.equal(currentOutput.includes('Other chat'), true);
    assert.equal(currentOutput.includes('Current chat'), false);

    terminal.input('\x1b');
    exitMaka(terminal);
    await run;
  });

  test('shows a session without a cwd in All but prevents resuming it', async () => {
    const terminal = new FakeTerminal();
    const driver = new SlashCommandDriver([
      fakeSessionSummary('session-current', '/repo', 'Current chat'),
      { ...fakeSessionSummary('session-legacy', '/repo', 'Legacy chat'), cwd: undefined },
    ]);
    Object.defineProperty(driver, 'getSessionResumeAvailability', { value: undefined });
    const run = runMakaPiTui({
      title: 'Maka', driver, cwd: '/repo', model: 'claude-sonnet-4-5',
      connectionSlug: 'claude-subscription', permissionMode: 'ask', terminal,
    });

    terminal.input('/session');
    terminal.input('\r');
    await waitFor(() => terminal.output().includes('Current chat'));
    terminal.input('\t');
    await waitFor(() => plainTerminalOutput(terminal.screenOutput()).includes('Missing working directory'));
    terminal.input('\x1b[B');
    terminal.input('\r');
    await delay(10);

    assert.deepEqual(driver.sessionIds, []);
    assert.match(plainTerminalOutput(terminal.screenOutput()), /Legacy chat.*Missing working directory/);

    terminal.input('\x1b');
    exitMaka(terminal);
    await run;
  });

  test('the session picker scrolls through every session rather than capping', async () => {
    const terminal = new FakeTerminal();
    const sessions = Array.from({ length: 12 }, (_, i) => fakeSessionSummary(`session-${i}`, '/repo', `chat ${i}`));
    const driver = new SlashCommandDriver(sessions);
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

    await waitFor(() => plainTerminalOutput(terminal.output()).includes('Resume Session Current'));
    // All 12 are in the list (not sliced to 10): the scroll indicator counts the
    // full total, so the window shows "(1/12)".
    await waitFor(() => plainTerminalOutput(terminal.screenOutput()).includes('/12)'));
    // And the 12th is genuinely reachable: scrolling down brings it into view,
    // even though it starts below the visible window.
    assert.equal(plainTerminalOutput(terminal.screenOutput()).includes('chat 11'), false);
    for (let i = 0; i < 11; i += 1) terminal.input('\x1b[B');
    await waitFor(() => plainTerminalOutput(terminal.screenOutput()).includes('chat 11'));

    terminal.input('\x1b');
    exitMaka(terminal);
    await Promise.race([
      run,
      delay(50).then(() => {
        throw new Error('TUI did not close during test cleanup');
      }),
    ]);
  });

  test('the session picker disambiguates same-named sessions by short id', async () => {
    const terminal = new FakeTerminal();
    const driver = new SlashCommandDriver([
      fakeSessionSummary('aaaa1111-2222-3333', '/repo', 'Same name'),
      fakeSessionSummary('bbbb4444-5555-6666', '/repo', 'Same name'),
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

    await waitFor(() => plainTerminalOutput(terminal.output()).includes('Resume Session Current'));
    // Same label on both rows, but the short id in the description tells them apart.
    await waitFor(() => plainTerminalOutput(terminal.screenOutput()).includes('aaaa1111'));
    await waitFor(() => plainTerminalOutput(terminal.screenOutput()).includes('bbbb4444'));

    terminal.input('\x1b');
    exitMaka(terminal);
    await Promise.race([
      run,
      delay(50).then(() => {
        throw new Error('TUI did not close during test cleanup');
      }),
    ]);
  });

  test('/help lists commands and keybindings', async () => {
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

    terminal.input('/help');
    terminal.input('\r');

    await waitFor(() => plainTerminalOutput(terminal.output()).includes('Commands'));
    const out = plainTerminalOutput(terminal.output());
    // Commands are derived from the registry, so a representative one shows up.
    assert.ok(out.includes('/rewind'));
    assert.ok(out.includes('Rewind to an earlier turn'));
    assert.ok(out.includes('/new'));
    // Keybindings — the whole reason /help exists (they are otherwise hidden).
    assert.ok(out.includes('Keybindings'));
    assert.ok(out.includes('Ctrl+O'));
    assert.ok(out.includes('Esc Esc'));
    assert.ok(out.includes('Ctrl+C — stop the turn, clear input, or press twice to exit'));
    assert.ok(out.includes('Ctrl+D — exit when input is empty'));
    // Scrolling is the terminal's own now; the removed PgUp/PgDn pager must not
    // be advertised as a working keybinding.
    assert.ok(out.includes('terminal or trackpad'));
    assert.equal(out.includes('PageUp'), false);
    assert.deepEqual(driver.prompts, []);

    exitMaka(terminal);
    await Promise.race([
      run,
      delay(50).then(() => {
        throw new Error('TUI did not close during test cleanup');
      }),
    ]);
  });

  test('/new clears the transcript and starts a fresh session', async () => {
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

    terminal.input('remember this');
    terminal.input('\r');
    await waitFor(() => driver.prompts.length === 1);
    await waitFor(() => plainTerminalOutput(terminal.screenOutput()).includes('remember this'));

    terminal.input('/new');
    terminal.input('\r');

    await waitFor(() => driver.startNewSessionCalls === 1);
    // /new empties the transcript, so it opens on the same welcome block as a
    // cold start rather than a one-off notice — that block is the "fresh session"
    // cue and a notice would suppress it.
    await waitFor(() => plainTerminalOutput(terminal.screenOutput()).includes('输入消息开始对话，或用斜杠命令：'));
    // The previous turn is gone from the visible transcript.
    await waitFor(() => !plainTerminalOutput(terminal.screenOutput()).includes('remember this'));

    exitMaka(terminal);
    await Promise.race([
      run,
      delay(50).then(() => {
        throw new Error('TUI did not close during test cleanup');
      }),
    ]);
  });

  test('/new cancels hydration retries owned by the previous session', async () => {
    const terminal = new FakeTerminal();
    const driver = new RewindDriver([{ turnId: 'turn-2', label: 'second question' }]);
    let hydrationAttempts = 0;
    const run = runMakaPiTui({
      title: 'Maka', driver, cwd: '/repo', model: 'claude-sonnet-4-5',
      connectionSlug: 'claude-subscription', permissionMode: 'ask', terminal,
      listShellRunUpdates: async () => {
        hydrationAttempts += 1;
        throw new Error('transient hydration failure');
      },
    });

    terminal.input('/rewind');
    terminal.input('\r');
    await waitFor(() => plainTerminalOutput(terminal.output()).includes('回到选定轮次'));
    terminal.input('\r');
    await waitFor(() => hydrationAttempts === 1);
    await waitFor(() => plainTerminalOutput(terminal.screenOutput()).includes('refilled: turn-2'));

    terminal.input('\x03');
    terminal.input('/new');
    terminal.input('\r');
    await waitFor(() => driver.startNewSessionCalls === 1);
    const attemptsAfterReset = hydrationAttempts;
    await delay(300);
    assert.equal(hydrationAttempts, attemptsAfterReset);

    exitMaka(terminal);
    await run;
  });

  test('blocks prompt submission while a control command is in flight', async () => {
    const terminal = new FakeTerminal();
    const driver = new DeferredControlDriver();
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

    // While the model switch is in flight, typing + Enter must not send a prompt.
    terminal.input('blocked');
    terminal.input('\r');
    await delay(20);
    assert.deepEqual(driver.prompts, []);

    // After the switch completes, the previously typed prompt goes through.
    driver.releaseSetModel();
    await delay(20);
    terminal.input('\r');
    await waitFor(() => driver.prompts.length === 1);
    assert.deepEqual(driver.prompts, ['blocked']);

    exitMaka(terminal);
    await Promise.race([
      run,
      delay(50).then(() => {
        throw new Error('TUI did not close during test cleanup');
      }),
    ]);
  });

  test('keeps the permission prompt visible when responding rejects', async () => {
    const terminal = new FakeTerminal();
    const driver = new RejectingPermissionDriver();
    const run = runMakaPiTui({
      title: 'Maka',
      driver,
      cwd: '/repo',
      model: 'claude-sonnet-4-5',
      connectionSlug: 'claude-subscription',
      permissionMode: 'ask',
      terminal,
    });

    terminal.input('run');
    terminal.input('\r');
    await waitFor(() => terminal.output().includes('Permission required'));

    terminal.input('y');
    await waitFor(() => driver.responses.length === 1);
    await delay(20);

    // Response rejected: error shows, but the permission prompt stays and can be retried.
    assert.ok(plainTerminalOutput(terminal.output()).includes('Permission required'));

    terminal.input('n');
    await waitFor(() => driver.responses.length === 2);

    exitMaka(terminal);
    await Promise.race([
      run,
      delay(50).then(() => {
        throw new Error('TUI did not close during test cleanup');
      }),
    ]);
  });

  test('blocks prompts while the session list is loading', async () => {
    const terminal = new FakeTerminal();
    const driver = new DeferredListSessionsDriver([fakeSessionSummary('session-2')]);
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
    await waitFor(() => driver.listCalls === 1);

    // While the list is still loading, a submitted prompt must not go through.
    terminal.input('hello');
    terminal.input('\r');
    await delay(20);
    assert.deepEqual(driver.prompts, []);

    driver.releaseList();
    await delay(30);

    terminal.input('\x1b');
    exitMaka(terminal);
    await Promise.race([
      run,
      delay(50).then(() => {
        throw new Error('TUI did not close during test cleanup');
      }),
    ]);
  });

  test('interrupts the running turn on double Escape', async () => {
    const terminal = new FakeTerminal();
    const driver = new InterruptibleTurnDriver();
    const run = runMakaPiTui({
      title: 'Maka',
      driver,
      cwd: '/repo',
      model: 'claude-sonnet-4-5',
      connectionSlug: 'claude-subscription',
      permissionMode: 'ask',
      terminal,
    });

    terminal.input('run');
    terminal.input('\r');
    await waitFor(() => terminal.progressStates.at(-1) === true);

    terminal.input('\x1b');
    await delay(20);
    assert.equal(driver.stopCalls, 0);

    terminal.input('\x1b');
    await waitFor(() => driver.stopCalls === 1);
    await waitFor(() => plainTerminalOutput(terminal.output()).includes('Stopped: user_stop'));
    await waitFor(() => terminal.progressStates.at(-1) === false);

    // Idle double Escape opens the rewind picker, never a stop: the session is
    // between turns. This fake exposes no rewind targets, so it only shows a
    // notice, but the contract under test is that stopSession is not fired again.
    terminal.input('\x1b');
    terminal.input('\x1b');
    await delay(20);
    assert.equal(driver.stopCalls, 1);

    exitMaka(terminal);
    await Promise.race([
      run,
      delay(50).then(() => {
        throw new Error('TUI did not close during test cleanup');
      }),
    ]);
  });

  test('opens a rewind picker from /rewind and branches on select', async () => {
    const terminal = new FakeTerminal();
    const driver = new RewindDriver(
      [
        { turnId: 'turn-2', label: 'second question' },
        { turnId: 'turn-1', label: 'first question' },
      ],
      [
        storedUserMessage('user-1', 'turn-1', 'first question'),
        storedAssistantMessage('assistant-1', 'turn-1', 'first answer'),
      ],
    );
    const run = runMakaPiTui({
      title: 'Maka',
      driver,
      cwd: '/repo',
      model: 'claude-sonnet-4-5',
      connectionSlug: 'claude-subscription',
      permissionMode: 'ask',
      terminal,
    });

    terminal.input('/rewind');
    terminal.input('\r');

    await waitFor(() => plainTerminalOutput(terminal.output()).includes('回到选定轮次'));
    await waitFor(() => plainTerminalOutput(terminal.output()).includes('second question'));
    await waitFor(() => plainTerminalOutput(terminal.output()).includes('first question'));

    // The picker lists targets newest-first, so the default selection is turn-2.
    terminal.input('\r');
    await waitFor(() => driver.rewound.length === 1);
    assert.deepEqual(driver.rewound, ['turn-2']);
    await waitFor(() => plainTerminalOutput(terminal.output()).includes('已回退到该轮之前'));
    await waitFor(() => plainTerminalOutput(terminal.output()).includes('first answer'));
    // The rewound turn's prompt is refilled into the editor for an edit-and-resend.
    await waitFor(() => plainTerminalOutput(terminal.output()).includes('refilled: turn-2'));

    exitMaka(terminal);
    await Promise.race([
      run,
      delay(50).then(() => {
        throw new Error('TUI did not close during test cleanup');
      }),
    ]);
  });

  test('marks an inherited running Bash card detached after rewind', async () => {
    const terminal = new FakeTerminal();
    const ref = 'maka://runtime/background-tasks/bg-1';
    const branchMessages = [
      {
        type: 'tool_call', id: 'tool-bg', turnId: 'turn-1', ts: 1,
        toolName: 'Bash', args: { command: 'build' },
      },
      {
        type: 'tool_result', id: 'result-bg', turnId: 'turn-1', ts: 2,
        toolUseId: 'tool-bg', isError: false,
        content: {
          kind: 'shell_run', ref, mode: 'pipes', status: 'running', cwd: '/repo', cmd: 'build',
          startedAt: 1_000, updatedAt: 2_000,
          revision: 2_000,
          output: pipeOutput('still running\n'),
        },
      },
    ] satisfies StoredMessage[];
    const driver = new RewindDriver(
      [{ turnId: 'turn-2', label: 'second question' }],
      branchMessages,
      { ...fakeSessionSummary('session-branch'), parentSessionId: 'session-1' },
    );
    let listener: ((update: ShellRunUpdate) => void) | undefined;
    let hydrationAttempts = 0;
    let resolveHydration: ((updates: ShellRunUpdate[]) => void) | undefined;
    const run = runMakaPiTui({
      title: 'Maka', driver, cwd: '/repo', model: 'claude-sonnet-4-5',
      connectionSlug: 'claude-subscription', permissionMode: 'ask', terminal,
      subscribeShellRunUpdates: (next) => {
        listener = next;
        return () => { listener = undefined; };
      },
      listShellRunUpdates: () => {
        hydrationAttempts += 1;
        if (hydrationAttempts === 1) return Promise.reject(new Error('transient hydration failure'));
        return new Promise((resolve) => { resolveHydration = resolve; });
      },
    });

    terminal.input('/rewind');
    terminal.input('\r');
    await waitFor(() => plainTerminalOutput(terminal.output()).includes('回到选定轮次'));
    terminal.input('\r');

    await waitFor(() => hydrationAttempts === 1);
    assert.ok(listener);
    listener({
      sessionId: 'session-1',
      ownership: { kind: 'local' },
      sourceTurnId: 'turn-1',
      sourceToolCallId: 'tool-bg',
      result: {
        kind: 'shell_run', ref, mode: 'pipes', status: 'running', cwd: '/repo', cmd: 'build',
        startedAt: 1_000, updatedAt: 4_000, revision: 4_000,
        output: pipeOutput('still running\nbuffered owner revision\n'),
      },
    });
    await waitFor(() => resolveHydration !== undefined);
    assert.ok(resolveHydration);
    resolveHydration([{
      sessionId: 'session-branch',
      ownership: {
        kind: 'source_owned',
        sourceSessionId: 'session-1',
        ownerSessionId: 'session-1',
      },
      sourceTurnId: 'turn-1',
      sourceToolCallId: 'tool-bg',
      result: {
        kind: 'shell_run', ref, mode: 'pipes', status: 'running', cwd: '/repo', cmd: 'build',
        startedAt: 1_000, updatedAt: 3_000, revision: 3_000,
        output: pipeOutput('still running\n'),
      },
    }]);

    await waitFor(() => plainTerminalOutput(terminal.screenOutput()).includes('detached'));
    await waitFor(() => plainTerminalOutput(terminal.screenOutput()).includes('buffered owner revision'));
    assert.equal(plainTerminalOutput(terminal.screenOutput()).includes('Ask Maka to stop this task'), false);

    assert.ok(listener);
    listener({
      sessionId: 'session-1',
      ownership: { kind: 'local' },
      sourceTurnId: 'turn-1',
      sourceToolCallId: 'tool-bg',
      result: {
        kind: 'shell_run', ref, mode: 'pipes', status: 'completed', cwd: '/repo', cmd: 'build',
        startedAt: 1_000, updatedAt: 5_000, completedAt: 5_000, exitCode: 0,
        revision: 5_000,
        output: pipeOutput('still running\nbuffered owner revision\ndone\n'),
      },
    });
    await waitFor(() => plainTerminalOutput(terminal.screenOutput()).includes('done'));
    assert.equal(plainTerminalOutput(terminal.screenOutput()).includes('detached'), false);

    exitMaka(terminal);
    await run;
  });

  test('rehydrates after buffer overflow instead of losing an evicted terminal update', async () => {
    const terminal = new FakeTerminal();
    const ref = 'maka://runtime/background-tasks/bg-overflow';
    const branchMessages = [
      {
        type: 'tool_call', id: 'tool-bg', turnId: 'turn-1', ts: 1,
        toolName: 'Bash', args: { command: 'build' },
      },
      {
        type: 'tool_result', id: 'result-bg', turnId: 'turn-1', ts: 2,
        toolUseId: 'tool-bg', isError: false,
        content: {
          kind: 'shell_run', ref, mode: 'pipes', status: 'running', cwd: '/repo', cmd: 'build',
          startedAt: 1_000, updatedAt: 2_000, revision: 2_000,
          output: pipeOutput('still running\n'),
        },
      },
    ] satisfies StoredMessage[];
    const driver = new RewindDriver(
      [{ turnId: 'turn-2', label: 'second question' }],
      branchMessages,
      { ...fakeSessionSummary('session-branch'), parentSessionId: 'session-1' },
    );
    let listener: ((update: ShellRunUpdate) => void) | undefined;
    const hydrationResolvers: Array<(updates: ShellRunUpdate[]) => void> = [];
    let hydrationAttempts = 0;
    const run = runMakaPiTui({
      title: 'Maka', driver, cwd: '/repo', model: 'claude-sonnet-4-5',
      connectionSlug: 'claude-subscription', permissionMode: 'ask', terminal,
      subscribeShellRunUpdates: (next) => {
        listener = next;
        return () => { listener = undefined; };
      },
      listShellRunUpdates: () => {
        hydrationAttempts += 1;
        return new Promise((resolve) => { hydrationResolvers.push(resolve); });
      },
    });

    terminal.input('/rewind');
    terminal.input('\r');
    await waitFor(() => plainTerminalOutput(terminal.output()).includes('回到选定轮次'));
    terminal.input('\r');
    await waitFor(() => hydrationAttempts === 1);
    assert.ok(listener);
    listener({
      sessionId: 'session-1',
      ownership: { kind: 'local' },
      sourceTurnId: 'turn-1',
      sourceToolCallId: 'tool-bg',
      result: {
        kind: 'shell_run', ref, mode: 'pipes', status: 'completed', cwd: '/repo', cmd: 'build',
        startedAt: 1_000, updatedAt: 5_000, completedAt: 5_000, exitCode: 0,
        revision: 5_000,
        output: pipeOutput('done but evicted\n'),
      },
    });
    for (let index = 0; index < SHELL_RUN_UPDATE_BUFFER_MAX_ENTRIES; index += 1) {
      listener({
        sessionId: `unrelated-owner-${index}`,
        ownership: { kind: 'local' },
        sourceTurnId: 'turn-unrelated',
        sourceToolCallId: `tool-unrelated-${index}`,
        result: {
          kind: 'shell_run',
          ref: `maka://runtime/background-tasks/unrelated-${index}`,
          mode: 'pipes', status: 'running', cwd: '/repo', cmd: 'sleep 1',
          startedAt: 1_000, updatedAt: 3_000, revision: 3_000,
          output: pipeOutput(''),
        },
      });
    }

    const firstHydration = hydrationResolvers.shift();
    assert.ok(firstHydration);
    firstHydration([{
      sessionId: 'session-branch',
      ownership: {
        kind: 'source_owned',
        sourceSessionId: 'session-1',
        ownerSessionId: 'session-1',
      },
      sourceTurnId: 'turn-1',
      sourceToolCallId: 'tool-bg',
      result: {
        kind: 'shell_run', ref, mode: 'pipes', status: 'running', cwd: '/repo', cmd: 'build',
        startedAt: 1_000, updatedAt: 3_000, revision: 3_000,
        output: pipeOutput('stale snapshot\n'),
      },
    }]);
    await waitFor(() => hydrationAttempts === 2);

    const authoritativeHydration = hydrationResolvers.shift();
    assert.ok(authoritativeHydration);
    authoritativeHydration([{
      sessionId: 'session-branch',
      ownership: {
        kind: 'source_owned',
        sourceSessionId: 'session-1',
        ownerSessionId: 'session-1',
      },
      sourceTurnId: 'turn-1',
      sourceToolCallId: 'tool-bg',
      result: {
        kind: 'shell_run', ref, mode: 'pipes', status: 'completed', cwd: '/repo', cmd: 'build',
        startedAt: 1_000, updatedAt: 5_000, completedAt: 5_000, exitCode: 0,
        revision: 5_000,
        output: pipeOutput('authoritative terminal state\n'),
      },
    }]);

    await waitFor(() => plainTerminalOutput(terminal.screenOutput()).includes('authoritative terminal state'));
    assert.equal(plainTerminalOutput(terminal.screenOutput()).includes('detached'), false);
    assert.equal(hydrationAttempts, 2);

    exitMaka(terminal);
    await run;
  });

  test('reports when /rewind has no earlier turns', async () => {
    const terminal = new FakeTerminal();
    const driver = new RewindDriver([]);
    const run = runMakaPiTui({
      title: 'Maka',
      driver,
      cwd: '/repo',
      model: 'claude-sonnet-4-5',
      connectionSlug: 'claude-subscription',
      permissionMode: 'ask',
      terminal,
    });

    terminal.input('/rewind');
    terminal.input('\r');

    await waitFor(() => plainTerminalOutput(terminal.output()).includes('没有可回退的轮次'));
    assert.equal(plainTerminalOutput(terminal.output()).includes('回到选定轮次'), false);
    assert.deepEqual(driver.rewound, []);

    exitMaka(terminal);
    await Promise.race([
      run,
      delay(50).then(() => {
        throw new Error('TUI did not close during test cleanup');
      }),
    ]);
  });

  test('idle double Escape opens the rewind picker; a single Escape does not', async () => {
    const terminal = new FakeTerminal();
    const driver = new RewindDriver([{ turnId: 'turn-1', label: 'first question' }]);
    const run = runMakaPiTui({
      title: 'Maka',
      driver,
      cwd: '/repo',
      model: 'claude-sonnet-4-5',
      connectionSlug: 'claude-subscription',
      permissionMode: 'ask',
      terminal,
    });

    await waitFor(() => plainTerminalOutput(terminal.output()).includes('Maka · ask · claude-sonnet-4-5 · claude-subscription · /repo'));

    // A single Escape falls through to the editor: no picker yet.
    terminal.input('\x1b');
    await delay(40);
    assert.equal(plainTerminalOutput(terminal.output()).includes('回到选定轮次'), false);

    // A second Escape within the window completes the gesture and opens the picker.
    terminal.input('\x1b');
    await waitFor(() => plainTerminalOutput(terminal.output()).includes('回到选定轮次'));

    // Cancel the picker so Ctrl-C reaches the runner rather than the overlay.
    terminal.input('\x1b');
    await waitFor(() => !plainTerminalOutput(terminal.screenOutput()).includes('回到选定轮次'));

    exitMaka(terminal);
    await Promise.race([
      run,
      delay(50).then(() => {
        throw new Error('TUI did not close during test cleanup');
      }),
    ]);
  });

  test('does not open the rewind picker while the editor has a draft', async () => {
    const terminal = new FakeTerminal();
    const driver = new RewindDriver([{ turnId: 'turn-1', label: 'first question' }]);
    const run = runMakaPiTui({
      title: 'Maka',
      driver,
      cwd: '/repo',
      model: 'claude-sonnet-4-5',
      connectionSlug: 'claude-subscription',
      permissionMode: 'ask',
      terminal,
    });

    await waitFor(() => plainTerminalOutput(terminal.output()).includes('Maka · ask · claude-sonnet-4-5 · claude-subscription · /repo'));

    // While a draft is present, Escape belongs to the editor (clear input), not
    // the rewind gesture. Two Escapes must not open the picker.
    terminal.input('draft in progress');
    await delay(20);
    terminal.input('\x1b');
    await delay(20);
    terminal.input('\x1b');
    await delay(40);
    assert.equal(plainTerminalOutput(terminal.screenOutput()).includes('回到选定轮次'), false);
    assert.deepEqual(driver.rewound, []);

    exitMaka(terminal);
    await Promise.race([
      run,
      delay(50).then(() => {
        throw new Error('TUI did not close during test cleanup');
      }),
    ]);
  });

  test('a non-Escape key between two Escapes does not open the rewind picker', async () => {
    const terminal = new FakeTerminal();
    const driver = new RewindDriver([{ turnId: 'turn-1', label: 'first question' }]);
    const run = runMakaPiTui({
      title: 'Maka',
      driver,
      cwd: '/repo',
      model: 'claude-sonnet-4-5',
      connectionSlug: 'claude-subscription',
      permissionMode: 'ask',
      terminal,
    });

    await waitFor(() => plainTerminalOutput(terminal.output()).includes('Maka · ask · claude-sonnet-4-5 · claude-subscription · /repo'));

    // The editor stays neutral (empty) throughout, but a left-arrow between the
    // two Escapes breaks the gesture: the two Escapes must be consecutive.
    terminal.input('\x1b');
    await delay(20);
    terminal.input('\x1b[D');
    await delay(20);
    terminal.input('\x1b');
    await delay(40);
    assert.equal(plainTerminalOutput(terminal.screenOutput()).includes('回到选定轮次'), false);

    exitMaka(terminal);
    await Promise.race([
      run,
      delay(50).then(() => {
        throw new Error('TUI did not close during test cleanup');
      }),
    ]);
  });

  test('interrupts at most once while the stop is still settling', async () => {
    const terminal = new FakeTerminal();
    const driver = new SlowStopDriver();
    const run = runMakaPiTui({
      title: 'Maka',
      driver,
      cwd: '/repo',
      model: 'claude-sonnet-4-5',
      connectionSlug: 'claude-subscription',
      permissionMode: 'ask',
      terminal,
    });

    terminal.input('run');
    terminal.input('\r');
    await waitFor(() => terminal.progressStates.at(-1) === true);

    terminal.input('\x1b');
    terminal.input('\x1b');
    await waitFor(() => driver.stopCalls === 1);

    // The turn has not ended yet (runtime stop is still settling). Further
    // double-Escapes must be swallowed, not fire a second stopSession that
    // would append a duplicate abort note to the session log.
    terminal.input('\x1b');
    terminal.input('\x1b');
    await delay(30);
    assert.equal(driver.stopCalls, 1);

    driver.endTurn();
    await waitFor(() => terminal.progressStates.at(-1) === false);

    exitMaka(terminal);
    await Promise.race([
      run,
      delay(50).then(() => {
        throw new Error('TUI did not close during test cleanup');
      }),
    ]);
  });

  test('stops the running turn on Ctrl-C without closing Maka', async () => {
    const terminal = new FakeTerminal();
    const driver = new InterruptibleTurnDriver();
    const run = runMakaPiTui({
      title: 'Maka',
      driver,
      cwd: '/repo',
      model: 'claude-sonnet-4-5',
      connectionSlug: 'claude-subscription',
      permissionMode: 'ask',
      terminal,
    });

    terminal.input('run');
    terminal.input('\r');
    await waitFor(() => terminal.progressStates.at(-1) === true);

    terminal.input('\x03');
    await waitFor(() => driver.stopCalls === 1);
    await waitFor(() => terminal.progressStates.at(-1) === false);

    assert.equal(terminal.stopCalls, 0);
    terminal.input('/exit');
    terminal.input('\r');
    await run;
  });

  test('exits on a second Ctrl-C while a turn interrupt is still in flight', async () => {
    const terminal = new FakeTerminal();
    const driver = new SlowStopDriver();
    const run = runMakaPiTui({
      title: 'Maka',
      driver,
      cwd: '/repo',
      model: 'claude-sonnet-4-5',
      connectionSlug: 'claude-subscription',
      permissionMode: 'ask',
      terminal,
    });

    terminal.input('run');
    terminal.input('\r');
    await waitFor(() => terminal.progressStates.at(-1) === true);

    terminal.input('\x03');
    await waitFor(() => driver.stopCalls === 1);
    assert.equal(terminal.stopCalls, 0);

    terminal.input('\x03');
    try {
      await Promise.race([
        run,
        delay(50).then(() => {
          throw new Error('TUI did not close after a second Ctrl-C');
        }),
      ]);
      assert.equal(driver.stopCalls, 1);
      assert.equal(terminal.stopCalls, 1);
    } finally {
      driver.endTurn();
      if (terminal.stopCalls === 0) exitMaka(terminal);
      await run;
    }
  });

  test('keeps Escape as permission deny while a permission prompt is pending', async () => {
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

    terminal.input('run');
    terminal.input('\r');
    await waitFor(() => driver.permissionRequests === 1);
    await delay(20);

    terminal.input('\x1b');
    terminal.input('\x1b');
    await waitFor(() => driver.permissionResponses.length >= 1);

    // Both Escapes route to the permission prompt, never to turn interruption.
    assert.equal(driver.permissionResponses[0]?.decision, 'deny');
    assert.equal(driver.stopCalls, 0);

    exitMaka(terminal);
    await Promise.race([
      run,
      delay(50).then(() => {
        throw new Error('TUI did not close during test cleanup');
      }),
    ]);
  });

  test('clears the permission prompt when the turn errors', async () => {
    const terminal = new FakeTerminal();
    const driver = new PermissionThenErrorDriver();
    const run = runMakaPiTui({
      title: 'Maka',
      driver,
      cwd: '/repo',
      model: 'claude-sonnet-4-5',
      connectionSlug: 'claude-subscription',
      permissionMode: 'ask',
      terminal,
    });

    terminal.input('run');
    terminal.input('\r');
    await waitFor(() => terminal.output().includes('Permission required'));
    driver.continueToError();
    await waitFor(() => terminal.output().includes('turn failed'));

    // The turn errored: the permission prompt must be gone from the screen.
    assert.equal(plainTerminalOutput(terminal.screenOutput()).includes('Permission required'), false);

    // y must not trigger a response for the now-dead request.
    terminal.input('y');
    await delay(20);
    assert.equal(driver.respondCalls, 0);

    exitMaka(terminal);
    await Promise.race([
      run,
      delay(50).then(() => {
        throw new Error('TUI did not close during test cleanup');
      }),
    ]);
  });

  test('enables focus reporting only after raw mode, so no stray ^[[I leaks on launch', async () => {
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

    await waitFor(() => terminal.writes.includes('\x1b[?1004h'));
    assert.ok(terminal.titles.includes('Maka'));

    // Enabling focus reporting before raw mode makes the terminal's focus-in
    // reply (`\x1b[I`) echo onto the screen as `^[[I`. The enable must be written
    // strictly after start() (raw mode on), never before.
    assert.notEqual(terminal.startWriteIndex, null);
    const focusEnableIndex = terminal.writes.indexOf('\x1b[?1004h');
    assert.ok(
      focusEnableIndex >= terminal.startWriteIndex!,
      'focus reporting was enabled before raw mode; a stray ^[[I can leak on launch',
    );

    exitMaka(terminal);
    await Promise.race([
      run,
      delay(50).then(() => {
        throw new Error('TUI did not close during test cleanup');
      }),
    ]);
  });

  test('rings the bell and marks the title when a long turn ends unfocused', async () => {
    const terminal = new FakeTerminal();
    const driver = new SlashCommandDriver();
    const run = runMakaPiTui({
      title: 'Maka',
      driver,
      cwd: '/repo',
      model: 'claude-sonnet-4-5',
      connectionSlug: 'claude-subscription',
      permissionMode: 'ask',
      // Zero threshold: every completed turn counts as long, so the test drives
      // the ring path without waiting real seconds.
      attentionLongTurnThresholdMs: 0,
      terminal,
    });

    // Report the terminal as backgrounded, then run a turn to completion.
    terminal.input('\x1b[O');
    terminal.input('go');
    terminal.input('\r');

    await waitFor(() => driver.prompts.length === 1);
    await waitFor(() => bellCount(terminal) === 1);
    assert.ok(
      terminal.titles.includes(`${BUSY_SPINNER_FRAMES[0]} Maka`),
      'title marks busy during the turn',
    );
    assert.ok(terminal.titles.includes('★ Maka'), 'title marks attention after the unfocused finish');

    exitMaka(terminal);
    await Promise.race([
      run,
      delay(50).then(() => {
        throw new Error('TUI did not close during test cleanup');
      }),
    ]);
  });

  test('does not ring when a short turn ends unfocused', async () => {
    const terminal = new FakeTerminal();
    const driver = new SlashCommandDriver();
    const run = runMakaPiTui({
      title: 'Maka',
      driver,
      cwd: '/repo',
      model: 'claude-sonnet-4-5',
      connectionSlug: 'claude-subscription',
      permissionMode: 'ask',
      // Default (large) threshold: the immediate-complete turn is far too short.
      terminal,
    });

    terminal.input('\x1b[O');
    terminal.input('go');
    terminal.input('\r');

    await waitFor(() => driver.prompts.length === 1);
    await delay(30);
    assert.equal(bellCount(terminal), 0);

    exitMaka(terminal);
    await Promise.race([
      run,
      delay(50).then(() => {
        throw new Error('TUI did not close during test cleanup');
      }),
    ]);
  });

  test('does not ring when a long turn ends while still focused', async () => {
    const terminal = new FakeTerminal();
    const driver = new SlashCommandDriver();
    const run = runMakaPiTui({
      title: 'Maka',
      driver,
      cwd: '/repo',
      model: 'claude-sonnet-4-5',
      connectionSlug: 'claude-subscription',
      permissionMode: 'ask',
      attentionLongTurnThresholdMs: 0,
      terminal,
    });

    // No blur report: the terminal is assumed focused, so a finished turn is
    // silent — the user is watching it.
    terminal.input('go');
    terminal.input('\r');

    await waitFor(() => driver.prompts.length === 1);
    await delay(30);
    assert.equal(bellCount(terminal), 0);
    assert.equal(terminal.titles.includes('★ Maka'), false);

    exitMaka(terminal);
    await Promise.race([
      run,
      delay(50).then(() => {
        throw new Error('TUI did not close during test cleanup');
      }),
    ]);
  });

  test('rings when a permission prompt appears unfocused', async () => {
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

    terminal.input('\x1b[O');
    terminal.input('run');
    terminal.input('\r');

    await waitFor(() => driver.permissionRequests === 1);
    await waitFor(() => bellCount(terminal) >= 1);
    assert.ok(terminal.titles.includes('★ Maka'));

    // Answer so the parked turn can finish and the TUI closes cleanly.
    terminal.input('y');
    await waitFor(() => driver.permissionResponses.length === 1);

    exitMaka(terminal);
    await Promise.race([
      run,
      delay(50).then(() => {
        throw new Error('TUI did not close during test cleanup');
      }),
    ]);
  });

  test('rings when a short turn fails unfocused', async () => {
    const terminal = new FakeTerminal();
    const driver = new QuickErrorDriver();
    const run = runMakaPiTui({
      title: 'Maka',
      driver,
      cwd: '/repo',
      model: 'claude-sonnet-4-5',
      connectionSlug: 'claude-subscription',
      permissionMode: 'ask',
      // Default (large) threshold: the ring must come from the error path, not
      // from turn duration — the turn fails immediately.
      terminal,
    });

    terminal.input('\x1b[O');
    terminal.input('go');
    terminal.input('\r');

    await waitFor(() => plainTerminalOutput(terminal.output()).includes('turn failed'));
    await waitFor(() => bellCount(terminal) === 1);
    assert.ok(terminal.titles.includes('★ Maka'));

    exitMaka(terminal);
    await Promise.race([
      run,
      delay(50).then(() => {
        throw new Error('TUI did not close during test cleanup');
      }),
    ]);
  });

  test('clears the busy title marker when Ctrl-C stops a turn', async () => {
    const terminal = new FakeTerminal();
    const driver = new InterruptibleTurnDriver();
    const run = runMakaPiTui({
      title: 'Maka',
      driver,
      cwd: '/repo',
      model: 'claude-sonnet-4-5',
      connectionSlug: 'claude-subscription',
      permissionMode: 'ask',
      terminal,
    });

    terminal.input('run');
    terminal.input('\r');
    await waitFor(() => terminal.titles.includes(`${BUSY_SPINNER_FRAMES[0]} Maka`));

    terminal.input('\x03');
    await waitFor(() => driver.stopCalls === 1);
    await waitFor(() => terminal.titles.at(-1) === 'Maka');
    assert.equal(terminal.stopCalls, 0);

    exitMaka(terminal);
    await run;
    assert.equal(terminal.titles.at(-1), 'Maka');
  });

});

/** Count the standalone BEL bytes the attention layer wrote. */
function bellCount(terminal: FakeTerminal): number {
  return terminal.writes.filter((write) => write === '\x07').length;
}

function exitMaka(_terminal: FakeTerminal): void {
  const previousExitCode = process.exitCode;
  process.emit('SIGTERM');
  process.exitCode = previousExitCode;
}

class ThrowingFocusReportTerminal extends FakeTerminal {
  override write(data: string): void {
    if (data === '\x1b[?1004h') throw new Error('focus reporting failed');
    super.write(data);
  }
}

class RejectingStopDriver implements MakaSessionDriver {
  stopCalls = 0;

  async listSessions(): Promise<SessionSummary[]> {
    return [];
  }

  async *sendPrompt(_prompt: string): AsyncIterable<never> {}
  async *compactSession(): AsyncIterable<never> {}

  async stop(): Promise<void> {
    this.stopCalls += 1;
    throw new Error('stop failed');
  }

  async respondToPermission(_response: PermissionResponse): Promise<void> {}
  async renameSession(): Promise<void> {}
  async setModel(): Promise<void> {}
  async setPermissionMode(): Promise<void> {}
  async setThinkingLevel(): Promise<void> {}
  async switchSession(sessionId: string): Promise<MakaSessionSwitchResult> {
    return switchResult(fakeSessionSummary(sessionId));
  }

  async listRewindTargets(): Promise<RewindTarget[]> {
    return [];
  }
  async rewindToTurn(): Promise<MakaSessionRewindResult> {
    throw new Error('rewind not supported in this fake');
  }
  startNewSession(): void {}
  getSessionId(): string {
    return 'session-1';
  }
}

interface PermissionPromptRequest {
  toolName: string;
  args: unknown;
  rememberForTurnAllowed: boolean;
}

class PermissionPromptDriver implements MakaSessionDriver {
  readonly permissionResponses: PermissionResponse[] = [];
  permissionRequests = 0;
  stopCalls = 0;
  private permissionResponseWaiter: (() => void) | null = null;
  private readonly requests: readonly PermissionPromptRequest[];

  constructor(
    requests: readonly (string | PermissionPromptRequest)[] = ['npm test'],
    private readonly beforePermissionAck: (index: number) => Promise<void> = async () => {},
    private readonly additionalPermissions = false,
  ) {
    this.requests = requests.map((request) => typeof request === 'string'
      ? {
          toolName: 'Bash',
          args: { command: request },
          rememberForTurnAllowed: true,
        }
      : request);
  }

  async listSessions(): Promise<SessionSummary[]> {
    return [];
  }

  async *compactSession(): AsyncIterable<never> {}

  async *sendPrompt(_prompt: string): AsyncIterable<SessionEvent> {
    for (const [index, request] of this.requests.entries()) {
      this.permissionRequests += 1;
      yield this.additionalPermissions ? {
        type: 'permission_request',
        kind: 'additional_permissions',
        id: `event-permission-${index + 1}`,
        turnId: 'turn-1',
        ts: index + 1,
        requestId: `permission-${index + 1}`,
        toolUseId: `tool-${index + 1}`,
        toolName: 'Write',
        category: 'file_write',
        reason: 'additional_permissions',
        args: undefined,
        cwd: '/repo',
        justification: 'Write requires access to the requested path.',
        intentHash: `sha256:${'1'.repeat(64)}`,
        permissionsHash: `sha256:${'2'.repeat(64)}`,
        additionalPermissions: {
          fileSystem: { entries: [{ path: '/outside/file.txt', access: 'write', scope: 'exact' }] },
        },
        risk: { outsideWorkspace: true, protectedMetadata: false, networkEnabled: false },
        alsoApprovesToolExecution: true,
        availableDecisions: ['allow_once', 'deny'],
        rememberForTurnAllowed: false,
      } : {
        type: 'permission_request',
        kind: 'tool_permission',
        id: `event-permission-${index + 1}`,
        turnId: 'turn-1',
        ts: index + 1,
        requestId: `permission-${index + 1}`,
        toolUseId: `tool-${index + 1}`,
        toolName: request.toolName,
        category: 'shell_unsafe',
        reason: 'shell_dangerous',
        args: request.args,
        rememberForTurnAllowed: request.rememberForTurnAllowed,
      };
    }
    for (const index of this.requests.keys()) {
      while (this.permissionResponses.length <= index) {
        await new Promise<void>((resolve) => {
          this.permissionResponseWaiter = resolve;
        });
      }
      const response = this.permissionResponses[index]!;
      await this.beforePermissionAck(index);
      yield {
        type: 'permission_decision_ack',
        id: `event-decision-${index + 1}`,
        turnId: 'turn-1',
        ts: this.requests.length + index + 1,
        requestId: response.requestId,
        toolUseId: `tool-${index + 1}`,
        decision: response.decision,
        ...(response.rememberForTurn !== undefined
          ? { rememberForTurn: response.rememberForTurn }
          : {}),
      };
    }
    yield {
      type: 'complete',
      id: 'event-complete',
      turnId: 'turn-1',
      ts: this.requests.length * 2 + 1,
      stopReason: 'end_turn',
    };
  }

  async stop(): Promise<void> {
    this.stopCalls += 1;
  }

  async respondToPermission(response: PermissionResponse): Promise<void> {
    this.permissionResponses.push(response);
    const waiter = this.permissionResponseWaiter;
    this.permissionResponseWaiter = null;
    waiter?.();
  }
  async renameSession(): Promise<void> {}
  async setModel(): Promise<void> {}
  async setPermissionMode(): Promise<void> {}
  async setThinkingLevel(): Promise<void> {}
  async switchSession(sessionId: string): Promise<MakaSessionSwitchResult> {
    return switchResult(fakeSessionSummary(sessionId));
  }

  async listRewindTargets(): Promise<RewindTarget[]> {
    return [];
  }
  async rewindToTurn(): Promise<MakaSessionRewindResult> {
    throw new Error('rewind not supported in this fake');
  }
  startNewSession(): void {}
  getSessionId(): string {
    return 'session-1';
  }
}

class UserQuestionPromptDriver implements MakaSessionDriver {
  readonly responses: UserQuestionResponse[] = [];
  stopCalls = 0;
  private release: (() => void) | undefined;

  async listSessions(): Promise<SessionSummary[]> { return []; }
  async *compactSession(): AsyncIterable<never> {}
  async *sendPrompt(_prompt: string): AsyncIterable<SessionEvent> {
    yield {
      type: 'user_question_request', id: 'event-question', turnId: 'turn-1', ts: 1,
      requestId: 'question-1', toolUseId: 'tool-1',
      questions: [
        { question: 'Choose an approach', options: [{ label: 'Extend', description: 'Reuse the seam' }, { label: 'Separate' }] },
        { question: 'Keep the default', options: [{ label: 'Yes' }, { label: 'No' }] },
        { question: 'Anything else', options: [{ label: 'Nothing' }, { label: 'More detail' }] },
      ],
    };
    await new Promise<void>((resolve) => { this.release = resolve; });
    yield { type: 'complete', id: 'complete-1', turnId: 'turn-1', ts: 2, stopReason: 'end_turn' };
  }
  async respondToUserQuestion(response: UserQuestionResponse): Promise<void> {
    this.responses.push(response);
    this.release?.();
  }
  async stop(): Promise<void> { this.stopCalls += 1; this.release?.(); }
  async respondToPermission(_response: PermissionResponse): Promise<void> {}
  async renameSession(): Promise<void> {}
  async setModel(): Promise<void> {}
  async setPermissionMode(): Promise<void> {}
  async setThinkingLevel(): Promise<void> {}
  async switchSession(sessionId: string): Promise<MakaSessionSwitchResult> { return switchResult(fakeSessionSummary(sessionId)); }
  async listRewindTargets(): Promise<RewindTarget[]> { return []; }
  async rewindToTurn(): Promise<MakaSessionRewindResult> { throw new Error('rewind not supported'); }
  startNewSession(): void {}
  getSessionId(): string { return 'session-1'; }
}

class InterruptibleTurnDriver implements MakaSessionDriver {
  stopCalls = 0;
  private releaseTurn: (() => void) | null = null;

  async listSessions(): Promise<SessionSummary[]> {
    return [];
  }

  async *compactSession(): AsyncIterable<never> {}

  async *sendPrompt(_prompt: string): AsyncIterable<SessionEvent> {
    // The turn parks like a real long-running provider call until stop() aborts it.
    await new Promise<void>((resolve) => {
      this.releaseTurn = resolve;
    });
    yield {
      type: 'abort',
      id: 'event-abort',
      turnId: 'turn-1',
      ts: 1,
      reason: 'user_stop',
    };
  }

  async stop(): Promise<void> {
    this.stopCalls += 1;
    this.releaseTurn?.();
    this.releaseTurn = null;
  }

  async respondToPermission(_response: PermissionResponse): Promise<void> {}
  async renameSession(): Promise<void> {}
  async setModel(): Promise<void> {}
  async setPermissionMode(): Promise<void> {}
  async setThinkingLevel(): Promise<void> {}
  async switchSession(sessionId: string): Promise<MakaSessionSwitchResult> {
    return switchResult(fakeSessionSummary(sessionId));
  }

  async listRewindTargets(): Promise<RewindTarget[]> {
    return [];
  }
  async rewindToTurn(): Promise<MakaSessionRewindResult> {
    throw new Error('rewind not supported in this fake');
  }
  startNewSession(): void {}
  getSessionId(): string {
    return 'session-1';
  }
}

class SlowStopDriver implements MakaSessionDriver {
  stopCalls = 0;
  private releaseTurn: (() => void) | null = null;

  async listSessions(): Promise<SessionSummary[]> {
    return [];
  }

  async *compactSession(): AsyncIterable<never> {}

  async *sendPrompt(_prompt: string): AsyncIterable<SessionEvent> {
    await new Promise<void>((resolve) => {
      this.releaseTurn = resolve;
    });
    yield {
      type: 'abort',
      id: 'event-abort',
      turnId: 'turn-1',
      ts: 1,
      reason: 'user_stop',
    };
  }

  // stop() records the request but leaves the turn parked, mimicking a runtime
  // stopSession that has not finished aborting yet.
  async stop(): Promise<void> {
    this.stopCalls += 1;
  }

  endTurn(): void {
    this.releaseTurn?.();
    this.releaseTurn = null;
  }

  async respondToPermission(_response: PermissionResponse): Promise<void> {}
  async renameSession(): Promise<void> {}
  async setModel(): Promise<void> {}
  async setPermissionMode(): Promise<void> {}
  async setThinkingLevel(): Promise<void> {}
  async switchSession(sessionId: string): Promise<MakaSessionSwitchResult> {
    return switchResult(fakeSessionSummary(sessionId));
  }

  async listRewindTargets(): Promise<RewindTarget[]> {
    return [];
  }
  async rewindToTurn(): Promise<MakaSessionRewindResult> {
    throw new Error('rewind not supported in this fake');
  }
  startNewSession(): void {}
  getSessionId(): string {
    return 'session-1';
  }
}

class ThinkingOutputDriver implements MakaSessionDriver {
  async listSessions(): Promise<SessionSummary[]> {
    return [];
  }

  async *compactSession(): AsyncIterable<never> {}

  async *sendPrompt(_prompt: string): AsyncIterable<SessionEvent> {
    yield {
      type: 'thinking_delta',
      id: 'event-thinking',
      turnId: 'turn-1',
      ts: 1,
      messageId: 'message-1',
      text: 'secret reasoning tail',
    };
    yield {
      type: 'text_complete',
      id: 'event-text',
      turnId: 'turn-1',
      ts: 2,
      messageId: 'message-1',
      text: 'visible answer',
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
  async renameSession(): Promise<void> {}
  async setModel(): Promise<void> {}
  async setPermissionMode(): Promise<void> {}
  async setThinkingLevel(): Promise<void> {}
  async switchSession(sessionId: string): Promise<MakaSessionSwitchResult> {
    return switchResult(fakeSessionSummary(sessionId));
  }

  async listRewindTargets(): Promise<RewindTarget[]> {
    return [];
  }
  async rewindToTurn(): Promise<MakaSessionRewindResult> {
    throw new Error('rewind not supported in this fake');
  }
  startNewSession(): void {}
  getSessionId(): string {
    return 'session-1';
  }
}

class ToolOutputDriver implements MakaSessionDriver {
  async listSessions(): Promise<SessionSummary[]> {
    return [];
  }

  async *compactSession(): AsyncIterable<never> {}

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
        status: 'completed',
        exitCode: 0,
        // `expanded-tail` is the FIRST line, so the compact tail (last ~5 lines)
        // hides it; expanding reveals the full output including this head line.
        output: pipeOutput(`expanded-tail\n${Array.from({ length: 30 }, (_, i) => `row-${i}`).join('\n')}`),
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
  async renameSession(): Promise<void> {}
  async setModel(): Promise<void> {}
  async setPermissionMode(): Promise<void> {}
  async setThinkingLevel(): Promise<void> {}
  async switchSession(sessionId: string): Promise<MakaSessionSwitchResult> {
    return switchResult(fakeSessionSummary(sessionId));
  }
  async listRewindTargets(): Promise<RewindTarget[]> {
    return [];
  }
  async rewindToTurn(): Promise<MakaSessionRewindResult> {
    throw new Error('rewind not supported in this fake');
  }
  startNewSession(): void {}
  getSessionId(): string {
    return 'session-1';
  }
}

class BackgroundShellRunDriver extends ToolOutputDriver {
  override async *sendPrompt(_prompt: string): AsyncIterable<SessionEvent> {
    yield {
      type: 'tool_start', id: 'event-tool-start', turnId: 'turn-1', ts: 1,
      toolUseId: 'tool-bg', toolName: 'Bash', args: { command: 'build' },
    };
    yield {
      type: 'tool_result', id: 'event-tool-result', turnId: 'turn-1', ts: 2,
      toolUseId: 'tool-bg', isError: false,
      content: {
        kind: 'shell_run', ref: 'maka://runtime/background-tasks/bg-1',
        mode: 'pipes',
        status: 'running', cwd: '/repo', cmd: 'build',
        startedAt: 1_000, updatedAt: 2_000,
        revision: 2_000,
        output: pipeOutput(),
      },
    };
    yield { type: 'complete', id: 'event-complete', turnId: 'turn-1', ts: 3, stopReason: 'end_turn' };
  }
}

function pipeOutput(stdout = '', stderr = '') {
  return {
    mode: 'pipes' as const,
    stdout,
    stderr,
    stdoutTruncated: false,
    stderrTruncated: false,
    redacted: false,
  };
}

class SlashCommandDriver implements MakaSessionDriver {
  readonly prompts: string[] = [];
  readonly models: string[] = [];
  readonly modelConnections: Array<string | undefined> = [];
  readonly permissionModes: PermissionMode[] = [];
  readonly thinkingLevelUpdates: Array<ThinkingLevel | undefined> = [];
  readonly sessionIds: string[] = [];
  readonly renames: string[] = [];
  startNewSessionCalls = 0;
  protected sessionId = 'session-1';

  constructor(
    private readonly sessions: SessionSummary[] = [fakeSessionSummary('session-2', '/repo')],
    private readonly sessionMessages: ReadonlyMap<string, readonly StoredMessage[]> = new Map(),
  ) {}

  async listSessions(): Promise<SessionSummary[]> {
    return this.sessions;
  }

  async getSessionResumeAvailability(session: SessionSummary): Promise<SessionResumeAvailability> {
    return session.cwd
      ? { available: true }
      : { available: false, reason: 'Missing working directory' };
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

  async *compactSession(): AsyncIterable<SessionEvent> {
    yield {
      type: 'complete',
      id: 'event-compact-complete',
      turnId: 'turn-compact',
      ts: 1,
      stopReason: 'end_turn',
    };
  }

  async stop(): Promise<void> {}
  async respondToPermission(_response: PermissionResponse): Promise<void> {}
  async setModel(model: string, connectionSlug?: string): Promise<void> {
    this.models.push(model);
    this.modelConnections.push(connectionSlug);
  }
  async renameSession(name: string): Promise<void> {
    this.renames.push(name);
  }
  async setPermissionMode(mode: PermissionMode): Promise<void> {
    this.permissionModes.push(mode);
  }
  async setThinkingLevel(level: ThinkingLevel | undefined): Promise<void> {
    this.thinkingLevelUpdates.push(level);
  }
  async switchSession(sessionId: string): Promise<MakaSessionSwitchResult> {
    this.sessionIds.push(sessionId);
    this.sessionId = sessionId;
    const summary = this.sessions.find((session) => session.id === sessionId);
    const nextSummary = summary ?? fakeSessionSummary(sessionId);
    return switchResult(nextSummary, [...(this.sessionMessages.get(nextSummary.id) ?? [])]);
  }
  async listRewindTargets(): Promise<RewindTarget[]> {
    return [];
  }
  async rewindToTurn(_turnId: string): Promise<MakaSessionRewindResult> {
    throw new Error('rewind not supported in this fake');
  }
  startNewSession(): void {
    this.startNewSessionCalls += 1;
    this.sessionId = 'session-new';
  }
  getSessionId(): string {
    return this.sessionId;
  }
}

class HangingCloseDriver extends SlashCommandDriver {
  stopCalls = 0;
  private resolveStop: (() => void) | null = null;

  override async stop(): Promise<void> {
    this.stopCalls += 1;
    await new Promise<void>((resolve) => {
      this.resolveStop = resolve;
    });
  }

  releaseStop(): void {
    this.resolveStop?.();
    this.resolveStop = null;
  }
}

class LongTranscriptDriver extends SlashCommandDriver {
  override async *sendPrompt(prompt: string): AsyncIterable<SessionEvent> {
    this.prompts.push(prompt);
    yield {
      type: 'text_complete',
      id: 'event-text-complete',
      turnId: 'turn-1',
      ts: 1,
      messageId: 'message-1',
      text: Array.from({ length: 40 }, (_, index) => `filler line ${index + 1}`).join('\n'),
    };
    yield {
      type: 'complete',
      id: 'event-complete',
      turnId: 'turn-1',
      ts: 2,
      stopReason: 'end_turn',
    };
  }
}

class DeferredCompactDriver extends SlashCommandDriver {
  compactCalls = 0;
  private resolveCompact: (() => void) | null = null;

  override async *compactSession(): AsyncIterable<SessionEvent> {
    this.compactCalls += 1;
    await new Promise<void>((resolve) => {
      this.resolveCompact = resolve;
    });
    yield {
      type: 'token_usage',
      id: 'event-token-usage',
      turnId: 'turn-compact',
      ts: 1,
      input: 0,
      output: 0,
      contextBudget: {
        enabled: true,
        policyName: 'unit-budget',
        estimatedTokensBefore: 1000,
        estimatedTokensAfter: 400,
        keptTurns: 1,
        droppedTurns: 2,
        keptEvents: 2,
        droppedEvents: 4,
        compactionDecisions: [{
          stage: 'priorReplay',
          sourceKind: 'runtimeEvents',
          decision: 'replaced',
          boundaryKind: 'historyCompact',
          estimatedTokensSaved: 600,
        }],
      },
    };
    yield {
      type: 'complete',
      id: 'event-complete',
      turnId: 'turn-compact',
      ts: 2,
      stopReason: 'end_turn',
    };
  }

  releaseCompact(): void {
    this.resolveCompact?.();
    this.resolveCompact = null;
  }
}

class DeferredControlDriver implements MakaSessionDriver {
  readonly prompts: string[] = [];
  readonly models: string[] = [];
  private resolveSetModel: (() => void) | null = null;

  async listSessions(): Promise<SessionSummary[]> {
    return [];
  }

  async *compactSession(): AsyncIterable<never> {}

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
    await new Promise<void>((resolve) => {
      this.resolveSetModel = resolve;
    });
  }

  releaseSetModel(): void {
    this.resolveSetModel?.();
    this.resolveSetModel = null;
  }

  async renameSession(): Promise<void> {}
  async setPermissionMode(): Promise<void> {}
  async setThinkingLevel(): Promise<void> {}
  async switchSession(sessionId: string): Promise<MakaSessionSwitchResult> {
    return switchResult(fakeSessionSummary(sessionId));
  }

  async listRewindTargets(): Promise<RewindTarget[]> {
    return [];
  }
  async rewindToTurn(): Promise<MakaSessionRewindResult> {
    throw new Error('rewind not supported in this fake');
  }
  startNewSession(): void {}
  getSessionId(): string {
    return 'session-1';
  }
}

class RejectingPermissionDriver implements MakaSessionDriver {
  readonly responses: PermissionResponse[] = [];

  async listSessions(): Promise<SessionSummary[]> {
    return [];
  }

  async *compactSession(): AsyncIterable<never> {}

  async *sendPrompt(_prompt: string): AsyncIterable<SessionEvent> {
    yield {
      type: 'permission_request',
      kind: 'tool_permission',
      id: 'event-permission',
      turnId: 'turn-1',
      ts: 1,
      requestId: 'permission-1',
      toolUseId: 'tool-1',
      toolName: 'Bash',
      category: 'shell_unsafe',
      reason: 'shell_dangerous',
      args: { command: 'npm test' },
      rememberForTurnAllowed: true,
    };
    // The turn stays parked while the permission is unresolved.
    await new Promise<void>(() => {});
  }

  async stop(): Promise<void> {}

  async respondToPermission(response: PermissionResponse): Promise<void> {
    this.responses.push(response);
    throw new Error('permission response rejected');
  }

  async renameSession(): Promise<void> {}
  async setModel(): Promise<void> {}
  async setPermissionMode(): Promise<void> {}
  async setThinkingLevel(): Promise<void> {}
  async switchSession(sessionId: string): Promise<MakaSessionSwitchResult> {
    return switchResult(fakeSessionSummary(sessionId));
  }

  async listRewindTargets(): Promise<RewindTarget[]> {
    return [];
  }
  async rewindToTurn(): Promise<MakaSessionRewindResult> {
    throw new Error('rewind not supported in this fake');
  }
  startNewSession(): void {}
  getSessionId(): string {
    return 'session-1';
  }
}

class DeferredListSessionsDriver extends SlashCommandDriver {
  listCalls = 0;
  private resolveList: (() => void) | null = null;

  override async listSessions(): Promise<SessionSummary[]> {
    this.listCalls += 1;
    await new Promise<void>((resolve) => {
      this.resolveList = resolve;
    });
    return super.listSessions();
  }

  releaseList(): void {
    this.resolveList?.();
    this.resolveList = null;
  }
}

class PermissionThenErrorDriver implements MakaSessionDriver {
  respondCalls = 0;
  private resolveContinue: (() => void) | null = null;

  async listSessions(): Promise<SessionSummary[]> {
    return [];
  }

  async *compactSession(): AsyncIterable<never> {}

  async *sendPrompt(_prompt: string): AsyncIterable<SessionEvent> {
    yield {
      type: 'permission_request',
      kind: 'tool_permission',
      id: 'event-permission',
      turnId: 'turn-1',
      ts: 1,
      requestId: 'permission-1',
      toolUseId: 'tool-1',
      toolName: 'Bash',
      category: 'shell_unsafe',
      reason: 'shell_dangerous',
      args: { command: 'npm test' },
      rememberForTurnAllowed: true,
    };
    await new Promise<void>((resolve) => {
      this.resolveContinue = resolve;
    });
    yield {
      type: 'error',
      id: 'event-error',
      turnId: 'turn-1',
      ts: 2,
      message: 'turn failed',
      recoverable: false,
    };
  }

  continueToError(): void {
    this.resolveContinue?.();
    this.resolveContinue = null;
  }

  async stop(): Promise<void> {}

  async respondToPermission(_response: PermissionResponse): Promise<void> {
    this.respondCalls += 1;
  }

  async renameSession(): Promise<void> {}
  async setModel(): Promise<void> {}
  async setPermissionMode(): Promise<void> {}
  async setThinkingLevel(): Promise<void> {}
  async switchSession(sessionId: string): Promise<MakaSessionSwitchResult> {
    return switchResult(fakeSessionSummary(sessionId));
  }

  async listRewindTargets(): Promise<RewindTarget[]> {
    return [];
  }
  async rewindToTurn(): Promise<MakaSessionRewindResult> {
    throw new Error('rewind not supported in this fake');
  }
  startNewSession(): void {}
  getSessionId(): string {
    return 'session-1';
  }
}

class QuickErrorDriver implements MakaSessionDriver {
  readonly prompts: string[] = [];

  async listSessions(): Promise<SessionSummary[]> {
    return [];
  }

  async *compactSession(): AsyncIterable<never> {}

  async *sendPrompt(prompt: string): AsyncIterable<SessionEvent> {
    this.prompts.push(prompt);
    // The turn fails immediately, so its duration never crosses the long-turn
    // threshold — the attention ring must come from the error, not the timer.
    yield {
      type: 'error',
      id: 'event-error',
      turnId: 'turn-1',
      ts: 1,
      message: 'turn failed',
      recoverable: false,
    };
  }

  async stop(): Promise<void> {}
  async respondToPermission(_response: PermissionResponse): Promise<void> {}
  async renameSession(): Promise<void> {}
  async setModel(): Promise<void> {}
  async setPermissionMode(): Promise<void> {}
  async setThinkingLevel(): Promise<void> {}
  async switchSession(sessionId: string): Promise<MakaSessionSwitchResult> {
    return switchResult(fakeSessionSummary(sessionId));
  }

  async listRewindTargets(): Promise<RewindTarget[]> {
    return [];
  }
  async rewindToTurn(): Promise<MakaSessionRewindResult> {
    throw new Error('rewind not supported in this fake');
  }
  startNewSession(): void {}
  getSessionId(): string {
    return 'session-1';
  }
}

class RewindDriver extends SlashCommandDriver {
  readonly rewound: string[] = [];

  constructor(
    private readonly targets: RewindTarget[],
    private readonly branchMessages: readonly StoredMessage[] = [],
    private readonly branchSummary: SessionSummary = fakeSessionSummary('session-branch'),
  ) {
    super();
  }

  override async listRewindTargets(): Promise<RewindTarget[]> {
    return this.targets;
  }

  override async rewindToTurn(turnId: string): Promise<MakaSessionRewindResult> {
    this.rewound.push(turnId);
    this.sessionId = this.branchSummary.id;
    return {
      ...switchResult(this.branchSummary, [...this.branchMessages]),
      prompt: `refilled: ${turnId}`,
    };
  }
}

function switchResult(summary: SessionSummary, messages: StoredMessage[] = []): MakaSessionSwitchResult {
  return { summary, messages };
}

function fakeSessionSummary(sessionId: string, cwd = '/repo', name = 'Existing chat'): SessionSummary {
  return {
    id: sessionId,
    cwd,
    name,
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

function storedUserMessage(id: string, turnId: string, text: string): StoredMessage {
  return {
    type: 'user',
    id,
    turnId,
    ts: 1,
    text,
  };
}

function storedAssistantMessage(id: string, turnId: string, text: string): StoredMessage {
  return {
    type: 'assistant',
    id,
    turnId,
    ts: 2,
    text,
    modelId: 'claude-sonnet-4-5',
  };
}

async function runSignalExitProbe(signalToSend: NodeJS.Signals, hangOuterCleanup = false): Promise<{
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
}> {
  const runnerUrl = new URL('../pi-tui-runner.js', import.meta.url).href;
  const cliUrl = new URL('../cli.js', import.meta.url).href;
  const terminalUrl = new URL('./tui-terminal-mock.js', import.meta.url).href;
  const childSource = `
    import { runMakaPiTui } from ${JSON.stringify(runnerUrl)};
    import { beginMakaCliExit } from ${JSON.stringify(cliUrl)};
    import { FakeTerminal } from ${JSON.stringify(terminalUrl)};

    class ReportingTerminal extends FakeTerminal {
      stop() {
        process.stdout.write('TERMINAL_STOP\\n');
        super.stop();
      }
    }

    const terminal = new ReportingTerminal();
    const driver = {
      async *sendPrompt() {},
      async *compactSession() {},
      async stop() {},
      async listSessions() { return []; },
      async respondToPermission() {},
      async renameSession() {},
      async setModel() {},
      async setPermissionMode() {},
      async setThinkingLevel() {},
      async switchSession() { throw new Error('unused'); },
      async listRewindTargets() { return []; },
      async rewindToTurn() { throw new Error('unused'); },
      startNewSession() {},
      getSessionId() { return null; },
    };
    const hold = setInterval(() => {}, 1_000);
    const run = runMakaPiTui({
      title: 'Maka',
      driver,
      cwd: '/repo',
      model: 'test-model',
      connectionSlug: 'test-connection',
      permissionMode: 'ask',
      terminal,
      onProcessExit: (exitCode) => beginMakaCliExit(exitCode),
    });
    process.stdout.write('READY\\n');
    await run;
    process.stdout.write('CLOSED\\n');
    if (${hangOuterCleanup}) await new Promise(() => {});
    clearInterval(hold);
  `;
  const child = spawn(process.execPath, ['--input-type=module', '-e', childSource], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let signalSent = false;
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    stdout += chunk;
    if (!signalSent && stdout.includes('READY')) {
      signalSent = true;
      child.kill(signalToSend);
    }
  });

  const killTimer = setTimeout(() => child.kill('SIGKILL'), 5_000);
  const [code, signal] = await once(child, 'exit') as [number | null, NodeJS.Signals | null];
  clearTimeout(killTimer);
  return { code, signal, stdout };
}

async function runFatalExitProbe(kind: 'uncaughtException' | 'unhandledRejection', hangOuterCleanup = false): Promise<{
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}> {
  const runnerUrl = new URL('../pi-tui-runner.js', import.meta.url).href;
  const cliUrl = new URL('../cli.js', import.meta.url).href;
  const terminalUrl = new URL('./tui-terminal-mock.js', import.meta.url).href;
  const trigger = kind === 'uncaughtException'
    ? "setImmediate(() => { throw new Error('fatal probe'); });"
    : "void Promise.reject(new Error('fatal probe'));";
  const childSource = `
    import { runMakaPiTui } from ${JSON.stringify(runnerUrl)};
    import { beginMakaCliExit, formatMakaCliFatalError } from ${JSON.stringify(cliUrl)};
    import { FakeTerminal } from ${JSON.stringify(terminalUrl)};

    class ReportingTerminal extends FakeTerminal {
      stop() {
        process.stdout.write('TERMINAL_STOP\\n');
        super.stop();
      }
    }

    const terminal = new ReportingTerminal();
    const driver = {
      async *sendPrompt() {},
      async *compactSession() {},
      async stop() {},
      async listSessions() { return []; },
      async respondToPermission() {},
      async renameSession() {},
      async setModel() {},
      async setPermissionMode() {},
      async setThinkingLevel() {},
      async switchSession() { throw new Error('unused'); },
      async listRewindTargets() { return []; },
      async rewindToTurn() { throw new Error('unused'); },
      startNewSession() {},
      getSessionId() { return null; },
    };
    const hold = setInterval(() => {}, 1_000);
    let fatalError;
    try {
      const run = runMakaPiTui({
        title: 'Maka',
        driver,
        cwd: '/repo',
        model: 'test-model',
        connectionSlug: 'test-connection',
        permissionMode: 'ask',
        terminal,
        onProcessExit: (exitCode, error) => {
          if (error) process.stderr.write(\`${'${formatMakaCliFatalError(error)}'}\\n\`);
          beginMakaCliExit(exitCode);
        },
      });
      process.stdout.write('READY\\n');
      ${trigger}
      await run;
    } catch (error) {
      fatalError = error;
    }
    process.stdout.write('CLOSED\\n');
    if (${hangOuterCleanup}) await new Promise(() => {});
    if (fatalError) process.stderr.write(\`${'${formatMakaCliFatalError(fatalError)}'}\\n\`);
    clearInterval(hold);
  `;
  const nodeArgs = kind === 'unhandledRejection' ? ['--unhandled-rejections=warn'] : [];
  const child = spawn(process.execPath, [...nodeArgs, '--input-type=module', '-e', childSource], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  const killTimer = setTimeout(() => child.kill('SIGKILL'), 5_000);
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.on('data', (chunk: string) => {
    stderr += chunk;
  });

  const [code, signal] = await once(child, 'exit') as [number | null, NodeJS.Signals | null];
  clearTimeout(killTimer);
  return { code, signal, stdout, stderr };
}
