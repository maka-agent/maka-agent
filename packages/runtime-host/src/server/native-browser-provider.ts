import {
  BrowserBackendError,
  type BrowserBackendInvocationProvider,
  type BrowserBackendOperations,
  type BrowserInvocationContext,
} from '@maka/runtime/browser-tools';
import type {
  NativeProviderBrowserContext,
  NativeProviderBrowserResultPayload,
  NativeProviderBrowserSubcall,
} from '../protocol/index.js';
import type {
  HostNativeProviderInvocation,
  HostNativeProviderService,
  HostNativeProviderSubcallOutcome,
} from './native-provider-coordinator.js';

type BrowserOutcome = HostNativeProviderSubcallOutcome<NativeProviderBrowserResultPayload>;

export function createHostNativeBrowserInvocationProvider(
  service: HostNativeProviderService,
): BrowserBackendInvocationProvider {
  return {
    async acquire(input, _signal) {
      let acquisition;
      try {
        acquisition = service.acquireInvocation({
          operationId: input.context.operationId,
          sessionId: input.context.sessionId,
          turnId: input.context.turnId,
          toolCallId: input.context.toolCallId,
          capability: 'browser',
          ...(input.affinity === undefined ? {} : { affinity: input.affinity }),
        });
      } catch {
        return acquisitionFailure('service_unavailable');
      }
      if (!acquisition.ok) {
        return acquisitionFailure(
          acquisition.error === 'service_mismatch' ? 'service_mismatch' : 'service_unavailable',
        );
      }
      const hostInvocation = acquisition.invocation;
      return {
        ok: true,
        invocation: {
          backend: createInvocationBackend(hostInvocation),
          affinity: hostInvocation.affinity,
          release: () => hostInvocation.release(),
        },
      };
    },
  };
}

function createInvocationBackend(
  invocation: HostNativeProviderInvocation,
): BrowserBackendOperations {
  const call = async <K extends NativeProviderBrowserSubcall['kind']>(
    subcall: Extract<NativeProviderBrowserSubcall, { kind: K }>,
    signal: AbortSignal,
  ): Promise<Extract<NativeProviderBrowserResultPayload, { kind: K }>> => {
    let outcome: BrowserOutcome;
    try {
      outcome = (await invocation.call({ subcall, signal })) as BrowserOutcome;
    } catch {
      throw new BrowserBackendError(
        'service_unavailable',
        'The native browser provider is unavailable',
      );
    }
    if (!outcome.ok) throw browserInvocationError(outcome.error.code);
    if (outcome.result.kind !== subcall.kind) {
      throw new BrowserBackendError(
        'service_unavailable',
        'The native browser provider returned an invalid result',
      );
    }
    return outcome.result as Extract<NativeProviderBrowserResultPayload, { kind: K }>;
  };

  return {
    async navigate(input, signal, runtimeContext) {
      const { kind: _kind, ...result } = await call(
        { kind: 'navigate', input, context: toProviderContext(runtimeContext) },
        signal,
      );
      return result;
    },
    async snapshot(signal, runtimeContext) {
      const { kind: _kind, ...result } = await call(
        { kind: 'snapshot', context: toProviderContext(runtimeContext) },
        signal,
      );
      return result;
    },
    async click(input, signal, runtimeContext) {
      const { kind: _kind, ...result } = await call(
        { kind: 'click', input, context: toProviderContext(runtimeContext) },
        signal,
      );
      return result;
    },
    async type(input, signal, runtimeContext) {
      const { kind: _kind, ...result } = await call(
        { kind: 'type', input, context: toProviderContext(runtimeContext) },
        signal,
      );
      return result;
    },
    async wait(input, signal, runtimeContext) {
      const { kind: _kind, ...result } = await call(
        { kind: 'wait', input, context: toProviderContext(runtimeContext) },
        signal,
      );
      return result;
    },
    async extract(input, signal, runtimeContext) {
      const { kind: _kind, ...result } = await call(
        { kind: 'extract', input, context: toProviderContext(runtimeContext) },
        signal,
      );
      return result;
    },
  };
}

function toProviderContext(context: BrowserInvocationContext): NativeProviderBrowserContext {
  return {
    sessionId: context.sessionId,
    turnId: context.turnId,
    toolCallId: context.toolCallId,
  };
}

function browserInvocationError(code: string): Error {
  if (code === 'outcome_unknown') {
    return new BrowserBackendError(
      'outcome_unknown',
      'The native browser operation outcome is unknown; observe before retrying',
    );
  }
  if (code === 'operation_failed') {
    return new Error('The native browser operation failed');
  }
  return new BrowserBackendError(
    'service_unavailable',
    'The native browser provider is unavailable',
  );
}

function acquisitionFailure(error: 'service_unavailable' | 'service_mismatch') {
  return {
    ok: false as const,
    error,
    message:
      error === 'service_mismatch'
        ? 'The browser provider bound to this Turn is no longer available'
        : 'Browser has no single available native provider',
  };
}
