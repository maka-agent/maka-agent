import {
  CODEX_SUBSCRIPTION_UNSUPPORTED_CHATGPT_MODELS,
  PROVIDER_DEFAULTS,
  type LlmConnection,
} from '@maka/core/llm-connections';
import type { ConnectionStore, CredentialStore } from '@maka/storage';
import {
  type ClaudeSubscriptionService,
  isSubscriptionExperimentalEnabled,
} from './oauth/claude-subscription-service.js';
import {
  type CodexSubscriptionService,
  isCodexSubscriptionExperimentalEnabled,
} from './oauth/codex-subscription-service.js';

export const CLAUDE_SUBSCRIPTION_CONNECTION_SLUG = 'claude-subscription';
export const CODEX_SUBSCRIPTION_CONNECTION_SLUG = 'codex-subscription';

interface OAuthModelConnectionsDeps {
  connectionStore: ConnectionStore;
  credentialStore: CredentialStore;
  claudeSubscription: ClaudeSubscriptionService;
  codexSubscription: CodexSubscriptionService;
}

export function createOAuthModelConnectionsMainService(deps: OAuthModelConnectionsDeps) {
  function isClaudeSubscriptionAuthenticatedState(
    state: Awaited<ReturnType<ClaudeSubscriptionService['getAccountState']>>,
  ): boolean {
    return state.runtimeState === 'authenticated' ||
      state.runtimeState === 'refreshing' ||
      state.runtimeState === 'quota_unavailable' ||
      state.runtimeState === 'provider_rejected';
  }

  async function syncClaudeSubscriptionConnection(): Promise<LlmConnection | null> {
    if (!isSubscriptionExperimentalEnabled()) return null;
    const state = await deps.claudeSubscription.getAccountState();
    const existing = await deps.connectionStore.get(CLAUDE_SUBSCRIPTION_CONNECTION_SLUG);
    if (!isClaudeSubscriptionAuthenticatedState(state)) {
      if (existing && (state.runtimeState === 'refresh_failed' || state.runtimeState === 'storage_failed' || state.runtimeState === 'not_logged_in')) {
        return deps.connectionStore.update(existing.slug, {
          enabled: false,
          lastTestStatus: 'needs_reauth',
          lastTestAt: new Date().toISOString(),
          lastTestMessage: state.errorMessage ?? (state.runtimeState === 'not_logged_in'
            ? 'Claude OAuth 未登录。'
            : state.runtimeState === 'storage_failed'
              ? 'Claude OAuth 本地凭据读取失败。'
              : 'Claude OAuth 需要重新登录。'),
        });
      }
      return existing;
    }

    const defaults = PROVIDER_DEFAULTS['claude-subscription'];
    const fallbackModels = defaults.fallbackModels.map((id) => ({ id }));
    const displayName = 'Claude OAuth';
    const now = Date.now();
    const connection: LlmConnection = {
      slug: CLAUDE_SUBSCRIPTION_CONNECTION_SLUG,
      name: existing?.name ?? displayName,
      providerType: 'claude-subscription',
      baseUrl: defaults.baseUrl,
      defaultModel: existing?.defaultModel || defaults.fallbackModels[0] || '',
      enabled: true,
      models: existing?.models?.length ? existing.models : fallbackModels,
      modelSource: existing?.modelSource ?? 'fallback',
      lastTestStatus: 'verified',
      lastTestAt: new Date(now).toISOString(),
      lastTestMessage: 'Claude OAuth 已登录。',
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    return deps.connectionStore.save(connection);
  }

  function isCodexSubscriptionAuthenticatedState(
    state: Awaited<ReturnType<CodexSubscriptionService['getAccountState']>>,
  ): boolean {
    return state.runtimeState === 'authenticated' || state.runtimeState === 'refreshing';
  }

  async function syncCodexSubscriptionConnection(): Promise<LlmConnection | null> {
    if (!isCodexSubscriptionExperimentalEnabled()) return null;
    const state = await deps.codexSubscription.getAccountState();
    const existing = await deps.connectionStore.get(CODEX_SUBSCRIPTION_CONNECTION_SLUG);
    if (!isCodexSubscriptionAuthenticatedState(state)) {
      if (existing && (state.runtimeState === 'refresh_failed' || state.runtimeState === 'storage_failed' || state.runtimeState === 'not_logged_in')) {
        return deps.connectionStore.update(existing.slug, {
          enabled: false,
          lastTestStatus: 'needs_reauth',
          lastTestAt: new Date().toISOString(),
          lastTestMessage: state.errorMessage ?? (state.runtimeState === 'not_logged_in'
            ? 'Codex OAuth 未登录。'
            : state.runtimeState === 'storage_failed'
              ? 'Codex OAuth 本地凭据读取失败。'
              : 'Codex OAuth 需要重新登录。'),
        });
      }
      return existing;
    }

    const defaults = PROVIDER_DEFAULTS['codex-subscription'];
    const fallbackModels = defaults.fallbackModels.map((id) => ({ id }));
    const normalizedModels = normalizeCodexSubscriptionModels(existing?.models, fallbackModels);
    const normalizedDefaultModel = normalizeCodexSubscriptionDefaultModel(
      existing?.defaultModel,
      normalizedModels.map((entry) => entry.id),
      defaults.fallbackModels[0] || '',
    );
    const displayName = 'Codex OAuth';
    const now = Date.now();
    const connection: LlmConnection = {
      slug: CODEX_SUBSCRIPTION_CONNECTION_SLUG,
      name: existing?.name ?? displayName,
      providerType: 'codex-subscription',
      baseUrl: defaults.baseUrl,
      defaultModel: normalizedDefaultModel,
      enabled: true,
      models: normalizedModels,
      modelSource: existing?.modelSource ?? 'fallback',
      lastTestStatus: 'verified',
      lastTestAt: new Date(now).toISOString(),
      lastTestMessage: 'Codex OAuth 已登录。',
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    return deps.connectionStore.save(connection);
  }

  async function syncOAuthModelConnections(): Promise<void> {
    const results = await Promise.allSettled([
      syncClaudeSubscriptionConnection(),
      syncCodexSubscriptionConnection(),
    ]);
    for (const result of results) {
      if (result.status === 'rejected') {
        console.warn('[maka] OAuth model connection sync failed', result.reason);
      }
    }
  }

  async function resolveConnectionSecret(slug: string): Promise<string | null> {
    const connection = await deps.connectionStore.get(slug);
    if (connection?.providerType === 'claude-subscription') {
      return deps.claudeSubscription.getAccessTokenInternal();
    }
    if (connection?.providerType === 'codex-subscription') {
      return deps.codexSubscription.getAccessTokenInternal();
    }
    return deps.credentialStore.getSecret(slug, 'api_key');
  }

  /**
   * Read-only credential-presence check for status paths (onboarding's
   * `getSnapshot`) that must not trigger `resolveConnectionSecret`'s
   * OAuth near-expiry refresh — that refresh hits the network and
   * mutates local token state, which a read-only status read must
   * never do just by being observed. Send/test/fetch-models paths
   * keep using `resolveConnectionSecret` so they still benefit from
   * the refresh.
   *
   * Takes the `LlmConnection` directly rather than a slug: callers
   * that already hold the connection list (onboarding does) skip the
   * extra `connectionStore.get()` round trip and derive state from
   * one consistent snapshot.
   */
  async function hasConnectionSecret(connection: LlmConnection): Promise<boolean> {
    if (connection.providerType === 'claude-subscription') {
      return deps.claudeSubscription.hasStoredCredential();
    }
    if (connection.providerType === 'codex-subscription') {
      return deps.codexSubscription.hasStoredCredential();
    }
    const key = await deps.credentialStore.getSecret(connection.slug, 'api_key');
    return typeof key === 'string' && key.length > 0;
  }

  return {
    isClaudeSubscriptionAuthenticatedState,
    isCodexSubscriptionAuthenticatedState,
    resolveConnectionSecret,
    hasConnectionSecret,
    syncClaudeSubscriptionConnection,
    syncCodexSubscriptionConnection,
    syncOAuthModelConnections,
  };
}

function normalizeCodexSubscriptionModels(
  existingModels: LlmConnection['models'] | undefined,
  fallbackModels: NonNullable<LlmConnection['models']>,
): NonNullable<LlmConnection['models']> {
  const safeExisting = (existingModels ?? []).filter(
    (entry) => entry.id && !CODEX_SUBSCRIPTION_UNSUPPORTED_CHATGPT_MODELS.has(entry.id),
  );
  return safeExisting.length ? safeExisting : fallbackModels;
}

function normalizeCodexSubscriptionDefaultModel(
  existingDefaultModel: string | undefined,
  enabledModelIds: string[],
  fallbackModel: string,
): string {
  if (
    existingDefaultModel &&
    !CODEX_SUBSCRIPTION_UNSUPPORTED_CHATGPT_MODELS.has(existingDefaultModel) &&
    enabledModelIds.includes(existingDefaultModel)
  ) {
    return existingDefaultModel;
  }
  return enabledModelIds[0] || fallbackModel;
}
