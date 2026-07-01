import type { SessionEvent } from '@maka/core';
import { generalizedErrorMessageChinese } from '@maka/core';

const NO_REAL_CONNECTION_CODE = 'NO_REAL_CONNECTION';
const NO_REAL_CONNECTION_REASON_RE = /NO_REAL_CONNECTION:([a-z_]+): /;

export function isNoRealConnectionError(error: unknown): boolean {
  const raw = error instanceof Error ? error.message : String(error);
  return raw.includes(NO_REAL_CONNECTION_CODE);
}

export function isNoRealConnectionEvent(event: Extract<SessionEvent, { type: 'error' }>): boolean {
  return event.code === NO_REAL_CONNECTION_CODE || event.message.includes(NO_REAL_CONNECTION_CODE);
}

export function noRealConnectionReasonFromError(error: unknown): string | undefined {
  const raw = error instanceof Error ? error.message : String(error);
  return raw.match(NO_REAL_CONNECTION_REASON_RE)?.[1];
}

export function noRealConnectionReasonFromEvent(event: Extract<SessionEvent, { type: 'error' }>): string | undefined {
  return event.reason ?? event.message.match(NO_REAL_CONNECTION_REASON_RE)?.[1];
}

export function noRealConnectionSetupDescription(reason: string | undefined): string {
  switch (reason) {
    case 'missing_default_connection':
      return '等待配置默认模型。请到 设置 · 模型 添加一个可用模型连接后再发送。';
    case 'connection_missing':
      return '该会话依赖的模型连接已删除，请到 设置 · 模型 重新选择或重建连接。';
    case 'connection_disabled':
      return '当前模型连接已禁用。请到 设置 · 模型 启用或选择其他默认模型。';
    case 'missing_api_key':
      return '当前模型连接还没有可用凭据。请到 设置 · 模型 补齐 API key 或重新登录后再发送。';
    case 'missing_model':
      return '当前模型连接还没有可用模型。请到 设置 · 模型 选择默认模型后再发送。';
    case 'empty_model_list':
      return '当前模型连接没有启用模型。请到 设置 · 模型 添加或启用模型后再发送。';
    case 'model_not_enabled':
      return '当前会话选择的模型未启用。请到 设置 · 模型 重新选择可用模型后再发送。';
    case 'model_not_chat_capable':
      return '当前会话选择的模型不能用于聊天。请到 设置 · 模型 重新选择支持聊天的模型后再发送。';
    case 'oauth_subscription_not_wired':
      return '这个订阅账号暂时不能作为聊天模型。请先选择可用的 API key 或已接入 OAuth 模型连接。';
    case 'fake_backend':
      return '当前会话来自旧的本地模拟连接。请到 设置 · 模型 添加真实模型后新建会话。';
    default:
      return '模型连接暂时无法用于发送，请到 设置 · 模型 检查后重试。';
  }
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
      description: '该会话依赖的模型连接已删除，请到 设置 · 模型 重新选择或重建连接。',
    };
  }
  return {
    title: '等待配置真实模型',
    description: fallback,
  };
}
