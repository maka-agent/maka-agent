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

describe('maka-lab CLI', () => {
  test('run executes a fake spec end-to-end and writes results + table', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'maka-lab-cli-'));
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
            verification: { command: 'test -f marker.txt' },
          },
        ],
      };
      const specPath = join(dir, 'spec.json');
      await writeFile(specPath, JSON.stringify(spec), 'utf8');
      const outDir = join(dir, 'out');

      const run = await runCli(['run', specPath, '--out', outDir]);
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

  test('run without a spec path exits non-zero', async () => {
    const result = await runCli(['run']);
    assert.equal(result.code, 1);
  });
});
