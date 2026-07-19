import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  canonicalRsiTokenList,
  hashRsiHeldInTaskSet,
  isRsiR2FailurePattern,
  promptSafeToken,
  validateRsiPromptText,
} from '../rsi-r2-safety.js';

describe('RSI R2 safety primitives', () => {
  test('recognizes only the R2 failure patterns that candidate rationales may cite', () => {
    assert.equal(isRsiR2FailurePattern('coverage_regression'), true);
    assert.equal(isRsiR2FailurePattern('tool_failed'), true);
    assert.equal(isRsiR2FailurePattern('held_out_regressed'), false);
    assert.equal(isRsiR2FailurePattern('verification_failed\nheld_out_regressed'), false);
  });

  test('sanitizes trace-derived prompt tokens with a safe fallback', () => {
    assert.equal(promptSafeToken('Bash.exec-1:ok', 'fallback'), 'Bash.exec-1:ok');
    assert.equal(promptSafeToken('tool with spaces', 'fallback'), 'fallback');
    assert.equal(promptSafeToken('x'.repeat(65), 'fallback'), 'fallback');
    assert.equal(promptSafeToken('工具', 'fallback'), 'fallback');
    assert.throws(
      () => promptSafeToken('tool with spaces', 'bad fallback'),
      /fallback must be prompt-safe/i,
    );
    assert.throws(
      () => promptSafeToken(123 as unknown as string, 'fallback'),
      /value must be prompt-safe/i,
    );
    assert.throws(
      () => promptSafeToken('tool with spaces', 123 as unknown as string),
      /fallback must be prompt-safe/i,
    );
  });

  test('validates bounded prompt text before it can become durable feedback', () => {
    assert.equal(
      validateRsiPromptText('  investigate repeated Bash timeouts  ', {
        fieldName: 'hypothesis',
        maxChars: 80,
      }),
      'investigate repeated Bash timeouts',
    );

    assert.throws(
      () =>
        validateRsiPromptText('held_out_regressed on hidden task', {
          fieldName: 'hypothesis',
          maxChars: 80,
        }),
      /hypothesis contains forbidden held_out/i,
    );
    assert.throws(
      () =>
        validateRsiPromptText('```raw trace```', {
          fieldName: 'hypothesis',
          maxChars: 80,
        }),
      /hypothesis contains forbidden code_fence/i,
    );
    for (const unsafe of [
      '/app/tests/test.sh',
      'runtime-events.jsonl',
      'resultsJsonlPath',
      'results.tsv',
    ]) {
      assert.throws(
        () =>
          validateRsiPromptText(unsafe, {
            fieldName: 'hypothesis',
            maxChars: 80,
          }),
        /hypothesis contains forbidden/i,
      );
    }
    assert.throws(
      () =>
        validateRsiPromptText('line one\nline two', {
          fieldName: 'hypothesis',
          maxChars: 80,
        }),
      /hypothesis must be single-line/i,
    );
    assert.throws(
      () =>
        validateRsiPromptText('x'.repeat(81), {
          fieldName: 'hypothesis',
          maxChars: 80,
        }),
      /hypothesis exceeds 80 chars/i,
    );
  });

  test('canonicalizes bounded token lists for evidence refs and task ids', () => {
    assert.deepEqual(
      canonicalRsiTokenList(['task-b', 'task-a', 'task-b'], {
        fieldName: 'predictedFixes',
        maxItems: 4,
      }),
      ['task-a', 'task-b'],
    );
    assert.deepEqual(
      canonicalRsiTokenList(['task_a', 'task-a', 'task.A', 'task:a', 'Task-a', 'task-A'], {
        fieldName: 'evidenceRefs',
        maxItems: 6,
      }),
      ['Task-a', 'task-A', 'task-a', 'task.A', 'task:a', 'task_a'],
    );

    assert.throws(
      () =>
        canonicalRsiTokenList(['task-a', 'task-b', 'task-c'], {
          fieldName: 'riskTasks',
          maxItems: 2,
        }),
      /riskTasks exceeds 2 items/i,
    );
    assert.throws(
      () =>
        canonicalRsiTokenList(Array(100).fill('task-a'), {
          fieldName: 'riskTasks',
          maxItems: 2,
        }),
      /riskTasks exceeds 2 items/i,
    );
    assert.throws(
      () =>
        canonicalRsiTokenList(['task a'], {
          fieldName: 'evidenceRefs',
          maxItems: 4,
        }),
      /evidenceRefs\[0\] must be prompt-safe/i,
    );
    for (const unsafe of [123, true, {}]) {
      assert.throws(
        () =>
          canonicalRsiTokenList([unsafe as unknown as string], {
            fieldName: 'evidenceRefs',
            maxItems: 4,
          }),
        /evidenceRefs\[0\] must be prompt-safe/i,
      );
    }
  });

  test('hashes held-in task sets independent of order while rejecting unsafe ids', () => {
    assert.equal(
      hashRsiHeldInTaskSet(['task-b', 'task-a']),
      hashRsiHeldInTaskSet(['task-a', 'task-b']),
    );
    assert.notEqual(
      hashRsiHeldInTaskSet(['task-a', 'task-b']),
      hashRsiHeldInTaskSet(['task-a', 'task-c']),
    );
    assert.equal(
      hashRsiHeldInTaskSet(['task_a', 'task-a', 'task.A', 'task:a', 'Task-a', 'task-A']),
      'sha256:afb9a3f239bb32247e4d013a0249f11cca97d3ba192710080ed43a7dce9089d0',
    );
    assert.match(hashRsiHeldInTaskSet(['task-a']), /^sha256:[a-f0-9]{64}$/);
    assert.throws(
      () => hashRsiHeldInTaskSet(['held out task']),
      /heldInTaskIds\[0\] must be prompt-safe/i,
    );
  });
});
