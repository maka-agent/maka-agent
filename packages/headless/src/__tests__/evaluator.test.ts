import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { runVerification } from '../evaluator.js';

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'maka-headless-eval-'));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe('runVerification', () => {
  test('passes on exit code 0', async () => {
    await withTempDir(async (dir) => {
      const result = await runVerification('exit 0', dir);
      assert.equal(result.passed, true);
      assert.equal(result.exitCode, 0);
      assert.equal(result.timedOut, false);
    });
  });

  test('fails on a non-zero exit code', async () => {
    await withTempDir(async (dir) => {
      const result = await runVerification('exit 3', dir);
      assert.equal(result.passed, false);
      assert.equal(result.exitCode, 3);
    });
  });

  test('captures stdout and runs in the given cwd', async () => {
    await withTempDir(async (dir) => {
      const result = await runVerification('pwd', dir);
      assert.equal(result.passed, true);
      assert.match(result.stdout, /maka-headless-eval-/);
    });
  });

  test('kills and fails a command that exceeds the timeout', async () => {
    await withTempDir(async (dir) => {
      const result = await runVerification('sleep 5', dir, 200);
      assert.equal(result.timedOut, true);
      assert.equal(result.passed, false);
    });
  });
});
