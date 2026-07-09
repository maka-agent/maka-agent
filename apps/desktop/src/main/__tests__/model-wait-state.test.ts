import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  MODEL_PROCESSING_DELAY_MS,
  createDelayedFlag,
  deriveModelWaitIdle,
  type DelayedFlagScheduler,
} from '../../renderer/model-wait-state.js';

const IDLE = {
  turnActive: true,
  streamingText: '',
  thinkingText: '',
  hasInFlightTools: false,
} as const;

function fakeScheduler() {
  let now = 0;
  let seq = 0;
  const timers = new Map<number, { at: number; fn: () => void }>();
  const scheduler: DelayedFlagScheduler = {
    setTimeout(fn, ms) {
      const id = ++seq;
      timers.set(id, { at: now + ms, fn });
      return id;
    },
    clearTimeout(handle) {
      timers.delete(handle as number);
    },
  };
  return {
    scheduler,
    advance(ms: number) {
      now += ms;
      for (const [id, timer] of [...timers.entries()]) {
        if (timer.at <= now) {
          timers.delete(id);
          timer.fn();
        }
      }
    },
    pending: () => timers.size,
  };
}

describe('deriveModelWaitIdle', () => {
  it('is true when the turn is active and nothing is streaming', () => {
    assert.equal(deriveModelWaitIdle(IDLE), true);
  });

  it('is false when the turn is not active', () => {
    assert.equal(deriveModelWaitIdle({ ...IDLE, turnActive: false }), false);
  });

  it('is false once answer text is streaming', () => {
    assert.equal(deriveModelWaitIdle({ ...IDLE, streamingText: 'hi' }), false);
  });

  it('is false once reasoning is streaming', () => {
    assert.equal(deriveModelWaitIdle({ ...IDLE, thinkingText: 'because' }), false);
  });

  it('is false while a tool is in flight', () => {
    assert.equal(deriveModelWaitIdle({ ...IDLE, hasInFlightTools: true }), false);
  });

  it('re-satisfies after a tool settles (mid-turn resume gap, no explicit re-arm)', () => {
    const running = deriveModelWaitIdle({ ...IDLE, hasInFlightTools: true });
    const settled = deriveModelWaitIdle({ ...IDLE, hasInFlightTools: false });
    assert.equal(running, false);
    assert.equal(settled, true);
  });
});

describe('createDelayedFlag', () => {
  it('reveals only after the delay elapses with the condition held true', () => {
    const clock = fakeScheduler();
    const flag = createDelayedFlag({ delayMs: MODEL_PROCESSING_DELAY_MS, scheduler: clock.scheduler });
    flag.setCondition(true);
    clock.advance(MODEL_PROCESSING_DELAY_MS - 1);
    assert.equal(flag.get(), false, 'still hidden just before the delay');
    clock.advance(1);
    assert.equal(flag.get(), true, 'revealed at the delay boundary');
  });

  it('never reveals when the condition drops before the delay (fast response, no flash)', () => {
    const clock = fakeScheduler();
    const flag = createDelayedFlag({ delayMs: MODEL_PROCESSING_DELAY_MS, scheduler: clock.scheduler });
    flag.setCondition(true);
    clock.advance(100);
    flag.setCondition(false);
    clock.advance(MODEL_PROCESSING_DELAY_MS);
    assert.equal(flag.get(), false);
    assert.equal(clock.pending(), 0, 'the pending reveal timer was cancelled');
  });

  it('hides immediately when the condition drops after being visible', () => {
    const clock = fakeScheduler();
    const flag = createDelayedFlag({ delayMs: MODEL_PROCESSING_DELAY_MS, scheduler: clock.scheduler });
    flag.setCondition(true);
    clock.advance(MODEL_PROCESSING_DELAY_MS);
    assert.equal(flag.get(), true);
    flag.setCondition(false);
    assert.equal(flag.get(), false);
  });

  it('re-arms on a fresh rising edge', () => {
    const clock = fakeScheduler();
    const flag = createDelayedFlag({ delayMs: MODEL_PROCESSING_DELAY_MS, scheduler: clock.scheduler });
    flag.setCondition(true);
    clock.advance(MODEL_PROCESSING_DELAY_MS);
    flag.setCondition(false);
    flag.setCondition(true);
    clock.advance(MODEL_PROCESSING_DELAY_MS - 1);
    assert.equal(flag.get(), false, 'the second window is delayed too');
    clock.advance(1);
    assert.equal(flag.get(), true);
  });

  it('emits onChange only on real transitions', () => {
    const clock = fakeScheduler();
    const changes: boolean[] = [];
    const flag = createDelayedFlag({
      delayMs: MODEL_PROCESSING_DELAY_MS,
      scheduler: clock.scheduler,
      onChange: (v) => changes.push(v),
    });
    flag.setCondition(true);
    flag.setCondition(true); // redundant, no timer churn
    clock.advance(MODEL_PROCESSING_DELAY_MS);
    flag.setCondition(false);
    assert.deepEqual(changes, [true, false]);
  });

  it('dispose cancels a pending reveal', () => {
    const clock = fakeScheduler();
    const flag = createDelayedFlag({ delayMs: MODEL_PROCESSING_DELAY_MS, scheduler: clock.scheduler });
    flag.setCondition(true);
    flag.dispose();
    clock.advance(MODEL_PROCESSING_DELAY_MS);
    assert.equal(flag.get(), false);
    assert.equal(clock.pending(), 0);
  });
});
