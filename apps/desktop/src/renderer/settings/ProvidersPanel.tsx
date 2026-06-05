import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode, type RefObject } from 'react';
import { X } from 'lucide-react';
import { nextRadioId } from './model-table-keyboard';
import {
  CATALOG_PROVIDER_TYPES,
  PROVIDER_DEFAULTS,
  generalizedErrorMessageChinese,
  redactSecrets,
  validateSlug,
  type ConnectionTestResult,
  type CreateConnectionInput,
  type LlmConnection,
  type ModelDiscoveryResult,
  type ModelInfo,
  type ProviderCategory,
  type ProviderType,
  type SubscriptionAccountState,
  type UpdateConnectionInput,
} from '@maka/core';
import { RelativeTime, useToast, useModalA11y } from '@maka/ui';
import { formatRelativeTimestamp } from '@maka/core';
import { PasswordInput } from './password-input';

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
  subscribeEvents?(handler: () => void): () => void;
}

type CatalogTab = Extract<ProviderCategory, 'domestic' | 'overseas' | 'local' | 'oauth'>;
type CredentialPresenceStatus = boolean | 'loading' | 'error';

const CATALOG_TABS: Array<{ id: CatalogTab; label: string }> = [
  { id: 'domestic', label: '国内' },
  { id: 'overseas', label: '海外' },
  { id: 'local', label: '本地' },
  { id: 'oauth', label: 'OAuth' },
];

/**
 * "（5 分钟前拉取）" style suffix for the model-source label.
 * Delegates to the shared `@maka/core/relative-time` helper so the
 * format matches the sidebar's MessageMeta and every other Settings
 * surface. Returns an empty string when no timestamp is available
 * (e.g. legacy connections from before `modelsFetchedAt` was
 * persisted by backend `94b482b`).
 */
function formatFetchedAtSuffix(modelsFetchedAt: number | undefined): string {
  if (modelsFetchedAt === undefined) return '';
  return `（${formatRelativeTimestamp(modelsFetchedAt)}拉取）`;
}

function providerPanelActionErrorMessage(error: unknown): string {
  return generalizedErrorMessageChinese(error, '模型连接服务暂时不可用，请稍后重试。');
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
  if (result.errorClass === 'network') return '网络错误，请检查 Base URL 或代理设置后重试。';
  return `检查 ${troubleshootingCopy} 后重试。`;
}

export function ProvidersPanel({ bridge }: { bridge: ConnectionsBridge }) {
  const [connections, setConnections] = useState<LlmConnection[]>([]);
  const [defaultSlug, setDefaultSlug] = useState<string | null>(null);
  const [selectedSlug, setSelectedSlug] = useState<string | null>(null);
  const [addingType, setAddingType] = useState<ProviderType | null>(null);
  const [catalogTab, setCatalogTab] = useState<CatalogTab>('domestic');
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const toast = useToast();

  function onCatalogTabsKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    const visibleTabs = CATALOG_TABS.map((tab) => tab.id);
    const next = nextRadioId(catalogTab, visibleTabs, event.key) as CatalogTab | null;
    if (next === null || next === catalogTab) return;
    event.preventDefault();
    setCatalogTab(next);
    const tablist = event.currentTarget;
    window.setTimeout(() => {
      tablist
        .querySelector<HTMLButtonElement>(`button[data-catalog-tab="${CSS.escape(next)}"]`)
        ?.focus({ preventScroll: true });
    }, 0);
  }

  async function reload() {
    try {
      const [list, defaultConnection] = await Promise.all([
        bridge.list(),
        bridge.getDefault(),
      ]);
      setConnections(list);
      setDefaultSlug(defaultConnection);
      setLoadError(null);
      setLoading(false);
      setSelectedSlug((current) =>
        current && list.some((connection) => connection.slug === current)
          ? current
          : null,
      );
    } catch (error) {
      const message = providerPanelActionErrorMessage(error);
      setLoadError(message);
      setLoading(false);
      toast.error('载入模型连接失败', message);
    }
  }

  useEffect(() => {
    void reload();
    const unsubscribe = bridge.subscribeEvents?.(() => {
      void reload();
    });
    return () => {
      unsubscribe?.();
    };
  }, [bridge]);

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

  function chipStatusText(connection: LlmConnection): string {
    if (!connection.enabled) return '已禁用';
    switch (connection.lastTestStatus) {
      case 'verified':
        // PR-UI-AUDIT-1 (@kenji msg 7a16aa0b): `verified` is a
        // credential-validation result only; it does NOT prove
        // agent send / stream / interrupt paths are operational
        // (provider-auth contract Path 17 S11 D1 lock). Older copy
        // "已验证可用" conflated validation with operational
        // readiness — fixed to credential-only language. Matches
        // the doc warning at SettingsModal `验证通过 ≠ 运行可用`.
        return '凭据已验证';
      case 'needs_reauth':
        return '需要重新登录';
      case 'error':
        return '上次连接失败';
      default:
        return '等待验证';
    }
  }

  function chipTitle(connection: LlmConnection): string {
    return `${connection.name} · ${chipStatusText(connection)}`;
  }

  function chipAriaLabel(connection: LlmConnection): string {
    const provider = providerDisplay(connection.providerType).name;
    const defaultSuffix = connection.slug === defaultSlug ? '，默认连接' : '';
    return `已启用模型：${connection.name}，供应商：${provider}${defaultSuffix}，${chipStatusText(connection)}`;
  }

  const configuredByType = (type: ProviderType) =>
    connections.filter((connection) => connection.providerType === type).length;

  if (loading) {
    return (
      <div className="providersPanel providersLoading" aria-busy="true" aria-label="正在加载模型供应商">
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
        <div className="enabledStrip" aria-label="已启用的模型供应商">
          <div className="enabledStripHeader">
            <h3>已启用模型</h3>
            {connections.length > 0 && <span>{connections.length} 个配置</span>}
          </div>
          {loadError ? (
            <button className="enabledEmptyChip" type="button" onClick={() => void reload()}>
              <strong>模型连接载入失败</strong>
              <small>{loadError} · 点击重试。</small>
            </button>
          ) : connections.length === 0 ? (
            <button className="enabledEmptyChip" type="button" onClick={() => startAdd('zai-coding-plan')}>
              <strong>等待添加供应商</strong>
              <small>从下面选择一个开始配置。</small>
            </button>
          ) : connections.map((connection) => (
              <button
                key={connection.slug}
                type="button"
                className="enabledProviderChip"
                data-default={connection.slug === defaultSlug}
                data-test-status={connection.lastTestStatus ?? 'untested'}
                data-disabled={connection.enabled ? undefined : 'true'}
                aria-label={chipAriaLabel(connection)}
                onClick={() => {
                  setSelectedSlug(connection.slug);
                  setAddingType(null);
                }}
                title={chipTitle(connection)}
              >
                <ProviderLogo type={connection.providerType} compact />
                <span>
                  <strong>{connection.name}</strong>
                  <small>{providerDisplay(connection.providerType).name}</small>
                </span>
                <span className="enabledProviderChipStatus" aria-hidden="true" />
              </button>
            ))
          }
        </div>

        <div className="providerMarketHeader">
          <div>
            <h3>模型供应商</h3>
            <p>选择 API Key 服务、本地模型、OAuth 账号登录，或自定义 OpenAI 兼容接口。</p>
          </div>
          <button className="maka-button" type="button" onClick={() => startAdd('openai-compatible')}>
            自定义
          </button>
        </div>

        <div
          className="catalogTabs catalogPillTabs"
          role="tablist"
          aria-label="模型供应商分类"
          onKeyDown={onCatalogTabsKeyDown}
        >
          {CATALOG_TABS.map((tab) => (
            <button
              key={tab.id}
              type="button"
              role="tab"
              aria-selected={catalogTab === tab.id}
              data-active={catalogTab === tab.id}
              data-catalog-tab={tab.id}
              tabIndex={catalogTab === tab.id ? 0 : -1}
              onClick={() => setCatalogTab(tab.id)}
            >
              <strong>{tab.label}</strong>
            </button>
          ))}
        </div>

        {catalogTab === 'oauth' ? (
          <ModelOAuthSection onConnectionsChanged={reload} />
        ) : (
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
        )}

        <div className="customProviderEntry">
          <div>
            <h3>自定义供应商</h3>
            <p>接入中转站、代理服务，或自部署的 OpenAI 兼容接口。</p>
          </div>
          {customProviders.map((type) => (
            <button key={type} type="button" onClick={() => startAdd(type)}>
              添加 OpenAI 兼容接口
            </button>
          ))}
        </div>
      </section>

      {(addingType || selected) && (
        <ProviderConfigSheetOverlay
          onClose={() => {
            setAddingType(null);
            setSelectedSlug(null);
          }}
        >
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
        </ProviderConfigSheetOverlay>
      )}
    </div>
  );
}

/**
 * Modal overlay + sheet for the provider config sub-flow. Wraps
 * `useModalA11y` so:
 *  - Tab/Shift+Tab cycles focus inside the sheet (no leak to sidebar)
 *  - Initial focus lands on the first interactive element
 *  - Esc closes the sheet (matches the overlay click-to-close)
 *  - Focus restoration to the previously-focused element on close
 *
 * Without this hook the sheet had `role="dialog"` + `aria-modal="true"`
 * but no actual focus trap or keyboard-dismiss path — a screen reader
 * user couldn't navigate the sheet predictably.
 */
function ProviderConfigSheetOverlay(props: { onClose(): void; children: ReactNode }) {
  const dialogRef = useRef<HTMLElement>(null);
  useModalA11y(dialogRef, props.onClose);
  useProviderSheetBackgroundInert(dialogRef);
  return (
    <div className="providerConfigOverlay" role="presentation" onMouseDown={props.onClose}>
      <section
        ref={dialogRef as RefObject<HTMLDivElement>}
        className="providerConfigSheet"
        role="dialog"
        aria-modal="true"
        aria-label="模型供应商配置"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <button
          type="button"
          className="providerConfigSheetClose"
          aria-label="关闭模型配置"
          onClick={props.onClose}
        >
          <X strokeWidth={1.75} aria-hidden="true" />
        </button>
        {props.children}
      </section>
    </div>
  );
}

function useProviderSheetBackgroundInert(dialogRef: RefObject<HTMLElement | null>) {
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    const surface = dialog.closest('.settingsSurface');
    if (!(surface instanceof HTMLElement)) return;

    const changed: Array<{
      element: HTMLElement;
      ariaHidden: string | null;
      inert: boolean;
      marker: string | null;
    }> = [];
    let current: HTMLElement | null = dialog;
    while (current && current !== surface) {
      const parent: HTMLElement | null = current.parentElement;
      if (!parent) break;
      for (const sibling of Array.from(parent.children)) {
        if (!(sibling instanceof HTMLElement) || sibling === current || sibling.contains(dialog)) continue;
        changed.push({
          element: sibling,
          ariaHidden: sibling.getAttribute('aria-hidden'),
          inert: sibling.inert,
          marker: sibling.getAttribute('data-provider-sheet-background-hidden'),
        });
        sibling.setAttribute('aria-hidden', 'true');
        sibling.inert = true;
        sibling.setAttribute('data-provider-sheet-background-hidden', 'true');
      }
      current = parent;
    }

    return () => {
      for (const item of changed.reverse()) {
        if (item.ariaHidden === null) item.element.removeAttribute('aria-hidden');
        else item.element.setAttribute('aria-hidden', item.ariaHidden);
        item.element.inert = item.inert;
        if (item.marker === null) item.element.removeAttribute('data-provider-sheet-background-hidden');
        else item.element.setAttribute('data-provider-sheet-background-hidden', item.marker);
      }
    };
  }, [dialogRef]);
}

function ProviderCatalogCard(props: { type: ProviderType; count: number; onSelect(): void }) {
  const defaults = PROVIDER_DEFAULTS[props.type];
  const display = providerDisplay(props.type);
  const disabled = defaults.status !== 'ready';
  const disabledStatus = providerDisabledStatus(props.type);
  const title = disabled ? providerDisabledTitle(props.type) : `添加 ${display.name}`;

  if (disabled) {
    return (
      <div
        className="providerCatalogCard"
        data-provider={props.type}
        data-status={disabledStatus}
        aria-label={providerDisabledAriaLabel(props.type, display.name)}
        title={title}
      >
        <ProviderLogo type={props.type} />
        <span className="providerCatalogCopy">
          <span className="providerCatalogTitle">
            <strong>{display.name}</strong>
          </span>
          <small>{display.description}</small>
        </span>
      </div>
    );
  }

  return (
    <button
      className="providerCatalogCard"
      data-provider={props.type}
      data-status="ready"
      type="button"
      aria-label={providerCatalogAriaLabel(display, props.count)}
      title={title}
      onClick={props.onSelect}
    >
      <ProviderLogo type={props.type} />
      <span className="providerCatalogCopy">
        <span className="providerCatalogTitle">
          <strong>{display.name}</strong>
          {display.badge && <em>{display.badge}</em>}
        </span>
        <small>{display.description}</small>
        {props.count > 0 && <span className="providerCatalogCount">已配置 {props.count} 个</span>}
      </span>
    </button>
  );
}

function providerDisabledStatus(type: ProviderType): 'unavailable' | 'experimental' {
  return isWiredOAuthProvider(type) ? 'experimental' : 'unavailable';
}

function providerDisabledTitle(type: ProviderType): string {
  if (isWiredOAuthProvider(type)) {
    return '请在 OAuth 分类完成账号登录；登录成功后会自动出现在已启用模型。';
  }
  return '该账号登录暂未接入聊天发送；当前请使用同一家厂商的 API key。';
}

function providerDisabledAriaLabel(type: ProviderType, name: string): string {
  if (isWiredOAuthProvider(type)) return `${name}（请从 OAuth 分类登录）`;
  return `${name}（账号登录暂未接入聊天发送）`;
}

function providerCatalogAriaLabel(display: ReturnType<typeof providerDisplay>, count: number): string {
  const parts = [`添加模型供应商：${display.name}`];
  if (display.badge) parts.push(`标签：${display.badge}`);
  parts.push(display.description.replace(/[。.!！？?]+$/u, ''));
  if (count > 0) parts.push(`已配置 ${count} 个`);
  return parts.join('，');
}

function isWiredOAuthProvider(type: ProviderType): boolean {
  return type === 'claude-subscription' || type === 'codex-subscription';
}

export function ProviderLogo(props: { type: ProviderType; compact?: boolean }) {
  return (
    <span className="providerLogo" data-provider={props.type} data-compact={props.compact ? 'true' : undefined} aria-hidden="true">
      <ProviderLogoMark type={props.type} />
    </span>
  );
}

/**
 * PR-MODEL-OAUTH-SECTION-0 / PR-MODEL-OAUTH-ALL-0 / PR-CLAUDE-CARD-MOVE-0:
 *
 * OAuth login catalog for Settings → 模型. It is rendered by the
 * same tab switcher as 国内 / 海外 / 本地, not as a standalone section
 * pinned above the provider market. All account providers render as
 * equal-size cards; richer provider-specific controls live in the
 * modal opened from that card.
 */
type OAuthCardId = 'claude' | 'codex' | 'antigravity' | 'cursor';
type OAuthServiceId = OAuthCardId;
type BrowserOAuthServiceId = Exclude<OAuthServiceId, 'claude'>;

interface ModelOAuthCard {
  id: OAuthCardId;
  name: string;
  accent: string;
  description: string;
  status: 'available';
  statusLabel: string;
}

const MODEL_OAUTH_CARDS: ReadonlyArray<ModelOAuthCard> = [
  {
    id: 'claude',
    name: 'Claude Code',
    accent: '#D97757',
    description: '用 Claude Pro / Max 订阅给 Claude Code / Claude OAuth 模型。',
    status: 'available',
    statusLabel: '可用',
  },
  {
    id: 'codex',
    name: 'OpenAI Codex',
    accent: '#10A37F',
    description: '用 ChatGPT Plus / Pro 订阅给 OpenAI Codex / GPT-5 等模型。',
    status: 'available',
    statusLabel: '可用',
  },
  {
    id: 'antigravity',
    name: 'Google Antigravity',
    accent: '#4285F4',
    description: '用 Google 账号给 Gemini 系列模型。',
    status: 'available',
    statusLabel: '预览',
  },
  {
    id: 'cursor',
    name: 'Cursor',
    accent: '#000000',
    description: '用 Cursor 订阅给本机 OpenAI 兼容代理。',
    status: 'available',
    statusLabel: '可用',
  },
];

function ModelOAuthSection(props: { onConnectionsChanged(): Promise<void> }) {
  const [openModal, setOpenModal] = useState<OAuthServiceId | null>(null);
  const toast = useToast();
  // PR-OAUTH-CARD-LIVE-STATE-0 (WAWQAQ msg d79fd115 follow-up):
  // before this lift the 3 button cards stayed at the static
  // "可用 / 预览" label even after the user finished the OAuth
  // flow in the modal — there was no parent re-fetch. We now
  // track a runtimeState + email per service so each card can
  // show "已登录" / the account email inline, and we re-fetch
  // every time the modal closes (success OR cancel — the user
  // may have logged out from inside the modal).
  const [cardStates, setCardStates] = useState<Record<OAuthServiceId, SubscriptionSnapshot | null>>({
    claude: null,
    codex: null,
    cursor: null,
    antigravity: null,
  });
  const [cardRefreshError, setCardRefreshError] = useState<string | null>(null);

  async function refreshAllCards() {
    const results = await Promise.all(
      MODEL_OAUTH_CARDS.map(async (card) => {
        try {
          const snapshot = await getSubscriptionSnapshot(card.id);
          return { id: card.id, snapshot } as const;
        } catch (error) {
          return { id: card.id, error } as const;
        }
      }),
    );
    const failures = results.filter((result) => 'error' in result);
    setCardStates((prev) => {
      const next = { ...prev };
      for (const result of results) {
        if ('snapshot' in result && result.snapshot !== undefined) next[result.id] = result.snapshot;
      }
      return next;
    });
    if (failures.length > 0) {
      const firstFailure = failures[0];
      const message = firstFailure && 'error' in firstFailure
        ? subscriptionActionErrorMessage(firstFailure.error)
        : '登录服务暂时不可用，请检查网络后重试。';
      setCardRefreshError(message);
      toast.error('刷新 OAuth 登录状态失败', message);
      return false;
    }
    setCardRefreshError(null);
    return true;
  }

  async function refreshAfterModalClose() {
    await refreshAllCards();
    try {
      await props.onConnectionsChanged();
    } catch (error) {
      toast.error('刷新已启用模型失败', subscriptionActionErrorMessage(error));
    }
  }

  useEffect(() => {
    void refreshAllCards();
  }, []);

  return (
    <div className="providerOAuthCatalog" aria-label="OAuth 登录" data-provider-category="oauth">
      {cardRefreshError && (
        <div className="providerOAuthError" role="alert">
          OAuth 登录状态暂时没刷新成功，已保留上一次状态。{cardRefreshError}
        </div>
      )}
      <div className="providerOAuthGrid">
        {MODEL_OAUTH_CARDS.map((card) => {
          const snapshot = cardStates[card.id];
          const runtimeState = snapshot?.runtimeState ?? 'unknown';
          const isLoggedIn =
            runtimeState === 'authenticated' ||
            runtimeState === 'refreshing' ||
            runtimeState === 'quota_unavailable' ||
            runtimeState === 'provider_rejected';
          const liveBadge = isLoggedIn ? '已登录' : card.statusLabel;
          const liveDescription = isLoggedIn && snapshot?.email
            ? snapshot.email
            : card.description;
          return (
            <button
              key={card.id}
              type="button"
              className="providerOAuthCard"
              data-card-id={card.id}
              data-status={card.status}
              data-logged-in={isLoggedIn ? 'true' : undefined}
              style={{ ['--oauth-accent' as string]: card.accent }}
              onClick={() => setOpenModal(card.id)}
            >
              <span className="providerOAuthCardBadge">{liveBadge}</span>
              <span className="providerOAuthCardName">{card.name}</span>
              <span className="providerOAuthCardDescription">{liveDescription}</span>
            </button>
          );
        })}
      </div>
      {openModal === 'claude' && (
        <ClaudeSubscriptionModal
          onClose={() => {
            setOpenModal(null);
            void refreshAfterModalClose();
          }}
        />
      )}
      {openModal !== null && openModal !== 'claude' && (
        <SubscriptionLoginModal
          serviceId={openModal}
          onClose={() => {
            setOpenModal(null);
            // Always re-fetch after the modal closes — the user may
            // have logged in, logged out, or cancelled.
            void refreshAfterModalClose();
          }}
        />
      )}
    </div>
  );
}

/**
 * Inline modal that drives a Codex / Cursor / Antigravity OAuth
 * flow against the matching `window.maka.<service>Subscription`
 * bridge. Mirrors the ClaudeSubscriptionCard pattern (Settings →
 * 账号) but does NOT expose a paste-code field — these flows are
 * loopback (Codex / Antigravity) or polling (Cursor) so the
 * browser handoff is enough.
 *
 * Tokens never enter the renderer; this component reads only
 * account-state snapshots returned by getAccountState().
 */
function ClaudeSubscriptionModal(props: { onClose(): void }) {
  const dialogRef = useRef<HTMLElement>(null);
  useModalA11y(dialogRef, props.onClose);
  useProviderSheetBackgroundInert(dialogRef);
  return (
    <div className="providerConfigOverlay" role="presentation" onMouseDown={props.onClose}>
      <section
        ref={dialogRef as RefObject<HTMLDivElement>}
        className="providerConfigSheet"
        role="dialog"
        aria-modal="true"
        aria-label="Claude Code 登录"
        data-subscription="claude"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="providerConfigHeader">
          <div>
            <h3>Claude Code</h3>
            <p>登录 Claude Pro / Max 后，会同步成已启用模型连接。</p>
          </div>
          <button
            type="button"
            className="maka-button"
            data-variant="ghost"
            onClick={props.onClose}
            aria-label="关闭"
          >
            ×
          </button>
        </header>
        <ClaudeSubscriptionCard />
      </section>
    </div>
  );
}

function SubscriptionLoginModal(props: { serviceId: BrowserOAuthServiceId; onClose(): void }) {
  const dialogRef = useRef<HTMLElement>(null);
  useModalA11y(dialogRef, props.onClose);
  useProviderSheetBackgroundInert(dialogRef);
  const toast = useToast();
  const bridge = pickSubscriptionBridge(props.serviceId);
  const [state, setState] = useState<SubscriptionSnapshot | null>(null);
  const [authRequestId, setAuthRequestId] = useState<string | null>(null);
  const [stateHint, setStateHint] = useState<string | null>(null);
  const [pendingAction, setPendingAction] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const display = subscriptionDisplay(props.serviceId);

  async function refresh() {
    try {
      const next = (await bridge.getAccountState()) as SubscriptionSnapshot;
      setState(next);
      setErrorMessage(null);
    } catch (error) {
      const message = subscriptionActionErrorMessage(error);
      toast.error('刷新登录状态失败', message);
      setErrorMessage(message);
    }
  }

  useEffect(() => {
    void refresh();
  }, []);

  // Cancel any pending authorization if the modal closes mid-flow.
  useEffect(() => {
    return () => {
      if (authRequestId) {
        void bridge.cancelAuthorization(authRequestId);
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authRequestId]);

  async function startLogin() {
    setPendingAction(true);
    setErrorMessage(null);
    try {
      const payload = await bridge.getAuthUrl();
      if ('ok' in payload) {
        const failureMessage = payload.ok ? '请稍后再试。' : subscriptionResultMessage(payload.message, '无法开始登录，请稍后再试。');
        toast.error('无法开始登录', failureMessage);
        setErrorMessage(failureMessage);
        return;
      }
      setAuthRequestId(payload.authRequestId);
      setStateHint(payload.stateHint);
      const opened = await bridge.openAuthUrl(payload.authRequestId);
      if (!opened.ok) {
        const message = subscriptionResultMessage(opened.message, '无法打开浏览器，请稍后重试。');
        toast.error('无法打开浏览器', message);
        setErrorMessage(message);
        setAuthRequestId(null);
        setStateHint(null);
        return;
      }
      await refresh();
      // Loopback / polling — wait for the backend to complete.
      const result = await bridge.completeAuthorization(payload.authRequestId);
      setAuthRequestId(null);
      setStateHint(null);
      if (result.ok) {
        toast.success('登录成功', `${display.name} 已绑定本机。`);
        await refresh();
      } else {
        const message = subscriptionResultMessage(result.message, '登录未完成，请重新打开浏览器授权。');
        toast.error('登录未完成', message);
        setErrorMessage(message);
      }
    } catch (error) {
      const message = subscriptionActionErrorMessage(error);
      toast.error('登录失败', message);
      setErrorMessage(message);
    } finally {
      setPendingAction(false);
    }
  }

  async function logout() {
    const ok = await toast.confirm({
      title: `退出 ${display.name} 登录？`,
      description: '将删除本机保存的订阅凭据，之后需要重新登录才能继续使用这些 OAuth 模型。',
      confirmLabel: '退出登录',
      cancelLabel: '取消',
      destructive: true,
    });
    if (!ok) return;
    setPendingAction(true);
    try {
      const result = await bridge.logout();
      if (result.ok) {
        toast.success('已退出登录', '本地凭据已清除。');
        await refresh();
      } else {
        toast.error('退出失败', subscriptionResultMessage(result.message, '退出登录失败，请稍后重试。'));
      }
    } catch (error) {
      toast.error('退出失败', subscriptionActionErrorMessage(error));
    } finally {
      setPendingAction(false);
    }
  }

  const runtimeState = state?.runtimeState ?? 'loading';
  const isLoggedIn = runtimeState === 'authenticated' || runtimeState === 'refreshing';

  return (
    <div className="providerConfigOverlay" role="presentation" onMouseDown={props.onClose}>
      <section
        ref={dialogRef as RefObject<HTMLDivElement>}
        className="providerConfigSheet"
        role="dialog"
        aria-modal="true"
        aria-label={`${display.name} 登录`}
        data-subscription={props.serviceId}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="providerConfigHeader">
          <div>
            <h3>{display.name}</h3>
            <p>{display.detail}</p>
          </div>
          <button
            type="button"
            className="maka-button"
            data-variant="ghost"
            onClick={props.onClose}
            aria-label="关闭"
          >
            ×
          </button>
        </header>
        <div className="settingsConnectionRow" data-status={runtimeState}>
          <p className="settingsConnectionDetail">
            {presentSnapshotDetail(state, display)}
          </p>
          {stateHint && (
            <small>提示：state 以 <code>{stateHint}</code> 开头。</small>
          )}
          {errorMessage && (
            <small className="settingsErrorText">{errorMessage}</small>
          )}
          <div className="settingsConnectionActions">
            {!isLoggedIn ? (
              <button
                type="button"
                className="maka-button"
                data-variant="primary"
                onClick={() => void startLogin()}
                disabled={pendingAction}
              >
                {pendingAction ? '等待浏览器…' : `登录 ${display.shortName}`}
              </button>
            ) : (
              <button
                type="button"
                className="maka-button"
                data-variant="ghost"
                onClick={() => void logout()}
                disabled={pendingAction}
              >
                退出登录
              </button>
            )}
          </div>
        </div>
      </section>
    </div>
  );
}

interface SubscriptionSnapshot {
  runtimeState:
    | 'not_logged_in'
    | 'authorizing'
    | 'authenticated'
    | 'refreshing'
    | 'refresh_failed'
    | 'storage_failed'
    | 'quota_unavailable'
    | 'provider_rejected';
  email?: string;
  plan?: string;
  status?: 'preview';
  errorMessage?: string;
}

interface SubscriptionBridge {
  getAuthUrl(): Promise<
    { authRequestId: string; stateHint: string } | { ok: boolean; reason?: string; message: string }
  >;
  openAuthUrl(authRequestId: string): Promise<{ ok: true } | { ok: false; reason: string; message: string }>;
  completeAuthorization(authRequestId: string): Promise<{ ok: true } | { ok: false; reason: string; message: string }>;
  cancelAuthorization(authRequestId?: string): Promise<{ ok: true }>;
  getAccountState(): Promise<unknown>;
  logout(): Promise<{ ok: true } | { ok: false; reason: string; message: string }>;
}

function subscriptionActionErrorMessage(error: unknown): string {
  const message = error instanceof Error
    ? error.message
    : typeof error === 'string'
      ? error
      : '';
  return subscriptionResultMessage(message, '登录服务暂时不可用，请检查网络后重试。');
}

function subscriptionResultMessage(message: string | undefined, fallback: string): string {
  const raw = redactSecrets(message ?? '').trim();
  if (!raw) return fallback;
  const classified = generalizedErrorMessageChinese(new Error(raw), '');
  if (classified) return classified;
  return /[\u4e00-\u9fff]/.test(raw) ? raw : fallback;
}

async function getSubscriptionSnapshot(serviceId: OAuthServiceId): Promise<SubscriptionSnapshot> {
  if (serviceId === 'claude') {
    const state = await window.maka.claudeSubscription.getAccountState();
    return {
      runtimeState: state.runtimeState,
      email: state.profile?.email,
      errorMessage: state.errorMessage,
    };
  }
  return (await pickSubscriptionBridge(serviceId).getAccountState()) as SubscriptionSnapshot;
}

function pickSubscriptionBridge(serviceId: BrowserOAuthServiceId): SubscriptionBridge {
  switch (serviceId) {
    case 'codex':
      return window.maka.codexSubscription as unknown as SubscriptionBridge;
    case 'cursor':
      return window.maka.cursorSubscription as unknown as SubscriptionBridge;
    case 'antigravity':
      return window.maka.antigravitySubscription as unknown as SubscriptionBridge;
  }
}

interface SubscriptionDisplay {
  name: string;
  shortName: string;
  detail: string;
}

function subscriptionDisplay(serviceId: BrowserOAuthServiceId): SubscriptionDisplay {
  switch (serviceId) {
    case 'codex':
      return {
        name: 'OpenAI Codex',
        shortName: 'Codex',
        detail: '点击下方按钮打开浏览器登录，授权完成后会自动回写到本机（127.0.0.1:1455）。',
      };
    case 'cursor':
      return {
        name: 'Cursor',
        shortName: 'Cursor',
        detail: '点击下方按钮打开浏览器登录；Maka 会自动等待 Cursor 后端确认凭据。',
      };
    case 'antigravity':
      return {
        name: 'Google Antigravity',
        shortName: 'Antigravity',
        // OAuth flow + token persistence + IPC handlers ARE wired
        // and tested; the only thing gating real login is the
        // Google client_id constant (the alma reference doesn't
        // expose it in the public plugin repo). When the user
        // clicks 登录 the service surfaces that exact reason via
        // its envelope, so this card-level copy stays factual
        // without claiming the whole thing is unimplemented.
        detail: '使用 Google 账号登录给 Gemini 模型。当前为预览状态：需要 Google client_id 后才能完成登录。',
      };
  }
  const _exhaustive: never = serviceId;
  return _exhaustive;
}

function presentSnapshotDetail(state: SubscriptionSnapshot | null, display: SubscriptionDisplay): string {
  if (!state) return '正在加载账号状态…';
  switch (state.runtimeState) {
    case 'not_logged_in':
      return `${display.name} 尚未登录。`;
    case 'authorizing':
      return '请在弹出的浏览器窗口完成登录。';
    case 'authenticated': {
      const parts = ['已登录'];
      if (state.email) parts.push(state.email);
      if (state.plan) parts.push(state.plan);
      return parts.join(' · ');
    }
    case 'refreshing':
      return '正在刷新访问令牌…';
    case 'refresh_failed':
      return subscriptionResultMessage(state.errorMessage, '令牌刷新失败，请重新登录。');
    case 'storage_failed':
      return subscriptionResultMessage(state.errorMessage, `${display.name} 本地凭据读取失败，请重新登录。`);
    case 'quota_unavailable':
    case 'provider_rejected':
      return subscriptionResultMessage(state.errorMessage, `${display.name} 已登录，但当前 provider 状态不可用。`);
  }
  const _exhaustive: never = state.runtimeState;
  return _exhaustive;
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
  const isWiredOAuth = isWiredOAuthProvider(props.providerType);

  async function submit() {
    setError(null);
    const slugError = validateSlug(slug);
    if (slugError) return setError(slugError);
    if (props.existingSlugs.includes(slug)) return setError('Slug 已存在');
    if (requiresBaseUrl && !baseUrl.trim()) return setError('这个供应商需要填写 Base URL');
    if (isExperimental) {
      return setError(isWiredOAuth
        ? '请到 OAuth 分类完成账号登录；登录成功后会自动创建模型连接。'
        : '该账号登录暂未接入聊天发送；请先使用同一家厂商的 API key。');
    }
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
      setError(providerPanelActionErrorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="providerEditor">
      <header>
        <div>
          <h3>{isExperimental && isWiredOAuth
            ? `${display.name} 通过 OAuth 登录`
            : isExperimental ? '账号登录暂未接入聊天发送' : `添加 ${display.name}`}</h3>
          <p>{display.description}</p>
        </div>
        <span className="settingsBadge">{categoryLabel(defaults.category)}</span>
      </header>
      {isExperimental && (
        <div className="providerUnavailableNotice">
          <strong>{isWiredOAuth ? '使用 OAuth 分类登录' : '账号登录暂未接入'}</strong>
          <span>{isWiredOAuth
            ? '不要在这里手动添加；请回到 OAuth 分类完成登录，Maka 会自动创建并刷新模型连接。'
            : '这类账号登录暂未接入聊天发送。当前请先使用同一家厂商的 API key。'}</span>
        </div>
      )}
      <label>
        <span>Slug</span>
        <input value={slug} onChange={(event) => setSlug(event.currentTarget.value)} placeholder="my-provider" disabled={isExperimental} aria-label="模型供应商 Slug" />
      </label>
      <label>
        <span>显示名称</span>
        <input value={name} onChange={(event) => setName(event.currentTarget.value)} placeholder={display.name} disabled={isExperimental} aria-label="模型供应商显示名称" />
      </label>
      <label>
        <span>Base URL {requiresBaseUrl ? '(required)' : ''}</span>
        <input
          value={baseUrl}
          onChange={(event) => setBaseUrl(event.currentTarget.value)}
          placeholder={defaults.baseUrl || 'https://…'}
          disabled={isExperimental}
          aria-label="模型供应商 Base URL"
        />
      </label>
      <label>
        <span>默认模型</span>
        <input
          value={defaultModel}
          onChange={(event) => setDefaultModel(event.currentTarget.value)}
          placeholder={defaults.fallbackModels[0] || 'model-id'}
          disabled={isExperimental}
          aria-label="模型供应商默认模型"
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
  const toast = useToast();
  const needsApiKey = defaults.authKind === 'api_key';
  const needsOAuth = defaults.authKind === 'oauth_token';
  const hasFixedOAuthBaseUrl = needsOAuth && Boolean(defaults.baseUrl);
  const requiresCredential = defaults.authKind !== 'none';
  const credentialProbePending = requiresCredential && (hasSecret === 'loading' || hasSecret === 'error');
  const hasUsableCredential = !requiresCredential || hasSecret === true;
  const credentialTroubleshootingCopy = needsOAuth
    ? 'OAuth 登录 / 代理设置'
    : 'API key / Base URL / 代理设置';
  const fallbackModels = defaults.fallbackModels;
  const savedBaseUrl = connection.baseUrl ?? defaults.baseUrl;
  const draftBaseUrl = hasFixedOAuthBaseUrl ? defaults.baseUrl : baseUrl;
  const hasSaveChanges =
    apiKey.length > 0 ||
    draftBaseUrl !== savedBaseUrl ||
    defaultModel !== connection.defaultModel;

  useEffect(() => {
    if (defaults.authKind === 'none') {
      setHasSecret(true);
      return;
    }
    setHasSecret('loading');
    void props.bridge
      .hasSecret(connection.slug)
      .then(setHasSecret)
      .catch((error) => {
        setHasSecret('error');
        toast.error('读取模型凭据状态失败', providerPanelActionErrorMessage(error));
      });
  }, [props.bridge, connection.slug, defaults.authKind, toast]);

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

  // Picker entries: when source is 'fetched', use the fetched list verbatim
  // (even if empty — that's the truthful state and the small empty-state
  // hint below tells the user). When 'fallback', merge fallback IDs in so
  // the dropdown isn't empty before first save / fetch.
  const modelChoices =
    modelSource === 'fetched' || models.length > 0
      ? models
      : fallbackModels.map((id) => ({ id }));

  async function save() {
    setBusy(true);
    let saved = false;
    try {
      await props.bridge.update(connection.slug, {
        baseUrl: hasFixedOAuthBaseUrl ? defaults.baseUrl : baseUrl || undefined,
        defaultModel,
        ...(apiKey ? { apiKey } : {}),
      });
      saved = true;
      const wroteNewKey = apiKey.length > 0;
      setApiKey('');
      const nextHasSecret = requiresCredential ? await props.bridge.hasSecret(connection.slug) : true;
      setHasSecret(nextHasSecret);
      await props.onChanged();
      // Auto-fetch live model list as soon as the secret is in place. Without
      // this, the user lands on a Settings · 模型 row whose `defaultModel`
      // dropdown only contains the static fallback list (e.g. Z.ai → just
      // glm-4.7 / 4.6 / 4.5), which looks like Maka doesn't support newer
      // models. Auto-fetch on save closes that gap.
      if (nextHasSecret && (wroteNewKey || (!needsApiKey && models.length === 0))) {
        void refreshModels({ silent: true });
      }
    } catch (error) {
      if (saved && requiresCredential) {
        setHasSecret('error');
      }
      toast.error(
        saved ? '刷新模型连接失败' : '保存模型连接失败',
        providerPanelActionErrorMessage(error),
      );
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
          connectionTestFailureMessage(result, credentialTroubleshootingCopy),
        );
      }
    } catch (error) {
      const message = providerPanelActionErrorMessage(error);
      toast.error(`连接测试出错 · ${connection.name}`, message);
    } finally {
      setTesting(false);
    }
  }

  async function refreshModels(opts: { silent?: boolean } = {}) {
    setFetchingModels(true);
    try {
      // Backend (xuan `81ed044`) returns a `ModelDiscoveryResult` envelope —
      // `{ models, source: 'fetched' | 'fallback', fetchedAt }` — and throws
      // a generalizedErrorMessage on failure. We trust `result.source`
      // verbatim instead of inferring from list length, so a provider that
      // legitimately returns 0 models still reads as 'fetched'.
      const result = await props.bridge.fetchModels(connection.slug);
      setModels(result.models);
      setModelSource(result.source);
      await props.onChanged();
      if (!opts.silent) {
        toast.success(`已拉取 ${result.models.length} 个模型 · ${connection.name}`);
      }
    } catch (error) {
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
      setFetchingModels(false);
    }
  }

  async function setAsDefault() {
    if (!connection.enabled) {
      toast.error('无法设为默认', '这个模型连接已禁用，请重新登录或启用后再设为默认。');
      return;
    }
    try {
      await props.bridge.setDefault(connection.slug);
      await props.onChanged();
      toast.success(`已设为默认 · ${connection.name}`);
    } catch (error) {
      toast.error('切换默认失败', providerPanelActionErrorMessage(error));
    }
  }

  async function remove() {
    const ok = await toast.confirm({
      title: `删除供应商 ${connection.name}？`,
      description: '将从已启用模型连接中移除这个供应商配置；如需再次使用，需要重新添加凭据。',
      confirmLabel: '删除',
      cancelLabel: '取消',
      destructive: true,
    });
    if (!ok) return;
    setBusy(true);
    let deleted = false;
    try {
      await props.bridge.delete(connection.slug);
      deleted = true;
      await props.onDeleted();
    } catch (error) {
      toast.error(
        deleted ? '刷新模型列表失败' : '删除模型连接失败',
        providerPanelActionErrorMessage(error),
      );
    } finally {
      setBusy(false);
    }
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
        <input value={connection.slug} disabled aria-label="模型连接 Slug" />
      </label>
      <label>
        <span>Base URL {hasFixedOAuthBaseUrl ? '（OAuth 固定）' : ''}</span>
        <input
          value={hasFixedOAuthBaseUrl ? defaults.baseUrl : baseUrl}
          onChange={(event) => setBaseUrl(event.currentTarget.value)}
          placeholder={defaults.baseUrl}
          readOnly={hasFixedOAuthBaseUrl}
          aria-readonly={hasFixedOAuthBaseUrl ? 'true' : undefined}
          aria-label={hasFixedOAuthBaseUrl ? '模型连接 Base URL，OAuth 固定' : '模型连接 Base URL'}
        />
      </label>
      {needsApiKey && (
        <label>
          <span>
            API key {hasSecret === true ? '（已设置，粘贴新值可替换）' : ''}
            {hasSecret === 'loading' ? '（正在读取状态）' : ''}
            {hasSecret === 'error' ? '（凭据状态未知）' : ''}
          </span>
          <PasswordInput
            value={apiKey}
            onChange={setApiKey}
            placeholder={hasSecret === true ? '••••••••' : '粘贴 API key'}
            ariaLabel={`${display.name} API key`}
          />
        </label>
      )}
      {needsOAuth && (
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
              ? '该模型连接使用主进程保存的 OAuth access token，不在这里显示或编辑令牌。'
              : hasSecret === 'loading'
                ? '正在读取本机 OAuth 登录状态，读取完成前不会把未知状态显示成未登录。'
                : hasSecret === 'error'
                  ? '暂时无法读取本机 OAuth 登录状态；请刷新页面或重新打开设置。'
                  : '请到上方 OAuth 分类完成登录；登录成功后会自动出现在已启用模型里。'}
          </span>
        </div>
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
        fallbackCount={fallbackModels.length}
        canRefresh={!fetchingModels && hasUsableCredential}
        fetchingModels={fetchingModels}
        onRefresh={() => void refreshModels()}
      />
      {defaults.signupUrl && (
        <a className="providerExternalLink" href={defaults.signupUrl} target="_blank" rel="noreferrer">
          获取 API key
        </a>
      )}
      <div className="providerActions">
        <button className="maka-button" data-variant="primary" type="button" disabled={busy || !hasSaveChanges} onClick={save}>
          {busy ? '保存中…' : '保存修改'}
        </button>
        <button className="maka-button" type="button" disabled={testing || !hasUsableCredential} onClick={runTest}>
          {testing ? '测试中…' : '测试连接'}
        </button>
        {!props.isDefault && connection.enabled && <button className="maka-button" type="button" onClick={setAsDefault}>设为默认</button>}
        <button className="maka-button" data-variant="destructive" type="button" disabled={busy} onClick={remove}>删除</button>
      </div>
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
 * Replaces the dropdown + "从 API 刷新" pair the editor used to ship
 * with. The picker is now a workspace, not a form field.
 */
function ModelTable(props: {
  modelChoices: ModelInfo[];
  defaultModel: string;
  onPickDefault(id: string): void;
  modelSource: 'fetched' | 'fallback';
  modelsFetchedAt?: number;
  fallbackCount: number;
  canRefresh: boolean;
  fetchingModels: boolean;
  onRefresh(): void;
}) {
  const [query, setQuery] = useState('');
  const listRef = useRef<HTMLUListElement>(null);
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return props.modelChoices;
    return props.modelChoices.filter((m) => m.id.toLowerCase().includes(q));
  }, [props.modelChoices, query]);

  const headerLine =
    props.modelSource === 'fetched'
      ? props.modelChoices.length > 0
        ? `实时拉取的 ${props.modelChoices.length} 个模型${formatFetchedAtSuffix(props.modelsFetchedAt)}`
        : '已成功调用供应商接口，但返回 0 个模型 — 该供应商可能未对当前 API key 开放任何模型。'
      : `静态备用列表（${props.fallbackCount} 项）。点「从 API 刷新」拉取该 provider 的真实模型清单。`;

  // ARIA radiogroup keyboard pattern: arrow keys move focus AND select.
  // Space/Enter on a focused radio just trigger the native button click.
  // The pure `nextRadioId` helper is unit-tested in
  // `apps/desktop/src/main/__tests__/model-table-keyboard.test.ts`.
  function onListKeyDown(event: ReactKeyboardEvent<HTMLUListElement>) {
    const list = listRef.current;
    if (!list) return;
    const radios = Array.from(list.querySelectorAll<HTMLButtonElement>('button[role="radio"]'));
    if (radios.length === 0) return;
    const visibleIds = filtered.map((m) => m.id);
    const currentId = (document.activeElement as HTMLElement | null)?.closest('button[role="radio"]')
      ? radios[radios.indexOf(document.activeElement as HTMLButtonElement)]?.dataset.modelId
      : undefined;
    const nextId = nextRadioId(currentId, visibleIds, event.key);
    if (nextId === null || nextId === currentId) return;
    event.preventDefault();
    const nextIndex = visibleIds.indexOf(nextId);
    const next = radios[nextIndex];
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
        <button
          className="maka-button"
          type="button"
          disabled={!props.canRefresh}
          onClick={props.onRefresh}
        >
          {props.fetchingModels ? '拉取中…' : '从 API 刷新'}
        </button>
      </header>

      {props.modelChoices.length > 6 && (
        <input
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
        <button
          type="button"
          className="modelTableDefaultHint"
          onClick={() => setQuery('')}
          title="清空搜索"
        >
          当前默认 <code>{props.defaultModel}</code> 不在搜索结果中 · 点这里清空搜索
        </button>
      )}

      {props.modelChoices.length === 0 ? (
        <div className="modelTableEmpty">
          {props.modelSource === 'fetched'
            ? '拉取返回 0 个模型。请检查账号方案或重新拉取。'
            : '尚无模型。点「从 API 刷新」拉取或先配置 API key。'}
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
            return (
              <li key={model.id}>
                <button
                  type="button"
                  className="modelTableRow"
                  role="radio"
                  aria-checked={isDefault}
                  data-default={isDefault ? 'true' : undefined}
                  data-model-id={model.id}
                  // Only the active radio is in the tab order; arrow keys
                  // move focus inside the group. Standard ARIA radiogroup.
                  tabIndex={isDefault || (!props.defaultModel && filtered[0]?.id === model.id) ? 0 : -1}
                  onClick={() => props.onPickDefault(model.id)}
                >
                  <span className="modelTableRowRadio" aria-hidden="true" />
                  <code className="modelTableRowId">{model.id}</code>
                  <ModelCapabilityChips model={model} />
                  {isDefault && <span className="modelTableDefaultBadge">默认</span>}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

function ModelCapabilityChips(props: { model: ModelInfo }) {
  const caps = props.model.capabilities;
  if (!caps) return null;
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
      return { name: 'Z.AI Coding Plan', description: 'GLM Coding Plan，OpenAI 兼容协议。', badge: 'Coding' };
    case 'ollama':
      return { name: 'Ollama', description: '连接本机 localhost 的 Ollama 模型。', badge: 'Local' };
    case 'openai-compatible':
      return { name: 'OpenAI Compatible', description: '中转站、代理服务或自部署网关。', badge: 'Custom' };
    case 'claude-subscription':
      return { name: 'Claude Subscription', description: 'Claude Pro / Max 订阅账号登录；登录后自动成为可用模型连接。' };
    case 'codex-subscription':
      return { name: 'Codex Subscription', description: 'ChatGPT / Codex 账号登录；登录后自动成为可用模型连接。' };
    case 'gemini-cli':
      return { name: 'Gemini CLI', description: 'Google 账号登录暂未接入聊天发送。' };
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
/**
 * PR-OAUTH-SUBSCRIPTION-0: Claude subscription card.
 *
 * Renders the runtime state, login/logout actions, paste-code modal,
 * and quota meter. Tokens never enter renderer — this component
 * consumes only `SubscriptionAccountState`.
 */
function ClaudeSubscriptionCard() {
  const [experimentalEnabled, setExperimentalEnabled] = useState<boolean | null>(null);
  const [experimentalGateError, setExperimentalGateError] = useState<string | null>(null);
  const [state, setState] = useState<SubscriptionAccountState | null>(null);
  const [pendingAction, setPendingAction] = useState(false);
  const [authRequestId, setAuthRequestId] = useState<string | null>(null);
  const [stateHint, setStateHint] = useState<string | null>(null);
  const [pasteValue, setPasteValue] = useState('');
  const [pasteError, setPasteError] = useState<string | null>(null);
  const toast = useToast();

  const refresh = async () => {
    try {
      const next = await window.maka.claudeSubscription.getAccountState();
      setState(next);
      setPasteError(null);
    } catch (error) {
      const message = subscriptionActionErrorMessage(error);
      toast.error('刷新登录状态失败', message);
      setPasteError(message);
    }
  };

  const refreshExperimentalGate = async () => {
    try {
      const flag = await window.maka.claudeSubscription.isExperimentalEnabled();
      setExperimentalEnabled(flag);
      setExperimentalGateError(null);
      if (flag) void refresh();
    } catch (error) {
      const message = subscriptionActionErrorMessage(error);
      setExperimentalEnabled(null);
      setExperimentalGateError(message);
      toast.error('读取 Claude 登录开关失败', message);
    }
  };

  useEffect(() => {
    // kenji `1da909d5` blocking concern: Anthropic does not permit
    // third-party developers to offer Claude.ai login on behalf of
    // users. Until product/legal sign-off, gate the whole UI behind
    // `MAKA_CLAUDE_SUBSCRIPTION_EXPERIMENTAL=1`. Loading state also
    // renders nothing — no teasing UI.
    let cancelled = false;
    void window.maka.claudeSubscription
      .isExperimentalEnabled()
      .then((flag) => {
        if (cancelled) return;
        setExperimentalEnabled(flag);
        setExperimentalGateError(null);
        if (flag) void refresh();
      })
      .catch((error) => {
        if (cancelled) return;
        const message = subscriptionActionErrorMessage(error);
        setExperimentalEnabled(null);
        setExperimentalGateError(message);
        toast.error('读取 Claude 登录开关失败', message);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (experimentalGateError) {
    return (
      <div className="settingsConnectionRow" data-status="error">
        <div className="settingsConnectionRowHead">
          <div className="settingsConnectionRowText">
            <div className="settingsConnectionRowName">
              <strong>Claude 订阅 (Pro / Max)</strong>
            </div>
            <small>无法确认 Claude OAuth 是否可用。没有登录动作会被执行。</small>
          </div>
          <span className="settingsConnectionBadge" data-tone="destructive">读取失败</span>
        </div>
        <small className="settingsErrorText" role="alert">
          Claude 登录开关读取失败：{experimentalGateError}
        </small>
        <div className="settingsConnectionActions">
          <button
            type="button"
            className="maka-button"
            onClick={() => void refreshExperimentalGate()}
          >
            重试
          </button>
        </div>
      </div>
    );
  }

  if (experimentalEnabled !== true) {
    return null;
  }

  async function startLogin() {
    setPendingAction(true);
    try {
      // kenji `027c93c0` + xuan `2e5be5a`: getAuthUrl now returns
      // a union — `AuthorizationUrlPayload` on success, or a
      // `SubscriptionActionResult` envelope when fail-closed
      // (e.g. experimental flag flipped off after the card
      // mounted). Discriminate by checking for the `ok` field; the
      // envelope variant has it, the success payload does not.
      const payload = await window.maka.claudeSubscription.getAuthUrl();
      if ('ok' in payload) {
        // Envelope variant. `ok: true` shouldn't happen for
        // getAuthUrl (success returns the payload, not an envelope),
        // so this branch is the failure case in practice.
        toast.error('无法开始登录', payload.ok ? '请稍后再试。' : subscriptionResultMessage(payload.message, '无法开始登录，请稍后再试。'));
        return;
      }
      setAuthRequestId(payload.authRequestId);
      setStateHint(payload.stateHint);
      setPasteValue('');
      setPasteError(null);
      // kenji `1da909d5` hardening: pass the opaque authRequestId,
      // NOT the URL. Main looks up the URL it generated.
      const opened = await window.maka.claudeSubscription.openAuthUrl(payload.authRequestId);
      if (!opened.ok) {
        toast.error('无法打开浏览器', subscriptionResultMessage(opened.message, '无法打开浏览器，请稍后重试。'));
        setAuthRequestId(null);
        setStateHint(null);
      }
      await refresh();
    } catch (error) {
      const message = subscriptionActionErrorMessage(error);
      toast.error('无法开始登录', message);
      setPasteError(message);
    } finally {
      setPendingAction(false);
    }
  }

  async function submitPaste() {
    if (!authRequestId) return;
    setPendingAction(true);
    setPasteError(null);
    try {
      const result = await window.maka.claudeSubscription.completeAuthorization(
        authRequestId,
        pasteValue,
      );
      if (result.ok) {
        toast.success('登录成功', '已绑定 Claude 订阅。');
        setAuthRequestId(null);
        setStateHint(null);
        setPasteValue('');
        await refresh();
      } else {
        setPasteError(subscriptionResultMessage(result.message, '授权码提交失败，请重新登录后再试。'));
      }
    } catch (error) {
      const message = subscriptionActionErrorMessage(error);
      toast.error('授权码提交失败', message);
      setPasteError(message);
    } finally {
      setPendingAction(false);
    }
  }

  async function cancelLogin() {
    if (!authRequestId) return;
    setPendingAction(true);
    try {
      await window.maka.claudeSubscription.cancelAuthorization(authRequestId);
      setAuthRequestId(null);
      setStateHint(null);
      setPasteValue('');
      setPasteError(null);
      await refresh();
    } catch (error) {
      toast.error('取消登录失败', subscriptionActionErrorMessage(error));
    } finally {
      setPendingAction(false);
    }
  }

  async function logout() {
    const ok = await toast.confirm({
      title: '退出 Claude Code 登录？',
      description: '将删除本机保存的订阅凭据，之后需要重新登录才能继续使用 Claude OAuth 模型。',
      confirmLabel: '退出登录',
      cancelLabel: '取消',
      destructive: true,
    });
    if (!ok) return;
    setPendingAction(true);
    try {
      const result = await window.maka.claudeSubscription.logout();
      if (result.ok) {
        toast.success('已退出登录', '本地凭据已清除。');
        await refresh();
      } else {
        toast.error('退出失败', subscriptionResultMessage(result.message, '退出登录失败，请稍后重试。'));
      }
    } catch (error) {
      toast.error('退出失败', subscriptionActionErrorMessage(error));
    } finally {
      setPendingAction(false);
    }
  }

  async function refreshQuota() {
    setPendingAction(true);
    try {
      await window.maka.claudeSubscription.refreshQuota();
      await refresh();
    } catch (error) {
      toast.error('刷新配额失败', subscriptionActionErrorMessage(error));
    } finally {
      setPendingAction(false);
    }
  }

  // Closed-state render mapping per the runtime state enum.
  const presentation = state ? presentSubscriptionState(state) : { label: '加载中…', tone: 'muted', detail: '' };
  const canStartClaudeLogin =
    state?.runtimeState === 'not_logged_in' ||
    state?.runtimeState === 'refresh_failed' ||
    state?.runtimeState === 'storage_failed';
  const claudeLoginPending = authRequestId !== null || state?.runtimeState === 'authorizing';

  return (
    <>
    <h3 className="settingsSubheading">订阅</h3>
    <div className="settingsConnectionRow" data-status={state?.runtimeState ?? 'loading'}>
      <div className="settingsConnectionRowHead">
        <div className="settingsConnectionRowText">
          <div className="settingsConnectionRowName">
            <strong>Claude 订阅 (Pro / Max)</strong>
          </div>
          <small>
            通过 Anthropic 官方 OAuth 登录使用订阅配额。
            {state?.profile?.email ? ` · ${state.profile.email}` : ''}
          </small>
        </div>
        <span className="settingsConnectionBadge" data-tone={presentation.tone}>
          {presentation.label}
        </span>
      </div>
      <p className="settingsConnectionDetail">{presentation.detail}</p>
      {pasteError && !authRequestId && (
        <small className="settingsErrorText" role="alert">{pasteError}</small>
      )}

      {state?.quota && (state.quota.fiveHour || state.quota.sevenDay) && (
        <div className="settingsQuotaSection">
          {state.quota.fiveHour && (
            <div className="settingsQuotaRow">
              <span>5 小时窗口</span>
              <span>{state.quota.fiveHour.utilization}%</span>
            </div>
          )}
          {state.quota.sevenDay && (
            <div className="settingsQuotaRow">
              <span>7 天窗口</span>
              <span>{state.quota.sevenDay.utilization}%</span>
            </div>
          )}
          <small className="settingsHelpText">
            数据更新于 <RelativeTime ts={state.quota.fetchedAt} className="settingsHelpInlineTime" />
          </small>
        </div>
      )}

      <div className="settingsConnectionActions">
        {canStartClaudeLogin || claudeLoginPending ? (
          <button
            type="button"
            className="maka-button"
            data-variant="primary"
            onClick={() => void startLogin()}
            disabled={pendingAction || claudeLoginPending}
          >
            {claudeLoginPending
              ? '登录中…'
              : state?.runtimeState === 'refresh_failed' || state?.runtimeState === 'storage_failed'
                ? '重新登录'
                : '登录订阅'}
          </button>
        ) : (
          <>
            <button
              type="button"
              className="maka-button"
              onClick={() => void refreshQuota()}
              disabled={pendingAction}
            >
              刷新配额
            </button>
            <button
              type="button"
              className="maka-button"
              data-variant="ghost"
              onClick={() => void logout()}
              disabled={pendingAction}
            >
              退出登录
            </button>
          </>
        )}
      </div>

      {authRequestId && (
        <div className="settingsOauthPastePanel" role="region" aria-label="粘贴授权码">
          <p>
            在 Claude.ai 完成登录后，会跳转到 Anthropic 控制台显示一段授权码（含 <code>#</code> 分隔符），
            把它粘贴到下面：
          </p>
          {stateHint && (
            <small>提示：你的 state 以 <code>{stateHint}</code> 开头。</small>
          )}
          <textarea
            value={pasteValue}
            onChange={(event) => setPasteValue(event.currentTarget.value)}
            placeholder="粘贴授权码（格式：xxx#yyy）"
            aria-label="授权码"
            rows={3}
            spellCheck={false}
            autoComplete="off"
          />
          {pasteError && <small className="settingsErrorText">{pasteError}</small>}
          <div className="settingsConnectionActions">
            <button
              type="button"
              className="maka-button"
              data-variant="primary"
              onClick={() => void submitPaste()}
              disabled={pendingAction || pasteValue.trim().length === 0}
            >
              提交授权码
            </button>
            <button
              type="button"
              className="maka-button"
              data-variant="ghost"
              onClick={() => void cancelLogin()}
              disabled={pendingAction}
            >
              取消
            </button>
          </div>
        </div>
      )}
    </div>
    </>
  );
}

interface SubscriptionStatePresentation {
  label: string;
  tone: string;
  detail: string;
}

function presentSubscriptionState(state: SubscriptionAccountState): SubscriptionStatePresentation {
  switch (state.runtimeState) {
    case 'not_logged_in':
      return { label: '未登录', tone: 'muted', detail: '使用 Claude 订阅配额前需要先登录。' };
    case 'authorizing':
      return { label: '登录中…', tone: 'info', detail: '请在弹出的浏览器窗口完成登录并粘贴授权码。' };
    case 'authenticated':
      return {
        label: '已登录',
        tone: 'success',
        detail: '已绑定 Claude 订阅，并会同步到“已启用模型”。',
      };
    case 'refreshing':
      return { label: '刷新中…', tone: 'info', detail: '正在刷新访问令牌。' };
    case 'refresh_failed':
      return {
        label: '刷新失败',
        tone: 'warning',
        detail: subscriptionResultMessage(state.errorMessage, '令牌刷新失败，请重新登录。'),
      };
    case 'storage_failed':
      return {
        label: '凭据读取失败',
        tone: 'warning',
        detail: subscriptionResultMessage(state.errorMessage, '本地 OAuth 凭据读取失败，请重新登录。'),
      };
    case 'quota_unavailable':
      return {
        label: '等待获取配额',
        tone: 'warning',
        detail: subscriptionResultMessage(state.errorMessage, '已登录；配额接口当前没有返回可用数据。'),
      };
    case 'provider_rejected':
      return {
        label: '订阅 API 拒绝',
        tone: 'destructive',
        detail: subscriptionResultMessage(state.errorMessage, '订阅端点拒绝了请求，可能需要重新登录。'),
      };
    default:
      return { label: '未知状态', tone: 'muted', detail: '' };
  }
}
