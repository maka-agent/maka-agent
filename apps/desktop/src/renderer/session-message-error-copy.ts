import { generalizedErrorMessageChinese } from '@maka/core';

const TRUSTED_SESSION_MESSAGE_ERROR_PREFIXES = [
  '读取进行中的对话缓存失败：',
  '读取对话运行记录失败：',
  '读取对话失败：',
  '对话内容已读取，但标记已读失败：',
] as const;

export function messageReadErrorMessage(error: unknown): string {
  const message = safeSessionMessageErrorMessage(error);
  if (message) return message;
  return generalizedErrorMessageChinese(error, '对话内容暂时无法读取，请稍后重试。');
}

export function messageRefreshErrorMessage(error: unknown): string {
  const message = safeSessionMessageErrorMessage(error);
  if (message) return message;
  return generalizedErrorMessageChinese(error, '对话内容暂时无法刷新，请稍后重试。');
}

function safeSessionMessageErrorMessage(error: unknown): string | undefined {
  const raw = error instanceof Error ? error.message : String(error);
  for (const prefix of TRUSTED_SESSION_MESSAGE_ERROR_PREFIXES) {
    const index = raw.indexOf(prefix);
    if (index >= 0) return raw.slice(index).trim();
  }
  return undefined;
}
