import type { SessionStatus } from '@maka/core';

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
