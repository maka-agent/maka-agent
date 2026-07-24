import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';

import { computeEditedSource } from '../edit-replace.js';
import { createPreparedWriteEditRecoveryContracts } from '../file-tool-recovery.js';
import { fileMutationArgsHash } from '../file-mutation-transform.js';
import {
  LocalFileCheckpointCarrier,
  preparedFileMutationAuxiliaryPaths,
  type PreparedFileMutationExecutionContext,
} from '../local-file-checkpoint-carrier.js';
import type { CurrentFileCheckpointState } from '../prepared-file-mutation.js';
import type { UnsettledToolOperation } from '../tool-recovery-contract.js';
import type { PreparedFileMutationFact } from '../tool-recovery-facts.js';
import { WorkerBackedFileCheckpointCarrier } from '../worker-backed-file-checkpoint-carrier.js';

describe('prepared Write/Edit recovery contracts', () => {
  test('current after image finalizes without executing the mutation again', async () => {
    const carrier = new RecoveryCarrier({ kind: 'file', sha256: 'a'.repeat(64) });
    const contract = createPreparedWriteEditRecoveryContracts(carrier).Write;

    const result = await contract.reconcile?.(writeOperation());

    assert.deepEqual(result?.decision, {
      result: 'applied',
      reasonCode: 'prepared_after_matches',
      nextAction: 'synthesize_response',
      synthesizedResult: {
        ok: true,
        path: 'notes.txt',
        bytes: 8,
        recovered: true,
      },
    });
    assert.equal(carrier.applyCalls, 0);
    assert.deepEqual(carrier.finalizeContexts, [{ cwd: '/workspace', mode: 'ask' }]);
  });

  test('routes recovery finalization through the worker with the source Run context', async () => {
    const local = new RecoveryCarrier({ kind: 'file', sha256: 'a'.repeat(64) });
    const workerCalls: unknown[] = [];
    const carrier = new WorkerBackedFileCheckpointCarrier(local, {
      execute: async (input) => {
        workerCalls.push(input);
        return { kind: 'prepared_file_finalize', ok: true };
      },
    });

    const result = await createPreparedWriteEditRecoveryContracts(carrier).Write.reconcile(
      writeOperation(),
    );

    assert.equal(result.decision.nextAction, 'synthesize_response');
    assert.deepEqual(local.finalizeContexts, []);
    assert.equal(workerCalls.length, 1);
    assert.deepEqual(workerCalls[0], {
      operation: {
        kind: 'prepared_file_finalize',
        path: '/workspace/notes.txt',
        fact: preparedFact('maka.write.utf8'),
      },
      cwd: '/workspace',
      mode: 'ask',
    });
  });

  test('current before image regenerates and installs the prepared after image', async () => {
    const carrier = new RecoveryCarrier({ kind: 'missing' });
    const contract = createPreparedWriteEditRecoveryContracts(carrier).Write;

    const result = await contract.reconcile?.(writeOperation());

    assert.equal(carrier.applyCalls, 1);
    assert.deepEqual(carrier.finalizeContexts, [{ cwd: '/workspace', mode: 'ask' }]);
    assert.equal(result?.decision.result, 'applied');
    assert.equal(result?.decision.reasonCode, 'prepared_redone');
    assert.equal(result?.decision.nextAction, 'synthesize_response');
  });

  test('Edit recovery reruns the shared transform from the hash-matched before file without Git', async () => {
    const root = await mkdtemp(join(tmpdir(), 'maka-edit-recovery-no-git-'));
    try {
      const path = 'source.txt';
      const args = {
        path,
        old_string: 'alpha\nbeta',
        new_string: 'changed',
      };
      await writeFile(join(root, path), 'alpha\n  beta\ngamma\n');
      const carrier = new LocalFileCheckpointCarrier();
      const fact = await carrier.prepare({
        operationId: 'operation-edit-real',
        workspaceRoot: root,
        targetPath: path,
        deriveExpectedContent: (before) =>
          Buffer.from(
            computeEditedSource(
              Buffer.from(before ?? []).toString('utf8'),
              args.old_string,
              args.new_string,
              path,
            ).content,
          ),
        transform: {
          id: 'maka.edit.compute_edited_source',
          version: 1,
          argsHash: fileMutationArgsHash(args),
        },
      });
      const operation: UnsettledToolOperation = {
        operationId: fact.operationId,
        toolCallId: 'call-edit-real',
        toolName: 'Edit',
        args,
        recoveryMode: 'reconcile',
        workspaceCwd: root,
        permissionMode: 'ask',
        evidenceEventIds: ['call', 'prepared', 'dispatch'],
        preparedFileMutation: fact,
      };

      const result =
        await createPreparedWriteEditRecoveryContracts(carrier).Edit.reconcile(operation);

      assert.equal(result.decision.reasonCode, 'prepared_redone');
      assert.equal(await readFile(join(root, path), 'utf8'), 'changed\ngamma\n');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('recovers a cwd-local absolute Write target using its canonical checkpoint identity', async () => {
    const root = await mkdtemp(join(tmpdir(), 'maka-write-recovery-absolute-'));
    try {
      const targetPath = join(root, 'notes.txt');
      const args = { path: targetPath, content: 'expected' };
      const carrier = new LocalFileCheckpointCarrier();
      const fact = await carrier.prepare({
        operationId: 'operation-write-absolute',
        workspaceRoot: root,
        targetPath,
        expectedContent: Buffer.from(args.content),
        transform: {
          id: 'maka.write.utf8',
          version: 1,
          argsHash: fileMutationArgsHash(args),
        },
      });
      const operation: UnsettledToolOperation = {
        operationId: fact.operationId,
        toolCallId: 'call-write-absolute',
        toolName: 'Write',
        args,
        recoveryMode: 'reconcile',
        workspaceCwd: root,
        permissionMode: 'ask',
        evidenceEventIds: ['call', 'prepared', 'dispatch'],
        preparedFileMutation: fact,
      };

      const result =
        await createPreparedWriteEditRecoveryContracts(carrier).Write.reconcile(operation);

      assert.equal(result.decision.reasonCode, 'prepared_redone');
      assert.equal(await readFile(targetPath, 'utf8'), 'expected');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('cleans a Windows before-image backup before synthesizing recovered success', async () => {
    const root = await mkdtemp(join(tmpdir(), 'maka-recovery-windows-finalize-'));
    try {
      const args = { path: 'notes.txt', content: 'expected' };
      await writeFile(join(root, args.path), 'before');
      const interrupted = new LocalFileCheckpointCarrier({
        platform: 'win32',
        failpoint: (point) => {
          if (point === 'after_parent_fsync') throw new Error('crash before backup cleanup');
        },
      });
      const fact = await interrupted.prepare({
        operationId: 'operation-windows-finalize',
        workspaceRoot: root,
        targetPath: args.path,
        expectedContent: Buffer.from(args.content),
        transform: {
          id: 'maka.write.utf8',
          version: 1,
          argsHash: fileMutationArgsHash(args),
        },
      });
      await assert.rejects(interrupted.apply(fact, Buffer.from(args.content)));
      const backupPath = preparedFileMutationAuxiliaryPaths(fact).beforeBackupPath;
      assert.equal(await readFile(backupPath, 'utf8'), 'before');

      const recoveryCarrier = new LocalFileCheckpointCarrier({ platform: 'win32' });
      const operation: UnsettledToolOperation = {
        operationId: fact.operationId,
        toolCallId: 'call-windows-finalize',
        toolName: 'Write',
        args,
        recoveryMode: 'reconcile',
        workspaceCwd: root,
        permissionMode: 'ask',
        evidenceEventIds: ['call', 'prepared', 'dispatch'],
        preparedFileMutation: fact,
      };
      const result =
        await createPreparedWriteEditRecoveryContracts(recoveryCarrier).Write.reconcile(operation);

      assert.equal(result.decision.nextAction, 'synthesize_response');
      await assert.rejects(readFile(backupPath), { code: 'ENOENT' });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  for (const referentLocation of ['inside', 'outside'] as const) {
    test(`parks recovery when the prepared target becomes an ${referentLocation}-workspace symlink`, {
      skip: process.platform === 'win32',
    }, async () => {
      const root = await mkdtemp(join(tmpdir(), `maka-recovery-link-${referentLocation}-`));
      const outside =
        referentLocation === 'outside'
          ? await mkdtemp(join(tmpdir(), 'maka-recovery-link-referent-'))
          : root;
      try {
        const target = join(root, 'notes.txt');
        const referent = join(outside, 'referent.txt');
        const args = { path: 'notes.txt', content: 'expected' };
        await writeFile(target, 'before');
        await writeFile(referent, args.content);
        const carrier = new LocalFileCheckpointCarrier();
        const fact = await carrier.prepare({
          operationId: `operation-link-${referentLocation}`,
          workspaceRoot: root,
          targetPath: args.path,
          expectedContent: Buffer.from(args.content),
          transform: {
            id: 'maka.write.utf8',
            version: 1,
            argsHash: fileMutationArgsHash(args),
          },
        });
        await unlink(target);
        await symlink(referent, target);
        const operation: UnsettledToolOperation = {
          operationId: fact.operationId,
          toolCallId: `call-link-${referentLocation}`,
          toolName: 'Write',
          args,
          recoveryMode: 'reconcile',
          workspaceCwd: root,
          permissionMode: 'ask',
          evidenceEventIds: ['call', 'prepared', 'dispatch'],
          preparedFileMutation: fact,
        };

        const result =
          await createPreparedWriteEditRecoveryContracts(carrier).Write.reconcile(operation);

        assert.equal(result.decision.nextAction, 'park');
        assert.equal(result.decision.reasonCode, 'prepared_file_became_symbolic_link');
        assert.equal(await readFile(referent, 'utf8'), args.content);
      } finally {
        await rm(root, { recursive: true, force: true });
        if (outside !== root) await rm(outside, { recursive: true, force: true });
      }
    });
  }

  test('a current state matching neither before nor after parks without overwriting', async () => {
    const carrier = new RecoveryCarrier({ kind: 'file', sha256: 'd'.repeat(64) });
    const contract = createPreparedWriteEditRecoveryContracts(carrier).Edit;

    const result = await contract.reconcile?.(editOperation());

    assert.deepEqual(result?.decision, {
      result: 'conflict',
      reasonCode: 'prepared_file_drifted',
      nextAction: 'park',
    });
    assert.equal(carrier.applyCalls, 0);
    assert.deepEqual(carrier.finalizeContexts, []);
  });

  test('rejects a checkpoint rooted in a different workspace before observation', async () => {
    const carrier = new RecoveryCarrier({ kind: 'file', sha256: 'a'.repeat(64) });
    const contract = createPreparedWriteEditRecoveryContracts(carrier).Write;
    const operation = writeOperation();
    operation.workspaceCwd = '/trusted-workspace';
    operation.preparedFileMutation = {
      ...operation.preparedFileMutation!,
      workspaceRoot: '/fact-controlled-workspace',
      canonicalPath: '/fact-controlled-workspace/notes.txt',
    };

    const result = await contract.reconcile(operation);

    assert.deepEqual(result.decision, {
      result: 'conflict',
      reasonCode: 'prepared_file_checkpoint_invalid',
      nextAction: 'park',
    });
    assert.equal(carrier.inspectCalls, 0);
    assert.equal(carrier.applyCalls, 0);
  });

  test('legacy operations without a checkpoint park without inspecting the file', async () => {
    const carrier = new RecoveryCarrier({ kind: 'file', sha256: 'a'.repeat(64) });
    const contract = createPreparedWriteEditRecoveryContracts(carrier).Edit;
    const operation = { ...editOperation(), preparedFileMutation: undefined };

    const result = await contract.reconcile?.(operation);

    assert.deepEqual(result?.decision, {
      result: 'conflict',
      reasonCode: 'edit_checkpoint_evidence_missing',
      nextAction: 'park',
    });
    assert.equal(carrier.inspectCalls, 0);
  });
});

class RecoveryCarrier {
  inspectCalls = 0;
  applyCalls = 0;
  readonly finalizeContexts: PreparedFileMutationExecutionContext[] = [];

  constructor(private state: CurrentFileCheckpointState) {}

  async resolveWorkspaceIdentity(workspaceRoot: string): Promise<string> {
    return workspaceRoot;
  }

  async resolveTargetIdentity(workspaceRoot: string, targetPath: string): Promise<string> {
    if (/^(?:[A-Za-z]:[\\/]|\/)/.test(targetPath)) return targetPath;
    return `${workspaceRoot.replace(/[\\/]$/, '')}/${targetPath.replaceAll('\\', '/')}`;
  }

  async prepare(): Promise<PreparedFileMutationFact> {
    throw new Error('prepare is not used by this recovery-only fake');
  }

  async inspect(): Promise<CurrentFileCheckpointState> {
    this.inspectCalls += 1;
    return this.state;
  }

  async readCurrentContent(): Promise<Uint8Array | undefined> {
    return this.state.kind === 'missing' ? undefined : Buffer.from('before');
  }

  async apply(fact: PreparedFileMutationFact): Promise<void> {
    this.applyCalls += 1;
    this.state = { kind: 'file', sha256: fact.expectedAfter.sha256 };
  }

  async finalize(
    _fact: PreparedFileMutationFact,
    context?: PreparedFileMutationExecutionContext,
  ): Promise<void> {
    if (context) this.finalizeContexts.push(context);
  }
}

function writeOperation(): UnsettledToolOperation {
  return {
    operationId: 'operation-1',
    toolCallId: 'call-1',
    toolName: 'Write',
    args: { path: 'notes.txt', content: 'expected' },
    recoveryMode: 'reconcile',
    workspaceCwd: '/workspace',
    permissionMode: 'ask',
    evidenceEventIds: ['call-1', 'prepared-1', 'dispatch-1'],
    preparedFileMutation: preparedFact('maka.write.utf8'),
  };
}

function editOperation(): UnsettledToolOperation {
  return {
    ...writeOperation(),
    toolName: 'Edit',
    args: { path: 'notes.txt', old_string: 'before', new_string: 'after' },
    preparedFileMutation: preparedFact('maka.edit.compute_edited_source'),
  };
}

function preparedFact(transformId: string): PreparedFileMutationFact {
  const argsHash =
    transformId === 'maka.write.utf8'
      ? fileMutationArgsHash({ path: 'notes.txt', content: 'expected' })
      : fileMutationArgsHash({
          path: 'notes.txt',
          old_string: 'before',
          new_string: 'after',
        });
  return {
    protocol: 'prepared_file_mutation_v1',
    operationId: 'operation-1',
    workspaceRoot: '/workspace',
    canonicalPath: '/workspace/notes.txt',
    relativePath: 'notes.txt',
    before: { kind: 'missing' },
    expectedAfter: {
      kind: 'file',
      sha256: 'a'.repeat(64),
      blobOid: 'b'.repeat(40),
      byteLength: 8,
      mode: 0o100644,
    },
    transform: { id: transformId, version: 1, argsHash },
    carrier: {
      kind: 'git_object_v1',
      repositoryCommonDir: '/workspace/.git',
      retentionRef: 'refs/maka/checkpoints/operations/operation-1',
    },
  };
}
