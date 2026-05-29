import type { OnboardingMilestone } from './onboarding.js';
import { sanitizeOnboardingMilestones } from './onboarding.js';
import type {
  WebSearchProvider,
  WebSearchProviderSettings,
  WebSearchSettings,
} from './web-search.js';
import type { LocalMemorySettings } from './local-memory.js';
import {
  MASKED_TOKEN_SENTINEL,
  defaultWebSearchSettings,
  isWebSearchCredentialStatus,
  isWebSearchProvider,
  reconcileMaskedToken,
} from './web-search.js';
import { defaultLocalMemorySettings, normalizeLocalMemorySettings } from './local-memory.js';

export type SettingsSection =
  | 'general'
  | 'personalization'
  | 'theme'
  | 'daily-review'
  | 'memory'
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
  /** Public callback/domain configured in the bot platform console. */
  domain?: string;
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

/**
 * PR-UI-16 (@yuejing 2026-05-22): user-pickable toast position.
 *
 * Audit §3.10 — Maka pinned toasts to bottom-right (PR55); some users
 * prefer top-right (notification-center style) or center for
 * full-attention dialogs. Six grid corners cover the practical needs;
 * sticking with `bottom-right` as default preserves the v1 behavior
 * so existing users see no change.
 */
export const TOAST_POSITIONS = [
  'top-left',
  'top-center',
  'top-right',
  'bottom-left',
  'bottom-center',
  'bottom-right',
] as const;

export type ToastPosition = typeof TOAST_POSITIONS[number];

export function isToastPosition(value: unknown): value is ToastPosition {
  return typeof value === 'string' && (TOAST_POSITIONS as readonly string[]).includes(value);
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
  /**
   * PR-UI-16: optional toast position override. When omitted, Maka
   * defaults to `bottom-right` (the v1 hardcoded behavior). Older
   * settings.json files without this field continue to work.
   */
  toastPosition?: ToastPosition;
}

/**
 * PR-LANG-PREF-0 (WAWQAQ msg `edc9cb41` + xuan `b4f4f2a8`/`54b56858`
 * + kenji `7e532892`): closed UI-locale preference.
 *
 * `'auto'` — use `navigator.language` detection (today's behavior).
 * `'zh'` / `'en'` — user explicit override; takes precedence over
 *   navigator detection but is itself overridden by the visual-smoke
 *   fixture locale (fixtures stay deterministic regardless of the
 *   persisted user preference).
 *
 * Closed union so adding a third locale is a deliberate
 * contract-level decision.
 */
export type UiLocalePreference = 'auto' | 'zh' | 'en';

export const UI_LOCALE_PREFERENCES: readonly UiLocalePreference[] = ['auto', 'zh', 'en'];

export function isUiLocalePreference(value: unknown): value is UiLocalePreference {
  return value === 'auto' || value === 'zh' || value === 'en';
}

export interface PersonalizationSettings {
  /** How the assistant addresses the user. Empty falls back to "你". */
  displayName: string;
  /** Inline tone preference shown to the model in its system prompt. */
  assistantTone: string;
  /**
   * PR-LANG-PREF-0: UI locale preference (kenji `7e532892` acceptance):
   * user explicit choice > navigator.language; visual-smoke override
   * stays for fixture tests. Defaults to `'auto'`.
   */
  uiLocale: UiLocalePreference;
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

export interface OpenGatewaySettings {
  enabled: boolean;
  host: '127.0.0.1' | '0.0.0.0';
  port: number;
  token: string;
}

export interface OpenGatewayRuntimeStatus {
  enabled: boolean;
  running: boolean;
  host: OpenGatewaySettings['host'];
  port: number;
  baseUrl: string | null;
  startedAt?: number;
  lastError?: string;
  tokenConfigured: boolean;
}

export interface WorkspaceInstructionsSettings {
  enabled: boolean;
}

export interface AppSettings {
  schemaVersion: 1;
  network: NetworkSettings;
  botChat: BotChatSettings;
  usage: UsageSettings;
  appearance: AppearanceSettings;
  personalization: PersonalizationSettings;
  onboarding: OnboardingSettings;
  openGateway: OpenGatewaySettings;
  webSearch: WebSearchSettings;
  localMemory: LocalMemorySettings;
  workspaceInstructions: WorkspaceInstructionsSettings;
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
  openGateway: Partial<OpenGatewaySettings>;
  localMemory: Partial<LocalMemorySettings>;
  workspaceInstructions: Partial<WorkspaceInstructionsSettings>;
  webSearch: Partial<{
    enabled: boolean;
    defaultProvider: WebSearchProvider;
    providers: Partial<{
      tavily: Partial<WebSearchProviderSettings>;
    }>;
  }>;
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

export type BotDeliveryProvider = Extract<BotProvider, 'telegram'>;

export const BOT_DELIVERY_PROVIDERS: BotDeliveryProvider[] = [
  'telegram',
];

export function isBotDeliveryProvider(value: unknown): value is BotDeliveryProvider {
  return typeof value === 'string' && (BOT_DELIVERY_PROVIDERS as readonly string[]).includes(value);
}

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
      toastPosition: 'bottom-right',
    },
    personalization: {
      displayName: '',
      assistantTone: '',
      uiLocale: 'auto',
    },
    onboarding: {
      milestones: [],
    },
    openGateway: {
      enabled: false,
      host: '127.0.0.1',
      port: 3939,
      token: '',
    },
    webSearch: defaultWebSearchSettings(),
    localMemory: defaultLocalMemorySettings(),
    workspaceInstructions: {
      enabled: true,
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
    openGateway: {
      ...current.openGateway,
      ...(patch.openGateway ?? {}),
    },
    localMemory: patch.localMemory
      ? normalizeLocalMemorySettings({ ...current.localMemory, ...patch.localMemory })
      : current.localMemory,
    workspaceInstructions: patch.workspaceInstructions
      ? normalizeWorkspaceInstructionsSettings({ ...current.workspaceInstructions, ...patch.workspaceInstructions })
      : current.workspaceInstructions,
    webSearch: mergeWebSearchSettings(current.webSearch, patch.webSearch),
  };
}

function mergeWebSearchSettings(
  current: WebSearchSettings,
  patch: UpdateAppSettingsInput['webSearch'],
): WebSearchSettings {
  if (!patch) return current;
  const tavilyPatch = patch.providers?.tavily;
  const candidateProvider = patch.defaultProvider;
  const nextProvider: WebSearchProvider = isWebSearchProvider(candidateProvider)
    ? candidateProvider
    : current.defaultProvider;
  // Mask-sentinel preservation lives here so the IPC boundary does
  // not have to special-case the round-tripped masked value.
  const nextApiKey =
    tavilyPatch && typeof tavilyPatch.apiKey === 'string'
      ? reconcileMaskedToken(current.providers.tavily.apiKey, tavilyPatch.apiKey)
      : current.providers.tavily.apiKey;
  const hasExplicitCredentialStatus =
    tavilyPatch && isWebSearchCredentialStatus(tavilyPatch.credentialStatus);
  const explicitCredentialCheckedAt =
    tavilyPatch &&
    typeof tavilyPatch.credentialCheckedAt === 'string' &&
    tavilyPatch.credentialCheckedAt.length <= 64
      ? tavilyPatch.credentialCheckedAt
      : undefined;
  const apiKeyChanged =
    tavilyPatch &&
    typeof tavilyPatch.apiKey === 'string' &&
    tavilyPatch.apiKey !== MASKED_TOKEN_SENTINEL &&
    nextApiKey !== current.providers.tavily.apiKey;
  const credentialStatus = hasExplicitCredentialStatus
    ? tavilyPatch.credentialStatus
    : apiKeyChanged
      ? 'untested'
      : current.providers.tavily.credentialStatus;
  const credentialCheckedAt = hasExplicitCredentialStatus
    ? explicitCredentialCheckedAt
    : apiKeyChanged
      ? undefined
      : current.providers.tavily.credentialCheckedAt;
  return {
    enabled: typeof patch.enabled === 'boolean' ? patch.enabled : current.enabled,
    defaultProvider: nextProvider,
    providers: {
      tavily: {
        apiKey: nextApiKey,
        credentialStatus,
        ...(credentialCheckedAt ? { credentialCheckedAt } : {}),
      },
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
    openGateway: value.openGateway,
    webSearch: value.webSearch,
    localMemory: value.localMemory,
    workspaceInstructions: value.workspaceInstructions,
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
    // PR-UI-D1 (@kenji msg 68bf2b13): closed-enum fail-closed for
    // appearance.palette. mergeSettings spreads the raw user value
    // straight in, so an unknown/garbage palette string would
    // otherwise survive the normalize pass and end up driving
    // `[data-maka-theme="evil-unknown"]` on the renderer with no
    // matching CSS block. Validate against the closed `THEME_PALETTES`
    // allowlist and fall back to `'default'` on any miss (undefined,
    // non-string, unknown string).
    //
    // Critical: this MUST NOT silently reset other appearance fields
    // (theme / density). We only override palette when it fails the
    // type guard; everything else keeps mergeSettings's behavior.
    // PR-UI-D1 + PR-UI-D2 (@kenji msg 68bf2b13 / eef6f7a5): closed-
    // enum fail-closed for both `appearance.palette` and
    // `appearance.toastPosition`. mergeSettings spreads the raw user
    // value straight in, so an unknown/garbage palette string would
    // otherwise survive the normalize pass and end up driving
    // `[data-maka-theme="evil-unknown"]` on the renderer with no
    // matching CSS block (palette case), or position toasts in an
    // unstyled corner (toastPosition case). Validate each against its
    // closed allowlist and fall back to defaults on any miss
    // (undefined, non-string, unknown string).
    //
    // Critical: this MUST NOT silently reset other appearance fields
    // (theme / density). We only override the offending field when it
    // fails the type guard; everything else keeps mergeSettings's
    // behavior.
    appearance: {
      ...base.appearance,
      palette: isThemePalette(base.appearance.palette) ? base.appearance.palette : 'default',
      toastPosition: isToastPosition(base.appearance.toastPosition)
        ? base.appearance.toastPosition
        : 'bottom-right',
    },
    // PR-LANG-PREF-0: closed-enum fail-closed for the new
    // `personalization.uiLocale` preference. mergeSettings spreads
    // raw user values, so an unknown value would otherwise reach the
    // renderer and produce a `data-maka-locale="xx"` attribute with
    // no detector mapping. Fall back to 'auto' on any miss.
    personalization: {
      ...base.personalization,
      uiLocale: isUiLocalePreference(base.personalization.uiLocale)
        ? base.personalization.uiLocale
        : 'auto',
    },
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
    openGateway: normalizeOpenGatewaySettings(base.openGateway),
    webSearch: normalizeWebSearchSettings(base.webSearch),
    localMemory: normalizeLocalMemorySettings(base.localMemory),
    workspaceInstructions: normalizeWorkspaceInstructionsSettings(base.workspaceInstructions),
  };
}

function normalizeWorkspaceInstructionsSettings(settings: WorkspaceInstructionsSettings): WorkspaceInstructionsSettings {
  return {
    enabled: settings.enabled !== false,
  };
}

function normalizeWebSearchSettings(settings: WebSearchSettings): WebSearchSettings {
  const enabled = settings.enabled === true;
  const defaultProvider = isWebSearchProvider(settings.defaultProvider)
    ? settings.defaultProvider
    : 'tavily';
  // Cap apiKey length defensively. Tavily keys are < 64 chars; anything
  // longer is almost certainly garbage that would break log redaction.
  const rawApiKey = settings.providers?.tavily?.apiKey;
  const apiKey =
    typeof rawApiKey === 'string' && rawApiKey.length <= 256 ? rawApiKey : '';
  const rawCredentialStatus = settings.providers?.tavily?.credentialStatus;
  const credentialStatus = isWebSearchCredentialStatus(rawCredentialStatus)
    ? rawCredentialStatus
    : 'untested';
  const rawCredentialCheckedAt = settings.providers?.tavily?.credentialCheckedAt;
  const credentialCheckedAt =
    typeof rawCredentialCheckedAt === 'string' && rawCredentialCheckedAt.length <= 64
      ? rawCredentialCheckedAt
      : undefined;
  return {
    enabled,
    defaultProvider,
    providers: {
      tavily: {
        apiKey,
        credentialStatus,
        ...(credentialCheckedAt ? { credentialCheckedAt } : {}),
      },
    },
  };
}

function normalizeOpenGatewaySettings(settings: OpenGatewaySettings): OpenGatewaySettings {
  const port = Number.isInteger(settings.port) && settings.port >= 1024 && settings.port <= 65535
    ? settings.port
    : 3939;
  const host = settings.host === '0.0.0.0' ? '0.0.0.0' : '127.0.0.1';
  const token = typeof settings.token === 'string' && settings.token.length <= 256
    ? settings.token
    : '';
  return {
    enabled: settings.enabled === true,
    host,
    port,
    token,
  };
}

function normalizeBotChannel(
  provider: BotProvider,
  channel: BotChannelSettings,
  rawChannel: Partial<BotChannelSettings> | undefined,
): BotChannelSettings {
  const hasExplicitReadiness = rawChannel && 'readiness' in rawChannel;
  const connected = channel.connected === true;
  const candidateReadiness = hasExplicitReadiness && isBotReadinessState(rawChannel?.readiness)
    ? channel.readiness
    : (connected ? 'credentials_valid' : readinessFromChannel(channel));
  return {
    ...channel,
    provider,
    connected,
    // PR-HEALTH-1 (xuan msg `e4887ffd`, I1 — bot readiness single-authority,
    // write path): coerce the persisted readiness to be consistent with
    // current credential state. The previous behavior trusted whatever was
    // on disk, so `mergeSettings({channels:{telegram:{token:''}}})` over
    // `{readiness:'credentials_valid', token:'X'}` would persist a stale
    // `'credentials_valid'` even though credentials no longer exist.
    // `coerceReadinessForCurrentState` downgrades credential-claiming states
    // (`configured` / `credentials_valid` / `operational` / `degraded`)
    // back to `'scaffolded'` when no credentials remain. Live bridges keep
    // their own authoritative readiness via `BotStatus`; they are not
    // affected by this settings-write coerce path.
    readiness: coerceReadinessForCurrentState(channel, candidateReadiness),
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

/**
 * PR-HEALTH-1 (xuan msg `e4887ffd`, I1 lock): downgrade a persisted
 * `BotReadinessState` to be consistent with the channel's current
 * credential state.
 *
 * Why: `mergeSettings` spreads a `channelPatch` over the current channel.
 * If the user clears `token` without explicitly patching `readiness`, the
 * prior `'credentials_valid'` (or any other credential-claiming state)
 * survives. That stale value then surfaces through
 * `bot-registry.scaffoldStatus()` into `BotStatus.readiness`, which the
 * capability snapshot maps into `CapabilityRuntimeProbeSignal.state` —
 * producing a "configured / verified" UI for a channel that actually has
 * no credentials.
 *
 * Rule: credential-claiming readiness (`'configured'` / `'credentials_valid'`
 * / `'operational'` / `'degraded'`) requires SOMETHING in the credential
 * trio (`token` / `appId` / `appSecret`). When all three are empty,
 * downgrade to `'scaffolded'`. `'unscaffolded'` and `'scaffolded'` are
 * always consistent with any credential state, so they pass through.
 *
 * Note: this is a write-path consistency gate, not an operational probe.
 * Even when credentials exist, we do NOT promote `'scaffolded'` to
 * `'configured'` here — that is the live bridge / connection-test path's
 * responsibility. We only downgrade; never upgrade.
 */
function coerceReadinessForCurrentState(
  channel: BotChannelSettings,
  candidate: BotReadinessState,
): BotReadinessState {
  const hasCredentials =
    channel.token.trim().length > 0 || Boolean(channel.appId) || Boolean(channel.appSecret);
  const claimsCredentials =
    candidate === 'configured' ||
    candidate === 'credentials_valid' ||
    candidate === 'operational' ||
    candidate === 'degraded';
  if (claimsCredentials && !hasCredentials) {
    return 'scaffolded';
  }
  return candidate;
}
