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
  webSearchCredentialSourceFromStoredKey,
} from './web-search.js';
import { defaultLocalMemorySettings, normalizeLocalMemorySettings } from './local-memory.js';
import type { PermissionMode } from './permission.js';
import { PERMISSION_MODES } from './permission.js';

/**
 * PR-SETTINGS-IA-CONSOLIDATE-0 + PR-SETTINGS-REVIEW-0 (WAWQAQ msg
 * `886f6406`): the memory+review merge had too much density and got
 * split back out. Other merges (network→general, personalization+
 * theme→appearance) held.
 *
 * PR-VOICE-GATEWAY-SPLIT-0 (WAWQAQ msg `d3ea9a33` 2026-06-26): voice
 * and open-gateway were re-split — they're two independent surfaces
 * (local mic / transcription pipeline vs. remote SSE/HTTP gateway)
 * and the merged page read as crowded.
 *
 * Final mapping:
 *   - `network`                       → `general`
 *   - `personalization` + `theme`     → `appearance`
 *   - `voice` and `open-gateway` are independent sections
 *   - `daily-review` is its own section again
 *   - `memory` is its own section again
 *
 * See docs/archive/reference-settings.md §7 for historical provenance.
 */
export type SettingsSection =
  | 'general'
  | 'appearance'
  | 'memory'
  | 'daily-review'
  | 'models'
  | 'usage'
  | 'voice'
  | 'open-gateway'
  | 'bot-chat'
  | 'search'
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
  /**
   * PR-BOT-USER-ALLOWLIST-0 (external bot research): platform-native user IDs
   * permitted to message this bot. `undefined` or empty means no
   * restriction (preserves the V0.1 behavior for existing installs).
   * When non-empty, the bot bridge silently drops inbound messages from
   * any other user — no acknowledgement is sent back, so unauthorized
   * scanners cannot use bounce behavior to enumerate the bot's policy.
   *
   * Stored as a string array since Telegram IDs are 64-bit and JS
   * `Number` loses precision past 2^53.
   */
  allowedUserIds?: ReadonlyArray<string>;
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
  // Product accent palettes named by color family. `coral` warm pink,
  // `azure` cool blue; `forest` deep moss, `dusk` violet twilight,
  // `sand` warm amber on cream, `mono` distraction-free grayscale.
  'coral',
  'azure',
  'forest',
  'dusk',
  'sand',
  'mono',
] as const;

export type ThemePalette = typeof THEME_PALETTES[number];

export function isThemePalette(value: unknown): value is ThemePalette {
  return typeof value === 'string' && (THEME_PALETTES as readonly string[]).includes(value);
}

export interface AppearanceSettings {
  theme: ThemePreference;
  /**
   * PR-UI-2: optional base46 palette override. When omitted or `default`,
   * Maka renders the original purple-accent palette. Older settings.json
   * files without this field continue to work — `normalizeSettings()`
   * defaults missing values to `default`.
   */
  palette?: ThemePalette;
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
  activeEventStreams: number;
}

export interface WorkspaceInstructionsSettings {
  enabled: boolean;
}

export interface PrivacySettings {
  incognitoActive: boolean;
}

/**
 * `explore` is excluded — it's reserved for Deep Research sessions and
 * Bot-incoming guards and is never a mode the user picks, in the composer
 * dropdown or here. Derived from the canonical PERMISSION_MODES (not a
 * hand-copied literal) so adding a future mode updates every consumer —
 * the Settings picker, the composer picker (@maka/ui re-exports this
 * list as PERMISSION_MODE_ORDER), and the settings validation — in one
 * place.
 */
export type ChatDefaultPermissionMode = Exclude<PermissionMode, 'explore'>;

export const CHAT_DEFAULT_PERMISSION_MODES: readonly ChatDefaultPermissionMode[] =
  PERMISSION_MODES.filter((mode): mode is ChatDefaultPermissionMode => mode !== 'explore');

export function isChatDefaultPermissionMode(value: unknown): value is ChatDefaultPermissionMode {
  return typeof value === 'string' && (CHAT_DEFAULT_PERMISSION_MODES as readonly string[]).includes(value);
}

/** Seeds new sessions' starting permission mode (Settings → 通用 → 默认权限模式). */
export interface ChatDefaultsSettings {
  permissionMode: ChatDefaultPermissionMode;
}

/**
 * Desktop OS notifications (Settings → 通用 → 通知). The runtime only
 * knows a turn ended from the renderer; the main process owns the focus
 * gate + native `Notification`, so this is a pure product on/off toggle.
 */
export interface NotificationSettings {
  /**
   * When enabled, the desktop app raises a native notification once an
   * agent turn finishes (completed or errored) **while its window is not
   * focused**. Focus + OS-permission gating live in the main process.
   */
  runComplete: boolean;
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
  privacy: PrivacySettings;
  chatDefaults: ChatDefaultsSettings;
  notifications: NotificationSettings;
}

export interface UsageRequestLog {
  id: string;
  ts: number;
  kind: 'model' | 'tool';
  sessionId: string;
  turnId: string;
  provider: string;
  model: string;
  toolName?: string;
  inputTokens: number;
  outputTokens: number;
  cacheMiss?: number;
  cacheRead?: number;
  cacheCreation?: number;
  reasoning?: number;
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
  cacheMiss: number;
  cacheRead: number;
  cacheCreation: number;
  reasoning: number;
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
  privacy: Partial<PrivacySettings>;
  chatDefaults: Partial<ChatDefaultsSettings>;
  notifications: Partial<NotificationSettings>;
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

export type BotDeliveryProvider = Extract<BotProvider, 'telegram' | 'wechat' | 'discord' | 'dingtalk' | 'qq'>;

export const BOT_DELIVERY_PROVIDERS: BotDeliveryProvider[] = [
  'telegram',
  'wechat',
  'discord',
  'dingtalk',
  'qq',
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
    ...(provider === 'wechat' ? { webhookUrl: 'http://127.0.0.1:18400' } : {}),
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
      palette: 'default',
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
    privacy: defaultPrivacySettings(),
    chatDefaults: defaultChatDefaultsSettings(),
    notifications: {
      runComplete: true,
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
          Object.entries(patch.botChat?.channels ?? {}).map(([provider, channelPatch]) => {
            const merged = {
              ...current.botChat.channels[provider as BotProvider],
              ...channelPatch,
            };
            // PR-BOT-USER-ALLOWLIST-0: keep the persisted allowlist
            // shape consistent on every save, not only on initial load.
            // The renderer textarea sends an array; the normalize step
            // trims/dedups/caps and downgrades the empty case to
            // `undefined` (the V0.1 "no restriction" sentinel).
            if ('allowedUserIds' in (channelPatch ?? {})) {
              const normalized = normalizeAllowedUserIds(merged.allowedUserIds);
              if (normalized) merged.allowedUserIds = normalized;
              else delete merged.allowedUserIds;
            }
            return [provider, merged];
          }),
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
    privacy: patch.privacy
      ? normalizePrivacySettings({ ...current.privacy, ...patch.privacy })
      : current.privacy,
    chatDefaults: patch.chatDefaults
      ? normalizeChatDefaultsSettings({ ...current.chatDefaults, ...patch.chatDefaults })
      : current.chatDefaults,
    notifications: {
      ...current.notifications,
      ...(patch.notifications ?? {}),
    },
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
  const currentCredentialVersion = normalizeCredentialVersion(current.providers.tavily.credentialVersion);
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
  const nextCredentialVersion = apiKeyChanged
    ? currentCredentialVersion + 1
    : currentCredentialVersion;
  const patchCredentialVersion = tavilyPatch
    ? normalizeOptionalCredentialVersion(tavilyPatch.credentialVersion)
    : undefined;
  const hasExplicitCredentialStatus =
    tavilyPatch &&
    isWebSearchCredentialStatus(tavilyPatch.credentialStatus) &&
    (patchCredentialVersion === undefined || patchCredentialVersion === currentCredentialVersion);
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
        credentialSource: webSearchCredentialSourceFromStoredKey(nextApiKey),
        credentialVersion: nextCredentialVersion,
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
    privacy: value.privacy,
    chatDefaults: value.chatDefaults,
    notifications: value.notifications,
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
  const {
    toastPosition: _legacyToastPosition,
    density: _legacyDensity,
    ...appearanceWithoutLegacyFields
  } =
    base.appearance as AppearanceSettings & Record<string, unknown>;
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
    // (theme). We only override palette when it fails the type guard;
    // everything else keeps mergeSettings's behavior.
    // Legacy `appearance.toastPosition` and `appearance.density` are
    // intentionally stripped here. Toasts are fixed to one app-wide
    // position; UI density is no longer a product setting.
    appearance: {
      ...appearanceWithoutLegacyFields,
      palette: isThemePalette(base.appearance.palette) ? base.appearance.palette : 'default',
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
    privacy: normalizePrivacySettings(base.privacy),
    chatDefaults: normalizeChatDefaultsSettings(base.chatDefaults),
    // Fail-closed boolean coercion: mergeSettings spreads the raw user
    // value, so a non-boolean `runComplete` (from a hand-edited or
    // legacy settings.json) would otherwise reach the main-process gate
    // as a truthy/falsy non-boolean. Default a missing/garbage value to
    // the enabled default rather than silently disabling notifications.
    notifications: {
      runComplete:
        typeof base.notifications.runComplete === 'boolean' ? base.notifications.runComplete : true,
    },
  };
}

function normalizeWorkspaceInstructionsSettings(settings: WorkspaceInstructionsSettings): WorkspaceInstructionsSettings {
  return {
    enabled: settings.enabled !== false,
  };
}

function defaultPrivacySettings(): PrivacySettings {
  return { incognitoActive: false };
}

function defaultChatDefaultsSettings(): ChatDefaultsSettings {
  return { permissionMode: 'ask' };
}

// Closed-enum fail-closed, same reasoning as appearance.palette /
// personalization.uiLocale above: an unknown/garbage persisted value
// (corrupted settings.json, a downgraded build reading a newer schema)
// must not reach session-creation code as a `PermissionMode` the picker
// doesn't recognize -- fall back to the safest default instead.
function normalizeChatDefaultsSettings(settings: ChatDefaultsSettings): ChatDefaultsSettings {
  return {
    permissionMode: isChatDefaultPermissionMode(settings.permissionMode) ? settings.permissionMode : 'ask',
  };
}

function normalizePrivacySettings(settings: PrivacySettings): PrivacySettings {
  return {
    incognitoActive: settings.incognitoActive === true,
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
  const credentialVersion = normalizeCredentialVersion(settings.providers?.tavily?.credentialVersion);
  return {
    enabled,
    defaultProvider,
    providers: {
      tavily: {
        apiKey,
        credentialSource: webSearchCredentialSourceFromStoredKey(apiKey),
        credentialVersion,
        credentialStatus,
        ...(credentialCheckedAt ? { credentialCheckedAt } : {}),
      },
    },
  };
}

function normalizeCredentialVersion(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) return 0;
  return value;
}

function normalizeOptionalCredentialVersion(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  return normalizeCredentialVersion(value);
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
  const allowedUserIds = normalizeAllowedUserIds(channel.allowedUserIds);
  return {
    ...channel,
    provider,
    connected,
    ...(allowedUserIds ? { allowedUserIds } : { allowedUserIds: undefined }),
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

export function hasBotChannelCredentials(channel: BotChannelSettings): boolean {
  if (channel.token.trim().length > 0 || Boolean(channel.appId) || Boolean(channel.appSecret)) return true;
  if (channel.provider === 'wechat' && Boolean(channel.webhookUrl?.trim())) return true;
  return false;
}

function readinessFromChannel(channel: BotChannelSettings): BotReadinessState {
  if (!channel.enabled) return 'scaffolded';
  if (!hasBotChannelCredentials(channel)) return 'scaffolded';
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
  const hasCredentials = hasBotChannelCredentials(channel);
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

/**
 * PR-BOT-USER-ALLOWLIST-0: shape-validate the persisted allowlist.
 * Returns `undefined` when there is nothing to enforce (preserves the
 * V0.1 "no restriction" behavior). Drops non-strings, trims, dedups, and
 * caps at MAX_ALLOWED_USER_IDS entries; the cap is defensive against
 * pathological persisted settings, not a product UX limit.
 *
 * IDs are stored as strings because Telegram user IDs are 64-bit and
 * JS `Number` loses precision past 2^53. Trimming a candidate to '' is
 * treated as absent rather than as a wildcard.
 */
export const MAX_ALLOWED_USER_IDS = 50;
export function normalizeAllowedUserIds(
  candidate: ReadonlyArray<string> | undefined | unknown,
): ReadonlyArray<string> | undefined {
  if (!Array.isArray(candidate)) return undefined;
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of candidate) {
    if (typeof raw !== 'string') continue;
    const trimmed = raw.trim();
    if (trimmed.length === 0) continue;
    if (seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
    if (out.length >= MAX_ALLOWED_USER_IDS) break;
  }
  return out.length === 0 ? undefined : Object.freeze(out);
}

/**
 * PR-BOT-USER-ALLOWLIST-UI-0: textarea-friendly parse helper for the
 * Settings UI. Splits on newline, trims each line, drops blanks, dedups,
 * and caps at MAX_ALLOWED_USER_IDS. Returns a string[] (not undefined)
 * because the renderer needs to be able to show "current 0 / 50" before
 * commit. The IPC merge layer will downgrade an empty list to `undefined`
 * at persist time so the V0.1 "no restriction" sentinel is preserved.
 */
export function parseAllowedUserIdsFromText(raw: string): string[] {
  if (typeof raw !== 'string' || raw.length === 0) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    if (seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
    if (out.length >= MAX_ALLOWED_USER_IDS) break;
  }
  return out;
}
