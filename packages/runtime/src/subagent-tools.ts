import { z } from 'zod';
import type { ToolResultContent } from '@maka/core';
import type { MakaTool } from './tool-runtime.js';
import {
  LOCAL_READ_AGENT_DEFINITION,
  buildToolsForAgentDefinition,
  requireBuiltinAgentDefinition,
} from './agent-catalog.js';
import type { ToolGroup } from './tool-availability.js';

export const AGENT_SPAWN_TOOL_NAME = 'agent_spawn';
export const AGENT_LIST_TOOL_NAME = 'agent_list';
export const AGENT_OUTPUT_TOOL_NAME = 'agent_output';
export const AGENT_TOOL_GROUP_ID = 'agent';
export const AGENT_TOOL_NAMES = [
  AGENT_SPAWN_TOOL_NAME,
  AGENT_LIST_TOOL_NAME,
  AGENT_OUTPUT_TOOL_NAME,
] as const;
export const CHILD_AGENT_TOOL_NAMES = LOCAL_READ_AGENT_DEFINITION.tools;

type SubagentToolResult = Extract<ToolResultContent, { kind: 'subagent' }>;

export function buildChildAgentTools(tools: readonly MakaTool[]): MakaTool[] {
  return buildToolsForAgentDefinition(tools, LOCAL_READ_AGENT_DEFINITION);
}

export function buildSubagentSpawnTool(): MakaTool<
  {
    agent: string;
    task: string;
  },
  unknown
> {
  return {
    name: AGENT_SPAWN_TOOL_NAME,
    displayName: 'Agent',
    description: 'Run a foreground catalog child agent for a bounded task and return its explicit result.',
    parameters: z.object({
      agent: z.string().min(1).max(80).describe('Built-in agent id, such as "local-read".'),
      task: z.string().min(1).max(60_000).describe('Bounded task for the selected child agent.'),
    }),
    permissionRequired: true,
    categoryHint: 'subagent',
    impl: async (input, ctx) => {
      if (!ctx.spawnChildAgent) {
        throw new Error('spawnChildAgent capability is unavailable in this runtime context');
      }
      const definition = requireBuiltinAgentDefinition(input.agent);
      const result = await ctx.spawnChildAgent({
        spec: {
          id: definition.id,
          name: definition.name,
          systemPrompt: definition.systemPrompt,
        },
        prompt: input.task,
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
    description: 'List available agent catalog definitions and child agent runs for the current session.',
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
    max_events?: number;
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
      max_events: z.number().int().min(1).max(100).optional(),
    }).refine((input) => Number(!!input.run_id) + Number(!!input.turn_id) === 1, {
      message: 'Provide exactly one of run_id or turn_id',
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
        ...(input.max_events !== undefined ? { maxEvents: input.max_events } : {}),
      });
    },
  };
}

export function buildSubagentProjectionTools(): MakaTool[] {
  return [buildSubagentListTool(), buildSubagentOutputTool()];
}

export function buildSubagentToolGroup(): ToolGroup {
  return {
    id: AGENT_TOOL_GROUP_ID,
    label: 'Agent',
    description: 'Spawn and inspect foreground child agents.',
    toolNames: AGENT_TOOL_NAMES,
  };
}
