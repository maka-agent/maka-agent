export const SHELL_RUN_STATUSES = [
  'running',
  'completed',
  'failed',
  'timed_out',
  'cancelled',
  'orphaned',
] as const;

export type ShellRunStatus = typeof SHELL_RUN_STATUSES[number];

export const SHELL_RUN_TERMINAL_STATUSES = [
  'completed',
  'failed',
  'timed_out',
  'cancelled',
  'orphaned',
] as const;

export type ShellRunTerminalStatus = typeof SHELL_RUN_TERMINAL_STATUSES[number];

export interface ShellRunRecord {
  shellRunId: string;
  sessionId: string;
  sourceRunId?: string;
  sourceTurnId: string;
  sourceToolCallId: string;
  cwd: string;
  command: string;
  status: ShellRunStatus;
  exitCode?: number;
  failureMessage?: string;
  startedAt: number;
  updatedAt: number;
  completedAt?: number;
  timeoutMs?: number;
  stdoutTail: string;
  stderrTail: string;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  observedAt?: number;
  orphanedReason?: string;
  pid?: number;
}

export interface ShellRunStore {
  createShellRun(record: ShellRunRecord): Promise<ShellRunRecord>;
  updateShellRun(
    sessionId: string,
    shellRunId: string,
    patch: Partial<ShellRunRecord>,
  ): Promise<ShellRunRecord>;
  readShellRun(sessionId: string, shellRunId: string): Promise<ShellRunRecord>;
  listSessionShellRuns(sessionId: string): Promise<ShellRunRecord[]>;
}

export function isShellRunStatus(value: unknown): value is ShellRunStatus {
  return typeof value === 'string' && (SHELL_RUN_STATUSES as readonly string[]).includes(value);
}

export function isTerminalShellRunStatus(value: ShellRunStatus): value is ShellRunTerminalStatus {
  return (SHELL_RUN_TERMINAL_STATUSES as readonly string[]).includes(value);
}
