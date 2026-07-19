import { redactSecrets } from '@maka/core/redaction';
import {
  TASK_ID_MAX_CHARS,
  isSafeTaskId,
  projectAgentSwarmResult,
  type ToolResultContent,
} from '@maka/core';
import { z } from 'zod';
import {
  AGENT_WORKSPACE_SAME_WORKSPACE,
  AGENT_WORKSPACE_WORKTREE,
  AGENT_WRITE_BACK_PATCH,
  AGENT_WRITE_BACK_SUMMARY,
  BUILTIN_AGENT_PROFILES,
  requireBuiltinAgentDefinitionByProfile,
  type AgentDefinition,
} from './agent-catalog.js';
import { runBoundedSwarm, type SwarmItemResult } from './bounded-swarm.js';
import type { SpawnChildAgentResult } from './session-manager.js';
import type { MakaTool, MakaToolContext } from './tool-runtime.js';

export const AGENT_SWARM_TOOL_NAME = 'agent_swarm';
export const AGENT_SWARM_DEFAULT_CONCURRENCY = 3;
export const AGENT_SWARM_MAX_CONCURRENCY = 5;
export const AGENT_SWARM_MAX_ITEMS = 32;

const AGENT_SWARM_WRITE_BACK_MODES = [AGENT_WRITE_BACK_SUMMARY, AGENT_WRITE_BACK_PATCH] as const;
const AGENT_SWARM_ISOLATION_MODES = [
  AGENT_WORKSPACE_SAME_WORKSPACE,
  AGENT_WORKSPACE_WORKTREE,
] as const;
const AGENT_SWARM_TASK_MAX_CHARS = 60_000;
const AGENT_SWARM_ERROR_MAX_CHARS = 1_000;

export interface AgentSwarmToolInput {
  items: Array<{
    item_id: string;
    profile: string;
    task: string;
    write_back?: string;
    isolation?: string;
  }>;
  max_concurrency?: number;
}

export type AgentSwarmToolResult = Extract<ToolResultContent, { kind: 'agent_swarm' }>;

interface PreparedAgentSwarmItem {
  readonly index: number;
  readonly itemId: string;
  readonly profile: string;
  readonly task: string;
  readonly definition: AgentDefinition;
}

interface StartedChildRef {
  readonly turnId: string;
  readonly agentId: string;
  readonly agentName: string;
}

export function buildAgentSwarmTool(
  deps: { now?: () => number } = {},
): MakaTool<AgentSwarmToolInput, AgentSwarmToolResult> {
  const now = deps.now ?? Date.now;
  return {
    name: AGENT_SWARM_TOOL_NAME,
    displayName: 'Agent Swarm',
    description: [
      'Run the same kind of bounded foreground child work over several independent items.',
      'Use this only when every item can run independently. Results return in input order; you remain responsible for semantic synthesis.',
    ].join(' '),
    parameters: agentSwarmInputSchema(),
    permissionRequired: true,
    categoryHint: 'subagent',
    impl: async (input, ctx) => {
      const prepared = preflightAgentSwarmInput(input);
      if (!ctx.spawnChildAgent) {
        throw new Error('spawnChildAgent capability is unavailable in this runtime context');
      }

      const startedAt = now();
      traceAgentSwarm(ctx, 'tool_started', 'batch_started', {
        itemCount: prepared.items.length,
        maxConcurrency: prepared.maxConcurrency,
      });
      for (
        let index = Math.min(prepared.maxConcurrency, prepared.items.length);
        index < prepared.items.length;
        index += 1
      ) {
        const item = prepared.items[index]!;
        traceAgentSwarm(ctx, 'tool_started', 'item_queued', {
          itemId: item.itemId,
          index: item.index,
          profile: item.profile,
          boundary: 'local_swarm_concurrency',
        });
      }
      const readyRefs: Array<StartedChildRef | undefined> = Array.from({
        length: prepared.items.length,
      });
      const childResults: Array<SpawnChildAgentResult | undefined> = Array.from({
        length: prepared.items.length,
      });
      const rows = await runBoundedSwarm(
        prepared.items,
        async (item, { index }) => {
          traceAgentSwarm(ctx, 'tool_started', 'item_started', {
            itemId: item.itemId,
            index: item.index,
            profile: item.profile,
            boundary: 'local_swarm_concurrency',
          });
          ctx.emitOutput(
            'stdout',
            `Agent swarm item ${item.itemId} started: ${item.definition.name}\n`,
          );
          try {
            const result = (await ctx.spawnChildAgent!({
              spec: {
                id: item.definition.id,
                name: item.definition.name,
                systemPrompt: item.definition.systemPrompt,
              },
              prompt: item.task,
              onReady: ({ turnId, agentId, agentName }) => {
                readyRefs[index] = { turnId, agentId, agentName };
              },
            })) as SpawnChildAgentResult;
            childResults[index] = result;
            traceAgentSwarm(
              ctx,
              result.status === 'failed' ? 'tool_failed' : 'tool_completed',
              'item_completed',
              {
                itemId: item.itemId,
                index: item.index,
                profile: item.profile,
                status: result.status,
                turnId: result.turnId,
                ...(result.runId ? { runId: result.runId } : {}),
                durationMs: result.durationMs,
                artifactCount: result.artifactIds.length,
              },
            );
            ctx.emitOutput(
              result.status === 'failed' ? 'stderr' : 'stdout',
              `Agent swarm item ${item.itemId}: ${result.status}\n`,
            );
            return result;
          } catch (error) {
            traceAgentSwarm(ctx, 'tool_failed', 'item_completed', {
              itemId: item.itemId,
              index: item.index,
              profile: item.profile,
              status: ctx.abortSignal.aborted ? 'cancelled' : 'failed',
              failureClass: boundedFailureClass(error, 'ChildAgentError'),
            });
            ctx.emitOutput(
              'stderr',
              `Agent swarm item ${item.itemId} failed: ${boundedSwarmError(error)}\n`,
            );
            throw error;
          }
        },
        {
          maxConcurrency: prepared.maxConcurrency,
          signal: ctx.abortSignal,
        },
      );

      const items = rows.map((row, index) =>
        mapAgentSwarmItem(prepared.items[index]!, row, readyRefs[index], childResults[index]),
      );
      const completedAt = now();
      const status = aggregateAgentSwarmStatus(items);
      ctx.emitOutput('stdout', `Agent swarm: ${status}\n`);
      const result: AgentSwarmToolResult = {
        kind: 'agent_swarm',
        status,
        items,
        startedAt,
        completedAt,
        durationMs: Math.max(0, completedAt - startedAt),
      };
      traceAgentSwarm(ctx, 'tool_completed', 'batch_completed', {
        ...projectAgentSwarmResult(result),
      });
      return result;
    },
  };
}

function traceAgentSwarm(
  ctx: MakaToolContext,
  type: 'tool_started' | 'tool_completed' | 'tool_failed',
  stage: 'batch_started' | 'item_queued' | 'item_started' | 'item_completed' | 'batch_completed',
  data: Record<string, unknown>,
): void {
  ctx.emitRunTrace?.(type, `Agent swarm ${stage.replaceAll('_', ' ')}`, {
    swarmStage: stage,
    ...data,
  });
}

function agentSwarmInputSchema() {
  const itemSchema = z
    .object({
      item_id: z
        .string()
        .min(1)
        .max(TASK_ID_MAX_CHARS)
        .refine(isSafeTaskId)
        .describe('Stable item id (letters, digits, dot, underscore, colon, or dash).'),
      profile: z.enum(BUILTIN_AGENT_PROFILES).describe('Child agent profile.'),
      task: z
        .string()
        .min(1)
        .max(AGENT_SWARM_TASK_MAX_CHARS)
        .describe('Bounded, self-contained task for this item.'),
      write_back: z
        .enum(AGENT_SWARM_WRITE_BACK_MODES)
        .optional()
        .describe('Requested child write-back mode.'),
      isolation: z
        .enum(AGENT_SWARM_ISOLATION_MODES)
        .optional()
        .describe('Requested child workspace isolation.'),
    })
    .superRefine((input, ctx) => {
      addAgentContractIssues(input, ctx);
    });

  return z.object({
    items: z
      .array(itemSchema)
      .min(1)
      .max(AGENT_SWARM_MAX_ITEMS)
      .superRefine((items, ctx) => {
        const seen = new Set<string>();
        for (let index = 0; index < items.length; index += 1) {
          const itemId = items[index]!.item_id;
          if (seen.has(itemId)) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              path: [index, 'item_id'],
              message: `Duplicate agent swarm item_id "${itemId}".`,
            });
          }
          seen.add(itemId);
        }
      }),
    max_concurrency: z
      .number()
      .int()
      .min(1)
      .max(AGENT_SWARM_MAX_CONCURRENCY)
      .default(AGENT_SWARM_DEFAULT_CONCURRENCY)
      .describe('Maximum number of child items active inside this batch.'),
  });
}

function addAgentContractIssues(
  input: AgentSwarmToolInput['items'][number],
  ctx: z.RefinementCtx,
): void {
  const definition = requireBuiltinAgentDefinitionByProfile(input.profile);
  const writeBack = input.write_back ?? definition.contract.defaultWriteBack;
  if (!definition.contract.supportedWriteBack.some((mode) => mode === writeBack)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['write_back'],
      message: `Agent profile "${definition.profile}" does not support write_back "${writeBack}".`,
    });
  }
  const isolation = input.isolation ?? definition.contract.workspace;
  if (isolation !== definition.contract.workspace) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['isolation'],
      message: `Agent profile "${definition.profile}" requires isolation "${definition.contract.workspace}", not "${isolation}".`,
    });
  }
}

function preflightAgentSwarmInput(input: AgentSwarmToolInput): {
  readonly items: readonly PreparedAgentSwarmItem[];
  readonly maxConcurrency: number;
} {
  if (!Array.isArray(input.items) || input.items.length < 1) {
    throw new Error('Agent swarm requires at least one item.');
  }
  if (input.items.length > AGENT_SWARM_MAX_ITEMS) {
    throw new Error(`Agent swarm supports at most ${AGENT_SWARM_MAX_ITEMS} items.`);
  }
  const maxConcurrency = input.max_concurrency ?? AGENT_SWARM_DEFAULT_CONCURRENCY;
  if (
    !Number.isSafeInteger(maxConcurrency) ||
    maxConcurrency < 1 ||
    maxConcurrency > AGENT_SWARM_MAX_CONCURRENCY
  ) {
    throw new Error(
      `Agent swarm max_concurrency must be an integer from 1 to ${AGENT_SWARM_MAX_CONCURRENCY}.`,
    );
  }

  const seen = new Set<string>();
  const items = input.items.map((item, index): PreparedAgentSwarmItem => {
    if (!isSafeTaskId(item.item_id)) {
      throw new Error(`Agent swarm item ${index} has an invalid item_id.`);
    }
    if (seen.has(item.item_id)) {
      throw new Error(`Duplicate agent swarm item_id "${item.item_id}".`);
    }
    seen.add(item.item_id);
    if (
      typeof item.task !== 'string' ||
      item.task.length < 1 ||
      item.task.length > AGENT_SWARM_TASK_MAX_CHARS
    ) {
      throw new Error(`Agent swarm item "${item.item_id}" has an invalid task.`);
    }

    const definition = requireBuiltinAgentDefinitionByProfile(item.profile);
    const writeBack = item.write_back ?? definition.contract.defaultWriteBack;
    if (!definition.contract.supportedWriteBack.some((mode) => mode === writeBack)) {
      throw new Error(
        `Agent profile "${definition.profile}" does not support write_back "${writeBack}".`,
      );
    }
    const isolation = item.isolation ?? definition.contract.workspace;
    if (isolation !== definition.contract.workspace) {
      throw new Error(
        `Agent profile "${definition.profile}" requires isolation "${definition.contract.workspace}", not "${isolation}".`,
      );
    }
    if (isolation !== AGENT_WORKSPACE_SAME_WORKSPACE) {
      throw new Error(
        `Agent profile "${definition.profile}" requires "${isolation}" workspace isolation, but this runtime does not provide a worktree child executor yet.`,
      );
    }

    return {
      index,
      itemId: item.item_id,
      profile: definition.profile,
      task: item.task,
      definition,
    };
  });
  return { items, maxConcurrency };
}

function mapAgentSwarmItem(
  item: PreparedAgentSwarmItem,
  row: SwarmItemResult<SpawnChildAgentResult>,
  ready: StartedChildRef | undefined,
  observed: SpawnChildAgentResult | undefined,
): AgentSwarmToolResult['items'][number] {
  if (row.status === 'fulfilled') {
    return mapChildResult(
      item,
      row.value,
      row.value.status === 'cancelled'
        ? 'cancelled'
        : row.value.status === 'completed'
          ? 'completed'
          : 'failed',
    );
  }
  if (row.status === 'rejected') {
    return {
      itemId: item.itemId,
      index: row.index,
      profile: item.profile,
      started: ready !== undefined,
      ...(ready ?? {}),
      status: 'failed',
      summary: boundedSwarmError(row.reason),
      artifactIds: [],
      failureClass: boundedFailureClass(row.reason, 'ChildAgentError'),
    };
  }
  if (observed) {
    return mapChildResult(item, observed, 'cancelled');
  }
  return {
    itemId: item.itemId,
    index: row.index,
    profile: item.profile,
    started: ready !== undefined,
    ...(ready ?? {}),
    status: 'cancelled',
    summary: ready
      ? 'Child run was cancelled with its parent swarm.'
      : 'Item was cancelled before its child run started.',
    artifactIds: [],
    failureClass: 'ParentCancelled',
  };
}

function mapChildResult(
  item: PreparedAgentSwarmItem,
  result: SpawnChildAgentResult,
  status: AgentSwarmToolResult['items'][number]['status'],
): AgentSwarmToolResult['items'][number] {
  return {
    itemId: item.itemId,
    index: item.index,
    profile: item.profile,
    started: true,
    agentId: result.agentId,
    agentName: result.agentName,
    turnId: result.turnId,
    ...(result.runId ? { runId: result.runId } : {}),
    status,
    summary: result.summary,
    artifactIds: result.artifactIds,
    startedAt: result.startedAt,
    completedAt: result.completedAt,
    durationMs: result.durationMs,
    ...(result.failureClass ? { failureClass: result.failureClass } : {}),
  };
}

function aggregateAgentSwarmStatus(
  items: AgentSwarmToolResult['items'],
): AgentSwarmToolResult['status'] {
  if (items.some((item) => item.status === 'cancelled')) return 'cancelled';
  if (items.every((item) => item.status === 'completed')) return 'completed';
  return 'partial';
}

function boundedSwarmError(error: unknown): string {
  const message = redactSecrets(
    error instanceof Error ? error.message : String(error ?? 'unknown error'),
  );
  return message.length <= AGENT_SWARM_ERROR_MAX_CHARS
    ? message
    : `${message.slice(0, AGENT_SWARM_ERROR_MAX_CHARS - 1)}…`;
}

function boundedFailureClass(error: unknown, fallback: string): string {
  const value = error instanceof Error && error.name.trim() ? error.name : fallback;
  return boundedSwarmError(value);
}
