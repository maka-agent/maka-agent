import { createHash } from 'node:crypto';
import {
  decodeNativeProviderClientFrame,
  NATIVE_PROVIDER_ATTACHMENT_CHUNK_BYTES,
  NATIVE_PROVIDER_MAX_ATTACHMENT_BYTES,
  NATIVE_PROVIDER_MAX_CAPABILITIES,
  NATIVE_PROVIDER_MAX_PENDING_INVOCATIONS,
  NATIVE_PROVIDER_MAX_SUBCALLS_PER_INVOCATION,
  nativeProviderResultAttachmentRefs,
  type NativeProviderAttachmentRef,
  type NativeProviderCapability,
  type NativeProviderChunkFrame,
  type NativeProviderFailureCode,
  type NativeProviderReleaseFrame,
  type NativeProviderResultFrame,
  type NativeProviderResultPayload,
  type NativeProviderTurnReleaseFrame,
  type NativeProviderTurnReleasedFrame,
  type NativeProviderSubcallFrame,
  type NativeProviderCancelFrame,
} from '../protocol/index.js';

export const NATIVE_PROVIDER_DEFAULT_CHUNK_BYTES = NATIVE_PROVIDER_ATTACHMENT_CHUNK_BYTES;

export type NativeCapability = NativeProviderCapability;

export interface NativeCapabilityAttachment {
  readonly attachmentId: string;
  readonly mimeType: 'image/png' | 'image/jpeg';
  readonly data: Uint8Array;
}

export type NativeCapabilityAttachmentRef = NativeProviderAttachmentRef;

export type NativeCapabilitySubcallFrame<C extends NativeCapability> = Extract<
  NativeProviderSubcallFrame,
  { readonly capability: C }
>;

export type NativeCapabilityResultPayload<C extends NativeCapability> = Extract<
  NativeProviderResultFrame,
  { readonly capability: C; readonly ok: true }
>['result'];

export type NativeCapabilityHandlerOutcome<C extends NativeCapability> =
  | {
      readonly ok: true;
      readonly attachment?: NativeCapabilityAttachment;
      readonly complete: (
        attachment?: NativeCapabilityAttachmentRef,
      ) => NativeCapabilityResultPayload<C>;
    }
  | { readonly ok: false; readonly code: NativeProviderFailureCode };

export interface NativeCapabilityHandlerContext {
  readonly signal: AbortSignal;
}

export type NativeCapabilityHandler<C extends NativeCapability> = (
  frame: NativeCapabilitySubcallFrame<C>,
  context: NativeCapabilityHandlerContext,
) => Promise<NativeCapabilityHandlerOutcome<C>>;

interface NativeCapabilityImplementationBase<C extends NativeCapability> {
  readonly capability: C;
  readonly handle: NativeCapabilityHandler<C>;
}

export type NativeCapabilityImplementation<C extends NativeCapability> =
  NativeCapabilityImplementationBase<C> &
    (C extends 'oauth_presentation'
      ? { readonly releaseTurnState?: never }
      : {
          readonly releaseTurnState: (input: TurnStateIdentity) => void | Promise<void>;
        });

type NativeCapabilityImplementationUnion = {
  [C in NativeCapability]: NativeCapabilityImplementation<C>;
}[NativeCapability];

export type NativeCapabilityImplementations = readonly [
  NativeCapabilityImplementationUnion,
  ...NativeCapabilityImplementationUnion[],
];

export interface NativeCapabilityProviderOptions {
  readonly chunkBytes?: number;
}

export interface NativeProviderRegistration {
  readonly registrationId: string;
  readonly drained: Promise<void>;
  unregister(timeoutMs?: number): Promise<void>;
}

export interface NativeProviderAttachmentTransport {
  readonly hostEpoch: string;
  send(
    frame: NativeProviderChunkFrame | NativeProviderResultFrame | NativeProviderTurnReleasedFrame,
  ): Promise<void>;
  fail(error: Error): void;
}

interface Invocation {
  readonly operationId: string;
  readonly bindingId: string;
  readonly capability: NativeCapability;
  readonly owner: InvocationOwner;
  nextOrdinal: number;
  active?: {
    readonly subcallId: string;
    readonly ordinal: number;
    readonly controller: AbortController;
    readonly settled: Promise<void>;
    readonly resolveSettled: () => void;
  };
}

type InvocationOwner =
  | {
      readonly kind: 'turn';
      readonly sessionId: string;
      readonly turnId: string;
      readonly toolCallId: string;
    }
  | { readonly kind: 'host_operation'; readonly ownerId: string; readonly attemptId: string };

export interface TurnStateIdentity {
  readonly sessionId: string;
  readonly turnId: string;
}

interface SeenTurnState extends TurnStateIdentity {
  readonly usedCapabilities: Set<NativeCapability>;
}

interface TurnCleanup {
  readonly releaseId: string;
  readonly task: Promise<void>;
}

export class NativeCapabilityProvider {
  readonly capabilities: readonly NativeCapability[];
  readonly #implementations: readonly NativeCapabilityImplementationUnion[];
  readonly #chunkBytes: number;
  #current: ClientNativeProviderAttachment | undefined;
  #attachGate = Promise.resolve();

  constructor(
    implementations: NativeCapabilityImplementations,
    options: NativeCapabilityProviderOptions = {},
  ) {
    if (implementations.length === 0) {
      throw new RangeError('Native capability provider must offer at least one capability');
    }
    const capabilities = implementations.map(({ capability }) => capability);
    if (new Set(capabilities).size !== capabilities.length) {
      throw new RangeError('Native capability provider capabilities must be unique');
    }
    if (capabilities.length > NATIVE_PROVIDER_MAX_CAPABILITIES) {
      throw new RangeError('Native capability provider offers too many capabilities');
    }
    const chunkBytes = options.chunkBytes ?? NATIVE_PROVIDER_DEFAULT_CHUNK_BYTES;
    if (
      !Number.isSafeInteger(chunkBytes) ||
      chunkBytes < 1 ||
      chunkBytes > NATIVE_PROVIDER_ATTACHMENT_CHUNK_BYTES
    ) {
      throw new RangeError('Native capability provider chunkBytes must be between 1 and 32768');
    }
    this.capabilities = Object.freeze(capabilities);
    this.#implementations = Object.freeze([...implementations]);
    this.#chunkBytes = chunkBytes;
  }

  get drained(): Promise<void> {
    return this.#current?.drained ?? Promise.resolve();
  }

  attach(transport: NativeProviderAttachmentTransport): Promise<ClientNativeProviderAttachment> {
    const attached = this.#attachGate.then(async () => {
      if (this.#current) {
        await this.#current.drained;
        if (this.#current.failed) {
          throw new Error('Native capability provider attachment failed during Turn cleanup');
        }
      }
      const attachment = new ClientNativeProviderAttachment(
        transport,
        this.capabilities,
        this.#implementations,
        this.#chunkBytes,
      );
      this.#current = attachment;
      return attachment;
    });
    this.#attachGate = attached.then(
      () => undefined,
      () => undefined,
    );
    return attached;
  }
}

export function createNativeCapabilityProvider(
  implementations: NativeCapabilityImplementations,
  options?: NativeCapabilityProviderOptions,
): NativeCapabilityProvider {
  return new NativeCapabilityProvider(implementations, options);
}

export class ClientNativeProviderAttachment {
  readonly capabilities: readonly NativeCapability[];
  readonly drained: Promise<void>;
  readonly #transport: NativeProviderAttachmentTransport;
  readonly #implementations: readonly NativeCapabilityImplementationUnion[];
  readonly #invocations = new Map<string, Invocation>();
  readonly #seenTurns = new Map<string, SeenTurnState>();
  readonly #turnCleanups = new Map<string, TurnCleanup>();
  readonly #chunkBytes: number;
  #registrationId: string | undefined;
  #admissionOpen = true;
  #sendResults = true;
  #transportFailed = false;
  #cleanupFailed = false;
  #drainStarted = false;
  #resolveDrained!: () => void;
  #writeTail = Promise.resolve();

  constructor(
    transport: NativeProviderAttachmentTransport,
    capabilities: readonly NativeCapability[],
    implementations: readonly NativeCapabilityImplementationUnion[],
    chunkBytes: number,
  ) {
    this.#transport = transport;
    this.capabilities = capabilities;
    this.#implementations = implementations;
    this.#chunkBytes = chunkBytes;
    this.drained = new Promise((resolve) => {
      this.#resolveDrained = resolve;
    });
  }

  canAccept(capability: NativeCapability): boolean {
    return this.#admissionOpen && this.capabilities.includes(capability);
  }

  get failed(): boolean {
    return this.#cleanupFailed;
  }

  bindRegistration(registrationId: string): void {
    if (this.#registrationId) throw new Error('Native Provider attachment is already registered');
    this.#registrationId = registrationId;
  }

  hasInvocation(operationId: string): boolean {
    return this.#invocations.has(operationId);
  }

  acceptSubcall(frame: NativeProviderSubcallFrame): void {
    this.#requireEpoch(frame.hostEpoch);
    if (!this.#registrationId)
      throw new Error('Native Provider subcall arrived before registration');
    if (!this.#admissionOpen)
      throw new Error('Native Provider subcall arrived after admission closed');
    if (!this.capabilities.includes(frame.capability)) {
      throw new Error('Runtime Host called an unregistered Native Provider capability');
    }
    let invocation = this.#invocations.get(frame.operationId);
    const owner = invocationOwner(frame);
    const releasingTurnKey =
      owner.kind === 'turn' ? turnStateKey(owner.sessionId, owner.turnId) : undefined;
    if (releasingTurnKey !== undefined && this.#turnCleanups.has(releasingTurnKey)) {
      throw new Error('Native Provider subcall arrived while its Turn state is releasing');
    }
    if (!invocation) {
      if (frame.ordinal !== 1)
        throw new Error('Native Provider invocation must begin at ordinal 1');
      if (this.#invocations.size >= NATIVE_PROVIDER_MAX_PENDING_INVOCATIONS) {
        throw new Error('Runtime Host exceeded the Native Provider pending invocation limit');
      }
      invocation = {
        operationId: frame.operationId,
        bindingId: frame.bindingId,
        capability: frame.capability,
        owner,
        nextOrdinal: 1,
      };
      this.#invocations.set(frame.operationId, invocation);
    }
    if (
      invocation.bindingId !== frame.bindingId ||
      invocation.capability !== frame.capability ||
      !sameInvocationOwner(invocation.owner, owner)
    ) {
      throw new Error('Runtime Host changed Native Provider invocation identity');
    }
    if (invocation.active)
      throw new Error('Runtime Host issued concurrent Native Provider subcalls');
    if (
      frame.ordinal !== invocation.nextOrdinal ||
      frame.ordinal > NATIVE_PROVIDER_MAX_SUBCALLS_PER_INVOCATION
    ) {
      throw new Error('Runtime Host issued a non-contiguous Native Provider subcall ordinal');
    }
    const active = {
      subcallId: frame.subcallId,
      ordinal: frame.ordinal,
      controller: new AbortController(),
      ...settlement(),
    };
    invocation.active = active;
    if (owner.kind === 'turn') {
      const stateKey = turnStateKey(owner.sessionId, owner.turnId);
      let turnState = this.#seenTurns.get(stateKey);
      if (!turnState) {
        turnState = {
          sessionId: owner.sessionId,
          turnId: owner.turnId,
          usedCapabilities: new Set(),
        };
        this.#seenTurns.set(stateKey, turnState);
      }
      turnState.usedCapabilities.add(frame.capability);
    }
    setImmediate(() => void this.#run(frame, invocation!, active));
  }

  acceptCancel(frame: NativeProviderCancelFrame): void {
    this.#requireEpoch(frame.hostEpoch);
    const invocation = this.#requireInvocation(frame.operationId, frame.bindingId);
    const active = invocation.active;
    if (!active || active.subcallId !== frame.subcallId || active.ordinal !== frame.ordinal) {
      throw new Error('Runtime Host cancelled a non-active Native Provider subcall');
    }
    active.controller.abort();
  }

  acceptRelease(frame: NativeProviderReleaseFrame): void {
    this.#requireEpoch(frame.hostEpoch);
    const invocation = this.#requireInvocation(frame.operationId, frame.bindingId);
    if (invocation.active)
      throw new Error('Runtime Host released an active Native Provider invocation');
    this.#invocations.delete(frame.operationId);
    this.#resolveDrainIfReady();
  }

  acceptTurnRelease(frame: NativeProviderTurnReleaseFrame): void {
    this.#requireEpoch(frame.hostEpoch);
    if (frame.registrationId !== this.#registrationId) {
      throw new Error('Native Provider Turn release referenced a different registration');
    }
    if (!this.#sendResults) throw new Error('Native Provider Turn release arrived after detach');
    const stateKey = turnStateKey(frame.sessionId, frame.turnId);
    const existing = this.#turnCleanups.get(stateKey);
    if (existing) {
      if (existing.releaseId !== frame.releaseId) {
        throw new Error('Native Provider Turn release identity changed during cleanup');
      }
      return;
    }
    if (!this.#seenTurns.has(stateKey)) {
      throw new Error('Native Provider Turn release referenced unseen Turn state');
    }
    const task = this.#releaseTurnState(frame);
    this.#turnCleanups.set(stateKey, {
      releaseId: frame.releaseId,
      task,
    });
    void task.catch((error: unknown) => this.#failTransport(asError(error)));
  }

  sealAdmission(): void {
    if (!this.#admissionOpen) return;
    this.#admissionOpen = false;
    this.#resolveDrainIfReady();
  }

  detach(): void {
    this.sealAdmission();
    if (!this.#sendResults) return;
    this.#sendResults = false;
    for (const invocation of this.#invocations.values()) invocation.active?.controller.abort();
    this.#resolveDrainIfReady();
  }

  async #releaseTurnState(frame: NativeProviderTurnReleaseFrame): Promise<void> {
    const stateKey = turnStateKey(frame.sessionId, frame.turnId);
    const turnState = this.#seenTurns.get(stateKey);
    if (!turnState) throw new Error('Native Provider Turn state disappeared during cleanup');
    await this.#waitForTurnHandlers(frame.sessionId, frame.turnId);
    await this.#cleanupTurnState(turnState);
    if (this.#sendResults) {
      await this.#serializeOutput(() =>
        this.#sendResults
          ? this.#sendValidated({
              kind: 'native.provider.turn_released',
              ...turnReleaseIdentity(frame),
            })
          : Promise.resolve(),
      );
    }
    this.#turnCleanups.delete(stateKey);
    this.#resolveDrainIfReady();
  }

  async #waitForTurnHandlers(sessionId: string, turnId: string): Promise<void> {
    for (;;) {
      const active = [...this.#invocations.values()]
        .filter(
          (invocation) =>
            invocation.owner.kind === 'turn' &&
            invocation.owner.sessionId === sessionId &&
            invocation.owner.turnId === turnId,
        )
        .flatMap((invocation) => (invocation.active ? [invocation.active.settled] : []));
      if (active.length === 0) return;
      await Promise.all(active);
    }
  }

  async #cleanupTurnState(turnState: SeenTurnState): Promise<void> {
    const identity = { sessionId: turnState.sessionId, turnId: turnState.turnId };
    const cleanupTasks = [...turnState.usedCapabilities].map((capability) =>
      Promise.resolve().then(() => this.#releaseCapabilityTurnState(capability, identity)),
    );
    const outcomes = await Promise.allSettled(cleanupTasks);
    const failure = outcomes.find(
      (outcome): outcome is PromiseRejectedResult => outcome.status === 'rejected',
    );
    if (failure) {
      this.#cleanupFailed = true;
      throw failure.reason;
    }
    this.#seenTurns.delete(turnStateKey(identity.sessionId, identity.turnId));
  }

  #releaseCapabilityTurnState(
    capability: NativeCapability,
    identity: TurnStateIdentity,
  ): void | Promise<void> {
    const implementation = this.#implementations.find(
      (candidate) => candidate.capability === capability,
    );
    if (!implementation || implementation.capability === 'oauth_presentation') {
      throw new Error('Host operation capability cannot own Turn state');
    }
    return implementation.releaseTurnState(identity);
  }

  async #run(
    frame: NativeProviderSubcallFrame,
    invocation: Invocation,
    active: NonNullable<Invocation['active']>,
  ): Promise<void> {
    try {
      let outcome: NativeCapabilityHandlerOutcome<NativeCapability>;
      try {
        outcome = await this.#handle(frame, { signal: active.controller.signal });
      } catch {
        outcome = { ok: false, code: 'operation_failed' };
      }
      if (!this.#sendResults) return;
      await this.#serializeOutput(async () => {
        if (!this.#sendResults) return;
        const identity = {
          hostEpoch: this.#transport.hostEpoch,
          operationId: frame.operationId,
          subcallId: frame.subcallId,
          ordinal: frame.ordinal,
          bindingId: frame.bindingId,
        };
        if (!outcome.ok) {
          const resultFrame = {
            kind: 'native.provider.result',
            ...identity,
            capability: frame.capability,
            ok: false,
            error: { code: outcome.code },
          } as NativeProviderResultFrame;
          await this.#sendValidated(resultFrame);
          return;
        }
        let ref: NativeCapabilityAttachmentRef | undefined;
        if (outcome.attachment) ref = await this.#sendAttachment(identity, outcome.attachment);
        if (!this.#sendResults) return;
        const result = outcome.complete(ref);
        if (result.kind !== frame.subcall.kind) {
          throw new Error('Native capability result kind does not match the subcall');
        }
        requireMatchingAttachment(result, ref);
        const resultFrame = {
          kind: 'native.provider.result',
          ...identity,
          capability: frame.capability,
          ok: true,
          result,
        } as NativeProviderResultFrame;
        await this.#sendValidated(resultFrame);
      });
    } catch (error) {
      if (this.#sendResults) this.#failTransport(asError(error));
    } finally {
      if (invocation.active === active) {
        invocation.active = undefined;
        invocation.nextOrdinal += 1;
      }
      active.resolveSettled();
      this.#resolveDrainIfReady();
    }
  }

  #handle(
    frame: NativeProviderSubcallFrame,
    context: NativeCapabilityHandlerContext,
  ): Promise<NativeCapabilityHandlerOutcome<NativeCapability>> {
    return this.#implementation(frame.capability).handle(frame, context);
  }

  #implementation<C extends NativeCapability>(capability: C): NativeCapabilityImplementation<C> {
    const implementation = this.#implementations.find(
      (candidate) => candidate.capability === capability,
    );
    if (!implementation) {
      throw new Error('Native capability provider implementation is unavailable');
    }
    // The runtime equality restores the capability correlation erased by Array.find.
    return implementation as unknown as NativeCapabilityImplementation<C>;
  }

  async #sendAttachment(
    identity: Omit<NativeProviderChunkFrame, 'kind' | 'attachmentId' | 'index' | 'data'>,
    attachment: NativeCapabilityAttachment,
  ): Promise<NativeCapabilityAttachmentRef> {
    const bytes = Buffer.from(attachment.data);
    if (bytes.byteLength === 0 || bytes.byteLength > NATIVE_PROVIDER_MAX_ATTACHMENT_BYTES) {
      throw new Error('Native capability result attachment limit exceeded');
    }
    const ref = {
      attachmentId: attachment.attachmentId,
      byteLength: bytes.byteLength,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      mimeType: attachment.mimeType,
    } satisfies NativeCapabilityAttachmentRef;
    for (let offset = 0, index = 0; offset < bytes.byteLength; index += 1) {
      if (!this.#sendResults) break;
      const chunk = bytes.subarray(offset, offset + this.#chunkBytes);
      offset += chunk.byteLength;
      await this.#sendValidated({
        kind: 'native.provider.chunk',
        ...identity,
        attachmentId: attachment.attachmentId,
        index,
        data: chunk.toString('base64'),
      });
    }
    return ref;
  }

  #serializeOutput(write: () => Promise<void>): Promise<void> {
    const result = this.#writeTail.then(write);
    this.#writeTail = result.catch(() => undefined);
    return result;
  }

  #sendValidated(
    frame: NativeProviderChunkFrame | NativeProviderResultFrame | NativeProviderTurnReleasedFrame,
  ): Promise<void> {
    return this.#transport.send(decodeNativeProviderClientFrame(frame));
  }

  #requireEpoch(hostEpoch: string): void {
    if (hostEpoch !== this.#transport.hostEpoch)
      throw new Error('Native Provider frame belongs to a different Host Epoch');
  }

  #requireInvocation(operationId: string, bindingId: string): Invocation {
    const invocation = this.#invocations.get(operationId);
    if (!invocation || invocation.bindingId !== bindingId) {
      throw new Error('Runtime Host referenced an unmatched Native Provider invocation');
    }
    return invocation;
  }

  #resolveDrainIfReady(): void {
    if (
      this.#admissionOpen ||
      this.#drainStarted ||
      [...this.#invocations.values()].some((item) => item.active)
    ) {
      return;
    }
    this.#drainStarted = true;
    this.#invocations.clear();
    const cleanup = (async () => {
      const tasks = [...this.#seenTurns.entries()].map(([stateKey, identity]) => {
        const existing = this.#turnCleanups.get(stateKey);
        if (existing) return existing.task;
        const task = Promise.resolve().then(() => this.#cleanupTurnState(identity));
        this.#turnCleanups.set(stateKey, { releaseId: '', task });
        return task;
      });
      const outcomes = await Promise.allSettled(tasks);
      const failure = outcomes.find(
        (outcome): outcome is PromiseRejectedResult => outcome.status === 'rejected',
      );
      if (failure) this.#failTransport(asError(failure.reason));
    })();
    void cleanup.finally(() => this.#resolveDrained());
  }

  #failTransport(error: Error): void {
    if (this.#transportFailed) return;
    this.#transportFailed = true;
    this.#admissionOpen = false;
    this.#sendResults = false;
    for (const invocation of this.#invocations.values()) invocation.active?.controller.abort();
    this.#transport.fail(error);
    this.#resolveDrainIfReady();
  }
}

function settlement(): Pick<NonNullable<Invocation['active']>, 'settled' | 'resolveSettled'> {
  let resolveSettled!: () => void;
  const settled = new Promise<void>((resolve) => {
    resolveSettled = resolve;
  });
  return { settled, resolveSettled };
}

function turnReleaseIdentity(frame: NativeProviderTurnReleaseFrame) {
  return {
    hostEpoch: frame.hostEpoch,
    registrationId: frame.registrationId,
    releaseId: frame.releaseId,
    sessionId: frame.sessionId,
    turnId: frame.turnId,
  };
}

function turnStateKey(sessionId: string, turnId: string): string {
  return `${sessionId}\u0000${turnId}`;
}

function invocationOwner(frame: NativeProviderSubcallFrame): InvocationOwner {
  if (frame.capability === 'oauth_presentation') {
    return {
      kind: 'host_operation',
      ownerId: frame.subcall.context.ownerId,
      attemptId: frame.subcall.context.attemptId,
    };
  }
  return {
    kind: 'turn',
    sessionId: frame.subcall.context.sessionId,
    turnId: frame.subcall.context.turnId,
    toolCallId: frame.subcall.context.toolCallId,
  };
}

function sameInvocationOwner(left: InvocationOwner, right: InvocationOwner): boolean {
  if (left.kind !== right.kind) return false;
  if (left.kind === 'host_operation' && right.kind === 'host_operation') {
    return left.ownerId === right.ownerId && left.attemptId === right.attemptId;
  }
  return (
    left.kind === 'turn' &&
    right.kind === 'turn' &&
    left.sessionId === right.sessionId &&
    left.turnId === right.turnId &&
    left.toolCallId === right.toolCallId
  );
}

function requireMatchingAttachment(
  result: NativeProviderResultPayload,
  ref?: NativeProviderAttachmentRef,
): void {
  const refs = nativeProviderResultAttachmentRefs(result);
  if (refs.length !== (ref ? 1 : 0) || (ref && refs[0] !== ref)) {
    throw new Error('Native capability result attachment metadata does not match its chunks');
  }
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error('Native Provider operation failed');
}
