import type { LlmConnection, OnboardingState, ProviderType, QuickChatMode, SettingsSection } from '@maka/core';
import { OnboardingHero } from './OnboardingHero';
import { FirstRunChecklist } from './FirstRunChecklist';

interface OnboardingEmptyStateProps {
  state: OnboardingState;
  onOpenSettings: (section?: SettingsSection) => void;
  onAddProvider: (providerType: ProviderType) => void;
  onBrowseProviders: () => void;
  onQuickChatSubmit: (
    prompt: string,
    mode?: QuickChatMode,
    skillIds?: readonly string[],
  ) => boolean | Promise<boolean>;
  mentionSkills?: ReadonlyArray<{ ref?: string; id: string; name: string; description?: string }>;
  quickChatPending?: boolean;
  connections: LlmConnection[];
  onRefreshConnections?: () => Promise<void> | void;
  onSkip?: () => Promise<void> | void;
  onOpenSettingsSection: (section: SettingsSection) => void;
  onOpenSidebarModule: (target: 'daily-review' | 'automations') => void;
  onStartPlanReminder?: () => void;
}

/**
 * The chat surface's empty-state stack (issue #1043): the OnboardingHero plus
 * the conditional FirstRunChecklist shown when there is no active session.
 * Presentational - the orchestration callbacks (skip milestone, quick-chat
 * submit, open settings) stay with the shell and are passed in.
 */
export function OnboardingEmptyState({
  state,
  onOpenSettings,
  onAddProvider,
  onBrowseProviders,
  onQuickChatSubmit,
  mentionSkills,
  quickChatPending,
  connections,
  onRefreshConnections,
  onSkip,
  onOpenSettingsSection,
  onOpenSidebarModule,
  onStartPlanReminder,
}: OnboardingEmptyStateProps) {
  return (
    <div className="maka-onboarding-stack">
      <OnboardingHero
        state={state}
        onOpenSettings={onOpenSettings}
        onAddProvider={onAddProvider}
        onBrowseProviders={onBrowseProviders}
        onQuickChatSubmit={onQuickChatSubmit}
        mentionSkills={mentionSkills}
        quickChatPending={quickChatPending}
        connections={connections}
        onRefreshConnections={onRefreshConnections}
        onSkip={onSkip}
      />
      {state.kind === 'ready_empty' && (
        <FirstRunChecklist
          onOpenSettingsSection={onOpenSettingsSection}
          onOpenSidebarModule={onOpenSidebarModule}
          onStartPlanReminder={onStartPlanReminder}
        />
      )}
    </div>
  );
}
