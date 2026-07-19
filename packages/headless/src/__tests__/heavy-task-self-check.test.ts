import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  auditSelfCheckPlanConsistency,
  buildHeavyTaskSelfCheckTools,
  createHeavyTaskSelfCheckRecorder,
  heavyTaskSelfCheckPlanSubmitSchema,
  heavyTaskSelfCheckSubmitSchema,
  renderHeavyTaskSelfCheckForPrompt,
  validateHeavyTaskPublicSelfCheck,
  validateHeavyTaskPublicSelfCheckPlan,
  type HeavyTaskSelfCheckPlanSubmitInput,
} from '../heavy-task-self-check.js';
import type {
  HeavyTaskSelfCheckPlanState,
  HeavyTaskSemanticSelfCheckState,
  HeavyTaskSourceGuardResult,
} from '../task-contracts.js';
import { createInMemoryTaskRunStore, projectTaskRun } from '../task-run-store.js';

const toolContext = {
  sessionId: 'session-1',
  turnId: 'turn-1',
  cwd: '/workspace',
  toolCallId: 'tool-1',
  abortSignal: new AbortController().signal,
  emitOutput: () => {},
};

describe('heavy-task semantic self-check tools', () => {
  test('self_check_plan_submit records accepted public plan state', async () => {
    const store = createInMemoryTaskRunStore();
    const tools = buildHeavyTaskSelfCheckTools(
      createHeavyTaskSelfCheckRecorder({
        taskRunId: 'run-plan',
        attemptId: 'attempt-1',
        store,
        now: () => 111,
        newId: idFactory(),
      }),
    );
    const planSubmit = tools.find((tool) => tool.name === 'self_check_plan_submit');
    assert.ok(planSubmit);

    const result = (await planSubmit.impl(planInput(), toolContext)) as
      | { accepted: true; plan: HeavyTaskSelfCheckPlanState }
      | { accepted: false; guard: HeavyTaskSourceGuardResult & { status: 'rejected' } };

    assert.equal(result.accepted, true);
    assert.equal(
      result.accepted ? result.plan.finalArtifacts[0]?.path : undefined,
      '/app/move.txt',
    );
    assert.equal(result.accepted ? result.plan.guard.status : undefined, 'accepted');
    const events = await store.readEvents('run-plan');
    assert.equal(events[0]?.type, 'heavy_task_self_check_plan_recorded');
    const projection = projectTaskRun(events, 'run-plan');
    assert.equal(
      projection.latestHeavyTaskSelfCheckPlan?.planId,
      result.accepted ? result.plan.planId : undefined,
    );
    assert.equal(projection.heavyTaskSelfCheckPlans.length, 1);
  });

  test('self_check_submit records accepted public semantic evidence', async () => {
    const store = createInMemoryTaskRunStore();
    const tools = buildHeavyTaskSelfCheckTools(
      createHeavyTaskSelfCheckRecorder({
        taskRunId: 'run-1',
        attemptId: 'attempt-1',
        store,
        now: () => 123,
        newId: idFactory(),
      }),
    );
    const selfCheckSubmit = tools.find((tool) => tool.name === 'self_check_submit');
    assert.ok(selfCheckSubmit);

    const result = (await selfCheckSubmit.impl(
      {
        status: 'pass',
        publicReason: 'npm test passed against public source files and generated build output.',
        commandEvidence: [
          {
            command: 'npm test',
            exitCode: 0,
            outputExcerpt: 'all public tests passed',
            artifactRefs: ['build-output.log'],
          },
        ],
        artifactEvidence: [
          {
            path: 'README.md',
            kind: 'file',
            exists: true,
            metadata: { inspected: 'public docs' },
          },
        ],
        executionHygiene: {
          sandbox: {
            root: '/tmp/maka-self-check/run-1',
            strategy: 'copied_inputs',
            inputPaths: ['/app/polyglot/main.py.c'],
            commandCwd: '/tmp/maka-self-check/run-1',
            outputPolicy: 'scratch_only',
            publicReason:
              'public inputs were copied into the sandbox and generated outputs stayed there',
          },
          scratchUsed: true,
          scratchPath: '/tmp/maka-self-check-1',
          cleanupPerformed: true,
          workspaceSideEffects: 'none',
          workspaceGuard: {
            checked: true,
            checkedPaths: ['/app/polyglot'],
            beforeListingCommand: 'find /app/polyglot -maxdepth 1 -type f | sort',
            afterListingCommand: 'find /app/polyglot -maxdepth 1 -type f | sort',
            addedPaths: [],
            modifiedPaths: [],
            removedPaths: [],
            publicReason: 'public listing showed no added deliverable files after cleanup',
          },
          publicReason:
            'temporary compile artifacts stayed under scratch and no deliverable files were left behind',
        },
      },
      { ...toolContext, runId: 'agent-run-1' },
    )) as { accepted: true; selfCheck: HeavyTaskSemanticSelfCheckState };

    assert.equal(result.accepted, true);
    assert.equal(result.selfCheck.status, 'pass');
    assert.equal(result.selfCheck.guard.status, 'accepted');
    assert.equal(result.selfCheck.source.toolCallId, 'tool-1');
    assert.equal(result.selfCheck.source.agentRunId, 'agent-run-1');
    assert.equal(result.selfCheck.executionHygiene?.sandbox?.root, '/tmp/maka-self-check/run-1');
    assert.equal(result.selfCheck.executionHygiene?.scratchUsed, true);
    assert.equal(result.selfCheck.executionHygiene?.workspaceSideEffects, 'none');
    assert.equal(result.selfCheck.executionHygiene?.workspaceGuard?.checked, true);
    const events = await store.readEvents('run-1');
    assert.equal(events[0]?.type, 'heavy_task_self_check_recorded');
  });

  test('rejects private or evaluator-only material before appending accepted state', async () => {
    const privateInputs = [
      {
        publicReason: 'Saw hidden/tests/private_case.py',
        commandEvidence: [{ command: 'npm test' }],
      },
      {
        publicReason: 'public check',
        commandEvidence: [{ command: 'cat hidden/tests/private_case.py' }],
      },
      {
        publicReason: 'public check',
        commandEvidence: [{ command: 'npm test', outputExcerpt: 'pytest assertion expected 42' }],
      },
      {
        publicReason: 'public check',
        commandEvidence: [{ command: 'npm test', artifactRefs: ['official-verifier-output.json'] }],
      },
      {
        publicReason: 'public check',
        artifactEvidence: [{ path: 'evaluator-only/reference.txt', kind: 'file' }],
      },
      {
        publicReason: 'public check',
        artifactEvidence: [
          { path: 'build-output.log', kind: 'log', metadata: { note: 'private threshold 0.97' } },
        ],
      },
      { publicReason: 'scorer constant controls pass', commandEvidence: [{ command: 'npm test' }] },
      {
        publicReason: 'private benchmark file identifier was used',
        commandEvidence: [{ command: 'npm test' }],
      },
      {
        publicReason: 'AssertionError: assert 41 == 42',
        commandEvidence: [{ command: 'npm test' }],
      },
      { publicReason: 'public check', commandEvidence: [{ command: 'npm test --threshold 0.97' }] },
      {
        publicReason: 'public check',
        commandEvidence: [
          { command: 'npm test', outputExcerpt: 'E   AssertionError: assert 41 == 42' },
        ],
      },
      {
        publicReason: 'public check',
        commandEvidence: [{ command: 'npm test', outputExcerpt: 'expected threshold 0.97' }],
      },
      {
        publicReason: 'public check',
        commandEvidence: [
          { command: 'npm test', outputExcerpt: 'expected == 42 from evaluator fixture' },
        ],
      },
      {
        publicReason: 'public check',
        commandEvidence: [{ command: 'npm test', artifactRefs: ['expected-threshold-0.97.txt'] }],
      },
      {
        publicReason: 'public check',
        artifactEvidence: [{ path: 'threshold-0.97.txt', kind: 'file' }],
      },
      {
        publicReason: 'public check',
        artifactEvidence: [
          { path: 'build-output.log', kind: 'log', metadata: { note: 'actual 41 expected 42' } },
        ],
      },
      {
        publicReason: 'public check',
        commandEvidence: [{ command: 'npm test' }],
        executionHygiene: { scratchUsed: true, scratchPath: 'hidden/tests/scratch' },
      },
      {
        publicReason: 'public check',
        commandEvidence: [{ command: 'npm test' }],
        executionHygiene: { remainingSideEffectPaths: ['official-verifier-output.json'] },
      },
      {
        publicReason: 'public check',
        commandEvidence: [{ command: 'npm test' }],
        executionHygiene: {
          workspaceGuard: { checked: true, addedPaths: ['hidden/tests/leak.log'] },
        },
      },
      {
        publicReason: 'public check',
        commandEvidence: [{ command: 'npm test' }],
        executionHygiene: {
          workspaceGuard: { beforeListingCommand: 'find official-verifier-output.json' },
        },
      },
      {
        publicReason: 'public check',
        commandEvidence: [{ command: 'npm test' }],
        executionHygiene: { sandbox: { root: 'hidden/tests/sandbox' } },
      },
      {
        publicReason: 'public check',
        commandEvidence: [{ command: 'npm test' }],
        executionHygiene: {
          sandbox: { root: '/tmp/maka-self-check', inputPaths: ['official-verifier-output.json'] },
        },
      },
    ];

    for (const input of privateInputs) {
      const parsed = heavyTaskSelfCheckSubmitSchema.parse({ status: 'inconclusive', ...input });
      const validation = validateHeavyTaskPublicSelfCheck(parsed, 456);
      assert.equal(validation.ok, false, JSON.stringify(input));
      assert.equal(validation.guard.status, 'rejected');
      assert.match(validation.guard.publicReason, /Rejected/);
      assert.doesNotMatch(
        validation.guard.publicReason,
        /private_case|0\.97|41|42|AssertionError|official-verifier-output/,
      );
    }

    const store = createInMemoryTaskRunStore();
    const recorder = createHeavyTaskSelfCheckRecorder({
      taskRunId: 'run-private',
      store,
      now: () => 789,
      newId: idFactory(),
    });
    const result = await recorder.recordSelfCheck(
      heavyTaskSelfCheckSubmitSchema.parse({
        status: 'fail',
        publicReason: 'official-verifier-output.json says this failed',
        commandEvidence: [{ command: 'npm test' }],
      }),
      toolContext,
    );
    assert.equal(result.accepted, false);
    assert.deepEqual(await store.readEvents('run-private'), []);
  });

  test('self_check_plan_submit source guard rejects private or evaluator-only material in all plan fields', () => {
    const privatePlans = [
      { publicReason: 'hidden tests informed this plan' },
      {
        finalArtifacts: [
          {
            path: '/app/move.txt',
            purpose: 'private scoring criteria',
            publicReason: 'public task requires it',
          },
        ],
      },
      {
        selfCheckScratch: {
          root: '/tmp/maka-self-check',
          expectedGeneratedPaths: ['official-verifier-output.json'],
          publicReason: 'public scratch',
        },
      },
      {
        workspaceGuardPlan: {
          checkedPaths: ['/app'],
          expectedAddedPaths: ['hidden/tests/leak.txt'],
          publicReason: 'public guard',
        },
      },
      {
        workspaceGuardPlan: {
          checkedPaths: ['/app'],
          expectedGeneratedPathsOutsideScratch: ['/app/out'],
          publicReason: 'evaluator-only fixture mentioned it',
        },
      },
    ];

    for (const override of privatePlans) {
      const parsed = heavyTaskSelfCheckPlanSubmitSchema.parse(planInput(override));
      const validation = validateHeavyTaskPublicSelfCheckPlan(parsed, 222);
      assert.equal(validation.ok, false, JSON.stringify(override));
      assert.equal(validation.guard.status, 'rejected');
      assert.doesNotMatch(
        validation.guard.publicReason,
        /official-verifier-output|private scoring criteria|evaluator-only fixture|leak\.txt/,
      );
    }
  });

  test('audits planned additions separately from unplanned scratch escapes', () => {
    const plan = {
      schemaVersion: 1 as const,
      planId: 'plan-1',
      taskRunId: 'run-self-check',
      ts: 1,
      ...planInput(),
      guard: {
        status: 'accepted' as const,
        checkedAt: 1,
        categories: [],
        publicReason: 'Accepted as public, task-derived advisory self-check plan.',
      },
      source: { kind: 'model_tool' as const, toolCallId: 'tool-plan' },
    };
    const planned = acceptedSelfCheck(
      'self-check-planned',
      'pass',
      'test -f /app/move.txt passed on public files.',
    );
    planned.executionHygiene = {
      ...planned.executionHygiene,
      workspaceGuard: {
        checked: true,
        checkedPaths: ['/app'],
        addedPaths: ['/app/move.txt'],
        modifiedPaths: [],
        removedPaths: [],
      },
    };
    planned.commandEvidence = [
      { command: 'test -f /app/move.txt', exitCode: 0, artifactRefs: ['/app/move.txt'] },
    ];
    planned.artifactEvidence = [{ path: '/app/move.txt', kind: 'file', exists: true }];

    const plannedAudit = auditSelfCheckPlanConsistency(plan, planned);
    assert.equal(plannedAudit.status, 'pass');
    assert.ok(plannedAudit.riskFlags.includes('planned_final_artifact_added'));
    assert.ok(!plannedAudit.riskFlags.includes('unplanned_added_path'));

    const readOnlyInput = acceptedSelfCheck(
      'self-check-readonly-input',
      'pass',
      'checked public input file.',
    );
    readOnlyInput.commandEvidence = [
      { command: 'python /app/input.py --check /app/move.txt', exitCode: 0 },
    ];
    readOnlyInput.artifactEvidence = [{ path: '/app/input.py', kind: 'file', exists: true }];
    const readOnlyAudit = auditSelfCheckPlanConsistency(plan, readOnlyInput);
    assert.equal(readOnlyAudit.status, 'pass');
    assert.ok(!readOnlyAudit.riskFlags.includes('scratch_escape'));

    const unplanned = acceptedSelfCheck(
      'self-check-unplanned',
      'pass',
      'compiled public source to /app/polyglot/cmain.',
    );
    unplanned.commandEvidence = [
      { command: 'cc /app/polyglot/main.py.c -o /app/polyglot/cmain', exitCode: 0 },
    ];
    unplanned.artifactEvidence = [
      { path: '/app/polyglot/cmain', kind: 'generated_output', exists: true },
    ];
    unplanned.executionHygiene = {
      ...unplanned.executionHygiene,
      workspaceGuard: {
        checked: true,
        checkedPaths: ['/app/polyglot'],
        addedPaths: ['/app/polyglot/cmain'],
        modifiedPaths: [],
        removedPaths: [],
      },
    };

    const unplannedAudit = auditSelfCheckPlanConsistency(plan, unplanned);
    assert.equal(unplannedAudit.status, 'fail');
    assert.ok(unplannedAudit.riskFlags.includes('unplanned_added_path'));
    assert.ok(unplannedAudit.riskFlags.includes('scratch_escape'));
    assert.match(unplannedAudit.diagnostics.join('\n'), /\/app\/polyglot\/cmain/);
  });

  test('rejects malformed or oversized submissions', () => {
    assert.throws(
      () =>
        heavyTaskSelfCheckSubmitSchema.parse({
          status: 'pass',
          publicReason: 'No evidence.',
        }),
      /at least one/,
    );
    assert.throws(() =>
      heavyTaskSelfCheckSubmitSchema.parse({
        status: 'maybe',
        publicReason: 'public check',
        commandEvidence: [{ command: 'npm test' }],
      }),
    );
    assert.throws(() =>
      heavyTaskSelfCheckSubmitSchema.parse({
        status: 'pass',
        publicReason: 'x'.repeat(2_001),
        commandEvidence: [{ command: 'npm test' }],
      }),
    );
    assert.throws(() =>
      heavyTaskSelfCheckSubmitSchema.parse({
        status: 'pass',
        publicReason: 'public check',
        commandEvidence: Array.from({ length: 26 }, () => ({ command: 'npm test' })),
      }),
    );
    assert.throws(
      () =>
        heavyTaskSelfCheckSubmitSchema.parse({
          status: 'pass',
          publicReason: 'public check',
          artifactEvidence: [
            {
              path: 'build-output.log',
              kind: 'log',
              metadata: { a: { b: { c: { d: 'too deep' } } } },
            },
          ],
        }),
      /metadata/,
    );
    assert.throws(() =>
      heavyTaskSelfCheckSubmitSchema.parse({
        status: 'pass',
        publicReason: 'public check',
        commandEvidence: [{ command: 'npm test' }],
        executionHygiene: {
          workspaceSideEffects: 'present',
          remainingSideEffectPaths: Array.from(
            { length: 21 },
            (_, index) => `/tmp/leftover-${index}`,
          ),
        },
      }),
    );
    assert.throws(() =>
      heavyTaskSelfCheckSubmitSchema.parse({
        status: 'pass',
        publicReason: 'public check',
        commandEvidence: [{ command: 'npm test' }],
        executionHygiene: {
          workspaceGuard: {
            checked: true,
            addedPaths: Array.from({ length: 21 }, (_, index) => `/app/generated-${index}`),
          },
        },
      }),
    );
  });

  test('renders compact accepted self-check state for continuation prompts', () => {
    const rendered = renderHeavyTaskSelfCheckForPrompt({
      latestHeavyTaskSelfCheck: acceptedSelfCheck(
        'self-check-1',
        'pass',
        'npm test passed on public files.',
      ),
    });

    assert.match(rendered ?? '', /Heavy-task semantic self-check state/);
    assert.match(rendered ?? '', /Latest advisory status: pass/);
    assert.match(rendered ?? '', /Self-check sandbox/);
    assert.match(rendered ?? '', /Self-check execution hygiene/);
    assert.match(rendered ?? '', /workspace guard/);
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
    executionHygiene: {
      sandbox: {
        root: '/tmp/maka-self-check',
        strategy: 'scratch_dir',
        commandCwd: '/tmp/maka-self-check',
        outputPolicy: 'scratch_only',
      },
      scratchUsed: true,
      scratchPath: '/tmp/maka-self-check',
      cleanupPerformed: true,
      workspaceSideEffects: 'none',
      workspaceGuard: {
        checked: true,
        checkedPaths: ['/app'],
        addedPaths: [],
        modifiedPaths: [],
        removedPaths: [],
      },
    },
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

function planInput(
  overrides: Partial<HeavyTaskSelfCheckPlanSubmitInput> = {},
): HeavyTaskSelfCheckPlanSubmitInput {
  const base: HeavyTaskSelfCheckPlanSubmitInput = {
    finalArtifacts: [
      {
        path: '/app/move.txt',
        purpose: 'final deliverable requested by the visible task',
        publicReason: 'visible task asks for this file',
      },
    ],
    selfCheckScratch: {
      root: '/tmp/maka-self-check/run-1',
      expectedGeneratedPaths: ['/tmp/maka-self-check/run-1/check.log'],
      publicReason: 'public checks write generated outputs under scratch',
    },
    workspaceGuardPlan: {
      checkedPaths: ['/app'],
      expectedAddedPaths: ['/app/move.txt'],
      expectedGeneratedPathsOutsideScratch: [],
      publicReason: 'public guard checks the deliverable directory',
    },
    publicReason: 'plan is derived from visible task files and public checks',
  };
  return {
    ...base,
    ...overrides,
    finalArtifacts: overrides.finalArtifacts ?? base.finalArtifacts,
    selfCheckScratch: { ...base.selfCheckScratch, ...overrides.selfCheckScratch },
    workspaceGuardPlan: { ...base.workspaceGuardPlan, ...overrides.workspaceGuardPlan },
  };
}
