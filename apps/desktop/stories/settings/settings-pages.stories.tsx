import { useRef } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { ToastProvider } from '@maka/ui';
import type {
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
} satisfies Record<string, unknown>;

const withSettingsBridge = withScopedMakaBridge(makaBridge);

function SettingsStory(props: { section: SettingsSection }) {
  const initialFocusRef = useRef<HTMLButtonElement>(null);

  return (
    <ToastProvider>
      <div
        data-maka-visual-smoke="true"
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
          requestedSection={props.section}
          initialFocusRef={initialFocusRef}
          onOpenDailyReview={noop}
          onOpenSession={noop}
        />
      </div>
    </ToastProvider>
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
export const Account: Story = {
  decorators: [withSettingsBridge],
  render: () => <SettingsStory section="account" />,
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
export const OpenGateway: Story = {
  decorators: [withSettingsBridge],
  render: () => <SettingsStory section="open-gateway" />,
};
export const BotChat: Story = {
  decorators: [withSettingsBridge],
  render: () => <SettingsStory section="bot-chat" />,
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
