import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';

import { computeEditedSource } from '../edit-replace.js';
import { createPreparedWriteEditRecoveryContracts } from '../file-tool-recovery.js';
import { fileMutationArgsHash } from '../file-mutation-transform.js';
import { LocalFileCheckpointCarrier } from '../local-file-checkpoint-carrier.js';
import type { CurrentFileCheckpointState } from '../prepared-file-mutation.js';
import type { UnsettledToolOperation } from '../tool-recovery-contract.js';
import type { PreparedFileMutationFact } from '../tool-recovery-facts.js';

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
  });

  test('current before image regenerates and installs the prepared after image', async () => {
    const carrier = new RecoveryCarrier({ kind: 'missing' });
    const contract = createPreparedWriteEditRecoveryContracts(carrier).Write;

    const result = await contract.reconcile?.(writeOperation());

    assert.equal(carrier.applyCalls, 1);
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

  constructor(private state: CurrentFileCheckpointState) {}

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
}

function writeOperation(): UnsettledToolOperation {
  return {
    operationId: 'operation-1',
    toolCallId: 'call-1',
    toolName: 'Write',
    args: { path: 'notes.txt', content: 'expected' },
    recoveryMode: 'reconcile',
    workspaceCwd: '/workspace',
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
