import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
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

        await assert.rejects(
          interrupted.apply(fact, Buffer.from('after image')),
          new RegExp(`crash:${failpoint}`),
        );
        const state = decidePreparedFileMutation(fact, await interrupted.inspect(fact));
        assert.equal(
          state.disposition,
          failpoint === 'after_replace' || failpoint === 'after_parent_fsync' ? 'finalize' : 'redo',
        );
        assert.deepEqual(
          (await readdir(root)).filter((name) => name.includes('.maka-')),
          [],
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
