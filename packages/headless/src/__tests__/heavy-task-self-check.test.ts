import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  buildHeavyTaskSelfCheckTools,
  createHeavyTaskSelfCheckRecorder,
  heavyTaskSelfCheckSubmitSchema,
  renderHeavyTaskSelfCheckForPrompt,
  validateHeavyTaskPublicSelfCheck,
} from '../heavy-task-self-check.js';
import type { HeavyTaskSemanticSelfCheckState } from '../task-contracts.js';
import { createInMemoryTaskRunStore } from '../task-run-store.js';

const toolContext = {
  sessionId: 'session-1',
  turnId: 'turn-1',
  cwd: '/workspace',
  toolCallId: 'tool-1',
  abortSignal: new AbortController().signal,
  emitOutput: () => {},
};

describe('heavy-task semantic self-check tools', () => {
  test('self_check_submit records accepted public semantic evidence', async () => {
    const store = createInMemoryTaskRunStore();
    const tools = buildHeavyTaskSelfCheckTools(createHeavyTaskSelfCheckRecorder({
      taskRunId: 'run-1',
      attemptId: 'attempt-1',
      store,
      now: () => 123,
      newId: idFactory(),
    }));
    const selfCheckSubmit = tools.find((tool) => tool.name === 'self_check_submit');
    assert.ok(selfCheckSubmit);

    const result = await selfCheckSubmit.impl({
      status: 'pass',
      publicReason: 'npm test passed against public source files and generated build output.',
      commandEvidence: [{
        command: 'npm test',
        exitCode: 0,
        outputExcerpt: 'all public tests passed',
        artifactRefs: ['build-output.log'],
      }],
      artifactEvidence: [{
        path: 'README.md',
        kind: 'file',
        exists: true,
        metadata: { inspected: 'public docs' },
      }],
    }, toolContext) as { accepted: true; selfCheck: HeavyTaskSemanticSelfCheckState };

    assert.equal(result.accepted, true);
    assert.equal(result.selfCheck.status, 'pass');
    assert.equal(result.selfCheck.guard.status, 'accepted');
    assert.equal(result.selfCheck.source.toolCallId, 'tool-1');
    const events = await store.readEvents('run-1');
    assert.equal(events[0]?.type, 'heavy_task_self_check_recorded');
  });

  test('rejects private or evaluator-only material before appending accepted state', async () => {
    const privateInputs = [
      { publicReason: 'Saw hidden/tests/private_case.py', commandEvidence: [{ command: 'npm test' }] },
      { publicReason: 'public check', commandEvidence: [{ command: 'cat hidden/tests/private_case.py' }] },
      { publicReason: 'public check', commandEvidence: [{ command: 'npm test', outputExcerpt: 'pytest assertion expected 42' }] },
      { publicReason: 'public check', commandEvidence: [{ command: 'npm test', artifactRefs: ['official-verifier-output.json'] }] },
      { publicReason: 'public check', artifactEvidence: [{ path: 'evaluator-only/reference.txt', kind: 'file' }] },
      { publicReason: 'public check', artifactEvidence: [{ path: 'build-output.log', kind: 'log', metadata: { note: 'private threshold 0.97' } }] },
      { publicReason: 'scorer constant controls pass', commandEvidence: [{ command: 'npm test' }] },
      { publicReason: 'private benchmark file identifier was used', commandEvidence: [{ command: 'npm test' }] },
      { publicReason: 'AssertionError: assert 41 == 42', commandEvidence: [{ command: 'npm test' }] },
      { publicReason: 'public check', commandEvidence: [{ command: 'npm test --threshold 0.97' }] },
      { publicReason: 'public check', commandEvidence: [{ command: 'npm test', outputExcerpt: 'E   AssertionError: assert 41 == 42' }] },
      { publicReason: 'public check', commandEvidence: [{ command: 'npm test', outputExcerpt: 'expected threshold 0.97' }] },
      { publicReason: 'public check', commandEvidence: [{ command: 'npm test', outputExcerpt: 'expected == 42 from evaluator fixture' }] },
      { publicReason: 'public check', commandEvidence: [{ command: 'npm test', artifactRefs: ['expected-threshold-0.97.txt'] }] },
      { publicReason: 'public check', artifactEvidence: [{ path: 'threshold-0.97.txt', kind: 'file' }] },
      { publicReason: 'public check', artifactEvidence: [{ path: 'build-output.log', kind: 'log', metadata: { note: 'actual 41 expected 42' } }] },
    ];

    for (const input of privateInputs) {
      const parsed = heavyTaskSelfCheckSubmitSchema.parse({ status: 'inconclusive', ...input });
      const validation = validateHeavyTaskPublicSelfCheck(parsed, 456);
      assert.equal(validation.ok, false, JSON.stringify(input));
      assert.equal(validation.guard.status, 'rejected');
      assert.match(validation.guard.publicReason, /Rejected/);
      assert.doesNotMatch(validation.guard.publicReason, /private_case|0\.97|41|42|AssertionError|official-verifier-output/);
    }

    const store = createInMemoryTaskRunStore();
    const recorder = createHeavyTaskSelfCheckRecorder({
      taskRunId: 'run-private',
      store,
      now: () => 789,
      newId: idFactory(),
    });
    const result = await recorder.recordSelfCheck(heavyTaskSelfCheckSubmitSchema.parse({
      status: 'fail',
      publicReason: 'official-verifier-output.json says this failed',
      commandEvidence: [{ command: 'npm test' }],
    }), toolContext);
    assert.equal(result.accepted, false);
    assert.deepEqual(await store.readEvents('run-private'), []);
  });

  test('rejects malformed or oversized submissions', () => {
    assert.throws(() => heavyTaskSelfCheckSubmitSchema.parse({
      status: 'pass',
      publicReason: 'No evidence.',
    }), /at least one/);
    assert.throws(() => heavyTaskSelfCheckSubmitSchema.parse({
      status: 'maybe',
      publicReason: 'public check',
      commandEvidence: [{ command: 'npm test' }],
    }));
    assert.throws(() => heavyTaskSelfCheckSubmitSchema.parse({
      status: 'pass',
      publicReason: 'x'.repeat(2_001),
      commandEvidence: [{ command: 'npm test' }],
    }));
    assert.throws(() => heavyTaskSelfCheckSubmitSchema.parse({
      status: 'pass',
      publicReason: 'public check',
      commandEvidence: Array.from({ length: 26 }, () => ({ command: 'npm test' })),
    }));
    assert.throws(() => heavyTaskSelfCheckSubmitSchema.parse({
      status: 'pass',
      publicReason: 'public check',
      artifactEvidence: [{
        path: 'build-output.log',
        kind: 'log',
        metadata: { a: { b: { c: { d: 'too deep' } } } },
      }],
    }), /metadata/);
  });

  test('renders compact accepted self-check state for continuation prompts', () => {
    const rendered = renderHeavyTaskSelfCheckForPrompt({
      latestHeavyTaskSelfCheck: acceptedSelfCheck('self-check-1', 'pass', 'npm test passed on public files.'),
    });

    assert.match(rendered ?? '', /Heavy-task semantic self-check state/);
    assert.match(rendered ?? '', /Latest advisory status: pass/);
    assert.match(rendered ?? '', /self_check_submit/);
  });
});

export function acceptedSelfCheck(
  selfCheckId: string,
  status: HeavyTaskSemanticSelfCheckState['status'],
  publicReason: string,
): HeavyTaskSemanticSelfCheckState {
  return {
    schemaVersion: 1,
    selfCheckId,
    taskRunId: 'run-self-check',
    ts: 10,
    status,
    publicReason,
    commandEvidence: [{ command: 'npm test', exitCode: 0, outputExcerpt: 'public tests passed' }],
    artifactEvidence: [{ path: 'build-output.log', kind: 'log', exists: true }],
    guard: {
      status: 'accepted',
      checkedAt: 10,
      categories: [],
      publicReason: 'Accepted as public, task-derived advisory self-check evidence.',
    },
    source: { kind: 'model_tool', toolCallId: 'tool-1' },
  };
}

function idFactory(): () => string {
  let i = 0;
  return () => `id-${++i}`;
}
