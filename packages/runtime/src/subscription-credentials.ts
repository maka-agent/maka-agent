import type { ProviderType } from '@maka/core/llm-connections';
import { TOKEN_REFRESH_SKEW_MS } from '@maka/core';
import {
  OAUTH_LOGIN_MAX_TOKEN_CHARS,
  OAUTH_LOGIN_PROVIDER_CONFIG,
  OAuthTokenEndpointError,
  decodeOAuthRefreshTokenPayload,
  requestOAuthTokenEndpointJson,
} from './oauth-login.js';

export type OAuthSubscriptionProvider = Extract<
  ProviderType,
  'claude-subscription' | 'openai-codex' | 'github-copilot'
>;

export interface OAuthSubscriptionTokens {
  access_token: string;
  refresh_token: string;
  expires_at: number;
  token_type?: string;
  scope?: string;
  account_uuid?: string;
  device_id?: string;
  id_token?: string;
  account_id?: string;
  base_url?: string;
}

export function isOAuthSubscriptionProvider(
  providerType: ProviderType,
): providerType is OAuthSubscriptionProvider {
  return (
    providerType === 'claude-subscription' ||
    providerType === 'openai-codex' ||
    providerType === 'github-copilot'
  );
}

export function parseOAuthSubscriptionTokens(raw: string): OAuthSubscriptionTokens | null {
  try {
    return projectOAuthSubscriptionTokens(JSON.parse(raw) as unknown);
  } catch {
    return null;
  }
}

export function serializeOAuthSubscriptionTokens(tokens: OAuthSubscriptionTokens): string {
  return JSON.stringify(projectOAuthSubscriptionTokens(tokens));
}

const OAUTH_SUBSCRIPTION_TOKEN_KEYS = new Set<keyof OAuthSubscriptionTokens>([
  'access_token',
  'refresh_token',
  'expires_at',
  'token_type',
  'scope',
  'account_uuid',
  'device_id',
  'id_token',
  'account_id',
  'base_url',
]);

function projectOAuthSubscriptionTokens(value: unknown): OAuthSubscriptionTokens {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new OAuthTokenEndpointError('invalid_response');
  }
  const ownKeys = Reflect.ownKeys(value);
  if (
    ownKeys.some(
      (key) =>
        typeof key !== 'string' ||
        !OAUTH_SUBSCRIPTION_TOKEN_KEYS.has(key as keyof OAuthSubscriptionTokens),
    )
  ) {
    throw new OAuthTokenEndpointError('invalid_response');
  }
  const record: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const key of ownKeys as string[]) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !('value' in descriptor)) {
      throw new OAuthTokenEndpointError('invalid_response');
    }
    record[key] = descriptor.value;
  }
  const accessToken = requireStoredToken(record.access_token);
  const refreshToken = requireStoredToken(record.refresh_token);
  const expiresAt = record.expires_at;
  if (typeof expiresAt !== 'number' || !Number.isSafeInteger(expiresAt) || expiresAt <= 0) {
    throw new OAuthTokenEndpointError('invalid_response');
  }
  const tokenType = optionalStoredString(record.token_type, 256);
  const scope = optionalStoredString(record.scope, 4 * 1024);
  const accountUuid = optionalStoredString(record.account_uuid, 1024);
  const deviceId = optionalDeviceId(record.device_id);
  const idToken = optionalStoredString(record.id_token, OAUTH_LOGIN_MAX_TOKEN_CHARS);
  const accountId = optionalStoredString(record.account_id, 1024);
  const baseUrl = optionalStoredString(record.base_url, 8 * 1024);
  return {
    access_token: accessToken,
    refresh_token: refreshToken,
    expires_at: expiresAt,
    ...(tokenType !== undefined ? { token_type: tokenType } : {}),
    ...(scope !== undefined ? { scope } : {}),
    ...(accountUuid !== undefined ? { account_uuid: accountUuid } : {}),
    ...(deviceId !== undefined ? { device_id: deviceId } : {}),
    ...(idToken !== undefined ? { id_token: idToken } : {}),
    ...(accountId !== undefined ? { account_id: accountId } : {}),
    ...(baseUrl !== undefined ? { base_url: baseUrl } : {}),
  };
}

function optionalDeviceId(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/.test(value)) {
    throw new OAuthTokenEndpointError('invalid_response');
  }
  return value;
}

function requireStoredToken(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > OAUTH_LOGIN_MAX_TOKEN_CHARS
  ) {
    throw new OAuthTokenEndpointError('invalid_response');
  }
  return value;
}

function optionalStoredString(value: unknown, maxChars: number): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.length === 0 || value.length > maxChars) {
    throw new OAuthTokenEndpointError('invalid_response');
  }
  return value;
}

export function extractOAuthSubscriptionAccessToken(raw: string): string | null {
  return parseOAuthSubscriptionTokens(raw)?.access_token ?? null;
}

export interface OAuthSubscriptionCredentialStore {
  getSecret(slug: string, kind: 'oauth_token'): Promise<string | null>;
  setSecret?(slug: string, kind: 'oauth_token', value: string): Promise<void>;
  compareAndSetSecret?(
    slug: string,
    kind: 'oauth_token',
    expected: string | null,
    value: string,
  ): Promise<{ committed: true } | { committed: false; current: string | null }>;
}

export interface ResolveOAuthSubscriptionAccessTokenInput {
  providerType: OAuthSubscriptionProvider;
  slug: string;
  credentialStore: OAuthSubscriptionCredentialStore;
  now?: () => number;
  fetchFn?: typeof fetch;
  timeoutMs?: number;
}

export type OAuthSubscriptionRefreshAndPersistOutcome =
  | { outcome: 'refreshed'; tokens: OAuthSubscriptionTokens }
  | { outcome: 'superseded'; tokens: OAuthSubscriptionTokens }
  | { outcome: 'logged-out' }
  | { outcome: 'refresh-failed'; error: unknown }
  | { outcome: 'storage-failed'; error: unknown };

export type OAuthSubscriptionResolveAndPersistOutcome =
  | { outcome: 'current'; tokens: OAuthSubscriptionTokens }
  | OAuthSubscriptionRefreshAndPersistOutcome;

export type RefreshAndPersistOAuthSubscriptionTokensInput = {
  slug: string;
  credentialStore: OAuthSubscriptionCredentialStore;
  now?: () => number;
  fetchFn?: typeof fetch;
} & (
  | {
      providerType: OAuthSubscriptionProvider;
      refreshTokens?: never;
      timeoutMs?: number;
    }
  | {
      providerType?: never;
      refreshTokens: (tokens: OAuthSubscriptionTokens) => Promise<OAuthSubscriptionTokens>;
      timeoutMs?: never;
    }
);

export type ResolveAndPersistOAuthSubscriptionTokensInput =
  RefreshAndPersistOAuthSubscriptionTokensInput & { refreshSkewMs?: number };

export async function resolveOAuthSubscriptionAccessToken(
  input: ResolveOAuthSubscriptionAccessTokenInput,
): Promise<string | null> {
  const tokens = await resolveOAuthSubscriptionTokens(input);
  return tokens?.access_token ?? null;
}

export async function resolveOAuthSubscriptionTokens(
  input: ResolveOAuthSubscriptionAccessTokenInput,
): Promise<OAuthSubscriptionTokens | null> {
  const result = await resolveAndPersistOAuthSubscriptionTokens(input);
  return result.outcome === 'current' ||
    result.outcome === 'refreshed' ||
    result.outcome === 'superseded'
    ? result.tokens
    : null;
}

export async function resolveAndPersistOAuthSubscriptionTokens(
  input: ResolveAndPersistOAuthSubscriptionTokensInput,
): Promise<OAuthSubscriptionResolveAndPersistOutcome> {
  let raw: string | null;
  try {
    raw = await input.credentialStore.getSecret(input.slug, 'oauth_token');
  } catch (error) {
    return { outcome: 'storage-failed', error };
  }
  if (raw === null) return { outcome: 'logged-out' };

  const tokens = parseOAuthSubscriptionTokens(raw);
  if (!tokens) {
    return { outcome: 'storage-failed', error: new Error('Stored OAuth token is invalid.') };
  }
  const now = input.now ?? (() => Date.now());
  if (tokens.expires_at - now() > (input.refreshSkewMs ?? TOKEN_REFRESH_SKEW_MS)) {
    return { outcome: 'current', tokens };
  }

  return refreshAndPersistOAuthSubscriptionTokensFromRaw(input, raw);
}

export async function refreshAndPersistOAuthSubscriptionTokens(
  input: RefreshAndPersistOAuthSubscriptionTokensInput,
): Promise<OAuthSubscriptionRefreshAndPersistOutcome> {
  let raw: string | null;
  try {
    raw = await input.credentialStore.getSecret(input.slug, 'oauth_token');
  } catch (error) {
    return { outcome: 'storage-failed', error };
  }
  if (raw === null) return { outcome: 'logged-out' };

  return refreshAndPersistOAuthSubscriptionTokensFromRaw(input, raw);
}

async function refreshAndPersistOAuthSubscriptionTokensFromRaw(
  input: RefreshAndPersistOAuthSubscriptionTokensInput,
  raw: string,
): Promise<OAuthSubscriptionRefreshAndPersistOutcome> {
  const tokens = parseOAuthSubscriptionTokens(raw);
  if (!tokens) {
    return { outcome: 'storage-failed', error: new Error('Stored OAuth token is invalid.') };
  }
  if (!input.credentialStore.compareAndSetSecret && !input.credentialStore.setSecret) {
    return { outcome: 'storage-failed', error: new Error('Credential store is read-only.') };
  }

  let refreshed: OAuthSubscriptionTokens;
  let serialized: string;
  try {
    refreshed = input.refreshTokens
      ? await input.refreshTokens(tokens)
      : await refreshOAuthSubscriptionTokens({
          providerType: input.providerType,
          tokens,
          now: input.now,
          fetchFn: input.fetchFn,
          timeoutMs: input.timeoutMs,
        });
    serialized = serializeOAuthSubscriptionTokens(refreshed);
  } catch (error) {
    return { outcome: 'refresh-failed', error };
  }

  try {
    if (input.credentialStore.compareAndSetSecret) {
      const committed = await input.credentialStore.compareAndSetSecret(
        input.slug,
        'oauth_token',
        raw,
        serialized,
      );
      if (!committed.committed) {
        if (committed.current === null) return { outcome: 'logged-out' };
        const current = parseOAuthSubscriptionTokens(committed.current);
        if (!current) {
          return { outcome: 'storage-failed', error: new Error('Stored OAuth token is invalid.') };
        }
        return { outcome: 'superseded', tokens: current };
      }
    } else {
      await input.credentialStore.setSecret!(input.slug, 'oauth_token', serialized);
    }
  } catch (error) {
    return { outcome: 'storage-failed', error };
  }

  return { outcome: 'refreshed', tokens: refreshed };
}

/**
 * Provider-specific refresh request. Exported so the desktop services
 * force-refresh through the same HTTP contract the pure-Node resolve
 * path uses — one refresh implementation per provider, not two.
 * Throws on a failed refresh; persistence is the caller's concern.
 */
export async function refreshOAuthSubscriptionTokens(input: {
  providerType: OAuthSubscriptionProvider;
  tokens: OAuthSubscriptionTokens;
  now?: () => number;
  fetchFn?: typeof fetch;
  timeoutMs?: number;
}): Promise<OAuthSubscriptionTokens> {
  const now = input.now ?? (() => Date.now());
  const fetchFn = input.fetchFn ?? fetch;
  switch (input.providerType) {
    case 'claude-subscription':
      return refreshClaudeSubscriptionTokens(input.tokens, now, fetchFn, input.timeoutMs);
    case 'openai-codex':
      return refreshOpenAiCodexTokens(input.tokens, now, fetchFn, input.timeoutMs);
    case 'github-copilot':
      return input.tokens;
  }
}

export const GITHUB_COPILOT_DEFAULT_API_ENDPOINT = 'https://api.githubcopilot.com';
export const GITHUB_COPILOT_API_VERSION = '2026-06-01';
export const GITHUB_COPILOT_COMPAT_HEADERS = {
  'User-Agent': 'GitHubCopilotChat/0.35.0',
  'Editor-Version': 'vscode/1.107.0',
  'Editor-Plugin-Version': 'copilot-chat/0.35.0',
  'Copilot-Integration-Id': 'vscode-chat',
} as const;

export function createGitHubCopilotAccountTokens(githubToken: string): OAuthSubscriptionTokens {
  return {
    access_token: githubToken,
    refresh_token: githubToken,
    expires_at: Number.MAX_SAFE_INTEGER,
    token_type: 'Bearer',
    base_url: GITHUB_COPILOT_DEFAULT_API_ENDPOINT,
  };
}

export function isSupportedGitHubCopilotAccountToken(token: string): boolean {
  return token.startsWith('gho_') || token.startsWith('ghu_') || token.startsWith('github_pat_');
}

async function refreshClaudeSubscriptionTokens(
  tokens: OAuthSubscriptionTokens,
  now: () => number,
  fetchFn: typeof fetch,
  timeoutMs?: number,
): Promise<OAuthSubscriptionTokens> {
  const config = OAUTH_LOGIN_PROVIDER_CONFIG['claude-subscription'];
  const { payload, status } = await requestOAuthTokenEndpointJson({
    endpoint: config.tokenEndpoint,
    fetchFn,
    timeoutMs,
    init: {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': config.tokenUserAgent,
      },
      body: JSON.stringify({
        grant_type: 'refresh_token',
        refresh_token: tokens.refresh_token,
        client_id: config.clientId,
      }),
    },
  });
  return decodeRefreshedOAuthTokens('claude-subscription', payload, status, tokens, now);
}

async function refreshOpenAiCodexTokens(
  tokens: OAuthSubscriptionTokens,
  now: () => number,
  fetchFn: typeof fetch,
  timeoutMs?: number,
): Promise<OAuthSubscriptionTokens> {
  const config = OAUTH_LOGIN_PROVIDER_CONFIG['openai-codex'];
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    client_id: config.clientId,
    refresh_token: tokens.refresh_token,
  });
  const { payload, status } = await requestOAuthTokenEndpointJson({
    endpoint: config.tokenEndpoint,
    fetchFn,
    timeoutMs,
    init: {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': config.tokenUserAgent,
      },
      body: body.toString(),
    },
  });
  return decodeRefreshedOAuthTokens('openai-codex', payload, status, tokens, now);
}

function decodeRefreshedOAuthTokens(
  provider: 'claude-subscription' | 'openai-codex',
  payload: unknown,
  status: number,
  previous: OAuthSubscriptionTokens,
  now: () => number,
): OAuthSubscriptionTokens {
  try {
    return decodeOAuthRefreshTokenPayload(provider, payload, previous, now());
  } catch (error) {
    throw new OAuthTokenEndpointError(
      error instanceof OAuthTokenEndpointError ? error.category : 'invalid_response',
      status,
    );
  }
}
