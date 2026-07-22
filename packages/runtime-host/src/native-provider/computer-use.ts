import { randomUUID } from 'node:crypto';
import type { CuAction } from '@maka/core/computer-use';
import { redactSecrets } from '@maka/core/redaction';
import type {
  CuAppSummary,
  CuDispatchBackend,
  CuObservation,
  CuRunContext,
  CuRunResult,
  CuScreenshot,
  CuSemanticAction,
} from '@maka/runtime';
import {
  type NativeCapabilityAttachment,
  type NativeCapabilityHandlerOutcome,
  type NativeCapabilityImplementation,
} from '../client/native-provider.js';
import {
  NATIVE_PROVIDER_MAX_ATTACHMENT_BYTES,
  NATIVE_PROVIDER_MAX_APPS,
  NATIVE_PROVIDER_MAX_DISPLAYS,
  NATIVE_PROVIDER_MAX_ELEMENTS,
  NATIVE_PROVIDER_MAX_WINDOWS,
  NATIVE_PROVIDER_MAX_WINDOWS_PER_APP,
  type NativeProviderAppSummary,
  type NativeProviderComputerUseResultPayload,
  type NativeProviderComputerUseSubcallFrame,
  type NativeProviderObservation,
  type NativeProviderRunResult,
  type NativeProviderScreenshot,
} from '../protocol/index.js';

const MAX_RETAINED_OBSERVATIONS_PER_SESSION = 16;

type CompleteComputerUseMethods =
  | 'preflight'
  | 'listApps'
  | 'observeApp'
  | 'runSemantic'
  | 'captureObservation'
  | 'run';

export type ComputerUseNativeProviderBackend = Omit<CuDispatchBackend, 'clearSession'> &
  Required<Pick<CuDispatchBackend, CompleteComputerUseMethods>> & {
    clearSession(sessionId: string): void | Promise<void>;
  };

interface StoredObservation {
  readonly sessionId: string;
  readonly wireObservationId: string;
  readonly observation: CuObservation;
  readonly elements: readonly {
    readonly wireElementId: string;
    readonly element: CuObservation['elements'][number];
  }[];
  readonly elementsByWireId: ReadonlyMap<string, CuObservation['elements'][number]>;
}

export function createComputerUseNativeCapability(
  backend: ComputerUseNativeProviderBackend,
): NativeCapabilityImplementation<'computer_use'> {
  const observations = new Map<string, StoredObservation>();
  const observationHandlesBySession = new Map<string, string[]>();
  const clearSession = async (sessionId: string) => {
    for (const handle of observationHandlesBySession.get(sessionId) ?? []) {
      observations.delete(handle);
    }
    observationHandlesBySession.delete(sessionId);
    await backend.clearSession(sessionId);
  };
  return {
    capability: 'computer_use',
    releaseTurnState: ({ sessionId }) => clearSession(sessionId),
    handle: async (frame, { signal }) => {
      const { subcall } = frame;
      const context = restoreContext(subcall.context, frame.operationId, observations);
      switch (subcall.kind) {
        case 'preflight': {
          const result = await backend.preflight(signal);
          return success({ kind: 'preflight', ...result });
        }
        case 'listApps': {
          return success({
            kind: 'listApps',
            apps: projectApps(await backend.listApps(signal)),
          });
        }
        case 'observeApp': {
          const observation = await backend.observeApp(subcall.input, signal, context);
          const stored = rememberObservation(
            observations,
            observationHandlesBySession,
            context.sessionId,
            observation,
          );
          return observationOutcome('observeApp', stored);
        }
        case 'captureObservation': {
          const observation = await backend.captureObservation(subcall.input, signal, context);
          const stored = rememberObservation(
            observations,
            observationHandlesBySession,
            context.sessionId,
            observation,
          );
          return observationOutcome('captureObservation', stored);
        }
        case 'runSemantic': {
          if (
            subcall.context.backendObservationId &&
            subcall.context.backendObservationId !== subcall.action.observationId
          ) {
            throw new Error('Native Provider semantic observation identity changed');
          }
          const stored = observations.get(
            subcall.context.backendObservationId ?? subcall.action.observationId,
          );
          if (stored && stored.sessionId !== context.sessionId) {
            throw new Error('Native Provider semantic observation crossed sessions');
          }
          const action = restoreSemanticAction(subcall.action, stored);
          const result = await backend.runSemantic(action, signal, context);
          const resultObservation = result.observation
            ? rememberObservation(
                observations,
                observationHandlesBySession,
                context.sessionId,
                result.observation,
              )
            : undefined;
          return runOutcome('runSemantic', result, resultObservation);
        }
        case 'run': {
          const result = await backend.run(subcall.action as CuAction, signal, context);
          const resultObservation = result.observation
            ? rememberObservation(
                observations,
                observationHandlesBySession,
                context.sessionId,
                result.observation,
              )
            : undefined;
          return runOutcome('run', result, resultObservation);
        }
      }
    },
  };
}

function success(
  result: NativeProviderComputerUseResultPayload,
): NativeCapabilityHandlerOutcome<'computer_use'> {
  return { ok: true, complete: () => result };
}

function observationOutcome(
  kind: 'observeApp' | 'captureObservation',
  stored: StoredObservation,
): NativeCapabilityHandlerOutcome<'computer_use'> {
  const { observation } = stored;
  const screenshot = observation.screenshot;
  return withScreenshot(screenshot, (wireScreenshot) => {
    const projected = projectObservation(stored, wireScreenshot);
    return kind === 'observeApp'
      ? { kind: 'observeApp', observation: projected }
      : { kind: 'captureObservation', observation: projected };
  });
}

function runOutcome(
  kind: 'run' | 'runSemantic',
  result: CuRunResult,
  storedObservation: StoredObservation | undefined,
): NativeCapabilityHandlerOutcome<'computer_use'> {
  const canonicalScreenshot = result.observation?.screenshot ?? result.screenshot;
  return withScreenshot(canonicalScreenshot, (wireScreenshot) => {
    const projected = projectRunResult(result, storedObservation, wireScreenshot);
    return kind === 'run'
      ? { kind: 'run', result: projected }
      : { kind: 'runSemantic', result: projected };
  });
}

function withScreenshot(
  screenshot: CuScreenshot | undefined,
  complete: (screenshot?: NativeProviderScreenshot) => NativeProviderComputerUseResultPayload,
): NativeCapabilityHandlerOutcome<'computer_use'> {
  if (!screenshot) return { ok: true, complete: () => complete() };
  const bytes = Buffer.from(screenshot.base64, 'base64');
  if (
    bytes.byteLength === 0 ||
    bytes.byteLength > NATIVE_PROVIDER_MAX_ATTACHMENT_BYTES ||
    bytes.toString('base64') !== screenshot.base64
  ) {
    return { ok: false, code: 'operation_failed' };
  }
  const attachment: NativeCapabilityAttachment = {
    attachmentId: randomUUID(),
    mimeType: screenshot.mimeType,
    data: bytes,
  };
  return {
    ok: true,
    attachment,
    complete: (ref) =>
      complete(
        ref
          ? {
              image: ref,
              widthPx: boundedPositive(screenshot.widthPx, 65_535),
              heightPx: boundedPositive(screenshot.heightPx, 65_535),
            }
          : undefined,
      ),
  };
}

function restoreContext(
  context: NativeProviderComputerUseSubcallFrame['subcall']['context'],
  operationId: string,
  observations: ReadonlyMap<string, StoredObservation>,
): CuRunContext {
  const stored = context.backendObservationId
    ? observations.get(context.backendObservationId)
    : undefined;
  if (context.backendObservationId && !stored) {
    throw new Error('Native Provider backend observation is unavailable');
  }
  if (stored && stored.sessionId !== context.sessionId)
    throw new Error('Native Provider observation crossed sessions');
  const rawBoundElement = context.boundAction?.elementId
    ? stored?.elementsByWireId.get(context.boundAction.elementId)
    : undefined;
  if (context.boundAction?.elementId && !rawBoundElement) {
    throw new Error('Native Provider bound element is unavailable');
  }
  const boundAction = context.boundAction
    ? {
        ...context.boundAction,
        actionFingerprint: '',
        fingerprint: '',
        ...(rawBoundElement ? { elementId: rawBoundElement.elementId } : {}),
        target: {
          ...context.boundAction.target,
          ...(stored?.observation.page ? { page: stored.observation.page } : {}),
        },
      }
    : undefined;
  return {
    ...context,
    operationId,
    ...(stored ? { backendObservationId: stored.observation.observationId } : {}),
    ...(boundAction ? { boundAction } : {}),
  } as CuRunContext;
}

function restoreSemanticAction(
  action: CuSemanticAction,
  stored: StoredObservation | undefined,
): CuSemanticAction {
  if (!stored) throw new Error('Native Provider semantic observation is unavailable');
  if (!('elementId' in action)) {
    return { ...action, observationId: stored.observation.observationId };
  }
  const element = stored.elementsByWireId.get(action.elementId);
  if (!element) throw new Error('Native Provider semantic element is unavailable');
  return {
    ...action,
    observationId: stored.observation.observationId,
    elementId: element.elementId,
    elementIdentity: element.identity,
  } as CuSemanticAction;
}

function rememberObservation(
  store: Map<string, StoredObservation>,
  handlesBySession: Map<string, string[]>,
  sessionId: string,
  observation: CuObservation,
): StoredObservation {
  const wireObservationId = randomUUID();
  const elements = observation.elements.slice(0, NATIVE_PROVIDER_MAX_ELEMENTS).map((element) => ({
    wireElementId: randomUUID(),
    element,
  }));
  const stored: StoredObservation = {
    sessionId,
    wireObservationId,
    observation,
    elements,
    elementsByWireId: new Map(
      elements.map(({ wireElementId, element }) => [wireElementId, element]),
    ),
  };
  store.set(wireObservationId, stored);
  const handles = handlesBySession.get(sessionId) ?? [];
  handles.push(wireObservationId);
  handlesBySession.set(sessionId, handles);
  while (handles.length > MAX_RETAINED_OBSERVATIONS_PER_SESSION) {
    const evicted = handles.shift();
    if (evicted) store.delete(evicted);
  }
  return stored;
}

function projectApps(apps: readonly CuAppSummary[]): NativeProviderAppSummary[] {
  const projected: NativeProviderAppSummary[] = [];
  let remainingWindows = NATIVE_PROVIDER_MAX_WINDOWS;
  for (const app of apps.slice(0, NATIVE_PROVIDER_MAX_APPS)) {
    const windowCount = Math.min(boundedCount(app.windowCount), remainingWindows);
    const windows = app.windows
      ?.slice(0, Math.min(windowCount, NATIVE_PROVIDER_MAX_WINDOWS_PER_APP))
      .map((window) => ({
        windowId: boundedPositive(window.windowId),
        ...(window.title === undefined ? {} : { title: boundedString(window.title, 1024) }),
      }));
    projected.push({
      appId: boundedString(app.appId, 512, 'app'),
      pid: boundedPositive(app.pid),
      ...(app.name === undefined ? {} : { name: boundedString(app.name, 512) }),
      windowCount,
      ...(windows === undefined ? {} : { windows }),
    });
    remainingWindows -= windowCount;
    if (remainingWindows === 0) break;
  }
  fitInline(projected, (value) => value.pop());
  return projected;
}

function projectObservation(
  stored: StoredObservation,
  screenshot?: NativeProviderScreenshot,
): NativeProviderObservation {
  const { observation } = stored;
  const elements = stored.elements.map(({ wireElementId, element }) => ({
    elementId: wireElementId,
    role: boundedString(element.role, 512, 'role'),
    ...(element.label === undefined ? {} : { label: boundedString(element.label, 1024) }),
    ...(element.value === undefined ? {} : { value: boundedString(element.value, 8000) }),
    ...(element.frame ? { frame: projectRect(element.frame) } : {}),
    ...(element.identity
      ? {
          identity: {
            role: boundedString(element.identity.role, 512, 'role'),
            ...(element.identity.label === undefined
              ? {}
              : { label: boundedString(element.identity.label, 1024) }),
            ...(element.identity.value === undefined
              ? {}
              : { value: boundedString(element.identity.value, 8000) }),
          },
        }
      : {}),
  }));
  fitInline(elements, (value) => value.pop());
  const result: NativeProviderObservation = {
    observationId: stored.wireObservationId,
    appId: boundedString(observation.appId, 512, 'app'),
    pid: boundedPositive(observation.pid),
    windowId: boundedPositive(observation.windowId),
    ...(observation.windowTitle === undefined
      ? {}
      : { windowTitle: boundedString(observation.windowTitle, 1024) }),
    ...(observation.capturedAt === undefined
      ? {}
      : { capturedAt: boundedCount(observation.capturedAt) }),
    ...(observation.windowBounds ? { windowBounds: projectRect(observation.windowBounds) } : {}),
    ...(observation.sourceBoundsPx
      ? { sourceBoundsPx: projectRect(observation.sourceBoundsPx) }
      : {}),
    ...(observation.zIndex === undefined ? {} : { zIndex: boundedInteger(observation.zIndex) }),
    ...(observation.bundleId === undefined
      ? {}
      : { bundleId: boundedString(observation.bundleId, 512) }),
    ...(validSha(observation.contentFingerprint)
      ? { contentFingerprint: observation.contentFingerprint }
      : {}),
    ...(observation.displays
      ? {
          displays: observation.displays.slice(0, NATIVE_PROVIDER_MAX_DISPLAYS).map((display) => ({
            displayId: boundedString(display.displayId, 128, 'display'),
            logicalBounds: projectRect(display.logicalBounds),
            sourceBoundsPx: projectRect(display.sourceBoundsPx),
            scaleFactor: boundedPositiveNumber(display.scaleFactor),
          })),
        }
      : {}),
    elements,
    ...(screenshot ? { screenshot } : {}),
  };
  return result;
}

function projectRunResult(
  result: CuRunResult,
  storedObservation: StoredObservation | undefined,
  screenshot?: NativeProviderScreenshot,
): NativeProviderRunResult {
  const outcome = result.outcome.ok
    ? {
        ok: true as const,
        tier: result.outcome.tier,
        ...(result.outcome.verified === undefined ? {} : { verified: result.outcome.verified }),
        ...(result.outcome.evidence?.effect === undefined
          ? {}
          : { effect: result.outcome.evidence.effect }),
        ...(result.outcome.completedSubSteps === undefined
          ? {}
          : {
              completedSubSteps: boundedCount(result.outcome.completedSubSteps),
            }),
      }
    : {
        ok: false as const,
        error: result.outcome.error,
        ...(result.outcome.completedSubSteps === undefined
          ? {}
          : {
              completedSubSteps: boundedCount(result.outcome.completedSubSteps),
            }),
      };
  const observation = storedObservation
    ? projectObservation(
        storedObservation,
        storedObservation.observation.screenshot ? screenshot : undefined,
      )
    : undefined;
  return {
    outcome,
    ...(result.resolvedScreenPoint
      ? { resolvedScreenPoint: projectPoint(result.resolvedScreenPoint) }
      : {}),
    ...(result.observation?.screenshot === undefined && screenshot ? { screenshot } : {}),
    ...(observation ? { observation } : {}),
  };
}

function fitInline<T>(value: T[], shrink: (value: T[]) => void): void {
  while (value.length > 0 && Buffer.byteLength(JSON.stringify(value), 'utf8') > 48 * 1024)
    shrink(value);
}

function boundedString(value: string, maxBytes: number, fallback = 'unknown'): string {
  const redacted = redactSecrets(String(value));
  const bytes = Buffer.from(redacted, 'utf8');
  if (bytes.byteLength <= maxBytes) return redacted || fallback;
  let end = maxBytes;
  while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end -= 1;
  return bytes.subarray(0, end).toString('utf8') || fallback;
}

function boundedCount(value: number): number {
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}
function boundedPositive(value: number, max = Number.MAX_SAFE_INTEGER): number {
  return Math.min(max, Math.max(1, boundedCount(value)));
}
function boundedInteger(value: number): number {
  return Math.min(10_000_000, Math.max(-10_000_000, Number.isSafeInteger(value) ? value : 0));
}
function boundedPositiveNumber(value: number): number {
  return Math.min(10_000_000, Number.isFinite(value) && value > 0 ? value : 1);
}
function boundedCoordinate(value: number): number {
  return Math.min(10_000_000, Math.max(-10_000_000, Number.isFinite(value) ? value : 0));
}
function projectPoint(point: { x: number; y: number }) {
  return { x: boundedCoordinate(point.x), y: boundedCoordinate(point.y) };
}
function projectRect(rect: { x: number; y: number; width: number; height: number }) {
  return {
    x: boundedCoordinate(rect.x),
    y: boundedCoordinate(rect.y),
    width: Math.min(10_000_000, Math.max(0, Number.isFinite(rect.width) ? rect.width : 0)),
    height: Math.min(10_000_000, Math.max(0, Number.isFinite(rect.height) ? rect.height : 0)),
  };
}
function validSha(value: string | undefined): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
}
