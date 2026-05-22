import type { OnboardingMilestone } from './onboarding.js';
import { sanitizeOnboardingMilestones } from './onboarding.js';

export type SettingsSection =
  | 'general'
  | 'personalization'
  | 'theme'
  | 'daily-review'
  | 'models'
  | 'usage'
  | 'voice-models'
  | 'open-gateway'
  | 'bot-chat'
  | 'search'
  | 'network'
  | 'data'
  | 'account'
  | 'permissions'
  | 'health'
  | 'about';

export type ProxyProtocol = 'http' | 'https' | 'socks5';

export interface NetworkProxySettings {
  enabled: boolean;
  protocol: ProxyProtocol;
  host: string;
  port: number;
  authEnabled: boolean;
  username: string;
  password: string;
  bypassList: string[];
  autoBypassDomains: string[];
}

export interface NetworkSettings {
  proxy: NetworkProxySettings;
}

export type BotProvider =
  | 'telegram'
  | 'feishu'
  | 'wecom'
  | 'wechat'
  | 'discord'
  | 'dingtalk'
  | 'qq';

export const BOT_READINESS_STATES = [
  'unscaffolded',
  'scaffolded',
  'configured',
  'credentials_valid',
  'operational',
  'degraded',
] as const;
export type BotReadinessState = typeof BOT_READINESS_STATES[number];

export interface BotChannelSettings {
  provider: BotProvider;
  enabled: boolean;
  /**
   * Legacy credential-test boolean. Do not use this to mean runtime
   * operational; prefer `readiness`.
   */
  connected: boolean;
  readiness: BotReadinessState;
  readinessReason?: string;
  readinessUpdatedAt?: number;
  token: string;
  proxyUrl: string;
  webhookUrl?: string;
  appId?: string;
  appSecret?: string;
  botUserId?: string;
  lastTestAt?: number;
  lastError?: string;
}

export function isBotReadinessState(value: unknown): value is BotReadinessState {
  return typeof value === 'string' && (BOT_READINESS_STATES as readonly string[]).includes(value);
}

export interface BotChatSettings {
  channels: Record<BotProvider, BotChannelSettings>;
}

export type UsageRange = '24h' | '7d' | '30d' | 'all';
export type UsageStatus = 'all' | 'success' | 'error';
export type UsageTab = 'requests' | 'providers' | 'models' | 'tools' | 'pricing';

export interface UsageSettings {
  range: UsageRange;
  status: UsageStatus;
  modelFilter: string;
  showDetails: boolean;
  activeTab: UsageTab;
}

export type ThemePreference = 'light' | 'dark' | 'auto';
export type UiDensity = 'compact' | 'comfortable' | 'spacious';

/**
 * PR-UI-2 (@yuejing 2026-05-22): base46 palette catalog. Each value
 * maps to a CSS `[data-maka-theme="..."]` selector in maka-tokens.css
 * that overrides the 6 base color tokens (background / foreground /
 * accent / info / success / destructive). `default` keeps the
 * current Maka palette unchanged.
 *
 * Adding a new palette = add `<id>` here + add the matching
 * `[data-maka-theme="<id>"]` block (light + dark) in maka-tokens.css.
 */
export const THEME_PALETTES = [
  'default',
  'onedark',
  'catppuccin-mocha',
  'tokyo-night',
  'nord',
] as const;

export type ThemePalette = typeof THEME_PALETTES[number];

export function isThemePalette(value: unknown): value is ThemePalette {
  return typeof value === 'string' && (THEME_PALETTES as readonly string[]).includes(value);
}

export interface AppearanceSettings {
  theme: ThemePreference;
  density: UiDensity;
  /**
   * PR-UI-2: optional base46 palette override. When omitted or `default`,
   * Maka renders the original purple-accent palette. Older settings.json
   * files without this field continue to work — `normalizeSettings()`
   * defaults missing values to `default`.
   */
  palette?: ThemePalette;
}

export interface PersonalizationSettings {
  /** How the assistant addresses the user. Empty falls back to "你". */
  displayName: string;
  /** Inline tone preference shown to the model in its system prompt. */
  assistantTone: string;
}

/**
 * PR110b: persisted onboarding state. Only `milestones` lives in
 * settings.json — `OnboardingState` is a runtime projection and is
 * never persisted. The milestone list is sanitized via
 * `sanitizeOnboardingMilestones()` (closed enum + at-most-one
 * terminal + strict field set) on every read and write.
 */
export interface OnboardingSettings {
  milestones: OnboardingMilestone[];
}

export interface AppSettings {
  schemaVersion: 1;
  network: NetworkSettings;
  botChat: BotChatSettings;
  usage: UsageSettings;
  appearance: AppearanceSettings;
  personalization: PersonalizationSettings;
  onboarding: OnboardingSettings;
}

export interface UsageRequestLog {
  id: string;
  ts: number;
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheRead?: number;
  cacheCreation?: number;
  costUsd?: number;
  latencyMs?: number;
  status: 'success' | 'error';
}

export interface UsageSummary {
  totalRequests: number;
  totalCostUsd: number;
  totalTokens: number;
  inputTokens: number;
  outputTokens: number;
  cacheTokens: number;
  cacheRead: number;
  cacheCreation: number;
}

export interface UsageStats {
  summary: UsageSummary;
  logs: UsageRequestLog[];
  byProvider: Array<{ provider: string; requests: number; tokens: number; costUsd: number }>;
  byModel: Array<{ model: string; requests: number; tokens: number; costUsd: number }>;
  byTool: Array<{ tool: string; calls: number; success: number; errors: number; avgDurationMs: number }>;
  pricing: Array<{ provider: string; model: string; inputPerMTokUsd: number; outputPerMTokUsd: number }>;
}

export interface SettingsTestResult {
  ok: boolean;
  message: string;
  latencyMs?: number;
  details?: Record<string, unknown>;
}

export type UpdateAppSettingsInput = Partial<{
  network: Partial<{
    proxy: Partial<NetworkProxySettings>;
  }>;
  botChat: Partial<{
    channels: Partial<Record<BotProvider, Partial<BotChannelSettings>>>;
  }>;
  usage: Partial<UsageSettings>;
  appearance: Partial<AppearanceSettings>;
  personalization: Partial<PersonalizationSettings>;
}>;

export type PersonalizationSettingsWarning =
  | 'override-attempt'
  | 'sensitive-pattern'
  | 'control-chars';

export interface UpdateAppSettingsWarnings {
  personalization?: PersonalizationSettingsWarning[];
}

export interface UpdateAppSettingsResult {
  settings: AppSettings;
  warnings?: UpdateAppSettingsWarnings;
}

export const BOT_PROVIDERS: BotProvider[] = [
  'telegram',
  'feishu',
  'wecom',
  'wechat',
  'discord',
  'dingtalk',
  'qq',
];

export const DEFAULT_PROXY_BYPASS_DOMAINS = [
  'localhost',
  '127.0.0.1',
  '::1',
  '192.168.*',
  '10.*',
  '*.local',
];

export function createDefaultBotChannel(provider: BotProvider): BotChannelSettings {
  return {
    provider,
    enabled: false,
    connected: false,
    readiness: 'scaffolded',
    token: '',
    proxyUrl: provider === 'telegram' ? 'http://127.0.0.1:7890' : '',
  };
}

export function createDefaultSettings(): AppSettings {
  return {
    schemaVersion: 1,
    network: {
      proxy: {
        enabled: false,
        protocol: 'http',
        host: '127.0.0.1',
        port: 7890,
        authEnabled: false,
        username: '',
        password: '',
        bypassList: ['metaso.cn', 'baidu.com'],
        autoBypassDomains: DEFAULT_PROXY_BYPASS_DOMAINS,
      },
    },
    botChat: {
      channels: Object.fromEntries(
        BOT_PROVIDERS.map((provider) => [provider, createDefaultBotChannel(provider)]),
      ) as Record<BotProvider, BotChannelSettings>,
    },
    usage: {
      range: '24h',
      status: 'all',
      modelFilter: '',
      showDetails: false,
      activeTab: 'requests',
    },
    appearance: {
      theme: 'auto',
      density: 'comfortable',
      palette: 'default',
    },
    personalization: {
      displayName: '',
      assistantTone: '',
    },
    onboarding: {
      milestones: [],
    },
  };
}

export function mergeSettings(current: AppSettings, patch: UpdateAppSettingsInput): AppSettings {
  return {
    ...current,
    network: {
      ...current.network,
      ...(patch.network ?? {}),
      proxy: {
        ...current.network.proxy,
        ...(patch.network?.proxy ?? {}),
      },
    },
    botChat: {
      ...current.botChat,
      channels: {
        ...current.botChat.channels,
        ...Object.fromEntries(
          Object.entries(patch.botChat?.channels ?? {}).map(([provider, channelPatch]) => [
            provider,
            {
              ...current.botChat.channels[provider as BotProvider],
              ...channelPatch,
            },
          ]),
        ),
      },
    },
    usage: {
      ...current.usage,
      ...(patch.usage ?? {}),
    },
    appearance: {
      ...current.appearance,
      ...(patch.appearance ?? {}),
    },
    personalization: {
      ...current.personalization,
      ...(patch.personalization ?? {}),
    },
    onboarding: {
      ...current.onboarding,
      // PR110b: milestones flow through a dedicated setMilestone IPC
      // rather than the generic UpdateAppSettingsInput patch surface.
      // Keep the existing list intact when callers patch other sections.
    },
  };
}

export function normalizeSettings(input: unknown): AppSettings {
  const defaults = createDefaultSettings();
  if (!input || typeof input !== 'object') return defaults;
  const value = input as Partial<AppSettings>;
  const base = mergeSettings(defaults, {
    network: value.network,
    botChat: value.botChat,
    usage: value.usage,
    appearance: value.appearance,
    personalization: value.personalization,
  });
  // PR110b: milestones bypass the generic patch surface so we can
  // sanitize them with the closed-enum + at-most-one validator on
  // every read. The settings → onboarding dependency is one-way; there
  // is no cycle.
  const rawOnboarding = (value as { onboarding?: unknown }).onboarding;
  const rawMilestones =
    rawOnboarding && typeof rawOnboarding === 'object'
      ? (rawOnboarding as { milestones?: unknown }).milestones
      : undefined;
  return {
    ...base,
    botChat: {
      channels: Object.fromEntries(
        BOT_PROVIDERS.map((provider) => {
          const rawChannel = value.botChat?.channels?.[provider] as Partial<BotChannelSettings> | undefined;
          return [
            provider,
            normalizeBotChannel(provider, base.botChat.channels[provider], rawChannel),
          ];
        }),
      ) as Record<BotProvider, BotChannelSettings>,
    },
    onboarding: {
      milestones: sanitizeOnboardingMilestones(rawMilestones),
    },
  };
}

function normalizeBotChannel(
  provider: BotProvider,
  channel: BotChannelSettings,
  rawChannel: Partial<BotChannelSettings> | undefined,
): BotChannelSettings {
  const hasExplicitReadiness = rawChannel && 'readiness' in rawChannel;
  const connected = channel.connected === true;
  return {
    ...channel,
    provider,
    connected,
    readiness: hasExplicitReadiness && isBotReadinessState(rawChannel?.readiness)
      ? channel.readiness
      : (connected ? 'credentials_valid' : readinessFromChannel(channel)),
    readinessReason: typeof channel.readinessReason === 'string' ? channel.readinessReason : undefined,
    readinessUpdatedAt: typeof channel.readinessUpdatedAt === 'number' && Number.isFinite(channel.readinessUpdatedAt)
      ? channel.readinessUpdatedAt
      : undefined,
  };
}

function readinessFromChannel(channel: BotChannelSettings): BotReadinessState {
  if (!channel.enabled) return 'scaffolded';
  if (!channel.token.trim() && !channel.appId && !channel.appSecret) return 'scaffolded';
  return 'configured';
}
