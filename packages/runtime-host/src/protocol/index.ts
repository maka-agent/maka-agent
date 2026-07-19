import { TextDecoder } from 'node:util';
import { invalidProtocolFrame, RuntimeHostProtocolError } from './errors.js';
import {
  decodeRequestFrame,
  decodeResponseFrame,
  type HostLifecycleState,
  type RequestFrame,
  type ResponseFrame,
} from './operations.js';

export { RuntimeHostProtocolError } from './errors.js';
export * from './operations.js';

export const RUNTIME_HOST_REGISTRATION_SCHEMA_VERSION = 1 as const;
export const RUNTIME_HOST_PROTOCOL_VERSION = 2 as const;
export const RUNTIME_HOST_MAX_FRAME_BYTES = 64 * 1024;

export type ClientSurface = 'desktop' | 'tui' | 'run' | 'bot' | 'open_gateway' | 'inspect';

export interface ProtocolRange {
  min: number;
  max: number;
}

export interface ClientHello {
  kind: 'hello';
  clientInstanceId: string;
  surface: ClientSurface;
  protocolMin: number;
  protocolMax: number;
}

export interface HostAccepted {
  kind: 'accepted';
  hostEpoch: string;
  connectionId: string;
  selectedProtocol: number;
  state: Exclude<HostLifecycleState, 'draining'>;
}

export interface HostIncompatible {
  kind: 'incompatible';
  hostEpoch: string;
  protocolMin: number;
  protocolMax: number;
  state: HostLifecycleState;
  replacement: 'blocked_by_residency' | 'wait_for_idle_exit';
}

export interface HostDraining {
  kind: 'draining';
  hostEpoch: string;
}

export type HostHandshakeResult = HostAccepted | HostIncompatible | HostDraining;

export type ClientFrame = ClientHello | RequestFrame;
export type HostFrame = HostHandshakeResult | ResponseFrame;

export interface HostRegistration {
  kind: 'maka-runtime-host';
  schemaVersion: typeof RUNTIME_HOST_REGISTRATION_SCHEMA_VERSION;
  rootId: string;
  hostEpoch: string;
  endpoint: string;
  protocolMin: number;
  protocolMax: number;
  state: HostLifecycleState;
  pid: number;
  createdAt: string;
}

export function negotiateProtocol(client: ProtocolRange, host: ProtocolRange): number | undefined {
  validateProtocolRange(client);
  validateProtocolRange(host);
  const selected = Math.min(client.max, host.max);
  return selected >= Math.max(client.min, host.min) ? selected : undefined;
}

export function validateProtocolRange(range: ProtocolRange): void {
  if (
    !Number.isSafeInteger(range.min) ||
    !Number.isSafeInteger(range.max) ||
    range.min < 1 ||
    range.max < range.min
  ) {
    throw invalidFrame('Invalid protocol range');
  }
}

export function requireClientInstanceId(value: unknown): string {
  return requireId(value, 'clientInstanceId');
}

export function decodeClientFrame(value: unknown): ClientFrame {
  const frame = requireRecord(value, 'client frame');
  if (frame.kind === 'hello') {
    const protocolMin = requireProtocolVersion(frame.protocolMin, 'protocolMin');
    const protocolMax = requireProtocolVersion(frame.protocolMax, 'protocolMax');
    validateProtocolRange({ min: protocolMin, max: protocolMax });
    return {
      kind: 'hello',
      clientInstanceId: requireClientInstanceId(frame.clientInstanceId),
      surface: requireSurface(frame.surface),
      protocolMin,
      protocolMax,
    } satisfies ClientHello;
  }
  return decodeRequestFrame(frame);
}

export function decodeHostFrame(value: unknown): HostFrame {
  const frame = requireRecord(value, 'host frame');
  if (frame.kind === 'accepted') {
    return {
      kind: 'accepted',
      hostEpoch: requireId(frame.hostEpoch, 'hostEpoch'),
      connectionId: requireId(frame.connectionId, 'connectionId'),
      selectedProtocol: requireProtocolVersion(frame.selectedProtocol, 'selectedProtocol'),
      state: requireAcceptedState(frame.state),
    } satisfies HostAccepted;
  }
  if (frame.kind === 'incompatible') {
    const protocolMin = requireProtocolVersion(frame.protocolMin, 'protocolMin');
    const protocolMax = requireProtocolVersion(frame.protocolMax, 'protocolMax');
    validateProtocolRange({ min: protocolMin, max: protocolMax });
    return {
      kind: 'incompatible',
      hostEpoch: requireId(frame.hostEpoch, 'hostEpoch'),
      protocolMin,
      protocolMax,
      state: requireHostState(frame.state),
      replacement: requireReplacement(frame.replacement),
    } satisfies HostIncompatible;
  }
  if (frame.kind === 'draining') {
    return { kind: 'draining', hostEpoch: requireId(frame.hostEpoch, 'hostEpoch') };
  }
  return decodeResponseFrame(frame);
}

export function decodeHostRegistration(value: unknown): HostRegistration {
  const registration = requireRecord(value, 'host registration');
  if (registration.kind !== 'maka-runtime-host') throw invalidFrame('Invalid registration kind');
  if (registration.schemaVersion !== RUNTIME_HOST_REGISTRATION_SCHEMA_VERSION) {
    throw invalidFrame('Unsupported registration schema');
  }
  const protocolMin = requireProtocolVersion(registration.protocolMin, 'protocolMin');
  const protocolMax = requireProtocolVersion(registration.protocolMax, 'protocolMax');
  validateProtocolRange({ min: protocolMin, max: protocolMax });
  const rootId = requireString(registration.rootId, 'rootId', 128);
  if (!/^[a-f0-9]{64}$/.test(rootId)) throw invalidFrame('Invalid rootId');
  const pid = requireCount(registration.pid, 'pid');
  if (pid === 0) throw invalidFrame('Invalid pid');
  return {
    kind: 'maka-runtime-host',
    schemaVersion: RUNTIME_HOST_REGISTRATION_SCHEMA_VERSION,
    rootId,
    hostEpoch: requireId(registration.hostEpoch, 'hostEpoch'),
    endpoint: requireString(registration.endpoint, 'endpoint', 512),
    protocolMin,
    protocolMax,
    state: requireHostState(registration.state),
    pid,
    createdAt: requireString(registration.createdAt, 'createdAt', 64),
  };
}

export function encodeProtocolFrame(value: ClientFrame | HostFrame): Buffer {
  const encoded = Buffer.from(`${JSON.stringify(value)}\n`, 'utf8');
  if (encoded.byteLength > RUNTIME_HOST_MAX_FRAME_BYTES) {
    throw new RuntimeHostProtocolError(
      'frame_too_large',
      'Runtime Host frame exceeds the byte limit',
    );
  }
  return encoded;
}

export class ProtocolFrameDecoder {
  readonly #decoder = new TextDecoder('utf-8', { fatal: true });
  #pending = Buffer.alloc(0);

  push(chunk: Uint8Array): unknown[] {
    const frames: unknown[] = [];
    let offset = 0;
    while (offset < chunk.byteLength) {
      const newline = chunk.indexOf(0x0a, offset);
      const end = newline === -1 ? chunk.byteLength : newline;
      const segment = Buffer.from(chunk.subarray(offset, end));
      const delimiterBytes = newline === -1 ? 0 : 1;
      if (
        this.#pending.byteLength + segment.byteLength + delimiterBytes >
        RUNTIME_HOST_MAX_FRAME_BYTES
      ) {
        throw new RuntimeHostProtocolError(
          'frame_too_large',
          'Runtime Host frame exceeds the byte limit',
        );
      }
      if (segment.byteLength > 0) this.#pending = Buffer.concat([this.#pending, segment]);
      if (newline === -1) break;
      frames.push(this.#decodePending());
      this.#pending = Buffer.alloc(0);
      offset = newline + 1;
    }
    return frames;
  }

  end(): void {
    if (this.#pending.byteLength !== 0) {
      throw new RuntimeHostProtocolError(
        'invalid_frame',
        'Runtime Host stream ended with a partial frame',
      );
    }
  }

  #decodePending(): unknown {
    if (this.#pending.byteLength === 0) throw invalidFrame('Runtime Host frame is empty');
    let text: string;
    try {
      const bytes = this.#pending.at(-1) === 0x0d ? this.#pending.subarray(0, -1) : this.#pending;
      text = this.#decoder.decode(bytes);
    } catch {
      throw new RuntimeHostProtocolError('invalid_utf8', 'Runtime Host frame is not valid UTF-8');
    }
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new RuntimeHostProtocolError('invalid_json', 'Runtime Host frame is not valid JSON');
    }
  }
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw invalidFrame(`Invalid ${label}`);
  return value as Record<string, unknown>;
}

function requireString(value: unknown, label: string, maxLength: number): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > maxLength) {
    throw invalidFrame(`Invalid ${label}`);
  }
  return value;
}

function requireId(value: unknown, label: string): string {
  return requireString(value, label, 128);
}

function requireProtocolVersion(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) throw invalidFrame(`Invalid ${label}`);
  return value as number;
}

function requireCount(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw invalidFrame(`Invalid ${label}`);
  return value as number;
}

function requireSurface(value: unknown): ClientSurface {
  if (
    value === 'desktop' ||
    value === 'tui' ||
    value === 'run' ||
    value === 'bot' ||
    value === 'open_gateway' ||
    value === 'inspect'
  )
    return value;
  throw invalidFrame('Invalid surface');
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
  throw invalidFrame('Invalid Host state');
}

function requireAcceptedState(value: unknown): Exclude<HostLifecycleState, 'draining'> {
  const state = requireHostState(value);
  if (state === 'draining') throw invalidFrame('Accepted Host cannot be draining');
  return state;
}

function requireReplacement(value: unknown): HostIncompatible['replacement'] {
  if (value === 'blocked_by_residency' || value === 'wait_for_idle_exit') return value;
  throw invalidFrame('Invalid replacement disposition');
}

function invalidFrame(message: string): RuntimeHostProtocolError {
  return invalidProtocolFrame(message);
}
