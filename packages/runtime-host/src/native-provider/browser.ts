import {
  boundBrowserSnapshotForWire,
  BrowserBackendError,
  type BrowserBackend,
} from '@maka/runtime/browser-tools';
import type {
  NativeCapabilityHandlerOutcome,
  NativeCapabilityImplementation,
} from '../client/native-provider.js';
import {
  decodeNativeProviderBrowserResultPayload,
  type NativeProviderBrowserResultPayload,
} from '../protocol/index.js';

export function createBrowserNativeCapability(
  backend: BrowserBackend,
): NativeCapabilityImplementation<'browser'> {
  return {
    capability: 'browser',
    releaseTurnState: async (input) => {
      await backend.releaseTurnState(input);
    },
    handle: async (frame, { signal }) => {
      const { subcall } = frame;
      try {
        switch (subcall.kind) {
          case 'navigate':
            return success({
              ...(await backend.navigate(subcall.input, signal, subcall.context)),
              kind: 'navigate',
            });
          case 'snapshot':
            return success({
              ...boundBrowserSnapshotForWire(await backend.snapshot(signal, subcall.context)),
              kind: 'snapshot',
            });
          case 'click':
            return success({
              ...(await backend.click(subcall.input, signal, subcall.context)),
              kind: 'click',
            });
          case 'type':
            return success({
              ...(await backend.type(subcall.input, signal, subcall.context)),
              kind: 'type',
            });
          case 'wait':
            return success({
              ...(await backend.wait(subcall.input, signal, subcall.context)),
              kind: 'wait',
            });
          case 'extract':
            return success({
              ...(await backend.extract(subcall.input, signal, subcall.context)),
              kind: 'extract',
            });
        }
      } catch (error) {
        return {
          ok: false,
          code:
            error instanceof BrowserBackendError && error.code === 'outcome_unknown'
              ? 'outcome_unknown'
              : 'operation_failed',
        };
      }
    },
  };
}

function success(
  result: NativeProviderBrowserResultPayload,
): NativeCapabilityHandlerOutcome<'browser'> {
  const validated = decodeNativeProviderBrowserResultPayload(result);
  return { ok: true, complete: () => validated };
}
