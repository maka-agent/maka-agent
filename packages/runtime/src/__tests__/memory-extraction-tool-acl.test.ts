import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { LlmConnection, SessionEvent, SessionHeader } from '@maka/core';
import { createExternalExecutionBoundary } from '@maka/core';
import { createTestToolRuntime } from './execution-boundary-test-helpers.js';
import {
  MemoryToolProtocolViolationError,
  type MakaTool,
  type ToolRuntime,
} from '../tool-runtime.js';

describe('memory extraction ToolRuntime ACL', () => {
  test('rejects internal memory tools in an ordinary Session before every side effect', async () => {
    const effects = counters();
    const runtime = testRuntime(ordinaryHeader(), undefined, effects);

    await assertProtocolViolation(
      runtime,
      tool('memory_evidence_search', effects),
      'internal_tool_outside_memory_extraction',
    );
    assert.deepEqual(effects, counters());
  });

  test('rejects ordinary and scheduling tools in a memory extraction Session', async () => {
    for (const toolName of ['Read', 'memory_remember', 'memory_extract']) {
      const effects = counters();
      const runtime = testRuntime(internalHeader(), memoryExecution(), effects);

      await assertProtocolViolation(
        runtime,
        tool(toolName, effects),
        'tool_not_allowed_in_memory_extraction',
      );
      assert.deepEqual(effects, counters());
    }
  });

  test('fails closed when the internal Session owner and execution descriptor do not match', async () => {
    const effects = counters();
    const runtime = testRuntime(
      internalHeader(),
      { ...memoryExecution(), operationId: 'other-operation' },
      effects,
    );

    await assertProtocolViolation(
      runtime,
      tool('memory_submit', effects),
      'memory_extraction_identity_mismatch',
    );
    assert.deepEqual(effects, counters());
  });

  test('allows only internal memory tools for a matching extraction identity', async () => {
    for (const toolName of ['memory_evidence_search', 'memory_evidence_read', 'memory_submit']) {
      const effects = counters();
      const runtime = testRuntime(internalHeader(), memoryExecution(), effects);
      const settlement = await settle(runtime, tool(toolName, effects));

      assert.deepEqual(settlement.result, { ok: true });
      assert.equal(effects.impl, 1);
      assert.equal(effects.permissionArgs, 1);
      assert.equal(effects.permission, 1);
      assert.equal(effects.append, 2);
    }
  });
});

interface Effects {
  append: number;
  permission: number;
  permissionArgs: number;
  impl: number;
}

function counters(): Effects {
  return { append: 0, permission: 0, permissionArgs: 0, impl: 0 };
}

function testRuntime(
  header: SessionHeader,
  execution: ReturnType<typeof memoryExecution> | undefined,
  effects: Effects,
): ToolRuntime {
  return createTestToolRuntime({
    sessionId: header.id,
    header,
    getCurrentExecution: () => execution,
    connection: connection(),
    modelId: 'model-1',
    appendMessage: async () => {
      effects.append += 1;
    },
    readExecutionBoundary: async () => {
      effects.permission += 1;
      return createExternalExecutionBoundary();
    },
    newId: (() => {
      let next = 0;
      return () => `id-${++next}`;
    })(),
    now: () => 1,
    getPermissionPauseTarget: () => null,
    runId: 'run-1',
  });
}

function tool(name: string, effects: Effects): MakaTool {
  return {
    name,
    description: name,
    parameters: {},
    permissionArgs: (args) => {
      effects.permissionArgs += 1;
      return args;
    },
    impl: async () => {
      effects.impl += 1;
      return { ok: true };
    },
  };
}

async function assertProtocolViolation(
  runtime: ToolRuntime,
  candidate: MakaTool,
  reason: MemoryToolProtocolViolationError['reason'],
): Promise<void> {
  await assert.rejects(
    () => settle(runtime, candidate),
    (error) => {
      assert.ok(error instanceof MemoryToolProtocolViolationError);
      assert.equal(error.code, 'protocol_violation');
      assert.equal(error.boundary, 'memory_tool_acl');
      assert.equal(error.reason, reason);
      assert.equal(error.toolName, candidate.name);
      return true;
    },
  );
}

async function settle(runtime: ToolRuntime, candidate: MakaTool) {
  return runtime.settleToolCall({
    tool: candidate,
    turnId: 'turn-1',
    toolCallId: `call-${candidate.name}`,
    input: {},
    abortSignal: new AbortController().signal,
    eventSink: {
      push: (_event: SessionEvent) => {},
      pushAndWaitUntilConsumed: async (_event: SessionEvent) => {},
    },
  });
}

function ordinaryHeader(): SessionHeader {
  return baseHeader();
}

function internalHeader(): SessionHeader {
  return {
    ...baseHeader(),
    internalOwner: {
      kind: 'memory_extraction',
      operationId: 'operation-1',
      parentSessionId: 'parent-session',
    },
  };
}

function baseHeader(): SessionHeader {
  return {
    id: 'session-1',
    workspaceRoot: '/tmp',
    cwd: '/tmp',
    createdAt: 1,
    lastUsedAt: 1,
    name: 'Test',
    titleIsManual: true,
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
    permissionMode: 'explore',
    schemaVersion: 1,
  };
}

function memoryExecution() {
  return {
    kind: 'memory_extraction_child' as const,
    operationId: 'operation-1',
    attemptId: 'attempt-1',
  };
}

function connection(): LlmConnection {
  return {
    slug: 'connection-1',
    name: 'Connection',
    providerType: 'openai',
    defaultModel: 'model-1',
    enabled: true,
    createdAt: 1,
    updatedAt: 1,
  };
}
