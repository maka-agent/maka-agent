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

  it('PersonalizationSettingsPage gates saves synchronously and freezes the draft while saving', async () => {
    const page = await readPersonalizationPage();

    assert.match(
      page,
      /const savingRef = useRef\(false\)/,
      'Personalization save must have a synchronous ref gate, not only React state',
    );
    assert.match(
      page,
      /async function save\(\) \{[\s\S]*if \(savingRef\.current\) return;[\s\S]*savingRef\.current = true;[\s\S]*setSaving\(true\)/,
      'Personalization save must lock before the first async settings update',
    );
    assert.match(
      page,
      /finally \{[\s\S]*savingRef\.current = false;[\s\S]*setSaving\(false\)/,
      'Personalization save must release the synchronous gate in finally',
    );
    assert.match(
      page,
      /disabled=\{saving\}[\s\S]*aria-label="显示名称"/,
      'Display name input must freeze while the saved payload is in flight',
    );
    assert.match(
      page,
      /ariaLabel="界面语言"[\s\S]*disabled=\{saving\}/,
      'Locale segmented control must freeze while the saved payload is in flight',
    );
    assert.match(
      page,
      /disabled=\{saving\}[\s\S]*aria-label="助手语气偏好"/,
      'Assistant tone textarea must freeze while the saved payload is in flight',
    );
    assert.match(
      page,
      /disabled=\{saving\}[\s\S]*aria-busy=\{saving\}[\s\S]*data-pending=\{saving \? 'true' : undefined\}/,
      'Save button must expose pending state to the UI and accessibility tree',
    );
  });

  it('PersonalizationSettingsPage describes the save action with its persistence boundary copy', async () => {
    const page = await readPersonalizationPage();

    assert.match(
      page,
      /const personalizationSaveHelpId = useId\(\)/,
      'Personalization save help copy must have a stable React-generated id',
    );
    assert.match(
      page,
      /aria-describedby=\{personalizationSaveHelpId\}/,
      'Personalization save button must reference the visible persistence boundary help text',
    );
    assert.match(
      page,
      /<p id=\{personalizationSaveHelpId\} className="settingsHelpText">保存后立即生效，下一次发送对话时模型会拿到新偏好。<\/p>/,
      'Personalization save help text must remain visible and programmatically associated',
    );
  });

  it('PersonalizationSettingsPage drops late save UI writes after Settings is closed', async () => {
    const page = await readPersonalizationPage();

    assert.match(
      page,
      /const personalizationMountedRef = useRef\(false\)/,
      'Personalization save must track page ownership separately from React pending state',
    );
    assert.match(
      page,
      /useEffect\(\(\) => \{[\s\S]*personalizationMountedRef\.current = true;[\s\S]*return \(\) => \{[\s\S]*personalizationMountedRef\.current = false;[\s\S]*savingRef\.current = false;/,
      'Personalization cleanup must release the synchronous save owner when Settings closes',
    );
    assert.match(
      page,
      /const result = await props\.onUpdate\([\s\S]*?\);[\s\S]*if \(!personalizationMountedRef\.current\) return;[\s\S]*applyUiLocale\(uiLocale\);/,
      'Personalization save must not apply a stale UI locale after Settings is closed',
    );
    assert.match(
      page,
      /if \(warnings\) \{[\s\S]*if \(personalizationMountedRef\.current\) \{[\s\S]*toast\.warning\('已保存并做安全清理'/,
      'Personalization warning toast must only fire while the page is still mounted',
    );
    assert.match(
      page,
      /else \{[\s\S]*if \(personalizationMountedRef\.current\) \{[\s\S]*toast\.success\('个性化已保存'\)/,
      'Personalization success toast must only fire while the page is still mounted',
    );
    assert.match(
      page,
      /catch \(error\) \{[\s\S]*if \(personalizationMountedRef\.current\) \{[\s\S]*toast\.error\('保存失败', settingsActionErrorMessage\(error\)\)/,
      'Personalization failure toast must only fire while the page is still mounted',
    );
    assert.match(
      page,
      /finally \{[\s\S]*savingRef\.current = false;[\s\S]*if \(personalizationMountedRef\.current\) \{[\s\S]*setSaving\(false\);/,
      'Personalization save cleanup must not write React state after unmount',
    );
  });
});
