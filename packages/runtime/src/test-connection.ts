import {
  PROVIDER_DEFAULTS,
  effectiveBaseUrl,
  type ConnectionTestResult,
  type LlmConnection,
} from '@maka/core/llm-connections';
import { proxiedFetch } from './bots/proxied-fetch.js';
import { anthropicRootUrl, anthropicV1Url, codexSubscriptionHeaders } from './subscription-auth.js';

const CONNECTION_TEST_TIMEOUT_MS = 15_000;
const CLAUDE_SUBSCRIPTION_BETA =
  'oauth-2025-04-20,interleaved-thinking-2025-05-14,redact-thinking-2026-02-12,context-management-2025-06-27,prompt-caching-scope-2026-01-05,claude-code-20250219';
const CLAUDE_SUBSCRIPTION_USER_AGENT = 'claude-cli/2.1.88 (external, cli)';

export async function testConnection(
  connection: LlmConnection,
  apiKey: string,
  model?: string,
): Promise<ConnectionTestResult> {
  const t0 = Date.now();
  const baseUrl = effectiveBaseUrl(connection);
  const auth = PROVIDER_DEFAULTS[connection.providerType].authKind;
  const secret = auth === 'none' ? '' : apiKey;
  const testModel =
    model ||
    connection.defaultModel ||
    PROVIDER_DEFAULTS[connection.providerType].fallbackModels[0];

  if (!testModel) {
    return { ok: false, errorMessage: 'No model to test' };
  }

  try {
    switch (PROVIDER_DEFAULTS[connection.providerType].protocol) {
      case 'anthropic':
        return await probeAnthropic(connection, baseUrl, secret, testModel, t0);
      case 'openai':
        return await probeOpenAI(connection, baseUrl, secret, testModel, t0);
      case 'google':
        return await probeGoogle(baseUrl, secret, testModel, t0);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      errorMessage: message,
      errorClass: message.toLowerCase().includes('timeout') ? 'timeout' : 'network',
      latencyMs: Date.now() - t0,
    };
  }
}

async function probeAnthropic(
  connection: LlmConnection,
  baseUrl: string,
  secret: string,
  model: string,
  t0: number,
): Promise<ConnectionTestResult> {
  const headers: Record<string, string> = connection.providerType === 'claude-subscription'
    ? {
        Authorization: `Bearer ${secret}`,
        'User-Agent': CLAUDE_SUBSCRIPTION_USER_AGENT,
        'anthropic-beta': CLAUDE_SUBSCRIPTION_BETA,
        'anthropic-dangerous-direct-browser-access': 'true',
        'x-app': 'cli',
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      }
    : {
        'x-api-key': secret,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      };

  if (connection.providerType === 'claude-subscription') {
    return probeClaudeSubscriptionProfile(baseUrl, headers, model, t0);
  }

  const r = await proxiedFetch(anthropicV1Url(baseUrl, '/messages'), {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model,
      max_tokens: 16,
      messages: [{ role: 'user', content: 'Hi' }],
    }),
    timeoutMs: CONNECTION_TEST_TIMEOUT_MS,
  });
  if (!r.ok) return httpFailure(r, t0);
  return { ok: true, latencyMs: Date.now() - t0, modelTested: model };
}

async function probeClaudeSubscriptionProfile(
  baseUrl: string,
  headers: Record<string, string>,
  model: string,
  t0: number,
): Promise<ConnectionTestResult> {
  // OAuth subscription login is account-scoped, not API-key-scoped. The
  // lightweight profile endpoint is the right "is this login usable?" probe;
  // firing a Messages API request just to test credentials spends quota and
  // can fail on Claude-Code-specific request-body cloaking unrelated to the
  // saved OAuth token.
  const r = await proxiedFetch(`${anthropicRootUrl(baseUrl)}/api/oauth/profile`, {
    method: 'GET',
    headers,
    timeoutMs: CONNECTION_TEST_TIMEOUT_MS,
  });
  if (!r.ok) return httpFailure(r, t0);
  return { ok: true, latencyMs: Date.now() - t0, modelTested: model };
}

async function probeOpenAI(
  connection: LlmConnection,
  baseUrl: string,
  apiKey: string,
  model: string,
  t0: number,
): Promise<ConnectionTestResult> {
  if (connection.providerType === 'codex-subscription') {
    return probeCodexSubscription(baseUrl, apiKey, model, t0);
  }
  const r = await proxiedFetch(`${stripTrailing(baseUrl)}/chat/completions`, {
    method: 'POST',
    headers: {
      ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model,
      max_tokens: 16,
      messages: [{ role: 'user', content: 'Hi' }],
    }),
    timeoutMs: CONNECTION_TEST_TIMEOUT_MS,
  });
  if (!r.ok) return httpFailure(r, t0);
  return { ok: true, latencyMs: Date.now() - t0, modelTested: model };
}

async function probeCodexSubscription(
  baseUrl: string,
  accessToken: string,
  model: string,
  t0: number,
): Promise<ConnectionTestResult> {
  const r = await proxiedFetch(`${stripTrailing(baseUrl)}/responses`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${accessToken}`,
      ...codexSubscriptionHeaders(accessToken),
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model,
      input: [{ role: 'user', content: [{ type: 'input_text', text: 'Hi' }] }],
      max_output_tokens: 16,
      store: false,
    }),
    timeoutMs: CONNECTION_TEST_TIMEOUT_MS,
  });
  if (!r.ok) return httpFailure(r, t0);
  return { ok: true, latencyMs: Date.now() - t0, modelTested: model };
}

async function probeGoogle(
  baseUrl: string,
  apiKey: string,
  model: string,
  t0: number,
): Promise<ConnectionTestResult> {
  const r = await proxiedFetch(
    `${stripTrailing(baseUrl)}/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: 'Hi' }] }],
        generationConfig: { maxOutputTokens: 16 },
      }),
      timeoutMs: CONNECTION_TEST_TIMEOUT_MS,
    },
  );
  if (!r.ok) return httpFailure(r, t0);
  return { ok: true, latencyMs: Date.now() - t0, modelTested: model };
}

async function httpFailure(r: Response, t0: number): Promise<ConnectionTestResult> {
  const statusCode = r.status;
  if (statusCode === 429) {
    return {
      ok: false,
      errorMessage: 'OAuth 已登录，但当前账号或 provider 正在 rate limit。请稍后重试，或先切换到其它可用模型。',
      statusCode,
      errorClass: 'provider_unavailable',
      latencyMs: Date.now() - t0,
    };
  }
  return {
    ok: false,
    errorMessage: `${statusCode} ${(await r.text()).slice(0, 200)}`,
    statusCode,
    errorClass: classifyHttpStatus(statusCode),
    latencyMs: Date.now() - t0,
  };
}

function stripTrailing(u: string): string {
  return u.replace(/\/+$/, '');
}

function classifyHttpStatus(statusCode: number): ConnectionTestResult['errorClass'] {
  if (statusCode === 401 || statusCode === 403) return 'auth';
  if (statusCode >= 500) return 'provider_unavailable';
  return 'unknown';
}
