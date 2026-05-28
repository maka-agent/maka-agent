/**
 * Connection readiness — pure, sync judgment shared between the
 * send-path (chat-readiness.ts) and the onboarding state machine
 * (onboarding.ts). PR110a.
 *
 * Source of truth for "is this LlmConnection ready to send a message
 * right now?". Caller is responsible for resolving async inputs
 * (credential lookup → boolean) before calling; this module never
 * touches the credential store, filesystem, or IPC.
 *
 * The single helper here is the only place these criteria live:
 *   - real backend (not `fake`)
 *   - `enabled === true`
 *   - provider auth path is already send-wired (OAuth subscriptions
 *     stay blocked until their runtime send path lands)
 *   - has usable secret OR provider's `authKind === 'none'`
 *   - effective model exists (caller's `requestedModel` if provided,
 *     otherwise `connection.defaultModel`)
 *   - effective model is in `connection.models` (when that list is
 *     enumerated)
 *
 * @kenji + @xuan PR110a review gate: send-path / onboarding / quick
 * chat must call this helper rather than reimplementing the criteria.
 */

import { PROVIDER_DEFAULTS, type LlmConnection } from './llm-connections.js';

/**
 * Canonical reasons why an LlmConnection is not ready to send.
 *
 * Moved from `apps/desktop/src/main/chat-readiness.ts` to keep the
 * taxonomy stable across send-path, onboarding, and quick-chat surfaces.
 * Adding a new reason MUST update both this enum AND the matching
 * `OnboardingState` mapping in `onboarding.ts`.
 */
export type ChatConfigurationReason =
  | 'missing_default_connection'
  | 'connection_missing'
  | 'connection_disabled'
  | 'missing_api_key'
  | 'missing_model'
  | 'empty_model_list'
  | 'model_not_enabled'
  | 'oauth_subscription_not_wired'
  | 'fake_backend';

export type IsConnectionReadyResult =
  | { ready: true; model: string }
  | { ready: false; reason: ChatConfigurationReason };

export interface IsConnectionReadyInput {
  /** The connection to evaluate. */
  connection: LlmConnection;
  /**
   * Whether a usable secret exists for this connection. The caller is
   * responsible for resolving this asynchronously (credential store /
   * IPC) before calling — the helper itself is pure & sync. Providers
   * whose `authKind === 'none'` bypass this check entirely (the helper
   * treats `hasSecret` as irrelevant in that case).
   */
  hasSecret: boolean;
  /**
   * Optional override. When set, the helper validates THIS model
   * against the connection's enabled list. When omitted, it validates
   * `connection.defaultModel`. Same helper covers both the default
   * send path and a Quick Chat that lets the user pick a temporary
   * model — no parallel helpers needed.
   */
  requestedModel?: string;
}

/**
 * Pure, sync. Returns `{ ready: true, model }` with the effective
 * model id resolved, or `{ ready: false, reason }` for the first
 * failing criterion (in the order documented below). The order
 * matters: callers may use the returned reason to drive UI fix paths
 * (e.g. onboarding state derivation), so changing the order is a
 * contract change.
 *
 * Order:
 *   1. backend is `fake` → `fake_backend`
 *   2. `enabled === false` → `connection_disabled`
 *   3. `authKind === 'oauth_token'` → `oauth_subscription_not_wired`
 *   4. `authKind !== 'none' && !hasSecret` → `missing_api_key`
 *   5. effective model is empty/missing → `missing_model`
 *   6. `connection.models` is enumerated but empty → `empty_model_list`
 *   7. effective model is not in `connection.models` → `model_not_enabled`
 *
 * "Effective model" = `requestedModel ?? connection.defaultModel`.
 */
export function isConnectionReady(input: IsConnectionReadyInput): IsConnectionReadyResult {
  const { connection, hasSecret, requestedModel } = input;

  if (isFakeBackend(connection)) {
    return { ready: false, reason: 'fake_backend' };
  }
  if (!connection.enabled) {
    return { ready: false, reason: 'connection_disabled' };
  }
  const authKind = PROVIDER_DEFAULTS[connection.providerType].authKind;
  if (authKind === 'oauth_token') {
    return { ready: false, reason: 'oauth_subscription_not_wired' };
  }
  if (authKind !== 'none' && !hasSecret) {
    return { ready: false, reason: 'missing_api_key' };
  }
  const model = requestedModel || connection.defaultModel;
  if (!model) {
    return { ready: false, reason: 'missing_model' };
  }
  if (connection.models) {
    const enabled = new Set(connection.models.map((entry) => entry.id));
    if (enabled.size === 0) {
      return { ready: false, reason: 'empty_model_list' };
    }
    if (!enabled.has(model)) {
      return { ready: false, reason: 'model_not_enabled' };
    }
  }
  return { ready: true, model };
}

/**
 * Whether a connection is backed by a real LLM provider (anything
 * whose `backendKind === 'ai-sdk'`), as opposed to the in-process
 * `fake` backend or an unrecognized legacy provider type.
 *
 * @kenji PR110a review gate: telemetry / lastTestStatus must NOT
 * influence this judgment. A `fake` connection that happens to have
 * `lastTestStatus: 'verified'` is still fake. An unknown providerType
 * (legacy seed, future provider not yet in PROVIDER_DEFAULTS) is also
 * treated as non-real — onboarding then routes the user to the
 * add-provider flow which will rebuild a real connection.
 */
export function isRealConnection(connection: Pick<LlmConnection, 'providerType'>): boolean {
  return !isFakeBackend(connection);
}

function isFakeBackend(connection: Pick<LlmConnection, 'providerType'>): boolean {
  const defaults = PROVIDER_DEFAULTS[connection.providerType];
  if (!defaults) return true; // unknown providerType → treat as non-real
  return defaults.backendKind === 'fake';
}
