import { redactSecrets } from '@maka/core';
import type { LlmConnection } from '@maka/core/llm-connections';
import {
  type ClaudeSubscriptionService,
  isCloakEnabled,
} from './oauth/claude-subscription-service.js';
import type { CodexSubscriptionService } from './oauth/codex-subscription-service.js';

interface SubscriptionModelFetchDeps {
  claudeSubscription: ClaudeSubscriptionService;
  codexSubscription: CodexSubscriptionService;
}

export function createSubscriptionModelFetch(deps: SubscriptionModelFetchDeps) {
  return function buildSubscriptionModelFetch(
    connection: LlmConnection,
    sessionId: string,
    modelId: string,
  ): typeof fetch | undefined {
    if (connection.providerType === 'claude-subscription' && isCloakEnabled()) {
      return buildClaudeSubscriptionCloakedFetch(deps.claudeSubscription, sessionId, modelId);
    }
    if (connection.providerType === 'codex-subscription') {
      return buildCodexSubscriptionFetch(sessionId);
    }
    return undefined;
  };
}

function buildCodexSubscriptionFetch(sessionId: string): typeof fetch {
  return async (url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const headers = new Headers(init?.headers);
    headers.set('OpenAI-Beta', 'responses=experimental');
    headers.set('originator', 'codex_cli_rs');
    headers.set('session_id', sessionId);
    headers.set('x-client-request-id', sessionId);
    headers.set('content-type', 'application/json');

    const rawBody = init?.body;
    if (typeof rawBody !== 'string') {
      return checkedCodexSubscriptionFetch(url, { ...init, headers });
    }

    let parsedBody: Record<string, unknown>;
    try {
      const parsed = JSON.parse(rawBody) as unknown;
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return checkedCodexSubscriptionFetch(url, { ...init, headers });
      }
      parsedBody = parsed as Record<string, unknown>;
    } catch {
      return checkedCodexSubscriptionFetch(url, { ...init, headers });
    }

    return checkedCodexSubscriptionFetch(url, {
      ...init,
      headers,
      body: JSON.stringify({
        ...parsedBody,
        instructions: codexInstructionsFromBody(parsedBody),
        store: false,
        parallel_tool_calls: parsedBody.parallel_tool_calls ?? true,
        text: {
          ...(parsedBody.text !== null && typeof parsedBody.text === 'object'
            ? parsedBody.text as Record<string, unknown>
            : {}),
          verbosity: (
            parsedBody.text !== null
            && typeof parsedBody.text === 'object'
            && typeof (parsedBody.text as { verbosity?: unknown }).verbosity === 'string'
          )
            ? (parsedBody.text as { verbosity: string }).verbosity
            : 'medium',
        },
      }),
    });
  };
}

async function checkedCodexSubscriptionFetch(
  url: Parameters<typeof fetch>[0],
  init?: Parameters<typeof fetch>[1],
): Promise<Response> {
  const response = await fetch(url, init);
  if (!response.ok) {
    const detail = await response.clone().text().catch(() => '');
    throw new Error(formatCodexSubscriptionHttpError(response.status, detail));
  }
  return response;
}

function codexInstructionsFromBody(body: Record<string, unknown>): string {
  if (typeof body.instructions === 'string' && body.instructions.trim()) {
    return body.instructions;
  }
  if (typeof body.system === 'string' && body.system.trim()) {
    return body.system;
  }
  const input = body.input;
  if (Array.isArray(input)) {
    for (const item of input) {
      if (!item || typeof item !== 'object') continue;
      const record = item as Record<string, unknown>;
      if (record.role !== 'system') continue;
      const content = record.content;
      if (typeof content === 'string' && content.trim()) return content;
      if (!Array.isArray(content)) continue;
      const text = content
        .map((part) => {
          if (!part || typeof part !== 'object') return '';
          const value = (part as Record<string, unknown>).text;
          return typeof value === 'string' ? value : '';
        })
        .filter(Boolean)
        .join('\n')
        .trim();
      if (text) return text;
    }
  }
  return 'You are Maka, a helpful AI assistant.';
}

function formatCodexSubscriptionHttpError(statusCode: number, detail: string): string {
  const compact = redactSecrets(detail).replace(/\s+/g, ' ').trim().slice(0, 240);
  return compact
    ? `Codex OAuth request failed: HTTP ${statusCode} ${compact}`
    : `Codex OAuth request failed: HTTP ${statusCode}`;
}

function buildClaudeSubscriptionCloakedFetch(
  claudeSubscription: ClaudeSubscriptionService,
  sessionId: string,
  modelId: string,
): typeof fetch {
  return async (url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const rawBody = init?.body;
    if (typeof rawBody !== 'string') {
      return fetch(url, init);
    }

    let parsedBody: Record<string, unknown>;
    try {
      const parsed = JSON.parse(rawBody) as unknown;
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return fetch(url, init);
      }
      parsedBody = parsed as Record<string, unknown>;
    } catch {
      return fetch(url, init);
    }

    const [{ buildCloakedRequest }, deviceId, accountState] = await Promise.all([
      import('./oauth/cloaked-request.js'),
      claudeSubscription.getOrCreateDeviceId(),
      claudeSubscription.getAccountState(),
    ]);
    const upstream = await buildCloakedRequest({
      body: parsedBody,
      model: modelId,
      sessionKey: sessionId,
      streaming: parsedBody.stream === true,
      timeoutMs: 600_000,
      deviceId,
      accountUuid: accountState.profile?.accountUuid ?? '',
      sessionId,
    });

    const headers = new Headers(init?.headers);
    for (const [key, value] of Object.entries(upstream.headers)) {
      headers.set(key, value);
    }
    headers.set('content-type', 'application/json');
    // Match the upstream Claude Code OAuth send: the outbound
    // request is OAuth-only (`Authorization: Bearer <token>` added
    // by AI SDK from `authToken`). AI SDK's Anthropic provider also
    // adds an empty / placeholder `x-api-key` header because we
    // never set `apiKey`. Anthropic's OAuth subscription endpoint
    // rejects requests that present BOTH `Authorization: Bearer` and
    // a non-OAuth-compatible `x-api-key` — the user-visible symptom is
    // a 401 / 403 rendered as `鉴权失败`. Strip `x-api-key` so only
    // the Bearer token is presented, exactly as the upstream Claude
    // Code OAuth send does.
    headers.delete('x-api-key');

    return fetch(url, {
      ...init,
      headers,
      body: JSON.stringify(upstream.body),
    });
  };
}
