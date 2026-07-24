export type DurableToolEffectState = 'effect_may_have_started' | 'effect_applied_not_durable';

/**
 * T1 is durable, but execution can no longer prove the side effect's outcome.
 * ToolRuntime must leave the operation unsettled for checkpoint reconciliation.
 */
export class DurableToolExecutionUnsettledError extends Error {
  readonly name = 'DurableToolExecutionUnsettledError';
  readonly code = 'DURABLE_TOOL_EXECUTION_UNSETTLED';

  constructor(
    readonly effectState: DurableToolEffectState,
    cause: unknown,
  ) {
    super(`Durable tool execution outcome is unsettled: ${effectState}`, { cause });
  }
}
