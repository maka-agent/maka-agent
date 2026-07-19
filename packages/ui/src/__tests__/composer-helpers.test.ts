import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  navigateComposerHistory,
  readComposerDraft,
  reconcileHistorySync,
  rememberComposerDraft,
  rememberComposerHistoryEntry,
  type ComposerHistoryState,
} from '../composer-helpers.js';

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

// The draft store backs useComposerDraft (issue #1044): the hook's
// save/clear/swap paths all delegate here, so pin the store semantics the
// hook relies on — no-op without a key, blank-means-delete, overwrite keeps
// one entry, and both caps (120k chars, 32 keys) bound the Map.
describe('rememberComposerDraft / readComposerDraft', () => {
  it('is a no-op when the draft key is undefined', () => {
    const store = new Map<string, string>();
    rememberComposerDraft(store, undefined, 'hello');
    assert.equal(store.size, 0);
    assert.equal(readComposerDraft(store, undefined), '');
  });

  it('stores and reads back the draft under its key', () => {
    const store = new Map<string, string>();
    rememberComposerDraft(store, 'session-a', '草稿内容');
    assert.equal(readComposerDraft(store, 'session-a'), '草稿内容');
    assert.equal(readComposerDraft(store, 'session-b'), '');
  });

  it('deletes the entry when the remembered value is blank', () => {
    const store = new Map<string, string>();
    rememberComposerDraft(store, 'session-a', '草稿内容');
    rememberComposerDraft(store, 'session-a', '   ');
    assert.equal(store.has('session-a'), false);
    assert.equal(readComposerDraft(store, 'session-a'), '');
  });

  it('overwrites an existing key without growing the store', () => {
    const store = new Map<string, string>();
    rememberComposerDraft(store, 'session-a', 'first');
    rememberComposerDraft(store, 'session-a', 'second');
    assert.equal(store.size, 1);
    assert.equal(readComposerDraft(store, 'session-a'), 'second');
  });

  it('keeps only the trailing 120k characters of an over-long draft', () => {
    const store = new Map<string, string>();
    const head = 'H'.repeat(100);
    const tail = 'T'.repeat(120_000);
    rememberComposerDraft(store, 'session-a', head + tail);
    const stored = readComposerDraft(store, 'session-a');
    assert.equal(stored.length, 120_000);
    assert.equal(stored, tail);
  });

  it('evicts the oldest key past 32 entries, and re-remembering refreshes recency', () => {
    const store = new Map<string, string>();
    for (let i = 0; i < 32; i++) rememberComposerDraft(store, `key-${i}`, `draft-${i}`);
    assert.equal(store.size, 32);
    // Refresh key-0 so key-1 becomes the oldest.
    rememberComposerDraft(store, 'key-0', 'draft-0-fresh');
    rememberComposerDraft(store, 'key-32', 'draft-32');
    assert.equal(store.size, 32);
    assert.equal(store.has('key-0'), true, 'refreshed key survives eviction');
    assert.equal(store.has('key-1'), false, 'oldest untouched key is evicted first');
    assert.equal(readComposerDraft(store, 'key-32'), 'draft-32');
  });
});

// rememberComposerHistoryEntry backs useComposerHistory.rememberSentEntry —
// the in-memory list mirrors the persisted global history (dedup + cap).
describe('rememberComposerHistoryEntry', () => {
  it('appends a trimmed new entry', () => {
    assert.deepEqual(rememberComposerHistoryEntry(['a'], '  b  '), ['a', 'b']);
  });

  it('leaves the list unchanged for blank input', () => {
    assert.deepEqual(rememberComposerHistoryEntry(['a'], '   '), ['a']);
  });

  it('dedups an existing entry by moving it to the newest position', () => {
    assert.deepEqual(rememberComposerHistoryEntry(['a', 'b', 'c'], 'a'), ['b', 'c', 'a']);
  });

  it('evicts the oldest entry past 50 entries', () => {
    const entries = Array.from({ length: 50 }, (_, i) => `entry-${i}`);
    const next = rememberComposerHistoryEntry(entries, 'entry-50');
    assert.equal(next.length, 50);
    assert.equal(next[0], 'entry-1');
    assert.equal(next[49], 'entry-50');
  });
});

// navigateComposerHistory backs useComposerHistory.handleArrowKey — the
// up/down recall transitions, including the saved-draft round trip the
// textarea applies verbatim.
describe('navigateComposerHistory', () => {
  it('does nothing when history is empty', () => {
    const state: ComposerHistoryState = { entries: [], index: -1, savedDraft: '' };
    assert.deepEqual(navigateComposerHistory(state, 'previous', 'draft'), { state, value: 'draft', changed: false });
  });

  it('previous from idle recalls the newest entry and saves the current draft', () => {
    const state: ComposerHistoryState = { entries: ['old', 'new'], index: -1, savedDraft: '' };
    const result = navigateComposerHistory(state, 'previous', '正在输入');
    assert.equal(result.changed, true);
    assert.equal(result.value, 'new');
    assert.deepEqual(result.state, { entries: ['old', 'new'], index: 1, savedDraft: '正在输入' });
  });

  it('previous walks older and clamps at the oldest entry', () => {
    let state: ComposerHistoryState = { entries: ['old', 'new'], index: 1, savedDraft: 'draft' };
    const first = navigateComposerHistory(state, 'previous', 'new');
    assert.equal(first.value, 'old');
    assert.equal(first.state.index, 0);
    const clamped = navigateComposerHistory(first.state, 'previous', 'old');
    assert.equal(clamped.value, 'old', 'stays on the oldest entry instead of wrapping');
    assert.equal(clamped.state.index, 0);
    assert.equal(clamped.changed, true);
    state = clamped.state;
    assert.equal(state.savedDraft, 'draft', 'the saved draft survives repeated previous');
  });

  it('next from idle is a no-op', () => {
    const state: ComposerHistoryState = { entries: ['a'], index: -1, savedDraft: '' };
    assert.deepEqual(navigateComposerHistory(state, 'next', 'draft'), { state, value: 'draft', changed: false });
  });

  it('next walks newer and restores the saved draft past the newest entry', () => {
    const navigating: ComposerHistoryState = { entries: ['old', 'new'], index: 0, savedDraft: '我的草稿' };
    const newer = navigateComposerHistory(navigating, 'next', 'old');
    assert.equal(newer.value, 'new');
    assert.equal(newer.state.index, 1);
    const restored = navigateComposerHistory(newer.state, 'next', 'new');
    assert.equal(restored.changed, true);
    assert.equal(restored.value, '我的草稿');
    assert.deepEqual(restored.state, { entries: ['old', 'new'], index: -1, savedDraft: '' });
  });

  it('round-trips a full up-up-down-down cycle back to the original draft', () => {
    let state: ComposerHistoryState = { entries: ['one', 'two'], index: -1, savedDraft: '' };
    let value = '原始输入';
    for (const direction of ['previous', 'previous', 'next', 'next'] as const) {
      const result = navigateComposerHistory(state, direction, value);
      assert.equal(result.changed, true);
      state = result.state;
      value = result.value;
    }
    assert.equal(value, '原始输入');
    assert.deepEqual(state, { entries: ['one', 'two'], index: -1, savedDraft: '' });
  });
});
