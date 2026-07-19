import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import type { RuntimeEvent } from '@maka/core/runtime-event';
import type { AgentRunInspectDocument } from '@maka/runtime';
import {
  MAKA_AHE_EVIDENCE_EXPORT_SOURCE_LABEL,
  buildMakaAheTargetSnapshot,
  makaAheEvidenceFromTaskRunProjections,
  readMakaAheHarborOfficialResult,
  validateMakaAheSourceRefs,
  writeMakaAheEvidenceExport,
} from '../ahe-evidence-export.js';
import type { MakaAheTargetComponent } from '../ahe-target-protocol.js';
import type { ScoreResult, TaskEvent } from '../task-contracts.js';
import { taskAttemptExecutionEvidence } from '../task-execution-lineage.js';
import { projectTaskRun } from '../task-run-store.js';

describe('AHE evidence export', () => {
  test('builds a deterministic target snapshot after validating repo source refs', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'maka-ahe-snapshot-'));
    try {
      await mkdir(join(dir, 'src'), { recursive: true });
      await writeFile(join(dir, 'src', 'prompt.ts'), 'export const prompt = "ok";\n', 'utf8');
      const components = fixtureComponents('src/prompt.ts');

      const first = await buildMakaAheTargetSnapshot({
        repoRoot: dir,
        components,
        createdAt: '2026-07-01T00:00:00.000Z',
      });
      const second = await buildMakaAheTargetSnapshot({
        repoRoot: dir,
        components,
        createdAt: '2026-07-02T00:00:00.000Z',
      });

      assert.equal(first.protocolVersion, 'maka.ahe-target.v2');
      assert.equal(first.sourceLabel, MAKA_AHE_EVIDENCE_EXPORT_SOURCE_LABEL);
      assert.equal(first.snapshotId, second.snapshotId);
      assert.match(first.snapshotId, /^maka-ahe-[a-f0-9]{64}$/);
      assert.match(first.sourceManifest.digest, /^sha256:[a-f0-9]{64}$/);
      assert.equal(first.sourceManifest.entries[0]?.sizeBytes, 28);
      assert.equal(first.components[0]?.sourceRefs[0]?.path, 'src/prompt.ts');

      await writeFile(join(dir, 'src', 'prompt.ts'), 'export const prompt = "changed";\n', 'utf8');
      const changed = await buildMakaAheTargetSnapshot({ repoRoot: dir, components });
      assert.notEqual(changed.snapshotId, first.snapshotId);
      assert.notEqual(
        changed.sourceManifest.entries[0]?.digest,
        first.sourceManifest.entries[0]?.digest,
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('makes target identity independent of source-ref order and Git metadata', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'maka-ahe-ordered-snapshot-'));
    try {
      await mkdir(join(dir, 'src'), { recursive: true });
      await writeFile(join(dir, 'src', 'a.ts'), 'export const a = 1;\n', 'utf8');
      await writeFile(join(dir, 'src', 'b.ts'), 'export const b = 2;\n', 'utf8');
      const component: MakaAheTargetComponent = {
        ...fixtureComponents('src/a.ts')[0]!,
        sourceRefs: [{ path: 'src/a.ts' }, { path: 'src/b.ts' }],
      };
      const first = await buildMakaAheTargetSnapshot({
        repoRoot: dir,
        components: [component],
        git: { repository: 'maka', commit: 'first', dirty: false },
      });
      const reordered = await buildMakaAheTargetSnapshot({
        repoRoot: dir,
        components: [{ ...component, sourceRefs: [...component.sourceRefs].reverse() }],
        sourceLabel: 'a-different-exporter',
        git: { repository: 'maka', commit: 'second', dirty: true },
      });

      assert.equal(reordered.snapshotId, first.snapshotId);
      assert.deepEqual(
        reordered.sourceManifest.entries.map((entry) => entry.path),
        ['src/a.ts', 'src/b.ts'],
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('rejects missing and unsafe target source refs', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'maka-ahe-bad-snapshot-'));
    try {
      const missing = await validateMakaAheSourceRefs(dir, fixtureComponents('src/missing.ts'));
      assert.equal(missing[0]?.path, 'components[0].sourceRefs[0].path');
      assert.match(missing[0]?.message ?? '', /does not exist/);

      const unsafe = await validateMakaAheSourceRefs(dir, fixtureComponents('../outside.ts'));
      assert.match(unsafe[0]?.message ?? '', /traverse/);

      await assert.rejects(
        () =>
          buildMakaAheTargetSnapshot({ repoRoot: dir, components: fixtureComponents('/abs.ts') }),
        /repo-relative POSIX/,
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('rejects source refs that escape the repo through symbolic links or resolve to directories', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'maka-ahe-symlink-snapshot-'));
    const outside = await mkdtemp(join(tmpdir(), 'maka-ahe-outside-'));
    try {
      await writeFile(join(outside, 'secret.ts'), 'export const secret = true;\n', 'utf8');
      await symlink(join(outside, 'secret.ts'), join(dir, 'escaped.ts'));
      await mkdir(join(dir, 'directory.ts'));

      const escaped = await validateMakaAheSourceRefs(dir, fixtureComponents('escaped.ts'));
      assert.match(escaped[0]?.message ?? '', /symbolic link/);
      const directory = await validateMakaAheSourceRefs(dir, fixtureComponents('directory.ts'));
      assert.match(directory[0]?.message ?? '', /regular file/);
    } finally {
      await rm(dir, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });

  test('maps task-run projections to AHE results with conservative authority buckets', () => {
    const official = projectTaskRun(
      [
        {
          type: 'task_run_created',
          id: 'e1',
          taskRunId: 'run-official',
          ts: 1,
          taskId: 'task-b',
          configId: 'cfg-1',
        },
        officialVerifierEvent('run-official', true),
        officialScoreEvent('run-official', true),
        { type: 'task_run_completed', id: 'e4', taskRunId: 'run-official', ts: 4, finishedAt: 4 },
      ],
      'run-official',
    );
    const selfCheck = projectTaskRun(
      [
        {
          type: 'task_run_created',
          id: 'e1',
          taskRunId: 'run-self-check',
          ts: 1,
          taskId: 'task-a',
          configId: 'cfg-1',
        },
        {
          type: 'self_check_observed',
          id: 'e2',
          taskRunId: 'run-self-check',
          ts: 2,
          observation: {
            id: 'self-check-1',
            taskRunId: 'run-self-check',
            ts: 2,
            summary: 'local check passed',
          },
        },
        scoreEvent({
          id: 'score-self-check',
          taskRunId: 'run-self-check',
          ts: 3,
          passed: true,
          scored: true,
          eligible: true,
          score: 1,
          maxScore: 1,
          taxonomy: 'passed',
          authority: { source: 'self_check', authoritative: true },
        }),
      ],
      'run-self-check',
    );

    const evidence = makaAheEvidenceFromTaskRunProjections([official, selfCheck], {
      snapshotId: 'snapshot-baseline',
      runId: 'baseline-run',
      exportedAt: '2026-07-01T00:00:00.000Z',
    });

    assert.deepEqual(
      evidence.harnessResults.results.map((result) => result.taskId),
      ['task-a', 'task-b'],
    );
    assert.equal(evidence.harnessResults.results[0]?.status, 'self_check_only');
    assert.equal(evidence.harnessResults.results[0]?.scoreAuthority, 'self_check');
    assert.match(
      evidence.harnessResults.results[0]?.warnings?.join('\n') ?? '',
      /non-authoritative/,
    );
    assert.equal(evidence.harnessResults.results[1]?.status, 'official_pass');
    assert.equal(evidence.harnessResults.results[1]?.scoreAuthority, 'official_scorer');
    assert.equal(evidence.harnessResults.results[0]?.schemaVersion, 'maka.ahe.run_result.v1');
    assert.equal(evidence.harnessResults.results[0]?.taskRunId, 'run-self-check');
    assert.equal(
      evidence.harnessResults.results[0]?.executionLineageRef.ref,
      'traces/run-self-check/execution-lineage.json',
    );
    assert.equal(
      evidence.traceIndex.entries[0]?.transcript?.ref,
      'traces/run-self-check/result.md',
    );
    assert.equal(
      evidence.traceIndex.entries[0]?.messages?.ref,
      'traces/run-self-check/messages.json',
    );
    assert.equal(
      evidence.traceIndex.entries[0]?.taskEventsJsonl?.ref,
      'traces/run-self-check/task-events.jsonl',
    );
    assert.equal(evidence.traceIndex.entries[0]?.runtimeEventsJsonl, undefined);
  });

  test('overlays Harbor post-exit official results during AHE bucketing', async () => {
    const trial = await mkdtemp(join(tmpdir(), 'maka-ahe-harbor-trial-'));
    try {
      await mkdir(join(trial, 'verifier'), { recursive: true });
      await writeFile(
        join(trial, 'result.json'),
        JSON.stringify({ verifier_result: { rewards: { reward: 1 } } }),
        'utf8',
      );
      await writeFile(join(trial, 'verifier', 'reward.txt'), '1\n', 'utf8');
      await writeFile(join(trial, 'verifier', 'test-stdout.txt'), '3 passed\n', 'utf8');
      const selfCheckOnlyProjection = projectTaskRun(
        [
          {
            type: 'task_run_created',
            id: 'e1',
            taskRunId: 'run-harbor',
            ts: 1,
            taskId: 'task-a',
            configId: 'cfg-1',
          },
          {
            type: 'heavy_task_self_check_recorded',
            id: 'e2',
            taskRunId: 'run-harbor',
            ts: 2,
            selfCheck: acceptedHeavySelfCheck('run-harbor', false),
          },
          scoreEvent({
            id: 'score-self-check',
            taskRunId: 'run-harbor',
            ts: 3,
            passed: false,
            scored: false,
            eligible: true,
            taxonomy: 'verification_failed',
            authority: { source: 'self_check', authoritative: false },
          }),
        ],
        'run-harbor',
      );
      const official = await readMakaAheHarborOfficialResult(trial, selfCheckOnlyProjection);

      const evidence = makaAheEvidenceFromTaskRunProjections([selfCheckOnlyProjection], {
        snapshotId: 'snapshot-baseline',
        officialResults: { 'run-harbor': official },
      });

      assert.equal(evidence.harnessResults.results[0]?.status, 'official_pass');
      assert.equal(evidence.harnessResults.results[0]?.scoreAuthority, 'official_scorer');
      assert.equal(
        evidence.harnessResults.results[0]?.verifierRef?.ref,
        'traces/run-harbor/official-harbor-result.json',
      );
      assert.match(
        evidence.traceIndex.entries[0]?.artifacts?.[0]?.ref ?? '',
        /official-harbor-result\.json/,
      );
    } finally {
      await rm(trial, { recursive: true, force: true });
    }
  });

  test('keeps excluded, infra, and unscored cells explicit', () => {
    assert.equal(
      statusForScore({
        id: 'score-excluded',
        taskRunId: 'run-bucket',
        ts: 2,
        passed: false,
        scored: false,
        eligible: false,
        taxonomy: 'unsupported_adapter',
        excludedReason: 'no official adapter',
        authority: { source: 'system', authoritative: false },
      }),
      'excluded',
    );
    assert.equal(
      statusForScore({
        id: 'score-infra',
        taskRunId: 'run-bucket',
        ts: 2,
        passed: false,
        scored: true,
        eligible: true,
        taxonomy: 'infra_failed',
        errorClass: 'infra_failed',
        authority: { source: 'official_harbor_verifier', authoritative: true },
      }),
      'infra_failed',
    );
    assert.equal(
      makaAheEvidenceFromTaskRunProjections(
        [
          projectTaskRun(
            [
              {
                type: 'task_run_created',
                id: 'e1',
                taskRunId: 'run-unscored',
                ts: 1,
                taskId: 'task-1',
                configId: 'cfg-1',
              },
            ],
            'run-unscored',
          ),
        ],
        { snapshotId: 'snapshot-baseline' },
      ).harnessResults.results[0]?.status,
      'unscored',
    );
  });

  test('exports payload-safe lineage by default and keeps raw Runtime Events opt-in', async () => {
    const repo = await mkdtemp(join(tmpdir(), 'maka-ahe-safe-repo-'));
    const out = await mkdtemp(join(tmpdir(), 'maka-ahe-safe-out-'));
    try {
      await writeFile(join(repo, 'prompt.ts'), 'export const prompt = "ok";\n', 'utf8');
      const snapshot = await buildMakaAheTargetSnapshot({
        repoRoot: repo,
        components: fixtureComponents('prompt.ts'),
      });
      const runtimeEvents = [
        fixtureRuntimeEvent('runtime-1', {
          content: { kind: 'text', text: 'PRIVATE_RUNTIME_PAYLOAD' },
        }),
      ];
      const projection = projectTaskRun(
        [
          {
            type: 'task_run_created',
            id: 'task-1',
            taskRunId: 'run-safe',
            ts: 1,
            taskId: 'task-safe',
            configId: 'cfg-1',
          },
          {
            type: 'task_attempt_started',
            id: 'task-2',
            taskRunId: 'run-safe',
            ts: 2,
            attemptId: 'attempt-1',
          },
          {
            type: 'task_attempt_execution_linked',
            id: 'task-3',
            taskRunId: 'run-safe',
            ts: 3,
            attemptId: 'attempt-1',
            evidence: taskAttemptExecutionEvidence({
              taskRunId: 'run-safe',
              attemptId: 'attempt-1',
              sessionId: 'session-1',
              invocationId: 'invocation-1',
              agentRunId: 'agent-run-1',
              turnId: 'turn-1',
              runtimeEvents,
            }),
          },
        ],
        'run-safe',
      );

      await writeMakaAheEvidenceExport(out, {
        snapshot,
        projections: [projection],
        agentRunEvidence: {
          'run-safe': [
            {
              sessionId: 'session-1',
              agentRunId: 'agent-run-1',
              inspect: fixtureAgentRunInspect(runtimeEvents),
              runtimeEvents,
            },
          ],
        },
      });

      const lineageText = await readFile(
        join(out, 'traces', 'run-safe', 'execution-lineage.json'),
        'utf8',
      );
      assert.match(lineageText, /"rawRuntimeEvents": "omitted_by_policy"/);
      assert.doesNotMatch(lineageText, /PRIVATE_RUNTIME_PAYLOAD/);
      assert.match(
        await readFile(
          join(out, 'traces', 'run-safe', 'agent-runs', 'agent-run-1', 'inspect.json'),
          'utf8',
        ),
        /maka.agent_run_inspect.v1/,
      );
      await assert.rejects(
        () =>
          readFile(
            join(out, 'traces', 'run-safe', 'agent-runs', 'agent-run-1', 'runtime-events.jsonl'),
            'utf8',
          ),
        /ENOENT/,
      );
      assert.match(
        await readFile(join(out, 'traces', 'run-safe', 'task-events.jsonl'), 'utf8'),
        /task_attempt_execution_linked/,
      );
    } finally {
      await rm(repo, { recursive: true, force: true });
      await rm(out, { recursive: true, force: true });
    }
  });

  test('records missing execution lineage as a gap instead of inventing an AgentRun', async () => {
    const repo = await mkdtemp(join(tmpdir(), 'maka-ahe-gap-repo-'));
    const out = await mkdtemp(join(tmpdir(), 'maka-ahe-gap-out-'));
    try {
      await writeFile(join(repo, 'prompt.ts'), 'export const prompt = "ok";\n', 'utf8');
      const snapshot = await buildMakaAheTargetSnapshot({
        repoRoot: repo,
        components: fixtureComponents('prompt.ts'),
      });
      const projection = projectTaskRun(
        [
          {
            type: 'task_run_created',
            id: 'task-1',
            taskRunId: 'run-gap',
            ts: 1,
            taskId: 'task-gap',
            configId: 'cfg-1',
          },
        ],
        'run-gap',
      );

      await writeMakaAheEvidenceExport(out, {
        snapshot,
        projections: [projection],
        includeEvents: true,
        agentRunEvidence: {
          'run-gap': [
            {
              sessionId: 'session-1',
              agentRunId: 'agent-run-1',
              inspect: fixtureAgentRunInspect(),
              runtimeEvents: [
                fixtureRuntimeEvent('unlinked-private', {
                  content: { kind: 'text', text: 'UNLINKED_PRIVATE_PAYLOAD' },
                }),
              ],
            },
          ],
        },
      });

      const lineage = JSON.parse(
        await readFile(join(out, 'traces', 'run-gap', 'execution-lineage.json'), 'utf8'),
      );
      assert.equal(lineage.attempts.length, 0);
      assert.equal(lineage.gaps[0].code, 'attempt_execution_missing');
      assert.equal(lineage.rawRuntimeEvents, 'requested_with_gaps');
      await assert.rejects(
        () =>
          readFile(
            join(out, 'traces', 'run-gap', 'agent-runs', 'agent-run-1', 'runtime-events.jsonl'),
            'utf8',
          ),
        /ENOENT/,
      );
    } finally {
      await rm(repo, { recursive: true, force: true });
      await rm(out, { recursive: true, force: true });
    }
  });

  test('writes deterministic AHE files and per-task trace exports', async () => {
    const repo = await mkdtemp(join(tmpdir(), 'maka-ahe-repo-'));
    const out = await mkdtemp(join(tmpdir(), 'maka-ahe-out-'));
    try {
      await mkdir(join(repo, 'src'), { recursive: true });
      await writeFile(join(repo, 'src', 'prompt.ts'), 'export const prompt = "ok";\n', 'utf8');
      const snapshot = await buildMakaAheTargetSnapshot({
        repoRoot: repo,
        components: fixtureComponents('src/prompt.ts'),
        createdAt: '2026-07-01T00:00:00.000Z',
      });
      const runtimeEvents = [
        fixtureRuntimeEvent('runtime-1'),
        fixtureRuntimeEvent('runtime-2', {
          status: 'completed',
          role: 'system',
          author: 'system',
          content: { kind: 'text', text: 'RAW_RUNTIME_PAYLOAD' },
        }),
      ];
      const projection = projectTaskRun(
        [
          {
            type: 'task_run_created',
            id: 'e1',
            taskRunId: 'run-official',
            ts: 1,
            taskId: 'task-1',
            configId: 'cfg-1',
          },
          {
            type: 'task_attempt_started',
            id: 'attempt-started',
            taskRunId: 'run-official',
            ts: 1.1,
            attemptId: 'attempt-1',
            sessionId: 'session-1',
            agentRunId: 'agent-run-1',
          },
          {
            type: 'task_attempt_execution_linked',
            id: 'execution-linked',
            taskRunId: 'run-official',
            ts: 1.2,
            attemptId: 'attempt-1',
            evidence: taskAttemptExecutionEvidence({
              taskRunId: 'run-official',
              attemptId: 'attempt-1',
              sessionId: 'session-1',
              invocationId: 'invocation-1',
              agentRunId: 'agent-run-1',
              turnId: 'turn-1',
              runtimeEvents,
            }),
          },
          {
            type: 'heavy_task_self_check_plan_recorded',
            id: 'self-check-plan-event',
            taskRunId: 'run-official',
            ts: 2,
            plan: acceptedHeavySelfCheckPlan('run-official'),
          },
          {
            type: 'heavy_task_self_check_recorded',
            id: 'self-check-event',
            taskRunId: 'run-official',
            ts: 2.1,
            selfCheck: acceptedHeavySelfCheck('run-official', true),
          },
          {
            type: 'verifier_result_recorded',
            id: 'verifier-run-official',
            taskRunId: 'run-official',
            ts: 3,
            result: {
              id: 'verifier-run-official',
              taskRunId: 'run-official',
              ts: 3,
              kind: 'terminal_bench',
              passed: false,
              exitCode: 1,
              score: 0,
              maxScore: 1,
              stdout: 'AssertionError: expected move e2e4 but got e2g4\n',
              authority: { source: 'official_harbor_verifier', authoritative: true },
            },
          },
          {
            type: 'heavy_task_self_check_gate_recorded',
            id: 'gate-run-official',
            taskRunId: 'run-official',
            ts: 3,
            gate: {
              schemaVersion: 1,
              action: 'repair_prompt',
              reason: 'latest self-check reports uncleaned workspace side effects',
              attempt: 1,
              maxAttempts: 1,
              checklist: [
                {
                  id: 'check-1',
                  kind: 'workspace_hygiene',
                  source: 'generic_heavy_task',
                  description:
                    'Pass self-check must include sandbox execution evidence and a public workspace hygiene guard',
                  evidenceRequired: 'command_or_artifact',
                },
              ],
              prompt: 'run public checks and self_check_submit',
            },
          },
          officialScoreEvent('run-official', false),
          { type: 'task_run_completed', id: 'e4', taskRunId: 'run-official', ts: 4, finishedAt: 4 },
        ],
        'run-official',
      );
      const sessionMessages = {
        'run-official': [
          { type: 'user', id: 'u1', turnId: 't1', ts: 1, text: 'compile sqlite with gcov' },
          {
            type: 'tool_call',
            id: 'tool-1',
            turnId: 't1',
            ts: 2,
            toolName: 'Bash',
            args: { command: 'make' },
          },
          {
            type: 'tool_result',
            id: 'tool-r1',
            turnId: 't1',
            ts: 3,
            toolUseId: 'tool-1',
            isError: false,
            content: { kind: 'text', text: 'ok' },
          },
          {
            type: 'assistant',
            id: 'a1',
            turnId: 't1',
            ts: 4,
            text: 'SQLite is installed with gcov instrumentation.',
            modelId: 'fake-model',
          },
        ],
      };

      const first = await writeMakaAheEvidenceExport(out, {
        snapshot,
        projections: [projection],
        runId: 'baseline-run',
        exportedAt: '2026-07-01T00:00:00.000Z',
        includeEvents: true,
        sessionMessages,
        agentRunEvidence: {
          'run-official': [
            {
              sessionId: 'session-1',
              agentRunId: 'agent-run-1',
              inspect: fixtureAgentRunInspect(runtimeEvents),
              runtimeEvents,
            },
          ],
        },
      });
      const firstHarness = await readFile(first.files.harnessResultsJson, 'utf8');
      const second = await writeMakaAheEvidenceExport(out, {
        snapshot,
        projections: [projection],
        runId: 'baseline-run',
        exportedAt: '2026-07-01T00:00:00.000Z',
        includeEvents: true,
        sessionMessages,
        agentRunEvidence: {
          'run-official': [
            {
              sessionId: 'session-1',
              agentRunId: 'agent-run-1',
              inspect: fixtureAgentRunInspect(runtimeEvents),
              runtimeEvents,
            },
          ],
        },
      });

      assert.equal(firstHarness, await readFile(second.files.harnessResultsJson, 'utf8'));
      const parsedHarness = JSON.parse(firstHarness);
      assert.equal(parsedHarness.results[0].status, 'official_fail');
      assert.equal(parsedHarness.results[0].taskRunId, 'run-official');
      assert.equal(parsedHarness.results[0].traceRef.ref, 'traces/run-official/task-run.json');
      assert.match(parsedHarness.results[0].traceRef.digest, /^sha256:/);
      assert.match(parsedHarness.results[0].executionLineageRef.digest, /^sha256:/);
      assert.match(parsedHarness.traceIndexRef.digest, /^sha256:/);
      const traceIndexJson = await readFile(join(out, 'trace-index.json'), 'utf8');
      assert.match(traceIndexJson, /traces\/run-official\/result.md/);
      assert.match(traceIndexJson, /traces\/run-official\/task-events.jsonl/);
      assert.match(traceIndexJson, /traces\/run-official\/execution-lineage.json/);
      assert.match(traceIndexJson, /traces\/run-official\/agent-runs\/agent-run-1\/inspect.json/);
      assert.match(
        traceIndexJson,
        /traces\/run-official\/agent-runs\/agent-run-1\/runtime-events.jsonl/,
      );
      assert.doesNotMatch(traceIndexJson, /"runtimeEventsJsonl"/);
      assert.match(traceIndexJson, /traces\/run-official\/messages.json/);
      assert.match(traceIndexJson, /traces\/run-official\/failure-digest.json/);
      assert.match(
        await readFile(join(out, 'traces', 'run-official', 'task-run.json'), 'utf8'),
        /maka.task_run_export.v1/,
      );
      assert.match(
        await readFile(join(out, 'traces', 'run-official', 'task-events.jsonl'), 'utf8'),
        /task_run_created/,
      );
      const lineage = JSON.parse(
        await readFile(join(out, 'traces', 'run-official', 'execution-lineage.json'), 'utf8'),
      );
      assert.equal(lineage.schemaVersion, 'maka.ahe.execution_lineage.v1');
      assert.equal(lineage.target.snapshotId, snapshot.snapshotId);
      assert.equal(lineage.task.taskRunId, 'run-official');
      assert.equal(lineage.task.coverage.highWater.eventId, 'e4');
      assert.equal(lineage.attempts[0].executions[0].evidence.execution.agentRunId, 'agent-run-1');
      assert.equal(
        lineage.attempts[0].executions[0].evidence.runtimeCoverage.highWater.eventId,
        'runtime-2',
      );
      assert.match(lineage.attempts[0].executions[0].inspectRef.digest, /^sha256:/);
      assert.match(lineage.attempts[0].executions[0].runtimeEventsRef.digest, /^sha256:/);
      assert.deepEqual(lineage.gaps, []);
      assert.match(
        await readFile(
          join(out, 'traces', 'run-official', 'agent-runs', 'agent-run-1', 'runtime-events.jsonl'),
          'utf8',
        ),
        /RAW_RUNTIME_PAYLOAD/,
      );
      const failureDigest = JSON.parse(
        await readFile(join(out, 'traces', 'run-official', 'failure-digest.json'), 'utf8'),
      );
      assert.equal(failureDigest.schemaVersion, 'maka.ahe.failure_digest.v1');
      assert.equal(failureDigest.status, 'official_fail');
      assert.equal(failureDigest.selfCheck.divergence, 'self_check_pass_official_fail');
      assert.equal(failureDigest.selfCheck.hygiene.sandboxStatus, 'present');
      assert.equal(
        failureDigest.selfCheck.hygiene.sandboxRoot,
        '/tmp/maka-self-check/run-official',
      );
      assert.equal(failureDigest.selfCheck.hygiene.sandboxStrategy, 'scratch_dir');
      assert.equal(failureDigest.selfCheck.hygiene.scratchUsed, false);
      assert.equal(failureDigest.selfCheck.hygiene.workspaceGuardStatus, 'dirty');
      assert.equal(failureDigest.selfCheck.hygiene.strongPassEligible, false);
      assert.match(
        failureDigest.selfCheck.hygiene.strongPassBlocker,
        /uncleaned workspace side effects/,
      );
      assert.equal(failureDigest.selfCheck.hygiene.workspacePollutionSuspected, true);
      assert.deepEqual(failureDigest.selfCheck.hygiene.remainingSideEffectPaths, [
        '/app/polyglot/cmain',
      ]);
      assert.deepEqual(failureDigest.selfCheck.hygiene.addedPaths, ['/app/polyglot/cmain']);
      assert.deepEqual(failureDigest.selfCheck.hygiene.checkedPaths, ['/app/polyglot']);
      assert.ok(
        failureDigest.selfCheck.hygiene.riskFlags.includes('workspace_side_effects_present'),
      );
      assert.ok(
        failureDigest.selfCheck.hygiene.riskFlags.includes('workspace_guard_added_paths_reported'),
      );
      assert.ok(failureDigest.selfCheck.hygiene.riskFlags.includes('unplanned_added_path'));
      assert.ok(failureDigest.selfCheck.hygiene.riskFlags.includes('scratch_escape'));
      assert.equal(failureDigest.selfCheck.heavyTaskSelfChecks[0].status, 'pass');
      assert.equal(failureDigest.selfCheck.selfCheckPlan.latest.planId, 'plan-1');
      assert.equal(failureDigest.selfCheck.selfCheckPlan.audit.status, 'fail');
      assert.ok(
        failureDigest.selfCheck.selfCheckPlan.audit.riskFlags.includes('unplanned_added_path'),
      );
      const taskRunExport = JSON.parse(
        await readFile(join(out, 'traces', 'run-official', 'task-run.json'), 'utf8'),
      );
      assert.equal(taskRunExport.progress.selfCheckPlans.latest.planId, 'plan-1');
      assert.equal(taskRunExport.progress.selfCheckPlans.audit.status, 'fail');
      assert.equal(taskRunExport.heavyTask.selfCheckPlan.audit.status, 'fail');
      assert.equal(failureDigest.finalState.selfCheckGate.action, 'repair_prompt');
      assert.match(
        failureDigest.finalState.selfCheckGate.reason,
        /uncleaned workspace side effects/,
      );
      assert.match(failureDigest.officialHarbor.verifier.stdoutExcerpt, /expected move e2e4/);
      assert.equal(failureDigest.debugRefs.messages.ref, 'traces/run-official/messages.json');
      assert.equal(
        failureDigest.debugRefs.taskEventsJsonl.ref,
        'traces/run-official/task-events.jsonl',
      );
      assert.equal(failureDigest.debugRefs.runtimeEventSources.length, 1);
      const messages = JSON.parse(
        await readFile(join(out, 'traces', 'run-official', 'messages.json'), 'utf8'),
      );
      assert.equal(messages.trace_id, 'run-official');
      assert.equal(messages.messages[0].role, 'system');
      assert.equal(messages.messages[1].role, 'user');
      assert.match(messages.messages[1].content, /compile sqlite with gcov/);
      assert.equal(messages.messages[2].role, 'assistant');
      assert.match(messages.messages[2].content, /tool_call/);
      assert.match(JSON.stringify(messages), /task_run_created/);
    } finally {
      await rm(repo, { recursive: true, force: true });
      await rm(out, { recursive: true, force: true });
    }
  });
});

function fixtureRuntimeEvent(id: string, overrides: Partial<RuntimeEvent> = {}): RuntimeEvent {
  return {
    id,
    invocationId: 'invocation-1',
    runId: 'agent-run-1',
    sessionId: 'session-1',
    turnId: 'turn-1',
    ts: 1,
    partial: false,
    role: 'model',
    author: 'agent',
    ...overrides,
  };
}

function fixtureAgentRunInspect(
  runtimeEvents: readonly RuntimeEvent[] = [
    fixtureRuntimeEvent('runtime-1'),
    fixtureRuntimeEvent('runtime-2'),
  ],
): AgentRunInspectDocument {
  const first = runtimeEvents[0];
  const last = runtimeEvents.at(-1);
  return {
    schemaVersion: 'maka.agent_run_inspect.v1',
    kind: 'agent_run',
    agentRun: {
      sessionId: 'session-1',
      agentRunId: 'agent-run-1',
      invocationId: 'invocation-1',
      turnId: 'turn-1',
      status: 'completed',
      createdAt: 1,
      updatedAt: 2,
      completedAt: 2,
    },
    sources: {
      operationalEventCount: 1,
      runtimeEventCount: runtimeEvents.length,
      ...(first && last
        ? {
            runtimeCoverage: {
              lowWater: {
                ledger: 'runtime_event',
                streamId: 'agent-run-1',
                sequence: 0,
                eventId: first.id,
              },
              highWater: {
                ledger: 'runtime_event',
                streamId: 'agent-run-1',
                sequence: runtimeEvents.length - 1,
                eventId: last.id,
              },
              eventCount: runtimeEvents.length,
            },
          }
        : {}),
      health: {
        runtimeLedger: 'present',
        runtimeTerminalPresent: true,
        operationalTerminalPresent: true,
        statusConsistency: 'consistent',
      },
    },
    tools: {
      callCount: 0,
      responseCount: 0,
      errorResponseCount: 0,
      callsWithoutResponse: [],
      responsesWithoutCall: [],
    },
    compactionCheckpoints: [],
    diagnostics: [],
  };
}

function fixtureComponents(sourcePath: string): readonly MakaAheTargetComponent[] {
  return [
    {
      id: 'fixture-prompt',
      category: 'system_prompt',
      label: 'Fixture prompt',
      description: 'Fixture source-backed prompt component',
      editable: true,
      sourceRefs: [{ path: sourcePath }],
    },
  ];
}

function statusForScore(score: ScoreResult): string | undefined {
  const projection = projectTaskRun(
    [
      {
        type: 'task_run_created',
        id: 'e1',
        taskRunId: 'run-bucket',
        ts: 1,
        taskId: 'task-1',
        configId: 'cfg-1',
      },
      scoreEvent(score),
    ],
    'run-bucket',
  );
  return makaAheEvidenceFromTaskRunProjections([projection], { snapshotId: 'snapshot-baseline' })
    .harnessResults.results[0]?.status;
}

function scoreEvent(result: ScoreResult): TaskEvent {
  return {
    type: 'score_result_recorded',
    id: `event-${result.id}`,
    taskRunId: result.taskRunId,
    ts: result.ts,
    result,
  };
}

function officialVerifierEvent(taskRunId: string, passed: boolean): TaskEvent {
  return {
    type: 'verifier_result_recorded',
    id: `verifier-${taskRunId}`,
    taskRunId,
    ts: 2,
    result: {
      id: `verifier-${taskRunId}`,
      taskRunId,
      ts: 2,
      kind: 'terminal_bench',
      passed,
      exitCode: passed ? 0 : 1,
      score: passed ? 1 : 0,
      maxScore: 1,
      authority: { source: 'official_harbor_verifier', authoritative: true },
    },
  };
}

function officialScoreEvent(taskRunId: string, passed: boolean): TaskEvent {
  return scoreEvent({
    id: `score-${taskRunId}`,
    taskRunId,
    ts: 3,
    passed,
    scored: true,
    eligible: true,
    score: passed ? 1 : 0,
    maxScore: 1,
    taxonomy: passed ? 'passed' : 'verification_failed',
    authority: { source: 'official_harbor_verifier', authoritative: true },
  });
}

function acceptedHeavySelfCheck(taskRunId: string, passed: boolean) {
  return {
    schemaVersion: 1 as const,
    selfCheckId: 'self-check-1',
    taskRunId,
    ts: 2,
    status: passed ? ('pass' as const) : ('fail' as const),
    publicReason: 'Accepted as public, task-derived advisory self-check evidence.',
    commandEvidence: [
      { command: 'npm test', exitCode: passed ? 0 : 1, outputExcerpt: passed ? 'ok' : 'fail' },
    ],
    artifactEvidence: [],
    ...(passed
      ? {
          executionHygiene: {
            sandbox: {
              root: `/tmp/maka-self-check/${taskRunId}`,
              strategy: 'scratch_dir' as const,
              commandCwd: `/tmp/maka-self-check/${taskRunId}`,
              outputPolicy: 'scratch_only' as const,
              publicReason: 'intended public check sandbox root',
            },
            scratchUsed: false,
            cleanupPerformed: false,
            workspaceSideEffects: 'present' as const,
            remainingSideEffectPaths: ['/app/polyglot/cmain'],
            workspaceGuard: {
              checked: true,
              checkedPaths: ['/app/polyglot'],
              beforeListingCommand: 'find /app/polyglot -maxdepth 1 -type f | sort',
              afterListingCommand: 'find /app/polyglot -maxdepth 1 -type f | sort',
              addedPaths: ['/app/polyglot/cmain'],
              modifiedPaths: [],
              removedPaths: [],
            },
            publicReason: 'public compile left a binary in the deliverable workspace',
          },
        }
      : {}),
    guard: {
      status: 'accepted' as const,
      checkedAt: 2,
      categories: [],
      publicReason: 'Accepted as public, task-derived advisory self-check evidence.',
    },
    source: { kind: 'model_tool' as const, toolCallId: 'tool-1' },
  };
}

function acceptedHeavySelfCheckPlan(taskRunId: string) {
  return {
    schemaVersion: 1 as const,
    planId: 'plan-1',
    taskRunId,
    ts: 2,
    finalArtifacts: [
      {
        path: '/app/move.txt',
        purpose: 'visible final deliverable',
        publicReason: 'visible task requires this artifact',
      },
    ],
    selfCheckScratch: {
      root: `/tmp/maka-self-check/${taskRunId}`,
      expectedGeneratedPaths: [`/tmp/maka-self-check/${taskRunId}/check.log`],
      publicReason: 'public checks should generate outputs under scratch',
    },
    workspaceGuardPlan: {
      checkedPaths: ['/app/polyglot'],
      expectedAddedPaths: ['/app/move.txt'],
      expectedGeneratedPathsOutsideScratch: [],
      publicReason: 'public guard checks visible deliverable paths',
    },
    publicReason: 'plan is derived from visible public task requirements',
    guard: {
      status: 'accepted' as const,
      checkedAt: 2,
      categories: [],
      publicReason: 'Accepted as public, task-derived advisory self-check plan.',
    },
    source: { kind: 'model_tool' as const, toolCallId: 'tool-plan' },
  };
}
