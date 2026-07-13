// Pure status helpers for the Settings → 模型 connection list. Kept out
// of `ProvidersPanel.tsx` (no React, no DOM) so the decision logic can be
// exercised directly from the desktop test runner, the same way
// `connection-status.ts` is. Behavioural tests live in
// `provider-connection-status.test.ts`.

import type { LlmConnection } from '@maka/core';

/**
 * Status copy for one connection in the 模型连接 list. A lapsed OAuth
 * subscription login arrives as enabled:false + needs_reauth (main.ts
 * subscription sync keeps the connection but flags it). That is a
 * "please log back in" signal, not a user-killed connection, so
 * needs_reauth wins over the disabled check and must never read as
 * "已禁用". A bare enabled:false (only the legacy V1→V2 migration sets
 * that, untested) falls through to the neutral "暂不可用".
 */
export function chipStatusText(connection: LlmConnection): string {
  if (connection.lastTestStatus === 'needs_reauth') return '需要重新登录';
  if (!connection.enabled) return '暂不可用';
  switch (connection.lastTestStatus) {
    case 'verified':
      // PR-UI-AUDIT-1 (@kenji msg 7a16aa0b): `verified` is a
      // credential-validation result only; it does NOT prove
      // agent send / stream / interrupt paths are operational
      // (provider-auth contract). Older copy
      // "已验证可用" conflated validation with operational
      // readiness, fixed to credential-only language. Matches
      // the doc warning at SettingsModal `验证通过 ≠ 运行可用`.
      return '凭据已验证';
    case 'error':
      return '上次连接失败';
    default:
      return '等待验证';
  }
}

export type GroupRollup = 'err' | 'warn' | 'ok' | 'idle';

/**
 * Worst-status rollup for a provider group's collapsed header, computed
 * over the FULL group rather than only enabled connections: a lapsed
 * OAuth subscription (enabled:false + needs_reauth) must still raise the
 * header so the user sees they need to log back in. An enabled-only
 * rollup read such a group as idle and hid the problem.
 */
export function rollupForGroup(connections: LlmConnection[]): GroupRollup {
  if (connections.some((c) => c.lastTestStatus === 'error')) return 'err';
  if (connections.some((c) => c.lastTestStatus === 'needs_reauth')) return 'warn';
  if (connections.some((c) => c.lastTestStatus === 'verified')) return 'ok';
  return 'idle';
}
