import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { z } from 'zod';
import type { SessionEvent } from '@maka/core/events';
import type { SessionHeader, StoredMessage } from '@maka/core/session';

import { buildAdditionalPermissionProposal } from '../additional-permissions.js';
import { PermissionEngine } from '../permission-engine.js';
import { ToolRuntime, type MakaTool, type MakaToolContext } from '../tool-runtime.js';

function header(): SessionHeader {
  return {
    id: 'session-1', workspaceRoot: '/tmp', cwd: '/tmp', createdAt: 1, lastUsedAt: 1,
    name: 'Test', isFlagged: false, labels: [], isArchived: false, status: 'active', statusUpdatedAt: 1,
    hasUnread: false, backend: 'ai-sdk', llmConnectionSlug: 'c', connectionLocked: true, model: 'm',
    permissionMode: 'ask', schemaVersion: 1,
  };
}

function harness() {
  let id = 0;
  const events: SessionEvent[] = [];
  const messages: StoredMessage[] = [];
  const permissionEngine = new PermissionEngine({ newId: () => `permission-${++id}`, now: () => 100 });
  const runtime = new ToolRuntime({
    sessionId: 'session-1',
    header: header(),
    connection: { providerType: 'openai', slug: 'c' } as never,
    modelId: 'm',
    appendMessage: async (message) => { messages.push(message); },
    permissionEngine,
    newId: () => `runtime-${++id}`,
    now: () => 100,
    getPermissionPauseTarget: () => null,
  });
  return { runtime, permissionEngine, events, messages };
}

describe('ToolRuntime additional permission orchestration', () => {
  test('parks, grants, consumes, and exposes a one-call grant to the implementation', async () => {
    const h = harness();
    let receivedContext: MakaToolContext['permissionContext'];
    const proposal = buildAdditionalPermissionProposal({
      profile: { network: { enabled: true } },
      normalizedPaths: [],
      justification: 'Access a local test service.',
      toolName: 'Bash',
      args: { command: 'curl http://127.0.0.1:8080' },
      workspaceRoots: ['/tmp/maka'],
    });
    const tool: MakaTool = {
      name: 'Bash',
      description: 'test',
      parameters: z.object({ command: z.string() }),
      permissionRequired: true,
      planAdditionalPermissions: () => ({ kind: 'request', proposal }),
      impl: (_args, context) => {
        receivedContext = context.permissionContext;
        return { ok: true };
      },
    };
    const execute = h.runtime.wrapToolExecute(tool, 'turn-1', { push: (event) => h.events.push(event) });
    const pending = execute(
      { command: 'curl http://127.0.0.1:8080' },
      { toolCallId: 'tool-1', abortSignal: new AbortController().signal },
    );
    await waitFor(() => h.events.some((event) => event.type === 'permission_request'));
    const request = h.events.find((event) => event.type === 'permission_request');
    assert.equal(request?.kind, 'additional_permissions');
    h.permissionEngine.recordResponse('turn-1', { requestId: request!.requestId, decision: 'allow' });
    assert.deepEqual(await pending, { ok: true });
    assert.equal(receivedContext?.additionalGrant?.permissionsHash, proposal.permissionsHash);
    assert.equal(receivedContext?.additionalGrant?.toolUseId, 'tool-1');
  });

  test('denial never invokes the implementation', async () => {
    const h = harness();
    let called = false;
    const proposal = buildAdditionalPermissionProposal({
      profile: { network: { enabled: true } }, normalizedPaths: [], justification: 'network',
      toolName: 'Bash', args: { command: 'curl http://127.0.0.1:8080' }, workspaceRoots: ['/tmp/maka'],
    });
    const tool: MakaTool = {
      name: 'Bash', description: 'test', parameters: z.object({ command: z.string() }), permissionRequired: true,
      planAdditionalPermissions: () => ({ kind: 'request', proposal }),
      impl: () => { called = true; return { ok: true }; },
    };
    const execute = h.runtime.wrapToolExecute(tool, 'turn-1', { push: (event) => h.events.push(event) });
    const pending = execute(
      { command: 'curl http://127.0.0.1:8080' },
      { toolCallId: 'tool-1', abortSignal: new AbortController().signal },
    );
    await waitFor(() => h.events.some((event) => event.type === 'permission_request'));
    const request = h.events.find((event) => event.type === 'permission_request')!;
    h.permissionEngine.recordResponse('turn-1', { requestId: request.requestId, decision: 'deny' });
    assert.deepEqual(await pending, { error: '用户已拒绝权限请求' });
    assert.equal(called, false);
  });
});

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error('Timed out waiting for condition');
}
