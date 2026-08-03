import assert from 'node:assert/strict';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { MemorySha256Digest } from '@maka/core/long-term-memory';
import type { RuntimeEvent } from '@maka/core/runtime-event';
import {
  createMemoryExtractionChildToolSet,
  MEMORY_SUBMIT_TOOL_NAME,
  type MakaToolContext,
  type RuntimeHostedRootAuthority,
} from '@maka/runtime';
import { openInteractiveExecutionStoresForWrite } from '@maka/storage/execution-stores';
import {
  LONG_TERM_MEMORY_DATABASE_NAME,
  openInteractiveLongTermMemoryStoreForWrite,
} from '@maka/storage/long-term-memory-store';
import { resolveStorageRoot, tryAcquireInteractiveRootOwner } from '@maka/storage/root-authority';
import {
  HostMemoryExtractionAttemptRunner,
  HostMemoryExtractionAttemptToolBindings,
} from '../server/memory-extraction-attempt-runner.js';
import { HostMemoryExtractionAttemptPorts } from '../server/memory-extraction-tool-ports.js';
import { HostMemoryExtractionWorker } from '../server/memory-extraction-worker.js';

test('real SQLite operation commits an Item through the hidden Memory child chain', async () => {
  const base = await mkdtemp(join(tmpdir(), 'maka-memory-component-chain-'));
  const root = join(base, 'interactive');
  const capability = await resolveStorageRoot({ path: root, kind: 'interactive' });
  const owner = await tryAcquireInteractiveRootOwner(capability);
  assert.ok(owner);
  if (!owner) throw new Error('Unable to acquire test Storage Root');
  const memory = await openInteractiveLongTermMemoryStoreForWrite(owner.lease);
  let worker: HostMemoryExtractionWorker | undefined;
  try {
    const stores = await openInteractiveExecutionStoresForWrite(owner.lease);
    const parent = await stores.sessionStore.create({
      cwd: root,
      backend: 'fake',
      llmConnectionSlug: 'fake',
      model: 'fake-model',
      permissionMode: 'explore',
      collaborationMode: 'agent',
      orchestrationMode: 'default',
    });
    const sourceRunId = 'memory-source-run';
    const sourceTurnId = 'memory-source-turn';
    const sourceEvent = userTextEvent(parent.id, sourceRunId, sourceTurnId);
    await stores.runtimeEventStore.appendRuntimeEvent(parent.id, sourceRunId, sourceEvent, {
      durable: true,
    });
    const prefix = await stores.runtimeEventStore.readImmutableRuntimePrefix({
      sessionId: parent.id,
      runId: sourceRunId,
    });

    const operationId = 'memory-component-operation';
    const internalSessionId = 'memory-component-internal-session';
    await memory.createMemoryExtractionOperation({
      operationId,
      sessionId: parent.id,
      mode: 'sweep',
      triggerKind: 'context_threshold',
      internalSessionId,
      sessionCreateFingerprint: digest('a'),
      requestHash: digest('b'),
      requestJson: JSON.stringify({
        protocol: 'memory_extraction_request_v1',
        calendarTimeZone: 'UTC',
      }),
      triggerEpoch: 'component-chain-epoch',
      ranges: [
        {
          rangeOrdinal: 0,
          sessionId: parent.id,
          invocationId: prefix.identity.invocationId,
          runId: sourceRunId,
          turnId: sourceTurnId,
          fromEventSeqExclusive: 0,
          fromEventId: null,
          fromPrefixDigest: null,
          toEventSeqInclusive: prefix.position.lastEventSeq,
          toEventId: prefix.position.lastEventId,
          toPrefixDigest: prefix.prefixDigest,
        },
      ],
    });

    const bindings = new HostMemoryExtractionAttemptToolBindings({
      prepare: async (input, hooks) => {
        const ports = new HostMemoryExtractionAttemptPorts({
          operationId: input.operation.operationId,
          attemptId: input.attempt.attemptId,
          internalSessionId: input.operation.internalSessionId,
          runId: input.attempt.runId,
          workspaceKey: root,
          operations: memory,
          runtimeEvents: stores.runtimeEventStore,
          commitWithParentAdmission: async (parentSessionId, commit) => {
            await stores.sessionStore.readHeaderSnapshot(parentSessionId);
            return await commit();
          },
        });
        const initial = await ports.prepareInitialEvidence();
        const toolSet = createMemoryExtractionChildToolSet(
          {
            operationId: input.operation.operationId,
            attemptId: input.attempt.attemptId,
            internalSessionId: input.operation.internalSessionId,
            runId: input.attempt.runId,
            initialSourceRefs: initial.sources.map((source) => source.sourceRef),
            onTerminalFailure: () => hooks?.onTerminalFailure(),
          },
          ports,
        );
        return {
          tools: toolSet.tools,
          terminalFailure: toolSet.terminalFailure,
          initialContext: JSON.stringify(initial),
        };
      },
    });

    const backend = new DeterministicMemoryBackend({ bindings, stores, root });
    const runner = new HostMemoryExtractionAttemptRunner({
      sessions: stores.sessionStore,
      runtime: {
        disposeSessionBackend: async () => undefined,
        sendMessage: (_sessionId, input, options) =>
          backend.events(input.text, async () => {
            if (options?.onRunStarted && options.runId) {
              await options.onRunStarted(
                options.runId,
                await stores.sessionStore.readHeaderSnapshot(internalSessionId),
              );
            }
          }),
      },
      root: {
        executeRoot: (input) => backend.executeRoot(input),
        stopRoot: async () => undefined,
      },
      toolBindings: bindings,
    });

    const ids = ['memory-attempt-1', 'memory-turn-1', 'memory-run-1'];
    worker = new HostMemoryExtractionWorker({
      store: memory,
      runner,
      acquireResidency: () => ({ release: () => undefined }),
      requestDrain: () => assert.fail('component chain must not request Host drain'),
      runPolicyAuthorized: async (_operation, execute) => {
        await execute();
        return true;
      },
      leaseDurationMs: 60_000,
      leaseRenewIntervalMs: 20_000,
      newId: () => {
        const id = ids.shift();
        if (!id) throw new Error('Unexpected extra Memory Worker id request');
        return id;
      },
    });
    await worker.recover();
    await eventually(
      async () => (await memory.readMemoryExtractionOperation(operationId))?.state === 'succeeded',
    );
    await worker.close();
    worker = undefined;

    const committed = await memory.readMemoryExtractionOperation(operationId);
    assert.equal(committed?.resultType, 'proposed');
    assert.equal(committed?.receipt?.mutationResults.length, 1);
    assert.equal(committed?.receipt?.cursors[0]?.committedEventSeq, 1);
    assert.equal(committed?.receipt?.writeOperationId, operationId);
    const itemId = committed?.receipt?.mutationResults[0]?.itemId;
    assert.ok(itemId);
    const record = await memory.readItem(itemId);
    assert.equal(record?.item.content, '用户希望回答保持简洁。');
    assert.deepEqual(record?.sources, [
      {
        sessionId: parent.id,
        runId: sourceRunId,
        turnId: sourceTurnId,
        eventId: sourceEvent.id,
      },
    ]);
    assert.equal(
      (await memory.readMemoryExtractionCursor(parent.id, sourceRunId))?.committedEventSeq,
      1,
    );

    const internal = await stores.sessionStore.readHeaderSnapshot(internalSessionId);
    assert.deepEqual(internal.internalOwner, {
      kind: 'memory_extraction',
      operationId,
      parentSessionId: parent.id,
    });
    assert.equal(
      (await stores.sessionStore.list()).some((session) => session.id === internalSessionId),
      false,
    );
    assert.equal((await stat(join(root, LONG_TERM_MEMORY_DATABASE_NAME))).isFile(), true);
  } finally {
    await worker?.close().catch(() => undefined);
    memory.close();
    await owner.close();
    await rm(base, { recursive: true, force: true });
  }
});

class DeterministicMemoryBackend {
  #prompt = '';

  constructor(
    private readonly input: {
      bindings: HostMemoryExtractionAttemptToolBindings;
      stores: Awaited<ReturnType<typeof openInteractiveExecutionStoresForWrite>>;
      root: string;
    },
  ) {}

  async *events(prompt: string, start: () => Promise<void>) {
    this.#prompt = prompt;
    await start();
  }

  async executeRoot(
    input: Parameters<RuntimeHostedRootAuthority['executeRoot']>[0],
  ): Promise<void> {
    for await (const _event of input.start({
      runId: input.runId,
      userMessageId: input.userMessageId,
      onRunStarted: async () => undefined,
    })) {
      // This backend is intentionally silent and only invokes memory_submit.
    }
    const header = await this.input.stores.sessionStore.readHeaderSnapshot(input.sessionId);
    const submit = this.input.bindings
      .resolveForSession(header)
      ?.find((tool) => tool.name === MEMORY_SUBMIT_TOOL_NAME);
    assert.ok(submit?.impl);
    const source = initialSourcesFromPrompt(this.#prompt)[0];
    assert.ok(source);
    const result = await submit.impl(
      {
        action: 'propose',
        result: {
          outcome: 'proposed',
          selectionSaturated: false,
          proposals: [
            {
              content: '用户希望回答保持简洁。',
              kind: 'preference',
              statementType: 'fact',
              temporal: { type: 'undated' },
              scopeProposal: 'global',
              suggestedKeys: [{ key: '简洁回答', keyType: 'concept' }],
              supports: [{ sourceRef: source.sourceRef, quote: '回答保持简洁' }],
            },
          ],
        },
      },
      toolContext(input, this.input.root),
    );
    assert.deepEqual(result, {
      status: 'committed',
      resultType: 'proposed',
      mutationCount: 1,
      replayed: false,
    });
  }
}

function userTextEvent(sessionId: string, runId: string, turnId: string): RuntimeEvent {
  return {
    id: 'memory-source-event',
    invocationId: 'memory-source-invocation',
    runId,
    sessionId,
    turnId,
    ts: Date.now() - 1_000,
    partial: false,
    role: 'user',
    author: 'user',
    content: { kind: 'text', text: '请记住：回答保持简洁。' },
  };
}

function initialSourcesFromPrompt(prompt: string): Array<{ sourceRef: string }> {
  const match = /<memory_evidence_context>([\s\S]+)<\/memory_evidence_context>/u.exec(prompt);
  assert.ok(match?.[1]);
  const value = JSON.parse(match[1]) as { sources?: Array<{ sourceRef: string }> };
  assert.ok(Array.isArray(value.sources));
  return value.sources;
}

function toolContext(
  input: { sessionId: string; runId: string; turnId: string },
  cwd: string,
): MakaToolContext {
  return {
    ...input,
    cwd,
    toolCallId: 'memory-submit-call',
    abortSignal: new AbortController().signal,
    emitOutput: () => undefined,
  };
}

async function eventually(condition: () => Promise<boolean>, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await condition())) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for Memory Extraction commit');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function digest(character: string): MemorySha256Digest {
  return `sha256:${character.repeat(64)}`;
}
