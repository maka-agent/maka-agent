import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { BackendRegistry, FakeBackend } from '@maka/runtime';
import type { Config, Task } from '../contracts.js';
import { runExperiment } from '../runner.js';

const registerFakeBackend = (registry: BackendRegistry): void => {
  registry.register('fake', (ctx) =>
    new FakeBackend({ sessionId: ctx.sessionId, header: ctx.header, store: ctx.store }),
  );
};

const fakeConfig: Config = {
  id: 'fake-cfg',
  backend: 'fake',
  llmConnectionSlug: 'fake',
  model: 'fake-model',
};

async function fileExistsRecursive(root: string, name: string): Promise<boolean> {
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const full = join(root, entry.name);
    if (entry.isDirectory()) {
      if (await fileExistsRecursive(full, name)) return true;
    } else if (entry.name === name) {
      return true;
    }
  }
  return false;
}

async function withDirs<T>(fn: (fixtureDir: string, storageRoot: string) => Promise<T>): Promise<T> {
  const fixtureDir = await mkdtemp(join(tmpdir(), 'maka-lab-fx-'));
  const storageRoot = await mkdtemp(join(tmpdir(), 'maka-lab-store-'));
  try {
    return await fn(fixtureDir, storageRoot);
  } finally {
    await rm(fixtureDir, { recursive: true, force: true });
    await rm(storageRoot, { recursive: true, force: true });
  }
}

describe('runExperiment (walking skeleton)', () => {
  test('runs Config × Task end-to-end, scores a passing verification, records a trajectory', async () => {
    await withDirs(async (fixtureDir, storageRoot) => {
      await writeFile(join(fixtureDir, 'marker.txt'), 'present', 'utf8');
      const task: Task = {
        id: 'pass-task',
        instruction: 'do the thing',
        workspaceDir: fixtureDir,
        verification: { command: 'test -f marker.txt' },
      };

      const result = await runExperiment(fakeConfig, task, {
        storageRoot,
        registerBackends: registerFakeBackend,
      });

      assert.equal(result.status, 'completed');
      assert.equal(result.passed, true);
      assert.equal(result.exitCode, 0);
      assert.equal(result.taskId, 'pass-task');
      assert.equal(result.configId, 'fake-cfg');
      // The agent run produced a trajectory...
      assert.ok(result.steps > 0, 'expected a non-empty trajectory');
      // ...persisted as the canonical runtime-events.jsonl.
      assert.ok(
        await fileExistsRecursive(storageRoot, 'runtime-events.jsonl'),
        'expected runtime-events.jsonl under the storage root',
      );
    });
  });

  test('scores a failing verification as not passed (run still completes)', async () => {
    await withDirs(async (fixtureDir, storageRoot) => {
      const task: Task = {
        id: 'fail-task',
        instruction: 'do the thing',
        workspaceDir: fixtureDir,
        verification: { command: 'test -f does-not-exist.txt' },
      };

      const result = await runExperiment(fakeConfig, task, {
        storageRoot,
        registerBackends: registerFakeBackend,
      });

      assert.equal(result.status, 'completed');
      assert.equal(result.passed, false);
      assert.notEqual(result.exitCode, 0);
    });
  });
});
