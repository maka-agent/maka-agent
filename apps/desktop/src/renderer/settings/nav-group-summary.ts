/**
 * Pure derivation of the Settings nav-group summary line (the short text
 * rendered under each group label in the Settings modal sidebar).
 *
 * Extracted from `SettingsModal.tsx` (PR-HEALTH-1, msg `e4887ffd` lock) so
 * the H1/H2 assertions from `notes/pr-health-0-audit-report.md` can be
 * pinned with `node:test`. Mirrors the `connection-status.ts`,
 * `chat-header-alert.ts`, `stale-sessions.ts` extraction pattern — pure
 * helper + colocated unit tests, no DOM / React.
 *
 * Per @xuan + @kenji PR-UI-AUDIT-1 (`7a16aa0b`) discipline, group summaries
 * MUST NOT impersonate operational readiness. We say `已启用` (the user-
 * toggle state) rather than `可用` (operational), and we don't claim
 * `凭据本地加密` when no credentials exist.
 */

import type { AppSettings, LlmConnection } from '@maka/core';

export type SettingsNavGroup = '基础' | 'AI' | '集成' | '数据与账号' | '其他';

/**
 * The render order used by the Settings modal sidebar. Lives here so the
 * nav-group enum and its presentation order stay in one place.
 */
export const NAV_GROUP_ORDER: SettingsNavGroup[] = ['基础', 'AI', '集成', '数据与账号', '其他'];

export interface NavGroupSummary {
  /** Short text rendered next to the group label, e.g. "3 verified · 1 needs reauth". */
  text: string;
  /** Tone drives color (info / warning / destructive). undefined → neutral. */
  tone?: 'info' | 'warning' | 'destructive';
}

export interface NavGroupSummaryInput {
  group: SettingsNavGroup;
  connections: LlmConnection[];
  defaultSlug: string | null;
  settings: AppSettings;
}

/**
 * Per @kenji's PR75 review: group labels shouldn't be just visual dividers
 * — they should summarize the live state of the group so the nav doubles
 * as a navigation map. We surface this as a small line below the group
 * heading, distinct from the persistent uppercase label.
 *
 * Keep summaries terse — @kenji's PR78 review: "不要让 nav 变成第二个详情页".
 * One short sentence, max ~14 chars, tone-coded for urgency.
 */
export function deriveNavGroupSummary(input: NavGroupSummaryInput): NavGroupSummary | undefined {
  switch (input.group) {
    case 'AI':
      return summarizeAi(input.connections, input.defaultSlug);
    case '集成':
      return summarizeIntegrations(input.connections, input.settings);
    case '数据与账号':
      return summarizeDataAccount(input.connections);
    case '基础':
    case '其他':
      return undefined;
  }
}

function summarizeAi(connections: LlmConnection[], defaultSlug: string | null): NavGroupSummary | undefined {
  const enabled = connections.filter((c) => c.enabled).length;
  if (enabled === 0) {
    return { text: '等待启用连接', tone: 'info' };
  }
  const errored = connections.filter((c) => c.enabled && c.lastTestStatus === 'error').length;
  const needsReauth = connections.filter((c) => c.enabled && c.lastTestStatus === 'needs_reauth').length;
  if (errored > 0) {
    return { text: `${errored} 个连接出错`, tone: 'destructive' };
  }
  if (needsReauth > 0) {
    return { text: `${needsReauth} 个需重登`, tone: 'warning' };
  }
  const defaultConnection = connections.find((c) => c.slug === defaultSlug);
  if (!defaultConnection) {
    return { text: '未设默认模型', tone: 'warning' };
  }
  // PR-UI-AUDIT-1 (@kenji msg 7a16aa0b): "可用" implied runtime
  // readiness (operational), but this count is purely
  // `connections.filter(c => c.enabled).length` — an enabled
  // connection may still be un-validated, needs-reauth, or
  // erroring. Use "已启用" to describe the actual user-toggle
  // state without claiming runtime availability. Matches the
  // provider-auth contract Path 17 S11 D1 lock
  // (`enabled / validated / operational` are three distinct concepts).
  return { text: `${enabled} 个已启用连接` };
}

function summarizeIntegrations(connections: LlmConnection[], settings: AppSettings): NavGroupSummary | undefined {
  // `connections` retained in the signature so future tone-coding
  // (e.g. bot connection requires LLM connection ready) has the data,
  // but the current summary is bot-channel + proxy only.
  void connections;
  const proxyOn = settings.network?.proxy?.enabled ?? false;
  const botChannels = settings.botChat?.channels ?? ({} as Record<string, { enabled?: boolean } | undefined>);
  const enabledBots = Object.values(botChannels).filter((channel) => channel?.enabled ?? false).length;
  // PR-HEALTH-1 (xuan msg e4887ffd, I4): same impersonation pattern
  // PR-UI-AUDIT-1 fixed for AI connections — "N 个机器人" implied an
  // operational claim, but this is a `channel.enabled` toggle count
  // only. Bots can be enabled but un-credentialed / unavailable /
  // degraded. Use "已启用机器人" parallel to "已启用连接" so the
  // user-toggle state stays distinct from operational readiness.
  return {
    text: `${proxyOn ? '代理已开' : '直连'} · ${enabledBots} 个已启用机器人`,
  };
}

function summarizeDataAccount(connections: LlmConnection[]): NavGroupSummary | undefined {
  const errored = connections.filter((c) => c.enabled && c.lastTestStatus === 'error').length;
  const needsReauth = connections.filter((c) => c.enabled && c.lastTestStatus === 'needs_reauth').length;
  if (errored + needsReauth > 0) {
    return {
      text: `${errored + needsReauth} 个凭据需处理`,
      tone: errored > 0 ? 'destructive' : 'warning',
    };
  }
  // PR-HEALTH-1 (xuan msg e4887ffd, I5): the prior fallback
  // `'凭据本地加密'` was a static reassurance shown even when no
  // connections exist — implying credentials were stored when none
  // were. Reflect the fact: only claim local encryption when there
  // ARE connections to encrypt for; otherwise tell the user the
  // group is empty.
  if (connections.length === 0) {
    return { text: '尚无凭据', tone: 'info' };
  }
  return { text: '凭据本地加密' };
}
