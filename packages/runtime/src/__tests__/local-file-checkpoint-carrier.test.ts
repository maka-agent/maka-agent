import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import {
  chmod,
  link,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';

import {
  LocalFileCheckpointCarrier,
  type LocalFileCheckpointFailpoint,
} from '../local-file-checkpoint-carrier.js';
import { decidePreparedFileMutation } from '../prepared-file-mutation.js';
import { parseToolRecoveryFact } from '../tool-recovery-facts.js';

describe('local file transaction checkpoint carrier', () => {
  for (const mode of [0o600, 0o700, 0o660] as const) {
    test(`preserves exact POSIX mode ${mode.toString(8)} across atomic replacement`, {
      skip: process.platform === 'win32',
    }, async () => {
      const root = await mkdtemp(join(tmpdir(), `maka-local-mode-${mode.toString(8)}-`));
      try {
        const path = join(root, 'notes.txt');
        await writeFile(path, 'before image');
        await chmod(path, mode);
        const carrier = new LocalFileCheckpointCarrier();
        const fact = await carrier.prepare({
          operationId: `operation-mode-${mode.toString(8)}`,
          workspaceRoot: root,
          targetPath: 'notes.txt',
          expectedContent: Buffer.from('after image'),
          transform: { id: 'maka.write.utf8', version: 1, argsHash: '9'.repeat(64) },
        });

        await carrier.apply(fact, Buffer.from('after image'));

        assert.equal((await stat(path)).mode & 0o7777, mode);
        assert.equal((await carrier.inspect(fact)).kind, 'file');
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });
  }

  test('rejects hard-linked targets instead of silently breaking inode sharing', {
    skip: process.platform === 'win32',
  }, async () => {
    const root = await mkdtemp(join(tmpdir(), 'maka-local-hard-link-'));
    try {
      const path = join(root, 'notes.txt');
      await writeFile(path, 'before image');
      await link(path, join(root, 'alias.txt'));

      await assert.rejects(
        new LocalFileCheckpointCarrier().prepare({
          operationId: 'operation-hard-link',
          workspaceRoot: root,
          targetPath: 'notes.txt',
          expectedContent: Buffer.from('after image'),
          transform: { id: 'maka.write.utf8', version: 1, argsHash: '8'.repeat(64) },
        }),
        /hard-linked/,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('recovers a Windows split replace from its durable before backup', async () => {
    const root = await mkdtemp(join(tmpdir(), 'maka-local-windows-backup-'));
    try {
      const path = join(root, 'notes.txt');
      await writeFile(path, 'before image');
      const preparer = new LocalFileCheckpointCarrier({ platform: 'win32' });
      const fact = await preparer.prepare({
        operationId: 'operation-windows-split-replace',
        workspaceRoot: root,
        targetPath: 'notes.txt',
        expectedContent: Buffer.from('after image'),
        transform: { id: 'maka.write.utf8', version: 1, argsHash: '6'.repeat(64) },
      });
      const interrupted = new LocalFileCheckpointCarrier({
        platform: 'win32',
        replaceFile: async (_source, target) => {
          await unlink(target);
          throw new Error('simulated split replace interruption');
        },
      });

      await assert.rejects(
        interrupted.apply(fact, Buffer.from('after image')),
        (error: unknown) =>
          error instanceof Error && error.name === 'DurableToolExecutionUnsettledError',
      );
      await assert.rejects(readFile(path), { code: 'ENOENT' });

      const restarted = new LocalFileCheckpointCarrier({ platform: 'win32' });
      assert.equal(
        decidePreparedFileMutation(fact, await restarted.inspect(fact)).disposition,
        'redo',
      );
      const interruptedAgain = new LocalFileCheckpointCarrier({
        platform: 'win32',
        failpoint: (point) => {
          if (point === 'before_replace') throw new Error('second interruption');
        },
      });
      await assert.rejects(
        interruptedAgain.apply(fact, Buffer.from('after image')),
        /second interruption/,
      );
      assert.equal(
        decidePreparedFileMutation(fact, await restarted.inspect(fact)).disposition,
        'redo',
      );
      await restarted.apply(fact, Buffer.from('after image'));
      assert.equal(await readFile(path, 'utf8'), 'after image');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('reports explicit drift when both the Windows target and before backup are missing', async () => {
    const root = await mkdtemp(join(tmpdir(), 'maka-local-windows-missing-before-'));
    try {
      const path = join(root, 'notes.txt');
      await writeFile(path, 'before image');
      const carrier = new LocalFileCheckpointCarrier({ platform: 'win32' });
      const fact = await carrier.prepare({
        operationId: 'operation-windows-missing-before',
        workspaceRoot: root,
        targetPath: 'notes.txt',
        expectedContent: Buffer.from('after image'),
        transform: { id: 'maka.write.utf8', version: 1, argsHash: '5'.repeat(64) },
      });
      const inspect = carrier.inspect.bind(carrier);
      let inspections = 0;
      carrier.inspect = async (checkpoint) => {
        const state = await inspect(checkpoint);
        inspections += 1;
        if (inspections === 2) await unlink(path);
        return state;
      };

      await assert.rejects(
        carrier.apply(fact, Buffer.from('after image')),
        /prepared_file_missing_before_backup/,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('prepares before/after identities without Git or storing file contents in the fact', async () => {
    const root = await mkdtemp(join(tmpdir(), 'maka-local-checkpoint-'));
    try {
      await writeFile(join(root, 'notes.txt'), 'before image');
      let transformInput = '';
      const carrier = new LocalFileCheckpointCarrier();
      const fact = await carrier.prepare({
        operationId: 'operation-1',
        workspaceRoot: root,
        targetPath: 'notes.txt',
        deriveExpectedContent: (before) => {
          transformInput = Buffer.from(before ?? []).toString('utf8');
          return Buffer.from('after image');
        },
        transform: { id: 'maka.edit.compute_edited_source', version: 1, argsHash: 'a'.repeat(64) },
      });

      assert.equal(transformInput, 'before image');
      assert.equal(fact.before.kind, 'file');
      assert.equal(fact.before.kind === 'file' ? fact.before.blobOid : undefined, undefined);
      assert.equal(fact.expectedAfter.blobOid, undefined);
      assert.equal(fact.carrier, undefined);
      assert.equal(parseToolRecoveryFact(runtimeFact(fact)).status, 'prepared_file_mutation');
      assert.equal(await readFile(join(root, 'notes.txt'), 'utf8'), 'before image');
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
  ] as const satisfies readonly LocalFileCheckpointFailpoint[]) {
    test(`restart converges after ${failpoint}`, async () => {
      const root = await mkdtemp(join(tmpdir(), `maka-local-${failpoint}-`));
      try {
        await writeFile(join(root, 'notes.txt'), 'before image');
        const fact = await new LocalFileCheckpointCarrier().prepare({
          operationId: `operation-${failpoint}`,
          workspaceRoot: root,
          targetPath: 'notes.txt',
          expectedContent: Buffer.from('after image'),
          transform: { id: 'maka.write.utf8', version: 1, argsHash: 'b'.repeat(64) },
        });
        const interrupted = new LocalFileCheckpointCarrier({
          failpoint: (point) => {
            if (point === failpoint) throw new Error(`crash:${point}`);
          },
        });

        await assert.rejects(interrupted.apply(fact, Buffer.from('after image')), (error) => {
          if (failpoint !== 'after_replace' && failpoint !== 'after_parent_fsync') {
            return error instanceof Error && error.message === `crash:${failpoint}`;
          }
          return (
            error instanceof Error &&
            error.name === 'DurableToolExecutionUnsettledError' &&
            error.cause instanceof Error &&
            error.cause.message === `crash:${failpoint}`
          );
        });
        const state = decidePreparedFileMutation(fact, await interrupted.inspect(fact));
        assert.equal(
          state.disposition,
          failpoint === 'after_replace' || failpoint === 'after_parent_fsync' ? 'finalize' : 'redo',
        );
        const transactionArtifacts = (await readdir(root)).filter((name) =>
          name.includes('.maka-'),
        );
        assert.equal(
          transactionArtifacts.some((name) => name.endsWith('.tmp')),
          false,
        );
        assert.equal(
          transactionArtifacts.some((name) => name.includes('.maka-before-')),
          process.platform === 'win32' &&
            (failpoint === 'after_replace' || failpoint === 'after_parent_fsync'),
        );

        await new LocalFileCheckpointCarrier().apply(fact, Buffer.from('after image'));
        assert.equal(await readFile(join(root, 'notes.txt'), 'utf8'), 'after image');
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });
  }

  test('validates the temporary file hash before replace', async () => {
    const root = await mkdtemp(join(tmpdir(), 'maka-local-temp-corrupt-'));
    try {
      await writeFile(join(root, 'notes.txt'), 'before image');
      const fact = await new LocalFileCheckpointCarrier().prepare({
        operationId: 'operation-corrupt-temp',
        workspaceRoot: root,
        targetPath: 'notes.txt',
        expectedContent: Buffer.from('after image'),
        transform: { id: 'maka.write.utf8', version: 1, argsHash: 'c'.repeat(64) },
      });
      const corrupting = new LocalFileCheckpointCarrier({
        failpoint: (point, detail) => {
          if (point === 'after_temp_write' && detail?.tempPath) {
            writeFileSync(detail.tempPath, 'corrupt image');
          }
        },
      });

      await assert.rejects(
        corrupting.apply(fact, Buffer.from('after image')),
        /temporary file does not match/,
      );
      assert.equal(await readFile(join(root, 'notes.txt'), 'utf8'), 'before image');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('parks external drift instead of replacing it', async () => {
    const root = await mkdtemp(join(tmpdir(), 'maka-local-drift-'));
    try {
      await writeFile(join(root, 'notes.txt'), 'before image');
      const carrier = new LocalFileCheckpointCarrier();
      const fact = await carrier.prepare({
        operationId: 'operation-drift',
        workspaceRoot: root,
        targetPath: 'notes.txt',
        expectedContent: Buffer.from('after image'),
        transform: { id: 'maka.write.utf8', version: 1, argsHash: 'd'.repeat(64) },
      });
      await writeFile(join(root, 'notes.txt'), 'external edit');

      await assert.rejects(
        carrier.apply(fact, Buffer.from('after image')),
        /prepared_file_drifted/,
      );
      assert.equal(await readFile(join(root, 'notes.txt'), 'utf8'), 'external edit');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('rejects a prepared image that exceeds the configured checkpoint limit', async () => {
    const root = await mkdtemp(join(tmpdir(), 'maka-local-limit-'));
    try {
      const carrier = new LocalFileCheckpointCarrier({ maxFileBytes: 4 });

      await assert.rejects(
        carrier.prepare({
          operationId: 'operation-too-large',
          workspaceRoot: root,
          targetPath: 'large.txt',
          expectedContent: Buffer.from('12345'),
          transform: { id: 'maka.write.utf8', version: 1, argsHash: 'f'.repeat(64) },
        }),
        (error: unknown) =>
          error instanceof Error &&
          error.name === 'PreparedFileCheckpointLimitError' &&
          'reasonCode' in error &&
          error.reasonCode === 'prepared_file_checkpoint_size_limit_exceeded',
      );
      await assert.rejects(readFile(join(root, 'large.txt')), { code: 'ENOENT' });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('rejects an oversized before image before reading it into a checkpoint', async () => {
    const root = await mkdtemp(join(tmpdir(), 'maka-local-before-limit-'));
    try {
      await writeFile(join(root, 'large.txt'), '12345');
      const carrier = new LocalFileCheckpointCarrier({ maxFileBytes: 4 });

      await assert.rejects(
        carrier.prepare({
          operationId: 'operation-before-too-large',
          workspaceRoot: root,
          targetPath: 'large.txt',
          expectedContent: Buffer.from('ok'),
          transform: { id: 'maka.write.utf8', version: 1, argsHash: '1'.repeat(64) },
        }),
        (error: unknown) =>
          error instanceof Error &&
          error.name === 'PreparedFileCheckpointLimitError' &&
          'side' in error &&
          error.side === 'before',
      );
      assert.equal(await readFile(join(root, 'large.txt'), 'utf8'), '12345');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('rejects an oversized current image during recovery observation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'maka-local-inspect-limit-'));
    try {
      const path = join(root, 'notes.txt');
      await writeFile(path, 'old');
      const carrier = new LocalFileCheckpointCarrier({ maxFileBytes: 4 });
      const fact = await carrier.prepare({
        operationId: 'operation-inspect-too-large',
        workspaceRoot: root,
        targetPath: 'notes.txt',
        expectedContent: Buffer.from('new'),
        transform: { id: 'maka.write.utf8', version: 1, argsHash: '7'.repeat(64) },
      });
      await writeFile(path, '12345');

      await assert.rejects(
        carrier.inspect(fact),
        (error: unknown) =>
          error instanceof Error &&
          error.name === 'PreparedFileCheckpointLimitError' &&
          'side' in error &&
          error.side === 'current',
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('removes the deterministic orphan temp for an interrupted operation before redo', async () => {
    const root = await mkdtemp(join(tmpdir(), 'maka-local-orphan-'));
    try {
      await writeFile(join(root, 'notes.txt'), 'before image');
      const carrier = new LocalFileCheckpointCarrier();
      const fact = await carrier.prepare({
        operationId: 'operation-orphan',
        workspaceRoot: root,
        targetPath: 'notes.txt',
        expectedContent: Buffer.from('after image'),
        transform: { id: 'maka.write.utf8', version: 1, argsHash: '0'.repeat(64) },
      });
      const operationKey = createHash('sha256').update(fact.operationId).digest('hex').slice(0, 32);
      const orphanPath = join(root, `.notes.txt.maka-${operationKey}.tmp`);
      await writeFile(orphanPath, 'partial old attempt');

      await carrier.apply(fact, Buffer.from('after image'));

      assert.equal(await readFile(join(root, 'notes.txt'), 'utf8'), 'after image');
      await assert.rejects(readFile(orphanPath), { code: 'ENOENT' });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('removes the deterministic orphan temp when the target already matches after', async () => {
    const root = await mkdtemp(join(tmpdir(), 'maka-local-finalize-orphan-'));
    try {
      await writeFile(join(root, 'notes.txt'), 'before image');
      const carrier = new LocalFileCheckpointCarrier();
      const fact = await carrier.prepare({
        operationId: 'operation-finalize-orphan',
        workspaceRoot: root,
        targetPath: 'notes.txt',
        expectedContent: Buffer.from('after image'),
        transform: { id: 'maka.write.utf8', version: 1, argsHash: '2'.repeat(64) },
      });
      await writeFile(join(root, 'notes.txt'), 'after image');
      const operationKey = createHash('sha256').update(fact.operationId).digest('hex').slice(0, 32);
      const orphanPath = join(root, `.notes.txt.maka-${operationKey}.tmp`);
      await writeFile(orphanPath, 'partial old attempt');

      await carrier.apply(fact, Buffer.from('after image'));

      await assert.rejects(readFile(orphanPath), { code: 'ENOENT' });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('rejects a target whose symlink parent escapes the workspace', {
    skip: process.platform === 'win32',
  }, async () => {
    const root = await mkdtemp(join(tmpdir(), 'maka-local-link-root-'));
    const outside = await mkdtemp(join(tmpdir(), 'maka-local-link-outside-'));
    try {
      await symlink(outside, join(root, 'outside'));
      const carrier = new LocalFileCheckpointCarrier();
      await assert.rejects(
        carrier.prepare({
          operationId: 'operation-escape',
          workspaceRoot: root,
          targetPath: 'outside/file.txt',
          expectedContent: Buffer.from('unsafe'),
          transform: { id: 'maka.write.utf8', version: 1, argsHash: 'e'.repeat(64) },
        }),
        /escapes the workspace/,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });
});

function runtimeFact(fact: unknown) {
  return {
    kind: 'maka.file.prepared_mutation',
    version: 1,
    legacyProjection: 'invisible' as const,
    payload: fact,
  };
}
