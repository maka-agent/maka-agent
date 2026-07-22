import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { LlmConnection, SessionEvent, SessionHeader } from '@maka/core';

import { PermissionEngine } from '../permission-engine.js';
import { ToolRuntime, type MakaTool } from '../tool-runtime.js';

interface InvocationArgs {
  path: string;
  content: string;
}

describe('ToolRuntime argument ownership', () => {
  test('snapshots embedded provider args independently from execution and public review owners', async () => {
    const initialArgs: InvocationArgs = {
      path: 'notes.md',
      content: 'approved',
    };
    const providerArgs = structuredClone(initialArgs);
    const executionOwners = new Map<string, InvocationArgs>();
    const privateOwners = new Map<string, InvocationArgs>();
    const publicOwners = new Map<string, unknown>();
    const permissionEngine = new PermissionEngine({ newId: nextId(), now: () => 1 });
    permissionEngine.beginTurn('turn-1');

    let resolvePermission!: (event: Extract<SessionEvent, { type: 'permission_request' }>) => void;
    const permissionRequested = new Promise<Extract<SessionEvent, { type: 'permission_request' }>>(
      (resolve) => {
        resolvePermission = resolve;
      },
    );
    const runtime = new ToolRuntime({
      execution: { kind: 'embedded', getCurrentRunId: () => undefined },
      sessionId: 'session-1',
      header: testHeader(),
      connection: testConnection(),
      modelId: 'test-model',
      appendMessage: async (message) => {
        if (message.type !== 'tool_call') return;
        publicOwners.set('storage', structuredClone(message.review));
        observeAndMutate(privateOwners, 'storage', message.args);
      },
      permissionEngine,
      newId: nextId(),
      now: () => 1,
      getPermissionPauseTarget: () => null,
      recordToolArtifacts: (input) => {
        observeAndMutate(executionOwners, 'artifact', input.args);
      },
    });
    const tool: MakaTool<InvocationArgs> = {
      name: 'Write',
      description: 'Write a file',
      parameters: {},
      prepareIntentArgs: (args) => {
        observeAndMutate(executionOwners, 'producer', args);
        return structuredClone(initialArgs);
      },
      sandbox: ({ args }) => {
        observeAndMutate(executionOwners, 'sandbox', args);
        return { platformSandboxAvailable: false };
      },
      impl: async (args) => {
        observeAndMutate(executionOwners, 'implementation', args);
        return { ok: true, path: '/tmp/maka/notes.md' };
      },
    };
    const execute = runtime.wrapToolExecute(tool, 'turn-1', {
      push: (event) => {
        if (event.type === 'tool_start') {
          publicOwners.set('event', structuredClone(event.review));
          observeAndMutate(privateOwners, 'event', event.args);
        } else if (event.type === 'permission_request' && event.kind === 'tool_permission') {
          publicOwners.set('permission', structuredClone(event.review));
          resolvePermission(event);
        }
      },
    });

    const pending = execute(providerArgs, {
      toolCallId: 'tool-1',
      abortSignal: new AbortController().signal,
    });
    mutateArgs(providerArgs, 'provider');
    const request = await permissionRequested;
    permissionEngine.recordResponse('turn-1', {
      requestId: request.requestId,
      decision: 'allow',
    });

    await pending;
    permissionEngine.endTurn('turn-1');

    for (const owner of ['producer', 'sandbox', 'implementation', 'artifact']) {
      assert.deepEqual(executionOwners.get(owner), initialArgs);
    }
    for (const owner of ['storage', 'event']) {
      assert.deepEqual(privateOwners.get(owner), initialArgs);
    }
    const expectedReview = {
      kind: 'path',
      operation: 'write',
      path: 'notes.md',
      cwd: '/tmp/maka',
    };
    for (const owner of ['storage', 'event', 'permission']) {
      assert.deepEqual(publicOwners.get(owner), expectedReview);
    }
    assert.equal(providerArgs.content, 'provider');
  });
});

function observeAndMutate(
  observed: Map<string, InvocationArgs>,
  owner: string,
  value: unknown,
): void {
  observed.set(owner, structuredClone(value) as InvocationArgs);
  mutateArgs(value, owner);
}

function mutateArgs(value: unknown, owner: string): void {
  const mutable = value as InvocationArgs;
  mutable.content = owner;
}

function testHeader(): SessionHeader {
  return {
    id: 'session-1',
    workspaceRoot: '/tmp/maka',
    cwd: '/tmp/maka',
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
    llmConnectionSlug: 'test',
    connectionLocked: true,
    model: 'test-model',
    permissionMode: 'ask',
    schemaVersion: 1,
  };
}

function testConnection(): LlmConnection {
  return {
    slug: 'test',
    name: 'Test',
    providerType: 'anthropic',
    defaultModel: 'test-model',
    enabled: true,
    createdAt: 1,
    updatedAt: 1,
  };
}

function nextId(): () => string {
  let id = 0;
  return () => `id-${++id}`;
}
