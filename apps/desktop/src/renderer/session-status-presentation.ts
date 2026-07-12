/**
 * Pure presentation helpers for SessionStatus + SessionBlockedReason
 * used by the sidebar and chat header.
 *
 * Separated from the React component layer so the copy + tone mapping
 * can be unit-tested without a DOM, mirroring `chat-header-alert.ts`
 * pattern.
 *
 * Two contracts enforced here:
 *
 *  1. **Generalized blocked-reason copy** (@kenji review): UI labels
 *     never expose the raw `SessionBlockedReason` enum string. The
 *     mapping below is the canonical translation. New blocked reasons
 *     must extend the core enum AND this matrix together, or the
 *     `unknown` fallback applies.
 *
 *  2. **Status tone matrix**: each SessionStatus has a single visual
 *     tone (`accent / warning / destructive / info / success / muted`)
 *     consumed by both the SessionStatusIcon and the chat-header
 *     status badge. Aligns with the existing chat-header-alert tone
 *     vocabulary.
 */

import type { SessionBlockedReason, SessionStatus, SessionSummary } from '@maka/core';

/**
 * Session-level "blocked" is only worth interrupting the user when
 * they can ACT on it: configure a connection, re-login, or confirm a
 * permission. `tool_failed` / `unknown` mean "the last run's bookkeeping
 * didn't close cleanly" — the conversation itself is intact and
 * retryable, and the failure detail already surfaces on the failed
 * turn inside the chat. Runtime keeps writing the strict status (the
 * #397/#410 terminal-fact invariant is untouched); this is a
 * display-layer distinction only.
 */
const ACTIONABLE_BLOCKED_REASONS: ReadonlySet<SessionBlockedReason> = new Set([
  'NO_REAL_CONNECTION',
  'auth',
  'permission_required',
]);

export function isActionableBlocked(reason: SessionBlockedReason | undefined): boolean {
  return reason !== undefined && ACTIONABLE_BLOCKED_REASONS.has(reason);
}

/**
 * Normalize a SessionSummary as it enters renderer state: non-actionable
 * blocked sessions read as ordinary resumable sessions (`active`), so the
 * sidebar grouping, row icon, and chat-header badge all agree without
 * each consumer re-implementing the rule. Everything else passes through
 * unchanged.
 */
export function normalizeSessionSummaryForDisplay(session: SessionSummary): SessionSummary {
  if (session.status !== 'blocked' || isActionableBlocked(session.blockedReason)) return session;
  const { blockedReason: _blockedReason, ...rest } = session;
  void _blockedReason;
  return { ...rest, status: 'active' };
}

/**
 * Status tone vocabulary — extends the chat-header-alert tone set
 * (`info | warning | destructive`) with `accent` for active in-flight
 * work, `success` for completed work, and `muted` for terminal /
 * dormant buckets. Tones map to semantic color tokens in CSS
 * (`[data-status-tone="..."]`).
 */
export type SessionStatusTone = 'accent' | 'warning' | 'destructive' | 'info' | 'success' | 'muted' | 'neutral';

export interface SessionStatusPresentation {
  /** User-visible Chinese label for this status. */
  label: string;
  /** Color tone driving the badge / icon. */
  tone: SessionStatusTone;
  /**
   * Whether the lifecycle state can transition further by user
   * interaction in the chat (vs being terminal-for-this-session).
   * UI uses this to decide whether to dim the chat composer.
   */
  interactive: boolean;
}

const STATUS_PRESENTATION: Record<SessionStatus, SessionStatusPresentation> = {
  active: { label: '可继续', tone: 'neutral', interactive: true },
  running: { label: '进行中', tone: 'accent', interactive: true },
  waiting_for_user: { label: '等你确认', tone: 'warning', interactive: true },
  // `blocked` was destructive (red) but most blocked states are
  // recoverable (permission_required, auth retry, missing connection
  // selection) — the chat header pill ended up sitting beside monochrome
  // quiet-icon utility buttons, where the bright red read as a hard
  // error in a row that did not deserve one. 'warning' (warm yellow)
  // honestly conveys "you need to do something" without screaming
  // failure. Real hard failures surface through ChatHeaderAlertBadge,
  // which still uses destructive.
  blocked: { label: '需要处理', tone: 'warning', interactive: true },
  review: { label: '待审核', tone: 'info', interactive: true },
  done: { label: '已完成', tone: 'success', interactive: true },
  archived: { label: '已归档', tone: 'muted', interactive: false },
  // @kenji review on PR109b: aborted is dormant history but the UI
  // must NOT silently treat it as active. Renders a muted "已中止"
  // badge so the user can see what they cancelled later.
  aborted: { label: '已中止', tone: 'muted', interactive: false },
};

export function presentSessionStatus(status: SessionStatus): SessionStatusPresentation {
  return STATUS_PRESENTATION[status];
}

/**
 * Generalized phrasing for a blocked session. Surfaces a user-readable
 * cause without exposing the underlying enum identifier (per @kenji
 * review: UI must not leak `NO_REAL_CONNECTION` etc. directly).
 *
 * Returned text is suitable for `aria-label`, `title`, and inline
 * tooltip slots — short phrase, sentence-cased Chinese, no period.
 */
const BLOCKED_REASON_LABEL: Record<SessionBlockedReason, string> = {
  NO_REAL_CONNECTION: '等待配置可用模型连接',
  auth: '需要重新登录',
  permission_required: '等待权限确认',
  tool_failed: '工具调用失败',
  unknown: '运行中断，可重试',
};

export function describeBlockedReason(reason: SessionBlockedReason | undefined): string {
  if (!reason) return BLOCKED_REASON_LABEL.unknown;
  return BLOCKED_REASON_LABEL[reason] ?? BLOCKED_REASON_LABEL.unknown;
}

/**
 * Compose a single-line aria-label / tooltip for a blocked session,
 * combining the status label and the cause. Example:
 *   "需要处理 · 等待配置可用模型连接"
 *
 * Non-blocked sessions return just the status label.
 */
export function sessionStatusAriaLabel(status: SessionStatus, blockedReason?: SessionBlockedReason): string {
  const presentation = presentSessionStatus(status);
  if (status !== 'blocked') return presentation.label;
  return `${presentation.label} · ${describeBlockedReason(blockedReason)}`;
}

/**
 * Generalized Chinese phrasing for a failed turn's `errorClass`
 * Mirrors `describeBlockedReason()`; UI must never display the raw enum identifier.
 *
 * Recognized classes are written by the runtime via `classifyError()`,
 * `classifyHttpStatus()`, and `event.reason` / `event.code`. The set is
 * open-ended (any string the runtime emits is possible), so we map a
 * known prefix-list and fall back to "未知错误" for anything else.
 *
 * Importantly, this helper accepts strings — not a typed enum — so
 * future runtime additions (e.g. a new tool failure class) don't break
 * the UI; they just fall through to the catch-all until the mapping
 * is extended.
 */
export function describeTurnErrorClass(errorClass: string | undefined): string {
  if (!errorClass) return '未知错误';
  const lower = errorClass.toLowerCase();
  if (lower === 'timeout' || lower.includes('timeout')) return '请求超时';
  if (lower === 'auth' || lower.includes('auth') || lower === '401' || lower === '403') return '鉴权失败';
  if (lower === 'rate_limit' || lower.includes('rate')) return '触发模型速率限制';
  if (lower === 'network' || lower.includes('network') || lower.includes('fetch') || lower.includes('econn')) {
    return '网络错误';
  }
  if (lower === 'provider_unavailable' || /\b5\d\d\b/.test(lower)) return '模型服务返回错误';
  if (lower === 'tool_step_cap_reached') return '达到工具步骤上限';
  if (lower === 'tool_failed' || lower.includes('tool')) return '工具调用失败';
  if (lower === 'permission_required' || lower.includes('permission')) return '等待权限确认';
  if (lower === 'app_restarted') return '本地应用重启，上一轮没有完成';
  return '未知错误';
}

export type FailedTurnRecoveryAction = 'retry' | 'continue' | 'inspect_tool' | 'check_connection';

export interface FailedTurnRecoveryPresentation {
  action: FailedTurnRecoveryAction;
  label: string;
}

export interface FailedTurnRecoveryInput {
  errorClass?: string;
  partialOutputRetained: boolean;
  toolActivityCount: number;
  erroredToolCount: number;
}

/**
 * User-facing recovery guidance for a failed turn. This intentionally
 * separates "what failed" (`describeTurnErrorClass`) from "what should I do
 * next", following the same incident-summary discipline as the runtime logs:
 * do not ask the user to blindly retry if a tool already ran or partial output
 * was retained.
 */
export function deriveFailedTurnRecovery(input: FailedTurnRecoveryInput): FailedTurnRecoveryPresentation {
  const lower = input.errorClass?.toLowerCase() ?? '';
  if (lower === 'tool_step_cap_reached') {
    return { action: 'continue', label: '任务可能尚未完成，可以继续' };
  }
  if (input.erroredToolCount > 0 || lower === 'tool_failed' || lower.includes('tool')) {
    return { action: 'inspect_tool', label: '先检查工具结果，再决定是否重试' };
  }
  if (lower === 'auth' || lower.includes('auth') || lower === '401' || lower === '403') {
    return { action: 'check_connection', label: '先检查模型连接或登录状态' };
  }
  if (input.partialOutputRetained) {
    return { action: 'continue', label: '已保留部分输出，可从这里继续' };
  }
  if (input.toolActivityCount > 0) {
    return { action: 'inspect_tool', label: '工具记录已保留，重试前先看结果' };
  }
  return { action: 'retry', label: '没有执行工具，可直接重试' };
}
