import { useState } from 'react';
import { PROVIDER_DEFAULTS, generalizedErrorMessageChinese } from '@maka/core';
import {
  Alert,
  AlertAction,
  AlertDescription,
  AlertTitle,
  Button,
  FieldDescription,
  FieldRoot,
  Input,
  Label,
  RelativeTime,
  useMountedRef,
  useToast,
  useUiLocale,
} from '@maka/ui';
import { PasswordInput } from './password-input';
import { providerDisplay } from './provider-display';
import { EnabledModelManager } from './provider-enabled-model-manager';
import { useActionGuard } from './use-action-guard';
import { useOAuthLoginFlow } from './use-oauth-login-flow';
import type { CredentialPresenceStatus } from './provider-panel-shared';
import {
  useConnectionDetail,
  type ConnectionDetailProps,
  type OAuthLoginService,
} from './use-connection-detail';

export function ConnectionDetail(props: ConnectionDetailProps) {
  const defaults = PROVIDER_DEFAULTS[props.connection.providerType];
  // Unknown providerType (a connection persisted on a branch that registers a
  // provider this build doesn't know) → render a non-actionable fallback so
  // opening the orphan connection doesn't crash on `.authKind`/`.baseUrl`.
  // Mirrors `isFakeBackend` in @maka/core/connection-readiness.ts.
  if (!defaults) return <UnknownConnectionDetail props={props} />;
  return <ConnectionDetailInner {...props} />;
}

function UnknownConnectionDetail({ props }: { props: ConnectionDetailProps }) {
  const { connection } = props;
  const toast = useToast();
  const mounted = useMountedRef();
  const [deleting, setDeleting] = useState(false);
  async function remove() {
    if (deleting) return;
    const ok = await toast.confirm({
      title: `删除供应商 ${connection.name || connection.slug}？`,
      description: '删除后，支持该 provider 的其他版本也无法恢复这条连接及其凭据。',
      confirmLabel: '删除',
      cancelLabel: '取消',
      destructive: true,
    });
    if (!mounted.current || !ok) return;
    setDeleting(true);
    try {
      await props.bridge.delete(connection.slug);
      if (!mounted.current) return;
      await props.onDeleted();
    } catch (error) {
      if (!mounted.current) return;
      toast.error('删除模型连接失败', generalizedErrorMessageChinese(error));
    } finally {
      if (mounted.current) setDeleting(false);
    }
  }
  return (
    <div className="providerConnectionDetail">
      <p>
        该连接使用的 provider「{connection.providerType}」在当前版本未注册。配置和凭据会保留，切回支持它的版本即可继续使用。
      </p>
      <Button variant="destructive" type="button" onClick={remove} disabled={deleting}>
        {deleting ? '删除中…' : '不再需要，删除连接'}
      </Button>
    </div>
  );
}

function ConnectionDetailInner(props: ConnectionDetailProps) {
  const locale = useUiLocale();
  const { connection } = props;
  const defaults = PROVIDER_DEFAULTS[connection.providerType];
  const display = providerDisplay(connection.providerType, locale);
  const {
    apiKey,
    setApiKey,
    hasSecret,
    baseUrl,
    setBaseUrl,
    enabledModelIds,
    modelChoices,
    busy,
    testing,
    fetchingModels,
    settingDefault,
    deleting,
    detailActionBusy,
    supportsApiKey,
    needsOAuth,
    usesGitHubCopilotLogin,
    oauthLoginService,
    hasFixedOAuthBaseUrl,
    credentialProbePending,
    hasUsableCredential,
    apiKeyStatusHint,
    hasApiKeyChange,
    hasBaseUrlChange,
    issue,
    lastTestMessage,
    lastTestAtMs,
    save,
    updateEnabledModels,
    runTest,
    refreshModels,
    setAsDefault,
    remove,
    refreshAfterRelogin,
  } = useConnectionDetail(props);

  return (
    <div className="providerEditor providerConnectionManager">
      {supportsApiKey && (
        <div className="providerCredentialTask">
          <FieldRoot className="grid gap-1.5">
            <Label className="text-xs text-foreground-secondary">模型密钥</Label>
            <FieldDescription>{apiKeyStatusHint}</FieldDescription>
            <PasswordInput
              value={apiKey}
              onChange={setApiKey}
              placeholder={hasSecret === true ? '••••••••' : '粘贴模型密钥'}
              ariaLabel={`${display.name} 模型密钥`}
              disabled={detailActionBusy}
            />
          </FieldRoot>
          <div className="providerCredentialActions">
            {defaults.signupUrl && (
              <a className="providerExternalLink" href={defaults.signupUrl} target="_blank" rel="noreferrer noopener">
                获取模型密钥
              </a>
            )}
            {/* Persistent button (disabled until a new key is typed) so the
                credential actions row keeps a fixed height — no jitter when the
                user starts pasting a key. */}
            <Button type="button" disabled={detailActionBusy || !hasApiKeyChange} onClick={save}>
              {busy ? '保存中…' : '更新密钥'}
            </Button>
          </div>
        </div>
      )}
      {issue && (
        <div className="providerConnectionIssue" data-tone={issue.tone} role="status">
          <strong>{issue.label}</strong>
          {(lastTestMessage || Number.isFinite(lastTestAtMs)) && (
            <span>
              {lastTestMessage && lastTestMessage !== issue.label ? lastTestMessage : null}
              {lastTestMessage && lastTestMessage !== issue.label && Number.isFinite(lastTestAtMs) ? ' · ' : null}
              {Number.isFinite(lastTestAtMs) && <RelativeTime ts={lastTestAtMs} />}
            </span>
          )}
        </div>
      )}
      {needsOAuth && (
        usesGitHubCopilotLogin ? (
          <GitHubCopilotReloginNotice hasSecret={hasSecret} onRelogin={refreshAfterRelogin} />
        ) : oauthLoginService ? (
          <OAuthReloginNotice
            service={oauthLoginService}
            hasSecret={hasSecret}
            onRelogin={refreshAfterRelogin}
          />
        ) : (
          <Alert variant="info">
            <AlertTitle>
              {hasSecret === true
                ? 'OAuth 已登录'
                : hasSecret === 'loading'
                  ? 'OAuth 状态读取中'
                  : hasSecret === 'error'
                    ? 'OAuth 状态未知'
                    : '等待 OAuth 登录'}
            </AlertTitle>
            <AlertDescription>
              {hasSecret === true
                ? '该模型连接使用主进程保存的 OAuth access token；若请求提示需要重新登录，请到账号连接重新授权。'
                : hasSecret === 'loading'
                  ? '正在读取本机 OAuth 登录状态，读取完成前不会把未知状态显示成未登录。'
                  : hasSecret === 'error'
                    ? '暂时无法读取本机 OAuth 登录状态；请刷新页面或重新打开设置。'
                    : '请到账号连接完成登录；登录成功后会自动出现在模型连接里。'}
            </AlertDescription>
          </Alert>
        )
      )}
      {credentialProbePending && (
        <p className="providerError" role="alert">
          {hasSecret === 'loading'
            ? '正在读取模型凭据状态，读取完成前暂不测试连接或刷新模型。'
            : '模型凭据状态暂时没刷新成功，已避免把未知状态显示成未登录或未配置。'}
        </p>
      )}
      <details className="providerAdvancedSettings">
        <summary>高级设置</summary>
        <div className="providerAdvancedSettingsBody">
          <EnabledModelManager
            modelChoices={modelChoices}
            enabledModelIds={enabledModelIds}
            defaultModel={connection.defaultModel}
            disabled={detailActionBusy}
            onChange={(next) => void updateEnabledModels(next)}
          />
          <div className="providerEndpointSettings">
            <ConnectionEndpointField
              baseUrl={baseUrl}
              defaultsBaseUrl={defaults.baseUrl}
              fixedOAuth={hasFixedOAuthBaseUrl}
              disabled={detailActionBusy}
              onChange={setBaseUrl}
            />
            {/* Persistent button (disabled until the endpoint is edited) so the
                advanced settings body height stays constant while typing. An
                OAuth-fixed endpoint is readOnly with no dirty path — no jitter
                risk — so it renders no permanently-disabled Save at all. */}
            {!hasFixedOAuthBaseUrl && (
              <div className="providerEndpointActions">
                <Button type="button" disabled={detailActionBusy || !hasBaseUrlChange} onClick={save}>
                  {busy ? '保存中…' : '保存服务地址'}
                </Button>
              </div>
            )}
          </div>
          <div className="providerAdvancedActions">
            <Button variant="secondary" type="button" disabled={detailActionBusy || !hasUsableCredential} onClick={runTest}>
              {testing ? '测试中…' : '测试连接'}
            </Button>
            <Button variant="quiet" type="button" disabled={detailActionBusy || !hasUsableCredential} onClick={() => void refreshModels()}>
              {fetchingModels ? '更新中…' : '更新模型目录'}
            </Button>
            {!props.isDefault && connection.enabled && (
              <Button variant="quiet" type="button" disabled={detailActionBusy} onClick={setAsDefault}>
                {settingDefault ? '设置中…' : '设为默认连接'}
              </Button>
            )}
            <Button className="providerAdvancedDanger" variant="quiet" type="button" disabled={detailActionBusy} onClick={remove}>
              {deleting ? '删除中…' : '删除连接'}
            </Button>
          </div>
        </div>
      </details>
    </div>
  );
}

function ConnectionEndpointField(props: {
  baseUrl: string;
  defaultsBaseUrl: string | undefined;
  fixedOAuth: boolean;
  disabled: boolean;
  onChange(value: string): void;
}) {
  return (
    <FieldRoot className="grid gap-1.5">
      <Label className="text-xs text-foreground-secondary">服务地址</Label>
      {props.fixedOAuth && <FieldDescription>OAuth 固定</FieldDescription>}
      <Input
        value={props.baseUrl}
        onChange={(event) => props.onChange(event.currentTarget.value)}
        placeholder={props.defaultsBaseUrl}
        readOnly={props.fixedOAuth}
        disabled={props.disabled}
        aria-readonly={props.fixedOAuth ? 'true' : undefined}
        aria-label={props.fixedOAuth ? '模型连接服务地址，OAuth 固定' : '模型连接服务地址'}
      />
    </FieldRoot>
  );
}

function GitHubCopilotReloginNotice(props: {
  hasSecret: CredentialPresenceStatus;
  onRelogin(): Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const connectGuard = useActionGuard<'connect'>();
  const mountedRef = useMountedRef();
  const toast = useToast();
  const loggedIn = props.hasSecret === true;
  const loading = props.hasSecret === 'loading';

  async function connect() {
    if (!connectGuard.begin('connect')) return;
    setBusy(true);
    try {
      const result = await window.maka.githubCopilotSubscription.connectExistingLogin();
      if (!result.ok) {
        toast.error('导入 GitHub Copilot 登录失败', result.message);
        return;
      }
      await props.onRelogin();
    } catch (error) {
      if (mountedRef.current) toast.error('导入 GitHub Copilot 登录失败', generalizedErrorMessageChinese(error));
    } finally {
      connectGuard.finish();
      if (mountedRef.current) setBusy(false);
    }
  }

  return (
    <Alert variant="info">
      <AlertTitle>{loggedIn ? 'GitHub Copilot 已登录' : loading ? 'OAuth 状态读取中' : '等待兼容 GitHub 凭据'}</AlertTitle>
      <AlertDescription>{loggedIn ? '若账号或组织策略变化，可重新导入兼容凭据。' : '配置具有 Copilot Requests 权限的凭据后从本机安全导入。'}</AlertDescription>
      {!loading && (
        <AlertAction>
          <Button type="button" size="sm" disabled={busy} onClick={() => void connect()}>
            {busy ? '导入中…' : loggedIn ? '重新导入' : '导入兼容凭据'}
          </Button>
        </AlertAction>
      )}
    </Alert>
  );
}

// The OAuth notice for a re-loginable connection. The 重新登录 button drives
// the SAME shared browser-loopback flow the OAuth catalog cards use, so an
// expired connection can be re-authorized right where the problem surfaces.
// The button shows in every credential state except 'loading' — an EXPIRED
// token still reads hasSecret===true, so it must not hide behind
// hasSecret===false.
function OAuthReloginNotice(props: {
  service: OAuthLoginService;
  hasSecret: CredentialPresenceStatus;
  onRelogin(): Promise<void>;
}) {
  const flow = useOAuthLoginFlow({
    bridge: props.service.bridge,
    display: props.service.display,
    onLoginSuccess: props.onRelogin,
  });
  const { hasSecret } = props;
  const loggedIn = hasSecret === true;
  const loading = hasSecret === 'loading';
  const errored = hasSecret === 'error';
  const title = loggedIn
    ? 'OAuth 已登录'
    : loading
      ? 'OAuth 状态读取中'
      : errored
        ? 'OAuth 状态未知'
        : '等待 OAuth 登录';
  const detail = loggedIn
    ? '若请求提示需要重新登录，点这里重新走一遍授权。'
    : loading
      ? '正在读取本机 OAuth 登录状态，读取完成前不会把未知状态显示成未登录。'
      : errored
        ? '暂时无法读取本机 OAuth 登录状态；请刷新页面或重新打开设置。'
        : '点下方按钮打开浏览器完成登录，授权成功后会自动刷新这里的状态。';
  return (
    <Alert variant="info">
      <AlertTitle>{title}</AlertTitle>
      <AlertDescription>{detail}</AlertDescription>
      {!loading && (
        <AlertAction>
          <Button
            type="button"
            size="sm"
            disabled={flow.actionBusy}
            onClick={() => void flow.startLogin()}
          >
            {flow.pendingAction === 'login' ? '登录中…' : loggedIn ? '重新登录' : '登录'}
          </Button>
        </AlertAction>
      )}
    </Alert>
  );
}
