import type { ModelMessage } from 'ai';

const DEFAULT_CHARS_PER_TOKEN = 4;

export type ProviderMessageShapeFailureReason =
  | 'invalid_message_shape'
  | 'duplicate_tool_call_id'
  | 'tool_result_without_call'
  | 'tool_result_missing'
  | 'tool_result_not_adjacent'
  | 'thinking_after_tool_call';

export interface ProviderMessageShapeValidation {
  valid: boolean;
  reasons: ProviderMessageShapeFailureReason[];
  reasonCounts: Readonly<Record<string, number>>;
}

export interface ProviderReplayProjectionPolicy {
  /** Hard cap for prior replay messages only; current input/system/tools are owned by request assembly. */
  maxEstimatedTokens?: number;
  maxTurns?: number;
  minRecentTurns?: number;
  charsPerToken?: number;
  messageTurnIds?: readonly (string | undefined)[];
  protectedTurnIds?: readonly string[];
}

export type ProviderReplayProjectionFailureReason =
  | 'provider_shape_invalid'
  | 'turn_identity_mismatch'
  | 'hard_budget_impossible';

export interface ProviderReplayProjectionFailure {
  kind: 'maka.provider_replay_projection_failure';
  reason: ProviderReplayProjectionFailureReason;
  shapeReasons: ProviderMessageShapeFailureReason[];
  estimatedTokensBefore: number;
  requiredEstimatedTokens: number;
  maxEstimatedTokens?: number;
  requiredTurns: number;
  maxTurns?: number;
}

export type ProviderReplayProjectionResult =
  | {
      ok: true;
      messages: ModelMessage[];
      trimmed: boolean;
      estimatedTokensBefore: number;
      estimatedTokensAfter: number;
      keptTurns: number;
      droppedTurns: number;
      keptMessages: number;
      droppedMessages: number;
      shape: ProviderMessageShapeValidation;
    }
  | {
      ok: false;
      messages: ModelMessage[];
      failure: ProviderReplayProjectionFailure;
      shape: ProviderMessageShapeValidation;
    };

export function projectProviderReplayMessages(
  messages: readonly ModelMessage[],
  policy: ProviderReplayProjectionPolicy = {},
): ProviderReplayProjectionResult {
  const originalMessages = [...messages];
  const charsPerToken = finitePositive(policy.charsPerToken) ?? DEFAULT_CHARS_PER_TOKEN;
  const estimatedTokensBefore = estimateProviderMessagesTokens(originalMessages, charsPerToken);
  const shape = validateProviderMessageShape(originalMessages);
  if (policy.messageTurnIds && policy.messageTurnIds.length !== originalMessages.length) {
    return {
      ok: false,
      messages: originalMessages,
      shape,
      failure: {
        kind: 'maka.provider_replay_projection_failure',
        reason: 'turn_identity_mismatch',
        shapeReasons: [],
        estimatedTokensBefore,
        requiredEstimatedTokens: estimatedTokensBefore,
        requiredTurns: 0,
      },
    };
  }
  if (!shape.valid) {
    return {
      ok: false,
      messages: originalMessages,
      shape,
      failure: {
        kind: 'maka.provider_replay_projection_failure',
        reason: 'provider_shape_invalid',
        shapeReasons: [...shape.reasons],
        estimatedTokensBefore,
        requiredEstimatedTokens: estimatedTokensBefore,
        requiredTurns: 0,
      },
    };
  }

  const turns = buildProviderReplayTurns(
    originalMessages,
    charsPerToken,
    policy.messageTurnIds,
  );
  const maxEstimatedTokens = finitePositive(policy.maxEstimatedTokens);
  const maxTurns = finitePositiveInteger(policy.maxTurns);
  const minRecentTurns = Math.max(0, Math.floor(policy.minRecentTurns ?? 1));
  const requiredIndexes = new Set<number>();
  const protectedTurnIds = new Set(policy.protectedTurnIds ?? []);
  turns.forEach((turn, index) => {
    if (turn.sourceTurnId && protectedTurnIds.has(turn.sourceTurnId)) requiredIndexes.add(index);
  });
  const recentStart = Math.max(0, turns.length - minRecentTurns);
  for (let index = turns.length - 1; index >= recentStart; index -= 1) {
    requiredIndexes.add(index);
  }
  const requiredTurns = requiredIndexes.size;
  const required = turns.filter((_turn, index) => requiredIndexes.has(index));
  const requiredEstimatedTokens = sumTurnTokens(required);
  if (
    (maxEstimatedTokens !== undefined && requiredEstimatedTokens > maxEstimatedTokens)
    || (maxTurns !== undefined && requiredTurns > maxTurns)
  ) {
    return {
      ok: false,
      messages: originalMessages,
      shape,
      failure: {
        kind: 'maka.provider_replay_projection_failure',
        reason: 'hard_budget_impossible',
        shapeReasons: [],
        estimatedTokensBefore,
        requiredEstimatedTokens,
        ...(maxEstimatedTokens !== undefined ? { maxEstimatedTokens } : {}),
        requiredTurns,
        ...(maxTurns !== undefined ? { maxTurns } : {}),
      },
    };
  }

  const selectedIndexes = new Set(requiredIndexes);
  let selectedTokens = requiredEstimatedTokens;
  let selectedCount = requiredTurns;
  for (let index = turns.length - 1; index >= 0; index -= 1) {
    if (selectedIndexes.has(index)) continue;
    const turn = turns[index]!;
    const wouldExceedTurns = maxTurns !== undefined && selectedCount + 1 > maxTurns;
    const wouldExceedTokens =
      maxEstimatedTokens !== undefined
      && selectedTokens + turn.estimatedTokens > maxEstimatedTokens;
    if (wouldExceedTurns || wouldExceedTokens) {
      break;
    }
    selectedIndexes.add(index);
    selectedCount += 1;
    selectedTokens += turn.estimatedTokens;
  }

  const selected = turns.filter((_turn, index) => selectedIndexes.has(index));
  const projectedMessages = selected.flatMap((turn) => turn.messages);
  const projectedShape = validateProviderMessageShape(projectedMessages);
  if (!projectedShape.valid) {
    return {
      ok: false,
      messages: originalMessages,
      shape: projectedShape,
      failure: {
        kind: 'maka.provider_replay_projection_failure',
        reason: 'provider_shape_invalid',
        shapeReasons: [...projectedShape.reasons],
        estimatedTokensBefore,
        requiredEstimatedTokens,
        ...(maxEstimatedTokens !== undefined ? { maxEstimatedTokens } : {}),
        requiredTurns,
        ...(maxTurns !== undefined ? { maxTurns } : {}),
      },
    };
  }

  return {
    ok: true,
    messages: projectedMessages,
    trimmed: selected.length !== turns.length,
    estimatedTokensBefore,
    estimatedTokensAfter: selectedTokens,
    keptTurns: selected.length,
    droppedTurns: turns.length - selected.length,
    keptMessages: projectedMessages.length,
    droppedMessages: originalMessages.length - projectedMessages.length,
    shape: projectedShape,
  };
}

export function validateProviderMessageShape(
  messages: readonly ModelMessage[],
): ProviderMessageShapeValidation {
  const reasons: ProviderMessageShapeFailureReason[] = [];
  const add = (reason: ProviderMessageShapeFailureReason) => {
    if (!reasons.includes(reason)) reasons.push(reason);
  };
  const seenToolCallIds = new Set<string>();
  let pendingToolCallIds = new Set<string>();

  for (const message of messages) {
    if (!isBasicProviderMessageShape(message)) {
      add('invalid_message_shape');
      continue;
    }
    const role = (message as { role: string }).role;
    if (role === 'tool') {
      if (pendingToolCallIds.size === 0) add('tool_result_without_call');
      for (const toolCallId of messageToolResultIds(message)) {
        if (!pendingToolCallIds.has(toolCallId)) add('tool_result_without_call');
        pendingToolCallIds.delete(toolCallId);
      }
      continue;
    }

    if (pendingToolCallIds.size > 0) {
      add('tool_result_missing');
      add('tool_result_not_adjacent');
      pendingToolCallIds = new Set<string>();
    }
    if (role !== 'assistant') continue;

    const content = (message as { content?: unknown }).content;
    if (!Array.isArray(content)) continue;
    const firstToolCallIndex = content.findIndex(isToolCallPart);
    const lastThinkingIndex = findLastPartIndex(content, isThinkingPart);
    if (firstToolCallIndex >= 0 && lastThinkingIndex > firstToolCallIndex) add('thinking_after_tool_call');

    const toolCallIds = messageToolCallIds(message);
    for (const toolCallId of toolCallIds) {
      if (seenToolCallIds.has(toolCallId)) add('duplicate_tool_call_id');
      seenToolCallIds.add(toolCallId);
      pendingToolCallIds.add(toolCallId);
    }
  }

  if (pendingToolCallIds.size > 0) add('tool_result_missing');
  return {
    valid: reasons.length === 0,
    reasons,
    reasonCounts: countReasons(reasons),
  };
}

export function estimateProviderMessagesTokens(
  messages: readonly ModelMessage[],
  charsPerToken = DEFAULT_CHARS_PER_TOKEN,
): number {
  const divisor = finitePositive(charsPerToken) ?? DEFAULT_CHARS_PER_TOKEN;
  return messages.reduce((total, message) => {
    const serialized = safeStringify(message);
    return total + Math.max(1, Math.ceil(serialized.length / divisor));
  }, 0);
}

interface ProviderReplayTurn {
  messages: ModelMessage[];
  estimatedTokens: number;
  sourceTurnId?: string;
}

function buildProviderReplayTurns(
  messages: readonly ModelMessage[],
  charsPerToken: number,
  messageTurnIds: readonly (string | undefined)[] | undefined,
): ProviderReplayTurn[] {
  const turns: Array<{ messages: ModelMessage[]; sourceTurnId?: string }> = [];
  let current: { messages: ModelMessage[]; sourceTurnId?: string } = { messages: [] };
  messages.forEach((message, index) => {
    const sourceTurnId = messageTurnIds?.[index];
    const startsNewSourceTurn = Boolean(
      current.messages.length > 0
      && sourceTurnId
      && current.sourceTurnId
      && sourceTurnId !== current.sourceTurnId,
    );
    if (
      current.messages.length > 0
      && (startsNewSourceTurn || ((message as { role?: string }).role === 'user' && !sourceTurnId))
    ) {
      turns.push(current);
      current = { messages: [] };
    }
    if (!current.sourceTurnId && sourceTurnId) current.sourceTurnId = sourceTurnId;
    current.messages.push(message);
  });
  if (current.messages.length > 0) turns.push(current);
  return turns.map((turn) => ({
    messages: turn.messages,
    estimatedTokens: estimateProviderMessagesTokens(turn.messages, charsPerToken),
    ...(turn.sourceTurnId ? { sourceTurnId: turn.sourceTurnId } : {}),
  }));
}

function isBasicProviderMessageShape(message: ModelMessage): boolean {
  const candidate = message as { role?: unknown; content?: unknown };
  if (
    candidate.role !== 'system'
    && candidate.role !== 'user'
    && candidate.role !== 'assistant'
    && candidate.role !== 'tool'
  ) {
    return false;
  }
  if (typeof candidate.content === 'string') return candidate.role !== 'tool';
  if (!Array.isArray(candidate.content) || !candidate.content.every(isTypedPart)) return false;
  if (candidate.role === 'system') return false;
  if (candidate.role === 'user') {
    return candidate.content.length > 0 && candidate.content.every(isValidUserPart);
  }
  if (candidate.role === 'tool') {
    return candidate.content.length > 0 && candidate.content.every((part) =>
      isRecord(part)
      && part.type === 'tool-result'
      && nonEmpty(part.toolCallId ?? part.tool_call_id)
      && nonEmpty(part.toolName ?? part.name)
      && ('output' in part || 'result' in part)
    );
  }
  if (candidate.role === 'assistant') {
    return candidate.content.length > 0 && candidate.content.every(isValidAssistantPart);
  }
  return true;
}

function isValidUserPart(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (value.type === 'text') return typeof value.text === 'string';
  if (value.type === 'image') return 'image' in value && value.image !== undefined && value.image !== null;
  if (value.type === 'file') {
    return 'data' in value
      && value.data !== undefined
      && value.data !== null
      && nonEmpty(value.mediaType ?? value.media_type);
  }
  return false;
}

function isValidAssistantPart(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (value.type === 'text' || value.type === 'reasoning') return typeof value.text === 'string';
  return isToolCallPart(value)
    && nonEmpty(value.toolCallId ?? value.tool_call_id)
    && nonEmpty(value.toolName ?? value.name)
    && 'input' in value;
}

function messageToolCallIds(message: ModelMessage): string[] {
  const content = (message as { content?: unknown }).content;
  if (!Array.isArray(content)) return [];
  return content
    .filter(isToolCallPart)
    .map((part) => part.toolCallId ?? part.tool_call_id)
    .filter(nonEmpty);
}

function messageToolResultIds(message: ModelMessage): string[] {
  const content = (message as { content?: unknown }).content;
  if (!Array.isArray(content)) return [];
  return content
    .filter((part) => isRecord(part) && part.type === 'tool-result')
    .map((part) => part.toolCallId ?? part.tool_call_id)
    .filter(nonEmpty);
}

function isToolCallPart(value: unknown): value is Record<string, unknown> {
  return isRecord(value) && value.type === 'tool-call';
}

function isThinkingPart(value: unknown): boolean {
  return isRecord(value) && (value.type === 'reasoning' || value.type === 'thinking');
}

function findLastPartIndex(values: readonly unknown[], predicate: (value: unknown) => boolean): number {
  for (let index = values.length - 1; index >= 0; index -= 1) {
    if (predicate(values[index])) return index;
  }
  return -1;
}

function isTypedPart(value: unknown): boolean {
  return isRecord(value) && nonEmpty(value.type);
}

function sumTurnTokens(turns: readonly ProviderReplayTurn[]): number {
  return turns.reduce((total, turn) => total + turn.estimatedTokens, 0);
}

function countReasons(values: readonly string[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const value of values) counts[value] = (counts[value] ?? 0) + 1;
  return counts;
}

function finitePositive(value: number | undefined): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;
}

function finitePositiveInteger(value: number | undefined): number | undefined {
  const finite = finitePositive(value);
  return finite === undefined ? undefined : Math.floor(finite);
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return '[unserializable-provider-message]';
  }
}

function nonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
