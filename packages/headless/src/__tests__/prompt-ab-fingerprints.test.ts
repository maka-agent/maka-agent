import assert from 'node:assert/strict';
import { mkdir, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { sha256 } from './helpers/hash-fixture.js';
import { withDir } from './helpers/temp-dir.js';

const promptAbScriptUrl = new URL('../../harbor/run-prompt-ab.mjs', import.meta.url).href;

describe('prompt A/B source fingerprints', () => {
  test('rejects dirty subject repos unless an explicit subject fingerprint is provided', async () => {
    const { buildSubjectFingerprint } = await import(promptAbScriptUrl);
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
    const { buildToolchainFingerprint } = await import(promptAbScriptUrl);

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
    const { buildToolchainFingerprint } = await import(promptAbScriptUrl);
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
    const { buildSubjectFingerprint } = await import(promptAbScriptUrl);
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
    const { buildTaskSourceFingerprint } = await import(promptAbScriptUrl);
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
    const { buildTaskSourceFingerprint } = await import(promptAbScriptUrl);
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
