import { useEffect, useMemo, useRef, useState, type ComponentType, type ReactNode } from 'react';
import {
  BarChart3,
  Bot,
  CalendarDays,
  Cpu,
  Database,
  Globe,
  Info,
  Network,
  Palette,
  Search,
  Settings as SettingsIcon,
  Sparkles,
  User,
  UserCircle,
  Volume2,
  X,
  type LucideProps,
} from 'lucide-react';
import type {
  AppSettings,
  BotProvider,
  LlmConnection,
  NetworkProxySettings,
  SettingsSection,
  ThemePreference,
  UiDensity,
  UsageRange,
  UsageStats,
} from '@maka/core';
import type { TestProxyInput } from '@maka/core/settings/network-settings';
import { BOT_PROVIDERS, createDefaultSettings } from '@maka/core/settings';
import { useModalA11y, useToast } from '@maka/ui';
import { ProvidersPanel } from './ProvidersPanel';

type SettingsNavItem = {
  id: SettingsSection;
  label: string;
  Icon: ComponentType<LucideProps>;
  enabled: boolean;
  comingSoon?: boolean;
};

const SETTINGS_NAV: SettingsNavItem[] = [
  { id: 'general', label: '通用', Icon: SettingsIcon, enabled: true },
  { id: 'personalization', label: '个性化', Icon: User, enabled: true },
  { id: 'theme', label: '主题', Icon: Palette, enabled: true },
  { id: 'daily-review', label: '每日回顾', Icon: CalendarDays, enabled: true, comingSoon: true },
  { id: 'models', label: '模型', Icon: Cpu, enabled: true },
  { id: 'usage', label: '使用统计', Icon: BarChart3, enabled: true },
  { id: 'voice-models', label: '语音模型', Icon: Volume2, enabled: true, comingSoon: true },
  { id: 'open-gateway', label: '开放网关', Icon: Sparkles, enabled: true, comingSoon: true },
  { id: 'bot-chat', label: '机器人对话', Icon: Bot, enabled: true },
  { id: 'search', label: '搜索服务', Icon: Search, enabled: true, comingSoon: true },
  { id: 'network', label: '网络', Icon: Globe, enabled: true },
  { id: 'data', label: '数据', Icon: Database, enabled: true, comingSoon: true },
  { id: 'account', label: '账号', Icon: UserCircle, enabled: true },
  { id: 'about', label: '关于', Icon: Info, enabled: true },
];

type ComingSoonCopy = {
  Icon: ComponentType<LucideProps>;
  headline: string;
  description: string;
  bullets: string[];
};

const COMING_SOON_PAGES: Partial<Record<SettingsSection, ComingSoonCopy>> = {
  'daily-review': {
    Icon: CalendarDays,
    headline: '即将推出 · 每日回顾',
    description:
      '自动汇总当天的对话、任务和工具调用，生成一份精炼的 daily brief；也可设置每周 / 每月节奏。',
    bullets: [
      '按时段或对话主题聚类，凸显高价值进展',
      '可导出为 Markdown、PDF 或推送至 Telegram / 飞书',
      '与「使用统计」共享 token 与费用数据',
    ],
  },
  'voice-models': {
    Icon: Volume2,
    headline: '即将推出 · 语音模型',
    description:
      '为 Maka 接入本地或云端的 TTS / STT，让对话可以语音输入和回放。',
    bullets: [
      '本地 TTS：piper / coqui，零网络延迟',
      '云端 STT：Whisper / GPT-4o Realtime / Gemini Live',
      '按 connection 单独切换语音模型，免影响文本',
    ],
  },
  'open-gateway': {
    Icon: Sparkles,
    headline: '即将推出 · 开放网关',
    description:
      '把 Maka 当作本机的 OpenAI 兼容 API 暴露给其他工具（IDE / shell / 工作流引擎），统一走 Maka 的权限策略和使用统计。',
    bullets: [
      '本机 :3939 暴露 OpenAI / Anthropic 兼容端点',
      '调用走当前默认 provider，复用凭据与代理设置',
      '所有调用进入「使用统计」聚合，方便对账',
    ],
  },
  search: {
    Icon: Search,
    headline: '即将推出 · 搜索服务',
    description:
      '为助手挂接外部搜索能力，自动按提问类型选择源；配合权限策略可控制每条搜索的范围与速率。',
    bullets: [
      '主流引擎：Tavily / Brave Search / SerpAPI',
      '自托管选项：SearxNG、MetaSo、本地索引',
      '查询缓存与隐私模式（含网络代理路由）',
    ],
  },
  data: {
    Icon: Database,
    headline: '即将推出 · 数据',
    description:
      '统一管理工作区数据：会话归档、设置备份、凭据导入导出，全部留在本机。',
    bullets: [
      '导出整个 workspace（sessions + settings + skills）为 .maka.zip',
      '导入备份时按 schemaVersion 升级，缺字段补默认',
      '清理旧会话与流式中断残留',
    ],
  },
};

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
  themePref: ThemePreference;
  onThemeChange(pref: ThemePreference): void;
  density: UiDensity;
  onDensityChange(density: UiDensity): void;
  onUserLabelChange?(label: string): void;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);
  // Escape closes the modal, Tab/Shift+Tab cycles inside the dialog,
  // focus restored to the trigger on close.
  useModalA11y(dialogRef, props.onClose);

  return (
    <div className="settingsModalBackdrop" role="presentation" onClick={props.onClose}>
      <div
        ref={dialogRef}
        className="settingsModal"
        role="dialog"
        aria-modal="true"
        aria-label="Settings"
        onClick={(event) => event.stopPropagation()}
      >
        <SettingsSurface
          connections={props.connections}
          defaultSlug={props.defaultSlug}
          onRefresh={props.onRefresh}
          onClose={props.onClose}
          themePref={props.themePref}
          onThemeChange={props.onThemeChange}
          density={props.density}
          onDensityChange={props.onDensityChange}
          onUserLabelChange={props.onUserLabelChange}
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
  themePref: ThemePreference;
  onThemeChange(pref: ThemePreference): void;
  density: UiDensity;
  onDensityChange(density: UiDensity): void;
  onUserLabelChange?(label: string): void;
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
    if (patch.personalization?.displayName !== undefined) {
      props.onUserLabelChange?.(next.personalization.displayName);
    }
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
          <span>设置 <kbd>⌘</kbd><kbd>,</kbd></span>
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
              <span className="settingsNavGlyph" aria-hidden="true">
                <item.Icon size={16} strokeWidth={1.5} />
              </span>
              <strong>{item.label}</strong>
              {item.comingSoon && <em className="settingsNavBadge" aria-label="即将推出">Soon</em>}
            </button>
          ))}
        </nav>
      </aside>

      <section className="settingsMainPane">
        <header className="settingsPageHeader">
          <h2>{activeItem.label}</h2>
          <button className="settingsCloseButton" type="button" aria-label="Close settings" onClick={props.onClose}>
            <X strokeWidth={1.75} aria-hidden="true" />
          </button>
        </header>

        <div className="settingsPageContent">
          {loading ? (
            <SettingsSkeleton />
          ) : (
            <SettingsPage
              section={section}
              settings={settings}
              usageStats={usageStats}
              connections={props.connections}
              defaultSlug={props.defaultSlug}
              themePref={props.themePref}
              density={props.density}
              onRefreshConnections={props.onRefresh}
              onUpdateSettings={updateSettings}
              onReloadUsage={reloadUsage}
              onThemeChange={props.onThemeChange}
              onDensityChange={props.onDensityChange}
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
  themePref: ThemePreference;
  density: UiDensity;
  onRefreshConnections(): Promise<void>;
  onUpdateSettings(patch: Parameters<typeof window.maka.settings.update>[0]): Promise<AppSettings>;
  onReloadUsage(range?: UsageRange): Promise<void>;
  onThemeChange(pref: ThemePreference): void;
  onDensityChange(density: UiDensity): void;
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
      return <AboutSettingsPage />;
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
        <ThemeSettingsPage
          themePref={props.themePref}
          density={props.density}
          onUpdate={props.onUpdateSettings}
          onThemeChange={props.onThemeChange}
          onDensityChange={props.onDensityChange}
        />
      );
    case 'personalization':
      return <PersonalizationSettingsPage settings={props.settings} onUpdate={props.onUpdateSettings} />;
    case 'account':
      return (
        <SettingsRows>
          <SettingRow title="权限策略" detail="敏感工具调用前需要确认。" value="Ask" />
          <SettingRow title="凭据保护" detail="API key 使用系统 safeStorage 加密。" value="Enabled" />
        </SettingsRows>
      );
    default: {
      const copy = COMING_SOON_PAGES[props.section];
      if (copy) {
        return <ComingSoonPage copy={copy} />;
      }
      return (
        <SettingsRows>
          <SettingRow title={navLabel(props.section)} detail="该设置页已纳入 Maka 设置树，会随对应 runtime 能力一起工作。" value="Ready" />
        </SettingsRows>
      );
    }
  }
}

type AppInfo = Awaited<ReturnType<typeof window.maka.app.info>>;

const PLATFORM_LABEL: Record<string, string> = {
  darwin: 'macOS',
  win32: 'Windows',
  linux: 'Linux',
};

function AboutSettingsPage() {
  const [info, setInfo] = useState<AppInfo | null>(null);

  useEffect(() => {
    let cancelled = false;
    window.maka.app
      .info()
      .then((next) => {
        if (!cancelled) setInfo(next);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  if (!info) {
    return (
      <div className="maka-skeleton-stack" aria-busy="true" aria-label="Loading about page">
        <div className="maka-skeleton maka-skeleton-line" data-size="lg" style={{ width: '38%' }} />
        <div className="maka-skeleton maka-skeleton-line" style={{ width: '70%' }} />
        <div className="maka-skeleton maka-skeleton-line" style={{ width: '52%' }} />
      </div>
    );
  }

  const platformPretty = PLATFORM_LABEL[info.platform] ?? info.platform;
  const platformLine = `${platformPretty} ${info.osRelease} · ${info.arch}`;
  return (
    <SettingsRows>
      <SettingRow title="Maka 版本" detail="Local development build." value={`v${info.appVersion}`} />
      <SettingRow title="运行时" detail="Renderer + Electron + Node 三层版本号一并显示。" value={`Electron ${info.electronVersion} · Node ${info.nodeVersion} · Chrome ${info.chromeVersion}`} />
      <SettingRow title="平台" detail="操作系统、版本和 CPU 架构。" value={platformLine} />
      <SettingRow title="工作区" detail="会话、设置、credential 全部留在本地这条路径下。" value={info.workspacePath} />
      <SettingRow title="存储" detail="JSONL sessions、settings.json、encrypted provider credentials。" value="Local" />
    </SettingsRows>
  );
}

function SettingsSkeleton() {
  return (
    <div className="settingsLoadingSkeleton" aria-busy="true" aria-label="Loading settings">
      <div className="maka-skeleton-stack">
        <div className="maka-skeleton maka-skeleton-line" data-size="lg" style={{ width: '38%' }} />
        <div className="maka-skeleton maka-skeleton-card" />
        <div className="maka-skeleton maka-skeleton-line" data-size="sm" style={{ width: '60%' }} />
        <div className="maka-skeleton maka-skeleton-line" style={{ width: '85%' }} />
        <div className="maka-skeleton maka-skeleton-line" style={{ width: '72%' }} />
        <div className="maka-skeleton maka-skeleton-line" style={{ width: '48%' }} />
      </div>
    </div>
  );
}

function ComingSoonPage(props: { copy: ComingSoonCopy }) {
  const { Icon, headline, description, bullets } = props.copy;
  return (
    <section className="settingsComingSoonPage" aria-label={headline}>
      <div className="settingsComingSoonHero">
        <span className="settingsComingSoonIcon" aria-hidden="true">
          <Icon size={28} strokeWidth={1.5} />
        </span>
        <div>
          <h3>{headline}</h3>
          <p>{description}</p>
        </div>
      </div>
      <ul className="settingsComingSoonList">
        {bullets.map((bullet) => (
          <li key={bullet}>{bullet}</li>
        ))}
      </ul>
      <p className="settingsHelpText">
        这些能力会随 Maka V0.2 路线推进逐步开放；想优先看到哪条，请在 issue tracker 提一下偏好。
      </p>
    </section>
  );
}

const THEME_OPTIONS: Array<{ value: ThemePreference; label: string; help: string }> = [
  { value: 'light', label: '浅色', help: '始终使用浅色界面。' },
  { value: 'dark', label: '深色', help: '始终使用深色界面。' },
  { value: 'auto', label: '跟随系统', help: '匹配 macOS 的当前 Light/Dark 偏好。' },
];

function PersonalizationSettingsPage(props: {
  settings: AppSettings;
  onUpdate(patch: Parameters<typeof window.maka.settings.update>[0]): Promise<AppSettings>;
}) {
  const value = props.settings.personalization;
  const [displayName, setDisplayName] = useState(value.displayName);
  const [assistantTone, setAssistantTone] = useState(value.assistantTone);
  const toast = useToast();
  const [saving, setSaving] = useState(false);

  async function save() {
    setSaving(true);
    try {
      await props.onUpdate({
        personalization: {
          displayName: displayName.trim().slice(0, 60),
          assistantTone: assistantTone.trim().slice(0, 500),
        },
      });
      toast.success('个性化已保存');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      toast.error('保存失败', message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="settingsStructuredPage">
      <label className="settingsField">
        <span>显示名称</span>
        <input
          type="text"
          value={displayName}
          onChange={(event) => setDisplayName(event.currentTarget.value)}
          placeholder="例如：JK"
          maxLength={60}
          autoComplete="off"
          spellCheck={false}
        />
        <small>Maka 在聊天里会以这个名字称呼你。留空就用默认的「你」。</small>
      </label>

      <label className="settingsField">
        <span>助手语气偏好</span>
        <textarea
          value={assistantTone}
          onChange={(event) => setAssistantTone(event.currentTarget.value)}
          placeholder="一句话告诉助手期望的语气，比如：技术严谨 / 偏简洁 / 不要 emoji / 多反问。"
          rows={4}
          maxLength={500}
          spellCheck={false}
          style={{ minHeight: 84, resize: 'vertical', borderRadius: 12 }}
        />
        <small>这段会拼到 system prompt 末尾。500 字符内。</small>
      </label>

      <div className="settingsActionRow">
        <button
          type="button"
          className="maka-button"
          data-variant="primary"
          disabled={saving}
          onClick={() => void save()}
        >
          {saving ? '保存中…' : '保存'}
        </button>
        <p className="settingsHelpText">保存后立即生效，下一次发送对话时模型会拿到新偏好。</p>
      </div>
    </div>
  );
}

const DENSITY_OPTIONS: Array<{ value: UiDensity; label: string; help: string }> = [
  { value: 'compact', label: '紧凑', help: '减小行间距与控件高度，更接近 IDE 风格。' },
  { value: 'comfortable', label: '舒适', help: '默认。平衡阅读和密度。' },
  { value: 'spacious', label: '宽松', help: '更大留白，适合长会话沉浸阅读。' },
];

function ThemeSettingsPage(props: {
  themePref: ThemePreference;
  density: UiDensity;
  onUpdate(patch: Parameters<typeof window.maka.settings.update>[0]): Promise<AppSettings>;
  onThemeChange(pref: ThemePreference): void;
  onDensityChange(density: UiDensity): void;
}) {
  async function setTheme(next: ThemePreference) {
    // Apply immediately for instant feedback, then persist. If persistence
    // fails the visual stays — the next app start will re-read whatever
    // landed on disk.
    props.onThemeChange(next);
    await props.onUpdate({ appearance: { theme: next } });
  }

  async function setDensity(next: UiDensity) {
    props.onDensityChange(next);
    await props.onUpdate({ appearance: { density: next } });
  }

  return (
    <div className="settingsStructuredPage">
      <h3 className="settingsSubheading">主题</h3>
      <div className="settingsThemeOptions" role="radiogroup" aria-label="主题">
        {THEME_OPTIONS.map((option) => (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={props.themePref === option.value}
            data-active={props.themePref === option.value}
            className="settingsThemeOption"
            onClick={() => void setTheme(option.value)}
          >
            <span className="settingsThemeSwatch" data-variant={option.value} aria-hidden="true" />
            <span className="settingsThemeLabel">
              <strong>{option.label}</strong>
              <small>{option.help}</small>
            </span>
          </button>
        ))}
      </div>

      <h3 className="settingsSubheading">界面密度</h3>
      <div className="settingsThemeOptions settingsDensityOptions" role="radiogroup" aria-label="界面密度">
        {DENSITY_OPTIONS.map((option) => (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={props.density === option.value}
            data-active={props.density === option.value}
            className="settingsThemeOption"
            onClick={() => void setDensity(option.value)}
          >
            <span className={`settingsDensitySwatch settingsDensitySwatch-${option.value}`} aria-hidden="true">
              <span /><span /><span />
            </span>
            <span className="settingsThemeLabel">
              <strong>{option.label}</strong>
              <small>{option.help}</small>
            </span>
          </button>
        ))}
      </div>

      <p className="settingsHelpText">
        切换会立即生效，并保存在 <code className="maka-empty-state-code">settings.json</code> 里下次启动延续。
      </p>
    </div>
  );
}

function NetworkSettingsPage(props: {
  settings: AppSettings;
  onUpdate(patch: Parameters<typeof window.maka.settings.update>[0]): Promise<AppSettings>;
}) {
  const proxy = props.settings.network.proxy;
  const [testing, setTesting] = useState(false);
  const toast = useToast();

  async function updateProxy(patch: Partial<NetworkProxySettings>) {
    await props.onUpdate({ network: { proxy: patch } });
  }

  async function testProxy() {
    setTesting(true);
    try {
      const result = await window.maka.settings.testNetworkProxy(toProxyTestInput(proxy));
      const latency = result.latencyMs !== undefined ? ` · ${result.latencyMs} ms` : '';
      if (result.ok) {
        toast.success('代理可达', `${result.message}${latency}`);
      } else {
        toast.error('代理测试失败', result.message);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      toast.error('代理测试出错', message);
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
              {testing ? '测试中…' : '测试当前配置'}
            </button>
          </div>
        </>
      )}
    </div>
  );
}

function toProxyTestInput(proxy: NetworkProxySettings): TestProxyInput {
  return {
    proxy: {
      enabled: proxy.enabled,
      type: proxy.protocol,
      host: proxy.host.trim(),
      port: proxy.port,
      username: proxy.authEnabled && proxy.username.trim() ? proxy.username.trim() : undefined,
      password: proxy.authEnabled && proxy.password ? proxy.password : undefined,
      bypassList: proxy.bypassList,
    },
  };
}

function BotChatSettingsPage(props: {
  settings: AppSettings;
  onUpdate(patch: Parameters<typeof window.maka.settings.update>[0]): Promise<AppSettings>;
}) {
  const [selected, setSelected] = useState<BotProvider>('telegram');
  const [testing, setTesting] = useState(false);
  const channel = props.settings.botChat.channels[selected];
  const toast = useToast();

  async function updateChannel(patch: Partial<typeof channel>) {
    await props.onUpdate({ botChat: { channels: { [selected]: patch } } });
  }

  async function testChannel() {
    setTesting(true);
    try {
      const result = await window.maka.settings.testBotChannel(selected);
      const platform = BOT_LABELS[selected].label;
      if (result.ok) {
        toast.success(`${platform} 连接成功`, result.message);
      } else {
        toast.error(`${platform} 连接失败`, result.message);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      toast.error('Bot 测试出错', message);
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
          <input type="password" value={channel.token} onChange={(event) => updateChannel({ token: event.currentTarget.value })} placeholder="123456:ABC-DEF…" />
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
            {testing ? '测试中…' : '测试并连接'}
          </button>
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
        <button className="maka-button" type="button" disabled={refreshing} onClick={refresh}>{refreshing ? '刷新中…' : '刷新'}</button>
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
        <input value={usage.modelFilter} onChange={(event) => void props.onUpdate({ usage: { modelFilter: event.currentTarget.value } })} placeholder="按模型筛选…" />
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
