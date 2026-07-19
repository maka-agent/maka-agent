import { useState } from 'react';
import type { SettingsSection } from '@maka/core';
import { safeLocalStorageSet } from './browser-storage';

/**
 * Owns the Settings modal surface state (issue #1043): the open flag, the
 * requested section, and the provider-catalog sub-open flag, plus the openers
 * that persist the section to localStorage.
 *
 * `closeSettings` stays in AppShell: on close it re-pulls the onboarding
 * snapshot, the memory-visibility flag, and the default permission mode -
 * cross-slice orchestration that belongs to the shell, not the modal.
 */
export function useSettingsModal() {
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsRequestedSection, setSettingsRequestedSection] = useState<SettingsSection | undefined>(
    undefined,
  );
  const [settingsProviderCatalogOpen, setSettingsProviderCatalogOpen] = useState(false);

  function openSettings() {
    setSettingsProviderCatalogOpen(false);
    setSettingsOpen(true);
  }

  function openSettingsSection(section: SettingsSection) {
    safeLocalStorageSet('maka-settings-section-v1', section);
    setSettingsRequestedSection(section);
    setSettingsProviderCatalogOpen(false);
    setSettingsOpen(true);
  }

  function openProviderCatalog() {
    safeLocalStorageSet('maka-settings-section-v1', 'models');
    setSettingsRequestedSection('models');
    setSettingsProviderCatalogOpen(true);
    setSettingsOpen(true);
  }

  return {
    settingsOpen,
    settingsRequestedSection,
    settingsProviderCatalogOpen,
    setSettingsOpen,
    setSettingsProviderCatalogOpen,
    openSettings,
    openSettingsSection,
    openProviderCatalog,
  };
}
