import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, test } from 'node:test';

describe('maka improved prompt v2', () => {
  test('keeps the stop-and-validate contract explicit', async () => {
    const prompt = await readFile(
      new URL('../../harbor/maka-improved-prompt-v2.txt', import.meta.url),
      'utf8',
    );

    assertV2PromptContract(prompt);
  });

  test('contract rejects wording that reintroduces the observed timeout risks', () => {
    const base = [
      'Use relative paths only, such as "out.html".',
      'Absolute paths are not allowed.',
      'Do not run evaluator, grader, hidden-test, or scoring scripts.',
      'Do not create extra files unless the task requires them.',
      'Run the smallest meaningful check that exercises the changed path.',
      'An existing successful validation signal is enough.',
      'Do not run extra checks only to restate a result you already validated.',
      'If a final read or check fails after earlier validation succeeded, stop.',
      'Mention the earlier validation and the failed extra check instead of trying new confirmations.',
      'Avoid broad test suites.',
    ].join('\n');

    assertV2PromptContract(base);
    assert.throws(
      () =>
        assertV2PromptContract(
          base.replace('Use relative paths only, such as "out.html".', 'Use /app/out.html.'),
        ),
      /relative paths/,
    );
    assert.throws(
      () =>
        assertV2PromptContract(
          base.replace(
            'Do not run evaluator, grader, hidden-test, or scoring scripts.',
            'Run evaluator scripts before finishing.',
          ),
        ),
      /evaluator/,
    );
    assert.throws(
      () =>
        assertV2PromptContract(
          base.replace(
            'Do not create extra files unless the task requires them.',
            'Create extra notes files before finishing.',
          ),
        ),
      /extra files/,
    );
    assert.throws(
      () =>
        assertV2PromptContract(
          base.replace(
            'An existing successful validation signal is enough.',
            'Always validate again before finishing.',
          ),
        ),
      /existing successful validation signal/,
    );
    assert.throws(
      () =>
        assertV2PromptContract(
          base.replace(
            'If a final read or check fails after earlier validation succeeded, stop.',
            'If a final read or check fails, try new confirmations.',
          ),
        ),
      /failed final check/,
    );
  });
});

function assertV2PromptContract(prompt: string): void {
  assert.match(prompt, /relative paths only/i, 'must require relative paths');
  assert.match(prompt, /out\.html/i, 'must include a concrete relative artifact example');
  assert.match(prompt, /absolute paths are not allowed/i, 'must ban absolute paths');
  assert.doesNotMatch(prompt, /\/app\//i, 'must not suggest absolute /app paths');
  assert.match(
    prompt,
    /do not run evaluator, grader, hidden-test, or scoring scripts/i,
    'must ban evaluator-like checks',
  );
  assert.match(
    prompt,
    /do not create extra files unless the task requires them/i,
    'must ban extra files',
  );
  assert.match(prompt, /smallest meaningful check/i, 'must require the smallest meaningful check');
  assert.match(prompt, /avoid broad test suites/i, 'must discourage broad tests');
  assert.match(
    prompt,
    /existing successful validation signal is enough/i,
    'must allow reusing an existing successful validation signal',
  );
  assert.match(
    prompt,
    /do not run extra checks/i,
    'must ban extra checks that only restate prior validation',
  );
  assert.match(
    prompt,
    /final read or check fails after earlier validation succeeded, stop/i,
    'must stop after failed final check when earlier validation succeeded',
  );
  assert.match(
    prompt,
    /instead of trying new confirmations/i,
    'must not retry confirmations after failed final check',
  );
}
