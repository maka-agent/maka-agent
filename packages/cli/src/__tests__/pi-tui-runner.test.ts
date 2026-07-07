import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { describe, test } from 'node:test';
import { visibleWidth } from '@earendil-works/pi-tui';
import type { PermissionMode, PermissionResponse, SessionEvent, SessionSummary, StoredMessage, ThinkingLevel } from '@maka/core';
import type { MakaSessionDriver, MakaSessionSwitchResult } from '../session-driver.js';
import { runMakaPiTui } from '../pi-tui-runner.js';
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
    // Expanding the 31-line result makes it overflow the viewport; its head line
    // `expanded-tail` scrolls off the top when following the tail, so page up to
    // bring it into view. This exercises the global expand and scrollback together.
    await waitFor(() => {
      terminal.input('\x1b[5~');
      return plainTerminalOutput(terminal.screenOutput()).includes('expanded-tail');
    });

    terminal.input('\x03');
    await Promise.race([
      run,
      delay(50).then(() => {
        throw new Error('TUI did not close after Ctrl-C');
      }),
    ]);
  });

  test('pages transcript scrollback and re-follows the tail', async () => {
    const terminal = new FakeTerminal();
    const driver = new LongReplyDriver();
    const run = runMakaPiTui({
      title: 'Maka',
      driver,
      cwd: '/repo',
      model: 'claude-sonnet-4-5',
      connectionSlug: 'claude-subscription',
      permissionMode: 'ask',
      terminal,
    });

    terminal.input('go');
    terminal.input('\r');

    // A 40-paragraph reply overflows the 24-row viewport, so the tail is pinned
    // to the bottom and a scroll indicator advertises the hidden lines above.
    await waitFor(() => {
      const screen = plainTerminalOutput(terminal.screenOutput());
      return screen.includes('para-39') && /↑ \d+ more/.test(screen);
    });
    assert.equal(plainTerminalOutput(terminal.screenOutput()).includes('para-00'), false);

    // Page up far enough to reach the head of the transcript.
    await waitFor(() => {
      terminal.input('\x1b[5~');
      return plainTerminalOutput(terminal.screenOutput()).includes('para-00');
    });

    // Page back down until the live tail follows again (no lines hidden below).
    await waitFor(() => {
      terminal.input('\x1b[6~');
      const screen = plainTerminalOutput(terminal.screenOutput());
      return screen.includes('para-39') && !/↓ \d+ more/.test(screen);
    });

    terminal.input('\x03');
    await Promise.race([
      run,
      delay(50).then(() => {
        throw new Error('TUI did not close after Ctrl-C');
      }),
    ]);
  });

  test('re-pins to the tail when the user submits after scrolling up', async () => {
    const terminal = new FakeTerminal();
    const driver = new MultiTurnLongDriver();
    const run = runMakaPiTui({
      title: 'Maka',
      driver,
      cwd: '/repo',
      model: 'claude-sonnet-4-5',
      connectionSlug: 'claude-subscription',
      permissionMode: 'ask',
      terminal,
    });

    terminal.input('go');
    terminal.input('\r');
    await waitFor(() => plainTerminalOutput(terminal.screenOutput()).includes('t1-para-39'));
    await waitFor(() => {
      terminal.input('\x1b[5~');
      return plainTerminalOutput(terminal.screenOutput()).includes('t1-para-00');
    });

    // Submitting a new prompt while scrolled up must snap back to the tail so the
    // new turn is visible, not preserve the old scrolled-up position.
    terminal.input('again');
    terminal.input('\r');
    await waitFor(() => plainTerminalOutput(terminal.screenOutput()).includes('t2-para-39'));

    terminal.input('\x03');
    await Promise.race([
      run,
      delay(50).then(() => {
        throw new Error('TUI did not close after Ctrl-C');
      }),
    ]);
  });

  test('snaps to the tail when a permission prompt appears while scrolled up', async () => {
    const terminal = new FakeTerminal();
    const driver = new PermissionAfterLongDriver();
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

    // The long reply overflows the viewport; scroll up so the tail (where the
    // permission prompt will land) is off-screen while the turn is still running.
    await waitFor(() => plainTerminalOutput(terminal.screenOutput()).includes('para-39'));
    await waitFor(() => {
      terminal.input('\x1b[5~');
      return plainTerminalOutput(terminal.screenOutput()).includes('para-00');
    });
    assert.equal(plainTerminalOutput(terminal.screenOutput()).includes('Permission required'), false);

    // The runtime now raises a permission request. It renders at the tail, below
    // the scrolled-up viewport — the session must snap to the tail so the y/n
    // prompt is visible instead of leaving the user staring at old output.
    driver.releaseBody();
    await waitFor(() => plainTerminalOutput(terminal.screenOutput()).includes('Permission required'));

    terminal.input('y');
    driver.releasePermission();
    terminal.input('\x03');
    await Promise.race([
      run,
      delay(50).then(() => {
        throw new Error('TUI did not close after Ctrl-C');
      }),
    ]);
  });

  test('holds the reader position when a late thinking completion grows a block above the fold', async () => {
    const terminal = new FakeTerminal();
    const driver = new LateThinkingDriver();
    const run = runMakaPiTui({
      title: 'Maka',
      driver,
      cwd: '/repo',
      model: 'claude-sonnet-4-5',
      connectionSlug: 'claude-subscription',
      permissionMode: 'ask',
      terminal,
    });

    const visibleParas = () =>
      (plainTerminalOutput(terminal.screenOutput()).match(/para-\d\d/g) ?? []).sort().join(',');

    terminal.input('run');
    terminal.input('\r');
    await waitFor(() => plainTerminalOutput(terminal.screenOutput()).includes('para-39'));

    // Expand thinking, then page up once so the (still short) thinking block sits
    // above the fold and the viewport shows a stable middle slice of the reply.
    terminal.input('\x14');
    await waitFor(() => {
      terminal.input('\x1b[5~');
      return !plainTerminalOutput(terminal.screenOutput()).includes('para-39');
    });
    const before = visibleParas();
    assert.ok(before.length > 0, 'expected reply paragraphs on screen while scrolled up');

    // A late thinking_complete replaces the short draft in place with a much
    // taller block above the fold. That growth must not be mistaken for a tail
    // append, or the window drifts and the reader loses their place.
    driver.releaseReply();
    await waitFor(() => driver.completed);
    assert.equal(visibleParas(), before, 'viewport drifted when a block above the fold grew');

    terminal.input('\x03');
    await Promise.race([
      run,
      delay(50).then(() => {
        throw new Error('TUI did not close after Ctrl-C');
      }),
    ]);
  });

  test('holds the reader position when streaming re-wraps the tail below the fold', async () => {
    const terminal = new FakeTerminal();
    const driver = new StreamingTailDriver();
    const run = runMakaPiTui({
      title: 'Maka',
      driver,
      cwd: '/repo',
      model: 'claude-sonnet-4-5',
      connectionSlug: 'claude-subscription',
      permissionMode: 'ask',
      terminal,
    });

    const visibleParas = () =>
      (plainTerminalOutput(terminal.screenOutput()).match(/s-para-\d\d/g) ?? []).sort().join(',');

    terminal.input('run');
    terminal.input('\r');
    await waitFor(() => plainTerminalOutput(terminal.screenOutput()).includes('typing-tail'));

    // Page up so the streaming tail (the partial last line about to grow) is off
    // the bottom of the viewport and a stable middle slice of the reply shows.
    await waitFor(() => {
      terminal.input('\x1b[5~');
      const screen = plainTerminalOutput(terminal.screenOutput());
      return screen.includes('s-para-00') && !screen.includes('typing-tail');
    });
    const before = visibleParas();
    assert.ok(before.length > 0, 'expected reply paragraphs on screen while scrolled up');

    // Streaming continues: the next delta re-wraps the partial tail line (an
    // in-place edit, not a pure append) and adds paragraphs — all below the fold.
    // The reader's slice must not move even though the tail block mutated.
    driver.releaseStream();
    await waitFor(() => driver.completed);
    assert.equal(visibleParas(), before, 'viewport drifted when the tail grew below the fold');

    terminal.input('\x03');
    await Promise.race([
      run,
      delay(50).then(() => {
        throw new Error('TUI did not close after Ctrl-C');
      }),
    ]);
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

    terminal.input('\x03');
    await Promise.race([
      run,
      delay(50).then(() => {
        throw new Error('TUI did not close after Ctrl-C');
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

    terminal.input('\x03');
    await Promise.race([
      run,
      delay(50).then(() => {
        throw new Error('TUI did not close after Ctrl-C');
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

    await waitFor(() => plainTerminalOutput(terminal.output()).includes('Maka deepseek-v4-flash deepseek ask /repo'));

    terminal.input('\x1b');
    await delay(30);

    assert.equal(terminal.stopCalls, 0);

    terminal.input('\x03');
    await Promise.race([
      run,
      delay(50).then(() => {
        throw new Error('TUI did not close after Ctrl-C');
      }),
    ]);
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

    terminal.input('\x03');
    await Promise.race([
      run,
      delay(50).then(() => {
        throw new Error('TUI did not close after Ctrl-C');
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

    terminal.input('\x03');
    await Promise.race([
      run,
      delay(50).then(() => {
        throw new Error('TUI did not close after Ctrl-C');
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

    terminal.input('/m');

    await waitFor(() => plainTerminalOutput(terminal.output()).includes('/model'));
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

    terminal.input('\x03');
    await Promise.race([
      run,
      delay(50).then(() => {
        throw new Error('TUI did not close after Ctrl-C');
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

    terminal.input('\x03');
    await Promise.race([
      run,
      delay(50).then(() => {
        throw new Error('TUI did not close after Ctrl-C');
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

    terminal.input('\x03');
    await Promise.race([
      run,
      delay(50).then(() => {
        throw new Error('TUI did not close after Ctrl-C');
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

    terminal.input('\x03');
    await Promise.race([
      run,
      delay(50).then(() => {
        throw new Error('TUI did not close after Ctrl-C');
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
      'Maka claude-sonnet-4-5 claude-subscription ask /repo',
    );
    terminal.input('\x1b[B');
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
    assertBottomPickerPlacement(terminal, 'Select Model', 'Maka deepseek-v4-flash deepseek ask /repo');
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

    terminal.input('\x03');
    await Promise.race([
      run,
      delay(50).then(() => {
        throw new Error('TUI did not close after Ctrl-C');
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
    assertBottomPickerPlacement(
      terminal,
      'Resume Session (Current Folder)',
      'Maka claude-sonnet-4-5 claude-subscription ask /repo',
    );
    terminal.input('\r');
    await waitFor(() => driver.sessionIds.length === 1);
    await waitFor(() => terminal.output().includes('Resumed session "Existing chat"'));

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

    terminal.input('\x03');
    await Promise.race([
      run,
      delay(50).then(() => {
        throw new Error('TUI did not close after Ctrl-C');
      }),
    ]);
  });

  test('re-pins to the tail after switching sessions while scrolled up', async () => {
    const terminal = new FakeTerminal();
    const driver = new ScrollThenSwitchDriver();
    const run = runMakaPiTui({
      title: 'Maka',
      driver,
      cwd: '/repo',
      model: 'claude-sonnet-4-5',
      connectionSlug: 'claude-subscription',
      permissionMode: 'ask',
      terminal,
    });

    terminal.input('go');
    terminal.input('\r');
    await waitFor(() => {
      const screen = plainTerminalOutput(terminal.screenOutput());
      return screen.includes('para-39') && /↑ \d+ more/.test(screen);
    });
    // Scroll up into history so the layout is no longer following the tail.
    await waitFor(() => {
      terminal.input('\x1b[5~');
      return plainTerminalOutput(terminal.screenOutput()).includes('para-00');
    });

    // Switching replaces the transcript wholesale; the resumed session must open
    // at its tail, not carry the old scroll offset into a different document.
    terminal.input('/session session-2');
    terminal.input('\r');
    await waitFor(() => plainTerminalOutput(terminal.screenOutput()).includes('switched-tail-marker'));

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

    terminal.input('\x03');
    await Promise.race([
      run,
      delay(50).then(() => {
        throw new Error('TUI did not close after Ctrl-C');
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

    terminal.input('\x03');
    await Promise.race([
      run,
      delay(50).then(() => {
        throw new Error('TUI did not close after Ctrl-C');
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
    terminal.input('\x03');
    await Promise.race([
      run,
      delay(50).then(() => {
        throw new Error('TUI did not close after Ctrl-C');
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

    // Idle double Escape must not stop anything: the session is between turns.
    terminal.input('\x1b');
    terminal.input('\x1b');
    await delay(20);
    assert.equal(driver.stopCalls, 1);

    terminal.input('\x03');
    await Promise.race([
      run,
      delay(50).then(() => {
        throw new Error('TUI did not close after Ctrl-C');
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

    terminal.input('\x03');
    await Promise.race([
      run,
      delay(50).then(() => {
        throw new Error('TUI did not close after Ctrl-C');
      }),
    ]);
  });

  test('does not stop again when Ctrl-C exits mid-interrupt', async () => {
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

    // The interrupt is issued but the runtime stop has not settled and the turn
    // is still parked. Quitting with Ctrl-C must reuse that in-flight stop, not
    // fire a second stopSession through close() that appends a duplicate abort.
    terminal.input('\x03');
    await Promise.race([
      run,
      delay(50).then(() => {
        throw new Error('TUI did not close after Ctrl-C');
      }),
    ]);

    assert.equal(driver.stopCalls, 1);
  });

  test('does not stop again when Esc arrives after Ctrl-C started closing', async () => {
    const terminal = new FakeTerminal();
    const driver = new HangingStopDriver();
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

    // Quit first: close() flips `closed`, then parks awaiting a slow runtime stop.
    terminal.input('\x03');
    await waitFor(() => driver.stopCalls === 1);

    // The TUI is half-closed but its input listener is still live. A double
    // Escape in this window must not slip a second stopSession past close().
    terminal.input('\x1b');
    terminal.input('\x1b');
    await delay(30);
    assert.equal(driver.stopCalls, 1);

    // Releasing the parked stop lets close() finish shutting the TUI down.
    driver.releaseStop();
    await Promise.race([
      run,
      delay(50).then(() => {
        throw new Error('TUI did not close after Ctrl-C');
      }),
    ]);
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

    terminal.input('\x03');
    await Promise.race([
      run,
      delay(50).then(() => {
        throw new Error('TUI did not close after Ctrl-C');
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

  getSessionId(): string {
    return 'session-1';
  }
}

class PermissionPromptDriver implements MakaSessionDriver {
  readonly permissionResponses: PermissionResponse[] = [];
  permissionRequests = 0;
  stopCalls = 0;
  private continueAfterPermission: (() => void) | null = null;

  async listSessions(): Promise<SessionSummary[]> {
    return [];
  }

  async *compactSession(): AsyncIterable<never> {}

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

  async stop(): Promise<void> {
    this.stopCalls += 1;
  }

  async respondToPermission(response: PermissionResponse): Promise<void> {
    this.permissionResponses.push(response);
    this.continueAfterPermission?.();
  }
  async renameSession(): Promise<void> {}
  async setModel(): Promise<void> {}
  async setPermissionMode(): Promise<void> {}
  async setThinkingLevel(): Promise<void> {}
  async switchSession(sessionId: string): Promise<MakaSessionSwitchResult> {
    return switchResult(fakeSessionSummary(sessionId));
  }

  getSessionId(): string {
    return 'session-1';
  }
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

  getSessionId(): string {
    return 'session-1';
  }
}

class HangingStopDriver implements MakaSessionDriver {
  stopCalls = 0;
  private releaseTurn: (() => void) | null = null;
  private releaseStopFns: Array<() => void> = [];

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

  // stop() parks until releaseStop(), mimicking a runtime whose stopSession has
  // not finished aborting. close() awaits this while the input listener is still
  // live, which is the window the Ctrl-C-then-Escape regression exercises.
  async stop(): Promise<void> {
    this.stopCalls += 1;
    await new Promise<void>((resolve) => {
      this.releaseStopFns.push(resolve);
    });
  }

  releaseStop(): void {
    for (const resolve of this.releaseStopFns) resolve();
    this.releaseStopFns = [];
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

  getSessionId(): string {
    return 'session-1';
  }
}

class ScrollThenSwitchDriver implements MakaSessionDriver {
  async listSessions(): Promise<SessionSummary[]> {
    return [fakeSessionSummary('session-2', '/repo')];
  }

  async *compactSession(): AsyncIterable<never> {}

  async *sendPrompt(_prompt: string): AsyncIterable<SessionEvent> {
    const body = Array.from({ length: 40 }, (_, i) => `para-${String(i).padStart(2, '0')}`).join('\n\n');
    yield { type: 'text_delta', id: 'e', turnId: 't', ts: 1, messageId: 'm1', text: body };
    yield { type: 'complete', id: 'c', turnId: 't', ts: 2, stopReason: 'end_turn' };
  }

  async stop(): Promise<void> {}
  async respondToPermission(_response: PermissionResponse): Promise<void> {}
  async renameSession(): Promise<void> {}
  async setModel(): Promise<void> {}
  async setPermissionMode(): Promise<void> {}
  async setThinkingLevel(): Promise<void> {}
  async switchSession(sessionId: string): Promise<MakaSessionSwitchResult> {
    // A history long enough to overflow the viewport, ending in a marker line so
    // the test can assert the tail is on screen after the switch.
    const messages: StoredMessage[] = [];
    for (let i = 0; i < 12; i += 1) {
      messages.push(storedUserMessage(`u${i}`, 't', `history-q-${i}`));
      messages.push(storedAssistantMessage(`a${i}`, 't', `history-a-${i}`));
    }
    messages.push(storedAssistantMessage('a-last', 't', 'switched-tail-marker'));
    return switchResult(fakeSessionSummary(sessionId, '/repo'), messages);
  }
  getSessionId(): string {
    return 'session-1';
  }
}

class MultiTurnLongDriver implements MakaSessionDriver {
  private turn = 0;

  async listSessions(): Promise<SessionSummary[]> {
    return [];
  }

  async *compactSession(): AsyncIterable<never> {}

  async *sendPrompt(_prompt: string): AsyncIterable<SessionEvent> {
    this.turn += 1;
    const n = this.turn;
    const body = Array.from({ length: 40 }, (_, i) => `t${n}-para-${String(i).padStart(2, '0')}`).join('\n\n');
    yield { type: 'text_delta', id: `e${n}`, turnId: `t${n}`, ts: 1, messageId: `m${n}`, text: body };
    yield { type: 'complete', id: `c${n}`, turnId: `t${n}`, ts: 2, stopReason: 'end_turn' };
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
  getSessionId(): string {
    return 'session-1';
  }
}

class LongReplyDriver implements MakaSessionDriver {
  async listSessions(): Promise<SessionSummary[]> {
    return [];
  }

  async *compactSession(): AsyncIterable<never> {}

  async *sendPrompt(_prompt: string): AsyncIterable<SessionEvent> {
    // Blank lines separate paragraphs so markdown keeps them on their own rows,
    // giving a reply that reliably overflows the 24-row viewport.
    const body = Array.from({ length: 40 }, (_, i) => `para-${String(i).padStart(2, '0')}`).join('\n\n');
    yield {
      type: 'text_delta',
      id: 'event-text',
      turnId: 'turn-1',
      ts: 1,
      messageId: 'message-1',
      text: body,
    };
    yield {
      type: 'complete',
      id: 'event-complete',
      turnId: 'turn-1',
      ts: 2,
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
  getSessionId(): string {
    return 'session-1';
  }
}

class PermissionAfterLongDriver implements MakaSessionDriver {
  permissionRequests = 0;
  private continuePastBody: (() => void) | null = null;
  private continuePastPermission: (() => void) | null = null;

  async listSessions(): Promise<SessionSummary[]> {
    return [];
  }

  async *compactSession(): AsyncIterable<never> {}

  async *sendPrompt(_prompt: string): AsyncIterable<SessionEvent> {
    const body = Array.from({ length: 40 }, (_, i) => `para-${String(i).padStart(2, '0')}`).join('\n\n');
    yield { type: 'text_delta', id: 'e', turnId: 't', ts: 1, messageId: 'm1', text: body };
    // Pause mid-turn so the test can scroll up before the permission request lands.
    await new Promise<void>((resolve) => {
      this.continuePastBody = resolve;
    });
    this.permissionRequests += 1;
    yield {
      type: 'permission_request',
      id: 'event-permission',
      turnId: 't',
      ts: 2,
      requestId: 'permission-1',
      toolUseId: 'tool-1',
      toolName: 'Bash',
      category: 'shell_unsafe',
      reason: 'shell_dangerous',
      args: { command: 'npm test' },
    };
    await new Promise<void>((resolve) => {
      this.continuePastPermission = resolve;
    });
    yield {
      type: 'permission_decision_ack',
      id: 'event-decision',
      turnId: 't',
      ts: 3,
      requestId: 'permission-1',
      toolUseId: 'tool-1',
      decision: 'allow',
      rememberForTurn: true,
    };
    yield { type: 'complete', id: 'c', turnId: 't', ts: 4, stopReason: 'end_turn' };
  }

  releaseBody(): void {
    this.continuePastBody?.();
  }

  releasePermission(): void {
    this.continuePastPermission?.();
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
  getSessionId(): string {
    return 'session-1';
  }
}

class LateThinkingDriver implements MakaSessionDriver {
  completed = false;
  private continuePastReply: (() => void) | null = null;

  async listSessions(): Promise<SessionSummary[]> {
    return [];
  }

  async *compactSession(): AsyncIterable<never> {}

  async *sendPrompt(_prompt: string): AsyncIterable<SessionEvent> {
    // A short thinking draft, then a reply long enough to push it above the fold.
    yield { type: 'thinking_delta', id: 'th', turnId: 't', ts: 1, messageId: 'm1', text: 'draft' };
    const body = Array.from({ length: 40 }, (_, i) => `para-${String(i).padStart(2, '0')}`).join('\n\n');
    yield { type: 'text_delta', id: 'tx', turnId: 't', ts: 2, messageId: 'm1', text: body };
    // Pause so the test can expand thinking and scroll up before the late completion.
    await new Promise<void>((resolve) => {
      this.continuePastReply = resolve;
    });
    // thinking_complete replaces the one-line draft in place with a much taller
    // block — an in-place edit above the fold, not a tail append.
    const thinking = Array.from({ length: 8 }, (_, i) => `reason-${i}`).join('\n');
    yield { type: 'thinking_complete', id: 'thc', turnId: 't', ts: 3, messageId: 'm1', text: thinking };
    yield { type: 'complete', id: 'c', turnId: 't', ts: 4, stopReason: 'end_turn' };
    this.completed = true;
  }

  releaseReply(): void {
    this.continuePastReply?.();
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
  getSessionId(): string {
    return 'session-1';
  }
}

class StreamingTailDriver implements MakaSessionDriver {
  completed = false;
  private continueStream: (() => void) | null = null;

  async listSessions(): Promise<SessionSummary[]> {
    return [];
  }

  async *compactSession(): AsyncIterable<never> {}

  async *sendPrompt(_prompt: string): AsyncIterable<SessionEvent> {
    // First chunk overflows the viewport and ends mid-line ("typing-tail" with no
    // trailing newline) so the next delta mutates that last rendered line in
    // place rather than only appending fresh lines.
    const head = Array.from({ length: 30 }, (_, i) => `s-para-${String(i).padStart(2, '0')}`).join('\n\n');
    yield { type: 'text_delta', id: 'e1', turnId: 't', ts: 1, messageId: 'm1', text: `${head}\n\ntyping-tail` };
    await new Promise<void>((resolve) => {
      this.continueStream = resolve;
    });
    // The continuation re-wraps the partial tail line and appends more paragraphs.
    const more = Array.from({ length: 10 }, (_, i) => `s-para-${String(i + 30).padStart(2, '0')}`).join('\n\n');
    yield { type: 'text_delta', id: 'e2', turnId: 't', ts: 2, messageId: 'm1', text: ` continued\n\n${more}` };
    yield { type: 'complete', id: 'c', turnId: 't', ts: 3, stopReason: 'end_turn' };
    this.completed = true;
  }

  releaseStream(): void {
    this.continueStream?.();
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
        stdout: `expanded-tail\n${Array.from({ length: 30 }, (_, i) => `row-${i}`).join('\n')}`,
        stderr: '',
        stdoutTruncated: false,
        stderrTruncated: false,
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
  getSessionId(): string {
    return 'session-1';
  }
}

class SlashCommandDriver implements MakaSessionDriver {
  readonly prompts: string[] = [];
  readonly models: string[] = [];
  readonly permissionModes: PermissionMode[] = [];
  readonly thinkingLevelUpdates: Array<ThinkingLevel | undefined> = [];
  readonly sessionIds: string[] = [];
  readonly renames: string[] = [];
  private sessionId = 'session-1';

  constructor(
    private readonly sessions: SessionSummary[] = [fakeSessionSummary('session-2', '/repo')],
    private readonly sessionMessages: ReadonlyMap<string, readonly StoredMessage[]> = new Map(),
  ) {}

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
  async setModel(model: string): Promise<void> {
    this.models.push(model);
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
  getSessionId(): string {
    return this.sessionId;
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

  getSessionId(): string {
    return 'session-1';
  }
}

function switchResult(summary: SessionSummary, messages: StoredMessage[] = []): MakaSessionSwitchResult {
  return { summary, messages };
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
