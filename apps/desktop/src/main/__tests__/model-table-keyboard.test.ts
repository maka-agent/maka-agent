/**
 * Tests for the ARIA radiogroup keyboard helper used by ProvidersPanel's
 * ModelTable.
 *
 * Per @kenji PR93 follow-up ("ModelTable 的 keyboard transition 抽成纯
 * helper（currentId + visibleIds + key → nextId），用 node:test 钉住
 * 逻辑，React 只负责调用 helper"). The helper lives in
 * `apps/desktop/src/renderer/settings/model-table-keyboard.ts` — pure
 * .ts, no React deps — so the desktop main test runner can import it
 * without JSX support.
 *
 * Locks down the a11y behavior so future refactors don't regress to
 * "focus-only, no select" or break the Arrow / Home / End semantics.
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import {
  isRadioGroupNavKey,
  nextRadioId,
} from '../../renderer/settings/model-table-keyboard.js';

const FIVE = ['glm-4.5', 'glm-4.5-air', 'glm-4.6', 'glm-4.7', 'glm-5'];

describe('isRadioGroupNavKey', () => {
  it('recognizes all four arrows + Home/End', () => {
    for (const k of ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End']) {
      assert.equal(isRadioGroupNavKey(k), true, `expected ${k} to be a nav key`);
    }
  });
  it('does not flag Space/Enter/Escape/printable', () => {
    for (const k of [' ', 'Enter', 'Escape', 'a', 'Tab']) {
      assert.equal(isRadioGroupNavKey(k), false, `expected ${k} NOT to be a nav key`);
    }
  });
});

describe('nextRadioId — ArrowDown / ArrowRight', () => {
  it('advances by one', () => {
    assert.equal(nextRadioId('glm-4.5', FIVE, 'ArrowDown'), 'glm-4.5-air');
    assert.equal(nextRadioId('glm-4.6', FIVE, 'ArrowRight'), 'glm-4.7');
  });
  it('wraps from last back to first', () => {
    assert.equal(nextRadioId('glm-5', FIVE, 'ArrowDown'), 'glm-4.5');
    assert.equal(nextRadioId('glm-5', FIVE, 'ArrowRight'), 'glm-4.5');
  });
  it('lands on first when no row focused', () => {
    assert.equal(nextRadioId(undefined, FIVE, 'ArrowDown'), 'glm-4.5');
  });
});

describe('nextRadioId — ArrowUp / ArrowLeft', () => {
  it('retreats by one', () => {
    assert.equal(nextRadioId('glm-4.7', FIVE, 'ArrowUp'), 'glm-4.6');
    assert.equal(nextRadioId('glm-4.5-air', FIVE, 'ArrowLeft'), 'glm-4.5');
  });
  it('wraps from first back to last', () => {
    assert.equal(nextRadioId('glm-4.5', FIVE, 'ArrowUp'), 'glm-5');
    assert.equal(nextRadioId('glm-4.5', FIVE, 'ArrowLeft'), 'glm-5');
  });
  it('lands on last when no row focused', () => {
    assert.equal(nextRadioId(undefined, FIVE, 'ArrowUp'), 'glm-5');
  });
});

describe('nextRadioId — Home / End', () => {
  it('Home → first', () => {
    assert.equal(nextRadioId('glm-4.7', FIVE, 'Home'), 'glm-4.5');
    assert.equal(nextRadioId(undefined, FIVE, 'Home'), 'glm-4.5');
  });
  it('End → last', () => {
    assert.equal(nextRadioId('glm-4.5', FIVE, 'End'), 'glm-5');
    assert.equal(nextRadioId(undefined, FIVE, 'End'), 'glm-5');
  });
});

describe('nextRadioId — non-nav keys / edge cases', () => {
  it('returns null for keys not in the radiogroup nav set', () => {
    // Caller bails out without preventDefault — Space/Enter still get the
    // native button click; printable keys still type into search.
    assert.equal(nextRadioId('glm-4.5', FIVE, ' '), null);
    assert.equal(nextRadioId('glm-4.5', FIVE, 'Enter'), null);
    assert.equal(nextRadioId('glm-4.5', FIVE, 'Escape'), null);
    assert.equal(nextRadioId('glm-4.5', FIVE, 'a'), null);
  });
  it('returns null for an empty radio set', () => {
    assert.equal(nextRadioId(undefined, [], 'ArrowDown'), null);
  });
  it('single-radio group: same id returned (caller short-circuits the no-op)', () => {
    // Only one id; ArrowDown wraps back to it, equals current.
    // Caller's `if (nextId === currentId) return;` then bails.
    assert.equal(nextRadioId('only', ['only'], 'ArrowDown'), 'only');
    assert.equal(nextRadioId('only', ['only'], 'ArrowUp'), 'only');
  });
  it('currentId not in visibleIds (e.g. filtered out): treat as -1', () => {
    // Default model `glm-4.5` is filtered out; user presses ArrowDown.
    // Should land on the first visible item.
    assert.equal(nextRadioId('glm-4.5', ['glm-5', 'glm-4.6'], 'ArrowDown'), 'glm-5');
  });
});
