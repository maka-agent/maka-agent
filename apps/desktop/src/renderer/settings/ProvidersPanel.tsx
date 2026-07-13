import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, ChevronRight, Plus, Search } from '@maka/ui/icons';
import {
  CATALOG_PROVIDER_TYPES,
  PROVIDER_DEFAULTS,
  type LlmConnection,
  type ProviderCatalogGroup,
  type ProviderType,
} from '@maka/core';
import {
  Button,
  InputGroup, InputGroupAddon, InputGroupInput,
  PrimitiveTabs, PrimitiveTabsList, PrimitiveTabsTrigger, PrimitiveTabsPanel,
  PrimitiveAccordion, PrimitiveAccordionItem, PrimitiveAccordionHeader, PrimitiveAccordionTrigger, PrimitiveAccordionPanel,
  Item, ItemContent, ItemTitle, ItemActions,
  useToast,
} from '@maka/ui';
import { chipStatusText, rollupForGroup } from './provider-connection-status';
import { AddProviderForm } from './provider-add-form';
import { ProviderCatalogCard } from './provider-catalog';
import { ConnectionDetail } from './provider-connection-detail';
import { ProviderLogo, providerDisplay } from './provider-display';
import { ModelOAuthSection } from './provider-oauth-section';
import { providerPanelActionErrorMessage, type ConnectionsBridge } from './provider-panel-shared';

export type { ConnectionsBridge } from './provider-panel-shared';
export { ProviderLogo, providerDisplay } from './provider-display';

type ProviderPage =
  | { kind: 'connections' }
  | { kind: 'catalog' }
  | { kind: 'add'; providerType: ProviderType }
  | { kind: 'detail'; slug: string };

type ProviderFocusTarget =
  | { kind: 'child-back' }
  | { kind: 'add-provider' }
  | { kind: 'catalog-provider'; providerType: ProviderType }
  | { kind: 'connection'; slug: string };

type CatalogCategory = ProviderCatalogGroup;

const CATALOG_TABS: Array<{ id: CatalogCategory; label: string }> = [
  { id: 'recommended', label: '推荐' },
  { id: 'plans', label: '模型计划' },
  { id: 'api', label: 'API' },
  { id: 'aggregators', label: '聚合服务' },
  { id: 'local', label: '本地' },
];

const RECOMMENDED_PROVIDER_TYPES: ProviderType[] = [
  'siliconflow',
  'anthropic',
  'openai',
  'google',
  'kimi-coding-plan',
  'deepseek',
  'ollama',
];

export function ProvidersPanel({ bridge }: { bridge: ConnectionsBridge }) {
  const [connections, setConnections] = useState<LlmConnection[]>([]);
  const [defaultSlug, setDefaultSlug] = useState<string | null>(null);
  const [page, setPage] = useState<ProviderPage>({ kind: 'connections' });
  const [catalogCategory, setCatalogCategory] = useState<CatalogCategory>('recommended');
  const [catalogQuery, setCatalogQuery] = useState('');
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const providersPanelMountedRef = useRef(false);
  const providersReloadTicketRef = useRef(0);
  const providerPageLifecycleRef = useRef(0);
  const providersPanelRef = useRef<HTMLDivElement>(null);
  const pendingFocusRef = useRef<ProviderFocusTarget | null>(null);
  const toast = useToast();

  function navigate(nextPage: ProviderPage, focusTarget: ProviderFocusTarget) {
    providerPageLifecycleRef.current += 1;
    pendingFocusRef.current = focusTarget;
    setPage(nextPage);
  }

  useLayoutEffect(() => {
    const focusTarget = pendingFocusRef.current;
    const panel = providersPanelRef.current;
    if (!focusTarget || !panel) return;
    pendingFocusRef.current = null;
    providerFocusElement(panel, focusTarget)?.focus({ preventScroll: true });
  }, [page]);

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
      setPage((current) => current.kind === 'detail' && !list.some((connection) => connection.slug === current.slug)
        ? { kind: 'connections' }
        : current);
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
      providerPageLifecycleRef.current += 1;
      unsubscribe?.();
    };
  }, [bridge]);

  const selected = useMemo(
    () => page.kind === 'detail'
      ? connections.find((connection) => connection.slug === page.slug) ?? null
      : null,
    [connections, page],
  );

  const providerGroups = useMemo(() => {
    const order: ProviderType[] = [];
    const byType = new Map<ProviderType, LlmConnection[]>();
    for (const connection of connections) {
      const list = byType.get(connection.providerType);
      if (list) list.push(connection);
      else {
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

  const defaultOpenGroups = useMemo(
    () => providerGroups
      .filter((group) =>
        group.rollup === 'err' ||
        group.rollup === 'warn' ||
        group.connections.some((connection) => connection.slug === defaultSlug))
      .map((group) => group.type),
    [providerGroups, defaultSlug],
  );
  const pendingFocus = pendingFocusRef.current;
  const focusRestoreGroup = pendingFocus?.kind === 'connection'
    ? connections.find((connection) => connection.slug === pendingFocus.slug)?.providerType
    : undefined;
  const initialOpenGroups = focusRestoreGroup && !defaultOpenGroups.includes(focusRestoreGroup)
    ? [...defaultOpenGroups, focusRestoreGroup]
    : defaultOpenGroups;

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

  function providerCatalogGroup(type: ProviderType): Exclude<CatalogCategory, 'recommended'> {
    const definition = PROVIDER_DEFAULTS[type];
    if (definition.catalogGroup && definition.catalogGroup !== 'recommended') return definition.catalogGroup;
    if (definition.category === 'local') return 'local';
    if (definition.catalogBadge === 'Coding') return 'plans';
    if (definition.category === 'custom') return 'aggregators';
    return 'api';
  }

  function providersForCategory(category: CatalogCategory): ProviderType[] {
    const source = category === 'recommended' ? RECOMMENDED_PROVIDER_TYPES : CATALOG_PROVIDER_TYPES;
    const normalizedQuery = catalogQuery.trim().toLocaleLowerCase();
    return source.filter((type) => {
      if (!CATALOG_PROVIDER_TYPES.includes(type)) return false;
      if (category !== 'recommended' && providerCatalogGroup(type) !== category) return false;
      if (!normalizedQuery) return true;
      const display = providerDisplay(type);
      return [type, display.name, display.description, PROVIDER_DEFAULTS[type].label]
        .some((value) => value.toLocaleLowerCase().includes(normalizedQuery));
    });
  }

  if (loading) {
    return (
      <div className="providersPanel providersLoading" aria-busy="true" aria-label="正在加载模型供应商">
        <div className="providersLoadingStrip">
          <div className="maka-skeleton maka-skeleton-line" data-size="lg" style={{ width: '34%' }} />
          <div className="maka-skeleton maka-skeleton-line" data-size="sm" style={{ width: '52%' }} />
        </div>
        <div className="providersLoadingGrid">
          {[0, 1, 2, 3, 4, 5].map((index) => <div key={index} className="maka-skeleton maka-skeleton-card" />)}
        </div>
      </div>
    );
  }

  if (page.kind === 'catalog') {
    return (
      <div ref={providersPanelRef} className="providersPanel providerChildPage">
        <ProviderPageHeader
          title="添加服务商"
          description="搜索 Maka 支持的 API、模型计划、聚合服务与本地运行时。"
          onBack={() => navigate({ kind: 'connections' }, { kind: 'add-provider' })}
        />
        <PrimitiveTabs
          className="catalogTabsRoot"
          value={catalogCategory}
          onValueChange={(value) => setCatalogCategory(value as CatalogCategory)}
        >
          <PrimitiveTabsList variant="pill" className="catalogTabs catalogPillTabs" aria-label="模型供应商分类">
            {CATALOG_TABS.map((tab) => (
              <PrimitiveTabsTrigger key={tab.id} value={tab.id} data-catalog-tab={tab.id}>
                <strong>{tab.label}</strong>
              </PrimitiveTabsTrigger>
            ))}
          </PrimitiveTabsList>
          <InputGroup className="providerCatalogSearch">
            <InputGroupAddon>
              <Search aria-hidden="true" />
            </InputGroupAddon>
            <InputGroupInput
              type="search"
              value={catalogQuery}
              onChange={(event) => setCatalogQuery(event.currentTarget.value)}
              placeholder="搜索服务商"
              aria-label="搜索模型服务商"
            />
          </InputGroup>
          {CATALOG_TABS.map((tab) => {
            const providers = providersForCategory(tab.id);
            return (
              <PrimitiveTabsPanel key={tab.id} value={tab.id}>
                {providers.length > 0 ? (
                  <div className="catalogGrid providerMarketGrid">
                    {providers.map((type) => (
                      <ProviderCatalogCard
                        key={type}
                        type={type}
                        count={configuredByType(type)}
                        onSelect={() => navigate({ kind: 'add', providerType: type }, { kind: 'child-back' })}
                      />
                    ))}
                  </div>
                ) : (
                  <div className="providerCatalogEmpty" role="status">没有匹配的服务商</div>
                )}
              </PrimitiveTabsPanel>
            );
          })}
        </PrimitiveTabs>
      </div>
    );
  }

  if (page.kind === 'add') {
    return (
      <div ref={providersPanelRef} className="providersPanel providerChildPage">
        <ProviderPageHeader
          title="配置服务商"
          description="保存后可以拉取账号可用模型，并继续测试连接。"
          onBack={() => navigate({ kind: 'catalog' }, { kind: 'catalog-provider', providerType: page.providerType })}
        />
        <div className="providerInlineEditor">
          <AddProviderForm
            key={page.providerType}
            bridge={bridge}
            providerType={page.providerType}
            existingSlugs={connections.map((connection) => connection.slug)}
            onCancel={() => navigate({ kind: 'catalog' }, { kind: 'catalog-provider', providerType: page.providerType })}
            onCreated={async (slug) => {
              const lifecycle = providerPageLifecycleRef.current;
              const reloaded = await reload();
              if (!reloaded || !providersPanelMountedRef.current || providerPageLifecycleRef.current !== lifecycle) return;
              navigate({ kind: 'detail', slug }, { kind: 'child-back' });
            }}
          />
        </div>
      </div>
    );
  }

  if (page.kind === 'detail' && selected) {
    return (
      <div ref={providersPanelRef} className="providersPanel providerChildPage">
        <ProviderPageHeader
          title={selected.name}
          description={`${providerDisplay(selected.providerType).name} · 模型、凭据与连接状态`}
          onBack={() => navigate({ kind: 'connections' }, { kind: 'connection', slug: selected.slug })}
        />
        <div className="providerInlineEditor">
          <ConnectionDetail
            key={selected.slug}
            bridge={bridge}
            connection={selected}
            isDefault={selected.slug === defaultSlug}
            onChanged={async () => { await reload(); }}
            onDeleted={async () => {
              if (!providersPanelMountedRef.current) return;
              navigate({ kind: 'connections' }, { kind: 'add-provider' });
              await reload();
            }}
          />
        </div>
      </div>
    );
  }

  return (
    <div ref={providersPanelRef} className="providersPanel providersMarketPanel">
      <section className="providerMarket">
        <div className="providerRootHeader">
          <div>
            <h3>模型连接</h3>
            <p>管理服务商凭据、默认模型和连接状态。</p>
          </div>
          <Button
            type="button"
            data-provider-focus="add-provider"
            onClick={() => navigate({ kind: 'catalog' }, { kind: 'child-back' })}
          >
            <Plus size={15} aria-hidden="true" />
            添加服务商
          </Button>
        </div>

        <div className="enabledStrip" aria-label="模型连接">
          <div className="enabledStripHeader">
            <h3>已配置</h3>
            {connections.length > 0 && <span>{providerGroups.length} 个服务商 · {connections.length} 个连接</span>}
          </div>
          {loadError ? (
            <Button className="enabledEmptyChip enabledEmptyAction" type="button" variant="ghost" onClick={() => void reload()}>
              <strong>模型连接载入失败</strong>
              <small>{loadError} · 点击重试。</small>
            </Button>
          ) : connections.length === 0 ? (
            <div className="enabledEmptyChip" role="note">
              <strong>等待添加服务商</strong>
              <small>点击右上角“添加服务商”开始配置。</small>
            </div>
          ) : (
            <PrimitiveAccordion className="enabledAccordion" multiple defaultValue={initialOpenGroups}>
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
                              className="enabledConnRow mx-2 py-2 pr-6 pl-10"
                              selected={connection.slug === defaultSlug}
                              data-test-status={connection.lastTestStatus ?? 'untested'}
                              data-connection-slug={connection.slug}
                              data-disabled={connection.enabled ? undefined : 'true'}
                              aria-label={chipAriaLabel(connection)}
                              title={chipTitle(connection)}
                              render={<button type="button" onClick={() => navigate({ kind: 'detail', slug: connection.slug }, { kind: 'child-back' })} />}
                            >
                              <ItemContent>
                                <ItemTitle className="enabledConnTitle">
                                  {connection.name}
                                  {connection.slug === defaultSlug && <span className="enabledDefaultTag">默认</span>}
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

        <section className="providerAccountSection" aria-label="账号连接">
          <div className="providerAccountSectionHeader">
            <h3>账号连接</h3>
            <p>使用现有 OAuth 登录流程连接订阅账号。</p>
          </div>
          <ModelOAuthSection onConnectionsChanged={async () => { await reload(); }} />
        </section>
      </section>
    </div>
  );
}

function ProviderPageHeader(props: { title: string; description: string; onBack(): void }) {
  return (
    <header className="providerSubpageHeader">
      <Button type="button" variant="quiet" className="providerSubpageBack" data-provider-focus="child-back" aria-label="返回模型连接" onClick={props.onBack}>
        <ArrowLeft size={16} aria-hidden="true" />
        返回
      </Button>
      <div>
        <h3>{props.title}</h3>
        <p>{props.description}</p>
      </div>
    </header>
  );
}

function providerFocusElement(panel: HTMLElement, target: ProviderFocusTarget): HTMLElement | undefined {
  if (target.kind === 'child-back') {
    return panel.querySelector<HTMLElement>('[data-provider-focus="child-back"]') ?? undefined;
  }
  if (target.kind === 'add-provider') {
    return panel.querySelector<HTMLElement>('[data-provider-focus="add-provider"]') ?? undefined;
  }
  if (target.kind === 'catalog-provider') {
    return [...panel.querySelectorAll<HTMLElement>('[data-provider][data-status="ready"]')]
      .find((element) => element.dataset.provider === target.providerType);
  }
  return [...panel.querySelectorAll<HTMLElement>('[data-connection-slug]')]
    .find((element) => element.dataset.connectionSlug === target.slug);
}
