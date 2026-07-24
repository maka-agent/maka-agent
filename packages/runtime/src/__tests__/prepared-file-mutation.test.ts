import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { describe, it } from 'node:test';
import { GitFileCheckpointCarrier } from '../git-file-checkpoint-carrier.js';
import { decidePreparedFileMutation } from '../prepared-file-mutation.js';
import { parseToolRecoveryFact } from '../tool-recovery-facts.js';

describe('prepared file mutation runtime fact', () => {
  it('accepts an exact versioned before/after Git checkpoint payload', () => {
    const parsed = parseToolRecoveryFact({
      kind: 'maka.file.prepared_mutation',
      version: 1,
      legacyProjection: 'invisible',
      payload: {
        protocol: 'prepared_file_mutation_v1',
        operationId: 'operation-edit-1',
        workspaceRoot: '/workspace',
        canonicalPath: '/workspace/notes.txt',
        relativePath: 'notes.txt',
        before: {
          kind: 'file',
          sha256: 'a'.repeat(64),
          blobOid: '1'.repeat(40),
          byteLength: 10,
          mode: 0o100644,
        },
        expectedAfter: {
          kind: 'file',
          sha256: 'b'.repeat(64),
          blobOid: '2'.repeat(40),
          byteLength: 11,
          mode: 0o100644,
        },
        transform: {
          id: 'maka.edit',
          version: 1,
          argsHash: 'c'.repeat(64),
        },
        carrier: {
          kind: 'git_object_v1',
          repositoryCommonDir: '/workspace/.git',
          retentionRef: 'refs/maka/checkpoints/session-1/operation-edit-1',
        },
      },
    });

    assert.equal(parsed.status as string, 'prepared_file_mutation');
  });

  it('finalizes without replay when the current file matches the prepared after image', () => {
    const parsed = preparedMutation();
    assert.equal(parsed.status, 'prepared_file_mutation');
    if (parsed.status !== 'prepared_file_mutation') return;

    assert.deepEqual(
      decidePreparedFileMutation(parsed.fact, { kind: 'file', sha256: 'b'.repeat(64) }),
      { disposition: 'finalize', reasonCode: 'prepared_after_matches' },
    );
  });

  it('requests deterministic redo when the current file still matches the before image', () => {
    const parsed = preparedMutation();
    assert.equal(parsed.status, 'prepared_file_mutation');
    if (parsed.status !== 'prepared_file_mutation') return;

    assert.deepEqual(
      decidePreparedFileMutation(parsed.fact, { kind: 'file', sha256: 'a'.repeat(64) }),
      { disposition: 'redo', reasonCode: 'prepared_before_matches' },
    );
  });

  it('parks when content matches but POSIX permission bits drift', () => {
    const parsed = preparedMutation();
    assert.equal(parsed.status, 'prepared_file_mutation');
    if (parsed.status !== 'prepared_file_mutation') return;

    assert.deepEqual(
      decidePreparedFileMutation(parsed.fact, {
        kind: 'file',
        sha256: 'b'.repeat(64),
        mode: 0o600,
      }),
      { disposition: 'park', reasonCode: 'prepared_file_mode_drifted' },
    );
  });

  it('prepares immutable before/after Git blobs without changing the working file or index', async () => {
    const root = await mkdtemp(join(tmpdir(), 'maka-git-file-checkpoint-'));
    try {
      await git(root, 'init', '--quiet');
      await writeFile(join(root, 'notes.txt'), 'before OLD after');
      const statusBefore = await git(root, 'status', '--porcelain=v1');
      const carrier = new GitFileCheckpointCarrier();

      const fact = await carrier.prepare({
        operationId: 'operation-edit-1',
        workspaceRoot: root,
        targetPath: 'notes.txt',
        expectedContent: Buffer.from('before NEW after'),
        transform: { id: 'maka.edit', version: 1, argsHash: 'c'.repeat(64) },
      });

      assert.equal(await readFile(join(root, 'notes.txt'), 'utf8'), 'before OLD after');
      assert.equal(await git(root, 'status', '--porcelain=v1'), statusBefore);
      assert.equal(fact.before.kind, 'file');
      assert.equal(fact.expectedAfter.sha256.length, 64);
      assert.ok(fact.expectedAfter.blobOid);
      assert.ok(fact.carrier);
      assert.equal(
        await git(root, 'cat-file', '-p', fact.expectedAfter.blobOid),
        'before NEW after',
      );
      assert.equal(
        await git(root, 'rev-parse', '--verify', fact.carrier.retentionRef),
        await git(root, 'rev-parse', '--verify', `${fact.carrier.retentionRef}^{commit}`),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('observes only complete current-file identity for prepared mutation decisions', async () => {
    const root = await mkdtemp(join(tmpdir(), 'maka-git-file-observe-'));
    try {
      await git(root, 'init', '--quiet');
      await writeFile(join(root, 'notes.txt'), 'before OLD after');
      const carrier = new GitFileCheckpointCarrier();
      const fact = await carrier.prepare({
        operationId: 'operation-edit-observe',
        workspaceRoot: root,
        targetPath: 'notes.txt',
        expectedContent: Buffer.from('before NEW after'),
        transform: { id: 'maka.edit', version: 1, argsHash: 'd'.repeat(64) },
      });

      assert.deepEqual(await carrier.inspect(fact), {
        kind: 'file',
        sha256: fact.before.kind === 'file' ? fact.before.sha256 : '',
      });
      await writeFile(join(root, 'notes.txt'), 'before NEW after');
      assert.deepEqual(await carrier.inspect(fact), {
        kind: 'file',
        sha256: fact.expectedAfter.sha256,
      });
      await rm(join(root, 'notes.txt'));
      assert.deepEqual(await carrier.inspect(fact), { kind: 'missing' });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('redos a prepared mutation from its retained after blob with atomic replacement', async () => {
    const root = await mkdtemp(join(tmpdir(), 'maka-git-file-redo-'));
    try {
      await git(root, 'init', '--quiet');
      await writeFile(join(root, 'notes.txt'), 'before OLD after');
      const carrier = new GitFileCheckpointCarrier();
      const fact = await carrier.prepare({
        operationId: 'operation-edit-redo',
        workspaceRoot: root,
        targetPath: 'notes.txt',
        expectedContent: Buffer.from('before NEW after'),
        transform: { id: 'maka.edit', version: 1, argsHash: 'e'.repeat(64) },
      });

      await carrier.redo(fact);

      assert.equal(await readFile(join(root, 'notes.txt'), 'utf8'), 'before NEW after');
      assert.deepEqual(
        (await readdir(root)).filter((name) => name.includes('.maka-')),
        [],
      );
      assert.deepEqual(decidePreparedFileMutation(fact, await carrier.inspect(fact)), {
        disposition: 'finalize',
        reasonCode: 'prepared_after_matches',
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  for (const failpoint of [
    'after_temp_write',
    'after_temp_fsync',
    'before_replace',
    'after_replace',
    'after_parent_fsync',
  ] as const) {
    it(`recovers a ${failpoint} interruption to one complete file image`, async () => {
      const root = await mkdtemp(join(tmpdir(), `maka-file-crash-${failpoint}-`));
      try {
        await git(root, 'init', '--quiet');
        await writeFile(join(root, 'notes.txt'), 'before image');
        const preparer = new GitFileCheckpointCarrier();
        const fact = await preparer.prepare({
          operationId: `operation-${failpoint}`,
          workspaceRoot: root,
          targetPath: 'notes.txt',
          expectedContent: Buffer.from('after image'),
          transform: { id: 'maka.write.utf8', version: 1, argsHash: 'f'.repeat(64) },
        });
        const interrupted = new GitFileCheckpointCarrier({
          failpoint: (point) => {
            if (point === failpoint) throw new Error(`crash:${point}`);
          },
        });

        await assert.rejects(interrupted.redo(fact), new RegExp(`crash:${failpoint}`));
        const contentAfterCrash = await readFile(join(root, 'notes.txt'), 'utf8');
        assert.equal(
          contentAfterCrash,
          failpoint === 'after_replace' || failpoint === 'after_parent_fsync'
            ? 'after image'
            : 'before image',
        );
        assert.deepEqual(
          (await readdir(root)).filter((name) => name.includes('.maka-')),
          [],
        );

        const restarted = new GitFileCheckpointCarrier();
        await restarted.redo(fact);
        assert.equal(await readFile(join(root, 'notes.txt'), 'utf8'), 'after image');
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });
  }

  it('never replaces an externally drifted file during redo', async () => {
    const root = await mkdtemp(join(tmpdir(), 'maka-file-drift-'));
    try {
      await git(root, 'init', '--quiet');
      await writeFile(join(root, 'notes.txt'), 'before image');
      const carrier = new GitFileCheckpointCarrier();
      const fact = await carrier.prepare({
        operationId: 'operation-drift',
        workspaceRoot: root,
        targetPath: 'notes.txt',
        expectedContent: Buffer.from('after image'),
        transform: { id: 'maka.write.utf8', version: 1, argsHash: 'e'.repeat(64) },
      });
      await writeFile(join(root, 'notes.txt'), 'external edit');

      await assert.rejects(carrier.redo(fact), /prepared_file_drifted/);
      assert.equal(await readFile(join(root, 'notes.txt'), 'utf8'), 'external edit');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  for (const failpoint of ['before_checkpoint_durable', 'after_checkpoint_durable'] as const) {
    it(`keeps the live file unchanged at ${failpoint}`, async () => {
      const root = await mkdtemp(join(tmpdir(), `maka-checkpoint-crash-${failpoint}-`));
      try {
        await git(root, 'init', '--quiet');
        await writeFile(join(root, 'notes.txt'), 'before image');
        const carrier = new GitFileCheckpointCarrier({
          failpoint: (point) => {
            if (point === failpoint) throw new Error(`crash:${point}`);
          },
        });

        await assert.rejects(
          carrier.prepare({
            operationId: `operation-${failpoint}`,
            workspaceRoot: root,
            targetPath: 'notes.txt',
            expectedContent: Buffer.from('after image'),
            transform: { id: 'maka.write.utf8', version: 1, argsHash: 'd'.repeat(64) },
          }),
          new RegExp(`crash:${failpoint}`),
        );
        assert.equal(await readFile(join(root, 'notes.txt'), 'utf8'), 'before image');
        const refs = await git(
          root,
          'for-each-ref',
          '--format=%(refname)',
          'refs/maka/checkpoints',
        );
        assert.equal(refs.length > 0, failpoint === 'after_checkpoint_durable');
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });
  }
});

const execFileAsync = promisify(execFile);

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd, encoding: 'utf8' });
  return stdout.trim();
}

function preparedMutation() {
  return parseToolRecoveryFact({
    kind: 'maka.file.prepared_mutation',
    version: 1,
    legacyProjection: 'invisible',
    payload: {
      protocol: 'prepared_file_mutation_v1',
      operationId: 'operation-edit-1',
      workspaceRoot: '/workspace',
      canonicalPath: '/workspace/notes.txt',
      relativePath: 'notes.txt',
      before: {
        kind: 'file',
        sha256: 'a'.repeat(64),
        blobOid: '1'.repeat(40),
        byteLength: 10,
        mode: 0o100644,
      },
      expectedAfter: {
        kind: 'file',
        sha256: 'b'.repeat(64),
        blobOid: '2'.repeat(40),
        byteLength: 11,
        mode: 0o100644,
      },
      transform: { id: 'maka.edit', version: 1, argsHash: 'c'.repeat(64) },
      carrier: {
        kind: 'git_object_v1',
        repositoryCommonDir: '/workspace/.git',
        retentionRef: 'refs/maka/checkpoints/session-1/operation-edit-1',
      },
    },
  });
}
