import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { LlmConnection, SessionEvent, SessionHeader, StoredMessage } from '@maka/core';
import { PermissionEngine } from '../permission-engine.js';
import type {
  RuntimeCommitSink,
  ToolOutcomeCommit,
  ToolPreparedCommit,
} from '../runtime-commit-sink.js';
import { ToolRuntime, type MakaTool } from '../tool-runtime.js';

describe('ToolRuntime durable boundary', () => {
  it('does not invoke the tool or publish a result when T1 fails', async () => {
    let implementationCalls = 0;
    const harness = makeHarness({
      commitToolPrepared: async () => {
        throw new Error('T1 unavailable');
      },
      commitToolOutcome: async () => {
        throw new Error('must not reach T2');
      },
    });

    await assert.rejects(
      harness.execute(
        tool(() => {
          implementationCalls += 1;
          return { ok: true };
        }),
      ),
      /T1 unavailable/,
    );

    assert.equal(implementationCalls, 0);
    assert.equal(
      harness.events.some((event) => event.type === 'tool_result'),
      false,
    );
    assert.equal(
      harness.messages.some((message) => message.type === 'tool_result'),
      false,
    );
  });

  it('does not invoke a tool when another local dispatcher already owns its operation', async () => {
    let implementationCalls = 0;
    const harness = makeHarness({
      commitToolPrepared: async () => ({ created: false, runtimeEventSeq: 1 }),
      commitToolOutcome: async () => {
        throw new Error('must not reach T2');
      },
    });

    await assert.rejects(
      harness.execute(
        tool(() => {
          implementationCalls += 1;
          return { ok: true };
        }),
      ),
      /already claimed/,
    );

    assert.equal(implementationCalls, 0);
    assert.deepEqual(
      harness.events.map((event) => event.type),
      ['tool_start'],
    );
    assert.deepEqual(
      harness.messages.map((message) => message.type),
      ['tool_call'],
    );
  });

  it('commits T1 before implementation and T2 before publishing the result', async () => {
    const order: string[] = [];
    const prepared: ToolPreparedCommit[] = [];
    const outcomes: ToolOutcomeCommit[] = [];
    const harness = makeHarness(
      {
        commitToolPrepared: async (input) => {
          prepared.push(input);
          order.push('t1');
          return { created: true, runtimeEventSeq: 1 };
        },
        commitToolOutcome: async (input) => {
          outcomes.push(input);
          order.push('t2');
          return { created: true, runtimeEventSeq: 2 };
        },
      },
      order,
    );

    const result = await harness.execute(
      tool(() => {
        order.push('impl');
        return { ok: true, text: 'done' };
      }),
    );

    assert.deepEqual(result, { ok: true, text: 'done' });
    assert.deepEqual(order, ['t1', 'impl', 't2', 'published-result']);
    assert.equal(prepared[0]?.runtimeEvent.content?.kind, 'function_call');
    assert.equal(
      prepared[0]?.dispatchRuntimeEvent.actions?.toolDispatch?.protocol,
      't1_after_preflight_v1',
    );
    assert.equal(prepared[0]?.dispatchRuntimeEvent.content, undefined);
    assert.equal(outcomes[0]?.runtimeEvent.content?.kind, 'function_response');
    assert.equal(prepared[0]?.operationId, outcomes[0]?.operationId);
    assert.equal(prepared[0]?.runtimeEvent.refs?.operationId, prepared[0]?.operationId);
    assert.equal(prepared[0]?.dispatchRuntimeEvent.refs?.operationId, prepared[0]?.operationId);
    assert.equal(outcomes[0]?.runtimeEvent.refs?.operationId, prepared[0]?.operationId);
  });

  it('treats a durable preflight validation failure as not dispatched', async () => {
    let preparedCommits = 0;
    let implementationCalls = 0;
    const harness = makeHarness({
      commitToolPrepared: async () => {
        preparedCommits += 1;
        return { created: true, runtimeEventSeq: 1 };
      },
      commitToolOutcome: async () => {
        throw new Error('must not reach T2');
      },
    });
    const target: MakaTool = {
      ...tool(() => {
        implementationCalls += 1;
        return { ok: true };
      }),
      prepareDurableExecution: async () => {
        throw new Error('old_string not found during preflight');
      },
    };

    await assert.rejects(harness.execute(target), /old_string not found during preflight/);

    assert.equal(preparedCommits, 0);
    assert.equal(implementationCalls, 0);
    assert.deepEqual(
      harness.events.map((event) => event.type),
      ['tool_start'],
    );
    assert.deepEqual(
      harness.messages.map((message) => message.type),
      ['tool_call'],
    );
  });

  it('releases a prepared mutation lease when T1 fails', async () => {
    const order: string[] = [];
    const harness = makeHarness({
      commitToolPrepared: async () => {
        order.push('t1');
        throw new Error('T1 unavailable');
      },
      commitToolOutcome: async () => {
        throw new Error('must not reach T2');
      },
    });
    const target: MakaTool = {
      ...tool(() => {
        order.push('legacy-impl');
        return { ok: true };
      }),
      prepareDurableExecution: async () => {
        order.push('prepare-checkpoint');
        return {
          runtimeFacts: [],
          execute: () => {
            order.push('prepared-execute');
            return { ok: true };
          },
          release: () => {
            order.push('release-lock');
          },
        };
      },
    };

    await assert.rejects(harness.execute(target), /T1 unavailable/);
    assert.deepEqual(order, ['prepare-checkpoint', 't1', 'release-lock']);
  });

  it('commits checkpoint preparation facts before dispatch and executes the prepared mutation', async () => {
    const order: string[] = [];
    const prepared: ToolPreparedCommit[] = [];
    const harness = makeHarness(
      {
        commitToolPrepared: async (input) => {
          prepared.push(input);
          order.push('t1');
          return { created: true, runtimeEventSeq: 3 };
        },
        commitToolOutcome: async () => {
          order.push('t2');
          return { created: true, runtimeEventSeq: 4 };
        },
      },
      order,
    );
    const target: MakaTool = {
      ...tool(() => {
        order.push('legacy-impl');
        return { source: 'legacy' };
      }),
      prepareDurableExecution: async () => {
        order.push('prepare-checkpoint');
        return {
          runtimeFacts: [
            {
              kind: 'maka.file.prepared_mutation',
              version: 1,
              legacyProjection: 'invisible',
              payload: { operationId: 'prepared' },
            },
          ],
          execute: async () => {
            order.push('prepared-execute');
            return { source: 'prepared' };
          },
          release: () => {
            order.push('release-lock');
          },
        };
      },
    };

    assert.deepEqual(await harness.execute(target), { source: 'prepared' });
    assert.deepEqual(order, [
      'prepare-checkpoint',
      't1',
      'prepared-execute',
      't2',
      'published-result',
      'release-lock',
    ]);
    assert.equal(
      prepared[0]?.preparationRuntimeEvents?.[0]?.actions?.runtimeFact?.kind,
      'maka.file.prepared_mutation',
    );
  });

  it('wraps business-domain kind values as canonical JSON tool results', async () => {
    const outcomes: ToolOutcomeCommit[] = [];
    const harness = makeHarness({
      commitToolPrepared: async () => ({ created: true, runtimeEventSeq: 1 }),
      commitToolOutcome: async (input) => {
        outcomes.push(input);
        return { created: true, runtimeEventSeq: 2 };
      },
    });
    const output = {
      kind: 'plan_submitted',
      proposal: { proposalId: 'proposal-1' },
      storeVersion: 1,
    };

    assert.deepEqual(await harness.execute(tool(() => output)), output);
    const response = outcomes[0]?.runtimeEvent.content;
    assert.equal(response?.kind, 'function_response');
    assert.deepEqual(response?.kind === 'function_response' ? response.result : undefined, {
      kind: 'json',
      value: output,
    });
    const message = harness.messages.find((candidate) => candidate.type === 'tool_result');
    assert.deepEqual(message?.type === 'tool_result' ? message.content : undefined, {
      kind: 'json',
      value: output,
    });
  });

  it('does not create a prepared journal operation when permission is denied', async () => {
    let preparedCalls = 0;
    let implementationCalls = 0;
    const harness = makeHarness({
      commitToolPrepared: async () => {
        preparedCalls += 1;
        return { created: true, runtimeEventSeq: 1 };
      },
      commitToolOutcome: async () => {
        throw new Error('must not reach T2');
      },
    });
    const execution = harness.execute({
      ...tool(() => {
        implementationCalls += 1;
        return { ok: true };
      }),
      name: 'Bash',
      permissionRequired: true,
    });
    while (!harness.events.some((event) => event.type === 'permission_request')) {
      await Promise.resolve();
    }
    const request = harness.events.find((event) => event.type === 'permission_request');
    if (!request || request.type !== 'permission_request')
      throw new Error('expected permission request');
    harness.permissionEngine.recordResponse('turn-1', {
      requestId: request.requestId,
      decision: 'deny',
    });

    await execution;

    assert.equal(preparedCalls, 0);
    assert.equal(implementationCalls, 0);
  });

  it('does not publish an implementation result when T2 fails', async () => {
    let implementationCalls = 0;
    const harness = makeHarness({
      commitToolPrepared: async () => ({ created: true, runtimeEventSeq: 1 }),
      commitToolOutcome: async () => {
        throw new Error('T2 unavailable');
      },
    });

    await assert.rejects(
      harness.execute(
        tool(() => {
          implementationCalls += 1;
          return { ok: true };
        }),
      ),
      /T2 unavailable/,
    );

    assert.equal(implementationCalls, 1);
    assert.equal(
      harness.events.some((event) => event.type === 'tool_result'),
      false,
    );
    assert.equal(
      harness.messages.some((message) => message.type === 'tool_result'),
      false,
    );
  });

  it('commits a normalized error outcome before returning a thrown tool failure to the model', async () => {
    const outcomes: ToolOutcomeCommit[] = [];
    const harness = makeHarness({
      commitToolPrepared: async () => ({ created: true, runtimeEventSeq: 1 }),
      commitToolOutcome: async (input) => {
        outcomes.push(input);
        return { created: true, runtimeEventSeq: 2 };
      },
    });

    await harness.execute(
      tool(() => {
        throw new Error('tool exploded');
      }),
    );

    const response = outcomes[0]?.runtimeEvent.content;
    assert.equal(response?.kind, 'function_response');
    assert.equal(response?.kind === 'function_response' && response.isError, true);
    assert.equal(
      harness.events.some((event) => event.type === 'tool_result' && event.isError),
      true,
    );
  });
});

function makeHarness(sink: RuntimeCommitSink, order?: string[]) {
  const messages: StoredMessage[] = [];
  const events: SessionEvent[] = [];
  const permissionEngine = new PermissionEngine({ newId: nextId(), now: () => 1 });
  permissionEngine.beginTurn('turn-1');
  const runtime = new ToolRuntime({
    sessionId: 'session-1',
    header: header(),
    connection: connection(),
    modelId: 'model-1',
    appendMessage: async (message) => {
      messages.push(message);
    },
    permissionEngine,
    newId: nextId(),
    now: nextNow(),
    getPermissionPauseTarget: () => null,
    getCurrentRunId: () => 'run-1',
    runtimeCommitSink: sink,
  });
  return {
    messages,
    events,
    permissionEngine,
    execute: async (target: MakaTool) =>
      (
        await runtime.settleToolCall({
          tool: target,
          turnId: 'turn-1',
          toolCallId: 'provider-call-1',
          input: {},
          abortSignal: new AbortController().signal,
          eventSink: {
            push: (event) => {
              events.push(event);
              if (event.type === 'tool_result') order?.push('published-result');
            },
          },
        })
      ).result,
  };
}

function tool(impl: MakaTool['impl']): MakaTool {
  return {
    name: 'Read',
    description: 'read',
    parameters: {},
    permissionRequired: false,
    recoveryMode: 'replay_safe',
    impl,
  };
}

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
