import { createHash, randomUUID } from 'node:crypto';
import type {
  NativeProviderAttachmentRef,
  NativeProviderCapability,
  NativeProviderChunkFrame,
  NativeProviderClientEnvelopeFrame,
  NativeProviderHostFrame,
  NativeProviderResultEnvelopeFrame,
  NativeProviderResultPayload,
  NativeProviderComputerUseResultPayload,
  NativeProviderTurnReleasedFrame,
  NativeProviderSubcall,
  OperationInput,
  OperationKey,
  OperationOutcome,
} from '../protocol/index.js';
import {
  decodeNativeProviderHostFrame,
  decodeNativeProviderBrowserResultPayload,
  decodeNativeProviderComputerUseResultPayload,
  decodeNativeProviderOAuthPresentationResultPayload,
  nativeProviderComputerUseResultAttachmentRefs,
  NATIVE_PROVIDER_ATTACHMENT_CHUNK_BYTES,
  NATIVE_PROVIDER_MAX_ATTACHMENT_BYTES,
  NATIVE_PROVIDER_MAX_ATTACHMENTS_PER_RESULT,
  NATIVE_PROVIDER_MAX_PENDING_INVOCATIONS,
  NATIVE_PROVIDER_MAX_RESULT_ATTACHMENT_BYTES,
  NATIVE_PROVIDER_MAX_SUBCALLS_PER_INVOCATION,
} from '../protocol/index.js';
import type { OperationHandlerMap, OperationResidency } from './operation-dispatcher.js';

export const NATIVE_PROVIDER_MAX_REGISTRATIONS_PER_CONNECTION = 1;
const DEFAULT_NATIVE_PROVIDER_RELEASE_TIMEOUT_MS = 5_000;

type NativeProviderRegistrationOperationKey = Extract<
  OperationKey,
  'native.provider.register' | 'native.provider.unregister'
>;

export type NativeProviderOperationHandlerMap = Pick<
  OperationHandlerMap,
  NativeProviderRegistrationOperationKey
>;

export interface NativeProviderAttachmentData {
  readonly attachmentId: string;
  readonly mimeType: NativeProviderAttachmentRef['mimeType'];
  readonly byteLength: number;
  readonly sha256: string;
  readonly bytes: Buffer;
}

export type HostNativeProviderSubcallErrorCode =
  | 'capability_lost'
  | 'operation_failed'
  | 'outcome_unknown';

export type HostNativeProviderSubcallOutcome<
  Result extends NativeProviderResultPayload = NativeProviderResultPayload,
> =
  | {
      readonly ok: true;
      readonly result: Result;
      readonly attachments: readonly NativeProviderAttachmentData[];
    }
  | {
      readonly ok: false;
      readonly error: {
        readonly code: HostNativeProviderSubcallErrorCode;
        readonly message: string;
      };
    };

export type HostNativeProviderAffinity = string;

export interface HostNativeProviderInvocation {
  /** The frozen registration identity used for observation-bound reacquisition. */
  readonly affinity: HostNativeProviderAffinity;
  call<Subcall extends NativeProviderSubcall>(input: {
    readonly subcall: Subcall;
    readonly signal: AbortSignal;
  }): Promise<
    HostNativeProviderSubcallOutcome<
      Extract<NativeProviderResultPayload, { kind: Subcall['kind'] }>
    >
  >;
  release(): void;
}

export type HostNativeProviderInvocationAcquisition =
  | { readonly ok: true; readonly invocation: HostNativeProviderInvocation }
  | {
      readonly ok: false;
      readonly error: 'capability_unavailable' | 'capability_ambiguous' | 'service_mismatch';
      readonly message: string;
    };

export interface NativeProviderFrameSink {
  /** Returning is the outbound admission cut; flushed only tracks later transport failure. */
  enqueue(frame: NativeProviderHostFrame): { readonly flushed: Promise<void> };
  close(): void;
}

export interface NativeProviderConnectionAttachment {
  accept(frame: NativeProviderClientEnvelopeFrame): void;
  close(): void;
}

export interface HostNativeProviderService {
  readonly handlers: NativeProviderOperationHandlerMap;
  acquireInvocation(input: {
    readonly operationId: string;
    readonly sessionId: string;
    readonly turnId: string;
    readonly toolCallId: string;
    readonly capability: NativeProviderCapability;
    readonly affinity?: HostNativeProviderAffinity;
  }): HostNativeProviderInvocationAcquisition;
  acquireHostOperationInvocation(input: {
    readonly operationId: string;
    readonly ownerId: string;
    readonly attemptId: string;
    readonly initiatingClientConnectionId: string;
    readonly capability: 'oauth_presentation';
  }): HostNativeProviderInvocationAcquisition;
  releaseTurnState(input: { readonly sessionId: string; readonly turnId: string }): Promise<void>;
  attachConnection(
    connectionId: string,
    sink: NativeProviderFrameSink,
  ): NativeProviderConnectionAttachment;
  beginDrain(): void;
  close(): Promise<void>;
}

interface ConnectionState {
  readonly connectionId: string;
  readonly sink: NativeProviderFrameSink;
  readonly registrationIds: Set<string>;
  attached: boolean;
}

interface RegistrationState {
  readonly registrationId: string;
  readonly connection: ConnectionState;
  readonly capabilities: ReadonlySet<NativeProviderCapability>;
  readonly invocations: Set<InvocationState>;
  readonly ownedTurns: Set<string>;
  active: boolean;
  resolveDrained: (() => void) | undefined;
  drained: Promise<void> | undefined;
}

interface FrozenBinding {
  readonly hostEpoch: string;
  readonly connectionId: string;
  readonly registrationId: string;
  readonly bindingId: string;
  readonly capability: NativeProviderCapability;
}

interface AttachmentBuffer {
  readonly chunks: Buffer[];
  nextIndex: number;
  byteLength: number;
}

interface ActiveSubcall {
  readonly subcallId: string;
  readonly ordinal: number;
  readonly subcall: NativeProviderSubcall;
  readonly signal: AbortSignal;
  readonly abortListener: () => void;
  readonly attachments: Map<string, AttachmentBuffer>;
  readonly resolve: (outcome: HostNativeProviderSubcallOutcome) => void;
  totalAttachmentBytes: number;
  enqueueInProgress: boolean;
  admitted: boolean;
  cancelRequested: boolean;
  cancelEnqueued: boolean;
  terminal: boolean;
}

interface InvocationState {
  readonly operationId: string;
  readonly owner: InvocationOwner;
  readonly binding: Readonly<FrozenBinding>;
  readonly registration: RegistrationState;
  readonly connection: ConnectionState;
  readonly residency: OperationResidency;
  ordinal: number;
  active: ActiveSubcall | undefined;
  releaseRequested: boolean;
  lost: boolean;
  finished: boolean;
  providerStateOwned: boolean;
}

type InvocationOwner =
  | {
      readonly kind: 'turn';
      readonly sessionId: string;
      readonly turnId: string;
      readonly toolCallId: string;
    }
  | { readonly kind: 'host_operation'; readonly ownerId: string; readonly attemptId: string };

interface TurnReleaseWaiter {
  readonly hostEpoch: string;
  readonly registration: RegistrationState;
  readonly registrationId: string;
  readonly releaseId: string;
  readonly sessionId: string;
  readonly turnId: string;
  readonly resolve: () => void;
  readonly promise: Promise<void>;
  timer: NodeJS.Timeout | undefined;
}

export class HostNativeProviderCoordinator implements HostNativeProviderService {
  readonly handlers: NativeProviderOperationHandlerMap;
  readonly #hostEpoch: string;
  readonly #acquireResidency: () => OperationResidency;
  readonly #connections = new Map<string, ConnectionState>();
  readonly #registrations = new Map<string, RegistrationState>();
  readonly #invocations = new Map<string, InvocationState>();
  readonly #turnFences = new Set<string>();
  readonly #releaseWaiters = new Map<string, TurnReleaseWaiter>();
  readonly #releaseTimeoutMs: number;
  #admissionOpen = true;
  #closing = false;
  #closed = false;
  #closeTask: Promise<void> | undefined;
  #resolveInvocationDrain: (() => void) | undefined;

  constructor(
    hostEpoch: string,
    acquireResidency: () => OperationResidency,
    options: { readonly releaseTimeoutMs?: number } = {},
  ) {
    this.#hostEpoch = hostEpoch;
    this.#acquireResidency = acquireResidency;
    this.#releaseTimeoutMs = options.releaseTimeoutMs ?? DEFAULT_NATIVE_PROVIDER_RELEASE_TIMEOUT_MS;
    if (!Number.isSafeInteger(this.#releaseTimeoutMs) || this.#releaseTimeoutMs < 1) {
      throw new RangeError('Native Provider release timeout must be a positive integer');
    }
    this.handlers = {
      'native.provider.register': async (input, context) =>
        this.#register(input, context.connectionId),
      'native.provider.unregister': async (input, context) =>
        this.#unregister(input, context.connectionId),
    } as NativeProviderOperationHandlerMap;
  }

  attachConnection(
    connectionId: string,
    sink: NativeProviderFrameSink,
  ): NativeProviderConnectionAttachment {
    if (this.#closing || this.#closed) throw new Error('Native Provider coordinator is closing');
    if (this.#connections.has(connectionId)) {
      throw new Error(`Duplicate Native Provider connection: ${connectionId}`);
    }
    const connection: ConnectionState = {
      connectionId,
      sink,
      registrationIds: new Set(),
      attached: true,
    };
    this.#connections.set(connectionId, connection);
    return {
      accept: (frame) => {
        if (connection.attached) this.#accept(connection, frame);
        else connection.sink.close();
      },
      close: () => this.#closeConnection(connection),
    };
  }

  acquireInvocation(input: {
    readonly operationId: string;
    readonly sessionId: string;
    readonly turnId: string;
    readonly toolCallId: string;
    readonly capability: NativeProviderCapability;
    readonly affinity?: HostNativeProviderAffinity;
  }): HostNativeProviderInvocationAcquisition {
    return this.#acquireInvocation({
      operationId: input.operationId,
      owner: {
        kind: 'turn',
        sessionId: input.sessionId,
        turnId: input.turnId,
        toolCallId: input.toolCallId,
      },
      capability: input.capability,
      ...(input.affinity === undefined ? {} : { affinity: input.affinity }),
    });
  }

  acquireHostOperationInvocation(input: {
    readonly operationId: string;
    readonly ownerId: string;
    readonly attemptId: string;
    readonly initiatingClientConnectionId: string;
    readonly capability: 'oauth_presentation';
  }): HostNativeProviderInvocationAcquisition {
    return this.#acquireInvocation({
      operationId: input.operationId,
      owner: {
        kind: 'host_operation',
        ownerId: input.ownerId,
        attemptId: input.attemptId,
      },
      capability: input.capability,
      initiatingClientConnectionId: input.initiatingClientConnectionId,
    });
  }

  #acquireInvocation(input: {
    readonly operationId: string;
    readonly owner: InvocationOwner;
    readonly capability: NativeProviderCapability;
    readonly affinity?: HostNativeProviderAffinity;
    readonly initiatingClientConnectionId?: string;
  }): HostNativeProviderInvocationAcquisition {
    if ((input.owner.kind === 'host_operation') !== (input.capability === 'oauth_presentation')) {
      return acquisitionFailure(
        'service_mismatch',
        'Native Provider capability does not match its invocation owner',
      );
    }
    if (!this.#admissionOpen || this.#closed) {
      return acquisitionFailure(
        'capability_unavailable',
        'Native Provider invocation admission is closed',
      );
    }
    if (
      input.owner.kind === 'turn' &&
      this.#turnFences.has(turnStateKey(input.owner.sessionId, input.owner.turnId))
    ) {
      return acquisitionFailure(
        'capability_unavailable',
        'Native Provider Turn state is being released',
      );
    }
    if (this.#invocations.has(input.operationId)) {
      throw new Error(`Duplicate Native Provider operationId: ${input.operationId}`);
    }
    if (this.#invocations.size >= NATIVE_PROVIDER_MAX_PENDING_INVOCATIONS) {
      return acquisitionFailure(
        'capability_unavailable',
        'Native Provider invocation limit reached',
      );
    }

    let registration: RegistrationState | undefined;
    if (input.initiatingClientConnectionId !== undefined) {
      const connection = this.#connections.get(input.initiatingClientConnectionId);
      const eligible = connection?.attached
        ? [...connection.registrationIds]
            .map((registrationId) => this.#registrations.get(registrationId))
            .filter(
              (candidate): candidate is RegistrationState =>
                candidate?.active === true && candidate.capabilities.has(input.capability),
            )
        : [];
      if (eligible.length === 0) {
        return acquisitionFailure(
          'capability_unavailable',
          'Initiating Client has no OAuth presentation capability',
        );
      }
      if (eligible.length > 1) {
        throw new Error('Native Provider connection registration invariant failed');
      }
      registration = eligible[0];
    } else if (input.affinity !== undefined) {
      const candidate = this.#registrations.get(input.affinity);
      if (
        !candidate?.active ||
        !candidate.connection.attached ||
        !candidate.capabilities.has(input.capability)
      ) {
        return acquisitionFailure(
          'service_mismatch',
          'Native Provider affinity no longer identifies the active service',
        );
      }
      registration = candidate;
    } else {
      const eligible = [...this.#registrations.values()].filter(
        (candidate) =>
          candidate.active &&
          candidate.connection.attached &&
          candidate.capabilities.has(input.capability),
      );
      if (eligible.length === 0) {
        return acquisitionFailure(
          'capability_unavailable',
          'Native Provider capability is unavailable',
        );
      }
      if (eligible.length > 1) {
        return acquisitionFailure(
          'capability_ambiguous',
          'Native Provider capability has multiple registrations',
        );
      }
      registration = eligible[0];
    }
    if (!registration) throw new Error('Native Provider selection invariant failed');

    const binding = Object.freeze({
      hostEpoch: this.#hostEpoch,
      connectionId: registration.connection.connectionId,
      registrationId: registration.registrationId,
      bindingId: randomUUID(),
      capability: input.capability,
    });
    const invocation: InvocationState = {
      operationId: input.operationId,
      owner: Object.freeze(input.owner),
      binding,
      registration,
      connection: registration.connection,
      residency: this.#acquireResidency(),
      ordinal: 0,
      active: undefined,
      releaseRequested: false,
      lost: false,
      finished: false,
      providerStateOwned: false,
    };
    const facade: HostNativeProviderInvocation = Object.freeze({
      affinity: registration.registrationId,
      call: <Subcall extends NativeProviderSubcall>(callInput: {
        readonly subcall: Subcall;
        readonly signal: AbortSignal;
      }) =>
        this.#call(invocation, callInput) as Promise<
          HostNativeProviderSubcallOutcome<
            Extract<NativeProviderResultPayload, { kind: Subcall['kind'] }>
          >
        >,
      release: () => this.#requestRelease(invocation),
    });
    this.#invocations.set(input.operationId, invocation);
    registration.invocations.add(invocation);
    return { ok: true, invocation: facade };
  }

  async releaseTurnState(input: {
    readonly sessionId: string;
    readonly turnId: string;
  }): Promise<void> {
    const stateKey = turnStateKey(input.sessionId, input.turnId);
    if (this.#turnFences.has(stateKey)) {
      throw new Error(`Native Provider Turn release is already in flight: ${input.turnId}`);
    }
    this.#turnFences.add(stateKey);
    try {
      if (
        [...this.#invocations.values()].some(
          (invocation) =>
            invocation.owner.kind === 'turn' &&
            invocation.owner.sessionId === input.sessionId &&
            invocation.owner.turnId === input.turnId,
        )
      ) {
        throw new Error(`Native Provider Turn still has an invocation: ${input.turnId}`);
      }
      const owners = [...this.#registrations.values()].filter(
        (registration) => registration.connection.attached && registration.ownedTurns.has(stateKey),
      );
      await Promise.all(owners.map((registration) => this.#releaseOwnedTurn(registration, input)));
    } finally {
      this.#turnFences.delete(stateKey);
    }
  }

  beginDrain(): void {
    this.#admissionOpen = false;
  }

  async close(): Promise<void> {
    if (!this.#closeTask) this.#closeTask = this.#close();
    return this.#closeTask;
  }

  #call(
    invocation: InvocationState,
    input: {
      readonly subcall: NativeProviderSubcall;
      readonly signal: AbortSignal;
    },
  ): Promise<HostNativeProviderSubcallOutcome> {
    if (invocation.finished || invocation.lost || !invocation.connection.attached) {
      return Promise.resolve(
        subcallFailure('capability_lost', 'Native Provider frozen binding is no longer available'),
      );
    }
    if (invocation.releaseRequested) {
      return Promise.resolve(
        subcallFailure('capability_lost', 'Native Provider invocation has been released'),
      );
    }
    if (
      !subcallMatchesCapability(input.subcall, invocation.binding.capability) ||
      !subcallMatchesOwner(input.subcall, invocation.owner)
    ) {
      return Promise.resolve(
        subcallFailure(
          'operation_failed',
          'Native Provider subcall identity does not match its acquired invocation',
        ),
      );
    }
    if (invocation.active) {
      return Promise.resolve(
        subcallFailure('operation_failed', 'Native Provider subcalls must be strictly serial'),
      );
    }
    if (invocation.ordinal >= NATIVE_PROVIDER_MAX_SUBCALLS_PER_INVOCATION) {
      return Promise.resolve(
        subcallFailure('operation_failed', 'Native Provider subcall limit reached'),
      );
    }
    if (input.signal.aborted) {
      return Promise.resolve(
        subcallFailure(
          'operation_failed',
          'Native Provider subcall was cancelled before admission',
        ),
      );
    }

    invocation.ordinal += 1;
    const subcallId = randomUUID();
    const frame = decodeNativeProviderHostFrame({
      kind: 'native.provider.subcall',
      hostEpoch: invocation.binding.hostEpoch,
      operationId: invocation.operationId,
      subcallId,
      ordinal: invocation.ordinal,
      bindingId: invocation.binding.bindingId,
      capability: invocation.binding.capability,
      subcall: input.subcall,
    });

    return new Promise<HostNativeProviderSubcallOutcome>((resolve) => {
      const active: ActiveSubcall = {
        subcallId,
        ordinal: invocation.ordinal,
        subcall: input.subcall,
        signal: input.signal,
        abortListener: () => this.#cancel(invocation, active),
        attachments: new Map(),
        resolve,
        totalAttachmentBytes: 0,
        enqueueInProgress: true,
        admitted: false,
        cancelRequested: false,
        cancelEnqueued: false,
        terminal: false,
      };
      invocation.active = active;
      input.signal.addEventListener('abort', active.abortListener, {
        once: true,
      });
      if (input.signal.aborted) active.cancelRequested = true;

      try {
        const receipt = invocation.connection.sink.enqueue(frame);
        active.admitted = true;
        active.enqueueInProgress = false;
        if (!invocation.providerStateOwned && invocation.connection.attached) {
          invocation.providerStateOwned = true;
          if (invocation.owner.kind === 'turn') {
            invocation.registration.ownedTurns.add(
              turnStateKey(invocation.owner.sessionId, invocation.owner.turnId),
            );
          }
        }
        void receipt.flushed.catch(() => this.#closeConnection(invocation.connection));
      } catch {
        active.enqueueInProgress = false;
        this.#finishSubcall(
          invocation,
          active,
          subcallFailure('capability_lost', 'Native Provider subcall could not be admitted'),
        );
        this.#closeConnection(invocation.connection);
        this.#releaseInvocation(invocation, false);
        return;
      }

      if (!invocation.connection.attached) {
        this.#finishSubcall(
          invocation,
          active,
          subcallFailure(
            'outcome_unknown',
            'Native Provider outcome is unknown after connection loss',
          ),
        );
        this.#releaseInvocation(invocation, false);
        return;
      }
      if (active.cancelRequested || input.signal.aborted) this.#enqueueCancel(invocation, active);
    });
  }

  #cancel(invocation: InvocationState, active: ActiveSubcall): void {
    if (active.terminal) return;
    active.cancelRequested = true;
    if (active.admitted) this.#enqueueCancel(invocation, active);
  }

  #enqueueCancel(invocation: InvocationState, active: ActiveSubcall): void {
    if (active.terminal || active.cancelEnqueued || !invocation.connection.attached) return;
    active.cancelEnqueued = true;
    const frame = decodeNativeProviderHostFrame({
      kind: 'native.provider.cancel',
      ...this.#subcallIdentity(invocation, active),
    });
    this.#enqueueControl(invocation.connection, frame);
  }

  #requestRelease(invocation: InvocationState): void {
    if (invocation.finished || invocation.releaseRequested) return;
    invocation.releaseRequested = true;
    if (invocation.active) return;
    this.#releaseInvocation(invocation, true);
  }

  #releaseInvocation(invocation: InvocationState, sendFrame: boolean): void {
    if (invocation.finished) return;
    invocation.finished = true;
    if (sendFrame && invocation.providerStateOwned && invocation.connection.attached) {
      try {
        const frame = decodeNativeProviderHostFrame({
          kind: 'native.provider.release',
          hostEpoch: invocation.binding.hostEpoch,
          operationId: invocation.operationId,
          bindingId: invocation.binding.bindingId,
        });
        this.#enqueueControl(invocation.connection, frame);
      } catch {
        // Local completion is authoritative for one-way release.
      }
    }
    this.#invocations.delete(invocation.operationId);
    invocation.registration.invocations.delete(invocation);
    try {
      invocation.residency.release();
    } catch {
      // Release is a one-way local cleanup boundary and must never escape to callers.
    }
    this.#settleRegistrationDrain(invocation.registration);
    if (this.#invocations.size === 0) this.#resolveInvocationDrain?.();
  }

  #register(
    input: OperationInput<'native.provider.register'>,
    connectionId: string,
  ): Promise<OperationOutcome<'native.provider.register'>> {
    if (!this.#admissionOpen || this.#closed) {
      return Promise.resolve({
        ok: false,
        error: {
          code: 'host_draining',
          message: 'Native Provider admission is closed',
        },
      } as OperationOutcome<'native.provider.register'>);
    }
    const connection = this.#connections.get(connectionId);
    if (!connection?.attached) {
      throw new Error('Native Provider registration connection is not attached');
    }
    if (connection.registrationIds.size >= NATIVE_PROVIDER_MAX_REGISTRATIONS_PER_CONNECTION) {
      return Promise.resolve({
        ok: false,
        error: {
          code: 'operation_conflict',
          message: 'Native Provider connection registration limit reached',
        },
      } as OperationOutcome<'native.provider.register'>);
    }
    const registrationId = randomUUID();
    const registration: RegistrationState = {
      registrationId,
      connection,
      capabilities: new Set(input.capabilities),
      invocations: new Set(),
      ownedTurns: new Set(),
      active: true,
      resolveDrained: undefined,
      drained: undefined,
    };
    this.#registrations.set(registrationId, registration);
    connection.registrationIds.add(registrationId);
    return Promise.resolve({
      ok: true,
      result: { registrationId },
    } as OperationOutcome<'native.provider.register'>);
  }

  async #unregister(
    input: OperationInput<'native.provider.unregister'>,
    connectionId: string,
  ): Promise<OperationOutcome<'native.provider.unregister'>> {
    const registration = this.#registrations.get(input.registrationId);
    if (!registration || registration.connection.connectionId !== connectionId) {
      return {
        ok: false,
        error: {
          code: 'not_found',
          message: 'Native Provider registration was not found',
        },
      } as OperationOutcome<'native.provider.unregister'>;
    }
    this.#deactivateRegistration(registration);
    await this.#registrationDrain(registration);
    this.#removeRegistration(registration);
    return {
      ok: true,
      result: { registrationId: input.registrationId },
    } as OperationOutcome<'native.provider.unregister'>;
  }

  #accept(connection: ConnectionState, frame: NativeProviderClientEnvelopeFrame): void {
    if (frame.kind === 'native.provider.turn_released') {
      this.#acceptTurnReleased(connection, frame);
      return;
    }
    const invocation = this.#invocations.get(frame.operationId);
    const active = invocation?.active;
    if (
      !invocation ||
      !active ||
      active.terminal ||
      invocation.connection !== connection ||
      frame.hostEpoch !== invocation.binding.hostEpoch ||
      frame.bindingId !== invocation.binding.bindingId ||
      (frame.kind === 'native.provider.result' &&
        frame.capability !== invocation.binding.capability) ||
      frame.subcallId !== active.subcallId ||
      frame.ordinal !== active.ordinal
    ) {
      this.#violate(connection);
      return;
    }
    if (frame.kind === 'native.provider.chunk') {
      this.#acceptChunk(connection, invocation, active, frame);
      return;
    }
    this.#acceptResult(connection, invocation, active, frame);
  }

  #acceptTurnReleased(connection: ConnectionState, frame: NativeProviderTurnReleasedFrame): void {
    const waiter = this.#releaseWaiters.get(frame.releaseId);
    if (
      !waiter ||
      waiter.registration.connection !== connection ||
      frame.hostEpoch !== waiter.hostEpoch ||
      frame.registrationId !== waiter.registrationId ||
      frame.sessionId !== waiter.sessionId ||
      frame.turnId !== waiter.turnId
    ) {
      this.#violate(connection);
      return;
    }
    waiter.registration.ownedTurns.delete(turnStateKey(waiter.sessionId, waiter.turnId));
    this.#settleReleaseWaiter(waiter);
    this.#settleRegistrationDrain(waiter.registration);
  }

  #acceptChunk(
    connection: ConnectionState,
    invocation: InvocationState,
    active: ActiveSubcall,
    frame: NativeProviderChunkFrame,
  ): void {
    if (invocation.binding.capability === 'oauth_presentation') {
      this.#violate(connection);
      return;
    }
    let attachment = active.attachments.get(frame.attachmentId);
    if (!attachment) {
      if (active.attachments.size >= NATIVE_PROVIDER_MAX_ATTACHMENTS_PER_RESULT) {
        this.#violate(connection);
        return;
      }
      attachment = { chunks: [], nextIndex: 0, byteLength: 0 };
      active.attachments.set(frame.attachmentId, attachment);
    }
    const bytes = Buffer.from(frame.data, 'base64');
    if (
      frame.index !== attachment.nextIndex ||
      bytes.byteLength === 0 ||
      bytes.byteLength > NATIVE_PROVIDER_ATTACHMENT_CHUNK_BYTES ||
      attachment.byteLength + bytes.byteLength > NATIVE_PROVIDER_MAX_ATTACHMENT_BYTES ||
      active.totalAttachmentBytes + bytes.byteLength > NATIVE_PROVIDER_MAX_RESULT_ATTACHMENT_BYTES
    ) {
      this.#violate(connection);
      return;
    }
    attachment.chunks.push(bytes);
    attachment.nextIndex += 1;
    attachment.byteLength += bytes.byteLength;
    active.totalAttachmentBytes += bytes.byteLength;
  }

  #acceptResult(
    connection: ConnectionState,
    invocation: InvocationState,
    active: ActiveSubcall,
    frame: NativeProviderResultEnvelopeFrame,
  ): void {
    if (!frame.ok) {
      if (active.attachments.size !== 0) {
        this.#violate(connection);
        return;
      }
      this.#finishSubcall(invocation, active, {
        ok: false,
        error: {
          code: frame.error.code,
          message: 'Native Provider reported failure',
        },
      });
      return;
    }
    let result: NativeProviderResultPayload;
    let refs: readonly NativeProviderAttachmentRef[];
    switch (invocation.binding.capability) {
      case 'computer_use': {
        result = decodeNativeProviderComputerUseResultPayload(frame.result);
        refs = nativeProviderComputerUseResultAttachmentRefs(
          result as NativeProviderComputerUseResultPayload,
        );
        break;
      }
      case 'browser':
        result = decodeNativeProviderBrowserResultPayload(frame.result);
        refs = [];
        break;
      case 'oauth_presentation':
        result = decodeNativeProviderOAuthPresentationResultPayload(frame.result);
        refs = [];
        break;
    }
    if (result.kind !== active.subcall.kind) {
      this.#violate(connection);
      return;
    }
    if (refs.length > NATIVE_PROVIDER_MAX_ATTACHMENTS_PER_RESULT) {
      this.#violate(connection);
      return;
    }
    const refIds = new Set<string>();
    const attachments: NativeProviderAttachmentData[] = [];
    for (const ref of refs) {
      if (refIds.has(ref.attachmentId)) {
        this.#violate(connection);
        return;
      }
      refIds.add(ref.attachmentId);
      const buffered = active.attachments.get(ref.attachmentId);
      const bytes = buffered
        ? Buffer.concat(buffered.chunks, buffered.byteLength)
        : Buffer.alloc(0);
      if (
        bytes.byteLength !== ref.byteLength ||
        createHash('sha256').update(bytes).digest('hex') !== ref.sha256
      ) {
        this.#violate(connection);
        return;
      }
      attachments.push({ ...ref, bytes });
    }
    if (active.attachments.size !== refIds.size) {
      this.#violate(connection);
      return;
    }
    this.#finishSubcall(invocation, active, {
      ok: true,
      result,
      attachments,
    });
  }

  #finishSubcall(
    invocation: InvocationState,
    active: ActiveSubcall,
    outcome: HostNativeProviderSubcallOutcome,
  ): void {
    if (active.terminal) return;
    active.terminal = true;
    active.signal.removeEventListener('abort', active.abortListener);
    active.attachments.clear();
    active.totalAttachmentBytes = 0;
    if (invocation.active === active) invocation.active = undefined;
    active.resolve(outcome);
    if (invocation.releaseRequested) this.#releaseInvocation(invocation, true);
  }

  #releaseOwnedTurn(
    registration: RegistrationState,
    identity: { readonly sessionId: string; readonly turnId: string },
  ): Promise<void> {
    if (!registration.connection.attached) {
      return Promise.resolve();
    }
    const releaseId = randomUUID();
    let resolve!: TurnReleaseWaiter['resolve'];
    const promise = new Promise<void>((settle) => {
      resolve = settle;
    });
    const waiter: TurnReleaseWaiter = {
      hostEpoch: this.#hostEpoch,
      registration,
      registrationId: registration.registrationId,
      releaseId,
      sessionId: identity.sessionId,
      turnId: identity.turnId,
      resolve,
      promise,
      timer: undefined,
    };
    this.#releaseWaiters.set(releaseId, waiter);
    const frame = decodeNativeProviderHostFrame({
      kind: 'native.provider.turn_release',
      hostEpoch: this.#hostEpoch,
      registrationId: registration.registrationId,
      releaseId,
      sessionId: identity.sessionId,
      turnId: identity.turnId,
    });
    try {
      const receipt = registration.connection.sink.enqueue(frame);
      void receipt.flushed.catch(() => this.#evictConnection(registration.connection));
      if (this.#releaseWaiters.get(releaseId) === waiter) {
        waiter.timer = setTimeout(() => {
          this.#evictConnection(registration.connection);
        }, this.#releaseTimeoutMs);
      }
    } catch {
      this.#evictConnection(registration.connection);
    }
    return promise;
  }

  #settleReleaseWaiter(waiter: TurnReleaseWaiter): void {
    if (this.#releaseWaiters.get(waiter.releaseId) !== waiter) return;
    this.#releaseWaiters.delete(waiter.releaseId);
    if (waiter.timer) clearTimeout(waiter.timer);
    waiter.timer = undefined;
    waiter.resolve();
  }

  #closeConnection(connection: ConnectionState): void {
    if (!connection.attached) return;
    connection.attached = false;
    this.#connections.delete(connection.connectionId);
    for (const registrationId of [...connection.registrationIds]) {
      const registration = this.#registrations.get(registrationId);
      if (registration) {
        this.#deactivateRegistration(registration);
        this.#removeRegistration(registration);
        registration.ownedTurns.clear();
        for (const waiter of [...this.#releaseWaiters.values()]) {
          if (waiter.registration === registration) this.#settleReleaseWaiter(waiter);
        }
        this.#settleRegistrationDrain(registration);
      }
    }
    for (const invocation of [...this.#invocations.values()]) {
      if (invocation.connection !== connection) continue;
      invocation.lost = true;
      const active = invocation.active;
      if (active?.enqueueInProgress) continue;
      if (active) {
        this.#finishSubcall(
          invocation,
          active,
          subcallFailure(
            active.admitted ? 'outcome_unknown' : 'capability_lost',
            active.admitted
              ? 'Native Provider outcome is unknown after connection loss'
              : 'Native Provider capability was lost before admission',
          ),
        );
      }
      this.#releaseInvocation(invocation, false);
    }
  }

  #deactivateRegistration(registration: RegistrationState): void {
    if (!registration.active) return;
    registration.active = false;
  }

  #removeRegistration(registration: RegistrationState): void {
    this.#registrations.delete(registration.registrationId);
    registration.connection.registrationIds.delete(registration.registrationId);
  }

  #registrationDrain(registration: RegistrationState): Promise<void> {
    if (registration.invocations.size === 0 && registration.ownedTurns.size === 0) {
      return Promise.resolve();
    }
    if (!registration.drained) {
      registration.drained = new Promise<void>((resolve) => {
        registration.resolveDrained = resolve;
      });
    }
    return registration.drained;
  }

  #settleRegistrationDrain(registration: RegistrationState): void {
    if (registration.invocations.size !== 0 || registration.ownedTurns.size !== 0) return;
    registration.resolveDrained?.();
    registration.resolveDrained = undefined;
  }

  #enqueueControl(connection: ConnectionState, frame: NativeProviderHostFrame): void {
    if (!connection.attached) return;
    try {
      const receipt = connection.sink.enqueue(frame);
      void receipt.flushed.catch(() => this.#closeConnection(connection));
    } catch {
      this.#closeConnection(connection);
    }
  }

  #violate(connection: ConnectionState): void {
    if (!connection.attached) return;
    this.#closeConnection(connection);
    connection.sink.close();
  }

  #evictConnection(connection: ConnectionState): void {
    this.#closeConnection(connection);
    connection.sink.close();
  }

  #subcallIdentity(
    invocation: InvocationState,
    active: ActiveSubcall,
  ): Readonly<{
    hostEpoch: string;
    operationId: string;
    subcallId: string;
    ordinal: number;
    bindingId: string;
  }> {
    return {
      hostEpoch: invocation.binding.hostEpoch,
      operationId: invocation.operationId,
      subcallId: active.subcallId,
      ordinal: active.ordinal,
      bindingId: invocation.binding.bindingId,
    };
  }

  async #close(): Promise<void> {
    if (this.#closed) return;
    this.beginDrain();
    this.#closing = true;
    if (this.#invocations.size !== 0) {
      await new Promise<void>((resolve) => {
        this.#resolveInvocationDrain = resolve;
      });
    }
    this.#closed = true;
    for (const connection of [...this.#connections.values()]) {
      this.#closeConnection(connection);
      connection.sink.close();
    }
  }
}

function acquisitionFailure(
  error: Extract<HostNativeProviderInvocationAcquisition, { ok: false }>['error'],
  message: string,
): Extract<HostNativeProviderInvocationAcquisition, { ok: false }> {
  return { ok: false, error, message };
}

function subcallFailure(
  code: HostNativeProviderSubcallErrorCode,
  message: string,
): Extract<HostNativeProviderSubcallOutcome, { ok: false }> {
  return { ok: false, error: { code, message } };
}

function turnStateKey(sessionId: string, turnId: string): string {
  return `${sessionId}\u0000${turnId}`;
}

function subcallMatchesCapability(
  subcall: NativeProviderSubcall,
  capability: NativeProviderCapability,
): boolean {
  switch (subcall.kind) {
    case 'open_external':
    case 'request_authorization_code':
      return capability === 'oauth_presentation';
    case 'navigate':
    case 'snapshot':
    case 'click':
    case 'type':
    case 'wait':
    case 'extract':
      return capability === 'browser';
    case 'preflight':
    case 'listApps':
    case 'observeApp':
    case 'runSemantic':
    case 'captureObservation':
    case 'run':
      return capability === 'computer_use';
  }
}

function subcallMatchesOwner(subcall: NativeProviderSubcall, owner: InvocationOwner): boolean {
  if (owner.kind === 'host_operation') {
    return (
      isOAuthPresentationSubcall(subcall) &&
      subcall.context.ownerId === owner.ownerId &&
      subcall.context.attemptId === owner.attemptId
    );
  }
  return (
    !isOAuthPresentationSubcall(subcall) &&
    subcall.context.sessionId === owner.sessionId &&
    subcall.context.turnId === owner.turnId &&
    subcall.context.toolCallId === owner.toolCallId
  );
}

function isOAuthPresentationSubcall(
  subcall: NativeProviderSubcall,
): subcall is Extract<
  NativeProviderSubcall,
  { readonly kind: 'open_external' | 'request_authorization_code' }
> {
  return subcall.kind === 'open_external' || subcall.kind === 'request_authorization_code';
}
