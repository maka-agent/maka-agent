import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import {
  MAKA_AHE_EVIDENCE_EXPORT_SOURCE_LABEL,
  buildMakaAheTargetSnapshot,
  makaAheEvidenceFromTaskRunProjections,
  validateMakaAheSourceRefs,
  writeMakaAheEvidenceExport,
} from '../ahe-evidence-export.js';
import type { MakaAheTargetComponent } from '../ahe-target-protocol.js';
import type { ScoreResult, TaskEvent } from '../task-contracts.js';
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

      assert.equal(first.protocolVersion, 'maka.ahe-target.v1');
      assert.equal(first.sourceLabel, MAKA_AHE_EVIDENCE_EXPORT_SOURCE_LABEL);
      assert.equal(first.snapshotId, second.snapshotId);
      assert.equal(first.components[0]?.sourceRefs[0]?.path, 'src/prompt.ts');
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
        () => buildMakaAheTargetSnapshot({ repoRoot: dir, components: fixtureComponents('/abs.ts') }),
        /repo-relative POSIX/,
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('maps task-run projections to AHE results with conservative authority buckets', () => {
    const official = projectTaskRun([
      { type: 'task_run_created', id: 'e1', taskRunId: 'run-official', ts: 1, taskId: 'task-b', configId: 'cfg-1' },
      officialVerifierEvent('run-official', true),
      officialScoreEvent('run-official', true),
      { type: 'task_run_completed', id: 'e4', taskRunId: 'run-official', ts: 4, finishedAt: 4 },
    ], 'run-official');
    const selfCheck = projectTaskRun([
      { type: 'task_run_created', id: 'e1', taskRunId: 'run-self-check', ts: 1, taskId: 'task-a', configId: 'cfg-1' },
      {
        type: 'self_check_observed',
        id: 'e2',
        taskRunId: 'run-self-check',
        ts: 2,
        observation: { id: 'self-check-1', taskRunId: 'run-self-check', ts: 2, summary: 'local check passed' },
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
    ], 'run-self-check');

    const evidence = makaAheEvidenceFromTaskRunProjections([official, selfCheck], {
      snapshotId: 'snapshot-baseline',
      runId: 'baseline-run',
      exportedAt: '2026-07-01T00:00:00.000Z',
    });

    assert.deepEqual(evidence.harnessResults.results.map((result) => result.taskId), ['task-a', 'task-b']);
    assert.equal(evidence.harnessResults.results[0]?.status, 'self_check_only');
    assert.equal(evidence.harnessResults.results[0]?.scoreAuthority, 'self_check');
    assert.match(evidence.harnessResults.results[0]?.warnings?.join('\n') ?? '', /non-authoritative/);
    assert.equal(evidence.harnessResults.results[1]?.status, 'official_pass');
    assert.equal(evidence.harnessResults.results[1]?.scoreAuthority, 'official_scorer');
    assert.equal(evidence.traceIndex.entries[0]?.transcript?.ref, 'traces/run-self-check/result.md');
  });

  test('keeps excluded, infra, and unscored cells explicit', () => {
    assert.equal(statusForScore({
      id: 'score-excluded',
      taskRunId: 'run-bucket',
      ts: 2,
      passed: false,
      scored: false,
      eligible: false,
      taxonomy: 'unsupported_adapter',
      excludedReason: 'no official adapter',
      authority: { source: 'system', authoritative: false },
    }), 'excluded');
    assert.equal(statusForScore({
      id: 'score-infra',
      taskRunId: 'run-bucket',
      ts: 2,
      passed: false,
      scored: true,
      eligible: true,
      taxonomy: 'infra_failed',
      errorClass: 'infra_failed',
      authority: { source: 'official_harbor_verifier', authoritative: true },
    }), 'infra_failed');
    assert.equal(
      makaAheEvidenceFromTaskRunProjections([
        projectTaskRun([
          { type: 'task_run_created', id: 'e1', taskRunId: 'run-unscored', ts: 1, taskId: 'task-1', configId: 'cfg-1' },
        ], 'run-unscored'),
      ], { snapshotId: 'snapshot-baseline' }).harnessResults.results[0]?.status,
      'unscored',
    );
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
      const projection = projectTaskRun([
        { type: 'task_run_created', id: 'e1', taskRunId: 'run-official', ts: 1, taskId: 'task-1', configId: 'cfg-1' },
        officialVerifierEvent('run-official', false),
        officialScoreEvent('run-official', false),
        { type: 'task_run_completed', id: 'e4', taskRunId: 'run-official', ts: 4, finishedAt: 4 },
      ], 'run-official');

      const first = await writeMakaAheEvidenceExport(out, {
        snapshot,
        projections: [projection],
        runId: 'baseline-run',
        exportedAt: '2026-07-01T00:00:00.000Z',
        includeEvents: true,
      });
      const firstHarness = await readFile(first.files.harnessResultsJson, 'utf8');
      const second = await writeMakaAheEvidenceExport(out, {
        snapshot,
        projections: [projection],
        runId: 'baseline-run',
        exportedAt: '2026-07-01T00:00:00.000Z',
        includeEvents: true,
      });

      assert.equal(firstHarness, await readFile(second.files.harnessResultsJson, 'utf8'));
      const parsedHarness = JSON.parse(firstHarness);
      assert.equal(parsedHarness.results[0].status, 'official_fail');
      assert.equal(parsedHarness.results[0].traceRef.ref, 'traces/run-official/task-run.json');
      const traceIndexJson = await readFile(join(out, 'trace-index.json'), 'utf8');
      assert.match(traceIndexJson, /traces\/run-official\/result.md/);
      assert.match(traceIndexJson, /traces\/run-official\/events.jsonl/);
      assert.match(await readFile(join(out, 'traces', 'run-official', 'task-run.json'), 'utf8'), /maka.task_run_export.v1/);
      assert.match(await readFile(join(out, 'traces', 'run-official', 'events.jsonl'), 'utf8'), /task_run_created/);
    } finally {
      await rm(repo, { recursive: true, force: true });
      await rm(out, { recursive: true, force: true });
    }
  });
});

function fixtureComponents(sourcePath: string): readonly MakaAheTargetComponent[] {
  return [{
    id: 'fixture-prompt',
    category: 'system_prompt',
    label: 'Fixture prompt',
    description: 'Fixture source-backed prompt component',
    editable: true,
    sourceRefs: [{ path: sourcePath }],
  }];
}

function statusForScore(score: ScoreResult): string | undefined {
  const projection = projectTaskRun([
    { type: 'task_run_created', id: 'e1', taskRunId: 'run-bucket', ts: 1, taskId: 'task-1', configId: 'cfg-1' },
    scoreEvent(score),
  ], 'run-bucket');
  return makaAheEvidenceFromTaskRunProjections([projection], { snapshotId: 'snapshot-baseline' }).harnessResults.results[0]?.status;
}

function scoreEvent(result: ScoreResult): TaskEvent {
  return { type: 'score_result_recorded', id: `event-${result.id}`, taskRunId: result.taskRunId, ts: result.ts, result };
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
