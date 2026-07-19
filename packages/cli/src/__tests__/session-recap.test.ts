import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  AUTO_RECAP_DISPLAY_LIMIT_BYTES,
  AUTO_RECAP_IDLE_MS,
  AUTO_RECAP_MIN_TURNS,
  cleanRecapText,
  shouldAutoRecap,
} from '../session-recap.js';

// AUTO_RECAP_DISPLAY_LIMIT_BYTES itself is a plain constant (contract value
// consumed by the runner's idle-recap display suppression, exercised in
// pi-tui-runner.test.ts's "/recap command" suite). Pin its value here so a
// drift is caught next to the rest of the recap contract constants.
test('AUTO_RECAP_DISPLAY_LIMIT_BYTES is 500 bytes', () => {
  assert.equal(AUTO_RECAP_DISPLAY_LIMIT_BYTES, 500);
});

describe('cleanRecapText', () => {
  test('collapses whitespace and trims', () => {
    assert.equal(cleanRecapText('  We   fixed\n\nthe   bug.  '), 'We fixed the bug.');
  });

  test('strips a leading Recap: label (case-insensitive)', () => {
    assert.equal(cleanRecapText('Recap: We fixed the bug.'), 'We fixed the bug.');
    assert.equal(cleanRecapText('RECAP:We fixed the bug.'), 'We fixed the bug.');
  });

  test('strips a leading Summary: label (case-insensitive)', () => {
    assert.equal(cleanRecapText('Summary:  We fixed the bug.'), 'We fixed the bug.');
    assert.equal(cleanRecapText('summary：We fixed the bug.'), 'We fixed the bug.');
  });

  test('strips a leading 回顾： label', () => {
    assert.equal(cleanRecapText('回顾：我们修复了问题。'), '我们修复了问题。');
  });

  test('strips one layer of wrapping quotes', () => {
    assert.equal(cleanRecapText('"We fixed the bug."'), 'We fixed the bug.');
    assert.equal(cleanRecapText("'We fixed the bug.'"), 'We fixed the bug.');
    assert.equal(cleanRecapText('“We fixed the bug.”'), 'We fixed the bug.');
  });

  test('truncates to 1200 characters with an ellipsis', () => {
    const long = 'a'.repeat(1300);
    const result = cleanRecapText(long);
    assert.equal(result.length, 1201);
    assert.equal(result.slice(0, 1200), 'a'.repeat(1200));
    assert.equal(result.at(-1), '…');
  });
});

describe('shouldAutoRecap', () => {
  test('idle-time boundary: 179999ms does not trigger, 180000ms does', () => {
    assert.equal(
      shouldAutoRecap({
        idleMs: AUTO_RECAP_IDLE_MS - 1,
        mainTurnCount: 3,
        lastRecapMainTurnCount: 0,
      }),
      false,
    );
    assert.equal(
      shouldAutoRecap({ idleMs: AUTO_RECAP_IDLE_MS, mainTurnCount: 3, lastRecapMainTurnCount: 0 }),
      true,
    );
  });

  test('main-turn boundary: 2 turns does not trigger, 3 turns does', () => {
    assert.equal(
      shouldAutoRecap({
        idleMs: AUTO_RECAP_IDLE_MS,
        mainTurnCount: AUTO_RECAP_MIN_TURNS - 1,
        lastRecapMainTurnCount: 0,
      }),
      false,
    );
    assert.equal(
      shouldAutoRecap({
        idleMs: AUTO_RECAP_IDLE_MS,
        mainTurnCount: AUTO_RECAP_MIN_TURNS,
        lastRecapMainTurnCount: 0,
      }),
      true,
    );
  });

  test('watermark: equal main-turn count does not re-trigger', () => {
    assert.equal(
      shouldAutoRecap({ idleMs: AUTO_RECAP_IDLE_MS, mainTurnCount: 3, lastRecapMainTurnCount: 3 }),
      false,
    );
    assert.equal(
      shouldAutoRecap({ idleMs: AUTO_RECAP_IDLE_MS, mainTurnCount: 4, lastRecapMainTurnCount: 3 }),
      true,
    );
  });
});
