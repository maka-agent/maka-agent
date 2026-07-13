import { lazy, Suspense } from 'react';
import type {
  LlmConnection,
  SettingsSection,
  ThemePalette,
  ThemePreference,
} from '@maka/core';
import { SearchModal } from '@maka/ui';
import { KeyboardHelpModal } from './keyboard-help';
import { CommandPalette } from './command-palette';
import { buildAppShellCommandList, type AppShellCommandListOptions } from './app-shell-command-actions';

// Settings is a large surface (providers, OAuth, network, bots, daily-review,
// usage, etc.) that is only needed once the user opens the Settings modal.
// Loading it lazily keeps all of that out of the initial chunk so the first
// paint of the chat shell isn't blocked on parsing hundreds of KB of settings
// UI that may never be opened.
const SettingsModal = lazy(() => import('./settings/SettingsModal').then((m) => ({ default: m.SettingsModal })));

type SearchModalProps = Parameters<typeof SearchModal>[0];

function SettingsModalFallback() {
  return (
    <div
      role="status"
      aria-busy="true"
      aria-label="正在加载设置"
      className="settingsModal settingsPage agents-layout-root"
      data-agents-page
    >
      <div className="maka-lazy-fallback" data-surface="modal">正在加载设置…</div>
    </div>
  );
}

export function AppShellOverlays(props: {
  settingsOpen: boolean;
  connections: LlmConnection[];
  defaultConnection: string | null;
  refreshConnections(): Promise<void>;
  closeSettings(): void;
  themePref: ThemePreference;
  setThemePref(themePref: ThemePreference): void;
  themePalette: ThemePalette;
  setThemePalette(themePalette: ThemePalette): void;
  setUserLabel(userLabel: string): void;
  settingsRequestedSection: SettingsSection | undefined;
  onOpenDailyReview(): void;
  onOpenSettingsSession(sessionId: string): void;
  helpOpen: boolean;
  closeHelp(): void;
  searchModalOpen: boolean;
  searchModalInitialQuery: string;
  closeSearchModal: SearchModalProps['onClose'];
  searchModalDeps: SearchModalProps['deps'];
  searchModalOnNavigate: NonNullable<SearchModalProps['onNavigateToSession']>;
  paletteOpen: boolean;
  closePalette(): void;
  paletteOnSelectSession(sessionId: string, turnId?: string): void;
  paletteOnOpenSearchModal(query: string): void;
  commandOptions: AppShellCommandListOptions;
}) {
  const {
    closeHelp,
    closePalette,
    closeSearchModal,
    closeSettings,
    commandOptions,
    connections,
    defaultConnection,
    helpOpen,
    paletteOnOpenSearchModal,
    paletteOnSelectSession,
    paletteOpen,
    refreshConnections,
    searchModalDeps,
    searchModalInitialQuery,
    searchModalOnNavigate,
    searchModalOpen,
    settingsOpen,
    settingsRequestedSection,
    setThemePalette,
    setThemePref,
    setUserLabel,
    themePalette,
    themePref,
  } = props;

  return (
    <>
      {settingsOpen && (
        <Suspense fallback={<SettingsModalFallback />}>
          <SettingsModal
            connections={connections}
            defaultSlug={defaultConnection}
            onRefresh={refreshConnections}
            onClose={closeSettings}
            themePref={themePref}
            onThemeChange={setThemePref}
            themePalette={themePalette}
            onThemePaletteChange={setThemePalette}
            onUserLabelChange={setUserLabel}
            requestedSection={settingsRequestedSection}
            onOpenDailyReview={props.onOpenDailyReview}
            onOpenSession={props.onOpenSettingsSession}
          />
        </Suspense>
      )}
      {helpOpen && <KeyboardHelpModal onClose={closeHelp} />}
      {searchModalOpen && (
        <SearchModal
          onClose={closeSearchModal}
          deps={searchModalDeps}
          initialQuery={searchModalInitialQuery}
          onNavigateToSession={searchModalOnNavigate}
        />
      )}
      {paletteOpen && (
        <CommandPalette
          onClose={closePalette}
          onSelectSession={paletteOnSelectSession}
          onOpenSearchModal={(query) => {
            closePalette();
            paletteOnOpenSearchModal(query);
          }}
          commands={buildAppShellCommandList(commandOptions)}
        />
      )}
    </>
  );
}
