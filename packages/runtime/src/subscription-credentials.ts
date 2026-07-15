import type { ProviderType } from '@maka/core/llm-connections';
import { TOKEN_REFRESH_SKEW_MS } from '@maka/core';

export type OAuthSubscriptionProvider = Extract<ProviderType, 'claude-subscription' | 'openai-codex' | 'github-copilot'>;

export interface OAuthSubscriptionTokens {
  access_token: string;
  refresh_token: string;
  expires_at: number;
  token_type?: string;
  scope?: string;
  account_uuid?: string;
  id_token?: string;
  account_id?: string;
  base_url?: string;
}

export function isOAuthSubscriptionProvider(providerType: ProviderType): providerType is OAuthSubscriptionProvider {
  return providerType === 'claude-subscription'
    || providerType === 'openai-codex'
    || providerType === 'github-copilot';
}

export function parseOAuthSubscriptionTokens(raw: string): OAuthSubscriptionTokens | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const record = parsed as Record<string, unknown>;
    if (typeof record.access_token !== 'string' || record.access_token.length === 0) return null;
    if (typeof record.refresh_token !== 'string' || record.refresh_token.length === 0) return null;
    if (typeof record.expires_at !== 'number' || !Number.isFinite(record.expires_at)) return null;
    return {
      access_token: record.access_token,
      refresh_token: record.refresh_token,
      expires_at: record.expires_at,
      ...(typeof record.token_type === 'string' ? { token_type: record.token_type } : {}),
      ...(typeof record.scope === 'string' ? { scope: record.scope } : {}),
      ...(typeof record.account_uuid === 'string' ? { account_uuid: record.account_uuid } : {}),
      ...(typeof record.id_token === 'string' ? { id_token: record.id_token } : {}),
      ...(typeof record.account_id === 'string' ? { account_id: record.account_id } : {}),
      ...(typeof record.base_url === 'string' ? { base_url: record.base_url } : {}),
    };
  } catch {
    return null;
  }
}

export function serializeOAuthSubscriptionTokens(tokens: OAuthSubscriptionTokens): string {
  return JSON.stringify(tokens);
}

export function extractOAuthSubscriptionAccessToken(raw: string): string | null {
  return parseOAuthSubscriptionTokens(raw)?.access_token ?? null;
}

export interface OAuthSubscriptionCredentialStore {
  getSecret(slug: string, kind: 'oauth_token'): Promise<string | null>;
  setSecret?(slug: string, kind: 'oauth_token', value: string): Promise<void>;
}

export interface ResolveOAuthSubscriptionAccessTokenInput {
  providerType: OAuthSubscriptionProvider;
  slug: string;
  credentialStore: OAuthSubscriptionCredentialStore;
  now?: () => number;
  fetchFn?: typeof fetch;
}

const CLAUDE_CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';
const CLAUDE_TOKEN_ENDPOINT = 'https://platform.claude.com/v1/oauth/token';
const CLAUDE_TOKEN_USER_AGENT = 'claude-cli/2.1.153 (external, cli)';

const CODEX_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
const CODEX_TOKEN_ENDPOINT = 'https://auth.openai.com/oauth/token';
const CODEX_TOKEN_USER_AGENT = 'maka-desktop/0.1.0 (oauth-subscription)';

export async function resolveOAuthSubscriptionAccessToken(
  input: ResolveOAuthSubscriptionAccessTokenInput,
): Promise<string | null> {
  const tokens = await resolveOAuthSubscriptionTokens(input);
  return tokens?.access_token ?? null;
}

export async function resolveOAuthSubscriptionTokens(
  input: ResolveOAuthSubscriptionAccessTokenInput,
): Promise<OAuthSubscriptionTokens | null> {
  const raw = await input.credentialStore.getSecret(input.slug, 'oauth_token');
  if (!raw) return null;
  const tokens = parseOAuthSubscriptionTokens(raw);
  if (!tokens) return null;

  const now = input.now ?? (() => Date.now());
  if (tokens.expires_at - now() > TOKEN_REFRESH_SKEW_MS) return tokens;
  if (!input.credentialStore.setSecret) return null;

  const refreshed = await refreshOAuthSubscriptionTokens({
    providerType: input.providerType,
    tokens,
    now,
    fetchFn: input.fetchFn ?? fetch,
  }).catch(() => null);
  if (!refreshed) return null;

  await input.credentialStore.setSecret(input.slug, 'oauth_token', serializeOAuthSubscriptionTokens(refreshed));
  return refreshed;
}

async function refreshOAuthSubscriptionTokens(input: {
  providerType: OAuthSubscriptionProvider;
  tokens: OAuthSubscriptionTokens;
  now: () => number;
  fetchFn: typeof fetch;
}): Promise<OAuthSubscriptionTokens> {
  switch (input.providerType) {
    case 'claude-subscription':
      return refreshClaudeSubscriptionTokens(input.tokens, input.now, input.fetchFn);
    case 'openai-codex':
      return refreshOpenAiCodexTokens(input.tokens, input.now, input.fetchFn);
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
): Promise<OAuthSubscriptionTokens> {
  const response = await fetchFn(CLAUDE_TOKEN_ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'User-Agent': CLAUDE_TOKEN_USER_AGENT,
    },
    body: JSON.stringify({
      grant_type: 'refresh_token',
      refresh_token: tokens.refresh_token,
      client_id: CLAUDE_CLIENT_ID,
    }),
  });
  if (!response.ok) throw new Error(`Claude OAuth token refresh failed (${response.status}).`);
  const payload = await response.json() as {
    access_token: string;
    refresh_token?: string;
    expires_in: number;
    token_type?: string;
    scope?: string;
    account?: { uuid?: string };
  };
  return {
    access_token: payload.access_token,
    refresh_token: payload.refresh_token ?? tokens.refresh_token,
    expires_at: now() + 1000 * payload.expires_in,
    token_type: payload.token_type ?? tokens.token_type,
    scope: payload.scope ?? tokens.scope,
    account_uuid: payload.account?.uuid ?? tokens.account_uuid,
  };
}

async function refreshOpenAiCodexTokens(
  tokens: OAuthSubscriptionTokens,
  now: () => number,
  fetchFn: typeof fetch,
): Promise<OAuthSubscriptionTokens> {
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    client_id: CODEX_CLIENT_ID,
    refresh_token: tokens.refresh_token,
  });
  const response = await fetchFn(CODEX_TOKEN_ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': CODEX_TOKEN_USER_AGENT,
    },
    body: body.toString(),
  });
  if (!response.ok) throw new Error(`Codex OAuth token refresh failed (${response.status}).`);
  const payload = await response.json() as {
    access_token: string;
    refresh_token?: string;
    id_token?: string;
    expires_in: number;
  };
  return {
    access_token: payload.access_token,
    refresh_token: payload.refresh_token ?? tokens.refresh_token,
    id_token: payload.id_token ?? tokens.id_token,
    expires_at: now() + 1000 * payload.expires_in,
    account_id: tokens.account_id,
  };
}
