import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { RuntimeEvent } from '@maka/core';
import { createSqliteRuntimeStore } from '@maka/storage';

import { createPreparedWriteEditRecoveryContractRegistry } from '../file-tool-recovery.js';
import { fileMutationArgsHash, WRITE_FILE_TRANSFORM } from '../file-mutation-transform.js';
import { LocalFileCheckpointCarrier } from '../local-file-checkpoint-carrier.js';
import { resolveRuntimeRecovery } from '../recovery-resolver.js';
import { buildResumePlanFromRuntimeEvents } from '../runtime-resume.js';
import { reconcileUnsettledToolOperation } from '../tool-recovery-coordinator.js';

test('a crash after atomic replace but before T2 only synthesizes the missing response', async () => {
  const root = await mkdtemp(join(tmpdir(), 'maka-prepared-t2-crash-'));
  const databasePath = join(root, 'runtime.sqlite');
  try {
    await writeFile(join(root, 'notes.txt'), 'before image');
    const carrier = new LocalFileCheckpointCarrier();
    const args = { path: 'notes.txt', content: 'after image' };
    const fact = await carrier.prepare({
      operationId: 'operation-1',
      workspaceRoot: root,
      targetPath: args.path,
      expectedContent: Buffer.from(args.content),
      transform: {
        ...WRITE_FILE_TRANSFORM,
        argsHash: fileMutationArgsHash(args),
      },
    });

    const firstProcess = createSqliteRuntimeStore(databasePath);
    await firstProcess.appendRuntimeEvent('session-1', 'run-1', initialEvent());
    await firstProcess.commitToolPrepared({
      operationId: 'operation-1',
      journalEventId: 'journal-prepared-1',
      runtimeEvent: callEvent(args),
      preparationRuntimeEvents: [preparedEvent(fact)],
      dispatchRuntimeEvent: dispatchEvent(),
      providerToolCallId: 'call-1',
      toolName: 'Write',
      canonicalArgsHash: 'sha256:args',
      recoveryMode: 'reconcile',
      committedAt: 4,
    });
    await carrier.apply(fact, Buffer.from(args.content));
    assert.equal(await readFile(join(root, 'notes.txt'), 'utf8'), 'after image');
    firstProcess.close(); // process dies here: no T2/function_response exists

    const restarted = createSqliteRuntimeStore(databasePath);
    try {
      const events = await restarted.readRuntimeEvents('session-1', 'run-1');
      const contracts = createPreparedWriteEditRecoveryContractRegistry(carrier);
      const plan = buildResumePlanFromRuntimeEvents(events, { recoveryContracts: contracts });
      const operation = plan.operations[0];
      assert.ok(operation?.preparedFileMutation);

      const result = await reconcileUnsettledToolOperation({
        contracts,
        runtimeEventStore: restarted,
        operation: {
          operationId: operation.operationId,
          toolCallId: operation.toolCallId,
          toolName: operation.toolName,
          args: operation.args,
          recoveryMode: operation.recoveryMode,
          workspaceCwd: root,
          permissionMode: 'ask',
          preparedFileMutation: operation.preparedFileMutation,
          evidenceEventIds: operation.evidenceEventIds,
        },
        runtimeIdentity: {
          sessionId: 'session-1',
          invocationId: 'invocation-1',
          runId: 'run-1',
          turnId: 'turn-1',
        },
        newId: (() => {
          let value = 0;
          return () => `recovery-${++value}`;
        })(),
        now: (() => {
          let value = 10;
          return () => value++;
        })(),
      });

      assert.equal(result.status, 'reconciled');
      assert.equal(await readFile(join(root, 'notes.txt'), 'utf8'), 'after image');
      const recovered = await restarted.readRuntimeEvents('session-1', 'run-1');
      assert.equal(
        recovered.filter((event) => event.content?.kind === 'function_response').length,
        1,
      );
      assert.equal(resolveRuntimeRecovery(recovered).decisions[0]?.disposition, 'completed');
    } finally {
      restarted.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

function initialEvent(): RuntimeEvent {
  return event({
    id: 'initial-1',
    role: 'user',
    author: 'user',
    content: { kind: 'text', text: 'write it' },
    actions: { runtimeProtocol: { toolBoundary: 't1_after_preflight_v1' } },
  });
}

function callEvent(args: { path: string; content: string }): RuntimeEvent {
  return event({
    id: 'call-1-event',
    role: 'model',
    author: 'agent',
    content: { kind: 'function_call', id: 'call-1', name: 'Write', args },
    refs: { operationId: 'operation-1', toolCallId: 'call-1' },
  });
}

function preparedEvent(fact: ReturnTypeForFact): RuntimeEvent {
  return event({
    id: 'prepared-1',
    actions: {
      runtimeFact: {
        kind: 'maka.file.prepared_mutation',
        version: 1,
        legacyProjection: 'invisible',
        payload: fact,
      },
    },
    refs: { operationId: 'operation-1', toolCallId: 'call-1' },
  });
}

type ReturnTypeForFact = Awaited<ReturnType<LocalFileCheckpointCarrier['prepare']>>;

function dispatchEvent(): RuntimeEvent {
  return event({
    id: 'dispatch-1',
    actions: {
      toolDispatch: {
        protocol: 't1_after_preflight_v1',
        operationId: 'operation-1',
        providerToolCallId: 'call-1',
        toolName: 'Write',
        canonicalArgsHash: 'sha256:args',
        recoveryMode: 'reconcile',
      },
    },
    refs: { operationId: 'operation-1', toolCallId: 'call-1' },
  });
}

function event(overrides: Partial<RuntimeEvent>): RuntimeEvent {
  return {
    id: 'event',
    invocationId: 'invocation-1',
    runId: 'run-1',
    sessionId: 'session-1',
    turnId: 'turn-1',
    ts: 1,
    partial: false,
    role: 'system',
    author: 'system',
    ...overrides,
  };
}
