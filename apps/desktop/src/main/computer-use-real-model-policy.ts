import type { ComputerUseToolSet, MakaTool } from '@maka/runtime';

export interface ComputerUseRealModelPolicy {
  allowedActions: readonly string[];
  maxTotalActions: number;
}

export function parseComputerUseRealModelPolicy(
  raw: string | undefined,
): ComputerUseRealModelPolicy | undefined {
  if (!raw) return undefined;
  const value = JSON.parse(raw) as {
    allowedActions?: unknown;
    maxTotalActions?: unknown;
  };
  if (
    !Array.isArray(value.allowedActions)
    || value.allowedActions.length === 0
    || value.allowedActions.some((action) =>
      typeof action !== 'string' || !action.trim())
    || new Set(value.allowedActions).size !== value.allowedActions.length
  ) {
    throw new Error('Invalid Computer Use real-model allowedActions');
  }
  if (
    !Number.isInteger(value.maxTotalActions)
    || (value.maxTotalActions as number) < 1
    || (value.maxTotalActions as number) > 100
  ) {
    throw new Error('Invalid Computer Use real-model maxTotalActions');
  }
  return {
    allowedActions: value.allowedActions,
    maxTotalActions: value.maxTotalActions as number,
  };
}

export function applyComputerUseRealModelPolicy(
  tools: ComputerUseToolSet,
  policy: ComputerUseRealModelPolicy | undefined,
): ComputerUseToolSet {
  if (!policy) return tools;
  let totalActions = 0;
  const allowed = new Set(policy.allowedActions);
  const wrapped = tools.map((tool) => {
    if (tool.name !== 'maka_computer') return tool;
    return {
      ...tool,
      impl: async (args, context) => {
        const action = typeof (args as { action?: unknown })?.action === 'string'
          ? (args as { action: string }).action
          : 'unknown';
        totalActions += 1;
        if (totalActions > policy.maxTotalActions) {
          return {
            text: 'maka_computer failed: total_action_budget_exceeded',
            error: 'total_action_budget_exceeded',
          };
        }
        if (!allowed.has(action)) {
          return {
            text: `maka_computer.${action} failed: unsupported_action_policy`,
            error: 'unsupported_action_policy',
          };
        }
        return tool.impl(args as never, context);
      },
    };
  }) as ComputerUseToolSet;
  wrapped.clearSession = (sessionId) => tools.clearSession(sessionId);
  wrapped.sessionEvents = tools.sessionEvents;
  return wrapped;
}
