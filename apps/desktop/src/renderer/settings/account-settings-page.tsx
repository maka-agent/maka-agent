import { useEffect, useRef, useState } from 'react';
import type { ConnectionTestResult, LlmConnection } from '@maka/core';
import { deriveProviderAuthContractFromConnection, generalizedErrorMessageChinese } from '@maka/core';
import { PROVIDER_DEFAULTS, providerAuthRequiresSecret } from '@maka/core/llm-connections';
import { Button, Chip, RelativeTime, useMountedRef, useToast } from '@maka/ui';
import {
  deriveAccountAuthActions,
  presentAccountAuthState,
  type AccountAuthActionPresentation,
} from './account-auth-ui';
import {
  connectionUiStatusFromRecord,
  presentConnectionUiStatus,
  type ConnectionUiStatus,
} from '../connection-status';
import { SettingsRows, SettingRow } from './settings-rows';
import { settingsActionErrorMessage } from './settings-error-copy';

type AccountSecretProbeStatus = boolean | 'loading' | 'error';
type AccountSecretProbeResult =
  | { slug: string; status: boolean }
  | { slug: string; status: 'error'; message: string };

function accountConnectionTestFailureMessage(result: ConnectionTestResult): string {
  const fallback = accountConnectionTestFailureFallback(result);
  if (!result.errorMessage) return fallback;
  return generalizedErrorMessageChinese(new Error(result.errorMessage), fallback);
}

function accountConnectionTestFailureFallback(result: ConnectionTestResult): string {
  if (result.statusCode === 429) return '当前账号或模型服务触发速率限制，请稍后重试。';
  if (result.errorClass === 'timeout') return '请求超时，请检查网络或代理后重试。';
  if (result.errorClass === 'auth' || result.statusCode === 401 || result.statusCode === 403) {
    return '鉴权失败，请检查模型密钥、订阅账号登录或凭据配置后重试。';
  }
  if (result.errorClass === 'provider_unavailable' || (result.statusCode !== undefined && result.statusCode >= 500)) {
    return '模型服务暂时不可用，请稍后重试。';
  }
  if (result.errorClass === 'network') return '网络错误，请检查服务地址或代理设置后重试。';
  return '连接测试失败，请检查模型连接配置后重试。';
}

function accountLastTestMessageDisplay(message: string | undefined): string | undefined {
  if (!message) return undefined;
  const trimmed = message.trim();
  if (!trimmed) return undefined;
  if (/[\u4e00-\u9fa5]/.test(trimmed)) return trimmed;
  const normalized = trimmed.toLowerCase();
  if (normalized === 'connection verified') return '连接已验证';
  if (normalized === 'authentication failed') return '鉴权失败';
  if (normalized === 'request timed out') return '请求超时';
  if (normalized === 'network error') return '网络错误';
  if (normalized === 'provider returned an error') return '模型服务返回错误';
  if (normalized === 'connection test failed') return '连接测试失败';
  const classified = generalizedErrorMessageChinese(new Error(trimmed), '');
  return classified || '连接测试状态暂时无法显示，请重新测试。';
}

export function AccountSettingsPage(props: {
  connections: LlmConnection[];
  defaultSlug: string | null;
  onRefresh(): Promise<void>;
}) {
  // Backend (xuan, 5ca1f8a) persists per-connection lastTestStatus. UI
  // derives the display status from `enabled + hasSecret + defaultModel +
  // lastTestStatus + authKind` per @kenji's status-contract priority list,
  // so we never produce mixed labels like "disabled + verified".
  const [secretMap, setSecretMap] = useState<Record<string, AccountSecretProbeStatus>>({});
  const [secretProbeError, setSecretProbeError] = useState<string | null>(null);
  const [testingSlug, setTestingSlug] = useState<string | null>(null);
  const testingSlugRef = useRef<string | null>(null);
  const accountPageMountedRef = useMountedRef();
  const toast = useToast();

  useEffect(() => {
    return () => {
      testingSlugRef.current = null;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    void Promise.all<AccountSecretProbeResult>(
      props.connections.map(async (connection) => {
        try {
          const has = await window.maka.connections.hasSecret(connection.slug);
          return { slug: connection.slug, status: has };
        } catch (error) {
          return { slug: connection.slug, status: 'error', message: settingsActionErrorMessage(error) };
        }
      }),
    ).then((entries) => {
      if (cancelled) return;
      setSecretMap(Object.fromEntries(entries.map((entry) => [entry.slug, entry.status])));
      const failure = entries.find(
        (entry): entry is Extract<AccountSecretProbeResult, { status: 'error' }> => entry.status === 'error',
      );
      if (failure) {
        setSecretProbeError(failure.message);
        toast.error('读取模型凭据状态失败', failure.message);
      } else {
        setSecretProbeError(null);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [props.connections]);

  async function testConnection(slug: string) {
    if (testingSlugRef.current !== null) return;
    testingSlugRef.current = slug;
    setTestingSlug(slug);
    try {
      const result = await window.maka.connections.test(slug);
      if (!accountPageMountedRef.current || testingSlugRef.current !== slug) return;
      if (result.ok) {
        toast.success('连接已验证', `延迟 ${result.latencyMs ?? '?'} ms${result.modelTested ? ' · ' + result.modelTested : ''}`);
      } else {
        toast.error('连接测试失败', accountConnectionTestFailureMessage(result));
      }
    } catch (error) {
      // Main is supposed to return a structured result; if something escapes
      // to throw form, surface the generalized message anyway.
      if (accountPageMountedRef.current && testingSlugRef.current === slug) {
        toast.error('测试出错', settingsActionErrorMessage(error));
      }
    } finally {
      // Pull the freshest lastTestStatus/lastTestAt/lastTestMessage so the
      // row re-renders with the new derived status without a Settings reopen.
      if (accountPageMountedRef.current && testingSlugRef.current === slug) {
        try {
          await props.onRefresh();
        } catch (error) {
          if (accountPageMountedRef.current && testingSlugRef.current === slug) {
            toast.error('刷新模型连接状态失败', settingsActionErrorMessage(error));
          }
        } finally {
          testingSlugRef.current = null;
          if (accountPageMountedRef.current) {
            setTestingSlug(null);
          }
        }
      } else if (testingSlugRef.current === slug) {
        testingSlugRef.current = null;
      }
    }
  }

  const enabledCount = props.connections.filter((connection) => connection.enabled).length;
  const totalCount = props.connections.length;
  return (
    <div className="settingsStructuredPage">
      <SettingsRows>
        <SettingRow
          title="默认权限模式"
          detail="新会话默认从询问权限开始；可在输入框左下角切到自动执行或跳过确认。"
          value="询问权限"
        />
        <SettingRow
          title="凭据保护"
          detail="模型密钥保存在本机凭据文件内；订阅账号令牌交给系统安全存储。"
          value="启用"
        />
        <SettingRow
          title="审计日志"
          detail="每个会话都会在本机保留消息、工具调用、权限决策与模式变更记录。"
          value="本地"
        />
      </SettingsRows>

      <h3 className="settingsSubheading">模型连接</h3>
      {secretProbeError && (
        <div className="settingsNotice" role="alert">
          模型凭据状态暂时没刷新成功，已避免把未知状态显示成待配置。{secretProbeError}
        </div>
      )}
      {totalCount === 0 ? (
        <div className="settingsEmptyState">等待添加模型连接。可在 设置 · 模型 添加。</div>
      ) : (
        /* PR-CONNECTION-LIST-A11Y-0 (round 17/30): same fix as
           rounds 7 and 16. Was `<div role="list">` containing
           `<div role="listitem">` rows — invalid ARIA layering.
           Semantic `<ul>` / `<li>` so screen readers get the
           relationship from the elements themselves. */
        <ul className="settingsConnectionList" aria-label="模型连接列表">
          {props.connections.map((connection) => (
            <li key={connection.slug}>
              <AccountConnectionRow
                connection={connection}
                secretStatus={secretMap[connection.slug] ?? 'loading'}
                isDefault={connection.slug === props.defaultSlug}
                testing={testingSlug === connection.slug}
                canTest={testingSlug === null}
                onTest={() => void testConnection(connection.slug)}
              />
            </li>
          ))}
        </ul>
      )}
      <p className="settingsHelpText">
        共 {totalCount} 个连接 · {enabledCount} 已启用。修改模型密钥、服务地址或默认模型会清掉「已验证」状态，
        需要重新测试。失败的测试不会自动禁用连接 —— 禁用始终是用户动作。
      </p>

      {/*
        PR-CLAUDE-CARD-MOVE-0 (WAWQAQ msg ddecd729): the Claude
        subscription card was previously rendered here. It now
        lives in 设置 → 模型 (`provider-oauth-section.tsx → ModelOAuthSection`)
        alongside the other OAuth-bound providers (Codex / Cursor
        / Antigravity), because OAuth is a model-side concern and
        the 账户 panel should only carry identity / security state.
      */}
    </div>
  );
}

function AccountConnectionRow(props: {
  connection: LlmConnection;
  secretStatus: AccountSecretProbeStatus;
  isDefault: boolean;
  testing: boolean;
  canTest: boolean;
  onTest(): void;
}) {
  const requiresSecret = providerAuthRequiresSecret(props.connection.providerType);
  const secretProbePending = requiresSecret && (props.secretStatus === 'loading' || props.secretStatus === 'error');
  const hasSecretForKnownStatus = props.secretStatus === true;
  const status: ConnectionUiStatus = connectionUiStatusFromRecord(
    props.connection,
    secretProbePending ? true : hasSecretForKnownStatus,
  );
  const presentation = secretProbePending
    ? {
        label: props.secretStatus === 'loading' ? '读取凭据状态…' : '凭据状态未知',
        detail: props.secretStatus === 'loading'
          ? '正在读取本机凭据状态；不会把读取中显示成待配置。'
          : '暂时无法读取本机凭据状态；请刷新或到模型设置查看。',
        tone: props.secretStatus === 'loading' ? 'info' as const : 'warning' as const,
      }
    : presentConnectionUiStatus(status);
  const authContract = secretProbePending
    ? undefined
    : deriveProviderAuthContractFromConnection(props.connection, hasSecretForKnownStatus);
  const authPresentation = authContract
    ? presentAccountAuthState(authContract)
    : {
        label: '凭据状态读取中',
        detail: props.secretStatus === 'loading'
          ? '正在读取本机凭据和账号登录状态。'
          : '读取本机凭据和账号登录状态失败，当前不会显示为待配置。',
        stateLabel: props.secretStatus === 'loading' ? '读取中' : '读取失败',
        tone: props.secretStatus === 'loading' ? 'info' as const : 'warning' as const,
      };
  const authActions = authContract ? deriveAccountAuthActions(authContract) : [];
  const authContractState = authContract?.state ?? (props.secretStatus === 'loading' ? 'loading' : 'error');
  const subtitle = `${props.connection.providerType} · ${props.connection.defaultModel || '未设默认模型'}`;
  const lastTestAtMs = props.connection.lastTestAt
    ? Date.parse(props.connection.lastTestAt)
    : NaN;
  const lastTestMessage = accountLastTestMessageDisplay(props.connection.lastTestMessage);
  return (
    <div
      className="settingsConnectionRow"
      data-status={status}
      data-default={props.isDefault ? 'true' : undefined}
    >
      <div className="settingsConnectionRowHead">
        <div className="settingsConnectionRowText">
          <div className="settingsConnectionRowName">
            <strong>{props.connection.name}</strong>
            {props.isDefault && (
              <span className="settingsConnectionDefaultBadge" aria-label="默认连接">默认</span>
            )}
          </div>
          <small>{subtitle}</small>
        </div>
        <Chip variant={presentation.tone}>
          {presentation.label}
        </Chip>
      </div>
      <p className="settingsConnectionDetail">{presentation.detail}</p>
      <div className="settingsAuthContract" data-state={authContractState}>
        <div className="settingsAuthContractText">
          <strong>{authPresentation.label}</strong>
          <span>{authPresentation.detail}</span>
        </div>
        <span className="settingsAuthContractBadge" data-tone={authPresentation.tone}>
          {authPresentation.stateLabel}
        </span>
      </div>
      {(Number.isFinite(lastTestAtMs) || lastTestMessage) && (
        <p className="settingsConnectionMeta">
          {lastTestMessage && <span>{lastTestMessage}</span>}
          {Number.isFinite(lastTestAtMs) && (
            <RelativeTime ts={lastTestAtMs} className="settingsConnectionMetaTime" />
          )}
        </p>
      )}
      {authActions.length > 0 && (
        <div className="settingsConnectionActions" role="group" aria-label={`${props.connection.name} 账号操作`}>
          {authActions.map((action) => (
            <AccountAuthActionView
              key={action.action}
              action={action}
              disabled={!props.canTest}
              testing={action.action === 'test_credentials' && props.testing}
              onTest={props.onTest}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function AccountAuthActionView(props: {
  action: AccountAuthActionPresentation;
  disabled: boolean;
  testing: boolean;
  onTest(): void;
}) {
  if (props.action.executable && props.action.action === 'test_credentials') {
    return (
      <Button
        type="button"
        data-size="sm"
        size="sm"
        disabled={props.disabled}
        onClick={props.onTest}
        title={props.action.detail}
      >
        {props.testing ? '测试中…' : props.action.label}
      </Button>
    );
  }
  // Non-interactive guidance label sitting next to the real 测试凭据 button.
  // Migrated onto the squared Chip primitive (tone→alpha authority); the
  // AccountAuthTone union (neutral/info/success/warning/destructive) maps 1:1
  // to Chip variants. The preview-kind dashed-border affordance stays in CSS.
  return (
    <Chip
      variant={props.action.tone}
      className="settingsAuthActionPill"
      data-kind={props.action.kind}
      data-tone={props.action.tone}
      title={props.action.detail}
    >
      {props.action.label}
    </Chip>
  );
}
