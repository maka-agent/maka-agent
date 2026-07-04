import { generalizedErrorMessageChinese } from '@maka/core';
import { errorCode, errorMessage } from './chat-readiness.js';

const SESSION_READ_MESSAGES_ERROR_MARKER = 'MAKA_SESSION_READ_MESSAGES_ERROR:';
const LOCAL_FILE_ACCESS_CODES = new Set(['EPERM', 'EACCES', 'EBUSY', 'ENOENT']);

export function sessionReadMessagesFailureMessage(error: unknown): string {
  return `${SESSION_READ_MESSAGES_ERROR_MARKER}${sessionReadMessagesFailureDescription(error)}`;
}

function sessionReadMessagesFailureDescription(error: unknown): string {
  const message = errorMessage(error);
  const diagnosticMessages = runtimeReadModelDiagnosticMessages(error);
  if (
    message === 'RuntimeEvent active projection cache read failed' ||
    diagnosticMessages.includes('SessionProjectionCache.readMessages failed')
  ) {
    return '读取进行中的对话缓存失败：本地会话文件暂时不可用，请稍后重试。';
  }
  if (
    message === 'RuntimeEvent ledger read failed' ||
    diagnosticMessages.includes('RuntimeEventStore.readRuntimeEvents failed')
  ) {
    return '读取对话运行记录失败：本地运行记录暂时无法读取，请稍后重试。';
  }
  if (isLocalFileAccessCode(errorCode(error))) {
    return '读取对话失败：本地会话文件暂时被占用或不可访问，请稍后重试。';
  }
  return `读取对话失败：${generalizedErrorMessageChinese(error, '本地对话状态暂时不可用，请稍后重试。')}`;
}

function isLocalFileAccessCode(code: string | undefined): boolean {
  return typeof code === 'string' && LOCAL_FILE_ACCESS_CODES.has(code.toUpperCase());
}

function runtimeReadModelDiagnosticMessages(error: unknown): string[] {
  const diagnostics = (error as { diagnostics?: unknown } | null)?.diagnostics;
  if (!Array.isArray(diagnostics)) return [];
  const messages: string[] = [];
  for (const diagnostic of diagnostics) {
    if (!diagnostic || typeof diagnostic !== 'object') continue;
    const message = (diagnostic as { message?: unknown }).message;
    if (typeof message === 'string') {
      messages.push(message);
    }
  }
  return messages;
}
