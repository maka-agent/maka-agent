import {
  COMPUTER_USE_DISPATCH_TIERS,
  COMPUTER_USE_EFFECTS,
  isComputerUseErrorCode,
  type ComputerUseDispatchTier,
  type ComputerUseEffect,
  type ComputerUseErrorCode,
} from '@maka/core/computer-use';
import {
  requireCount,
  requireExactRecord,
  requireId,
  requireRecord,
  requireUtf8BoundedString,
} from './codec.js';
import { invalidProtocolFrame } from './errors.js';

export const NATIVE_PROVIDER_ATTACHMENT_CHUNK_BYTES = 32 * 1024;
export const NATIVE_PROVIDER_MAX_ATTACHMENTS_PER_RESULT = 1;
export const NATIVE_PROVIDER_MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024;
export const NATIVE_PROVIDER_MAX_RESULT_ATTACHMENT_BYTES = 8 * 1024 * 1024;
export const NATIVE_PROVIDER_MAX_APPS = 128;
export const NATIVE_PROVIDER_MAX_WINDOWS_PER_APP = 64;
export const NATIVE_PROVIDER_MAX_WINDOWS = 512;
export const NATIVE_PROVIDER_MAX_DISPLAYS = 16;
export const NATIVE_PROVIDER_MAX_ELEMENTS = 500;

const MAX_NAME_BYTES = 512;
const MAX_TITLE_BYTES = 1_024;
const MAX_TEXT_BYTES = 8_000;
const MAX_ELEMENT_VALUE_BYTES = 8_000;
const MAX_COORDINATE_ABS = 10_000_000;
const MAX_DURATION_MS = 3_600_000;
const MAX_SCROLL_AMOUNT = 100;

export interface NativeProviderComputerUseContext {
  readonly sessionId: string;
  readonly turnId: string;
  readonly toolCallId: string;
  readonly backendObservationId?: string;
  readonly boundAction?: NativeProviderBoundAction;
}

export interface NativeProviderPoint {
  readonly x: number;
  readonly y: number;
}

export interface NativeProviderRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface NativeProviderDisplay {
  readonly displayId: string;
  readonly logicalBounds: NativeProviderRect;
  readonly sourceBoundsPx: NativeProviderRect;
  readonly scaleFactor: number;
}

export interface NativeProviderWindowTarget {
  readonly pid: number;
  readonly windowId: number;
  readonly bundleId?: string;
  readonly appName?: string;
  readonly title?: string;
  readonly bounds?: NativeProviderRect;
  readonly sourceBoundsPx?: NativeProviderRect;
  readonly zIndex?: number;
  readonly contentFingerprint?: string;
}

export interface NativeProviderBoundAction {
  readonly frameId: string;
  readonly epoch: number;
  readonly target: NativeProviderWindowTarget;
  readonly display?: NativeProviderDisplay;
  readonly elementId?: string;
  readonly sourceCoordinate?: NativeProviderPoint;
  readonly sourceStartCoordinate?: NativeProviderPoint;
  readonly windowCoordinate?: NativeProviderPoint;
  readonly windowStartCoordinate?: NativeProviderPoint;
  readonly coordinateSpace?: 'window-screenshot-local';
}

export interface NativeProviderObserveInput {
  readonly app?: string;
  readonly windowId?: number;
  readonly includeScreenshot: boolean;
}

export interface NativeProviderElementIdentity {
  readonly role: string;
  readonly label?: string;
  readonly value?: string;
}

export interface NativeProviderObservedElement {
  readonly elementId: string;
  readonly role: string;
  readonly label?: string;
  readonly value?: string;
  readonly frame?: NativeProviderRect;
  readonly identity?: NativeProviderElementIdentity;
}

export interface NativeProviderAttachmentRef {
  readonly attachmentId: string;
  readonly byteLength: number;
  readonly sha256: string;
  readonly mimeType: 'image/png' | 'image/jpeg';
}

export interface NativeProviderScreenshot {
  readonly image: NativeProviderAttachmentRef;
  readonly widthPx: number;
  readonly heightPx: number;
}

export interface NativeProviderObservation {
  readonly observationId: string;
  readonly appId: string;
  readonly pid: number;
  readonly windowId: number;
  readonly windowTitle?: string;
  readonly capturedAt?: number;
  readonly windowBounds?: NativeProviderRect;
  readonly sourceBoundsPx?: NativeProviderRect;
  readonly zIndex?: number;
  readonly bundleId?: string;
  readonly contentFingerprint?: string;
  readonly displays?: readonly NativeProviderDisplay[];
  readonly elements: readonly NativeProviderObservedElement[];
  readonly screenshot?: NativeProviderScreenshot;
}

export interface NativeProviderAppSummary {
  readonly appId: string;
  readonly pid: number;
  readonly name?: string;
  readonly windowCount: number;
  readonly windows?: readonly NativeProviderWindowSummary[];
}

export interface NativeProviderWindowSummary {
  readonly windowId: number;
  readonly title?: string;
}

export type NativeProviderSemanticAction =
  | {
      readonly type: 'click_element';
      readonly observationId: string;
      readonly elementId: string;
      readonly elementIdentity?: NativeProviderElementIdentity;
    }
  | {
      readonly type: 'set_value';
      readonly observationId: string;
      readonly elementId: string;
      readonly value: string;
      readonly elementIdentity?: NativeProviderElementIdentity;
    }
  | {
      readonly type: 'select_text';
      readonly observationId: string;
      readonly elementId: string;
      readonly text: string;
      readonly elementIdentity?: NativeProviderElementIdentity;
    }
  | {
      readonly type: 'secondary_action';
      readonly observationId: string;
      readonly elementId: string;
      readonly action: string;
      readonly elementIdentity?: NativeProviderElementIdentity;
    }
  | {
      readonly type: 'press_key';
      readonly observationId: string;
      readonly key: string;
    };

export type NativeProviderAction =
  | { readonly type: 'screenshot' }
  | { readonly type: 'cursor_position' }
  | { readonly type: 'mouse_move'; readonly coordinate: NativeProviderPoint }
  | NativeProviderPointerClickAction
  | {
      readonly type: 'left_mouse_down';
      readonly coordinate: NativeProviderPoint;
    }
  | { readonly type: 'left_mouse_up'; readonly coordinate: NativeProviderPoint }
  | {
      readonly type: 'left_click_drag';
      readonly startCoordinate: NativeProviderPoint;
      readonly coordinate: NativeProviderPoint;
      readonly text?: string;
    }
  | { readonly type: 'type'; readonly text: string }
  | { readonly type: 'key'; readonly text: string }
  | {
      readonly type: 'hold_key';
      readonly text: string;
      readonly durationMs: number;
    }
  | {
      readonly type: 'scroll';
      readonly coordinate: NativeProviderPoint;
      readonly scrollDirection: 'up' | 'down' | 'left' | 'right';
      readonly scrollAmount: number;
      readonly text?: string;
    }
  | { readonly type: 'wait'; readonly durationMs: number }
  | {
      readonly type: 'zoom';
      readonly region: Readonly<{
        x1: number;
        y1: number;
        x2: number;
        y2: number;
      }>;
    };

export type NativeProviderPointerClickAction =
  | NativeProviderPointerClick<'left_click'>
  | NativeProviderPointerClick<'right_click'>
  | NativeProviderPointerClick<'middle_click'>
  | NativeProviderPointerClick<'double_click'>
  | NativeProviderPointerClick<'triple_click'>;

type NativeProviderPointerClick<Type extends string> = Readonly<{
  type: Type;
  coordinate: NativeProviderPoint;
  text?: string;
}>;

export type NativeProviderComputerUseActionOutcome =
  | {
      readonly ok: true;
      readonly tier: ComputerUseDispatchTier;
      readonly verified?: boolean;
      readonly effect?: ComputerUseEffect;
      readonly completedSubSteps?: number;
    }
  | {
      readonly ok: false;
      readonly error: ComputerUseErrorCode;
      readonly completedSubSteps?: number;
    };

export interface NativeProviderRunResult {
  readonly outcome: NativeProviderComputerUseActionOutcome;
  readonly resolvedScreenPoint?: NativeProviderPoint;
  readonly screenshot?: NativeProviderScreenshot;
  readonly observation?: NativeProviderObservation;
}

export type NativeProviderComputerUseSubcall =
  | {
      readonly kind: 'preflight';
      readonly context: NativeProviderComputerUseContext;
    }
  | {
      readonly kind: 'listApps';
      readonly context: NativeProviderComputerUseContext;
    }
  | {
      readonly kind: 'observeApp';
      readonly input: NativeProviderObserveInput;
      readonly context: NativeProviderComputerUseContext;
    }
  | {
      readonly kind: 'runSemantic';
      readonly action: NativeProviderSemanticAction;
      readonly context: NativeProviderComputerUseContext;
    }
  | {
      readonly kind: 'captureObservation';
      readonly input: NativeProviderObserveInput & Readonly<{ includeScreenshot: true }>;
      readonly context: NativeProviderComputerUseContext;
    }
  | {
      readonly kind: 'run';
      readonly action: NativeProviderAction;
      readonly context: NativeProviderComputerUseContext;
    };

export type NativeProviderComputerUseResultPayload =
  | {
      readonly kind: 'preflight';
      readonly accessibility: boolean;
      readonly screenRecording: boolean;
    }
  | {
      readonly kind: 'listApps';
      readonly apps: readonly NativeProviderAppSummary[];
    }
  | {
      readonly kind: 'observeApp';
      readonly observation: NativeProviderObservation;
    }
  | { readonly kind: 'runSemantic'; readonly result: NativeProviderRunResult }
  | {
      readonly kind: 'captureObservation';
      readonly observation: NativeProviderObservation;
    }
  | { readonly kind: 'run'; readonly result: NativeProviderRunResult };

export function decodeNativeProviderComputerUseSubcall(
  value: unknown,
): NativeProviderComputerUseSubcall {
  const subcall = requireRecord(value, 'native Provider subcall');
  if (subcall.kind === 'preflight') {
    const preflight = requireExactRecord(subcall, 'native Provider preflight subcall', [
      'kind',
      'context',
    ]);
    return {
      kind: 'preflight',
      context: decodeNativeProviderComputerUseContext(preflight.context),
    };
  }
  if (subcall.kind === 'listApps') {
    const listApps = requireExactRecord(subcall, 'native Provider listApps subcall', [
      'kind',
      'context',
    ]);
    return {
      kind: 'listApps',
      context: decodeNativeProviderComputerUseContext(listApps.context),
    };
  }
  if (subcall.kind === 'observeApp') {
    const observed = requireExactRecord(subcall, 'native Provider observeApp subcall', [
      'kind',
      'input',
      'context',
    ]);
    return {
      kind: 'observeApp',
      input: decodeObserveInput(observed.input, undefined),
      context: decodeNativeProviderComputerUseContext(observed.context),
    };
  }
  if (subcall.kind === 'captureObservation') {
    const observed = requireExactRecord(subcall, 'native Provider captureObservation subcall', [
      'kind',
      'input',
      'context',
    ]);
    return {
      kind: 'captureObservation',
      input: decodeObserveInput(observed.input, true) as NativeProviderObserveInput &
        Readonly<{ includeScreenshot: true }>,
      context: decodeNativeProviderComputerUseContext(observed.context),
    };
  }
  if (subcall.kind === 'runSemantic') {
    const run = requireExactRecord(subcall, 'native Provider runSemantic subcall', [
      'kind',
      'action',
      'context',
    ]);
    return {
      kind: 'runSemantic',
      action: decodeSemanticAction(run.action),
      context: decodeNativeProviderComputerUseContext(run.context),
    };
  }
  if (subcall.kind === 'run') {
    const run = requireExactRecord(subcall, 'native Provider run subcall', [
      'kind',
      'action',
      'context',
    ]);
    return {
      kind: 'run',
      action: decodeNativeProviderAction(run.action),
      context: decodeNativeProviderComputerUseContext(run.context),
    };
  }
  throw invalidProtocolFrame('Invalid Native Provider subcall kind');
}

export function decodeNativeProviderComputerUseResultPayload(
  value: unknown,
): NativeProviderComputerUseResultPayload {
  const result = requireRecord(value, 'native Provider result payload');
  if (result.kind === 'preflight') {
    const preflight = requireExactRecord(result, 'native Provider preflight result', [
      'kind',
      'accessibility',
      'screenRecording',
    ]);
    return {
      kind: 'preflight',
      accessibility: requireBoolean(preflight.accessibility, 'preflight accessibility'),
      screenRecording: requireBoolean(preflight.screenRecording, 'preflight screenRecording'),
    };
  }
  if (result.kind === 'listApps') {
    const list = requireExactRecord(result, 'native Provider listApps result', ['kind', 'apps']);
    const apps = decodeBoundedArray(list.apps, 'apps', NATIVE_PROVIDER_MAX_APPS, decodeAppSummary);
    if (apps.reduce((total, app) => total + app.windowCount, 0) > NATIVE_PROVIDER_MAX_WINDOWS) {
      throw invalidProtocolFrame('Native Provider app list has too many windows');
    }
    return { kind: 'listApps', apps };
  }
  if (result.kind === 'observeApp') {
    const observed = requireExactRecord(result, 'native Provider observeApp result', [
      'kind',
      'observation',
    ]);
    return {
      kind: 'observeApp',
      observation: decodeObservation(observed.observation),
    };
  }
  if (result.kind === 'captureObservation') {
    const observed = requireExactRecord(result, 'native Provider captureObservation result', [
      'kind',
      'observation',
    ]);
    return {
      kind: 'captureObservation',
      observation: decodeObservation(observed.observation),
    };
  }
  if (result.kind === 'runSemantic') {
    const run = requireExactRecord(result, 'native Provider runSemantic result', [
      'kind',
      'result',
    ]);
    return { kind: 'runSemantic', result: decodeRunResult(run.result) };
  }
  if (result.kind === 'run') {
    const run = requireExactRecord(result, 'native Provider run result', ['kind', 'result']);
    return { kind: 'run', result: decodeRunResult(run.result) };
  }
  throw invalidProtocolFrame('Invalid Native Provider result kind');
}

export function decodeNativeProviderComputerUseContext(
  value: unknown,
): NativeProviderComputerUseContext {
  const record = requireRecord(value, 'native Provider computer use context');
  const fields = optionalFields(record, ['backendObservationId', 'boundAction']);
  const context = requireExactRecord(record, 'native Provider computer use context', [
    'sessionId',
    'turnId',
    'toolCallId',
    ...fields,
  ]);
  return {
    sessionId: requireId(context.sessionId, 'sessionId'),
    turnId: requireId(context.turnId, 'turnId'),
    toolCallId: requireId(context.toolCallId, 'toolCallId'),
    ...(context.backendObservationId === undefined
      ? {}
      : {
          backendObservationId: requireId(context.backendObservationId, 'backendObservationId'),
        }),
    ...(context.boundAction === undefined
      ? {}
      : { boundAction: decodeBoundAction(context.boundAction) }),
  };
}

export function decodeNativeProviderAttachmentRef(value: unknown): NativeProviderAttachmentRef {
  const ref = requireExactRecord(value, 'native Provider attachment ref', [
    'attachmentId',
    'byteLength',
    'sha256',
    'mimeType',
  ]);
  const byteLength = requireCount(ref.byteLength, 'attachment byteLength');
  if (byteLength === 0 || byteLength > NATIVE_PROVIDER_MAX_ATTACHMENT_BYTES) {
    throw invalidProtocolFrame('Invalid attachment byteLength');
  }
  if (typeof ref.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(ref.sha256)) {
    throw invalidProtocolFrame('Invalid attachment sha256');
  }
  return {
    attachmentId: requireId(ref.attachmentId, 'attachmentId'),
    byteLength,
    sha256: ref.sha256,
    mimeType: imageMimeType(ref.mimeType),
  };
}

export function decodeNativeProviderComputerUseActionOutcome(
  value: unknown,
): NativeProviderComputerUseActionOutcome {
  const outcome = requireRecord(value, 'native Provider action outcome');
  if (outcome.ok === false) {
    const optional = optionalFields(outcome, ['completedSubSteps']);
    const failure = requireExactRecord(outcome, 'native Provider action failure', [
      'ok',
      'error',
      ...optional,
    ]);
    if (!isComputerUseErrorCode(failure.error)) {
      throw invalidProtocolFrame('Invalid native Provider action error');
    }
    return {
      ok: false,
      error: failure.error,
      ...(failure.completedSubSteps === undefined
        ? {}
        : {
            completedSubSteps: requireCount(failure.completedSubSteps, 'completedSubSteps'),
          }),
    };
  }
  if (outcome.ok !== true) throw invalidProtocolFrame('Invalid native Provider action outcome');
  const optional = optionalFields(outcome, ['verified', 'effect', 'completedSubSteps']);
  const success = requireExactRecord(outcome, 'native Provider action success', [
    'ok',
    'tier',
    ...optional,
  ]);
  if (!(COMPUTER_USE_DISPATCH_TIERS as readonly unknown[]).includes(success.tier)) {
    throw invalidProtocolFrame('Invalid native Provider action tier');
  }
  if (success.verified !== undefined && typeof success.verified !== 'boolean') {
    throw invalidProtocolFrame('Invalid native Provider action verification');
  }
  if (
    success.effect !== undefined &&
    !(COMPUTER_USE_EFFECTS as readonly unknown[]).includes(success.effect)
  ) {
    throw invalidProtocolFrame('Invalid native Provider action effect');
  }
  return {
    ok: true,
    tier: success.tier as ComputerUseDispatchTier,
    ...(success.verified === undefined ? {} : { verified: success.verified }),
    ...(success.effect === undefined ? {} : { effect: success.effect as ComputerUseEffect }),
    ...(success.completedSubSteps === undefined
      ? {}
      : {
          completedSubSteps: requireCount(success.completedSubSteps, 'completedSubSteps'),
        }),
  };
}

function decodeObserveInput(
  value: unknown,
  requiredScreenshot: true | undefined,
): NativeProviderObserveInput {
  const input = requireRecord(value, 'native Provider observation input');
  const optional = optionalFields(input, ['app', 'windowId']);
  const exact = requireExactRecord(input, 'native Provider observation input', [
    ...optional,
    'includeScreenshot',
  ]);
  const includeScreenshot = requireBoolean(
    exact.includeScreenshot,
    'observation includeScreenshot',
  );
  if (exact.app === undefined && exact.windowId === undefined) {
    throw invalidProtocolFrame('Native Provider observation requires an app or windowId');
  }
  if (requiredScreenshot && !includeScreenshot) {
    throw invalidProtocolFrame('Capture observation requires a screenshot');
  }
  return {
    ...(exact.app === undefined
      ? {}
      : { app: boundedString(exact.app, 'observation app', MAX_NAME_BYTES) }),
    ...(exact.windowId === undefined
      ? {}
      : { windowId: positiveInteger(exact.windowId, 'observation windowId') }),
    includeScreenshot,
  };
}

function decodeBoundAction(value: unknown): NativeProviderBoundAction {
  const record = requireRecord(value, 'native Provider bound action');
  const optional = optionalFields(record, [
    'display',
    'elementId',
    'sourceCoordinate',
    'sourceStartCoordinate',
    'windowCoordinate',
    'windowStartCoordinate',
    'coordinateSpace',
  ]);
  const action = requireExactRecord(record, 'native Provider bound action', [
    'frameId',
    'epoch',
    'target',
    ...optional,
  ]);
  if (
    action.coordinateSpace !== undefined &&
    action.coordinateSpace !== 'window-screenshot-local'
  ) {
    throw invalidProtocolFrame('Invalid bound action coordinateSpace');
  }
  return {
    frameId: requireId(action.frameId, 'bound action frameId'),
    epoch: requireCount(action.epoch, 'bound action epoch'),
    target: decodeWindowTarget(action.target),
    ...(action.display === undefined ? {} : { display: decodeDisplay(action.display) }),
    ...(action.elementId === undefined
      ? {}
      : { elementId: requireId(action.elementId, 'bound action elementId') }),
    ...decodeOptionalPointFields(action, [
      'sourceCoordinate',
      'sourceStartCoordinate',
      'windowCoordinate',
      'windowStartCoordinate',
    ]),
    ...(action.coordinateSpace === undefined
      ? {}
      : { coordinateSpace: 'window-screenshot-local' as const }),
  };
}

function decodeWindowTarget(value: unknown): NativeProviderWindowTarget {
  const record = requireRecord(value, 'native Provider window target');
  const optional = optionalFields(record, [
    'bundleId',
    'appName',
    'title',
    'bounds',
    'sourceBoundsPx',
    'zIndex',
    'contentFingerprint',
  ]);
  const target = requireExactRecord(record, 'native Provider window target', [
    'pid',
    'windowId',
    ...optional,
  ]);
  return {
    pid: positiveInteger(target.pid, 'window target pid'),
    windowId: positiveInteger(target.windowId, 'window target windowId'),
    ...(target.bundleId === undefined
      ? {}
      : {
          bundleId: boundedString(target.bundleId, 'window target bundleId', MAX_NAME_BYTES),
        }),
    ...(target.appName === undefined
      ? {}
      : {
          appName: boundedString(target.appName, 'window target appName', MAX_NAME_BYTES),
        }),
    ...(target.title === undefined
      ? {}
      : {
          title: boundedString(target.title, 'window target title', MAX_TITLE_BYTES),
        }),
    ...(target.bounds === undefined ? {} : { bounds: decodeRect(target.bounds, 'window bounds') }),
    ...(target.sourceBoundsPx === undefined
      ? {}
      : {
          sourceBoundsPx: decodeRect(target.sourceBoundsPx, 'window source bounds'),
        }),
    ...(target.zIndex === undefined
      ? {}
      : { zIndex: boundedInteger(target.zIndex, 'window zIndex') }),
    ...(target.contentFingerprint === undefined
      ? {}
      : {
          contentFingerprint: sha256(target.contentFingerprint, 'window target contentFingerprint'),
        }),
  };
}

function decodeSemanticAction(value: unknown): NativeProviderSemanticAction {
  const action = requireRecord(value, 'native Provider semantic action');
  const commonOptional = optionalFields(action, ['elementIdentity']);
  if (action.type === 'press_key') {
    const key = requireExactRecord(action, 'native Provider press key action', [
      'type',
      'observationId',
      'key',
    ]);
    return {
      type: 'press_key',
      observationId: requireId(key.observationId, 'semantic observationId'),
      key: boundedString(key.key, 'semantic key', MAX_TEXT_BYTES),
    };
  }
  if (
    action.type !== 'click_element' &&
    action.type !== 'set_value' &&
    action.type !== 'select_text' &&
    action.type !== 'secondary_action'
  ) {
    throw invalidProtocolFrame('Invalid Native Provider semantic action kind');
  }
  const payloadField =
    action.type === 'set_value'
      ? 'value'
      : action.type === 'select_text'
        ? 'text'
        : action.type === 'secondary_action'
          ? 'action'
          : undefined;
  const exact = requireExactRecord(action, `native Provider ${action.type} action`, [
    'type',
    'observationId',
    'elementId',
    ...(payloadField ? [payloadField] : []),
    ...commonOptional,
  ]);
  const common = {
    observationId: requireId(exact.observationId, 'semantic observationId'),
    elementId: requireId(exact.elementId, 'semantic elementId'),
    ...(exact.elementIdentity === undefined
      ? {}
      : { elementIdentity: decodeElementIdentity(exact.elementIdentity) }),
  };
  if (action.type === 'click_element') return { type: action.type, ...common };
  const payload = boundedText(exact[payloadField!], `semantic ${payloadField}`, MAX_TEXT_BYTES);
  if (action.type === 'set_value') return { type: action.type, ...common, value: payload };
  if (action.type === 'select_text') return { type: action.type, ...common, text: payload };
  return { type: action.type, ...common, action: payload };
}

function decodeNativeProviderAction(value: unknown): NativeProviderAction {
  const action = requireRecord(value, 'native Provider action');
  if (action.type === 'screenshot' || action.type === 'cursor_position') {
    requireExactRecord(action, `native Provider ${action.type} action`, ['type']);
    return action.type === 'screenshot' ? { type: 'screenshot' } : { type: 'cursor_position' };
  }
  if (
    action.type === 'mouse_move' ||
    action.type === 'left_mouse_down' ||
    action.type === 'left_mouse_up'
  ) {
    const point = requireExactRecord(action, `native Provider ${action.type} action`, [
      'type',
      'coordinate',
    ]);
    const coordinate = decodePoint(point.coordinate, 'action coordinate');
    if (action.type === 'mouse_move') return { type: 'mouse_move', coordinate };
    if (action.type === 'left_mouse_down') return { type: 'left_mouse_down', coordinate };
    return { type: 'left_mouse_up', coordinate };
  }
  if (
    action.type === 'left_click' ||
    action.type === 'right_click' ||
    action.type === 'middle_click' ||
    action.type === 'double_click' ||
    action.type === 'triple_click'
  ) {
    const optional = optionalFields(action, ['text']);
    const click = requireExactRecord(action, `native Provider ${action.type} action`, [
      'type',
      'coordinate',
      ...optional,
    ]);
    const decoded = {
      coordinate: decodePoint(click.coordinate, 'action coordinate'),
      ...(click.text === undefined
        ? {}
        : { text: boundedText(click.text, 'action text', MAX_TEXT_BYTES) }),
    };
    if (action.type === 'left_click') return { type: 'left_click', ...decoded };
    if (action.type === 'right_click') return { type: 'right_click', ...decoded };
    if (action.type === 'middle_click') return { type: 'middle_click', ...decoded };
    if (action.type === 'double_click') return { type: 'double_click', ...decoded };
    return { type: 'triple_click', ...decoded };
  }
  if (action.type === 'left_click_drag') {
    const optional = optionalFields(action, ['text']);
    const drag = requireExactRecord(action, 'native Provider drag action', [
      'type',
      'startCoordinate',
      'coordinate',
      ...optional,
    ]);
    return {
      type: action.type,
      startCoordinate: decodePoint(drag.startCoordinate, 'action startCoordinate'),
      coordinate: decodePoint(drag.coordinate, 'action coordinate'),
      ...(drag.text === undefined
        ? {}
        : { text: boundedText(drag.text, 'action text', MAX_TEXT_BYTES) }),
    };
  }
  if (action.type === 'type' || action.type === 'key') {
    const text = requireExactRecord(action, `native Provider ${action.type} action`, [
      'type',
      'text',
    ]);
    const decoded = boundedText(text.text, 'action text', MAX_TEXT_BYTES);
    return action.type === 'type'
      ? { type: 'type', text: decoded }
      : { type: 'key', text: decoded };
  }
  if (action.type === 'hold_key') {
    const hold = requireExactRecord(action, 'native Provider hold key action', [
      'type',
      'text',
      'durationMs',
    ]);
    return {
      type: action.type,
      text: boundedString(hold.text, 'action text', MAX_TEXT_BYTES),
      durationMs: boundedCount(hold.durationMs, 'action durationMs', MAX_DURATION_MS),
    };
  }
  if (action.type === 'scroll') {
    const optional = optionalFields(action, ['text']);
    const scroll = requireExactRecord(action, 'native Provider scroll action', [
      'type',
      'coordinate',
      'scrollDirection',
      'scrollAmount',
      ...optional,
    ]);
    if (
      scroll.scrollDirection !== 'up' &&
      scroll.scrollDirection !== 'down' &&
      scroll.scrollDirection !== 'left' &&
      scroll.scrollDirection !== 'right'
    ) {
      throw invalidProtocolFrame('Invalid action scrollDirection');
    }
    return {
      type: action.type,
      coordinate: decodePoint(scroll.coordinate, 'action coordinate'),
      scrollDirection: scroll.scrollDirection,
      scrollAmount: boundedCount(scroll.scrollAmount, 'action scrollAmount', MAX_SCROLL_AMOUNT),
      ...(scroll.text === undefined
        ? {}
        : { text: boundedText(scroll.text, 'action text', MAX_TEXT_BYTES) }),
    };
  }
  if (action.type === 'wait') {
    const wait = requireExactRecord(action, 'native Provider wait action', ['type', 'durationMs']);
    return {
      type: action.type,
      durationMs: boundedCount(wait.durationMs, 'action durationMs', MAX_DURATION_MS),
    };
  }
  if (action.type === 'zoom') {
    const zoom = requireExactRecord(action, 'native Provider zoom action', ['type', 'region']);
    const region = requireExactRecord(zoom.region, 'native Provider zoom region', [
      'x1',
      'y1',
      'x2',
      'y2',
    ]);
    return {
      type: action.type,
      region: {
        x1: boundedCoordinate(region.x1, 'zoom x1'),
        y1: boundedCoordinate(region.y1, 'zoom y1'),
        x2: boundedCoordinate(region.x2, 'zoom x2'),
        y2: boundedCoordinate(region.y2, 'zoom y2'),
      },
    };
  }
  throw invalidProtocolFrame('Invalid Native Provider action kind');
}

function decodeAppSummary(value: unknown): NativeProviderAppSummary {
  const record = requireRecord(value, 'native Provider app summary');
  const optional = optionalFields(record, ['name', 'windows']);
  const app = requireExactRecord(record, 'native Provider app summary', [
    'appId',
    'pid',
    'windowCount',
    ...optional,
  ]);
  const windowCount = boundedCount(app.windowCount, 'app windowCount', NATIVE_PROVIDER_MAX_WINDOWS);
  const windows =
    app.windows === undefined
      ? undefined
      : decodeBoundedArray(
          app.windows,
          'app windows',
          NATIVE_PROVIDER_MAX_WINDOWS_PER_APP,
          decodeWindowSummary,
        );
  if (windows && windows.length > windowCount) {
    throw invalidProtocolFrame('Native Provider app windows exceed windowCount');
  }
  return {
    appId: boundedString(app.appId, 'appId', MAX_NAME_BYTES),
    pid: positiveInteger(app.pid, 'app pid'),
    ...(app.name === undefined
      ? {}
      : { name: boundedString(app.name, 'app name', MAX_NAME_BYTES) }),
    windowCount,
    ...(windows === undefined ? {} : { windows }),
  };
}

function decodeWindowSummary(value: unknown): NativeProviderWindowSummary {
  const record = requireRecord(value, 'native Provider window summary');
  const optional = optionalFields(record, ['title']);
  const window = requireExactRecord(record, 'native Provider window summary', [
    'windowId',
    ...optional,
  ]);
  return {
    windowId: positiveInteger(window.windowId, 'windowId'),
    ...(window.title === undefined
      ? {}
      : { title: boundedText(window.title, 'window title', MAX_TITLE_BYTES) }),
  };
}

function decodeObservation(value: unknown): NativeProviderObservation {
  const record = requireRecord(value, 'native Provider observation');
  const optional = optionalFields(record, [
    'windowTitle',
    'capturedAt',
    'windowBounds',
    'sourceBoundsPx',
    'zIndex',
    'bundleId',
    'contentFingerprint',
    'displays',
    'screenshot',
  ]);
  const observation = requireExactRecord(record, 'native Provider observation', [
    'observationId',
    'appId',
    'pid',
    'windowId',
    'elements',
    ...optional,
  ]);
  return {
    observationId: requireId(observation.observationId, 'observationId'),
    appId: boundedString(observation.appId, 'observation appId', MAX_NAME_BYTES),
    pid: positiveInteger(observation.pid, 'observation pid'),
    windowId: positiveInteger(observation.windowId, 'observation windowId'),
    ...(observation.windowTitle === undefined
      ? {}
      : {
          windowTitle: boundedText(
            observation.windowTitle,
            'observation windowTitle',
            MAX_TITLE_BYTES,
          ),
        }),
    ...(observation.capturedAt === undefined
      ? {}
      : {
          capturedAt: requireCount(observation.capturedAt, 'observation capturedAt'),
        }),
    ...(observation.windowBounds === undefined
      ? {}
      : {
          windowBounds: decodeRect(observation.windowBounds, 'observation windowBounds'),
        }),
    ...(observation.sourceBoundsPx === undefined
      ? {}
      : {
          sourceBoundsPx: decodeRect(observation.sourceBoundsPx, 'observation sourceBoundsPx'),
        }),
    ...(observation.zIndex === undefined
      ? {}
      : { zIndex: boundedInteger(observation.zIndex, 'observation zIndex') }),
    ...(observation.bundleId === undefined
      ? {}
      : {
          bundleId: boundedString(observation.bundleId, 'observation bundleId', MAX_NAME_BYTES),
        }),
    ...(observation.contentFingerprint === undefined
      ? {}
      : {
          contentFingerprint: sha256(
            observation.contentFingerprint,
            'observation contentFingerprint',
          ),
        }),
    ...(observation.displays === undefined
      ? {}
      : {
          displays: decodeBoundedArray(
            observation.displays,
            'observation displays',
            NATIVE_PROVIDER_MAX_DISPLAYS,
            decodeDisplay,
          ),
        }),
    elements: decodeBoundedArray(
      observation.elements,
      'observation elements',
      NATIVE_PROVIDER_MAX_ELEMENTS,
      decodeObservedElement,
    ),
    ...(observation.screenshot === undefined
      ? {}
      : { screenshot: decodeScreenshot(observation.screenshot) }),
  };
}

function decodeObservedElement(value: unknown): NativeProviderObservedElement {
  const record = requireRecord(value, 'native Provider observed element');
  const optional = optionalFields(record, ['label', 'value', 'frame', 'identity']);
  const element = requireExactRecord(record, 'native Provider observed element', [
    'elementId',
    'role',
    ...optional,
  ]);
  return {
    elementId: requireId(element.elementId, 'elementId'),
    role: boundedString(element.role, 'element role', MAX_NAME_BYTES),
    ...(element.label === undefined
      ? {}
      : {
          label: boundedText(element.label, 'element label', MAX_TITLE_BYTES),
        }),
    ...(element.value === undefined
      ? {}
      : {
          value: boundedText(element.value, 'element value', MAX_ELEMENT_VALUE_BYTES),
        }),
    ...(element.frame === undefined ? {} : { frame: decodeRect(element.frame, 'element frame') }),
    ...(element.identity === undefined
      ? {}
      : { identity: decodeElementIdentity(element.identity) }),
  };
}

function decodeElementIdentity(value: unknown): NativeProviderElementIdentity {
  const record = requireRecord(value, 'native Provider element identity');
  const optional = optionalFields(record, ['label', 'value']);
  const identity = requireExactRecord(record, 'native Provider element identity', [
    'role',
    ...optional,
  ]);
  return {
    role: boundedString(identity.role, 'element identity role', MAX_NAME_BYTES),
    ...(identity.label === undefined
      ? {}
      : {
          label: boundedText(identity.label, 'element identity label', MAX_TITLE_BYTES),
        }),
    ...(identity.value === undefined
      ? {}
      : {
          value: boundedText(identity.value, 'element identity value', MAX_ELEMENT_VALUE_BYTES),
        }),
  };
}

function decodeRunResult(value: unknown): NativeProviderRunResult {
  const record = requireRecord(value, 'native Provider run result');
  const optional = optionalFields(record, ['resolvedScreenPoint', 'screenshot', 'observation']);
  const result = requireExactRecord(record, 'native Provider run result', ['outcome', ...optional]);
  return {
    outcome: decodeNativeProviderComputerUseActionOutcome(result.outcome),
    ...(result.resolvedScreenPoint === undefined
      ? {}
      : {
          resolvedScreenPoint: decodePoint(result.resolvedScreenPoint, 'resolved screen point'),
        }),
    ...(result.screenshot === undefined ? {} : { screenshot: decodeScreenshot(result.screenshot) }),
    ...(result.observation === undefined
      ? {}
      : { observation: decodeObservation(result.observation) }),
  };
}

function decodeScreenshot(value: unknown): NativeProviderScreenshot {
  const screenshot = requireExactRecord(value, 'native Provider screenshot', [
    'image',
    'widthPx',
    'heightPx',
  ]);
  return {
    image: decodeNativeProviderAttachmentRef(screenshot.image),
    widthPx: positiveBoundedInteger(screenshot.widthPx, 'screenshot widthPx', 65_535),
    heightPx: positiveBoundedInteger(screenshot.heightPx, 'screenshot heightPx', 65_535),
  };
}

function decodeDisplay(value: unknown): NativeProviderDisplay {
  const display = requireExactRecord(value, 'native Provider display', [
    'displayId',
    'logicalBounds',
    'sourceBoundsPx',
    'scaleFactor',
  ]);
  return {
    displayId: requireId(display.displayId, 'displayId'),
    logicalBounds: decodeRect(display.logicalBounds, 'display logicalBounds'),
    sourceBoundsPx: decodeRect(display.sourceBoundsPx, 'display sourceBoundsPx'),
    scaleFactor: positiveFiniteNumber(display.scaleFactor, 'display scaleFactor'),
  };
}

function decodeRect(value: unknown, label: string): NativeProviderRect {
  const rect = requireExactRecord(value, label, ['x', 'y', 'width', 'height']);
  return {
    x: boundedCoordinate(rect.x, `${label} x`),
    y: boundedCoordinate(rect.y, `${label} y`),
    width: boundedDimension(rect.width, `${label} width`),
    height: boundedDimension(rect.height, `${label} height`),
  };
}

function decodePoint(value: unknown, label: string): NativeProviderPoint {
  const point = requireExactRecord(value, label, ['x', 'y']);
  return {
    x: boundedCoordinate(point.x, `${label} x`),
    y: boundedCoordinate(point.y, `${label} y`),
  };
}

function decodeOptionalPointFields<K extends string>(
  record: Record<string, unknown>,
  fields: readonly K[],
): Partial<Record<K, NativeProviderPoint>> {
  const decoded: Partial<Record<K, NativeProviderPoint>> = {};
  for (const field of fields) {
    if (record[field] !== undefined) decoded[field] = decodePoint(record[field], field);
  }
  return decoded;
}

function decodeBoundedArray<T>(
  value: unknown,
  label: string,
  maxLength: number,
  decode: (item: unknown) => T,
): readonly T[] {
  if (!Array.isArray(value) || value.length > maxLength) {
    throw invalidProtocolFrame(`Invalid native Provider ${label}`);
  }
  return value.map(decode);
}

function optionalFields(record: Record<string, unknown>, allowed: readonly string[]): string[] {
  return allowed.filter((key) => Object.hasOwn(record, key));
}

export function nativeProviderComputerUseResultAttachmentRefs(
  result: NativeProviderComputerUseResultPayload,
): readonly NativeProviderAttachmentRef[] {
  if (result.kind === 'observeApp' || result.kind === 'captureObservation') {
    return result.observation.screenshot ? [result.observation.screenshot.image] : [];
  }
  if (result.kind !== 'run' && result.kind !== 'runSemantic') return [];
  return [
    ...(result.result.screenshot ? [result.result.screenshot.image] : []),
    ...(result.result.observation?.screenshot ? [result.result.observation.screenshot.image] : []),
  ];
}

function imageMimeType(value: unknown): NativeProviderAttachmentRef['mimeType'] {
  if (value === 'image/png' || value === 'image/jpeg') return value;
  throw invalidProtocolFrame('Invalid native Provider image MIME type');
}

function sha256(value: unknown, label: string): string {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) {
    throw invalidProtocolFrame(`Invalid ${label}`);
  }
  return value;
}

function boundedString(value: unknown, label: string, maxBytes: number): string {
  return requireUtf8BoundedString(value, label, maxBytes);
}

function boundedText(value: unknown, label: string, maxBytes: number): string {
  if (typeof value !== 'string' || Buffer.byteLength(value, 'utf8') > maxBytes) {
    throw invalidProtocolFrame(`Invalid ${label}`);
  }
  return value;
}

function requireBoolean(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') throw invalidProtocolFrame(`Invalid ${label}`);
  return value;
}

function positiveInteger(value: unknown, label: string): number {
  const integer = requireCount(value, label);
  if (integer === 0) throw invalidProtocolFrame(`Invalid ${label}`);
  return integer;
}

function boundedCount(value: unknown, label: string, max: number): number {
  const count = requireCount(value, label);
  if (count > max) throw invalidProtocolFrame(`Invalid ${label}`);
  return count;
}

function positiveBoundedInteger(value: unknown, label: string, max: number): number {
  const integer = boundedCount(value, label, max);
  if (integer === 0) throw invalidProtocolFrame(`Invalid ${label}`);
  return integer;
}

function boundedInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Math.abs(value as number) > MAX_COORDINATE_ABS) {
    throw invalidProtocolFrame(`Invalid ${label}`);
  }
  return value as number;
}

function boundedCoordinate(value: unknown, label: string): number {
  if (
    typeof value !== 'number' ||
    !Number.isFinite(value) ||
    Math.abs(value) > MAX_COORDINATE_ABS
  ) {
    throw invalidProtocolFrame(`Invalid ${label}`);
  }
  return value;
}

function boundedDimension(value: unknown, label: string): number {
  const dimension = boundedCoordinate(value, label);
  if (dimension < 0) throw invalidProtocolFrame(`Invalid ${label}`);
  return dimension;
}

function positiveFiniteNumber(value: unknown, label: string): number {
  if (
    typeof value !== 'number' ||
    !Number.isFinite(value) ||
    value <= 0 ||
    value > MAX_COORDINATE_ABS
  ) {
    throw invalidProtocolFrame(`Invalid ${label}`);
  }
  return value;
}
