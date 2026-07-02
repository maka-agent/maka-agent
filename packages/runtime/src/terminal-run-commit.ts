import type { AgentRunEvent, AgentRunHeader, AgentRunStore, RuntimeEvent, RuntimeEventStore } from '@maka/core';

export type TerminalAgentRunStatus = Extract<AgentRunHeader['status'], 'completed' | 'failed' | 'cancelled'>;

export interface CommitTerminalRunWithRuntimeFactInput {
  runStore: AgentRunStore;
  runtimeEventStore?: RuntimeEventStore;
  newId: () => string;
  sessionId: string;
  runId: string;
  turnId: string;
  status: TerminalAgentRunStatus;
  ts: number;
  terminalEvent?: RuntimeEvent;
  terminalEventAlreadyPersisted?: boolean;
  failureClass?: string;
  failureMessage?: string;
  abortSource?: string;
  runEventData?: Record<string, unknown>;
  runEventMessage?: string;
  existingEvents?: readonly Pick<AgentRunEvent, 'type'>[];
}

export async function commitTerminalRunWithRuntimeFact(
  input: CommitTerminalRunWithRuntimeFactInput,
): Promise<void> {
  if (!input.terminalEventAlreadyPersisted) {
    if (!input.runtimeEventStore || !input.terminalEvent) {
      throw new Error('terminal RuntimeEvent must be persisted before terminal run header');
    }
    await input.runtimeEventStore.appendRuntimeEvent(input.sessionId, input.runId, input.terminalEvent);
  }

  const failureClass = input.status === 'failed' ? input.failureClass ?? 'unknown' : undefined;
  const abortSource = input.status === 'cancelled' ? input.abortSource : undefined;
  await input.runStore.updateRun(input.sessionId, input.runId, {
    status: input.status,
    updatedAt: input.ts,
    completedAt: input.ts,
    ...(failureClass ? { failureClass } : {}),
    ...(input.failureMessage ? { failureMessage: input.failureMessage } : {}),
    ...(abortSource ? { abortSource } : {}),
  });

  if (hasTerminalAgentRunEvent(input.existingEvents ?? [])) return;
  const data = terminalRunEventData(input.status, failureClass, input.runEventData);
  await input.runStore.appendEvent(input.sessionId, input.runId, {
    type: terminalAgentRunEventType(input.status),
    id: input.newId(),
    runId: input.runId,
    sessionId: input.sessionId,
    turnId: input.turnId,
    ts: input.ts,
    ...(input.runEventMessage ? { message: input.runEventMessage } : {}),
    ...(Object.keys(data).length > 0 ? { data } : {}),
  });
}

export interface BuildRecoveredTerminalRuntimeEventInput {
  id: string;
  run: Pick<AgentRunHeader, 'runId' | 'sessionId' | 'turnId'>;
  status: TerminalAgentRunStatus;
  ts: number;
  invocationId?: string;
  failureClass?: string;
  abortSource?: string;
  recoveryReason: string;
  diagnostic?: Record<string, unknown>;
  message?: string;
}

export function buildRecoveredTerminalRuntimeEvent(
  input: BuildRecoveredTerminalRuntimeEventInput,
): RuntimeEvent {
  const failureClass = input.status === 'failed' ? input.failureClass ?? 'unknown' : undefined;
  const abortSource = input.status === 'cancelled' ? input.abortSource ?? 'unknown' : undefined;
  return {
    id: input.id,
    invocationId: input.invocationId ?? `recovery-${input.run.runId}`,
    runId: input.run.runId,
    sessionId: input.run.sessionId,
    turnId: input.run.turnId,
    ts: input.ts,
    partial: false,
    role: 'system',
    author: 'system',
    status: input.status === 'cancelled' ? 'aborted' : input.status,
    ...(failureClass
      ? {
          content: {
            kind: 'error',
            code: failureClass,
            reason: failureClass,
            message: input.message ?? failureClass,
          },
        }
      : {}),
    actions: {
      endInvocation: true,
      stateDelta: {
        recovered: true,
        recoveryReason: input.recoveryReason,
        ...(input.diagnostic ?? {}),
        ...(failureClass ? { failureClass } : {}),
        ...(abortSource ? { abortSource } : {}),
      },
    },
  };
}

export function hasTerminalAgentRunEvent(events: readonly Pick<AgentRunEvent, 'type'>[]): boolean {
  return events.some((event) =>
    event.type === 'run_completed' ||
    event.type === 'run_failed' ||
    event.type === 'run_cancelled'
  );
}

function terminalAgentRunEventType(status: TerminalAgentRunStatus): AgentRunEvent['type'] {
  if (status === 'cancelled') return 'run_cancelled';
  if (status === 'failed') return 'run_failed';
  return 'run_completed';
}

function terminalRunEventData(
  status: TerminalAgentRunStatus,
  failureClass: string | undefined,
  runEventData: Record<string, unknown> | undefined,
): Record<string, unknown> {
  return {
    ...(status === 'failed' && failureClass ? { failureClass } : {}),
    ...(runEventData ?? {}),
  };
}
