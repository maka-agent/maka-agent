export interface InterruptedResumeTurn {
  turnId: string;
  status: string;
  errorClass?: string;
}

export function latestInterruptedResumeTurnId(
  turns: readonly InterruptedResumeTurn[],
): string | undefined {
  const latestTurn = turns.at(-1);
  return latestTurn?.status === 'failed'
    && latestTurn.errorClass?.toLowerCase() === 'app_restarted'
    ? latestTurn.turnId
    : undefined;
}
