import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  createChatInputActionOwner,
  fileTransferContainsFiles,
  focusTextInputAtEnd,
  isChatInputComposing,
} from '../chat-input-behavior.js';

describe('shared chat input behavior', () => {
  it('recognizes IME composition from either the native flag or Process key', () => {
    assert.equal(isChatInputComposing({ key: 'Enter', nativeEvent: { isComposing: true } }), true);
    assert.equal(isChatInputComposing({ key: 'Process', nativeEvent: {} }), true);
    assert.equal(isChatInputComposing({ nativeEvent: {} }, true), true);
    assert.equal(isChatInputComposing({ key: 'Enter', nativeEvent: {} }), false);
  });

  it('recognizes file drag and paste payloads without depending on one event type', () => {
    assert.equal(fileTransferContainsFiles(['text/plain', 'Files'], 0), true);
    assert.equal(fileTransferContainsFiles(['text/plain'], 1), true);
    assert.equal(fileTransferContainsFiles(['text/plain'], 0), false);
  });

  it('focuses a text input and moves its selection to the visible value end', () => {
    const calls: Array<string | [number, number]> = [];
    const input = {
      value: 'hello',
      focus: () => calls.push('focus'),
      setSelectionRange: (start: number, end: number) => calls.push([start, end]),
    };
    focusTextInputAtEnd(input);
    assert.deepEqual(calls, ['focus', [5, 5]]);
  });

  it('owns async input actions synchronously and releases only the active action', async () => {
    const states: Array<string | null> = [];
    const owner = createChatInputActionOwner<string>((action) => states.push(action));
    let release!: () => void;
    const first = owner.run('drop', () => new Promise<string>((resolve) => { release = () => resolve('done'); }));
    assert.equal(owner.pending, 'drop');
    assert.equal(await owner.run('paste', async () => 'ignored'), undefined);
    release();
    assert.equal(await first, 'done');
    assert.equal(owner.pending, null);
    assert.deepEqual(states, ['drop', null]);
  });

  it('reset invalidates late completion cleanup', async () => {
    const states: Array<string | null> = [];
    const owner = createChatInputActionOwner<string>((action) => states.push(action));
    let release!: () => void;
    const action = owner.run('drop', () => new Promise<void>((resolve) => { release = resolve; }));
    owner.reset();
    release();
    await action;
    assert.deepEqual(states, ['drop']);
  });
});
