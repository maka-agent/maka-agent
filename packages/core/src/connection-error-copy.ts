/**
 * Human-readable copy for a not-ready chat connection — the single source of
 * truth shared by every surface (desktop renderer, CLI first-run) so the
 * `NO_REAL_CONNECTION:<reason>` codes map to one set of fix instructions rather
 * than a per-surface table.
 *
 * Pure & sync. `describeChatConfigurationReason` turns a `ChatConfigurationReason`
 * into a Chinese sentence that names what is missing and where to fix it (设置 ·
 * 模型); `chatConfigurationReasonFromError` recovers the reason code from a thrown
 * `NO_REAL_CONNECTION:<reason>` error, tolerating both the bare CLI form and the
 * `NO_REAL_CONNECTION:<reason>: <message>` form that IPC wrapping produces.
 *
 * This module is the canonical home for the copy. The desktop renderer still
 * carries an identical inline switch in
 * `apps/desktop/src/renderer/model-connection-errors.ts` (`noRealConnectionSetupDescription`),
 * pinned verbatim by a source-snapshot boundary test; delegating that copy to
 * this function is a follow-up left out of the CLI-scoped change that introduced
 * this module.
 */

import type { ChatConfigurationReason } from './connection-readiness.js';

/**
 * Runtime membership anchor: `Object.keys` of this record is the set of valid
 * reason tokens the parser accepts. Typed as `Record<ChatConfigurationReason,
 * true>`, so adding a reason to the union fails the build until it is listed
 * here (which also keeps the parser's known-token set complete).
 */
const CHAT_CONFIGURATION_REASON_PRESENCE: Record<ChatConfigurationReason, true> = {
  missing_default_connection: true,
  connection_missing: true,
  connection_disabled: true,
  missing_api_key: true,
  missing_model: true,
  empty_model_list: true,
  model_not_enabled: true,
  model_not_chat_capable: true,
  oauth_subscription_not_wired: true,
  fake_backend: true,
};

const KNOWN_CHAT_CONFIGURATION_REASONS: ReadonlySet<string> = new Set(
  Object.keys(CHAT_CONFIGURATION_REASON_PRESENCE),
);

/**
 * Fix instructions for a not-ready connection. `undefined` (the parser's result
 * for an unrecognized error) returns the generic fallback; every known reason
 * has its own line. The switch is exhaustive over `ChatConfigurationReason` —
 * `assertUnhandledReason` gives it a `never` tail, so adding a reason to the
 * union fails the build here until its copy is added.
 */
export function describeChatConfigurationReason(reason: ChatConfigurationReason | undefined): string {
  switch (reason) {
    case undefined:
      return '模型连接暂时无法用于发送，请到 设置 · 模型 检查后重试。';
    case 'missing_default_connection':
      return '等待配置默认模型。请到 设置 · 模型 添加一个可用模型连接后再发送。';
    case 'connection_missing':
      return '该会话依赖的模型连接已删除，请到 设置 · 模型 重新选择或重建连接。';
    case 'connection_disabled':
      return '当前模型连接已禁用。请到 设置 · 模型 启用或选择其他默认模型。';
    case 'missing_api_key':
      return '当前模型连接还没有可用凭据。请到 设置 · 模型 补齐 API key 或重新登录后再发送。';
    case 'missing_model':
      return '当前模型连接还没有可用模型。请到 设置 · 模型 选择默认模型后再发送。';
    case 'empty_model_list':
      return '当前模型连接没有启用模型。请到 设置 · 模型 添加或启用模型后再发送。';
    case 'model_not_enabled':
      return '当前会话选择的模型未启用。请到 设置 · 模型 重新选择可用模型后再发送。';
    case 'model_not_chat_capable':
      return '当前会话选择的模型不能用于聊天。请到 设置 · 模型 重新选择支持聊天的模型后再发送。';
    case 'oauth_subscription_not_wired':
      return '这个订阅账号暂时不能作为聊天模型。请先选择可用的 API key 或已接入 OAuth 模型连接。';
    case 'fake_backend':
      return '当前会话来自旧的本地模拟连接。请到 设置 · 模型 添加真实模型后新建会话。';
    default:
      return assertUnhandledReason(reason);
  }
}

/**
 * Compile-time exhaustiveness guard: reachable only if a `ChatConfigurationReason`
 * has no `case` above, which makes `reason` non-`never` and fails the build.
 */
function assertUnhandledReason(reason: never): never {
  throw new Error(`Unhandled ChatConfigurationReason: ${String(reason)}`);
}

const NO_REAL_CONNECTION_REASON_RE = /NO_REAL_CONNECTION:([a-z_]+)/;

/**
 * Recover the `ChatConfigurationReason` from a `NO_REAL_CONNECTION:<reason>`
 * error. Returns `undefined` when the error is not a NO_REAL_CONNECTION error or
 * carries a token that is not a known reason (so callers fall back to the
 * generic copy rather than trusting an unrecognized code).
 */
export function chatConfigurationReasonFromError(error: unknown): ChatConfigurationReason | undefined {
  const raw = error instanceof Error ? error.message : String(error);
  const token = raw.match(NO_REAL_CONNECTION_REASON_RE)?.[1];
  return token && KNOWN_CHAT_CONFIGURATION_REASONS.has(token)
    ? (token as ChatConfigurationReason)
    : undefined;
}
