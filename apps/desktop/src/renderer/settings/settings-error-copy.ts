import { generalizedErrorMessageChinese } from '@maka/core';
import { redactSecrets } from '@maka/ui';

export function settingsActionErrorMessage(error: unknown): string {
  const raw = error instanceof Error
    ? error.message
    : typeof error === 'string'
      ? error
      : '';
  const classified = generalizedErrorMessageChinese(new Error(raw), '');
  if (classified) return classified;
  const redacted = redactSecrets(raw).trim();
  if (redacted && /[\u4E00-\u9FFF]/.test(redacted)) return redacted;
  return '未知错误，请稍后重试。';
}
