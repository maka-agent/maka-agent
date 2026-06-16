import type { ModelMessage } from 'ai';
import type { RuntimeEvent } from '@maka/core/runtime-event';
import type {
  ContextBudgetDiagnostic,
  PromptSegmentEstimate,
} from '@maka/core/usage-stats/types';

export interface ContextBudgetPolicy {
  name?: string;
  /**
   * Approximate max model-visible prior-history tokens. This is an estimate
   * used for shaping, not provider billing.
   */
  maxHistoryEstimatedTokens?: number;
  /** Hard cap on prior turns retained for model replay. */
  maxHistoryTurns?: number;
  /** Keep at least this many recent turns even if the token estimate exceeds the cap. */
  minRecentTurns?: number;
  /** Estimate conversion. Defaults to 4 chars/token, intentionally conservative for mixed text. */
  charsPerToken?: number;
}

export interface BudgetedRuntimeContext {
  events: RuntimeEvent[];
  diagnostic: ContextBudgetDiagnostic;
}

export interface PromptSegmentInput {
  systemPrompt?: string;
  toolSchemaChars: number;
  toolCount: number;
  priorMessages: readonly ModelMessage[];
  priorRuntimeEventCount?: number;
  currentUserContent: string;
  turnTailPrompt?: string;
  charsPerToken?: number;
}

export function applyRuntimeEventContextBudget(
  events: readonly RuntimeEvent[],
  policy: ContextBudgetPolicy | undefined,
): BudgetedRuntimeContext | undefined {
  const enabled = Boolean(policy?.maxHistoryEstimatedTokens || policy?.maxHistoryTurns);
  if (!enabled) return undefined;
  const charsPerToken = policy?.charsPerToken ?? 4;
  const maxTokens = finitePositive(policy?.maxHistoryEstimatedTokens);
  const maxTurns = finitePositive(policy?.maxHistoryTurns);
  const minRecentTurns = Math.max(0, Math.floor(policy?.minRecentTurns ?? 1));
  const turnGroups = groupEventsByTurn(events, charsPerToken);
  const estimatedTokensBefore = estimateRuntimeEventsTokens(events, charsPerToken);

  const keptTurnIds = new Set<string>();
  let keptTokens = 0;
  for (let index = turnGroups.length - 1; index >= 0; index -= 1) {
    const group = turnGroups[index]!;
    const nextTurnCount = keptTurnIds.size + 1;
    const mustKeep = nextTurnCount <= minRecentTurns;
    const wouldExceedTurns = maxTurns !== undefined && nextTurnCount > maxTurns;
    const wouldExceedTokens =
      maxTokens !== undefined &&
      keptTokens > 0 &&
      keptTokens + group.estimatedTokens > maxTokens;
    if (!mustKeep && (wouldExceedTurns || wouldExceedTokens)) break;
    keptTurnIds.add(group.turnId);
    keptTokens += group.estimatedTokens;
  }

  const keptEvents = events.filter((event) => keptTurnIds.has(event.turnId));
  const diagnostic: ContextBudgetDiagnostic = {
    enabled: true,
    ...(policy?.name ? { policyName: policy.name } : {}),
    ...(maxTokens !== undefined ? { maxHistoryEstimatedTokens: maxTokens } : {}),
    ...(maxTurns !== undefined ? { maxHistoryTurns: maxTurns } : {}),
    estimatedTokensBefore,
    estimatedTokensAfter: estimateRuntimeEventsTokens(keptEvents, charsPerToken),
    keptTurns: keptTurnIds.size,
    droppedTurns: Math.max(0, turnGroups.length - keptTurnIds.size),
    keptEvents: keptEvents.length,
    droppedEvents: Math.max(0, events.length - keptEvents.length),
  };
  return { events: keptEvents, diagnostic };
}

export function buildPromptSegmentEstimates(input: PromptSegmentInput): PromptSegmentEstimate[] {
  const charsPerToken = input.charsPerToken ?? 4;
  return [
    segment('system_prompt', input.systemPrompt?.length ?? 0, charsPerToken),
    {
      ...segment('tool_schema', input.toolSchemaChars, charsPerToken),
      toolCount: input.toolCount,
    },
    {
      ...segment('prior_history', estimateModelMessagesChars(input.priorMessages), charsPerToken),
      messageCount: input.priorMessages.length,
      ...(input.priorRuntimeEventCount !== undefined ? { eventCount: input.priorRuntimeEventCount } : {}),
    },
    segment('current_user', input.currentUserContent.length, charsPerToken),
    segment('turn_tail', input.turnTailPrompt?.length ?? 0, charsPerToken),
  ];
}

export function estimateModelMessagesChars(messages: readonly ModelMessage[]): number {
  return messages.reduce((total, message) => total + estimateModelMessageChars(message), 0);
}

export function estimateRuntimeEventsTokens(
  events: readonly RuntimeEvent[],
  charsPerToken = 4,
): number {
  const chars = events.reduce((total, event) => total + estimateRuntimeEventChars(event), 0);
  return estimateTokens(chars, charsPerToken);
}

export function estimateTokens(chars: number, charsPerToken = 4): number {
  if (chars <= 0) return 0;
  return Math.ceil(chars / Math.max(1, charsPerToken));
}

function groupEventsByTurn(events: readonly RuntimeEvent[], charsPerToken: number): Array<{
  turnId: string;
  estimatedTokens: number;
}> {
  const order: string[] = [];
  const byTurn = new Map<string, RuntimeEvent[]>();
  for (const event of events) {
    const key = event.turnId || '<unknown-turn>';
    const group = byTurn.get(key);
    if (group) group.push(event);
    else {
      order.push(key);
      byTurn.set(key, [event]);
    }
  }
  return order.map((turnId) => ({
    turnId,
    estimatedTokens: estimateRuntimeEventsTokens(byTurn.get(turnId) ?? [], charsPerToken),
  }));
}

function estimateRuntimeEventChars(event: RuntimeEvent): number {
  let total = 0;
  const content = event.content;
  if (content?.kind === 'text' || content?.kind === 'thinking') total += content.text.length;
  else if (content?.kind === 'function_call') total += content.name.length + stableJsonLength(content.args);
  else if (content?.kind === 'function_response') total += content.name.length + stableJsonLength(content.result);
  else if (content?.kind === 'error') total += content.message.length;
  return total;
}

function estimateModelMessageChars(message: ModelMessage): number {
  const raw = message as unknown as { content?: unknown };
  return estimateContentChars(raw.content);
}

function estimateContentChars(content: unknown): number {
  if (typeof content === 'string') return content.length;
  if (Array.isArray(content)) {
    return content.reduce((total, part) => total + estimatePartChars(part), 0);
  }
  return stableJsonLength(content);
}

function estimatePartChars(part: unknown): number {
  if (!part || typeof part !== 'object') return stableJsonLength(part);
  const value = part as Record<string, unknown>;
  let total = 0;
  for (const key of ['text', 'toolName', 'toolCallId'] as const) {
    if (typeof value[key] === 'string') total += value[key].length;
  }
  for (const key of ['input', 'output'] as const) {
    if (value[key] !== undefined) total += stableJsonLength(value[key]);
  }
  return total;
}

function segment(
  kind: PromptSegmentEstimate['kind'],
  chars: number,
  charsPerToken: number,
): PromptSegmentEstimate {
  return {
    kind,
    chars,
    estimatedTokens: estimateTokens(chars, charsPerToken),
  };
}

function stableJsonLength(value: unknown): number {
  if (value === undefined) return 0;
  try {
    return JSON.stringify(value)?.length ?? 0;
  } catch {
    return String(value).length;
  }
}

function finitePositive(value: number | undefined): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : undefined;
}
