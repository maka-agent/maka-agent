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
import { openPathFailureCopy, openPathActionLabel } from '../open-path';

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
  { id: 'data', label: '数据', Icon: Database, enabled: true },
  { id: 'account', label: '账号', Icon: UserCircle, enabled: true },
  { id: 'about', label: '关于', Icon: Info, enabled: true },
];

/**
 * V0.2 product-stance copy for Coming Soon Settings pages. The shape is
 * derived from @kenji's contract notes (`notes/maka-*-contract.md`) and is
 * surfaced as four explicit sections — `当前状态 / 会包含什么 / 不会做什么 /
 * 下一步需要配置什么` — so the UI reads as a deliberate disabled-by-default
 * stance rather than empty placeholder.
 */
type ComingSoonCopy = {
  Icon: ComponentType<LucideProps>;
  headline: string;
  /** Short tag like "V0.2 · disabled-by-default" rendered as a badge on the hero. */
  badge?: string;
  description: string;
  /** 当前状态 — one-sentence honest status now. */
  status: string;
  /** 会包含什么 — concrete capabilities V0.2 will ship. */
  willInclude: string[];
  /** 不会做什么 — explicit non-goals / hard boundaries (the safety contract). */
  willNotDo: string[];
  /** 下一步需要配置什么 — what the user / project must do before it can flip on. */
  nextConfig: string[];
};

const COMING_SOON_PAGES: Partial<Record<SettingsSection, ComingSoonCopy>> = {
  'daily-review': {
    Icon: CalendarDays,
    headline: '每日回顾',
    badge: 'V0.2 · opt-in · 本地汇总',
    description:
      '把当天的 Maka 会话、任务、工具调用本地聚合成一份精炼简报。整条管线默认关闭，启用后只读取 Maka 自己产生的数据。',
    status: '当前未启用。V0.2 会作为单独的开关上线，默认仍是关闭状态。',
    willInclude: [
      '把当天会话按时段 / 主题聚类，凸显已完成的决策与进展',
      '汇总「使用统计」当天的 token / 费用，不重复算账',
      '允许导出 Markdown / PDF，或推送到用户自配的 Telegram / 飞书 bot',
      '生成简报时复用当前默认 provider 与代理设置，受权限策略约束',
    ],
    willNotDo: [
      '不截屏、不监听键盘、不读取其他 App 的数据',
      '不读取系统文件系统，只读取 Maka 自己的会话 JSONL',
      '不向云端上传原始消息，只把生成简报所需的最小上下文交给所选模型',
      '不在用户关闭功能后偷偷继续聚合或保留临时索引',
    ],
    nextConfig: [
      '在「每日回顾」内显式开启功能并选择执行节奏（每日 / 每周 / 每月）',
      '选择用于摘要的模型 connection（建议本地 / 自部署模型）',
      '可选：配置导出目录或推送 bot（Telegram / 飞书 webhook）',
    ],
  },
  'voice-models': {
    Icon: Volume2,
    headline: '语音模型',
    badge: 'V0.2 · per-session opt-in · 麦克风需授权',
    description:
      '为 Maka 接入本地或云端的 TTS / STT，让对话可以语音输入和回放。语音是单独的能力，必须显式启用，与文本通道分开管理。',
    status: '当前未启用。麦克风权限尚未申请，应用不会主动调用任何音频设备。',
    willInclude: [
      '本地 TTS：piper / coqui，零网络延迟',
      '云端 STT：Whisper / GPT-4o Realtime / Gemini Live',
      '按 connection 单独切换语音模型，文本通道不受影响',
      '语音转写结果走与文本同等的权限审计与本地 JSONL',
    ],
    willNotDo: [
      '不在未授权时打开麦克风；首次启用必须经过 macOS 系统授权对话框',
      '不在 UI 未明确披露上传范围前向云端 STT 传输音频',
      '不在客户端中预打包大体积本地 STT 模型，所有模型文件由用户授权后下载',
      '不把语音转写结果发送给与文本对话不同的 provider，除非用户明确选择',
    ],
    nextConfig: [
      '在「语音模型」内显式启用语音通道并完成系统级麦克风授权',
      '选择 TTS / STT 的具体引擎与 connection',
      '可选：单独为语音通道配置代理、缓存目录或本地模型路径',
    ],
  },
  'open-gateway': {
    Icon: Sparkles,
    headline: '开放网关',
    badge: 'V0.2 · disabled-by-default · token-required · localhost-only',
    description:
      '把 Maka 当作本机的 OpenAI 兼容 API 暴露给其他工具（IDE / shell / 工作流引擎）。这是一个被严格收窄的本地网关：只代理模型调用，永远不暴露 Settings、tools、文件或 bot 控制权。',
    status: '当前未启用。即使在 V0.2 上线后，默认状态仍是关闭，必须显式开启。',
    willInclude: [
      '本机 :3939 暴露 OpenAI 兼容端点 (chat / models / health)',
      '启用时生成一次性 gateway token，每个请求必须 Authorization: Bearer',
      '默认仅 bind 127.0.0.1；LAN 绑定需要在 Settings 中单独确认',
      '调用走当前默认 provider，复用 Maka 的凭据、代理与权限策略',
      '所有调用进入「使用统计」聚合，方便对账',
    ],
    willNotDo: [
      '不在未配置 gateway token 时接受任何请求',
      '不允许 token 读写 Settings、调用 tools、打开文件、安装 skills、启动 bots',
      '不接受 CORS *：跨源域必须在 allow-list 中显式列出',
      '不在 provider readiness 失败时静默走 fake fallback，永远返回结构化 needs_configuration',
      '不在日志中记 prompt / response / Authorization header；只记 status / latency / model alias / token hash / token counts',
    ],
    nextConfig: [
      '在「开放网关」内显式启用并生成 gateway token，保存到接入方的 secret store',
      '确认 bind 地址（127.0.0.1 或受信任的 LAN 网段）',
      '为跨源工具配置 CORS allow-list',
      '在所选默认 provider 的凭据完成 readiness 验证后再开启对外暴露',
    ],
  },
  search: {
    Icon: Search,
    headline: '搜索服务',
    badge: 'V0.2 · per-query opt-in · 走代理',
    description:
      '为助手挂接外部搜索能力，自动按提问类型选择源。每条搜索都经过权限策略与代理路由，UI 上可以单独关闭具体搜索源。',
    status: '当前未启用。Maka 不会主动联网搜索，所有搜索都必须由用户显式开启。',
    willInclude: [
      '主流引擎：Tavily / Brave Search / SerpAPI（自带凭据）',
      '自托管选项：SearxNG、MetaSo、本地索引',
      '查询缓存与隐私模式（含网络代理路由）',
      '按引擎单独关闭 / 启用，凭据测试通过后才放行真实查询',
    ],
    willNotDo: [
      '不在未启用任何引擎时静默回退到默认搜索',
      '不绕过 Settings 中配置的网络代理与超时',
      '不保留查询原文与返回 body，只保留 query hash / 引擎 / latency',
      '隐私模式下不写入会话 JSONL 以外的任何持久化存储',
    ],
    nextConfig: [
      '在「搜索服务」内逐个启用引擎并填入凭据，先通过连通性测试再保存',
      '选择代理路由策略（默认 / 直连 / 走 Maka 网络代理）',
      '可选：开启隐私模式，禁用缓存与日志',
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
  const [section, setSection] = useState<SettingsSection>(() => readLastSettingsSection());

  useEffect(() => {
    try {
      localStorage.setItem('maka-settings-section-v1', section);
    } catch {
      /* localStorage unavailable */
    }
  }, [section]);
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
    case 'data':
      return <DataSettingsPage />;
    case 'account':
      return <AccountSettingsPage connections={props.connections} />;
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
  const toast = useToast();

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

  async function copyEnvSummary() {
    if (!info) return;
    // Markdown block ready to paste into a bug report. Deliberately excludes
    // workspacePath since that can leak the OS username; user can still copy
    // it from the Data page if needed.
    const summary = [
      `**Maka** v${info.appVersion}`,
      ``,
      `- Electron: ${info.electronVersion}`,
      `- Node: ${info.nodeVersion}`,
      `- Chrome: ${info.chromeVersion}`,
      `- Platform: ${platformPretty} ${info.osRelease}`,
      `- Arch: ${info.arch}`,
    ].join('\n');
    try {
      await navigator.clipboard.writeText(summary);
      toast.success('已复制环境信息', '可直接粘贴到 bug report');
    } catch {
      toast.error('复制失败', '剪贴板不可用');
    }
  }

  return (
    <div className="settingsAboutPage">
      <header className="settingsAboutHero">
        <span className="settingsAboutLogo" aria-hidden="true">
          <Sparkles size={26} strokeWidth={1.5} />
        </span>
        <div>
          <div className="settingsAboutHeading">
            <h2>Maka</h2>
            <span className="settingsAboutVersion">v{info.appVersion}</span>
            <span className="settingsAboutChannel">本地开发版</span>
          </div>
          <p className="settingsAboutTagline">本地优先的 AI 助手 · Electron + React + Vercel AI SDK</p>
        </div>
      </header>

      <section className="settingsAboutPrivacy" aria-label="隐私与安全">
        <h3>本地优先 · 隐私默认</h3>
        <ul>
          <li>所有会话、settings、credentials、skills 都保留在本机工作区，不上传到 Maka 服务器</li>
          <li>provider API key 通过 Electron safeStorage 加密保存（macOS Keychain / Windows DPAPI / Linux libsecret）</li>
          <li>Maka 不发送任何使用遥测；只在你显式启用时与所选 provider 通信</li>
          <li>权限策略对工具调用做 risk 分类；高危操作需要在 chat 内明示授权</li>
          <li>每个会话的 JSONL 留存所有消息、tool 调用、权限决策与 mode_change，永不离开本机</li>
        </ul>
      </section>

      <SettingsRows>
        <SettingRow
          title="运行时"
          detail="Renderer + Electron + Node 三层版本号一并显示。"
          value={`Electron ${info.electronVersion} · Node ${info.nodeVersion} · Chrome ${info.chromeVersion}`}
        />
        <SettingRow title="平台" detail="操作系统、版本和 CPU 架构。" value={platformLine} />
        <SettingRow
          title="工作区"
          detail="会话、设置、credential 全部留在本地这条路径下。"
          value={info.workspacePath}
        />
        <SettingRow
          title="存储"
          detail="JSONL sessions、settings.json、SQLite usage stats、safeStorage 加密的 provider credentials。"
          value="Local"
        />
      </SettingsRows>

      <div className="settingsActionRow">
        <button type="button" className="maka-button" onClick={() => void copyEnvSummary()}>
          复制环境信息
        </button>
      </div>
      <p className="settingsHelpText">
        如果遇到问题，复制以上信息会同时带上版本号与平台细节，方便定位。复制内容不包含工作区路径（避免泄露用户名）。
      </p>
    </div>
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
  const { Icon, headline, badge, description, status, willInclude, willNotDo, nextConfig } = props.copy;
  return (
    <section className="settingsComingSoonPage" aria-label={headline}>
      <div className="settingsComingSoonHero">
        <span className="settingsComingSoonIcon" aria-hidden="true">
          <Icon size={28} strokeWidth={1.5} />
        </span>
        <div>
          <div className="settingsComingSoonHeroHeading">
            <h3>{headline}</h3>
            {badge ? <span className="settingsComingSoonBadge">{badge}</span> : null}
          </div>
          <p>{description}</p>
        </div>
      </div>

      <ComingSoonSection tone="status" title="当前状态">
        <p>{status}</p>
      </ComingSoonSection>

      <ComingSoonSection tone="include" title="会包含什么">
        <ul className="settingsComingSoonList">
          {willInclude.map((bullet) => (
            <li key={bullet}>{bullet}</li>
          ))}
        </ul>
      </ComingSoonSection>

      <ComingSoonSection tone="exclude" title="不会做什么">
        <ul className="settingsComingSoonList settingsComingSoonListExclude">
          {willNotDo.map((bullet) => (
            <li key={bullet}>{bullet}</li>
          ))}
        </ul>
      </ComingSoonSection>

      <ComingSoonSection tone="config" title="下一步需要配置什么">
        <ul className="settingsComingSoonList">
          {nextConfig.map((bullet) => (
            <li key={bullet}>{bullet}</li>
          ))}
        </ul>
      </ComingSoonSection>

      <p className="settingsHelpText">
        这些边界来自 V0.2 contract（see <code>notes/maka-*-contract.md</code>）。每条「不会做什么」都是要在实现里加上 test gate 的硬规则，不是宣传语。
      </p>
    </section>
  );
}

function ComingSoonSection(props: {
  tone: 'status' | 'include' | 'exclude' | 'config';
  title: string;
  children: ReactNode;
}) {
  return (
    <div className={`settingsComingSoonSection settingsComingSoonSection-${props.tone}`}>
      <h4 className="settingsComingSoonSectionTitle">{props.title}</h4>
      {props.children}
    </div>
  );
}

const THEME_OPTIONS: Array<{ value: ThemePreference; label: string; help: string }> = [
  { value: 'light', label: '浅色', help: '始终使用浅色界面。' },
  { value: 'dark', label: '深色', help: '始终使用深色界面。' },
  { value: 'auto', label: '跟随系统', help: '匹配 macOS 的当前 Light/Dark 偏好。' },
];

function AccountSettingsPage(props: { connections: LlmConnection[] }) {
  // Pull real per-connection state instead of the previous "Ask / Enabled"
  // placeholders. The PermissionEngine + safeStorage are background facts the
  // page should surface honestly, not vague labels.
  const enabledCount = props.connections.filter((connection) => connection.enabled).length;
  const totalCount = props.connections.length;
  return (
    <div className="settingsStructuredPage">
      <SettingsRows>
        <SettingRow
          title="默认权限模式"
          detail="新会话默认从 Ask 模式开始；可在 chat header 切到 Explore / Execute。"
          value="需要确认 (ask)"
        />
        <SettingRow
          title="凭据保护"
          detail="API key 使用 Electron safeStorage 加密（macOS Keychain / Windows DPAPI / Linux libsecret）。"
          value="启用"
        />
        <SettingRow
          title="审计日志"
          detail="每个会话的 JSONL 留存所有消息、tool 调用、权限决策与 mode_change，永不离开本机。"
          value="本地"
        />
      </SettingsRows>

      <h3 className="settingsSubheading">模型连接</h3>
      {totalCount === 0 ? (
        <div className="settingsEmptyState">未配置任何模型连接。可在 设置 · 模型 添加。</div>
      ) : (
        <div className="settingsRows">
          {props.connections.map((connection) => {
            // Per @kenji's contract: we surface configured vs not, but
            // can't honestly say "verified" until backend adds a
            // lastTestStatus enum. Until then, enabled = has-been-saved.
            const status = connection.enabled ? '已启用，未验证' : '已禁用';
            const subtitle = `${connection.providerType} · ${connection.defaultModel || 'no default model'}`;
            return (
              <div key={connection.slug} className="settingsRow">
                <div>
                  <strong>{connection.name}</strong>
                  <small>{subtitle}</small>
                </div>
                <span>{status}</span>
              </div>
            );
          })}
        </div>
      )}
      <p className="settingsHelpText">
        显示 “{enabledCount} 已启用 / {totalCount} 总数”。一旦后端补上 lastTestStatus，
        这里会区分 已配置 / 已验证 / 需要重新登录 / 错误 五种状态。
      </p>
    </div>
  );
}

function DataSettingsPage() {
  const [info, setInfo] = useState<Awaited<ReturnType<typeof window.maka.app.info>> | null>(null);
  const toast = useToast();

  useEffect(() => {
    let cancelled = false;
    void window.maka.app.info().then((next) => {
      if (!cancelled) setInfo(next);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  async function openWorkspace() {
    if (!info) return;
    const result = await window.maka.app.openPath('workspace');
    if (!result.ok) {
      toast.error(`无法打开${openPathActionLabel('workspace')}`, openPathFailureCopy(result.reason));
    }
  }

  async function copyPath() {
    if (!info) return;
    try {
      await navigator.clipboard.writeText(info.workspacePath);
      toast.success('已复制工作区路径');
    } catch {
      toast.error('复制失败', '剪贴板不可用');
    }
  }

  return (
    <div className="settingsStructuredPage">
      <SettingsRows>
        <SettingRow
          title="工作区路径"
          detail="会话、设置、credentials、skills 都存在这个目录下。"
          value={info?.workspacePath ?? '正在加载…'}
        />
        <SettingRow
          title="存储引擎"
          detail="JSONL 会话、settings.json、SQLite usage stats、safeStorage 加密的 API key。"
          value="本地文件"
        />
      </SettingsRows>
      <div className="settingsActionRow">
        <button
          type="button"
          className="maka-button"
          data-variant="primary"
          onClick={() => void openWorkspace()}
          disabled={!info}
        >
          在 Finder / 资源管理器中打开
        </button>
        <button
          type="button"
          className="maka-button"
          onClick={() => void copyPath()}
          disabled={!info}
        >
          复制路径
        </button>
      </div>
      <div className="settingsNotice">
        提示：导出整个 workspace 为 .maka.zip、按 schemaVersion 升级导入备份等
        能力会在 V0.2 阶段开放。现在可以在 Finder 里直接打包整个目录做手动备份。
      </div>
    </div>
  );
}

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
        <small>
          以低优先级用户偏好拼到 system prompt，500 字符内。Runtime 仍按权限策略和工具规则
          独立判定 —— 此处不能写成"忽略前面规则"或"不要再询问"这种指令，会被忽略。
        </small>
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

function readLastSettingsSection(): SettingsSection {
  try {
    const value = localStorage.getItem('maka-settings-section-v1');
    if (!value) return 'models';
    if (SETTINGS_NAV.some((item) => item.id === value)) {
      return value as SettingsSection;
    }
  } catch {
    /* fall through */
  }
  return 'models';
}

function csvList(value: string): string[] {
  return value.split(',').map((part) => part.trim()).filter(Boolean);
}

function navLabel(section: SettingsSection): string {
  return SETTINGS_NAV.find((item) => item.id === section)?.label ?? section;
}
