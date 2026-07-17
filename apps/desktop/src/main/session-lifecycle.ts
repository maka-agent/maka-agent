export type SessionLifecycleReason = 'archived' | 'removed';

export const SESSION_LIFECYCLE_CODE = 'SESSION_LIFECYCLE';

export class SessionLifecycleError extends Error {
  readonly code = SESSION_LIFECYCLE_CODE;

  constructor(readonly reason: SessionLifecycleReason) {
    super(reason === 'archived' ? 'Session is archived.' : 'Session no longer exists.');
    this.name = 'SessionLifecycleError';
  }
}

export function isSessionLifecycleError(error: unknown): error is SessionLifecycleError {
  return error instanceof SessionLifecycleError
    || (error !== null
      && typeof error === 'object'
      && (error as { code?: unknown }).code === SESSION_LIFECYCLE_CODE
      && ((error as { reason?: unknown }).reason === 'archived'
        || (error as { reason?: unknown }).reason === 'removed'));
}

export function sessionLifecycleErrorFromReadFailure(error: unknown): SessionLifecycleError | undefined {
  if (error !== null && typeof error === 'object'
    && ((error as { code?: unknown }).code === 'ENOENT'
      || (error as { message?: unknown }).message === 'ENOENT')) {
    return new SessionLifecycleError('removed');
  }
  return undefined;
}

export function assertSessionCanSendFromHeader(input: {
  isArchived: boolean;
  status: string;
}): void {
  if (input.isArchived || input.status === 'archived') {
    throw new SessionLifecycleError('archived');
  }
}
