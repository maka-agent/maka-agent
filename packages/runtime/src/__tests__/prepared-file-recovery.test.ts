import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { createPreparedWriteEditRecoveryContracts } from '../file-tool-recovery.js';
import { fileMutationArgsHash } from '../file-mutation-transform.js';
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
    assert.equal(carrier.redoCalls, 0);
  });

  test('current before image installs the retained after blob and then finalizes', async () => {
    const carrier = new RecoveryCarrier({ kind: 'missing' });
    const contract = createPreparedWriteEditRecoveryContracts(carrier).Write;

    const result = await contract.reconcile?.(writeOperation());

    assert.equal(carrier.redoCalls, 1);
    assert.equal(result?.decision.result, 'applied');
    assert.equal(result?.decision.reasonCode, 'prepared_redone');
    assert.equal(result?.decision.nextAction, 'synthesize_response');
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
    assert.equal(carrier.redoCalls, 0);
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
  redoCalls = 0;

  constructor(private state: CurrentFileCheckpointState) {}

  async inspect(): Promise<CurrentFileCheckpointState> {
    this.inspectCalls += 1;
    return this.state;
  }

  async redo(fact: PreparedFileMutationFact): Promise<void> {
    this.redoCalls += 1;
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
