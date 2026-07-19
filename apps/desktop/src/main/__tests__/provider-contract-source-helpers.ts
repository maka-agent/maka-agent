import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const REPO_ROOT = resolve(import.meta.dirname, '../../../../..');
const SETTINGS_ROOT = resolve(REPO_ROOT, 'apps', 'desktop', 'src', 'renderer', 'settings');

export interface ProviderSettingsSources {
  panel: string;
  dialog: string;
  catalog: string;
  oauth: string;
  claudeCard: string;
  display: string;
  displayCopy: string;
  addForm: string;
  detail: string;
  shared: string;
  combined: string;
}

const sourcePaths = {
  panel: resolve(SETTINGS_ROOT, 'ProvidersPanel.tsx'),
  dialog: resolve(SETTINGS_ROOT, 'provider-connection-dialog.tsx'),
  catalog: resolve(SETTINGS_ROOT, 'provider-catalog.tsx'),
  oauth: resolve(SETTINGS_ROOT, 'provider-oauth-section.tsx'),
  // #1042: ClaudeSubscriptionCard moved out of provider-oauth-section.tsx
  // into its own file; it stays part of the provider settings surface the
  // contract tests pin, right after the OAuth section that renders it.
  claudeCard: resolve(SETTINGS_ROOT, 'claude-subscription-card.tsx'),
  display: resolve(SETTINGS_ROOT, 'provider-display.tsx'),
  displayCopy: resolve(SETTINGS_ROOT, 'provider-display-copy.ts'),
  addForm: resolve(SETTINGS_ROOT, 'provider-add-form.tsx'),
  detail: resolve(SETTINGS_ROOT, 'provider-connection-detail.tsx'),
  shared: resolve(SETTINGS_ROOT, 'provider-panel-shared.ts'),
} as const;

export async function readProviderSettingsSources(): Promise<ProviderSettingsSources> {
  const [panel, dialog, catalog, oauth, claudeCard, display, displayCopy, addForm, detail, shared] = await Promise.all([
    readFile(sourcePaths.panel, 'utf8'),
    readFile(sourcePaths.dialog, 'utf8'),
    readFile(sourcePaths.catalog, 'utf8'),
    readFile(sourcePaths.oauth, 'utf8'),
    readFile(sourcePaths.claudeCard, 'utf8'),
    readFile(sourcePaths.display, 'utf8'),
    readFile(sourcePaths.displayCopy, 'utf8'),
    readFile(sourcePaths.addForm, 'utf8'),
    readFile(sourcePaths.detail, 'utf8'),
    readFile(sourcePaths.shared, 'utf8'),
  ]);

  return {
    panel,
    dialog,
    catalog,
    oauth,
    claudeCard,
    display,
    displayCopy,
    addForm,
    detail,
    shared,
    combined: [
      panel,
      dialog,
      catalog,
      oauth,
      claudeCard,
      display,
      displayCopy,
      addForm,
      detail,
      shared,
    ].join('\n'),
  };
}

export async function readProviderSettingsCombinedSource(): Promise<string> {
  return (await readProviderSettingsSources()).combined;
}
