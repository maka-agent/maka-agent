import { describe, test } from 'node:test';
import { buildBuiltinTools } from '../builtin-tools.js';
import {
  AGENT_LIST_TOOL_NAME,
  AGENT_OUTPUT_TOOL_NAME,
  AGENT_SPAWN_TOOL_NAME,
  buildChildAgentTools,
  buildSubagentListTool,
  buildSubagentOutputTool,
  buildSubagentSpawnTool,
} from '../subagent-tools.js';
import { expect } from '../test-helpers.js';

describe('subagent tools', () => {
  test('child agent toolset keeps only local non-prompting tools', () => {
    const tools = buildChildAgentTools([
      ...buildBuiltinTools(),
      {
        name: AGENT_SPAWN_TOOL_NAME,
        description: 'spawn',
        parameters: {},
        categoryHint: 'subagent',
        impl: async () => ({}),
      },
      {
        name: 'WebSearch',
        description: 'web',
        parameters: {},
        categoryHint: 'web_read',
        impl: async () => ({}),
      },
    ]);

    expect(tools.map((tool) => tool.name)).toEqual(['Bash', 'Read', 'Glob', 'Grep']);
  });

  test('agent_spawn delegates through the narrow tool context capability', async () => {
    const tool = buildSubagentSpawnTool();
    const abortController = new AbortController();
    const calls: unknown[] = [];

    const result = await tool.impl({
      agent_name: 'Researcher',
      system_prompt: 'Stay read-only.',
      prompt: 'Inspect the runtime tests.',
    }, {
      sessionId: 'session-1',
      turnId: 'parent-turn',
      cwd: '/tmp/cwd',
      toolCallId: 'tool-1',
      abortSignal: abortController.signal,
      emitOutput: () => {},
      spawnChildAgent: async (input) => {
        calls.push(input);
        return {
          agentName: input.spec.name,
          turnId: 'child-turn',
          status: 'completed',
          permissionMode: 'explore',
          summary: 'done',
          artifactIds: [],
        };
      },
    });

    expect(tool.name).toBe(AGENT_SPAWN_TOOL_NAME);
    expect(tool.categoryHint).toBe('subagent');
    expect(tool.permissionRequired).toBe(true);
    expect(calls).toEqual([{
      spec: {
        name: 'Researcher',
        systemPrompt: 'Stay read-only.',
      },
      prompt: 'Inspect the runtime tests.',
    }]);
    expect(result).toEqual({
      kind: 'subagent',
      agentName: 'Researcher',
      turnId: 'child-turn',
      status: 'completed',
      permissionMode: 'explore',
      summary: 'done',
      artifactIds: [],
    });
  });

  test('agent projection tools delegate through read-only context capabilities', async () => {
    const listTool = buildSubagentListTool();
    const outputTool = buildSubagentOutputTool();

    const list = await listTool.impl({}, {
      sessionId: 'session-1',
      turnId: 'parent-turn',
      cwd: '/tmp/cwd',
      toolCallId: 'tool-list',
      abortSignal: new AbortController().signal,
      emitOutput: () => {},
      listChildAgents: async () => ({ agents: [{ runId: 'child-run', turnId: 'child-turn' }] }),
    });
    const output = await outputTool.impl({ run_id: 'child-run' }, {
      sessionId: 'session-1',
      turnId: 'parent-turn',
      cwd: '/tmp/cwd',
      toolCallId: 'tool-output',
      abortSignal: new AbortController().signal,
      emitOutput: () => {},
      readChildAgentOutput: async (input) => ({ requested: input }),
    });

    expect(listTool.name).toBe(AGENT_LIST_TOOL_NAME);
    expect(outputTool.name).toBe(AGENT_OUTPUT_TOOL_NAME);
    expect(listTool.permissionRequired).toBe(false);
    expect(outputTool.permissionRequired).toBe(false);
    expect(list).toEqual({ agents: [{ runId: 'child-run', turnId: 'child-turn' }] });
    expect(output).toEqual({ requested: { runId: 'child-run' } });
  });
});
