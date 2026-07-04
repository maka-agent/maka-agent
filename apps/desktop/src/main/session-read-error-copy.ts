import { generalizedErrorMessageChinese, redactSecrets } from '@maka/core';
import { errorCode, errorMessage } from './chat-readiness.js';

const LOCAL_FILE_ACCESS_HINT = '本地会话文件暂时被占用或不可访问，请稍后重试。';

export function sessionReadMessagesFailureMessage(error: unknown): string {
  const signature = errorSignature(error);
  if (isActiveProjectionCacheFailure(signature)) {
    return `读取进行中的对话缓存失败：${localFileReadHint(signature)}`;
  }
  if (isRuntimeLedgerFailure(signature)) {
    return '读取对话运行记录失败：本地运行记录暂时无法读取，请稍后重试。';
  }
  if (isLocalFileAccessFailure(signature)) {
    return `读取对话失败：${localFileReadHint(signature)}`;
  }
  return `读取对话失败：${generalizedErrorMessageChinese(error, '本地对话状态暂时不可用，请稍后重试。')}`;
}

export function sessionMarkReadFailureMessage(error: unknown): string {
  const signature = errorSignature(error);
  if (isLocalFileAccessFailure(signature)) {
    return `对话内容已读取，但标记已读失败：${LOCAL_FILE_ACCESS_HINT}`;
  }
  return `对话内容已读取，但标记已读失败：${generalizedErrorMessageChinese(error, '未读状态暂时无法更新，请稍后重试。')}`;
}

function isActiveProjectionCacheFailure(signature: string): boolean {
  return signature.includes('runtimeevent active projection cache read failed') ||
    signature.includes('sessionprojectioncache.readmessages failed') ||
    signature.includes('in-flight projection cache');
}

function isRuntimeLedgerFailure(signature: string): boolean {
  return signature.includes('runtimeevent ledger read failed') ||
    signature.includes('runtimeeventstore.readruntimeevents failed') ||
    signature.includes('invalid runtimeevent jsonl');
}

function isLocalFileAccessFailure(signature: string): boolean {
  return signature.includes('eperm') ||
    signature.includes('eacces') ||
    signature.includes('ebusy') ||
    signature.includes('enoent') ||
    signature.includes('operation not permitted') ||
    signature.includes('permission denied') ||
    signature.includes('resource busy') ||
    signature.includes('rename ') ||
    signature.includes('session.jsonl');
}

function localFileReadHint(signature: string): string {
  if (signature.includes('enoent') || signature.includes('no such file')) {
    return '本地会话文件缺失或暂时无法读取，请稍后重试。';
  }
  return LOCAL_FILE_ACCESS_HINT;
}

function errorSignature(error: unknown): string {
  return redactSecrets([
    errorMessage(error),
    errorCode(error),
    ...runtimeReadModelDiagnostics(error),
  ].filter(Boolean).join('\n')).toLowerCase();
}

function runtimeReadModelDiagnostics(error: unknown): string[] {
  const diagnostics = (error as { diagnostics?: unknown } | null)?.diagnostics;
  if (!Array.isArray(diagnostics)) return [];
  const parts: string[] = [];
  for (const diagnostic of diagnostics) {
    if (!diagnostic || typeof diagnostic !== 'object') continue;
    const record = diagnostic as Record<string, unknown>;
    collectPrimitive(parts, record.code);
    collectPrimitive(parts, record.message);
    const details = record.details;
    if (!details || typeof details !== 'object') continue;
    for (const value of Object.values(details as Record<string, unknown>)) {
      collectPrimitive(parts, value);
    }
  }
  return parts;
}

function collectPrimitive(parts: string[], value: unknown): void {
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    parts.push(String(value));
  }
}
