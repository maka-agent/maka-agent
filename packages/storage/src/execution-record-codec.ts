import {
  decodeAgentRunEvent as decodeCanonicalAgentRunEvent,
  decodeAgentRunHeader as decodeCanonicalAgentRunHeader,
  decodeRuntimeEvent as decodeCanonicalRuntimeEvent,
  decodeStoredMessageForRead,
  decodeStoredMessageForRecovery,
  type AgentRunEvent,
  type AgentRunHeader,
  type RuntimeEvent,
} from '@maka/core';

export { decodeStoredMessageForRead, decodeStoredMessageForRecovery };

export function decodeAgentRunHeader(
  value: unknown,
  expected: { sessionId: string; runId: string },
): AgentRunHeader {
  try {
    const header = decodeCanonicalAgentRunHeader(value);
    if (header.sessionId !== expected.sessionId || header.runId !== expected.runId) {
      throw new Error('AgentRun header identity does not match its path');
    }
    return header;
  } catch (error) {
    throw new Error(`Invalid AgentRun header for run ${expected.runId}: malformed fields`, {
      cause: error,
    });
  }
}

export function decodeAgentRunEvent(
  value: unknown,
  expected: { sessionId: string; runId: string; turnId: string },
): AgentRunEvent {
  const event = decodeCanonicalAgentRunEvent(value);
  if (
    event.sessionId !== expected.sessionId ||
    event.runId !== expected.runId ||
    event.turnId !== expected.turnId
  ) {
    throw new Error('AgentRun event identity does not match its run');
  }
  return event;
}

export function decodeRuntimeEvent(
  value: unknown,
  expected: Pick<AgentRunHeader, 'sessionId' | 'runId' | 'turnId' | 'invocationId'>,
): RuntimeEvent {
  const event = decodeCanonicalRuntimeEvent(value);
  if (
    event.sessionId !== expected.sessionId ||
    event.runId !== expected.runId ||
    event.turnId !== expected.turnId ||
    (expected.invocationId !== undefined && event.invocationId !== expected.invocationId)
  ) {
    throw new Error('RuntimeEvent identity does not match its run');
  }
  return event;
}
