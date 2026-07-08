/**
 * Human-readable copy for a not-ready chat connection: maps each
 * `NO_REAL_CONNECTION:<reason>` code to one fix sentence so a first-run / CLI
 * surface does not hand-roll its own table.
 *
 * Pure & sync. `describeChatConfigurationReason` turns a reason into a Chinese
 * sentence naming what is missing and where to fix it (设置 · 模型);
 * `parseNoRealConnectionError` reports whether an error is a NO_REAL_CONNECTION
 * failure and recovers its reason, tolerating both the bare CLI form and the
 * `NO_REAL_CONNECTION:<reason>: <message>` form that IPC wrapping produces.
 *
 * The desktop renderer (`apps/desktop/src/renderer/model-connection-errors.ts`)
 * still carries its own copy of these strings and its own parser, so this is the
 * canonical home for the CLI path only; delegating the desktop copy+parser here
 * (and converting its source-snapshot boundary test to a behavior test) is a
 * tracked follow-up in the PR description. Until then the desktop copy can drift.
 */

import type { ChatConfigurationReason } from './connection-readiness.js';

const GENERIC_FIX_COPY = '模型连接暂时无法用于发送，请到 设置 · 模型 检查后重试。';

/**
 * The one hand-maintained table: reason → fix copy. Typed as
 * `Record<ChatConfigurationReason, string>`, so adding a reason to the union
 * fails the build until its copy is added here — completeness and copy live in
 * one place. `CHAT_CONFIGURATION_REASONS` and the parser's known-token set are
 * derived from its keys, so neither can drift from it.
 */
const REASON_FIX_COPY: Record<ChatConfigurationReason, string> = {
  missing_default_connection: '等待配置默认模型。请到 设置 · 模型 添加一个可用模型连接后再发送。',
  connection_missing: '该会话依赖的模型连接已删除，请到 设置 · 模型 重新选择或重建连接。',
  connection_disabled: '当前模型连接已禁用。请到 设置 · 模型 启用或选择其他默认模型。',
  missing_api_key: '当前模型连接还没有可用凭据。请到 设置 · 模型 补齐 API key 或重新登录后再发送。',
  missing_model: '当前模型连接还没有可用模型。请到 设置 · 模型 选择默认模型后再发送。',
  empty_model_list: '当前模型连接没有启用模型。请到 设置 · 模型 添加或启用模型后再发送。',
  model_not_enabled: '当前会话选择的模型未启用。请到 设置 · 模型 重新选择可用模型后再发送。',
  model_not_chat_capable: '当前会话选择的模型不能用于聊天。请到 设置 · 模型 重新选择支持聊天的模型后再发送。',
  oauth_subscription_not_wired: '这个订阅账号暂时不能作为聊天模型。请先选择可用的 API key 或已接入 OAuth 模型连接。',
  fake_backend: '当前会话来自旧的本地模拟连接。请到 设置 · 模型 添加真实模型后新建会话。',
};

/**
 * Every reason, derived from the copy table so test coverage and the parser's
 * known-token set track the union automatically. Module-scoped (the package
 * index does not re-export it) — only the parser and the tests read it.
 */
export const CHAT_CONFIGURATION_REASONS = Object.keys(REASON_FIX_COPY) as ChatConfigurationReason[];

const KNOWN_CHAT_CONFIGURATION_REASONS: ReadonlySet<string> = new Set(CHAT_CONFIGURATION_REASONS);

/**
 * Fix instructions for a not-ready connection. `undefined` (a missing or
 * unrecognized reason) returns the generic fallback; every known reason has its
 * own line, guaranteed present by the `Record` type above.
 */
export function describeChatConfigurationReason(reason: ChatConfigurationReason | undefined): string {
  return reason === undefined ? GENERIC_FIX_COPY : REASON_FIX_COPY[reason];
}

// Capture the whole reason token up to the next delimiter (`:` in the wrapped
// `NO_REAL_CONNECTION:<reason>: <msg>` form, whitespace, or end) so a malformed
// token that only prefixes a known reason (e.g. `missing_api_key2`) is not
// mistaken for it. The reason group is optional so the bare code still matches.
const NO_REAL_CONNECTION_RE = /NO_REAL_CONNECTION(?::([^\s:]+))?/;

export interface ParsedNoRealConnectionError {
  /** True when the error is a `NO_REAL_CONNECTION` failure. */
  matched: boolean;
  /** The known reason, or `undefined` for a missing/unrecognized token. */
  reason?: ChatConfigurationReason;
}

/**
 * Classify a thrown error: whether it is a NO_REAL_CONNECTION failure and, if
 * so, its reason. A matched error with a missing or unrecognized token yields
 * `{ matched: true, reason: undefined }`, so a caller still renders generic fix
 * copy rather than mistaking it for an unrelated failure and re-throwing.
 */
export function parseNoRealConnectionError(error: unknown): ParsedNoRealConnectionError {
  const raw = error instanceof Error ? error.message : String(error);
  const match = raw.match(NO_REAL_CONNECTION_RE);
  if (!match) return { matched: false };
  const token = match[1];
  return {
    matched: true,
    reason: token && KNOWN_CHAT_CONFIGURATION_REASONS.has(token)
      ? (token as ChatConfigurationReason)
      : undefined,
  };
}
