import type { ConnectionTestResult, PermissionMode, TextFileImportPreflightFailureReason } from '@maka/core';
import { generalizedErrorMessageChinese } from '@maka/core';
import { openPathActionLabel } from './open-path.js';

const SESSION_READ_MESSAGES_ERROR_MARKER = 'MAKA_SESSION_READ_MESSAGES_ERROR:';

export function basenameFromPath(value: string): string {
  const trimmed = value.replace(/[\\/]+$/, '');
  const name = trimmed.split(/[\\/]/).filter(Boolean).pop();
  return name || trimmed || '当前项目';
}

export function messageReadErrorMessage(error: unknown): string {
  return sessionMessageErrorMessage(error, '对话内容暂时无法读取，请稍后重试。');
}

export function messageRefreshErrorMessage(error: unknown): string {
  return sessionMessageErrorMessage(error, '对话内容暂时无法刷新，请稍后重试。');
}

function sessionMessageErrorMessage(error: unknown, fallback: string): string {
  const raw = error instanceof Error ? error.message : String(error);
  const markerIndex = raw.indexOf(SESSION_READ_MESSAGES_ERROR_MARKER);
  if (markerIndex < 0) return generalizedErrorMessageChinese(error, fallback);
  const marked = raw.slice(markerIndex + SESSION_READ_MESSAGES_ERROR_MARKER.length).trim();
  return marked.split(/\r?\n/, 1)[0]?.trim() || fallback;
}

export function commandPaletteActionErrorMessage(error: unknown, fallback: string): string {
  return generalizedErrorMessageChinese(error, fallback);
}

export function openPathActionErrorMessage(error: unknown, key: 'workspace' | 'project' | 'skills'): string {
  return generalizedErrorMessageChinese(error, `无法打开${openPathActionLabel(key)}，请稍后重试。`);
}

export function selectProjectDirectoryFailureCopy(reason: 'missing-selection'): string {
  if (reason === 'missing-selection') return '没有读取到选中的目录，请重新选择。';
  return '工作目录暂时无法切换，请稍后重试。';
}

export function commandPaletteConnectionTestFailureMessage(result: ConnectionTestResult): string {
  const fallback = commandPaletteConnectionTestFailureFallback(result);
  if (!result.errorMessage) return fallback;
  return generalizedErrorMessageChinese(new Error(result.errorMessage), fallback);
}

function commandPaletteConnectionTestFailureFallback(result: ConnectionTestResult): string {
  if (result.statusCode === 429) return '当前账号或模型服务触发速率限制，请稍后重试。';
  if (result.errorClass === 'timeout') return '请求超时，请检查网络或代理后重试。';
  if (result.errorClass === 'auth' || result.statusCode === 401 || result.statusCode === 403) {
    return '鉴权失败，请检查模型密钥、订阅账号登录或凭据配置后重试。';
  }
  if (result.errorClass === 'network') return '网络错误，请检查网络或代理后重试。';
  if (result.errorClass === 'provider_unavailable' || (result.statusCode && result.statusCode >= 500)) {
    return '模型服务返回错误，请稍后重试。';
  }
  return '连接测试失败，请稍后重试。';
}

export function createSkillFailureCopy(reason: 'blocked_path' | 'already_exists' | 'write_failed'): string {
  if (reason === 'blocked_path') return 'skills 目录不是普通工作区目录，已阻止写入。';
  if (reason === 'already_exists') return '示例技能编号已占满，请先整理 skills 目录。';
  return '写入 skills 目录失败，请检查工作区权限。';
}

export function openSkillFailureCopy(
  reason: 'invalid_id' | 'missing' | 'blocked_path' | 'not_file' | 'not_directory' | 'open_failed',
): string {
  if (reason === 'invalid_id') return 'Skill 名称不在允许范围内。';
  if (reason === 'missing') return '没有找到对应的 SKILL.md。';
  if (reason === 'blocked_path') return 'Skill 路径不在工作区 skills 目录内，已阻止打开。';
  if (reason === 'not_file') return '目标不是一个可打开的 SKILL.md 文件。';
  if (reason === 'not_directory') return '目标不是一个可打开的目录。';
  return '系统打开文件失败。';
}

export const permissionModeDescriptions: Record<PermissionMode, string> = {
  explore: '只读工具直通，写入或网络仍需确认。',
  ask: '所有敏感工具调用前都会停下来征求允许或拒绝。',
  execute: '常见工具直通；破坏性操作、特权操作和浏览器操作仍然确认。',
  bypass: '跳过全部工具确认，包括破坏性操作、特权操作和浏览器操作。',
};
