import { z } from 'zod';
import type { MakaTool } from './tool-runtime.js';

export const AGENT_SPAWN_TOOL_NAME = 'agent_spawn';
export const CHILD_AGENT_TOOL_NAMES = ['Bash', 'Read', 'Glob', 'Grep'] as const;

const childAgentToolNameSet = new Set<string>(CHILD_AGENT_TOOL_NAMES);

export function buildChildAgentTools(tools: readonly MakaTool[]): MakaTool[] {
  return tools.filter((tool) => childAgentToolNameSet.has(tool.name));
}

export function buildSubagentSpawnTool(): MakaTool<
  {
    agent_name: string;
    system_prompt: string;
    prompt: string;
  },
  unknown
> {
  return {
    name: AGENT_SPAWN_TOOL_NAME,
    displayName: 'Agent',
    description: 'Run a foreground read-only child agent for a bounded task and return its explicit result.',
    parameters: z.object({
      agent_name: z.string().min(1).max(80).describe('Short display name for the child agent.'),
      system_prompt: z.string().min(1).max(12_000).describe('System prompt for the child agent.'),
      prompt: z.string().min(1).max(60_000).describe('Delegation prompt for the child agent.'),
    }),
    permissionRequired: true,
    categoryHint: 'subagent',
    impl: async (input, ctx) => {
      if (!ctx.spawnChildAgent) {
        throw new Error('spawnChildAgent capability is unavailable in this runtime context');
      }
      return await ctx.spawnChildAgent({
        spec: {
          name: input.agent_name,
          systemPrompt: input.system_prompt,
        },
        prompt: input.prompt,
      });
    },
  };
}
