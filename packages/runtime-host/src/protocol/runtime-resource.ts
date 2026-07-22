import {
  assertAllowedKeys,
  requireCount,
  requireEntityId,
  requireExactRecord,
  requireRecord,
  requireUtf8BoundedString,
} from './codec.js';
import { invalidProtocolFrame } from './errors.js';
import { defineOperation } from './operation-spec.js';

export const RUNTIME_RESOURCE_RESULT_MAX_BYTES = 48 * 1024;
export const RUNTIME_RESOURCE_COMMAND_MAX_BYTES = 8 * 1024;
export const RUNTIME_RESOURCE_CWD_MAX_BYTES = 4 * 1024;
export const RUNTIME_RESOURCE_FAILURE_MAX_BYTES = 4 * 1024;
export const RUNTIME_RESOURCE_OUTPUT_FIELD_MAX_BYTES = 32 * 1024;
export const PTY_INPUT_MAX_BYTES = 16 * 1024;
export const PTY_CURSOR_MAX_BYTES = 512;
export const PTY_CONTROLLER_ID_MAX_BYTES = 128;
export const MIN_PTY_COLS = 2;
export const MAX_PTY_COLS = 240;
export const MIN_PTY_ROWS = 1;
export const MAX_PTY_ROWS = 100;
export const RUNTIME_RESOURCE_REF_PREFIX = 'maka://runtime/background-tasks';

const RUNTIME_RESOURCE_ID_MAX_CHARS = 128;
const RUNTIME_RESOURCE_ID_PATTERN = new RegExp(
  `^[A-Za-z0-9_-]{1,${RUNTIME_RESOURCE_ID_MAX_CHARS}}$`,
);
const RUNTIME_RESOURCE_REF_PATH_PATTERN = /^\/background-tasks\/([^/]+)$/;
const RUNTIME_RESOURCE_STATUSES = [
  'starting',
  'running',
  'completed',
  'failed',
  'timed_out',
  'cancelled',
  'orphaned',
] as const;
const RUNTIME_RESOURCE_TERMINAL_STATUSES = [
  'completed',
  'failed',
  'timed_out',
  'cancelled',
  'orphaned',
] as const;

const QUERY_ERRORS = [
  'host_not_ready',
  'host_draining',
  'operation_unavailable',
  'internal_failure',
  'invalid_request',
  'persistence_failed',
  'not_found',
] as const;
const PTY_ACQUIRE_ERRORS = [...QUERY_ERRORS, 'controller_held', 'resource_terminal'] as const;
const PTY_RELEASE_ERRORS = [...QUERY_ERRORS, 'controller_invalid'] as const;
const PTY_CONTROLLER_ERRORS = [...QUERY_ERRORS, 'controller_invalid', 'resource_terminal'] as const;
const PTY_CONTROL_ERRORS = [...PTY_CONTROLLER_ERRORS, 'outcome_unknown'] as const;

const SHELL_RUN_REQUIRED_FIELDS = [
  'kind',
  'ref',
  'mode',
  'status',
  'cwd',
  'cmd',
  'startedAt',
  'updatedAt',
  'revision',
] as const;
const SHELL_RUN_FIELDS = [
  ...SHELL_RUN_REQUIRED_FIELDS,
  'completedAt',
  'exitCode',
  'failureMessage',
  'timeoutMs',
  'sandboxDenial',
] as const;

export interface RuntimeResourceRefInput {
  readonly sessionId: string;
  readonly ref: string;
}

export type RuntimeResourceStatus = (typeof RUNTIME_RESOURCE_STATUSES)[number];

export type RuntimeResourceTerminalStatus = (typeof RUNTIME_RESOURCE_TERMINAL_STATUSES)[number];

export function isTerminalRuntimeResourceStatus(
  value: RuntimeResourceStatus,
): value is RuntimeResourceTerminalStatus {
  return (RUNTIME_RESOURCE_TERMINAL_STATUSES as readonly string[]).includes(value);
}

export interface RuntimeResourceSandboxDenial {
  readonly likely: true;
  readonly backend?: 'macos-seatbelt' | 'linux';
  readonly recovery: 'require_escalated';
}

interface RuntimeResourceMetadataFields {
  readonly kind: 'shell_run';
  readonly ref: string;
  readonly status: RuntimeResourceStatus;
  readonly cwd: string;
  readonly cmd: string;
  readonly startedAt: number;
  readonly updatedAt: number;
  readonly completedAt?: number;
  readonly exitCode?: number;
  readonly failureMessage?: string;
  readonly revision: number;
  readonly timeoutMs?: number;
  readonly sandboxDenial?: RuntimeResourceSandboxDenial;
}

export type RuntimeResourceMetadata = RuntimeResourceMetadataFields &
  ({ readonly mode: 'pipes' } | { readonly mode: 'pty' });

export interface RuntimeResourcePipeOutput {
  readonly mode: 'pipes';
  readonly stdout: string;
  readonly stderr: string;
  readonly latestStream?: 'stdout' | 'stderr';
  readonly stdoutTruncated: boolean;
  readonly stderrTruncated: boolean;
  readonly redacted: boolean;
}

export interface RuntimeResourcePtyOutput {
  readonly mode: 'pty';
  readonly screen: string;
  readonly scrollback: string;
  readonly lastAlternateScreen?: string;
  readonly cols: number;
  readonly rows: number;
  readonly cursor: {
    readonly x: number;
    readonly y: number;
    readonly visible: boolean;
  };
  readonly alternateScreen: boolean;
  readonly truncated: boolean;
  readonly redacted: boolean;
}

export type RuntimeResourceOutput = RuntimeResourcePipeOutput | RuntimeResourcePtyOutput;

export type RuntimeResourceSnapshot = RuntimeResourceMetadataFields &
  (
    | { readonly mode: 'pipes'; readonly output: RuntimeResourcePipeOutput }
    | { readonly mode: 'pty'; readonly output: RuntimeResourcePtyOutput }
  );

export type RuntimeResourceQueryResult = RuntimeResourceMetadata;
export type RuntimeResourceReadResult = RuntimeResourceSnapshot;
export type RuntimeResourceStopResult = RuntimeResourceSnapshot & {
  readonly status: RuntimeResourceTerminalStatus;
  readonly operation: { readonly kind: 'stop'; readonly applied: boolean };
};

export interface PtyAcquireInput extends RuntimeResourceRefInput {}

export interface PtyAcquireResult {
  readonly controllerId: string;
}

export interface PtyReleaseInput extends RuntimeResourceRefInput {
  readonly controllerId: string;
}

export interface PtyReleaseResult {
  readonly released: true;
}

export type PtyResizeInput = {
  readonly cols: number;
  readonly rows: number;
};

export type PtyControlInput = PtyReleaseInput &
  (
    | { readonly input: string; readonly resize?: PtyResizeInput }
    | { readonly input?: never; readonly resize: PtyResizeInput }
  );

export type PtyInputAdmission = {
  readonly accepted: boolean;
  readonly bytes: number;
};

export type PtyResizeOutcome = {
  readonly applied: boolean;
  readonly changed: boolean;
};

export type PtyControlResult =
  | { readonly input: PtyInputAdmission; readonly resize?: PtyResizeOutcome }
  | { readonly input?: never; readonly resize: PtyResizeOutcome };

export type PtyCursor = string;

export interface PtyReadInput extends RuntimeResourceRefInput {
  /** `null` requests a snapshot; a matching cursor may return unchanged, otherwise the latest snapshot. */
  readonly cursor: PtyCursor | null;
}

export type PtyShellRunMetadata = Extract<RuntimeResourceMetadata, { mode: 'pty' }>;
export type PtyShellRunSnapshot = Extract<RuntimeResourceSnapshot, { mode: 'pty' }>;

export type PtyReadResult =
  | {
      readonly kind: 'snapshot';
      readonly resource: PtyShellRunSnapshot;
      readonly cursor: PtyCursor;
    }
  | {
      readonly kind: 'unchanged';
      readonly resource: PtyShellRunMetadata;
      readonly cursor: PtyCursor;
    };

export const RUNTIME_RESOURCE_OPERATION_SPECS = {
  'resource.query': defineOperation<
    RuntimeResourceRefInput,
    RuntimeResourceQueryResult,
    (typeof QUERY_ERRORS)[number]
  >({
    mode: 'query',
    retry: 'safe',
    admission: 'session',
    errors: QUERY_ERRORS,
    decodeInput: decodeRuntimeResourceRefInput,
    decodeOutput: decodeRuntimeResourceQueryResult,
  }),
  'resource.read': defineOperation<
    RuntimeResourceRefInput,
    RuntimeResourceReadResult,
    (typeof QUERY_ERRORS)[number]
  >({
    mode: 'query',
    retry: 'safe',
    admission: 'session',
    errors: QUERY_ERRORS,
    decodeInput: decodeRuntimeResourceRefInput,
    decodeOutput: decodeRuntimeResourceReadResult,
  }),
  'resource.stop': defineOperation<
    RuntimeResourceRefInput,
    RuntimeResourceStopResult,
    (typeof QUERY_ERRORS)[number]
  >({
    mode: 'command',
    retry: 'safe',
    admission: 'session',
    errors: QUERY_ERRORS,
    decodeInput: decodeRuntimeResourceRefInput,
    decodeOutput: decodeRuntimeResourceStopResult,
  }),
  'pty.acquire': defineOperation<
    PtyAcquireInput,
    PtyAcquireResult,
    (typeof PTY_ACQUIRE_ERRORS)[number]
  >({
    mode: 'control',
    retry: 'none',
    admission: 'session',
    errors: PTY_ACQUIRE_ERRORS,
    decodeInput: decodePtyAcquireInput,
    decodeOutput: decodePtyAcquireResult,
  }),
  'pty.release': defineOperation<
    PtyReleaseInput,
    PtyReleaseResult,
    (typeof PTY_RELEASE_ERRORS)[number]
  >({
    mode: 'control',
    retry: 'none',
    admission: 'session',
    errors: PTY_RELEASE_ERRORS,
    decodeInput: decodePtyReleaseInput,
    decodeOutput: decodePtyReleaseResult,
  }),
  'pty.control': defineOperation<
    PtyControlInput,
    PtyControlResult,
    (typeof PTY_CONTROL_ERRORS)[number]
  >({
    mode: 'control',
    retry: 'none',
    admission: 'session',
    errors: PTY_CONTROL_ERRORS,
    decodeInput: decodePtyControlInput,
    decodeOutput: decodePtyControlResult,
  }),
  'pty.read': defineOperation<PtyReadInput, PtyReadResult, (typeof QUERY_ERRORS)[number]>({
    mode: 'query',
    retry: 'safe',
    admission: 'session',
    errors: QUERY_ERRORS,
    decodeInput: decodePtyReadInput,
    decodeOutput: decodePtyReadResult,
  }),
} as const;

export function decodeRuntimeResourceRefInput(value: unknown): RuntimeResourceRefInput {
  const input = requireExactRecord(value, 'runtime resource input', ['sessionId', 'ref']);
  return decodeResourceRef(input);
}

export function decodeRuntimeResourceQueryResult(value: unknown): RuntimeResourceQueryResult {
  const result = decodeShellRunMetadata(value, 'runtime resource query result');
  assertResultSize(result);
  return result;
}

export function decodeRuntimeResourceReadResult(value: unknown): RuntimeResourceReadResult {
  const result = decodeShellRunSnapshot(value, 'runtime resource read result');
  assertResultSize(result);
  return result;
}

export function decodeRuntimeResourceStopResult(value: unknown): RuntimeResourceStopResult {
  const record = requireRecord(value, 'runtime resource stop result');
  assertAllowedKeys(record, 'runtime resource stop result', [
    ...SHELL_RUN_FIELDS,
    'output',
    'operation',
  ]);
  if (!Object.hasOwn(record, 'output') || !Object.hasOwn(record, 'operation')) {
    throw invalidProtocolFrame('Invalid runtime resource stop result fields');
  }
  const snapshot = decodeShellRunSnapshotFields(record, 'runtime resource stop result');
  const status = snapshot.status;
  if (!isTerminalRuntimeResourceStatus(status)) {
    throw invalidProtocolFrame('Runtime resource stop result is not terminal');
  }
  const operation = requireExactRecord(record.operation, 'runtime resource stop operation', [
    'kind',
    'applied',
  ]);
  if (operation.kind !== 'stop' || typeof operation.applied !== 'boolean') {
    throw invalidProtocolFrame('Invalid runtime resource stop operation');
  }
  const result = {
    ...snapshot,
    status,
    operation: { kind: 'stop' as const, applied: operation.applied },
  } satisfies RuntimeResourceStopResult;
  assertResultSize(result);
  return result;
}

export const encodeRuntimeResourceQueryResult = decodeRuntimeResourceQueryResult;
export const encodeRuntimeResourceReadResult = decodeRuntimeResourceReadResult;
export const encodeRuntimeResourceStopResult = decodeRuntimeResourceStopResult;

export function decodePtyAcquireInput(value: unknown): PtyAcquireInput {
  return decodeRuntimeResourceRefInput(value);
}

export function decodePtyAcquireResult(value: unknown): PtyAcquireResult {
  const result = requireExactRecord(value, 'PTY acquire result', ['controllerId']);
  return { controllerId: controllerId(result.controllerId) };
}

export function decodePtyReleaseInput(value: unknown): PtyReleaseInput {
  const input = requireExactRecord(value, 'PTY release input', [
    'sessionId',
    'ref',
    'controllerId',
  ]);
  return { ...decodeResourceRef(input), controllerId: controllerId(input.controllerId) };
}

export function decodePtyReleaseResult(value: unknown): PtyReleaseResult {
  const result = requireExactRecord(value, 'PTY release result', ['released']);
  if (result.released !== true) throw invalidProtocolFrame('Invalid PTY release result');
  return { released: true };
}

export function decodePtyControlInput(value: unknown): PtyControlInput {
  const input = requireRecord(value, 'PTY control input');
  assertAllowedKeys(input, 'PTY control input', [
    'sessionId',
    'ref',
    'controllerId',
    'input',
    'resize',
  ]);
  if (
    !Object.hasOwn(input, 'sessionId') ||
    !Object.hasOwn(input, 'ref') ||
    !Object.hasOwn(input, 'controllerId') ||
    (!Object.hasOwn(input, 'input') && !Object.hasOwn(input, 'resize'))
  ) {
    throw invalidProtocolFrame('Invalid PTY control input fields');
  }
  const base = {
    ...decodeResourceRef(input),
    controllerId: controllerId(input.controllerId),
  };
  if (Object.hasOwn(input, 'input')) {
    return {
      ...base,
      input: requireWellFormedPtyInput(input.input),
      ...(Object.hasOwn(input, 'resize') ? { resize: decodePtyResize(input.resize) } : {}),
    };
  }
  return { ...base, resize: decodePtyResize(input.resize) };
}

export function decodePtyControlResult(value: unknown): PtyControlResult {
  const result = requireRecord(value, 'PTY control result');
  assertAllowedKeys(result, 'PTY control result', ['input', 'resize']);
  if (!Object.hasOwn(result, 'input') && !Object.hasOwn(result, 'resize')) {
    throw invalidProtocolFrame('Invalid PTY control result fields');
  }
  if (Object.hasOwn(result, 'input')) {
    return {
      input: decodePtyInputAdmission(result.input),
      ...(Object.hasOwn(result, 'resize') ? { resize: decodePtyResizeOutcome(result.resize) } : {}),
    };
  }
  return { resize: decodePtyResizeOutcome(result.resize) };
}

export function decodePtyReadInput(value: unknown): PtyReadInput {
  const input = requireExactRecord(value, 'PTY read input', ['sessionId', 'ref', 'cursor']);
  return {
    ...decodeResourceRef(input),
    cursor: input.cursor === null ? null : ptyCursor(input.cursor),
  };
}

export function decodePtyReadResult(value: unknown): PtyReadResult {
  const result = requireRecord(value, 'PTY read result');
  let decoded: PtyReadResult;
  if (result.kind === 'snapshot') {
    const exact = requireExactRecord(result, 'PTY snapshot result', ['kind', 'resource', 'cursor']);
    decoded = {
      kind: 'snapshot',
      resource: requirePtySnapshot(exact.resource),
      cursor: ptyCursor(exact.cursor),
    };
  } else if (result.kind === 'unchanged') {
    const exact = requireExactRecord(result, 'PTY unchanged result', [
      'kind',
      'resource',
      'cursor',
    ]);
    decoded = {
      kind: 'unchanged',
      resource: requirePtyMetadata(exact.resource),
      cursor: ptyCursor(exact.cursor),
    };
  } else {
    throw invalidProtocolFrame('Invalid PTY read result kind');
  }
  assertResultSize(decoded);
  return decoded;
}

export const encodePtyAcquireResult = decodePtyAcquireResult;
export const encodePtyReleaseResult = decodePtyReleaseResult;
export const encodePtyControlResult = decodePtyControlResult;
export const encodePtyReadResult = decodePtyReadResult;

function decodeResourceRef(record: Record<string, unknown>): RuntimeResourceRefInput {
  const ref = record.ref;
  if (typeof ref !== 'string' || !isRuntimeResourceRef(ref)) {
    throw invalidProtocolFrame('Invalid runtime resource ref');
  }
  return { sessionId: requireEntityId(record.sessionId, 'sessionId'), ref };
}

export function runtimeResourceRef(shellRunId: string): string {
  if (!isRuntimeResourceId(shellRunId)) throw new Error('Invalid shell run id');
  return `${RUNTIME_RESOURCE_REF_PREFIX}/${encodeURIComponent(shellRunId)}`;
}

export function isRuntimeResourceRef(ref: string): boolean {
  return parseRuntimeResourceRef(ref) !== null;
}

function parseRuntimeResourceRef(ref: string): { shellRunId: string } | null {
  let url: URL;
  try {
    url = new URL(ref);
  } catch {
    return null;
  }
  if (
    url.protocol !== 'maka:' ||
    url.hostname !== 'runtime' ||
    url.username ||
    url.password ||
    url.port ||
    url.search ||
    url.hash ||
    ref.length > RUNTIME_RESOURCE_REF_PREFIX.length + 1 + RUNTIME_RESOURCE_ID_MAX_CHARS
  ) {
    return null;
  }
  const encodedId = RUNTIME_RESOURCE_REF_PATH_PATTERN.exec(url.pathname)?.[1];
  if (!encodedId) return null;
  try {
    const shellRunId = decodeURIComponent(encodedId);
    if (!isRuntimeResourceId(shellRunId) || ref !== runtimeResourceRef(shellRunId)) return null;
    return { shellRunId };
  } catch {
    return null;
  }
}

function isRuntimeResourceId(value: unknown): value is string {
  return typeof value === 'string' && RUNTIME_RESOURCE_ID_PATTERN.test(value);
}

function decodeShellRunMetadata(value: unknown, label: string): RuntimeResourceMetadata {
  const record = requireRecord(value, label);
  assertAllowedKeys(record, label, SHELL_RUN_FIELDS);
  return decodeShellRunMetadataFields(record, label);
}

function decodeShellRunSnapshot(value: unknown, label: string): RuntimeResourceSnapshot {
  const record = requireRecord(value, label);
  assertAllowedKeys(record, label, [...SHELL_RUN_FIELDS, 'output']);
  if (!Object.hasOwn(record, 'output')) throw invalidProtocolFrame(`Invalid ${label} fields`);
  return decodeShellRunSnapshotFields(record, label);
}

function decodeShellRunSnapshotFields(
  record: Record<string, unknown>,
  label: string,
): RuntimeResourceSnapshot {
  const metadata = decodeShellRunMetadataFields(record, label);
  if (metadata.mode === 'pipes') {
    return { ...metadata, output: decodePipeOutput(record.output) };
  }
  return { ...metadata, output: decodePtyOutput(record.output) };
}

function decodeShellRunMetadataFields(
  record: Record<string, unknown>,
  label: string,
): RuntimeResourceMetadata {
  if (SHELL_RUN_REQUIRED_FIELDS.some((field) => !Object.hasOwn(record, field))) {
    throw invalidProtocolFrame(`Invalid ${label} fields`);
  }
  if (record.kind !== 'shell_run' || (record.mode !== 'pipes' && record.mode !== 'pty')) {
    throw invalidProtocolFrame(`Invalid ${label} kind or mode`);
  }
  if (
    typeof record.ref !== 'string' ||
    !isRuntimeResourceRef(record.ref) ||
    !isRuntimeResourceStatus(record.status)
  ) {
    throw invalidProtocolFrame(`Invalid ${label} identity or status`);
  }
  const fields: RuntimeResourceMetadataFields = {
    kind: 'shell_run' as const,
    ref: record.ref,
    status: record.status,
    cwd: requireUtf8BoundedString(record.cwd, 'shell run cwd', RUNTIME_RESOURCE_CWD_MAX_BYTES),
    cmd: requireUtf8BoundedString(
      record.cmd,
      'shell run command',
      RUNTIME_RESOURCE_COMMAND_MAX_BYTES,
    ),
    startedAt: finiteNumber(record.startedAt, 'shell run startedAt'),
    updatedAt: finiteNumber(record.updatedAt, 'shell run updatedAt'),
    revision: positiveCount(record.revision, 'shell run revision'),
    ...optionalFiniteNumber(record, 'completedAt'),
    ...optionalFiniteNumber(record, 'exitCode'),
    ...optionalFiniteNumber(record, 'timeoutMs'),
    ...(Object.hasOwn(record, 'failureMessage')
      ? {
          failureMessage: requireUtf8BoundedString(
            record.failureMessage,
            'shell run failureMessage',
            RUNTIME_RESOURCE_FAILURE_MAX_BYTES,
          ),
        }
      : {}),
    ...(Object.hasOwn(record, 'sandboxDenial')
      ? { sandboxDenial: decodeSandboxDenial(record.sandboxDenial) }
      : {}),
  };
  if (!isValidRuntimeResourceState(fields)) throw invalidProtocolFrame(`Invalid ${label} state`);
  return record.mode === 'pipes' ? { ...fields, mode: 'pipes' } : { ...fields, mode: 'pty' };
}

function isRuntimeResourceStatus(value: unknown): value is RuntimeResourceStatus {
  return (
    typeof value === 'string' && (RUNTIME_RESOURCE_STATUSES as readonly string[]).includes(value)
  );
}

function isValidRuntimeResourceState(value: RuntimeResourceMetadataFields): boolean {
  switch (value.status) {
    case 'starting':
    case 'running':
      return (
        value.completedAt === undefined &&
        value.exitCode === undefined &&
        value.failureMessage === undefined
      );
    case 'completed':
      return (
        value.completedAt !== undefined &&
        value.exitCode === 0 &&
        value.failureMessage === undefined
      );
    case 'failed':
      return (
        value.completedAt !== undefined &&
        ((value.exitCode !== undefined && value.exitCode !== 0) ||
          (value.exitCode === undefined &&
            value.failureMessage !== undefined &&
            value.failureMessage.length > 0))
      );
    case 'timed_out':
      return value.completedAt !== undefined && value.exitCode === 124;
    case 'cancelled':
      return value.completedAt !== undefined && value.exitCode === 130;
    case 'orphaned':
      return (
        value.completedAt !== undefined &&
        value.exitCode === undefined &&
        value.failureMessage !== undefined &&
        value.failureMessage.length > 0
      );
  }
}

function decodePipeOutput(value: unknown): RuntimeResourcePipeOutput {
  const output = requireRecord(value, 'pipe shell output');
  assertAllowedKeys(output, 'pipe shell output', [
    'mode',
    'stdout',
    'stderr',
    'latestStream',
    'stdoutTruncated',
    'stderrTruncated',
    'redacted',
  ]);
  for (const field of [
    'mode',
    'stdout',
    'stderr',
    'stdoutTruncated',
    'stderrTruncated',
    'redacted',
  ]) {
    if (!Object.hasOwn(output, field))
      throw invalidProtocolFrame('Invalid pipe shell output fields');
  }
  if (
    output.mode !== 'pipes' ||
    typeof output.stdoutTruncated !== 'boolean' ||
    typeof output.stderrTruncated !== 'boolean' ||
    typeof output.redacted !== 'boolean' ||
    (Object.hasOwn(output, 'latestStream') &&
      output.latestStream !== 'stdout' &&
      output.latestStream !== 'stderr')
  ) {
    throw invalidProtocolFrame('Invalid pipe shell output');
  }
  return {
    mode: 'pipes',
    stdout: boundedStringAllowEmpty(
      output.stdout,
      'shell stdout',
      RUNTIME_RESOURCE_OUTPUT_FIELD_MAX_BYTES,
    ),
    stderr: boundedStringAllowEmpty(
      output.stderr,
      'shell stderr',
      RUNTIME_RESOURCE_OUTPUT_FIELD_MAX_BYTES,
    ),
    ...(Object.hasOwn(output, 'latestStream')
      ? { latestStream: output.latestStream as 'stdout' | 'stderr' }
      : {}),
    stdoutTruncated: output.stdoutTruncated,
    stderrTruncated: output.stderrTruncated,
    redacted: output.redacted,
  };
}

function decodePtyOutput(value: unknown): RuntimeResourcePtyOutput {
  const output = requireRecord(value, 'PTY shell output');
  assertAllowedKeys(output, 'PTY shell output', [
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
  for (const field of [
    'mode',
    'screen',
    'scrollback',
    'cols',
    'rows',
    'cursor',
    'alternateScreen',
    'truncated',
    'redacted',
  ]) {
    if (!Object.hasOwn(output, field))
      throw invalidProtocolFrame('Invalid PTY shell output fields');
  }
  const cols = ptyDimension(output.cols, 'PTY cols', MIN_PTY_COLS, MAX_PTY_COLS);
  const rows = ptyDimension(output.rows, 'PTY rows', MIN_PTY_ROWS, MAX_PTY_ROWS);
  const cursor = requireExactRecord(output.cursor, 'PTY output cursor', ['x', 'y', 'visible']);
  const x = requireCount(cursor.x, 'PTY cursor x');
  const y = requireCount(cursor.y, 'PTY cursor y');
  if (
    output.mode !== 'pty' ||
    x > cols ||
    y >= rows ||
    typeof cursor.visible !== 'boolean' ||
    typeof output.alternateScreen !== 'boolean' ||
    typeof output.truncated !== 'boolean' ||
    typeof output.redacted !== 'boolean'
  ) {
    throw invalidProtocolFrame('Invalid PTY shell output');
  }
  return {
    mode: 'pty',
    screen: boundedStringAllowEmpty(
      output.screen,
      'PTY screen',
      RUNTIME_RESOURCE_OUTPUT_FIELD_MAX_BYTES,
    ),
    scrollback: boundedStringAllowEmpty(
      output.scrollback,
      'PTY scrollback',
      RUNTIME_RESOURCE_OUTPUT_FIELD_MAX_BYTES,
    ),
    ...(Object.hasOwn(output, 'lastAlternateScreen')
      ? {
          lastAlternateScreen: boundedStringAllowEmpty(
            output.lastAlternateScreen,
            'PTY last alternate screen',
            RUNTIME_RESOURCE_OUTPUT_FIELD_MAX_BYTES,
          ),
        }
      : {}),
    cols,
    rows,
    cursor: { x, y, visible: cursor.visible },
    alternateScreen: output.alternateScreen,
    truncated: output.truncated,
    redacted: output.redacted,
  };
}

function decodeSandboxDenial(value: unknown): RuntimeResourceSandboxDenial {
  const denial = requireRecord(value, 'shell run sandbox denial');
  assertAllowedKeys(denial, 'shell run sandbox denial', ['likely', 'backend', 'recovery']);
  if (!Object.hasOwn(denial, 'likely') || !Object.hasOwn(denial, 'recovery')) {
    throw invalidProtocolFrame('Invalid shell run sandbox denial fields');
  }
  if (
    denial.likely !== true ||
    denial.recovery !== 'require_escalated' ||
    (Object.hasOwn(denial, 'backend') &&
      denial.backend !== 'macos-seatbelt' &&
      denial.backend !== 'linux')
  ) {
    throw invalidProtocolFrame('Invalid shell run sandbox denial');
  }
  return {
    likely: true,
    recovery: 'require_escalated',
    ...(Object.hasOwn(denial, 'backend')
      ? { backend: denial.backend as 'macos-seatbelt' | 'linux' }
      : {}),
  };
}

function decodePtyResize(value: unknown): { cols: number; rows: number } {
  const resize = requireExactRecord(value, 'PTY resize', ['cols', 'rows']);
  return {
    cols: ptyDimension(resize.cols, 'PTY resize cols', MIN_PTY_COLS, MAX_PTY_COLS),
    rows: ptyDimension(resize.rows, 'PTY resize rows', MIN_PTY_ROWS, MAX_PTY_ROWS),
  };
}

function decodePtyInputAdmission(value: unknown): PtyInputAdmission {
  const input = requireExactRecord(value, 'PTY input admission', ['accepted', 'bytes']);
  if (typeof input.accepted !== 'boolean')
    throw invalidProtocolFrame('Invalid PTY input admission');
  const bytes = requireCount(input.bytes, 'PTY accepted input bytes');
  if (bytes > PTY_INPUT_MAX_BYTES) throw invalidProtocolFrame('Invalid PTY accepted input bytes');
  return { accepted: input.accepted, bytes };
}

function decodePtyResizeOutcome(value: unknown): PtyResizeOutcome {
  const resize = requireExactRecord(value, 'PTY resize outcome', ['applied', 'changed']);
  if (typeof resize.applied !== 'boolean' || typeof resize.changed !== 'boolean') {
    throw invalidProtocolFrame('Invalid PTY resize outcome');
  }
  if (!resize.applied && resize.changed) throw invalidProtocolFrame('Invalid PTY resize outcome');
  return { applied: resize.applied, changed: resize.changed };
}

function requirePtyMetadata(value: unknown): PtyShellRunMetadata {
  const resource = decodeShellRunMetadata(value, 'PTY resource metadata');
  if (resource.mode !== 'pty') throw invalidProtocolFrame('PTY read returned a pipes resource');
  return resource;
}

function requirePtySnapshot(value: unknown): PtyShellRunSnapshot {
  const resource = decodeShellRunSnapshot(value, 'PTY resource snapshot');
  if (resource.mode !== 'pty') throw invalidProtocolFrame('PTY read returned a pipes resource');
  return resource;
}

function optionalFiniteNumber<Field extends 'completedAt' | 'exitCode' | 'timeoutMs'>(
  record: Record<string, unknown>,
  field: Field,
): Partial<Record<Field, number>> {
  return Object.hasOwn(record, field)
    ? ({ [field]: finiteNumber(record[field], `shell run ${field}`) } as Record<Field, number>)
    : {};
}

function finiteNumber(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw invalidProtocolFrame(`Invalid ${label}`);
  }
  return value;
}

function positiveCount(value: unknown, label: string): number {
  const count = requireCount(value, label);
  if (count === 0) throw invalidProtocolFrame(`Invalid ${label}`);
  return count;
}

function ptyDimension(value: unknown, label: string, min: number, max: number): number {
  const dimension = positiveCount(value, label);
  if (dimension < min || dimension > max) throw invalidProtocolFrame(`Invalid ${label}`);
  return dimension;
}

function controllerId(value: unknown): string {
  return requireUtf8BoundedString(value, 'PTY controllerId', PTY_CONTROLLER_ID_MAX_BYTES);
}

function ptyCursor(value: unknown): PtyCursor {
  return requireUtf8BoundedString(value, 'PTY cursor', PTY_CURSOR_MAX_BYTES);
}

function boundedStringAllowEmpty(value: unknown, label: string, maxBytes: number): string {
  if (typeof value !== 'string' || Buffer.byteLength(value, 'utf8') > maxBytes) {
    throw invalidProtocolFrame(`Invalid ${label}`);
  }
  return value;
}

function requireWellFormedPtyInput(value: unknown): string {
  const input = requireUtf8BoundedString(value, 'PTY input', PTY_INPUT_MAX_BYTES);
  for (let index = 0; index < input.length; index += 1) {
    const codeUnit = input.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      if (index + 1 >= input.length) throw invalidProtocolFrame('Invalid PTY input');
      const next = input.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) {
        throw invalidProtocolFrame('Invalid PTY input');
      }
      index += 1;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      throw invalidProtocolFrame('Invalid PTY input');
    }
  }
  return input;
}

function assertResultSize(value: unknown): void {
  if (Buffer.byteLength(JSON.stringify(value), 'utf8') > RUNTIME_RESOURCE_RESULT_MAX_BYTES) {
    throw invalidProtocolFrame('Runtime resource result exceeds byte limit');
  }
}
