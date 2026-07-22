import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  readlink,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import {
  discoverMarkedStorageRoot,
  resolveRootControlNamespace,
  resolveStorageRoot,
  STORAGE_ROOT_MARKER_FILE,
  StorageRootAuthorityError,
} from '@maka/storage/root-authority';
import { registerFakeBackend } from '../backends.js';
import { runHarborCell } from '../harbor-cell.js';
import { openHeadlessStorageForRead } from '../headless-storage.js';
import { runTaskOnce } from '../task-agent-controller.js';
import { inspectTaskRun } from '../task-run-inspect.js';
import type { Config, Task } from '../contracts.js';

const fakeConfig: Config = {
  id: 'fake-config',
  backend: 'fake',
  llmConnectionSlug: 'fake',
  model: 'fake-model',
};

describe('Headless storage root boundary', () => {
  test('rejects an Interactive root before Harbor mutates storage, workspace, output, or control state', async () => {
    const base = await mkdtemp(join(tmpdir(), 'maka-headless-root-kind-'));
    const storageRoot = join(base, 'storage');
    const workspaceDir = join(base, 'workspace');
    const outputDir = join(base, 'output');
    let backendRegistrationCalled = false;
    try {
      await mkdir(workspaceDir);
      await mkdir(outputDir);
      await writeFile(join(workspaceDir, 'workspace-sentinel.txt'), 'workspace\n');
      await writeFile(join(outputDir, 'output-sentinel.txt'), 'output\n');
      const interactive = await resolveStorageRoot({ path: storageRoot, kind: 'interactive' });
      await writeFile(join(storageRoot, 'storage-sentinel.txt'), 'storage\n');
      const controlDirectory = join(resolveRootControlNamespace(), interactive.rootId);
      const before = await snapshotManifest({
        storageRoot,
        workspaceDir,
        outputDir,
        controlDirectory,
      });

      await assert.rejects(
        () =>
          runHarborCell({
            config: fakeConfig,
            instruction: 'Do not mutate anything.',
            cwd: workspaceDir,
            outputDir,
            storageRoot,
            registerBackends: (registry) => {
              backendRegistrationCalled = true;
              registerFakeBackend(registry);
            },
          }),
        (error: unknown) =>
          error instanceof StorageRootAuthorityError && error.code === 'root_kind_mismatch',
      );

      assert.equal(backendRegistrationCalled, false);
      assert.deepEqual(
        await snapshotManifest({ storageRoot, workspaceDir, outputDir, controlDirectory }),
        before,
      );
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  test('executes on a Headless root and reads TaskRun and execution state without writes', async () => {
    const base = await mkdtemp(join(tmpdir(), 'maka-headless-storage-read-'));
    const storageRoot = join(base, 'storage');
    const workspaceDir = join(base, 'workspace');
    try {
      await mkdir(workspaceDir);
      await writeFile(join(workspaceDir, 'proof.txt'), 'present\n');
      const task: Task = {
        id: 'headless-storage-task',
        instruction: 'Complete the task.',
        workspaceDir,
        verification: { command: 'test -f proof.txt', protectedPaths: [] },
      };

      const result = await runTaskOnce(fakeConfig, task, {
        storageRoot,
        taskRunId: 'task-run-1',
      });
      assert.equal(result.resultRecord.status, 'completed');

      const discovered = await discoverMarkedStorageRoot({ path: storageRoot });
      assert.equal(discovered.kind, 'headless');
      const beforeRead = await snapshotTree(storageRoot, 'storage');
      const storage = await openHeadlessStorageForRead(storageRoot);
      assert.equal('appendEvent' in storage.taskRunStore, false);
      assert.deepEqual(await storage.taskRunStore.listTaskRunIds(), ['task-run-1']);
      assert.equal((await storage.taskRunStore.project('task-run-1')).status, 'completed');
      assert.equal((await storage.executionStores.sessionStore.list()).length, 1);
      assert.deepEqual(await snapshotTree(storageRoot, 'storage'), beforeRead);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  test('opens a discovered Headless capability without adopting a replacement root', async () => {
    const base = await mkdtemp(join(tmpdir(), 'maka-headless-discovered-root-'));
    const storageRoot = join(base, 'storage');
    const displacedRoot = join(base, 'displaced');
    try {
      const capability = await resolveStorageRoot({ path: storageRoot, kind: 'headless' });
      await rename(storageRoot, displacedRoot);
      await resolveStorageRoot({ path: storageRoot, kind: 'headless' });

      await assert.rejects(
        () => openHeadlessStorageForRead(capability),
        (error: unknown) =>
          error instanceof StorageRootAuthorityError && error.code === 'root_identity_changed',
      );
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  test('fails TaskRun inspection closed when root authority changes after AgentRun header read', async () => {
    const base = await mkdtemp(join(tmpdir(), 'maka-headless-inspect-authority-'));
    const storageRoot = join(base, 'storage');
    const workspaceDir = join(base, 'workspace');
    try {
      await mkdir(workspaceDir);
      await writeFile(join(workspaceDir, 'proof.txt'), 'present\n');
      const task: Task = {
        id: 'headless-inspect-authority',
        instruction: 'Complete the task.',
        workspaceDir,
        verification: { command: 'test -f proof.txt', protectedPaths: [] },
      };
      const result = await runTaskOnce(fakeConfig, task, {
        storageRoot,
        taskRunId: 'authority-change-run',
      });
      assert.equal(result.projection.status, 'completed');

      const storage = await openHeadlessStorageForRead(storageRoot);
      const markerPath = join(storageRoot, STORAGE_ROOT_MARKER_FILE);
      const agentRunStore = {
        ...storage.executionStores.agentRunStore,
        readRun: async (sessionId: string, runId: string) => {
          const header = await storage.executionStores.agentRunStore.readRun(sessionId, runId);
          const marker = JSON.parse(await readFile(markerPath, 'utf8')) as Record<string, unknown>;
          await writeFile(markerPath, `${JSON.stringify({ ...marker, rootId: 'f'.repeat(64) })}\n`);
          return header;
        },
      };

      await assert.rejects(
        () =>
          inspectTaskRun(
            {
              taskRunStore: storage.taskRunStore,
              agentRunStore,
              runtimeEventStore: storage.executionStores.runtimeEventStore,
            },
            'authority-change-run',
          ),
        (error: unknown) =>
          error instanceof StorageRootAuthorityError && error.code === 'root_identity_changed',
      );
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });
});

interface ManifestEntry {
  path: string;
  type: 'directory' | 'file' | 'symlink' | 'other' | 'missing';
  mode?: number;
  size?: string;
  mtimeNs?: string;
  contentSha256?: string;
}

async function snapshotManifest(paths: {
  storageRoot: string;
  workspaceDir: string;
  outputDir: string;
  controlDirectory: string;
}): Promise<ManifestEntry[]> {
  const groups = await Promise.all([
    snapshotTree(paths.storageRoot, 'storage'),
    snapshotTree(paths.workspaceDir, 'workspace'),
    snapshotTree(paths.outputDir, 'output'),
    snapshotTree(paths.controlDirectory, 'control'),
  ]);
  return groups.flat();
}

async function snapshotTree(path: string, label: string): Promise<ManifestEntry[]> {
  let stats;
  try {
    stats = await lstat(path, { bigint: true });
  } catch (error) {
    if (isNotFound(error)) return [{ path: label, type: 'missing' }];
    throw error;
  }

  const type = stats.isDirectory()
    ? 'directory'
    : stats.isFile()
      ? 'file'
      : stats.isSymbolicLink()
        ? 'symlink'
        : 'other';
  const entry: ManifestEntry = {
    path: label,
    type,
    mode: Number(stats.mode & 0o7777n),
    size: stats.size.toString(),
    mtimeNs: stats.mtimeNs.toString(),
  };
  if (type === 'file') {
    entry.contentSha256 = createHash('sha256')
      .update(await readFile(path))
      .digest('hex');
  } else if (type === 'symlink') {
    entry.contentSha256 = createHash('sha256')
      .update(await readlink(path))
      .digest('hex');
  }
  if (type !== 'directory') return [entry];

  const children = await readdir(path);
  const descendants = await Promise.all(
    children.sort().map((child) => snapshotTree(join(path, child), `${label}/${child}`)),
  );
  return [entry, ...descendants.flat()];
}

function isNotFound(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}
