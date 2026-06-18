import { describe, test } from 'node:test';
import { buildBuiltinTools } from '../builtin-tools.js';
import {
  AGENT_SPAWN_TOOL_NAME,
  buildChildAgentTools,
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
      agentName: 'Researcher',
      turnId: 'child-turn',
      status: 'completed',
      summary: 'done',
      artifactIds: [],
    });
  });
});
