import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import {
  createLocalReadOnlyFileRecoveryObserver,
  createWriteEditRecoveryContractRegistry,
  createWriteEditRecoveryContracts,
} from '../file-tool-recovery.js';
import type { UnsettledToolOperation } from '../tool-recovery-contract.js';

describe('Write/Edit read-only recovery contracts', () => {
  it('classifies Write by its observable postcondition without mutating the target', async () => {
    const reads: string[] = [];
    const contracts = createWriteEditRecoveryContracts({
      readText: async (path) => {
        reads.push(path);
        return { status: 'text', content: 'expected contents' };
      },
    });
    const operation = writeOperation();
    const observation = await contracts.Write.observe?.(operation);

    assert.deepEqual(contracts.Write.decide?.({ operation, observation }), {
      result: 'applied',
      reasonCode: 'write_postcondition_matches',
      nextAction: 'synthesize_response',
      synthesizedResult: {
        ok: true,
        path: 'notes.txt',
        bytes: 17,
        recovered: true,
      },
    });
    assert.deepEqual(reads, ['notes.txt']);
  });

  it('distinguishes a missing Write target from conflicting contents', async () => {
    const missingContracts = createWriteEditRecoveryContracts({
      readText: async () => ({ status: 'missing' }),
    });
    const conflictContracts = createWriteEditRecoveryContracts({
      readText: async () => ({ status: 'text', content: 'someone else changed this' }),
    });
    const operation = writeOperation();

    const missing = await missingContracts.Write.observe?.(operation);
    const conflict = await conflictContracts.Write.observe?.(operation);

    assert.deepEqual(missingContracts.Write.decide?.({ operation, observation: missing }), {
      result: 'not_applied',
      reasonCode: 'write_target_missing',
      nextAction: 'retry_allowed',
    });
    assert.deepEqual(conflictContracts.Write.decide?.({ operation, observation: conflict }), {
      result: 'conflict',
      reasonCode: 'write_postcondition_conflict',
      nextAction: 'park',
    });
  });

  it('parks Edit observations that lack durable before/after checkpoint evidence', async () => {
    const operation = editOperation();
    const decide = async (content: string) => {
      const contract = createWriteEditRecoveryContracts({
        readText: async () => ({ status: 'text', content }),
      }).Edit;
      const observation = await contract.observe?.(operation);
      return contract.decide?.({ operation, observation });
    };

    const parkedWithoutCheckpoint = {
      result: 'conflict',
      reasonCode: 'edit_checkpoint_evidence_missing',
      nextAction: 'park',
    } as const;
    assert.deepEqual(await decide('before NEW after'), parkedWithoutCheckpoint);
    assert.deepEqual(await decide('before OLD after'), parkedWithoutCheckpoint);
    assert.deepEqual(await decide('OLD and NEW are both present'), parkedWithoutCheckpoint);
  });

  it('does not treat substring counts as proof that an interrupted Edit was applied', async () => {
    const operation = editOperation();
    let reads = 0;
    const contract = createWriteEditRecoveryContracts({
      // This satisfies the old heuristic (OLD absent, NEW present once), but it
      // is not the complete post-image prepared from the durable before state.
      readText: async () => {
        reads += 1;
        return { status: 'text', content: 'unrelated replacement containing NEW' };
      },
    }).Edit;
    const observation = await contract.observe?.(operation);

    assert.deepEqual(contract.decide?.({ operation, observation }), {
      result: 'conflict',
      reasonCode: 'edit_checkpoint_evidence_missing',
      nextAction: 'park',
    });
    assert.equal(reads, 0);
  });

  it('parks unreadable targets and malformed durable arguments', async () => {
    const contracts = createWriteEditRecoveryContracts({
      readText: async () => ({ status: 'unreadable' }),
    });
    const malformed = { ...writeOperation(), args: { path: 'notes.txt' } };
    const unreadableObservation = await contracts.Write.observe?.(writeOperation());
    const malformedObservation = await contracts.Write.observe?.(malformed);

    assert.equal(
      contracts.Write.decide?.({ operation: writeOperation(), observation: unreadableObservation })
        .nextAction,
      'park',
    );
    assert.equal(
      contracts.Write.decide?.({ operation: malformed, observation: malformedObservation })
        .nextAction,
      'park',
    );
  });

  it('registers Write/Edit against a bounded observer confined to the source workspace', async () => {
    const root = await mkdtemp(join(tmpdir(), 'maka-file-recovery-'));
    const outside = join(root, '..', `outside-${Date.now()}.txt`);
    try {
      await writeFile(join(root, 'notes.txt'), 'expected contents');
      await writeFile(outside, 'outside contents');
      const observer = createLocalReadOnlyFileRecoveryObserver({ maxBytes: 64 });
      const registry = createWriteEditRecoveryContractRegistry(observer);
      const operation = { ...writeOperation(), workspaceCwd: root };
      const contract = registry.resolve('Write', 'reconcile');
      assert.equal(contract.status, 'available');
      if (contract.status !== 'available') return;

      assert.deepEqual(await contract.contract.observe?.(operation), {
        path: 'notes.txt',
        status: 'text',
        content: 'expected contents',
      });
      assert.deepEqual(await observer.readText('missing.txt', operation), { status: 'missing' });
      assert.deepEqual(await observer.readText(outside, operation), { status: 'unreadable' });
      await writeFile(join(root, 'large.txt'), 'x'.repeat(65));
      assert.deepEqual(await observer.readText('large.txt', operation), { status: 'unreadable' });
      await writeFile(join(root, 'binary.dat'), Buffer.from([0xff, 0xfe, 0xfd]));
      assert.deepEqual(await observer.readText('binary.dat', operation), {
        status: 'unreadable',
      });
    } finally {
      await rm(outside, { force: true });
      await rm(root, { recursive: true, force: true });
    }
  });
});

function writeOperation(): UnsettledToolOperation {
  return {
    operationId: 'operation-write-1',
    toolCallId: 'call-write-1',
    toolName: 'Write',
    args: { path: 'notes.txt', content: 'expected contents' },
    recoveryMode: 'reconcile',
    evidenceEventIds: ['call-1', 'dispatch-1'],
  };
}

function editOperation(): UnsettledToolOperation {
  return {
    operationId: 'operation-edit-1',
    toolCallId: 'call-edit-1',
    toolName: 'Edit',
    args: { path: 'notes.txt', old_string: 'OLD', new_string: 'NEW' },
    recoveryMode: 'reconcile',
    evidenceEventIds: ['call-1', 'dispatch-1'],
  };
}
