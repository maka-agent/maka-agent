import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { Task } from '../contracts.js';
import {
  observeHeavyTaskWorkspace,
  parseWorkspaceObservation,
  workspaceManifestRevision,
} from '../heavy-task-workspace-observation.js';
import type { IsolatedCommandInput, IsolatedToolExecutor } from '../isolation.js';
import type { HeavyTaskSelfCheckPlanState, TaskEvent } from '../task-contracts.js';
import { projectTaskRun } from '../task-run-store.js';

describe('heavy-task workspace observation', () => {
  test('records machine-observed one-level entries for task artifact directories', async () => {
    const taskRunId = 'run-observe';
    const task: Task = {
      id: 'polyglot-task',
      instruction: 'Write me a single file in /app/polyglot/main.py.c which is a polyglot.',
      workspaceDir: '/tmp/workspace',
      verification: { command: 'true', protectedPaths: [] },
    };
    const plan: HeavyTaskSelfCheckPlanState = {
      schemaVersion: 1,
      planId: 'plan-1',
      taskRunId,
      ts: 2,
      finalArtifacts: [
        {
          path: '/app/polyglot/main.py.c',
          purpose: 'final polyglot source file',
          publicReason: 'accepted structured plan artifact',
        },
      ],
      selfCheckScratch: {
        root: '/tmp/maka-self-check/run-observe',
        expectedGeneratedPaths: ['/tmp/maka-self-check/run-observe/cmain'],
        publicReason: 'compile probes stay in scratch',
      },
      workspaceGuardPlan: {
        checkedPaths: ['/app/polyglot'],
        expectedAddedPaths: ['/app/polyglot/main.py.c'],
        expectedGeneratedPathsOutsideScratch: [],
        publicReason: 'observe the declared artifact directory',
      },
      publicReason: 'structured plan supplies artifact paths for observation',
      guard: {
        status: 'accepted',
        checkedAt: 2,
        categories: [],
        publicReason: 'Accepted as public, task-derived advisory self-check plan.',
      },
      source: { kind: 'model_tool', toolCallId: 'tool-plan' },
    };
    const projection = projectTaskRun(
      [
        { type: 'task_run_created', id: 'e1', taskRunId, ts: 1, taskId: task.id, configId: 'cfg' },
        { type: 'heavy_task_self_check_plan_recorded', id: 'e2', taskRunId, ts: 2, plan },
      ] satisfies TaskEvent[],
      taskRunId,
    );
    const seenCommands: IsolatedCommandInput[] = [];
    const executor: IsolatedToolExecutor = {
      async exec(input) {
        seenCommands.push(input);
        return {
          exitCode: 0,
          stdout: [
            'file\t/app/polyglot/main.py.c\t\t42\tabc123',
            'symlink\t/app/polyglot/main.py\tmain.py.c',
          ].join('\n'),
          stderr: '',
        };
      },
    };

    const event = await observeHeavyTaskWorkspace({
      taskRunId,
      projection,
      executor,
      cwd: '/agent/workspace',
      now: () => 10,
      newId: (() => {
        let next = 0;
        return () => `id-${++next}`;
      })(),
    });

    assert.ok(event);
    assert.deepEqual(event.observation.roots, ['/app/polyglot']);
    assert.equal(event.observation.status, 'ok');
    assert.match(event.observation.revision?.ref ?? '', /^sha256:[a-f0-9]{64}$/);
    assert.deepEqual(event.observation.entries, [
      { path: '/app/polyglot/main.py.c', kind: 'file', sizeBytes: 42, sha256: 'abc123' },
      { path: '/app/polyglot/main.py', kind: 'symlink', symlinkTarget: 'main.py.c' },
    ]);
    assert.equal(seenCommands[0]?.cwd, '/agent/workspace');
    assert.equal(seenCommands[0]?.timeoutMs, 30_000);
    assert.match(seenCommands[0]?.command ?? '', /\/app\/polyglot/);
  });

  test('includes file content facts in a deterministic manifest revision', () => {
    const entries = parseWorkspaceObservation(
      ['file\t/app/project/result.txt\t\t12\tabc123', 'directory\t/app/project/cache\t\t\t'].join(
        '\n',
      ),
    );
    assert.deepEqual(entries, [
      { path: '/app/project/result.txt', kind: 'file', sizeBytes: 12, sha256: 'abc123' },
      { path: '/app/project/cache', kind: 'directory' },
    ]);
    assert.deepEqual(
      workspaceManifestRevision(['/app/project'], entries),
      workspaceManifestRevision(['/app/project'], [...entries].reverse()),
    );
    assert.notEqual(
      workspaceManifestRevision(['/app/project'], entries).ref,
      workspaceManifestRevision(
        ['/app/project'],
        [{ ...entries[0]!, sha256: 'changed' }, entries[1]!],
      ).ref,
    );
  });
});
