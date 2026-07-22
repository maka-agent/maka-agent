import type {
  NativeCapabilityHandlerOutcome,
  NativeCapabilityImplementation,
} from '../client/native-provider.js';
import {
  decodeNativeProviderOAuthPresentationResultPayload,
  type NativeProviderOAuthPresentationContext,
  type NativeProviderOAuthPresentationResultPayload,
} from '../protocol/native-provider-oauth-presentation.js';

export interface OAuthPresentationNativeBackend {
  openExternal(
    input: Readonly<{ url: string }>,
    context: NativeProviderOAuthPresentationContext,
    signal: AbortSignal,
  ): Promise<void>;
  requestAuthorizationCode(
    input: Readonly<{ url: string; stateHint: string }>,
    context: NativeProviderOAuthPresentationContext,
    signal: AbortSignal,
  ): Promise<string>;
}

export function createOAuthPresentationNativeCapability(
  backend: OAuthPresentationNativeBackend,
): NativeCapabilityImplementation<'oauth_presentation'> {
  return {
    capability: 'oauth_presentation',
    handle: async (frame, { signal }) => {
      try {
        switch (frame.subcall.kind) {
          case 'open_external':
            await backend.openExternal(frame.subcall.input, frame.subcall.context, signal);
            return success({ kind: 'open_external', opened: true });
          case 'request_authorization_code':
            return success({
              kind: 'request_authorization_code',
              payload: await backend.requestAuthorizationCode(
                frame.subcall.input,
                frame.subcall.context,
                signal,
              ),
            });
        }
      } catch {
        return { ok: false, code: 'operation_failed' };
      }
    },
  };
}

function success(
  result: NativeProviderOAuthPresentationResultPayload,
): NativeCapabilityHandlerOutcome<'oauth_presentation'> {
  const validated = decodeNativeProviderOAuthPresentationResultPayload(result);
  return { ok: true, complete: () => validated };
}
