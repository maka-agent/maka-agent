import { useEffect, useMemo, useRef, useState, type ComponentType, type KeyboardEvent, type ReactNode, type RefObject } from 'react';
import {
  Activity,
  BarChart3,
  Bot,
  Brain,
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
  BotChannelSettings,
  BotProvider,
  BotReadinessState,
  CapabilityId,
  CapabilityReadinessState,
  CapabilitySnapshot,
  CapabilitySnapshotCollection,
  ConnectionTestResult,
  HealthSignal,
  HealthSignalLayer,
  HealthSignalSource,
  HealthSignalStatus,
  HealthSnapshot,
  LlmConnection,
  NetworkProxySettings,
  OsPermissionId,
  OsPermissionSnapshot,
  OsPermissionState,
  OpenGatewayRuntimeStatus,
  PermissionSnapshot,
  PersonalizationSettingsWarning,
  SettingsSection,
  ThemePalette,
  ThemePreference,
  UiDensity,
  UpdateAppSettingsResult,
  UsageRange,
  UsageStats,
  SubscriptionAccountState,
  WebSearchCredentialStatus,
  LocalMemoryState,
  VoicePermissionStatus,
} from '@maka/core';
import type { BotStatus, WechatBridgeQrCodeResult } from '@maka/runtime';
import type { TestProxyInput } from '@maka/core/settings/network-settings';
import {
  HEALTH_SIGNAL_LAYERS,
  LOCAL_MEMORY_PROMPT_MAX_CHARS,
  OS_PERMISSION_IDS,
  THEME_PALETTES,
  deriveProviderAuthContractFromConnection,
  appendManualLocalMemoryEntryDraft,
  buildLocalMemoryPromptBody,
  defaultVoiceCaptureCaps,
  findLocalMemoryEntryDraftRange,
  generalizedErrorMessageChinese,
  parseLocalMemoryMarkdown,
  setLocalMemoryEntryStatusDraft,
  validateVoiceCaptureRequest,
  webSearchCredentialStatusFromResponse,
} from '@maka/core';
import { BOT_PROVIDERS, MAX_ALLOWED_USER_IDS, createDefaultSettings, parseAllowedUserIdsFromText } from '@maka/core/settings';
import { PROVIDER_DEFAULTS } from '@maka/core/llm-connections';
import { RelativeTime, redactSecrets, useModalA11y, useToast } from '@maka/ui';
import { normalizeSearchUrl } from '@maka/core';
import { ProvidersPanel } from './ProvidersPanel';
import { PasswordInput } from './password-input';
import { openPathFailureCopy, openPathActionLabel } from '../open-path';
import { applyUiLocale, type UiLocalePreference } from '../theme';
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
import { nextRadioId } from './model-table-keyboard';

type SettingsNavItem = {
  id: SettingsSection;
  label: string;
  Icon: ComponentType<LucideProps>;
  enabled: boolean;
  /** Group label rendered as a small uppercase divider above this item. */
  group: SettingsNavGroup;
};

type AccountSecretProbeStatus = boolean | 'loading' | 'error';
type AccountSecretProbeResult =
  | { slug: string; status: boolean }
  | { slug: string; status: 'error'; message: string };

function focusRadioValue(container: HTMLElement, value: string) {
  container
    .querySelector<HTMLButtonElement>(`button[data-radio-value="${CSS.escape(value)}"]`)
    ?.focus({ preventScroll: true });
}

function onSettingsRadioGroupKeyDown<T extends string>(
  event: KeyboardEvent<HTMLElement>,
  values: readonly T[],
  current: T,
  onChange: (next: T) => void,
) {
  const next = nextRadioId(current, values, event.key) as T | null;
  if (next === null || next === current) return;
  event.preventDefault();
  onChange(next);
  const group = event.currentTarget;
  window.setTimeout(() => focusRadioValue(group, next), 0);
}

function radioTabIndex<T extends string>(value: T, current: T, values: readonly T[]): 0 | -1 {
  if (value === current) return 0;
  return !values.includes(current) && values[0] === value ? 0 : -1;
}

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
  { id: 'daily-review', label: '每日回顾', Icon: CalendarDays, enabled: true, group: 'AI' },
  { id: 'memory', label: '记忆', Icon: Brain, enabled: true, group: 'AI' },
  { id: 'voice-models', label: '语音模型', Icon: Volume2, enabled: true, group: 'AI' },
  { id: 'open-gateway', label: '开放网关', Icon: Sparkles, enabled: true, group: 'AI' },
  // Group 3: 集成 — bot、搜索、网络
  { id: 'bot-chat', label: '机器人对话', Icon: Bot, enabled: true, group: '集成' },
  // PR-UX-POLISH-1 commit 2 (yuejing UX audit msg `9c779b56`):
  // renamed `搜索服务` → `联网搜索` so it doesn't collide semantically
  // with the sidebar's local-content search modal (which is a
  // completely different feature — search across thread / session
  // text, not web). Future Settings page wires per-engine credentials
  // for web-search providers; the sidebar's modal stays the
  // local-content search UI.
  { id: 'search', label: '联网搜索', Icon: Search, enabled: true, group: '集成' },
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
 * PR-BOT-SETTINGS-UI-0 (WAWQAQ msg `51c7b4ff`): per-platform brand
 * presentation. The glyph is a single-character monogram tinted with
 * the brand color so the platform is recognizable at a glance without
 * embedding upstream platform logo SVGs (license/asset hygiene).
 * `configDocUrl` is the official developer doc surfaced inline as a
 * "查看配置文档 →" link.
 */
const BOT_BRAND: Record<BotProvider, { color: string; glyph: string; configDocUrl?: string }> = {
  telegram: { color: '#229ED9', glyph: 'T', configDocUrl: 'https://core.telegram.org/bots/tutorial' },
  feishu:   { color: '#00C6B7', glyph: '飞', configDocUrl: 'https://open.feishu.cn/document/server-docs/bot-v3' },
  wecom:    { color: '#0089FF', glyph: '企', configDocUrl: 'https://developer.work.weixin.qq.com/document/' },
  wechat:   { color: '#07C160', glyph: '微', configDocUrl: 'https://developers.weixin.qq.com/doc/offiaccount/Getting_Started/Overview.html' },
  discord:  { color: '#5865F2', glyph: 'D', configDocUrl: 'https://discord.com/developers/docs/intro' },
  dingtalk: { color: '#1372FB', glyph: '钉', configDocUrl: 'https://open.dingtalk.com/document/' },
  qq:       { color: '#EB1923', glyph: 'Q', configDocUrl: 'https://bot.q.qq.com/wiki/' },
};

// PR-BOT-WECHAT-SCAN-LOGIN-0 (WAWQAQ msg `2fa6ada6`): help copy
// rewritten per reference screenshots — short product sentence pointing
// at where to provision credentials; not a runtime technical breakdown.
const BOT_LABELS: Record<BotProvider, { label: string; help: string; support: 'runtime' | 'credentials' | 'planned' }> = {
  telegram: {
    label: 'Telegram',
    help: '通过 @BotFather 创建 Bot 并获取 Token',
    support: 'runtime',
  },
  feishu: {
    label: '飞书',
    help: '在飞书开放平台创建应用并获取凭证',
    support: 'credentials',
  },
  wecom: {
    label: '企业微信',
    help: '通过企业微信 AI 应用接入，使用 WebSocket 长连接',
    support: 'credentials',
  },
  wechat: {
    label: '微信',
    help: '通过本机 wechat-bridge 接入个人微信，需 iOS / Android 微信 8.0.70+。',
    support: 'credentials',
  },
  discord: {
    label: 'Discord',
    help: '在 Discord Developer Portal 创建 Bot',
    support: 'runtime',
  },
  dingtalk: {
    label: '钉钉',
    help: '在钉钉开发者后台创建机器人应用',
    support: 'runtime',
  },
  qq: {
    label: 'QQ',
    help: '在 QQ 开放平台创建机器人并获取 AppID 和 AppSecret',
    support: 'runtime',
  },
};

const BOT_READINESS_COPY: Record<BotReadinessState, { label: string; detail: string; tone: 'neutral' | 'info' | 'success' | 'warning' | 'destructive' }> = {
  unscaffolded: { label: '未开放', detail: '该平台当前不可作为可用机器人。', tone: 'neutral' },
  scaffolded: { label: '待配置', detail: '等待补齐这个平台需要的凭据配置。', tone: 'neutral' },
  configured: { label: '已配置', detail: '已填写配置；等待完成凭据或运行态验证。', tone: 'info' },
  credentials_valid: { label: '凭据有效', detail: '凭据探测通过；这不代表已能收发消息。', tone: 'warning' },
  operational: { label: '运行可用', detail: '最近一次真实运行探测成功。', tone: 'success' },
  degraded: { label: '运行降级', detail: '之前可用，但最近运行态探测失败。', tone: 'destructive' },
};

const BOT_PLANNED_COPY = {
  label: '未开放',
  detail: '该平台当前不会保存为可用机器人或计划提醒投递目标。',
  tone: 'neutral' as const,
};

function botReadinessCopyForSupport(support: 'runtime' | 'credentials' | 'planned', readiness: BotReadinessState) {
  if (support === 'planned') return BOT_PLANNED_COPY;
  return BOT_READINESS_COPY[readiness] ?? BOT_READINESS_COPY.scaffolded;
}

function canEnableBotChannel(readiness: BotReadinessState): boolean {
  return readiness === 'credentials_valid' || readiness === 'operational' || readiness === 'degraded';
}

/**
 * PR-BOT-SETTINGS-UI-0 (WAWQAQ msg `51c7b4ff`): brand monogram badge
 * with a small status dot at bottom-right. Compact in the platform
 * list, larger inside the hero card via `size="large"`.
 */
function BotBrandLogo(props: {
  provider: BotProvider;
  readiness: BotReadinessState;
  support: 'runtime' | 'credentials' | 'planned';
  size?: 'compact' | 'large';
}) {
  const brand = BOT_BRAND[props.provider];
  const isLarge = props.size === 'large';
  const copy = botReadinessCopyForSupport(props.support, props.readiness);
  return (
    <span
      className="settingsBotLogo"
      data-large={isLarge ? 'true' : undefined}
      data-provider={props.provider}
      aria-hidden="true"
      style={{ ['--bot-brand-color' as string]: brand.color }}
    >
      {brand.glyph}
      {props.support !== 'planned' && (
        <span className="settingsBotLogoStatusDot" data-tone={copy.tone} aria-hidden="true" />
      )}
    </span>
  );
}

/**
 * PR-BOT-SETTINGS-UI-0: status pill rendered inline next to the
 * platform name in the hero card. Colored leading dot + label,
 * matching the reference design's "● 已连接 / ● 未连接" affordance.
 */
function BotStatusPill(props: { tone: 'neutral' | 'info' | 'success' | 'warning' | 'destructive'; label: string }) {
  return (
    <span className="settingsBotStatusPill" data-tone={props.tone}>
      <span className="settingsBotStatusPillDot" aria-hidden="true" />
      {props.label}
    </span>
  );
}

/**
 * PR-BOT-WECHAT-SCAN-LOGIN-0 (WAWQAQ msg `1d9c412e` / `e0ae9de2`):
 * WeChat detail follows the reference design — primary surface is a
 * single Bot Token field for the local bridge, with 公众号 (App ID /
 * App Secret) and the bridge URL tucked into a collapsed "高级设置"
 * section so backend wiring stays intact for users that depend on
 * 公众号 messaging.
 *
 * The Bot Token field maps to `channel.token` (used by wechat-bridge
 * for Bearer auth). Advanced fields keep `appId / appSecret /
 * webhookUrl` so the existing runtime contract continues to work.
 */
function BotWeChatFields(props: {
  channel: BotChannelSettings;
  updateChannel(patch: Partial<BotChannelSettings>): Promise<boolean>;
}) {
  const { channel, updateChannel } = props;
  const hasAdvanced = Boolean(channel.appId || channel.appSecret || channel.webhookUrl);
  const [advancedOpen, setAdvancedOpen] = useState<boolean>(hasAdvanced);
  return (
    <>
      <label className="settingsField">
        <span>Bot Token</span>
        <PasswordInput
          value={channel.token}
          onChange={(next) => updateChannel({ token: next })}
          placeholder="本机 wechat-bridge Bearer Token"
          ariaLabel="微信 Bot Token"
        />
      </label>
      <div className="settingsBotAdvanced">
        <button
          type="button"
          className="settingsBotAdvancedToggle"
          aria-expanded={advancedOpen}
          onClick={() => setAdvancedOpen((current) => !current)}
        >
          {advancedOpen ? '收起高级设置' : '高级设置（公众号 / 本机 bridge 地址）'}
        </button>
        {advancedOpen && (
          <div className="settingsBotAdvancedBody">
            <label className="settingsField">
              <span>本机 bridge 地址</span>
              <input
                value={channel.webhookUrl ?? ''}
                onChange={(event) => updateChannel({ webhookUrl: event.currentTarget.value })}
                placeholder="http://127.0.0.1:18400"
                aria-label="微信本机 bridge 地址"
              />
            </label>
            <label className="settingsField">
              <span>公众号 App ID</span>
              <input
                value={channel.appId ?? ''}
                onChange={(event) => updateChannel({ appId: event.currentTarget.value })}
                placeholder="微信公众号 App ID"
                aria-label="微信公众号 App ID"
              />
            </label>
            <label className="settingsField">
              <span>公众号 App Secret</span>
              <PasswordInput
                value={channel.appSecret ?? ''}
                onChange={(next) => updateChannel({ appSecret: next })}
                placeholder="微信公众号 App Secret"
                ariaLabel="微信公众号 App Secret"
              />
            </label>
            <div className="settingsNotice">
              本机 bridge 默认为 <code>http://127.0.0.1:18400</code>。公众号 App ID / App Secret 仅用于公众号消息发送，个人微信扫码登录走本机 bridge。
            </div>
          </div>
        )}
      </div>
    </>
  );
}

function WeChatScanLoginModal(props: {
  onClose(): void;
  onConfirmed(credentials: { botToken: string; baseUrl: string; botId: string; userId: string }): Promise<void>;
}) {
  const [qr, setQr] = useState<{ qrcodeUrl: string; qrToken: string } | null>(null);
  const [status, setStatus] = useState<'fetching' | 'waiting' | 'expired' | 'confirmed' | 'error'>('fetching');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const fetchingQrRef = useRef(false);
  const scanLoginPollingRef = useRef(false);
  const scanLoginConfirmingRef = useRef(false);
  const scanLoginMountedRef = useRef(false);
  const scanLoginFetchTicketRef = useRef(0);
  useModalA11y(dialogRef, props.onClose);

  async function fetchQr() {
    if (fetchingQrRef.current) return;
    fetchingQrRef.current = true;
    const ticket = ++scanLoginFetchTicketRef.current;
    const isCurrentRequest = () => scanLoginMountedRef.current && scanLoginFetchTicketRef.current === ticket;
    setStatus('fetching');
    setErrorMessage(null);
    try {
      const result = await window.maka.settings.bots.wechat.fetchQrcode();
      if (!isCurrentRequest()) return;
      if (!result.ok) {
        setStatus('error');
        setErrorMessage(settingsActionErrorMessage(result.error.message));
        return;
      }
      setQr(result.data);
      setStatus('waiting');
    } catch (error) {
      if (isCurrentRequest()) {
        setStatus('error');
        setErrorMessage(settingsActionErrorMessage(error));
      }
    } finally {
      if (!scanLoginMountedRef.current || scanLoginFetchTicketRef.current === ticket) {
        fetchingQrRef.current = false;
      }
    }
  }

  useEffect(() => {
    scanLoginMountedRef.current = true;
    void fetchQr();
    return () => {
      scanLoginMountedRef.current = false;
      scanLoginFetchTicketRef.current += 1;
      fetchingQrRef.current = false;
      scanLoginPollingRef.current = false;
      scanLoginConfirmingRef.current = false;
    };
  }, []);

  useEffect(() => {
    if (status !== 'waiting' || !qr?.qrToken) return;
    let cancelled = false;
    const interval = window.setInterval(async () => {
      if (cancelled || scanLoginPollingRef.current || scanLoginConfirmingRef.current) return;
      scanLoginPollingRef.current = true;
      try {
        const result = await window.maka.settings.bots.wechat.pollQrcodeStatus(qr.qrToken);
        if (cancelled || !scanLoginMountedRef.current) return;
        if (!result.ok) {
          setStatus('error');
          setErrorMessage(settingsActionErrorMessage(result.error.message));
          return;
        }
        if (result.data.status === 'confirmed') {
          scanLoginConfirmingRef.current = true;
          setStatus('confirmed');
          await props.onConfirmed(result.data.credentials);
        } else if (result.data.status === 'expired') {
          setStatus('expired');
        }
      } catch (error) {
        if (cancelled || !scanLoginMountedRef.current) return;
        setStatus('error');
        setErrorMessage(settingsActionErrorMessage(error));
      } finally {
        if (!scanLoginConfirmingRef.current) {
          scanLoginPollingRef.current = false;
        }
      }
    }, 2500);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
      scanLoginPollingRef.current = false;
    };
  }, [status, qr?.qrToken]);

  const statusCopy = (() => {
    switch (status) {
      case 'fetching': return '正在获取二维码…';
      case 'waiting': return '请使用 iOS / Android 微信 8.0.70+ 扫描二维码';
      case 'expired': return '二维码已过期，请刷新';
      case 'confirmed': return '已扫码登录';
      case 'error': return errorMessage ?? '扫码登录失败';
    }
  })();

  return (
    <div className="settingsModalBackdrop" role="presentation" onClick={props.onClose}>
      <div
        ref={dialogRef}
        className="settingsBotScanLoginModal"
        role="dialog"
        aria-modal="true"
        aria-label="微信扫码登录"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="settingsBotScanLoginHeader">
          <h3>微信扫码登录</h3>
          <button type="button" className="settingsCloseButton" aria-label="关闭" onClick={props.onClose}>
            <X strokeWidth={1.75} aria-hidden="true" />
          </button>
        </header>
        <div className="settingsBotScanLoginBody">
          {qr?.qrcodeUrl && (status === 'waiting' || status === 'confirmed') ? (
            <img
              className="settingsBotScanLoginQr"
              src={qr.qrcodeUrl}
              alt="微信扫码登录二维码"
            />
          ) : (
            <div className="settingsBotScanLoginQrPlaceholder" aria-hidden="true">
              {status === 'fetching' ? '…' : status === 'expired' ? '⟳' : '!'}
            </div>
          )}
          <p className="settingsBotScanLoginStatus" data-status={status}>{statusCopy}</p>
          <p className="settingsHelpText">
            扫码确认后会保存个人微信机器人凭据；Maka 不保存二维码轮询的中间状态。
          </p>
        </div>
        <div className="settingsBotScanLoginActions" role="group" aria-label="微信扫码登录操作">
          {(status === 'expired' || status === 'error') && (
            <button className="settingsBotAction" type="button" onClick={() => void fetchQr()}>
              刷新二维码
            </button>
          )}
          <button className="settingsBotAction" type="button" onClick={props.onClose}>
            {status === 'confirmed' ? '关闭' : '取消'}
          </button>
        </div>
      </div>
    </div>
  );
}

function WechatQrLoginModal(props: {
  onClose(): void;
  onRefreshStatuses(): void | Promise<unknown>;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const [result, setResult] = useState<WechatBridgeQrCodeResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [reloadNonce, setReloadNonce] = useState(0);
  const notifiedLoggedInRef = useRef(false);
  const loadingQrRef = useRef(false);
  useModalA11y(dialogRef, props.onClose);

  function reloadQrCode() {
    if (loadingQrRef.current) return;
    loadingQrRef.current = true;
    setLoading(true);
    setReloadNonce((current) => current + 1);
  }

  useEffect(() => {
    let active = true;
    loadingQrRef.current = true;
    setLoading(true);
    void window.maka.settings.bots.wechatQrCode()
      .then((next) => {
        if (!active) return;
        setResult(next);
        if (next.ok && next.loggedIn && !notifiedLoggedInRef.current) {
          notifiedLoggedInRef.current = true;
          void props.onRefreshStatuses();
        }
      })
      .catch((error) => {
        if (!active) return;
        setResult({
          ok: false,
          error: settingsActionErrorMessage(error),
          hint: '读取本机 wechat-bridge 二维码失败，请确认 bridge 已启动。',
        });
      })
      .finally(() => {
        if (active) {
          setLoading(false);
          loadingQrRef.current = false;
        }
      });
    return () => {
      active = false;
    };
  }, [reloadNonce]);

  useEffect(() => {
    if (!result?.ok || result.loggedIn || result.expired) return undefined;
    const interval = window.setInterval(() => {
      reloadQrCode();
    }, 3_000);
    return () => window.clearInterval(interval);
  }, [result]);

  const qrDataUrl = result?.ok ? result.qrcode : null;
  const expired = result?.ok ? result.expired : false;
  const loggedIn = result?.ok ? result.loggedIn : false;
  const error = result && !result.ok ? result : null;

  return (
    <div
      className="settingsWechatQrBackdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) props.onClose();
      }}
    >
      <div
        ref={dialogRef}
        className="settingsWechatQrModal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="settingsWechatQrTitle"
      >
        <div className="settingsWechatQrHeader">
          <div>
            <h3 id="settingsWechatQrTitle">微信扫码登录</h3>
            <p>使用手机微信扫描二维码，并在手机上确认登录本机 wechat-bridge。</p>
          </div>
          <button
            type="button"
            className="settingsWechatQrClose"
            aria-label="关闭微信扫码登录"
            onClick={props.onClose}
          >
            <X size={17} aria-hidden="true" />
          </button>
        </div>

        <div className="settingsWechatQrBody">
          {loading ? (
            <div className="settingsWechatQrState" data-tone="loading">
              正在生成二维码…
            </div>
          ) : loggedIn ? (
            <div className="settingsWechatQrState" data-tone="success">
              微信已登录，返回后可以测试连接或重启监听。
            </div>
          ) : expired ? (
            <div className="settingsWechatQrState" data-tone="warning">
              二维码已过期
              <button type="button" className="settingsWechatQrSecondary" disabled={loading} onClick={reloadQrCode}>
                {loading ? '刷新中…' : '刷新二维码'}
              </button>
            </div>
          ) : qrDataUrl ? (
            <>
              <div className="settingsWechatQrFrame">
                <img src={qrDataUrl} alt="微信扫码登录二维码" />
              </div>
              <p className="settingsWechatQrCaption">等待扫码确认… 窗口会每 3 秒刷新登录状态。</p>
            </>
          ) : error ? (
            <div className="settingsWechatQrState" data-tone="error" role="alert">
              <strong>{error.error}</strong>
              <span>{error.hint}</span>
              <button type="button" className="settingsWechatQrSecondary" disabled={loading} onClick={reloadQrCode}>
                {loading ? '重试中…' : '重试'}
              </button>
            </div>
          ) : (
            <div className="settingsWechatQrState" data-tone="loading">
              bridge 正在生成二维码
              <button type="button" className="settingsWechatQrSecondary" disabled={loading} onClick={reloadQrCode}>
                {loading ? '获取中…' : '重新获取'}
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

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
   * PR-THEME-APPLY-AND-DONE-POLISH-0 (WAWQAQ msg `dec85e5b`): current
   * palette + live setter. Click handler calls `onThemePaletteChange(next)`
   * synchronously so the `data-maka-theme` attribute updates on the same
   * tick — no need to wait for the IPC `appearance.palette` round-trip,
   * and no need for a restart for switching to take visible effect.
   */
  themePalette: ThemePalette;
  onThemePaletteChange(palette: ThemePalette): void;
  onUserLabelChange?(label: string): void;
  /**
   * Force the modal to a specific section when it (re-)mounts or when the
   * value changes while already open. Used by the command palette so
   * ⌘K → "网络" jumps straight to the section without an extra click.
   */
  requestedSection?: SettingsSection;
  /**
   * PR-DAILY-REVIEW-MVP-0 follow-up: navigate to the sidebar's
   * Daily Review module. Optional so the settings page degrades
   * gracefully when the shell does not provide the jump.
   */
  onOpenDailyReview?(): void;
  /**
   * Jump from diagnostics surfaces (usage rows, later run history) back to the
   * source conversation. Settings owns the table, shell owns navigation.
   */
  onOpenSession?(sessionId: string): void;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const activeNavRef = useRef<HTMLButtonElement>(null);
  // Escape closes the modal, Tab/Shift+Tab cycles inside the dialog,
  // focus restored to the trigger on close.
  useModalA11y(dialogRef, props.onClose, activeNavRef);

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
          themePalette={props.themePalette}
          onThemePaletteChange={props.onThemePaletteChange}
          onUserLabelChange={props.onUserLabelChange}
          requestedSection={props.requestedSection}
          initialFocusRef={activeNavRef}
          onOpenDailyReview={props.onOpenDailyReview}
          onOpenSession={props.onOpenSession}
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
  themePalette: ThemePalette;
  onThemePaletteChange(palette: ThemePalette): void;
  onUserLabelChange?(label: string): void;
  requestedSection?: SettingsSection;
  initialFocusRef: RefObject<HTMLButtonElement | null>;
  onOpenDailyReview?(): void;
  onOpenSession?(sessionId: string): void;
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

  // PR-MODEL-OAUTH-SECTION-0: ProvidersPanel's OAuth cards dispatch a
  // `maka:jumpToSettingsSection` window event to navigate between
  // Settings sections without threading another prop through. The event
  // payload is the destination SettingsSection id.
  useEffect(() => {
    const handler = (event: Event) => {
      const detail = (event as CustomEvent<{ section?: SettingsSection }>).detail;
      // PR-OAUTH-CARD-LIVE-STATE-0: validate against SETTINGS_NAV so
      // a dispatched section id that doesn't match any nav item falls
      // through to the default fallback page silently. Previously
      // any truthy string was accepted; a typo would land the user
      // on "该设置页已纳入 Maka 设置树…" with no clear cause.
      if (
        detail?.section &&
        SETTINGS_NAV.some((item) => item.id === detail.section)
      ) {
        setSection(detail.section);
      }
    };
    window.addEventListener('maka:jumpToSettingsSection', handler);
    return () => window.removeEventListener('maka:jumpToSettingsSection', handler);
  }, []);

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
  const settingsModalMountedRef = useRef(false);
  const settingsReloadTicketRef = useRef(0);
  const settingsUpdateTicketRef = useRef(0);
  const usageReloadTicketRef = useRef(0);
  const toast = useToast();

  useEffect(() => {
    settingsModalMountedRef.current = true;
    return () => {
      settingsModalMountedRef.current = false;
      settingsReloadTicketRef.current += 1;
      settingsUpdateTicketRef.current += 1;
      usageReloadTicketRef.current += 1;
    };
  }, []);

  async function reloadSettings() {
    const ticket = settingsReloadTicketRef.current + 1;
    settingsReloadTicketRef.current = ticket;
    try {
      const next = await window.maka.settings.get();
      if (settingsModalMountedRef.current && ticket === settingsReloadTicketRef.current) {
        setSettings(next);
      }
    } catch (error) {
      if (settingsModalMountedRef.current && ticket === settingsReloadTicketRef.current) {
        toast.error('载入设置失败', settingsActionErrorMessage(error));
      }
    } finally {
      if (settingsModalMountedRef.current && ticket === settingsReloadTicketRef.current) {
        setLoading(false);
      }
    }
  }

  async function updateSettings(patch: Parameters<typeof window.maka.settings.update>[0]) {
    const ticket = settingsUpdateTicketRef.current + 1;
    settingsUpdateTicketRef.current = ticket;
    const result = await window.maka.settings.update(patch);
    const next = result.settings;
    if (settingsModalMountedRef.current && ticket === settingsUpdateTicketRef.current) {
      setSettings(next);
      props.onUserLabelChange?.(next.personalization.displayName);
    }
    return result;
  }

  async function reloadUsage(range: UsageRange = settings.usage.range) {
    const ticket = usageReloadTicketRef.current + 1;
    usageReloadTicketRef.current = ticket;
    try {
      const next = await window.maka.settings.usageStats(range);
      if (settingsModalMountedRef.current && ticket === usageReloadTicketRef.current) {
        setUsageStats(next);
      }
    } catch (error) {
      if (settingsModalMountedRef.current && ticket === usageReloadTicketRef.current) {
        toast.error('载入使用统计失败', settingsActionErrorMessage(error));
      }
    }
  }

  useEffect(() => {
    void reloadSettings();
  }, []);

  useEffect(() => {
    if (section === 'usage') void reloadUsage();
  }, [section]);

  const activeItem = SETTINGS_NAV.find((item) => item.id === section) ?? SETTINGS_NAV[0];

  return (
    <main className="settingsSurface" data-modal="true" aria-label="设置内容">
      <aside className="settingsSidebar" aria-label="设置侧栏">
        <header>
          <span>设置</span>
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
              <div key={group} className="settingsNavGroup" role="group" aria-label={group}>
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
                    aria-current={section === item.id ? 'page' : undefined}
                    type="button"
                    ref={section === item.id ? props.initialFocusRef : undefined}
                    disabled={!item.enabled}
                    onClick={() => setSection(item.id)}
                  >
                    <span className="settingsNavGlyph" aria-hidden="true">
                      <item.Icon size={16} strokeWidth={1.5} />
                    </span>
                    <strong>{item.label}</strong>
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
              themePalette={props.themePalette}
              onRefreshConnections={props.onRefresh}
              onUpdateSettings={updateSettings}
              onReloadSettings={reloadSettings}
              onReloadUsage={reloadUsage}
              onThemeChange={props.onThemeChange}
              onDensityChange={props.onDensityChange}
              onThemePaletteChange={props.onThemePaletteChange}
              onOpenDailyReview={props.onOpenDailyReview}
              onOpenSession={props.onOpenSession}
            />
          )}
        </div>
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
  themePalette: ThemePalette;
  onRefreshConnections(): Promise<void>;
  onUpdateSettings(patch: Parameters<typeof window.maka.settings.update>[0]): Promise<UpdateAppSettingsResult>;
  onReloadSettings(): Promise<void>;
  onReloadUsage(range?: UsageRange): Promise<void>;
  onThemeChange(pref: ThemePreference): void;
  onDensityChange(density: UiDensity): void;
  onThemePaletteChange(palette: ThemePalette): void;
  onOpenDailyReview?(): void;
  onOpenSession?(sessionId: string): void;
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
          onOpenSession={props.onOpenSession}
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
    case 'open-gateway':
      return <OpenGatewaySettingsPage settings={props.settings} onUpdate={props.onUpdateSettings} />;
    case 'about':
      return <AboutSettingsPage />;
    case 'general':
      return (
        <SettingsRows>
          <SettingRow title="启动" detail="打开应用后回到最近一次对话。" value="已启用" />
          <SettingRow title="新对话模式" detail="新对话默认从确认模式开始。" value="确认" />
          <SettingRow title="默认模型" detail="新对话默认使用的模型连接。" value={props.defaultSlug ?? '未设置'} />
        </SettingsRows>
      );
    case 'theme':
      return (
        <ThemeSettingsPage
          themePref={props.themePref}
          density={props.density}
          themePalette={props.themePalette}
          settings={props.settings}
          onUpdate={props.onUpdateSettings}
          onThemeChange={props.onThemeChange}
          onDensityChange={props.onDensityChange}
          onThemePaletteChange={props.onThemePaletteChange}
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
    case 'daily-review':
      return <DailyReviewSettingsPage onOpenDailyReview={props.onOpenDailyReview} />;
    case 'memory':
      return (
        <MemorySettingsPage
          settings={props.settings}
          onUpdate={props.onUpdateSettings}
          onReloadSettings={props.onReloadSettings}
        />
      );
    case 'voice-models':
      return <VoiceModelsSettingsPage />;
    case 'search':
      return (
        <WebSearchSettingsPage
          settings={props.settings}
          onUpdate={props.onUpdateSettings}
        />
      );
    default:
      return (
        <SettingsRows>
          <SettingRow title={navLabel(props.section)} detail="该设置页已纳入 Maka 设置树，会随对应 runtime 能力一起工作。" value="Ready" />
        </SettingsRows>
      );
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
  const [infoError, setInfoError] = useState<string | null>(null);
  const [copyingEnvSummary, setCopyingEnvSummary] = useState(false);
  const copyingEnvSummaryRef = useRef(false);
  const aboutPageMountedRef = useRef(false);
  const toast = useToast();

  useEffect(() => {
    let cancelled = false;
    aboutPageMountedRef.current = true;
    window.maka.app
      .info()
      .then((next) => {
        if (!cancelled) {
          setInfo(next);
          setInfoError(null);
        }
      })
      .catch((error) => {
        if (cancelled) return;
        const message = settingsActionErrorMessage(error);
        setInfoError(message);
        toast.error('载入关于信息失败', message);
    });
    return () => {
      cancelled = true;
      aboutPageMountedRef.current = false;
      copyingEnvSummaryRef.current = false;
    };
  }, [toast]);

  if (!info && !infoError) {
    return (
      <div className="maka-skeleton-stack" aria-busy="true" aria-label="正在加载关于页">
        <div className="maka-skeleton maka-skeleton-line" data-size="lg" style={{ width: '38%' }} />
        <div className="maka-skeleton maka-skeleton-line" style={{ width: '70%' }} />
        <div className="maka-skeleton maka-skeleton-line" style={{ width: '52%' }} />
      </div>
    );
  }

  if (!info) {
    return (
      <div className="settingsStructuredPage">
        <div className="settingsNotice" role="alert">
          <strong>无法载入关于信息</strong>
          <small>{infoError}</small>
        </div>
      </div>
    );
  }

  const platformPretty = PLATFORM_LABEL[info.platform] ?? info.platform;
  const platformLine = `${platformPretty} ${info.osRelease} · ${info.arch}`;

  async function copyEnvSummary() {
    if (!info) return;
    if (copyingEnvSummaryRef.current) return;
    copyingEnvSummaryRef.current = true;
    setCopyingEnvSummary(true);
    // Markdown block ready to paste into a problem report. Deliberately excludes
    // workspacePath since that can leak the OS username; user can still copy
    // it from the Data page if needed.
    const buildLine =
      info.buildMode === 'dev'
        ? `- Build: dev${info.buildCommit ? ` @ ${info.buildCommit}` : ''}`
        : '- Build: packaged';
    const summary = [
      `**Maka** v${info.appVersion}`,
      ``,
      `- Electron: ${info.electronVersion}`,
      `- Node: ${info.nodeVersion}`,
      `- Chrome: ${info.chromeVersion}`,
      `- Platform: ${platformPretty} ${info.osRelease}`,
      `- Arch: ${info.arch}`,
      buildLine,
    ].join('\n');
    try {
      await navigator.clipboard.writeText(summary);
      if (aboutPageMountedRef.current) {
        toast.success('已复制环境信息', '可直接粘贴到问题报告');
      }
    } catch {
      if (aboutPageMountedRef.current) {
        toast.error('复制失败', '剪贴板不可用或被系统拒绝。');
      }
    } finally {
      copyingEnvSummaryRef.current = false;
      if (aboutPageMountedRef.current) {
        setCopyingEnvSummary(false);
      }
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
            <span className="settingsAboutChannel">
              {info.buildMode === 'dev'
                ? info.buildCommit
                  ? `本地开发版 · ${info.buildCommit}`
                  : '本地开发版'
                : '正式版'}
            </span>
          </div>
          <p className="settingsAboutTagline">本地优先的 AI 助手 · 桌面端运行环境</p>
        </div>
      </header>

      <section className="settingsAboutPrivacy" aria-label="隐私与安全">
        <h3>本地优先 · 隐私默认</h3>
        <ul aria-label="隐私与安全说明">
          <li>所有会话、设置、凭据和 Skill 指令文件都保留在本机工作区，不上传到 Maka 服务器</li>
          <li>模型供应商密钥通过系统安全存储加密保存，优先使用 macOS 钥匙串等系统能力</li>
          <li>Maka 不发送任何使用遥测；只在你显式启用时与所选模型供应商通信</li>
          <li>权限策略会判断工具调用风险；高危操作需要在对话内明示授权</li>
          <li>每个会话都会在本机保留消息、工具调用、权限决策与模式变更记录</li>
        </ul>
      </section>

      <SettingsRows>
        <SettingRow
          title="运行时"
          detail="界面层、桌面运行时和本地 Node 版本号一并显示。"
          value={`Electron ${info.electronVersion} · Node ${info.nodeVersion} · Chrome ${info.chromeVersion}`}
        />
        <SettingRow title="平台" detail="操作系统、版本和 CPU 架构。" value={platformLine} />
        <SettingRow
          title="工作区"
          detail="会话、设置和凭据全部留在本地这条路径下。"
          value={info.workspacePath}
        />
        <SettingRow
          title="存储"
          detail="会话记录、设置文件、SQLite 使用统计和系统安全存储加密的模型密钥。"
          value="本地"
        />
      </SettingsRows>

      <div className="settingsActionRow">
        <button type="button" className="maka-button" disabled={copyingEnvSummary} onClick={() => void copyEnvSummary()}>
          {copyingEnvSummary ? '复制中…' : '复制环境信息'}
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

/**
 * PR-DAILY-REVIEW-MVP-0 follow-up: Settings → 每日回顾 is no longer
 * a roadmap page. The sidebar panel handles browsing/usage; this
 * page summarizes what it does, the privacy boundary, and offers a
 * one-click jump to the sidebar.
 */
function DailyReviewSettingsPage(props: { onOpenDailyReview?: () => void }) {
  return (
    <section className="settingsFeatureStatusPage" aria-label="每日回顾">
      <header className="settingsFeatureStatusBanner" role="status">
        <span className="settingsFeatureStatusBannerDot" aria-hidden="true" />
        <strong>本地汇总 · 已上线</strong>
        <span>读取本机 Maka 自己产生的会话与使用统计，不联网、不读其他 App 数据。</span>
      </header>

      <div className="settingsFeatureStatusHero">
        <span className="settingsFeatureStatusIcon" aria-hidden="true">
          <CalendarDays size={24} strokeWidth={1.5} />
        </span>
        <div>
          <div className="settingsFeatureStatusHeroHeading">
            <h3>每日回顾</h3>
            <span className="settingsFeatureStatusBadge">本地汇总</span>
          </div>
          <p>
            每日回顾会按你选择的日期范围，把活跃会话、模型用量、工具调用聚合到一个面板里。
            主内容栏里的 "每日回顾" 支持今日 / 本周 / 本月切换、左右翻页、复制 / 保存 Markdown 摘要，也可以把当前范围粘到输入框继续追问。
          </p>
          {props.onOpenDailyReview && (
            <button
              type="button"
              className="maka-button"
              onClick={props.onOpenDailyReview}
              style={{ marginTop: 8 }}
            >
              打开每日回顾
            </button>
          )}
        </div>
      </div>

      <div className="settingsFeatureStatusHeroHeading">
        <h3>当前包含</h3>
      </div>
      <ul className="settingsFeatureStatusList" aria-label="每日回顾当前包含">
        <li>对话数 / 请求数 / Token / 费用 / 错误数</li>
        <li>今日 / 本周 / 本月三个范围，以及按范围翻页</li>
        <li>活跃对话（点击可直接打开）</li>
        <li>使用最频繁的模型 Top 8</li>
        <li>调用最频繁的工具 Top 8</li>
        <li>复制 / 保存 Markdown 摘要，或粘到输入框继续追问</li>
      </ul>

      <div className="settingsFeatureStatusHeroHeading">
        <h3>不会做的事</h3>
      </div>
      <ul className="settingsFeatureStatusList" aria-label="每日回顾不会执行的事">
        <li>不调用任何 LLM 生成摘要（当前只是本地聚合数字，不向云端送内容）</li>
        <li>不写入记忆系统，也不导出任何东西</li>
        <li>不读取 Maka 工作区以外的文件</li>
      </ul>
    </section>
  );
}

type VoiceSmokeState =
  | { status: 'idle'; message: string }
  | { status: 'checking'; message: string }
  | { status: 'recording'; message: string }
  | { status: 'ok'; message: string; durationMs: number; audioBytes: number }
  | { status: 'error'; message: string };

function VoiceModelsSettingsPage() {
  const [permission, setPermission] = useState<VoicePermissionStatus>('unknown');
  const [smoke, setSmoke] = useState<VoiceSmokeState>({
    status: 'idle',
    message: '等待运行本机录音自检。',
  });
  const [isBusy, setIsBusy] = useState(false);
  const captureSmokeBusyRef = useRef(false);
  const voicePageMountedRef = useRef(false);
  const toast = useToast();
  const caps = defaultVoiceCaptureCaps();

  useEffect(() => {
    voicePageMountedRef.current = true;
    return () => {
      voicePageMountedRef.current = false;
      captureSmokeBusyRef.current = false;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    void readBrowserMicrophonePermission().then((next) => {
      if (!cancelled) setPermission(next);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  async function runCaptureSmoke() {
    if (captureSmokeBusyRef.current) return;
    if (!navigator.mediaDevices?.getUserMedia) {
      setPermission('unsupported');
      setSmoke({ status: 'error', message: '当前运行环境不支持浏览器麦克风 API。' });
      return;
    }
    if (typeof MediaRecorder === 'undefined') {
      setPermission('unsupported');
      setSmoke({ status: 'error', message: '当前运行环境不支持 MediaRecorder，无法做本地录音自检。' });
      return;
    }

    captureSmokeBusyRef.current = true;
    setIsBusy(true);
    setSmoke({ status: 'checking', message: '正在请求 macOS / 浏览器麦克风权限…' });
    let stream: MediaStream | null = null;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: caps.maxChannels,
          sampleRate: caps.maxSampleRate,
        },
      });
      if (!voicePageMountedRef.current) return;
      setPermission('granted');
      setSmoke({ status: 'recording', message: '正在录制 2 秒本地样本；样本只在内存里计算大小，结束后立即丢弃。' });
      const startedAt = performance.now();
      const chunks: Blob[] = [];
      const recorder = new MediaRecorder(stream);
      recorder.addEventListener('dataavailable', (event) => {
        if (event.data.size > 0) chunks.push(event.data);
      });
      const stopped = new Promise<void>((resolve, reject) => {
        recorder.addEventListener('stop', () => resolve(), { once: true });
        recorder.addEventListener('error', () => reject(new Error('录音自检失败')), { once: true });
      });
      recorder.start();
      await waitMs(2_000);
      if (recorder.state !== 'inactive') recorder.stop();
      await stopped;
      const durationMs = Math.round(performance.now() - startedAt);
      const audioBytes = chunks.reduce((sum, chunk) => sum + chunk.size, 0);
      const validation = validateVoiceCaptureRequest({
        mode: 'push_to_talk',
        permission: 'granted',
        durationMs,
        audioBytes,
        sampleRate: caps.maxSampleRate,
        channels: caps.maxChannels,
      });
      if (!validation.ok) {
        if (voicePageMountedRef.current) {
          setSmoke({ status: 'error', message: voiceValidationCopy(validation.reason) });
        }
        return;
      }
      const message = `录音链路可用：${formatVoiceDuration(durationMs)}，${formatVoiceBytes(audioBytes)}。样本未保存。`;
      if (voicePageMountedRef.current) {
        setSmoke({ status: 'ok', message, durationMs, audioBytes });
        toast.success('语音自检通过', message);
      }
    } catch (error) {
      const next = classifyVoicePermissionError(error);
      const message = next === 'denied'
        ? '麦克风权限被拒绝；请在系统设置里允许 Maka 访问麦克风后重试。'
        : '录音自检失败；请确认系统权限和音频设备可用。';
      if (voicePageMountedRef.current) {
        setPermission(next);
        setSmoke({ status: 'error', message });
        toast.error('语音自检失败', message);
      }
    } finally {
      stream?.getTracks().forEach((track) => track.stop());
      captureSmokeBusyRef.current = false;
      if (voicePageMountedRef.current) {
        setIsBusy(false);
      }
    }
  }

  return (
    <section className="settingsFeatureStatusPage" aria-label="语音模型">
      <header className="settingsFeatureStatusBanner" role="status">
        <span className="settingsFeatureStatusBannerDot" aria-hidden="true" />
        <strong>本机录音自检 · 已上线</strong>
        <span>只做本地权限与采集链路自检；不上传音频、不保存样本、不写入记忆。</span>
      </header>

      <div className="settingsFeatureStatusHero">
        <span className="settingsFeatureStatusIcon" aria-hidden="true">
          <Volume2 size={24} strokeWidth={1.5} />
        </span>
        <div>
          <div className="settingsFeatureStatusHeroHeading">
            <h3>语音模型</h3>
            <span className="settingsFeatureStatusBadge">本地自检</span>
          </div>
          <p>
            这页现在可以验证麦克风权限和本地录音链路。语音转写和语音朗读模型必须遵守这个边界：
            转写结果必须先回到消息输入框，由用户编辑确认后才能发送；音频样本默认不落盘。
          </p>
        </div>
      </div>

      <dl className="settingsBotStatusGrid" aria-label="语音能力状态">
        <div>
          <dt>麦克风权限</dt>
          <dd>{voicePermissionLabel(permission)}</dd>
        </div>
        <div>
          <dt>采集上限</dt>
          <dd>{Math.round(caps.maxDurationMs / 1000)} 秒 · {Math.round(caps.maxAudioBytes / 1024 / 1024)} MB</dd>
        </div>
        <div>
          <dt>通道</dt>
          <dd>单声道 · ≤ {Math.round(caps.maxSampleRate / 1000)} kHz</dd>
        </div>
        <div>
          <dt>隐私</dt>
          <dd>不保存音频 · 不进遥测</dd>
        </div>
      </dl>

      <div className="settingsActionRow">
        <button
          className="maka-button"
          type="button"
          onClick={() => void runCaptureSmoke()}
          disabled={isBusy}
          aria-busy={isBusy}
          data-pending={isBusy ? 'true' : undefined}
        >
          {isBusy ? '自检中…' : '运行录音自检'}
        </button>
      </div>

      <div className="settingsNotice" data-tone={smoke.status === 'error' ? undefined : 'passive'} role="status">
        {smoke.message}
      </div>

      <div className="settingsFeatureStatusHeroHeading">
        <h3>当前边界</h3>
      </div>
      <ul className="settingsFeatureStatusList" aria-label="语音能力边界说明">
        <li>录音样本只在本机内存里用于计算时长和大小；自检结束后立即停止采集并丢弃样本。</li>
        <li>配置语音转写模型之前，不会把音频传给任何云端服务。</li>
        <li>转写文本只进入消息输入框草稿；用户发送前必须能编辑。</li>
      </ul>
    </section>
  );
}

async function readBrowserMicrophonePermission(): Promise<VoicePermissionStatus> {
  const query = (navigator.permissions as { query?: (descriptor: { name: string }) => Promise<{ state: string }> } | undefined)?.query;
  if (!query) return 'unknown';
  try {
    const result = await query.call(navigator.permissions, { name: 'microphone' });
    if (result.state === 'granted') return 'granted';
    if (result.state === 'denied') return 'denied';
    if (result.state === 'prompt') return 'not_determined';
    return 'unknown';
  } catch {
    return 'unknown';
  }
}

function classifyVoicePermissionError(error: unknown): VoicePermissionStatus {
  const name = error instanceof DOMException ? error.name : '';
  if (name === 'NotAllowedError' || name === 'SecurityError') return 'denied';
  if (name === 'NotFoundError' || name === 'NotReadableError') return 'unsupported';
  return 'unknown';
}

function voicePermissionLabel(status: VoicePermissionStatus): string {
  switch (status) {
    case 'granted': return '已授权';
    case 'denied': return '已拒绝';
    case 'restricted': return '受系统限制';
    case 'not_determined': return '待授权';
    case 'unsupported': return '不支持';
    case 'unknown': return '未知';
  }
}

function voiceValidationCopy(reason: string): string {
  switch (reason) {
    case 'duration_exceeded': return '录音超过时长上限。';
    case 'audio_too_large': return '录音样本超过大小上限。';
    case 'invalid_audio_shape': return '录音格式不符合当前采集契约。';
    case 'permission_not_granted': return '麦克风权限未授予。';
    default: return '语音采集自检未通过。';
  }
}

function formatVoiceDuration(durationMs: number): string {
  return `${Math.max(0, durationMs / 1000).toFixed(1)} 秒`;
}

function formatVoiceBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function waitMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const THEME_OPTIONS: Array<{ value: ThemePreference; label: string; help: string }> = [
  { value: 'light', label: '浅色', help: '始终使用浅色界面。' },
  { value: 'dark', label: '深色', help: '始终使用深色界面。' },
  { value: 'auto', label: '跟随系统', help: '匹配 macOS 当前浅色或深色偏好。' },
];

function accountConnectionTestFailureMessage(result: ConnectionTestResult): string {
  const fallback = accountConnectionTestFailureFallback(result);
  if (!result.errorMessage) return fallback;
  return generalizedErrorMessageChinese(new Error(result.errorMessage), fallback);
}

function accountConnectionTestFailureFallback(result: ConnectionTestResult): string {
  if (result.statusCode === 429) return '当前账号或模型服务触发速率限制，请稍后重试。';
  if (result.errorClass === 'timeout') return '请求超时，请检查网络或代理后重试。';
  if (result.errorClass === 'auth' || result.statusCode === 401 || result.statusCode === 403) {
    return '鉴权失败，请检查模型密钥、订阅账号登录或凭据配置后重试。';
  }
  if (result.errorClass === 'provider_unavailable' || (result.statusCode !== undefined && result.statusCode >= 500)) {
    return '模型服务暂时不可用，请稍后重试。';
  }
  if (result.errorClass === 'network') return '网络错误，请检查服务地址或代理设置后重试。';
  return '连接测试失败，请检查模型连接配置后重试。';
}

function accountLastTestMessageDisplay(message: string | undefined): string | undefined {
  if (!message) return undefined;
  const trimmed = message.trim();
  if (!trimmed) return undefined;
  if (/[\u4e00-\u9fa5]/.test(trimmed)) return trimmed;
  const normalized = trimmed.toLowerCase();
  if (normalized === 'connection verified') return '连接已验证';
  if (normalized === 'authentication failed') return '鉴权失败';
  if (normalized === 'request timed out') return '请求超时';
  if (normalized === 'network error') return '网络错误';
  if (normalized === 'provider returned an error') return '模型服务返回错误';
  if (normalized === 'connection test failed') return '连接测试失败';
  const classified = generalizedErrorMessageChinese(new Error(trimmed), '');
  return classified || '连接测试状态暂时无法显示，请重新测试。';
}

function AccountSettingsPage(props: {
  connections: LlmConnection[];
  defaultSlug: string | null;
  onRefresh(): Promise<void>;
}) {
  // Backend (xuan, 5ca1f8a) persists per-connection lastTestStatus. UI
  // derives the display status from `enabled + hasSecret + defaultModel +
  // lastTestStatus + authKind` per @kenji's status-contract priority list,
  // so we never produce mixed labels like "disabled + verified".
  const [secretMap, setSecretMap] = useState<Record<string, AccountSecretProbeStatus>>({});
  const [secretProbeError, setSecretProbeError] = useState<string | null>(null);
  const [testingSlug, setTestingSlug] = useState<string | null>(null);
  const testingSlugRef = useRef<string | null>(null);
  const accountPageMountedRef = useRef(false);
  const toast = useToast();

  useEffect(() => {
    accountPageMountedRef.current = true;
    return () => {
      accountPageMountedRef.current = false;
      testingSlugRef.current = null;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    void Promise.all<AccountSecretProbeResult>(
      props.connections.map(async (connection) => {
        try {
          const has = await window.maka.connections.hasSecret(connection.slug);
          return { slug: connection.slug, status: has };
        } catch (error) {
          return { slug: connection.slug, status: 'error', message: settingsActionErrorMessage(error) };
        }
      }),
    ).then((entries) => {
      if (cancelled) return;
      setSecretMap(Object.fromEntries(entries.map((entry) => [entry.slug, entry.status])));
      const failure = entries.find(
        (entry): entry is Extract<AccountSecretProbeResult, { status: 'error' }> => entry.status === 'error',
      );
      if (failure) {
        setSecretProbeError(failure.message);
        toast.error('读取模型凭据状态失败', failure.message);
      } else {
        setSecretProbeError(null);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [props.connections]);

  async function testConnection(slug: string) {
    if (testingSlugRef.current !== null) return;
    testingSlugRef.current = slug;
    setTestingSlug(slug);
    try {
      const result = await window.maka.connections.test(slug);
      if (!accountPageMountedRef.current || testingSlugRef.current !== slug) return;
      if (result.ok) {
        toast.success('连接已验证', `延迟 ${result.latencyMs ?? '?'} ms${result.modelTested ? ' · ' + result.modelTested : ''}`);
      } else {
        toast.error('连接测试失败', accountConnectionTestFailureMessage(result));
      }
    } catch (error) {
      // Main is supposed to return a structured result; if something escapes
      // to throw form, surface the generalized message anyway.
      if (accountPageMountedRef.current && testingSlugRef.current === slug) {
        toast.error('测试出错', settingsActionErrorMessage(error));
      }
    } finally {
      // Pull the freshest lastTestStatus/lastTestAt/lastTestMessage so the
      // row re-renders with the new derived status without a Settings reopen.
      if (accountPageMountedRef.current && testingSlugRef.current === slug) {
        try {
          await props.onRefresh();
        } catch (error) {
          if (accountPageMountedRef.current && testingSlugRef.current === slug) {
            toast.error('刷新模型连接状态失败', settingsActionErrorMessage(error));
          }
        } finally {
          testingSlugRef.current = null;
          if (accountPageMountedRef.current) {
            setTestingSlug(null);
          }
        }
      } else if (testingSlugRef.current === slug) {
        testingSlugRef.current = null;
      }
    }
  }

  const enabledCount = props.connections.filter((connection) => connection.enabled).length;
  const totalCount = props.connections.length;
  return (
    <div className="settingsStructuredPage">
      <SettingsRows>
        <SettingRow
          title="默认权限模式"
          detail="新会话默认从确认模式开始；可在对话顶部切到只读或执行。"
          value="需要确认"
        />
        <SettingRow
          title="凭据保护"
          detail="模型密钥和订阅账号令牌会交给系统安全存储加密保存。"
          value="启用"
        />
        <SettingRow
          title="审计日志"
          detail="每个会话都会在本机保留消息、工具调用、权限决策与模式变更记录。"
          value="本地"
        />
      </SettingsRows>

      <h3 className="settingsSubheading">模型连接</h3>
      {secretProbeError && (
        <div className="settingsNotice" role="alert">
          模型凭据状态暂时没刷新成功，已避免把未知状态显示成待配置。{secretProbeError}
        </div>
      )}
      {totalCount === 0 ? (
        <div className="settingsEmptyState">等待添加模型连接。可在 设置 · 模型 添加。</div>
      ) : (
        <div className="settingsConnectionList" role="list" aria-label="模型连接列表">
          {props.connections.map((connection) => (
            <AccountConnectionRow
              key={connection.slug}
              connection={connection}
              secretStatus={secretMap[connection.slug] ?? 'loading'}
              isDefault={connection.slug === props.defaultSlug}
              testing={testingSlug === connection.slug}
              canTest={testingSlug === null}
              onTest={() => void testConnection(connection.slug)}
            />
          ))}
        </div>
      )}
      <p className="settingsHelpText">
        共 {totalCount} 个连接 · {enabledCount} 已启用。修改模型密钥、服务地址或默认模型会清掉「已验证」状态，
        需要重新测试。失败的测试不会自动禁用连接 —— 禁用始终是用户动作。
      </p>

      {/*
        PR-CLAUDE-CARD-MOVE-0 (WAWQAQ msg ddecd729): the Claude
        subscription card was previously rendered here. It now
        lives in 设置 → 模型 (`ProvidersPanel.tsx → ModelOAuthSection`)
        alongside the other OAuth-bound providers (Codex / Cursor
        / Antigravity), because OAuth is a model-side concern and
        the 账户 panel should only carry identity / security state.
      */}
    </div>
  );
}

function AccountConnectionRow(props: {
  connection: LlmConnection;
  secretStatus: AccountSecretProbeStatus;
  isDefault: boolean;
  testing: boolean;
  canTest: boolean;
  onTest(): void;
}) {
  const requiresSecret = PROVIDER_DEFAULTS[props.connection.providerType].authKind !== 'none';
  const secretProbePending = requiresSecret && (props.secretStatus === 'loading' || props.secretStatus === 'error');
  const hasSecretForKnownStatus = props.secretStatus === true;
  const status: ConnectionUiStatus = connectionUiStatusFromRecord(
    props.connection,
    secretProbePending ? true : hasSecretForKnownStatus,
  );
  const presentation = secretProbePending
    ? {
        label: props.secretStatus === 'loading' ? '读取凭据状态…' : '凭据状态未知',
        detail: props.secretStatus === 'loading'
          ? '正在读取本机凭据状态；不会把读取中显示成待配置。'
          : '暂时无法读取本机凭据状态；请刷新或到模型设置查看。',
        tone: props.secretStatus === 'loading' ? 'info' as const : 'warning' as const,
      }
    : presentConnectionUiStatus(status);
  const authContract = secretProbePending
    ? undefined
    : deriveProviderAuthContractFromConnection(props.connection, hasSecretForKnownStatus);
  const authPresentation = authContract
    ? presentAccountAuthState(authContract)
    : {
        label: '凭据状态读取中',
        detail: props.secretStatus === 'loading'
          ? '正在读取本机凭据和账号登录状态。'
          : '读取本机凭据和账号登录状态失败，当前不会显示为待配置。',
        stateLabel: props.secretStatus === 'loading' ? '读取中' : '读取失败',
        tone: props.secretStatus === 'loading' ? 'info' as const : 'warning' as const,
      };
  const authActions = authContract ? deriveAccountAuthActions(authContract) : [];
  const authContractState = authContract?.state ?? (props.secretStatus === 'loading' ? 'loading' : 'error');
  const subtitle = `${props.connection.providerType} · ${props.connection.defaultModel || '未设默认模型'}`;
  const lastTestAtMs = props.connection.lastTestAt
    ? Date.parse(props.connection.lastTestAt)
    : NaN;
  const lastTestMessage = accountLastTestMessageDisplay(props.connection.lastTestMessage);
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
      <div className="settingsAuthContract" data-state={authContractState}>
        <div className="settingsAuthContractText">
          <strong>{authPresentation.label}</strong>
          <span>{authPresentation.detail}</span>
        </div>
        <span className="settingsAuthContractBadge" data-tone={authPresentation.tone}>
          {authPresentation.stateLabel}
        </span>
      </div>
      {(Number.isFinite(lastTestAtMs) || lastTestMessage) && (
        <p className="settingsConnectionMeta">
          {lastTestMessage && <span>{lastTestMessage}</span>}
          {Number.isFinite(lastTestAtMs) && (
            <RelativeTime ts={lastTestAtMs} className="settingsConnectionMetaTime" />
          )}
        </p>
      )}
      {authActions.length > 0 && (
        <div className="settingsConnectionActions" role="group" aria-label={`${props.connection.name} 账号操作`}>
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
  const [infoError, setInfoError] = useState<string | null>(null);
  const [pendingDataAction, setPendingDataAction] = useState<string | null>(null);
  const pendingDataActionRef = useRef<string | null>(null);
  const dataPageMountedRef = useRef(false);
  const toast = useToast();

  useEffect(() => {
    let cancelled = false;
    dataPageMountedRef.current = true;
    void window.maka.app.info().then((next) => {
      if (!cancelled) {
        setInfo(next);
        setInfoError(null);
      }
    }).catch((error) => {
      if (cancelled) return;
      const message = settingsActionErrorMessage(error);
      setInfo(null);
      setInfoError(message);
      toast.error('载入数据目录失败', message);
    });
    return () => {
      cancelled = true;
      dataPageMountedRef.current = false;
      pendingDataActionRef.current = null;
    };
  }, [toast]);

  async function runDataAction(action: string, run: () => Promise<void>) {
    if (pendingDataActionRef.current) return;
    pendingDataActionRef.current = action;
    setPendingDataAction(action);
    try {
      await run();
    } finally {
      pendingDataActionRef.current = null;
      if (dataPageMountedRef.current) {
        setPendingDataAction(null);
      }
    }
  }

  const isDataActionPending = (action: string) => pendingDataAction === action;
  const dataActionDisabled = Boolean(pendingDataAction);

  async function openWorkspace() {
    if (!info) return;
    await runDataAction('workspace:open', async () => {
      try {
        const result = await window.maka.app.openPath('workspace');
        if (!dataPageMountedRef.current) return;
        if (!result.ok) {
          toast.error(`无法打开${openPathActionLabel('workspace')}`, openPathFailureCopy(result.reason));
        }
      } catch (error) {
        if (dataPageMountedRef.current) {
          toast.error(`无法打开${openPathActionLabel('workspace')}`, settingsActionErrorMessage(error));
        }
      }
    });
  }

  async function copyPath() {
    if (!info) return;
    await runDataAction('workspace:path:copy', async () => {
      try {
        await navigator.clipboard.writeText(info.workspacePath);
        if (dataPageMountedRef.current) {
          toast.success('已复制工作区路径');
        }
      } catch {
        if (dataPageMountedRef.current) {
          toast.error('复制失败', '剪贴板不可用或被系统拒绝。');
        }
      }
    });
  }

  return (
    <div className="settingsStructuredPage">
      <SettingsRows>
        <SettingRow
          title="工作区路径"
          detail="会话、设置、凭据和技能文件都存在这个目录下。"
          value={info?.workspacePath ?? (infoError ? '载入失败' : '正在加载…')}
        />
        <SettingRow
          title="存储引擎"
          detail="会话记录、外观与账号设置、本地使用统计，以及系统安全存储加密的模型密钥。"
          value="本地文件"
        />
      </SettingsRows>
      <div className="settingsActionRow" role="group" aria-label="工作区数据操作">
        <button
          type="button"
          className="maka-button"
          data-variant="primary"
          onClick={() => void openWorkspace()}
          disabled={!info || dataActionDisabled}
        >
          {isDataActionPending('workspace:open') ? '打开中…' : '打开工作区文件夹'}
        </button>
        <button
          type="button"
          className="maka-button"
          onClick={() => void copyPath()}
          disabled={!info || dataActionDisabled}
        >
          {isDataActionPending('workspace:path:copy') ? '复制中…' : '复制路径'}
        </button>
      </div>
      <div className="settingsNotice">
        本机数据保存在工作区。需要备份时先退出 Maka，再复制整个目录；恢复时替换同一路径后重启。
        模型密钥使用系统安全存储加密，跨设备恢复后需要重新测试连接。
      </div>
      {infoError && (
        <div className="settingsNotice" role="alert">
          无法载入工作区路径：{infoError}
        </div>
      )}
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
  const [uiLocale, setUiLocale] = useState<UiLocalePreference>(value.uiLocale);
  const toast = useToast();
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);
  const personalizationMountedRef = useRef(false);

  useEffect(() => {
    personalizationMountedRef.current = true;
    return () => {
      personalizationMountedRef.current = false;
      savingRef.current = false;
    };
  }, []);

  // PR-PERSONALIZATION-SYNC-0: sync form state when the persisted
  // personalization changes externally. Two real scenarios:
  //   1. Server-side sanitization (control chars, secret-shaped
  //      patterns) rewrites the input on save — local state would
  //      otherwise keep showing the raw typed value while the
  //      persisted store has the sanitized version.
  //   2. Another agent / background sync mutates settings while the
  //      panel is open.
  // The user's in-progress edits aren't blown away — this only
  // fires when the persisted reference identity actually changes.
  useEffect(() => {
    setDisplayName(value.displayName);
    setAssistantTone(value.assistantTone);
    setUiLocale(value.uiLocale);
  }, [value.displayName, value.assistantTone, value.uiLocale]);

  async function save() {
    if (savingRef.current) return;
    savingRef.current = true;
    setSaving(true);
    try {
      const result = await props.onUpdate({
        personalization: {
          displayName: displayName.trim().slice(0, 60),
          assistantTone: assistantTone.trim().slice(0, 500),
          uiLocale,
        },
      });
      if (!personalizationMountedRef.current) return;
      // PR-LANG-PREF-0: apply the chosen locale to <html> right
      // after save so the change takes effect immediately in the
      // current window. The persisted value also drives next-boot
      // detection (main.tsx applies it on settings load).
      applyUiLocale(uiLocale);
      // Single toast either way. With warnings, surface generic policy
      // statements (no raw user text echoed back, no specific keyword
      // disclosed) per kenji's personalization-prompt-contract.
      const warnings = collectPersonalizationWarningCopy(result.warnings?.personalization ?? []);
      if (warnings) {
        if (personalizationMountedRef.current) {
          toast.warning('已保存并做安全清理', warnings);
        }
      } else {
        if (personalizationMountedRef.current) {
          toast.success('个性化已保存');
        }
      }
    } catch (error) {
      if (personalizationMountedRef.current) {
        toast.error('保存失败', settingsActionErrorMessage(error));
      }
    } finally {
      savingRef.current = false;
      if (personalizationMountedRef.current) {
        setSaving(false);
      }
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
          disabled={saving}
          aria-label="显示名称"
        />
        <small>Maka 在聊天里会以这个名字称呼你。留空就用默认的「你」。</small>
      </label>

      {/*
        PR-LANG-PREF-0 (WAWQAQ msg `edc9cb41` + kenji `7e532892`
        acceptance criteria): 自动 / 中文 / English. User explicit
        choice wins over navigator.language; visual-smoke override
        wins over both (deterministic baselines).
      */}
      <div className="settingsField">
        <span>界面语言</span>
        <Segmented
          value={uiLocale}
          options={[
            ['auto', '跟随系统'],
            ['zh', '中文'],
            ['en', 'English'],
          ]}
          onChange={(next) => setUiLocale(next as UiLocalePreference)}
          ariaLabel="界面语言"
          disabled={saving}
        />
        <small>选择 Maka 界面的显示语言。保存后立即生效，重启后保持。</small>
      </div>

      <label className="settingsField">
        <span>助手语气偏好</span>
        <textarea
          value={assistantTone}
          onChange={(event) => setAssistantTone(event.currentTarget.value)}
          placeholder="一句话告诉助手期望的语气，比如：技术严谨 / 偏简洁 / 不要 emoji / 多反问。"
          rows={4}
          maxLength={500}
          spellCheck={false}
          disabled={saving}
          aria-label="助手语气偏好"
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
          aria-busy={saving}
          data-pending={saving ? 'true' : undefined}
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
  { value: 'compact', label: '紧凑', help: '减小行间距与控件高度，更接近专业编辑器风格。' },
  { value: 'comfortable', label: '舒适', help: '默认。平衡阅读和密度。' },
  { value: 'spacious', label: '宽松', help: '更大留白，适合长会话沉浸阅读。' },
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

// PR-THEME-PRODUCT-PALETTES-0: user-facing labels + short description
// for each palette. Kept inline (not in i18n strings) so the picker
// label and accessibility text live next to the palette token.
const PALETTE_LABEL: Record<ThemePalette, string> = {
  'default': '默认',
  'onedark': 'One Dark',
  'catppuccin-mocha': 'Catppuccin Mocha',
  'tokyo-night': 'Tokyo Night',
  'nord': 'Nord',
  'coral': '珊瑚',
  'azure': '湖蓝',
  'forest': '森林',
  'dusk': '暮光',
  'sand': '沙金',
  'mono': '极简灰',
};

const PALETTE_HELP: Record<ThemePalette, string> = {
  'default': 'Maka 原本的紫色强调色',
  'onedark': '编辑器经典深色',
  'catppuccin-mocha': '紫调柔和深色',
  'tokyo-night': '深蓝主题',
  'nord': '北欧冷色',
  'coral': '暖粉 / 珊瑚强调色',
  'azure': '湖蓝强调色，干净冷静',
  'forest': '深苔绿 + 暖蜂蜜强调色，自然感',
  'dusk': '深紫罗兰 + 冷调画布，黄昏感',
  'sand': '琥珀沙金 + 暖奶白，复古暖调',
  'mono': '纯灰阶，无彩色干扰',
};

/**
 * PR-PALETTE-PICKER-GROUPS-0: 11 palettes need grouping so the
 * picker scans cleanly. `default` + the 4 community editor themes
 * land in 编辑器主题; the 6 color-family product accents land in
 * 产品色调. Order within each group is preserved for stable
 * keyboard navigation.
 */
const PALETTE_GROUPS: ReadonlyArray<{ id: string; label: string; palettes: ReadonlyArray<ThemePalette> }> = [
  { id: 'editor', label: '编辑器主题', palettes: ['default', 'onedark', 'catppuccin-mocha', 'tokyo-night', 'nord'] },
  { id: 'product', label: '产品色调', palettes: ['coral', 'azure', 'forest', 'dusk', 'sand', 'mono'] },
];

function ThemeSettingsPage(props: {
  themePref: ThemePreference;
  density: UiDensity;
  themePalette: ThemePalette;
  settings: AppSettings;
  onUpdate(patch: Parameters<typeof window.maka.settings.update>[0]): Promise<UpdateAppSettingsResult>;
  onThemeChange(pref: ThemePreference): void;
  onDensityChange(density: UiDensity): void;
  onThemePaletteChange(palette: ThemePalette): void;
}) {
  const toast = useToast();
  const themePageMountedRef = useRef(false);
  const themePersistTicketRef = useRef(0);

  useEffect(() => {
    themePageMountedRef.current = true;
    return () => {
      themePageMountedRef.current = false;
      themePersistTicketRef.current += 1;
    };
  }, []);

  async function persistAppearance(patch: NonNullable<Parameters<typeof window.maka.settings.update>[0]['appearance']>) {
    const ticket = ++themePersistTicketRef.current;
    try {
      await props.onUpdate({ appearance: patch });
    } catch (error) {
      if (themePageMountedRef.current && ticket === themePersistTicketRef.current) {
        toast.error('保存外观设置失败', settingsActionErrorMessage(error));
      }
    }
  }

  async function setTheme(next: ThemePreference) {
    // Apply immediately for instant feedback, then persist. If persistence
    // fails the visual stays — the next app start will re-read whatever
    // landed on disk.
    props.onThemeChange(next);
    await persistAppearance({ theme: next });
  }

  async function setDensity(next: UiDensity) {
    props.onDensityChange(next);
    await persistAppearance({ density: next });
  }

  // PR-THEME-PRODUCT-PALETTES-0 (WAWQAQ msg `4472ee95`) + PR-THEME-APPLY-
  // AND-DONE-POLISH-0 (WAWQAQ msg `dec85e5b`): apply the palette
  // synchronously on click for instant feedback, then persist. Same
  // pattern as setTheme/setDensity above. The original comment claimed
  // the IPC round-trip would re-apply on its own, but main.tsx had no
  // listener for palette changes — only ran applyThemePalette once at
  // mount — so switches were invisible until the next app start.
  const currentPalette: ThemePalette = props.themePalette;
  async function setPalette(next: ThemePalette) {
    props.onThemePaletteChange(next);
    await persistAppearance({ palette: next });
  }

  return (
    <div className="settingsStructuredPage">
      <h3 className="settingsSubheading">主题</h3>
      <div
        className="settingsThemeOptions settingsThemeOptionsPreview"
        role="radiogroup"
        aria-label="主题"
        onKeyDown={(event) => onSettingsRadioGroupKeyDown(
          event,
          THEME_OPTIONS.map((option) => option.value),
          props.themePref,
          (next) => void setTheme(next),
        )}
      >
        {THEME_OPTIONS.map((option) => (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={props.themePref === option.value}
            data-active={props.themePref === option.value}
            data-radio-value={option.value}
            tabIndex={radioTabIndex(option.value, props.themePref, THEME_OPTIONS.map((item) => item.value))}
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

      <h3 className="settingsSubheading">调色板</h3>
      {/* PR-PALETTE-PICKER-GROUPS-0: 11 palettes in a flat grid is
          cramped. Split into 编辑器主题 (default + 4 community editor
          themes) and 产品色调 (6 product accents) so the picker is
          easier to scan. Each subgroup is its own radiogroup so
          arrow-key navigation stays scoped. */}
      {PALETTE_GROUPS.map((group) => (
        <div key={group.id} className="settingsPaletteGroup">
          <h4 className="settingsPaletteGroupHeading">{group.label}</h4>
          <div
            className="settingsThemeOptions settingsPaletteOptions"
            role="radiogroup"
            aria-label={group.label}
            onKeyDown={(event) => onSettingsRadioGroupKeyDown(
              event,
              group.palettes,
              currentPalette,
              (next) => void setPalette(next),
            )}
          >
            {group.palettes.map((palette) => (
              <button
                key={palette}
                type="button"
                role="radio"
                aria-checked={currentPalette === palette}
                data-active={currentPalette === palette}
                data-palette={palette}
                data-radio-value={palette}
                tabIndex={radioTabIndex(palette, currentPalette, group.palettes)}
                className="settingsThemeOption settingsPaletteOption"
                onClick={() => void setPalette(palette)}
              >
                <span className={`settingsPaletteSwatch settingsPaletteSwatch-${palette}`} aria-hidden="true" />
                <span className="settingsThemeLabel">
                  <strong>{PALETTE_LABEL[palette]}</strong>
                  <small>{PALETTE_HELP[palette]}</small>
                </span>
              </button>
            ))}
          </div>
        </div>
      ))}

      <h3 className="settingsSubheading">界面密度</h3>
      <div
        className="settingsThemeOptions settingsDensityOptions"
        role="radiogroup"
        aria-label="界面密度"
        onKeyDown={(event) => onSettingsRadioGroupKeyDown(
          event,
          DENSITY_OPTIONS.map((option) => option.value),
          props.density,
          (next) => void setDensity(next),
        )}
      >
        {DENSITY_OPTIONS.map((option) => (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={props.density === option.value}
            data-active={props.density === option.value}
            data-radio-value={option.value}
            tabIndex={radioTabIndex(option.value, props.density, DENSITY_OPTIONS.map((item) => item.value))}
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
        切换会立即生效，并保存在本地外观设置里下次启动延续。通知统一显示在屏幕右下角。
      </p>
    </div>
  );
}

/**
 * PR-WEB-SEARCH-TAVILY-0: Settings → 联网搜索.
 *
 * Current provider support is Tavily only. Renderer never sees the cleartext API
 * key — `props.settings.webSearch.providers.tavily.apiKey` arrives
 * pre-masked from the IPC store boundary (the bullet sentinel
 * `MASKED_TOKEN_SENTINEL`). Re-submitting the sentinel is treated as
 * "keep current" in `mergeWebSearchSettings`.
 *
 * The "测试" button calls `web-search:test` (main-process Tavily call)
 * and surfaces ok/fail via toast. The live-query verifier runs a real query
 * and renders 3-5 plain-text rows.
 */
function WebSearchSettingsPage(props: {
  settings: AppSettings;
  onUpdate(patch: Parameters<typeof window.maka.settings.update>[0]): Promise<UpdateAppSettingsResult>;
}) {
  const webSearch = props.settings.webSearch;
  const tavily = webSearch.providers.tavily;
  const tavilyKey = tavily.apiKey;
  const credentialSource = tavily.credentialSource;
  const usingEnvKey = credentialSource === 'env';
  const [draftKey, setDraftKey] = useState('');
  const [pendingCredentialAction, setPendingCredentialAction] = useState<'save' | 'clear' | null>(null);
  const [testing, setTesting] = useState(false);
  const [liveQuery, setLiveQuery] = useState('');
  const [liveQueryRunning, setLiveQueryRunning] = useState(false);
  const [liveQueryResults, setLiveQueryResults] = useState<readonly { title: string; url: string; snippet: string; source: string }[] | null>(null);
  const [liveQueryError, setLiveQueryError] = useState<string | null>(null);
  const webSearchMountedRef = useRef(true);
  const pendingCredentialActionRef = useRef<'save' | 'clear' | null>(null);
  const testingRef = useRef(false);
  const liveQueryRunningRef = useRef(false);
  const toast = useToast();

  useEffect(() => {
    webSearchMountedRef.current = true;
    return () => {
      webSearchMountedRef.current = false;
      pendingCredentialActionRef.current = null;
      testingRef.current = false;
      liveQueryRunningRef.current = false;
    };
  }, []);

  async function runCredentialAction(action: 'save' | 'clear', run: () => Promise<void>) {
    if (pendingCredentialActionRef.current !== null || testingRef.current) return;
    pendingCredentialActionRef.current = action;
    setPendingCredentialAction(action);
    try {
      await run();
    } finally {
      pendingCredentialActionRef.current = null;
      if (webSearchMountedRef.current) {
        setPendingCredentialAction(null);
      }
    }
  }

  async function updateWebSearch(
    patch: NonNullable<Parameters<typeof window.maka.settings.update>[0]['webSearch']>,
    failureTitle = '保存联网搜索设置失败',
  ): Promise<boolean> {
    try {
      await props.onUpdate({ webSearch: patch });
      return true;
    } catch (error) {
      if (webSearchMountedRef.current) {
        toast.error(failureTitle, settingsActionErrorMessage(error));
      }
      return false;
    }
  }

  async function setEnabled(enabled: boolean) {
    await updateWebSearch({ enabled });
  }

  async function persistCredentialStatus(status: WebSearchCredentialStatus, credentialVersion: number): Promise<boolean> {
    return updateWebSearch(
      {
        providers: {
          tavily: {
            credentialVersion,
            credentialStatus: status,
            credentialCheckedAt: new Date().toISOString(),
          },
        },
      },
      '保存联网搜索状态失败',
    );
  }

  async function saveDraftKey() {
    if (usingEnvKey || draftKey.length === 0) return;
    await runCredentialAction('save', async () => {
      const saved = await updateWebSearch({ providers: { tavily: { apiKey: draftKey } } });
      if (!saved) return;
      if (!webSearchMountedRef.current) return;
      setDraftKey('');
      toast.success('已保存 Tavily 密钥', '可点击「测试」做一次真实请求验证。');
    });
  }

  async function clearKey() {
    await runCredentialAction('clear', async () => {
      const saved = await updateWebSearch({ enabled: false, providers: { tavily: { apiKey: '' } } });
      if (!saved) return;
      if (!webSearchMountedRef.current) return;
      setDraftKey('');
      toast.success('已清空 Tavily 凭据', '联网搜索已自动关闭。');
    });
  }

  async function runTest() {
    if (testingRef.current || pendingCredentialActionRef.current !== null) return;
    testingRef.current = true;
    setTesting(true);
    const usesDraftKey = draftKey.trim().length > 0;
    const testedCredentialVersion = tavily.credentialVersion;
    try {
      const result = await window.maka.webSearch.test({
        provider: 'tavily',
        apiKey: usesDraftKey ? draftKey : undefined,
      });
      if (!webSearchMountedRef.current) return;
      if (!usesDraftKey && hasUsableKey) {
        void persistCredentialStatus(webSearchCredentialStatusFromResponse(result), testedCredentialVersion);
      }
      if (result.ok) {
        toast.success('Tavily 凭据可用', `返回 ${result.results.length} 条结果。`);
      } else {
        toast.error('Tavily 测试失败', result.message);
      }
    } catch (err) {
      if (webSearchMountedRef.current) {
        toast.error('Tavily 测试出错', settingsActionErrorMessage(err));
      }
    } finally {
      testingRef.current = false;
      if (webSearchMountedRef.current) {
        setTesting(false);
      }
    }
  }

  async function runLiveQuery() {
    if (liveQueryRunningRef.current) return;
    const trimmed = liveQuery.trim();
    if (trimmed.length === 0) return;
    liveQueryRunningRef.current = true;
    setLiveQueryRunning(true);
    setLiveQueryError(null);
    setLiveQueryResults(null);
    const queriedCredentialVersion = tavily.credentialVersion;
    try {
      const result = await window.maka.webSearch.query({
        provider: 'tavily',
        query: trimmed,
        limit: 5,
      });
      if (!webSearchMountedRef.current) return;
      if (result.ok) {
        setLiveQueryResults(result.results);
        if (hasUsableKey) {
          void persistCredentialStatus('valid', queriedCredentialVersion);
        }
      } else {
        setLiveQueryError(result.message);
        if (hasUsableKey) {
          void persistCredentialStatus(webSearchCredentialStatusFromResponse(result), queriedCredentialVersion);
        }
      }
    } catch (err) {
      if (webSearchMountedRef.current) {
        setLiveQueryError(settingsActionErrorMessage(err));
      }
    } finally {
      liveQueryRunningRef.current = false;
      if (webSearchMountedRef.current) {
        setLiveQueryRunning(false);
      }
    }
  }

  const hasStoredKey = tavilyKey.length > 0;
  const hasUsableKey = hasStoredKey || usingEnvKey;
  const statusCopy = presentWebSearchCredentialStatus(
    credentialSource,
    webSearch.enabled,
    tavily.credentialStatus,
  );
  const queryDisabledReason = webSearchQueryDisabledReason({
    hasUsableKey,
    enabled: webSearch.enabled,
    query: liveQuery,
  });
  const checkedAtMs = tavily.credentialCheckedAt
    ? Date.parse(tavily.credentialCheckedAt)
    : Number.NaN;
  const hasCheckedAt = Number.isFinite(checkedAtMs);
  const credentialActionBusy = pendingCredentialAction !== null || testing;

  return (
    <div className="settingsStructuredPage">
      <div className="settingsFormRow">
        <div>
          <strong>启用联网搜索</strong>
          <small>开关启用后，界面里显式触发的查询才会真的请求 Tavily。模型不会自动调用。</small>
        </div>
        <div className="settingsWebSearchStatusCluster" role="group" aria-label="联网搜索凭据状态">
          <span className="settingsConnectionBadge" data-tone={statusCopy.tone}>
            {statusCopy.label}
          </span>
          {hasCheckedAt && (
            <small>
              最近测试 <RelativeTime ts={checkedAtMs} />
            </small>
          )}
          <small>{presentWebSearchCredentialSource(credentialSource, hasStoredKey)}</small>
        </div>
        <Switch
          ariaLabel="启用联网搜索"
          checked={webSearch.enabled}
          disabled={!hasUsableKey}
          onChange={(enabled) => void setEnabled(enabled)}
        />
      </div>

      <div className="settingsFormGrid">
        <label>
          <span>Tavily 密钥</span>
          <PasswordInput
            value={draftKey}
            onChange={setDraftKey}
            disabled={usingEnvKey || credentialActionBusy}
            placeholder={usingEnvKey ? '由环境变量提供' : hasStoredKey ? '已保存（输入新密钥可替换）' : 'tvly-xxxxxxxx'}
            ariaLabel="Tavily 密钥"
          />
          <small>
            {usingEnvKey
              ? '当前使用环境变量 TAVILY_API_KEY / MAKA_TAVILY_API_KEY；如需改用保存的密钥，请移除环境变量后重启。'
              : <>保存在主进程设置中，渲染器永远看不到明文。在 <a href="https://tavily.com" target="_blank" rel="noreferrer">tavily.com</a> 申请。</>}
          </small>
        </label>
      </div>

      <div className="settingsFormRow" style={{ gap: 8, flexWrap: 'wrap' }}>
        <button
          type="button"
          className="maka-button"
          disabled={credentialActionBusy || usingEnvKey || draftKey.length === 0}
          onClick={() => void saveDraftKey()}
        >
          {pendingCredentialAction === 'save' ? '保存中…' : '保存密钥'}
        </button>
        <button
          type="button"
          className="maka-button maka-button-ghost"
          disabled={credentialActionBusy || (draftKey.length === 0 && !hasUsableKey)}
          onClick={() => void runTest()}
        >
          {testing ? '测试中…' : '测试凭据'}
        </button>
        {hasStoredKey && (
          <button
            type="button"
            className="maka-button maka-button-ghost"
            disabled={credentialActionBusy}
            onClick={() => void clearKey()}
          >
            {pendingCredentialAction === 'clear' ? '清空中…' : '清空密钥'}
          </button>
        )}
      </div>

      <div className="settingsFormRow">
        <div style={{ flex: 1 }}>
          <strong>真实查询验证</strong>
          <small>直接发一条真实查询，看到 Tavily 返回的标题 / 摘要 / 来源域名。结果只显示在此页面，不写入会话也不写入遥测。</small>
        </div>
      </div>
      <div className="settingsFormGrid">
        <label>
          <span>查询</span>
          <input
            value={liveQuery}
            onChange={(event) => setLiveQuery(event.currentTarget.value)}
            placeholder="例如：本周 AI 产品发布动态"
            aria-label="联网搜索真实查询"
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !liveQueryRunning) {
                event.preventDefault();
                void runLiveQuery();
              }
            }}
          />
        </label>
      </div>
      <div>
        <button
          type="button"
          className="maka-button"
          disabled={liveQueryRunning || queryDisabledReason !== null}
          onClick={() => void runLiveQuery()}
        >
          {liveQueryRunning ? '搜索中…' : '搜索'}
        </button>
        {!liveQueryRunning && queryDisabledReason && (
          <small style={{ marginLeft: 12, color: 'var(--foreground-50)' }}>
            {queryDisabledReason}
          </small>
        )}
      </div>

      {liveQueryError && (
        <div className="settingsConnectionMeta" role="alert">
          <span>查询失败：{liveQueryError}</span>
        </div>
      )}
      {(() => {
        // PR-SETTINGS-WEB-SEARCH-URL-HARDEN-0: match the chat-side
        // WebSearchPreview hardening (xuan `e511aa5`): the renderer
        // does NOT trust raw URLs / text coming back over IPC even
        // though the main-process Tavily client filters first. Drop
        // non-http(s) / malformed rows and redact every text cell
        // before it reaches the DOM.
        const safeRows: ReadonlyArray<{ title: string; url: string; source: string; snippet: string }> | null =
          liveQueryResults
            ? liveQueryResults
                .map((row) => {
                  const normalized = normalizeSearchUrl(row.url);
                  if (!normalized.ok) return null;
                  return {
                    title: redactSecrets(row.title),
                    url: redactSecrets(normalized.value),
                    source: redactSecrets(row.source),
                    snippet: redactSecrets(row.snippet),
                  };
                })
                .filter(
                  (
                    row,
                  ): row is { title: string; url: string; source: string; snippet: string } =>
                    row !== null,
                )
            : null;
        if (safeRows && safeRows.length === 0 && !liveQueryError) {
          return <div className="settingsConnectionMeta">没有结果。</div>;
        }
        if (safeRows && safeRows.length > 0) {
          return (
            <ul className="settingsWebSearchResults" aria-label="联网搜索真实查询结果">
              {safeRows.map((row, idx) => (
                <li key={`${row.url}-${idx}`} className="settingsWebSearchResult">
                  <a href={row.url} target="_blank" rel="noreferrer">{row.title}</a>
                  <small>{row.source}</small>
                  <p>{row.snippet}</p>
                </li>
              ))}
            </ul>
          );
        }
        return null;
      })()}
    </div>
  );
}

function webSearchQueryDisabledReason(input: { hasUsableKey: boolean; enabled: boolean; query: string }): string | null {
  if (!input.hasUsableKey) return '先保存 Tavily 密钥，或设置 TAVILY_API_KEY 环境变量';
  if (!input.enabled) return '先启用联网搜索';
  if (input.query.trim().length === 0) return '输入查询后再搜索';
  return null;
}

function presentWebSearchCredentialStatus(
  credentialSource: AppSettings['webSearch']['providers']['tavily']['credentialSource'],
  enabled: boolean,
  status: WebSearchCredentialStatus,
): { label: string; tone: 'success' | 'info' | 'warning' | 'destructive' } {
  if (credentialSource === 'none') return { label: '等待保存密钥', tone: 'warning' };
  if (status === 'valid') {
    return enabled
      ? { label: '已验证 · 已启用', tone: 'success' }
      : { label: '已验证 · 未启用', tone: 'info' };
  }
  if (status === 'invalid_credentials') return { label: '密钥无效', tone: 'destructive' };
  if (status === 'rate_limited') return { label: 'Tavily 限流', tone: 'warning' };
  if (status === 'timeout') return { label: '测试超时', tone: 'warning' };
  if (status === 'network_error') return { label: '网络异常', tone: 'warning' };
  if (status === 'not_configured') return { label: '等待配置', tone: 'warning' };
  return enabled
    ? { label: '未测试 · 已启用', tone: 'warning' }
    : { label: '未测试', tone: 'info' };
}

function presentWebSearchCredentialSource(
  credentialSource: AppSettings['webSearch']['providers']['tavily']['credentialSource'],
  hasStoredKey: boolean,
): string {
  if (credentialSource === 'env') {
    return hasStoredKey ? '来源：环境变量（已保存密钥备用）' : '来源：环境变量';
  }
  if (credentialSource === 'saved') return '来源：本机已保存密钥';
  return '来源：未配置';
}

function MemorySettingsPage(props: {
  settings: AppSettings;
  onUpdate(patch: Parameters<typeof window.maka.settings.update>[0]): Promise<UpdateAppSettingsResult>;
  onReloadSettings(): Promise<void>;
}) {
  type MemoryWriteAction =
    | 'reload'
    | 'enable'
    | 'agent-read'
    | 'workspace-instructions'
    | 'save'
    | 'reset'
    | 'restore'
    | 'entry-status'
    | 'instruction-create';

  const [state, setState] = useState<LocalMemoryState | null>(null);
  const [workspaceInstructionState, setWorkspaceInstructionState] = useState<Awaited<
    ReturnType<typeof window.maka.workspaceInstructions.getState>
  > | null>(null);
  const [draft, setDraft] = useState('');
  const [newMemoryTitle, setNewMemoryTitle] = useState('');
  const [newMemoryTags, setNewMemoryTags] = useState('');
  const [newMemoryContent, setNewMemoryContent] = useState('');
  const [memoryEntryQuery, setMemoryEntryQuery] = useState('');
  const [lastSaveSummary, setLastSaveSummary] = useState<{ title: string; detail: string; savedAt: number } | null>(null);
  const [loadingMemory, setLoadingMemory] = useState(true);
  const [busy, setBusy] = useState(false);
  const [pendingMemoryWriteAction, setPendingMemoryWriteAction] = useState<MemoryWriteAction | null>(null);
  const [pendingMemoryActions, setPendingMemoryActions] = useState<Set<string>>(() => new Set());
  const editorRef = useRef<HTMLTextAreaElement | null>(null);
  const memoryWriteBusyRef = useRef(false);
  const pendingMemoryActionKeysRef = useRef<Set<string>>(new Set());
  const memoryPageMountedRef = useRef(false);
  const memoryPageLifecycleRef = useRef(0);
  const memoryReloadTicketRef = useRef(0);
  const toast = useToast();

  useEffect(() => {
    memoryPageLifecycleRef.current += 1;
    memoryPageMountedRef.current = true;
    const lifecycle = memoryPageLifecycleRef.current;
    return () => {
      if (memoryPageLifecycleRef.current !== lifecycle) return;
      memoryPageMountedRef.current = false;
      memoryReloadTicketRef.current += 1;
      memoryWriteBusyRef.current = false;
      pendingMemoryActionKeysRef.current.clear();
    };
  }, []);

  function isMemoryPageCurrent(lifecycle: number): boolean {
    return memoryPageMountedRef.current && memoryPageLifecycleRef.current === lifecycle;
  }

  async function runMemoryWriteAction<T>(
    action: MemoryWriteAction,
    run: (isCurrent: () => boolean) => Promise<T>,
  ): Promise<T | undefined> {
    if (memoryWriteBusyRef.current) return undefined;
    const lifecycle = memoryPageLifecycleRef.current;
    memoryWriteBusyRef.current = true;
    setPendingMemoryWriteAction(action);
    setBusy(true);
    try {
      return await run(() => isMemoryPageCurrent(lifecycle));
    } catch (error) {
      if (!isMemoryPageCurrent(lifecycle)) return undefined;
      throw error;
    } finally {
      memoryWriteBusyRef.current = false;
      if (isMemoryPageCurrent(lifecycle)) {
        setPendingMemoryWriteAction(null);
        setBusy(false);
      }
    }
  }

  async function runMemoryAction<T>(
    key: string,
    action: (isCurrent: () => boolean) => Promise<T>,
  ): Promise<T | undefined> {
    if (pendingMemoryActionKeysRef.current.has(key)) return undefined;
    const lifecycle = memoryPageLifecycleRef.current;
    pendingMemoryActionKeysRef.current.add(key);
    setPendingMemoryActions((current) => new Set(current).add(key));
    try {
      return await action(() => isMemoryPageCurrent(lifecycle));
    } catch (error) {
      if (!isMemoryPageCurrent(lifecycle)) return undefined;
      throw error;
    } finally {
      pendingMemoryActionKeysRef.current.delete(key);
      if (isMemoryPageCurrent(lifecycle)) {
        setPendingMemoryActions((current) => {
          const next = new Set(current);
          next.delete(key);
          return next;
        });
      }
    }
  }

  async function reload(): Promise<boolean> {
    const lifecycle = memoryPageLifecycleRef.current;
    const ticket = ++memoryReloadTicketRef.current;
    try {
      const [next, instructions] = await Promise.all([
        window.maka.memory.getState(),
        window.maka.workspaceInstructions.getState(),
      ]);
      if (!isMemoryPageCurrent(lifecycle) || ticket !== memoryReloadTicketRef.current) return false;
      setState(next);
      setWorkspaceInstructionState(instructions);
      setDraft(next.content);
      setLastSaveSummary(null);
      return true;
    } catch (error) {
      if (isMemoryPageCurrent(lifecycle) && ticket === memoryReloadTicketRef.current) {
        toast.error('载入本地记忆失败', settingsActionErrorMessage(error));
      }
      return false;
    } finally {
      if (isMemoryPageCurrent(lifecycle) && ticket === memoryReloadTicketRef.current) {
        setLoadingMemory(false);
      }
    }
  }

  async function reloadDraftFromDisk() {
    await runMemoryWriteAction('reload', async (isCurrent) => {
      const ok = await reload();
      if (ok && isCurrent()) toast.success('已重新载入 MEMORY.md', '未保存的草稿修改已丢弃。');
    });
  }

  useEffect(() => {
    void reload();
  }, []);

  async function setEnabled(enabled: boolean) {
    try {
      await runMemoryWriteAction('enable', async (isCurrent) => {
        const next = await window.maka.memory.setEnabled(enabled);
        await props.onReloadSettings();
        if (!isCurrent()) return;
        setState(next);
        setDraft(next.content);
      });
    } catch (error) {
      toast.error('更新本地记忆开关失败', settingsActionErrorMessage(error));
    }
  }

  async function setAgentReadEnabled(agentReadEnabled: boolean) {
    try {
      await runMemoryWriteAction('agent-read', async (isCurrent) => {
        const next = await window.maka.memory.setAgentReadEnabled(agentReadEnabled);
        await props.onReloadSettings();
        if (!isCurrent()) return;
        setState(next);
        setDraft(next.content);
      });
    } catch (error) {
      toast.error('更新模型读取权限失败', settingsActionErrorMessage(error));
    }
  }

  async function setWorkspaceInstructionsEnabled(enabled: boolean) {
    try {
      await runMemoryWriteAction('workspace-instructions', async () => {
        await props.onUpdate({ workspaceInstructions: { enabled } });
        await props.onReloadSettings();
      });
    } catch (error) {
      toast.error('更新项目指令开关失败', settingsActionErrorMessage(error));
    }
  }

  async function save() {
    try {
      await runMemoryWriteAction('save', async (isCurrent) => {
        const next = await window.maka.memory.save(draft);
        if (!isCurrent()) return;
        const redacted = next.content !== draft;
        setState(next);
        setDraft(next.content);
        if (next.status === 'safe_mode') {
          setLastSaveSummary(null);
          toast.error('保存被拦截', 'MEMORY.md 内容过大，已进入安全模式。');
        } else if (redacted) {
          const detail = `写入前已替换疑似 token、API key 或密码；${formatLocalMemorySaveSummary(next)}`;
          setLastSaveSummary({ title: '已保存并遮蔽敏感字段', detail, savedAt: Date.now() });
          toast.success('已保存并遮蔽敏感字段', detail);
        } else {
          const detail = formatLocalMemorySaveSummary(next);
          setLastSaveSummary({ title: '已保存 MEMORY.md', detail, savedAt: Date.now() });
          toast.success('已保存 MEMORY.md', detail);
        }
      });
    } catch (error) {
      toast.error('保存 MEMORY.md 失败', settingsActionErrorMessage(error));
    }
  }

  async function reset() {
    try {
      await runMemoryWriteAction('reset', async (isCurrent) => {
        const next = await window.maka.memory.reset();
        if (!isCurrent()) return;
        setState(next);
        setDraft(next.content);
        setLastSaveSummary(null);
        toast.success('已重置 MEMORY.md', '上一版已保存为备份文件。');
      });
    } catch (error) {
      toast.error('重置 MEMORY.md 失败', settingsActionErrorMessage(error));
    }
  }

  async function restoreLatestBackup() {
    await runMemoryAction('backup:latest:restore', async () => {
      try {
        await runMemoryWriteAction('restore', async (isCurrent) => {
          const backup = state?.latestBackup;
          if (!backup) {
            toast.error('没有可恢复备份', '保存或重置 MEMORY.md 后才会生成上一版备份。');
            return;
          }
          const backupLabel = `${localMemoryBackupKindLabel(backup.kind)} · ${localMemoryBackupSummary(backup)} · ${new Date(backup.updatedAt).toLocaleString()}`;
          const ok = await toast.confirm({
            title: '恢复上一版 MEMORY.md？',
            description: `会先备份当前 MEMORY.md，再用最近一次备份覆盖当前文件。将恢复：${backupLabel}`,
            confirmLabel: '恢复',
            cancelLabel: '取消',
            destructive: true,
          });
          if (!ok) return;
          if (!isCurrent()) return;
          const result = await window.maka.memory.restoreLatestBackup();
          if (!isCurrent()) return;
          setState(result.state);
          setDraft(result.state.content);
          setLastSaveSummary(null);
          if (result.ok) {
            toast.success('已恢复上一版 MEMORY.md', `${backupLabel}；恢复前的当前文件已保存为 restore.bak。`);
          } else {
            toast.error('恢复失败', result.message);
          }
        });
      } catch (error) {
        toast.error('恢复上一版失败', settingsActionErrorMessage(error));
      }
    });
  }

  async function restoreBackupCandidate(backup: NonNullable<LocalMemoryState['latestBackup']>) {
    await runMemoryAction(`backup:${backup.kind}:restore`, async () => {
      try {
        await runMemoryWriteAction('restore', async (isCurrent) => {
          const backupLabel = `${localMemoryBackupKindLabel(backup.kind)} · ${localMemoryBackupSummary(backup)} · ${new Date(backup.updatedAt).toLocaleString()}`;
          const ok = await toast.confirm({
            title: '恢复这个 MEMORY.md 备份？',
            description: `会先备份当前 MEMORY.md，再用选中的备份覆盖当前文件。将恢复：${backupLabel}`,
            confirmLabel: '恢复',
            cancelLabel: '取消',
            destructive: true,
          });
          if (!ok) return;
          if (!isCurrent()) return;
          const result = await window.maka.memory.restoreBackup(backup.kind);
          if (!isCurrent()) return;
          setState(result.state);
          setDraft(result.state.content);
          setLastSaveSummary(null);
          if (result.ok) {
            toast.success('已恢复 MEMORY.md 备份候选', `${backupLabel}；恢复前的当前文件已保存为 restore.bak。`);
          } else {
            toast.error('恢复失败', result.message);
          }
        });
      } catch (error) {
        toast.error('恢复备份失败', settingsActionErrorMessage(error));
      }
    });
  }

  async function openFile() {
    await runMemoryAction('memory:file:open', async (isCurrent) => {
      try {
        const result = await window.maka.memory.openFile();
        if (!isCurrent()) return;
        if (!result.ok) toast.error('打开失败', result.message);
      } catch (error) {
        if (isCurrent()) toast.error('打开失败', settingsActionErrorMessage(error));
      }
    });
  }

  async function openLatestBackup() {
    await runMemoryAction('backup:latest:open', async (isCurrent) => {
      try {
        const result = await window.maka.memory.openLatestBackup();
        if (!isCurrent()) return;
        if (!result.ok) toast.error('打开上一版失败', result.message);
      } catch (error) {
        if (isCurrent()) toast.error('打开上一版失败', settingsActionErrorMessage(error));
      }
    });
  }

  async function openBackupCandidate(backup: NonNullable<LocalMemoryState['latestBackup']>) {
    await runMemoryAction(`backup:${backup.kind}:open`, async (isCurrent) => {
      try {
        const result = await window.maka.memory.openBackup(backup.kind);
        if (!isCurrent()) return;
        if (!result.ok) {
          toast.error(`打开${localMemoryBackupKindLabel(backup.kind)}失败`, result.message);
        }
      } catch (error) {
        if (isCurrent()) toast.error(`打开${localMemoryBackupKindLabel(backup.kind)}失败`, settingsActionErrorMessage(error));
      }
    });
  }

  async function openFolder() {
    await runMemoryAction('memory:folder:open', async (isCurrent) => {
      try {
        const result = await window.maka.app.openPath('memory');
        if (!isCurrent()) return;
        if (!result.ok) {
          toast.error(`打开${openPathActionLabel('memory')}失败`, openPathFailureCopy(result.reason));
        }
      } catch (error) {
        if (isCurrent()) toast.error(`打开${openPathActionLabel('memory')}失败`, settingsActionErrorMessage(error));
      }
    });
  }

  async function openWorkspaceInstructionFile(file: string) {
    await runMemoryAction(`instruction:${file}:open`, async (isCurrent) => {
      try {
        const result = await window.maka.workspaceInstructions.openFile(file);
        if (!isCurrent()) return;
        if (!result.ok) {
          toast.error('打开项目指令失败', result.message);
        }
      } catch (error) {
        if (isCurrent()) toast.error('打开项目指令失败', settingsActionErrorMessage(error));
      }
    });
  }

  async function createWorkspaceInstructionFile(file: string) {
    await runMemoryAction(`instruction:${file}:create`, async (isActionCurrent) => {
      try {
        await runMemoryWriteAction('instruction-create', async (isCurrent) => {
          const result = await window.maka.workspaceInstructions.createFile(file);
          if (!isCurrent()) return;
          if (!result.ok) {
            toast.error('创建项目指令失败', result.message);
            return;
          }
          const instructions = await window.maka.workspaceInstructions.getState();
          if (!isCurrent()) return;
          setWorkspaceInstructionState(instructions);
          toast.success('已创建项目指令', file);
          await openWorkspaceInstructionFile(file);
        });
      } catch (error) {
        if (isActionCurrent()) toast.error('创建项目指令失败', settingsActionErrorMessage(error));
      }
    });
  }

  async function copyPath() {
    await runMemoryAction('memory:path:copy', async (isCurrent) => {
      if (!state?.path) return;
      try {
        await navigator.clipboard.writeText(state.path);
        if (isCurrent()) toast.success('已复制路径', state.path);
      } catch {
        if (isCurrent()) toast.error('复制失败', '剪贴板不可用或被系统拒绝。');
      }
    });
  }

  async function copyBackupReference(backup: NonNullable<LocalMemoryState['latestBackup']>) {
    await runMemoryAction(`backup:${backup.kind}:copy`, async (isCurrent) => {
      const reference = [
        `Memory backup: ${localMemoryBackupKindLabel(backup.kind)}`,
        `Path: ${backup.path}`,
        `Updated: ${new Date(backup.updatedAt).toISOString()}`,
        `Entries: ${localMemoryBackupSummary(backup)}`,
        `Size: ${backup.sizeBytes} bytes`,
        backup.safeMode ? `Safe mode: ${backup.reason ?? 'oversize'}` : 'Safe mode: false',
      ].join('\n');
      try {
        await navigator.clipboard.writeText(reference);
        if (isCurrent()) toast.success('已复制上一版引用', localMemoryBackupSummary(backup));
      } catch {
        if (isCurrent()) toast.error('复制失败', '剪贴板不可用或被系统拒绝。');
      }
    });
  }

  async function copyLatestBackupReference() {
    const backup = state?.latestBackup;
    if (!backup) return;
    await copyBackupReference(backup);
  }

  async function copyMemoryEntryReference(entry: LocalMemoryState['entries'][number]) {
    await runMemoryAction(`entry:${entry.id}:copy`, async (isCurrent) => {
      const reference = [
        `Memory entry: ${entry.title}`,
        `ID: ${entry.id}`,
        `Status: ${memoryEntryStatusLabel(entry.status)}`,
        `Origin: ${memoryOriginLabel(entry.origin)}`,
        entry.createdAt === undefined ? '' : `Created: ${new Date(entry.createdAt).toISOString()}`,
        entry.updatedAt === undefined ? '' : `Updated: ${new Date(entry.updatedAt).toISOString()}`,
        entry.tags.length > 0 ? `Tags: ${entry.tags.join(', ')}` : '',
      ].filter(Boolean).join('\n');
      try {
        await navigator.clipboard.writeText(reference);
        if (isCurrent()) toast.success('已复制记忆引用', entry.id);
      } catch {
        if (isCurrent()) toast.error('复制失败', '剪贴板不可用或被系统拒绝。');
      }
    });
  }

  function focusMemoryEntryInDraft(entry: LocalMemoryState['entries'][number]) {
    const range = findLocalMemoryEntryDraftRange(draft, entry.id);
    if (!range) {
      toast.error('无法定位记忆', '当前草稿里找不到这条记忆；请先保存或刷新后重试。');
      return;
    }
    requestAnimationFrame(() => {
      editorRef.current?.focus();
      editorRef.current?.setSelectionRange(range.start, range.end);
      editorRef.current?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    });
  }

  function addManualMemoryDraftEntry() {
    const result = appendManualLocalMemoryEntryDraft(draft, {
      title: newMemoryTitle,
      content: newMemoryContent,
      tags: newMemoryTags.split(','),
    });
    if (!result.ok) {
      switch (result.reason) {
        case 'empty_title':
          toast.error('标题不能为空', '给这条记忆起一个短标题。');
          return;
        case 'empty_content':
          toast.error('内容不能为空', '写下要保留的偏好或事实。');
          return;
        case 'oversize':
          toast.error('草稿过大', 'MEMORY.md 超出安全上限，请先删减旧内容。');
          return;
      }
    }
    setDraft(result.draft);
    setNewMemoryTitle('');
    setNewMemoryTags('');
    setNewMemoryContent('');
    toast.success('已添加到草稿', '确认文件内容后点击保存。');
    requestAnimationFrame(() => {
      editorRef.current?.focus();
      editorRef.current?.setSelectionRange(result.draft.length, result.draft.length);
    });
  }

  async function updateMemoryEntryStatus(entry: LocalMemoryState['activeEntries'][number], status: 'active' | 'archived') {
    const result = setLocalMemoryEntryStatusDraft(draft, {
      id: entry.id,
      status,
    });
    if (!result.ok) {
      switch (result.reason) {
        case 'invalid_id':
          toast.error('无法更新记忆', '这条记忆没有可识别 ID，已停止更新。');
          return;
        case 'not_found':
          toast.error('无法更新记忆', '当前草稿里找不到这条记忆；请先保存或刷新后重试。');
          return;
        case 'oversize':
          toast.error('无法更新记忆', 'MEMORY.md 超出安全上限，请先删减旧内容。');
          return;
      }
    }

    if (memoryDraftDirty) {
      setDraft(result.draft);
      toast.success(status === 'archived' ? '已在草稿中归档记忆' : '已在草稿中恢复记忆', '确认文件内容后点击保存。');
      return;
    }

    try {
      await runMemoryWriteAction('entry-status', async (isCurrent) => {
        const next = await window.maka.memory.save(result.draft);
        if (!isCurrent()) return;
        setState(next);
        setDraft(next.content);
        if (next.status === 'safe_mode') {
          toast.error('更新被拦截', 'MEMORY.md 内容过大，已进入安全模式。');
        } else {
          toast.success(status === 'archived' ? '已归档记忆' : '已恢复记忆', entry.title);
        }
      });
    } catch (error) {
      toast.error(status === 'archived' ? '归档记忆失败' : '恢复记忆失败', settingsActionErrorMessage(error));
    }
  }

  const effective = state ?? {
    path: '',
    enabled: props.settings.localMemory.enabled,
    agentReadEnabled: props.settings.localMemory.agentReadEnabled,
    status: 'disabled',
    content: '',
    entryCount: 0,
    activeEntryCount: 0,
    archivedEntryCount: 0,
    entries: [],
    activeEntries: [],
    archivedEntries: [],
  } satisfies LocalMemoryState;
  const memoryDraftDirty = draft !== effective.content;
  const draftMemoryEntries = useMemo(() => parseLocalMemoryMarkdown(draft), [draft]);
  const visibleMemoryEntries = memoryDraftDirty ? draftMemoryEntries : effective;
  const memoryEntryPreviewBlockedReason =
    memoryDraftDirty && draftMemoryEntries.safeMode
      ? '草稿过大，条目预览已暂停；保存前请先删减 MEMORY.md 内容。'
      : '';
  const normalizedMemoryEntryQuery = memoryEntryQuery.trim();
  const filteredActiveEntries = useMemo(
    () => filterLocalMemoryEntries(visibleMemoryEntries.activeEntries, normalizedMemoryEntryQuery),
    [visibleMemoryEntries.activeEntries, normalizedMemoryEntryQuery],
  );
  const filteredArchivedEntries = useMemo(
    () => filterLocalMemoryEntries(visibleMemoryEntries.archivedEntries, normalizedMemoryEntryQuery),
    [visibleMemoryEntries.archivedEntries, normalizedMemoryEntryQuery],
  );
  const filteredEntryCount = filteredActiveEntries.length + filteredArchivedEntries.length;
  const localMemoryPromptPreview = useMemo(() => buildLocalMemoryPromptBody(draft) ?? '', [draft]);
  const promptPreviewBlockedReason = localMemoryPromptPreviewBlockedReason(effective);
  const promptPreviewWillInject = localMemoryPromptPreview.length > 0 && !promptPreviewBlockedReason;
  const localMemoryPromptPreviewTruncated = localMemoryPromptPreview.includes('[本地记忆已按长度截断]');
  const localMemoryPromptPreviewBudgetLabel = localMemoryPromptPreview
    ? localMemoryPromptPreviewTruncated
      ? `预览已按 ${LOCAL_MEMORY_PROMPT_MAX_CHARS.toLocaleString('zh-CN')} 字符上限截断`
      : `预览 ${localMemoryPromptPreview.length.toLocaleString('zh-CN')} / ${LOCAL_MEMORY_PROMPT_MAX_CHARS.toLocaleString('zh-CN')} 字符`
    : `prompt 上限 ${LOCAL_MEMORY_PROMPT_MAX_CHARS.toLocaleString('zh-CN')} 字符`;
  const memoryDraftHasSensitiveFields = useMemo(() => redactSecrets(draft) !== draft, [draft]);
  const memoryControlsDisabled = loadingMemory || busy;
  const isMemoryActionPending = (key: string) => pendingMemoryActions.has(key);

  async function copyLocalMemoryPromptPreview() {
    if (!localMemoryPromptPreview) return;
    await runMemoryAction('memory:prompt-preview:copy', async (isCurrent) => {
      try {
        await navigator.clipboard.writeText(localMemoryPromptPreview);
        if (isCurrent()) toast.success('已复制模型上下文预览', '使用同一条 prompt 预览和遮蔽路径。');
      } catch {
        if (isCurrent()) toast.error('复制失败', '剪贴板不可用或被系统拒绝。');
      }
    });
  }

  return (
    <div className="settingsStructuredPage">
      <div className="settingsFormRow">
        <div>
          <strong>本地 MEMORY.md</strong>
          <small>透明 Markdown 文件，保存在当前本机工作区。这里的内容不会自动从聊天里抽取。</small>
        </div>
        <span className="settingsConnectionBadge" data-tone={memoryStatusTone(effective.status)}>
          {memoryStatusLabel(effective.status)}
        </span>
        <Switch
          ariaLabel="启用本地 MEMORY.md"
          checked={effective.enabled}
          disabled={memoryControlsDisabled}
          onChange={(enabled) => void setEnabled(enabled)}
        />
      </div>

      <div className="settingsFormRow">
        <div>
          <strong>模型上下文可读取</strong>
          <small>默认关闭。开启后才允许发送消息时把本地记忆加入 prompt；隐身模式下仍会禁用。</small>
        </div>
        <Switch
          ariaLabel="允许模型上下文读取本地记忆"
          checked={effective.agentReadEnabled}
          disabled={memoryControlsDisabled || !effective.enabled}
          onChange={(enabled) => void setAgentReadEnabled(enabled)}
        />
      </div>

      <div className="settingsFormRow">
        <div>
          <strong>项目指令文件</strong>
          <small>读取当前工作区的 AGENTS.md / CLAUDE.md / GEMINI.md；按低优先级指令注入，可随时关闭。</small>
        </div>
        <Switch
          ariaLabel="启用项目指令文件"
          checked={props.settings.workspaceInstructions.enabled}
          disabled={memoryControlsDisabled}
          onChange={(enabled) => void setWorkspaceInstructionsEnabled(enabled)}
        />
      </div>

      {workspaceInstructionState && (
        <div className="settingsMemoryPreview">
          <strong>
            检测到 {workspaceInstructionState.detectedCount} 个项目指令文件
          </strong>
          <small>
            单文件最多读取 {workspaceInstructionState.fileCharLimit.toLocaleString('zh-CN')} 字符；只显示状态，不在这里展示内容。
          </small>
          <div className="settingsConnectionMeta">
            {workspaceInstructionState.files.map((file) => (
              <span key={file.file} className="settingsInlineFileState">
                <span>{file.file} · {workspaceInstructionStatusLabel(file.status, file.chars, file.truncated)}</span>
                {(file.status === 'available' || file.status === 'empty') && (
                  <button
                    type="button"
                    className="settingsInlineTextButton"
                    aria-label={`打开项目指令文件 ${file.file}`}
                    disabled={memoryControlsDisabled || isMemoryActionPending(`instruction:${file.file}:open`)}
                    onClick={() => void openWorkspaceInstructionFile(file.file)}
                  >
                    {isMemoryActionPending(`instruction:${file.file}:open`) ? '打开中…' : '打开'}
                  </button>
                )}
                {file.status === 'missing' && (
                  <button
                    type="button"
                    className="settingsInlineTextButton"
                    aria-label={`创建项目指令文件 ${file.file}`}
                    disabled={memoryControlsDisabled || isMemoryActionPending(`instruction:${file.file}:create`)}
                    onClick={() => void createWorkspaceInstructionFile(file.file)}
                  >
                    {isMemoryActionPending(`instruction:${file.file}:create`) ? '创建中…' : '创建'}
                  </button>
                )}
              </span>
            ))}
          </div>
        </div>
      )}

      <div className="settingsConnectionMeta">
        <span>{effective.path || '等待创建 MEMORY.md'}</span>
        {effective.latestBackup ? (
          <span className="settingsMemoryBackupState">
            上一版 {localMemoryBackupKindLabel(effective.latestBackup.kind)} · {localMemoryBackupSummary(effective.latestBackup)} · <RelativeTime ts={effective.latestBackup.updatedAt} />
          </span>
        ) : (
          <span className="settingsMemoryBackupState" data-empty="true">等待生成上一版备份</span>
        )}
        <span className="settingsMemoryDirtyState" data-dirty={memoryDraftDirty ? 'true' : 'false'}>
          {memoryDraftDirty ? '有未保存修改' : '草稿已保存'}
        </span>
        <span>
          {memoryDraftDirty ? '草稿 ' : ''}
          {visibleMemoryEntries.activeEntries.length} 条生效
        </span>
        {visibleMemoryEntries.archivedEntries.length > 0 && (
          <span>
            {memoryDraftDirty ? '草稿 ' : ''}
            {visibleMemoryEntries.archivedEntries.length} 条已归档
          </span>
        )}
      </div>

      {effective.backups && effective.backups.length > 1 && (
        <div className="settingsMemoryBackupList" role="status">
          <strong>备份候选</strong>
          <div role="list" aria-label="本地记忆备份候选列表">
            {effective.backups.map((backup) => {
              const backupCandidateLabel = `${localMemoryBackupKindLabel(backup.kind)} · ${localMemoryBackupSummary(backup)}`;
              return (
                <span key={`${backup.kind}:${backup.path}`} className="settingsMemoryBackupCandidate" role="listitem">
                  <span>{backupCandidateLabel} · <RelativeTime ts={backup.updatedAt} /></span>
                  <button
                    type="button"
                    className="settingsInlineTextButton"
                    aria-label={`打开备份候选 ${backupCandidateLabel}`}
                    disabled={memoryControlsDisabled || !effective.enabled || isMemoryActionPending(`backup:${backup.kind}:open`)}
                    onClick={() => void openBackupCandidate(backup)}
                  >
                    {isMemoryActionPending(`backup:${backup.kind}:open`) ? '打开中…' : '打开'}
                  </button>
                  <button
                    type="button"
                    className="settingsInlineTextButton"
                    aria-label={`恢复备份候选 ${backupCandidateLabel}`}
                    disabled={memoryControlsDisabled || !effective.enabled || isMemoryActionPending(`backup:${backup.kind}:restore`)}
                    onClick={() => void restoreBackupCandidate(backup)}
                  >
                    {isMemoryActionPending(`backup:${backup.kind}:restore`) ? '恢复中…' : '恢复'}
                  </button>
                  <button
                    type="button"
                    className="settingsInlineTextButton"
                    aria-label={`复制备份候选引用 ${backupCandidateLabel}`}
                    disabled={isMemoryActionPending(`backup:${backup.kind}:copy`)}
                    onClick={() => void copyBackupReference(backup)}
                  >
                    {isMemoryActionPending(`backup:${backup.kind}:copy`) ? '复制中…' : '复制引用'}
                  </button>
                </span>
              );
            })}
          </div>
          <small>上一版操作会使用最近的候选；这里只显示 metadata，不展示备份正文。</small>
        </div>
      )}

      {lastSaveSummary && !memoryDraftDirty && (
        <div className="settingsMemorySaveSummary" role="status">
          <strong>{lastSaveSummary.title}</strong>
          <small className="settingsMemorySaveSummaryTime">
            保存于 <RelativeTime ts={lastSaveSummary.savedAt} />
          </small>
          <small>{lastSaveSummary.detail}</small>
        </div>
      )}

      {memoryEntryPreviewBlockedReason && (
        <div className="settingsMemoryEntryPreviewNotice" role="status">
          <strong>草稿条目预览暂停</strong>
          <small>{memoryEntryPreviewBlockedReason}</small>
        </div>
      )}

      <div className="settingsMemoryPromptPreview" data-active={promptPreviewWillInject ? 'true' : 'false'}>
        <div className="settingsMemoryPromptPreviewHeader">
          <strong>模型上下文预览</strong>
          <div>
            <span>{promptPreviewWillInject ? '发送时会注入' : '当前不会注入'}</span>
            <button
              type="button"
              className="settingsInlineTextButton"
              disabled={!localMemoryPromptPreview || isMemoryActionPending('memory:prompt-preview:copy')}
              onClick={() => void copyLocalMemoryPromptPreview()}
            >
              {isMemoryActionPending('memory:prompt-preview:copy') ? '复制中…' : '复制上下文'}
            </button>
          </div>
        </div>
        <small>只展示生效记忆会进入 prompt 的内容；已归档条目不会注入，疑似密钥会遮蔽。</small>
        <small className="settingsMemoryPromptPreviewBudget">{localMemoryPromptPreviewBudgetLabel}</small>
        {localMemoryPromptPreview ? (
          <pre>{localMemoryPromptPreview}</pre>
        ) : (
          <p>{effective.status === 'safe_mode' ? 'MEMORY.md 过大，当前不会生成模型上下文预览。' : '没有生效记忆会进入 prompt。'}</p>
        )}
        {promptPreviewBlockedReason && localMemoryPromptPreview && (
          <small>{promptPreviewBlockedReason}</small>
        )}
      </div>

      {visibleMemoryEntries.entries.length > 0 && (
        <>
          <div className="settingsMemoryFilter">
            <input
              type="search"
              value={memoryEntryQuery}
              onChange={(event) => setMemoryEntryQuery(event.currentTarget.value)}
              aria-label="筛选本地记忆"
              placeholder="筛选标题、内容、ID 或标签"
            />
            {normalizedMemoryEntryQuery ? (
              <button type="button" className="settingsInlineTextButton" onClick={() => setMemoryEntryQuery('')}>
                清除
              </button>
            ) : null}
            <small>
              {normalizedMemoryEntryQuery
                ? `${filteredEntryCount} / ${visibleMemoryEntries.entries.length} 条匹配`
                : `${visibleMemoryEntries.entries.length} 条记忆`}
            </small>
          </div>
          {normalizedMemoryEntryQuery && filteredEntryCount === 0 ? (
            <div className="settingsMemoryFilterEmpty" role="status">
              <strong>没有匹配的记忆条目</strong>
              <small>筛选不会修改 MEMORY.md；清除筛选后会恢复显示全部条目。</small>
            </div>
          ) : (
            <div className="settingsMemoryEntryGroups">
              <MemoryEntryList
                title="生效记忆"
                entries={filteredActiveEntries}
                filtered={normalizedMemoryEntryQuery.length > 0}
                draftDirty={memoryDraftDirty}
                busy={memoryControlsDisabled || effective.status === 'incognito_blocked' || !effective.enabled}
                pendingCopyIds={pendingMemoryActions}
                onCopyReference={copyMemoryEntryReference}
                onFocusDraft={focusMemoryEntryInDraft}
                onStatusChange={updateMemoryEntryStatus}
              />
              {visibleMemoryEntries.archivedEntries.length > 0 && (
                <MemoryEntryList
                  title="已归档记忆"
                  entries={filteredArchivedEntries}
                  filtered={normalizedMemoryEntryQuery.length > 0}
                  archived
                  draftDirty={memoryDraftDirty}
                  busy={memoryControlsDisabled || effective.status === 'incognito_blocked' || !effective.enabled}
                  pendingCopyIds={pendingMemoryActions}
                  onCopyReference={copyMemoryEntryReference}
                  onFocusDraft={focusMemoryEntryInDraft}
                  onStatusChange={updateMemoryEntryStatus}
                />
              )}
            </div>
          )}
        </>
      )}

      {visibleMemoryEntries.entries.length === 0 && !memoryEntryPreviewBlockedReason && (
        <div className="settingsMemoryListEmpty" role="status">
          <strong>等待添加记忆条目</strong>
          <small>手动添加会先进入下方草稿；保存后才会写入 MEMORY.md。</small>
        </div>
      )}

      <div className="settingsMemoryManualAdd" role="group" aria-label="手动添加本地记忆">
        <div className="settingsMemoryManualAddHeader">
          <strong>手动添加记忆</strong>
          <small>只追加到下方草稿；保存前仍可检查和修改 Markdown。</small>
        </div>
        <div className="settingsMemoryManualAddGrid">
          <input
            type="text"
            value={newMemoryTitle}
            onChange={(event) => setNewMemoryTitle(event.currentTarget.value)}
            aria-label="记忆标题"
            placeholder="标题"
            disabled={memoryControlsDisabled || effective.status === 'incognito_blocked' || !effective.enabled}
          />
          <input
            type="text"
            value={newMemoryTags}
            onChange={(event) => setNewMemoryTags(event.currentTarget.value)}
            aria-label="记忆标签"
            placeholder="标签（逗号分隔，可选）"
            disabled={memoryControlsDisabled || effective.status === 'incognito_blocked' || !effective.enabled}
          />
          <textarea
            value={newMemoryContent}
            onChange={(event) => setNewMemoryContent(event.currentTarget.value)}
            aria-label="记忆内容"
            placeholder="内容"
            rows={3}
            disabled={memoryControlsDisabled || effective.status === 'incognito_blocked' || !effective.enabled}
          />
        </div>
        <button
          type="button"
          className="maka-button maka-button-ghost"
          disabled={memoryControlsDisabled || effective.status === 'incognito_blocked' || !effective.enabled}
          onClick={addManualMemoryDraftEntry}
        >
          添加到草稿
        </button>
      </div>

      {memoryDraftHasSensitiveFields && (
        <div className="settingsMemoryDraftWarning" role="status">
          <strong>草稿含疑似敏感字段</strong>
          <small>保存时会先遮蔽疑似 token、API key 或密码，再写入 MEMORY.md。</small>
        </div>
      )}

      <label className="settingsMemoryEditor">
        <span>文件内容</span>
        <textarea
          ref={editorRef}
          value={draft}
          onChange={(event) => setDraft(event.currentTarget.value)}
          disabled={memoryControlsDisabled || effective.status === 'incognito_blocked' || !effective.enabled}
          rows={12}
          spellCheck={false}
          aria-label="MEMORY.md 内容"
        />
      </label>

      {effective.reason && (
        <div className="settingsNotice" data-tone="passive" role="status">
          {effective.reason}
        </div>
      )}

      <div className="settingsActionRow" role="group" aria-label="MEMORY.md 文件操作">
        <button type="button" className="maka-button" disabled={memoryControlsDisabled || !effective.enabled || !memoryDraftDirty} onClick={() => void save()}>
          {pendingMemoryWriteAction === 'save' ? '保存中…' : memoryDraftDirty ? '保存' : '已保存'}
        </button>
        <button type="button" className="maka-button maka-button-ghost" disabled={memoryControlsDisabled || !effective.enabled || isMemoryActionPending('memory:file:open')} onClick={() => void openFile()}>
          {isMemoryActionPending('memory:file:open') ? '打开中…' : '打开 MEMORY.md'}
        </button>
        <button type="button" className="maka-button maka-button-ghost" disabled={memoryControlsDisabled || !effective.enabled || isMemoryActionPending('memory:folder:open')} onClick={() => void openFolder()}>
          {isMemoryActionPending('memory:folder:open') ? '打开中…' : '打开所在目录'}
        </button>
        <button type="button" className="maka-button maka-button-ghost" disabled={memoryControlsDisabled || !effective.enabled} onClick={() => void reloadDraftFromDisk()}>
          {pendingMemoryWriteAction === 'reload' ? '载入中…' : '重新载入'}
        </button>
        <button type="button" className="maka-button maka-button-ghost" disabled={memoryControlsDisabled || !effective.enabled || !effective.latestBackup || isMemoryActionPending('backup:latest:open')} onClick={() => void openLatestBackup()}>
          {isMemoryActionPending('backup:latest:open') ? '打开中…' : '打开上一版'}
        </button>
        <button type="button" className="maka-button maka-button-ghost" disabled={!effective.path || isMemoryActionPending('memory:path:copy')} onClick={() => void copyPath()}>
          {isMemoryActionPending('memory:path:copy') ? '复制中…' : '复制路径'}
        </button>
        <button type="button" className="maka-button maka-button-ghost" disabled={!effective.latestBackup || (effective.latestBackup ? isMemoryActionPending(`backup:${effective.latestBackup.kind}:copy`) : false)} onClick={() => void copyLatestBackupReference()}>
          {effective.latestBackup && isMemoryActionPending(`backup:${effective.latestBackup.kind}:copy`) ? '复制中…' : '复制上一版引用'}
        </button>
        <button type="button" className="maka-button maka-button-ghost" disabled={memoryControlsDisabled || !effective.enabled} onClick={() => void reset()}>
          {pendingMemoryWriteAction === 'reset' ? '重置中…' : '重置并备份'}
        </button>
        <button type="button" className="maka-button maka-button-ghost" disabled={memoryControlsDisabled || !effective.enabled || !effective.latestBackup || isMemoryActionPending('backup:latest:restore')} onClick={() => void restoreLatestBackup()}>
          {isMemoryActionPending('backup:latest:restore') ? '恢复中…' : '恢复上一版'}
        </button>
      </div>
    </div>
  );
}

function MemoryEntryList(props: {
  title: string;
  entries: LocalMemoryState['activeEntries'];
  filtered?: boolean;
  archived?: boolean;
  draftDirty?: boolean;
  busy?: boolean;
  pendingCopyIds?: ReadonlySet<string>;
  onCopyReference?(entry: LocalMemoryState['activeEntries'][number]): void | Promise<void>;
  onFocusDraft?(entry: LocalMemoryState['activeEntries'][number]): void | Promise<void>;
  onStatusChange?(entry: LocalMemoryState['activeEntries'][number], status: 'active' | 'archived'): void | Promise<void>;
}) {
  return (
    <section className="settingsMemoryEntryGroup" data-archived={props.archived ? 'true' : 'false'}>
      <div className="settingsMemoryEntryGroupHeader">
        <strong>{props.title}</strong>
        <span>{props.entries.length} 条</span>
      </div>
      {props.draftDirty && props.onStatusChange && (
        <p className="settingsMemoryEntryDraftNotice" role="status">
          当前归档/恢复操作只更新草稿，保存后才会写入 MEMORY.md。
        </p>
      )}
      {props.entries.length === 0 ? (
        <p className="settingsMemoryEntryEmpty">{props.filtered ? '无匹配条目。' : '暂无条目。'}</p>
      ) : (
        <div className="settingsMemoryEntryList" role="list" aria-label={`${props.title}列表`}>
          {props.entries.map((entry) => {
            const copyPending = props.pendingCopyIds?.has(`entry:${entry.id}:copy`) ?? false;
            const statusActionLabel = props.draftDirty
              ? props.archived
                ? '恢复到草稿'
                : '归档到草稿'
              : props.archived
                ? '恢复'
                : '归档';
            const statusActionAriaLabel = props.draftDirty
              ? `${statusActionLabel}，保存前不会写入 MEMORY.md`
              : undefined;
            return (
              <article className="settingsMemoryEntryCard" role="listitem" key={entry.id}>
                <strong>{entry.title}</strong>
                <small className="settingsMemoryEntryMeta">
                  {memoryOriginLabel(entry.origin)}
                  {entry.tags.length > 0 ? ` · ${entry.tags.join(' / ')}` : ''}
                </small>
                <small className="settingsMemoryEntryFacts">
                  <span>ID {entry.id}</span>
                  {entry.createdAt !== undefined && (
                    <span>
                      创建 <RelativeTime ts={entry.createdAt} className="settingsHelpInlineTime" />
                    </span>
                  )}
                  {entry.updatedAt !== undefined && (
                    <span>
                      更新 <RelativeTime ts={entry.updatedAt} className="settingsHelpInlineTime" />
                    </span>
                  )}
                </small>
                <span className="settingsMemoryPromptScope" data-active={props.archived ? 'false' : 'true'}>
                  {props.archived ? '已归档，不进入 prompt' : '生效条目，会进入本地记忆 prompt'}
                </span>
                <p>{entry.content}</p>
                {(props.onCopyReference || props.onFocusDraft || props.onStatusChange) && (
                  <div className="settingsMemoryEntryActions" role="group" aria-label={`${entry.title}记忆操作`}>
                    {props.onCopyReference && (
                      <button
                        type="button"
                        className="settingsInlineTextButton"
                        disabled={copyPending}
                        onClick={() => void props.onCopyReference?.(entry)}
                      >
                        {copyPending ? '复制中…' : '复制引用'}
                      </button>
                    )}
                    {props.onFocusDraft && (
                      <button
                        type="button"
                        className="settingsInlineTextButton"
                        onClick={() => void props.onFocusDraft?.(entry)}
                      >
                        定位草稿
                      </button>
                    )}
                    {props.onStatusChange && (
                      <button
                        type="button"
                        className="settingsInlineTextButton"
                        aria-label={statusActionAriaLabel}
                        disabled={props.busy}
                        onClick={() => void props.onStatusChange?.(entry, props.archived ? 'active' : 'archived')}
                      >
                        {statusActionLabel}
                      </button>
                    )}
                  </div>
                )}
              </article>
            );
          })}
        </div>
      )}
    </section>
  );
}

function filterLocalMemoryEntries(
  entries: LocalMemoryState['activeEntries'],
  query: string,
): LocalMemoryState['activeEntries'] {
  if (!query) return entries;
  const needle = query.toLocaleLowerCase('zh-CN');
  return entries.filter((entry) => {
    const haystack = [
      entry.id,
      entry.title,
      entry.content,
      entry.origin,
      memoryOriginLabel(entry.origin),
      entry.createdAt === undefined ? '' : String(entry.createdAt),
      entry.updatedAt === undefined ? '' : String(entry.updatedAt),
      ...entry.tags,
    ].join('\n').toLocaleLowerCase('zh-CN');
    return haystack.includes(needle);
  });
}

function memoryOriginLabel(origin: NonNullable<LocalMemoryState['latestEntry']>['origin']): string {
  switch (origin) {
    case 'manual': return '手动记录';
    case 'imported': return '导入记录';
    case 'extracted': return '确认提取';
    case 'unknown': return '手写条目';
  }
}

function memoryEntryStatusLabel(status: LocalMemoryState['entries'][number]['status']): string {
  switch (status) {
    case 'active': return '生效';
    case 'archived': return '已归档';
  }
}

function formatLocalMemorySaveSummary(state: LocalMemoryState): string {
  const archived = state.archivedEntryCount > 0 ? ` / ${state.archivedEntryCount} 条已归档` : '';
  return `当前 ${state.activeEntryCount} 条生效${archived}；已保留上一版备份。`;
}

function localMemoryBackupKindLabel(kind: NonNullable<LocalMemoryState['latestBackup']>['kind']): string {
  switch (kind) {
    case 'reset': return '重置前备份';
    case 'restore': return '恢复前备份';
    case 'save': return '保存前备份';
  }
}

function localMemoryBackupSummary(backup: NonNullable<LocalMemoryState['latestBackup']>): string {
  if (backup.safeMode) return '备份过大，无法预览条目';
  const archived = backup.archivedEntryCount > 0 ? ` / ${backup.archivedEntryCount} 条已归档` : '';
  return `${backup.activeEntryCount} 条生效${archived}`;
}

function memoryStatusLabel(status: LocalMemoryState['status']): string {
  switch (status) {
    case 'ok': return '本地文件已就绪';
    case 'disabled': return '已关闭';
    case 'safe_mode': return '安全模式';
    case 'incognito_blocked': return '隐身禁用';
    case 'error': return '读取失败';
  }
}

function localMemoryPromptPreviewBlockedReason(state: LocalMemoryState): string {
  if (!state.enabled) return '本地记忆已关闭。';
  if (state.status === 'incognito_blocked') return '隐身模式下不会注入本地记忆。';
  if (state.status === 'safe_mode') return 'MEMORY.md 过大，当前不会注入。';
  if (!state.agentReadEnabled) return '模型上下文读取未开启。';
  return '';
}

function workspaceInstructionStatusLabel(status: string, chars: number, truncated: boolean): string {
  switch (status) {
    case 'available':
      return `${chars.toLocaleString('zh-CN')} 字符${truncated ? '，已截断' : ''}`;
    case 'missing':
      return '未找到';
    case 'blocked':
      return '路径被拦截';
    case 'empty':
      return '空文件';
    case 'unreadable':
      return '无法读取';
    default:
      return '未知状态';
  }
}

function memoryStatusTone(status: LocalMemoryState['status']): 'success' | 'info' | 'warning' | 'destructive' {
  switch (status) {
    case 'ok': return 'success';
    case 'disabled': return 'info';
    case 'safe_mode':
    case 'incognito_blocked': return 'warning';
    case 'error': return 'destructive';
  }
}

function settingsActionErrorMessage(error: unknown): string {
  const raw = error instanceof Error
    ? error.message
    : typeof error === 'string'
      ? error
      : '';
  const classified = generalizedErrorMessageChinese(new Error(raw), '');
  if (classified) return classified;
  const redacted = redactSecrets(raw).trim();
  if (redacted && /[\u4E00-\u9FFF]/.test(redacted)) return redacted;
  return '未知错误，请稍后重试。';
}

function NetworkSettingsPage(props: {
  settings: AppSettings;
  onUpdate(patch: Parameters<typeof window.maka.settings.update>[0]): Promise<UpdateAppSettingsResult>;
}) {
  const persistedProxy = props.settings.network.proxy;
  const [proxyDraft, setProxyDraft] = useState<NetworkProxySettings>(persistedProxy);
  const [testing, setTesting] = useState(false);
  const proxyDraftRef = useRef<NetworkProxySettings>(persistedProxy);
  const persistedProxyRef = useRef<NetworkProxySettings>(persistedProxy);
  const proxyPendingSaveCountRef = useRef(0);
  const proxySaveTicketRef = useRef(0);
  const proxyTestRunningRef = useRef(false);
  const networkPageMountedRef = useRef(false);
  const toast = useToast();

  useEffect(() => {
    networkPageMountedRef.current = true;
    return () => {
      networkPageMountedRef.current = false;
      proxySaveTicketRef.current += 1;
      proxyTestRunningRef.current = false;
    };
  }, []);

  function commitProxyDraft(next: NetworkProxySettings) {
    proxyDraftRef.current = next;
    setProxyDraft(next);
  }

  useEffect(() => {
    persistedProxyRef.current = persistedProxy;
    if (proxyPendingSaveCountRef.current === 0) {
      commitProxyDraft(persistedProxy);
    }
  }, [persistedProxy]);

  async function updateProxy(patch: Partial<NetworkProxySettings>) {
    const nextDraft = { ...proxyDraftRef.current, ...patch };
    const ticket = proxySaveTicketRef.current + 1;
    proxySaveTicketRef.current = ticket;
    proxyPendingSaveCountRef.current += 1;
    commitProxyDraft(nextDraft);
    try {
      const result = await props.onUpdate({ network: { proxy: patch } });
      if (networkPageMountedRef.current && ticket === proxySaveTicketRef.current) {
        commitProxyDraft(result.settings.network.proxy);
      }
    } catch (error) {
      if (networkPageMountedRef.current && ticket === proxySaveTicketRef.current) {
        commitProxyDraft(persistedProxyRef.current);
        toast.error('保存网络设置失败', settingsActionErrorMessage(error));
      }
    } finally {
      proxyPendingSaveCountRef.current = Math.max(0, proxyPendingSaveCountRef.current - 1);
    }
  }

  async function testProxy() {
    if (proxyTestRunningRef.current) return;
    proxyTestRunningRef.current = true;
    setTesting(true);
    try {
      const result = await window.maka.settings.testNetworkProxy(toProxyTestInput(proxyDraftRef.current));
      const latency = result.latencyMs !== undefined ? ` · ${result.latencyMs} ms` : '';
      if (result.ok && networkPageMountedRef.current) {
        toast.success('代理可达', `${result.message}${latency}`);
      } else if (networkPageMountedRef.current) {
        toast.error('代理测试失败', result.message);
      }
    } catch (error) {
      if (networkPageMountedRef.current) {
        toast.error('代理测试出错', settingsActionErrorMessage(error));
      }
    } finally {
      proxyTestRunningRef.current = false;
      if (networkPageMountedRef.current) {
        setTesting(false);
      }
    }
  }

  return (
    <div className="settingsStructuredPage">
      <div className="settingsFormRow">
        <div>
          <strong>代理服务器</strong>
          <small>为 AI 模型请求配置网络代理</small>
        </div>
        <Switch
          ariaLabel="启用代理服务器"
          checked={proxyDraft.enabled}
          onChange={(enabled) => void updateProxy({ enabled })}
        />
      </div>

      {proxyDraft.enabled && (
        <>
          <div className="settingsFormGrid settingsFormGridProxy">
            <label>
              <span>代理协议</span>
              <select
                value={proxyDraft.protocol}
                onChange={(event) => void updateProxy({ protocol: event.currentTarget.value as NetworkProxySettings['protocol'] })}
                aria-label="代理协议"
              >
                <option value="http">HTTP/HTTPS</option>
                <option value="https">HTTPS</option>
                <option value="socks5">SOCKS5</option>
              </select>
            </label>
            <label>
              <span>服务器地址</span>
              <input value={proxyDraft.host} onChange={(event) => void updateProxy({ host: event.currentTarget.value })} placeholder="127.0.0.1" aria-label="代理服务器地址" />
            </label>
            <label>
              <span>端口</span>
              <input value={String(proxyDraft.port || '')} onChange={(event) => void updateProxy({ port: Number(event.currentTarget.value) || 0 })} placeholder="7890" aria-label="代理端口" />
            </label>
          </div>

          <div className="settingsFormRow">
            <div>
              <strong>代理认证</strong>
              <small>需要用户名和密码时开启。</small>
            </div>
            <Switch
              ariaLabel="启用代理认证"
              checked={proxyDraft.authEnabled}
              onChange={(authEnabled) => void updateProxy({ authEnabled })}
            />
          </div>

          {proxyDraft.authEnabled && (
            <div className="settingsFormGrid">
              <label>
                <span>用户名</span>
                <input value={proxyDraft.username} onChange={(event) => void updateProxy({ username: event.currentTarget.value })} aria-label="代理用户名" />
              </label>
              <label>
                <span>密码</span>
                <PasswordInput value={proxyDraft.password} onChange={(next) => void updateProxy({ password: next })} ariaLabel="代理密码" />
              </label>
            </div>
          )}

          <label className="settingsField">
            <span>代理白名单</span>
            <input
              value={proxyDraft.bypassList.join(', ')}
              onChange={(event) => void updateProxy({ bypassList: csvList(event.currentTarget.value) })}
              placeholder="metaso.cn, baidu.com"
              aria-label="代理白名单"
            />
            <small>这些域名将绕过代理直连，多个用逗号分隔。</small>
          </label>

          <div className="settingsNotice">
            已自动添加 {proxyDraft.autoBypassDomains.length} 个域名（来自本地和模型供应商）。代理仅作用于 AI 模型请求，不影响应用自身网络。
          </div>

          <div className="settingsActionRow">
            <button
              className="maka-button"
              type="button"
              disabled={testing}
              aria-busy={testing}
              data-pending={testing ? 'true' : undefined}
              onClick={() => void testProxy()}
            >
              {testing ? '测试中…' : '测试当前配置'}
            </button>
          </div>
        </>
      )}
    </div>
  );
}

function OpenGatewaySettingsPage(props: {
  settings: AppSettings;
  onUpdate(patch: Parameters<typeof window.maka.settings.update>[0]): Promise<UpdateAppSettingsResult>;
}) {
  const persistedGateway = props.settings.openGateway;
  const [gatewayDraft, setGatewayDraft] = useState(persistedGateway);
  const [status, setStatus] = useState<OpenGatewayRuntimeStatus | null>(null);
  const [statusLoadError, setStatusLoadError] = useState<string | null>(null);
  const [tokenDraft, setTokenDraft] = useState(persistedGateway.token);
  const [eventSessionId, setEventSessionId] = useState('');
  const [saving, setSaving] = useState(false);
  const [copyingGatewayAction, setCopyingGatewayAction] = useState<string | null>(null);
  const gatewayDraftRef = useRef(persistedGateway);
  const persistedGatewayRef = useRef(persistedGateway);
  const gatewayPendingSaveCountRef = useRef(0);
  const gatewaySaveTicketRef = useRef(0);
  const copyingGatewayActionRef = useRef<string | null>(null);
  const openGatewayMountedRef = useRef(false);
  const toast = useToast();

  useEffect(() => {
    openGatewayMountedRef.current = true;
    return () => {
      openGatewayMountedRef.current = false;
      gatewaySaveTicketRef.current += 1;
      copyingGatewayActionRef.current = null;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    window.maka.gateway
      .status()
      .then((next) => {
        if (!cancelled) {
          setStatus(next);
          setStatusLoadError(null);
        }
      })
      .catch((error) => {
        if (cancelled) return;
        const message = settingsActionErrorMessage(error);
        setStatusLoadError(message);
        toast.error('读取开放网关状态失败', message);
      });
    const unsubscribe = window.maka.gateway.subscribeStatusChanges((next) => {
      if (!cancelled) {
        setStatus(next);
        setStatusLoadError(null);
      }
    });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, []);

  function commitGatewayDraft(next: AppSettings['openGateway']) {
    gatewayDraftRef.current = next;
    setGatewayDraft(next);
  }

  useEffect(() => {
    persistedGatewayRef.current = persistedGateway;
    if (gatewayPendingSaveCountRef.current === 0) {
      commitGatewayDraft(persistedGateway);
      setTokenDraft(persistedGateway.token);
    }
  }, [persistedGateway]);

  async function updateGateway(patch: Partial<AppSettings['openGateway']>): Promise<boolean> {
    const nextDraft = { ...gatewayDraftRef.current, ...patch };
    const ticket = gatewaySaveTicketRef.current + 1;
    gatewaySaveTicketRef.current = ticket;
    gatewayPendingSaveCountRef.current += 1;
    commitGatewayDraft(nextDraft);
    setSaving(true);
    try {
      const result = await props.onUpdate({ openGateway: patch });
      if (openGatewayMountedRef.current && ticket === gatewaySaveTicketRef.current) {
        commitGatewayDraft(result.settings.openGateway);
        setTokenDraft(result.settings.openGateway.token);
      }
      return openGatewayMountedRef.current;
    } catch (error) {
      if (openGatewayMountedRef.current && ticket === gatewaySaveTicketRef.current) {
        commitGatewayDraft(persistedGatewayRef.current);
        setTokenDraft(persistedGatewayRef.current.token);
        toast.error('保存开放网关设置失败', settingsActionErrorMessage(error));
      }
      return false;
    } finally {
      gatewayPendingSaveCountRef.current = Math.max(0, gatewayPendingSaveCountRef.current - 1);
      if (openGatewayMountedRef.current) {
        setSaving(gatewayPendingSaveCountRef.current > 0);
      }
    }
  }

  async function saveToken(nextToken = tokenDraft.trim()) {
    const saved = await updateGateway({ token: nextToken });
    if (!saved || !openGatewayMountedRef.current) return;
    toast.success(nextToken ? '网关 token 已保存' : '网关 token 已清空');
  }

  async function generateToken() {
    const token = generateGatewayToken();
    setTokenDraft(token);
    const saved = await updateGateway({ token });
    if (!saved || !openGatewayMountedRef.current) return;
    toast.success('网关 token 已生成', '本机 API 需要 Authorization Bearer token。');
  }

  async function copyGatewayText(action: string, text: string, successTitle: string, successDetail: string) {
    if (copyingGatewayActionRef.current) return;
    copyingGatewayActionRef.current = action;
    setCopyingGatewayAction(action);
    try {
      await navigator.clipboard.writeText(text);
      if (openGatewayMountedRef.current) {
        toast.success(successTitle, successDetail);
      }
    } catch {
      if (openGatewayMountedRef.current) {
        toast.error('复制失败', '剪贴板不可用或被系统拒绝。');
      }
    } finally {
      copyingGatewayActionRef.current = null;
      if (openGatewayMountedRef.current) {
        setCopyingGatewayAction(null);
      }
    }
  }

  async function copyBaseUrl() {
    const baseUrl = status?.baseUrl ?? gatewayBaseUrl(gatewayDraft.host, gatewayDraft.port);
    await copyGatewayText('base-url', baseUrl, '已复制网关地址', baseUrl);
  }

  const baseUrl = status?.baseUrl ?? gatewayBaseUrl(gatewayDraft.host, gatewayDraft.port);
  async function copyOverviewCurl() {
    const command = `curl -sS ${shellSingleQuote(`${baseUrl}/v1/state`)} -H ${shellSingleQuote(`Authorization: Bearer ${gatewayDraft.token}`)}`;
    await copyGatewayText('overview-curl', command, '已复制总览 curl', '可在终端验证开放网关状态。');
  }

  async function copyOpenApiCurl() {
    const command = `curl -sS ${shellSingleQuote(`${baseUrl}/v1/openapi.json`)} -H ${shellSingleQuote(`Authorization: Bearer ${gatewayDraft.token}`)}`;
    await copyGatewayText('openapi-curl', command, '已复制接口说明 curl', '可交给外部工具发现本机 API。');
  }

  async function copySessionStateCurl() {
    const sessionId = eventSessionId.trim() ? encodeURIComponent(eventSessionId.trim()) : '<SESSION_ID>';
    const command = `curl -sS ${shellSingleQuote(`${baseUrl}/v1/sessions/${sessionId}/state`)} -H ${shellSingleQuote(`Authorization: Bearer ${gatewayDraft.token}`)}`;
    await copyGatewayText('session-state-curl', command, '已复制单会话状态 curl', sessionId === '<SESSION_ID>' ? '把 <SESSION_ID> 替换成目标会话 ID 后运行。' : '可在终端查看单个会话状态。');
  }

  async function copyEventStreamCurl() {
    const sessionId = eventSessionId.trim() ? encodeURIComponent(eventSessionId.trim()) : '<SESSION_ID>';
    const command = [
      'curl -N -sS',
      shellSingleQuote(`${baseUrl}/v1/sessions/${sessionId}/events`),
      '-H',
      shellSingleQuote(`Authorization: Bearer ${gatewayDraft.token}`),
      '-H',
      shellSingleQuote('Accept: text/event-stream'),
    ].join(' ');
    await copyGatewayText('event-stream-curl', command, '已复制事件流 curl', sessionId === '<SESSION_ID>' ? '把 <SESSION_ID> 替换成目标会话 ID 后运行。' : '可在终端观察当前会话事件。');
  }

  async function copyRecentEventsCurl() {
    const sessionId = eventSessionId.trim() ? encodeURIComponent(eventSessionId.trim()) : '<SESSION_ID>';
    const command = `curl -sS ${shellSingleQuote(`${baseUrl}/v1/sessions/${sessionId}/events/recent`)} -H ${shellSingleQuote(`Authorization: Bearer ${gatewayDraft.token}`)}`;
    await copyGatewayText('recent-events-curl', command, '已复制最近事件 curl', sessionId === '<SESSION_ID>' ? '把 <SESSION_ID> 替换成目标会话 ID 后运行。' : '可在终端查看最近事件摘要。');
  }

  async function copyRecentRequestsCurl() {
    const command = `curl -sS ${shellSingleQuote(`${baseUrl}/v1/requests/recent`)} -H ${shellSingleQuote(`Authorization: Bearer ${gatewayDraft.token}`)}`;
    await copyGatewayText('recent-requests-curl', command, '已复制最近请求 curl', '可在终端查看网关请求元数据。');
  }

  const state = presentGatewayStatus(status, gatewayDraft);
  const isCopyingGatewayAction = (action: string) => copyingGatewayAction === action;
  const gatewayCopyDisabled = Boolean(copyingGatewayAction);

  return (
    <div className="settingsStructuredPage">
      <div className="settingsUsageSummary" role="group" aria-label="开放网关状态">
        <MetricCard title="状态" value={state.label} detail={state.detail} />
        <MetricCard title="监听地址" value={baseUrl} detail={gatewayDraft.host === '0.0.0.0' ? '局域网可访问' : '仅本机'} />
        <MetricCard title="访问凭据" value={gatewayDraft.token ? '已配置' : '等待 token'} detail="Bearer token 保护所有 /v1 API" />
        <MetricCard title="实时连接" value={String(status?.activeEventStreams ?? 0)} detail="SSE 客户端" />
        <MetricCard title="能力" value="19 个端点" detail="/health · openapi · state · sessions · events · requests" />
      </div>
      {statusLoadError && (
        <div className="settingsNotice" role="alert">
          开放网关运行状态读取失败：{statusLoadError}
        </div>
      )}

      <div className="settingsFormRow">
        <div>
          <strong>开放本机 API 网关</strong>
          <small>启动一个本机 HTTP 服务，让外部工具读取会话、消息和本地搜索结果。</small>
        </div>
        <Switch
          ariaLabel="开放本机 API 网关"
          checked={gatewayDraft.enabled}
          onChange={(enabled) => void updateGateway({ enabled })}
        />
      </div>

      <div className="settingsFormGrid settingsFormGridProxy">
        <label>
          <span>监听地址</span>
          <select
            value={gatewayDraft.host}
            onChange={(event) => void updateGateway({ host: event.currentTarget.value as AppSettings['openGateway']['host'] })}
            aria-label="开放网关监听地址"
          >
            <option value="127.0.0.1">127.0.0.1</option>
            <option value="0.0.0.0">0.0.0.0</option>
          </select>
        </label>
        <label>
          <span>端口</span>
          <input
            value={String(gatewayDraft.port)}
            inputMode="numeric"
            onChange={(event) => void updateGateway({ port: Number(event.currentTarget.value) || 3939 })}
            aria-label="开放网关端口"
          />
        </label>
        <label>
          <span>访问 token</span>
          <PasswordInput
            value={tokenDraft}
            onChange={setTokenDraft}
            disabled={saving}
            onBlur={() => {
              if (tokenDraft !== gatewayDraft.token) void saveToken();
            }}
            placeholder="生成或输入 token"
            ariaLabel="开放网关访问 token"
          />
        </label>
        <label>
          <span>会话 sessionId</span>
          <input
            value={eventSessionId}
            disabled={saving}
            placeholder="留空则复制 <SESSION_ID> 模板"
            onChange={(event) => setEventSessionId(event.currentTarget.value)}
            aria-label="开放网关会话 sessionId"
          />
        </label>
      </div>

      {gatewayDraft.enabled && !gatewayDraft.token && (
        <div className="settingsNotice" data-tone="passive">
          网关已开启，等待生成访问 token。生成 token 后服务会自动启动。
        </div>
      )}
      {status?.lastError && (
        <div className="settingsNotice">
          启动状态：{gatewayErrorCopy(status.lastError)}
        </div>
      )}

      <div className="settingsActionRow" role="group" aria-label="开放网关操作">
        <button className="maka-button" type="button" disabled={saving} onClick={() => void generateToken()}>
          生成 token
        </button>
        <button className="maka-button secondary" type="button" disabled={!gatewayDraft.token || saving} onClick={() => void saveToken('')}>
          清空 token
        </button>
        <button className="maka-button secondary" type="button" disabled={gatewayCopyDisabled} onClick={() => void copyBaseUrl()}>
          {isCopyingGatewayAction('base-url') ? '复制中…' : '复制地址'}
        </button>
        <button className="maka-button secondary" type="button" disabled={!gatewayDraft.token || gatewayCopyDisabled} onClick={() => void copyOverviewCurl()}>
          {isCopyingGatewayAction('overview-curl') ? '复制中…' : '复制总览 curl'}
        </button>
        <button className="maka-button secondary" type="button" disabled={!gatewayDraft.token || gatewayCopyDisabled} onClick={() => void copyOpenApiCurl()}>
          {isCopyingGatewayAction('openapi-curl') ? '复制中…' : '复制接口说明 curl'}
        </button>
        <button className="maka-button secondary" type="button" disabled={!gatewayDraft.token || gatewayCopyDisabled} onClick={() => void copySessionStateCurl()}>
          {isCopyingGatewayAction('session-state-curl') ? '复制中…' : '复制单会话状态 curl'}
        </button>
        <button className="maka-button secondary" type="button" disabled={!gatewayDraft.token || gatewayCopyDisabled} onClick={() => void copyEventStreamCurl()}>
          {isCopyingGatewayAction('event-stream-curl') ? '复制中…' : '复制事件流 curl'}
        </button>
        <button className="maka-button secondary" type="button" disabled={!gatewayDraft.token || gatewayCopyDisabled} onClick={() => void copyRecentEventsCurl()}>
          {isCopyingGatewayAction('recent-events-curl') ? '复制中…' : '复制最近事件 curl'}
        </button>
        <button className="maka-button secondary" type="button" disabled={!gatewayDraft.token || gatewayCopyDisabled} onClick={() => void copyRecentRequestsCurl()}>
          {isCopyingGatewayAction('recent-requests-curl') ? '复制中…' : '复制最近请求 curl'}
        </button>
      </div>

      <SettingsRows>
        <SettingRow title="健康检查" detail="不需要 token，用于确认网关进程是否启动。" value="GET /health" />
        <SettingRow title="接口说明" detail="需要 Bearer token，返回 OpenAPI 3.1 描述，方便外部工具自动发现开放网关能力。" value="GET /v1/openapi.json" />
        <SettingRow title="总览状态" detail="需要 Bearer token，返回网关运行态、会话状态、请求状态、失败索引状态和能力清单，不含正文或预览。" value="GET /v1/state" />
        <SettingRow title="能力清单" detail="需要 Bearer token，返回当前开放的本机 API 能力。" value="GET /v1/capabilities" />
        <SettingRow title="会话列表" detail="需要 Bearer token，返回本地 session summary。" value="GET /v1/sessions" />
        <SettingRow title="会话状态" detail="需要 Bearer token，返回会话数量、未读数、状态分布和最近失败计数，不含标题或预览。" value="GET /v1/sessions/state" />
        <SettingRow title="单会话状态" detail="需要 Bearer token，返回单个会话的状态、消息计数、事件缓冲和失败计数，不含标题、正文或预览。" value="GET /v1/sessions/:id/state" />
        <SettingRow title="会话消息" detail="需要 Bearer token，按 sessionId 读取本地消息；支持 limit / before 分页。" value="GET /v1/sessions/:id/messages" />
        <SettingRow title="消息状态" detail="需要 Bearer token，返回消息数量和边界摘要，不含正文。" value="GET /v1/sessions/:id/messages/state" />
        <SettingRow title="发送消息" detail="需要 Bearer token，向已有会话追加一条用户消息并返回 turnId。" value="POST /v1/sessions/:id/messages" />
        <SettingRow title="实时事件" detail="需要 Bearer token，SSE 输出当前会话 live 事件；支持 Last-Event-ID / after 补发最近事件。" value="GET /v1/sessions/:id/events" />
        <SettingRow title="事件状态" detail="需要 Bearer token，返回当前事件 replay buffer 和实时连接状态，不含事件正文。" value="GET /v1/sessions/:id/events/state" />
        <SettingRow title="最近事件摘要" detail="需要 Bearer token，返回当前会话最近事件的 id、类型、turnId 和时间，不含事件正文。" value="GET /v1/sessions/:id/events/recent" />
        <SettingRow title="全局事件状态" detail="需要 Bearer token，跨会话返回事件 replay buffer 和实时连接聚合状态，不含事件正文。" value="GET /v1/events/state" />
        <SettingRow title="最近请求" detail="需要 Bearer token，返回最近网关请求的 requestId、方法、路径、状态码和耗时，不含 query、header 或 body。" value="GET /v1/requests/recent" />
        <SettingRow title="失败记录" detail="需要 Bearer token，返回最近错误和中断摘要，用于外部恢复面板。" value="GET /v1/sessions/:id/incidents" />
        <SettingRow title="失败索引" detail="需要 Bearer token，跨会话返回最近错误和中断摘要。" value="GET /v1/incidents" />
        <SettingRow title="失败索引状态" detail="需要 Bearer token，跨会话返回最近失败总数、涉及会话数和边界摘要。" value="GET /v1/incidents/state" />
        <SettingRow title="本地搜索" detail="需要 Bearer token，复用 Maka 的 thread search。" value="GET /v1/search/thread?q=..." />
      </SettingsRows>

      <p className="settingsHelpText">
        /v1 接口默认关闭且都需要 token；发送消息会走当前会话的模型和权限边界。把监听地址设成 0.0.0.0 会让同一局域网设备可访问，请只在可信网络中使用。
      </p>
    </div>
  );
}

function gatewayBaseUrl(host: AppSettings['openGateway']['host'], port: number): string {
  return `http://${host}:${port}`;
}

function shellSingleQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function presentGatewayStatus(
  status: OpenGatewayRuntimeStatus | null,
  settings: AppSettings['openGateway'],
): { label: string; detail: string } {
  if (!settings.enabled) return { label: '已关闭', detail: '设置开关关闭' };
  if (!settings.token) return { label: '等待 token', detail: '生成访问 token 后服务会自动启动' };
  if (!status) return { label: '读取中', detail: '正在读取运行状态' };
  if (status.running) return { label: '运行中', detail: status.startedAt ? '本机 API 已启动' : '服务已监听' };
  return { label: '启动失败', detail: gatewayErrorCopy(status.lastError ?? 'gateway_start_failed') };
}

function gatewayErrorCopy(error: string): string {
  if (error === 'missing_token') return '等待生成访问 token';
  if (error === 'start_failed' || error === 'gateway_start_failed') return '开放网关暂时无法启动，请检查监听地址和端口。';
  if (error.includes('EADDRINUSE')) return '端口已被占用';
  return '开放网关暂时无法启动，请检查监听地址和端口。';
}

function generateGatewayToken(): string {
  const bytes = new Uint8Array(24);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
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
  type BotPendingActionName = 'test' | 'connect' | 'restart' | 'disconnect';
  type BotPendingAction = { provider: BotProvider; action: BotPendingActionName };

  const [selected, setSelected] = useState<BotProvider>('telegram');
  const [pendingBotAction, setPendingBotAction] = useState<BotPendingAction | null>(null);
  const [scanLoginOpen, setScanLoginOpen] = useState(false);
  const [wechatQrOpen, setWechatQrOpen] = useState(false);
  const [statuses, setStatuses] = useState<Record<BotProvider, BotStatus> | null>(null);
  const [statusLoadError, setStatusLoadError] = useState<string | null>(null);
  const channel = props.settings.botChat.channels[selected];
  const toast = useToast();
  const selectedStatus = statuses?.[selected];
  const pendingBotActionRef = useRef<BotPendingAction | null>(null);
  const botPageMountedRef = useRef(false);
  const botActionBusy = pendingBotAction !== null;
  const selectedBotActionPending = pendingBotAction?.provider === selected ? pendingBotAction.action : null;
  const testing = selectedBotActionPending === 'test' || selectedBotActionPending === 'connect';
  const restarting = selectedBotActionPending === 'restart';

  useEffect(() => {
    botPageMountedRef.current = true;
    return () => {
      botPageMountedRef.current = false;
      pendingBotActionRef.current = null;
    };
  }, []);

  function beginBotAction(provider: BotProvider, action: BotPendingActionName): boolean {
    if (pendingBotActionRef.current !== null) return false;
    const next = { provider, action };
    pendingBotActionRef.current = next;
    setPendingBotAction(next);
    return true;
  }

  function finishBotAction(provider: BotProvider, action: BotPendingActionName) {
    const current = pendingBotActionRef.current;
    if (!current || current.provider !== provider || current.action !== action) return;
    pendingBotActionRef.current = null;
    if (botPageMountedRef.current) {
      setPendingBotAction(null);
    }
  }

  async function updateChannelFor(provider: BotProvider, patch: Partial<typeof channel>): Promise<boolean> {
    try {
      await props.onUpdate({ botChat: { channels: { [provider]: patch } } });
      if (!botPageMountedRef.current) return false;
      return true;
    } catch (error) {
      if (botPageMountedRef.current) {
        toast.error(`${BOT_LABELS[provider].label} 保存失败`, settingsActionErrorMessage(error));
      }
      return false;
    }
  }

  async function updateChannel(patch: Partial<typeof channel>): Promise<boolean> {
    return updateChannelFor(selected, patch);
  }

  useEffect(() => {
    let active = true;
    void window.maka.settings.bots.listStatuses().then((next) => {
      if (!active) return;
      setStatuses(next);
      setStatusLoadError(null);
    }).catch((error) => {
      if (!active) return;
      const message = settingsActionErrorMessage(error);
      setStatusLoadError(message);
      toast.error('载入机器人运行状态失败', message);
    });
    const unsubscribe = window.maka.settings.bots.subscribeStatusChanges((status) => {
      if (!botPageMountedRef.current) return;
      setStatusLoadError(null);
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
    const provider = selected;
    if (!beginBotAction(provider, 'test')) return;
    try {
      const result = await window.maka.settings.testBotChannel(provider);
      if (!botPageMountedRef.current) return;
      const platform = BOT_LABELS[provider].label;
      if (result.ok) {
        // PR-BOT-CHAT-POLISH-0: title now matches kenji boundary 2's
        // 5-state readiness chain — a successful test PROVES
        // `credentials_valid`, NOT `operational`. The detail copy
        // still carries the IPC-side message so the user can see
        // latency / identity etc.
        toast.success(`${platform} 凭据已验证`, result.message);
      } else {
        toast.error(`${platform} 凭据测试失败`, result.message);
      }
      await refreshBotStatuses();
    } catch (error) {
      if (botPageMountedRef.current) {
        toast.error(`${BOT_LABELS[provider].label} 测试出错`, settingsActionErrorMessage(error));
      }
    } finally {
      finishBotAction(provider, 'test');
    }
  }

  /**
   * PR-BOT-SETTINGS-UI-0 (WAWQAQ msg `51c7b4ff`): combined "测试并连接"
   * action mirrors the reference design's primary CTA. Runs credential
   * test, then on success flips the enable toggle on and starts the
   * listener. On test failure stops at the credential step — does NOT
   * flip the toggle, so the user can fix the credentials and retry.
   */
  async function testAndConnect() {
    const provider = selected;
    const providerChannel = props.settings.botChat.channels[provider];
    const providerSupport = BOT_LABELS[provider].support;
    if (!beginBotAction(provider, 'connect')) return;
    let testOk = false;
    try {
      const result = await window.maka.settings.testBotChannel(provider);
      if (!botPageMountedRef.current) return;
      const platform = BOT_LABELS[provider].label;
      testOk = result.ok;
      if (result.ok) {
        toast.success(`${platform} 凭据已验证`, result.message);
      } else {
        toast.error(`${platform} 凭据测试失败`, result.message);
      }
      await refreshBotStatuses();
    } catch (error) {
      if (botPageMountedRef.current) {
        toast.error(`${BOT_LABELS[provider].label} 测试出错`, settingsActionErrorMessage(error));
      }
      finishBotAction(provider, 'connect');
      return;
    }
    try {
      if (!botPageMountedRef.current) return;
      if (!testOk || providerSupport !== 'runtime') return;
      if (!providerChannel.enabled) {
        const saved = await updateChannelFor(provider, { enabled: true });
        if (!saved) return;
      }
      if (!botPageMountedRef.current) return;
      await restartBotProvider(provider);
    } finally {
      finishBotAction(provider, 'connect');
    }
  }

  async function restartBotProvider(provider: BotProvider): Promise<boolean> {
    if (!botPageMountedRef.current) return false;
    try {
      const status = await window.maka.settings.bots.restart(provider);
      if (!botPageMountedRef.current) return status.running;
      setStatuses((current) => ({
        ...(current ?? ({} as Record<BotProvider, BotStatus>)),
        [status.platform]: status,
      }));
      // PR-BOT-CHAT-POLISH-0: tone follows actual runtime state, not
      // the bare fact that the restart command returned. A restarted
      // bot that immediately stops (e.g. token rejected, network
      // down) was previously surfaced as a green success toast.
      const platform = BOT_LABELS[provider].label;
      if (status.running) {
        toast.success(`${platform} 已开始监听`, botStatusDetail(status));
      } else {
        toast.error(`${platform} 启动后未进入监听`, botStatusDetail(status));
      }
      return status.running;
    } catch (error) {
      if (!botPageMountedRef.current) return false;
      const message = settingsActionErrorMessage(error);
      toast.error(`${BOT_LABELS[provider].label} 启动失败`, message);
      return false;
    }
  }

  async function restartChannel() {
    const provider = selected;
    if (!beginBotAction(provider, 'restart')) return;
    try {
      await restartBotProvider(provider);
    } finally {
      finishBotAction(provider, 'restart');
    }
  }

  async function refreshBotStatuses(): Promise<boolean> {
    if (!botPageMountedRef.current) return false;
    try {
      await props.onReload();
      if (!botPageMountedRef.current) return false;
      const nextStatuses = await window.maka.settings.bots.listStatuses();
      if (!botPageMountedRef.current) return false;
      setStatuses(nextStatuses);
      setStatusLoadError(null);
      return true;
    } catch (error) {
      if (!botPageMountedRef.current) return false;
      const message = settingsActionErrorMessage(error);
      setStatusLoadError(message);
      toast.error('刷新机器人运行状态失败', message);
      return false;
    }
  }

  async function disconnectWechatLogin() {
    const provider = selected;
    const providerChannel = props.settings.botChat.channels[provider];
    if (!beginBotAction(provider, 'disconnect')) return;
    try {
      const ok = await toast.confirm({
        title: '断开微信登录？',
        description: '将清除本机保存的扫码登录凭据，之后需要重新扫码才能继续使用微信机器人。',
        confirmLabel: '断开登录',
        cancelLabel: '取消',
        destructive: true,
      });
      if (!ok) return;
      const isIlink = providerChannel.webhookUrl?.trim().startsWith('https://ilinkai.weixin.qq.com') ?? false;
      const saved = await updateChannelFor(provider, {
        token: '',
        ...(isIlink ? { webhookUrl: '' } : {}),
        botUserId: undefined,
        connected: false,
        readiness: 'scaffolded',
        readinessReason: undefined,
        readinessUpdatedAt: Date.now(),
        lastError: undefined,
      });
      if (!saved) return;
      if (!botPageMountedRef.current) return;
      await refreshBotStatuses();
      if (botPageMountedRef.current) {
        toast.success('微信登录已断开', '本机扫码登录凭据已清除。');
      }
    } finally {
      finishBotAction(provider, 'disconnect');
    }
  }

  const support = BOT_LABELS[selected].support;
  const readiness = support === 'credentials'
    ? channel.readiness
    : selectedStatus?.readiness ?? channel.readiness;
  const copy = botReadinessCopyForSupport(support, readiness);
  const enableSwitchDisabled = support === 'planned' || (!channel.enabled && !canEnableBotChannel(readiness));
  const enableSwitchHint = support === 'planned'
    ? '该平台未开放，暂不能启用。'
    : !channel.enabled && !canEnableBotChannel(readiness)
      ? '先测试并连接后才能启用。'
      : undefined;
  const enableSwitchHintId = `settings-bot-enable-hint-${selected}`;

  return (
    <div className="settingsBotLayout">
      <nav className="settingsBotList" aria-label="机器人频道列表">
        {BOT_PROVIDERS.map((provider) => {
          const status = statuses?.[provider];
          const providerSupport = BOT_LABELS[provider].support;
          const providerChannel = props.settings.botChat.channels[provider];
          const providerCopy = botReadinessCopyForSupport(
            providerSupport,
            providerSupport === 'credentials'
              ? providerChannel.readiness
              : status?.readiness ?? providerChannel.readiness,
          );
          // PR-BOT-SETTINGS-UI-0 (WAWQAQ msg `51c7b4ff`): the platform
          // brand logo carries a small bottom-right status badge so the
          // user can scan the list and see which channels are live.
          // Badge tone tracks the same readiness tone the row label uses.
          const providerReadiness = providerSupport === 'credentials'
            ? providerChannel.readiness
            : status?.readiness ?? providerChannel.readiness;
          return (
            <button
              key={provider}
              type="button"
              data-active={selected === provider}
              data-support={providerSupport}
              aria-current={selected === provider ? 'page' : undefined}
              disabled={botActionBusy}
              onClick={() => {
                setSelected(provider);
              }}
            >
              <BotBrandLogo provider={provider} readiness={providerReadiness} support={providerSupport} />
              <span>{BOT_LABELS[provider].label}</span>
              <em data-tone={providerCopy.tone}>{providerCopy.label}</em>
            </button>
          );
        })}
      </nav>

      <section className="settingsBotDetail">
        {/* PR-BOT-SETTINGS-UI-0 (WAWQAQ msg `51c7b4ff`): brand-tinted hero
            card mirrors the reference design — brand logo + name + status
            pill + one-line help with inline config doc link, enable toggle
            at right. The card background uses the brand color at ~6%
            alpha so the platform identity is visible without overpowering
            the form below. */}
        <div className="settingsBotHero" data-provider={selected} data-support={support}>
          <BotBrandLogo provider={selected} readiness={readiness} support={support} size="large" />
          <div className="settingsBotHeroBody">
            <h3>
              {BOT_LABELS[selected].label}
              <BotStatusPill tone={copy.tone} label={copy.label} />
            </h3>
            <small>
              {BOT_LABELS[selected].help}
              {BOT_BRAND[selected].configDocUrl && (
                <>
                  {' '}
                  <a
                    className="settingsBotConfigDocLink"
                    href={BOT_BRAND[selected].configDocUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    查看配置文档 →
                  </a>
                </>
              )}
            </small>
            {enableSwitchHint && (
              <small id={enableSwitchHintId} className="settingsBotEnableHint">
                {enableSwitchHint}
              </small>
            )}
          </div>
          <Switch
            ariaLabel={`启用${BOT_LABELS[selected].label}机器人`}
            ariaDescribedBy={enableSwitchHint ? enableSwitchHintId : undefined}
            checked={channel.enabled}
            onChange={(enabled) => updateChannel({ enabled })}
            disabled={enableSwitchDisabled || botActionBusy}
          />
        </div>

        {/* PR-BOT-WECHAT-SCAN-LOGIN-0 (WAWQAQ msg `2fa6ada6` screenshots):
            each platform's fields, labels, placeholders and notices
            rewritten to match the reference design 1:1. The previous
            implementations diverged with technical wording, extra
            fields, and missing TUN-mode amber notices. */}
        {selected === 'telegram' && (
          <>
            <label className="settingsField">
              <span>Bot Token</span>
              <PasswordInput value={channel.token} onChange={(next) => updateChannel({ token: next })} placeholder="123456:ABC-DEF..." ariaLabel="Telegram Bot Token" />
            </label>
            <label className="settingsField">
              <span>代理地址 <em className="settingsFieldHint">(国内网络必填)</em></span>
              <input value={channel.proxyUrl} onChange={(event) => updateChannel({ proxyUrl: event.currentTarget.value })} placeholder="http://127.0.0.1:7890" aria-label="Telegram 代理地址" />
            </label>
            <BotAllowedUserIdsField
              value={channel.allowedUserIds}
              onChange={(next) => updateChannel({ allowedUserIds: next })}
            />
            <div className="settingsBotInfoNotice">
              <span className="settingsBotInfoNoticeIcon" aria-hidden="true">ⓘ</span>
              <span>提示：请打开网络的 TUN 模式后重启应用，以便完成 Telegram Bot 设置</span>
            </div>
          </>
        )}

        {selected === 'feishu' && (
          <>
            <label className="settingsField">
              <span>App ID</span>
              <input aria-label="飞书凭据 ID" value={channel.appId ?? ''} onChange={(event) => updateChannel({ appId: event.currentTarget.value })} placeholder="cli_xxxx" />
            </label>
            <label className="settingsField">
              <span>App Secret</span>
              <PasswordInput value={channel.appSecret ?? ''} onChange={(next) => updateChannel({ appSecret: next })} placeholder="xxxx" ariaLabel="飞书 App Secret" />
            </label>
            <label className="settingsField">
              <span>域名</span>
              <select
                className="settingsBotDomainSelect"
                value={channel.domain ?? 'feishu.cn'}
                onChange={(event) => updateChannel({ domain: event.currentTarget.value })}
                aria-label="飞书域名"
              >
                <option value="feishu.cn">飞书 (feishu.cn)</option>
                <option value="larksuite.com">Lark (larksuite.com)</option>
              </select>
            </label>
          </>
        )}

        {selected === 'discord' && (
          <>
            <label className="settingsField">
              <span>Bot Token</span>
              <PasswordInput value={channel.token} onChange={(next) => updateChannel({ token: next })} placeholder="MTAx..." ariaLabel="Discord Bot Token" />
            </label>
            <label className="settingsField">
              <span>代理地址 <em className="settingsFieldHint">(仅用于 Bot 鉴权)</em></span>
              <input value={channel.proxyUrl} onChange={(event) => updateChannel({ proxyUrl: event.currentTarget.value })} placeholder="http://127.0.0.1:7890" aria-label="Discord 代理地址" />
            </label>
            <div className="settingsBotInfoNotice">
              <span className="settingsBotInfoNoticeIcon" aria-hidden="true">ⓘ</span>
              <span>国内网络访问 Discord：上方代理仅作用于 Bot 鉴权请求，消息收发走 WebSocket 长连接需要系统级代理。请打开网络的 TUN 模式后重启应用。</span>
            </div>
          </>
        )}

        {selected === 'dingtalk' && (
          <>
            <label className="settingsField">
              <span>Client ID (AppKey)</span>
              <input aria-label="钉钉应用密钥" value={channel.appId ?? ''} onChange={(event) => updateChannel({ appId: event.currentTarget.value })} placeholder="dingxxxxxxxx" />
            </label>
            <label className="settingsField">
              <span>Client Secret (AppSecret)</span>
              <PasswordInput value={channel.appSecret ?? ''} onChange={(next) => updateChannel({ appSecret: next })} placeholder="xxxx" ariaLabel="钉钉 Client Secret" />
            </label>
          </>
        )}

        {selected === 'wecom' && (
          <>
            <label className="settingsField">
              <span>Bot ID</span>
              <input value={channel.appId ?? ''} onChange={(event) => updateChannel({ appId: event.currentTarget.value })} placeholder="企业微信 AI 应用 Bot ID" aria-label="企业微信 Bot ID" />
            </label>
            <label className="settingsField">
              <span>Secret</span>
              <PasswordInput value={channel.appSecret ?? ''} onChange={(next) => updateChannel({ appSecret: next })} placeholder="AI 应用 Secret" ariaLabel="企业微信 Secret" />
            </label>
          </>
        )}

        {/* PR-BOT-WECHAT-SCAN-LOGIN-0 (WAWQAQ msg `1d9c412e`): WeChat
            personal account integration. Reference design uses ONE
            Bot Token field for the local bridge connection + a
            scan-login affordance. 公众号 (App ID / App Secret) and
            advanced bridge URL stay available behind a collapsed
            「高级设置」section so runtime backward compatibility is
            preserved. */}
        {selected === 'wechat' && (
          <BotWeChatFields channel={channel} updateChannel={updateChannel} />
        )}

        {selected === 'qq' && (
          <>
            <label className="settingsField">
              <span>AppID</span>
              <input aria-label="QQ 应用编号" value={channel.appId ?? ''} onChange={(event) => updateChannel({ appId: event.currentTarget.value })} placeholder="102xxxxxx" />
            </label>
            <label className="settingsField">
              <span>AppSecret</span>
              <PasswordInput value={channel.appSecret ?? ''} onChange={(next) => updateChannel({ appSecret: next })} placeholder="xxxx" ariaLabel="QQ AppSecret" />
            </label>
          </>
        )}

        {support === 'planned' && (
          <div className="settingsNotice" data-tone="passive">
            这个平台当前只作为平台清单展示，不会进入可用机器人列表，也不会保存为计划提醒投递目标。
          </div>
        )}

        <dl className="settingsBotStatusGrid" aria-label={`${BOT_LABELS[selected].label}运行状态`}>
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
            <dd>
              {selectedStatus?.lastEventAt ? (
                <RelativeTime
                  ts={selectedStatus.lastEventAt}
                  className="settingsBotMetaTime"
                />
              ) : (
                '暂无'
              )}
            </dd>
          </div>
          <div>
            <dt>最近一次测试</dt>
            <dd>
              {channel.lastTestAt ? (
                <RelativeTime
                  ts={channel.lastTestAt}
                  className="settingsBotMetaTime"
                />
              ) : (
                '从未测试'
              )}
            </dd>
          </div>
        </dl>

        {statusLoadError && (
          <div className="settingsBotReason" data-tone="error" role="alert">
            机器人运行状态刷新失败：{statusLoadError}
          </div>
        )}
        {selectedStatus?.reason && <div className="settingsBotReason">{botStatusDetail(selectedStatus)}</div>}

        {/* PR-BOT-CHAT-POLISH-0: surface the last persisted test error
            so the user does not have to remember the toast that just
            faded out. `channel.lastError` is written by the IPC test
            handler regardless of why the test failed. */}
        {channel.lastError && support !== 'planned' && (
          <div className="settingsBotReason" data-tone="error" role="alert">
            上次测试失败：{channel.lastError}
          </div>
        )}

        {/* WeChat keeps scan login as a first-class action, separate from
            connection testing, because QR generation and listener readiness
            are different states. */}
        {scanLoginOpen && (
          <WeChatScanLoginModal
            onClose={() => setScanLoginOpen(false)}
            onConfirmed={async (credentials) => {
              const saved = await updateChannel({
                token: credentials.botToken,
                webhookUrl: credentials.baseUrl,
                botUserId: credentials.botId,
              });
              if (!saved) return;
              await props.onReload();
              if (!botPageMountedRef.current) return;
              setScanLoginOpen(false);
              toast.success('微信已扫码登录', credentials.botId ? `Bot ID ${credentials.botId}` : '凭据已保存');
            }}
          />
        )}
        <div className="settingsBotActionStack" role="group" aria-label={`${BOT_LABELS[selected].label}机器人操作`}>
          {selected === 'wechat' ? (
            <>
              <button
                className="settingsBotAction"
                type="button"
                disabled={botActionBusy}
                onClick={() => setScanLoginOpen(true)}
              >
                扫码登录
              </button>
              {(channel.token || selectedStatus?.identity) && (
                <button
                  className="settingsBotAction"
                  type="button"
                  disabled={botActionBusy}
                  onClick={() => void disconnectWechatLogin()}
                >
                  {selectedBotActionPending === 'disconnect' ? '断开中…' : '断开微信登录'}
                </button>
              )}
              <button
                className="settingsBotAction"
                type="button"
                disabled={botActionBusy}
                onClick={() => setWechatQrOpen(true)}
              >
                本机桥接二维码
              </button>
              <button
                className="settingsBotAction"
                type="button"
                disabled={botActionBusy}
                onClick={testChannel}
              >
                {selectedBotActionPending === 'test' ? '测试中…' : '测试连接'}
              </button>
            </>
          ) : support === 'runtime' && !selectedStatus?.running ? (
            <button
              className="settingsBotAction"
              type="button"
              disabled={botActionBusy}
              onClick={testAndConnect}
            >
              {selectedBotActionPending === 'connect' ? '连接中…' : '测试并连接'}
            </button>
          ) : (
            <button className="settingsBotAction" type="button" disabled={botActionBusy || support === 'planned'} onClick={testChannel}>
              {selectedBotActionPending === 'test' ? '测试中…' : support === 'runtime' ? '测试连接' : '测试并连接'}
            </button>
          )}
          {/* PR-BOT-RESTART-RACE-0: keep the restart button mounted
              while a restart is in-flight, even if the bridge's
              running flag transiently flips false during the
              stop→start cycle inside reconcileOne. Otherwise
              `disabled={restarting}` does nothing because the whole
              button unmounts mid-click and the user sees no
              resolution feedback. */}
          {support === 'runtime' && (selectedStatus?.running || restarting) && selected !== 'wechat' && (
            <button className="settingsBotAction" type="button" disabled={botActionBusy} onClick={restartChannel}>
              {restarting ? '重启中…' : '重启监听'}
            </button>
          )}
        </div>
        {wechatQrOpen && (
          <WechatQrLoginModal
            onClose={() => setWechatQrOpen(false)}
            onRefreshStatuses={refreshBotStatuses}
          />
        )}
      </section>
    </div>
  );
}

/**
 * PR-BOT-USER-ALLOWLIST-UI-0 — textarea bound to
 * `BotChannelSettings.allowedUserIds`. Empty / blank lines are stripped;
 * duplicates are dedup'd; entries are trimmed; the list is capped at
 * `MAX_ALLOWED_USER_IDS`. Empty array is forwarded as `undefined` so the
 * settings persist layer sees the "no restriction" default sentinel.
 *
 * Local-only buffer state: the user can type a value mid-edit (e.g.
 * `1234567`) without the in-progress short ID being dropped by the
 * parse function. We only emit the parsed array on commit (onBlur).
 */
function BotAllowedUserIdsField(props: {
  value: ReadonlyArray<string> | undefined;
  onChange(next: ReadonlyArray<string> | undefined): void;
}): ReactNode {
  const persisted = props.value ?? [];
  const [buffer, setBuffer] = useState<string>(persisted.join('\n'));

  // Reset the buffer when the persisted value changes from outside
  // (e.g. settings reload). Compare by join so identity differences
  // do not cause noisy resets.
  useEffect(() => {
    const next = persisted.join('\n');
    if (next !== buffer) {
      setBuffer(next);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [persisted.join('\n')]);

  const parsed = useMemo(() => parseAllowedUserIdsFromText(buffer), [buffer]);
  const atCap = parsed.length >= MAX_ALLOWED_USER_IDS;
  // PR-BOT-ALLOWLIST-INVALID-ID-WARN-0: Telegram user IDs are decimal
  // integers (e.g. `123456789`). Common mistake is pasting `@alice`
  // (username) instead — that string will persist and silently never
  // match anyone. Surface the invalid entries so the user can fix them.
  // Persistence is NOT enforced here (normalize still accepts any
  // non-empty string) — the gate is informational so a power user
  // tracking a non-Telegram platform later is not blocked.
  const invalidEntries = useMemo(
    () => parsed.filter((id) => !/^[0-9]+$/.test(id)),
    [parsed],
  );

  const commit = (): void => {
    const next = parsed.length === 0 ? undefined : parsed;
    const same =
      (next?.length ?? 0) === persisted.length &&
      (next ?? []).every((id, idx) => id === persisted[idx]);
    if (!same) props.onChange(next);
  };

  return (
    <label className="settingsField">
      <span>允许的用户 ID（{parsed.length} / {MAX_ALLOWED_USER_IDS}）</span>
      <textarea
        value={buffer}
        onChange={(event) => setBuffer(event.currentTarget.value)}
        onBlur={commit}
        rows={3}
        spellCheck={false}
        placeholder={'每行一个用户 ID，留空表示不限\n例如：123456789'}
        aria-label="允许的用户 ID"
      />
      <small>
        Telegram 用户 ID 是 64 位整数；填入后只接收列表里这些 ID 的来信，其它人发的消息会被静默忽略（不会回弹任何提示）。
        {atCap && <strong>（已达到上限）</strong>}
        {invalidEntries.length > 0 && (
          <span className="settingsFieldWarning" data-tone="warning">
            下列不是数字 ID，可能是用户名之类的输入，匹配不到任何人：{invalidEntries.slice(0, 3).join('、')}
            {invalidEntries.length > 3 && ` 等 ${invalidEntries.length} 项`}
          </span>
        )}
      </small>
    </label>
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
    case 'no-token': return '等待填写 Bot Token';
    case 'missing-feishu-credentials': return '等待填写飞书 App ID 或 App Secret';
    case 'feishu-domain-required': return '飞书凭据有效，等待填写事件订阅域名';
    case 'feishu-events-not-connected': return '飞书凭据有效，等待事件回调接入';
    case 'scaffold-only': return '该平台当前不可作为可用机器人';
    case 'unimplemented': return '该平台当前不可作为可用机器人';
    case 'stopped': return '监听已停止';
    // PR-BOT-CHAT-POLISH-0: the previous fallback `status.reason ??
    // '暂无运行细节'` would surface a raw reason code (e.g.
    // `polling-timeout`) for any unmapped state. That's noise the
    // user can't act on; collapse to a generalized copy.
    default: return '运行态详情请见日志';
  }
}

function UsageSettingsPage(props: {
  settings: AppSettings;
  stats: UsageStats | null;
  onUpdate(patch: Parameters<typeof window.maka.settings.update>[0]): Promise<UpdateAppSettingsResult>;
  onReload(range?: UsageRange): Promise<void>;
  onOpenSession?(sessionId: string): void;
}) {
  const persistedUsage = props.settings.usage;
  const [usageDraft, setUsageDraft] = useState(persistedUsage);
  const [refreshing, setRefreshing] = useState(false);
  const usageDraftRef = useRef(persistedUsage);
  const persistedUsageRef = useRef(persistedUsage);
  const usagePendingSaveCountRef = useRef(0);
  const usageSaveTicketRef = useRef(0);
  const usageRefreshRunningRef = useRef(false);
  const usagePageMountedRef = useRef(false);
  const stats = props.stats;
  const toast = useToast();

  function commitUsageDraft(next: AppSettings['usage']) {
    usageDraftRef.current = next;
    setUsageDraft(next);
  }

  useEffect(() => {
    persistedUsageRef.current = persistedUsage;
    if (usagePendingSaveCountRef.current === 0) {
      commitUsageDraft(persistedUsage);
    }
  }, [persistedUsage]);

  useEffect(() => {
    usagePageMountedRef.current = true;
    return () => {
      usagePageMountedRef.current = false;
      usageSaveTicketRef.current += 1;
      usageRefreshRunningRef.current = false;
    };
  }, []);

  const normalizedModelFilter = usageDraft.modelFilter.trim().toLowerCase();
  const hasRequestFilters = usageDraft.status !== 'all' || normalizedModelFilter.length > 0;
  const showRequestDetails = usageDraft.activeTab === 'requests' && usageDraft.showDetails;
  const filteredLogs = useMemo(() => {
    const logs = stats?.logs ?? [];
    return logs
      .filter((log) => usageDraft.status === 'all' || log.status === usageDraft.status)
      .filter((log) =>
        normalizedModelFilter.length === 0 ||
        log.model.toLowerCase().includes(normalizedModelFilter) ||
        (log.toolName ?? '').toLowerCase().includes(normalizedModelFilter)
      );
  }, [stats, usageDraft.status, normalizedModelFilter]);

  async function setRange(range: UsageRange) {
    const saved = await updateUsage({ range });
    if (!saved || !usagePageMountedRef.current) return;
    await props.onReload(range);
  }

  async function updateUsage(patch: Partial<AppSettings['usage']>): Promise<boolean> {
    const nextDraft = { ...usageDraftRef.current, ...patch };
    const ticket = usageSaveTicketRef.current + 1;
    usageSaveTicketRef.current = ticket;
    usagePendingSaveCountRef.current += 1;
    commitUsageDraft(nextDraft);
    try {
      const result = await props.onUpdate({ usage: patch });
      if (usagePageMountedRef.current && ticket === usageSaveTicketRef.current) {
        commitUsageDraft(result.settings.usage);
      }
      return usagePageMountedRef.current && ticket === usageSaveTicketRef.current;
    } catch (error) {
      if (usagePageMountedRef.current && ticket === usageSaveTicketRef.current) {
        commitUsageDraft(persistedUsageRef.current);
        toast.error('保存使用统计设置失败', settingsActionErrorMessage(error));
      }
      return false;
    } finally {
      usagePendingSaveCountRef.current = Math.max(0, usagePendingSaveCountRef.current - 1);
    }
  }

  async function refresh() {
    if (usageRefreshRunningRef.current) return;
    usageRefreshRunningRef.current = true;
    setRefreshing(true);
    try {
      await props.onReload(usageDraftRef.current.range);
    } finally {
      usageRefreshRunningRef.current = false;
      if (usagePageMountedRef.current) {
        setRefreshing(false);
      }
    }
  }

  function clearRequestFilters() {
    void updateUsage({ status: 'all', modelFilter: '' });
  }

  return (
    <div className="settingsUsagePage">
      <div className="settingsUsageToolbar" role="group" aria-label="使用统计范围与刷新">
        <Segmented
          value={usageDraft.range}
          ariaLabel="使用统计时间范围"
          options={[
            ['24h', '24h'],
            ['7d', '7天'],
            ['30d', '30天'],
            ['all', '全部'],
          ]}
          onChange={(value) => void setRange(value as UsageRange)}
        />
        <button
          className="maka-button"
          type="button"
          disabled={refreshing}
          aria-busy={refreshing}
          data-pending={refreshing ? 'true' : undefined}
          onClick={() => void refresh()}
        >
          {refreshing ? '刷新中…' : '刷新'}
        </button>
      </div>

      <div className="settingsUsageSummary" role="group" aria-label="使用统计汇总指标">
        <MetricCard title="总请求" value={String(stats?.summary.totalRequests ?? 0)} />
        <MetricCard title="总费用" value={`$${(stats?.summary.totalCostUsd ?? 0).toFixed(2)}`} detail="以模型供应商最终结算为准" />
        <MetricCard title="总 Token" value={String(stats?.summary.totalTokens ?? 0)} detail={`输入 ${stats?.summary.inputTokens ?? 0} / 输出 ${stats?.summary.outputTokens ?? 0}`} />
        <MetricCard title="缓存 Token" value={String(stats?.summary.cacheTokens ?? 0)} detail={`命中 ${stats?.summary.cacheRead ?? 0} / 创建 ${stats?.summary.cacheCreation ?? 0}`} />
      </div>

      <Segmented
        value={usageDraft.activeTab}
        ariaLabel="使用统计视图"
        options={[
          ['requests', '请求日志'],
          ['providers', '供应商统计'],
          ['models', '模型统计'],
          ['tools', '工具统计'],
          ['pricing', '定价配置'],
        ]}
        onChange={(activeTab) => void updateUsage({ activeTab: activeTab as typeof usageDraft.activeTab })}
      />

      {usageDraft.activeTab === 'requests' && (
        <div className="settingsUsageFilters" role="group" aria-label="请求记录筛选">
          {usageDraft.showDetails && (
            <>
              <input value={usageDraft.modelFilter} onChange={(event) => void updateUsage({ modelFilter: event.currentTarget.value })} placeholder="按模型或工具筛选…" aria-label="按模型或工具筛选请求记录" />
              <select value={usageDraft.status} onChange={(event) => void updateUsage({ status: event.currentTarget.value as typeof usageDraft.status })} aria-label="请求状态筛选">
                <option value="all">全部状态</option>
                <option value="success">成功</option>
                <option value="error">错误</option>
              </select>
            </>
          )}
          <label>
            <span>详情记录</span>
            <Switch
              ariaLabel="显示使用统计详情记录"
              checked={usageDraft.showDetails}
              onChange={(showDetails) => void updateUsage({ showDetails })}
            />
          </label>
          {usageDraft.showDetails && <small>共 {filteredLogs.length} 条记录</small>}
          {usageDraft.showDetails && hasRequestFilters && (
            <button type="button" className="maka-button maka-button-ghost" data-size="sm" onClick={clearRequestFilters}>
              清除筛选
            </button>
          )}
        </div>
      )}

      {usageDraft.activeTab === 'requests' && !usageDraft.showDetails ? (
        <div className="settingsNotice">
          当前仅显示汇总指标。打开详情记录后，可以查看逐条模型请求和工具调用，按模型、工具或状态筛选，并用于排查费用与失败请求。
          <div className="settingsActionRow" style={{ marginTop: 8 }}>
            <button type="button" className="maka-button maka-button-ghost" data-size="sm" onClick={() => void updateUsage({ showDetails: true })}>
              显示明细
            </button>
          </div>
        </div>
      ) : (
        <UsageTable
          activeTab={usageDraft.activeTab}
          stats={stats}
          logs={showRequestDetails ? filteredLogs : []}
          requestEmpty={hasRequestFilters ? '没有符合筛选条件的请求记录' : '暂无请求记录'}
          onOpenSession={props.onOpenSession}
        />
      )}
    </div>
  );
}

function UsageTable(props: { activeTab: AppSettings['usage']['activeTab']; stats: UsageStats | null; logs: UsageStats['logs']; requestEmpty: string; onOpenSession?(sessionId: string): void }) {
  if (props.activeTab === 'providers') {
    return <SimpleStatsTable ariaLabel="使用统计供应商统计表" headers={['供应商', '请求', 'Token', '费用']} rows={(props.stats?.byProvider ?? []).map((row) => [row.provider, row.requests, row.tokens, `$${row.costUsd.toFixed(2)}`])} />;
  }
  if (props.activeTab === 'models') {
    return <SimpleStatsTable ariaLabel="使用统计模型统计表" headers={['模型', '请求', 'Token', '费用']} rows={(props.stats?.byModel ?? []).map((row) => [row.model, row.requests, row.tokens, `$${row.costUsd.toFixed(2)}`])} />;
  }
  if (props.activeTab === 'tools') {
    return <SimpleStatsTable ariaLabel="使用统计工具统计表" headers={['工具', '调用', '成功', '错误', '平均耗时']} rows={(props.stats?.byTool ?? []).map((row) => [row.tool, row.calls, row.success, row.errors, `${row.avgDurationMs}ms`])} />;
  }
  if (props.activeTab === 'pricing') {
    return <SimpleStatsTable ariaLabel="使用统计定价配置表" headers={['供应商', '模型', '输入 / 1M', '输出 / 1M']} rows={(props.stats?.pricing ?? []).map((row) => [row.provider, row.model, `$${row.inputPerMTokUsd}`, `$${row.outputPerMTokUsd}`])} empty="暂无定价覆盖配置" />;
  }
  return <SimpleStatsTable ariaLabel="使用统计请求日志表" headers={['时间', '类型', '对象', '会话', 'Token', '费用', '延迟', '状态']} rows={props.logs.map((row) => [new Date(row.ts).toLocaleString(), usageRequestKindLabel(row.kind), usageRequestTarget(row), usageRequestSessionCell(row, props.onOpenSession), row.inputTokens + row.outputTokens, row.kind === 'model' ? `$${(row.costUsd ?? 0).toFixed(2)}` : '-', row.latencyMs ? `${row.latencyMs}ms` : '-', usageRequestStatusLabel(row.status)])} empty={props.requestEmpty} />;
}

function usageRequestKindLabel(kind: UsageStats['logs'][number]['kind']) {
  switch (kind) {
    case 'model': return '模型';
    case 'tool': return '工具';
  }
}

function usageRequestTarget(row: UsageStats['logs'][number]) {
  return row.kind === 'tool' ? row.toolName ?? row.model : row.model;
}

function usageRequestSessionCell(row: UsageStats['logs'][number], onOpenSession?: (sessionId: string) => void) {
  const label = shortUsageSessionId(row.sessionId);
  if (!onOpenSession) return label;
  return (
    <button type="button" className="maka-button maka-button-ghost" data-size="sm" onClick={() => onOpenSession(row.sessionId)}>
      打开 {label}
    </button>
  );
}

function shortUsageSessionId(sessionId: string) {
  return sessionId.length > 8 ? sessionId.slice(0, 8) : sessionId;
}

function usageRequestStatusLabel(status: UsageStats['logs'][number]['status']) {
  switch (status) {
    case 'success': return '成功';
    case 'error': return '错误';
  }
}

function SimpleStatsTable(props: { ariaLabel: string; headers: string[]; rows: Array<Array<ReactNode>>; empty?: string }) {
  return (
    <table className="settingsStatsTable" aria-label={props.ariaLabel}>
      <thead>
        <tr>{props.headers.map((header) => <th key={header} scope="col">{header}</th>)}</tr>
      </thead>
      <tbody>
        {props.rows.length === 0 ? (
          <tr><td colSpan={props.headers.length}>{props.empty ?? '暂无请求记录'}</td></tr>
        ) : props.rows.map((row, rowIndex) => (
          <tr key={rowIndex}>
            {row.map((cell, cellIndex) => (
              cellIndex === 0 ? (
                <th key={cellIndex} scope="row">{cell}</th>
              ) : (
                <td key={cellIndex}>{cell}</td>
              )
            ))}
          </tr>
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

function Segmented<T extends string>(props: { value: T; options: Array<[T, string]>; onChange(value: T): void; ariaLabel?: string; disabled?: boolean }) {
  const values = props.options.map(([value]) => value);
  return (
    <div
      className="settingsSegmented"
      role="radiogroup"
      aria-label={props.ariaLabel}
      aria-disabled={props.disabled ? 'true' : undefined}
      onKeyDown={(event) => {
        if (props.disabled) return;
        onSettingsRadioGroupKeyDown(event, values, props.value, props.onChange);
      }}
    >
      {props.options.map(([value, label]) => (
        <button
          key={value}
          type="button"
          role="radio"
          aria-checked={props.value === value}
          data-active={props.value === value}
          data-radio-value={value}
          tabIndex={radioTabIndex(value, props.value, values)}
          disabled={props.disabled}
          onClick={() => props.onChange(value)}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

function Switch(props: { ariaLabel: string; checked: boolean; onChange(checked: boolean): void; disabled?: boolean; ariaDescribedBy?: string }) {
  return (
    <button
      className="settingsSwitch"
      type="button"
      role="switch"
      aria-label={props.ariaLabel}
      aria-describedby={props.ariaDescribedBy}
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
 * PR-UI-8 — Permission Center read-only page. Consumes `window.maka.permissions.getSnapshot()`
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
  not_configured: { label: '等待配置', detail: '需要先打开开关或补齐配置才能启用。', tone: 'neutral' },
  denied: { label: '系统拒绝', detail: '所需系统权限被拒绝或当前平台不支持。', tone: 'destructive' },
  enabled: { label: '运行可用', detail: '当前快照标记为可用，具体层级见下方。', tone: 'success' },
  degraded: { label: '部分可用', detail: '已有一部分能力可用，但仍有运行态、权限或子功能需要处理。', tone: 'warning' },
  paused: { label: '已暂停', detail: '功能开关被显式关闭，但配置仍保留。', tone: 'info' },
};

const OS_PERMISSION_COPY: Record<OsPermissionId, { label: string; purpose: string }> = {
  accessibility: { label: '辅助功能', purpose: 'Computer Use 需要它来读取窗口焦点 / 模拟键盘鼠标。' },
  screen_recording: { label: '屏幕录制', purpose: 'Computer Use 需要它来读取窗口内容；未来屏幕活动录制也会使用。' },
  microphone: { label: '麦克风', purpose: 'Voice 通道需要它来采集语音输入。' },
  notifications: { label: '通知', purpose: '权限申请、回顾完成等系统通知需要它。' },
  automation: { label: '自动化（Apple Events）', purpose: 'Computer Use 控制其他 App 需要逐 target 授权。' },
};

const OS_PERMISSION_STATE_COPY: Record<OsPermissionState, { label: string; tone: 'neutral' | 'info' | 'success' | 'warning' | 'destructive' }> = {
  unsupported: { label: '当前平台不支持', tone: 'neutral' },
  unknown: { label: '无法读取状态', tone: 'neutral' },
  not_determined: { label: '等待授权', tone: 'warning' },
  denied: { label: '已拒绝', tone: 'destructive' },
  granted: { label: '已授权', tone: 'success' },
};

const OFFICECLI_INSTALL_COMMAND = 'curl -fsSL https://raw.githubusercontent.com/iOfficeAI/OfficeCLI/main/install.sh | bash';
const OFFICECLI_RELEASES_URL = 'https://github.com/iOfficeAI/OfficeCLI/releases';

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
        setError(settingsActionErrorMessage(err));
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

  const checkedAtMs = capabilities.checkedAt;

  return (
    <div className="settingsPermissionPage">
      <header className="settingsPermissionIntro">
        <div>
          <h3>权限与能力中心</h3>
          <p>
            这里只读取系统权限与功能能力的当前快照，不会代替你修改任何 OS 权限。
            需要变更权限时，请前往「系统设置 → 隐私与安全性」完成授权或撤销。
          </p>
        </div>
        <div className="settingsPermissionMeta">
          <span className="pill" data-tone="info">只读快照</span>
          <small>
            最近一次读取：<RelativeTime ts={checkedAtMs} className="settingsHelpInlineTime" />
          </small>
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
        <ul className="settingsCapabilityList" aria-label="功能能力列表">
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
        <ul className="settingsOsPermissionList" aria-label="系统权限列表">
          {OS_PERMISSION_IDS.map((id) => (
            <OsPermissionRow key={id} snapshot={permissions.permissions[id]} />
          ))}
        </ul>
      </section>

      <p className="settingsPermissionFootnote">
        本页不会自动授予 Accessibility、Automation 或 Screen Recording。
        高风险自动化能力必须保持逐项审批、可审计、可撤销。
      </p>
    </div>
  );
}

function CapabilityRow(props: { capability: CapabilitySnapshot }) {
  const { capability } = props;
  const toast = useToast();
  const [copyingOfficeCliInstall, setCopyingOfficeCliInstall] = useState(false);
  const copyingOfficeCliInstallRef = useRef(false);
  const capabilityRowMountedRef = useRef(false);
  const readinessCopy = CAPABILITY_READINESS_COPY[capability.readiness];
  const showOfficeCliInstallActions =
    capability.id === 'office_documents' && capability.runtimeProbe.state !== 'healthy';

  useEffect(() => {
    capabilityRowMountedRef.current = true;
    return () => {
      capabilityRowMountedRef.current = false;
      copyingOfficeCliInstallRef.current = false;
    };
  }, []);

  async function copyOfficeCliInstallCommand() {
    if (copyingOfficeCliInstallRef.current) return;
    copyingOfficeCliInstallRef.current = true;
    setCopyingOfficeCliInstall(true);
    try {
      await navigator.clipboard.writeText(OFFICECLI_INSTALL_COMMAND);
      if (capabilityRowMountedRef.current) {
        toast.success('已复制安装命令', '在终端执行后点击刷新重新探测。');
      }
    } catch {
      if (capabilityRowMountedRef.current) {
        toast.error('复制失败', '剪贴板不可用或被系统拒绝。');
      }
    } finally {
      copyingOfficeCliInstallRef.current = false;
      if (capabilityRowMountedRef.current) {
        setCopyingOfficeCliInstall(false);
      }
    }
  }

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
      <dl className="settingsCapabilityLayers" aria-label={`${capability.label}能力状态明细`}>
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
          <ul aria-label={`${capability.label}所需系统权限列表`}>
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
      {capability.guidance.length > 0 && (
        <div className="settingsCapabilityGuidance">
          <span>处理建议</span>
          <ul aria-label={`${capability.label}处理建议列表`}>
            {capability.guidance.map((item, index) => (
              <li key={`${capability.id}-guidance-${index}`}>{item}</li>
            ))}
          </ul>
          {showOfficeCliInstallActions && (
            <div className="settingsCapabilityGuidanceActions" role="group" aria-label="Office 文档安装辅助">
              <code>{OFFICECLI_INSTALL_COMMAND}</code>
              <div>
                <button
                  type="button"
                  className="maka-button secondary"
                  disabled={copyingOfficeCliInstall}
                  onClick={() => void copyOfficeCliInstallCommand()}
                >
                  {copyingOfficeCliInstall ? '复制中…' : '复制 macOS/Linux 安装命令'}
                </button>
                <a href={OFFICECLI_RELEASES_URL} target="_blank" rel="noreferrer">
                  打开二进制下载页
                </a>
              </div>
            </div>
          )}
        </div>
      )}
      {/*
        PR-UX-POLISH-1 commit 2 (yuejing UX audit + xuan ROADMAP-SURFACE-0 +
        kenji boundary 1): unavailable pause/revoke chips looked like
        disabled toggles, which violates the capability presentation
        contract. Keep them hidden until there are real actions with
        `data-state="available"`.
      */}
      <div className="settingsCapabilityAuditSlot" aria-hidden={capability.auditEvents.length === 0}>
        {capability.auditEvents.length === 0 ? (
          <small>暂无审计记录。</small>
        ) : (
          <ul aria-label={`${capability.label}审计记录列表`}>
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
    case 'partial': return '部分可用';
    case 'disabled': return '已关闭';
    case 'not_available': return '未开放';
  }
}
function featureTone(state: CapabilitySnapshot['feature']['state']): 'neutral' | 'info' | 'success' | 'warning' | 'destructive' {
  if (state === 'enabled') return 'success';
  if (state === 'partial') return 'warning';
  if (state === 'disabled') return 'info';
  return 'neutral';
}

function configurationLabel(state: CapabilitySnapshot['configuration']['state']): string {
  switch (state) {
    case 'not_required': return '不需要配置';
    case 'missing': return '等待补齐配置';
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
 * PR-UI-9 — Health Center read-only page. Consumes `window.maka.health.getSnapshot()`
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
 * Read-only boundary: no test buttons, no repair flows. Test/repair entries
 * will be wired in PR-HC-2 once typed actions are exposed.
 */
const HEALTH_LAYER_COPY: Record<HealthSignalLayer, { label: string; description: string }> = {
  configuration: { label: '配置', description: '是否填齐了设置页里的必填项。' },
  validation: { label: '验证', description: '凭据 / 端点的连通性测试结果，仅代表验证通过，不等于发送通路可用。' },
  permission: { label: '系统权限', description: '所需 OS / TCC 权限是否已授权。' },
  feature: { label: '功能开关', description: '功能是否被显式启用、当前是否可使用。' },
  action_approval: { label: '操作审批', description: '每次工具调用 / 高危操作的审批策略状态。' },
  memory_acceptance: { label: '记忆写入', description: '是否接受了记忆写入约定、是否启用了记忆写入。' },
  runtime_probe: { label: '运行态探测', description: '最近一次真实运行（发送 / 流式 / 接收事件）的探测结果。' },
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

const HEALTH_SOURCE_LABEL: Record<HealthSignalSource, string> = {
  connection_test: '连接测试',
  capability_snapshot: '能力快照',
  permission_snapshot: '权限快照',
  runtime_probe: '运行态探测',
  settings: '设置',
  storage: '本地存储',
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
        setError(settingsActionErrorMessage(err));
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

  const healthCheckedAtMs = snapshot.checkedAt;
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
            <strong>验证通过 ≠ 运行可用</strong> — 凭据测试只属于验证层；发送通路以运行态探测结果为准。
          </p>
        </div>
        <div className="settingsHealthMeta">
          <span className="pill" data-tone="info">只读快照</span>
          <small>
            最近一次读取：<RelativeTime ts={healthCheckedAtMs} className="settingsHelpInlineTime" />
          </small>
          <button
            type="button"
            className="settingsHealthRefresh"
            onClick={() => setRefreshTick((tick) => tick + 1)}
          >
            刷新
          </button>
        </div>
      </header>

      <section aria-label="健康摘要" className="settingsHealthSummary" role="list">
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
              {blocksSendCount} 条健康信号会阻塞发送
            </span>
          )}
          {blocksCapabilityCount > 0 && (
            <span className="pill" data-tone="warning">
              {blocksCapabilityCount} 条健康信号会阻塞能力
            </span>
          )}
        </div>
      )}

      {HEALTH_SIGNAL_LAYERS.map((layer) => {
        const signals = signalsByLayer[layer];
        if (!signals || signals.length === 0) return null;
        const copy = HEALTH_LAYER_COPY[layer];
        return (
          <section key={layer} className="settingsHealthLayer" aria-label={`${copy.label}健康信号`}>
            <header>
              <h4>{copy.label}</h4>
              <small>{copy.description}</small>
            </header>
            <ul className="settingsHealthSignalList" aria-label={`${copy.label}健康信号列表`}>
              {signals.map((signal) => (
                <HealthSignalRow key={signal.id} signal={signal} />
              ))}
            </ul>
          </section>
        );
      })}

      <p className="settingsHealthFootnote">
        本页不直接执行测试、修复或权限变更；它只汇总当前已记录的健康信号。
        需要处理问题时，请进入对应设置页或重新触发相关功能。
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
    <div className="settingsHealthSummaryTile" role="listitem" data-tone={props.tone} data-empty={props.count === 0}>
      <strong>{props.count}</strong>
      <small>{props.label}</small>
    </div>
  );
}

function HealthSignalRow(props: { signal: HealthSignal }) {
  const { signal } = props;
  const statusCopy = HEALTH_STATUS_COPY[signal.status];
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
        <span>来源：{HEALTH_SOURCE_LABEL[signal.source]}</span>
        <span>
          读取：<RelativeTime ts={signal.checkedAt} className="settingsHelpInlineTime" />
        </span>
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
