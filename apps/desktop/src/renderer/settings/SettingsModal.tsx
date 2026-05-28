import { useEffect, useMemo, useRef, useState, type ComponentType, type ReactNode } from 'react';
import {
  Activity,
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
  ShieldCheck,
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
  BotReadinessState,
  CapabilityId,
  CapabilityReadinessState,
  CapabilitySnapshot,
  CapabilitySnapshotCollection,
  HealthSignal,
  HealthSignalLayer,
  HealthSignalStatus,
  HealthSnapshot,
  LlmConnection,
  NetworkProxySettings,
  OsPermissionId,
  OsPermissionSnapshot,
  OsPermissionState,
  PermissionSnapshot,
  PersonalizationSettingsWarning,
  SettingsSection,
  ThemePreference,
  ToastPosition,
  UiDensity,
  UpdateAppSettingsResult,
  UsageRange,
  UsageStats,
  SubscriptionAccountState,
} from '@maka/core';
import type { BotStatus } from '@maka/runtime';
import type { TestProxyInput } from '@maka/core/settings/network-settings';
import {
  HEALTH_SIGNAL_LAYERS,
  OS_PERMISSION_IDS,
  deriveProviderAuthContractFromConnection,
  isToastPosition,
} from '@maka/core';
import { BOT_PROVIDERS, createDefaultSettings } from '@maka/core/settings';
import { useModalA11y, useToast } from '@maka/ui';
import { ProvidersPanel } from './ProvidersPanel';
import { openPathFailureCopy, openPathActionLabel } from '../open-path';
import {
  deriveAccountAuthActions,
  presentAccountAuthState,
  type AccountAuthActionPresentation,
} from './account-auth-ui';
import {
  connectionUiStatusFromRecord,
  presentConnectionUiStatus,
  type ConnectionUiStatus,
} from '../connection-status';
import {
  NAV_GROUP_ORDER,
  deriveNavGroupSummary,
  type NavGroupSummary,
  type SettingsNavGroup,
} from './nav-group-summary';

type SettingsNavItem = {
  id: SettingsSection;
  label: string;
  Icon: ComponentType<LucideProps>;
  enabled: boolean;
  comingSoon?: boolean;
  /** Group label rendered as a small uppercase divider above this item. */
  group: SettingsNavGroup;
};

// `SettingsNavGroup` + `NAV_GROUP_ORDER` moved to `nav-group-summary.ts`
// (PR-HEALTH-1) so the H1/H2 group-summary assertions can be pinned with
// node:test without a DOM / React.
export type { SettingsNavGroup };

export const SETTINGS_NAV: SettingsNavItem[] = [
  // Group 1: 基础 — 通用偏好、个性化、主题
  { id: 'general', label: '通用', Icon: SettingsIcon, enabled: true, group: '基础' },
  { id: 'personalization', label: '个性化', Icon: User, enabled: true, group: '基础' },
  { id: 'theme', label: '主题', Icon: Palette, enabled: true, group: '基础' },
  // Group 2: AI — 模型、使用、语音、回顾、网关
  { id: 'models', label: '模型', Icon: Cpu, enabled: true, group: 'AI' },
  { id: 'usage', label: '使用统计', Icon: BarChart3, enabled: true, group: 'AI' },
  { id: 'daily-review', label: '每日回顾', Icon: CalendarDays, enabled: true, comingSoon: true, group: 'AI' },
  { id: 'voice-models', label: '语音模型', Icon: Volume2, enabled: true, comingSoon: true, group: 'AI' },
  { id: 'open-gateway', label: '开放网关', Icon: Sparkles, enabled: true, comingSoon: true, group: 'AI' },
  // Group 3: 集成 — bot、搜索、网络
  { id: 'bot-chat', label: '机器人对话', Icon: Bot, enabled: true, group: '集成' },
  // PR-UX-POLISH-1 commit 2 (yuejing UX audit msg `9c779b56`):
  // renamed `搜索服务` → `联网搜索` so it doesn't collide semantically
  // with the sidebar's local-content search modal (which is a
  // completely different feature — search across thread / session
  // text, not web). Future Settings page wires per-engine credentials
  // for web-search providers; the sidebar's modal stays the
  // local-content search UI.
  { id: 'search', label: '联网搜索', Icon: Search, enabled: true, comingSoon: true, group: '集成' },
  { id: 'network', label: '网络', Icon: Globe, enabled: true, group: '集成' },
  // Group 4: 数据与账号
  { id: 'data', label: '数据', Icon: Database, enabled: true, group: '数据与账号' },
  { id: 'account', label: '账号', Icon: UserCircle, enabled: true, group: '数据与账号' },
  // Group 5: 其他
  { id: 'permissions', label: '权限与能力', Icon: ShieldCheck, enabled: true, group: '其他' },
  { id: 'health', label: '健康', Icon: Activity, enabled: true, group: '其他' },
  { id: 'about', label: '关于', Icon: Info, enabled: true, group: '其他' },
];

/** Order-preserving grouping used by the nav renderer. */
function groupedNav(): Array<{ group: SettingsNavGroup; items: SettingsNavItem[] }> {
  const byGroup = new Map<SettingsNavGroup, SettingsNavItem[]>();
  for (const item of SETTINGS_NAV) {
    if (!byGroup.has(item.group)) byGroup.set(item.group, []);
    byGroup.get(item.group)!.push(item);
  }
  return NAV_GROUP_ORDER.flatMap((group) => {
    const items = byGroup.get(group);
    return items && items.length > 0 ? [{ group, items }] : [];
  });
}

// `navGroupSummary` + its return type extracted to
// `./nav-group-summary.ts` (PR-HEALTH-1, msg `e4887ffd`). The renderer
// uses the imported `deriveNavGroupSummary` below; the H1/H2 assertions
// are pinned in `apps/desktop/src/main/__tests__/nav-group-summary.test.ts`.
const navGroupSummary = deriveNavGroupSummary;
export type { NavGroupSummary };

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
      '把当天的 Maka 会话、任务、工具调用本地聚合成一份精炼简报。整条管线默认关闭，上线后只读取 Maka 自己产生的数据。',
    status: '当前尚未实现。V0.2 会以独立开关的形式上线，默认仍是关闭状态。',
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
      '功能停止后不会偷偷继续聚合或保留临时索引',
    ],
    nextConfig: [
      '未来在「每日回顾」内由用户显式选择运行节奏（每日 / 每周 / 每月）',
      '选择用于摘要的模型 connection（建议本地 / 自部署模型）',
      '可选：指定导出目录或推送 bot（Telegram / 飞书 webhook）',
    ],
  },
  'voice-models': {
    Icon: Volume2,
    headline: '语音模型',
    badge: 'V0.2 · per-session opt-in · 麦克风需 OS 权限',
    description:
      '为 Maka 提供本地或云端的 TTS / STT，让对话可以语音输入和回放。语音是单独的能力，未来由用户显式选择，与文本通道分开管理。',
    status: '当前尚未实现。麦克风权限尚未申请，应用不会主动调用任何音频设备。',
    willInclude: [
      '本地 TTS：piper / coqui，零网络延迟',
      '云端 STT：Whisper / GPT-4o Realtime / Gemini Live',
      '按 connection 独立配置语音模型，文本通道不受影响',
      '语音转写结果走与文本同等的权限审计与本地 JSONL',
    ],
    willNotDo: [
      '没有用户在 macOS 中明确同意时不会访问麦克风；上线后首次需要经过系统级权限对话框',
      '在 UI 未明确披露上传范围前不会向云端 STT 传输音频',
      '客户端中不预打包大体积本地 STT 模型，所有模型文件需要用户明确同意后才会下载',
      '语音转写结果不会发送给与文本对话不同的 provider，除非用户明确选择',
    ],
    nextConfig: [
      '未来在「语音模型」内由用户显式选择语音通道，并经由 macOS 系统获取麦克风权限',
      '选择 TTS / STT 的具体引擎与 connection',
      '可选：单独为语音通道指定代理、缓存目录或本地模型路径',
    ],
  },
  'open-gateway': {
    Icon: Sparkles,
    headline: '开放网关',
    badge: 'V0.2 · disabled-by-default · token-required · localhost-only',
    description:
      '把 Maka 当作本机的 OpenAI 兼容 API 暴露给其他工具（IDE / shell / 工作流引擎）。这是一个被严格收窄的本地网关：只代理模型调用，永远不暴露 Settings、tools、文件或 bot 控制权。',
    status: '当前尚未实现。即使在 V0.2 上线后，默认状态仍是关闭，未来由用户显式发起。',
    willInclude: [
      '本机 :3939 暴露 OpenAI 兼容端点 (chat / models / health)',
      '上线时生成一次性 gateway token，每个请求必须 Authorization: Bearer',
      '默认仅 bind 127.0.0.1；LAN 绑定需要在 Settings 中单独确认',
      '调用走当前默认 provider，复用 Maka 的凭据、代理与权限策略',
      '所有调用进入「使用统计」聚合，方便对账',
    ],
    willNotDo: [
      '没有 gateway token 配置时不会接受任何请求',
      'token 不允许读写 Settings、调用 tools、读写文件、安装 skills、运行 bots',
      'CORS * 不被接受：跨源域必须在 allow-list 中显式列出',
      'provider readiness 失败时不会静默走 fake fallback，永远返回结构化 needs_configuration',
      '日志不记 prompt / response / Authorization header；只记 status / latency / model alias / token hash / token counts',
    ],
    nextConfig: [
      '未来在「开放网关」内由用户显式生成 gateway token，保存到使用方的 secret store',
      '确认 bind 地址（127.0.0.1 或受信任的 LAN 网段）',
      '为跨源工具指定 CORS allow-list',
      '在所选默认 provider 的凭据完成 readiness 校验后再向外暴露',
    ],
  },
  search: {
    Icon: Search,
    // PR-UX-POLISH-1 commit 2: same rename as nav label —
    // 联网搜索 vs sidebar local-content search.
    headline: '联网搜索',
    badge: 'V0.2 · per-query opt-in · 走代理',
    description:
      '为助手提供外部搜索能力，自动按提问类型选择源。每条搜索都经过权限策略与代理路由，UI 上可以按引擎独立声明可用性。',
    status: '当前尚未实现。Maka 不会主动联网搜索，所有搜索都需要由用户显式发起。',
    willInclude: [
      '主流引擎：Tavily / Brave Search / SerpAPI（自带凭据）',
      '自托管选项：SearxNG、MetaSo、本地索引',
      '查询缓存与隐私模式（含网络代理路由）',
      '按引擎独立配置可用性，凭据通过连通性校验后才放行真实查询',
    ],
    willNotDo: [
      '没有可用引擎时不会静默回退到默认搜索',
      '不绕过 Settings 中指定的网络代理与超时',
      '不保留查询原文与返回 body，只保留 query hash / 引擎 / latency',
      '隐私模式下不写入会话 JSONL 以外的任何持久化存储',
    ],
    nextConfig: [
      '未来在「搜索服务」内由用户逐个引擎填入凭据，先通过连通性校验再保存',
      '选择代理路由策略（默认 / 直连 / 走 Maka 网络代理）',
      '可选：切到隐私模式（不写缓存与日志）',
    ],
  },
};

const BOT_LABELS: Record<BotProvider, { label: string; help: string; support: 'runtime' | 'credentials' | 'planned' }> = {
  telegram: {
    label: 'Telegram',
    help: '填写机器人 Token 后测试凭据；启动监听后，用户发给机器人的消息会进入 Maka，会话完成后自动回复。',
    support: 'runtime',
  },
  feishu: {
    label: '飞书',
    help: '填写飞书自建应用的 App ID、App Secret 和事件订阅域名；当前先验证凭据，事件接收需要企业后台回调接入。',
    support: 'credentials',
  },
  wecom: { label: '企业微信', help: '企业微信机器人运行时尚未接入。', support: 'planned' },
  wechat: { label: '微信', help: '微信个人号/公众号接入涉及额外合规和授权，尚未接入。', support: 'planned' },
  discord: { label: 'Discord', help: 'Discord 机器人运行时尚未接入。', support: 'planned' },
  dingtalk: { label: '钉钉', help: '钉钉机器人运行时尚未接入。', support: 'planned' },
  qq: { label: 'QQ', help: 'QQ 机器人运行时尚未接入。', support: 'planned' },
};

const BOT_READINESS_COPY: Record<BotReadinessState, { label: string; detail: string; tone: 'neutral' | 'info' | 'success' | 'warning' | 'destructive' }> = {
  unscaffolded: { label: '未接入', detail: '代码中还没有这个平台的运行时。', tone: 'neutral' },
  scaffolded: { label: '待配置', detail: '还没有完成这个平台需要的凭据配置。', tone: 'neutral' },
  configured: { label: '已配置', detail: '已填写配置；还没有证明凭据或运行态可用。', tone: 'info' },
  credentials_valid: { label: '凭据有效', detail: '凭据探测通过；这不代表已能收发消息。', tone: 'warning' },
  operational: { label: '运行可用', detail: '最近一次运行态探测或收发 smoke 成功。', tone: 'success' },
  degraded: { label: '运行降级', detail: '之前可用，但最近运行态探测失败。', tone: 'destructive' },
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
  /**
   * PR-UI-D2 fixup v2 (@kenji msg b4dbfa91): current toast position
   * (source-of-truth lifted from `App`) and live setter. The Theme
   * Settings picker calls `onToastPositionChange(next)` synchronously
   * on click so `ToastProvider` re-renders with the new `position`
   * prop — no `querySelector('.maka-toast-viewport')` DOM hack.
   */
  toastPosition: ToastPosition;
  onToastPositionChange(position: ToastPosition): void;
  onUserLabelChange?(label: string): void;
  /**
   * Force the modal to a specific section when it (re-)mounts or when the
   * value changes while already open. Used by the command palette so
   * ⌘K → "网络" jumps straight to the section without an extra click.
   */
  requestedSection?: SettingsSection;
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
        aria-label="设置"
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
          toastPosition={props.toastPosition}
          onToastPositionChange={props.onToastPositionChange}
          onUserLabelChange={props.onUserLabelChange}
          requestedSection={props.requestedSection}
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
  toastPosition: ToastPosition;
  onToastPositionChange(position: ToastPosition): void;
  onUserLabelChange?(label: string): void;
  requestedSection?: SettingsSection;
}) {
  const [section, setSection] = useState<SettingsSection>(() => props.requestedSection ?? readLastSettingsSection());

  // When the parent updates requestedSection (e.g. the palette opens
  // Settings with a different section while it's already mounted), reflect
  // that into the local state.
  useEffect(() => {
    if (props.requestedSection && props.requestedSection !== section) {
      setSection(props.requestedSection);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.requestedSection]);

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
    const result = await window.maka.settings.update(patch);
    const next = result.settings;
    setSettings(next);
    if (patch.personalization?.displayName !== undefined) {
      props.onUserLabelChange?.(next.personalization.displayName);
    }
    return result;
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
        <nav aria-label="设置分组">
          {groupedNav().map(({ group, items }) => {
            const summary = navGroupSummary({
              group,
              connections: props.connections,
              defaultSlug: props.defaultSlug,
              settings,
            });
            return (
              <div key={group} className="settingsNavGroup">
                <div className="settingsNavGroupLabel">{group}</div>
                {summary && (
                  <div className="settingsNavGroupSummary" data-tone={summary.tone ?? 'neutral'}>
                    {summary.text}
                  </div>
                )}
                {items.map((item) => (
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
                    {item.comingSoon && <em className="settingsNavBadge" aria-label="路线图（尚未实现）">Roadmap</em>}
                  </button>
                ))}
              </div>
            );
          })}
        </nav>
      </aside>

      <section className="settingsMainPane">
        <header className="settingsPageHeader">
          <h2>{activeItem.label}</h2>
          <button className="settingsCloseButton" type="button" aria-label="关闭设置" onClick={props.onClose}>
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
              toastPosition={props.toastPosition}
              onRefreshConnections={props.onRefresh}
              onUpdateSettings={updateSettings}
              onReloadSettings={reloadSettings}
              onReloadUsage={reloadUsage}
              onThemeChange={props.onThemeChange}
              onDensityChange={props.onDensityChange}
              onToastPositionChange={props.onToastPositionChange}
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
  toastPosition: ToastPosition;
  onRefreshConnections(): Promise<void>;
  onUpdateSettings(patch: Parameters<typeof window.maka.settings.update>[0]): Promise<UpdateAppSettingsResult>;
  onReloadSettings(): Promise<void>;
  onReloadUsage(range?: UsageRange): Promise<void>;
  onThemeChange(pref: ThemePreference): void;
  onDensityChange(density: UiDensity): void;
  onToastPositionChange(position: ToastPosition): void;
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
      return (
        <BotChatSettingsPage
          settings={props.settings}
          onUpdate={props.onUpdateSettings}
          onReload={props.onReloadSettings}
        />
      );
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
          toastPosition={props.toastPosition}
          settings={props.settings}
          onUpdate={props.onUpdateSettings}
          onThemeChange={props.onThemeChange}
          onDensityChange={props.onDensityChange}
          onToastPositionChange={props.onToastPositionChange}
        />
      );
    case 'personalization':
      return <PersonalizationSettingsPage settings={props.settings} onUpdate={props.onUpdateSettings} />;
    case 'data':
      return <DataSettingsPage />;
    case 'account':
      return (
        <AccountSettingsPage
          connections={props.connections}
          defaultSlug={props.defaultSlug}
          onRefresh={props.onRefreshConnections}
        />
      );
    case 'permissions':
      return <PermissionCenterPage />;
    case 'health':
      return <HealthCenterPage />;
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
      <div className="maka-skeleton-stack" aria-busy="true" aria-label="正在加载关于页">
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
    <div className="settingsLoadingSkeleton" aria-busy="true" aria-label="正在加载设置">
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
      {/* PR-UI-LAYOUT-17 (@yuejing 2026-05-22, per @kenji audit recommendation):
       * make the "not yet implemented" state honest at first glance instead
       * of leaning on the "Soon" nav badge alone. The roadmap banner gives
       * users an immediate signal that this page is *describing* a planned
       * surface, not configuring a working one. */}
      <div className="settingsComingSoonBanner" role="status">
        <span className="settingsComingSoonBannerDot" aria-hidden="true" />
        <strong>路线图项</strong>
        {/* PR-UI-LAYOUT-17 + @kenji review (#my-ai:9a8fb603 msg fb7fe5af):
         * banner copy stays explicit about the unimplemented state and
         * avoids operational verbs (启用 / connected / toggle / etc.)
         * to prevent users from reading this page as a working
         * surface. The page below describes capability, boundary, and
         * the future configuration flow only. */}
        <span>该功能尚未实现；下面是当前 contract、边界与未来的配置流程预览。</span>
      </div>
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

      <ComingSoonSection tone="config" title="上线后的配置流程">
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

function AccountSettingsPage(props: {
  connections: LlmConnection[];
  defaultSlug: string | null;
  onRefresh(): Promise<void>;
}) {
  // Backend (xuan, 5ca1f8a) persists per-connection lastTestStatus. UI
  // derives the display status from `enabled + hasSecret + defaultModel +
  // lastTestStatus + authKind` per @kenji's status-contract priority list,
  // so we never produce mixed labels like "disabled + verified".
  const [secretMap, setSecretMap] = useState<Record<string, boolean>>({});
  const [testingSlug, setTestingSlug] = useState<string | null>(null);
  const toast = useToast();

  useEffect(() => {
    let cancelled = false;
    void Promise.all(
      props.connections.map(async (connection) => {
        try {
          const has = await window.maka.connections.hasSecret(connection.slug);
          return [connection.slug, has] as const;
        } catch {
          return [connection.slug, false] as const;
        }
      }),
    ).then((entries) => {
      if (cancelled) return;
      setSecretMap(Object.fromEntries(entries));
    });
    return () => {
      cancelled = true;
    };
  }, [props.connections]);

  async function testConnection(slug: string) {
    setTestingSlug(slug);
    try {
      const result = await window.maka.connections.test(slug);
      if (result.ok) {
        toast.success('连接已验证', `延迟 ${result.latencyMs ?? '?'} ms${result.modelTested ? ' · ' + result.modelTested : ''}`);
      } else {
        toast.error('连接测试失败', result.errorMessage ?? '未知错误');
      }
    } catch (error) {
      // Main is supposed to return a structured result; if something escapes
      // to throw form, surface the generalized message anyway.
      toast.error('测试出错', error instanceof Error ? error.message : String(error));
    } finally {
      setTestingSlug(null);
      // Pull the freshest lastTestStatus/lastTestAt/lastTestMessage so the
      // row re-renders with the new derived status without a Settings reopen.
      await props.onRefresh();
    }
  }

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
        <div className="settingsConnectionList" role="list">
          {props.connections.map((connection) => (
            <AccountConnectionRow
              key={connection.slug}
              connection={connection}
              hasSecret={secretMap[connection.slug] ?? false}
              isDefault={connection.slug === props.defaultSlug}
              testing={testingSlug === connection.slug}
              canTest={testingSlug === null}
              onTest={() => void testConnection(connection.slug)}
            />
          ))}
        </div>
      )}
      <p className="settingsHelpText">
        共 {totalCount} 个连接 · {enabledCount} 已启用。修改 API key / baseUrl / 默认模型会清掉「已验证」状态，
        需要重新测试。失败的测试不会自动禁用连接 —— 禁用始终是用户动作。
      </p>

      {/*
        PR-OAUTH-SUBSCRIPTION-0: Claude subscription card lives in
        Settings · 账号 (kenji `cf41871b` decision #3 — auth state
        belongs with the account, not the model catalog).
      */}
      <h3 className="settingsSubheading">订阅</h3>
      <ClaudeSubscriptionCard />
    </div>
  );
}

/**
 * PR-OAUTH-SUBSCRIPTION-0: Claude subscription card.
 *
 * Renders the runtime state, login/logout actions, paste-code modal,
 * and quota meter. Tokens never enter renderer — this component
 * consumes only `SubscriptionAccountState`.
 */
function ClaudeSubscriptionCard() {
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
    } catch {
      // ignore — surface as state.runtimeState = not_logged_in
    }
  };

  useEffect(() => {
    void refresh();
  }, []);

  async function startLogin() {
    setPendingAction(true);
    try {
      const payload = await window.maka.claudeSubscription.getAuthUrl();
      setAuthRequestId(payload.authRequestId);
      setStateHint(payload.stateHint);
      setPasteValue('');
      setPasteError(null);
      const opened = await window.maka.claudeSubscription.openAuthUrl(payload.url);
      if (!opened.ok) {
        toast.error('无法打开浏览器', opened.message);
        setAuthRequestId(null);
        setStateHint(null);
      }
      await refresh();
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
        setPasteError(result.message);
      }
    } finally {
      setPendingAction(false);
    }
  }

  async function cancelLogin() {
    if (!authRequestId) return;
    await window.maka.claudeSubscription.cancelAuthorization(authRequestId);
    setAuthRequestId(null);
    setStateHint(null);
    setPasteValue('');
    setPasteError(null);
    await refresh();
  }

  async function logout() {
    if (!confirm('退出登录将删除本地保存的订阅凭据，确认吗？')) return;
    setPendingAction(true);
    try {
      const result = await window.maka.claudeSubscription.logout();
      if (result.ok) {
        toast.success('已退出登录', '本地凭据已清除。');
        await refresh();
      } else {
        toast.error('退出失败', result.message);
      }
    } finally {
      setPendingAction(false);
    }
  }

  async function refreshQuota() {
    setPendingAction(true);
    try {
      await window.maka.claudeSubscription.refreshQuota();
      await refresh();
    } finally {
      setPendingAction(false);
    }
  }

  // Closed-state render mapping per the runtime state enum.
  const presentation = state ? presentSubscriptionState(state) : { label: '加载中…', tone: 'muted', detail: '' };

  return (
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
            数据更新于 {new Date(state.quota.fetchedAt).toLocaleString()}
          </small>
        </div>
      )}

      <div className="settingsConnectionActions">
        {state?.runtimeState === 'not_logged_in' || state?.runtimeState === 'refresh_failed' ? (
          <button
            type="button"
            className="maka-button"
            data-variant="primary"
            onClick={() => void startLogin()}
            disabled={pendingAction || authRequestId !== null}
          >
            {state.runtimeState === 'refresh_failed' ? '重新登录' : '登录订阅'}
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
        detail: '已绑定 Claude 订阅。目前仅展示账号与配额，聊天发送会在后续版本开放。',
      };
    case 'refreshing':
      return { label: '刷新中…', tone: 'info', detail: '正在刷新访问令牌。' };
    case 'refresh_failed':
      return {
        label: '刷新失败',
        tone: 'warning',
        detail: state.errorMessage ?? '令牌刷新失败，请重新登录。',
      };
    case 'quota_unavailable':
      return {
        label: '配额暂不可用',
        tone: 'warning',
        detail: state.errorMessage ?? '已登录，但配额接口暂时无法访问。',
      };
    case 'provider_rejected':
      return {
        label: '订阅 API 拒绝',
        tone: 'destructive',
        detail: state.errorMessage ?? '订阅端点拒绝了请求，可能需要重新登录。',
      };
    default:
      return { label: '未知状态', tone: 'muted', detail: '' };
  }
}

function AccountConnectionRow(props: {
  connection: LlmConnection;
  hasSecret: boolean;
  isDefault: boolean;
  testing: boolean;
  canTest: boolean;
  onTest(): void;
}) {
  const status: ConnectionUiStatus = connectionUiStatusFromRecord(props.connection, props.hasSecret);
  const presentation = presentConnectionUiStatus(status);
  const authContract = deriveProviderAuthContractFromConnection(props.connection, props.hasSecret);
  const authPresentation = presentAccountAuthState(authContract);
  const authActions = deriveAccountAuthActions(authContract);
  const subtitle = `${props.connection.providerType} · ${props.connection.defaultModel || '未设默认模型'}`;
  const lastTestAt = props.connection.lastTestAt
    ? new Date(props.connection.lastTestAt).toLocaleString()
    : null;
  const lastTestMessage = props.connection.lastTestMessage;
  return (
    <div
      className="settingsConnectionRow"
      role="listitem"
      data-status={status}
      data-default={props.isDefault ? 'true' : undefined}
    >
      <div className="settingsConnectionRowHead">
        <div className="settingsConnectionRowText">
          <div className="settingsConnectionRowName">
            <strong>{props.connection.name}</strong>
            {props.isDefault && (
              <span className="settingsConnectionDefaultBadge" aria-label="默认连接">默认</span>
            )}
          </div>
          <small>{subtitle}</small>
        </div>
        <span className="settingsConnectionBadge" data-tone={presentation.tone}>
          {presentation.label}
        </span>
      </div>
      <p className="settingsConnectionDetail">{presentation.detail}</p>
      <div className="settingsAuthContract" data-state={authContract.state}>
        <div className="settingsAuthContractText">
          <strong>{authPresentation.label}</strong>
          <span>{authPresentation.detail}</span>
        </div>
        <span className="settingsAuthContractBadge" data-tone={authPresentation.tone}>
          {authPresentation.stateLabel}
        </span>
      </div>
      {(lastTestAt || lastTestMessage) && (
        <p className="settingsConnectionMeta">
          {lastTestMessage && <span>{lastTestMessage}</span>}
          {lastTestAt && <time dateTime={props.connection.lastTestAt}>{lastTestAt}</time>}
        </p>
      )}
      {authActions.length > 0 && (
        <div className="settingsConnectionActions" aria-label={`${props.connection.name} 账号操作`}>
          {authActions.map((action) => (
            <AccountAuthActionView
              key={action.action}
              action={action}
              disabled={!props.canTest}
              testing={action.action === 'test_credentials' && props.testing}
              onTest={props.onTest}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function AccountAuthActionView(props: {
  action: AccountAuthActionPresentation;
  disabled: boolean;
  testing: boolean;
  onTest(): void;
}) {
  if (props.action.executable && props.action.action === 'test_credentials') {
    return (
      <button
        type="button"
        className="maka-button"
        data-size="sm"
        disabled={props.disabled}
        onClick={props.onTest}
        title={props.action.detail}
      >
        {props.testing ? '测试中…' : props.action.label}
      </button>
    );
  }
  return (
    <span
      className="settingsAuthActionPill"
      data-kind={props.action.kind}
      data-tone={props.action.tone}
      title={props.action.detail}
    >
      {props.action.label}
    </span>
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
  onUpdate(patch: Parameters<typeof window.maka.settings.update>[0]): Promise<UpdateAppSettingsResult>;
}) {
  const value = props.settings.personalization;
  const [displayName, setDisplayName] = useState(value.displayName);
  const [assistantTone, setAssistantTone] = useState(value.assistantTone);
  const toast = useToast();
  const [saving, setSaving] = useState(false);

  async function save() {
    setSaving(true);
    try {
      const result = await props.onUpdate({
        personalization: {
          displayName: displayName.trim().slice(0, 60),
          assistantTone: assistantTone.trim().slice(0, 500),
        },
      });
      // Single toast either way. With warnings, surface generic policy
      // statements (no raw user text echoed back, no specific keyword
      // disclosed) per kenji's personalization-prompt-contract.
      const warnings = collectPersonalizationWarningCopy(result.warnings?.personalization ?? []);
      if (warnings) {
        toast.warning('已保存并做安全清理', warnings);
      } else {
        toast.success('个性化已保存');
      }
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

function collectPersonalizationWarningCopy(warnings: PersonalizationSettingsWarning[]): string | undefined {
  if (warnings.length === 0) return undefined;
  // Copy per kenji's personalization-prompt-contract: enum -> generic policy
  // statement. Never quote, name, or echo the matched phrase / keyword;
  // each line describes the action taken + the invariant that still holds.
  const copy: Record<PersonalizationSettingsWarning, string> = {
    'override-attempt':
      '检测到可能尝试改变助手行为的内容，已按低优先级偏好处理；权限策略不受影响。',
    'sensitive-pattern': '检测到疑似敏感凭据，已避免在提示或日志中回显原文。',
    'control-chars': '已清理不可见控制字符，避免影响提示结构。',
  };
  return warnings.map((warning) => copy[warning]).join('\n');
}

const DENSITY_OPTIONS: Array<{ value: UiDensity; label: string; help: string }> = [
  { value: 'compact', label: '紧凑', help: '减小行间距与控件高度，更接近 IDE 风格。' },
  { value: 'comfortable', label: '舒适', help: '默认。平衡阅读和密度。' },
  { value: 'spacious', label: '宽松', help: '更大留白，适合长会话沉浸阅读。' },
];

/** PR-UI-16: user-pickable toast position. Six grid corners cover the
 *  practical needs (top/bottom × left/center/right). Default
 *  `bottom-right` matches the v1 hardcoded behavior. */
const TOAST_POSITION_OPTIONS: Array<{ value: ToastPosition; label: string }> = [
  { value: 'top-left', label: '左上' },
  { value: 'top-center', label: '顶部居中' },
  { value: 'top-right', label: '右上' },
  { value: 'bottom-left', label: '左下' },
  { value: 'bottom-center', label: '底部居中' },
  { value: 'bottom-right', label: '右下（默认）' },
];

/**
 * Mini chat-surface mockup rendered inside each theme radio tile. Replaces
 * the generic gradient swatch with a representative preview so the user
 * can see roughly what light vs dark looks like before clicking. The mock
 * uses hardcoded color values per variant (deliberately not tokenized) so
 * the preview tiles don't all shift to match the *currently active* theme
 * — that would defeat the comparison.
 *
 * Per @kenji's PR79 review: preview is purely visual; click commits. We
 * deliberately do not do a "hover to apply globally" flow because it
 * makes Settings feel like it's mutating state on idle pointer movement.
 */
function ThemePreviewMock(props: { variant: ThemePreference }) {
  if (props.variant === 'auto') {
    return (
      <div className="settingsThemePreview settingsThemePreviewSplit" aria-hidden="true">
        <ThemePreviewPane mode="light" />
        <ThemePreviewPane mode="dark" />
      </div>
    );
  }
  return (
    <div className="settingsThemePreview" aria-hidden="true">
      <ThemePreviewPane mode={props.variant} />
    </div>
  );
}

function ThemePreviewPane(props: { mode: 'light' | 'dark' }) {
  return (
    <div className="settingsThemePreviewPane" data-mode={props.mode}>
      <div className="settingsThemePreviewSidebar" />
      <div className="settingsThemePreviewChat">
        <div className="settingsThemePreviewLine settingsThemePreviewLine-assistant" />
        <div className="settingsThemePreviewLine settingsThemePreviewLine-assistant settingsThemePreviewLine-short" />
        <div className="settingsThemePreviewBubble" />
      </div>
    </div>
  );
}

function ThemeSettingsPage(props: {
  themePref: ThemePreference;
  density: UiDensity;
  toastPosition: ToastPosition;
  settings: AppSettings;
  onUpdate(patch: Parameters<typeof window.maka.settings.update>[0]): Promise<UpdateAppSettingsResult>;
  onThemeChange(pref: ThemePreference): void;
  onDensityChange(density: UiDensity): void;
  onToastPositionChange(position: ToastPosition): void;
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

  // PR-UI-16 + PR-UI-D2 fixup v2 (@kenji msg b4dbfa91):
  // user-driven toast position picker.
  //
  // v1 had two real bugs:
  //   1. Used `querySelector('.maka-toast-viewport')` to write
  //      `data-position` on the DOM directly. ToastViewport returns
  //      `null` when there are no live toasts, so the DOM node didn't
  //      exist — the change was invisible until the next render.
  //   2. Wrote `localStorage` BEFORE `await onUpdate(...)`. If
  //      `onUpdate` failed, the mirror would diverge from
  //      `settings.json` and a subsequent pre-React boot would read
  //      a position that doesn't match disk.
  //
  // v2 (this version):
  //   - Calls `onToastPositionChange(next)` SYNCHRONOUSLY first. This
  //     bubbles up to `App`'s `setToastPosition`, which re-renders
  //     `<ToastProvider position={toastPosition}>` with the new prop.
  //     `ToastViewport` reads `position` from context and emits
  //     `data-position={position}` on its own — no DOM mutation
  //     from outside React.
  //   - Awaits `onUpdate({ appearance: { toastPosition: next } })`.
  //   - On success, writes the localStorage mirror using the
  //     normalized value returned by the server
  //     (`result.settings.appearance.toastPosition`). If the server
  //     ever rejects or rewrites the value (e.g. closed-enum
  //     fail-closed), the mirror stays consistent with disk.
  //   - On failure, does NOT touch localStorage. The mirror keeps
  //     its previous value, which still matches `settings.json`.
  async function setToastPosition(next: ToastPosition) {
    props.onToastPositionChange(next);
    let result: UpdateAppSettingsResult;
    try {
      result = await props.onUpdate({ appearance: { toastPosition: next } });
    } catch {
      // Persistence failed. React state reverts to disk's value on
      // the next settings load; localStorage stays at the previous
      // value, so pre-React boot remains consistent.
      return;
    }
    const normalized = result.settings.appearance.toastPosition;
    if (normalized && isToastPosition(normalized)) {
      try {
        localStorage.setItem('maka-toast-position-v1', normalized);
      } catch {
        /* localStorage unavailable; ignore */
      }
      // If the server normalized the value to something different
      // (e.g. closed-enum fail-closed to 'bottom-right'), also push
      // the normalized value through React state so the picker
      // reflects the persisted truth.
      if (normalized !== next) {
        props.onToastPositionChange(normalized);
      }
    }
  }

  // PR-UI-D2 fixup v2: source-of-truth is the LIFTED `App` state, not
  // `settings.appearance.toastPosition`. The two are kept in sync on
  // settings load by `AppShell.onToastPositionChange` and on user
  // click by `setToastPosition` above. Reading from `props.toastPosition`
  // means the picker's `aria-checked` reflects the live state in
  // ToastProvider, not a value that's about to be settled by a
  // pending IPC.
  const currentToastPosition: ToastPosition = props.toastPosition;

  return (
    <div className="settingsStructuredPage">
      <h3 className="settingsSubheading">主题</h3>
      <div className="settingsThemeOptions settingsThemeOptionsPreview" role="radiogroup" aria-label="主题">
        {THEME_OPTIONS.map((option) => (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={props.themePref === option.value}
            data-active={props.themePref === option.value}
            className="settingsThemeOption settingsThemeOptionPreview"
            onClick={() => void setTheme(option.value)}
          >
            <ThemePreviewMock variant={option.value} />
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

      <h3 className="settingsSubheading">通知位置</h3>
      <div className="settingsToastPositionGrid" role="radiogroup" aria-label="通知位置">
        {TOAST_POSITION_OPTIONS.map((option) => (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={currentToastPosition === option.value}
            data-active={currentToastPosition === option.value}
            data-position={option.value}
            className="settingsToastPositionOption"
            onClick={() => void setToastPosition(option.value)}
            title={option.label}
          >
            <span className="settingsToastPositionSwatch" aria-hidden="true">
              <span className="settingsToastPositionDot" />
            </span>
            <span className="settingsToastPositionLabel">{option.label}</span>
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
  onUpdate(patch: Parameters<typeof window.maka.settings.update>[0]): Promise<UpdateAppSettingsResult>;
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
  onUpdate(patch: Parameters<typeof window.maka.settings.update>[0]): Promise<UpdateAppSettingsResult>;
  onReload(): Promise<void>;
}) {
  const [selected, setSelected] = useState<BotProvider>('telegram');
  const [testing, setTesting] = useState(false);
  const [restarting, setRestarting] = useState(false);
  const [statuses, setStatuses] = useState<Record<BotProvider, BotStatus> | null>(null);
  const channel = props.settings.botChat.channels[selected];
  const toast = useToast();
  const selectedStatus = statuses?.[selected];

  async function updateChannel(patch: Partial<typeof channel>) {
    await props.onUpdate({ botChat: { channels: { [selected]: patch } } });
  }

  useEffect(() => {
    let active = true;
    void window.maka.settings.bots.listStatuses().then((next) => {
      if (active) setStatuses(next);
    });
    const unsubscribe = window.maka.settings.bots.subscribeStatusChanges((status) => {
      setStatuses((current) => ({
        ...(current ?? ({} as Record<BotProvider, BotStatus>)),
        [status.platform]: status,
      }));
    });
    return () => {
      active = false;
      unsubscribe();
    };
  }, []);

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
      await props.onReload();
      const nextStatuses = await window.maka.settings.bots.listStatuses();
      setStatuses(nextStatuses);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      toast.error('Bot 测试出错', message);
    } finally {
      setTesting(false);
    }
  }

  async function restartChannel() {
    setRestarting(true);
    try {
      const status = await window.maka.settings.bots.restart(selected);
      setStatuses((current) => ({
        ...(current ?? ({} as Record<BotProvider, BotStatus>)),
        [status.platform]: status,
      }));
      toast.success(`${BOT_LABELS[selected].label} 已重新启动`, botStatusDetail(status));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      toast.error('机器人启动失败', message);
    } finally {
      setRestarting(false);
    }
  }

  const support = BOT_LABELS[selected].support;
  const readiness = selectedStatus?.readiness ?? channel.readiness;
  const copy = BOT_READINESS_COPY[readiness] ?? BOT_READINESS_COPY.scaffolded;

  return (
    <div className="settingsBotLayout">
      <nav className="settingsBotList" aria-label="机器人频道列表">
        {BOT_PROVIDERS.map((provider) => {
          const status = statuses?.[provider];
          const providerCopy = BOT_READINESS_COPY[status?.readiness ?? props.settings.botChat.channels[provider].readiness] ?? BOT_READINESS_COPY.scaffolded;
          return (
            <button key={provider} type="button" data-active={selected === provider} onClick={() => {
              setSelected(provider);
            }}>
              <span className="settingsBotLogo">{BOT_LABELS[provider].label.slice(0, 2)}</span>
              <span>{BOT_LABELS[provider].label}</span>
              <em data-tone={providerCopy.tone}>{providerCopy.label}</em>
            </button>
          );
        })}
      </nav>

      <section className="settingsBotDetail">
        <div className="settingsBotHero">
          <span className="settingsBotLogo" data-large="true">{BOT_LABELS[selected].label.slice(0, 2)}</span>
          <div>
            <h3>{BOT_LABELS[selected].label}</h3>
            <small>
              {copy.label}
              {' · '}
              {copy.detail}
            </small>
          </div>
          <Switch checked={channel.enabled} onChange={(enabled) => updateChannel({ enabled })} disabled={support === 'planned'} />
        </div>

        <p className="settingsHelpText">{BOT_LABELS[selected].help}</p>

        {selected === 'telegram' && (
          <>
            <label className="settingsField">
              <span>机器人 Token</span>
              <input type="password" value={channel.token} onChange={(event) => updateChannel({ token: event.currentTarget.value })} placeholder="123456:ABC-DEF…" />
            </label>
            <label className="settingsField">
              <span>代理地址</span>
              <input value={channel.proxyUrl} onChange={(event) => updateChannel({ proxyUrl: event.currentTarget.value })} placeholder="http://127.0.0.1:7890" />
            </label>
            <div className="settingsNotice">
              Telegram 国内网络通常需要代理。保存并测试凭据后，打开开关并重启监听；用户向机器人发消息后，Maka 会创建对话并自动回复。
            </div>
          </>
        )}

        {selected === 'feishu' && (
          <>
            <label className="settingsField">
              <span>App ID</span>
              <input value={channel.appId ?? ''} onChange={(event) => updateChannel({ appId: event.currentTarget.value })} placeholder="飞书应用 ID" />
            </label>
            <label className="settingsField">
              <span>App Secret</span>
              <input type="password" value={channel.appSecret ?? ''} onChange={(event) => updateChannel({ appSecret: event.currentTarget.value })} placeholder="飞书开放平台 App Secret" />
            </label>
            <label className="settingsField">
              <span>事件订阅域名</span>
              <input value={channel.domain ?? ''} onChange={(event) => updateChannel({ domain: event.currentTarget.value })} placeholder="https://maka.example.com/feishu/events" />
            </label>
            <div className="settingsNotice">
              飞书凭据测试会申请 tenant_access_token；事件订阅域名用于企业后台回调。未接通事件回调前，状态只能到“凭据有效”，不会显示成运行可用。
            </div>
          </>
        )}

        {support === 'planned' && (
          <div className="settingsNotice" data-tone="passive">
            这个平台还没有运行时接入，当前不会保存为可用机器人。后续接入前需要先补凭据测试、收发 smoke、权限边界和失败日志。
          </div>
        )}

        <dl className="settingsBotStatusGrid">
          <div>
            <dt>运行状态</dt>
            <dd>{selectedStatus?.running ? '监听中' : '未监听'}</dd>
          </div>
          <div>
            <dt>通道类型</dt>
            <dd>{botConnectionLabel(selectedStatus?.connection ?? 'none')}</dd>
          </div>
          <div>
            <dt>身份</dt>
            <dd>{selectedStatus?.identity?.username ?? selectedStatus?.identity?.displayName ?? '未获取'}</dd>
          </div>
          <div>
            <dt>最近事件</dt>
            <dd>{selectedStatus?.lastEventAt ? new Date(selectedStatus.lastEventAt).toLocaleString() : '暂无'}</dd>
          </div>
        </dl>

        {selectedStatus?.reason && <div className="settingsBotReason">{botStatusDetail(selectedStatus)}</div>}

        <div className="settingsActionRow">
          <button className="maka-button" type="button" disabled={testing || support === 'planned'} onClick={testChannel}>
            {testing ? '测试中…' : '测试凭据'}
          </button>
          <button className="maka-button subtle" type="button" disabled={restarting || !channel.enabled || support === 'planned'} onClick={restartChannel}>
            {restarting ? '重启中…' : '重启监听'}
          </button>
        </div>
      </section>
    </div>
  );
}

function botConnectionLabel(connection: BotStatus['connection']): string {
  switch (connection) {
    case 'polling': return '长轮询';
    case 'gateway': return '事件通道';
    case 'webhook': return 'Webhook';
    case 'none': return '无';
  }
}

function botStatusDetail(status: BotStatus): string {
  switch (status.reason) {
    case 'disabled': return '开关关闭';
    case 'no-token': return '缺少 Bot Token';
    case 'missing-feishu-credentials': return '缺少飞书 App ID 或 App Secret';
    case 'feishu-domain-required': return '飞书凭据有效，但还没有事件订阅域名';
    case 'feishu-events-not-connected': return '飞书凭据有效，等待事件回调接入';
    case 'scaffold-only': return '平台入口已保留，运行时尚未接入';
    case 'unimplemented': return '平台运行时尚未接入';
    case 'stopped': return '监听已停止';
    default: return status.reason ?? '暂无运行细节';
  }
}

function UsageSettingsPage(props: {
  settings: AppSettings;
  stats: UsageStats | null;
  onUpdate(patch: Parameters<typeof window.maka.settings.update>[0]): Promise<UpdateAppSettingsResult>;
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

function Switch(props: { checked: boolean; onChange(checked: boolean): void; disabled?: boolean }) {
  return (
    <button
      className="settingsSwitch"
      type="button"
      role="switch"
      aria-checked={props.checked}
      data-checked={props.checked}
      disabled={props.disabled}
      onClick={() => props.onChange(!props.checked)}
    >
      <span />
    </button>
  );
}

/**
 * PR-UI-8 — Permission Center stub. Consumes `window.maka.permissions.getSnapshot()`
 * and `window.maka.capabilities.getSnapshot()` (both shipped by @xuan PR-REAL-2).
 *
 * Stage 1 Hard Gate contract:
 * - Renders the live snapshot per capability with explicit four-layer breakdown
 *   (OS permission · feature toggle · action approval · memory acceptance), so
 *   the user can see WHY each capability lands on its readiness state.
 * - Surfaces every OS permission separately at the bottom so users can verify
 *   the underlying TCC state without re-deriving it from capabilities.
 * - **Read-only by design.** @xuan/@kenji review (2026-05-22): the UI must
 *   NOT pretend to revoke OS TCC or guide the user through grant flows here;
 *   that lands in PR-CU-0 / PR-CU-1 once the drag-`.app` helper exists.
 * - Audit hint slot is reserved (`auditEvents` is empty for now) — once
 *   PR-REAL-3 wires the audit log, the slot fills without UI change.
 */
const CAPABILITY_READINESS_COPY: Record<CapabilityReadinessState, { label: string; detail: string; tone: 'neutral' | 'info' | 'success' | 'warning' | 'destructive' }> = {
  not_configured: { label: '未配置', detail: '需要先打开开关或完成配置才能启用。', tone: 'neutral' },
  denied: { label: '系统拒绝', detail: '所需系统权限被拒绝或当前平台不支持。', tone: 'destructive' },
  enabled: { label: '运行可用', detail: '当前快照标记为可用，具体层级见下方。', tone: 'success' },
  degraded: { label: '运行降级', detail: '之前可用，但最近的运行态探测失败。', tone: 'warning' },
  paused: { label: '已暂停', detail: '功能开关被显式关闭，但配置仍保留。', tone: 'info' },
};

const OS_PERMISSION_COPY: Record<OsPermissionId, { label: string; purpose: string }> = {
  accessibility: { label: '辅助功能', purpose: 'Computer Use 需要它来读取窗口焦点 / 模拟键盘鼠标。' },
  screen_recording: { label: '屏幕录制', purpose: 'Computer Use 与 Activity Recorder 需要它来读取窗口内容。' },
  microphone: { label: '麦克风', purpose: 'Voice 通道需要它来采集语音输入。' },
  notifications: { label: '通知', purpose: '权限申请、回顾完成等系统通知需要它。' },
  automation: { label: '自动化（Apple Events）', purpose: 'Computer Use 控制其他 App 需要逐 target 授权。' },
};

const OS_PERMISSION_STATE_COPY: Record<OsPermissionState, { label: string; tone: 'neutral' | 'info' | 'success' | 'warning' | 'destructive' }> = {
  unsupported: { label: '当前平台不支持', tone: 'neutral' },
  unknown: { label: '无法读取状态', tone: 'neutral' },
  not_determined: { label: '尚未授权', tone: 'warning' },
  denied: { label: '已拒绝', tone: 'destructive' },
  granted: { label: '已授权', tone: 'success' },
};

function PermissionCenterPage() {
  const [permissions, setPermissions] = useState<PermissionSnapshot | null>(null);
  const [capabilities, setCapabilities] = useState<CapabilitySnapshotCollection | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshTick, setRefreshTick] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    Promise.all([
      window.maka.permissions.getSnapshot(),
      window.maka.capabilities.getSnapshot(),
    ])
      .then(([perm, caps]) => {
        if (cancelled) return;
        setPermissions(perm);
        setCapabilities(caps);
        setLoading(false);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : '读取权限快照失败');
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [refreshTick]);

  if (loading) {
    return (
      <div className="maka-skeleton-stack" aria-busy="true" aria-label="正在加载权限快照">
        <div className="maka-skeleton maka-skeleton-line" data-size="lg" style={{ width: '38%' }} />
        <div className="maka-skeleton maka-skeleton-line" style={{ width: '72%' }} />
        <div className="maka-skeleton maka-skeleton-line" style={{ width: '60%' }} />
        <div className="maka-skeleton maka-skeleton-line" style={{ width: '80%' }} />
      </div>
    );
  }

  if (error || !permissions || !capabilities) {
    return (
      <div className="settingsPermissionPage">
        <div className="settingsPermissionError" role="alert">
          <strong>无法读取权限快照</strong>
          <small>{error ?? '权限服务未返回数据。'}</small>
          <button type="button" className="maka-button" onClick={() => setRefreshTick((tick) => tick + 1)}>
            重新读取
          </button>
        </div>
      </div>
    );
  }

  const checkedAtLabel = new Date(capabilities.checkedAt).toLocaleString();

  return (
    <div className="settingsPermissionPage">
      <header className="settingsPermissionIntro">
        <div>
          <h3>权限与能力中心</h3>
          <p>
            这里只读取系统权限与功能能力的当前快照，不会代替你修改任何 OS 权限。
            撤销与引导流程会在原生 helper 上线后单独提供。
          </p>
        </div>
        <div className="settingsPermissionMeta">
          <span className="pill" data-tone="info">只读快照</span>
          <small>最近一次读取：{checkedAtLabel}</small>
          <button
            type="button"
            className="settingsPermissionRefresh"
            onClick={() => setRefreshTick((tick) => tick + 1)}
          >
            刷新
          </button>
        </div>
      </header>

      <section aria-label="功能能力" className="settingsPermissionSection">
        <header>
          <h4>功能能力</h4>
          <small>每个能力的就绪状态由「功能开关 · 配置 · 系统权限 · 运行态探测」共同决定。</small>
        </header>
        <ul className="settingsCapabilityList">
          {capabilities.capabilities.map((capability) => (
            <CapabilityRow key={capability.id} capability={capability} />
          ))}
        </ul>
      </section>

      <section aria-label="系统权限" className="settingsPermissionSection">
        <header>
          <h4>系统权限</h4>
          <small>Maka 读到的 OS 级权限状态。撤销请前往「系统设置 → 隐私与安全性」。</small>
        </header>
        <ul className="settingsOsPermissionList">
          {OS_PERMISSION_IDS.map((id) => (
            <OsPermissionRow key={id} snapshot={permissions.permissions[id]} />
          ))}
        </ul>
      </section>

      <p className="settingsPermissionFootnote">
        想要新增「拖拽 .app 完成 Accessibility 授权」「逐 target 申请 Automation」「Screen Recording 引导」等真正能修改 OS 权限的流程？
        权限引导模块（Computer Use 原生 helper）接入后会替换这里的只读视图。
      </p>
    </div>
  );
}

function CapabilityRow(props: { capability: CapabilitySnapshot }) {
  const { capability } = props;
  const readinessCopy = CAPABILITY_READINESS_COPY[capability.readiness];
  return (
    <li className="settingsCapabilityRow" data-readiness={capability.readiness}>
      <div className="settingsCapabilityHeader">
        <div className="settingsCapabilityHeading">
          <strong>{capability.label}</strong>
          <small className="settingsCapabilityId">{prettyCapabilityId(capability.id)}</small>
        </div>
        <span className="pill" data-tone={readinessCopy.tone}>{readinessCopy.label}</span>
      </div>
      <p className="settingsCapabilityDetail">{readinessCopy.detail}</p>
      <dl className="settingsCapabilityLayers">
        <div>
          <dt>功能开关</dt>
          <dd data-tone={featureTone(capability.feature.state)}>
            {featureLabel(capability.feature.state)}
            {capability.feature.reason && <small>{capability.feature.reason}</small>}
          </dd>
        </div>
        <div>
          <dt>配置</dt>
          <dd data-tone={configurationTone(capability.configuration.state)}>
            {configurationLabel(capability.configuration.state)}
            {capability.configuration.reason && <small>{capability.configuration.reason}</small>}
          </dd>
        </div>
        <div>
          <dt>操作审批</dt>
          <dd data-tone={actionApprovalTone(capability.actionApproval.state)}>
            {actionApprovalLabel(capability.actionApproval.state)}
          </dd>
        </div>
        <div>
          <dt>记忆写入</dt>
          <dd data-tone={memoryAcceptanceTone(capability.memoryAcceptance.state)}>
            {memoryAcceptanceLabel(capability.memoryAcceptance.state)}
          </dd>
        </div>
        <div>
          <dt>运行态探测</dt>
          <dd data-tone={runtimeProbeTone(capability.runtimeProbe.state)}>
            {runtimeProbeLabel(capability.runtimeProbe.state)}
            {capability.runtimeProbe.reason && <small>{capability.runtimeProbe.reason}</small>}
          </dd>
        </div>
      </dl>
      {capability.osPermissions.length > 0 && (
        <div className="settingsCapabilityOsPermissions">
          <span>所需系统权限</span>
          <ul>
            {capability.osPermissions.map((req) => (
              <li key={req.id}>
                <span>{OS_PERMISSION_COPY[req.id]?.label ?? req.id}</span>
                <em data-tone={OS_PERMISSION_STATE_COPY[req.status].tone}>
                  {OS_PERMISSION_STATE_COPY[req.status].label}
                </em>
              </li>
            ))}
          </ul>
        </div>
      )}
      {/*
        PR-UX-POLISH-1 commit 2 (yuejing UX audit + xuan ROADMAP-SURFACE-0 +
        kenji boundary 1): the `可暂停 · 即将可用` / `可撤销 · 即将可用`
        chips read like disabled toggles, which violates the capability
        presentation contract (`coming_soon` must be passive, not a fake
        action). They're hidden here until the actual pause/revoke wiring
        ships in PR-PERMISSION-GUIDE-0. Once available, render them as
        real action buttons with `data-state="available"`.
      */}
      <div className="settingsCapabilityAuditSlot" aria-hidden={capability.auditEvents.length === 0}>
        {capability.auditEvents.length === 0 ? (
          <small>审计日志接入后显示。</small>
        ) : (
          <ul>
            {capability.auditEvents.slice(-3).map((event, index) => (
              <li key={`${capability.id}-audit-${index}`}>{event}</li>
            ))}
          </ul>
        )}
      </div>
    </li>
  );
}

function OsPermissionRow(props: { snapshot: OsPermissionSnapshot }) {
  const { snapshot } = props;
  const copy = OS_PERMISSION_COPY[snapshot.id] ?? { label: snapshot.id, purpose: '' };
  const stateCopy = OS_PERMISSION_STATE_COPY[snapshot.status];
  return (
    <li className="settingsOsPermissionRow" data-state={snapshot.status}>
      <div>
        <strong>{copy.label}</strong>
        <small>{copy.purpose}</small>
        {snapshot.reason && <small className="settingsOsPermissionReason">{snapshot.reason}</small>}
      </div>
      <span className="pill" data-tone={stateCopy.tone}>{stateCopy.label}</span>
    </li>
  );
}

function prettyCapabilityId(id: CapabilityId): string {
  return id;
}

function featureLabel(state: CapabilitySnapshot['feature']['state']): string {
  switch (state) {
    case 'enabled': return '已开启';
    case 'disabled': return '已关闭';
    case 'not_available': return '尚未实现';
  }
}
function featureTone(state: CapabilitySnapshot['feature']['state']): 'neutral' | 'info' | 'success' | 'warning' | 'destructive' {
  if (state === 'enabled') return 'success';
  if (state === 'disabled') return 'info';
  return 'neutral';
}

function configurationLabel(state: CapabilitySnapshot['configuration']['state']): string {
  switch (state) {
    case 'not_required': return '不需要配置';
    case 'missing': return '缺少必要配置';
    case 'present': return '已填写';
  }
}
function configurationTone(state: CapabilitySnapshot['configuration']['state']): 'neutral' | 'info' | 'success' | 'warning' | 'destructive' {
  if (state === 'present') return 'success';
  if (state === 'missing') return 'warning';
  return 'neutral';
}

function actionApprovalLabel(state: CapabilitySnapshot['actionApproval']['state']): string {
  switch (state) {
    case 'not_required': return '不需要审批';
    case 'required_per_action': return '每次调用都需审批';
    case 'pending': return '审批挂起';
    case 'approved': return '当前会话已批准';
    case 'denied': return '当前会话已拒绝';
  }
}
function actionApprovalTone(state: CapabilitySnapshot['actionApproval']['state']): 'neutral' | 'info' | 'success' | 'warning' | 'destructive' {
  if (state === 'approved') return 'success';
  if (state === 'denied') return 'destructive';
  if (state === 'pending') return 'warning';
  if (state === 'required_per_action') return 'info';
  return 'neutral';
}

function memoryAcceptanceLabel(state: CapabilitySnapshot['memoryAcceptance']['state']): string {
  switch (state) {
    case 'not_applicable': return '不涉及记忆写入';
    case 'disabled': return '记忆写入已关闭';
    case 'draft_required': return '需要先草拟 memory 协议';
    case 'accepted': return '记忆写入已接受';
  }
}
function memoryAcceptanceTone(state: CapabilitySnapshot['memoryAcceptance']['state']): 'neutral' | 'info' | 'success' | 'warning' | 'destructive' {
  if (state === 'accepted') return 'success';
  if (state === 'draft_required') return 'warning';
  return 'neutral';
}

function runtimeProbeLabel(state: CapabilitySnapshot['runtimeProbe']['state']): string {
  switch (state) {
    case 'not_available': return '尚无运行态探测';
    case 'not_run': return '探测未运行';
    case 'healthy': return '探测通过';
    case 'degraded': return '探测降级';
  }
}
function runtimeProbeTone(state: CapabilitySnapshot['runtimeProbe']['state']): 'neutral' | 'info' | 'success' | 'warning' | 'destructive' {
  if (state === 'healthy') return 'success';
  if (state === 'degraded') return 'destructive';
  if (state === 'not_run') return 'warning';
  return 'neutral';
}

/**
 * PR-UI-9 — Health Center stub. Consumes `window.maka.health.getSnapshot()`
 * (shipped by @xuan PR-HC-1).
 *
 * Hard contract (per @xuan): "validation/config/permission/runtime 别聚成
 * 一个绿点". The UI groups signals by `layer` and renders each in its own
 * section so the user sees WHICH layer is okay and WHICH is degraded.
 *
 * Status semantics ≠ tone-by-color only. `ok` (validation pass) on an LLM
 * connection does NOT promote it to operational — that requires a runtime
 * probe in PR-REAL-4. The detail copy below makes the distinction explicit.
 *
 * Read-only stub: no test buttons, no repair flows. Test/repair entries
 * will be wired in PR-HC-2 once typed actions are exposed.
 */
const HEALTH_LAYER_COPY: Record<HealthSignalLayer, { label: string; description: string }> = {
  configuration: { label: '配置', description: '是否填齐了 settings 里的必填项。' },
  validation: { label: '验证', description: '凭据 / 端点的连通性测试结果，仅代表 validation 通过，不等于 agent 通路可用。' },
  permission: { label: '系统权限', description: '所需 OS / TCC 权限是否已授权。' },
  feature: { label: '功能开关', description: '功能是否被显式启用、是否已实现。' },
  action_approval: { label: '操作审批', description: '每次工具调用 / 高危操作的审批策略状态。' },
  memory_acceptance: { label: '记忆写入', description: '是否接受了 memory contract、是否启用了记忆写入。' },
  runtime_probe: { label: '运行态探测', description: '最近一次真实运行（发送 / 流式 / 收发 smoke）的探测结果。' },
  storage: { label: '存储', description: '工作区文件、JSONL、SQLite 等本地存储健康度。' },
};

const HEALTH_STATUS_COPY: Record<HealthSignalStatus, { label: string; tone: 'neutral' | 'info' | 'success' | 'warning' | 'destructive' }> = {
  ok: { label: '正常', tone: 'success' },
  info: { label: '提示', tone: 'info' },
  warning: { label: '警告', tone: 'warning' },
  error: { label: '错误', tone: 'destructive' },
  unknown: { label: '未知', tone: 'neutral' },
};

const HEALTH_SCOPE_LABEL: Record<HealthSignal['scope'], string> = {
  app: '应用',
  llm_connection: 'LLM 连接',
  bot: '机器人',
  capability: '能力',
  storage: '存储',
};

function HealthCenterPage() {
  const [snapshot, setSnapshot] = useState<HealthSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshTick, setRefreshTick] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    window.maka.health
      .getSnapshot()
      .then((next) => {
        if (cancelled) return;
        setSnapshot(next);
        setLoading(false);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : '读取健康快照失败');
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [refreshTick]);

  if (loading) {
    return (
      <div className="maka-skeleton-stack" aria-busy="true" aria-label="正在加载健康快照">
        <div className="maka-skeleton maka-skeleton-line" data-size="lg" style={{ width: '38%' }} />
        <div className="maka-skeleton maka-skeleton-line" style={{ width: '72%' }} />
        <div className="maka-skeleton maka-skeleton-line" style={{ width: '60%' }} />
        <div className="maka-skeleton maka-skeleton-line" style={{ width: '80%' }} />
      </div>
    );
  }

  if (error || !snapshot) {
    return (
      <div className="settingsHealthPage">
        <div className="settingsHealthError" role="alert">
          <strong>无法读取健康快照</strong>
          <small>{error ?? '健康服务未返回数据。'}</small>
          <button type="button" className="maka-button" onClick={() => setRefreshTick((tick) => tick + 1)}>
            重新读取
          </button>
        </div>
      </div>
    );
  }

  const checkedAtLabel = new Date(snapshot.checkedAt).toLocaleString();
  const signalsByLayer = groupSignalsByLayer(snapshot.signals);
  const blocksSendCount = snapshot.signals.filter((signal) => signal.blocksSend).length;
  const blocksCapabilityCount = snapshot.signals.filter((signal) => signal.blocksCapability).length;

  return (
    <div className="settingsHealthPage">
      <header className="settingsHealthIntro">
        <div>
          <h3>健康中心</h3>
          <p>
            按层级（配置 · 验证 · 权限 · 功能 · 操作审批 · 记忆 · 运行态 · 存储）展示当前快照。
            <strong>验证通过 ≠ 运行可用</strong> — 凭据测试只属于 validation 层，运行态需要运行态探测接入后实测。
          </p>
        </div>
        <div className="settingsHealthMeta">
          <span className="pill" data-tone="info">只读快照</span>
          <small>最近一次读取：{checkedAtLabel}</small>
          <button
            type="button"
            className="settingsHealthRefresh"
            onClick={() => setRefreshTick((tick) => tick + 1)}
          >
            刷新
          </button>
        </div>
      </header>

      <section aria-label="健康摘要" className="settingsHealthSummary">
        <HealthSummaryTile tone="success" label="正常" count={snapshot.summary.ok} />
        <HealthSummaryTile tone="info" label="提示" count={snapshot.summary.info} />
        <HealthSummaryTile tone="warning" label="警告" count={snapshot.summary.warning} />
        <HealthSummaryTile tone="destructive" label="错误" count={snapshot.summary.error} />
        <HealthSummaryTile tone="neutral" label="未知" count={snapshot.summary.unknown} />
      </section>

      {(blocksSendCount > 0 || blocksCapabilityCount > 0) && (
        <div className="settingsHealthBlockers" role="status">
          {blocksSendCount > 0 && (
            <span className="pill" data-tone="destructive">
              {blocksSendCount} 条 signal 会阻塞发送
            </span>
          )}
          {blocksCapabilityCount > 0 && (
            <span className="pill" data-tone="warning">
              {blocksCapabilityCount} 条 signal 会阻塞 capability
            </span>
          )}
        </div>
      )}

      {HEALTH_SIGNAL_LAYERS.map((layer) => {
        const signals = signalsByLayer[layer];
        if (!signals || signals.length === 0) return null;
        const copy = HEALTH_LAYER_COPY[layer];
        return (
          <section key={layer} className="settingsHealthLayer" aria-label={`${copy.label} signals`}>
            <header>
              <h4>{copy.label}</h4>
              <small>{copy.description}</small>
            </header>
            <ul className="settingsHealthSignalList">
              {signals.map((signal) => (
                <HealthSignalRow key={signal.id} signal={signal} />
              ))}
            </ul>
          </section>
        );
      })}

      <p className="settingsHealthFootnote">
        想要从这里直接「测试连接」「重新探测」「修复凭据」？运行态修复操作接入后显示。
        所有真正的运行态探测落地后会自动出现在「运行态探测」层。
      </p>
    </div>
  );
}

function HealthSummaryTile(props: {
  tone: 'neutral' | 'info' | 'success' | 'warning' | 'destructive';
  label: string;
  count: number;
}) {
  return (
    <div className="settingsHealthSummaryTile" data-tone={props.tone} data-empty={props.count === 0}>
      <strong>{props.count}</strong>
      <small>{props.label}</small>
    </div>
  );
}

function HealthSignalRow(props: { signal: HealthSignal }) {
  const { signal } = props;
  const statusCopy = HEALTH_STATUS_COPY[signal.status];
  const checkedAtLabel = new Date(signal.checkedAt).toLocaleString();
  return (
    <li className="settingsHealthSignalRow" data-status={signal.status}>
      <div className="settingsHealthSignalHeader">
        <div className="settingsHealthSignalHeading">
          <strong>{signal.label}</strong>
          <small className="settingsHealthSignalScope">{HEALTH_SCOPE_LABEL[signal.scope]}</small>
        </div>
        <span className="pill" data-tone={statusCopy.tone}>{statusCopy.label}</span>
      </div>
      <p className="settingsHealthSignalMessage">{signal.message}</p>
      {signal.detail && <small className="settingsHealthSignalDetail">{signal.detail}</small>}
      <div className="settingsHealthSignalMeta">
        <span>source: <code>{signal.source}</code></span>
        <span>checked: {checkedAtLabel}</span>
        {signal.blocksSend && <span className="settingsHealthSignalBlocker" data-tone="destructive">阻塞发送</span>}
        {signal.blocksCapability && <span className="settingsHealthSignalBlocker" data-tone="warning">阻塞能力</span>}
      </div>
    </li>
  );
}

function groupSignalsByLayer(signals: HealthSignal[]): Record<HealthSignalLayer, HealthSignal[]> {
  const byLayer: Record<HealthSignalLayer, HealthSignal[]> = {
    configuration: [],
    validation: [],
    permission: [],
    feature: [],
    action_approval: [],
    memory_acceptance: [],
    runtime_probe: [],
    storage: [],
  };
  for (const signal of signals) {
    byLayer[signal.layer].push(signal);
  }
  return byLayer;
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
