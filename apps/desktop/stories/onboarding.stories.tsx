import { type ReactNode } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { ToastProvider } from '@maka/ui';
import type { LlmConnection, OnboardingState, PlanReminder, ProviderType, SettingsSection } from '@maka/core';
import { createDefaultSettings } from '@maka/core';
import { OnboardingHero } from '../src/renderer/OnboardingHero';
import { FirstRunChecklist } from '../src/renderer/FirstRunChecklist';
import { withScopedMakaBridge } from './maka-bridge';

const meta = {
  title: 'Product/Onboarding',
  parameters: {
    layout: 'fullscreen',
  },
} satisfies Meta;

export default meta;

type Story = StoryObj<typeof meta>;

const noop = () => undefined;

function makeConnection(input: {
  slug: string;
  name: string;
  providerType: ProviderType;
}): LlmConnection {
  return {
    slug: input.slug,
    name: input.name,
    providerType: input.providerType,
    defaultModel: 'glm-4.7',
    enabled: true,
    modelsFetchedAt: Date.now() - 60_000,
    lastTestAt: new Date(Date.now() - 60_000).toISOString(),
    createdAt: Date.now() - 6 * 24 * 60 * 60 * 1000,
    updatedAt: Date.now() - 60_000,
  };
}

const connections: LlmConnection[] = [
  makeConnection({ slug: 'zai-live', name: 'Z.AI Live', providerType: 'zai-coding-plan' }),
  makeConnection({ slug: 'openai-review', name: 'OpenAI Review', providerType: 'openai' }),
];

function DetailPane(props: { children: ReactNode }) {
  return (
    <div
      data-maka-e2e-fixture="true"
      style={{
        background: 'var(--surface-canvas)',
        height: '100%',
        minHeight: 560,
      }}
    >
      <div
        className="maka-panel maka-panel-detail maka-floating-panel agents-content-area agents-parchment-paper-surface"
        style={{ height: '100%', overflow: 'auto' }}
      >
        <div style={{ margin: '0 auto', maxWidth: 720, padding: '48px 32px' }}>
          {props.children}
        </div>
      </div>
    </div>
  );
}

function heroProps(state: OnboardingState) {
  return {
    state,
    onOpenSettings: (_section?: SettingsSection) => undefined,
    onAddProvider: () => undefined,
    onBrowseProviders: () => undefined,
    onQuickChatSubmit: async () => true,
    connections,
    onRefreshConnections: async () => undefined,
    onSkip: () => undefined,
  };
}

export const NeedsConnection: Story = {
  render: () => (
    <DetailPane>
      <OnboardingHero {...heroProps({ kind: 'needs_connection' })} />
    </DetailPane>
  ),
};

export const NeedsDefaultConnection: Story = {
  render: () => (
    <DetailPane>
      <OnboardingHero {...heroProps({ kind: 'needs_default_connection' })} />
    </DetailPane>
  ),
};

export const NeedsConnectionCredentials: Story = {
  render: () => (
    <DetailPane>
      <OnboardingHero
        {...heroProps({ kind: 'needs_connection_credentials', connectionSlug: 'zai-live' })}
      />
    </DetailPane>
  ),
};

export const NeedsDefaultModel: Story = {
  render: () => (
    <DetailPane>
      <OnboardingHero
        {...heroProps({ kind: 'needs_default_model', connectionSlug: 'zai-live' })}
      />
    </DetailPane>
  ),
};

export const ReadyEmpty: Story = {
  render: () => (
    <DetailPane>
      <OnboardingHero
        {...heroProps({
          kind: 'ready_empty',
          defaultConnectionSlug: 'zai-live',
          defaultModel: 'glm-4.7',
        })}
      />
    </DetailPane>
  ),
};

export const ReadyEmptySubmitting: Story = {
  render: () => (
    <DetailPane>
      <OnboardingHero
        {...heroProps({
          kind: 'ready_empty',
          defaultConnectionSlug: 'zai-live',
          defaultModel: 'glm-4.7',
        })}
        quickChatPending
      />
    </DetailPane>
  ),
};

export const BlockedAllUnhealthy: Story = {
  render: () => (
    <DetailPane>
      <OnboardingHero
        {...heroProps({ kind: 'blocked', reason: 'all_connections_unhealthy' })}
      />
    </DetailPane>
  ),
};

// --- FirstRunChecklist ---

interface ChecklistFixture {
  settings?: ReturnType<typeof createDefaultSettings>;
  plans?: PlanReminder[];
  workspaceInstructionCount?: number;
  failAll?: boolean;
}

function makeChecklistBridge(fixture: ChecklistFixture) {
  const base = createDefaultSettings();
  const settings = fixture.settings ?? base;
  return {
    settings: {
      get: async () => {
        if (fixture.failAll) throw new Error('设置暂时不可用');
        return settings;
      },
    },
    plans: {
      list: async () => {
        if (fixture.failAll) throw new Error('计划提醒暂时不可用');
        return fixture.plans ?? [];
      },
    },
    workspaceInstructions: {
      getState: async () => {
        if (fixture.failAll) throw new Error('项目指令状态暂时不可用');
        return { detectedCount: fixture.workspaceInstructionCount ?? 0 };
      },
    },
  } satisfies Record<string, unknown>;
}

function withChecklistBridge(fixture: ChecklistFixture) {
  return withScopedMakaBridge(makeChecklistBridge(fixture));
}

function ChecklistStory() {
  return (
    <ToastProvider>
      <DetailPane>
        <FirstRunChecklist
          onOpenSettingsSection={noop}
          onOpenSidebarModule={noop}
          onStartPlanReminder={noop}
        />
      </DetailPane>
    </ToastProvider>
  );
}

export const ChecklistAllTodo: Story = {
  decorators: [withChecklistBridge({})],
  render: () => <ChecklistStory />,
};

const checklistSomeDoneFixture: ChecklistFixture = (() => {
  const base = createDefaultSettings();
  const settings: ReturnType<typeof createDefaultSettings> = {
    ...base,
    personalization: { ...base.personalization, displayName: '小马' },
    webSearch: { ...base.webSearch, enabled: true, providers: { ...base.webSearch.providers, tavily: { ...base.webSearch.providers.tavily, apiKey: 'tvly-storybook' } } },
    localMemory: { ...base.localMemory, enabled: true, agentReadEnabled: true },
  };
  const plan: PlanReminder = {
    id: 'plan-1',
    title: '每周回顾',
    note: '',
    schedule: { kind: 'recurring', startAt: Date.now(), recurrence: 'weekly' },
    delivery: { channel: 'local' },
    status: 'scheduled',
    enabled: true,
    createdAt: Date.now() - 86_400_000,
    updatedAt: Date.now() - 86_400_000,
    runs: [],
    runCount: 0,
  };
  return { settings, plans: [plan], workspaceInstructionCount: 2 };
})();

export const ChecklistSomeDone: Story = {
  decorators: [withChecklistBridge(checklistSomeDoneFixture)],
  render: () => <ChecklistStory />,
};

export const ChecklistLoadFailed: Story = {
  decorators: [withChecklistBridge({ failAll: true })],
  render: () => <ChecklistStory />,
};
