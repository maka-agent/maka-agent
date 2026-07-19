import { z } from 'zod';
import {
  TASK_ID_MAX_CHARS,
  isSafeTaskId,
  type TaskLedgerStore,
  type ToolResultContent,
} from '@maka/core';
import type { SessionEvent } from '@maka/core/events';
import type { MakaTool, MakaToolContext } from './tool-runtime.js';
import {
  AGENT_WORKSPACE_SAME_WORKSPACE,
  AGENT_WORKSPACE_WORKTREE,
  AGENT_WRITE_BACK_PATCH,
  AGENT_WRITE_BACK_SUMMARY,
  BUILTIN_AGENT_DEFINITIONS,
  BUILTIN_AGENT_PROFILES,
  buildToolsForAgentDefinition,
  requireBuiltinAgentDefinitionByProfile,
} from './agent-catalog.js';
import type { ToolGroup } from './tool-availability.js';
import { AGENT_TEAM_CHILD_TOOL_NAMES } from './agent-team-tool-names.js';
import { AGENT_SWARM_TOOL_NAME, buildAgentSwarmTool } from './agent-swarm-tools.js';

export const AGENT_SPAWN_TOOL_NAME = 'agent_spawn';
export const AGENT_LIST_TOOL_NAME = 'agent_list';
export const AGENT_OUTPUT_TOOL_NAME = 'agent_output';
export const AGENT_TOOL_GROUP_ID = 'agent';
export const AGENT_TOOL_NAMES = [
  AGENT_SPAWN_TOOL_NAME,
  AGENT_SWARM_TOOL_NAME,
  AGENT_LIST_TOOL_NAME,
  AGENT_OUTPUT_TOOL_NAME,
] as const;
export const CHILD_AGENT_TOOL_NAMES = [
  ...new Set(
    BUILTIN_AGENT_DEFINITIONS.filter(
      (definition) => definition.contract.workspace === AGENT_WORKSPACE_SAME_WORKSPACE,
    ).flatMap((definition) => definition.tools),
  ),
] as readonly string[];
const AGENT_SPAWN_WRITE_BACK_MODES = [AGENT_WRITE_BACK_SUMMARY, AGENT_WRITE_BACK_PATCH] as const;
const AGENT_SPAWN_ISOLATION_MODES = [
  AGENT_WORKSPACE_SAME_WORKSPACE,
  AGENT_WORKSPACE_WORKTREE,
] as const;
const CHILD_PROGRESS_MAX_EVENTS = 64;
const CHILD_PROGRESS_MAX_CHARS = 8_192;
const CHILD_PROGRESS_ERROR_MAX_CHARS = 1_000;

type SubagentToolResult = Extract<ToolResultContent, { kind: 'subagent' }>;

export function buildChildAgentTools(tools: readonly MakaTool[]): MakaTool[] {
  const seen = new Set<string>();
  const out: MakaTool[] = [];
  for (const definition of BUILTIN_AGENT_DEFINITIONS) {
    if (definition.contract.workspace !== AGENT_WORKSPACE_SAME_WORKSPACE) continue;
    for (const tool of buildToolsForAgentDefinition(tools, definition)) {
      if (seen.has(tool.name)) continue;
      seen.add(tool.name);
      out.push(tool);
    }
  }
  for (const name of AGENT_TEAM_CHILD_TOOL_NAMES) {
    const tool = tools.find((candidate) => candidate.name === name);
    if (!tool || seen.has(name)) continue;
    seen.add(name);
    out.push(tool);
  }
  return out;
}

export function buildSubagentSpawnTool(deps: { taskLedger?: TaskLedgerStore } = {}): MakaTool<
  {
    profile: string;
    task: string;
    write_back?: string;
    isolation?: string;
    task_id?: string;
  },
  unknown
> {
  return {
    name: AGENT_SPAWN_TOOL_NAME,
    displayName: 'Agent',
    description:
      'Run a foreground catalog child agent for a bounded task and return its explicit result.',
    parameters: z
      .object({
        profile: z.enum(BUILTIN_AGENT_PROFILES).describe('Child agent profile.'),
        task: z.string().min(1).max(60_000).describe('Bounded task for the selected child agent.'),
        write_back: z
          .enum(AGENT_SPAWN_WRITE_BACK_MODES)
          .optional()
          .describe(
            'Requested child write-back mode. Each built-in profile declares its supported modes.',
          ),
        isolation: z
          .enum(AGENT_SPAWN_ISOLATION_MODES)
          .optional()
          .describe(
            'Requested child workspace isolation. Worktree profiles fail closed until a worktree child executor is available.',
          ),
        task_id: z
          .string()
          .min(1)
          .max(TASK_ID_MAX_CHARS)
          .refine(isSafeTaskId)
          .optional()
          .describe('Existing task UUID or short key to bind to this child run.'),
      })
      .superRefine((input, ctx) => {
        const definition = requireBuiltinAgentDefinitionByProfile(input.profile);
        const requestedWriteBack = input.write_back ?? definition.contract.defaultWriteBack;
        if (!definition.contract.supportedWriteBack.some((mode) => mode === requestedWriteBack)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['write_back'],
            message: `Agent profile "${definition.profile}" does not support write_back "${requestedWriteBack}".`,
          });
        }
        const requestedIsolation = input.isolation ?? definition.contract.workspace;
        if (requestedIsolation !== definition.contract.workspace) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['isolation'],
            message: `Agent profile "${definition.profile}" requires isolation "${definition.contract.workspace}", not "${requestedIsolation}".`,
          });
        }
      }),
    permissionRequired: true,
    categoryHint: 'subagent',
    impl: async (input, ctx) => {
      const definition = requireBuiltinAgentDefinitionByProfile(input.profile);
      const requestedWriteBack = input.write_back ?? definition.contract.defaultWriteBack;
      if (!definition.contract.supportedWriteBack.some((mode) => mode === requestedWriteBack)) {
        throw new Error(
          `Agent profile "${definition.profile}" does not support write_back "${requestedWriteBack}".`,
        );
      }
      const requestedIsolation = input.isolation ?? definition.contract.workspace;
      if (requestedIsolation !== definition.contract.workspace) {
        throw new Error(
          `Agent profile "${definition.profile}" requires isolation "${definition.contract.workspace}", not "${requestedIsolation}".`,
        );
      }
      if (requestedIsolation !== AGENT_WORKSPACE_SAME_WORKSPACE) {
        throw new Error(
          `Agent profile "${definition.profile}" requires "${requestedIsolation}" workspace isolation, but this runtime does not provide a worktree child executor yet.`,
        );
      }
      if (!ctx.spawnChildAgent) {
        throw new Error('spawnChildAgent capability is unavailable in this runtime context');
      }
      const boundTask = input.task_id
        ? await deps.taskLedger?.get(ctx.sessionId, input.task_id)
        : undefined;
      if (input.task_id && !deps.taskLedger)
        throw new Error('Task binding is unavailable in this runtime');
      if (input.task_id && !boundTask)
        throw new Error(`No such task in this session: ${input.task_id}`);
      let claimedOwner: { actor: 'child_agent'; agentId: string; turnId: string } | undefined;
      let result: Omit<SubagentToolResult, 'kind'>;
      const progress = new ChildAgentProgressProjector(ctx);
      ctx.emitOutput('stdout', `Starting child agent: ${definition.name}\n`);
      try {
        result = (await ctx.spawnChildAgent({
          spec: {
            id: definition.id,
            name: definition.name,
            systemPrompt: definition.systemPrompt,
          },
          prompt: input.task,
          ...(boundTask
            ? {
                onReady: async ({ turnId, agentId }) => {
                  const owner = { actor: 'child_agent' as const, agentId, turnId };
                  await deps.taskLedger!.claim(ctx.sessionId, boundTask.id, owner, {
                    runId: ctx.runId,
                    turnId: ctx.turnId,
                    toolCallId: ctx.toolCallId,
                    source: 'system',
                    actor: 'main_agent',
                    reason: `assigned to child agent ${agentId}`,
                  });
                  claimedOwner = owner;
                },
              }
            : {}),
          onEvent: (event) => progress.observe(event),
        })) as Omit<SubagentToolResult, 'kind'>;
      } catch (error) {
        ctx.emitOutput(
          'stderr',
          `Child agent ${definition.name} failed: ${boundedChildError(error)}\n`,
        );
        if (boundTask && claimedOwner) {
          await deps.taskLedger!.settleAgentOutcome(
            ctx.sessionId,
            boundTask.id,
            {
              status: 'failed',
              owner: claimedOwner,
              reason:
                error instanceof Error
                  ? error.message
                  : 'Child agent failed before returning a result',
            },
            {
              turnId: claimedOwner.turnId,
              toolCallId: ctx.toolCallId,
              source: 'system',
              actor: 'child_agent',
            },
          );
        }
        throw error;
      }
      ctx.emitOutput('stdout', `Child agent ${definition.name}: ${result.status}\n`);
      if (boundTask && claimedOwner) {
        const owner = {
          ...claimedOwner,
          ...(result.runId ? { runId: result.runId } : {}),
          turnId: result.turnId,
        };
        await deps.taskLedger!.settleAgentOutcome(
          ctx.sessionId,
          boundTask.id,
          {
            status: result.status,
            owner,
            reason: result.failureClass ?? result.summary,
          },
          {
            runId: result.runId,
            turnId: result.turnId,
            toolCallId: ctx.toolCallId,
            source: 'system',
            actor: 'child_agent',
          },
        );
      }
      return {
        kind: 'subagent',
        ...result,
      } satisfies SubagentToolResult;
    },
  };
}

class ChildAgentProgressProjector {
  private readonly tools = new Map<string, string>();
  private projectedEvents = 0;
  private projectedChars = 0;

  constructor(private readonly ctx: Pick<MakaToolContext, 'emitOutput'>) {}

  observe(event: SessionEvent): void {
    if (this.projectedEvents >= CHILD_PROGRESS_MAX_EVENTS) return;
    if (event.type === 'tool_start') {
      const name = event.displayName ?? event.toolName;
      this.tools.set(event.toolUseId, name);
      this.emit('stdout', `Child tool started: ${name}\n`);
      return;
    }
    if (event.type === 'tool_result') {
      const name = this.tools.get(event.toolUseId) ?? 'tool';
      this.tools.delete(event.toolUseId);
      this.emit(
        event.isError ? 'stderr' : 'stdout',
        `Child tool ${event.isError ? 'failed' : 'finished'}: ${name}\n`,
      );
    }
  }

  private emit(stream: 'stdout' | 'stderr', chunk: string): void {
    const remaining = CHILD_PROGRESS_MAX_CHARS - this.projectedChars;
    if (remaining <= 0) return;
    const bounded = chunk.slice(0, remaining);
    this.projectedEvents += 1;
    this.projectedChars += bounded.length;
    this.ctx.emitOutput(stream, bounded);
  }
}

function boundedChildError(error: unknown): string {
  const message = error instanceof Error ? error.message : 'unknown error';
  return message.length <= CHILD_PROGRESS_ERROR_MAX_CHARS
    ? message
    : `${message.slice(0, CHILD_PROGRESS_ERROR_MAX_CHARS - 1)}…`;
}

export function buildSubagentListTool(): MakaTool<Record<string, never>, unknown> {
  return {
    name: AGENT_LIST_TOOL_NAME,
    displayName: 'Agent List',
    description:
      'List available agent catalog definitions and child agent runs for the current session.',
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
    description:
      'Inspect a child agent run by run_id or turn_id, including runtime events and artifacts.',
    parameters: z
      .object({
        run_id: z.string().optional(),
        turn_id: z.string().optional(),
        max_events: z.number().int().min(1).max(100).optional(),
      })
      .refine((input) => Number(!!input.run_id) + Number(!!input.turn_id) === 1, {
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

export function buildParentAgentTools(deps: { taskLedger?: TaskLedgerStore } = {}): MakaTool[] {
  return [buildSubagentSpawnTool(deps), buildAgentSwarmTool(), ...buildSubagentProjectionTools()];
}

export function buildSubagentToolGroup(): ToolGroup {
  return {
    id: AGENT_TOOL_GROUP_ID,
    label: 'Agent',
    description: 'Spawn, fan out, and inspect foreground child agents.',
    toolNames: AGENT_TOOL_NAMES,
  };
}
