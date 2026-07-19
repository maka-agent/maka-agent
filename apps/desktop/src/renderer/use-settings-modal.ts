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
  const [settingsConnectionDetailSlug, setSettingsConnectionDetailSlug] = useState<string | undefined>(undefined);

  function openSettings() {
    setSettingsProviderCatalogOpen(false);
    setSettingsConnectionDetailSlug(undefined);
    setSettingsOpen(true);
  }

  function openSettingsSection(section: SettingsSection) {
    safeLocalStorageSet('maka-settings-section-v1', section);
    setSettingsRequestedSection(section);
    setSettingsProviderCatalogOpen(false);
    setSettingsConnectionDetailSlug(undefined);
    setSettingsOpen(true);
  }

  function openProviderCatalog() {
    safeLocalStorageSet('maka-settings-section-v1', 'models');
    setSettingsRequestedSection('models');
    setSettingsProviderCatalogOpen(true);
    setSettingsConnectionDetailSlug(undefined);
    setSettingsOpen(true);
  }

  /** Open Settings → 模型 with a specific connection's detail sheet expanded. */
  function openConnectionDetail(slug: string) {
    safeLocalStorageSet('maka-settings-section-v1', 'models');
    setSettingsRequestedSection('models');
    setSettingsProviderCatalogOpen(false);
    setSettingsConnectionDetailSlug(slug);
    setSettingsOpen(true);
  }

  return {
    settingsOpen,
    settingsRequestedSection,
    settingsProviderCatalogOpen,
    settingsConnectionDetailSlug,
    setSettingsOpen,
    setSettingsProviderCatalogOpen,
    openSettings,
    openSettingsSection,
    openProviderCatalog,
    openConnectionDetail,
  };
}
