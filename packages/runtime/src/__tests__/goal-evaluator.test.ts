import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildGoalEvaluationPrompt,
  parseGoalEvaluation,
  evaluateGoal,
  GoalEvaluatorFatalError,
} from '../goal-evaluator.js';

describe('buildGoalEvaluationPrompt', () => {
  test('includes condition, context, and field spec', () => {
    const p = buildGoalEvaluationPrompt('all tests pass', 'ran tests, 2 failed');
    assert.ok(p.includes('all tests pass'));
    assert.ok(p.includes('ran tests, 2 failed'));
    assert.ok(p.includes('GOAL CONDITION'));
    assert.ok(p.includes('CONVERSATION CONTEXT'));
    assert.ok(p.includes('"met"'));
    assert.ok(p.includes('"progress"'));
    assert.ok(p.includes('"waiting"'));
  });
});

describe('parseGoalEvaluation', () => {
  test('parses a full verdict', () => {
    const r = parseGoalEvaluation(
      '{"met": false, "impossible": false, "progress": true, "waiting": false, "reason": "fixed 1 of 3"}',
    );
    assert.equal(r.met, false);
    assert.equal(r.progress, true);
    assert.equal(r.reason, 'fixed 1 of 3');
  });

  test('parses waiting (no wait_seconds in the contract)', () => {
    const r = parseGoalEvaluation(
      '{"met": false, "impossible": false, "progress": false, "waiting": true, "reason": "CI running"}',
    );
    assert.equal(r.waiting, true);
    // wait_seconds was removed from the contract (honoring it would be the
    // out-of-scope scheduled-poll handoff); any wait_seconds in the payload is
    // simply ignored, never surfaced.
    assert.equal('waitSeconds' in r, false);
  });

  test('ignores a stray wait_seconds field in evaluator output', () => {
    const r = parseGoalEvaluation(
      '{"met": false, "waiting": true, "wait_seconds": 999999, "reason": "x"}',
    );
    assert.equal(r.waiting, true);
    assert.equal('waitSeconds' in r, false);
  });

  test('extracts JSON from surrounding prose', () => {
    const r = parseGoalEvaluation(
      'Here is my judgment:\n{"met": true, "impossible": false, "progress": true, "waiting": false, "reason": "all pass"}\nDone.',
    );
    assert.equal(r.met, true);
  });

  test('missing fields default to false', () => {
    const r = parseGoalEvaluation('{"met": true}');
    assert.equal(r.met, true);
    assert.equal(r.impossible, false);
    assert.equal(r.progress, false);
    assert.equal(r.waiting, false);
    assert.equal(r.reason, 'No reason provided');
  });

  test('unparseable output → neutral evaluator failure (not real no-progress)', () => {
    const r = parseGoalEvaluation('I cannot determine this');
    assert.equal(r.met, false);
    assert.equal(r.progress, false);
    assert.equal(r.evaluatorFailed, true);
    assert.ok(r.reason.includes('unparseable'));
  });

  test('malformed JSON → neutral evaluator failure', () => {
    const r = parseGoalEvaluation('{met: true, broken}');
    assert.equal(r.met, false);
    assert.equal(r.evaluatorFailed, true);
    assert.ok(r.reason.includes('parse failed'));
  });

  test('braces inside reason → treated as neutral, not false no-progress', () => {
    // A coding-goal judge whose reason references code can defeat the flat regex.
    const r = parseGoalEvaluation(
      '{"met":false,"progress":true,"reason":"add return {} to handler"}',
    );
    // Either it parses (progress true) or it fails neutrally — never a real
    // progress=false that would count toward stall.
    if (r.evaluatorFailed) {
      assert.equal(r.progress, false);
    } else {
      assert.equal(r.progress, true);
    }
  });

  test('truncates long reason', () => {
    const long = 'x'.repeat(300);
    const r = parseGoalEvaluation(`{"met": false, "reason": "${long}"}`);
    assert.ok(r.reason.length <= 200);
  });
});

describe('evaluateGoal', () => {
  test('returns parsed verdict on success', async () => {
    const r = await evaluateGoal(
      { evaluate: async () => '{"met": true, "progress": true, "reason": "done"}' },
      'finish',
      'ctx',
      'sess-1',
    );
    assert.equal(r.met, true);
    assert.equal(r.reason, 'done');
  });

  test('fails open on evaluator error (evaluatorFailed=true, continue)', async () => {
    const r = await evaluateGoal(
      {
        evaluate: async () => {
          throw new Error('network');
        },
      },
      'finish',
      'ctx',
      'sess-1',
    );
    assert.equal(r.met, false);
    assert.equal(r.impossible, false);
    assert.equal(r.progress, false);
    assert.equal(r.evaluatorFailed, true);
    assert.ok(r.reason.includes('failed'));
  });

  test('does not fail open on a typed fatal evaluator rejection', async () => {
    const cause = new Error('post-cut Store completion failed');
    const fatal = new GoalEvaluatorFatalError('Goal evaluator entered fail-stop', cause);
    await assert.rejects(
      () =>
        evaluateGoal(
          {
            evaluate: async () => {
              throw fatal;
            },
          },
          'finish',
          'ctx',
          'sess-1',
        ),
      (error: unknown) => error === fatal,
    );
  });

  test('waits for responsive generation and transport cleanup before timeout verdict', async () => {
    let evaluatorSignal: AbortSignal | undefined;
    let abortObserved = false;
    let transportClosed = false;
    const r = await evaluateGoal(
      {
        evaluate: async (_prompt, _sessionId, signal) => {
          assert.ok(signal);
          evaluatorSignal = signal;
          try {
            await new Promise<void>((_resolve, reject) => {
              signal.addEventListener(
                'abort',
                () => {
                  abortObserved = signal.aborted;
                  reject(new Error('aborted'));
                },
                { once: true },
              );
            });
            return '';
          } finally {
            await new Promise((resolve) => setTimeout(resolve, 5));
            transportClosed = true;
          }
        },
        timeoutMs: 10,
        abortCleanupGraceMs: 100,
      },
      'finish',
      'ctx',
      'sess-1',
    );
    assert.equal(r.met, false);
    assert.equal(r.progress, false);
    assert.equal(r.evaluatorFailed, true);
    assert.ok(r.reason.includes('timed out'));
    assert.equal(evaluatorSignal?.aborted, true);
    assert.equal(abortObserved, true);
    assert.equal(transportClosed, true);
  });

  test('returns after cleanup grace when the aborted evaluator does not settle', async () => {
    let evaluatorSignal: AbortSignal | undefined;
    const startedAt = Date.now();
    const r = await evaluateGoal(
      {
        evaluate: (_prompt, _sessionId, signal) => {
          assert.ok(signal);
          evaluatorSignal = signal;
          return new Promise<string>(() => {});
        },
        timeoutMs: 5,
        abortCleanupGraceMs: 30,
      },
      'finish',
      'ctx',
      'sess-1',
    );
    const elapsedMs = Date.now() - startedAt;
    assert.equal(r.evaluatorFailed, true);
    assert.ok(r.reason.includes('timed out'));
    assert.equal(evaluatorSignal?.aborted, true);
    assert.ok(elapsedMs >= 25, `cleanup grace returned too early after ${elapsedMs}ms`);
    assert.ok(elapsedMs < 500, `cleanup grace did not bound the wait (${elapsedMs}ms)`);
  });

  test('does not abort an evaluator that completes normally', async () => {
    let evaluatorSignal: AbortSignal | undefined;
    const r = await evaluateGoal(
      {
        evaluate: async (_prompt, _sessionId, signal) => {
          assert.ok(signal);
          evaluatorSignal = signal;
          await Promise.resolve();
          assert.equal(signal.aborted, false);
          return '{"met": true, "reason": "done"}';
        },
        timeoutMs: 10,
      },
      'finish',
      'ctx',
      'sess-1',
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(r.met, true);
    assert.equal(evaluatorSignal?.aborted, false);
  });

  test('successful parse sets evaluatorFailed=false', async () => {
    const r = await evaluateGoal(
      { evaluate: async () => '{"met": false, "progress": true, "reason": "ok"}' },
      'finish',
      'ctx',
      'sess-1',
    );
    assert.equal(r.evaluatorFailed, false);
  });

  test('clears the timeout timer on success', async () => {
    let cleared = false;
    await evaluateGoal(
      {
        evaluate: async () => '{"met": true, "reason": "ok"}',
        setTimeout: () => 42,
        clearTimeout: (h) => {
          cleared = h === 42;
        },
      },
      'finish',
      'ctx',
      'sess-1',
    );
    assert.equal(cleared, true);
  });

  test('threads the sessionId into the evaluator (session-model routing)', async () => {
    let seenSessionId: string | undefined;
    await evaluateGoal(
      {
        evaluate: async (_prompt, sessionId) => {
          seenSessionId = sessionId;
          return '{"met": true, "reason": "ok"}';
        },
      },
      'finish',
      'ctx',
      'sess-42',
    );
    assert.equal(seenSessionId, 'sess-42');
  });
});
