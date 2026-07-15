import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { Button as BaseButton } from '@base-ui/react/button';
import {
  canPickDefaultModel,
  canSaveDefaultModelChange,
  nextRadioId,
  selectableDefaultModelIds,
  tabbableRadioId,
} from './model-table-keyboard';
import {
  PROVIDER_DEFAULTS,
  generalizedErrorMessageChinese,
  type ConnectionTestResult,
  type LlmConnection,
  type ModelCatalogEntry,
  type ModelInfo,
  type ProviderType,
} from '@maka/core';
import { providerAuthRequiresSecret, providerAuthSupportsApiKey } from '@maka/core/llm-connections';
import { formatRelativeTimestamp } from '@maka/core';
import { Button, Chip, FieldDescription, FieldRoot, Input, Label, useMountedRef, useToast } from '@maka/ui';
import { PasswordInput } from './password-input';
import { buildCatalogModelChoices } from '../model-catalog-choices';
import { providerDisplay } from './provider-display';
import { useOAuthLoginFlow, type OAuthLoginFlowBridge } from './use-oauth-login-flow';
import {
  categoryLabel,
  providerPanelActionErrorMessage,
  type ConnectionsBridge,
  type CredentialPresenceStatus,
} from './provider-panel-shared';

// Maps an OAuth model-connection provider type to the browser-loopback login
// service that can re-run its authorization from inside the detail sheet. Only
// the loopback / polling services (Codex, Antigravity) are one-button-drivable
// here; Claude's paste-code flow and plain API-key providers return null so the
// notice falls back to prose instead of rendering a dead button.
interface OAuthLoginService {
  bridge: OAuthLoginFlowBridge;
  display: { name: string; shortName: string };
}

function oauthLoginServiceFor(providerType: ProviderType): OAuthLoginService | null {
  switch (providerType) {
    case 'openai-codex':
      return {
        bridge: window.maka.openAiCodex as unknown as OAuthLoginFlowBridge,
        display: { name: 'OpenAI Codex', shortName: 'Codex' },
      };
    case 'gemini-cli':
      return {
        bridge: window.maka.antigravitySubscription as unknown as OAuthLoginFlowBridge,
        display: { name: 'Google Antigravity', shortName: 'Antigravity' },
      };
    default:
      return null;
  }
}

function formatFetchedAtSuffix(modelsFetchedAt: number | undefined): string {
  if (modelsFetchedAt === undefined) return '';
  return `（${formatRelativeTimestamp(modelsFetchedAt)}拉取）`;
}

function connectionTestFailureMessage(result: ConnectionTestResult, troubleshootingCopy: string): string {
  const fallback = connectionTestFailureFallback(result, troubleshootingCopy);
  if (!result.errorMessage) return fallback;
  return generalizedErrorMessageChinese(new Error(result.errorMessage), fallback);
}

function connectionTestFailureFallback(result: ConnectionTestResult, troubleshootingCopy: string): string {
  if (result.statusCode === 429) return '当前账号或模型服务触发速率限制，请稍后重试。';
  if (result.errorClass === 'timeout') return '请求超时，请检查网络或代理后重试。';
  if (result.errorClass === 'auth' || result.statusCode === 401 || result.statusCode === 403) {
    return `鉴权失败，请确认 ${troubleshootingCopy} 后重试。`;
  }
  if (result.errorClass === 'provider_unavailable' || (result.statusCode !== undefined && result.statusCode >= 500)) {
    return '模型服务暂时不可用，请稍后重试。';
  }
  if (result.errorClass === 'network') return '网络错误，请检查服务地址或代理设置后重试。';
  return `检查 ${troubleshootingCopy} 后重试。`;
}

interface ConnectionDetailProps {
  bridge: ConnectionsBridge;
  connection: LlmConnection;
  isDefault: boolean;
  onChanged(): Promise<void>;
  onDeleted(): Promise<void>;
}

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
  const { connection } = props;
  const defaults = PROVIDER_DEFAULTS[connection.providerType];
  const display = providerDisplay(connection.providerType);
  const [apiKey, setApiKey] = useState('');
  const [hasSecret, setHasSecret] = useState<CredentialPresenceStatus>(
    defaults.authKind === 'none' ? true : 'loading',
  );
  const [baseUrl, setBaseUrl] = useState(connection.baseUrl ?? defaults.baseUrl ?? '');
  const [defaultModel, setDefaultModel] = useState(connection.defaultModel);
  const [models, setModels] = useState<ModelInfo[]>(connection.models ?? []);
  // Backend persists the model-list source alongside the model cache, so a
  // Settings restart no longer has to infer "fetched" from a non-empty array.
  // A successful provider response may legitimately contain 0 models; source
  // and length remain separate facts.
  const [modelSource, setModelSource] = useState<'fetched' | 'fallback'>(
    connection.modelSource ?? 'fallback',
  );
  const syncedConnectionSnapshotRef = useRef(connectionDetailSnapshot(connection, defaults.baseUrl));
  const [busy, setBusy] = useState(false);
  const [testing, setTesting] = useState(false);
  const [fetchingModels, setFetchingModels] = useState(false);
  const [settingDefault, setSettingDefault] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const busyRef = useRef(false);
  const testingRef = useRef(false);
  const fetchingModelsRef = useRef(false);
  const settingDefaultRef = useRef(false);
  const deletingRef = useRef(false);
  const connectionDetailMountedRef = useMountedRef();
  const connectionDetailLifecycleRef = useRef(0);
  const toast = useToast();
  const supportsApiKey = providerAuthSupportsApiKey(connection.providerType);
  const needsOAuth = defaults.authKind === 'oauth_token';
  const oauthLoginService = needsOAuth ? oauthLoginServiceFor(connection.providerType) : null;
  const usesGitHubCopilotLogin = connection.providerType === 'github-copilot';
  const hasFixedOAuthBaseUrl = needsOAuth && Boolean(defaults.baseUrl);
  const requiresCredential = providerAuthRequiresSecret(connection.providerType);
  const probesCredential = supportsApiKey || needsOAuth;
  const credentialProbePending = requiresCredential && (hasSecret === 'loading' || hasSecret === 'error');
  const hasUsableCredential = !requiresCredential || hasSecret === true;
  const credentialTroubleshootingCopy = needsOAuth
    ? 'OAuth 登录 / 代理设置'
    : '模型密钥 / 服务地址 / 代理设置';
  const savedBaseUrl = connection.baseUrl ?? defaults.baseUrl;
  const draftBaseUrl = baseUrl;
  const hasSaveChanges =
    apiKey.length > 0 ||
    draftBaseUrl !== savedBaseUrl ||
    defaultModel !== connection.defaultModel;
  const detailActionBusy = busy || testing || fetchingModels || settingDefault || deleting;

  useEffect(() => {
    connectionDetailLifecycleRef.current += 1;
    return () => {
      connectionDetailLifecycleRef.current += 1;
      busyRef.current = false;
      testingRef.current = false;
      fetchingModelsRef.current = false;
      settingDefaultRef.current = false;
      deletingRef.current = false;
    };
  }, [connection.slug]);

  function isConnectionDetailCurrent(lifecycle: number): boolean {
    return connectionDetailMountedRef.current && connectionDetailLifecycleRef.current === lifecycle;
  }

  useEffect(() => {
    const lifecycle = connectionDetailLifecycleRef.current;
    if (!probesCredential) {
      if (isConnectionDetailCurrent(lifecycle)) setHasSecret(true);
      return;
    }
    setHasSecret('loading');
    void props.bridge
      .hasSecret(connection.slug)
      .then((next) => {
        if (isConnectionDetailCurrent(lifecycle)) setHasSecret(next);
      })
      .catch((error) => {
        if (!isConnectionDetailCurrent(lifecycle)) return;
        setHasSecret('error');
        toast.error('读取模型凭据状态失败', providerPanelActionErrorMessage(error));
      });
  }, [props.bridge, connection.slug, probesCredential, toast]);

  useEffect(() => {
    const nextSnapshot = connectionDetailSnapshot(connection, defaults.baseUrl);
    const previousSnapshot = syncedConnectionSnapshotRef.current;
    const localStillSynced = connectionDetailDraftMatchesSnapshot(
      { baseUrl, defaultModel, models, modelSource },
      previousSnapshot,
    );
    const localAlreadyMatchesNext = connectionDetailDraftMatchesSnapshot(
      { baseUrl, defaultModel, models, modelSource },
      nextSnapshot,
    );

    if (connection.slug !== previousSnapshot.slug || (apiKey.length === 0 && localStillSynced)) {
      setBaseUrl(nextSnapshot.baseUrl);
      setDefaultModel(nextSnapshot.defaultModel);
      setModels(nextSnapshot.models);
      setModelSource(nextSnapshot.modelSource);
      syncedConnectionSnapshotRef.current = nextSnapshot;
      return;
    }

    if (localAlreadyMatchesNext) {
      syncedConnectionSnapshotRef.current = nextSnapshot;
    }
  }, [
    apiKey.length,
    baseUrl,
    connection,
    defaultModel,
    defaults.baseUrl,
    modelSource,
    models,
  ]);

  // Picker entries come from the same catalog merge path as Chat and Daily
  // Review, but use the local unsaved editor draft for model/default changes.
  const modelChoices = buildCatalogModelChoices({
    slug: connection.slug,
    providerType: connection.providerType,
    defaultModel,
    models: modelSource === 'fetched' || models.length > 0 ? models : undefined,
    modelSource,
    modelsFetchedAt: connection.modelsFetchedAt,
  });
  const catalogFallbackCount = modelChoices.filter((choice) => choice.source === 'static_catalog').length;

  async function save() {
    if (busyRef.current || testingRef.current || fetchingModelsRef.current || settingDefaultRef.current || deletingRef.current) return;
    if (!canSaveDefaultModelChange(connection.defaultModel, defaultModel, modelChoices)) {
      toast.error(
        '默认模型不可用',
        '请选择一个当前可用于聊天的模型后再保存。',
      );
      return;
    }
    const lifecycle = connectionDetailLifecycleRef.current;
    busyRef.current = true;
    setBusy(true);
    let saved = false;
    try {
      await props.bridge.update(connection.slug, {
        baseUrl: baseUrl || undefined,
        defaultModel,
        ...(apiKey ? { apiKey } : {}),
      });
      saved = true;
      if (!isConnectionDetailCurrent(lifecycle)) return;
      const wroteNewKey = apiKey.length > 0;
      setApiKey('');
      const nextHasSecret = probesCredential ? await props.bridge.hasSecret(connection.slug) : true;
      if (!isConnectionDetailCurrent(lifecycle)) return;
      setHasSecret(nextHasSecret);
      await props.onChanged();
      if (!isConnectionDetailCurrent(lifecycle)) return;
      // Auto-fetch live model list as soon as the secret is in place. Without
      // this, the user lands on a Settings · 模型 row whose `defaultModel`
      // dropdown only contains the static fallback list (e.g. Z.ai → just
      // glm-4.7 / 4.6 / 4.5), which looks like Maka doesn't support newer
      // models. Auto-fetch on save closes that gap.
      if ((!requiresCredential || nextHasSecret) && (wroteNewKey || models.length === 0)) {
        void refreshModels({ silent: true });
      }
    } catch (error) {
      if (!isConnectionDetailCurrent(lifecycle)) return;
      if (saved && probesCredential) {
        setHasSecret('error');
      }
      toast.error(
        saved ? '刷新模型连接失败' : '保存模型连接失败',
        providerPanelActionErrorMessage(error),
      );
    } finally {
      busyRef.current = false;
      if (isConnectionDetailCurrent(lifecycle)) setBusy(false);
    }
  }

  async function runTest() {
    if (testingRef.current || busyRef.current || fetchingModelsRef.current || settingDefaultRef.current || deletingRef.current) return;
    const lifecycle = connectionDetailLifecycleRef.current;
    testingRef.current = true;
    setTesting(true);
    try {
      const result: ConnectionTestResult = await props.bridge.test(connection.slug, { model: defaultModel });
      if (!isConnectionDetailCurrent(lifecycle)) return;
      if (result.ok) {
        toast.success(
          `连接成功 · ${connection.name}`,
          `${result.modelTested} · ${result.latencyMs} ms`,
        );
      } else {
        toast.error(
          `连接失败 · ${connection.name}`,
          connectionTestFailureMessage(result, credentialTroubleshootingCopy),
        );
      }
    } catch (error) {
      if (!isConnectionDetailCurrent(lifecycle)) return;
      const message = providerPanelActionErrorMessage(error);
      toast.error(`连接测试出错 · ${connection.name}`, message);
    } finally {
      testingRef.current = false;
      if (isConnectionDetailCurrent(lifecycle)) setTesting(false);
    }
  }

  async function refreshModels(opts: { silent?: boolean } = {}) {
    if (fetchingModelsRef.current) return;
    if (!opts.silent && (busyRef.current || testingRef.current || settingDefaultRef.current || deletingRef.current)) return;
    const lifecycle = connectionDetailLifecycleRef.current;
    fetchingModelsRef.current = true;
    setFetchingModels(true);
    try {
      // Backend (xuan `81ed044`) returns a `ModelDiscoveryResult` envelope —
      // `{ models, source: 'fetched' | 'fallback', fetchedAt }` — and throws
      // a generalizedErrorMessage on failure. We trust `result.source`
      // verbatim instead of inferring from list length, so a provider that
      // legitimately returns 0 models still reads as 'fetched'.
      const result = await props.bridge.fetchModels(connection.slug);
      if (!isConnectionDetailCurrent(lifecycle)) return;
      setModels(result.models);
      setModelSource(result.source);
      await props.onChanged();
      if (!isConnectionDetailCurrent(lifecycle)) return;
      if (!opts.silent) {
        toast.success(`已拉取 ${result.models.length} 个模型 · ${connection.name}`);
      }
    } catch (error) {
      if (!isConnectionDetailCurrent(lifecycle)) return;
      const message = providerPanelActionErrorMessage(error);
      // Leave the previously-known source / models intact (so the dropdown
      // doesn't suddenly empty out), but downgrade the source label back to
      // 'fallback' if we have nothing fresh to show — the failed fetch
      // means whatever's on screen is not from the latest probe.
      if (models.length === 0) setModelSource('fallback');
      toast.error(
        `拉取模型失败 · ${connection.name}`,
        `${message} · 当前继续显示静态列表，请确认 ${credentialTroubleshootingCopy} 后重试。`,
      );
    } finally {
      fetchingModelsRef.current = false;
      if (isConnectionDetailCurrent(lifecycle)) setFetchingModels(false);
    }
  }

  async function setAsDefault() {
    if (settingDefaultRef.current || busyRef.current || testingRef.current || fetchingModelsRef.current || deletingRef.current) return;
    if (!connection.enabled) {
      toast.error('无法设为默认', '这个模型连接已禁用，请重新登录或启用后再设为默认。');
      return;
    }
    const lifecycle = connectionDetailLifecycleRef.current;
    settingDefaultRef.current = true;
    setSettingDefault(true);
    try {
      await props.bridge.setDefault(connection.slug);
      if (!isConnectionDetailCurrent(lifecycle)) return;
      await props.onChanged();
      if (!isConnectionDetailCurrent(lifecycle)) return;
      toast.success(`已设为默认 · ${connection.name}`);
    } catch (error) {
      if (!isConnectionDetailCurrent(lifecycle)) return;
      toast.error('切换默认失败', providerPanelActionErrorMessage(error));
    } finally {
      settingDefaultRef.current = false;
      if (isConnectionDetailCurrent(lifecycle)) setSettingDefault(false);
    }
  }

  async function remove() {
    if (deletingRef.current || busyRef.current || testingRef.current || fetchingModelsRef.current || settingDefaultRef.current) return;
    const lifecycle = connectionDetailLifecycleRef.current;
    deletingRef.current = true;
    setDeleting(true);
    const ok = await toast.confirm({
      title: `删除供应商 ${connection.name}？`,
      description: '将从模型连接中移除这个供应商配置；如需再次使用，需要重新添加凭据。',
      confirmLabel: '删除',
      cancelLabel: '取消',
      destructive: true,
    });
    if (!isConnectionDetailCurrent(lifecycle)) return;
    if (!ok) {
      deletingRef.current = false;
      setDeleting(false);
      return;
    }
    let deleted = false;
    try {
      await props.bridge.delete(connection.slug);
      deleted = true;
      if (!isConnectionDetailCurrent(lifecycle)) return;
      await props.onDeleted();
    } catch (error) {
      if (!isConnectionDetailCurrent(lifecycle)) return;
      toast.error(
        deleted ? '刷新模型列表失败' : '删除模型连接失败',
        providerPanelActionErrorMessage(error),
      );
    } finally {
      deletingRef.current = false;
      if (isConnectionDetailCurrent(lifecycle)) setDeleting(false);
    }
  }

  // After a successful in-sheet OAuth re-login, re-probe the credential
  // presence (an expired token still read hasSecret===true, so we must
  // refresh it) and reload the connection so its status leaves 需要重新登录.
  async function refreshAfterRelogin() {
    const lifecycle = connectionDetailLifecycleRef.current;
    try {
      const nextHasSecret = await props.bridge.hasSecret(connection.slug);
      if (!isConnectionDetailCurrent(lifecycle)) return;
      setHasSecret(nextHasSecret);
    } catch (error) {
      if (!isConnectionDetailCurrent(lifecycle)) return;
      setHasSecret('error');
      toast.error('读取模型凭据状态失败', providerPanelActionErrorMessage(error));
    }
    await props.onChanged();
  }

  return (
    <div className="providerEditor">
      <header>
        <div>
          <h3>{connection.name}</h3>
          <p>{display.name}</p>
        </div>
        <span className="providerHeaderBadges">
          {props.isDefault && <Chip variant="neutral" size="sm">默认</Chip>}
          <Chip variant="neutral" size="sm">{categoryLabel(defaults.category)}</Chip>
        </span>
      </header>
      <FieldRoot className="grid gap-1.5">
        <Label className="text-xs text-foreground-secondary">连接标识</Label>
        <Input value={connection.slug} disabled aria-label="模型连接标识" />
      </FieldRoot>
      <FieldRoot className="grid gap-1.5">
        <Label className="text-xs text-foreground-secondary">服务地址</Label>
        {hasFixedOAuthBaseUrl && <FieldDescription>OAuth 固定</FieldDescription>}
        <Input
          value={baseUrl}
          onChange={(event) => setBaseUrl(event.currentTarget.value)}
          placeholder={defaults.baseUrl}
          readOnly={hasFixedOAuthBaseUrl}
          disabled={detailActionBusy}
          aria-readonly={hasFixedOAuthBaseUrl ? 'true' : undefined}
          aria-label={hasFixedOAuthBaseUrl ? '模型连接服务地址，OAuth 固定' : '模型连接服务地址'}
        />
      </FieldRoot>
      {supportsApiKey && (
        <FieldRoot className="grid gap-1.5">
          <Label className="text-xs text-foreground-secondary">模型密钥</Label>
          {hasSecret === true && <FieldDescription>已设置，粘贴新值可替换</FieldDescription>}
          {hasSecret === 'loading' && <FieldDescription>正在读取状态</FieldDescription>}
          {hasSecret === 'error' && <FieldDescription>凭据状态未知</FieldDescription>}
          <PasswordInput
            value={apiKey}
            onChange={setApiKey}
            placeholder={hasSecret === true ? '••••••••' : '粘贴模型密钥'}
            ariaLabel={`${display.name} 模型密钥`}
            disabled={detailActionBusy}
          />
        </FieldRoot>
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
          <div className="providerUnavailableNotice" data-auth-kind="oauth">
            <strong>
              {hasSecret === true
                ? 'OAuth 已登录'
                : hasSecret === 'loading'
                  ? 'OAuth 状态读取中'
                  : hasSecret === 'error'
                    ? 'OAuth 状态未知'
                    : '等待 OAuth 登录'}
            </strong>
            <span>
              {hasSecret === true
                ? '该模型连接使用主进程保存的 OAuth access token；若请求提示需要重新登录，请到账号连接重新授权。'
                : hasSecret === 'loading'
                  ? '正在读取本机 OAuth 登录状态，读取完成前不会把未知状态显示成未登录。'
                  : hasSecret === 'error'
                    ? '暂时无法读取本机 OAuth 登录状态；请刷新页面或重新打开设置。'
                    : '请到账号连接完成登录；登录成功后会自动出现在模型连接里。'}
            </span>
          </div>
        )
      )}
      {credentialProbePending && (
        <p className="providerError" role="alert">
          {hasSecret === 'loading'
            ? '正在读取模型凭据状态，读取完成前暂不测试连接或刷新模型。'
            : '模型凭据状态暂时没刷新成功，已避免把未知状态显示成未登录或未配置。'}
        </p>
      )}
      <ModelTable
        modelChoices={modelChoices}
        defaultModel={defaultModel}
        onPickDefault={(id) => setDefaultModel(id)}
        modelSource={modelSource}
        modelsFetchedAt={connection.modelsFetchedAt}
        fallbackCount={catalogFallbackCount}
        canRefresh={!detailActionBusy && hasUsableCredential}
        fetchingModels={fetchingModels}
        disabled={detailActionBusy}
        onRefresh={() => void refreshModels()}
      />
      {defaults.signupUrl && (
        <a className="providerExternalLink" href={defaults.signupUrl} target="_blank" rel="noreferrer noopener">
          获取模型密钥
        </a>
      )}
      <div className="providerActions">
        <Button type="button" disabled={detailActionBusy || !hasSaveChanges} onClick={save}>
          {busy ? '保存中…' : '保存修改'}
        </Button>
        <Button variant="secondary" type="button" disabled={detailActionBusy || !hasUsableCredential} onClick={runTest}>
          {testing ? '测试中…' : '测试连接'}
        </Button>
        {!props.isDefault && connection.enabled && (
          <Button variant="secondary" type="button" disabled={detailActionBusy} onClick={setAsDefault}>
            {settingDefault ? '设置中…' : '设为默认'}
          </Button>
        )}
        <Button variant="destructive" type="button" disabled={detailActionBusy} onClick={remove}>
          {deleting ? '删除中…' : '删除'}
        </Button>
      </div>
    </div>
  );
}

function GitHubCopilotReloginNotice(props: {
  hasSecret: CredentialPresenceStatus;
  onRelogin(): Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const mountedRef = useMountedRef();
  const toast = useToast();
  const loggedIn = props.hasSecret === true;
  const loading = props.hasSecret === 'loading';

  async function connect() {
    if (busyRef.current) return;
    busyRef.current = true;
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
      busyRef.current = false;
      if (mountedRef.current) setBusy(false);
    }
  }

  return (
    <div className="providerUnavailableNotice" data-auth-kind="oauth">
      <strong>{loggedIn ? 'GitHub Copilot 已登录' : loading ? 'OAuth 状态读取中' : '等待兼容 GitHub 凭据'}</strong>
      <span>{loggedIn ? '若账号或组织策略变化，可重新导入兼容凭据。' : '配置具有 Copilot Requests 权限的凭据后从本机安全导入。'}</span>
      {!loading && (
        <Button type="button" size="sm" disabled={busy} onClick={() => void connect()}>
          {busy ? '导入中…' : loggedIn ? '重新导入' : '导入兼容凭据'}
        </Button>
      )}
    </div>
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
    <div className="providerUnavailableNotice" data-auth-kind="oauth">
      <strong>{title}</strong>
      <span>{detail}</span>
      {!loading && (
        <Button
          type="button"
          size="sm"
          disabled={flow.actionBusy}
          onClick={() => void flow.startLogin()}
        >
          {flow.pendingAction === 'login' ? '登录中…' : loggedIn ? '重新登录' : '登录'}
        </Button>
      )}
    </div>
  );
}

type ConnectionDetailSnapshot = {
  slug: string;
  baseUrl: string;
  defaultModel: string;
  models: ModelInfo[];
  modelSource: 'fetched' | 'fallback';
};

function connectionDetailSnapshot(
  connection: LlmConnection,
  defaultBaseUrl: string | undefined,
): ConnectionDetailSnapshot {
  return {
    slug: connection.slug,
    baseUrl: connection.baseUrl ?? defaultBaseUrl ?? '',
    defaultModel: connection.defaultModel,
    models: connection.models ?? [],
    modelSource: connection.modelSource ?? 'fallback',
  };
}

function connectionDetailDraftMatchesSnapshot(
  draft: {
    baseUrl: string;
    defaultModel: string;
    models: ModelInfo[];
    modelSource: 'fetched' | 'fallback';
  },
  snapshot: ConnectionDetailSnapshot,
): boolean {
  return draft.baseUrl === snapshot.baseUrl &&
    draft.defaultModel === snapshot.defaultModel &&
    draft.modelSource === snapshot.modelSource &&
    modelListsEqual(draft.models, snapshot.models);
}

function modelListsEqual(left: ModelInfo[], right: ModelInfo[]): boolean {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    const leftModel = left[index];
    const rightModel = right[index];
    if (leftModel.id !== rightModel.id) return false;
    if (leftModel.contextWindow !== rightModel.contextWindow) return false;
    if (leftModel.maxOutputTokens !== rightModel.maxOutputTokens) return false;
    if (leftModel.capabilities?.chat !== rightModel.capabilities?.chat) return false;
    if (leftModel.capabilities?.vision !== rightModel.capabilities?.vision) return false;
    if (leftModel.capabilities?.reasoning !== rightModel.capabilities?.reasoning) return false;
    if (leftModel.capabilities?.functionCalling !== rightModel.capabilities?.functionCalling) return false;
    if (leftModel.capabilities?.imageGeneration !== rightModel.capabilities?.imageGeneration) return false;
  }
  return true;
}

/**
 * UI-02 provider model workspace (per @kenji backlog item):
 *
 *   - Source/fetchedAt header (driven by persisted backend metadata)
 *   - Search box to filter long catalogs
 *   - Per-row default radio + capability chips (vision / reasoning /
 *     function calling) when present
 *   - Default model gets a tinted background + "默认" badge
 *   - Empty state distinguishes "fetched 0" from "haven't fetched yet"
 *   - Refresh button anchored to the header
 *
 * Replaces the dropdown + "刷新模型列表" pair the editor used to ship
 * with. The picker is now a workspace, not a form field.
 */
function ModelTable(props: {
  modelChoices: ModelCatalogEntry[];
  defaultModel: string;
  onPickDefault(id: string): void;
  modelSource: 'fetched' | 'fallback';
  modelsFetchedAt?: number;
  fallbackCount: number;
  canRefresh: boolean;
  fetchingModels: boolean;
  disabled?: boolean;
  onRefresh(): void;
}) {
  const [query, setQuery] = useState('');
  const listRef = useRef<HTMLUListElement>(null);
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return props.modelChoices;
    return props.modelChoices.filter((m) => {
      const displayName = modelTableDisplayLabel(m).toLowerCase();
      return m.id.toLowerCase().includes(q) || displayName.includes(q);
    });
  }, [props.modelChoices, query]);
  const selectableModelIds = useMemo(() => selectableDefaultModelIds(filtered), [filtered]);
  const tabbableModelId = tabbableRadioId(props.defaultModel || undefined, selectableModelIds);

  const headerLine =
    props.modelSource === 'fetched'
      ? props.modelChoices.length > 0
        ? `实时拉取的 ${props.modelChoices.length} 个模型${formatFetchedAtSuffix(props.modelsFetchedAt)}`
        : '已成功调用供应商接口，但返回 0 个模型 — 该供应商可能未对当前模型密钥开放任何模型。'
      : `静态备用列表（${props.fallbackCount} 项）。点「刷新模型列表」拉取该供应商的真实模型清单。`;

  // ARIA radiogroup keyboard pattern: arrow keys move focus AND select.
  // Space/Enter on a focused radio just trigger the native button click.
  // The pure `nextRadioId` helper is unit-tested in
  // `apps/desktop/src/main/__tests__/model-table-keyboard.test.ts`.
  function onListKeyDown(event: ReactKeyboardEvent<HTMLUListElement>) {
    if (props.disabled) return;
    const list = listRef.current;
    if (!list) return;
    const radios = Array.from(list.querySelectorAll<HTMLButtonElement>('button[role="radio"]'));
    if (radios.length === 0) return;
    const focusedRadio = (document.activeElement as HTMLElement | null)?.closest<HTMLButtonElement>('button[role="radio"]');
    const currentId = focusedRadio?.dataset.modelId;
    const nextId = nextRadioId(currentId, selectableModelIds, event.key);
    if (nextId === null || nextId === currentId) return;
    event.preventDefault();
    const next = radios.find((radio) => radio.dataset.modelId === nextId);
    next?.focus({ preventScroll: false });
    next?.scrollIntoView({ block: 'nearest' });
    // ARIA radiogroup pattern (per @xuan PR92 follow-up): arrow keys move
    // focus AND select. Safe because `onPickDefault` updates local form
    // state only — persistence happens on "保存修改", so scanning models
    // with the arrow keys doesn't write to disk on every keystroke.
    props.onPickDefault(nextId);
  }

  // @kenji PR91 follow-up #2: when search filters out the currently-selected
  // default, surface a one-line hint so the user doesn't lose track of which
  // model is in effect. Click the hint to clear the search.
  const defaultHidden =
    query.trim().length > 0 &&
    props.defaultModel.length > 0 &&
    filtered.every((m) => m.id !== props.defaultModel);

  return (
    <div className="modelTable" data-source={props.modelSource}>
      <header className="modelTableHeader">
        <div className="modelTableHeaderText">
          <strong>模型</strong>
          <small>{headerLine}</small>
          <small className="modelTableStickyHint">
            默认模型只用于新建会话；已有会话会保留创建时的模型选择。
          </small>
        </div>
        <Button
          type="button"
          disabled={!props.canRefresh}
          onClick={props.onRefresh}
        >
          {props.fetchingModels ? '拉取中…' : '刷新模型列表'}
        </Button>
      </header>

      {props.modelChoices.length > 6 && (
        <Input
          type="search"
          className="modelTableSearch"
          placeholder={`在 ${props.modelChoices.length} 个模型中搜索…`}
          value={query}
          onChange={(event) => setQuery(event.currentTarget.value)}
          autoComplete="off"
          spellCheck={false}
          aria-label="搜索模型"
        />
      )}

      {defaultHidden && (
        <BaseButton
          type="button"
          className="modelTableDefaultHint"
          onClick={() => setQuery('')}
          title="清空搜索"
        >
          当前默认 <code>{props.defaultModel}</code> 不在搜索结果中 · 点这里清空搜索
        </BaseButton>
      )}

      {props.modelChoices.length === 0 ? (
        <div className="modelTableEmpty">
          {props.modelSource === 'fetched'
            ? '拉取返回 0 个模型。请检查账号方案或重新拉取。'
            : '尚无模型。点「刷新模型列表」拉取或先配置模型密钥。'}
        </div>
      ) : filtered.length === 0 ? (
        <div className="modelTableEmpty">没有匹配 “{query}” 的模型。</div>
      ) : (
        <ul
          ref={listRef}
          className="modelTableList"
          role="radiogroup"
          aria-label="默认模型"
          onKeyDown={onListKeyDown}
        >
          {filtered.map((model) => {
            const isDefault = model.id === props.defaultModel;
            const displayName = modelTableDisplayLabel(model);
            const showRawId = displayName !== model.id;
            const warning = modelTableEntryWarning(model);
            const canPickDefault = canPickDefaultModel(model);
            return (
              <li key={model.id} role="none">
                <BaseButton
                  type="button"
                  className="modelTableRow"
                  role="radio"
                  aria-checked={isDefault}
                  aria-disabled={!canPickDefault || props.disabled ? true : undefined}
                  data-default={isDefault ? 'true' : undefined}
                  data-disabled={!canPickDefault ? 'true' : undefined}
                  data-model-id={model.id}
                  disabled={props.disabled || !canPickDefault}
                  // Only the active radio is in the tab order; arrow keys
                  // move focus inside the group. Standard ARIA radiogroup.
                  tabIndex={tabbableModelId === model.id ? 0 : -1}
                  onClick={() => {
                    if (!canPickDefault) return;
                    props.onPickDefault(model.id);
                  }}
                >
                  <span className="modelTableRowRadio" aria-hidden="true" />
                  <span className="modelTableRowText">
                    <span className="modelTableRowName">{displayName}</span>
                    {showRawId && <code className="modelTableRowId">{model.id}</code>}
                    {warning && <span className="modelTableRowWarning">{warning}</span>}
                  </span>
                  <ModelCapabilityChips model={model} />
                  {isDefault && <span className="modelTableDefaultBadge">默认</span>}
                </BaseButton>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

function modelTableDisplayLabel(model: Pick<ModelCatalogEntry, 'id' | 'displayName'>): string {
  return model.displayName?.trim() || model.id;
}

function modelTableEntryWarning(model: Pick<ModelCatalogEntry, 'unavailableReason' | 'availability'>): string | null {
  if (model.unavailableReason === 'not_in_live_list') {
    return '已保存，但当前模型列表未返回，可能不可用。';
  }
  if (model.availability === 'blocked') return '当前不可用。';
  if (model.availability === 'warning') return '模型列表可能已过期。';
  return null;
}

function ModelCapabilityChips(props: { model: Pick<ModelCatalogEntry, 'capabilities' | 'contextWindow'> }) {
  const caps = props.model.capabilities;
  const chips: string[] = [];
  if (caps.vision) chips.push('vision');
  if (caps.reasoning) chips.push('reasoning');
  if (caps.functionCalling) chips.push('tools');
  if (props.model.contextWindow) {
    // 200_000 → "200K", 1_000_000 → "1M". Compact for the row.
    chips.push(formatContextWindow(props.model.contextWindow));
  }
  if (chips.length === 0) return null;
  return (
    <span className="modelTableChips">
      {chips.map((c) => (
        <span key={c} className="modelTableChip">{c}</span>
      ))}
    </span>
  );
}

function formatContextWindow(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(tokens % 1_000_000 === 0 ? 0 : 1)}M ctx`;
  if (tokens >= 1_000) return `${Math.round(tokens / 1_000)}K ctx`;
  return `${tokens} ctx`;
}
