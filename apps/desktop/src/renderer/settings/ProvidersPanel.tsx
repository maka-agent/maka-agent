import { useEffect, useMemo, useRef, useState } from 'react';
import { ChevronRight } from '@maka/ui/icons';
import {
  CATALOG_PROVIDER_TYPES,
  PROVIDER_DEFAULTS,
  type LlmConnection,
  type ProviderCategory,
  type ProviderType,
} from '@maka/core';
import {
  Button,
  PrimitiveTabs, PrimitiveTabsList, PrimitiveTabsTrigger, PrimitiveTabsPanel,
  PrimitiveAccordion, PrimitiveAccordionItem, PrimitiveAccordionHeader, PrimitiveAccordionTrigger, PrimitiveAccordionPanel,
  Item, ItemContent, ItemTitle, ItemActions,
  useToast,
} from '@maka/ui';
import { chipStatusText, rollupForGroup } from './provider-connection-status';
import { AddProviderForm } from './provider-add-form';
import { ProviderCatalogCard } from './provider-catalog';
import { ConnectionDetail } from './provider-connection-detail';
import { ProviderConfigSheetOverlay } from './provider-config-sheet';
import { ProviderLogo, providerDisplay } from './provider-display';
import { ModelOAuthSection } from './provider-oauth-section';
import { providerPanelActionErrorMessage, type ConnectionsBridge } from './provider-panel-shared';

export type { ConnectionsBridge } from './provider-panel-shared';
export { ProviderLogo, providerDisplay } from './provider-display';

type CatalogTab = Extract<ProviderCategory, 'domestic' | 'overseas' | 'local' | 'oauth'>;

const CATALOG_TABS: Array<{ id: CatalogTab; label: string }> = [
  { id: 'domestic', label: '国内' },
  { id: 'overseas', label: '海外' },
  { id: 'local', label: '本地' },
  { id: 'oauth', label: 'OAuth' },
];

export function ProvidersPanel({ bridge }: { bridge: ConnectionsBridge }) {
  const [connections, setConnections] = useState<LlmConnection[]>([]);
  const [defaultSlug, setDefaultSlug] = useState<string | null>(null);
  const [selectedSlug, setSelectedSlug] = useState<string | null>(null);
  const [addingType, setAddingType] = useState<ProviderType | null>(null);
  const [catalogTab, setCatalogTab] = useState<CatalogTab>('domestic');
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const providersPanelMountedRef = useRef(false);
  const providersReloadTicketRef = useRef(0);
  const providerSheetLifecycleRef = useRef(0);
  const toast = useToast();

  async function reload(): Promise<boolean> {
    const ticket = ++providersReloadTicketRef.current;
    try {
      const [list, defaultConnection] = await Promise.all([
        bridge.list(),
        bridge.getDefault(),
      ]);
      if (!providersPanelMountedRef.current || providersReloadTicketRef.current !== ticket) return false;
      setConnections(list);
      setDefaultSlug(defaultConnection);
      setLoadError(null);
      setLoading(false);
      setSelectedSlug((current) =>
        current && list.some((connection) => connection.slug === current)
          ? current
          : null,
      );
      return true;
    } catch (error) {
      if (!providersPanelMountedRef.current || providersReloadTicketRef.current !== ticket) return false;
      const message = providerPanelActionErrorMessage(error);
      setLoadError(message);
      setLoading(false);
      toast.error('载入模型连接失败', message);
      return false;
    }
  }

  useEffect(() => {
    providersPanelMountedRef.current = true;
    void reload();
    const unsubscribe = bridge.subscribeEvents?.(() => {
      void reload();
    });
    return () => {
      providersPanelMountedRef.current = false;
      providersReloadTicketRef.current += 1;
      unsubscribe?.();
    };
  }, [bridge]);

  const selected = useMemo(
    () => connections.find((connection) => connection.slug === selectedSlug) ?? null,
    [connections, selectedSlug],
  );

  // Group connections under their provider so the list reads as a
  // hierarchy (provider → connections) instead of a flat peer list. Each
  // group rolls the worst connection status up to its header so a problem
  // is visible while the group is collapsed.
  const providerGroups = useMemo(() => {
    const order: ProviderType[] = [];
    const byType = new Map<ProviderType, LlmConnection[]>();
    for (const connection of connections) {
      const list = byType.get(connection.providerType);
      if (list) {
        list.push(connection);
      } else {
        byType.set(connection.providerType, [connection]);
        order.push(connection.providerType);
      }
    }
    return order.map((type) => {
      const groupConnections = byType.get(type) ?? [];
      return {
        type,
        name: providerDisplay(type).name,
        connections: groupConnections,
        rollup: rollupForGroup(groupConnections),
      };
    });
  }, [connections]);

  // Start with the provider holding the default connection expanded (so the
  // default is visible at a glance) plus any problem provider (failed / needs
  // re-login), surfacing issues without a click; healthy providers stay
  // collapsed and compact.
  const defaultOpenGroups = useMemo(
    () =>
      providerGroups
        .filter(
          (group) =>
            group.rollup === 'err' ||
            group.rollup === 'warn' ||
            group.connections.some((connection) => connection.slug === defaultSlug),
        )
        .map((group) => group.type),
    [providerGroups, defaultSlug],
  );

  const customProviders = CATALOG_PROVIDER_TYPES.filter(
    (type) => PROVIDER_DEFAULTS[type].category === 'custom',
  );

  function startAdd(type: ProviderType) {
    providerSheetLifecycleRef.current += 1;
    setAddingType(type);
    setSelectedSlug(null);
  }

  function closeProviderConfigSheet() {
    providerSheetLifecycleRef.current += 1;
    setAddingType(null);
    setSelectedSlug(null);
  }

  function chipTitle(connection: LlmConnection): string {
    return `${connection.name} · ${chipStatusText(connection)}`;
  }

  function chipAriaLabel(connection: LlmConnection): string {
    const provider = providerDisplay(connection.providerType).name;
    const defaultSuffix = connection.slug === defaultSlug ? '，默认连接' : '';
    return `模型连接：${connection.name}，供应商：${provider}${defaultSuffix}，${chipStatusText(connection)}`;
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
        <div className="enabledStrip" aria-label="模型连接">
          <div className="enabledStripHeader">
            <h3>模型连接</h3>
            {connections.length > 0 && (
              <span>{providerGroups.length} 个供应商 · {connections.length} 个连接</span>
            )}
          </div>
          {loadError ? (
            <Button className="enabledEmptyChip enabledEmptyAction" type="button" variant="ghost" onClick={() => void reload()}>
              <strong>模型连接载入失败</strong>
              <small>{loadError} · 点击重试。</small>
            </Button>
          ) : connections.length === 0 ? (
            <div className="enabledEmptyChip" role="note">
              <strong>等待添加供应商</strong>
              <small>从下面选择一个开始配置。</small>
            </div>
          ) : (
            <PrimitiveAccordion className="enabledAccordion" multiple defaultValue={defaultOpenGroups}>
              {providerGroups.map((group) => {
                const single = group.connections.length === 1;
                const problem = group.rollup === 'err' || group.rollup === 'warn';
                const rollupLabel = problem
                  ? single
                    ? chipStatusText(group.connections[0])
                    : group.rollup === 'err' ? '有连接异常' : '需重新登录'
                  : `${group.connections.length} 连接`;
                return (
                  <PrimitiveAccordionItem key={group.type} value={group.type} className="enabledProvider">
                    <PrimitiveAccordionHeader className="enabledProviderHead">
                      <PrimitiveAccordionTrigger className="enabledProviderTrigger">
                        <ProviderLogo type={group.type} compact />
                        <span className="enabledProviderName">{group.name}</span>
                        <span className="enabledProviderMeta">
                          <span className={`enabledRollup is-${group.rollup}`}>
                            <span className="enabledStatusDot" aria-hidden="true" />
                            {rollupLabel}
                          </span>
                          <ChevronRight className="enabledChevron" size={15} aria-hidden="true" />
                        </span>
                      </PrimitiveAccordionTrigger>
                    </PrimitiveAccordionHeader>
                    <PrimitiveAccordionPanel className="enabledProviderPanel">
                      <ul role="list">
                        {group.connections.map((connection) => (
                          <li key={connection.slug}>
                            <Item
                              className="enabledConnRow py-2 pr-8 pl-12 rounded-none"
                              data-default={connection.slug === defaultSlug ? 'true' : undefined}
                              data-test-status={connection.lastTestStatus ?? 'untested'}
                              data-disabled={connection.enabled ? undefined : 'true'}
                              aria-label={chipAriaLabel(connection)}
                              title={chipTitle(connection)}
                              render={
                                <button
                                  type="button"
                                  onClick={() => {
                                    providerSheetLifecycleRef.current += 1;
                                    setSelectedSlug(connection.slug);
                                    setAddingType(null);
                                  }}
                                />
                              }
                            >
                              <ItemContent>
                                <ItemTitle className="enabledConnTitle">
                                  {connection.name}
                                  {connection.slug === defaultSlug && (
                                    <span className="enabledDefaultTag">默认</span>
                                  )}
                                </ItemTitle>
                              </ItemContent>
                              <ItemActions>
                                <span className={`enabledConnStatus is-${connection.lastTestStatus ?? 'untested'}`}>
                                  <span className="enabledStatusDot" aria-hidden="true" />
                                  {chipStatusText(connection)}
                                </span>
                              </ItemActions>
                            </Item>
                          </li>
                        ))}
                      </ul>
                    </PrimitiveAccordionPanel>
                  </PrimitiveAccordionItem>
                );
              })}
            </PrimitiveAccordion>
          )}
        </div>

        <div className="providerMarketHeader">
          <div>
            <h3>模型供应商</h3>
            <p>选择 API Key 服务、本地模型、OAuth 账号登录，或自定义 OpenAI 兼容接口。</p>
          </div>
          <Button type="button" onClick={() => startAdd('openai-compatible')}>
            自定义
          </Button>
        </div>

        <PrimitiveTabs
          className="catalogTabsRoot"
          value={catalogTab}
          onValueChange={(value) => setCatalogTab(value as CatalogTab)}
        >
          <PrimitiveTabsList variant="pill" className="catalogTabs catalogPillTabs" aria-label="模型供应商分类">
            {CATALOG_TABS.map((tab) => (
              <PrimitiveTabsTrigger
                key={tab.id}
                value={tab.id}
                data-catalog-tab={tab.id}
              >
                <strong>{tab.label}</strong>
              </PrimitiveTabsTrigger>
            ))}
          </PrimitiveTabsList>
          <PrimitiveTabsPanel value="oauth">
            <ModelOAuthSection onConnectionsChanged={async () => { await reload(); }} />
          </PrimitiveTabsPanel>
          {(['domestic', 'overseas', 'local'] as const).map((cat) => (
            <PrimitiveTabsPanel key={cat} value={cat}>
              <div className="catalogGrid providerMarketGrid">
                {CATALOG_PROVIDER_TYPES.filter((type) => PROVIDER_DEFAULTS[type].category === cat).map((type) => (
                  <ProviderCatalogCard
                    key={type}
                    type={type}
                    count={configuredByType(type)}
                    onSelect={() => startAdd(type)}
                  />
                ))}
              </div>
            </PrimitiveTabsPanel>
          ))}
        </PrimitiveTabs>

        <div className="customProviderEntry">
          <div>
            <h3>自定义供应商</h3>
            <p>接入中转站、代理服务，或自部署的 OpenAI 兼容接口。</p>
          </div>
          {customProviders.map((type) => (
            <Button key={type} type="button" variant="secondary" onClick={() => startAdd(type)}>
              添加 OpenAI 兼容接口
            </Button>
          ))}
        </div>
      </section>

      {(addingType || selected) && (
        <ProviderConfigSheetOverlay
          onClose={closeProviderConfigSheet}
        >
            {addingType ? (
              <AddProviderForm
                key={addingType}
                bridge={bridge}
                providerType={addingType}
                existingSlugs={connections.map((connection) => connection.slug)}
                onCancel={() => setAddingType(null)}
                onCreated={async (slug) => {
                  const providerSheetLifecycle = providerSheetLifecycleRef.current;
                  const reloaded = await reload();
                  if (
                    !reloaded ||
                    !providersPanelMountedRef.current ||
                    providerSheetLifecycleRef.current !== providerSheetLifecycle
                  ) return;
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
                onChanged={async () => { await reload(); }}
                onDeleted={async () => {
                  if (!providersPanelMountedRef.current) return;
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
