import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { appendPending, clearPending, removePending, removePendingItems, selectPending } from '../../renderer/app-shell-pending-attachments.js';

describe('pending attachments by draft key', () => {
  test('selecting another key never leaks pending from a different session', () => {
    const map = appendPending<string>({}, 'session-a', ['a1']);
    assert.deepEqual(selectPending(map, 'session-a'), ['a1']);
    assert.deepEqual(selectPending(map, 'session-b'), []);
  });

  test('removes a single pending by index without touching other keys', () => {
    let map = appendPending<string>({}, 'a', ['a1', 'a2']);
    map = appendPending(map, 'b', ['b1']);
    const next = removePending(map, 'a', 0);
    assert.deepEqual(selectPending(next, 'a'), ['a2']);
    assert.deepEqual(selectPending(next, 'b'), ['b1']);
  });

  test('clears one key without affecting others', () => {
    let map = appendPending<string>({}, 'a', ['a1']);
    map = appendPending(map, 'b', ['b1']);
    const next = clearPending(map, 'a');
    assert.deepEqual(selectPending(next, 'a'), []);
    assert.deepEqual(selectPending(next, 'b'), ['b1']);
  });

  test('successful send removes only its submitted snapshot', () => {
    const submitted = { name: 'submitted' };
    const addedWhileSending = { name: 'added later' };
    let map = appendPending({}, 'draft', [submitted]);
    map = appendPending(map, 'draft', [addedWhileSending]);

    const next = removePendingItems(map, 'draft', [submitted]);

    assert.deepEqual(selectPending(next, 'draft'), [addedWhileSending]);
  });
});
