import { invalidProtocolFrame } from './errors.js';
import { requireExactRecord, requireId, requireRecord, requireString } from './codec.js';
import { HOST_STATUS_OPERATION_SPECS } from './host-status.js';
import { INTERACTION_OPERATION_SPECS } from './interaction.js';
import { MESSAGE_OPERATION_SPECS } from './message.js';
import {
  composeOperationSpecMaps,
  type HostOperationError,
  type HostOperationErrorCode,
  type OperationSpec,
} from './operation-spec.js';
import { SESSION_CONTINUITY_OPERATION_SPECS } from './session-continuity.js';
import { TURN_OPERATION_SPECS } from './turn.js';

export { TURN_MESSAGE_TEXT_MAX_BYTES } from './turn.js';

export type {
  InFlightMessageSnapshot,
  MessagePlacement,
  MessageQueueEntrySnapshot,
  QueueRetractInput,
  QueueRetractResult,
  QueuedMessageSnapshot,
  RetractedMessageSnapshot,
  SessionMessageQueueProjection,
  SteeringMessageSnapshot,
  TurnInterruptInput,
  TurnInterruptResult,
  TurnMessageSubmitInput,
  TurnMessageSubmitResult,
} from './message.js';
export type {
  HostLifecycleState,
  HostStatusInput,
  HostStatusResult,
} from './host-status.js';
export type {
  AdmissionClass,
  HostOperationError,
  HostOperationErrorCode,
  OperationMode,
  OperationSpec,
  RetryPolicy,
} from './operation-spec.js';
export type {
  TurnQueryInput,
  TurnRunStatus,
  TurnSnapshot,
  TurnStartInput,
  TurnStopInput,
} from './turn.js';

const HOST_AND_TURN_OPERATION_SPECS = composeOperationSpecMaps(
  HOST_STATUS_OPERATION_SPECS,
  TURN_OPERATION_SPECS,
);

const HOST_TURN_AND_MESSAGE_OPERATION_SPECS = composeOperationSpecMaps(
  HOST_AND_TURN_OPERATION_SPECS,
  MESSAGE_OPERATION_SPECS,
);

const HOST_TURN_MESSAGE_AND_INTERACTION_OPERATION_SPECS = composeOperationSpecMaps(
  HOST_TURN_AND_MESSAGE_OPERATION_SPECS,
  INTERACTION_OPERATION_SPECS,
);

export const HOST_OPERATION_SPECS = composeOperationSpecMaps(
  HOST_TURN_MESSAGE_AND_INTERACTION_OPERATION_SPECS,
  SESSION_CONTINUITY_OPERATION_SPECS,
);

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
    const frame = requireExactRecord(record, 'operation response', [
      'requestId',
      'operation',
      'ok',
      'result',
    ]);
    const requestId = requireId(frame.requestId, 'requestId');
    const operation = requireOperationKey(frame.operation);
    const result = HOST_OPERATION_SPECS[operation].decodeOutput(frame.result);
    return { requestId, operation, ok: true, result } as ResponseFrame;
  }
  if (record.ok === false) {
    const frame = requireExactRecord(record, 'operation response', [
      'requestId',
      'operation',
      'ok',
      'error',
    ]);
    const requestId = requireId(frame.requestId, 'requestId');
    const operation = requireOperationKey(frame.operation);
    const error = decodeOperationError(frame.error, HOST_OPERATION_SPECS[operation].errors);
    return { requestId, operation, ok: false, error } as ResponseFrame;
  }
  throw invalidProtocolFrame('Invalid operation response outcome');
}

export function isOperationKey(value: unknown): value is OperationKey {
  return typeof value === 'string' && Object.hasOwn(HOST_OPERATION_SPECS, value);
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
