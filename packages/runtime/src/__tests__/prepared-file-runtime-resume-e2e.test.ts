import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { LlmConnection, RuntimeEvent, SessionEvent } from '@maka/core';
import { createAgentRunStore, createSessionStore, createSqliteRuntimeStore } from '@maka/storage';
import { buildBuiltinTools } from '../builtin-tools.js';
import { FakeBackend } from '../fake-backend.js';
import { createPreparedWriteEditRecoveryContractRegistry } from '../file-tool-recovery.js';
import { LocalFileCheckpointCarrier } from '../local-file-checkpoint-carrier.js';
import { PermissionEngine } from '../permission-engine.js';
import type { RuntimeCommitSink } from '../runtime-commit-sink.js';
import { BackendRegistry, SessionManager } from '../session-manager.js';
import { ToolRuntime } from '../tool-runtime.js';

test('a production Write survives a T2 crash and resumes through SessionManager', async () => {
  const root = await mkdtemp(join(tmpdir(), 'maka-write-resume-e2e-'));
  const databasePath = join(root, 'runtime.sqlite');
  const sessionStore = createSessionStore(root);
  const runStore = createAgentRunStore(root);
  const carrier = new LocalFileCheckpointCarrier();
  const firstProcess = createSqliteRuntimeStore(databasePath);
  try {
    const session = await sessionStore.create({
      cwd: root,
      backend: 'fake',
      llmConnectionSlug: 'fake',
      model: 'fake-model',
      permissionMode: 'bypass',
      name: 'Write crash recovery',
      labels: [],
    });
    const sourceRunId = 'source-run';
    const sourceTurnId = 'source-turn';
    const sourceInvocationId = 'source-invocation';
    await runStore.createRun({
      runId: sourceRunId,
      invocationId: sourceInvocationId,
      sessionId: session.id,
      turnId: sourceTurnId,
      status: 'failed',
      failureClass: 'app_restarted',
      backendKind: 'fake',
      llmConnectionSlug: 'fake',
      modelId: 'fake-model',
      cwd: root,
      workspaceIdentity: 'workspace-1',
      permissionMode: 'bypass',
      createdAt: 1,
      updatedAt: 10,
      completedAt: 10,
    });
    await firstProcess.appendRuntimeEvent(
      session.id,
      sourceRunId,
      runtimeEvent({
        id: 'source-user',
        sessionId: session.id,
        runId: sourceRunId,
        turnId: sourceTurnId,
        invocationId: sourceInvocationId,
        ts: 1,
        role: 'user',
        author: 'user',
        content: { kind: 'text', text: 'write result.txt' },
        actions: { runtimeProtocol: { toolBoundary: 't1_after_preflight_v1' } },
      }),
    );

    const crashBeforeT2: RuntimeCommitSink = {
      commitToolPrepared: (input) => firstProcess.commitToolPrepared(input),
      commitToolOutcome: async () => {
        throw new Error('simulated process crash before T2');
      },
    };
    const permissionEngine = new PermissionEngine({ newId: nextId(), now: () => 2 });
    permissionEngine.beginTurn(sourceTurnId);
    const runtime = new ToolRuntime({
      sessionId: session.id,
      header: session,
      connection: connection(),
      modelId: 'fake-model',
      appendMessage: async () => {},
      permissionEngine,
      newId: nextId(),
      now: nextNow(2),
      getPermissionPauseTarget: () => null,
      getCurrentRunId: () => sourceRunId,
      getCurrentInvocationId: () => sourceInvocationId,
      runtimeCommitSink: crashBeforeT2,
    });
    const write = buildBuiltinTools({ fileMutationCheckpointCarrier: carrier }).find(
      ({ name }) => name === 'Write',
    );
    assert.ok(write);

    await assert.rejects(
      runtime.wrapToolExecute(write, sourceTurnId, { push: () => {} })(
        { path: 'result.txt', content: 'durable result' },
        {
          toolCallId: 'provider-write-1',
          abortSignal: new AbortController().signal,
        },
      ),
      /T2 runtime commit failed: simulated process crash before T2/,
    );
    assert.equal(await readFile(join(root, 'result.txt'), 'utf8'), 'durable result');
    const interruptedEvents = await firstProcess.readRuntimeEvents(session.id, sourceRunId);
    assert.equal(
      interruptedEvents.find((event) => event.actions?.toolDispatch)?.actions?.toolDispatch
        ?.recoveryMode,
      'reconcile',
    );
    assert.equal(
      interruptedEvents.some((event) => event.content?.kind === 'function_response'),
      false,
    );
    await firstProcess.appendRuntimeEvent(
      session.id,
      sourceRunId,
      runtimeEvent({
        id: 'source-terminal',
        sessionId: session.id,
        runId: sourceRunId,
        turnId: sourceTurnId,
        invocationId: sourceInvocationId,
        ts: 10,
        role: 'system',
        author: 'system',
        status: 'failed',
        actions: { endInvocation: true, stateDelta: { failureClass: 'app_restarted' } },
      }),
    );
    firstProcess.close();

    const restarted = createSqliteRuntimeStore(databasePath);
    try {
      const backends = new BackendRegistry();
      backends.register('fake', (context) => new FakeBackend(context));
      const manager = new SessionManager({
        store: sessionStore,
        runStore,
        runtimeEventStore: restarted,
        toolRecoveryStore: restarted,
        recoveryContracts: createPreparedWriteEditRecoveryContractRegistry(carrier),
        backends,
        safeBoundaryResumeEnabled: true,
        inspectContinuationSafety: async () => ({
          workspaceIdentity: 'workspace-1',
          backgroundOperationsSettled: true,
          availableToolNames: ['Write'],
        }),
        newId: nextId(),
        now: nextNow(20),
        runtimeSource: 'test',
      });

      const plan = await manager.planAuthoritativeSafeBoundaryContinuation(session.id, {
        sourceRunId,
      });
      assert.equal(plan.disposition, 'continue');
      assert.equal(plan.recoveredOperations?.[0]?.nextAction, 'synthesize_response');
      assert.ok(plan.continuation);
      assert.equal(await readFile(join(root, 'result.txt'), 'utf8'), 'durable result');

      const recoveredEvents = await restarted.readRuntimeEvents(session.id, sourceRunId);
      assert.equal(
        recoveredEvents.filter((event) => event.content?.kind === 'function_response').length,
        1,
      );
      const operationId = recoveredEvents.find((event) => event.refs?.operationId)?.refs
        ?.operationId;
      assert.ok(operationId);
      assert.deepEqual(
        (await restarted.readToolJournal(operationId)).map(({ state }) => state),
        ['prepared', 'reconcile_recorded', 'outcome_committed', 'recovery_decided'],
      );

      const continuationEvents = await collect(
        manager.resumeSafeBoundaryContinuation(plan.continuation),
      );
      assert.ok(continuationEvents.some((event) => event.type === 'text_complete'));
      assert.ok(continuationEvents.some((event) => event.type === 'complete'));
      assert.equal(
        (await runStore.readRun(session.id, plan.continuation.runId)).status,
        'completed',
      );
    } finally {
      restarted.close();
    }
  } finally {
    try {
      firstProcess.close();
    } catch {
      // The simulated process may already have closed its database handle.
    }
    await rm(root, { recursive: true, force: true });
  }
});

function runtimeEvent(input: Omit<RuntimeEvent, 'partial'>): RuntimeEvent {
  return { partial: false, ...input };
}

function connection(): LlmConnection {
  return {
    slug: 'fake',
    name: 'fake',
    providerType: 'openai',
    defaultModel: 'fake-model',
    enabled: true,
    createdAt: 1,
    updatedAt: 1,
  };
}

function nextId(): () => string {
  let value = 0;
  return () => `generated-${++value}`;
}

function nextNow(start: number): () => number {
  let value = start;
  return () => ++value;
}

async function collect(iterable: AsyncIterable<SessionEvent>): Promise<SessionEvent[]> {
  const events: SessionEvent[] = [];
  for await (const event of iterable) events.push(event);
  return events;
}
