import { invalidProtocolFrame } from './errors.js';

export type HostLifecycleState = 'starting' | 'containing' | 'recovering' | 'ready' | 'draining';
export type OperationMode = 'command' | 'query' | 'control';
export type RetryPolicy = 'none' | 'safe' | 'semantic';
export type AdmissionClass = 'bootstrap' | 'ready' | 'session';

export type HostOperationErrorCode =
  | 'host_not_ready'
  | 'host_draining'
  | 'operation_unavailable'
  | 'not_found'
  | 'session_archived'
  | 'session_busy'
  | 'operation_conflict'
  | 'internal_failure';

export interface HostOperationError<C extends HostOperationErrorCode = HostOperationErrorCode> {
  code: C;
  message: string;
}

export interface OperationSpec<Input, Output, ErrorCode extends HostOperationErrorCode> {
  mode: OperationMode;
  decodeInput(value: unknown): Input;
  decodeOutput(value: unknown): Output;
  errors: readonly ErrorCode[];
  retry: RetryPolicy;
  admission: AdmissionClass;
}

export type HostStatusInput = Record<string, never>;

export interface HostStatusResult {
  hostEpoch: string;
  state: HostLifecycleState;
  connections: number;
  activeOperations: number;
  activeResidencies: number;
}

export interface TurnStartInput {
  sessionId: string;
  turnId: string;
  text: string;
}

export interface TurnQueryInput {
  sessionId: string;
  turnId: string;
}

export interface TurnStopInput {
  sessionId: string;
  turnId: string;
  runId: string;
}

export type TurnRunStatus =
  | 'admitted'
  | 'created'
  | 'running'
  | 'waiting_permission'
  | 'completed'
  | 'failed'
  | 'cancelled';

interface TurnSnapshotBase {
  sessionId: string;
  turnId: string;
  runId: string;
}

export type TurnSnapshot =
  | (TurnSnapshotBase & {
      status: Exclude<TurnRunStatus, 'completed' | 'failed' | 'cancelled'>;
    })
  | (TurnSnapshotBase & { status: 'completed'; terminalEventId: string })
  | (TurnSnapshotBase & {
      status: 'failed';
      terminalEventId: string;
      failureClass: string;
    })
  | (TurnSnapshotBase & {
      status: 'cancelled';
      terminalEventId: string;
      abortSource: string;
    });

function defineOperation<Input, Output, ErrorCode extends HostOperationErrorCode>(
  spec: OperationSpec<Input, Output, ErrorCode>,
): OperationSpec<Input, Output, ErrorCode> {
  return spec;
}

export const HOST_OPERATION_SPECS = {
  'host.status': defineOperation({
    mode: 'query',
    decodeInput: decodeHostStatusInput,
    decodeOutput: decodeHostStatusResult,
    errors: ['host_draining', 'internal_failure'] as const,
    retry: 'safe',
    admission: 'bootstrap',
  }),
  'turn.start': defineOperation({
    mode: 'command',
    decodeInput: decodeTurnStartInput,
    decodeOutput: decodeTurnSnapshot,
    errors: [
      'host_not_ready',
      'host_draining',
      'operation_unavailable',
      'not_found',
      'session_archived',
      'session_busy',
      'operation_conflict',
      'internal_failure',
    ] as const,
    retry: 'semantic',
    admission: 'session',
  }),
  'turn.query': defineOperation({
    mode: 'query',
    decodeInput: decodeTurnQueryInput,
    decodeOutput: decodeTurnSnapshot,
    errors: [
      'host_not_ready',
      'host_draining',
      'operation_unavailable',
      'not_found',
      'internal_failure',
    ] as const,
    retry: 'safe',
    admission: 'ready',
  }),
  'turn.stop': defineOperation({
    mode: 'control',
    decodeInput: decodeTurnStopInput,
    decodeOutput: decodeTurnSnapshot,
    errors: [
      'host_not_ready',
      'host_draining',
      'operation_unavailable',
      'not_found',
      'operation_conflict',
      'internal_failure',
    ] as const,
    retry: 'semantic',
    admission: 'session',
  }),
} as const;

export type OperationSpecMap = typeof HOST_OPERATION_SPECS;
export type OperationKey = keyof OperationSpecMap;

type InferInput<Spec> =
  Spec extends OperationSpec<infer Input, unknown, HostOperationErrorCode> ? Input : never;
type InferOutput<Spec> =
  Spec extends OperationSpec<unknown, infer Output, HostOperationErrorCode> ? Output : never;
type InferErrorCode<Spec> =
  Spec extends OperationSpec<unknown, unknown, infer ErrorCode> ? ErrorCode : never;

export type OperationInput<K extends OperationKey> = InferInput<OperationSpecMap[K]>;
export type OperationOutput<K extends OperationKey> = InferOutput<OperationSpecMap[K]>;
export type OperationError<K extends OperationKey> = HostOperationError<
  InferErrorCode<OperationSpecMap[K]>
>;

export type RequestFrameFor<K extends OperationKey> = {
  requestId: string;
  operation: K;
  input: OperationInput<K>;
};

export type ResponseFrameFor<K extends OperationKey> =
  | { requestId: string; operation: K; ok: true; result: OperationOutput<K> }
  | { requestId: string; operation: K; ok: false; error: OperationError<K> };

export type OperationOutcome<K extends OperationKey> =
  | { ok: true; result: OperationOutput<K> }
  | { ok: false; error: OperationError<K> };

export type RequestFrame = {
  [K in OperationKey]: RequestFrameFor<K>;
}[OperationKey];
export type ResponseFrame = {
  [K in OperationKey]: ResponseFrameFor<K>;
}[OperationKey];

export function decodeRequestFrame(value: unknown): RequestFrame {
  const frame = requireExactRecord(value, 'operation request', ['requestId', 'operation', 'input']);
  const requestId = requireId(frame.requestId, 'requestId');
  const operation = requireOperationKey(frame.operation);
  const spec = HOST_OPERATION_SPECS[operation];
  const input = spec.decodeInput(frame.input);
  return { requestId, operation, input } as RequestFrame;
}

export function decodeResponseFrame(value: unknown): ResponseFrame {
  const record = requireRecord(value, 'operation response');
  if (record.ok === true) {
    assertExactKeys(record, 'operation response', ['requestId', 'operation', 'ok', 'result']);
    const requestId = requireId(record.requestId, 'requestId');
    const operation = requireOperationKey(record.operation);
    const result = HOST_OPERATION_SPECS[operation].decodeOutput(record.result);
    return { requestId, operation, ok: true, result } as ResponseFrame;
  }
  if (record.ok === false) {
    assertExactKeys(record, 'operation response', ['requestId', 'operation', 'ok', 'error']);
    const requestId = requireId(record.requestId, 'requestId');
    const operation = requireOperationKey(record.operation);
    const error = decodeOperationError(record.error, HOST_OPERATION_SPECS[operation].errors);
    return { requestId, operation, ok: false, error } as ResponseFrame;
  }
  throw invalidProtocolFrame('Invalid operation response outcome');
}

export function isOperationKey(value: unknown): value is OperationKey {
  return typeof value === 'string' && Object.hasOwn(HOST_OPERATION_SPECS, value);
}

function decodeHostStatusInput(value: unknown): HostStatusInput {
  requireExactRecord(value, 'host.status input', []);
  return {};
}

function decodeHostStatusResult(value: unknown): HostStatusResult {
  const record = requireExactRecord(value, 'host.status result', [
    'hostEpoch',
    'state',
    'connections',
    'activeOperations',
    'activeResidencies',
  ]);
  return {
    hostEpoch: requireId(record.hostEpoch, 'hostEpoch'),
    state: requireHostState(record.state),
    connections: requireCount(record.connections, 'connections'),
    activeOperations: requireCount(record.activeOperations, 'activeOperations'),
    activeResidencies: requireCount(record.activeResidencies, 'activeResidencies'),
  };
}

function decodeTurnStartInput(value: unknown): TurnStartInput {
  const record = requireExactRecord(value, 'turn.start input', ['sessionId', 'turnId', 'text']);
  return {
    sessionId: requireEntityId(record.sessionId, 'sessionId'),
    turnId: requireEntityId(record.turnId, 'turnId'),
    text: requireString(record.text, 'text', 48 * 1024),
  };
}

function decodeTurnQueryInput(value: unknown): TurnQueryInput {
  const record = requireExactRecord(value, 'turn.query input', ['sessionId', 'turnId']);
  return {
    sessionId: requireEntityId(record.sessionId, 'sessionId'),
    turnId: requireEntityId(record.turnId, 'turnId'),
  };
}

function decodeTurnStopInput(value: unknown): TurnStopInput {
  const record = requireExactRecord(value, 'turn.stop input', ['sessionId', 'turnId', 'runId']);
  return {
    sessionId: requireEntityId(record.sessionId, 'sessionId'),
    turnId: requireEntityId(record.turnId, 'turnId'),
    runId: requireEntityId(record.runId, 'runId'),
  };
}

function decodeTurnSnapshot(value: unknown): TurnSnapshot {
  const record = requireRecord(value, 'Turn snapshot');
  const base = {
    sessionId: requireEntityId(record.sessionId, 'sessionId'),
    turnId: requireEntityId(record.turnId, 'turnId'),
    runId: requireEntityId(record.runId, 'runId'),
  };
  const status = requireTurnRunStatus(record.status);
  if (status === 'completed') {
    assertExactKeys(record, 'completed Turn snapshot', [
      'sessionId',
      'turnId',
      'runId',
      'status',
      'terminalEventId',
    ]);
    return {
      ...base,
      status,
      terminalEventId: requireId(record.terminalEventId, 'terminalEventId'),
    };
  }
  if (status === 'failed') {
    assertExactKeys(record, 'failed Turn snapshot', [
      'sessionId',
      'turnId',
      'runId',
      'status',
      'terminalEventId',
      'failureClass',
    ]);
    return {
      ...base,
      status,
      terminalEventId: requireId(record.terminalEventId, 'terminalEventId'),
      failureClass: requireString(record.failureClass, 'failureClass', 128),
    };
  }
  if (status === 'cancelled') {
    assertExactKeys(record, 'cancelled Turn snapshot', [
      'sessionId',
      'turnId',
      'runId',
      'status',
      'terminalEventId',
      'abortSource',
    ]);
    return {
      ...base,
      status,
      terminalEventId: requireId(record.terminalEventId, 'terminalEventId'),
      abortSource: requireString(record.abortSource, 'abortSource', 128),
    };
  }
  assertExactKeys(record, 'non-terminal Turn snapshot', ['sessionId', 'turnId', 'runId', 'status']);
  return { ...base, status };
}

function decodeOperationError<C extends HostOperationErrorCode>(
  value: unknown,
  allowedCodes: readonly C[],
): HostOperationError<C> {
  const record = requireExactRecord(value, 'operation error', ['code', 'message']);
  if (typeof record.code !== 'string' || !allowedCodes.includes(record.code as C)) {
    throw invalidProtocolFrame('Operation returned an undeclared error code');
  }
  return {
    code: record.code as C,
    message: requireString(record.message, 'operation error message', 1024),
  };
}

function requireOperationKey(value: unknown): OperationKey {
  if (!isOperationKey(value)) throw invalidProtocolFrame('Unknown operation key');
  return value;
}

function requireHostState(value: unknown): HostLifecycleState {
  if (
    value === 'starting' ||
    value === 'containing' ||
    value === 'recovering' ||
    value === 'ready' ||
    value === 'draining'
  )
    return value;
  throw invalidProtocolFrame('Invalid Host state');
}

function requireTurnRunStatus(value: unknown): TurnRunStatus {
  if (
    value === 'admitted' ||
    value === 'created' ||
    value === 'running' ||
    value === 'waiting_permission' ||
    value === 'completed' ||
    value === 'failed' ||
    value === 'cancelled'
  )
    return value;
  throw invalidProtocolFrame('Invalid Turn run status');
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw invalidProtocolFrame(`Invalid ${label}`);
  }
  return value as Record<string, unknown>;
}

function requireExactRecord(
  value: unknown,
  label: string,
  keys: readonly string[],
): Record<string, unknown> {
  const record = requireRecord(value, label);
  assertExactKeys(record, label, keys);
  return record;
}

function assertExactKeys(
  record: Record<string, unknown>,
  label: string,
  keys: readonly string[],
): void {
  assertAllowedKeys(record, label, keys);
  if (
    Object.keys(record).length !== keys.length ||
    keys.some((key) => !Object.hasOwn(record, key))
  ) {
    throw invalidProtocolFrame(`Invalid ${label} fields`);
  }
}

function assertAllowedKeys(
  record: Record<string, unknown>,
  label: string,
  keys: readonly string[],
): void {
  const allowed = new Set(keys);
  if (Object.keys(record).some((key) => !allowed.has(key))) {
    throw invalidProtocolFrame(`Unknown ${label} field`);
  }
}

function requireString(value: unknown, label: string, maxLength: number): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > maxLength) {
    throw invalidProtocolFrame(`Invalid ${label}`);
  }
  return value;
}

function requireId(value: unknown, label: string): string {
  return requireString(value, label, 128);
}

function requireEntityId(value: unknown, label: string): string {
  const id = requireId(value, label);
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(id)) throw invalidProtocolFrame(`Invalid ${label}`);
  return id;
}

function requireCount(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw invalidProtocolFrame(`Invalid ${label}`);
  }
  return value as number;
}
