/**
 * Source-grounded contract for PR-PERSONALIZATION-SYNC-0
 * (WAWQAQ msg 23c079a9 round 7). The personalization form
 * initializes from `props.settings.personalization` once on mount.
 * Without a sync effect, the visible inputs diverge from the
 * persisted store after server-side sanitization rewrites the
 * saved value.
 */

import { strict as assert } from 'node:assert';
import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';
import { resolve } from 'node:path';

const REPO_ROOT = resolve(process.cwd(), '..', '..');
const SETTINGS_MODAL = resolve(
  REPO_ROOT, 'apps', 'desktop', 'src', 'renderer', 'settings', 'SettingsModal.tsx',
);

describe('Personalization form state sync (PR-PERSONALIZATION-SYNC-0)', () => {
  async function readPersonalizationPage(): Promise<string> {
    const src = await readFile(SETTINGS_MODAL, 'utf8');
    const pageStart = src.indexOf('function PersonalizationSettingsPage');
    assert.notEqual(pageStart, -1, 'PersonalizationSettingsPage must exist');
    return src.slice(pageStart, pageStart + 7000);
  }

  it('PersonalizationSettingsPage syncs state when persisted personalization changes', async () => {
    // Anchor on the function declaration and slice forward by a
    // generous window — the body is ~250 lines but the sync
    // useEffect appears in the first ~30 after init.
    const head = await readPersonalizationPage();
    // useEffect block resetting all three input states from `value.*`.
    assert.match(
      head,
      /useEffect\(\(\) => \{[\s\S]*?setDisplayName\(value\.displayName\)[\s\S]*?setAssistantTone\(value\.assistantTone\)[\s\S]*?setUiLocale\(value\.uiLocale\)[\s\S]*?\},\s*\[\s*value\.displayName,\s*value\.assistantTone,\s*value\.uiLocale,?\s*\]\)/,
      'PersonalizationSettingsPage must sync local state when persisted values change',
    );
  });

  it('PersonalizationSettingsPage scrubs save failures before showing a toast', async () => {
    const page = await readPersonalizationPage();

    assert.match(
      page,
      /catch \(error\) \{[\s\S]*toast\.error\('保存失败', settingsActionErrorMessage\(error\)\)/,
      'Personalization save failures must use the shared Settings error scrubber',
    );
    assert.doesNotMatch(
      page,
      /const message = error instanceof Error \? error\.message : String\(error\)[\s\S]*toast\.error\('保存失败', message\)/,
      'Personalization save failures must not toast raw Error.message',
    );
  });
});
