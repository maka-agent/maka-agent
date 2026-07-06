import type {
  BranchFromTurnInput,
  PermissionResponse,
  RegenerateTurnInput,
  RetryTurnInput,
} from '@maka/core';

const MAX_PERMISSION_REQUEST_ID_LENGTH = 128;
const MAX_TURN_ID_LENGTH = 128;
const MAX_BRANCH_NAME_LENGTH = 200;
const MAX_SESSION_SEND_TEXT_LENGTH = 128_000;

interface NormalizedSendSessionCommand {
  type: 'send';
  turnId?: string;
  text: string;
  attachmentItems?: unknown;
}
type NormalizedStopSessionInput = { source?: 'stop_button' };

export function normalizePermissionResponse(input: unknown): PermissionResponse {
  if (!input || typeof input !== 'object') {
    throw new Error('Invalid permission response');
  }
  const value = input as Record<string, unknown>;
  if (
    typeof value.requestId !== 'string' ||
    value.requestId.length === 0 ||
    value.requestId.length > MAX_PERMISSION_REQUEST_ID_LENGTH
  ) {
    throw new Error('Invalid permission response requestId');
  }
  if (value.decision !== 'allow' && value.decision !== 'deny') {
    throw new Error('Invalid permission response decision');
  }
  if (value.rememberForTurn !== undefined && typeof value.rememberForTurn !== 'boolean') {
    throw new Error('Invalid permission response rememberForTurn');
  }
  return {
    requestId: value.requestId,
    decision: value.decision,
    ...(value.rememberForTurn !== undefined ? { rememberForTurn: value.rememberForTurn } : {}),
  };
}

export function normalizeRetryTurnInput(input: unknown): RetryTurnInput {
  const value = requireObject(input, 'Invalid retry turn input');
  return {
    sourceTurnId: normalizeRequiredString(value.sourceTurnId, 'Invalid retry turn sourceTurnId', MAX_TURN_ID_LENGTH),
    ...normalizeOptionalTurnId(value.turnId),
  };
}

export function normalizeRegenerateTurnInput(input: unknown): RegenerateTurnInput {
  const value = requireObject(input, 'Invalid regenerate turn input');
  return {
    sourceTurnId: normalizeRequiredString(
      value.sourceTurnId,
      'Invalid regenerate turn sourceTurnId',
      MAX_TURN_ID_LENGTH,
    ),
    ...normalizeOptionalTurnId(value.turnId),
  };
}

export function normalizeBranchFromTurnInput(input: unknown): BranchFromTurnInput {
  const value = requireObject(input, 'Invalid branch turn input');
  const name =
    value.name === undefined
      ? undefined
      : normalizeOptionalString(value.name, 'Invalid branch name', MAX_BRANCH_NAME_LENGTH);
  return {
    sourceTurnId: normalizeRequiredString(value.sourceTurnId, 'Invalid branch sourceTurnId', MAX_TURN_ID_LENGTH),
    ...(name ? { name } : {}),
  };
}

export function normalizeSessionSendCommand(input: unknown): NormalizedSendSessionCommand | undefined {
  const value = requireObject(input, 'Invalid session command');
  if (value.type !== 'send') return undefined;
  return {
    type: 'send',
    ...normalizeOptionalSendTurnId(value.turnId),
    text: normalizeRequiredString(value.text, 'Invalid send text', MAX_SESSION_SEND_TEXT_LENGTH),
    ...(value.attachmentItems !== undefined ? { attachmentItems: value.attachmentItems } : {}),
  };
}

export function normalizeStopSessionInput(input: unknown): NormalizedStopSessionInput {
  if (input === undefined) return {};
  const value = requireObject(input, 'Invalid stop session input');
  if (value.source === undefined) return {};
  if (value.source !== 'stop_button') {
    throw new Error('Invalid stop session source');
  }
  return { source: 'stop_button' };
}

function requireObject(input: unknown, errorMessage: string): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error(errorMessage);
  }
  return input as Record<string, unknown>;
}

function normalizeRequiredString(input: unknown, errorMessage: string, maxLength: number): string {
  if (typeof input !== 'string' || input.length === 0 || input.length > maxLength) {
    throw new Error(errorMessage);
  }
  return input;
}

function normalizeOptionalString(input: unknown, errorMessage: string, maxLength: number): string | undefined {
  if (typeof input !== 'string') {
    throw new Error(errorMessage);
  }
  const trimmed = input.trim();
  if (trimmed.length === 0) return undefined;
  if (trimmed.length > maxLength) {
    throw new Error(errorMessage);
  }
  return trimmed;
}

function normalizeOptionalTurnId(input: unknown): { turnId?: string } {
  if (input === undefined) return {};
  return {
    turnId: normalizeRequiredString(input, 'Invalid turnId', MAX_TURN_ID_LENGTH),
  };
}

function normalizeOptionalSendTurnId(input: unknown): { turnId?: string } {
  if (input === undefined || input === '') return {};
  return {
    turnId: normalizeRequiredString(input, 'Invalid send turnId', MAX_TURN_ID_LENGTH),
  };
}
