export type RestrictedVerificationWorkspaceEffect =
  | 'none'
  | 'local_mutation'
  | 'external_side_effect';

export interface RestrictedVerificationBoundary {
  operationId: string;
  originalToolName: string;
  originalCanonicalArgsHash: string;
  allowedReadOnlyToolNames: readonly string[];
}

export interface RestrictedVerificationRequest {
  toolName: string;
  canonicalArgsHash: string;
  workspaceEffect: RestrictedVerificationWorkspaceEffect;
}

export type RestrictedVerificationDiagnostic =
  | {
      code: 'restricted_verification_violation';
      operationId: string;
      toolName: string;
      reason: 'original_operation_retry' | 'workspace_mutation_forbidden' | 'tool_not_allowlisted';
    }
  | {
      code: 'tool_recovery_observation_failed';
      operationId: string;
      toolName: string;
      reason: 'observation_failed';
    };

export type RestrictedVerificationResult<T> =
  | { status: 'observed'; observation: T }
  | { status: 'blocked'; diagnostic: RestrictedVerificationDiagnostic };

export async function executeRestrictedVerification<T>(input: {
  boundary: RestrictedVerificationBoundary;
  request: RestrictedVerificationRequest;
  execute: () => Promise<T>;
}): Promise<RestrictedVerificationResult<T>> {
  const violation = restrictedVerificationViolation(input.boundary, input.request);
  if (violation) return { status: 'blocked', diagnostic: violation };
  try {
    return { status: 'observed', observation: await input.execute() };
  } catch {
    return {
      status: 'blocked',
      diagnostic: {
        code: 'tool_recovery_observation_failed',
        operationId: input.boundary.operationId,
        toolName: input.request.toolName,
        reason: 'observation_failed',
      },
    };
  }
}

function restrictedVerificationViolation(
  boundary: RestrictedVerificationBoundary,
  request: RestrictedVerificationRequest,
):
  | Extract<RestrictedVerificationDiagnostic, { code: 'restricted_verification_violation' }>
  | undefined {
  let reason:
    | 'original_operation_retry'
    | 'workspace_mutation_forbidden'
    | 'tool_not_allowlisted'
    | undefined;
  if (
    request.toolName === boundary.originalToolName &&
    request.canonicalArgsHash === boundary.originalCanonicalArgsHash
  ) {
    reason = 'original_operation_retry';
  } else if (request.workspaceEffect !== 'none') {
    reason = 'workspace_mutation_forbidden';
  } else if (!boundary.allowedReadOnlyToolNames.includes(request.toolName)) {
    reason = 'tool_not_allowlisted';
  }
  if (!reason) return undefined;
  return {
    code: 'restricted_verification_violation',
    operationId: boundary.operationId,
    toolName: request.toolName,
    reason,
  };
}
