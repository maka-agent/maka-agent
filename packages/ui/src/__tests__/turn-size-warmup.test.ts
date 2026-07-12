import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { createTurnSizeWarmup, type WarmupScheduler } from '../turn-size-warmup.js';

function fakeTurn(overrides: { live?: boolean; connected?: boolean } = {}) {
  return {
    isConnected: overrides.connected ?? true,
    hasAttribute: (name: string) => name === 'data-live-streaming' && (overrides.live ?? false),
    style: { contentVisibility: '' },
  };
}

function fakeScheduler() {
  const idle: Array<() => void> = [];
  const frames: Array<() => void> = [];
  const remove = (queue: Array<() => void>, callback: () => void) => {
    const index = queue.indexOf(callback);
    if (index >= 0) queue.splice(index, 1);
  };
  const scheduler: WarmupScheduler = {
    requestIdle(callback) {
      idle.push(callback);
      return () => remove(idle, callback);
    },
    requestFrame(callback) {
      frames.push(callback);
      return () => remove(frames, callback);
    },
  };
  return {
    scheduler,
    flushIdle: () => { idle.splice(0).forEach((callback) => callback()); },
    flushFrame: () => { frames.splice(0).forEach((callback) => callback()); },
    pending: () => idle.length + frames.length,
  };
}

function forced(turns: Array<{ style: { contentVisibility: string } }>): number[] {
  return turns.flatMap((turn, index) => turn.style.contentVisibility === 'visible' ? [index] : []);
}

describe('createTurnSizeWarmup', () => {
  it('walks bottom-up in chunks, forcing each chunk across a full frame then releasing it', () => {
    const turns = [fakeTurn(), fakeTurn(), fakeTurn(), fakeTurn(), fakeTurn()];
    const { scheduler, flushIdle, flushFrame, pending } = fakeScheduler();
    createTurnSizeWarmup({ turns: () => turns, chunkSize: 2, scheduler });

    assert.deepEqual(forced(turns), []);
    flushIdle();
    assert.deepEqual(forced(turns), [3, 4]);
    // The chunk must stay forced across the frame that lays it out (the first
    // frame callback fires before that layout) and release on the next frame.
    flushFrame();
    assert.deepEqual(forced(turns), [3, 4]);
    flushFrame();
    assert.deepEqual(forced(turns), []);

    flushIdle();
    assert.deepEqual(forced(turns), [1, 2]);
    flushFrame();
    flushFrame();
    flushIdle();
    assert.deepEqual(forced(turns), [0]);
    flushFrame();
    flushFrame();
    assert.deepEqual(forced(turns), []);
    assert.equal(pending(), 0);
  });

  it('skips the live-streaming tail and disconnected turns', () => {
    const turns = [fakeTurn(), fakeTurn({ connected: false }), fakeTurn(), fakeTurn({ live: true })];
    const { scheduler, flushIdle } = fakeScheduler();
    createTurnSizeWarmup({ turns: () => turns, chunkSize: 4, scheduler });

    flushIdle();
    assert.deepEqual(forced(turns), [0, 2]);
  });

  it('cancel releases the in-flight chunk and stops the walk', () => {
    const turns = [fakeTurn(), fakeTurn(), fakeTurn()];
    const { scheduler, flushIdle, flushFrame, pending } = fakeScheduler();
    const stop = createTurnSizeWarmup({ turns: () => turns, chunkSize: 2, scheduler });

    flushIdle();
    assert.deepEqual(forced(turns), [1, 2]);
    stop();
    assert.deepEqual(forced(turns), []);
    flushFrame();
    flushFrame();
    flushIdle();
    assert.deepEqual(forced(turns), []);
    assert.equal(pending(), 0);
  });
});
