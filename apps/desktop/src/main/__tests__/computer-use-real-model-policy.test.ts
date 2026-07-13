import assert from 'node:assert/strict';
import test from 'node:test';
import type { ComputerUseToolSet, MakaTool } from '@maka/runtime';
import {
  applyComputerUseRealModelPolicy,
  parseComputerUseRealModelPolicy,
} from '../computer-use-real-model-policy.js';

function tool(calls: string[]): MakaTool {
  return {
    name: 'maka_computer',
    description: 'test',
    parameters: {},
    impl: async (args) => {
      calls.push((args as { action: string }).action);
      return { text: 'ok' };
    },
  };
}

function toolSet(calls: string[]): ComputerUseToolSet {
  return Object.assign([tool(calls)], {
    clearSession(_sessionId: string) {},
    sessionEvents: {
      snapshot: () => ({ status: 'unobserved' as const, generation: 0 }),
      physicalUserIntervened: () => ({ status: 'intervention_debounce' as const, generation: 1 }),
      interventionDebounceElapsed: () => ({ status: 'reobserve_required' as const, generation: 1 }),
      reobserveRequired: () => ({ status: 'reobserve_required' as const, generation: 1 }),
      screenLocked: () => ({ status: 'screen_locked' as const, generation: 1 }),
      screenUnlocked: () => ({ status: 'reobserve_required' as const, generation: 1 }),
      blockedUrlDetected: () => ({ status: 'blocked_url' as const, generation: 1 }),
      userStopped: () => ({ status: 'user_stopped' as const, generation: 1 }),
      dynamicContentChanged: () => ({ status: 'unobserved' as const, generation: 0 }),
    },
  });
}

test('parses one bounded allowlist and rejects malformed policies', () => {
  assert.deepEqual(parseComputerUseRealModelPolicy(JSON.stringify({
    allowedActions: ['list_apps', 'observe', 'wait'],
    maxTotalActions: 4,
  })), {
    allowedActions: ['list_apps', 'observe', 'wait'],
    maxTotalActions: 4,
  });
  assert.throws(
    () => parseComputerUseRealModelPolicy('{"allowedActions":[],"maxTotalActions":0}'),
    /Invalid Computer Use real-model/,
  );
});

test('blocks disallowed and over-budget actions before dispatch', async () => {
  const calls: string[] = [];
  const [wrapped] = applyComputerUseRealModelPolicy(toolSet(calls), {
    allowedActions: ['observe'],
    maxTotalActions: 2,
  });
  const context = {
    sessionId: 's',
    turnId: 't',
    toolCallId: 'c',
    cwd: '/tmp',
    abortSignal: new AbortController().signal,
    emitOutput() {},
  };

  const allowed = await wrapped.impl({ action: 'observe' } as never, context) as { text: string };
  assert.equal(allowed.text, 'ok');
  const disallowed = await wrapped.impl(
    { action: 'left_click' } as never,
    context,
  ) as { text: string };
  assert.match(
    disallowed.text,
    /unsupported_action_policy/,
  );
  const overBudget = await wrapped.impl(
    { action: 'observe' } as never,
    context,
  ) as { text: string };
  assert.match(
    overBudget.text,
    /total_action_budget_exceeded/,
  );
  assert.deepEqual(calls, ['observe']);
});
