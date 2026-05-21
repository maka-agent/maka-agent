import { useEffect, useMemo, useState } from 'react';
import {
  CATALOG_PROVIDER_TYPES,
  PROVIDER_DEFAULTS,
  validateSlug,
  type ConnectionTestResult,
  type CreateConnectionInput,
  type LlmConnection,
  type ModelDiscoveryResult,
  type ModelInfo,
  type ProviderCategory,
  type ProviderType,
  type UpdateConnectionInput,
} from '@maka/core';
import { useToast } from '@maka/ui';

export interface ConnectionsBridge {
  list(): Promise<LlmConnection[]>;
  getDefault(): Promise<string | null>;
  setDefault(slug: string | null): Promise<void>;
  create(input: CreateConnectionInput): Promise<LlmConnection>;
  update(slug: string, patch: UpdateConnectionInput): Promise<LlmConnection>;
  delete(slug: string): Promise<void>;
  test(slug: string, opts?: { model?: string }): Promise<ConnectionTestResult>;
  fetchModels(slug: string): Promise<ModelDiscoveryResult>;
  hasSecret(slug: string): Promise<boolean>;
}

type CatalogTab = Extract<ProviderCategory, 'oauth' | 'domestic' | 'overseas' | 'local'>;

const CATALOG_TABS: Array<{ id: CatalogTab; label: string }> = [
  { id: 'oauth', label: 'OAuth' },
  { id: 'domestic', label: '国内' },
  { id: 'overseas', label: '海外' },
  { id: 'local', label: '本地' },
];

export function ProvidersPanel({ bridge }: { bridge: ConnectionsBridge }) {
  const [connections, setConnections] = useState<LlmConnection[]>([]);
  const [defaultSlug, setDefaultSlug] = useState<string | null>(null);
  const [selectedSlug, setSelectedSlug] = useState<string | null>(null);
  const [addingType, setAddingType] = useState<ProviderType | null>(null);
  const [catalogTab, setCatalogTab] = useState<CatalogTab>('domestic');
  const [loading, setLoading] = useState(true);

  async function reload() {
    const [list, defaultConnection] = await Promise.all([
      bridge.list(),
      bridge.getDefault(),
    ]);
    setConnections(list);
    setDefaultSlug(defaultConnection);
    setLoading(false);
    setSelectedSlug((current) => current ?? list[0]?.slug ?? null);
  }

  useEffect(() => {
    void reload();
  }, []);

  const selected = useMemo(
    () => connections.find((connection) => connection.slug === selectedSlug) ?? null,
    [connections, selectedSlug],
  );

  const catalogProviders = CATALOG_PROVIDER_TYPES.filter(
    (type) => PROVIDER_DEFAULTS[type].category === catalogTab,
  );
  const customProviders = CATALOG_PROVIDER_TYPES.filter(
    (type) => PROVIDER_DEFAULTS[type].category === 'custom',
  );

  function startAdd(type: ProviderType) {
    setAddingType(type);
    setSelectedSlug(null);
  }

  const configuredByType = (type: ProviderType) =>
    connections.filter((connection) => connection.providerType === type).length;

  if (loading) {
    return (
      <div className="providersPanel providersLoading" aria-busy="true" aria-label="Loading providers">
        <div className="providersLoadingStrip">
          <div className="maka-skeleton maka-skeleton-line" data-size="lg" style={{ width: '34%' }} />
          <div className="maka-skeleton maka-skeleton-line" data-size="sm" style={{ width: '52%' }} />
        </div>
        <div className="providersLoadingGrid">
          {[0, 1, 2, 3, 4, 5].map((idx) => (
            <div key={idx} className="maka-skeleton maka-skeleton-card" />
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="providersPanel providersMarketPanel">
      <section className="providerMarket">
        <div className="enabledStrip" aria-label="Enabled providers">
          <div className="enabledStripHeader">
            <h3>已启用模型</h3>
            {connections.length > 0 && <span>{connections.length} 个配置</span>}
          </div>
          {connections.length === 0 ? (
            <button className="enabledEmptyChip" type="button" onClick={() => startAdd('zai-coding-plan')}>
              <strong>还没有供应商</strong>
              <small>从下面选择一个开始配置。</small>
            </button>
          ) : connections.map((connection) => (
              <button
                key={connection.slug}
                type="button"
                className="enabledProviderChip"
                data-default={connection.slug === defaultSlug}
                onClick={() => {
                  setSelectedSlug(connection.slug);
                  setAddingType(null);
                }}
              >
                <ProviderLogo type={connection.providerType} compact />
                <span>
                  <strong>{connection.name}</strong>
                  <small>{providerDisplay(connection.providerType).name}</small>
                </span>
              </button>
            ))
          }
        </div>

        <div className="providerMarketHeader">
          <div>
            <h3>模型供应商</h3>
            <p>选择 API Key 服务、本地模型，或即将支持的 OAuth 订阅登录。</p>
          </div>
          <button className="maka-button" type="button" onClick={() => startAdd('openai-compatible')}>
            自定义
          </button>
        </div>

        <div className="catalogTabs catalogPillTabs" role="tablist" aria-label="Provider categories">
          {CATALOG_TABS.map((tab) => (
            <button
              key={tab.id}
              type="button"
              role="tab"
              aria-selected={catalogTab === tab.id}
              data-active={catalogTab === tab.id}
              onClick={() => setCatalogTab(tab.id)}
            >
              <strong>{tab.label}</strong>
            </button>
          ))}
        </div>

        <div className="catalogGrid providerMarketGrid">
          {catalogProviders.map((type) => (
            <ProviderCatalogCard
              key={type}
              type={type}
              count={configuredByType(type)}
              onSelect={() => startAdd(type)}
            />
          ))}
        </div>

        <div className="customProviderEntry">
          <div>
            <h3>自定义供应商</h3>
            <p>接入中转站、代理服务，或自部署的 OpenAI-compatible endpoint。</p>
          </div>
          {customProviders.map((type) => (
            <button key={type} type="button" onClick={() => startAdd(type)}>
              添加 OpenAI-compatible endpoint
            </button>
          ))}
        </div>
      </section>

      {(addingType || selected) && (
        <div className="providerConfigOverlay" role="presentation" onMouseDown={() => {
          setAddingType(null);
          setSelectedSlug(null);
        }}>
          <section className="providerConfigSheet" role="dialog" aria-modal="true" aria-label="Provider configuration" onMouseDown={(event) => event.stopPropagation()}>
            {addingType ? (
              <AddProviderForm
                key={addingType}
                bridge={bridge}
                providerType={addingType}
                existingSlugs={connections.map((connection) => connection.slug)}
                onCancel={() => setAddingType(null)}
                onCreated={async (slug) => {
                  await reload();
                  setSelectedSlug(slug);
                  setAddingType(null);
                }}
              />
            ) : selected ? (
              <ConnectionDetail
                key={selected.slug}
                bridge={bridge}
                connection={selected}
                isDefault={selected.slug === defaultSlug}
                onChanged={reload}
                onDeleted={async () => {
                  setSelectedSlug(null);
                  await reload();
                }}
              />
            ) : null}
          </section>
        </div>
      )}
    </div>
  );
}

function ProviderCatalogCard(props: { type: ProviderType; count: number; onSelect(): void }) {
  const defaults = PROVIDER_DEFAULTS[props.type];
  const display = providerDisplay(props.type);
  const disabled = defaults.status !== 'ready';
  const title = disabled
    ? '即将推出 OAuth 订阅登录。当前可使用同一家厂商的 API key 在下方分类中接入。'
    : `添加 ${display.name}`;

  return (
    <button
      className="providerCatalogCard"
      data-provider={props.type}
      data-status={disabled ? 'coming-soon' : 'ready'}
      type="button"
      title={title}
      onClick={disabled ? undefined : props.onSelect}
    >
      <ProviderLogo type={props.type} />
      <span className="providerCatalogCopy">
        <span className="providerCatalogTitle">
          <strong>{display.name}</strong>
          {!disabled && display.badge && <em>{display.badge}</em>}
        </span>
        <small>{display.description}</small>
        {props.count > 0 && <span className="providerCatalogCount">已配置 {props.count} 个</span>}
      </span>
    </button>
  );
}

export function ProviderLogo(props: { type: ProviderType; compact?: boolean }) {
  return (
    <span className="providerLogo" data-provider={props.type} data-compact={props.compact ? 'true' : undefined} aria-hidden="true">
      <ProviderLogoMark type={props.type} />
    </span>
  );
}

function ProviderLogoMark({ type }: { type: ProviderType }) {
  switch (type) {
    case 'anthropic':
    case 'claude-subscription':
      return (
        <svg viewBox="0 0 36 36" role="img">
          <path d="M18 6 29.5 30h-5.1l-2.3-5.4h-8.2L11.6 30H6.5L18 6Zm-2.5 14.7h5L18 14.9l-2.5 5.8Z" />
        </svg>
      );
    case 'openai':
    case 'codex-subscription':
    case 'openai-compatible':
      return (
        <svg viewBox="0 0 36 36" role="img">
          <g fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round">
            <path d="M18 7.5c4.5 0 7.7 3.4 7.7 7.1 3.2 1.9 4.2 6.2 2.1 9.5-2.1 3.4-6.2 4.6-9.2 3.1-3.1 1.8-7.4.9-9.6-2.4-2.2-3.2-1.6-7.6 1.4-9.6.2-4.1 3.4-7.7 7.6-7.7Z" />
            <path d="M12 15.4 18 12l6 3.4v6.9L18 25.7l-6-3.4v-6.9Z" />
          </g>
        </svg>
      );
    case 'google':
    case 'gemini-cli':
      return (
        <svg viewBox="0 0 36 36" role="img">
          <path fill="#4285F4" d="M29.5 18.3c0-.8-.1-1.6-.2-2.3H18v4.5h6.5c-.3 1.5-1.1 2.8-2.4 3.6v3h3.9c2.3-2.1 3.5-5.2 3.5-8.8Z" />
          <path fill="#34A853" d="M18 30c3.3 0 6.1-1.1 8.1-3l-3.9-3c-1.1.7-2.4 1.1-4.2 1.1-3.1 0-5.8-2.1-6.8-5H7.2v3.1C9.2 27.2 13.3 30 18 30Z" />
          <path fill="#FBBC05" d="M11.2 20.1c-.3-.7-.4-1.5-.4-2.3s.1-1.6.4-2.3v-3.1H7.2a12 12 0 0 0 0 10.8l4-3.1Z" />
          <path fill="#EA4335" d="M18 10.8c1.8 0 3.4.6 4.7 1.8l3.5-3.5C24 7.1 21.3 6 18 6c-4.7 0-8.8 2.8-10.8 6.4l4 3.1c1-2.9 3.7-4.7 6.8-4.7Z" />
        </svg>
      );
    case 'deepseek':
      return (
        <svg viewBox="0 0 36 36" role="img">
          <path d="M7 19.5c4.6-7.7 14.4-8.4 21-3.1-1.2 7.4-8.7 12.9-16.7 9.1 2.8-.2 5.5-1.6 7-4.1-3.9 2.2-7.9 1.9-11.3-1.9Z" />
          <circle cx="24" cy="14" r="2.3" fill="#fff" opacity=".9" />
        </svg>
      );
    case 'moonshot':
      return (
        <svg viewBox="0 0 36 36" role="img">
          <path d="M22.8 6.9a11.7 11.7 0 1 0 0 22.2 10 10 0 1 1 0-22.2Z" />
          <circle cx="23.5" cy="13" r="2" />
          <circle cx="26.5" cy="22" r="1.4" />
        </svg>
      );
    case 'kimi-coding-plan':
      return (
        <svg viewBox="0 0 36 36" role="img">
          <path d="M9 8h5.3v9.1L22.6 8h6.6L20 17.6 30 28h-6.9l-8.8-9.5V28H9V8Z" />
          <path d="M27 8.4c-2.4 3.1-2.2 6.5.4 9.7-4.3-.6-7.1-3.7-7.1-7.3 0-1 .2-1.9.6-2.8 1.8-.5 3.9-.5 6.1.4Z" opacity=".35" />
        </svg>
      );
    case 'zai-coding-plan':
      return (
        <svg viewBox="0 0 44 36" role="img">
          <path d="M8 9h18v4.4L14.8 24H26v4H7.5v-4.5L18.7 13H8V9Z" />
          <circle cx="31" cy="26" r="2" />
          <path d="M35 12h3.7v16H35V12Zm-.2-4.8c0-1.2.9-2.2 2.1-2.2 1.3 0 2.2 1 2.2 2.2s-.9 2.1-2.2 2.1c-1.2 0-2.1-.9-2.1-2.1Z" />
        </svg>
      );
    case 'ollama':
      return (
        <svg viewBox="0 0 36 36" role="img">
          <path d="M13 9.5 10.8 6 9.4 12.2A10.6 10.6 0 0 0 7 19c0 6 4.9 10 11 10s11-4 11-10c0-2.6-.9-4.9-2.4-6.8L25.2 6 23 9.5A12 12 0 0 0 18 8.4c-1.8 0-3.5.4-5 1.1Z" />
          <circle cx="14.2" cy="18" r="1.5" fill="#fff" opacity=".9" />
          <circle cx="21.8" cy="18" r="1.5" fill="#fff" opacity=".9" />
        </svg>
      );
  }
}

function AddProviderForm(props: {
  bridge: ConnectionsBridge;
  providerType: ProviderType;
  existingSlugs: string[];
  onCancel(): void;
  onCreated(slug: string): Promise<void>;
}) {
  const defaults = PROVIDER_DEFAULTS[props.providerType];
  const display = providerDisplay(props.providerType);
  const [slug, setSlug] = useState(() => nextSlug(props.providerType, props.existingSlugs));
  const [name, setName] = useState(display.name);
  const [baseUrl, setBaseUrl] = useState(defaults.baseUrl);
  const [defaultModel, setDefaultModel] = useState(defaults.fallbackModels[0] ?? '');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const requiresBaseUrl = !defaults.baseUrl;
  const isExperimental = defaults.status === 'phase3-experimental';

  async function submit() {
    setError(null);
    const slugError = validateSlug(slug);
    if (slugError) return setError(slugError);
    if (props.existingSlugs.includes(slug)) return setError('Slug 已存在');
    if (requiresBaseUrl && !baseUrl.trim()) return setError('这个供应商需要填写 Base URL');
    if (isExperimental) return setError('OAuth 订阅登录即将推出');
    setBusy(true);
    try {
      const connection = await props.bridge.create({
        slug,
        name: name || display.name,
        providerType: props.providerType,
        baseUrl: baseUrl || undefined,
        defaultModel,
      });
      await props.onCreated(connection.slug);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="providerEditor">
      <header>
        <div>
          <h3>{isExperimental ? 'OAuth 订阅登录即将推出' : `添加 ${display.name}`}</h3>
          <p>{display.description}</p>
        </div>
        <span className="settingsBadge">{categoryLabel(defaults.category)}</span>
      </header>
      {isExperimental && (
        <div className="providerComingSoon">
          <strong>即将推出</strong>
          <span>这类供应商会通过官方 SDK 或 CLI 完成 OAuth 登录。当前可先使用同一家厂商的 API key 接入。</span>
        </div>
      )}
      <label>
        <span>Slug</span>
        <input value={slug} onChange={(event) => setSlug(event.currentTarget.value)} placeholder="my-provider" disabled={isExperimental} />
      </label>
      <label>
        <span>显示名称</span>
        <input value={name} onChange={(event) => setName(event.currentTarget.value)} placeholder={display.name} disabled={isExperimental} />
      </label>
      <label>
        <span>Base URL {requiresBaseUrl ? '(required)' : ''}</span>
        <input
          value={baseUrl}
          onChange={(event) => setBaseUrl(event.currentTarget.value)}
          placeholder={defaults.baseUrl || 'https://…'}
          disabled={isExperimental}
        />
      </label>
      <label>
        <span>默认模型</span>
        <input
          value={defaultModel}
          onChange={(event) => setDefaultModel(event.currentTarget.value)}
          placeholder={defaults.fallbackModels[0] || 'model-id'}
          disabled={isExperimental}
        />
      </label>
      {error && <p className="providerError">{error}</p>}
      <div className="providerActions">
        <button className="maka-button" type="button" onClick={props.onCancel}>取消</button>
        <button className="maka-button" data-variant="primary" type="button" disabled={busy || isExperimental} onClick={submit}>
          {busy ? '保存中…' : '保存供应商'}
        </button>
      </div>
    </div>
  );
}

function ConnectionDetail(props: {
  bridge: ConnectionsBridge;
  connection: LlmConnection;
  isDefault: boolean;
  onChanged(): Promise<void>;
  onDeleted(): Promise<void>;
}) {
  const { connection } = props;
  const defaults = PROVIDER_DEFAULTS[connection.providerType];
  const display = providerDisplay(connection.providerType);
  const [apiKey, setApiKey] = useState('');
  const [hasSecret, setHasSecret] = useState(defaults.authKind === 'none');
  const [baseUrl, setBaseUrl] = useState(connection.baseUrl ?? defaults.baseUrl);
  const [defaultModel, setDefaultModel] = useState(connection.defaultModel);
  const [models, setModels] = useState<ModelInfo[]>(connection.models ?? []);
  // Track the model-list source explicitly instead of inferring from array
  // length, per @kenji's review of PR73: "等 @xuan 后端不再 silent fallback
  // 后，UI 的 fetched/fallback source 标记要以 backend 返回 source 或实际
  // 错误分支为准，别只按数组非空判断." A successful fetch that legitimately
  // returns 0 models is still 'fetched'; a failed fetch leaves the source
  // at 'fallback'. Persisted models on mount are assumed 'fetched' (they
  // were written by a previous successful fetch via `connections.update`).
  const [modelSource, setModelSource] = useState<'fetched' | 'fallback'>(
    (connection.models?.length ?? 0) > 0 ? 'fetched' : 'fallback',
  );
  const [busy, setBusy] = useState(false);
  const [testing, setTesting] = useState(false);
  const [fetchingModels, setFetchingModels] = useState(false);
  const toast = useToast();

  useEffect(() => {
    if (defaults.authKind === 'none') {
      setHasSecret(true);
      return;
    }
    void props.bridge.hasSecret(connection.slug).then(setHasSecret);
  }, [props.bridge, connection.slug, defaults.authKind]);

  const fallbackModels = defaults.fallbackModels;
  // Picker entries: when source is 'fetched', use the fetched list verbatim
  // (even if empty — that's the truthful state and the small empty-state
  // hint below tells the user). When 'fallback', merge fallback IDs in so
  // the dropdown isn't empty before first save / fetch.
  const modelChoices =
    modelSource === 'fetched' || models.length > 0
      ? models
      : fallbackModels.map((id) => ({ id }));
  const needsSecret = defaults.authKind !== 'none';

  async function save() {
    setBusy(true);
    try {
      await props.bridge.update(connection.slug, {
        baseUrl: baseUrl || undefined,
        defaultModel,
        ...(apiKey ? { apiKey } : {}),
      });
      const wroteNewKey = apiKey.length > 0;
      setApiKey('');
      const nextHasSecret = needsSecret ? await props.bridge.hasSecret(connection.slug) : true;
      setHasSecret(nextHasSecret);
      await props.onChanged();
      // Auto-fetch live model list as soon as the secret is in place. Without
      // this, the user lands on a Settings · 模型 row whose `defaultModel`
      // dropdown only contains the static fallback list (e.g. Z.ai → just
      // glm-4.7 / 4.6 / 4.5), which looks like Maka doesn't support newer
      // models. Auto-fetch on save closes that gap.
      if (nextHasSecret && (wroteNewKey || models.length === 0)) {
        void refreshModels({ silent: true });
      }
    } finally {
      setBusy(false);
    }
  }

  async function runTest() {
    setTesting(true);
    try {
      const result: ConnectionTestResult = await props.bridge.test(connection.slug, { model: defaultModel });
      if (result.ok) {
        toast.success(
          `连接成功 · ${connection.name}`,
          `${result.modelTested} · ${result.latencyMs} ms`,
        );
      } else {
        toast.error(
          `连接失败 · ${connection.name}`,
          result.errorMessage || '检查 API key、Base URL 或代理设置后重试。',
        );
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      toast.error(`连接测试出错 · ${connection.name}`, message);
    } finally {
      setTesting(false);
    }
  }

  async function refreshModels(opts: { silent?: boolean } = {}) {
    setFetchingModels(true);
    try {
      // Once xuan's backend patch lands, a failed live `/models` probe will
      // throw with a generalizedErrorMessage (auth / timeout / network /
      // provider unavailable) rather than silently substituting the static
      // fallback list. Until then we still defensively handle the throw
      // case here so the UI is correct once the backend flips.
      const result = await props.bridge.fetchModels(connection.slug);
      const list = result.models;
      setModels(list);
      // Mark as fetched even if list.length === 0. A provider that returned
      // an empty model list is a meaningful signal — the user should see
      // "0 fetched" rather than the static fallback being silently
      // substituted.
      setModelSource(result.source);
      await props.bridge.update(connection.slug, { models: list });
      await props.onChanged();
      if (!opts.silent) {
        toast.success(`已拉取 ${list.length} 个模型 · ${connection.name}`);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // Leave the previously-known source / models intact (so the dropdown
      // doesn't suddenly empty out), but ensure the source label downgrades
      // back to 'fallback' if we have nothing fresh to show.
      if (models.length === 0) setModelSource('fallback');
      toast.error(
        `拉取模型失败 · ${connection.name}`,
        `${message} · 当前继续显示静态列表，请确认 API key / Base URL / 代理设置后重试。`,
      );
    } finally {
      setFetchingModels(false);
    }
  }

  async function setAsDefault() {
    await props.bridge.setDefault(connection.slug);
    await props.onChanged();
  }

  async function remove() {
    if (!confirm(`删除供应商 "${connection.name}"？`)) return;
    await props.bridge.delete(connection.slug);
    await props.onDeleted();
  }

  return (
    <div className="providerEditor">
      <header>
        <div>
          <h3>{connection.name}</h3>
          <p>{display.name}</p>
        </div>
        <span className="providerHeaderBadges">
          {props.isDefault && <span className="settingsBadge">默认</span>}
          <span className="settingsBadge">{categoryLabel(defaults.category)}</span>
        </span>
      </header>
      <label>
        <span>Slug</span>
        <input value={connection.slug} disabled />
      </label>
      <label>
        <span>Base URL</span>
        <input
          value={baseUrl}
          onChange={(event) => setBaseUrl(event.currentTarget.value)}
          placeholder={defaults.baseUrl}
        />
      </label>
      {needsSecret && (
        <label>
          <span>API key {hasSecret ? '（已设置，粘贴新值可替换）' : ''}</span>
          <input
            type="password"
            value={apiKey}
            onChange={(event) => setApiKey(event.currentTarget.value)}
            placeholder={hasSecret ? '••••••••' : '粘贴 API key'}
          />
        </label>
      )}
      <label>
        <span>默认模型</span>
        <div className="providerModelRow">
          <select value={defaultModel} onChange={(event) => setDefaultModel(event.currentTarget.value)}>
            {modelChoices.map((model) => (
              <option key={model.id} value={model.id}>{model.id}</option>
            ))}
          </select>
          <button
            className="maka-button"
            type="button"
            disabled={fetchingModels || (needsSecret && !hasSecret)}
            onClick={() => void refreshModels()}
          >
            {fetchingModels ? '拉取中…' : '从 API 刷新'}
          </button>
        </div>
        <small className="providerModelSource" data-source={modelSource}>
          {modelSource === 'fetched'
            ? models.length > 0
              ? `实时拉取的 ${models.length} 个模型（最新一次成功）`
              : '已成功调用 provider，但返回 0 个模型 — 该 provider 可能未对当前 API key 开放任何模型，请检查账户/方案。'
            : `静态备用列表（${fallbackModels.length} 项）。点「从 API 刷新」拉取该 provider 的真实模型清单。`}
        </small>
      </label>
      {defaults.signupUrl && (
        <a className="providerExternalLink" href={defaults.signupUrl} target="_blank" rel="noreferrer">
          获取 API key
        </a>
      )}
      <div className="providerActions">
        <button className="maka-button" data-variant="primary" type="button" disabled={busy} onClick={save}>
          {busy ? '保存中…' : '保存修改'}
        </button>
        <button className="maka-button" type="button" disabled={testing || (needsSecret && !hasSecret)} onClick={runTest}>
          {testing ? '测试中…' : '测试连接'}
        </button>
        {!props.isDefault && <button className="maka-button" type="button" onClick={setAsDefault}>设为默认</button>}
        <button className="maka-button" data-variant="destructive" type="button" onClick={remove}>删除</button>
      </div>
    </div>
  );
}

export function providerDisplay(type: ProviderType): { name: string; description: string; badge?: string } {
  switch (type) {
    case 'anthropic':
      return { name: 'Anthropic', description: 'Claude API key，适合生产级 Agent。', badge: 'API' };
    case 'kimi-coding-plan':
      return { name: 'Kimi Coding Plan', description: 'Kimi for Coding，兼容 Anthropic 协议。', badge: 'Coding' };
    case 'openai':
      return { name: 'OpenAI', description: 'GPT / Responses API 模型，使用 API key 接入。', badge: 'API' };
    case 'google':
      return { name: 'Google Gemini', description: 'Google AI Studio API key 接入。', badge: 'API' };
    case 'deepseek':
      return { name: 'DeepSeek', description: 'DeepSeek Chat / Reasoner 系列模型。', badge: 'API' };
    case 'moonshot':
      return { name: 'Moonshot', description: 'Moonshot Kimi API key 接入。', badge: 'API' };
    case 'zai-coding-plan':
      return { name: 'Z.AI Coding Plan', description: 'GLM Coding Plan，OpenAI-compatible 协议。', badge: 'Coding' };
    case 'ollama':
      return { name: 'Ollama', description: '连接本机 localhost 的 Ollama 模型。', badge: 'Local' };
    case 'openai-compatible':
      return { name: 'OpenAI Compatible', description: '中转站、代理服务或自部署网关。', badge: 'Custom' };
    case 'claude-subscription':
      return { name: 'Claude Subscription', description: 'Claude Pro / Max 订阅登录，后续支持。', badge: 'Soon' };
    case 'codex-subscription':
      return { name: 'Codex Subscription', description: 'ChatGPT / Codex 订阅登录，后续支持。', badge: 'Soon' };
    case 'gemini-cli':
      return { name: 'Gemini CLI', description: 'Google 账号 OAuth 登录，后续支持。', badge: 'Soon' };
  }
}

function categoryLabel(category: ProviderCategory): string {
  switch (category) {
    case 'oauth': return 'OAuth';
    case 'domestic': return '国内';
    case 'overseas': return '海外';
    case 'local': return '本地';
    case 'custom': return 'Custom';
  }
}

function nextSlug(type: ProviderType, existing: string[]): string {
  const base = type.replace(/[^a-z0-9-]/g, '-');
  if (!existing.includes(base)) return base;
  for (let i = 2; i < 100; i += 1) {
    const candidate = `${base}-${i}`;
    if (!existing.includes(candidate)) return candidate;
  }
  return `${base}-${Date.now()}`;
}
