import {
  PROVIDER_AUTH_ACTIONS,
  type ProviderAuthAction,
  type ProviderAuthContract,
  type ProviderAuthState,
} from '@maka/core';

export type AccountAuthTone = 'neutral' | 'info' | 'success' | 'warning' | 'destructive';

export interface AccountAuthStatePresentation {
  stateLabel: string;
  label: string;
  detail: string;
  tone: AccountAuthTone;
}

export type AccountAuthActionKind = 'button' | 'guidance' | 'preview';

export interface AccountAuthActionPresentation {
  action: ProviderAuthAction;
  kind: AccountAuthActionKind;
  executable: boolean;
  label: string;
  detail: string;
  tone: AccountAuthTone;
}

const AUTH_STATE_TONE: Record<ProviderAuthState, AccountAuthTone> = {
  disabled: 'neutral',
  not_configured: 'warning',
  configured: 'info',
  validated: 'success',
  needs_reauth: 'warning',
  error: 'destructive',
  preview_only: 'info',
};

const AUTH_STATE_LABEL: Record<ProviderAuthState, string> = {
  disabled: '已关闭',
  not_configured: '待配置',
  configured: '待验证',
  validated: '凭据已验证',
  needs_reauth: '需重新授权',
  error: '测试失败',
  preview_only: '预览',
};

export function presentAccountAuthState(
  contract: ProviderAuthContract,
): AccountAuthStatePresentation {
  return {
    stateLabel: AUTH_STATE_LABEL[contract.state],
    label: contract.copy.label,
    detail: contract.copy.detail,
    tone: AUTH_STATE_TONE[contract.state],
  };
}

export function deriveAccountAuthActions(
  contract: ProviderAuthContract,
): AccountAuthActionPresentation[] {
  const actions: AccountAuthActionPresentation[] = [];
  for (const action of PROVIDER_AUTH_ACTIONS) {
    const availability = contract.actionAvailability[action];
    if (availability === 'hidden') continue;
    if (availability === 'preview_only') {
      actions.push(previewAction(action));
      continue;
    }
    actions.push(availableAction(contract, action));
  }
  return actions;
}

function availableAction(
  contract: ProviderAuthContract,
  action: ProviderAuthAction,
): AccountAuthActionPresentation {
  switch (action) {
    case 'test_credentials':
      if (contract.setupMode === 'none') {
        return {
          action,
          kind: 'button',
          executable: true,
          label: '探测本地服务',
          detail: '检查本地服务和默认模型是否可达；这不是凭据测试。',
          tone: 'info',
        };
      }
      return {
        action,
        kind: 'button',
        executable: true,
        label: '测试凭据',
        detail: '只验证凭据和端点，不代表运行通路已完成健康检查。',
        tone: 'info',
      };
    case 'save_secret':
      return {
        action,
        kind: 'guidance',
        executable: false,
        label: '在模型设置中保存 API key',
        detail: 'Account 只展示状态；密钥输入仍在 设置 · 模型。',
        tone: 'neutral',
      };
    case 'fetch_models':
      return {
        action,
        kind: 'guidance',
        executable: false,
        label: contract.setupMode === 'none' ? '在模型设置中探测模型' : '在模型设置中拉取模型',
        detail: '模型列表刷新由 设置 · 模型 的 provider 编辑器执行。',
        tone: 'neutral',
      };
    case 'revoke_auth':
      return {
        action,
        kind: 'guidance',
        executable: false,
        label: '在模型设置中替换或移除凭据',
        detail: '当前页面不直接写入 credential store。',
        tone: 'neutral',
      };
    case 'start_oauth':
    case 'refresh_oauth':
      return previewAction(action);
  }
}

function previewAction(action: ProviderAuthAction): AccountAuthActionPresentation {
  const labels: Record<ProviderAuthAction, string> = {
    save_secret: 'API key 管理',
    test_credentials: '凭据验证',
    fetch_models: '模型同步',
    start_oauth: '订阅账号预览',
    refresh_oauth: '订阅状态预览',
    revoke_auth: '订阅管理预览',
  };
  return {
    action,
    kind: 'preview',
    executable: false,
    label: labels[action],
    detail: '受控入口当前只展示状态，不会连接 OAuth IPC 或远端登录流程。',
    tone: 'info',
  };
}
