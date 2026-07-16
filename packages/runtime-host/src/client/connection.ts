import { randomUUID } from 'node:crypto';
import { connect } from 'node:net';
import { performance } from 'node:perf_hooks';
import {
  prepareStorageRootControlDirectory,
  resolveStorageRoot,
  type StorageRootCapability,
} from '@maka/storage/root-authority';
import { readHostRegistration, RuntimeHostRegistrationError } from '../control/registration.js';
import {
  decodeHostFrame,
  type ClientSurface,
  type HostIncompatible,
  type HostRegistration,
  type HostStatusResponse,
  type ProtocolRange,
  requireClientInstanceId,
  validateProtocolRange,
} from '../protocol/index.js';
import { FramedTransport } from '../transport/framed-transport.js';

const DEFAULT_CONNECT_TIMEOUT_MS = 500;
const DEFAULT_HANDSHAKE_TIMEOUT_MS = 2_000;

export interface ConnectRuntimeHostInput {
  rootPath: string;
  surface: ClientSurface;
  protocol: ProtocolRange;
  clientInstanceId?: string;
  connectTimeoutMs?: number;
  handshakeTimeoutMs?: number;
}

export type RuntimeHostUnavailableReason =
  | 'not_registered'
  | 'invalid_registration'
  | 'root_mismatch'
  | 'connect_failed'
  | 'handshake_failed'
  | 'epoch_mismatch';

export type ConnectRuntimeHostResult =
  | { kind: 'connected'; connection: RuntimeHostConnection; registration: HostRegistration }
  | { kind: 'incompatible'; handshake: HostIncompatible; registration: HostRegistration }
  | { kind: 'draining'; registration: HostRegistration }
  | { kind: 'unavailable'; reason: RuntimeHostUnavailableReason; registration?: HostRegistration };

interface ConnectResolvedRuntimeHostInput extends Omit<ConnectRuntimeHostInput, 'rootPath' | 'clientInstanceId'> {
  capability: StorageRootCapability<'interactive'>;
  clientInstanceId: string;
  controlDirectory: string;
  electionDeadline?: number;
}

export interface RuntimeHostConnection {
  readonly hostEpoch: string;
  readonly connectionId: string;
  readonly selectedProtocol: number;
  readonly closed: Promise<void>;
  status(timeoutMs?: number): Promise<HostStatusResponse>;
  close(): Promise<void>;
}

class RuntimeHostConnectionImpl implements RuntimeHostConnection {
  readonly hostEpoch: string;
  readonly connectionId: string;
  readonly selectedProtocol: number;
  readonly closed: Promise<void>;
  readonly #transport: FramedTransport;
  #requestTail: Promise<void> = Promise.resolve();
  #terminalError: Error | undefined;

  constructor(
    transport: FramedTransport,
    accepted: {
      hostEpoch: string;
      connectionId: string;
      selectedProtocol: number;
    },
  ) {
    this.#transport = transport;
    this.hostEpoch = accepted.hostEpoch;
    this.connectionId = accepted.connectionId;
    this.selectedProtocol = accepted.selectedProtocol;
    this.closed = this.#transport.closed;
  }

  status(timeoutMs = DEFAULT_HANDSHAKE_TIMEOUT_MS): Promise<HostStatusResponse> {
    const boundedTimeoutMs = requireTimeout(timeoutMs, 'timeoutMs');
    const request = async () => {
      if (this.#terminalError) throw this.#terminalError;
      const requestId = randomUUID();
      try {
        await this.#transport.write({ kind: 'status', requestId });
        const frame = decodeHostFrame(await this.#transport.read(boundedTimeoutMs));
        if (frame.kind !== 'status' || frame.requestId !== requestId || frame.hostEpoch !== this.hostEpoch) {
          throw new Error('Runtime Host returned a mismatched status response');
        }
        return frame;
      } catch (error) {
        this.#terminalError = error instanceof Error ? error : new Error(String(error));
        this.#transport.destroy();
        throw this.#terminalError;
      }
    };
    const result = this.#requestTail.then(request, request);
    this.#requestTail = result.then(() => undefined, () => undefined);
    return result;
  }

  async close(): Promise<void> {
    this.#transport.destroy();
    await this.#transport.closed;
  }
}

export async function connectRuntimeHost(
  input: ConnectRuntimeHostInput,
): Promise<ConnectRuntimeHostResult> {
  validateProtocolRange(input.protocol);
  const connectTimeoutMs = requireTimeout(input.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS, 'connectTimeoutMs');
  const handshakeTimeoutMs = requireTimeout(
    input.handshakeTimeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS,
    'handshakeTimeoutMs',
  );
  const clientInstanceId = requireClientInstanceId(input.clientInstanceId ?? randomUUID());
  const capability = await resolveStorageRoot({ path: input.rootPath, kind: 'interactive' });
  const { controlDirectory } = await prepareStorageRootControlDirectory(capability);
  return connectResolvedRuntimeHost({
    ...input,
    clientInstanceId,
    connectTimeoutMs,
    handshakeTimeoutMs,
    capability,
    controlDirectory,
  });
}

export async function connectResolvedRuntimeHost(
  input: ConnectResolvedRuntimeHostInput,
): Promise<ConnectRuntimeHostResult> {
  validateProtocolRange(input.protocol);
  requireClientInstanceId(input.clientInstanceId);
  const connectTimeoutMs = requireTimeout(input.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS, 'connectTimeoutMs');
  const handshakeTimeoutMs = requireTimeout(
    input.handshakeTimeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS,
    'handshakeTimeoutMs',
  );
  let registration: HostRegistration | undefined;
  try {
    registration = await readRegistrationBeforeDeadline(
      input.controlDirectory,
      input.electionDeadline,
    );
  } catch (error) {
    if (error instanceof RuntimeHostRegistrationError && error.code === 'invalid_registration') {
      return { kind: 'unavailable', reason: 'invalid_registration' };
    }
    return { kind: 'unavailable', reason: 'connect_failed' };
  }
  if (!registration) return { kind: 'unavailable', reason: 'not_registered' };
  if (registration.rootId !== input.capability.rootId) {
    return { kind: 'unavailable', reason: 'root_mismatch', registration };
  }

  const connectDeadline = phaseDeadline(connectTimeoutMs, input.electionDeadline);
  const connectBudget = remainingTimeout(connectDeadline);
  if (connectBudget === undefined) {
    return { kind: 'unavailable', reason: 'connect_failed', registration };
  }
  let transport: FramedTransport;
  try {
    transport = await openTransport(registration.endpoint, connectBudget);
  } catch {
    return { kind: 'unavailable', reason: 'connect_failed', registration };
  }
  const handshakeDeadline = phaseDeadline(handshakeTimeoutMs, input.electionDeadline);
  const handshakeBudget = remainingTimeout(handshakeDeadline);
  if (handshakeBudget === undefined) {
    transport.destroy();
    return { kind: 'unavailable', reason: 'handshake_failed', registration };
  }
  const handshakeTimer = setTimeout(() => {
    transport.destroy(new Error('Timed out handshaking with Runtime Host'));
  }, handshakeBudget);
  try {
    await transport.write({
      kind: 'hello',
      clientInstanceId: input.clientInstanceId,
      surface: input.surface,
      protocolMin: input.protocol.min,
      protocolMax: input.protocol.max,
    });
    const readBudget = remainingTimeout(handshakeDeadline);
    if (readBudget === undefined) throw new Error('Runtime Host handshake deadline elapsed');
    const handshake = decodeHostFrame(
      await transport.read(readBudget),
    );
    if (handshake.kind === 'status') throw new Error('Runtime Host returned status before handshake');
    if (handshake.hostEpoch !== registration.hostEpoch) {
      transport.destroy();
      return { kind: 'unavailable', reason: 'epoch_mismatch', registration };
    }
    if (handshake.kind === 'accepted') {
      if (
        handshake.selectedProtocol < input.protocol.min
        || handshake.selectedProtocol > input.protocol.max
        || handshake.selectedProtocol < registration.protocolMin
        || handshake.selectedProtocol > registration.protocolMax
      ) {
        throw new Error('Runtime Host selected a protocol outside the negotiated range');
      }
      return {
        kind: 'connected',
        registration,
        connection: new RuntimeHostConnectionImpl(transport, handshake),
      };
    }
    transport.destroy();
    if (handshake.kind === 'incompatible') return { kind: 'incompatible', handshake, registration };
    return { kind: 'draining', registration };
  } catch {
    transport.destroy();
    return { kind: 'unavailable', reason: 'handshake_failed', registration };
  } finally {
    clearTimeout(handshakeTimer);
  }
}

function openTransport(path: string, timeoutMs: number): Promise<FramedTransport> {
  return new Promise((resolve, reject) => {
    const socket = connect(path);
    const timer = setTimeout(() => {
      cleanup();
      socket.destroy();
      reject(new Error('Timed out connecting to Runtime Host'));
    }, timeoutMs);
    const onConnect = () => {
      const transport = new FramedTransport(socket);
      cleanup();
      resolve(transport);
    };
    const onError = (error: Error) => {
      cleanup();
      socket.destroy();
      reject(error);
    };
    const cleanup = () => {
      clearTimeout(timer);
      socket.off('connect', onConnect);
      socket.off('error', onError);
    };
    socket.once('connect', onConnect);
    socket.once('error', onError);
  });
}

function requireTimeout(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 120_000) {
    throw new RangeError(`${label} must be an integer between 1 and 120000`);
  }
  return value;
}

function phaseDeadline(timeoutMs: number, outerDeadline: number | undefined): number {
  const deadline = performance.now() + timeoutMs;
  return outerDeadline === undefined ? deadline : Math.min(deadline, outerDeadline);
}

function remainingTimeout(deadline: number): number | undefined {
  const remaining = deadline - performance.now();
  return remaining <= 0 ? undefined : Math.max(1, Math.ceil(remaining));
}

function readRegistrationBeforeDeadline(
  controlDirectory: string,
  deadline: number | undefined,
): Promise<HostRegistration | undefined> {
  if (deadline === undefined) return readHostRegistration(controlDirectory);
  const remaining = remainingTimeout(deadline);
  if (remaining === undefined) {
    return Promise.reject(new Error('Runtime Host election deadline elapsed'));
  }
  const operation = readHostRegistration(controlDirectory);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error('Runtime Host election deadline elapsed')),
      remaining,
    );
    operation.then(
      (registration) => {
        clearTimeout(timer);
        resolve(registration);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}
