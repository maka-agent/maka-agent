import assert from 'node:assert/strict';
import test from 'node:test';
import type {
  MemoryExtractionAttempt,
  MemoryExtractionOperation,
} from '@maka/core/long-term-memory';
import type { SessionHeader } from '@maka/core/session';
import { buildUnboundMemoryExtractionChildTools } from '@maka/runtime';
import { SessionNotFoundError } from '@maka/storage/execution-stores';
import {
  HostMemoryExtractionAttemptRunner,
  HostMemoryExtractionAttemptToolBindings,
} from '../server/memory-extraction-attempt-runner.js';
import { MemoryExtractionAttemptRunnerError } from '../server/memory-extraction-worker.js';

test('runs one Attempt in a stable hidden Session with inherited model configuration', async () => {
  const parent = parentHeader();
  const creates: unknown[] = [];
  const sends: unknown[] = [];
  const executions: any[] = [];
  const invalidations: string[] = [];
  let activeToolsSeen = false;
  const bindings = new HostMemoryExtractionAttemptToolBindings({
    prepare: async () => ({
      tools: buildUnboundMemoryExtractionChildTools(),
      initialContext: 'bounded evidence',
    }),
  });
  const runner = new HostMemoryExtractionAttemptRunner({
    sessions: {
      readHeaderSnapshot: async () => parent,
      createStableSession: async (request) => {
        creates.push(request);
        return { kind: 'created', record: { header: internalHeader() } } as never;
      },
    },
    runtime: {
      disposeSessionBackend: async (sessionId: string) => {
        invalidations.push(sessionId);
      },
      sendMessage: (_sessionId, input, options) => {
        sends.push({ input, options });
        return emptyEvents();
      },
    },
    root: {
      executeRoot: async (input) => {
        executions.push(input);
        activeToolsSeen = bindings.resolveForSession(internalHeader())?.length === 3;
        assert.equal(bindings.resolveForSession(parentHeader()), undefined);
        assert.equal(
          bindings.resolveForSession({
            id: 'memory-session-1',
            internalOwner: {
              kind: 'memory_extraction',
              operationId: 'other-operation',
              parentSessionId: 'parent-session',
            },
          }),
          undefined,
        );
        assert.equal(
          bindings.resolveForSession({
            id: 'memory-session-1',
            internalOwner: {
              kind: 'memory_extraction',
              operationId: 'operation-1',
              parentSessionId: 'other-parent',
            },
          }),
          undefined,
        );
        for await (const _event of input.start({
          runId: input.runId,
          userMessageId: input.userMessageId,
          onRunStarted: async () => undefined,
        })) {
          // Internal events are consumed by RootTurnCoordinator, not published to a client.
        }
      },
      stopRoot: async () => undefined,
    },
    toolBindings: bindings,
  });

  await runner.run({
    operation: operation(),
    attempt: attempt(),
    signal: new AbortController().signal,
  });

  assert.equal(creates.length, 1);
  assert.deepEqual((creates[0] as any).input.internalOwner, {
    kind: 'memory_extraction',
    operationId: 'operation-1',
    parentSessionId: 'parent-session',
  });
  assert.equal((creates[0] as any).input.model, parent.model);
  assert.equal((creates[0] as any).input.llmConnectionSlug, parent.llmConnectionSlug);
  assert.equal((creates[0] as any).input.thinkingLevel, parent.thinkingLevel);
  assert.equal(activeToolsSeen, true);
  assert.equal(executions[0].execution.kind, 'memory_extraction_child');
  assert.equal(executions[0].onEvent, undefined);
  assert.deepEqual((sends[0] as any).options.rootExecution, {
    kind: 'memory_extraction_child',
    operationId: 'operation-1',
    attemptId: 'attempt-1',
  });
  assert.match((sends[0] as any).input.text, /runtime_memory_extraction/u);
  assert.match((sends[0] as any).input.text, /bounded evidence/u);
  assert.match((sends[0] as any).input.text, /future Agent would plausibly act better/u);
  assert.match((sends[0] as any).input.text, /Empty is preferable to low-value memory/u);
  assert.match((sends[0] as any).input.text, /Assistant text alone does not prove/u);
  assert.match((sends[0] as any).input.text, /Time passing never converts a plan/u);
  assert.deepEqual(invalidations, ['memory-session-1', 'memory-session-1']);
  assert.equal(bindings.resolveForSession(internalHeader()), undefined);
});

test('fails non-retryably before creating an internal Session when the parent is gone', async () => {
  const runner = new HostMemoryExtractionAttemptRunner({
    sessions: {
      readHeaderSnapshot: async () => {
        throw new SessionNotFoundError('parent-session');
      },
      createStableSession: async () => assert.fail('must not create'),
    },
    runtime: {
      disposeSessionBackend: async () => undefined,
      sendMessage: () => assert.fail('must not send'),
    },
    root: {
      executeRoot: async () => assert.fail('must not execute'),
      stopRoot: async () => undefined,
    },
    toolBindings: new HostMemoryExtractionAttemptToolBindings({
      prepare: async () => assert.fail('must not bind tools'),
    }),
  });

  await assert.rejects(
    runner.run({
      operation: operation(),
      attempt: attempt(),
      signal: new AbortController().signal,
    }),
    (error: unknown) =>
      error instanceof MemoryExtractionAttemptRunnerError &&
      error.code === 'parent_session_missing' &&
      error.retryable === false,
  );
});

test('an abort completed during binding preparation is observed before Root execution', async () => {
  const controller = new AbortController();
  const reason = new Error('host draining');
  let releases = 0;
  let disposals = 0;
  let stops = 0;
  const runner = new HostMemoryExtractionAttemptRunner({
    sessions: {
      readHeaderSnapshot: async () => parentHeader(),
      createStableSession: async () =>
        ({ kind: 'created', record: { header: internalHeader() } }) as never,
    },
    runtime: {
      disposeSessionBackend: async () => {
        disposals += 1;
      },
      sendMessage: () => assert.fail('must not send'),
    },
    root: {
      executeRoot: async () => assert.fail('must not execute'),
      stopRoot: async () => {
        stops += 1;
      },
    },
    toolBindings: new HostMemoryExtractionAttemptToolBindings({
      prepare: async () => {
        controller.abort(reason);
        return {
          tools: buildUnboundMemoryExtractionChildTools(),
          release: () => {
            releases += 1;
          },
        };
      },
    }),
  });

  await assert.rejects(
    runner.run({ operation: operation(), attempt: attempt(), signal: controller.signal }),
    (error: unknown) => error === reason,
  );
  await Promise.resolve();
  assert.equal(stops, 1);
  assert.equal(disposals, 1);
  assert.equal(releases, 1);
});

test('terminal tool failure stops the hidden Root and preserves the stable failure code', async () => {
  let terminal = false;
  let stops = 0;
  let stopForTerminalFailure: (() => void) | undefined;
  const bindings = new HostMemoryExtractionAttemptToolBindings({
    prepare: async (_input, hooks) => {
      stopForTerminalFailure = hooks?.onTerminalFailure;
      return {
        tools: buildUnboundMemoryExtractionChildTools(),
        terminalFailure: () =>
          terminal ? { code: 'invalid_source_ref', phase: 'propose' as const } : undefined,
        release: () => undefined,
        initialContext: 'bounded evidence',
      };
    },
  });
  const runner = new HostMemoryExtractionAttemptRunner({
    sessions: {
      readHeaderSnapshot: async () => parentHeader(),
      createStableSession: async () =>
        ({ kind: 'created', record: { header: internalHeader() } }) as never,
    },
    runtime: {
      disposeSessionBackend: async () => undefined,
      sendMessage: () => emptyEvents(),
    },
    root: {
      executeRoot: async () => {
        terminal = true;
        stopForTerminalFailure?.();
        throw new Error('Root stopped');
      },
      stopRoot: async () => {
        stops += 1;
      },
    },
    toolBindings: bindings,
  });

  await assert.rejects(
    runner.run({
      operation: operation(),
      attempt: attempt(),
      signal: new AbortController().signal,
    }),
    (error: unknown) =>
      error instanceof MemoryExtractionAttemptRunnerError &&
      error.code === 'invalid_source_ref' &&
      error.retryable === false,
  );
  assert.equal(stops, 1);
});

test('attempt bindings reject a same-name tool that changes provider-visible schema metadata', async () => {
  const tools = [...buildUnboundMemoryExtractionChildTools()];
  tools[0] = { ...tools[0]!, description: 'changed description' };
  const bindings = new HostMemoryExtractionAttemptToolBindings({
    prepare: async () => ({ tools }),
  });

  await assert.rejects(
    bindings.activate({
      operation: operation(),
      attempt: attempt(),
      signal: new AbortController().signal,
    }),
    (error: unknown) =>
      error instanceof MemoryExtractionAttemptRunnerError &&
      error.code === 'attempt_tool_schema_mismatch',
  );
});

async function* emptyEvents() {}

function parentHeader(): SessionHeader {
  return {
    id: 'parent-session',
    workspaceRoot: '/workspace',
    cwd: '/workspace/project',
    projectId: 'project-1',
    createdAt: 1,
    lastUsedAt: 1,
    name: 'Parent',
    titleIsManual: false,
    isFlagged: false,
    labels: [],
    isArchived: false,
    status: 'active',
    hasUnread: false,
    backend: 'ai-sdk',
    llmConnectionSlug: 'connection-1',
    connectionLocked: true,
    model: 'model-1',
    thinkingLevel: 'high',
    permissionMode: 'explore',
    collaborationMode: 'agent',
    orchestrationMode: 'default',
    schemaVersion: 1,
  };
}

function internalHeader(): Pick<SessionHeader, 'id' | 'internalOwner'> {
  return {
    id: 'memory-session-1',
    internalOwner: {
      kind: 'memory_extraction',
      operationId: 'operation-1',
      parentSessionId: 'parent-session',
    },
  };
}

function operation(): MemoryExtractionOperation {
  return {
    operationId: 'operation-1',
    sessionId: 'parent-session',
    mode: 'targeted',
    triggerKind: 'user_requested',
    internalSessionId: 'memory-session-1',
    sessionCreateFingerprint: `sha256:${'1'.repeat(64)}`,
    requestHash: `sha256:${'2'.repeat(64)}`,
    requestJson: '{"schemaVersion":1}',
    triggerEpoch: null,
    state: 'running',
    attemptCount: 1,
    activeAttemptId: 'attempt-1',
    leaseExpiresAt: 2,
    nextAttemptAt: null,
    lastErrorCode: null,
    lastErrorStage: null,
    lastErrorAt: null,
    lastFailedAttemptId: null,
    startedAt: 1,
    createdAt: 1,
    updatedAt: 1,
    completedAt: null,
    resultType: null,
    commitHash: null,
    receipt: null,
    diagnosticRetentionUntil: null,
    cleanupState: null,
    cleanupClaimId: null,
    cleanupLeaseExpiresAt: null,
    cleanupAttemptCount: 0,
    cleanupErrorCode: null,
    cleanedAt: null,
    ranges: [],
  };
}

function attempt(): MemoryExtractionAttempt {
  return {
    attemptId: 'attempt-1',
    operationId: 'operation-1',
    attemptOrdinal: 1,
    state: 'running',
    turnId: 'turn-1',
    runId: 'run-1',
    snapshotKind: 'reconstructed_full',
    startedAt: 1,
    completedAt: null,
    failureCode: null,
    failureStage: null,
    metrics: null,
  };
}
