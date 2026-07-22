import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import type { AgentRunHeader, RuntimeEvent, RuntimeEventStore } from '@maka/core';
import {
  createAgentRunStore,
  createRuntimeEventStore,
  createSessionStore,
  createSqliteRuntimeStore,
} from '@maka/storage';
import { BackendRegistry, SessionManager } from '../session-manager.js';
import { ToolRecoveryContractRegistry } from '../tool-recovery-contract.js';

describe('SessionManager Phase 3A production recovery', () => {
  it('keeps the plan parked and appends a stable diagnostic when observation is blocked', async () => {
    await withInterruptedWrites(
      [{ path: 'blocked.txt', result: 'observation_failed' }],
      async (fx) => {
        const plan = await fx.plan();

        assert.equal(plan.disposition, 'park');
        assert.ok(plan.diagnostics.some(({ code }) => code === 'tool_recovery_observation_failed'));
        assert.deepEqual(await fx.journalStates('blocked.txt'), ['prepared']);
      },
    );
  });

  it('keeps earlier recovery facts when a later operation is blocked and parks this attempt', async () => {
    await withInterruptedWrites(
      [
        { path: 'applied.txt', result: 'applied' },
        { path: 'blocked.txt', result: 'observation_failed' },
      ],
      async (fx) => {
        const plan = await fx.plan();

        assert.equal(plan.disposition, 'park');
        assert.deepEqual(await fx.journalStates('applied.txt'), [
          'prepared',
          'reconcile_recorded',
          'outcome_committed',
          'recovery_decided',
        ]);
        assert.deepEqual(await fx.journalStates('blocked.txt'), ['prepared']);
      },
    );
  });

  it('records not_applied once and does not repeatedly reconcile it on later resume attempts', async () => {
    await withInterruptedWrites([{ path: 'missing.txt', result: 'not_applied' }], async (fx) => {
      const first = await fx.plan();
      const second = await fx.plan();

      assert.equal(first.disposition, 'park');
      assert.equal(second.disposition, 'park');
      assert.equal(fx.observationCount('missing.txt'), 1);
      assert.deepEqual(await fx.journalStates('missing.txt'), [
        'prepared',
        'reconcile_recorded',
        'recovery_decided',
      ]);
      assert.ok(
        second.diagnostics.some(
          (diagnostic) =>
            diagnostic.code === 'tool_recovery_required' &&
            diagnostic.detail?.reasonCode === 'reconcile_not_applied',
        ),
      );
    });
  });

  it('does not attempt Phase 3A recovery for the JSONL host configuration without contracts', async () => {
    await withInterruptedWrites(
      [{ path: 'legacy.txt', result: 'applied' }],
      async (fx) => {
        const before = await fx.runtimeEvents();
        const plan = await fx.plan();

        assert.equal(plan.disposition, 'park');
        assert.ok(plan.diagnostics.some(({ code }) => code === 'tool_recovery_contract_missing'));
        assert.deepEqual(await fx.runtimeEvents(), before);
        assert.equal(fx.observationCount('legacy.txt'), 0);
      },
      { canonical: false },
    );
  });
});

type WriteResult = 'applied' | 'not_applied' | 'observation_failed';

interface InterruptedWrite {
  path: string;
  result: WriteResult;
}

interface InterruptedWriteFixture {
  plan(): ReturnType<SessionManager['planAuthoritativeSafeBoundaryContinuation']>;
  journalStates(path: string): Promise<string[]>;
  observationCount(path: string): number;
  runtimeEvents(): Promise<RuntimeEvent[]>;
}

async function withInterruptedWrites(
  writes: readonly InterruptedWrite[],
  run: (fixture: InterruptedWriteFixture) => Promise<void>,
  options: { canonical?: boolean } = {},
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'maka-session-recovery-'));
  const sessionStore = createSessionStore(root);
  const runStore = createAgentRunStore(root);
  const canonical = options.canonical !== false;
  const sqliteStore = canonical ? createSqliteRuntimeStore(':memory:') : undefined;
  const runtimeEventStore: RuntimeEventStore = sqliteStore ?? createRuntimeEventStore(root);
  const observations = new Map<string, number>();
  const contracts = canonical
    ? new ToolRecoveryContractRegistry([
        {
          toolName: 'Write',
          contract: {
            id: 'maka.tool.write.reconcile',
            version: 1,
            mode: 'reconcile_then_decide',
            observe: async (operation) => {
              const path = readPath(operation.args);
              observations.set(path, (observations.get(path) ?? 0) + 1);
              const configured = writes.find((write) => write.path === path)?.result;
              if (configured === 'observation_failed') throw new Error('read failed');
              return { path, result: configured };
            },
            decide: ({ observation }) => {
              const observed = observation as { path: string; result?: WriteResult };
              if (observed.result === 'applied') {
                return {
                  result: 'applied',
                  reasonCode: 'write_postcondition_matches',
                  nextAction: 'synthesize_response',
                  synthesizedResult: { ok: true, path: observed.path, recovered: true },
                };
              }
              return {
                result: 'not_applied',
                reasonCode: 'write_target_missing',
                nextAction: 'retry_allowed',
              };
            },
          },
        },
      ])
    : undefined;
  let id = 0;
  let now = 100;
  const manager = new SessionManager({
    store: sessionStore,
    runStore,
    runtimeEventStore,
    ...(sqliteStore && contracts
      ? { toolRecoveryStore: sqliteStore, recoveryContracts: contracts }
      : {}),
    backends: new BackendRegistry(),
    safeBoundaryResumeEnabled: true,
    inspectContinuationSafety: async () => ({
      workspaceIdentity: 'workspace-1',
      backgroundOperationsSettled: true,
      availableToolNames: ['Write'],
    }),
    newId: () => `generated-${++id}`,
    now: () => ++now,
  });
  try {
    const session = await manager.createSession({
      cwd: root,
      backend: 'fake',
      llmConnectionSlug: 'fake',
      model: 'fake-model',
      permissionMode: 'ask',
      name: 'Recovery test',
      labels: [],
    });
    const sourceRunId = 'source-run';
    const sourceTurnId = 'source-turn';
    const sourceInvocationId = 'source-invocation';
    await runStore.createRun(
      runHeader({
        sessionId: session.id,
        runId: sourceRunId,
        turnId: sourceTurnId,
        cwd: root,
      }),
    );
    await runtimeEventStore.appendRuntimeEvent(
      session.id,
      sourceRunId,
      event({
        id: 'source-user',
        sessionId: session.id,
        runId: sourceRunId,
        turnId: sourceTurnId,
        invocationId: sourceInvocationId,
        ts: 1,
        role: 'user',
        author: 'user',
        content: { kind: 'text', text: 'write files' },
        actions: { runtimeProtocol: { toolBoundary: 't1_after_preflight_v1' } },
      }),
    );
    for (const [index, write] of writes.entries()) {
      const operationId = operationIdFor(write.path);
      const toolCallId = `call-${index + 1}`;
      const call = event({
        id: `call-event-${index + 1}`,
        sessionId: session.id,
        runId: sourceRunId,
        turnId: sourceTurnId,
        invocationId: sourceInvocationId,
        ts: index * 2 + 2,
        role: 'model',
        author: 'agent',
        content: {
          kind: 'function_call',
          id: toolCallId,
          name: 'Write',
          args: { path: write.path, content: `contents:${write.path}` },
        },
      });
      const dispatch = event({
        id: `dispatch-event-${index + 1}`,
        sessionId: session.id,
        runId: sourceRunId,
        turnId: sourceTurnId,
        invocationId: sourceInvocationId,
        ts: index * 2 + 3,
        role: 'system',
        author: 'system',
        actions: {
          toolDispatch: {
            protocol: 't1_after_preflight_v1',
            operationId,
            providerToolCallId: toolCallId,
            toolName: 'Write',
            canonicalArgsHash: `sha256:${index + 1}`,
            recoveryMode: 'reconcile',
          },
        },
        refs: { operationId, toolCallId },
      });
      if (sqliteStore) {
        await sqliteStore.commitToolPrepared({
          operationId,
          journalEventId: `journal-${index + 1}`,
          runtimeEvent: call,
          dispatchRuntimeEvent: dispatch,
          providerToolCallId: toolCallId,
          toolName: 'Write',
          canonicalArgsHash: `sha256:${index + 1}`,
          recoveryMode: 'reconcile',
          committedAt: index * 2 + 3,
        });
      } else {
        await runtimeEventStore.appendRuntimeEvent(session.id, sourceRunId, call);
        await runtimeEventStore.appendRuntimeEvent(session.id, sourceRunId, dispatch);
      }
    }
    await runtimeEventStore.appendRuntimeEvent(
      session.id,
      sourceRunId,
      event({
        id: 'source-terminal',
        sessionId: session.id,
        runId: sourceRunId,
        turnId: sourceTurnId,
        invocationId: sourceInvocationId,
        ts: writes.length * 2 + 2,
        role: 'system',
        author: 'system',
        status: 'failed',
        actions: { endInvocation: true, stateDelta: { failureClass: 'app_restarted' } },
      }),
    );

    await run({
      plan: () => manager.planAuthoritativeSafeBoundaryContinuation(session.id, { sourceRunId }),
      journalStates: async (path) =>
        sqliteStore
          ? (await sqliteStore.readToolJournal(operationIdFor(path))).map(({ state }) => state)
          : [],
      observationCount: (path) => observations.get(path) ?? 0,
      runtimeEvents: () => runtimeEventStore.readRuntimeEvents(session.id, sourceRunId),
    });
  } finally {
    sqliteStore?.close();
    await rm(root, { recursive: true, force: true });
  }
}

function event(input: Omit<RuntimeEvent, 'partial'>): RuntimeEvent {
  return { partial: false, ...input };
}

function runHeader(overrides: Partial<AgentRunHeader>): AgentRunHeader {
  return {
    runId: 'source-run',
    sessionId: 'session-1',
    turnId: 'source-turn',
    status: 'failed',
    backendKind: 'fake',
    llmConnectionSlug: 'fake',
    modelId: 'fake-model',
    cwd: '/tmp',
    workspaceIdentity: 'workspace-1',
    permissionMode: 'ask',
    createdAt: 1,
    updatedAt: 10,
    completedAt: 10,
    failureClass: 'app_restarted',
    ...overrides,
  };
}

function readPath(args: unknown): string {
  if (typeof args !== 'object' || args === null || !('path' in args)) return '<invalid>';
  return String(args.path);
}

function operationIdFor(path: string): string {
  return `operation-${path.replaceAll(/[^A-Za-z0-9_-]/g, '-')}`;
}
