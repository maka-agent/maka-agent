import type { UiCatalog, UiLocale } from '@maka/core';
import type { ConnectionUiStatus } from '../connection-status.js';

type StatusPresentation = {
  label: string;
  detail: string;
  tone: 'neutral' | 'info' | 'success' | 'warning' | 'destructive';
};

const CONNECTION_STATUS_COPY_BY_LOCALE = {
  zh: {
    disabled: { label: '已禁用', detail: '不会用于聊天或代理调用，直到在设置里启用。', tone: 'neutral' },
    unsupported_provider: { label: '当前版本不支持', detail: '此模型服务商未在当前版本注册。连接配置和凭据已保留。', tone: 'warning' },
    not_configured: { label: '待补齐', detail: '等待填写模型密钥或选择默认模型。', tone: 'warning' },
    configured: { label: '已配置 · 等待验证', detail: '凭据已保存；点测试连接确认服务可达。', tone: 'info' },
    verified: { label: '凭据已验证', detail: '最近一次凭据测试成功；发送链路需独立验证。', tone: 'success' },
    needs_reauth: { label: '需要重新登录', detail: '上次测试返回 401/403。请更新模型密钥或重新登录。', tone: 'warning' },
    error: { label: '连接出错', detail: '上次测试失败：超时、网络或服务商返回错误。可重试或检查代理。', tone: 'destructive' },
  },
  en: {
    disabled: { label: 'Disabled', detail: 'This connection is not used for chats or agent calls until enabled.', tone: 'neutral' },
    unsupported_provider: { label: 'Unsupported in this version', detail: 'This provider is not registered in the current build. Its configuration and credentials are preserved.', tone: 'warning' },
    not_configured: { label: 'Setup required', detail: 'Add a model key or choose a default model.', tone: 'warning' },
    configured: { label: 'Configured · Awaiting verification', detail: 'Credentials are saved. Test the connection to confirm the service is reachable.', tone: 'info' },
    verified: { label: 'Credentials verified', detail: 'The latest credential test passed. The send path is verified separately.', tone: 'success' },
    needs_reauth: { label: 'Sign in again', detail: 'The latest test returned 401/403. Update the model key or sign in again.', tone: 'warning' },
    error: { label: 'Connection error', detail: 'The latest test failed. Try again or check the network proxy.', tone: 'destructive' },
  },
} satisfies UiCatalog<Record<ConnectionUiStatus, StatusPresentation>>;

export function getConnectionStatusCopy(locale: UiLocale): Record<ConnectionUiStatus, StatusPresentation> {
  return CONNECTION_STATUS_COPY_BY_LOCALE[locale];
}
