import type { LlmConnection, OnboardingState, QuickChatMode, SettingsSection } from '@maka/core';
import { OnboardingHero } from './OnboardingHero';
import { FirstRunChecklist } from './FirstRunChecklist';

interface OnboardingEmptyStateProps {
  state: OnboardingState;
  onOpenSettings: (section?: SettingsSection) => void;
  onBrowseProviders: () => void;
  onQuickChatSubmit: (prompt: string, mode?: QuickChatMode) => boolean | Promise<boolean>;
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
  onBrowseProviders,
  onQuickChatSubmit,
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
        onBrowseProviders={onBrowseProviders}
        onQuickChatSubmit={onQuickChatSubmit}
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
