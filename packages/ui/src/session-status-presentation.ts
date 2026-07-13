import type { SessionBlockedReason, SessionStatus } from '@maka/core';

export type SessionStatusTone = 'accent' | 'warning' | 'destructive' | 'info' | 'success' | 'muted' | 'neutral';

export interface SessionStatusPresentation {
  label: string;
  tone: SessionStatusTone;
  interactive: boolean;
}

const STATUS_PRESENTATION: Record<SessionStatus, SessionStatusPresentation> = {
  active: { label: '可继续', tone: 'neutral', interactive: true },
  running: { label: '进行中', tone: 'accent', interactive: true },
  waiting_for_user: { label: '等你确认', tone: 'warning', interactive: true },
  blocked: { label: '需要处理', tone: 'warning', interactive: true },
  review: { label: '待审核', tone: 'info', interactive: true },
  done: { label: '已完成', tone: 'success', interactive: true },
  archived: { label: '已归档', tone: 'muted', interactive: false },
  aborted: { label: '已中止', tone: 'muted', interactive: false },
};

export function presentSessionStatus(status: SessionStatus): SessionStatusPresentation {
  return STATUS_PRESENTATION[status];
}

const BLOCKED_REASON_LABEL: Record<SessionBlockedReason, string> = {
  NO_REAL_CONNECTION: '等待配置可用模型连接',
  auth: '需要重新登录',
  permission_required: '等待权限确认',
  tool_failed: '工具调用失败',
  unknown: '运行中断，可重试',
};

export function describeBlockedReason(reason: SessionBlockedReason | undefined): string {
  return reason ? BLOCKED_REASON_LABEL[reason] : BLOCKED_REASON_LABEL.unknown;
}
