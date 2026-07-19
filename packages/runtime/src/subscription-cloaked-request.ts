import { randomUUID } from 'node:crypto';

const CLAUDE_CODE_PRODUCT_VERSION = '2.1.153';
const CLAUDE_CODE_UA = `claude-cli/${CLAUDE_CODE_PRODUCT_VERSION} (external, cli)`;
const CLAUDE_CODE_SYSTEM_PREFIX = "You are Claude Code, Anthropic's official CLI for Claude.";

export interface CloakedRequestInput {
  body: Record<string, unknown>;
  model?: string;
  sessionKey: string;
  streaming: boolean;
  timeoutMs: number;
  deviceId: string;
  accountUuid: string;
  sessionId: string;
}

export interface CloakedRequestOutput {
  body: Record<string, unknown>;
  headers: Record<string, string>;
}

export async function buildCloakedRequest(
  input: CloakedRequestInput,
): Promise<CloakedRequestOutput> {
  const body: Record<string, unknown> = { ...input.body };
  const rawSystem = body.system;
  const systemBlocks: Array<Record<string, unknown>> = Array.isArray(rawSystem)
    ? [...(rawSystem as Array<Record<string, unknown>>)]
    : typeof rawSystem === 'string' && rawSystem
      ? [{ type: 'text', text: rawSystem }]
      : [];

  if (!systemBlocks.some(isClaudeCodePrefixBlock)) {
    systemBlocks.unshift({
      type: 'text',
      text: CLAUDE_CODE_SYSTEM_PREFIX,
      cache_control: { type: 'ephemeral' },
    });
  }

  const firstMessage = extractFirstUserMessageText(body.messages);
  const fingerprint = await computeFingerprint(firstMessage);
  systemBlocks.unshift({
    type: 'text',
    text: `x-anthropic-billing-header: cc_version=${CLAUDE_CODE_PRODUCT_VERSION}.${fingerprint}; cc_entrypoint=cli;`,
  });
  body.system = systemBlocks;

  const existingMetadata =
    body.metadata !== null && typeof body.metadata === 'object'
      ? (body.metadata as Record<string, unknown>)
      : {};
  body.metadata = {
    ...existingMetadata,
    user_id: JSON.stringify({
      device_id: input.deviceId,
      account_uuid: input.accountUuid,
      session_id: input.sessionId,
    }),
  };

  return {
    body,
    headers: {
      'user-agent': CLAUDE_CODE_UA,
      'X-Claude-Code-Session-Id': input.sessionId,
      'anthropic-beta': buildAnthropicBetaHeader(input.model),
      'anthropic-dangerous-direct-browser-access': 'true',
      'anthropic-version': '2023-06-01',
      'x-app': 'cli',
      'x-client-request-id': randomUUID(),
      Accept: input.streaming ? 'text/event-stream' : 'application/json',
      ...getStainlessHeaders(input.timeoutMs),
    },
  };
}

function getStainlessHeaders(timeoutMs: number): Record<string, string> {
  const platformMap: Record<string, string> = {
    darwin: 'MacOS',
    win32: 'Windows',
    freebsd: 'FreeBSD',
  };
  const archMap: Record<string, string> = { arm64: 'arm64', x64: 'x64' };
  const platform = platformMap[process.platform] ?? 'Linux';
  const arch = archMap[process.arch] ?? 'x86';
  return {
    'X-Stainless-Lang': 'js',
    'X-Stainless-Package-Version': '0.74.0',
    'X-Stainless-Runtime': 'node',
    'X-Stainless-Runtime-Version': 'v22.13.0',
    'X-Stainless-Arch': arch,
    'X-Stainless-Os': platform,
    'X-Stainless-Timeout': String(Math.max(1, Math.ceil(timeoutMs / 1000))),
    'X-Stainless-Retry-Count': '0',
  };
}

function buildAnthropicBetaHeader(model: string | undefined): string {
  const isHaiku = (model ?? '').toLowerCase().includes('haiku');
  return isHaiku
    ? 'oauth-2025-04-20,interleaved-thinking-2025-05-14,redact-thinking-2026-02-12,context-management-2025-06-27,prompt-caching-scope-2026-01-05,claude-code-20250219'
    : 'claude-code-20250219,oauth-2025-04-20,interleaved-thinking-2025-05-14,redact-thinking-2026-02-12,context-management-2025-06-27,prompt-caching-scope-2026-01-05,advanced-tool-use-2025-11-20,effort-2025-11-24';
}

function isClaudeCodePrefixBlock(block: unknown): boolean {
  if (block === null || typeof block !== 'object') return false;
  const text = (block as { text?: unknown }).text;
  return typeof text === 'string' && text.includes('You are Claude Code');
}

function extractFirstUserMessageText(messages: unknown): string {
  if (!Array.isArray(messages)) return '';
  const user = messages.find(
    (m) => m !== null && typeof m === 'object' && (m as { role?: unknown }).role === 'user',
  );
  if (!user) return '';
  const content = (user as { content?: unknown }).content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const textBlock = content.find(
      (b) => b !== null && typeof b === 'object' && (b as { type?: unknown }).type === 'text',
    );
    if (textBlock) {
      const text = (textBlock as { text?: unknown }).text;
      return typeof text === 'string' ? text : '';
    }
  }
  return '';
}

async function computeFingerprint(firstMessage: string): Promise<string> {
  const salt = '59cf53e54c78';
  const chars = [4, 7, 20].map((i) => firstMessage[i] ?? '0').join('');
  const payload = `${salt}${chars}${CLAUDE_CODE_PRODUCT_VERSION}`;
  const data = new TextEncoder().encode(payload);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
    .slice(0, 3);
}
