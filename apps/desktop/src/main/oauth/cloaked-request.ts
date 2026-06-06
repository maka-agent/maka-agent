/**
 * Claude subscription "cloaked" request builder.
 *
 * PR-OAUTH-SUBSCRIPTION-0 (xuan `2c5aa125` G-X4 + kenji `cf41871b` #1).
 *
 * IMPORTANT: This module is ONLY imported dynamically when
 * `process.env.MAKA_CLAUDE_SUBSCRIPTION_CLOAK === '1'`. The default
 * Claude subscription request path in
 * `claude-subscription-service.ts` MUST NOT statically import this
 * module. Contract test `claude-subscription-cloak-flag.test.ts`
 * enforces this.
 *
 * Why opt-in:
 *   The subscription endpoint at api.anthropic.com refuses requests
 *   that don't look like the Claude Code CLI — it checks user-agent,
 *   Stainless SDK headers, and the presence of a "You are Claude
 *   Code" system prompt prefix. To make Maka's subscription quota
 *   actually work, the upstream Claude.ai client sends all of these
 *   (external reference at main.js:16037-16089).
 *
 *   Whether THIS impersonation is acceptable under Anthropic's ToS
 *   is an open product/legal question. Default OFF until a clear
 *   decision is recorded; users who explicitly opt in via the env
 *   var accept the risk.
 *
 * What this module exposes:
 *   - `buildCloakedRequest(input)`: takes a base outgoing request
 *     and returns a copy with cloaked headers + system prefix +
 *     metadata injection. Pure (no I/O); the caller is responsible
 *     for the actual HTTP call.
 *
 * What this module does NOT do:
 *   - Send tokens (caller adds `Authorization: Bearer <token>`).
 *   - Persist anything.
 *   - Decide whether to cloak (caller checks env var BEFORE
 *     dynamic import).
 */

import { randomUUID } from 'node:crypto';

const CLAUDE_CODE_PRODUCT_VERSION = '2.1.88';
const CLAUDE_CODE_UA = `claude-cli/${CLAUDE_CODE_PRODUCT_VERSION} (external, cli)`;
const CLAUDE_CODE_SYSTEM_PREFIX = "You are Claude Code, Anthropic's official CLI for Claude.";

/**
 * Stainless SDK headers — the upstream pattern pretends Maka is the
 * Anthropic SDK so the subscription gateway accepts the call.
 */
function getStainlessHeaders(timeoutMs: number): Record<string, string> {
  const platformMap: Record<string, string> = { darwin: 'MacOS', win32: 'Windows', freebsd: 'FreeBSD' };
  const archMap: Record<string, string> = { arm64: 'arm64', x64: 'x64' };
  const platform = platformMap[process.platform] ?? 'Linux';
  const arch = archMap[process.arch] ?? 'x86';
  return {
    'X-Stainless-Lang': 'js',
    'X-Stainless-Package-Version': '0.74.0',
    'X-Stainless-Runtime': 'node',
    // PR-CLAUDE-OAUTH-RUNTIME-VERSION-PIN-0: hardcode v22.13.0
    // instead of the dynamic process.version. Anthropic's OAuth
    // gateway may consult an allowlist of known Claude Code
    // runtime versions; alma's cloak (readable/main.js:16026) ships
    // a hardcoded `v22.13.0` regardless of the actual Node it
    // boots under. Mirror it exactly so a future Electron Node
    // bump (e.g. v23.x) doesn't silently start failing the gateway
    // check. Cross-ref notes/alma-deep-dive-yuejing-round-2/
    // 09-cloak-request-full.md "Maka delta" section.
    'X-Stainless-Runtime-Version': 'v22.13.0',
    'X-Stainless-Arch': arch,
    'X-Stainless-Os': platform,
    'X-Stainless-Timeout': String(Math.max(1, Math.ceil(timeoutMs / 1000))),
    'X-Stainless-Retry-Count': '0',
  };
}

/**
 * Build the anthropic-beta header chain. Haiku models get a smaller
 * subset per the upstream pattern.
 */
function buildAnthropicBetaHeader(model: string | undefined): string {
  const isHaiku = (model ?? '').toLowerCase().includes('haiku');
  return isHaiku
    ? 'oauth-2025-04-20,interleaved-thinking-2025-05-14,redact-thinking-2026-02-12,context-management-2025-06-27,prompt-caching-scope-2026-01-05,claude-code-20250219'
    : 'claude-code-20250219,oauth-2025-04-20,interleaved-thinking-2025-05-14,redact-thinking-2026-02-12,context-management-2025-06-27,prompt-caching-scope-2026-01-05,advanced-tool-use-2025-11-20,effort-2025-11-24';
}

/**
 * Type-narrow helper: is this `system` block already the Claude
 * Code prefix? If so we leave it (caller might be replaying).
 */
function isClaudeCodePrefixBlock(block: unknown): boolean {
  if (block === null || typeof block !== 'object') return false;
  const text = (block as { text?: unknown }).text;
  return typeof text === 'string' && text.includes('You are Claude Code');
}

/**
 * Extract the first user message text (used for billing fingerprint).
 * Defensive against arbitrary content shapes; returns empty string
 * if nothing matches.
 */
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

/**
 * Compute the billing fingerprint — three hex chars derived from a
 * salted hash of the first user message + product version. Matches
 * the upstream `computeFingerprint` (external reference at main.js:15978-15981).
 *
 * Async because we use SubtleCrypto when available so the helper
 * works on web (future) and Node alike. In Node 20+ `crypto.subtle`
 * is global.
 */
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

export interface CloakedRequestInput {
  /** Anthropic Messages API request body. Caller-owned; we copy. */
  body: Record<string, unknown>;
  /** Target model — used to pick the beta header variant. */
  model?: string;
  /** Session key for session-id derivation. */
  sessionKey: string;
  /** Whether this is a streaming request (affects Accept header). */
  streaming: boolean;
  /** Total timeout for the request, used for Stainless header. */
  timeoutMs: number;
  /** Device ID generated + persisted by the subscription service. */
  deviceId: string;
  /** Account UUID from the OAuth token response. */
  accountUuid: string;
  /** Stable per-session ID supplied by the caller — rotation is the
   *  caller's concern, this module just stamps it into headers. */
  sessionId: string;
}

export interface CloakedRequestOutput {
  body: Record<string, unknown>;
  headers: Record<string, string>;
}

/**
 * Build a cloaked outgoing request from the base body.
 *
 * Caller still adds `Authorization: Bearer <token>` to the headers
 * before sending — this module deliberately does not see tokens.
 */
export async function buildCloakedRequest(input: CloakedRequestInput): Promise<CloakedRequestOutput> {
  const body: Record<string, unknown> = { ...input.body };

  // 1. Inject Claude Code prefix into the system prompt array.
  const rawSystem = body.system;
  const systemBlocks: Array<Record<string, unknown>> = Array.isArray(rawSystem)
    ? [...rawSystem as Array<Record<string, unknown>>]
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

  // 2. Inject billing header block.
  const firstMessage = extractFirstUserMessageText(body.messages);
  const fingerprint = await computeFingerprint(firstMessage);
  const billingBlock = {
    type: 'text',
    text: `x-anthropic-billing-header: cc_version=${CLAUDE_CODE_PRODUCT_VERSION}.${fingerprint}; cc_entrypoint=cli;`,
  };
  // Billing block sits ABOVE the Claude Code prefix per the upstream pattern.
  systemBlocks.unshift(billingBlock);
  body.system = systemBlocks;

  // 3. Stamp identity into metadata.user_id.
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

  // 4. Build headers (excluding Authorization — caller adds that).
  const headers: Record<string, string> = {
    'user-agent': CLAUDE_CODE_UA,
    'X-Claude-Code-Session-Id': input.sessionId,
    'anthropic-beta': buildAnthropicBetaHeader(input.model),
    'anthropic-dangerous-direct-browser-access': 'true',
    'anthropic-version': '2023-06-01',
    'x-app': 'cli',
    'x-client-request-id': randomUUID(),
    Accept: input.streaming ? 'text/event-stream' : 'application/json',
    ...getStainlessHeaders(input.timeoutMs),
  };

  return { body, headers };
}
