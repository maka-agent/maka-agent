import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  ptyCompactTerminalLine,
  ptyHumanTerminalText,
  ptyTuiTerminalRows,
  ptyTuiTerminalView,
  type PtyShellOutput,
} from '../index.js';

describe('PTY human output projection', () => {
  it('uses the active view and only falls back to the last alternate frame when empty', () => {
    assert.equal(
      ptyHumanTerminalText(
        output({ scrollback: 'old', screen: 'now', lastAlternateScreen: 'alt' }),
      ),
      'old\nnow',
    );
    assert.equal(ptyHumanTerminalText(output({ lastAlternateScreen: 'alt' })), 'alt');
    assert.equal(
      ptyHumanTerminalText(output({ alternateScreen: true, screen: 'full', scrollback: 'old' })),
      'full',
    );
  });

  it('keeps three head and three tail screen rows without an in-band marker', () => {
    const view = ptyTuiTerminalView(output({ screen: '1\n2\n3\n4\n5\n6\n7\n8' }));
    assert.deepEqual(view.rows, ['1', '2', '3', '6', '7', '8']);
    assert.equal(view.rowsOmitted, true);
  });

  it('fills a short screen from latest scrollback and follows cursor-first compact semantics', () => {
    const value = output({
      scrollback: 'one\ntwo\nthree\nfour',
      screen: 'prompt\n\nanswer',
      cursor: { x: 0, y: 1, visible: true },
    });
    assert.deepEqual(ptyTuiTerminalRows(value), ['two', 'three', 'four', 'prompt', '', 'answer']);
    assert.equal(ptyTuiTerminalView(value).rowsOmitted, true);
    assert.equal(ptyCompactTerminalLine(value), 'prompt');
  });
});

function output(overrides: Partial<PtyShellOutput>): PtyShellOutput {
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
