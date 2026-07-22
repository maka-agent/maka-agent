import {
  RuntimeInteractionAdmissionRejectedError,
  RuntimeInteractionClosedError,
  RuntimeInteractionFailStopError,
  RuntimeInteractionInvariantError,
  type RuntimeInteractionFatalError,
} from './interaction-authority.js';

export type RuntimeLifecycleError =
  | { kind: 'fail_stop'; error: RuntimeInteractionFailStopError }
  | { kind: 'invariant'; error: RuntimeInteractionInvariantError }
  | { kind: 'admission'; error: RuntimeInteractionAdmissionRejectedError }
  | { kind: 'closure'; error: RuntimeInteractionClosedError }
  | { kind: 'ordinary'; error: unknown };

export function classifyRuntimeLifecycleError(error: unknown): RuntimeLifecycleError {
  if (error instanceof RuntimeInteractionFailStopError) {
    return { kind: 'fail_stop', error };
  }
  if (error instanceof RuntimeInteractionInvariantError) {
    return { kind: 'invariant', error };
  }
  if (error instanceof RuntimeInteractionAdmissionRejectedError) {
    return { kind: 'admission', error };
  }
  if (error instanceof RuntimeInteractionClosedError) {
    return { kind: 'closure', error };
  }
  return { kind: 'ordinary', error };
}

export function isRuntimeLifecycleFatal(error: unknown): error is RuntimeInteractionFatalError {
  const classified = classifyRuntimeLifecycleError(error);
  return classified.kind === 'fail_stop' || classified.kind === 'invariant';
}

export function isRuntimeLifecycleControlError(error: unknown): boolean {
  return classifyRuntimeLifecycleError(error).kind !== 'ordinary';
}

export function isRuntimeLifecycleAdmissionOrFatal(error: unknown): boolean {
  const classified = classifyRuntimeLifecycleError(error);
  return (
    classified.kind === 'admission' ||
    classified.kind === 'fail_stop' ||
    classified.kind === 'invariant'
  );
}

export function isRuntimeLifecycleAdmission(
  error: unknown,
): error is RuntimeInteractionAdmissionRejectedError {
  return classifyRuntimeLifecycleError(error).kind === 'admission';
}

export function isRuntimeLifecycleClosure(error: unknown): error is RuntimeInteractionClosedError {
  return classifyRuntimeLifecycleError(error).kind === 'closure';
}

export function throwIfRuntimeLifecycleFatal(error: unknown): void {
  if (isRuntimeLifecycleFatal(error)) throw error;
}

export function asRuntimeInteractionFailStop(
  message: string,
  error: unknown,
): RuntimeInteractionFailStopError {
  const classified = classifyRuntimeLifecycleError(error);
  if (classified.kind === 'fail_stop') return classified.error;
  return new RuntimeInteractionFailStopError(message, error);
}

export function isTypedRuntimeStopClosure(error: unknown, authorityDraining: boolean): boolean {
  const classified = classifyRuntimeLifecycleError(error);
  if (classified.kind === 'closure') {
    return classified.error.reason === 'turn_stopped';
  }
  if (classified.kind !== 'admission') return false;
  if (classified.error.reason === 'authority_draining') return authorityDraining;
  return (
    classified.error.reason === 'run_closed' && classified.error.closureReason === 'turn_stopped'
  );
}
