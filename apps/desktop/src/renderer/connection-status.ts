// Derived per-connection UI status, computed from the persistent
// LlmConnection fields plus the async `hasSecret` lookup. Backend (xuan)
// owns the persistent enum:
//
//   `lastTestStatus?: 'verified' | 'needs_reauth' | 'error'`
//
// UI mixes that with `enabled`, the auth requirement, secret presence,
// and `defaultModel` to choose a *display* status. Priority order is
// fixed per @kenji's contract so we never produce mixed labels like
// "disabled + verified":
//
//   1. !enabled                                → disabled
//   2. needs secret but missing, or no model   → not_configured
//   3. lastTestStatus = 'verified'             → verified
//   4. lastTestStatus = 'needs_reauth'         → needs_reauth
//   5. lastTestStatus = 'error'                → error
//   6. otherwise (secret + model, never tested)→ configured

import type {
  ConnectionAuth,
  ConnectionLastTestStatus,
  LlmConnection,
  UiLocale,
} from '@maka/core';
import { PROVIDER_DEFAULTS } from '@maka/core/llm-connections';
import { getConnectionStatusCopy } from './locales/connection-status-copy.js';

export type ConnectionUiStatus =
  | 'disabled'
  | 'unsupported_provider'
  | 'not_configured'
  | 'configured'
  | 'verified'
  | 'needs_reauth'
  | 'error';

export interface ConnectionUiStatusInput {
  enabled: boolean;
  /** Whether a saved credential is available for this connection. */
  hasSecret: boolean;
  /** Non-empty `defaultModel` is required to call the connection. */
  defaultModel: string | undefined;
  /** Persistent test outcome (xuan's `5ca1f8a` schema). */
  lastTestStatus?: ConnectionLastTestStatus;
  /**
   * Determines whether `hasSecret` actually gates the connection. Providers
   * with `authKind: 'none'` (e.g. Ollama on localhost) never need a secret;
   * for them `hasSecret` is ignored in the not_configured check.
   */
  authKind: ConnectionAuth['kind'];
}

export function deriveConnectionUiStatus(input: ConnectionUiStatusInput): ConnectionUiStatus {
  if (!input.enabled) return 'disabled';
  const needsSecret = input.authKind === 'api_key' || input.authKind === 'oauth_token';
  if ((needsSecret && !input.hasSecret) || !input.defaultModel) {
    return 'not_configured';
  }
  switch (input.lastTestStatus) {
    case 'verified':
      return 'verified';
    case 'needs_reauth':
      return 'needs_reauth';
    case 'error':
      return 'error';
    default:
      return 'configured';
  }
}

export function connectionUiStatusFromRecord(
  connection: LlmConnection,
  hasSecret: boolean,
): ConnectionUiStatus {
  const defaults = PROVIDER_DEFAULTS[connection.providerType];
  // Unknown providerType → not configurable on this build, but not incomplete.
  if (!defaults) return connection.enabled ? 'unsupported_provider' : 'disabled';
  return deriveConnectionUiStatus({
    enabled: connection.enabled,
    hasSecret,
    defaultModel: connection.defaultModel,
    lastTestStatus: connection.lastTestStatus,
    authKind: defaults.authKind,
  });
}

interface StatusPresentation {
  label: string;
  detail: string;
  tone: 'neutral' | 'info' | 'success' | 'warning' | 'destructive';
}

export function presentConnectionUiStatus(status: ConnectionUiStatus, locale: UiLocale): StatusPresentation {
  return getConnectionStatusCopy(locale)[status];
}
