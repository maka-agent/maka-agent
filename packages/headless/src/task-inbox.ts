import type { TaskInboxItem, TaskPermissionRequest } from './task-contracts.js';

export function approvalRequestInboxItem(input: {
  inboxItemId: string;
  request: TaskPermissionRequest;
  createdAt: number;
}): TaskInboxItem {
  return {
    schemaVersion: 1,
    inboxItemId: input.inboxItemId,
    taskRunId: input.request.taskRunId,
    attemptId: input.request.attemptId,
    kind: 'approval_request',
    status: 'open',
    title: `Approval required for ${input.request.toolName}`,
    reason: input.request.reason,
    createdAt: input.createdAt,
    expiresAt: input.request.expiresAt,
    relatedRequestId: input.request.requestId,
    preview: {
      toolName: input.request.toolName,
      toolCallId: input.request.toolCallId,
      normalizedArgsHash: input.request.normalizedArgsHash,
      resourceScope: input.request.resourceScope,
      ...input.request.preview,
    },
  };
}

export function budgetExtensionInboxItem(input: {
  inboxItemId: string;
  taskRunId: string;
  attemptId?: string;
  reason: string;
  createdAt: number;
  budget: Record<string, unknown>;
}): TaskInboxItem {
  return {
    schemaVersion: 1,
    inboxItemId: input.inboxItemId,
    taskRunId: input.taskRunId,
    ...(input.attemptId ? { attemptId: input.attemptId } : {}),
    kind: 'budget_extension',
    status: 'open',
    title: 'Budget extension requested',
    reason: input.reason,
    createdAt: input.createdAt,
    preview: { budget: input.budget },
  };
}
