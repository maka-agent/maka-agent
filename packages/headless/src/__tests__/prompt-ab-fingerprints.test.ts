import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmod, lstat, mkdir, readFile, readdir, symlink, writeFile } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { describe, test } from 'node:test';
import {
  buildSubjectFingerprint,
  buildTaskSourceFingerprint,
  buildToolchainFingerprint,
} from '../experiment-fingerprint.js';
import { sha256 } from './helpers/hash-fixture.js';
import { withDir } from './helpers/temp-dir.js';

describe('prompt A/B source fingerprints', () => {
  test('rejects dirty subject repos unless an explicit subject fingerprint is provided', async () => {
    const gitWithStatus =
      (status: string) =>
      async (_repoPath: string, args: readonly string[]): Promise<string> => {
        const command = args.join(' ');
        if (command === 'rev-parse --show-toplevel') return '/repo';
        if (command === 'rev-parse HEAD') return 'abc123';
        if (command === 'status --porcelain=v1 --untracked-files=normal') return status;
        throw new Error(`unexpected git command: ${command}`);
      };
    const trackedDirtyGit = gitWithStatus(' M src/runtime.ts');
    const untrackedDirtyGit = gitWithStatus('?? scratch.txt');

    await assert.rejects(
      buildSubjectFingerprint('/repo', undefined, trackedDirtyGit),
      /must be clean/,
    );
    await assert.rejects(
      buildSubjectFingerprint('/repo', undefined, untrackedDirtyGit),
      /must be clean/,
    );
    await assert.rejects(
      buildSubjectFingerprint('/repo', 'dirty-subject-snapshot-1', untrackedDirtyGit),
      /EXPLICIT_SUBJECT_FINGERPRINT must be a sha256/,
    );
    await assert.doesNotReject(buildSubjectFingerprint('/repo', sha256('a'), untrackedDirtyGit));
  });

  test('builds a toolchain fingerprint from Node and Harbor identity unless explicit', async () => {
    await withDir(async (dir) => {
      await writeFile(
        join(dir, 'package-lock.json'),
        '{"lockfileVersion":3,"packages":{}}\n',
        'utf8',
      );
      await mkdir(join(dir, 'node_modules'), { recursive: true });
      await writeFile(
        join(dir, 'node_modules/.package-lock.json'),
        '{"lockfileVersion":3,"packages":{"node_modules/ai":{"version":"6.0.185"}}}\n',
        'utf8',
      );

      const first = await buildToolchainFingerprint(undefined, async () => 'harbor 1.0.0', dir);
      const second = await buildToolchainFingerprint(undefined, async () => 'harbor 2.0.0', dir);
      assert.notEqual(first, second);

      await writeFile(
        join(dir, 'node_modules/.package-lock.json'),
        '{"lockfileVersion":3,"packages":{"node_modules/ai":{"version":"6.0.186"}}}\n',
        'utf8',
      );
      const dependencyChanged = await buildToolchainFingerprint(
        undefined,
        async () => 'harbor 1.0.0',
        dir,
      );
      assert.notEqual(first, dependencyChanged);
    });

    await assert.rejects(
      buildToolchainFingerprint('toolchain-v1', async () => 'harbor 1.0.0'),
      /TOOLCHAIN_FINGERPRINT must be a sha256/,
    );
    assert.equal(
      await buildToolchainFingerprint(sha256('b'), async () => 'harbor 1.0.0'),
      sha256('b'),
    );
  });

  test('requires an installed dependency lock unless the toolchain fingerprint is explicit', async () => {
    await withDir(async (dir) => {
      await writeFile(
        join(dir, 'package-lock.json'),
        '{"lockfileVersion":3,"packages":{}}\n',
        'utf8',
      );

      await assert.rejects(
        buildToolchainFingerprint(undefined, async () => 'harbor 1.0.0', dir),
        /node_modules\/\.package-lock\.json/,
      );
      assert.equal(
        await buildToolchainFingerprint(sha256('b'), async () => 'harbor 1.0.0', dir),
        sha256('b'),
      );
    });
  });

  test('includes runtime dist artifacts in the subject fingerprint', async () => {
    await withDir(async (dir) => {
      const repo = join(dir, 'repo');
      const distFile = join(repo, 'packages/headless/dist/harbor-cell.js');
      await mkdir(join(repo, 'packages/headless/dist'), { recursive: true });
      await writeFile(distFile, 'export const version = 1;\n', 'utf8');
      const git = async (_repoPath: string, args: readonly string[]): Promise<string> => {
        const command = args.join(' ');
        if (command === 'rev-parse --show-toplevel') return repo;
        if (command === 'rev-parse HEAD') return 'abc123';
        if (command === 'status --porcelain=v1 --untracked-files=normal') return '';
        throw new Error(`unexpected git command: ${command}`);
      };

      const first = await buildSubjectFingerprint(repo, undefined, git);
      await writeFile(distFile, 'export const version = 2;\n', 'utf8');
      const second = await buildSubjectFingerprint(repo, undefined, git);

      assert.notEqual(first, second);
    });
  });

  test('hashes non-task.toml files inside selected task directories', async () => {
    await withDir(async (dir) => {
      const tasksRoot = join(dir, 'tasks');
      const taskPath = join(tasksRoot, 'task-a');
      await mkdir(taskPath, { recursive: true });
      await writeFile(join(taskPath, 'task.toml'), 'id = "task-a"\n', 'utf8');
      await writeFile(join(taskPath, 'Dockerfile'), 'FROM ubuntu:24.04\n', 'utf8');

      const first = await buildTaskSourceFingerprint(tasksRoot, [{ id: 'task-a', path: taskPath }]);
      await writeFile(join(taskPath, 'Dockerfile'), 'FROM ubuntu:26.04\n', 'utf8');
      const second = await buildTaskSourceFingerprint(tasksRoot, [
        { id: 'task-a', path: taskPath },
      ]);

      assert.notEqual(first, second);
    });
  });

  test('rejects symlinks inside selected task directories', async () => {
    await withDir(async (dir) => {
      const tasksRoot = join(dir, 'tasks');
      const taskPath = join(tasksRoot, 'task-a');
      const externalFile = join(dir, 'external-fixture.txt');
      await mkdir(taskPath, { recursive: true });
      await writeFile(join(taskPath, 'task.toml'), 'id = "task-a"\n', 'utf8');
      await writeFile(externalFile, 'fixture v1\n', 'utf8');
      await symlink(externalFile, join(taskPath, 'fixture.txt'));

      await assert.rejects(
        buildTaskSourceFingerprint(tasksRoot, [{ id: 'task-a', path: taskPath }]),
        /task source symlink is not supported/,
      );
    });
  });
});

// Byte-contract pin for the resume-critical fingerprint trio. The tests above
// only assert that input changes change the hash; these bind the exact output
// bytes. `legacyFingerprintOracle` is a frozen, verbatim port of the hashing
// algorithm as it lived in run-prompt-ab.mjs before the helpers moved to
// experiment-fingerprint.ts — do NOT refactor it to share code with the module
// under test, and do not update it: if these assertions ever fail, the module
// changed resume identity for every prior A/B run.
describe('experiment fingerprint byte contract', () => {
  test('explicit subject fingerprint hashes to the pinned constant', async () => {
    assert.equal(
      await buildSubjectFingerprint('/repo', `sha256:${'a'.repeat(64)}`, async () => {
        throw new Error('git must not be consulted for an explicit subject fingerprint');
      }),
      'sha256:bb02d53e06206262747388edea9ae81725b62498f074ef6d2fbce6639b5d36f3',
    );
  });

  test('subject, toolchain, and task-source fingerprints match the frozen legacy algorithm', async () => {
    await withDir(async (dir) => {
      // Deterministic fixture: a fake repo with one present dist artifact (the
      // other three dist roots are missing), a dependency lock pair, and a task
      // directory with a Dockerfile plus an executable nested script.
      const repo = join(dir, 'repo');
      await mkdir(join(repo, 'packages/headless/dist'), { recursive: true });
      await writeFile(
        join(repo, 'packages/headless/dist/harbor-cell.js'),
        'export const version = 1;\n',
        'utf8',
      );
      await writeFile(
        join(repo, 'package-lock.json'),
        '{"lockfileVersion":3,"packages":{}}\n',
        'utf8',
      );
      await mkdir(join(repo, 'node_modules'), { recursive: true });
      await writeFile(
        join(repo, 'node_modules/.package-lock.json'),
        '{"lockfileVersion":3,"packages":{"node_modules/ai":{"version":"6.0.185"}}}\n',
        'utf8',
      );
      const tasksRoot = join(dir, 'tasks');
      const taskPath = join(tasksRoot, 'task-a');
      await mkdir(join(taskPath, 'scripts'), { recursive: true });
      await writeFile(join(taskPath, 'task.toml'), 'id = "task-a"\n', 'utf8');
      await writeFile(join(taskPath, 'Dockerfile'), 'FROM ubuntu:24.04\n', 'utf8');
      await writeFile(join(taskPath, 'scripts/run.sh'), '#!/bin/sh\nexit 0\n', 'utf8');
      await chmod(join(taskPath, 'scripts/run.sh'), 0o755);

      const git = async (_repoPath: string, args: readonly string[]): Promise<string> => {
        const command = args.join(' ');
        if (command === 'rev-parse --show-toplevel') return repo;
        if (command === 'rev-parse HEAD') return 'abc123';
        if (command === 'status --porcelain=v1 --untracked-files=normal') return '';
        throw new Error(`unexpected git command: ${command}`);
      };
      const tool = async () => 'harbor 9.9.9';
      const oracle = legacyFingerprintOracle();

      assert.equal(
        await buildSubjectFingerprint(repo, undefined, git),
        await oracle.subject(repo, git),
      );
      assert.equal(
        await buildToolchainFingerprint(undefined, tool, repo),
        await oracle.toolchain(tool, repo),
      );
      assert.equal(
        await buildTaskSourceFingerprint(tasksRoot, [{ id: 'task-a', path: taskPath }]),
        await oracle.taskSource(tasksRoot, [{ id: 'task-a', path: taskPath }]),
      );
    });
  });
});

/** Frozen verbatim port of the pre-refactor run-prompt-ab.mjs hashing helpers. */
function legacyFingerprintOracle() {
  type Entry = Record<string, string | boolean>;
  const hashBytes = (bytes: Buffer) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
  const canonicalJson = (value: unknown): string => {
    if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
    if (value && typeof value === 'object') {
      const entries = Object.entries(value)
        .filter(([, entryValue]) => entryValue !== undefined)
        .sort(([a], [b]) => a.localeCompare(b));
      return `{${entries.map(([key, entryValue]) => `${JSON.stringify(key)}:${canonicalJson(entryValue)}`).join(',')}}`;
    }
    return JSON.stringify(value);
  };
  const hashPayload = (payload: unknown) =>
    `sha256:${createHash('sha256').update(canonicalJson(payload)).digest('hex')}`;
  const walk = async (root: string, dir: string, entries: Entry[]): Promise<void> => {
    const children = await readdir(dir, { withFileTypes: true });
    children.sort((a, b) => a.name.localeCompare(b.name));
    for (const child of children) {
      const path = join(dir, child.name);
      const stats = await lstat(path);
      const entryPath = relative(root, path).split('\\').join('/');
      if (child.isDirectory()) {
        entries.push({ path: entryPath, type: 'directory' });
        await walk(root, path, entries);
      } else if (child.isSymbolicLink()) {
        throw new Error(`unexpected symlink in oracle fixture: ${entryPath}`);
      } else if (child.isFile()) {
        entries.push({
          path: entryPath,
          type: 'file',
          executable: (stats.mode & 0o111) !== 0,
          hash: hashBytes(await readFile(path)),
        });
      } else {
        entries.push({ path: entryPath, type: 'other' });
      }
    }
  };
  const hashDirectory = async (root: string): Promise<Entry[]> => {
    const entries: Entry[] = [];
    await walk(root, root, entries);
    return entries;
  };
  const hashOptionalDirectory = async (path: string): Promise<Entry[]> => {
    try {
      return await hashDirectory(resolve(path));
    } catch (error) {
      if ((error as { code?: unknown }).code === 'ENOENT') return [{ path: '.', type: 'missing' }];
      throw error;
    }
  };
  const runtimeArtifacts = async (repoRoot: string) =>
    hashPayload({
      kind: 'prompt-ab-runtime-artifacts',
      artifacts: await Promise.all(
        [
          'packages/headless/dist',
          'packages/core/dist',
          'packages/runtime/dist',
          'packages/storage/dist',
        ].map(async (artifactPath) => ({
          path: artifactPath,
          entries: await hashOptionalDirectory(join(repoRoot, artifactPath)),
        })),
      ),
    });
  return {
    subject: async (
      repoPath: string,
      git: (repoPath: string, args: readonly string[]) => Promise<string>,
    ) => {
      const [gitRoot, head, status] = await Promise.all([
        git(repoPath, ['rev-parse', '--show-toplevel']),
        git(repoPath, ['rev-parse', 'HEAD']),
        git(repoPath, ['status', '--porcelain=v1', '--untracked-files=normal']),
      ]);
      return hashPayload({
        kind: 'prompt-ab-subject',
        path: resolve(repoPath),
        gitRoot: resolve(gitRoot),
        head,
        dirty: false,
        statusHash: hashPayload({ status }),
        runtimeArtifactFingerprint: await runtimeArtifacts(gitRoot),
      });
    },
    toolchain: async (tool: () => Promise<string>, repoPath: string) => {
      const [packageLock, installedLock] = await Promise.all([
        readFile(join(repoPath, 'package-lock.json')),
        readFile(join(repoPath, 'node_modules/.package-lock.json')),
      ]);
      return hashPayload({
        kind: 'prompt-ab-toolchain',
        node: process.version,
        harborVersion: await tool(),
        dependencyInstallFingerprint: {
          packageLockPath: resolve(join(repoPath, 'package-lock.json')),
          packageLockHash: hashBytes(packageLock),
          installedPackageLockPath: resolve(join(repoPath, 'node_modules/.package-lock.json')),
          installedPackageLockHash: hashBytes(installedLock),
        },
      });
    },
    taskSource: async (tasksRoot: string, tasks: ReadonlyArray<{ id: string; path: string }>) => {
      const taskEntries = [];
      for (const task of tasks) {
        taskEntries.push({
          id: task.id,
          path: resolve(task.path),
          entries: await hashDirectory(resolve(task.path)),
        });
      }
      return hashPayload({
        kind: 'prompt-ab-task-source',
        tasksRoot: resolve(tasksRoot),
        tasks: taskEntries,
      });
    },
  };
}
