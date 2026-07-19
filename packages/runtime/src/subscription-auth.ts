export const CODEX_SUBSCRIPTION_USER_AGENT = 'codex_cli_rs/0.0.0 (Maka)';
export const CLAUDE_SUBSCRIPTION_BETA =
  'oauth-2025-04-20,interleaved-thinking-2025-05-14,redact-thinking-2026-02-12,context-management-2025-06-27,prompt-caching-scope-2026-01-05,claude-code-20250219';
export const CLAUDE_SUBSCRIPTION_USER_AGENT = 'claude-cli/2.1.153 (external, cli)';

export function claudeSubscriptionHeaders(): Record<string, string> {
  return {
    'User-Agent': CLAUDE_SUBSCRIPTION_USER_AGENT,
    'anthropic-beta': CLAUDE_SUBSCRIPTION_BETA,
    'anthropic-dangerous-direct-browser-access': 'true',
    'x-app': 'cli',
  };
}

export function openAiCodexHeaders(accessToken: string): Record<string, string> {
  const accountId = extractCodexAccountId(accessToken);
  return {
    ...(accountId
      ? {
          'ChatGPT-Account-Id': accountId,
        }
      : {}),
    'OpenAI-Beta': 'responses=experimental',
    originator: 'codex_cli_rs',
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
  const value = payload.chatgpt_account_id;
  if (typeof value === 'string' && value.trim()) return value.trim();
  const organizations = payload.organizations;
  if (Array.isArray(organizations)) {
    for (const organization of organizations) {
      if (!organization || typeof organization !== 'object') continue;
      const id = (organization as Record<string, unknown>).id;
      if (typeof id === 'string' && id.trim()) return id.trim();
    }
  }
  return null;
}

function decodeJwtPayload(token: string): Record<string, unknown> | null {
  const parts = token.split('.');
  if (parts.length !== 3 || !parts[1]) return null;
  try {
    const padded = parts[1] + '='.repeat((4 - (parts[1].length % 4)) % 4);
    const json = Buffer.from(padded.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString(
      'utf8',
    );
    return JSON.parse(json) as Record<string, unknown>;
  } catch {
    return null;
  }
}
