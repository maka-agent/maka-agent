export type ExternalHarborBenchmarkFailureKind =
  | 'none'
  | 'agent_incomplete'
  | 'budget_exhausted'
  | 'infra_failure';

export interface ExternalHarborBenchmarkFailureInput {
  status?: unknown;
  errorClass?: unknown;
  error?: unknown;
  taxonomy?: unknown;
}

export interface ExternalHarborBenchmarkFailureClassification {
  kind: ExternalHarborBenchmarkFailureKind;
  shouldThrow: boolean;
  errorClass?: string;
}

const AGENT_INCOMPLETE_CLASSES = new Set([
  'agent_incomplete',
  'failed',
  'incomplete_tool_calls',
  'permission_denied',
  'runtime_error',
  'self_check_failed',
  'tool_failed',
]);

const INFRA_FAILURE_CLASSES = new Set([
  'infra_failed',
  'invalid_setup',
  'isolation_required',
  'setup_failed',
  'unsupported_adapter',
]);

const BUDGET_FAILURE_PATTERNS = [
  'agent_timeout',
  'agenttimeouterror',
  'budget_exhausted',
  'limit',
  'limits_exceeded',
  'max_steps',
  'max_tokens',
  'step cap',
  'timed out',
  'timeout',
  'tool_step_cap',
  'wall time cap',
];

const INCOMPLETE_FAILURE_PATTERNS = [
  'agent_incomplete',
  'incomplete',
  'no_submit',
  'tool_calls',
  'truncated',
];

export function classifyExternalHarborBenchmarkFailure(
  input: ExternalHarborBenchmarkFailureInput | null | undefined,
): ExternalHarborBenchmarkFailureClassification {
  if (!input) return { kind: 'none', shouldThrow: false };
  const status = normalized(input.status);
  if (!status || status === 'completed') return { kind: 'none', shouldThrow: false };

  const errorClass = normalized(input.errorClass);
  const taxonomy = normalized(input.taxonomy);
  const failureText = [status, errorClass, taxonomy, normalized(input.error)]
    .filter(Boolean)
    .join(' ');
  const base = errorClass ? { errorClass } : {};

  if (INFRA_FAILURE_CLASSES.has(errorClass) || INFRA_FAILURE_CLASSES.has(taxonomy)) {
    return { kind: 'infra_failure', shouldThrow: true, ...base };
  }
  if (includesAny(failureText, BUDGET_FAILURE_PATTERNS)) {
    return { kind: 'budget_exhausted', shouldThrow: false, ...base };
  }
  if (
    AGENT_INCOMPLETE_CLASSES.has(errorClass) ||
    AGENT_INCOMPLETE_CLASSES.has(taxonomy) ||
    includesAny(failureText, INCOMPLETE_FAILURE_PATTERNS)
  ) {
    return { kind: 'agent_incomplete', shouldThrow: false, ...base };
  }

  return { kind: 'infra_failure', shouldThrow: true, ...base };
}

function normalized(value: unknown): string {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

function includesAny(value: string, needles: readonly string[]): boolean {
  return needles.some((needle) => value.includes(needle));
}
