import assert from 'node:assert/strict';
import { chmod, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import type {
  CreateMemoryExtractionOperationRequest,
  MemoryItemWrite,
  MemorySha256Digest,
} from '@maka/core/long-term-memory';
import { LONG_TERM_MEMORY_DATABASE_NAME } from '../long-term-memory-store.js';
import {
  SqliteMemoryItemStore,
  type SqliteMemoryItemStoreFailpoint,
} from '../sqlite-long-term-memory-store.js';

const DIGEST_A = digest('a');
const DIGEST_B = digest('b');

describe('SQLite long-term memory extraction', () => {
  test('commits an empty sweep atomically and replays its frozen receipt', async () => {
    await withExtractionStore(async ({ store, setNow }) => {
      await store.createMemoryExtractionOperation(sweepOperation());
      await store.claimMemoryExtractionOperation({
        operationId: 'operation-1',
        attemptId: 'attempt-1',
        turnId: 'memory-turn-1',
        runId: 'memory-run-1',
        snapshotKind: 'provider_prefix',
        leaseExpiresAt: 2_000,
      });

      const committed = await store.commitMemoryExtraction(emptyCommit());
      assert.equal(committed.replayed, false);
      assert.equal(committed.resultType, 'empty');
      assert.equal(committed.cursors[0]?.committedEventSeq, 3);
      assert.equal(committed.cursors[0]?.activeSweepOperationId, null);

      setNow(1_500);
      const replayed = await store.commitMemoryExtraction(emptyCommit());
      assert.equal(replayed.replayed, true);
      assert.deepEqual(replayed.receipt, committed.receipt);
      assert.deepEqual(replayed.cursors, committed.cursors);
    });
  });

  test('abandons an expired attempt and respects retry scheduling', async () => {
    await withExtractionStore(async ({ store, setNow }) => {
      await store.createMemoryExtractionOperation(targetedOperation());
      await store.claimMemoryExtractionOperation({
        operationId: 'operation-targeted',
        attemptId: 'attempt-stale',
        turnId: 'memory-turn-stale',
        runId: 'memory-run-stale',
        snapshotKind: 'runtime_delta',
        leaseExpiresAt: 1_100,
      });

      setNow(1_200);
      const reclaimed = await store.claimMemoryExtractionOperation({
        operationId: 'operation-targeted',
        attemptId: 'attempt-reclaimed',
        turnId: 'memory-turn-reclaimed',
        runId: 'memory-run-reclaimed',
        snapshotKind: 'reconstructed_full',
        leaseExpiresAt: 1_500,
      });
      assert.equal(reclaimed?.attempt.attemptOrdinal, 2);
      assert.equal((await store.readMemoryExtractionAttempt('attempt-stale'))?.state, 'abandoned');

      const pending = await store.failMemoryExtractionAttempt({
        operationId: 'operation-targeted',
        attemptId: 'attempt-reclaimed',
        runId: 'memory-run-reclaimed',
        failureCode: 'provider_unavailable',
        failureStage: 'provider',
        nextAttemptAt: 1_400,
      });
      assert.equal(pending.state, 'pending');
      assert.equal(
        await store.claimMemoryExtractionOperation({
          operationId: 'operation-targeted',
          attemptId: 'attempt-too-early',
          turnId: 'memory-turn-too-early',
          runId: 'memory-run-too-early',
          snapshotKind: 'reconstructed_full',
          leaseExpiresAt: 1_600,
        }),
        undefined,
      );

      setNow(1_400);
      const retried = await store.claimMemoryExtractionOperation({
        operationId: 'operation-targeted',
        attemptId: 'attempt-retry',
        turnId: 'memory-turn-retry',
        runId: 'memory-run-retry',
        snapshotKind: 'reconstructed_full',
        leaseExpiresAt: 1_800,
      });
      assert.equal(retried?.attempt.attemptOrdinal, 3);
    });
  });

  test('atomically stops recovery before claiming beyond the retry ceiling', async () => {
    await withExtractionStore(async ({ store, setNow }) => {
      await store.createMemoryExtractionOperation(targetedOperation());
      await store.claimMemoryExtractionOperation({
        operationId: 'operation-targeted',
        attemptId: 'attempt-last',
        turnId: 'memory-turn-last',
        runId: 'memory-run-last',
        snapshotKind: 'runtime_delta',
        leaseExpiresAt: 1_100,
      });

      setNow(1_200);
      assert.equal(
        await store.claimMemoryExtractionOperation({
          operationId: 'operation-targeted',
          attemptId: 'attempt-forbidden',
          turnId: 'memory-turn-forbidden',
          runId: 'memory-run-forbidden',
          snapshotKind: 'reconstructed_full',
          leaseExpiresAt: 1_500,
          maxAttempts: 1,
          diagnosticRetentionUntil: 2_000,
        }),
        undefined,
      );
      assert.equal(
        (await store.readMemoryExtractionOperation('operation-targeted'))?.state,
        'failed',
      );
      assert.equal((await store.readMemoryExtractionAttempt('attempt-last'))?.state, 'abandoned');
      assert.equal(await store.readMemoryExtractionAttempt('attempt-forbidden'), undefined);
    });
  });

  test('lists only recoverable operations with targeted-first stable ordering', async () => {
    await withExtractionStore(async ({ store, setNow }) => {
      setNow(1_000);
      await store.createMemoryExtractionOperation(recoveryOperation('sweep-pending', 'sweep', '1'));

      setNow(1_050);
      await store.createMemoryExtractionOperation(
        recoveryOperation('targeted-expired', 'targeted', '2'),
      );
      await store.claimMemoryExtractionOperation({
        operationId: 'targeted-expired',
        attemptId: 'attempt-targeted-expired',
        turnId: 'turn-targeted-expired',
        runId: 'run-targeted-expired',
        snapshotKind: 'runtime_delta',
        leaseExpiresAt: 1_100,
      });

      setNow(1_060);
      await store.createMemoryExtractionOperation(
        recoveryOperation('targeted-pending', 'targeted', '3'),
      );

      setNow(1_070);
      await store.createMemoryExtractionOperation(
        recoveryOperation('targeted-delayed', 'targeted', '4'),
      );
      await store.claimMemoryExtractionOperation({
        operationId: 'targeted-delayed',
        attemptId: 'attempt-targeted-delayed',
        turnId: 'turn-targeted-delayed',
        runId: 'run-targeted-delayed',
        snapshotKind: 'runtime_delta',
        leaseExpiresAt: 1_200,
      });
      await store.failMemoryExtractionAttempt({
        operationId: 'targeted-delayed',
        attemptId: 'attempt-targeted-delayed',
        runId: 'run-targeted-delayed',
        failureCode: 'provider_unavailable',
        failureStage: 'provider',
        nextAttemptAt: 1_300,
      });

      setNow(1_080);
      await store.createMemoryExtractionOperation(
        recoveryOperation('sweep-unexpired', 'sweep', '5'),
      );
      await store.claimMemoryExtractionOperation({
        operationId: 'sweep-unexpired',
        attemptId: 'attempt-sweep-unexpired',
        turnId: 'turn-sweep-unexpired',
        runId: 'run-sweep-unexpired',
        snapshotKind: 'provider_prefix',
        leaseExpiresAt: 1_400,
      });

      setNow(1_200);
      const recoverable = await store.listRecoverableMemoryExtractions();
      assert.deepEqual(
        recoverable.map((operation) => operation.operationId),
        ['targeted-expired', 'targeted-pending', 'sweep-pending'],
      );
      assert.deepEqual(
        (await store.listRecoverableMemoryExtractions({ limit: 2 })).map(
          (operation) => operation.operationId,
        ),
        ['targeted-expired', 'targeted-pending'],
      );
      await assert.rejects(
        store.listRecoverableMemoryExtractions({ limit: 101 }),
        /limit must be between 1 and 100/,
      );
      await assert.rejects(
        store.listRecoverableMemoryExtractions({ limit: 10, now: 0 } as never),
        /only accepts limit/,
      );
    });
  });

  test('renews only the active unexpired attempt lease and never shortens it', async () => {
    await withExtractionStore(async ({ store, setNow }) => {
      await store.createMemoryExtractionOperation(
        recoveryOperation('targeted-renew', 'targeted', '6'),
      );
      await store.claimMemoryExtractionOperation({
        operationId: 'targeted-renew',
        attemptId: 'attempt-renew',
        turnId: 'turn-renew',
        runId: 'run-renew',
        snapshotKind: 'runtime_delta',
        leaseExpiresAt: 1_200,
      });

      setNow(1_100);
      const renewed = await store.renewMemoryExtractionAttemptLease({
        operationId: 'targeted-renew',
        attemptId: 'attempt-renew',
        runId: 'run-renew',
        leaseExpiresAt: 1_500,
      });
      assert.equal(renewed.leaseExpiresAt, 1_500);
      assert.equal(
        (
          await store.renewMemoryExtractionAttemptLease({
            operationId: 'targeted-renew',
            attemptId: 'attempt-renew',
            runId: 'run-renew',
            leaseExpiresAt: 1_500,
          })
        ).leaseExpiresAt,
        1_500,
      );
      await assert.rejects(
        store.renewMemoryExtractionAttemptLease({
          operationId: 'targeted-renew',
          attemptId: 'attempt-renew',
          runId: 'run-renew',
          leaseExpiresAt: 1_400,
        }),
        /cannot shorten/,
      );
      await assert.rejects(
        store.renewMemoryExtractionAttemptLease({
          operationId: 'targeted-renew',
          attemptId: 'attempt-renew',
          runId: 'wrong-run',
          leaseExpiresAt: 1_600,
        }),
        /not the active running Attempt/,
      );
      assert.equal(
        (await store.readMemoryExtractionOperation('targeted-renew'))?.leaseExpiresAt,
        1_500,
      );

      setNow(1_500);
      await assert.rejects(
        store.renewMemoryExtractionAttemptLease({
          operationId: 'targeted-renew',
          attemptId: 'attempt-renew',
          runId: 'run-renew',
          leaseExpiresAt: 1_800,
        }),
        /not the active running Attempt/,
      );
      assert.deepEqual(
        (await store.listRecoverableMemoryExtractions()).map((operation) => operation.operationId),
        ['targeted-renew'],
      );
    });
  });

  test('finds active candidates only inside the exact scope', async () => {
    await withExtractionStore(async ({ store }) => {
      await store.applyMutations({
        operationId: 'seed-candidates',
        mutations: [
          { type: 'create', item: memoryWrite('workspace-a', 'event-a') },
          { type: 'create', item: memoryWrite('workspace-b', 'event-b') },
        ],
      });

      const result = await store.searchMemoryExtractionCandidates({
        content: 'The project uses SQLite for durable memory.',
        kind: 'knowledge',
        statementType: 'fact',
        temporalType: 'undated',
        scopeType: 'workspace',
        scopeKey: 'workspace-a',
        keys: ['sqlite'],
        sourceEventIds: ['event-a'],
      });

      assert.equal(result.truncated, false);
      assert.equal(result.candidates.length, 1);
      assert.equal(result.candidates[0]?.record.item.scopeKey, 'workspace-a');
      assert.equal(result.candidates[0]?.sourceOverlapCount, 1);
      assert.equal(result.candidates[0]?.exactKeyMatchCount, 1);
    });
  });

  test('commits a Targeted proposed Item without a Cursor range', async () => {
    await withExtractionStore(async ({ store }) => {
      await store.createMemoryExtractionOperation(targetedOperation());
      await store.claimMemoryExtractionOperation({
        operationId: 'operation-targeted',
        attemptId: 'attempt-targeted',
        turnId: 'memory-turn-targeted',
        runId: 'memory-run-targeted',
        snapshotKind: 'provider_prefix',
        leaseExpiresAt: 2_000,
      });

      const committed = await store.commitMemoryExtraction({
        operationId: 'operation-targeted',
        attemptId: 'attempt-targeted',
        runId: 'memory-run-targeted',
        resultType: 'proposed',
        selectionSaturated: false,
        evidenceDigest: DIGEST_A,
        mutations: [{ type: 'create', item: memoryWrite('workspace-a', 'event-a') }],
        diagnosticRetentionUntil: 2_000,
      });

      assert.equal(committed.operation.state, 'succeeded');
      assert.deepEqual(committed.cursors, []);
      const itemId = committed.writeOperation.results[0]?.itemId;
      assert.ok(itemId);
      assert.equal((await store.readItem(itemId))?.sources[0]?.eventId, 'event-a');
    });
  });

  test('rolls back a proposed Item with extraction state at every transaction boundary', async () => {
    for (const point of [
      'after_item_write',
      'after_keys_write',
      'after_sources_write',
      'after_cursor_write',
      'after_extraction_state_write',
    ] as const) {
      await withExtractionStore(async ({ store, setFailpoint }) => {
        await store.createMemoryExtractionOperation(sweepOperation());
        await store.claimMemoryExtractionOperation({
          operationId: 'operation-1',
          attemptId: 'attempt-1',
          turnId: 'memory-turn-1',
          runId: 'memory-run-1',
          snapshotKind: 'provider_prefix',
          leaseExpiresAt: 2_000,
        });
        const request = proposedCommit();

        setFailpoint(point);
        await assert.rejects(store.commitMemoryExtraction(request), new RegExp(point));
        setFailpoint(undefined);

        assert.equal(await store.readItem('memory-item-1'), undefined, point);
        assert.equal(await store.readOperation('operation-1'), undefined, point);
        assert.deepEqual(
          {
            state: (await store.readMemoryExtractionOperation('operation-1'))?.state,
            activeAttemptId: (await store.readMemoryExtractionOperation('operation-1'))
              ?.activeAttemptId,
            attemptState: (await store.readMemoryExtractionAttempt('attempt-1'))?.state,
            committedEventSeq: (await store.readMemoryExtractionCursor('session-1', 'run-1'))
              ?.committedEventSeq,
          },
          {
            state: 'running',
            activeAttemptId: 'attempt-1',
            attemptState: 'running',
            committedEventSeq: 0,
          },
          point,
        );

        const committed = await store.commitMemoryExtraction(request);
        assert.equal(committed.replayed, false, point);
        assert.equal(committed.writeOperation.results.length, 1, point);
        const itemId = committed.writeOperation.results[0]?.itemId;
        assert.ok(itemId, point);
        assert.deepEqual((await store.readItem(itemId))?.sources, [
          { sessionId: 'session-1', runId: 'run-1', turnId: 'turn-1', eventId: 'event-a' },
        ]);
        assert.equal(committed.cursors[0]?.committedEventSeq, 3, point);

        const replayed = await store.commitMemoryExtraction(request);
        assert.equal(replayed.replayed, true, point);
        assert.deepEqual(replayed.receipt, committed.receipt, point);
        assert.deepEqual(
          (
            await store.searchByKeys({
              terms: ['SQLite'],
              match: 'exact',
              workspaceKey: 'workspace-a',
            })
          ).map((record) => record.item.itemId),
          [itemId],
          point,
        );
      });
    }
  });

  test('keeps a raised requested boundary after committing the frozen sweep range', async () => {
    await withExtractionStore(async ({ store }) => {
      await store.createMemoryExtractionOperation(sweepOperation());
      const raised = await store.raiseMemoryExtractionRequestedBoundary({
        sessionId: 'session-1',
        runId: 'run-1',
        activeSweepOperationId: 'operation-1',
        requestedEventSeq: 5,
        requestedEventId: 'event-5',
        requestedPrefixDigest: DIGEST_B,
      });
      assert.equal(raised.requestedEventSeq, 5);

      await store.claimMemoryExtractionOperation({
        operationId: 'operation-1',
        attemptId: 'attempt-1',
        turnId: 'memory-turn-1',
        runId: 'memory-run-1',
        snapshotKind: 'provider_prefix',
        leaseExpiresAt: 2_000,
      });
      const committed = await store.commitMemoryExtraction(emptyCommit());
      assert.equal(committed.cursors[0]?.committedEventSeq, 3);
      assert.equal(committed.cursors[0]?.requestedEventSeq, 5);
      assert.equal(committed.cursors[0]?.requestedEventId, 'event-5');

      const debts = await store.listUnassignedMemoryExtractionSweepDebts();
      assert.equal(debts.length, 1);
      const debt = debts[0]!;
      const followup = await store.createMemoryExtractionSweepFollowup({
        expectedCursorVersion: debt.version,
        operation: {
          operationId: 'operation-followup',
          sessionId: debt.sessionId,
          mode: 'sweep',
          triggerKind: 'context_threshold',
          internalSessionId: 'memory-session-followup',
          sessionCreateFingerprint: digest('d'),
          requestHash: digest('e'),
          requestJson: JSON.stringify({ version: 1, kind: 'cursor_debt_followup' }),
          triggerEpoch: `cursor-debt-${debt.version}`,
          ranges: [
            {
              rangeOrdinal: 0,
              sessionId: debt.sessionId,
              invocationId: debt.invocationId,
              runId: debt.runId,
              turnId: debt.turnId,
              fromEventSeqExclusive: debt.committedEventSeq,
              fromEventId: debt.committedEventId,
              fromPrefixDigest: debt.committedPrefixDigest,
              toEventSeqInclusive: debt.requestedEventSeq,
              toEventId: debt.requestedEventId!,
              toPrefixDigest: debt.requestedPrefixDigest!,
            },
          ],
        },
      });
      assert.equal(followup?.replayed, false);
      assert.equal(
        (await store.readMemoryExtractionCursor('session-1', 'run-1'))?.activeSweepOperationId,
        'operation-followup',
      );
      assert.deepEqual(await store.listUnassignedMemoryExtractionSweepDebts(), []);
    });
  });

  test('releases a Sweep cursor after its final failed Attempt', async () => {
    await withExtractionStore(async ({ store }) => {
      await store.createMemoryExtractionOperation(sweepOperation());
      await store.claimMemoryExtractionOperation({
        operationId: 'operation-1',
        attemptId: 'attempt-1',
        turnId: 'memory-turn-1',
        runId: 'memory-run-1',
        snapshotKind: 'provider_prefix',
        leaseExpiresAt: 2_000,
      });

      await store.failMemoryExtractionAttempt({
        operationId: 'operation-1',
        attemptId: 'attempt-1',
        runId: 'memory-run-1',
        failureCode: 'provider_unavailable',
        failureStage: 'provider',
        diagnosticRetentionUntil: 2_000,
      });

      assert.equal(
        (await store.readMemoryExtractionCursor('session-1', 'run-1'))?.activeSweepOperationId,
        null,
      );
      assert.equal(
        (await store.readMemoryExtractionCursor('session-1', 'run-1'))?.requestedEventSeq,
        3,
      );
      assert.deepEqual(await store.listUnassignedMemoryExtractionSweepDebts(), []);
    });
  });

  test('retires unassigned Sweep cursor debt after its parent Session is removed', async () => {
    await withExtractionStore(async ({ store }) => {
      await store.createMemoryExtractionOperation(sweepOperation());
      await store.raiseMemoryExtractionRequestedBoundary({
        sessionId: 'session-1',
        runId: 'run-1',
        activeSweepOperationId: 'operation-1',
        requestedEventSeq: 5,
        requestedEventId: 'event-5',
        requestedPrefixDigest: DIGEST_B,
      });
      await store.claimMemoryExtractionOperation({
        operationId: 'operation-1',
        attemptId: 'attempt-1',
        turnId: 'memory-turn-1',
        runId: 'memory-run-1',
        snapshotKind: 'provider_prefix',
        leaseExpiresAt: 2_000,
      });
      await store.commitMemoryExtraction(emptyCommit());

      assert.equal((await store.listUnassignedMemoryExtractionSweepDebts()).length, 1);

      assert.deepEqual(
        await store.cancelMemoryExtractionsForSessions({
          sessionIds: ['session-1'],
          diagnosticRetentionUntil: 2_000,
        }),
        [],
      );
      assert.deepEqual(await store.listUnassignedMemoryExtractionSweepDebts(), []);
    });
  });

  test('claims cleanup only after retention and settles the durable claim', async () => {
    await withExtractionStore(async ({ store, setNow }) => {
      await store.createMemoryExtractionOperation(sweepOperation());
      await store.claimMemoryExtractionOperation({
        operationId: 'operation-1',
        attemptId: 'attempt-1',
        turnId: 'memory-turn-1',
        runId: 'memory-run-1',
        snapshotKind: 'provider_prefix',
        leaseExpiresAt: 2_000,
      });
      await store.commitMemoryExtraction(emptyCommit());

      assert.deepEqual(await store.listRecoverableMemoryExtractionCleanups(), []);

      assert.equal(
        await store.claimMemoryExtractionCleanup({
          operationId: 'operation-1',
          claimId: 'cleanup-too-early',
          leaseExpiresAt: 2_500,
        }),
        undefined,
      );
      setNow(2_000);
      assert.deepEqual(
        (await store.listRecoverableMemoryExtractionCleanups()).map(
          (operation) => operation.operationId,
        ),
        ['operation-1'],
      );
      const claimed = await store.claimMemoryExtractionCleanup({
        operationId: 'operation-1',
        claimId: 'cleanup-1',
        leaseExpiresAt: 2_500,
      });
      assert.equal(claimed?.cleanupState, 'running');

      const completed = await store.finishMemoryExtractionCleanup({
        operationId: 'operation-1',
        claimId: 'cleanup-1',
      });
      assert.equal(completed.cleanupState, 'completed');
      assert.equal(completed.cleanedAt, 2_000);
      assert.deepEqual(await store.listRecoverableMemoryExtractionCleanups(), []);
    });
  });

  test('terminally cancels pending and running Operations when their parent Session is removed', async () => {
    await withExtractionStore(async ({ store }) => {
      await store.createMemoryExtractionOperation(sweepOperation());
      await store.claimMemoryExtractionOperation({
        operationId: 'operation-1',
        attemptId: 'attempt-1',
        turnId: 'memory-turn-1',
        runId: 'memory-run-1',
        snapshotKind: 'provider_prefix',
        leaseExpiresAt: 2_000,
      });
      await store.createMemoryExtractionOperation(targetedOperation());

      assert.deepEqual(
        await store.cancelMemoryExtractionsForSessions({
          sessionIds: ['session-1'],
          diagnosticRetentionUntil: 2_000,
        }),
        ['operation-1', 'operation-targeted'],
      );
      assert.equal((await store.readMemoryExtractionOperation('operation-1'))?.state, 'failed');
      assert.equal(
        (await store.readMemoryExtractionAttempt('attempt-1'))?.failureCode,
        'source_evidence_deleted',
      );
      assert.equal((await store.readMemoryExtractionAttempt('attempt-1'))?.state, 'abandoned');
      assert.equal(
        (await store.readMemoryExtractionCursor('session-1', 'run-1'))?.activeSweepOperationId,
        null,
      );
      assert.deepEqual(await store.listUnassignedMemoryExtractionSweepDebts(), []);
    });
  });

  test('atomically enforces the unfinished Targeted queue ceiling', async () => {
    await withExtractionStore(async ({ store }) => {
      for (const [index, character] of ['d', 'e'].entries()) {
        await store.createMemoryExtractionOperation({
          ...targetedOperation(),
          operationId: `operation-targeted-${index}`,
          internalSessionId: `memory-session-targeted-${index}`,
          requestHash: digest(character),
          requestJson: JSON.stringify({ version: 1, index }),
          maxUnfinishedTargetedPerSession: 2,
        });
      }

      await assert.rejects(
        store.createMemoryExtractionOperation({
          ...targetedOperation(),
          operationId: 'operation-targeted-overflow',
          internalSessionId: 'memory-session-targeted-overflow',
          requestHash: digest('f'),
          requestJson: JSON.stringify({ version: 1, index: 2 }),
          maxUnfinishedTargetedPerSession: 2,
        }),
        (error: unknown) =>
          error instanceof Error && 'reason' in error && error.reason === 'extraction_queue_full',
      );
    });
  });
});

function sweepOperation(): CreateMemoryExtractionOperationRequest {
  return {
    operationId: 'operation-1',
    sessionId: 'session-1',
    mode: 'sweep',
    triggerKind: 'context_threshold',
    internalSessionId: 'memory-session-1',
    sessionCreateFingerprint: DIGEST_A,
    requestHash: DIGEST_B,
    requestJson: JSON.stringify({ version: 1, kind: 'sweep' }),
    triggerEpoch: 'threshold-1',
    ranges: [
      {
        rangeOrdinal: 0,
        sessionId: 'session-1',
        invocationId: 'invocation-1',
        runId: 'run-1',
        turnId: 'turn-1',
        fromEventSeqExclusive: 0,
        fromEventId: null,
        fromPrefixDigest: null,
        toEventSeqInclusive: 3,
        toEventId: 'event-3',
        toPrefixDigest: DIGEST_A,
      },
    ],
  };
}

function targetedOperation(): CreateMemoryExtractionOperationRequest {
  return {
    operationId: 'operation-targeted',
    sessionId: 'session-1',
    mode: 'targeted',
    triggerKind: 'user_requested',
    internalSessionId: 'memory-session-targeted',
    sessionCreateFingerprint: DIGEST_A,
    requestHash: digest('c'),
    requestJson: JSON.stringify({ version: 1, kind: 'targeted' }),
    triggerEpoch: 'tool-call-1',
  };
}

function recoveryOperation(
  operationId: string,
  mode: 'sweep' | 'targeted',
  digestCharacter: string,
): CreateMemoryExtractionOperationRequest {
  const sessionId = `session-${operationId}`;
  return {
    operationId,
    sessionId,
    mode,
    triggerKind: mode === 'targeted' ? 'user_requested' : 'compaction',
    internalSessionId: `memory-session-${operationId}`,
    sessionCreateFingerprint: DIGEST_A,
    requestHash: digest(digestCharacter),
    requestJson: JSON.stringify({ version: 1, operationId }),
    triggerEpoch: `trigger-${operationId}`,
    ...(mode === 'sweep'
      ? {
          ranges: [
            {
              rangeOrdinal: 0,
              sessionId,
              invocationId: `invocation-${operationId}`,
              runId: `source-run-${operationId}`,
              turnId: `source-turn-${operationId}`,
              fromEventSeqExclusive: 0,
              fromEventId: null,
              fromPrefixDigest: null,
              toEventSeqInclusive: 1,
              toEventId: `source-event-${operationId}`,
              toPrefixDigest: DIGEST_A,
            },
          ],
        }
      : {}),
  };
}

function emptyCommit() {
  return {
    operationId: 'operation-1',
    attemptId: 'attempt-1',
    runId: 'memory-run-1',
    resultType: 'empty' as const,
    selectionSaturated: false,
    evidenceDigest: DIGEST_A,
    mutations: [],
    diagnosticRetentionUntil: 2_000,
  };
}

function proposedCommit() {
  return {
    operationId: 'operation-1',
    attemptId: 'attempt-1',
    runId: 'memory-run-1',
    resultType: 'proposed' as const,
    selectionSaturated: false,
    evidenceDigest: DIGEST_A,
    mutations: [{ type: 'create' as const, item: memoryWrite('workspace-a', 'event-a') }],
    diagnosticRetentionUntil: 2_000,
  };
}

function memoryWrite(workspaceKey: string, eventId: string): MemoryItemWrite {
  return {
    content: 'The project uses SQLite for durable memory.',
    kind: 'knowledge',
    statementType: 'fact',
    temporalType: 'undated',
    scopeType: 'workspace',
    scopeKey: workspaceKey,
    observedAt: 900,
    origin: 'agent_extracted',
    keys: [{ key: 'SQLite', keyType: 'exact', keyOrigin: 'deterministic' }],
    sources: [{ sessionId: 'session-1', runId: 'run-1', turnId: 'turn-1', eventId }],
  };
}

async function withExtractionStore(
  run: (context: {
    store: SqliteMemoryItemStore;
    setNow: (value: number) => void;
    setFailpoint: (value: SqliteMemoryItemStoreFailpoint | undefined) => void;
  }) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'maka-memory-extraction-'));
  await chmod(root, 0o700);
  let now = 1_000;
  let failpoint: SqliteMemoryItemStoreFailpoint | undefined;
  let item = 0;
  const store = new SqliteMemoryItemStore(join(root, LONG_TERM_MEMORY_DATABASE_NAME), {
    now: () => now,
    idFactory: () => `memory-item-${++item}`,
    failpoint: (point) => {
      if (point === failpoint) throw new Error(`failpoint:${point}`);
    },
  });
  try {
    await run({
      store,
      setNow: (value) => {
        now = value;
      },
      setFailpoint: (value) => {
        failpoint = value;
      },
    });
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
}

function digest(character: string): MemorySha256Digest {
  return `sha256:${character.repeat(64)}`;
}
