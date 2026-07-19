import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import {
  PROVIDER_DEFAULTS,
  connectionEnabledModelIds,
  type ConnectionTestResult,
  type LlmConnection,
  type ModelCatalogEntry,
  type ModelInfo,
  type ProviderType,
} from '@maka/core';
import { providerAuthRequiresSecret, providerAuthSupportsApiKey } from '@maka/core/llm-connections';
import {
  Button,
  FieldDescription,
  FieldRoot,
  Input,
  Item,
  ItemActions,
  ItemContent,
  ItemMedia,
  ItemTitle,
  Label,
  OverlayScrollArea,
  RelativeTime,
  useMountedRef,
  useToast,
  useUiLocale,
} from '@maka/ui';
import { Check } from '@maka/ui/icons';
import { PasswordInput } from './password-input';
import { getProviderSettingsCopy } from '../locales/settings-provider-copy';
import { buildCatalogModelChoices } from '../model-catalog-choices';
import { providerDisplay } from './provider-display';
import { connectionChipStatus } from './provider-connection-status';
import { useActionGuard, useKeyedActionGuard } from './use-action-guard';
import { useOAuthLoginFlow, type OAuthLoginFlowBridge } from './use-oauth-login-flow';
import {
  connectionLastTestMessageDisplay,
  connectionTestFailureMessage,
  providerPanelActionErrorMessage,
  type ConnectionsBridge,
  type CredentialPresenceStatus,
} from './provider-panel-shared';

// Maps an OAuth model-connection provider type to the browser-loopback login
// service that can re-run its authorization from inside the connection dialog. Only
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
  const locale = useUiLocale();
  const copy = getProviderSettingsCopy(locale).detail;
  const { connection } = props;
  const toast = useToast();
  const mounted = useMountedRef();
  const [deleting, setDeleting] = useState(false);
  async function remove() {
    if (deleting) return;
    const ok = await toast.confirm({
      title: copy.deleteProviderTitle(connection.name || connection.slug),
      description: copy.deleteUnknownDescription,
      confirmLabel: copy.delete,
      cancelLabel: copy.cancel,
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
      toast.error(copy.deleteFailed, providerPanelActionErrorMessage(error, locale));
    } finally {
      if (mounted.current) setDeleting(false);
    }
  }
  return (
    <div className="providerConnectionDetail">
      <p>
        {copy.unknownDescription(connection.providerType)}
      </p>
      <Button variant="destructive" type="button" onClick={remove} disabled={deleting}>
        {deleting ? copy.deleting : copy.deleteUnused}
      </Button>
    </div>
  );
}

function ConnectionDetailInner(props: ConnectionDetailProps) {
  const locale = useUiLocale();
  const copy = getProviderSettingsCopy(locale).detail;
  const { connection } = props;
  const defaults = PROVIDER_DEFAULTS[connection.providerType];
  const display = providerDisplay(connection.providerType, locale);
  const [apiKey, setApiKey] = useState('');
  const [hasSecret, setHasSecret] = useState<CredentialPresenceStatus>(
    defaults.authKind === 'none' ? true : 'loading',
  );
  const [baseUrl, setBaseUrl] = useState(connection.baseUrl ?? defaults.baseUrl ?? '');
  const [models, setModels] = useState<ModelInfo[]>(connection.models ?? []);
  const [enabledModelIds, setEnabledModelIds] = useState(() => connectionEnabledModelIds(connection));
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
  const [savingEnabledModels, setSavingEnabledModels] = useState(false);
  const [settingDefault, setSettingDefault] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const connectionDetailActionGuard = useKeyedActionGuard<
    'save' | 'test' | 'fetch-models' | 'save-enabled-models' | 'set-default' | 'delete'
  >();
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
  const credentialTroubleshootingCopy = needsOAuth ? copy.oauthTroubleshooting : copy.keyTroubleshooting;
  const savedBaseUrl = connection.baseUrl ?? defaults.baseUrl;
  const draftBaseUrl = baseUrl;
  const hasApiKeyChange = apiKey.length > 0;
  const hasBaseUrlChange = draftBaseUrl !== savedBaseUrl;
  // Persistent single-line credential hint. Rendered in every hasSecret state
  // (including `false`) so the description row never adds or drops a line as the
  // async secret probe resolves — the dialog height stays constant.
  const apiKeyStatusHint =
    hasSecret === true
      ? copy.keySet
      : hasSecret === 'loading'
        ? copy.statusLoading
        : hasSecret === 'error'
          ? copy.credentialUnknown
          : copy.keyMissing;
  const detailActionBusy = busy || testing || fetchingModels || savingEnabledModels || settingDefault || deleting;
  const issue = connectionChipStatus(connection, locale);
  const lastTestMessage = connectionLastTestMessageDisplay(connection.lastTestMessage, locale);
  const lastTestAtMs = connection.lastTestAt ? Date.parse(connection.lastTestAt) : NaN;

  useEffect(() => {
    connectionDetailLifecycleRef.current += 1;
    return () => {
      connectionDetailLifecycleRef.current += 1;
      connectionDetailActionGuard.reset();
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
        toast.error(copy.credentialReadFailed, providerPanelActionErrorMessage(error, locale));
      });
  }, [props.bridge, connection.slug, probesCredential, toast]);

  useEffect(() => {
    const nextSnapshot = connectionDetailSnapshot(connection, defaults.baseUrl);
    const previousSnapshot = syncedConnectionSnapshotRef.current;
    const localStillSynced = connectionDetailDraftMatchesSnapshot(
      { baseUrl, models, modelSource },
      previousSnapshot,
    );
    const localAlreadyMatchesNext = connectionDetailDraftMatchesSnapshot(
      { baseUrl, models, modelSource },
      nextSnapshot,
    );

    if (connection.slug !== previousSnapshot.slug || (apiKey.length === 0 && localStillSynced)) {
      setBaseUrl(nextSnapshot.baseUrl);
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
    defaults.baseUrl,
    modelSource,
    models,
  ]);

  useEffect(() => {
    setEnabledModelIds(connectionEnabledModelIds(connection));
  }, [connection.defaultModel, connection.enabledModelIds, connection.slug]);

  // Picker entries come from the same catalog merge path as Chat and Daily
  // Review, but use the local unsaved editor draft for model/default changes.
  const modelChoices = buildCatalogModelChoices({
    slug: connection.slug,
    providerType: connection.providerType,
    defaultModel: connection.defaultModel,
    models: modelSource === 'fetched' || models.length > 0 ? models : undefined,
    modelSource,
    modelsFetchedAt: connection.modelsFetchedAt,
  });

  async function save() {
    const releaseSave = connectionDetailActionGuard.beginExclusive('save');
    if (!releaseSave) return;
    const lifecycle = connectionDetailLifecycleRef.current;
    setBusy(true);
    let saved = false;
    try {
      await props.bridge.update(connection.slug, {
        baseUrl,
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
        saved ? copy.refreshFailed : copy.saveFailed,
        providerPanelActionErrorMessage(error, locale),
      );
    } finally {
      releaseSave();
      if (isConnectionDetailCurrent(lifecycle)) setBusy(false);
    }
  }

  async function updateEnabledModels(nextIds: string[]) {
    if (connectionDetailActionGuard.has('save-enabled-models') || detailActionBusy) return;
    const next = connectionEnabledModelIds({
      defaultModel: connection.defaultModel,
      enabledModelIds: nextIds,
    });
    if (modelIdListsEqual(next, enabledModelIds)) return;
    const previous = enabledModelIds;
    const lifecycle = connectionDetailLifecycleRef.current;
    const releaseSaveModels = connectionDetailActionGuard.begin('save-enabled-models');
    if (!releaseSaveModels) return;
    setSavingEnabledModels(true);
    setEnabledModelIds(next);
    let saved = false;
    try {
      await props.bridge.update(connection.slug, { enabledModelIds: next });
      saved = true;
      if (!isConnectionDetailCurrent(lifecycle)) return;
      await props.onChanged();
    } catch (error) {
      if (!isConnectionDetailCurrent(lifecycle)) return;
      if (!saved) setEnabledModelIds(previous);
      toast.error(
        saved ? copy.refreshFailed : copy.saveModelsFailed,
        providerPanelActionErrorMessage(error, locale),
      );
    } finally {
      releaseSaveModels();
      if (isConnectionDetailCurrent(lifecycle)) setSavingEnabledModels(false);
    }
  }

  async function runTest() {
    const releaseTest = connectionDetailActionGuard.beginExclusive('test');
    if (!releaseTest) return;
    const lifecycle = connectionDetailLifecycleRef.current;
    setTesting(true);
    try {
      const result: ConnectionTestResult = await props.bridge.test(connection.slug, { model: connection.defaultModel });
      if (!isConnectionDetailCurrent(lifecycle)) return;
      if (result.ok) {
        toast.success(
          copy.connectionSuccess(connection.name),
          `${result.modelTested} · ${result.latencyMs} ms`,
        );
      } else {
        toast.error(
          copy.connectionFailed(connection.name),
          connectionTestFailureMessage(result, {
            auth: copy.authTroubleshooting(credentialTroubleshootingCopy),
            recheck: copy.recheckTroubleshooting(credentialTroubleshootingCopy),
          }, locale),
        );
      }
    } catch (error) {
      if (!isConnectionDetailCurrent(lifecycle)) return;
      const message = providerPanelActionErrorMessage(error, locale);
      toast.error(copy.connectionTestError(connection.name), message);
    } finally {
      releaseTest();
      if (isConnectionDetailCurrent(lifecycle)) setTesting(false);
    }
  }

  async function refreshModels(opts: { silent?: boolean } = {}) {
    // A silent refresh (the post-save auto-fetch) may overlap other actions;
    // a manual one is gated on the whole sheet like the other buttons.
    const releaseFetch = opts.silent
      ? connectionDetailActionGuard.begin('fetch-models')
      : connectionDetailActionGuard.beginExclusive('fetch-models');
    if (!releaseFetch) return;
    const lifecycle = connectionDetailLifecycleRef.current;
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
        toast.success(copy.modelsFetched(result.models.length, connection.name));
      }
    } catch (error) {
      if (!isConnectionDetailCurrent(lifecycle)) return;
      const message = providerPanelActionErrorMessage(error, locale);
      // Leave the previously-known source / models intact (so the dropdown
      // doesn't suddenly empty out), but downgrade the source label back to
      // 'fallback' if we have nothing fresh to show — the failed fetch
      // means whatever's on screen is not from the latest probe.
      if (models.length === 0) setModelSource('fallback');
      toast.error(
        copy.modelsFetchFailed(connection.name),
        copy.modelsFetchFailedDetail(message, credentialTroubleshootingCopy),
      );
    } finally {
      releaseFetch();
      if (isConnectionDetailCurrent(lifecycle)) setFetchingModels(false);
    }
  }

  async function setAsDefault() {
    const releaseSetDefault = connectionDetailActionGuard.beginExclusive('set-default');
    if (!releaseSetDefault) return;
    if (!connection.enabled) {
      releaseSetDefault();
      toast.error(copy.connectionDisabled, copy.connectionDisabledDetail);
      return;
    }
    const lifecycle = connectionDetailLifecycleRef.current;
    setSettingDefault(true);
    try {
      await props.bridge.setDefault(connection.slug);
      if (!isConnectionDetailCurrent(lifecycle)) return;
      await props.onChanged();
      if (!isConnectionDetailCurrent(lifecycle)) return;
      toast.success(copy.defaultSet(connection.name));
    } catch (error) {
      if (!isConnectionDetailCurrent(lifecycle)) return;
      toast.error(copy.switchDefaultFailed, providerPanelActionErrorMessage(error, locale));
    } finally {
      releaseSetDefault();
      if (isConnectionDetailCurrent(lifecycle)) setSettingDefault(false);
    }
  }

  async function remove() {
    const releaseDelete = connectionDetailActionGuard.beginExclusive('delete');
    if (!releaseDelete) return;
    const lifecycle = connectionDetailLifecycleRef.current;
    setDeleting(true);
    const ok = await toast.confirm({
      title: copy.deleteProviderTitle(connection.name),
      description: copy.deleteDescription,
      confirmLabel: copy.delete,
      cancelLabel: copy.cancel,
      destructive: true,
    });
    if (!isConnectionDetailCurrent(lifecycle)) return;
    if (!ok) {
      releaseDelete();
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
        deleted ? copy.refreshFailed : copy.deleteFailed,
        providerPanelActionErrorMessage(error, locale),
      );
    } finally {
      releaseDelete();
      if (isConnectionDetailCurrent(lifecycle)) setDeleting(false);
    }
  }

  // After a successful in-dialog OAuth re-login, re-probe the credential
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
      toast.error(copy.credentialReadFailed, providerPanelActionErrorMessage(error, locale));
    }
    await props.onChanged();
  }

  return (
    <div className="providerEditor providerConnectionManager">
      {supportsApiKey && (
        <div className="providerCredentialTask">
          <FieldRoot className="grid gap-1.5">
            <Label className="text-xs text-foreground-secondary">{copy.modelKey}</Label>
            <FieldDescription>{apiKeyStatusHint}</FieldDescription>
            <PasswordInput
              value={apiKey}
              onChange={setApiKey}
              placeholder={hasSecret === true ? '••••••••' : copy.pasteModelKey}
              ariaLabel={copy.modelKeyAria(display.name)}
              disabled={detailActionBusy}
            />
          </FieldRoot>
          <div className="providerCredentialActions">
            {defaults.signupUrl && (
              <a className="providerExternalLink" href={defaults.signupUrl} target="_blank" rel="noreferrer noopener" aria-label={copy.getModelKey}>
                {copy.getModelKey}
              </a>
            )}
            {/* Persistent button (disabled until a new key is typed) so the
                credential actions row keeps a fixed height — no jitter when the
                user starts pasting a key. */}
            <Button type="button" disabled={detailActionBusy || !hasApiKeyChange} onClick={save}>
              {busy ? copy.saving : copy.updateKey}
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
          <div className="providerUnavailableNotice" data-auth-kind="oauth">
            <strong>
              {hasSecret === true
                ? copy.oauthLoggedIn
                : hasSecret === 'loading'
                  ? copy.oauthLoading
                  : hasSecret === 'error'
                    ? copy.oauthUnknown
                    : copy.oauthWaiting}
            </strong>
            <span>
              {hasSecret === true
                ? copy.oauthLoggedInDetail
                : hasSecret === 'loading'
                  ? copy.oauthLoadingDetail
                  : hasSecret === 'error'
                    ? copy.oauthUnknownDetail
                    : copy.oauthWaitingDetail}
            </span>
          </div>
        )
      )}
      {credentialProbePending && (
        <p className="providerError" role="alert">
          {hasSecret === 'loading'
            ? copy.credentialLoadingDetail
            : copy.credentialUnknownDetail}
        </p>
      )}
      <details className="providerAdvancedSettings">
        <summary>{copy.advanced}</summary>
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
                  {busy ? copy.saving : copy.saveEndpoint}
                </Button>
              </div>
            )}
          </div>
          <div className="providerAdvancedActions">
            <Button variant="secondary" type="button" disabled={detailActionBusy || !hasUsableCredential} onClick={runTest}>
              {testing ? copy.testing : copy.testConnection}
            </Button>
            <Button variant="quiet" type="button" disabled={detailActionBusy || !hasUsableCredential} onClick={() => void refreshModels()}>
              {fetchingModels ? copy.updating : copy.updateModels}
            </Button>
            {!props.isDefault && connection.enabled && (
              <Button variant="quiet" type="button" disabled={detailActionBusy} onClick={setAsDefault}>
                {settingDefault ? copy.setting : copy.setDefault}
              </Button>
            )}
            <Button className="providerAdvancedDanger" variant="quiet" type="button" disabled={detailActionBusy} onClick={remove}>
              {deleting ? copy.deleting : copy.deleteConnection}
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
  const copy = getProviderSettingsCopy(useUiLocale()).detail;
  return (
    <FieldRoot className="grid gap-1.5">
      <Label className="text-xs text-foreground-secondary">{copy.endpoint}</Label>
      {props.fixedOAuth && <FieldDescription>{copy.oauthFixed}</FieldDescription>}
      <Input
        value={props.baseUrl}
        onChange={(event) => props.onChange(event.currentTarget.value)}
        placeholder={props.defaultsBaseUrl}
        readOnly={props.fixedOAuth}
        disabled={props.disabled}
        aria-readonly={props.fixedOAuth ? 'true' : undefined}
        aria-label={props.fixedOAuth ? copy.endpointFixedAria : copy.endpointAria}
      />
    </FieldRoot>
  );
}

function GitHubCopilotReloginNotice(props: {
  hasSecret: CredentialPresenceStatus;
  onRelogin(): Promise<void>;
}) {
  const locale = useUiLocale();
  const copy = getProviderSettingsCopy(locale).detail;
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
        toast.error(copy.copilotImportFailed, result.message);
        return;
      }
      await props.onRelogin();
    } catch (error) {
      if (mountedRef.current) toast.error(copy.copilotImportFailed, providerPanelActionErrorMessage(error, locale));
    } finally {
      connectGuard.finish();
      if (mountedRef.current) setBusy(false);
    }
  }

  return (
    <div className="providerUnavailableNotice" data-auth-kind="oauth">
      <strong>{loggedIn ? copy.copilotLoggedIn : loading ? copy.oauthLoading : copy.copilotWaiting}</strong>
      <span>{loggedIn ? copy.copilotLoggedInDetail : copy.copilotWaitingDetail}</span>
      {!loading && (
        <Button type="button" size="sm" disabled={busy} onClick={() => void connect()}>
          {busy ? copy.importing : loggedIn ? copy.reimport : copy.importCredential}
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
  const copy = getProviderSettingsCopy(useUiLocale()).detail;
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
    ? copy.oauthLoggedIn
    : loading
      ? copy.oauthLoading
      : errored
        ? copy.oauthUnknown
        : copy.oauthWaiting;
  const detail = loggedIn
    ? copy.oauthReloginDetail
    : loading
      ? copy.oauthLoadingDetail
      : errored
        ? copy.oauthUnknownDetail
        : copy.oauthStartDetail;
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
          {flow.pendingAction === 'login' ? copy.loggingIn : loggedIn ? copy.relogin : copy.login}
        </Button>
      )}
    </div>
  );
}

type ConnectionDetailSnapshot = {
  slug: string;
  baseUrl: string;
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
    models: connection.models ?? [],
    modelSource: connection.modelSource ?? 'fallback',
  };
}

function connectionDetailDraftMatchesSnapshot(
  draft: {
    baseUrl: string;
    models: ModelInfo[];
    modelSource: 'fetched' | 'fallback';
  },
  snapshot: ConnectionDetailSnapshot,
): boolean {
  return draft.baseUrl === snapshot.baseUrl &&
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
 * Enabled-model editor. The full candidate catalog (live-fetched merged with
 * the static fallback, via buildCatalogModelChoices) is shown persistently
 * inside a fixed-height scroll region; enabled models read as checked. Clicking
 * a row toggles it through the shared `enabledModelIds` path, so a newly
 * enabled model reaches the chat model picker with no side state. The default
 * model stays checked and locked (`connectionEnabledModelIds` always keeps it
 * enabled). Search filters the same list in place, so neither the provider's
 * model count nor an active filter changes the dialog height.
 */
function EnabledModelManager(props: {
  modelChoices: ModelCatalogEntry[];
  enabledModelIds: string[];
  defaultModel: string;
  disabled: boolean;
  onChange(ids: string[]): void;
}) {
  const copy = getProviderSettingsCopy(useUiLocale()).detail;
  const [query, setQuery] = useState('');
  // Roving tabindex (composite-widget keyboard pattern): the whole list is ONE
  // Tab stop. Without this every row button is a Tab stop, and a large catalog
  // (OpenRouter's fallback list is 260+ rows) walls off everything below the
  // list for keyboard users. Only the active row has tabIndex=0; ArrowUp/Down
  // + Home/End move activity (focus scrolls the row into view), Space/Enter
  // toggle via the button's native activation.
  const [activeRowId, setActiveRowId] = useState<string | null>(null);
  const modelListRef = useRef<HTMLUListElement>(null);
  const enabled = useMemo(() => new Set(props.enabledModelIds), [props.enabledModelIds]);
  const rows = useMemo(() => {
    const byId = new Map(props.modelChoices.map((model) => [model.id, model] as const));
    const seen = new Set<string>();
    const list: Array<{ id: string; label: string }> = [];
    for (const model of props.modelChoices) {
      if (!model.canUseAsChatDefault) continue;
      seen.add(model.id);
      list.push({ id: model.id, label: modelDisplayLabel(model) });
    }
    // Always surface an already-enabled model even if it is not a current
    // chat-default candidate (a stale id, or a model dropped from the latest
    // catalog), so the user can still toggle it off.
    for (const id of props.enabledModelIds) {
      if (seen.has(id)) continue;
      seen.add(id);
      const model = byId.get(id);
      list.push({ id, label: model ? modelDisplayLabel(model) : id });
    }
    return list;
  }, [props.modelChoices, props.enabledModelIds]);

  const visibleRows = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    if (!normalizedQuery) return rows;
    return rows.filter(
      (row) => row.id.toLowerCase().includes(normalizedQuery) || row.label.toLowerCase().includes(normalizedQuery),
    );
  }, [rows, query]);

  function toggle(id: string) {
    if (props.disabled || id === props.defaultModel) return;
    const next = enabled.has(id)
      ? props.enabledModelIds.filter((candidate) => candidate !== id)
      : [...props.enabledModelIds, id];
    props.onChange(next);
  }

  // The default-model row is disabled (natively unfocusable), so arrow-key
  // traversal skips it — consistent with Tab behavior.
  const focusableRows = visibleRows.filter((row) => row.id !== props.defaultModel);
  const resolvedActiveRowId = activeRowId !== null && focusableRows.some((row) => row.id === activeRowId)
    ? activeRowId
    : focusableRows[0]?.id ?? null;

  function onModelListKeyDown(event: KeyboardEvent<HTMLUListElement>) {
    if (focusableRows.length === 0) return;
    const currentIndex = Math.max(0, focusableRows.findIndex((row) => row.id === resolvedActiveRowId));
    let nextIndex: number;
    switch (event.key) {
      case 'ArrowDown':
        nextIndex = Math.min(currentIndex + 1, focusableRows.length - 1);
        break;
      case 'ArrowUp':
        nextIndex = Math.max(currentIndex - 1, 0);
        break;
      case 'Home':
        nextIndex = 0;
        break;
      case 'End':
        nextIndex = focusableRows.length - 1;
        break;
      default:
        return;
    }
    event.preventDefault();
    const next = focusableRows[nextIndex];
    setActiveRowId(next.id);
    // Focus scrolls the row into view inside the fixed-height scroll region.
    modelListRef.current
      ?.querySelector<HTMLElement>(`[data-model-id="${CSS.escape(next.id)}"]`)
      ?.focus();
  }

  return (
    <section className="providerEnabledModels" aria-labelledby="provider-enabled-models-title">
      <div className="providerEnabledModelsHeader">
        <strong id="provider-enabled-models-title">{copy.enabledModelsTitle(props.enabledModelIds.length)}</strong>
        <span>{copy.enabledModelsHelp}</span>
      </div>
      <Input
        type="search"
        value={query}
        onChange={(event) => setQuery(event.currentTarget.value)}
        placeholder={copy.searchModels}
        autoComplete="off"
        spellCheck={false}
        disabled={props.disabled}
        aria-label={copy.searchModels}
      />
      <OverlayScrollArea className="providerModelChoiceScroll">
        <ul
          ref={modelListRef}
          className="providerModelChoiceList"
          aria-label={copy.modelListAria}
          onKeyDown={onModelListKeyDown}
        >
          {visibleRows.length === 0 ? (
            <li className="providerModelChoiceEmpty">
              {rows.length === 0 ? copy.noModels : copy.noMatchingModels}
            </li>
          ) : (
            visibleRows.map((row) => {
              const isEnabled = enabled.has(row.id);
              const isDefault = row.id === props.defaultModel;
              return (
                <li key={row.id}>
                  <Item
                    className="providerModelChoiceRow"
                    size="sm"
                    render={
                      <button
                        type="button"
                        role="checkbox"
                        aria-checked={isEnabled}
                        data-model-id={row.id}
                        tabIndex={row.id === resolvedActiveRowId ? 0 : -1}
                        disabled={props.disabled || isDefault}
                        onClick={() => toggle(row.id)}
                        onFocus={() => setActiveRowId(row.id)}
                      />
                    }
                  >
                    <ItemMedia className="providerModelChoiceCheck" aria-hidden="true">
                      {isEnabled ? <Check size={14} /> : null}
                    </ItemMedia>
                    <ItemContent>
                      <ItemTitle className="providerModelChoiceLabel">{row.label}</ItemTitle>
                    </ItemContent>
                    {isDefault && (
                      <ItemActions>
                        <span className="providerEnabledModelMeta">{copy.defaultModel}</span>
                      </ItemActions>
                    )}
                  </Item>
                </li>
              );
            })
          )}
        </ul>
      </OverlayScrollArea>
    </section>
  );
}

function modelDisplayLabel(model: Pick<ModelCatalogEntry, 'id' | 'displayName'>): string {
  return model.displayName?.trim() || model.id;
}

function modelIdListsEqual(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((id, index) => id === right[index]);
}
