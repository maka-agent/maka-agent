import type { LlmConnection } from '@maka/core/llm-connections';
import { buildDefaultContextBudgetPolicy } from '@maka/runtime';
import type { ContextBudgetPolicy } from '@maka/runtime';

export function buildContextBudgetPolicy(connection: LlmConnection): ContextBudgetPolicy | undefined {
  return buildDefaultContextBudgetPolicy(connection, { name: 'desktop-default-history-budget' });
}
