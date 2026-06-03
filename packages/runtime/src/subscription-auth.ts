export const CODEX_SUBSCRIPTION_USER_AGENT = 'codex-cli/0.0.0 (external, cli)';

/**
 * The Anthropic AI SDK expects a versioned API prefix and appends
 * `/messages` internally. Maka's provider defaults are user-facing roots
 * (`https://api.anthropic.com`) because our manual probes append `/v1/...`.
 * Keep the translation centralized so OAuth/API-key sends and probes do not
 * drift into `https://api.anthropic.com/messages` or `/v1/v1/...`.
 */
export function anthropicRootUrl(baseUrl: string): string {
  return stripTrailing(baseUrl).replace(/\/v1$/i, '');
}

export function anthropicV1BaseUrl(baseUrl: string): string {
  return `${anthropicRootUrl(baseUrl)}/v1`;
}

export function anthropicV1Url(baseUrl: string, path: string): string {
  const cleanPath = path.startsWith('/') ? path : `/${path}`;
  return `${anthropicV1BaseUrl(baseUrl)}${cleanPath}`;
}

export function codexSubscriptionHeaders(accessToken: string): Record<string, string> {
  const accountId = extractCodexAccountId(accessToken);
  return {
    ...(accountId ? { 'chatgpt-account-id': accountId } : {}),
    'User-Agent': CODEX_SUBSCRIPTION_USER_AGENT,
  };
}

export function extractCodexAccountId(accessToken: string): string | null {
  const payload = decodeJwtPayload(accessToken);
  if (!payload) return null;
  const auth = payload['https://api.openai.com/auth'];
  if (auth && typeof auth === 'object') {
    const value = (auth as Record<string, unknown>).chatgpt_account_id;
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  const sub = payload.sub;
  return typeof sub === 'string' && sub.trim() ? sub.trim() : null;
}

function stripTrailing(u: string): string {
  return u.replace(/\/+$/, '');
}

function decodeJwtPayload(token: string): Record<string, unknown> | null {
  const parts = token.split('.');
  if (parts.length !== 3 || !parts[1]) return null;
  try {
    const padded = parts[1] + '='.repeat((4 - (parts[1].length % 4)) % 4);
    const json = Buffer.from(padded.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
    return JSON.parse(json) as Record<string, unknown>;
  } catch {
    return null;
  }
}
