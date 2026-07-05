import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { reconcileHistorySync, type ComposerHistoryState } from '../composer-helpers.js';

// reconcileHistorySync reconciles the Composer's in-memory history state
// with what localStorage reports, right before a history-navigation keystroke
// is dispatched to navigateComposerHistory. It is the seam that keeps a
// storage clear or a transient storage failure from clobbering the user's
// in-memory history or the draft they were typing.

describe('reconcileHistorySync', () => {
  // P2-2: localStorage read failed — keep the in-memory history intact so a
  // transient storage failure (private browsing, quota, SSR) does not wipe
  // history the user already has in memory.
  it('keeps the current state when synced is null (storage read failed)', () => {
    const current: ComposerHistoryState = { entries: ['内存里的历史'], index: 0, savedDraft: '草稿' };
    const result = reconcileHistorySync(current, null);
    assert.deepEqual(result.state, current);
    assert.equal(result.restoreDraft, false);
  });

  // P2-1: history was cleared (e.g. from Settings) while the Composer was
  // mid-navigation — the saved draft must be restored so the user does not
  // lose what they were typing.
  it('resets to empty and signals draft restore when cleared mid-navigation', () => {
    const current: ComposerHistoryState = { entries: ['旧'], index: 0, savedDraft: '用户正在编辑的草稿' };
    const result = reconcileHistorySync(current, []);
    assert.deepEqual(result.state, { entries: [], index: -1, savedDraft: '' });
    assert.equal(result.restoreDraft, true);
  });

  it('resets to empty without draft restore when cleared but not navigating', () => {
    const current: ComposerHistoryState = { entries: ['旧'], index: -1, savedDraft: '' };
    const result = reconcileHistorySync(current, []);
    assert.deepEqual(result.state, { entries: [], index: -1, savedDraft: '' });
    assert.equal(result.restoreDraft, false);
  });

  it('does not signal draft restore when mid-navigation but savedDraft is empty', () => {
    const current: ComposerHistoryState = { entries: ['旧'], index: 0, savedDraft: '' };
    const result = reconcileHistorySync(current, []);
    assert.equal(result.restoreDraft, false);
  });

  it('adopts synced entries and clamps the index into range', () => {
    const current: ComposerHistoryState = { entries: [], index: 5, savedDraft: '草稿' };
    const result = reconcileHistorySync(current, ['a', 'b']);
    assert.deepEqual(result.state, { entries: ['a', 'b'], index: 1, savedDraft: '草稿' });
    assert.equal(result.restoreDraft, false);
  });

  it('preserves savedDraft when adopting synced entries', () => {
    const current: ComposerHistoryState = { entries: [], index: -1, savedDraft: '保留的草稿' };
    const result = reconcileHistorySync(current, ['a']);
    assert.equal(result.state.savedDraft, '保留的草稿');
  });
});
