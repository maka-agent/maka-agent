import {
  failureClassFromCompleteStopReason,
  type SessionEvent,
} from '@maka/core/events';

export function turnFailureMessageFromSessionEvent(event: SessionEvent): string | undefined {
  if (event.type === 'error') return event.message ?? event.reason ?? 'turn error';
  if (event.type !== 'complete') return undefined;
  const failureClass = failureClassFromCompleteStopReason(event.stopReason);
  if (failureClass) return `turn ended: ${failureClass}`;
  return undefined;
}
