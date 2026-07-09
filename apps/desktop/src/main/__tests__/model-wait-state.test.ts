import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  MODEL_PROCESSING_DELAY_MS,
  createDelayedFlag,
  deriveModelWait,
  type DelayedFlagScheduler,
} from '../../renderer/model-wait-state.js';

const HEAD = {
  turnPhase: 'waiting',
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

describe('deriveModelWait', () => {
  it("is 'processing' at the turn head — armed, waiting for the first token", () => {
    assert.equal(deriveModelWait(HEAD), 'processing');
  });

  it("is 'none' when no turn is in flight", () => {
    assert.equal(deriveModelWait({ ...HEAD, turnPhase: undefined }), 'none');
  });

  it("is 'none' once answer text is streaming", () => {
    assert.equal(deriveModelWait({ ...HEAD, streamingText: 'hi' }), 'none');
  });

  it("is 'none' once reasoning is streaming", () => {
    assert.equal(deriveModelWait({ ...HEAD, thinkingText: 'because' }), 'none');
  });

  it("is 'none' while a tool is in flight", () => {
    assert.equal(deriveModelWait({ ...HEAD, hasInFlightTools: true }), 'none');
  });

  it("a mid-turn lull after content is 'continuing', NOT 'processing' (#646)", () => {
    // Once the turn has streamed (phase 'streamed'), a tool settling back to an
    // idle state is the calm "继续中…" hint — the prominent "正在处理…" must not
    // re-fire in every step-to-step gap (the regression this split fixes).
    const running = deriveModelWait({ ...HEAD, turnPhase: 'streamed', hasInFlightTools: true });
    const settled = deriveModelWait({ ...HEAD, turnPhase: 'streamed', hasInFlightTools: false });
    assert.equal(running, 'none');
    assert.equal(settled, 'continuing');
  });

  it("the head wait stays 'processing' only until the first content event flips the phase", () => {
    assert.equal(deriveModelWait({ ...HEAD, turnPhase: 'waiting' }), 'processing');
    assert.equal(deriveModelWait({ ...HEAD, turnPhase: 'streamed' }), 'continuing');
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
