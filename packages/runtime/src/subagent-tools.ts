import { z } from 'zod';
import type { ToolResultContent } from '@maka/core';
import type { MakaTool } from './tool-runtime.js';

export const AGENT_SPAWN_TOOL_NAME = 'agent_spawn';
export const AGENT_LIST_TOOL_NAME = 'agent_list';
export const AGENT_OUTPUT_TOOL_NAME = 'agent_output';
export const CHILD_AGENT_TOOL_NAMES = ['Bash', 'Read', 'Glob', 'Grep'] as const;

const childAgentToolNameSet = new Set<string>(CHILD_AGENT_TOOL_NAMES);

type SubagentToolResult = Extract<ToolResultContent, { kind: 'subagent' }>;

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
      const result = await ctx.spawnChildAgent({
        spec: {
          name: input.agent_name,
          systemPrompt: input.system_prompt,
        },
        prompt: input.prompt,
      }) as Omit<SubagentToolResult, 'kind'>;
      return {
        kind: 'subagent',
        ...result,
      } satisfies SubagentToolResult;
    },
  };
}

export function buildSubagentListTool(): MakaTool<Record<string, never>, unknown> {
  return {
    name: AGENT_LIST_TOOL_NAME,
    displayName: 'Agent List',
    description: 'List child agent runs for the current session.',
    parameters: z.object({}),
    permissionRequired: false,
    categoryHint: 'read',
    impl: async (_input, ctx) => {
      if (!ctx.listChildAgents) {
        throw new Error('listChildAgents capability is unavailable in this runtime context');
      }
      return await ctx.listChildAgents();
    },
  };
}

export function buildSubagentOutputTool(): MakaTool<
  {
    run_id?: string;
    turn_id?: string;
  },
  unknown
> {
  return {
    name: AGENT_OUTPUT_TOOL_NAME,
    displayName: 'Agent Output',
    description: 'Inspect a child agent run by run_id or turn_id, including runtime events and artifacts.',
    parameters: z.object({
      run_id: z.string().optional(),
      turn_id: z.string().optional(),
    }).refine((input) => !!input.run_id || !!input.turn_id, {
      message: 'Provide run_id or turn_id',
    }),
    permissionRequired: false,
    categoryHint: 'read',
    impl: async (input, ctx) => {
      if (!ctx.readChildAgentOutput) {
        throw new Error('readChildAgentOutput capability is unavailable in this runtime context');
      }
      return await ctx.readChildAgentOutput({
        ...(input.run_id ? { runId: input.run_id } : {}),
        ...(input.turn_id ? { turnId: input.turn_id } : {}),
      });
    },
  };
}

export function buildSubagentProjectionTools(): MakaTool[] {
  return [buildSubagentListTool(), buildSubagentOutputTool()];
}
