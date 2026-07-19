import {
  HOST_OPERATION_SPECS,
  type ClientSurface,
  type HostOperationErrorCode,
  type OperationInput,
  type OperationKey,
  type OperationOutcome,
  type RequestFrame,
  type RequestFrameFor,
  type ResponseFrame,
  type ResponseFrameFor,
} from '../protocol/index.js';

export interface ConnectionContext {
  hostEpoch: string;
  connectionId: string;
  surface: ClientSurface;
  principal: 'local_os_user';
  acquireResidency(): OperationResidency;
}

export interface OperationResidency {
  release(): void;
}

export type OperationHandler<K extends OperationKey> = (
  input: OperationInput<K>,
  context: ConnectionContext,
) => Promise<OperationOutcome<K>>;

export type OperationHandlerMap = {
  [K in OperationKey]: OperationHandler<K>;
};

export type DomainOperationKey = Exclude<OperationKey, 'host.status'>;
export type DomainOperationHandlerMap = Pick<OperationHandlerMap, DomainOperationKey>;

export async function dispatchOperation(
  request: RequestFrame,
  handlers: OperationHandlerMap,
  context: ConnectionContext,
): Promise<ResponseFrame> {
  return dispatchTypedOperation(
    request as RequestFrameFor<OperationKey>,
    handlers,
    context,
  ) as Promise<ResponseFrame>;
}

export function operationFailureResponse(
  request: RequestFrame,
  code: HostOperationErrorCode,
  message: string,
): ResponseFrame {
  const declaredErrors = HOST_OPERATION_SPECS[request.operation]
    .errors as readonly HostOperationErrorCode[];
  if (!declaredErrors.includes(code)) {
    throw new Error(`${request.operation} does not declare ${code}`);
  }
  return {
    requestId: request.requestId,
    operation: request.operation,
    ok: false,
    error: { code, message },
  } as ResponseFrame;
}

async function dispatchTypedOperation<K extends OperationKey>(
  request: RequestFrameFor<K>,
  handlers: OperationHandlerMap,
  context: ConnectionContext,
): Promise<ResponseFrameFor<K>> {
  const handler = handlers[request.operation] as OperationHandler<K>;
  let outcome: OperationOutcome<K>;
  try {
    outcome = await handler(request.input, context);
  } catch {
    return operationFailureResponse(
      request as RequestFrame,
      'internal_failure',
      'Runtime Host operation failed',
    ) as ResponseFrameFor<K>;
  }
  return outcome.ok
    ? {
        requestId: request.requestId,
        operation: request.operation,
        ok: true,
        result: outcome.result,
      }
    : {
        requestId: request.requestId,
        operation: request.operation,
        ok: false,
        error: outcome.error,
      };
}
