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
export type TurnOperationKey = Extract<OperationKey, 'turn.start' | 'turn.query' | 'turn.stop'>;
export type MessageOperationKey = Extract<
  OperationKey,
  'turn.message.submit' | 'queue.retract' | 'turn.interrupt'
>;
export type SessionContinuityOperationKey = Extract<OperationKey, `subscription.${string}`>;
export type InteractionOperationKey = Extract<OperationKey, `interaction.${string}`>;
export type RuntimePolicyOperationKey = Extract<
  OperationKey,
  `runtime.policy.${string}` | `connection.catalog.${string}` | `credential.vault.${string}`
>;
export type SkillCatalogOperationKey = Extract<OperationKey, `skill.catalog.${string}`>;
export type TaskLedgerOperationKey = Extract<OperationKey, 'task.ledger.query'>;
export type ArtifactOperationKey = Extract<OperationKey, `artifact.${string}`>;
export type MemoryOperationKey = Extract<OperationKey, `memory.${string}`>;
export type RuntimeResourceOperationKey = Extract<
  OperationKey,
  `resource.${string}` | `pty.${string}`
>;
export type UsagePricingOperationKey = Extract<OperationKey, 'usage.query' | `pricing.${string}`>;
export type TurnOperationHandlerMap = Pick<OperationHandlerMap, TurnOperationKey>;
export type MessageOperationHandlerMap = Pick<OperationHandlerMap, MessageOperationKey>;
export type AllDomainOperationHandlerMap = Pick<OperationHandlerMap, DomainOperationKey>;
export type SessionContinuityOperationHandlerMap = Pick<
  OperationHandlerMap,
  SessionContinuityOperationKey
>;
export type InteractionOperationHandlerMap = Pick<OperationHandlerMap, InteractionOperationKey>;
export type RuntimePolicyOperationHandlerMap = Pick<OperationHandlerMap, RuntimePolicyOperationKey>;
export type SkillCatalogOperationHandlerMap = Pick<OperationHandlerMap, SkillCatalogOperationKey>;
export type TaskLedgerOperationHandlerMap = Pick<OperationHandlerMap, TaskLedgerOperationKey>;
export type ArtifactOperationHandlerMap = Pick<OperationHandlerMap, ArtifactOperationKey>;
export type MemoryOperationHandlerMap = Pick<OperationHandlerMap, MemoryOperationKey>;
export type RuntimeResourceOperationHandlerMap = Pick<
  OperationHandlerMap,
  RuntimeResourceOperationKey
>;
export type UsagePricingOperationHandlerMap = Pick<OperationHandlerMap, UsagePricingOperationKey>;

export function combineDomainOperationHandlers(
  ...domains: readonly Partial<AllDomainOperationHandlerMap>[]
): AllDomainOperationHandlerMap {
  const combined = new Map<DomainOperationKey, AllDomainOperationHandlerMap[DomainOperationKey]>();
  for (const domain of domains) {
    for (const [rawKey, handler] of Object.entries(domain)) {
      if (!isDomainOperationKey(rawKey) || typeof handler !== 'function') {
        throw new Error(`Invalid Runtime Host domain operation handler: ${rawKey}`);
      }
      if (combined.has(rawKey)) {
        throw new Error(`Duplicate Runtime Host operation handler: ${rawKey}`);
      }
      combined.set(rawKey, handler as AllDomainOperationHandlerMap[DomainOperationKey]);
    }
  }
  for (const key of domainOperationKeys()) {
    if (!combined.has(key)) {
      throw new Error(`Missing Runtime Host operation handler: ${key}`);
    }
  }
  return Object.fromEntries(combined) as AllDomainOperationHandlerMap;
}

export function createUnavailableDomainOperationHandlers(): AllDomainOperationHandlerMap {
  return Object.fromEntries(
    domainOperationKeys().map((key) => [key, createUnavailableHandler(key)]),
  ) as AllDomainOperationHandlerMap;
}

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

function domainOperationKeys(): DomainOperationKey[] {
  return (Object.keys(HOST_OPERATION_SPECS) as OperationKey[]).filter(
    (key): key is DomainOperationKey => key !== 'host.status',
  );
}

function isDomainOperationKey(value: string): value is DomainOperationKey {
  return value !== 'host.status' && Object.hasOwn(HOST_OPERATION_SPECS, value);
}

function createUnavailableHandler<K extends DomainOperationKey>(
  operation: K,
): AllDomainOperationHandlerMap[K] {
  const declaredErrors = HOST_OPERATION_SPECS[operation]
    .errors as readonly HostOperationErrorCode[];
  if (!declaredErrors.includes('operation_unavailable')) {
    throw new Error(`${operation} does not declare operation_unavailable`);
  }
  const handler: OperationHandler<K> = async () =>
    ({
      ok: false,
      error: {
        code: 'operation_unavailable',
        message: 'Runtime Host operation is unavailable in this composition',
      },
    }) as OperationOutcome<K>;
  return handler as AllDomainOperationHandlerMap[K];
}
