import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { RuntimeEvent } from '@maka/core/runtime-event';
import {
  estimateNextRequestTokens,
  exceedsContextWindow,
  exceedsHighWater,
  selectMidTurnSafeBoundary,
} from '../mid-turn-capacity-compact.js';

describe('mid-turn capacity trigger measurement', () => {
  test('anchors on real provider usage plus a tail char/4 delta', () => {
    // last step: 100 input + 40 output real tokens, then 400 chars of new tool results
    assert.equal(
      estimateNextRequestTokens({ priorUsageTokens: 140, appendedChars: 400, charsPerToken: 4 }),
      140 + 100,
    );
  });

  test('falls back to whole-projection char/4 on cold start (no usage)', () => {
    assert.equal(
      estimateNextRequestTokens({ appendedChars: 40, charsPerToken: 4, coldStartChars: 800 }),
      200,
    );
  });

  test('high-water crosses at contextWindow minus reserve; hard cap at the window', () => {
    assert.equal(exceedsHighWater(100_000, 128_000, 16_384), false);
    assert.equal(exceedsHighWater(120_000, 128_000, 16_384), true);
    assert.equal(exceedsContextWindow(120_000, 128_000), false);
    assert.equal(exceedsContextWindow(130_000, 128_000), true);
  });
});

describe('mid-turn safe boundary selection', () => {
  test('folds the largest immutable non-partial prefix, leaving the reserved tail', () => {
    const events = [
      user('anchor', 'turn-1'),
      model('m1', 'turn-1'),
      model('m2', 'turn-1'),
      model('m3', 'turn-1'),
    ];
    const boundary = selectMidTurnSafeBoundary(events, { reserveTailEvents: 1 });
    assert.deepEqual(boundary, { ok: true, coveredCount: 3 });
  });

  test('never cuts on a partial (streaming) event', () => {
    const events = [
      user('anchor', 'turn-1'),
      model('m1', 'turn-1'),
      { ...model('m2-partial', 'turn-1'), partial: true },
    ];
    // Reserving 0 tail would cut after the partial; it must retreat to m1.
    const boundary = selectMidTurnSafeBoundary(events, { reserveTailEvents: 0 });
    assert.deepEqual(boundary, { ok: true, coveredCount: 2 });
  });

  test('never splits a tool call/result pair', () => {
    const events = [
      user('anchor', 'turn-1'),
      call('c1', 'call-1', 'turn-1'),
      result('r1', 'call-1', 'turn-1'),
      call('c2', 'call-2', 'turn-1'),
      result('r2', 'call-2', 'turn-1'),
    ];
    // reserveTail=2 would cut at index 3, between call-2 and its result → retreat to 3? No:
    // index 3 straddles call-2(3)/result-2(4)? call at 3 >= 3, result at 4 >= 3, both outside → safe.
    // Force a straddle: reserveTail=1 → maxCut=4 straddles nothing (call-2 at 3<4, result-2 at 4>=4) → straddle, retreat to 3.
    const boundary = selectMidTurnSafeBoundary(events, { reserveTailEvents: 1 });
    assert.deepEqual(boundary, { ok: true, coveredCount: 3 });
  });

  test('reports no safe completed span when the whole pool is one atomic pair', () => {
    const events = [
      call('c1', 'call-1', 'turn-1'),
      result('r1', 'call-1', 'turn-1'),
    ];
    // Reserving 1 tail forces maxCut=1, which straddles the only pair → no safe span.
    const boundary = selectMidTurnSafeBoundary(events, { reserveTailEvents: 1 });
    assert.deepEqual(boundary, { ok: false, reason: 'no_safe_completed_span' });
  });
});

function base(id: string, turnId: string): Omit<RuntimeEvent, 'role' | 'author' | 'content'> {
  return {
    id, sessionId: 'session-1', runId: 'run-1', turnId, invocationId: 'run-1',
    ts: 1_800_000_000_000, partial: false,
  };
}
function user(id: string, turnId: string): RuntimeEvent {
  return { ...base(id, turnId), role: 'user', author: 'user', content: { kind: 'text', text: id } };
}
function model(id: string, turnId: string): RuntimeEvent {
  return { ...base(id, turnId), role: 'model', author: 'agent', content: { kind: 'text', text: id } };
}
function call(id: string, callId: string, turnId: string): RuntimeEvent {
  return {
    ...base(id, turnId), role: 'model', author: 'agent',
    content: { kind: 'function_call', id: callId, name: 'tool', args: {} },
  };
}
function result(id: string, callId: string, turnId: string): RuntimeEvent {
  return {
    ...base(id, turnId), role: 'tool', author: 'tool',
    content: { kind: 'function_response', id: callId, name: 'tool', result: 'ok' },
  };
}
