/**
 * Source-grounded contract for PR-PERSONALIZATION-SYNC-0
 * (WAWQAQ msg 23c079a9 round 7) + PR-TONE-AUTOSAVE-0.
 *
 * The personalization form initializes from
 * `props.settings.personalization` once on mount. Without a sync
 * effect, the visible inputs diverge from the persisted store after
 * server-side sanitization rewrites the saved value.
 *
 * PR-TONE-AUTOSAVE-0: the block used to carry the page's only explicit
 * save control + helper line while every neighbor persisted silently on
 * change/blur. It now autosaves like its siblings — 显示名称 flushes on
 * blur, 界面语言 persists on change, 助手语气偏好 debounces mid-typing and
 * flushes on blur — with no button and no success toast (silence is the
 * page's success language; only failures surface via toast.error).
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { readSettingsCombinedSource } from './settings-contract-source-helpers.js';


describe('Personalization form state sync (PR-PERSONALIZATION-SYNC-0)', () => {
  async function readPersonalizationPage(): Promise<string> {
    const src = await readSettingsCombinedSource();
    const pageStart = src.indexOf('function PersonalizationSettingsPage');
    assert.notEqual(pageStart, -1, 'PersonalizationSettingsPage must exist');
    // Window widened for PR-TONE-AUTOSAVE-0: the autosave rewrite added the
    // shared persist path + per-field handlers, pushing the tone textarea's
    // blur flush (the last JSX row) past the old 7000-char slice.
    return src.slice(pageStart, pageStart + 8500);
  }

  it('PersonalizationSettingsPage syncs state through the shared optimistic draft hook', async () => {
    // The prop→state sync effect (reconcile server-side sanitization or a
    // background settings mutation) and its in-flight pending guard now live
    // inside useOptimisticSettingsDraft; the page drives personalization
    // through it with the personalization narrowing. The guard behavior itself
    // is unit-tested on the hook's controller.
    const head = await readPersonalizationPage();
    assert.match(
      head,
      /useOptimisticSettingsDraft<PersonalizationSettings>\([\s\S]*persistedPersonalization,[\s\S]*\(patch\) => props\.onUpdate\(\{ personalization: patch \}\)\.then\(\(result\) => result\.settings\.personalization\)/,
      'PersonalizationSettingsPage must sync local state through the shared optimistic draft hook',
    );
    assert.match(
      head,
      /draft,[\s\S]*draftRef,[\s\S]*mountedRef: personalizationMountedRef,[\s\S]*commit,[\s\S]*runSave,[\s\S]*persist,/,
      'PersonalizationSettingsPage must read its draft, commit, runSave, and persist from the shared hook',
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

  it('PersonalizationSettingsPage autosaves via a last-write-wins persist path', async () => {
    const page = await readPersonalizationPage();

    // Shared persist helper takes a partial personalization patch and routes
    // through the hook's runSave + persist. Unlike the generic reconcile it must
    // not overwrite the other fields the user may still be editing, so it commits
    // only the reconciled locale, gated on the still-current save.
    assert.match(
      page,
      /async function persistPersonalization\(patch: Partial<PersonalizationSettings>\) \{[\s\S]*?await runSave\(async \(\{ isCurrent \}\) => \{[\s\S]*?const next = await persist\(patch\);[\s\S]*?if \(isCurrent\(\) && patch\.uiLocale !== undefined\) \{[\s\S]*?commit\(\{ \.\.\.draftRef\.current, uiLocale: next\.uiLocale \}\)/,
      'Personalization must persist a partial patch through the shared runSave + persist path (last-write-wins owned by the hook)',
    );
  });

  it('PersonalizationSettingsPage debounces the tone textarea and flushes on blur', async () => {
    const page = await readPersonalizationPage();

    // A debounce timer + a fixed interval constant.
    assert.match(
      page,
      /const TONE_AUTOSAVE_DEBOUNCE_MS = \d+/,
      'Tone autosave must debounce on a fixed interval constant',
    );
    assert.match(
      page,
      /const toneDebounceRef = useRef<ReturnType<typeof setTimeout> \| null>\(null\)/,
      'Tone autosave must hold a debounce timer ref',
    );
    assert.match(
      page,
      /function scheduleToneSave\([\s\S]*?toneDebounceRef\.current = setTimeout\([\s\S]*?assistantTone:[\s\S]*?\},\s*TONE_AUTOSAVE_DEBOUNCE_MS\)/,
      'Tone autosave must schedule a debounced persist after the user stops typing',
    );
    // Blur wins immediately: clears the pending timer and persists now.
    assert.match(
      page,
      /function flushTone\([\s\S]*?clearTimeout\(toneDebounceRef\.current\)[\s\S]*?persistPersonalization\(\{ assistantTone:/,
      'Tone blur must clear the debounce timer and flush the save immediately',
    );
    assert.match(
      page,
      /onBlur=\{\(event\) => flushTone\(event\.currentTarget\.value\)\}/,
      'Tone textarea must flush on blur',
    );
    // The tone textarea change handler must optimistically commit the draft
    // and schedule the debounced save.
    assert.match(
      page,
      /onChange=\{\(event\) => \{[\s\S]*?commit\(\{ \.\.\.draftRef\.current, assistantTone: event\.currentTarget\.value \}\);[\s\S]*?scheduleToneSave\(event\.currentTarget\.value\);/,
      'Tone textarea onChange must commit the optimistic draft and schedule the debounced autosave',
    );
  });

  it('PersonalizationSettingsPage autosaves display name on blur and locale on change', async () => {
    const page = await readPersonalizationPage();

    assert.match(
      page,
      /onBlur=\{\(event\) => flushDisplayName\(event\.currentTarget\.value\)\}[\s\S]*?aria-label="显示名称"/,
      'Display name must flush its autosave on blur',
    );
    assert.match(
      page,
      /onChange=\{\(next\) => persistLocale\(next as UiLocalePreference\)\}[\s\S]*?ariaLabel="界面语言"/,
      'Locale segmented control must persist immediately on change',
    );
  });

  it('PersonalizationSettingsPage has no explicit save control in the personalization block', async () => {
    const page = await readPersonalizationPage();

    // Autosave siblings never render an in-row commit control; the block
    // must not reintroduce one, nor its describing helper id/copy.
    assert.doesNotMatch(
      page,
      /<Button[\s\S]*?onClick=\{\(\) => void save\(\)\}/,
      'Personalization block must not carry an in-row commit control',
    );
    assert.doesNotMatch(
      page,
      /const personalizationSaveHelpId = useId\(\)/,
      'The dropped commit control must not leave its describing help id behind',
    );
    assert.doesNotMatch(
      page,
      /aria-describedby=\{personalizationSaveHelpId\}/,
      'No control should reference the removed persistence-boundary help copy',
    );
  });

  it('PersonalizationSettingsPage stays silent on success (no toast, autosave language)', async () => {
    const page = await readPersonalizationPage();

    // Silence is the page's success language — matching every autosave
    // sibling. No confirmation toast on a successful persist.
    assert.doesNotMatch(
      page,
      /toast\.success\(/,
      'Personalization autosave must not fire a success toast',
    );
    assert.doesNotMatch(
      page,
      /toast\.warning\(/,
      'Personalization autosave must not fire a warning toast',
    );
  });

  it('PersonalizationSettingsPage drops late save UI writes after Settings is closed', async () => {
    const page = await readPersonalizationPage();

    assert.match(
      page,
      /mountedRef: personalizationMountedRef,/,
      'Personalization save must track page ownership (from the shared draft hook) separately from React pending state',
    );
    // Cleanup only drops the pending debounced flush so it can't fire
    // post-unmount; the hook already invalidates any in-flight save's late apply.
    assert.match(
      page,
      /useEffect\(\(\) => \{[\s\S]*return \(\) => \{[\s\S]*clearTimeout\(toneDebounceRef\.current\)/,
      'Personalization cleanup must cancel the pending debounce when Settings closes',
    );
    // A stale canonical locale must not be reconciled into the form after
    // Settings closes: the hook's isCurrent() guard (mount + ticket) gates the
    // local commit.
    assert.match(
      page,
      /if \(isCurrent\(\) && patch\.uiLocale !== undefined\) \{[\s\S]*commit\(\{ \.\.\.draftRef\.current, uiLocale: next\.uiLocale \}\)/,
      'Personalization save must not reconcile a stale UI locale after Settings is closed',
    );
    assert.match(
      page,
      /catch \(error\) \{[\s\S]*if \(isCurrent\(\)\) \{[\s\S]*toast\.error\('保存失败', settingsActionErrorMessage\(error\)\)/,
      'Personalization failure toast must only fire while the page still owns the save',
    );
  });
});
