import { useLayoutEffect, useRef, useState } from 'react';
import type { Decorator, Meta, StoryObj } from '@storybook/react-vite';
import { ToastProvider } from '@maka/ui';
import type {
  AppSettings,
  LlmConnection,
  ProviderType,
  SettingsSection,
  ThemePalette,
  ThemePreference,
  UpdateAppSettingsResult,
  UsageStats,
} from '@maka/core';
import { createDefaultSettings, DEFAULT_DAILY_REVIEW_CONFIG, mergeSettings } from '@maka/core';
import { SettingsSurface } from '../../src/renderer/settings/settings-surface';
import { createUiLocaleUpdateGate } from '../../src/renderer/settings/ui-locale-update-gate';
import type { ConnectionsBridge } from '../../src/renderer/settings/ProvidersPanel';
import { withScopedMakaBridge } from '../maka-bridge';

const STORY_PLATFORM = 'darwin' as const;

const meta = {
  title: 'Product/Settings/Pages',
  parameters: {
    layout: 'fullscreen',
  },
} satisfies Meta;

export default meta;

type Story = StoryObj<typeof meta>;

const NOW = Date.now();
const noop = () => undefined;

function makeConnection(input: {
  slug: string;
  name: string;
  providerType: ProviderType;
  enabled?: boolean;
}): LlmConnection {
  return {
    slug: input.slug,
    name: input.name,
    providerType: input.providerType,
    defaultModel: 'glm-4.7',
    enabled: input.enabled ?? true,
    modelsFetchedAt: NOW - 18 * 60_000,
    lastTestStatus: 'verified',
    lastTestAt: new Date(NOW - 12 * 60_000).toISOString(),
    createdAt: NOW - 6 * 24 * 60 * 60 * 1000,
    updatedAt: NOW - 12 * 60_000,
  };
}

const connections: LlmConnection[] = [
  makeConnection({ slug: 'zai-live', name: 'Z.AI Live', providerType: 'zai-coding-plan' }),
  makeConnection({ slug: 'openai-review', name: 'OpenAI Review', providerType: 'openai' }),
  makeConnection({ slug: 'ollama-local', name: 'Ollama Local', providerType: 'ollama' }),
];

const connectionsBridge: ConnectionsBridge = {
  async list() {
    return connections;
  },
  async getDefault() {
    return 'zai-live';
  },
  async setDefault() {
    /* noop */
  },
  async create(next) {
    return makeConnection({ slug: next.slug, name: next.name, providerType: next.providerType });
  },
  async update(slug, patch) {
    const current = connections.find((c) => c.slug === slug)!;
    return { ...current, ...patch, updatedAt: NOW };
  },
  async delete() {
    /* noop */
  },
  async test() {
    return { ok: true, latencyMs: 210, modelTested: 'glm-4.7' };
  },
  async fetchModels(slug) {
    return {
      models: slug.includes('openai') ? [{ id: 'gpt-5' }] : [{ id: 'glm-4.7' }],
      source: 'fetched',
      fetchedAt: NOW,
    };
  },
  async hasSecret() {
    return true;
  },
  async getApiKey() {
    return 'sk-storybook-example';
  },
  subscribeEvents() {
    return () => undefined;
  },
};

const usageStats: UsageStats = {
  summary: {
    totalRequests: 420,
    totalCostUsd: 2.34,
    totalTokens: 186_000,
    inputTokens: 100_000,
    outputTokens: 86_000,
    cacheTokens: 0,
    cacheMiss: 0,
    cacheRead: 0,
    cacheCreation: 0,
    reasoning: 0,
  },
  logs: [],
  byProvider: [{ provider: 'zai-coding-plan', requests: 280, tokens: 124_000, costUsd: 1.5 }],
  byModel: [{ model: 'glm-4.7', requests: 280, tokens: 124_000, costUsd: 1.5 }],
  byTool: [{ tool: 'Bash', calls: 120, success: 118, errors: 2, avgDurationMs: 840 }],
  pricing: [{ provider: 'zai-coding-plan', model: 'glm-4.7', inputPerMTokUsd: 0, outputPerMTokUsd: 0 }],
};

const makaBridge = {
  settings: {
    get: async () => createDefaultSettings(),
    update: async (patch: Parameters<typeof window.maka.settings.update>[0]): Promise<UpdateAppSettingsResult> => {
      return { settings: mergeSettings(createDefaultSettings(), patch) };
    },
    usageStats: async (): Promise<UsageStats> => usageStats,
    bots: {
      listStatuses: async () => ({}),
      subscribeStatusChanges: () => () => undefined,
    },
  },
  connections: connectionsBridge,
  app: {
    info: async () => ({
      platform: STORY_PLATFORM,
      osRelease: '23.4.0',
      arch: 'arm64',
      buildMode: 'dev',
      buildCommit: 'a63ae4d',
      appVersion: '0.9.0-dev',
      electronVersion: '33.2.0',
      nodeVersion: '20.18.0',
      chromeVersion: '130.0.6723.59',
    }),
  },
  health: {
    getSnapshot: async () => ({
      checkedAt: NOW,
      signals: [],
      summary: { ok: 0, info: 0, warning: 0, error: 0, unknown: 0 },
    }),
  },
  gateway: {
    status: async () => ({
      enabled: false,
      running: false,
      host: '127.0.0.1',
      port: 0,
      baseUrl: null,
      tokenConfigured: false,
      activeEventStreams: 0,
    }),
    subscribeStatusChanges: () => () => undefined,
  },
  permissions: {
    getSnapshot: async () => ({
      checkedAt: NOW,
      platform: STORY_PLATFORM,
      permissions: {},
    }),
    openSystemSettings: async () => ({ ok: true }),
    requestAccess: async () => ({ ok: true }),
  },
  capabilities: {
    getSnapshot: async () => ({
      checkedAt: NOW,
      capabilities: [],
    }),
  },
  dailyReview: {
    getConfig: async () => DEFAULT_DAILY_REVIEW_CONFIG,
    setConfig: async (patch: Record<string, unknown>) => ({
      ...DEFAULT_DAILY_REVIEW_CONFIG,
      ...patch,
    }),
    runOnce: async () => ({ ok: true }),
  },
  e2eFixture: {
    getState: async () => null,
  },
} satisfies Record<string, unknown>;

const withSettingsBridge = withScopedMakaBridge(makaBridge);

type StoryBotStatuses = Awaited<ReturnType<typeof window.maka.settings.bots.listStatuses>>;

const botAttentionError =
  'Discord WebSocket 握手失败：系统级代理连接超时，请检查 TUN 模式与网络设置后重试。';

const botAttentionSettings = mergeSettings(createDefaultSettings(), {
  botChat: {
    channels: {
      telegram: {
        enabled: true,
        connected: true,
        readiness: 'operational',
        token: 'storybook-telegram-token',
        lastTestAt: NOW - 8 * 60_000,
      },
      discord: {
        enabled: true,
        connected: true,
        readiness: 'degraded',
        token: 'storybook-discord-token',
        lastTestAt: NOW - 25 * 60_000,
        lastError: botAttentionError,
      },
    },
  },
});

function createInactiveStoryBotStatus(
  platform: keyof StoryBotStatuses,
): StoryBotStatuses[keyof StoryBotStatuses] {
  return {
    platform,
    running: false,
    readiness: 'scaffolded',
    connection: 'none',
  };
}

const botAttentionStatuses: StoryBotStatuses = {
  telegram: {
    platform: 'telegram',
    running: true,
    readiness: 'operational',
    connection: 'polling',
    startedAt: NOW - 2 * 60 * 60_000,
    lastEventAt: NOW - 4 * 60_000,
    identity: { username: '@maka_review_bot' },
  },
  discord: {
    platform: 'discord',
    running: false,
    readiness: 'degraded',
    connection: 'none',
    reason: botAttentionError,
    lastEventAt: NOW - 35 * 60_000,
    identity: { username: 'maka-remote-review-bot-with-a-long-name' },
  },
  feishu: createInactiveStoryBotStatus('feishu'),
  wecom: createInactiveStoryBotStatus('wecom'),
  wechat: createInactiveStoryBotStatus('wechat'),
  dingtalk: createInactiveStoryBotStatus('dingtalk'),
  qq: createInactiveStoryBotStatus('qq'),
};

function makeBotAttentionBridge(settings: AppSettings) {
  return {
    ...makaBridge,
    settings: {
      ...makaBridge.settings,
      get: async () => settings,
      update: async (
        patch: Parameters<typeof window.maka.settings.update>[0],
      ): Promise<UpdateAppSettingsResult> => ({
        settings: mergeSettings(settings, patch),
      }),
      bots: {
        ...makaBridge.settings.bots,
        listStatuses: async () => botAttentionStatuses as StoryBotStatuses,
      },
    },
  } satisfies Record<string, unknown>;
}

const withBotAttentionBridge = withScopedMakaBridge(makeBotAttentionBridge(botAttentionSettings));

type VoiceStoryOutcome = 'denied' | 'success';

function withVoiceCaptureOutcome(outcome: VoiceStoryOutcome): Decorator {
  return (Story) => {
    useLayoutEffect(() => {
      const permissions = navigator.permissions as Permissions & {
        query(descriptor: PermissionDescriptor): Promise<PermissionStatus>;
      };
      const permissionsQuery = Object.getOwnPropertyDescriptor(permissions, 'query');
      const mediaDevices = Object.getOwnPropertyDescriptor(navigator, 'mediaDevices');
      const mediaRecorder = Object.getOwnPropertyDescriptor(globalThis, 'MediaRecorder');
      const stream = {
        getTracks: () => [{ stop: noop }],
      } as unknown as MediaStream;
      const permissionsQueryMock = async () => ({
        state: outcome === 'denied' ? 'denied' : 'granted',
      });
      const mediaDevicesMock = {
        getUserMedia: async () => {
          if (outcome === 'denied') {
            throw new DOMException('Microphone access denied for the story', 'NotAllowedError');
          }
          return stream;
        },
      };

      class StoryMediaRecorder extends EventTarget {
        state: RecordingState = 'inactive';

        start() {
          this.state = 'recording';
        }

        stop() {
          this.state = 'inactive';
          const dataEvent = new Event('dataavailable');
          Object.defineProperty(dataEvent, 'data', {
            value: new Blob(['storybook voice capture']),
          });
          this.dispatchEvent(dataEvent);
          this.dispatchEvent(new Event('stop'));
        }
      }

      Object.defineProperty(permissions, 'query', {
        configurable: true,
        value: permissionsQueryMock,
      });
      Object.defineProperty(navigator, 'mediaDevices', {
        configurable: true,
        value: mediaDevicesMock,
      });
      Object.defineProperty(globalThis, 'MediaRecorder', {
        configurable: true,
        value: StoryMediaRecorder,
      });

      return () => {
        restoreProperty(permissions, 'query', permissionsQueryMock, permissionsQuery);
        restoreProperty(navigator, 'mediaDevices', mediaDevicesMock, mediaDevices);
        restoreProperty(globalThis, 'MediaRecorder', StoryMediaRecorder, mediaRecorder);
      };
    }, []);

    return <Story />;
  };
}

function SettingsStory(props: { section: SettingsSection }) {
  const initialFocusRef = useRef<HTMLButtonElement>(null);
  const [uiLocaleUpdateGate] = useState(createUiLocaleUpdateGate);

  return (
    <ToastProvider>
      <div
        data-maka-e2e-fixture="true"
        style={{
          background: 'var(--surface-canvas)',
          height: '100%',
          minHeight: 640,
        }}
      >
        <SettingsSurface
          connections={connections}
          defaultSlug="zai-live"
          onRefresh={async () => undefined}
          onClose={noop}
          themePref={'auto' as ThemePreference}
          onThemeChange={noop}
          themePalette={'default' as ThemePalette}
          onThemePaletteChange={noop}
          onUiLocalePreferenceChange={noop}
          uiLocaleUpdateGate={uiLocaleUpdateGate}
          requestedSection={props.section}
          initialFocusRef={initialFocusRef}
          onOpenDailyReview={noop}
          onOpenSession={noop}
        />
      </div>
    </ToastProvider>
  );
}

function restoreProperty(
  target: object,
  property: PropertyKey,
  ownedValue: unknown,
  descriptor: PropertyDescriptor | undefined,
) {
  if (Reflect.get(target, property) !== ownedValue) return;
  if (descriptor) {
    Object.defineProperty(target, property, descriptor);
  } else {
    Reflect.deleteProperty(target, property);
  }
}

async function waitForStoryButton(
  canvasElement: HTMLElement,
  predicate: (button: HTMLButtonElement) => boolean,
): Promise<HTMLButtonElement> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const button = Array.from(canvasElement.querySelectorAll<HTMLButtonElement>('button')).find(predicate);
    if (button) return button;
    await new Promise((resolve) => globalThis.setTimeout(resolve, 20));
  }
  throw new Error('Story action button did not render');
}

async function waitForStoryCondition(predicate: () => boolean, errorMessage: string): Promise<void> {
  for (let attempt = 0; attempt < 250; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => globalThis.setTimeout(resolve, 20));
  }
  throw new Error(errorMessage);
}

async function runVoiceStoryCapture(
  canvasElement: HTMLElement,
  expectedStatusText: string,
  expectedPermissionText: string,
) {
  const button = await waitForStoryButton(
    canvasElement,
    (candidate) => candidate.textContent?.includes('运行录音自检') === true,
  );
  button.click();
  await waitForStoryCondition(() => {
    const status = canvasElement.querySelector<HTMLElement>('[role="status"]');
    const permission = Array.from(canvasElement.querySelectorAll<HTMLElement>('dt')).find(
      (term) => term.textContent?.trim() === '麦克风权限',
    )?.nextElementSibling;
    return button.dataset.pending !== 'true'
      && status?.textContent?.includes(expectedStatusText) === true
      && permission?.textContent?.trim() === expectedPermissionText;
  }, `Voice story did not reach the expected state: ${expectedStatusText}`);
}

async function openFirstActiveBotChannel(canvasElement: HTMLElement) {
  const button = await waitForStoryButton(
    canvasElement,
    (candidate) => candidate.closest('.settingsRemoteAccessChannelRow') !== null,
  );
  button.click();
  await waitForStoryCondition(
    () => canvasElement.querySelector('.settingsBotDetail') !== null,
    'Remote Access story did not open the channel detail',
  );
}

export const Models: Story = {
  decorators: [withSettingsBridge],
  render: () => <SettingsStory section="models" />,
};
export const General: Story = {
  decorators: [withSettingsBridge],
  render: () => <SettingsStory section="general" />,
};
export const Appearance: Story = {
  decorators: [withSettingsBridge],
  render: () => <SettingsStory section="appearance" />,
};
export const Usage: Story = {
  decorators: [withSettingsBridge],
  render: () => <SettingsStory section="usage" />,
};
export const Memory: Story = {
  decorators: [withSettingsBridge],
  render: () => <SettingsStory section="memory" />,
};
export const WebSearch: Story = {
  decorators: [withSettingsBridge],
  render: () => <SettingsStory section="search" />,
};
export const Voice: Story = {
  decorators: [withSettingsBridge],
  render: () => <SettingsStory section="voice" />,
};
export const VoiceSuccess: Story = {
  decorators: [withSettingsBridge, withVoiceCaptureOutcome('success')],
  render: () => <SettingsStory section="voice" />,
  play: async ({ canvasElement }) => {
    await runVoiceStoryCapture(canvasElement, '录音链路可用', '已授权');
  },
};
export const VoicePermissionDenied: Story = {
  decorators: [withSettingsBridge, withVoiceCaptureOutcome('denied')],
  render: () => <SettingsStory section="voice" />,
  play: async ({ canvasElement }) => {
    await runVoiceStoryCapture(canvasElement, '麦克风权限被拒绝', '已拒绝');
  },
};
export const OpenGateway: Story = {
  decorators: [withSettingsBridge],
  render: () => <SettingsStory section="open-gateway" />,
};
export const BotChat: Story = {
  decorators: [withSettingsBridge],
  render: () => <SettingsStory section="bot-chat" />,
};
export const BotChatNeedsAttention: Story = {
  decorators: [withBotAttentionBridge],
  render: () => <SettingsStory section="bot-chat" />,
};
export const BotChatNeedsAttentionDetail: Story = {
  decorators: [withBotAttentionBridge],
  render: () => <SettingsStory section="bot-chat" />,
  play: async ({ canvasElement }) => {
    await openFirstActiveBotChannel(canvasElement);
  },
};
export const DailyReview: Story = {
  decorators: [withSettingsBridge],
  render: () => <SettingsStory section="daily-review" />,
};
export const Data: Story = {
  decorators: [withSettingsBridge],
  render: () => <SettingsStory section="data" />,
};
export const PermissionCenter: Story = {
  decorators: [withSettingsBridge],
  render: () => <SettingsStory section="permissions" />,
};
export const HealthCenter: Story = {
  decorators: [withSettingsBridge],
  render: () => <SettingsStory section="health" />,
};
export const About: Story = {
  decorators: [withSettingsBridge],
  render: () => <SettingsStory section="about" />,
};
