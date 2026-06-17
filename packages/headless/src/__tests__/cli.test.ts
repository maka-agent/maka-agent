import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
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
});
