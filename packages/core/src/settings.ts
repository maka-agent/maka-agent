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

export interface BotChannelSettings {
  provider: BotProvider;
  enabled: boolean;
  connected: boolean;
  token: string;
  proxyUrl: string;
  webhookUrl?: string;
  appId?: string;
  appSecret?: string;
  botUserId?: string;
  lastTestAt?: number;
  lastError?: string;
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

export interface AppSettings {
  schemaVersion: 1;
  network: NetworkSettings;
  botChat: BotChatSettings;
  usage: UsageSettings;
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
}>;

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
  };
}

export function normalizeSettings(input: unknown): AppSettings {
  const defaults = createDefaultSettings();
  if (!input || typeof input !== 'object') return defaults;
  const value = input as Partial<AppSettings>;
  return mergeSettings(defaults, {
    network: value.network,
    botChat: value.botChat,
    usage: value.usage,
  });
}
