import {
  assertAllowedKeys,
  requireCount,
  requireEntityId,
  requireExactRecord,
  requirePositiveCount,
  requireRecord,
} from './codec.js';
import { invalidProtocolFrame } from './errors.js';
import { defineOperation } from './operation-spec.js';

export const GOAL_CONDITION_MAX_BYTES = 16 * 1024;
export const GOAL_REASON_MAX_BYTES = 4 * 1024;
export const GOAL_RESULT_MAX_BYTES = 24 * 1024;

const GOAL_STATUSES = [
  'active',
  'waiting',
  'achieved',
  'impossible',
  'cleared',
  'paused',
  'stalled',
  'budget_limited',
  'max_iterations',
] as const;

const GOAL_REQUIRED_FIELDS = [
  'goalId',
  'revision',
  'sessionId',
  'condition',
  'status',
  'setAt',
  'iterations',
  'maxIterations',
  'consecutiveNoProgress',
  'blockCap',
  'tokensAtStart',
  'tokensNow',
  'tokensBaselinePending',
] as const;
const GOAL_FIELDS = [
  ...GOAL_REQUIRED_FIELDS,
  'tokenBudget',
  'lastReason',
  'lastReasonTruncated',
  'achievedAt',
  'pausedAt',
] as const;

const QUERY_ERRORS = [
  'host_not_ready',
  'host_draining',
  'operation_unavailable',
  'invalid_request',
  'internal_failure',
] as const;
const CLEAR_ERRORS = [...QUERY_ERRORS, 'not_found', 'operation_conflict'] as const;

export type GoalStatus = (typeof GOAL_STATUSES)[number];

export interface GoalProjection {
  readonly goalId: string;
  readonly revision: number;
  readonly sessionId: string;
  readonly condition: string;
  readonly status: GoalStatus;
  readonly setAt: number;
  readonly iterations: number;
  readonly maxIterations: number;
  readonly consecutiveNoProgress: number;
  readonly blockCap: number;
  readonly tokenBudget?: number;
  readonly tokensAtStart: number;
  readonly tokensNow: number;
  readonly tokensBaselinePending: boolean;
  readonly lastReason?: string;
  /** Present only when `lastReason` is a bounded prefix of the Runtime value. */
  readonly lastReasonTruncated?: true;
  readonly achievedAt?: number;
  readonly pausedAt?: number;
}

export interface GoalQueryInput {
  readonly sessionId: string;
}

export type GoalQueryResult =
  | { readonly kind: 'none' }
  | { readonly kind: 'item'; readonly goal: GoalProjection };

export interface GoalClearInput {
  readonly sessionId: string;
  readonly goalId: string;
}

export interface GoalClearResult {
  readonly kind: 'cleared' | 'unchanged';
  readonly goal: GoalProjection;
}

export const GOAL_OPERATION_SPECS = {
  'goal.query': defineOperation<GoalQueryInput, GoalQueryResult, (typeof QUERY_ERRORS)[number]>({
    mode: 'query',
    retry: 'safe',
    admission: 'session',
    errors: QUERY_ERRORS,
    decodeInput: decodeGoalQueryInput,
    decodeOutput: decodeGoalQueryResult,
  }),
  'goal.clear': defineOperation<GoalClearInput, GoalClearResult, (typeof CLEAR_ERRORS)[number]>({
    mode: 'command',
    retry: 'semantic',
    admission: 'session',
    errors: CLEAR_ERRORS,
    decodeInput: decodeGoalClearInput,
    decodeOutput: decodeGoalClearResult,
  }),
} as const;

export function decodeGoalQueryInput(value: unknown): GoalQueryInput {
  const input = requireExactRecord(value, 'goal query input', ['sessionId']);
  return { sessionId: requireEntityId(input.sessionId, 'sessionId') };
}

export function decodeGoalClearInput(value: unknown): GoalClearInput {
  const input = requireExactRecord(value, 'goal clear input', ['sessionId', 'goalId']);
  return {
    sessionId: requireEntityId(input.sessionId, 'sessionId'),
    goalId: requireEntityId(input.goalId, 'goalId'),
  };
}

export function decodeGoalQueryResult(value: unknown): GoalQueryResult {
  const result = requireRecord(value, 'goal query result');
  if (result.kind === 'none') {
    requireExactRecord(result, 'empty goal query result', ['kind']);
    return { kind: 'none' };
  }
  if (result.kind !== 'item') throw invalidProtocolFrame('Invalid goal query result kind');
  const item = requireExactRecord(result, 'goal item result', ['kind', 'goal']);
  return assertResultSize({ kind: 'item', goal: decodeGoalProjection(item.goal) });
}

export function encodeGoalQueryResult(value: unknown): GoalQueryResult {
  return decodeGoalQueryResult(projectResultReason(value));
}

export function decodeGoalClearResult(value: unknown): GoalClearResult {
  const result = requireExactRecord(value, 'goal clear result', ['kind', 'goal']);
  if (result.kind !== 'cleared' && result.kind !== 'unchanged') {
    throw invalidProtocolFrame('Invalid goal clear result kind');
  }
  const goal = decodeGoalProjection(result.goal);
  if (
    (result.kind === 'cleared' && goal.status !== 'cleared') ||
    (result.kind === 'unchanged' && !isTerminalGoalStatus(goal.status))
  ) {
    throw invalidProtocolFrame('Goal clear result does not match Goal status');
  }
  return assertResultSize({ kind: result.kind, goal });
}

export function encodeGoalClearResult(value: unknown): GoalClearResult {
  return decodeGoalClearResult(projectResultReason(value));
}

function decodeGoalProjection(value: unknown): GoalProjection {
  const record = requireRecord(value, 'goal projection');
  assertAllowedKeys(record, 'goal projection', GOAL_FIELDS);
  if (GOAL_REQUIRED_FIELDS.some((field) => !Object.hasOwn(record, field))) {
    throw invalidProtocolFrame('Invalid goal projection fields');
  }

  const iterations = requireCount(record.iterations, 'goal iterations');
  const maxIterations = requirePositiveCount(record.maxIterations, 'goal maxIterations');
  const consecutiveNoProgress = requireCount(
    record.consecutiveNoProgress,
    'goal consecutiveNoProgress',
  );
  const blockCap = requirePositiveCount(record.blockCap, 'goal blockCap');
  const tokensAtStart = requireCount(record.tokensAtStart, 'goal tokensAtStart');
  const tokensNow = requireCount(record.tokensNow, 'goal tokensNow');
  const projection: GoalProjection = {
    goalId: requireEntityId(record.goalId, 'goalId'),
    revision: requireCount(record.revision, 'goal revision'),
    sessionId: requireEntityId(record.sessionId, 'sessionId'),
    condition: requireWireText(record.condition, 'goal condition', GOAL_CONDITION_MAX_BYTES),
    status: goalStatus(record.status),
    setAt: requireCount(record.setAt, 'goal setAt'),
    iterations,
    maxIterations,
    consecutiveNoProgress,
    blockCap,
    tokensAtStart,
    tokensNow,
    tokensBaselinePending: requireBoolean(
      record.tokensBaselinePending,
      'goal tokensBaselinePending',
    ),
    ...(Object.hasOwn(record, 'tokenBudget')
      ? { tokenBudget: requirePositiveCount(record.tokenBudget, 'goal tokenBudget') }
      : {}),
    ...(Object.hasOwn(record, 'lastReason')
      ? {
          lastReason: requireWireText(
            record.lastReason,
            'goal lastReason',
            GOAL_REASON_MAX_BYTES,
            true,
          ),
        }
      : {}),
    ...(Object.hasOwn(record, 'lastReasonTruncated')
      ? { lastReasonTruncated: requireTruncated(record.lastReasonTruncated) }
      : {}),
    ...(Object.hasOwn(record, 'achievedAt')
      ? { achievedAt: requireCount(record.achievedAt, 'goal achievedAt') }
      : {}),
    ...(Object.hasOwn(record, 'pausedAt')
      ? { pausedAt: requireCount(record.pausedAt, 'goal pausedAt') }
      : {}),
  };
  validateGoalProjection(projection);
  return projection;
}

function goalStatus(value: unknown): GoalStatus {
  if (typeof value !== 'string' || !GOAL_STATUSES.includes(value as GoalStatus)) {
    throw invalidProtocolFrame('Invalid goal status');
  }
  return value as GoalStatus;
}

function requireBoolean(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') throw invalidProtocolFrame(`Invalid ${label}`);
  return value;
}

function requireTruncated(value: unknown): true {
  if (value !== true) throw invalidProtocolFrame('Invalid goal lastReasonTruncated');
  return true;
}

function requireWireText(
  value: unknown,
  label: string,
  maxBytes: number,
  allowEmpty = false,
): string {
  if (
    typeof value !== 'string' ||
    (!allowEmpty && value.length === 0) ||
    Buffer.byteLength(value, 'utf8') > maxBytes ||
    jsonStringContentBytes(value) > maxBytes
  ) {
    throw invalidProtocolFrame(`Invalid ${label}`);
  }
  return value;
}

function validateGoalProjection(goal: GoalProjection): void {
  const reasonRequired =
    goal.status === 'waiting' ||
    goal.status === 'achieved' ||
    goal.status === 'impossible' ||
    goal.status === 'stalled' ||
    goal.status === 'budget_limited' ||
    goal.status === 'max_iterations';
  const spent = goal.tokensNow - goal.tokensAtStart;
  const budgetReached = goal.tokenBudget !== undefined && spent >= goal.tokenBudget;
  const pausedAtAllowed = goal.status === 'paused' || goal.status === 'cleared';

  if (
    goal.tokensNow < goal.tokensAtStart ||
    goal.consecutiveNoProgress > goal.iterations ||
    goal.iterations > goal.revision ||
    (goal.tokensBaselinePending && goal.tokensNow !== goal.tokensAtStart) ||
    (!goal.tokensBaselinePending && goal.iterations === 0) ||
    (goal.status === 'waiting' && goal.iterations === 0) ||
    (goal.iterations > 0 && goal.lastReason === undefined) ||
    (goal.revision === 0 &&
      (goal.status !== 'active' || !goal.tokensBaselinePending || goal.lastReason !== undefined)) ||
    (goal.status === 'max_iterations'
      ? goal.iterations !== goal.maxIterations
      : goal.iterations >= goal.maxIterations) ||
    (goal.status === 'stalled'
      ? goal.consecutiveNoProgress !== goal.blockCap
      : goal.consecutiveNoProgress >= goal.blockCap) ||
    (goal.status === 'budget_limited') !== budgetReached ||
    (goal.status === 'achieved') !== (goal.achievedAt !== undefined) ||
    (goal.status === 'paused' && goal.pausedAt === undefined) ||
    (!pausedAtAllowed && goal.pausedAt !== undefined) ||
    (reasonRequired && goal.lastReason === undefined) ||
    (goal.lastReasonTruncated === true && goal.lastReason === undefined)
  ) {
    throw invalidProtocolFrame('Invalid goal projection state');
  }
}

function isTerminalGoalStatus(status: GoalStatus): boolean {
  return (
    status === 'achieved' ||
    status === 'impossible' ||
    status === 'cleared' ||
    status === 'stalled' ||
    status === 'budget_limited' ||
    status === 'max_iterations'
  );
}

function projectResultReason(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const result = value as Record<string, unknown>;
  if (result.kind !== 'item' && result.kind !== 'cleared' && result.kind !== 'unchanged') {
    return value;
  }
  if (!result.goal || typeof result.goal !== 'object' || Array.isArray(result.goal)) return value;
  const goal = result.goal as Record<string, unknown>;
  if (typeof goal.lastReason !== 'string' || Object.hasOwn(goal, 'lastReasonTruncated')) {
    return value;
  }
  const projected = projectWireText(goal.lastReason, GOAL_REASON_MAX_BYTES);
  if (!projected.truncated) return value;
  return {
    ...result,
    goal: {
      ...goal,
      lastReason: projected.text,
      lastReasonTruncated: true,
    },
  };
}

function projectWireText(value: string, maxBytes: number): { text: string; truncated: boolean } {
  let text = '';
  let rawBytes = 0;
  let encodedBytes = 0;
  for (const character of value) {
    const nextRawBytes = Buffer.byteLength(character, 'utf8');
    const nextEncodedBytes = jsonStringContentBytes(character);
    if (rawBytes + nextRawBytes > maxBytes || encodedBytes + nextEncodedBytes > maxBytes) {
      return { text, truncated: true };
    }
    text += character;
    rawBytes += nextRawBytes;
    encodedBytes += nextEncodedBytes;
  }
  return { text, truncated: false };
}

function jsonStringContentBytes(value: string): number {
  return Buffer.byteLength(JSON.stringify(value).slice(1, -1), 'utf8');
}

function assertResultSize<Result extends GoalQueryResult | GoalClearResult>(
  result: Result,
): Result {
  if (Buffer.byteLength(JSON.stringify(result), 'utf8') > GOAL_RESULT_MAX_BYTES) {
    throw invalidProtocolFrame('Goal result exceeds byte limit');
  }
  return result;
}
