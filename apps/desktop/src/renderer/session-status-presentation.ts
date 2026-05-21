/**
 * Pure presentation helpers for SessionStatus + SessionBlockedReason
 * (PR109b, design-system §9.8).
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

import type { SessionBlockedReason, SessionStatus } from '@maka/core';

/**
 * Status tone vocabulary — extends the chat-header-alert tone set
 * (`info | warning | destructive`) with `accent` for active in-flight
 * work, `success` for completed work, and `muted` for terminal /
 * dormant buckets. Tones map to design-system color tokens in CSS
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
  blocked: { label: '已阻塞', tone: 'destructive', interactive: true },
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
  NO_REAL_CONNECTION: '缺少可用模型连接',
  auth: '需要重新登录',
  permission_required: '等待权限确认',
  tool_failed: '工具调用失败',
  unknown: '未知阻塞',
};

export function describeBlockedReason(reason: SessionBlockedReason | undefined): string {
  if (!reason) return BLOCKED_REASON_LABEL.unknown;
  return BLOCKED_REASON_LABEL[reason] ?? BLOCKED_REASON_LABEL.unknown;
}

/**
 * Compose a single-line aria-label / tooltip for a blocked session,
 * combining the status label and the cause. Example:
 *   "已阻塞 · 缺少可用模型连接"
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
 * (PR109e-d, design-system §9.9). Mirrors `describeBlockedReason()`
 * pattern from PR109b — UI must never display the raw enum identifier.
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
  if (lower === 'provider_unavailable' || /\b5\d\d\b/.test(lower)) return '模型服务暂不可用';
  if (lower === 'tool_failed' || lower.includes('tool')) return '工具调用失败';
  if (lower === 'permission_required' || lower.includes('permission')) return '等待权限确认';
  return '未知错误';
}
