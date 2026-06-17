import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { z } from 'zod';
import type { SessionEvent } from '@maka/core/events';
import type { SessionHeader } from '@maka/core/session';
import type { StoredMessage } from '@maka/core/session';

import {
  ToolRuntime,
  formatDeferredNotLoadedText,
  type MakaTool,
} from '../tool-runtime.js';
import { PermissionEngine } from '../permission-engine.js';

// The execute-boundary guard (Layer 1, Slice 5) rejects a deferred tool whose
// name is absent from the current step's active snapshot — before permission
// eval and before the real impl. These tests drive ToolRuntime directly so the
// rejection path resolves synchronously (no streaming, no parking).

function header(): SessionHeader {
  return {
    id: 'session-1',
    workspaceRoot: '/tmp/maka',
    cwd: '/tmp/maka',
    createdAt: 1,
    lastUsedAt: 1,
    name: 'Test',
    isFlagged: false,
    labels: [],
    isArchived: false,
    status: 'active',
    statusUpdatedAt: 1,
    hasUnread: false,
    backend: 'ai-sdk',
    llmConnectionSlug: 'c',
    connectionLocked: true,
    model: 'm',
    permissionMode: 'ask',
    schemaVersion: 1,
  };
}

interface Harness {
  runtime: ToolRuntime;
  appended: StoredMessage[];
  pushed: SessionEvent[];
  evaluateCalls: string[];
}

function makeHarness(): Harness {
  const appended: StoredMessage[] = [];
  const pushed: SessionEvent[] = [];
  const evaluateCalls: string[] = [];
  const engine = new PermissionEngine({ newId: () => 'perm', now: () => 1 });
  const realEvaluate = engine.evaluate.bind(engine);
  // Spy: record whether the guard let execution reach permission evaluation.
  engine.evaluate = ((input: Parameters<typeof realEvaluate>[0]) => {
    evaluateCalls.push(input.toolName);
    return realEvaluate(input);
  }) as typeof engine.evaluate;
  let n = 0;
  const runtime = new ToolRuntime({
    sessionId: 'session-1',
    header: header(),
    connection: { providerType: 'openai', slug: 'c' } as never,
    modelId: 'm',
    appendMessage: async (m) => { appended.push(m); },
    permissionEngine: engine,
    newId: () => `id-${++n}`,
    now: () => 1,
    getPermissionPauseTarget: () => null,
  });
  return { runtime, appended, pushed, evaluateCalls };
}

function deferredTool(name: string, implCalls: string[]): MakaTool {
  return {
    name,
    description: name,
    parameters: z.object({}),
    exposure: 'deferred',
    impl: () => { implCalls.push(name); return { ok: true }; },
  };
}

function run(h: Harness, tool: MakaTool) {
  const exec = h.runtime.wrapToolExecute(tool, 'turn-1', { push: (e) => h.pushed.push(e) });
  return exec({}, { toolCallId: 'tc1', abortSignal: new AbortController().signal });
}

describe('deferred execute-boundary guard (Slice 5)', () => {
  test('rejects a deferred tool absent from the step snapshot — no impl, no permission eval', async () => {
    const h = makeHarness();
    const implCalls: string[] = [];
    // The same-step trap: browser was just requested via load_tool but is not
    // yet active this step, so browser_click must be rejected.
    h.runtime.setStepActivation(() => new Set(['Read', 'load_tool']));

    const result = await run(h, deferredTool('browser_click', implCalls));

    assert.deepEqual(implCalls, [], 'the real impl must not run');
    assert.deepEqual(h.evaluateCalls, [], 'permission must not be evaluated for a rejected deferred call');
    assert.deepEqual(result, { error: formatDeferredNotLoadedText('browser_click') });

    const callMsg = h.appended.find((m) => m.type === 'tool_call');
    const resultMsg = h.appended.find((m) => m.type === 'tool_result');
    assert.ok(callMsg, 'a ToolCallMessage is still written (call/result pairing intact)');
    assert.ok(resultMsg && resultMsg.isError, 'a synthetic error ToolResult is written');
    assert.ok(
      h.pushed.some((e) => e.type === 'tool_result' && e.isError && e.toolUseId === 'tc1'),
      'an error tool_result event is emitted to the renderer',
    );
    assert.ok(
      !h.pushed.some((e) => e.type === 'permission_request'),
      'no permission prompt is emitted',
    );
  });

  test('lets a deferred tool run once its name is in the step snapshot', async () => {
    const h = makeHarness();
    const implCalls: string[] = [];
    h.runtime.setStepActivation(() => new Set(['Read', 'load_tool', 'browser_click']));

    const tool = deferredTool('browser_click', implCalls);
    tool.permissionRequired = false;
    await run(h, tool);

    assert.deepEqual(implCalls, ['browser_click'], 'an active deferred tool executes normally');
    assert.ok(
      !h.pushed.some((e) => e.type === 'tool_result' && e.isError),
      'no synthetic error result for an active tool',
    );
  });

  test('is inert when no step activation is installed (deferred loading off)', async () => {
    const h = makeHarness();
    const implCalls: string[] = [];
    // No setStepActivation call: a deferred tool must execute as before.
    const tool = deferredTool('browser_click', implCalls);
    tool.permissionRequired = false;
    await run(h, tool);

    assert.deepEqual(implCalls, ['browser_click'], 'guard must not fire without an installed snapshot');
  });

  test('never gates a direct tool (always present in the snapshot)', async () => {
    const h = makeHarness();
    const implCalls: string[] = [];
    h.runtime.setStepActivation(() => new Set(['Read']));
    const direct: MakaTool = {
      name: 'Read',
      description: 'Read',
      parameters: z.object({}),
      permissionRequired: false,
      impl: () => { implCalls.push('Read'); return { ok: true }; },
    };
    await run(h, direct);
    assert.deepEqual(implCalls, ['Read']);
  });
});
