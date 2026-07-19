import type {
  SessionBlockedReason,
  SessionHeader,
  SessionStatus,
  StoredMessage,
  TurnRecord,
  TurnStateMessage,
} from '@maka/core/session';

export type TurnStateLineage = Partial<
  Pick<
    TurnStateMessage,
    | 'parentTurnId'
    | 'retriedFromTurnId'
    | 'regeneratedFromTurnId'
    | 'branchOfTurnId'
    | 'parentSessionId'
  >
>;

export interface BuildTurnStateMessageInput {
  id: string;
  turnId: string;
  ts: number;
  status: TurnRecord['status'];
  lineage?: TurnStateLineage;
  errorClass?: string;
  abortSource?: string;
  partialOutputRetained: boolean;
}

export function buildStatusPatch(
  status: SessionStatus,
  ts: number,
  blockedReason?: SessionBlockedReason,
): Pick<SessionHeader, 'status' | 'blockedReason' | 'statusUpdatedAt'> {
  return {
    status,
    blockedReason: status === 'blocked' ? (blockedReason ?? 'unknown') : undefined,
    statusUpdatedAt: ts,
  };
}

export function buildTurnStateMessage(input: BuildTurnStateMessageInput): TurnStateMessage {
  const lineage = input.lineage ?? {};
  return {
    type: 'turn_state',
    id: input.id,
    turnId: input.turnId,
    ts: input.ts,
    status: input.status,
    ...(lineage.parentTurnId ? { parentTurnId: lineage.parentTurnId } : {}),
    ...(lineage.retriedFromTurnId ? { retriedFromTurnId: lineage.retriedFromTurnId } : {}),
    ...(lineage.regeneratedFromTurnId
      ? { regeneratedFromTurnId: lineage.regeneratedFromTurnId }
      : {}),
    ...(lineage.branchOfTurnId ? { branchOfTurnId: lineage.branchOfTurnId } : {}),
    ...(lineage.parentSessionId ? { parentSessionId: lineage.parentSessionId } : {}),
    ...(input.status === 'aborted' ? { abortedAt: input.ts } : {}),
    ...(input.status === 'aborted' && input.abortSource ? { abortSource: input.abortSource } : {}),
    ...(input.status === 'failed' ? { errorClass: input.errorClass ?? 'unknown' } : {}),
    partialOutputRetained: input.partialOutputRetained,
  };
}

export function turnHasRetainedOutput(messages: readonly StoredMessage[], turnId: string): boolean {
  return messages.some(
    (message) =>
      (message.type === 'assistant' &&
        message.turnId === turnId &&
        message.text.trim().length > 0) ||
      (message.type === 'tool_result' && message.turnId === turnId),
  );
}

export function normalizeStopSessionSource(
  source: 'stop_button' | 'benchmark_deadline' | undefined,
): string | undefined {
  switch (source) {
    case 'stop_button':
      return 'renderer.stop_button';
    case 'benchmark_deadline':
      return 'benchmark.deadline';
    case undefined:
      return undefined;
  }
}
