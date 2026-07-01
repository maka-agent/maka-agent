import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import type { MetaAgent } from '../prompt-candidate-loop.js';
import {
  CONTROL_RULE_MARKER,
  runPromptControlExperiment,
} from '../prompt-control-run.js';

describe('runPromptControlExperiment', () => {
  test('keeps a prompt that learns the held-in control rule and passes held-out', async () => {
    await withDir(async (dir) => {
      const metaAgentInputs: string[] = [];
      const metaAgent: MetaAgent = async (input) => {
        metaAgentInputs.push(input.resultsTsv);
        const learnedFromHeldIn = input.resultsTsv.includes(`missing_${CONTROL_RULE_MARKER}`);
        const signal = input.rsiAnalysis?.signals[0];
        return {
          systemPrompt: learnedFromHeldIn
            ? `${input.currentSystemPrompt.trimEnd()}\nAlways include ${CONTROL_RULE_MARKER} when solving control benchmark tasks.\n`
            : input.currentSystemPrompt,
          summary: learnedFromHeldIn ? 'added the missing control rule' : 'no control signal found',
          candidateRationale: {
            failurePattern: signal ? 'verification_failed' : 'other',
            evidenceRefs: signal ? [signal.id] : [],
            hypothesis: 'held-in failures share one missing prompt rule',
            targetedFix: 'add the shared rule without task-specific answers',
            predictedFixes: ['control-held-in-a', 'control-held-in-b'],
            riskTasks: [],
          },
        };
      };

      const result = await runPromptControlExperiment({
        runId: 'control-test',
        runRoot: join(dir, 'control-test'),
        apiKeyFile: join(dir, 'missing-key'),
        metaAgent,
        now: (() => {
          let clock = 0;
          return () => (clock += 1);
        })(),
        newId: (() => {
          let id = 0;
          return () => `id-${(id += 1)}`;
        })(),
      });

      assert.equal(metaAgentInputs.length, 1);
      assert.match(metaAgentInputs[0] ?? '', new RegExp(`missing_${CONTROL_RULE_MARKER}`));
      assert.equal(result.accepted, true);
      assert.equal(result.learnedRulePresent, true);
      assert.equal(result.decision?.decision, 'keep');
      assert.equal(result.decision?.reason, 'held_in_improved');
      assert.equal(result.heldInBefore.passEligibleRate, 0);
      assert.equal(result.heldInAfter.passEligibleRate, 1);
      assert.equal(result.heldOutAfter.passEligibleRate, 1);
      assert.equal(result.loopResult.keptCount, 1);

      const json = JSON.parse(await readFile(result.resultPath, 'utf8')) as {
        learnedRulePresent?: unknown;
        accepted?: unknown;
      };
      assert.equal(json.learnedRulePresent, true);
      assert.equal(json.accepted, true);

      const report = await readFile(result.reportPath, 'utf8');
      assert.match(report, new RegExp(CONTROL_RULE_MARKER));
      assert.match(report, /held-out after: 1/);
    });
  });
});

async function withDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'maka-prompt-control-'));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
