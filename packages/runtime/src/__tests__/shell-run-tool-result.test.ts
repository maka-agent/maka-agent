import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { PtyShellOutput } from '@maka/core';

import { projectPtyOutputForModel } from '../shell-run-tool-result.js';

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
