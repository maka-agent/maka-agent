import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import type { LlmConnection, SessionEvent, SessionHeader } from '@maka/core';
import { createSqliteRuntimeStore } from '@maka/storage';
import { createSessionEventMapMemory, mapSessionEventToRuntimeEvent } from '../ai-sdk-flow.js';
import { buildBuiltinTools } from '../builtin-tools.js';
import type { InvocationContext } from '../invocation-context.js';
import { LocalFileCheckpointCarrier } from '../local-file-checkpoint-carrier.js';
import { FilesystemWorkerClientError } from '../filesystem-worker/client.js';
import { PermissionEngine } from '../permission-engine.js';
import { parsePreparedFileMutationFact } from '../tool-recovery-facts.js';
import { ToolRuntime, type MakaTool } from '../tool-runtime.js';

describe('ToolRuntime with real SQLite boundary', () => {
  for (const failure of [
    {
      name: 'after_replace failpoint',
      carrier: () =>
        new LocalFileCheckpointCarrier({
          failpoint: (point) => {
            if (point === 'after_replace') throw new Error('crash:after_replace');
          },
        }),
      cause: 'crash:after_replace',
    },
    {
      name: 'after_parent_fsync failpoint',
      carrier: () =>
        new LocalFileCheckpointCarrier({
          failpoint: (point) => {
            if (point === 'after_parent_fsync') throw new Error('crash:after_parent_fsync');
          },
        }),
      cause: 'crash:after_parent_fsync',
    },
    {
      name: 'parent directory fsync failure',
      carrier: () =>
        new LocalFileCheckpointCarrier({
          platform: 'linux',
          syncDirectory: async () => {
            throw new Error('parent fsync failed');
          },
        }),
      cause: 'parent fsync failed',
    },
  ] as const) {
    it(`leaves a prepared Write unsettled after ${failure.name}`, async () => {
      const root = await mkdtemp(join(tmpdir(), 'maka-tool-unsettled-'));
      const store = createSqliteRuntimeStore(join(root, 'runtime.sqlite'));
      try {
        await writeFile(join(root, 'notes.txt'), 'before image');
        const permissionEngine = new PermissionEngine({ newId: nextId(), now: () => 1 });
        permissionEngine.beginTurn('turn-1');
        const traceTypes: string[] = [];
        const runtime = new ToolRuntime({
          sessionId: 'session-1',
          header: { ...header(), workspaceRoot: root, cwd: root, permissionMode: 'bypass' },
          connection: connection(),
          modelId: 'model-1',
          appendMessage: async () => {},
          permissionEngine,
          newId: nextId(),
          now: nextNow(),
          getPermissionPauseTarget: () => null,
          getCurrentRunId: () => 'run-1',
          getCurrentInvocationId: () => 'invocation-1',
          runtimeCommitSink: store,
          getRunTrace: () => ({
            emit: (_phase, type) => {
              traceTypes.push(type);
            },
          }),
        });
        const tool = buildBuiltinTools({
          fileMutationCheckpointCarrier: failure.carrier(),
        }).find(({ name }) => name === 'Write');
        assert.ok(tool);

        await assert.rejects(
          runtime.settleToolCall({
            tool,
            turnId: 'turn-1',
            toolCallId: 'provider-Write',
            input: { path: 'notes.txt', content: 'after image' },
            abortSignal: new AbortController().signal,
            eventSink: { push: () => {} },
          }),
          (error: unknown) =>
            error instanceof Error &&
            error.name === 'DurableToolExecutionUnsettledError' &&
            error.cause instanceof Error &&
            error.cause.message === failure.cause,
        );

        assert.equal(await readFile(join(root, 'notes.txt'), 'utf8'), 'after image');
        const events = await store.readRuntimeEvents('session-1', 'run-1');
        assert.equal(
          events.some((event) => event.content?.kind === 'function_response'),
          false,
        );
        const operationId = events.find((event) => event.content?.kind === 'function_call')?.refs
          ?.operationId;
        assert.ok(operationId);
        assert.equal((await store.readToolOperation(operationId))?.currentState, 'prepared');
        assert.equal(traceTypes.includes('tool_unsettled'), true);
        assert.equal(traceTypes.includes('tool_failed'), false);
      } finally {
        store.close();
        await rm(root, { recursive: true, force: true });
      }
    });
  }

  it('keeps the real prepared Write on the worker through T1 and T2', async () => {
    const root = await mkdtemp(join(tmpdir(), 'maka-tool-worker-owned-'));
    const store = createSqliteRuntimeStore(join(root, 'runtime.sqlite'));
    try {
      await writeFile(join(root, 'notes.txt'), 'before image');
      const permissionEngine = new PermissionEngine({ newId: nextId(), now: () => 1 });
      permissionEngine.beginTurn('turn-1');
      const runtime = new ToolRuntime({
        sessionId: 'session-1',
        header: { ...header(), workspaceRoot: root, cwd: root, permissionMode: 'bypass' },
        connection: connection(),
        modelId: 'model-1',
        appendMessage: async () => {},
        permissionEngine,
        newId: nextId(),
        now: nextNow(),
        getPermissionPauseTarget: () => null,
        getCurrentRunId: () => 'run-1',
        getCurrentInvocationId: () => 'invocation-1',
        runtimeCommitSink: store,
      });
      const hostCarrier = new LocalFileCheckpointCarrier();
      hostCarrier.apply = async () => {
        throw new Error('host-local prepared apply was invoked');
      };
      const workerCarrier = new LocalFileCheckpointCarrier();
      let workerCalls = 0;
      const tool = buildBuiltinTools({
        fileMutationCheckpointCarrier: hostCarrier,
        filesystemWorker: {
          execute: async (input) => {
            workerCalls += 1;
            assert.equal(input.operation.kind, 'prepared_file_apply');
            if (input.operation.kind !== 'prepared_file_apply') {
              throw new Error('unexpected worker operation');
            }
            const fact = parsePreparedFileMutationFact(input.operation.fact);
            assert.ok(fact);
            await workerCarrier.apply(
              fact,
              Buffer.from(input.operation.expectedContentBase64, 'base64'),
            );
            return { kind: 'prepared_file_apply', ok: true };
          },
        },
      }).find(({ name }) => name === 'Write');
      assert.ok(tool);

      const { result } = await runtime.settleToolCall({
        tool,
        turnId: 'turn-1',
        toolCallId: 'provider-Write',
        input: { path: 'notes.txt', content: 'after image' },
        abortSignal: new AbortController().signal,
        eventSink: { push: () => {} },
      });

      assert.deepEqual(result, {
        ok: true,
        path: join(root, 'notes.txt'),
        bytes: Buffer.byteLength('after image'),
      });
      assert.equal(workerCalls, 1);
      assert.equal(await readFile(join(root, 'notes.txt'), 'utf8'), 'after image');
      const events = await store.readRuntimeEvents('session-1', 'run-1');
      assert.equal(events.filter((event) => event.content?.kind === 'function_response').length, 1);
      const operationId = events.find((event) => event.content?.kind === 'function_call')?.refs
        ?.operationId;
      assert.ok(operationId);
      assert.equal((await store.readToolOperation(operationId))?.currentState, 'outcome_committed');
    } finally {
      store.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('leaves a prepared Write unsettled when its worker crashes during apply', async () => {
    const root = await mkdtemp(join(tmpdir(), 'maka-tool-worker-crash-'));
    const store = createSqliteRuntimeStore(join(root, 'runtime.sqlite'));
    try {
      await writeFile(join(root, 'notes.txt'), 'before image');
      const permissionEngine = new PermissionEngine({ newId: nextId(), now: () => 1 });
      permissionEngine.beginTurn('turn-1');
      const runtime = new ToolRuntime({
        sessionId: 'session-1',
        header: { ...header(), workspaceRoot: root, cwd: root, permissionMode: 'bypass' },
        connection: connection(),
        modelId: 'model-1',
        appendMessage: async () => {},
        permissionEngine,
        newId: nextId(),
        now: nextNow(),
        getPermissionPauseTarget: () => null,
        getCurrentRunId: () => 'run-1',
        getCurrentInvocationId: () => 'invocation-1',
        runtimeCommitSink: store,
      });
      const tool = buildBuiltinTools({
        fileMutationCheckpointCarrier: new LocalFileCheckpointCarrier(),
        filesystemWorker: {
          execute: async () => {
            throw new FilesystemWorkerClientError({
              reason: 'worker_crashed',
              stage: 'launch',
              effectMayHaveStarted: true,
            });
          },
        },
      }).find(({ name }) => name === 'Write');
      assert.ok(tool);

      await assert.rejects(
        runtime.settleToolCall({
          tool,
          turnId: 'turn-1',
          toolCallId: 'provider-Write',
          input: { path: 'notes.txt', content: 'after image' },
          abortSignal: new AbortController().signal,
          eventSink: { push: () => {} },
        }),
        /unsettled/,
      );

      const events = await store.readRuntimeEvents('session-1', 'run-1');
      assert.equal(
        events.some((event) => event.content?.kind === 'function_response'),
        false,
      );
      const operationId = events.find((event) => event.content?.kind === 'function_call')?.refs
        ?.operationId;
      assert.ok(operationId);
      assert.equal((await store.readToolOperation(operationId))?.currentState, 'prepared');
    } finally {
      store.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('persists reconcile dispatch mode for production Write and Edit definitions', async () => {
    const cases = [
      { toolName: 'Write', args: { path: 'write.txt', content: 'written' } },
      {
        toolName: 'Edit',
        args: { path: 'edit.txt', old_string: 'before', new_string: 'after' },
      },
    ] as const;
    for (const candidate of cases) {
      const root = await mkdtemp(join(tmpdir(), `maka-builtin-${candidate.toolName}-`));
      const store = createSqliteRuntimeStore(join(root, 'runtime.sqlite'));
      try {
        if (candidate.toolName === 'Edit') await writeFile(join(root, 'edit.txt'), 'before');
        const permissionEngine = new PermissionEngine({ newId: nextId(), now: () => 1 });
        permissionEngine.beginTurn('turn-1');
        const runtime = new ToolRuntime({
          sessionId: 'session-1',
          header: { ...header(), workspaceRoot: root, cwd: root, permissionMode: 'bypass' },
          connection: connection(),
          modelId: 'model-1',
          appendMessage: async () => {},
          permissionEngine,
          newId: nextId(),
          now: nextNow(),
          getPermissionPauseTarget: () => null,
          getCurrentRunId: () => 'run-1',
          getCurrentInvocationId: () => 'invocation-1',
          runtimeCommitSink: store,
        });
        const tool = buildBuiltinTools({
          fileMutationCheckpointCarrier: new LocalFileCheckpointCarrier(),
        }).find(({ name }) => name === candidate.toolName);
        assert.ok(tool);

        await runtime.settleToolCall({
          tool,
          turnId: 'turn-1',
          toolCallId: `provider-${candidate.toolName}`,
          input: candidate.args,
          abortSignal: new AbortController().signal,
          eventSink: { push: () => {} },
        });

        const dispatch = (await store.readRuntimeEvents('session-1', 'run-1')).find(
          (event) => event.actions?.toolDispatch,
        );
        assert.equal(dispatch?.actions?.toolDispatch?.recoveryMode, 'reconcile');
      } finally {
        store.close();
        await rm(root, { recursive: true, force: true });
      }
    }
  });

  it('persists one atomic prepared/outcome pair around the real implementation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'maka-tool-sqlite-'));
    const store = createSqliteRuntimeStore(join(root, 'runtime.sqlite'));
    try {
      const permissionEngine = new PermissionEngine({ newId: nextId(), now: () => 1 });
      permissionEngine.beginTurn('turn-1');
      let implementationCalls = 0;
      const runtime = new ToolRuntime({
        sessionId: 'session-1',
        header: header(),
        connection: connection(),
        modelId: 'model-1',
        appendMessage: async () => {},
        permissionEngine,
        newId: nextId(),
        now: nextNow(),
        getPermissionPauseTarget: () => null,
        getCurrentRunId: () => 'run-1',
        getCurrentInvocationId: () => 'invocation-1',
        runtimeCommitSink: store,
      });
      const tool: MakaTool = {
        name: 'Read',
        description: 'read',
        parameters: {},
        permissionRequired: false,
        recoveryMode: 'replay_safe',
        impl: async () => {
          implementationCalls += 1;
          return { ok: true, text: 'contents' };
        },
      };

      const published: SessionEvent[] = [];

      await runtime.settleToolCall({
        tool,
        turnId: 'turn-1',
        toolCallId: 'provider-call-1',
        input: {},
        abortSignal: new AbortController().signal,
        eventSink: { push: (event) => published.push(event) },
      });

      assert.equal(implementationCalls, 1);
      const events = await store.readRuntimeEvents('session-1', 'run-1');
      assert.deepEqual(
        events.map((event) => event.content?.kind),
        ['function_call', undefined, 'function_response'],
      );
      const operationId = events[0]?.refs?.operationId;
      assert.ok(operationId);
      assert.equal((await store.readToolOperation(operationId))?.currentState, 'outcome_committed');
      assert.deepEqual(
        events.map((event) => event.invocationId),
        ['invocation-1', 'invocation-1', 'invocation-1'],
      );
      assert.deepEqual(
        (await store.readToolJournal(operationId)).map((event) => event.state),
        ['prepared', 'outcome_committed'],
      );
      assert.equal((await store.readImmutableRuntimeEvents('session-1', 'run-1')).length, 3);

      const context = invocationContext();
      const memory = createSessionEventMapMemory();
      const durableEvents = published.filter(
        (event) => event.type === 'tool_start' || event.type === 'tool_result',
      );
      assert.equal(durableEvents.length, 2);
      for (const event of durableEvents) {
        const mapped = mapSessionEventToRuntimeEvent(event, context, memory);
        await store.appendRuntimeEvent('session-1', 'run-1', mapped);
      }

      assert.equal((await store.readRuntimeEvents('session-1', 'run-1')).length, 3);
      assert.equal((await store.readImmutableRuntimeEvents('session-1', 'run-1')).length, 3);
    } finally {
      store.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('persists the same normalized error event that the Runtime flow later observes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'maka-tool-sqlite-error-'));
    const store = createSqliteRuntimeStore(join(root, 'runtime.sqlite'));
    try {
      const permissionEngine = new PermissionEngine({ newId: nextId(), now: () => 1 });
      permissionEngine.beginTurn('turn-1');
      const runtime = new ToolRuntime({
        sessionId: 'session-1',
        header: header(),
        connection: connection(),
        modelId: 'model-1',
        appendMessage: async () => {},
        permissionEngine,
        newId: nextId(),
        now: nextNow(),
        getPermissionPauseTarget: () => null,
        getCurrentRunId: () => 'run-1',
        getCurrentInvocationId: () => 'invocation-1',
        runtimeCommitSink: store,
      });
      const published: SessionEvent[] = [];
      const tool: MakaTool = {
        name: 'Read',
        description: 'read',
        parameters: {},
        permissionRequired: false,
        recoveryMode: 'replay_safe',
        impl: async () => {
          throw new Error('disk read failed');
        },
      };

      await runtime.settleToolCall({
        tool,
        turnId: 'turn-1',
        toolCallId: 'provider-call-1',
        input: {},
        abortSignal: new AbortController().signal,
        eventSink: { push: (event) => published.push(event) },
      });

      const memory = createSessionEventMapMemory();
      for (const event of published.filter(
        (item) => item.type === 'tool_start' || item.type === 'tool_result',
      )) {
        await store.appendRuntimeEvent(
          'session-1',
          'run-1',
          mapSessionEventToRuntimeEvent(event, invocationContext(), memory),
        );
      }
      const events = await store.readRuntimeEvents('session-1', 'run-1');
      assert.equal(events.length, 3);
      assert.equal(events[2]?.content?.kind, 'function_response');
      assert.equal(
        events[2]?.content?.kind === 'function_response' ? events[2].content.isError : undefined,
        true,
      );
    } finally {
      store.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});

function header(): SessionHeader {
  return {
    id: 'session-1',
    workspaceRoot: '/workspace/repo',
    cwd: '/workspace/repo',
    createdAt: 1,
    lastUsedAt: 1,
    name: 'test',
    titleIsManual: false,
    isFlagged: false,
    labels: [],
    isArchived: false,
    status: 'active',
    statusUpdatedAt: 1,
    hasUnread: false,
    backend: 'ai-sdk',
    llmConnectionSlug: 'connection-1',
    connectionLocked: true,
    model: 'model-1',
    permissionMode: 'ask',
    schemaVersion: 1,
  };
}

function invocationContext(): InvocationContext {
  return {
    sessionId: 'session-1',
    invocationId: 'invocation-1',
    runId: 'run-1',
    turnId: 'turn-1',
    source: 'test',
    startedAt: 1,
    newId: nextId(),
    now: () => 1,
    request: {
      sessionId: 'session-1',
      invocationId: 'invocation-1',
      runId: 'run-1',
      turnId: 'turn-1',
      text: 'test',
      source: 'test',
    },
  };
}

function connection(): LlmConnection {
  return {
    slug: 'connection-1',
    name: 'test',
    providerType: 'openai',
    defaultModel: 'model-1',
    enabled: true,
    createdAt: 1,
    updatedAt: 1,
  };
}

function nextId(): () => string {
  let value = 0;
  return () => `id-${++value}`;
}

function nextNow(): () => number {
  let value = 0;
  return () => ++value;
}
