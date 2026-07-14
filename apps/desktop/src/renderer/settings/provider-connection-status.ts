// Pure status helpers for the Settings → 模型 connection list. Kept out
// of `ProvidersPanel.tsx` (no React, no DOM) so the decision logic can be
// exercised directly from the desktop test runner, the same way
// `connection-status.ts` is. Behavioural tests live in
// `provider-connection-status.test.ts`.

import type { LlmConnection } from '@maka/core';
import type { StatusTone } from './settings-status-badge';

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

/**
 * Status tone for one connection's Chip in the 模型连接 list. The branch
 * order mirrors `chipStatusText` exactly so the dot color and the copy can
 * never disagree: a lapsed OAuth login (enabled:false + needs_reauth) reads
 * as an actionable `info` ("please log back in"), a bare disabled connection
 * as `neutral`, verified as `success`, a last failure as `destructive`, and
 * an untested connection as `neutral`.
 */
export function chipStatusTone(connection: LlmConnection): StatusTone {
  if (connection.lastTestStatus === 'needs_reauth') return 'info';
  if (!connection.enabled) return 'neutral';
  switch (connection.lastTestStatus) {
    case 'verified':
      return 'success';
    case 'error':
      return 'destructive';
    default:
      return 'neutral';
  }
}
