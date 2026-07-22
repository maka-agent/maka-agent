import { requireExactRecord, requireId, requireRecord, requireUtf8BoundedString } from './codec.js';
import { invalidProtocolFrame } from './errors.js';

export const NATIVE_PROVIDER_OAUTH_PRESENTATION_MAX_URL_CHARS = 8 * 1024;
export const NATIVE_PROVIDER_OAUTH_PRESENTATION_MAX_STATE_HINT_UTF8_BYTES = 128;
export const NATIVE_PROVIDER_OAUTH_PRESENTATION_MAX_PASTE_PAYLOAD_UTF8_BYTES = 16 * 1024;

const NATIVE_PROVIDER_OAUTH_PRESENTATION_MAX_URL_UTF8_BYTES = 8 * 1024;

export interface NativeProviderOAuthPresentationContext {
  readonly ownerId: string;
  readonly attemptId: string;
}

export type NativeProviderOAuthPresentationSubcall =
  | {
      readonly kind: 'open_external';
      readonly input: Readonly<{ url: string }>;
      readonly context: NativeProviderOAuthPresentationContext;
    }
  | {
      readonly kind: 'request_authorization_code';
      readonly input: Readonly<{ url: string; stateHint: string }>;
      readonly context: NativeProviderOAuthPresentationContext;
    };

export type NativeProviderOAuthPresentationResultPayload =
  | { readonly kind: 'open_external'; readonly opened: true }
  | { readonly kind: 'request_authorization_code'; readonly payload: string };

export function decodeNativeProviderOAuthPresentationSubcall(
  value: unknown,
): NativeProviderOAuthPresentationSubcall {
  const subcall = requireRecord(value, 'native Provider OAuth presentation subcall');
  switch (subcall.kind) {
    case 'open_external': {
      const decoded = requireExactRecord(
        subcall,
        'native Provider OAuth presentation open external subcall',
        ['kind', 'input', 'context'],
      );
      const input = requireExactRecord(
        decoded.input,
        'native Provider OAuth presentation open external input',
        ['url'],
      );
      return {
        kind: 'open_external',
        input: { url: httpsUrl(input.url) },
        context: decodeContext(decoded.context),
      };
    }
    case 'request_authorization_code': {
      const decoded = requireExactRecord(
        subcall,
        'native Provider OAuth presentation authorization code subcall',
        ['kind', 'input', 'context'],
      );
      const input = requireExactRecord(
        decoded.input,
        'native Provider OAuth presentation authorization code input',
        ['url', 'stateHint'],
      );
      return {
        kind: 'request_authorization_code',
        input: {
          url: httpsUrl(input.url),
          stateHint: nonEmptyUtf8(
            input.stateHint,
            'OAuth presentation stateHint',
            NATIVE_PROVIDER_OAUTH_PRESENTATION_MAX_STATE_HINT_UTF8_BYTES,
          ),
        },
        context: decodeContext(decoded.context),
      };
    }
    default:
      throw invalidProtocolFrame('Invalid Native Provider OAuth presentation subcall kind');
  }
}

export function decodeNativeProviderOAuthPresentationResultPayload(
  value: unknown,
): NativeProviderOAuthPresentationResultPayload {
  const result = requireRecord(value, 'native Provider OAuth presentation result payload');
  switch (result.kind) {
    case 'open_external': {
      const decoded = requireExactRecord(
        result,
        'native Provider OAuth presentation open external result',
        ['kind', 'opened'],
      );
      if (decoded.opened !== true) {
        throw invalidProtocolFrame('Invalid OAuth presentation opened result');
      }
      return { kind: 'open_external', opened: true };
    }
    case 'request_authorization_code': {
      const decoded = requireExactRecord(
        result,
        'native Provider OAuth presentation authorization code result',
        ['kind', 'payload'],
      );
      return {
        kind: 'request_authorization_code',
        payload: nonEmptyUtf8(
          decoded.payload,
          'OAuth presentation paste payload',
          NATIVE_PROVIDER_OAUTH_PRESENTATION_MAX_PASTE_PAYLOAD_UTF8_BYTES,
        ),
      };
    }
    default:
      throw invalidProtocolFrame('Invalid Native Provider OAuth presentation result kind');
  }
}

function decodeContext(value: unknown): NativeProviderOAuthPresentationContext {
  const context = requireExactRecord(value, 'native Provider OAuth presentation context', [
    'ownerId',
    'attemptId',
  ]);
  return {
    ownerId: requireId(context.ownerId, 'ownerId'),
    attemptId: requireId(context.attemptId, 'attemptId'),
  };
}

function httpsUrl(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw invalidProtocolFrame('OAuth presentation URL must be non-empty');
  }
  if (value.length > NATIVE_PROVIDER_OAUTH_PRESENTATION_MAX_URL_CHARS) {
    throw invalidProtocolFrame('OAuth presentation URL exceeds character limit');
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw invalidProtocolFrame('OAuth presentation URL must be absolute');
  }
  if (parsed.protocol !== 'https:') {
    throw invalidProtocolFrame('OAuth presentation URL must use HTTPS');
  }
  if (parsed.username !== '' || parsed.password !== '') {
    throw invalidProtocolFrame('OAuth presentation URL must not contain userinfo');
  }
  const normalized = requireUtf8BoundedString(
    parsed.href,
    'OAuth presentation normalized URL',
    NATIVE_PROVIDER_OAUTH_PRESENTATION_MAX_URL_UTF8_BYTES,
  );
  if (normalized.length > NATIVE_PROVIDER_OAUTH_PRESENTATION_MAX_URL_CHARS) {
    throw invalidProtocolFrame('OAuth presentation normalized URL exceeds character limit');
  }
  return normalized;
}

function nonEmptyUtf8(value: unknown, label: string, maxBytes: number): string {
  const decoded = requireUtf8BoundedString(value, label, maxBytes);
  if (decoded.length === 0) throw invalidProtocolFrame(`${label} must be non-empty`);
  return decoded;
}
