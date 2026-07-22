import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import {
  resolveStorageRoot,
  StorageRootAuthorityError,
  tryAcquireInteractiveRootOwner,
} from '../root-authority.js';
import {
  authenticateInteractiveTaskLedgerWriter,
  openInteractiveTaskLedgerStoreForWrite,
  type InteractiveTaskLedgerWriterFacade,
} from '../task-ledger-store.js';

describe('interactive task ledger authority', () => {
  it('returns one authenticated writer per live lease and rejects I/O after release', async () => {
    const root = await mkdtemp(join(tmpdir(), 'maka-task-ledger-authority-'));
    const capability = await resolveStorageRoot({ path: root, kind: 'interactive' });
    const owner = await tryAcquireInteractiveRootOwner(capability);
    assert.ok(owner);
    try {
      const first = await openInteractiveTaskLedgerStoreForWrite(owner.lease);
      const second = await openInteractiveTaskLedgerStoreForWrite(owner.lease);
      assert.equal(first, second);
      assert.equal(authenticateInteractiveTaskLedgerWriter(first), first);
      await first.create('session-a', [{ subject: 'authorized' }]);
      assert.equal((await first.listCanonical('session-a')).length, 1);

      await owner.close();
      await assert.rejects(
        () => first.listCanonical('session-a'),
        (error: unknown) =>
          error instanceof StorageRootAuthorityError && error.code === 'invalid_lease',
      );
      await assert.rejects(
        () => first.create('session-a', [{ subject: 'released' }]),
        (error: unknown) =>
          error instanceof StorageRootAuthorityError && error.code === 'invalid_lease',
      );
    } finally {
      await owner.close();
    }
  });

  it('does not authenticate a structurally forged writer facade', () => {
    assert.throws(
      () => authenticateInteractiveTaskLedgerWriter({} as InteractiveTaskLedgerWriterFacade),
      (error: unknown) =>
        error instanceof StorageRootAuthorityError && error.code === 'invalid_lease',
    );
  });
});
