import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { GoalManager } from '../goal-state.js';
import {
  buildGoalTools,
  GOAL_SET_TOOL_NAME,
  GOAL_CLEAR_TOOL_NAME,
  GOAL_STATUS_TOOL_NAME,
  GOAL_PAUSE_TOOL_NAME,
  GOAL_RESUME_TOOL_NAME,
} from '../goal-tools.js';
import type { MakaTool, MakaToolContext } from '../tool-runtime.js';

const SESSION = 'sess-1';

function ctx(): MakaToolContext {
  return { sessionId: SESSION, turnId: 't', cwd: '/', toolCallId: 'tc', abortSignal: new AbortController().signal, emitOutput: () => {} };
}

function findTool(tools: MakaTool[], name: string): MakaTool {
  const t = tools.find(x => x.name === name);
  assert.ok(t, `tool ${name} exists`);
  return t!;
}

function makeTools(getTokenCount?: (s: string) => number) {
  const mgr = new GoalManager({ generateId: () => 'g-1', now: () => 5000 });
  const tools = buildGoalTools({ goalManager: mgr, getTokenCount, now: () => 5000 });
  return { mgr, tools };
}

describe('goal tools', () => {
  test('exposes 5 tools', () => {
    const { tools } = makeTools();
    const names = tools.map(t => t.name).sort();
    assert.deepEqual(names, [
      GOAL_CLEAR_TOOL_NAME, GOAL_PAUSE_TOOL_NAME, GOAL_RESUME_TOOL_NAME,
      GOAL_SET_TOOL_NAME, GOAL_STATUS_TOOL_NAME,
    ].sort());
  });

  test('all tools are permission-free', () => {
    const { tools } = makeTools();
    for (const t of tools) assert.equal(t.permissionRequired, false);
  });

  test('GoalSet creates a goal with custom limits', async () => {
    const { mgr, tools } = makeTools();
    const set = findTool(tools, GOAL_SET_TOOL_NAME);
    const out = await set.impl({ condition: 'all tests pass', max_iterations: 10, block_cap: 3, token_budget: 5000 }, ctx()) as string;
    assert.ok(out.includes('Goal set'));
    assert.ok(out.includes('all tests pass'));
    assert.ok(out.includes('max 10 turns'));
    assert.ok(out.includes('budget 5000'));
    const g = mgr.get(SESSION)!;
    assert.equal(g.maxIterations, 10);
    assert.equal(g.blockCap, 3);
    assert.equal(g.tokenBudget, 5000);
  });

  test('GoalSet captures the token baseline', async () => {
    const { mgr, tools } = makeTools(() => 1234);
    const set = findTool(tools, GOAL_SET_TOOL_NAME);
    await set.impl({ condition: 'x' }, ctx());
    assert.equal(mgr.get(SESSION)?.tokensAtStart, 1234);
  });

  test('GoalPause / GoalResume lifecycle', async () => {
    const { mgr, tools } = makeTools();
    await findTool(tools, GOAL_SET_TOOL_NAME).impl({ condition: 'x' }, ctx());

    const pauseOut = await findTool(tools, GOAL_PAUSE_TOOL_NAME).impl({}, ctx()) as string;
    assert.ok(pauseOut.includes('paused'));
    assert.equal(mgr.get(SESSION)?.status, 'paused');

    const resumeOut = await findTool(tools, GOAL_RESUME_TOOL_NAME).impl({}, ctx()) as string;
    assert.ok(resumeOut.includes('resumed'));
    assert.equal(mgr.get(SESSION)?.status, 'active');
  });

  test('GoalPause with no goal', async () => {
    const { tools } = makeTools();
    const out = await findTool(tools, GOAL_PAUSE_TOOL_NAME).impl({}, ctx()) as string;
    assert.ok(out.includes('No active goal'));
  });

  test('GoalResume with no paused goal', async () => {
    const { tools } = makeTools();
    await findTool(tools, GOAL_SET_TOOL_NAME).impl({ condition: 'x' }, ctx());
    const out = await findTool(tools, GOAL_RESUME_TOOL_NAME).impl({}, ctx()) as string;
    assert.ok(out.includes('No paused goal'));
  });

  test('GoalClear', async () => {
    const { mgr, tools } = makeTools();
    await findTool(tools, GOAL_SET_TOOL_NAME).impl({ condition: 'x' }, ctx());
    const out = await findTool(tools, GOAL_CLEAR_TOOL_NAME).impl({}, ctx()) as string;
    assert.ok(out.includes('cleared'));
    assert.equal(mgr.get(SESSION)?.status, 'cleared');
  });

  test('GoalStatus shows full lifecycle detail', async () => {
    const { mgr, tools } = makeTools();
    await findTool(tools, GOAL_SET_TOOL_NAME).impl({ condition: 'deploy', token_budget: 5000 }, ctx());
    mgr.recordTokens(SESSION, 1000); // establishes baseline at 1000
    mgr.recordTokens(SESSION, 2500); // spent 1500 since baseline
    const out = await findTool(tools, GOAL_STATUS_TOOL_NAME).impl({}, ctx()) as string;
    assert.ok(out.includes('deploy'));
    assert.ok(out.includes('Status: active'));
    assert.ok(out.includes('No-progress streak: 0/8'));
    assert.ok(out.includes('Tokens: 1500/5000'));
  });

  test('GoalStatus with no goal', async () => {
    const { tools } = makeTools();
    const out = await findTool(tools, GOAL_STATUS_TOOL_NAME).impl({}, ctx()) as string;
    assert.ok(out.includes('No goal set'));
  });
});
