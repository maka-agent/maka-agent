import type { AgentRunEvent, AgentRunHeader } from '@maka/core';
import type { StoredMessage } from '@maka/core/session';
import type { UserMessageInput } from '@maka/core/runtime-inputs';

export interface AgentRunRecoveryDecision {
  runId: string;
  turnId: string;
  status: 'failed' | 'completed';
  failureClass?: string;
  diagnostic?: Record<string, unknown>;
  lineage: Partial<Pick<
    UserMessageInput,
    'parentTurnId' | 'retriedFromTurnId' | 'regeneratedFromTurnId' | 'branchOfTurnId' | 'parentSessionId'
  >>;
}

export function classifyAgentRunRecovery(
  header: AgentRunHeader,
  events: readonly AgentRunEvent[],
  sessionMessages: readonly StoredMessage[],
): AgentRunRecoveryDecision | undefined {
  if (isTerminalRunStatus(header.status)) return undefined;

  const lastEvent = lastNonCorruptEvent(events);
  const hasCorruptEvent = events.some((event) => event.type === 'event_corrupt');
  const lastEventType = lastEvent?.type;
  const lastTurnState = latestTurnState(sessionMessages, header.turnId);
  const hasAssistantOutput = sessionMessages.some((message) =>
    message.type === 'assistant' && message.turnId === header.turnId && message.text.trim().length > 0,
  );
  const hasToolOutput = sessionMessages.some((message) =>
    message.type === 'tool_result' && message.turnId === header.turnId,
  );

  if (lastEventType === 'model_stream_completed' && !hasTerminalRunEvent(events)) {
    if (hasAssistantOutput || lastTurnState?.status === 'completed') {
      return {
        runId: header.runId,
        turnId: header.turnId,
        status: 'completed',
        diagnostic: diagnostic('stale_completed_run', lastEventType, hasCorruptEvent),
        lineage: headerLineage(header),
      };
    }
    return failedDecision(header, 'app_restarted', diagnostic('model_stream_completed_without_projection', lastEventType, hasCorruptEvent));
  }

  if (
    header.status === 'waiting_permission' ||
    lastEventType === 'permission_requested' ||
    lastEventType === 'permission_failed'
  ) {
    return failedDecision(header, 'app_restarted', diagnostic('stale_permission_wait', lastEventType, hasCorruptEvent));
  }

  if (lastEventType === 'tool_started') {
    return failedDecision(
      header,
      'app_restarted',
      diagnostic('tool_interrupted', lastEventType, hasCorruptEvent, { partialOutputRetained: hasToolOutput }),
    );
  }

  if (
    header.status === 'created' ||
    header.status === 'running' ||
    lastEventType === undefined ||
    lastEventType === 'run_created' ||
    lastEventType === 'run_started' ||
    lastEventType === 'turn_started' ||
    lastEventType === 'model_resolved' ||
    lastEventType === 'model_stream_started' ||
    lastEventType === 'run_status_changed'
  ) {
    return failedDecision(header, 'app_restarted', diagnostic('run_interrupted', lastEventType, hasCorruptEvent));
  }

  return failedDecision(header, 'app_restarted', diagnostic('non_terminal_run_recovered', lastEventType, hasCorruptEvent));
}

function failedDecision(
  header: AgentRunHeader,
  failureClass: string,
  diagnostic?: Record<string, unknown>,
): AgentRunRecoveryDecision {
  return {
    runId: header.runId,
    turnId: header.turnId,
    status: 'failed',
    failureClass,
    diagnostic,
    lineage: headerLineage(header),
  };
}

function isTerminalRunStatus(status: AgentRunHeader['status']): boolean {
  return status === 'completed' || status === 'failed' || status === 'cancelled';
}

function hasTerminalRunEvent(events: readonly AgentRunEvent[]): boolean {
  return events.some((event) =>
    event.type === 'run_completed' ||
    event.type === 'run_failed' ||
    event.type === 'run_cancelled',
  );
}

function lastNonCorruptEvent(events: readonly AgentRunEvent[]): AgentRunEvent | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event && event.type !== 'event_corrupt') return event;
  }
  return undefined;
}

function latestTurnState(
  messages: readonly StoredMessage[],
  turnId: string,
): Extract<StoredMessage, { type: 'turn_state' }> | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.type === 'turn_state' && message.turnId === turnId) return message;
  }
  return undefined;
}

function diagnostic(
  reason: string,
  lastEventType: AgentRunEvent['type'] | undefined,
  hasCorruptEvent: boolean,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    recoveryReason: reason,
    ...(lastEventType ? { lastEventType } : {}),
    ...(hasCorruptEvent ? { eventCorrupt: true } : {}),
    ...extra,
  };
}

function headerLineage(
  header: AgentRunHeader,
): Partial<Pick<UserMessageInput, 'parentTurnId' | 'retriedFromTurnId' | 'regeneratedFromTurnId' | 'branchOfTurnId' | 'parentSessionId'>> {
  return {
    ...(header.parentTurnId ? { parentTurnId: header.parentTurnId } : {}),
    ...(header.retriedFromTurnId ? { retriedFromTurnId: header.retriedFromTurnId } : {}),
    ...(header.regeneratedFromTurnId ? { regeneratedFromTurnId: header.regeneratedFromTurnId } : {}),
    ...(header.branchOfTurnId ? { branchOfTurnId: header.branchOfTurnId } : {}),
    ...(header.parentSessionId ? { parentSessionId: header.parentSessionId } : {}),
  };
}
