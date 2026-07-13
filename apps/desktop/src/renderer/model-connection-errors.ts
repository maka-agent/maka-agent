import type { SessionEvent } from '@maka/core';
import {
  describeChatConfigurationReason,
  generalizedErrorMessageChinese,
  parseNoRealConnectionError,
} from '@maka/core';

const NO_REAL_CONNECTION_CODE = 'NO_REAL_CONNECTION';
const NO_REAL_CONNECTION_REASON_RE = /NO_REAL_CONNECTION:([a-z_]+): /;

export function isNoRealConnectionError(error: unknown): boolean {
  return parseNoRealConnectionError(error).matched;
}

export function isNoRealConnectionEvent(event: Extract<SessionEvent, { type: 'error' }>): boolean {
  return event.code === NO_REAL_CONNECTION_CODE || parseNoRealConnectionError(event.message).matched;
}

export function noRealConnectionReasonFromError(error: unknown): string | undefined {
  return parseNoRealConnectionError(error).reason;
}

export function noRealConnectionReasonFromEvent(event: Extract<SessionEvent, { type: 'error' }>): string | undefined {
  return parseNoRealConnectionError(
    event.reason ? `${NO_REAL_CONNECTION_CODE}:${event.reason}` : event.message,
  ).reason;
}

export function noRealConnectionSetupDescription(reason: string | undefined): string {
  return describeChatConfigurationReason(reason);
}

export function sessionEventErrorMessage(event: Extract<SessionEvent, { type: 'error' }>): string {
  return generalizedErrorMessageChinese(new Error(event.message), '对话运行失败，请稍后重试。');
}

export function cleanErrorMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return cleanEventMessage(raw);
}

export function cleanEventMessage(message: string): string {
  return message
    .replace(/^Error invoking remote method '[^']+': Error: /, '')
    .replace(NO_REAL_CONNECTION_REASON_RE, '')
    .replace(`${NO_REAL_CONNECTION_CODE}: `, '');
}

export function modelSetupToastCopy(reason: string | undefined, fallback: string): { title: string; description: string } {
  if (reason === 'connection_missing') {
    return {
      title: '连接已删除',
      description: describeChatConfigurationReason(reason),
    };
  }
  return {
    title: '等待配置真实模型',
    description: fallback,
  };
}
