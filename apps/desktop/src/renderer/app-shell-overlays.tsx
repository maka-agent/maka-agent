import { lazy, Suspense, useCallback, useMemo, useRef } from 'react';
import type {
  LlmConnection,
  SettingsSection,
  ThemePalette,
  ThemePreference,
  UiLocalePreference,
} from '@maka/core';
import { SearchModal } from '@maka/ui';
import { KeyboardHelpModal } from './keyboard-help';
import { CommandPalette } from './command-palette';
import { buildAppShellCommandList, type AppShellCommandListOptions } from './app-shell-command-actions';
import type { UiLocaleUpdateGate } from './settings/ui-locale-update-gate';

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
  setUiLocalePreference: (preference: UiLocalePreference) => void;
  uiLocaleUpdateGate: UiLocaleUpdateGate;
  setUserLabel(userLabel: string): void;
  settingsRequestedSection: SettingsSection | undefined;
  settingsProviderCatalogOpen: boolean;
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
    settingsProviderCatalogOpen,
    setThemePalette,
    setThemePref,
    setUiLocalePreference,
    uiLocaleUpdateGate,
    setUserLabel,
    themePalette,
    themePref,
  } = props;

  /* #1045: keep the palette's command list identity stable while it is open.
   * app-shell rebuilds commandOptions on every render (streaming ticks
   * included), which used to rebuild the whole command list per render and
   * bust every memo inside CommandPalette. The palette is modal, so its
   * visible inputs cannot change from user action while it is open — rebuild
   * only on the open/close transition, reading the latest options snapshot
   * through a ref (same stable-ref pattern as openSessionInChatRef in
   * app-shell.tsx). */
  const commandOptionsRef = useRef(commandOptions);
  commandOptionsRef.current = commandOptions;
  const commands = useMemo(
    () => buildAppShellCommandList(commandOptionsRef.current),
    [paletteOpen],
  );
  const openSearchModal = useCallback(
    (query: string) => {
      closePalette();
      paletteOnOpenSearchModal(query);
    },
    [closePalette, paletteOnOpenSearchModal],
  );

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
            onUiLocalePreferenceChange={setUiLocalePreference}
            uiLocaleUpdateGate={uiLocaleUpdateGate}
            onUserLabelChange={setUserLabel}
            requestedSection={settingsRequestedSection}
            openProviderCatalog={settingsProviderCatalogOpen}
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
          onOpenSearchModal={openSearchModal}
          commands={commands}
        />
      )}
    </>
  );
}
