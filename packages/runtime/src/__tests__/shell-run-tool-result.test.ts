import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { PtyShellOutput, ShellRunRecord } from '@maka/core';

import { projectPtyOutputForModel, terminalContent } from '../shell-run-tool-result.js';

describe('PTY model output projection', () => {
  test('shares one UTF-8 budget in screen, alternate, then latest scrollback priority', () => {
    const output = ptyOutput({
      screen: 'SCREEN',
      lastAlternateScreen: 'ALT'.repeat(20),
      scrollback: 'SCROLL'.repeat(20),
    });
    const projected = projectPtyOutputForModel(output, 80);

    assert.equal(projected.screen, output.screen);
    assert.equal(projected.lastAlternateScreen, output.lastAlternateScreen);
    assert.notEqual(projected.scrollback, output.scrollback);
    assert.equal(projected.truncated, true);
    assert.ok(modelTextBytes(projected) <= 80);

    const screenOnly = projectPtyOutputForModel(ptyOutput({
      screen: '\u754c'.repeat(100),
      lastAlternateScreen: 'must-not-fit',
      scrollback: 'must-not-fit',
    }), 100);
    assert.ok(modelTextBytes(screenOnly) <= 100);
    assert.equal(screenOnly.lastAlternateScreen, undefined);
    assert.equal(screenOnly.scrollback, '');
    assert.equal(screenOnly.screen.includes('\uFFFD'), false);
  });
});

describe('shell run sandbox denial projection', () => {
  test('offers escalation recovery only for a failed sandboxed process', () => {
    const base: ShellRunRecord = {
      shellRunId: 'shell-1', sessionId: 'session-1', sourceTurnId: 'turn-1',
      sourceToolCallId: 'tool-1', cwd: '/workspace', command: 'write outside',
      status: 'failed', startedAt: 1, updatedAt: 2, completedAt: 2, exitCode: 1,
      revision: 2,
      output: {
        mode: 'pipes', stdout: '', stderr: 'Operation not permitted',
        stdoutTruncated: false, stderrTruncated: false, redacted: false,
      },
    };

    assert.equal(terminalContent(base).sandboxDenial, undefined);
    assert.deepEqual(terminalContent({
      ...base,
      sandboxExecution: { type: 'macos-seatbelt', enforced: true },
    }).sandboxDenial, {
      likely: true,
      backend: 'macos-seatbelt',
      recovery: 'require_escalated',
    });
    assert.equal(terminalContent({
      ...base,
      sandboxExecution: { type: 'none', enforced: false },
    }).sandboxDenial, undefined);
  });
});

function ptyOutput(overrides: Partial<PtyShellOutput>): PtyShellOutput {
  return {
    mode: 'pty',
    screen: '',
    scrollback: '',
    cols: 80,
    rows: 24,
    cursor: { x: 0, y: 0, visible: true },
    alternateScreen: false,
    truncated: false,
    redacted: false,
    ...overrides,
  };
}

function modelTextBytes(output: PtyShellOutput): number {
  const text = output.screen + (output.lastAlternateScreen ?? '') + output.scrollback;
  return Buffer.byteLength(text, 'utf8');
}
