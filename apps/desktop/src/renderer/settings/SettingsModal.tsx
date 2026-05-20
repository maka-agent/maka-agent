import { useEffect, useMemo, useState, type ReactNode } from 'react';
import type {
  AppSettings,
  BotProvider,
  LlmConnection,
  NetworkProxySettings,
  SettingsSection,
  SettingsTestResult,
  UsageRange,
  UsageStats,
} from '@maka/core';
import { BOT_PROVIDERS, createDefaultSettings } from '@maka/core/settings';
import { ProvidersPanel } from './ProvidersPanel';

type SettingsNavItem = {
  id: SettingsSection;
  label: string;
  glyph: string;
  enabled: boolean;
};

const SETTINGS_NAV: SettingsNavItem[] = [
  { id: 'general', label: '通用', glyph: 'GE', enabled: true },
  { id: 'personalization', label: '个性化', glyph: 'PE', enabled: true },
  { id: 'theme', label: '主题', glyph: 'TH', enabled: true },
  { id: 'daily-review', label: '每日回顾', glyph: 'DR', enabled: true },
  { id: 'models', label: '模型', glyph: 'MO', enabled: true },
  { id: 'usage', label: '使用统计', glyph: 'US', enabled: true },
  { id: 'voice-models', label: '语音模型', glyph: 'VO', enabled: true },
  { id: 'open-gateway', label: '开放网关', glyph: 'GW', enabled: true },
  { id: 'bot-chat', label: '机器人对话', glyph: 'BT', enabled: true },
  { id: 'search', label: '搜索服务', glyph: 'SE', enabled: true },
  { id: 'network', label: '网络', glyph: 'NW', enabled: true },
  { id: 'data', label: '数据', glyph: 'DA', enabled: true },
  { id: 'account', label: '账号', glyph: 'AC', enabled: true },
  { id: 'about', label: '关于', glyph: 'AB', enabled: true },
];

const BOT_LABELS: Record<BotProvider, { label: string; help: string }> = {
  telegram: { label: 'Telegram', help: '通过 BotFather 创建 Bot 并获取 Token' },
  feishu: { label: '飞书', help: '配置飞书自建应用凭据' },
  wecom: { label: '企业微信', help: '配置企业微信机器人回调' },
  wechat: { label: '微信', help: '接入微信对话 bridge' },
  discord: { label: 'Discord', help: '配置 Discord Bot Token' },
  dingtalk: { label: '钉钉', help: '配置钉钉机器人 webhook' },
  qq: { label: 'QQ', help: '配置 QQ Bot bridge' },
};

export function SettingsModal(props: {
  connections: LlmConnection[];
  defaultSlug: string | null;
  onRefresh(): Promise<void>;
  onClose(): void;
}) {
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') props.onClose();
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [props.onClose]);

  return (
    <div className="settingsModalBackdrop" role="presentation" onMouseDown={props.onClose}>
      <div className="settingsModal" role="dialog" aria-modal="true" aria-label="Settings" onMouseDown={(event) => event.stopPropagation()}>
        <SettingsSurface
          connections={props.connections}
          defaultSlug={props.defaultSlug}
          onRefresh={props.onRefresh}
          onClose={props.onClose}
        />
      </div>
    </div>
  );
}

function SettingsSurface(props: {
  connections: LlmConnection[];
  defaultSlug: string | null;
  onRefresh(): Promise<void>;
  onClose(): void;
}) {
  const [section, setSection] = useState<SettingsSection>('models');
  const [settings, setSettings] = useState<AppSettings>(() => createDefaultSettings());
  const [usageStats, setUsageStats] = useState<UsageStats | null>(null);
  const [loading, setLoading] = useState(true);

  async function reloadSettings() {
    const next = await window.maka.settings.get();
    setSettings(next);
    setLoading(false);
  }

  async function updateSettings(patch: Parameters<typeof window.maka.settings.update>[0]) {
    const next = await window.maka.settings.update(patch);
    setSettings(next);
    return next;
  }

  async function reloadUsage(range: UsageRange = settings.usage.range) {
    setUsageStats(await window.maka.settings.usageStats(range));
  }

  useEffect(() => {
    void reloadSettings();
  }, []);

  useEffect(() => {
    if (section === 'usage') void reloadUsage();
  }, [section]);

  const activeItem = SETTINGS_NAV.find((item) => item.id === section) ?? SETTINGS_NAV[0];

  return (
    <main className="settingsSurface" data-modal="true">
      <aside className="settingsSidebar">
        <header>
          <span>设置 ⌘,</span>
        </header>
        <nav aria-label="Settings sections">
          {SETTINGS_NAV.map((item) => (
            <button
              key={item.id}
              className="settingsNavItem"
              data-active={section === item.id}
              type="button"
              disabled={!item.enabled}
              onClick={() => setSection(item.id)}
            >
              <span className="settingsNavGlyph" aria-hidden="true">{item.glyph}</span>
              <strong>{item.label}</strong>
            </button>
          ))}
        </nav>
      </aside>

      <section className="settingsMainPane">
        <header className="settingsPageHeader">
          <h2>{activeItem.label}</h2>
          <button className="settingsCloseButton" type="button" aria-label="Close settings" onClick={props.onClose}>×</button>
        </header>

        <div className="settingsPageContent">
          {loading ? (
            <div className="settingsEmptyState">Loading...</div>
          ) : (
            <SettingsPage
              section={section}
              settings={settings}
              usageStats={usageStats}
              connections={props.connections}
              defaultSlug={props.defaultSlug}
              onRefreshConnections={props.onRefresh}
              onUpdateSettings={updateSettings}
              onReloadUsage={reloadUsage}
            />
          )}
        </div>

        <button className="settingsDoneButton" type="button" onClick={props.onClose}>完成</button>
      </section>
    </main>
  );
}

function SettingsPage(props: {
  section: SettingsSection;
  settings: AppSettings;
  usageStats: UsageStats | null;
  connections: LlmConnection[];
  defaultSlug: string | null;
  onRefreshConnections(): Promise<void>;
  onUpdateSettings(patch: Parameters<typeof window.maka.settings.update>[0]): Promise<AppSettings>;
  onReloadUsage(range?: UsageRange): Promise<void>;
}) {
  switch (props.section) {
    case 'models':
      return (
        <div className="settingsStructuredPage settingsModelsPage">
          <div className="settingsPageIntro">
            <p>如果配置遇到问题，可以查看配置指南。</p>
            {props.connections.length > 0 && <span className="settingsBadge">{props.connections.length} 个模型</span>}
          </div>
          <ProvidersPanel bridge={window.maka.connections} />
        </div>
      );
    case 'usage':
      return (
        <UsageSettingsPage
          settings={props.settings}
          stats={props.usageStats}
          onUpdate={props.onUpdateSettings}
          onReload={props.onReloadUsage}
        />
      );
    case 'bot-chat':
      return <BotChatSettingsPage settings={props.settings} onUpdate={props.onUpdateSettings} />;
    case 'network':
      return <NetworkSettingsPage settings={props.settings} onUpdate={props.onUpdateSettings} />;
    case 'about':
      return (
        <SettingsRows>
          <SettingRow title="版本" detail="Local development build." value="0.1.0" />
          <SettingRow title="Runtime" detail="Electron desktop with React renderer." value="Electron 39" />
          <SettingRow title="存储" detail="JSONL sessions、settings.json 和 encrypted provider credentials." value="Local" />
        </SettingsRows>
      );
    case 'general':
      return (
        <SettingsRows>
          <SettingRow title="启动" detail="打开应用后回到最近一次对话。" value="Enabled" />
          <SettingRow title="新对话模式" detail="新对话默认从 Ask mode 开始。" value="Ask" />
          <SettingRow title="默认模型" detail="新对话默认使用的模型连接。" value={props.defaultSlug ?? 'Not set'} />
        </SettingsRows>
      );
    case 'theme':
      return (
        <SettingsRows>
          <SettingRow title="主题" detail="当前使用浅色桌面主题。" value="Light" />
          <SettingRow title="布局密度" detail="紧凑桌面间距。" value="Compact" />
        </SettingsRows>
      );
    case 'account':
      return (
        <SettingsRows>
          <SettingRow title="权限策略" detail="敏感工具调用前需要确认。" value="Ask" />
          <SettingRow title="凭据保护" detail="API key 使用系统 safeStorage 加密。" value="Enabled" />
        </SettingsRows>
      );
    default:
      return (
        <SettingsRows>
          <SettingRow title={navLabel(props.section)} detail="该设置页已纳入 Maka 设置树，会随对应 runtime 能力一起工作。" value="Ready" />
        </SettingsRows>
      );
  }
}

function NetworkSettingsPage(props: {
  settings: AppSettings;
  onUpdate(patch: Parameters<typeof window.maka.settings.update>[0]): Promise<AppSettings>;
}) {
  const proxy = props.settings.network.proxy;
  const [result, setResult] = useState<SettingsTestResult | null>(null);
  const [testing, setTesting] = useState(false);

  async function updateProxy(patch: Partial<NetworkProxySettings>) {
    await props.onUpdate({ network: { proxy: patch } });
  }

  async function testProxy() {
    setTesting(true);
    setResult(null);
    try {
      setResult(await window.maka.settings.testNetworkProxy());
    } finally {
      setTesting(false);
    }
  }

  return (
    <div className="settingsStructuredPage">
      <div className="settingsFormRow">
        <div>
          <strong>代理服务器</strong>
          <small>为 AI 模型请求配置网络代理</small>
        </div>
        <Switch checked={proxy.enabled} onChange={(enabled) => updateProxy({ enabled })} />
      </div>

      {proxy.enabled && (
        <>
          <div className="settingsFormGrid settingsFormGridProxy">
            <label>
              <span>代理协议</span>
              <select value={proxy.protocol} onChange={(event) => updateProxy({ protocol: event.currentTarget.value as NetworkProxySettings['protocol'] })}>
                <option value="http">HTTP/HTTPS</option>
                <option value="https">HTTPS</option>
                <option value="socks5">SOCKS5</option>
              </select>
            </label>
            <label>
              <span>服务器地址</span>
              <input value={proxy.host} onChange={(event) => updateProxy({ host: event.currentTarget.value })} placeholder="127.0.0.1" />
            </label>
            <label>
              <span>端口</span>
              <input value={String(proxy.port || '')} onChange={(event) => updateProxy({ port: Number(event.currentTarget.value) || 0 })} placeholder="7890" />
            </label>
          </div>

          <div className="settingsFormRow">
            <div>
              <strong>代理认证</strong>
              <small>需要用户名和密码时开启。</small>
            </div>
            <Switch checked={proxy.authEnabled} onChange={(authEnabled) => updateProxy({ authEnabled })} />
          </div>

          {proxy.authEnabled && (
            <div className="settingsFormGrid">
              <label>
                <span>用户名</span>
                <input value={proxy.username} onChange={(event) => updateProxy({ username: event.currentTarget.value })} />
              </label>
              <label>
                <span>密码</span>
                <input type="password" value={proxy.password} onChange={(event) => updateProxy({ password: event.currentTarget.value })} />
              </label>
            </div>
          )}

          <label className="settingsField">
            <span>代理白名单</span>
            <input
              value={proxy.bypassList.join(', ')}
              onChange={(event) => updateProxy({ bypassList: csvList(event.currentTarget.value) })}
              placeholder="metaso.cn, baidu.com"
            />
            <small>这些域名将绕过代理直连，多个用逗号分隔。</small>
          </label>

          <div className="settingsNotice">
            已自动添加 {proxy.autoBypassDomains.length} 个域名（来自本地和模型供应商）。代理仅作用于 AI 模型请求，不影响应用自身网络。
          </div>

          <div className="settingsActionRow">
            <button className="maka-button" type="button" disabled={testing} onClick={testProxy}>
              {testing ? '测试中...' : '测试当前配置'}
            </button>
            {result && <span className="settingsInlineResult" data-ok={result.ok}>{result.message}{result.latencyMs !== undefined ? ` (${result.latencyMs}ms)` : ''}</span>}
          </div>
        </>
      )}
    </div>
  );
}

function BotChatSettingsPage(props: {
  settings: AppSettings;
  onUpdate(patch: Parameters<typeof window.maka.settings.update>[0]): Promise<AppSettings>;
}) {
  const [selected, setSelected] = useState<BotProvider>('telegram');
  const [result, setResult] = useState<SettingsTestResult | null>(null);
  const [testing, setTesting] = useState(false);
  const channel = props.settings.botChat.channels[selected];

  async function updateChannel(patch: Partial<typeof channel>) {
    await props.onUpdate({ botChat: { channels: { [selected]: patch } } });
  }

  async function testChannel() {
    setTesting(true);
    setResult(null);
    try {
      setResult(await window.maka.settings.testBotChannel(selected));
    } finally {
      setTesting(false);
    }
  }

  return (
    <div className="settingsBotLayout">
      <nav className="settingsBotList" aria-label="Bot channels">
        {BOT_PROVIDERS.map((provider) => (
          <button key={provider} type="button" data-active={selected === provider} onClick={() => {
            setSelected(provider);
            setResult(null);
          }}>
            <span className="settingsBotLogo">{BOT_LABELS[provider].label.slice(0, 2)}</span>
            <span>{BOT_LABELS[provider].label}</span>
            {props.settings.botChat.channels[provider].connected && <em>已连接</em>}
          </button>
        ))}
      </nav>

      <section className="settingsBotDetail">
        <div className="settingsBotHero">
          <span className="settingsBotLogo" data-large="true">{BOT_LABELS[selected].label.slice(0, 2)}</span>
          <div>
            <h3>{BOT_LABELS[selected].label}</h3>
            <small>{channel.connected ? '已连接' : '未连接'}</small>
          </div>
          <Switch checked={channel.enabled} onChange={(enabled) => updateChannel({ enabled })} />
        </div>

        <p className="settingsHelpText">{BOT_LABELS[selected].help}</p>

        <label className="settingsField">
          <span>{selected === 'telegram' || selected === 'discord' ? 'Bot Token' : 'App Secret / Token'}</span>
          <input type="password" value={channel.token} onChange={(event) => updateChannel({ token: event.currentTarget.value })} placeholder="123456:ABC-DEF..." />
        </label>

        <label className="settingsField">
          <span>代理地址（国内网络必填）</span>
          <input value={channel.proxyUrl} onChange={(event) => updateChannel({ proxyUrl: event.currentTarget.value })} placeholder="http://127.0.0.1:7890" />
        </label>

        <div className="settingsNotice">
          提示：Telegram 等海外服务通常需要网络代理。先在“网络”页配置代理，再测试机器人连接。
        </div>

        <div className="settingsActionRow">
          <button className="maka-button" type="button" disabled={testing} onClick={testChannel}>
            {testing ? '测试中...' : '测试并连接'}
          </button>
          {result && <span className="settingsInlineResult" data-ok={result.ok}>{result.message}</span>}
        </div>
      </section>
    </div>
  );
}

function UsageSettingsPage(props: {
  settings: AppSettings;
  stats: UsageStats | null;
  onUpdate(patch: Parameters<typeof window.maka.settings.update>[0]): Promise<AppSettings>;
  onReload(range?: UsageRange): Promise<void>;
}) {
  const usage = props.settings.usage;
  const [refreshing, setRefreshing] = useState(false);
  const stats = props.stats;
  const filteredLogs = useMemo(() => {
    const logs = stats?.logs ?? [];
    return logs
      .filter((log) => usage.status === 'all' || log.status === usage.status)
      .filter((log) => !usage.modelFilter || log.model.toLowerCase().includes(usage.modelFilter.toLowerCase()));
  }, [stats, usage.status, usage.modelFilter]);

  async function setRange(range: UsageRange) {
    await props.onUpdate({ usage: { range } });
    await props.onReload(range);
  }

  async function refresh() {
    setRefreshing(true);
    try {
      await props.onReload(usage.range);
    } finally {
      setRefreshing(false);
    }
  }

  return (
    <div className="settingsUsagePage">
      <div className="settingsUsageToolbar">
        <Segmented
          value={usage.range}
          options={[
            ['24h', '24h'],
            ['7d', '7天'],
            ['30d', '30天'],
            ['all', '全部'],
          ]}
          onChange={(value) => void setRange(value as UsageRange)}
        />
        <button className="maka-button" type="button" disabled={refreshing} onClick={refresh}>{refreshing ? '刷新中...' : '刷新'}</button>
      </div>

      <div className="settingsUsageSummary">
        <MetricCard title="总请求" value={String(stats?.summary.totalRequests ?? 0)} />
        <MetricCard title="总费用" value={`$${(stats?.summary.totalCostUsd ?? 0).toFixed(2)}`} detail="以模型供应商最终结算为准" />
        <MetricCard title="总 Token" value={String(stats?.summary.totalTokens ?? 0)} detail={`输入 ${stats?.summary.inputTokens ?? 0} / 输出 ${stats?.summary.outputTokens ?? 0}`} />
        <MetricCard title="缓存 Token" value={String(stats?.summary.cacheTokens ?? 0)} detail={`命中 ${stats?.summary.cacheRead ?? 0} / 创建 ${stats?.summary.cacheCreation ?? 0}`} />
      </div>

      <Segmented
        value={usage.activeTab}
        options={[
          ['requests', '请求日志'],
          ['providers', '供应商统计'],
          ['models', '模型统计'],
          ['tools', '工具统计'],
          ['pricing', '定价配置'],
        ]}
        onChange={(activeTab) => void props.onUpdate({ usage: { activeTab: activeTab as typeof usage.activeTab } })}
      />

      <div className="settingsUsageFilters">
        <input value={usage.modelFilter} onChange={(event) => void props.onUpdate({ usage: { modelFilter: event.currentTarget.value } })} placeholder="按模型筛选..." />
        <select value={usage.status} onChange={(event) => void props.onUpdate({ usage: { status: event.currentTarget.value as typeof usage.status } })}>
          <option value="all">全部状态</option>
          <option value="success">成功</option>
          <option value="error">错误</option>
        </select>
        <label>
          <span>详情记录</span>
          <Switch checked={usage.showDetails} onChange={(showDetails) => props.onUpdate({ usage: { showDetails } })} />
        </label>
        <small>共 {filteredLogs.length} 条记录</small>
      </div>

      <UsageTable activeTab={usage.activeTab} stats={stats} logs={filteredLogs} />
    </div>
  );
}

function UsageTable(props: { activeTab: AppSettings['usage']['activeTab']; stats: UsageStats | null; logs: UsageStats['logs'] }) {
  if (props.activeTab === 'providers') {
    return <SimpleStatsTable headers={['供应商', '请求', 'Token', '费用']} rows={(props.stats?.byProvider ?? []).map((row) => [row.provider, row.requests, row.tokens, `$${row.costUsd.toFixed(2)}`])} />;
  }
  if (props.activeTab === 'models') {
    return <SimpleStatsTable headers={['模型', '请求', 'Token', '费用']} rows={(props.stats?.byModel ?? []).map((row) => [row.model, row.requests, row.tokens, `$${row.costUsd.toFixed(2)}`])} />;
  }
  if (props.activeTab === 'tools') {
    return <SimpleStatsTable headers={['工具', '调用', '成功', '错误', '平均耗时']} rows={(props.stats?.byTool ?? []).map((row) => [row.tool, row.calls, row.success, row.errors, `${row.avgDurationMs}ms`])} />;
  }
  if (props.activeTab === 'pricing') {
    return <SimpleStatsTable headers={['供应商', '模型', '输入 / 1M', '输出 / 1M']} rows={(props.stats?.pricing ?? []).map((row) => [row.provider, row.model, `$${row.inputPerMTokUsd}`, `$${row.outputPerMTokUsd}`])} empty="暂无定价覆盖配置" />;
  }
  return <SimpleStatsTable headers={['时间', '供应商', '模型', 'Token', '费用', '延迟', '状态']} rows={props.logs.map((row) => [new Date(row.ts).toLocaleString(), row.provider, row.model, row.inputTokens + row.outputTokens, `$${(row.costUsd ?? 0).toFixed(2)}`, row.latencyMs ? `${row.latencyMs}ms` : '-', row.status])} empty="暂无请求记录" />;
}

function SimpleStatsTable(props: { headers: string[]; rows: Array<Array<string | number>>; empty?: string }) {
  return (
    <table className="settingsStatsTable">
      <thead>
        <tr>{props.headers.map((header) => <th key={header}>{header}</th>)}</tr>
      </thead>
      <tbody>
        {props.rows.length === 0 ? (
          <tr><td colSpan={props.headers.length}>{props.empty ?? '暂无请求记录'}</td></tr>
        ) : props.rows.map((row, rowIndex) => (
          <tr key={rowIndex}>{row.map((cell, cellIndex) => <td key={cellIndex}>{cell}</td>)}</tr>
        ))}
      </tbody>
    </table>
  );
}

function MetricCard(props: { title: string; value: string; detail?: string }) {
  return (
    <div className="settingsMetricCard">
      <small>{props.title}</small>
      <strong>{props.value}</strong>
      {props.detail && <span>{props.detail}</span>}
    </div>
  );
}

function Segmented<T extends string>(props: { value: T; options: Array<[T, string]>; onChange(value: T): void }) {
  return (
    <div className="settingsSegmented">
      {props.options.map(([value, label]) => (
        <button key={value} type="button" data-active={props.value === value} onClick={() => props.onChange(value)}>
          {label}
        </button>
      ))}
    </div>
  );
}

function Switch(props: { checked: boolean; onChange(checked: boolean): void }) {
  return (
    <button className="settingsSwitch" type="button" role="switch" aria-checked={props.checked} data-checked={props.checked} onClick={() => props.onChange(!props.checked)}>
      <span />
    </button>
  );
}

function SettingsRows(props: { children: ReactNode }) {
  return <div className="settingsRows">{props.children}</div>;
}

function SettingRow(props: { title: string; detail: string; value: string }) {
  return (
    <div className="settingsRow">
      <div>
        <strong>{props.title}</strong>
        <small>{props.detail}</small>
      </div>
      <span>{props.value}</span>
    </div>
  );
}

function csvList(value: string): string[] {
  return value.split(',').map((part) => part.trim()).filter(Boolean);
}

function navLabel(section: SettingsSection): string {
  return SETTINGS_NAV.find((item) => item.id === section)?.label ?? section;
}
