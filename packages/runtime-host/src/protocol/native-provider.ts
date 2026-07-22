import {
  decodeNativeProviderBrowserResultPayload,
  decodeNativeProviderBrowserSubcall,
  type NativeProviderBrowserResultPayload,
  type NativeProviderBrowserSubcall,
} from './native-provider-browser.js';
import {
  requireCount,
  requireExactRecord,
  requireId,
  requireRecord,
  requireUtf8BoundedString,
} from './codec.js';
import { invalidProtocolFrame } from './errors.js';
import { defineOperation } from './operation-spec.js';
import {
  decodeNativeProviderComputerUseResultPayload,
  decodeNativeProviderComputerUseSubcall,
  nativeProviderComputerUseResultAttachmentRefs,
  NATIVE_PROVIDER_ATTACHMENT_CHUNK_BYTES,
  NATIVE_PROVIDER_MAX_ATTACHMENTS_PER_RESULT,
  type NativeProviderAttachmentRef,
  type NativeProviderComputerUseResultPayload,
  type NativeProviderComputerUseSubcall,
} from './native-provider-computer-use.js';
import {
  decodeNativeProviderOAuthPresentationResultPayload,
  decodeNativeProviderOAuthPresentationSubcall,
  type NativeProviderOAuthPresentationResultPayload,
  type NativeProviderOAuthPresentationSubcall,
} from './native-provider-oauth-presentation.js';

export {
  decodeNativeProviderOAuthPresentationResultPayload,
  decodeNativeProviderOAuthPresentationSubcall,
  NATIVE_PROVIDER_OAUTH_PRESENTATION_MAX_PASTE_PAYLOAD_UTF8_BYTES,
  NATIVE_PROVIDER_OAUTH_PRESENTATION_MAX_STATE_HINT_UTF8_BYTES,
  NATIVE_PROVIDER_OAUTH_PRESENTATION_MAX_URL_CHARS,
  type NativeProviderOAuthPresentationContext,
  type NativeProviderOAuthPresentationResultPayload,
  type NativeProviderOAuthPresentationSubcall,
} from './native-provider-oauth-presentation.js';

export const NATIVE_PROVIDER_CAPABILITIES = [
  'computer_use',
  'browser',
  'oauth_presentation',
] as const;
export const NATIVE_PROVIDER_MAX_CAPABILITIES = NATIVE_PROVIDER_CAPABILITIES.length;
export const NATIVE_PROVIDER_MAX_PENDING_INVOCATIONS = 8;
export const NATIVE_PROVIDER_MAX_SUBCALLS_PER_INVOCATION = 64;
export const NATIVE_PROVIDER_MAX_INLINE_PAYLOAD_BYTES = 60 * 1024;
export const NATIVE_PROVIDER_FAILURE_CODES = ['operation_failed', 'outcome_unknown'] as const;

const REGISTRATION_ERRORS = [
  'host_not_ready',
  'host_draining',
  'operation_unavailable',
  'invalid_request',
  'not_found',
  'operation_conflict',
  'internal_failure',
] as const;

export type NativeProviderCapability = (typeof NATIVE_PROVIDER_CAPABILITIES)[number];
export type NativeProviderFailureCode = (typeof NATIVE_PROVIDER_FAILURE_CODES)[number];
export type NativeProviderSubcall =
  | NativeProviderComputerUseSubcall
  | NativeProviderBrowserSubcall
  | NativeProviderOAuthPresentationSubcall;
export type NativeProviderResultPayload =
  | NativeProviderComputerUseResultPayload
  | NativeProviderBrowserResultPayload
  | NativeProviderOAuthPresentationResultPayload;

export interface NativeProviderRegisterInput {
  readonly capabilities: readonly NativeProviderCapability[];
}

export interface NativeProviderRegisterResult {
  readonly registrationId: string;
}

export interface NativeProviderUnregisterInput {
  readonly registrationId: string;
}

export type NativeProviderUnregisterResult = NativeProviderUnregisterInput;

export interface NativeProviderInvocationIdentity {
  readonly hostEpoch: string;
  readonly operationId: string;
  readonly bindingId: string;
}

export interface NativeProviderSubcallIdentity extends NativeProviderInvocationIdentity {
  readonly subcallId: string;
  readonly ordinal: number;
}

export interface NativeProviderComputerUseSubcallFrame extends NativeProviderSubcallIdentity {
  readonly kind: 'native.provider.subcall';
  readonly capability: 'computer_use';
  readonly subcall: NativeProviderComputerUseSubcall;
}

export interface NativeProviderBrowserSubcallFrame extends NativeProviderSubcallIdentity {
  readonly kind: 'native.provider.subcall';
  readonly capability: 'browser';
  readonly subcall: NativeProviderBrowserSubcall;
}

export interface NativeProviderOAuthPresentationSubcallFrame extends NativeProviderSubcallIdentity {
  readonly kind: 'native.provider.subcall';
  readonly capability: 'oauth_presentation';
  readonly subcall: NativeProviderOAuthPresentationSubcall;
}

export type NativeProviderSubcallFrame =
  | NativeProviderComputerUseSubcallFrame
  | NativeProviderBrowserSubcallFrame
  | NativeProviderOAuthPresentationSubcallFrame;

export interface NativeProviderCancelFrame extends NativeProviderSubcallIdentity {
  readonly kind: 'native.provider.cancel';
}

export interface NativeProviderReleaseFrame extends NativeProviderInvocationIdentity {
  readonly kind: 'native.provider.release';
}

export interface NativeProviderTurnReleaseIdentity {
  readonly hostEpoch: string;
  readonly registrationId: string;
  readonly releaseId: string;
  readonly sessionId: string;
  readonly turnId: string;
}

export interface NativeProviderTurnReleaseFrame extends NativeProviderTurnReleaseIdentity {
  readonly kind: 'native.provider.turn_release';
}

export interface NativeProviderTurnReleasedFrame extends NativeProviderTurnReleaseIdentity {
  readonly kind: 'native.provider.turn_released';
}

export interface NativeProviderChunkFrame extends NativeProviderSubcallIdentity {
  readonly kind: 'native.provider.chunk';
  readonly attachmentId: string;
  readonly index: number;
  readonly data: string;
}

export type NativeProviderComputerUseResultOutcome =
  | { readonly ok: true; readonly result: NativeProviderComputerUseResultPayload }
  | { readonly ok: false; readonly error: { readonly code: NativeProviderFailureCode } };

export type NativeProviderBrowserResultOutcome =
  | { readonly ok: true; readonly result: NativeProviderBrowserResultPayload }
  | { readonly ok: false; readonly error: { readonly code: NativeProviderFailureCode } };

export type NativeProviderOAuthPresentationResultOutcome =
  | { readonly ok: true; readonly result: NativeProviderOAuthPresentationResultPayload }
  | { readonly ok: false; readonly error: { readonly code: NativeProviderFailureCode } };

export type NativeProviderResultOutcome =
  | NativeProviderComputerUseResultOutcome
  | NativeProviderBrowserResultOutcome
  | NativeProviderOAuthPresentationResultOutcome;

export type NativeProviderComputerUseResultFrame = NativeProviderSubcallIdentity &
  Readonly<{ kind: 'native.provider.result'; capability: 'computer_use' }> &
  NativeProviderComputerUseResultOutcome;

export type NativeProviderBrowserResultFrame = NativeProviderSubcallIdentity &
  Readonly<{ kind: 'native.provider.result'; capability: 'browser' }> &
  NativeProviderBrowserResultOutcome;

export type NativeProviderOAuthPresentationResultFrame = NativeProviderSubcallIdentity &
  Readonly<{ kind: 'native.provider.result'; capability: 'oauth_presentation' }> &
  NativeProviderOAuthPresentationResultOutcome;

export type NativeProviderResultFrame =
  | NativeProviderComputerUseResultFrame
  | NativeProviderBrowserResultFrame
  | NativeProviderOAuthPresentationResultFrame;

export type NativeProviderResultEnvelopeFrame = NativeProviderSubcallIdentity &
  Readonly<{ kind: 'native.provider.result'; capability: NativeProviderCapability }> &
  (
    | { readonly ok: true; readonly result: unknown }
    | { readonly ok: false; readonly error: { readonly code: NativeProviderFailureCode } }
  );

export type NativeProviderHostFrame =
  | NativeProviderSubcallFrame
  | NativeProviderCancelFrame
  | NativeProviderReleaseFrame
  | NativeProviderTurnReleaseFrame;

export type NativeProviderClientFrame =
  | NativeProviderChunkFrame
  | NativeProviderResultFrame
  | NativeProviderTurnReleasedFrame;

export type NativeProviderClientEnvelopeFrame =
  | NativeProviderChunkFrame
  | NativeProviderResultEnvelopeFrame
  | NativeProviderTurnReleasedFrame;

export const NATIVE_PROVIDER_OPERATION_SPECS = {
  'native.provider.register': defineOperation<
    NativeProviderRegisterInput,
    NativeProviderRegisterResult,
    (typeof REGISTRATION_ERRORS)[number]
  >({
    mode: 'control',
    retry: 'none',
    admission: 'ready',
    errors: REGISTRATION_ERRORS,
    decodeInput: decodeNativeProviderRegisterInput,
    decodeOutput: decodeNativeProviderRegisterResult,
  }),
  'native.provider.unregister': defineOperation<
    NativeProviderUnregisterInput,
    NativeProviderUnregisterResult,
    (typeof REGISTRATION_ERRORS)[number]
  >({
    mode: 'control',
    retry: 'none',
    admission: 'ready',
    errors: REGISTRATION_ERRORS,
    decodeInput: decodeNativeProviderUnregisterInput,
    decodeOutput: decodeNativeProviderUnregisterResult,
  }),
} as const;

export function decodeNativeProviderRegisterInput(value: unknown): NativeProviderRegisterInput {
  const input = requireExactRecord(value, 'native Provider register input', ['capabilities']);
  if (!Array.isArray(input.capabilities) || input.capabilities.length === 0) {
    throw invalidProtocolFrame('Native Provider capabilities must be non-empty');
  }
  if (input.capabilities.length > NATIVE_PROVIDER_MAX_CAPABILITIES) {
    throw invalidProtocolFrame('Too many Native Provider capabilities');
  }
  const capabilities = input.capabilities.map(nativeProviderCapability);
  if (new Set(capabilities).size !== capabilities.length) {
    throw invalidProtocolFrame('Duplicate Native Provider capability');
  }
  return { capabilities };
}

export function decodeNativeProviderRegisterResult(value: unknown): NativeProviderRegisterResult {
  const result = requireExactRecord(value, 'native Provider register result', ['registrationId']);
  return { registrationId: requireId(result.registrationId, 'registrationId') };
}

export function decodeNativeProviderUnregisterInput(value: unknown): NativeProviderUnregisterInput {
  return decodeNativeProviderRegisterResult(value);
}

export function decodeNativeProviderUnregisterResult(
  value: unknown,
): NativeProviderUnregisterResult {
  return decodeNativeProviderRegisterResult(value);
}

export function isNativeProviderClientFrameKind(
  value: unknown,
): value is NativeProviderClientFrame['kind'] {
  return (
    value === 'native.provider.chunk' ||
    value === 'native.provider.result' ||
    value === 'native.provider.turn_released'
  );
}

export function isNativeProviderHostFrameKind(
  value: unknown,
): value is NativeProviderHostFrame['kind'] {
  return (
    value === 'native.provider.subcall' ||
    value === 'native.provider.cancel' ||
    value === 'native.provider.release' ||
    value === 'native.provider.turn_release'
  );
}

export function decodeNativeProviderClientFrame(value: unknown): NativeProviderClientFrame {
  const record = requireRecord(value, 'native Provider client frame');
  if (record.kind === 'native.provider.chunk') return decodeNativeProviderChunkFrame(record);
  if (record.kind === 'native.provider.result') return decodeNativeProviderResultFrame(record);
  if (record.kind === 'native.provider.turn_released') {
    return decodeNativeProviderTurnReleasedFrame(record);
  }
  throw invalidProtocolFrame('Invalid Native Provider client frame kind');
}

export function decodeNativeProviderClientEnvelopeFrame(
  value: unknown,
): NativeProviderClientEnvelopeFrame {
  const record = requireRecord(value, 'native Provider client frame');
  if (record.kind === 'native.provider.chunk') return decodeNativeProviderChunkFrame(record);
  if (record.kind === 'native.provider.result') {
    return decodeNativeProviderResultEnvelopeFrame(record);
  }
  if (record.kind === 'native.provider.turn_released') {
    return decodeNativeProviderTurnReleasedFrame(record);
  }
  throw invalidProtocolFrame('Invalid Native Provider client frame kind');
}

export function decodeNativeProviderHostFrame(value: unknown): NativeProviderHostFrame {
  const record = requireRecord(value, 'native Provider host frame');
  if (record.kind === 'native.provider.subcall') return decodeNativeProviderSubcallFrame(record);
  if (record.kind === 'native.provider.cancel') return decodeNativeProviderCancelFrame(record);
  if (record.kind === 'native.provider.release') return decodeNativeProviderReleaseFrame(record);
  if (record.kind === 'native.provider.turn_release') {
    return decodeNativeProviderTurnReleaseFrame(record);
  }
  throw invalidProtocolFrame('Invalid Native Provider host frame kind');
}

export function decodeNativeProviderSubcallFrame(value: unknown): NativeProviderSubcallFrame {
  const frame = requireExactRecord(value, 'native Provider subcall frame', [
    'kind',
    'hostEpoch',
    'operationId',
    'subcallId',
    'ordinal',
    'bindingId',
    'capability',
    'subcall',
  ]);
  if (frame.kind !== 'native.provider.subcall') {
    throw invalidProtocolFrame('Invalid Native Provider subcall');
  }
  const capability = nativeProviderCapability(frame.capability);
  switch (capability) {
    case 'computer_use':
      return {
        kind: 'native.provider.subcall',
        ...decodeSubcallIdentity(frame),
        capability,
        subcall: boundedInlinePayload(
          decodeNativeProviderComputerUseSubcall(frame.subcall),
          'native Provider subcall payload',
        ),
      };
    case 'browser':
      return {
        kind: 'native.provider.subcall',
        ...decodeSubcallIdentity(frame),
        capability,
        subcall: boundedInlinePayload(
          decodeNativeProviderBrowserSubcall(frame.subcall),
          'native Provider subcall payload',
        ),
      };
    case 'oauth_presentation':
      return {
        kind: 'native.provider.subcall',
        ...decodeSubcallIdentity(frame),
        capability,
        subcall: boundedInlinePayload(
          decodeNativeProviderOAuthPresentationSubcall(frame.subcall),
          'native Provider subcall payload',
        ),
      };
  }
}

export function decodeNativeProviderCancelFrame(value: unknown): NativeProviderCancelFrame {
  const frame = requireExactRecord(value, 'native Provider cancel frame', [
    'kind',
    'hostEpoch',
    'operationId',
    'subcallId',
    'ordinal',
    'bindingId',
  ]);
  if (frame.kind !== 'native.provider.cancel') {
    throw invalidProtocolFrame('Invalid Native Provider cancel');
  }
  return { kind: 'native.provider.cancel', ...decodeSubcallIdentity(frame) };
}

export function decodeNativeProviderReleaseFrame(value: unknown): NativeProviderReleaseFrame {
  const frame = requireExactRecord(value, 'native Provider release frame', [
    'kind',
    'hostEpoch',
    'operationId',
    'bindingId',
  ]);
  if (frame.kind !== 'native.provider.release') {
    throw invalidProtocolFrame('Invalid Native Provider release');
  }
  return { kind: 'native.provider.release', ...decodeInvocationIdentity(frame) };
}

export function decodeNativeProviderTurnReleaseFrame(
  value: unknown,
): NativeProviderTurnReleaseFrame {
  const frame = requireExactRecord(value, 'native Provider Turn release frame', [
    'kind',
    'hostEpoch',
    'registrationId',
    'releaseId',
    'sessionId',
    'turnId',
  ]);
  if (frame.kind !== 'native.provider.turn_release') {
    throw invalidProtocolFrame('Invalid Native Provider Turn release');
  }
  return { kind: 'native.provider.turn_release', ...decodeTurnReleaseIdentity(frame) };
}

export function decodeNativeProviderTurnReleasedFrame(
  value: unknown,
): NativeProviderTurnReleasedFrame {
  const frame = requireExactRecord(value, 'native Provider Turn released frame', [
    'kind',
    'hostEpoch',
    'registrationId',
    'releaseId',
    'sessionId',
    'turnId',
  ]);
  if (frame.kind !== 'native.provider.turn_released') {
    throw invalidProtocolFrame('Invalid Native Provider Turn released acknowledgement');
  }
  return { kind: 'native.provider.turn_released', ...decodeTurnReleaseIdentity(frame) };
}

export function decodeNativeProviderChunkFrame(value: unknown): NativeProviderChunkFrame {
  const frame = requireExactRecord(value, 'native Provider chunk frame', [
    'kind',
    'hostEpoch',
    'operationId',
    'subcallId',
    'ordinal',
    'bindingId',
    'attachmentId',
    'index',
    'data',
  ]);
  if (frame.kind !== 'native.provider.chunk') {
    throw invalidProtocolFrame('Invalid Native Provider chunk');
  }
  const data = requireUtf8BoundedString(
    frame.data,
    'native Provider chunk data',
    Math.ceil(NATIVE_PROVIDER_ATTACHMENT_CHUNK_BYTES / 3) * 4,
  );
  if (
    !isCanonicalBase64(data) ||
    Buffer.from(data, 'base64').byteLength > NATIVE_PROVIDER_ATTACHMENT_CHUNK_BYTES
  ) {
    throw invalidProtocolFrame('Invalid Native Provider chunk data');
  }
  return {
    kind: 'native.provider.chunk',
    ...decodeSubcallIdentity(frame),
    attachmentId: requireId(frame.attachmentId, 'attachmentId'),
    index: requireCount(frame.index, 'native Provider chunk index'),
    data,
  };
}

export function decodeNativeProviderResultFrame(value: unknown): NativeProviderResultFrame {
  const frame = requireRecord(value, 'native Provider result frame');
  const identity = decodeSubcallIdentity(frame);
  if (frame.kind !== 'native.provider.result') {
    throw invalidProtocolFrame('Invalid Native Provider result');
  }
  if (frame.ok === false) {
    const failure = requireExactRecord(frame, 'native Provider result failure', [
      'kind',
      'hostEpoch',
      'operationId',
      'subcallId',
      'ordinal',
      'bindingId',
      'capability',
      'ok',
      'error',
    ]);
    const error = requireExactRecord(failure.error, 'native Provider failure error', ['code']);
    if (!(NATIVE_PROVIDER_FAILURE_CODES as readonly unknown[]).includes(error.code)) {
      throw invalidProtocolFrame('Invalid Native Provider failure code');
    }
    const capability = nativeProviderCapability(failure.capability);
    const result = {
      kind: 'native.provider.result' as const,
      ...identity,
      ok: false as const,
      error: { code: error.code as NativeProviderFailureCode },
    };
    switch (capability) {
      case 'computer_use':
        return { ...result, capability };
      case 'browser':
        return { ...result, capability };
      case 'oauth_presentation':
        return { ...result, capability };
    }
  }
  if (frame.ok !== true) throw invalidProtocolFrame('Invalid Native Provider result outcome');
  const success = requireExactRecord(frame, 'native Provider result success', [
    'kind',
    'hostEpoch',
    'operationId',
    'subcallId',
    'ordinal',
    'bindingId',
    'capability',
    'ok',
    'result',
  ]);
  const capability = nativeProviderCapability(success.capability);
  switch (capability) {
    case 'computer_use': {
      const result = boundedInlinePayload(
        decodeNativeProviderComputerUseResultPayload(success.result),
        'native Provider result payload',
      );
      if (
        nativeProviderComputerUseResultAttachmentRefs(result).length >
        NATIVE_PROVIDER_MAX_ATTACHMENTS_PER_RESULT
      ) {
        throw invalidProtocolFrame('Native Provider result has too many attachments');
      }
      return { kind: 'native.provider.result', ...identity, capability, ok: true, result };
    }
    case 'browser': {
      const result = boundedInlinePayload(
        decodeNativeProviderBrowserResultPayload(success.result),
        'native Provider result payload',
      );
      return { kind: 'native.provider.result', ...identity, capability, ok: true, result };
    }
    case 'oauth_presentation': {
      const result = boundedInlinePayload(
        decodeNativeProviderOAuthPresentationResultPayload(success.result),
        'native Provider result payload',
      );
      return { kind: 'native.provider.result', ...identity, capability, ok: true, result };
    }
  }
}

export function decodeNativeProviderResultEnvelopeFrame(
  value: unknown,
): NativeProviderResultEnvelopeFrame {
  const frame = requireRecord(value, 'native Provider result frame');
  if (frame.kind !== 'native.provider.result') {
    throw invalidProtocolFrame('Invalid Native Provider result');
  }
  const capability = nativeProviderCapability(frame.capability);
  const identity = decodeSubcallIdentity(frame);
  if (frame.ok === false) {
    const failure = requireExactRecord(frame, 'native Provider result failure', [
      'kind',
      'hostEpoch',
      'operationId',
      'subcallId',
      'ordinal',
      'bindingId',
      'capability',
      'ok',
      'error',
    ]);
    const error = requireExactRecord(failure.error, 'native Provider failure error', ['code']);
    if (!(NATIVE_PROVIDER_FAILURE_CODES as readonly unknown[]).includes(error.code)) {
      throw invalidProtocolFrame('Invalid Native Provider failure code');
    }
    return {
      kind: 'native.provider.result',
      ...identity,
      capability,
      ok: false,
      error: { code: error.code as NativeProviderFailureCode },
    };
  }
  if (frame.ok !== true) throw invalidProtocolFrame('Invalid Native Provider result outcome');
  const success = requireExactRecord(frame, 'native Provider result success', [
    'kind',
    'hostEpoch',
    'operationId',
    'subcallId',
    'ordinal',
    'bindingId',
    'capability',
    'ok',
    'result',
  ]);
  return {
    kind: 'native.provider.result',
    ...identity,
    capability,
    ok: true,
    result: boundedInlinePayload(success.result, 'native Provider result payload'),
  };
}

export function nativeProviderResultAttachmentRefs(
  result: NativeProviderResultPayload,
): readonly NativeProviderAttachmentRef[] {
  switch (result.kind) {
    case 'preflight':
    case 'listApps':
    case 'observeApp':
    case 'runSemantic':
    case 'captureObservation':
    case 'run':
      return nativeProviderComputerUseResultAttachmentRefs(result);
    case 'navigate':
    case 'snapshot':
    case 'click':
    case 'type':
    case 'wait':
    case 'extract':
      return [];
    case 'open_external':
    case 'request_authorization_code':
      return [];
  }
}

function decodeInvocationIdentity(
  record: Record<string, unknown>,
): NativeProviderInvocationIdentity {
  return {
    hostEpoch: requireId(record.hostEpoch, 'hostEpoch'),
    operationId: requireId(record.operationId, 'operationId'),
    bindingId: requireId(record.bindingId, 'bindingId'),
  };
}

function decodeTurnReleaseIdentity(
  record: Record<string, unknown>,
): NativeProviderTurnReleaseIdentity {
  return {
    hostEpoch: requireId(record.hostEpoch, 'hostEpoch'),
    registrationId: requireId(record.registrationId, 'registrationId'),
    releaseId: requireId(record.releaseId, 'releaseId'),
    sessionId: requireId(record.sessionId, 'sessionId'),
    turnId: requireId(record.turnId, 'turnId'),
  };
}

function decodeSubcallIdentity(record: Record<string, unknown>): NativeProviderSubcallIdentity {
  const ordinal = requireCount(record.ordinal, 'native Provider ordinal');
  if (ordinal === 0 || ordinal > NATIVE_PROVIDER_MAX_SUBCALLS_PER_INVOCATION) {
    throw invalidProtocolFrame('Invalid Native Provider ordinal');
  }
  return {
    ...decodeInvocationIdentity(record),
    subcallId: requireId(record.subcallId, 'subcallId'),
    ordinal,
  };
}

function boundedInlinePayload<T>(value: T, label: string): T {
  const encoded = JSON.stringify(value);
  if (
    encoded === undefined ||
    Buffer.byteLength(encoded, 'utf8') > NATIVE_PROVIDER_MAX_INLINE_PAYLOAD_BYTES
  ) {
    throw invalidProtocolFrame(`${label} exceeds inline byte limit`);
  }
  return value;
}

function nativeProviderCapability(value: unknown): NativeProviderCapability {
  if (!(NATIVE_PROVIDER_CAPABILITIES as readonly unknown[]).includes(value)) {
    throw invalidProtocolFrame('Unsupported Native Provider capability');
  }
  return value as NativeProviderCapability;
}

function isCanonicalBase64(value: string): boolean {
  if (value.length === 0 || value.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) {
    return false;
  }
  return Buffer.from(value, 'base64').toString('base64') === value;
}
