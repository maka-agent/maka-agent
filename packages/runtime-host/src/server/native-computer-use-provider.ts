import { createHash } from 'node:crypto';
import type { CuAction, ComputerUseErrorCode } from '@maka/core/computer-use';
import { CuBackendError } from '@maka/runtime';
import type {
  CuAppSummary,
  CuBackendInvocationProvider,
  CuDispatchBackend,
  CuObservation,
  CuRunContext,
  CuRunResult,
  CuScreenshot,
  CuSemanticAction,
} from '@maka/runtime';
import type {
  NativeProviderAttachmentRef,
  NativeProviderAction,
  NativeProviderBoundAction,
  NativeProviderComputerUseContext,
  NativeProviderObservation,
  NativeProviderResultPayload,
  NativeProviderRunResult,
  NativeProviderSemanticAction,
  NativeProviderSubcall,
} from '../protocol/index.js';
import type {
  HostNativeProviderInvocation,
  HostNativeProviderInvocationAcquisition,
  HostNativeProviderService,
  HostNativeProviderSubcallOutcome,
  NativeProviderAttachmentData,
} from './native-provider-coordinator.js';

type FailedCall = Extract<HostNativeProviderSubcallOutcome, { ok: false }>;

export function createHostNativeComputerUseInvocationProvider(
  service: HostNativeProviderService,
): CuBackendInvocationProvider {
  return {
    async acquire(input, _signal) {
      let acquisition: HostNativeProviderInvocationAcquisition;
      try {
        acquisition = service.acquireInvocation({
          operationId: input.context.operationId,
          sessionId: input.context.sessionId,
          turnId: input.context.turnId,
          toolCallId: input.context.toolCallId,
          capability: 'computer_use',
          ...(input.affinity === undefined ? {} : { affinity: input.affinity }),
        });
      } catch {
        return {
          ok: false,
          error: 'service_unavailable',
          message: 'Computer Use native provider acquisition failed',
        };
      }
      if (!acquisition.ok) {
        const error =
          acquisition.error === 'service_mismatch' ? 'service_mismatch' : 'service_unavailable';
        return {
          ok: false,
          error,
          message:
            error === 'service_mismatch'
              ? 'The Computer Use provider for the active observation is no longer available'
              : 'Computer Use has no single available native provider',
        };
      }

      const hostInvocation = acquisition.invocation;
      const backend = createInvocationBackend(hostInvocation, input.context);
      return {
        ok: true,
        invocation: {
          backend,
          affinity: hostInvocation.affinity,
          release: () => hostInvocation.release(),
        },
      };
    },
  };
}

function createInvocationBackend(
  invocation: HostNativeProviderInvocation,
  acquiredContext: CuRunContext,
): CuDispatchBackend &
  Required<
    Pick<
      CuDispatchBackend,
      'preflight' | 'listApps' | 'observeApp' | 'runSemantic' | 'captureObservation' | 'run'
    >
  > {
  const call = (subcall: NativeProviderSubcall, signal: AbortSignal) =>
    invocation.call({ subcall, signal });

  return {
    async preflight(signal) {
      const outcome = await call(
        { kind: 'preflight', context: toProviderContext(acquiredContext) },
        signal,
      );
      const { result } = requireResult(outcome, 'preflight', signal);
      return {
        accessibility: result.accessibility,
        screenRecording: result.screenRecording,
      };
    },
    async listApps(signal) {
      const outcome = await call(
        { kind: 'listApps', context: toProviderContext(acquiredContext) },
        signal,
      );
      const { result } = requireResult(outcome, 'listApps', signal);
      return result.apps.map(toAppSummary);
    },
    async observeApp(input, signal, context) {
      const outcome = await call(
        { kind: 'observeApp', input, context: toProviderContext(context) },
        signal,
      );
      const succeeded = requireResult(outcome, 'observeApp', signal);
      return toObservation(succeeded.result.observation, succeeded.attachments);
    },
    async runSemantic(action, signal, context) {
      const outcome = await call(
        {
          kind: 'runSemantic',
          action: toSemanticAction(action),
          context: toProviderContext(context),
        },
        signal,
      );
      if (!outcome.ok) return failedRunResult(outcome, signal);
      if (outcome.result.kind !== 'runSemantic') {
        throw invalidProviderResultError();
      }
      return toRunResult(outcome.result.result, outcome.attachments);
    },
    async captureObservation(input, signal, context) {
      const outcome = await call(
        {
          kind: 'captureObservation',
          input,
          context: toProviderContext(context),
        },
        signal,
      );
      const succeeded = requireResult(outcome, 'captureObservation', signal);
      return toObservation(succeeded.result.observation, succeeded.attachments);
    },
    async run(action, signal, context) {
      const outcome = await call(
        {
          kind: 'run',
          action: toAction(action),
          context: toProviderContext(context),
        },
        signal,
      );
      if (!outcome.ok) return failedRunResult(outcome, signal);
      if (outcome.result.kind !== 'run') throw invalidProviderResultError();
      return toRunResult(outcome.result.result, outcome.attachments);
    },
  };
}

function requireResult<K extends NativeProviderResultPayload['kind']>(
  outcome: HostNativeProviderSubcallOutcome,
  kind: K,
  signal: AbortSignal,
): {
  result: Extract<NativeProviderResultPayload, { kind: K }>;
  attachments: readonly NativeProviderAttachmentData[];
} {
  if (!outcome.ok) throw invocationError(outcome, signal);
  if (outcome.result.kind !== kind) throw invalidProviderResultError();
  return {
    result: outcome.result as Extract<NativeProviderResultPayload, { kind: K }>,
    attachments: outcome.attachments,
  };
}

function invocationError(outcome: FailedCall, signal: AbortSignal): CuBackendError {
  const code = callErrorCode(outcome.error.code, signal);
  return new CuBackendError(code, computerUseFailureMessage(code));
}

function failedRunResult(outcome: FailedCall, signal: AbortSignal): CuRunResult {
  const error = callErrorCode(outcome.error.code, signal);
  return {
    outcome: { ok: false, error, message: computerUseFailureMessage(error) },
  };
}

function invalidProviderResultError(): CuBackendError {
  return new CuBackendError(
    'service_unavailable',
    'The native Computer Use provider returned an invalid result',
  );
}

function callErrorCode(code: string, signal: AbortSignal): CuBackendError['code'] {
  if (code === 'outcome_unknown') return 'outcome_unknown';
  if (code === 'operation_failed' && signal.aborted) return 'aborted';
  return 'service_unavailable';
}

function computerUseFailureMessage(code: ComputerUseErrorCode): string {
  switch (code) {
    case 'outcome_unknown':
      return 'The Computer Use action outcome is unknown; re-observe before retrying';
    case 'aborted':
      return 'The Computer Use operation was aborted';
    case 'service_unavailable':
      return 'The native Computer Use provider is unavailable';
    default:
      return `The Computer Use operation failed: ${code}`;
  }
}

function toProviderContext(context: CuRunContext): NativeProviderComputerUseContext {
  return {
    sessionId: context.sessionId,
    turnId: context.turnId,
    toolCallId: context.toolCallId,
    ...(context.backendObservationId === undefined
      ? {}
      : { backendObservationId: context.backendObservationId }),
    ...(context.boundAction === undefined
      ? {}
      : { boundAction: toBoundAction(context.boundAction) }),
  };
}

function toBoundAction(
  action: NonNullable<CuRunContext['boundAction']>,
): NativeProviderBoundAction {
  const target = action.target;
  return {
    frameId: action.frameId,
    epoch: action.epoch,
    target: {
      pid: target.pid,
      windowId: target.windowId,
      ...(target.bundleId === undefined ? {} : { bundleId: target.bundleId }),
      ...(target.appName === undefined ? {} : { appName: target.appName }),
      ...(target.title === undefined ? {} : { title: target.title }),
      ...(target.bounds === undefined ? {} : { bounds: target.bounds }),
      ...(target.sourceBoundsPx === undefined ? {} : { sourceBoundsPx: target.sourceBoundsPx }),
      ...(target.zIndex === undefined ? {} : { zIndex: target.zIndex }),
      ...(target.contentFingerprint === undefined
        ? {}
        : { contentFingerprint: target.contentFingerprint }),
    },
    ...(action.display === undefined ? {} : { display: action.display }),
    ...(action.elementId === undefined ? {} : { elementId: action.elementId }),
    ...(action.sourceCoordinate === undefined ? {} : { sourceCoordinate: action.sourceCoordinate }),
    ...(action.sourceStartCoordinate === undefined
      ? {}
      : { sourceStartCoordinate: action.sourceStartCoordinate }),
    ...(action.windowCoordinate === undefined ? {} : { windowCoordinate: action.windowCoordinate }),
    ...(action.windowStartCoordinate === undefined
      ? {}
      : { windowStartCoordinate: action.windowStartCoordinate }),
    ...(action.coordinateSpace === undefined ? {} : { coordinateSpace: action.coordinateSpace }),
  };
}

function toSemanticAction(action: CuSemanticAction): NativeProviderSemanticAction {
  return { ...action };
}

function toAction(action: CuAction): NativeProviderAction {
  return { ...action };
}

function toAppSummary(app: {
  readonly appId: string;
  readonly pid: number;
  readonly name?: string;
  readonly windowCount: number;
  readonly windows?: readonly {
    readonly windowId: number;
    readonly title?: string;
  }[];
}): CuAppSummary {
  return {
    appId: app.appId,
    pid: app.pid,
    ...(app.name === undefined ? {} : { name: app.name }),
    windowCount: app.windowCount,
    ...(app.windows === undefined ? {} : { windows: app.windows.map((window) => ({ ...window })) }),
  };
}

function toObservation(
  observation: NativeProviderObservation,
  attachments: readonly NativeProviderAttachmentData[],
): CuObservation {
  return {
    observationId: observation.observationId,
    appId: observation.appId,
    pid: observation.pid,
    windowId: observation.windowId,
    ...(observation.windowTitle === undefined ? {} : { windowTitle: observation.windowTitle }),
    ...(observation.capturedAt === undefined ? {} : { capturedAt: observation.capturedAt }),
    ...(observation.windowBounds === undefined ? {} : { windowBounds: observation.windowBounds }),
    ...(observation.sourceBoundsPx === undefined
      ? {}
      : { sourceBoundsPx: observation.sourceBoundsPx }),
    ...(observation.zIndex === undefined ? {} : { zIndex: observation.zIndex }),
    ...(observation.bundleId === undefined ? {} : { bundleId: observation.bundleId }),
    ...(observation.contentFingerprint === undefined
      ? {}
      : { contentFingerprint: observation.contentFingerprint }),
    ...(observation.displays === undefined
      ? {}
      : { displays: observation.displays.map((display) => ({ ...display })) }),
    elements: observation.elements.map((element) => ({
      ...element,
      ...(element.frame === undefined ? {} : { frame: { ...element.frame } }),
      ...(element.identity === undefined ? {} : { identity: { ...element.identity } }),
    })),
    ...(observation.screenshot === undefined
      ? {}
      : { screenshot: toScreenshot(observation.screenshot, attachments) }),
  };
}

function toRunResult(
  result: NativeProviderRunResult,
  attachments: readonly NativeProviderAttachmentData[],
): CuRunResult {
  const outcome = result.outcome.ok
    ? {
        ok: true as const,
        tier: result.outcome.tier,
        ...(result.outcome.verified === undefined ? {} : { verified: result.outcome.verified }),
        ...(result.outcome.effect === undefined
          ? {}
          : { evidence: { effect: result.outcome.effect } }),
        ...(result.outcome.completedSubSteps === undefined
          ? {}
          : { completedSubSteps: result.outcome.completedSubSteps }),
      }
    : {
        ok: false as const,
        error: result.outcome.error,
        message: computerUseFailureMessage(result.outcome.error),
        ...(result.outcome.completedSubSteps === undefined
          ? {}
          : { completedSubSteps: result.outcome.completedSubSteps }),
      };
  return {
    outcome,
    ...(result.resolvedScreenPoint === undefined
      ? {}
      : { resolvedScreenPoint: result.resolvedScreenPoint }),
    ...(result.screenshot === undefined
      ? {}
      : { screenshot: toScreenshot(result.screenshot, attachments) }),
    ...(result.observation === undefined
      ? {}
      : { observation: toObservation(result.observation, attachments) }),
  };
}

function toScreenshot(
  screenshot: {
    readonly image: NativeProviderAttachmentRef;
    readonly widthPx: number;
    readonly heightPx: number;
  },
  attachments: readonly NativeProviderAttachmentData[],
): CuScreenshot {
  const ref = screenshot.image;
  const attachment = attachments.find(
    (candidate) =>
      candidate.attachmentId === ref.attachmentId &&
      candidate.byteLength === ref.byteLength &&
      candidate.sha256 === ref.sha256 &&
      candidate.mimeType === ref.mimeType,
  );
  if (
    !attachment ||
    attachment.bytes.byteLength !== ref.byteLength ||
    createHash('sha256').update(attachment.bytes).digest('hex') !== ref.sha256
  ) {
    throw new CuBackendError(
      'capture_failed',
      'The native Computer Use provider returned an invalid screenshot attachment',
    );
  }
  return {
    base64: attachment.bytes.toString('base64'),
    mimeType: ref.mimeType,
    widthPx: screenshot.widthPx,
    heightPx: screenshot.heightPx,
  };
}
