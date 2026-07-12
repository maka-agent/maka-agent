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

const SHELL_RUN_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const PIPE_SHELL_OUTPUT_KEYS = new Set([
  'mode',
  'stdout',
  'stderr',
  'latestStream',
  'stdoutTruncated',
  'stderrTruncated',
  'redacted',
]);
const PTY_SHELL_OUTPUT_KEYS = new Set([
  'mode',
  'screen',
  'scrollback',
  'lastAlternateScreen',
  'cols',
  'rows',
  'cursor',
  'alternateScreen',
  'truncated',
  'redacted',
]);
const PTY_CURSOR_KEYS = new Set(['x', 'y', 'visible']);

export type ShellRunTerminalStatus = typeof SHELL_RUN_TERMINAL_STATUSES[number];
export type ShellMode = 'pipes' | 'pty';

export interface PipeShellOutput {
  mode: 'pipes';
  stdout: string;
  stderr: string;
  latestStream?: 'stdout' | 'stderr';
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  redacted: boolean;
}

export interface PtyShellOutput {
  mode: 'pty';
  screen: string;
  scrollback: string;
  lastAlternateScreen?: string;
  cols: number;
  rows: number;
  cursor: {
    x: number;
    y: number;
    visible: boolean;
  };
  alternateScreen: boolean;
  truncated: boolean;
  redacted: boolean;
}

export type ShellOutput = PipeShellOutput | PtyShellOutput;

export type ShellRunOperation =
  | {
      kind: 'stop';
      applied: boolean;
    }
  | {
      kind: 'pty_control';
      failed: boolean;
      input?: {
        bytes: number;
        applied: boolean;
      };
      resize?: {
        cols: number;
        rows: number;
        applied: boolean;
        changed: boolean;
      };
    };

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
  revision: number;
  observedAt?: number;
  output: ShellOutput;
}

export type ShellRunPatch = Partial<Pick<
  ShellRunRecord,
  | 'status'
  | 'exitCode'
  | 'failureMessage'
  | 'updatedAt'
  | 'completedAt'
  | 'observedAt'
  | 'output'
>>;

export interface ShellRunStore {
  createShellRun(record: ShellRunRecord): Promise<ShellRunRecord>;
  updateShellRun(
    sessionId: string,
    shellRunId: string,
    patch: ShellRunPatch,
  ): Promise<ShellRunRecord>;
  readShellRun(sessionId: string, shellRunId: string): Promise<ShellRunRecord>;
  listSessionShellRuns(sessionId: string): Promise<ShellRunRecord[]>;
}

export function isShellRunStatus(value: unknown): value is ShellRunStatus {
  return typeof value === 'string' && (SHELL_RUN_STATUSES as readonly string[]).includes(value);
}

export function isShellRunId(value: unknown): value is string {
  return typeof value === 'string' && SHELL_RUN_ID_PATTERN.test(value);
}

export function isTerminalShellRunStatus(value: ShellRunStatus): value is ShellRunTerminalStatus {
  return (SHELL_RUN_TERMINAL_STATUSES as readonly string[]).includes(value);
}

export function isShellOutput(value: unknown): value is ShellOutput {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const output = value as Partial<ShellOutput>;
  if (output.mode === 'pipes') {
    return hasOnlyKeys(output, PIPE_SHELL_OUTPUT_KEYS)
      && typeof output.stdout === 'string'
      && typeof output.stderr === 'string'
      && (output.latestStream === undefined
        || output.latestStream === 'stdout'
        || output.latestStream === 'stderr')
      && typeof output.stdoutTruncated === 'boolean'
      && typeof output.stderrTruncated === 'boolean'
      && typeof output.redacted === 'boolean';
  }
  if (output.mode !== 'pty') return false;
  const pty = output as Partial<PtyShellOutput>;
  const cursor = pty.cursor;
  return hasOnlyKeys(pty, PTY_SHELL_OUTPUT_KEYS)
    && typeof pty.screen === 'string'
    && typeof pty.scrollback === 'string'
    && (pty.lastAlternateScreen === undefined || typeof pty.lastAlternateScreen === 'string')
    && isPositiveInteger(pty.cols)
    && isPositiveInteger(pty.rows)
    && !!cursor
    && hasOnlyKeys(cursor, PTY_CURSOR_KEYS)
    && isNonNegativeInteger(cursor.x)
    && cursor.x <= pty.cols
    && isNonNegativeInteger(cursor.y)
    && cursor.y < pty.rows
    && typeof cursor.visible === 'boolean'
    && typeof pty.alternateScreen === 'boolean'
    && typeof pty.truncated === 'boolean'
    && typeof pty.redacted === 'boolean';
}

export function isValidShellRunState(value: {
  status?: unknown;
  completedAt?: unknown;
  exitCode?: unknown;
  failureMessage?: unknown;
  observedAt?: unknown;
}): boolean {
  switch (value.status) {
    case 'running':
      return value.completedAt === undefined
        && value.exitCode === undefined
        && value.failureMessage === undefined
        && value.observedAt === undefined;
    case 'completed':
      return isFiniteNumber(value.completedAt)
        && value.exitCode === 0
        && value.failureMessage === undefined;
    case 'failed':
      return isFiniteNumber(value.completedAt)
        && ((isFiniteNumber(value.exitCode) && value.exitCode !== 0)
          || (value.exitCode === undefined
            && typeof value.failureMessage === 'string'
            && value.failureMessage.length > 0));
    case 'timed_out':
      return isFiniteNumber(value.completedAt) && value.exitCode === 124;
    case 'cancelled':
      return isFiniteNumber(value.completedAt) && value.exitCode === 130;
    case 'orphaned':
      return isFiniteNumber(value.completedAt)
        && value.exitCode === undefined
        && typeof value.failureMessage === 'string'
        && value.failureMessage.length > 0;
    default:
      return false;
  }
}

function hasOnlyKeys(value: object, allowed: ReadonlySet<string>): boolean {
  return Object.keys(value).every((key) => allowed.has(key));
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}
