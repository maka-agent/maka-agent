import type { PermissionResponse } from '@maka/core';

const MAX_PERMISSION_REQUEST_ID_LENGTH = 128;

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
