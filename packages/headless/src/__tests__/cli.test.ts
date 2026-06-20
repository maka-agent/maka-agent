import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, test } from 'node:test';
import { readResults } from '../results.js';

const cliPath = fileURLToPath(new URL('../cli.js', import.meta.url));

function runCli(args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [cliPath, ...args]);
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d: Buffer) => { stdout += d.toString('utf8'); });
    child.stderr.on('data', (d: Buffer) => { stderr += d.toString('utf8'); });
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

describe('maka-headless CLI', () => {
  test('eval executes a fake spec end-to-end and writes results + table', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'maka-headless-cli-'));
    try {
      await mkdir(join(dir, 'fixture'), { recursive: true });
      await writeFile(join(dir, 'fixture', 'marker.txt'), 'ok', 'utf8');
      const spec = {
        configs: [{ id: 'fake-cfg', backend: 'fake', llmConnectionSlug: 'fake', model: 'fake-model' }],
        tasks: [
          {
            id: 't-pass',
            instruction: 'go',
            workspaceDir: 'fixture', // resolved relative to the spec file
            verification: { command: 'test -f marker.txt', protectedPaths: [] },
          },
        ],
      };
      const specPath = join(dir, 'spec.json');
      await writeFile(specPath, JSON.stringify(spec), 'utf8');
      const outDir = join(dir, 'out');

      const run = await runCli(['eval', specPath, '--out', outDir]);
      assert.equal(run.code, 0, run.stderr);

      const records = await readResults(join(outDir, 'results.jsonl'));
      assert.equal(records.length, 1);
      assert.equal(records[0]?.passed, true);

      const compare = await runCli(['compare', join(outDir, 'results.jsonl')]);
      assert.equal(compare.code, 0, compare.stderr);
      assert.match(compare.stdout, /\| Task \| fake-cfg \|/);
      assert.match(compare.stdout, /\| t-pass \| ✅ \|/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('eval without a spec path exits non-zero', async () => {
    const result = await runCli(['eval']);
    assert.equal(result.code, 1);
  });

  test('rejects an unknown flag', async () => {
    const result = await runCli(['eval', 'spec.json', '--bogus', 'x']);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /unknown flag/);
  });

  test('rejects --out without a value', async () => {
    const result = await runCli(['eval', 'spec.json', '--out']);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /needs a value/);
  });

  test('rejects a task missing protectedPaths (grading boundary required)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'maka-headless-cli-'));
    try {
      const spec = {
        configs: [{ id: 'fake-cfg', backend: 'fake', llmConnectionSlug: 'fake', model: 'fake-model' }],
        tasks: [{ id: 't', instruction: 'go', workspaceDir: 'fixture', verification: { command: 'true' } }],
      };
      const specPath = join(dir, 'spec.json');
      await writeFile(specPath, JSON.stringify(spec), 'utf8');
      const result = await runCli(['eval', specPath, '--out', join(dir, 'out')]);
      assert.equal(result.code, 1);
      assert.match(result.stderr, /protectedPaths/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('refuses a model-backed backend (fail closed — no isolated executor)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'maka-headless-cli-'));
    try {
      const spec = {
        configs: [{ id: 'real', backend: 'ai-sdk', llmConnectionSlug: 'x', model: 'm' }],
        tasks: [{ id: 't', instruction: 'go', workspaceDir: 'fixture',
          verification: { command: 'true', protectedPaths: [] } }],
      };
      const specPath = join(dir, 'spec.json');
      await writeFile(specPath, JSON.stringify(spec), 'utf8');
      const result = await runCli(['eval', specPath, '--out', join(dir, 'out')]);
      assert.equal(result.code, 1);
      assert.match(result.stderr, /isolated executor/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('exits non-zero when a run errors out (missing workspace = infra failure)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'maka-headless-cli-'));
    try {
      const spec = {
        configs: [{ id: 'fake-cfg', backend: 'fake', llmConnectionSlug: 'fake', model: 'fake-model' }],
        tasks: [{ id: 't', instruction: 'go', workspaceDir: 'does-not-exist',
          verification: { command: 'true', protectedPaths: [] } }],
      };
      const specPath = join(dir, 'spec.json');
      await writeFile(specPath, JSON.stringify(spec), 'utf8');
      const result = await runCli(['eval', specPath, '--out', join(dir, 'out')]);
      assert.equal(result.code, 1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('exits 0 when a run completes but fails verification (valid benchmark data)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'maka-headless-cli-'));
    try {
      await mkdir(join(dir, 'fixture'), { recursive: true });
      const spec = {
        configs: [{ id: 'fake-cfg', backend: 'fake', llmConnectionSlug: 'fake', model: 'fake-model' }],
        tasks: [{ id: 't-fail', instruction: 'go', workspaceDir: 'fixture',
          verification: { command: 'test -f nope.txt', protectedPaths: [] } }],
      };
      const specPath = join(dir, 'spec.json');
      await writeFile(specPath, JSON.stringify(spec), 'utf8');
      const result = await runCli(['eval', specPath, '--out', join(dir, 'out')]);
      assert.equal(result.code, 0, result.stderr);
      const records = await readResults(join(dir, 'out', 'results.jsonl'));
      assert.equal(records[0]?.passed, false);
      assert.ok(!records[0]?.error);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('task run, inspect, and export operate on task-run store projections', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'maka-headless-task-cli-'));
    try {
      await mkdir(join(dir, 'fixture'), { recursive: true });
      await writeFile(join(dir, 'fixture', 'marker.txt'), 'ok', 'utf8');
      const spec = {
        configs: [{ id: 'fake-cfg', backend: 'fake', llmConnectionSlug: 'fake', model: 'fake-model' }],
        tasks: [
          {
            id: 'tb-pass',
            instruction: 'go',
            workspaceDir: 'fixture',
            verifier: {
              kind: 'terminal_bench',
              adapter: 'terminal-bench',
              instanceId: 'tb-local',
              testCommand: 'test -f marker.txt',
              protectedPaths: [],
            },
          },
        ],
      };
      const specPath = join(dir, 'spec.json');
      const outDir = join(dir, 'out');
      await writeFile(specPath, JSON.stringify(spec), 'utf8');

      const run = await runCli([
        'task',
        'run',
        specPath,
        '--task',
        'tb-pass',
        '--config',
        'fake-cfg',
        '--task-run-id',
        'task-run-1',
        '--out',
        outDir,
        '--include-events',
      ]);
      assert.equal(run.code, 0, run.stderr);
      assert.match(run.stdout, /taskRunId: task-run-1/);

      const inspect = await runCli(['task', 'inspect', 'task-run-1', '--store', join(outDir, 'runs'), '--json']);
      assert.equal(inspect.code, 0, inspect.stderr);
      assert.equal(JSON.parse(inspect.stdout).taxonomy, 'passed');

      const exportDir = join(dir, 'manual-export');
      const exported = await runCli([
        'task',
        'export',
        'task-run-1',
        '--store',
        join(outDir, 'runs'),
        '--out',
        exportDir,
        '--include-events',
      ]);
      assert.equal(exported.code, 0, exported.stderr);
      const taskRunJson = JSON.parse(await readFile(join(exportDir, 'task-run.json'), 'utf8'));
      assert.equal(taskRunJson.verifier.kind, 'terminal_bench');
      assert.equal(taskRunJson.verifier.benchmark.instanceId, 'tb-local');
      assert.match(await readFile(join(exportDir, 'events.jsonl'), 'utf8'), /verifier_result_recorded/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('task resume continues a parked needs_approval task run', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'maka-headless-task-resume-'));
    try {
      await mkdir(join(dir, 'fixture'), { recursive: true });
      await writeFile(join(dir, 'fixture', 'marker.txt'), 'ok', 'utf8');
      const spec = {
        configs: [{ id: 'fake-cfg', backend: 'fake', llmConnectionSlug: 'fake', model: 'fake-model' }],
        tasks: [
          {
            id: 'approval-task',
            instruction: 'go',
            workspaceDir: 'fixture',
            verification: { command: 'test -f marker.txt', protectedPaths: [] },
          },
        ],
      };
      const specPath = join(dir, 'spec.json');
      const outDir = join(dir, 'out');
      const taskRunId = 'parked-run';
      const firstAttemptId = `${taskRunId}-attempt-1`;
      await writeFile(specPath, JSON.stringify(spec), 'utf8');
      await mkdir(join(outDir, 'runs', 'task-runs'), { recursive: true });
      await writeFile(join(outDir, 'runs', 'task-runs', `${taskRunId}.jsonl`), [
        JSON.stringify({ type: 'task_run_created', id: 'e1', taskRunId, ts: 1, taskId: 'approval-task', configId: 'fake-cfg' }),
        JSON.stringify({
          type: 'task_run_started',
          id: 'e2',
          taskRunId,
          ts: 2,
          startedAt: 2,
          sessionId: 'session-1',
          agentRunId: 'agent-1',
        }),
        JSON.stringify({
          type: 'task_attempt_started',
          id: 'e3',
          taskRunId,
          ts: 2,
          attemptId: firstAttemptId,
          startedAt: 2,
          sessionId: 'session-1',
          agentRunId: 'agent-1',
        }),
        JSON.stringify({
          type: 'task_inbox_item_recorded',
          id: 'e4',
          taskRunId,
          ts: 3,
          item: {
            schemaVersion: 1,
            inboxItemId: 'inbox-1',
            taskRunId,
            attemptId: firstAttemptId,
            kind: 'approval_request',
            status: 'open',
            title: 'Approval required',
            reason: 'Bash requires approval',
            createdAt: 3,
            relatedRequestId: 'request-1',
          },
        }),
        JSON.stringify({
          type: 'task_run_needs_approval',
          id: 'e5',
          taskRunId,
          ts: 3,
          attemptId: firstAttemptId,
          reason: 'approval',
          inboxItemId: 'inbox-1',
        }),
        '',
      ].join('\n'), 'utf8');

      const resumed = await runCli(['task', 'resume', taskRunId, '--spec', specPath, '--out', outDir]);
      assert.equal(resumed.code, 0, resumed.stderr);
      assert.match(resumed.stdout, /resumed: parked-run/);
      assert.match(resumed.stdout, /status: completed/);

      const inspect = await runCli(['task', 'inspect', taskRunId, '--store', join(outDir, 'runs'), '--json']);
      assert.equal(inspect.code, 0, inspect.stderr);
      const projected = JSON.parse(inspect.stdout);
      assert.equal(projected.status, 'completed');
      assert.equal(projected.taxonomy, 'passed');
      assert.equal(projected.attempts, 2);
      assert.equal(projected.parked, undefined);

      const exported = JSON.parse(await readFile(join(outDir, 'exports', taskRunId, 'task-run.json'), 'utf8'));
      assert.equal(exported.taskRun.status, 'completed');
      assert.equal(exported.inbox.items[0].status, 'resolved');

      const records = await readResults(join(outDir, 'results.jsonl'));
      assert.equal(records.length, 1);
      assert.equal(records[0]?.taskId, 'approval-task');
      assert.equal(records[0]?.passed, true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('task retry-failed retries retryable failures and skips unsupported adapters', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'maka-headless-task-retry-'));
    try {
      await mkdir(join(dir, 'fixture'), { recursive: true });
      const spec = {
        configs: [{ id: 'fake-cfg', backend: 'fake', llmConnectionSlug: 'fake', model: 'fake-model' }],
        tasks: [
          { id: 'pass', instruction: 'go', workspaceDir: 'fixture', verification: { command: 'true', protectedPaths: [] } },
          { id: 'retry-me', instruction: 'go', workspaceDir: 'fixture', verification: { command: 'true', protectedPaths: [] } },
          { id: 'unsupported', instruction: 'go', workspaceDir: 'fixture', verification: { command: 'true', protectedPaths: [] } },
        ],
      };
      const specPath = join(dir, 'spec.json');
      const priorPath = join(dir, 'prior-results.jsonl');
      await writeFile(specPath, JSON.stringify(spec), 'utf8');
      await writeFile(priorPath, [
        JSON.stringify(record('pass', 'fake-cfg', true)),
        JSON.stringify(record('retry-me', 'fake-cfg', false, { errorClass: 'verification_failed', exitCode: 1 })),
        JSON.stringify(record('unsupported', 'fake-cfg', false, {
          errorClass: 'unsupported_adapter',
          excludedReason: 'unsupported_adapter',
          error: 'adapter missing',
          exitCode: null,
        })),
        '',
      ].join('\n'), 'utf8');

      const outDir = join(dir, 'out');
      const result = await runCli(['task', 'retry-failed', priorPath, '--spec', specPath, '--out', outDir]);
      assert.equal(result.code, 0, result.stderr);
      assert.match(result.stdout, /retry retry-me/);
      assert.match(result.stdout, /skip unsupported/);

      const records = await readResults(join(outDir, 'results.jsonl'));
      assert.equal(records.length, 4);
      assert.equal(records.filter((r) => r.taskId === 'retry-me').length, 2);
      assert.equal(records.at(-1)?.passed, true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

function record(taskId: string, configId: string, passed: boolean, extra: Record<string, unknown> = {}) {
  return {
    taskId,
    configId,
    sessionId: `s-${taskId}`,
    runId: `r-${taskId}`,
    status: 'completed',
    passed,
    exitCode: passed ? 0 : 1,
    steps: 1,
    durationMs: 1,
    startedAt: 1,
    finishedAt: 2,
    scored: true,
    eligible: true,
    ...extra,
  };
}
