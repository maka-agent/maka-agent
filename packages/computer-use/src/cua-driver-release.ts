export type CuaDriverRole = 'action' | 'capture';

export type CuaDriverChildState =
  | 'idle'
  | 'starting'
  | 'ready'
  | 'backing_off'
  | 'unavailable'
  | 'disposed';

export type CuaDriverRequestStage =
  | 'queued'
  | 'writing'
  | 'delivered'
  | 'settled';

export interface CuaDriverRoleSnapshot {
  role: CuaDriverRole;
  state: CuaDriverChildState;
  generation: number;
  restartAttempts: number;
  nextRestartAt?: number;
}

export interface CuaDriverReleaseEvent {
  role: CuaDriverRole;
  generation: number;
  generationReleased: boolean;
  reason:
    | 'child_exit'
    | 'request_timeout'
    | 'request_aborted'
    | 'session_cleared'
    | 'restart_exhausted'
    | 'disposed';
  sessionIds: readonly string[];
  outcomeUnknown: boolean;
}

export type CuaDriverLifecycleErrorCode =
  | 'outcome_unknown'
  | 'service_unavailable'
  | 'service_mismatch'
  | 'aborted';

export class CuaDriverLifecycleError extends Error {
  constructor(
    readonly code: CuaDriverLifecycleErrorCode,
    message: string,
    readonly role: CuaDriverRole,
    readonly generation: number,
    readonly requestStage?: CuaDriverRequestStage,
  ) {
    super(`${code}: ${message}`);
    this.name = 'CuaDriverLifecycleError';
  }
}

export function isCuaDriverLifecycleError(
  error: unknown,
  code?: CuaDriverLifecycleErrorCode,
): error is CuaDriverLifecycleError {
  return error instanceof CuaDriverLifecycleError
    && (code === undefined || error.code === code);
}

export function cuaDriverLifecycleMessage(error: CuaDriverLifecycleError): string {
  return error.message;
}
