import { z } from 'zod';
import type { MakaTool, MakaToolContext } from './tool-runtime.js';

export const MEMORY_REMEMBER_TOOL_NAME = 'memory_remember';
export const MEMORY_EXTRACT_TOOL_NAME = 'memory_extract';

export type MemoryExtractionScheduleMode = 'targeted' | 'sweep';
export type MemoryExtractionTriggerKind = 'user_requested' | 'agent_requested';

export interface MemoryExtractionScheduleRequest {
  readonly mode: MemoryExtractionScheduleMode;
  readonly triggerKind: MemoryExtractionTriggerKind;
  readonly sessionId: string;
  readonly runId: string;
  readonly turnId: string;
  readonly toolCallId: string;
}

export type MemoryExtractionScheduleResult =
  | { readonly status: 'accepted' }
  | { readonly status: 'coalesced' }
  | { readonly status: 'already_covered' }
  | {
      readonly status: 'rejected';
      readonly reason:
        | 'incognito_active'
        | 'memory_disabled'
        | 'queue_full'
        | 'runtime_unavailable';
    };

export interface MemoryExtractionScheduler {
  schedule(request: MemoryExtractionScheduleRequest): Promise<MemoryExtractionScheduleResult>;
}

export type AutomaticMemoryExtractionTriggerKind = 'context_threshold' | 'compaction';

/** Trusted Runtime-only automatic scheduling input. It is never model supplied. */
export interface AutomaticMemoryExtractionScheduleRequest {
  readonly sessionId: string;
  readonly runId: string;
  readonly turnId: string;
  readonly triggerKind: AutomaticMemoryExtractionTriggerKind;
  /** Stable identifier for one history-compaction cycle. */
  readonly triggerEpoch: string;
}

export type AutomaticMemoryExtractionScheduler = (
  request: AutomaticMemoryExtractionScheduleRequest,
) => Promise<void> | void;

const EMPTY_PARAMETERS = z.object({}).strict();

export function buildMemoryExtractionScheduleTools(
  scheduler: MemoryExtractionScheduler,
): readonly MakaTool<Record<string, never>, MemoryExtractionScheduleResult>[] {
  return Object.freeze([
    buildScheduleTool({
      name: MEMORY_REMEMBER_TOOL_NAME,
      displayName: 'Remember',
      description:
        'Schedule durable memory extraction when the user explicitly asks to remember information from this conversation. The request is asynchronous; do not claim the memory has already been saved.',
      mode: 'targeted',
      triggerKind: 'user_requested',
      scheduler,
    }),
    buildScheduleTool({
      name: MEMORY_EXTRACT_TOOL_NAME,
      displayName: 'Extract Memory',
      description:
        'Schedule durable memory extraction when this conversation contains information with clear long-term value. The request is asynchronous; do not claim the memory has already been saved.',
      mode: 'sweep',
      triggerKind: 'agent_requested',
      scheduler,
    }),
  ]);
}

function buildScheduleTool(input: {
  readonly name: typeof MEMORY_REMEMBER_TOOL_NAME | typeof MEMORY_EXTRACT_TOOL_NAME;
  readonly displayName: string;
  readonly description: string;
  readonly mode: MemoryExtractionScheduleMode;
  readonly triggerKind: MemoryExtractionTriggerKind;
  readonly scheduler: MemoryExtractionScheduler;
}): MakaTool<Record<string, never>, MemoryExtractionScheduleResult> {
  return {
    name: input.name,
    displayName: input.displayName,
    description: input.description,
    parameters: EMPTY_PARAMETERS,
    categoryHint: 'custom_tool',
    recoveryMode: 'replay_safe',
    executionSemantics: 'exclusive_step',
    impl: async (_args, context) =>
      input.scheduler.schedule(scheduleRequest(input.mode, input.triggerKind, context)),
  };
}

function scheduleRequest(
  mode: MemoryExtractionScheduleMode,
  triggerKind: MemoryExtractionTriggerKind,
  context: MakaToolContext,
): MemoryExtractionScheduleRequest {
  if (!context.runId) {
    throw new Error('Memory extraction scheduling requires an active Agent Run');
  }
  return Object.freeze({
    mode,
    triggerKind,
    sessionId: context.sessionId,
    runId: context.runId,
    turnId: context.turnId,
    toolCallId: context.toolCallId,
  });
}
