import { strict as assert } from 'node:assert';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { readRendererContractCss } from './contract-css-helpers.js';
import { readSettingsCombinedSource } from './settings-contract-source-helpers.js';

const repoRoot = process.cwd().endsWith('apps/desktop')
  ? join(process.cwd(), '..', '..')
  : process.cwd();

async function readRepo(path: string): Promise<string> {
  return readFile(join(repoRoot, path), 'utf8');
}

describe('Settings theme page contract', () => {
  it('keeps instant appearance preview but surfaces persistence failures', async () => {
    const src = await readSettingsCombinedSource();
    const themePage = src.match(/function ThemeSettingsPage\([\s\S]*?function WebSearchSettingsPage/);

    assert.ok(themePage, 'Theme settings page block must exist');
    assert.match(
      themePage![0],
      /async function persistAppearance\(patch: NonNullable<Parameters<typeof window\.maka\.settings\.update>\[0\]\['appearance'\]>\)/,
      'Theme page must centralize appearance persistence',
    );
    assert.match(
      themePage![0],
      /const ticket = \+\+themePersistTicketRef\.current;[\s\S]*try \{[\s\S]*await props\.onUpdate\(\{ appearance: patch \}\)[\s\S]*catch \(error\) \{[\s\S]*if \(themePageMountedRef\.current && ticket === themePersistTicketRef\.current\) \{[\s\S]*toast\.error\('保存外观设置失败', settingsActionErrorMessage\(error\)\)/,
      'Appearance persistence failures must show a user-visible toast only for the latest mounted request',
    );
    assert.match(
      themePage![0],
      /props\.onThemeChange\(next\);[\s\S]*await persistAppearance\(\{ theme: next \}\)/,
      'Theme changes must keep instant preview before persisting',
    );
    assert.match(
      themePage![0],
      /props\.onThemePaletteChange\(next\);[\s\S]*await persistAppearance\(\{ palette: next \}\)/,
      'Palette changes must keep instant preview before persisting',
    );
    assert.doesNotMatch(
      themePage![0],
      /await props\.onUpdate\(\{ appearance: \{ (theme|palette): next \} \}\)/,
      'Appearance controls must not call raw settings update without the fail-soft helper',
    );
  });

  it('drops stale or late theme persistence errors after newer choices or unmount', async () => {
    const src = await readSettingsCombinedSource();
    const themePage = src.match(/function ThemeSettingsPage\([\s\S]*?function WebSearchSettingsPage/)?.[0] ?? '';

    assert.match(
      themePage,
      /const themePageMountedRef = useMountedRef\(\);[\s\S]*const themePersistTicketRef = useRef\(0\);/,
      'Theme page must track mounted state and the newest persistence request',
    );
    assert.match(
      themePage,
      /useEffect\(\(\) => \{[\s\S]*return \(\) => \{[\s\S]*themePersistTicketRef\.current \+= 1;/,
      'Theme page cleanup must invalidate in-flight appearance persistence requests',
    );
    assert.match(
      themePage,
      /const ticket = \+\+themePersistTicketRef\.current;[\s\S]*catch \(error\) \{[\s\S]*if \(themePageMountedRef\.current && ticket === themePersistTicketRef\.current\) \{[\s\S]*toast\.error\('保存外观设置失败', settingsActionErrorMessage\(error\)\);/,
      'Only the latest mounted theme persistence failure may show a toast',
    );
  });

  it('supports standard radiogroup keyboard navigation for appearance controls', async () => {
    const src = await readSettingsCombinedSource();
    const themePage = src.match(/function ThemeSettingsPage\([\s\S]*?function WebSearchSettingsPage/)?.[0] ?? '';

    // PR round-c-choice-card-primitive + PR yuejing/settings-segmented-
    // primitive: Theme/Palette via Base UI `RadioGroup`-backed
    // `ChoiceCardGroup`; Segmented via Base UI `ToggleGroup`-backed
    // `SettingsSegmented`. Both primitives provide arrow-key
    // navigation, focus management, and roving tabindex for free, so
    // the hand-rolled `onSettingsRadioGroupKeyDown` /
    // `focusRadioValue` / `radioTabIndex` helpers are gone from
    // SettingsModal.tsx. The provider connection dialog no longer
    // contains a hand-rolled default-model radiogroup.
    assert.doesNotMatch(src, /function onSettingsRadioGroupKeyDown/);
    assert.doesNotMatch(src, /function focusRadioValue/);
    assert.doesNotMatch(src, /function radioTabIndex/);
    assert.doesNotMatch(src, /import \{ nextRadioId \} from '\.\/model-table-keyboard'/);

    // Theme + palette pickers must use `ChoiceCardGroup` with
    // `value` + `onValueChange` semantics, NOT the legacy keyboard
    // helpers or `data-radio-value` attribute.
    assert.match(themePage, /<ChoiceCardGroup[\s\S]*aria-label="主题"[\s\S]*value=\{props\.themePref\}[\s\S]*onValueChange/);
    assert.match(themePage, /<ChoiceCardGroup[\s\S]*aria-label=\{group\.label\}[\s\S]*value=\{currentPalette\}[\s\S]*onValueChange/);
    assert.doesNotMatch(themePage, /onSettingsRadioGroupKeyDown|radioTabIndex|data-radio-value/);
    assert.doesNotMatch(themePage, /界面密度|props\.density|setDensity|onDensityChange/);

    // Segmented now comes from `@maka/ui` as `SettingsSegmented`,
    // imported aliased as `Segmented`. The local `function Segmented`
    // declaration must be gone.
    assert.match(src, /SettingsSegmented as Segmented/);
    assert.doesNotMatch(src, /^function Segmented</m);
  });

  it('uses the ChoiceCard primitive (not native <button> or shared <Button>) for theme + palette cards', async () => {
    // Regression history:
    //   1. Original `<Button>` migration (commit b40d097, WAWQAQ msg
    //      5f75daf6) baked `h-9 inline-flex bg-primary` utilities into
    //      the cards, collapsing each to a 36px black pill. Reverted
    //      to native `<button role="radio">` + manual keyboard nav.
    //   2. Round C (PR round-c-choice-card-primitive, WAWQAQ msg
    //      4f598b19) replaces the native `<button>` with a Base UI
    //      `Radio.Root`-backed `ChoiceCard` primitive. The primitive
    //      intentionally applies NO layout/background utilities so the
    //      existing `.settingsThemeOption*` chrome rules still own the
    //      visuals; the migration only moves semantics (data-checked,
    //      keyboard nav, focus) into Base UI.
    // This test pins step 2 and prevents regressing back to either
    // shared `<Button>` (which still has the 36px-pill problem) or
    // hand-rolled native `<button>` (which loses Base UI's keyboard
    // and focus contract).
    const src = await readSettingsCombinedSource();
    const themePage = src.match(/function ThemeSettingsPage\([\s\S]*?function WebSearchSettingsPage/)?.[0] ?? '';
    const themePageNoComments = themePage
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/[^\n]*/g, '');
    const lcButtonCount = (themePageNoComments.match(/<button\b/g) ?? []).length;
    const ucButtonCount = (themePageNoComments.match(/<Button\b/g) ?? []).length;
    const choiceCardCount = (themePageNoComments.match(/<ChoiceCard\b/g) ?? []).length;
    const choiceCardGroupCount = (themePageNoComments.match(/<ChoiceCardGroup\b/g) ?? []).length;
    assert.equal(
      lcButtonCount,
      0,
      `Theme/palette cards must use the ChoiceCard primitive, not native <button> (found ${lcButtonCount} <button> occurrences in the page)`,
    );
    assert.equal(
      ucButtonCount,
      0,
      `Theme/palette cards must use the ChoiceCard primitive, not the shared <Button> (found ${ucButtonCount} <Button> occurrences — see the b40d097 regression note)`,
    );
    assert.equal(
      choiceCardCount,
      2,
      `Expected exactly 2 <ChoiceCard> elements (one per .map for theme + palette), found ${choiceCardCount}`,
    );
    assert.equal(
      choiceCardGroupCount,
      2,
      `Expected exactly 2 <ChoiceCardGroup> elements (theme group + palette group), found ${choiceCardGroupCount}`,
    );
    assert.match(themePage, /className="settingsThemeOption settingsThemeOptionPreview"/);
    assert.match(themePage, /className="settingsThemeOption settingsPaletteOption"/);
    assert.doesNotMatch(themePage, /界面密度|settingsDensitySwatch|setDensity/);
  });

  it('keeps theme page copy Chinese-first and user-facing', async () => {
    const src = await readSettingsCombinedSource();
    const themePage = src.match(/function ThemeSettingsPage\([\s\S]*?function WebSearchSettingsPage/)?.[0] ?? '';
    const themeCopy = [
      src.match(/const THEME_OPTIONS[\s\S]*?\];/)?.[0] ?? '',
      src.match(/const PALETTE_HELP[\s\S]*?\};/)?.[0] ?? '',
      themePage.match(/<p className="settingsHelpText">[\s\S]*?<\/p>/)?.[0] ?? '',
    ].join('\n');

    assert.match(themeCopy, /匹配 macOS 当前浅色或深色偏好。/);
    // Brand accent is logo blue now (owner decision 2026-07-03); the old
    // pinned copy still claimed a purple accent.
    assert.match(themeCopy, /Maka 品牌蓝强调色/);
    assert.match(themeCopy, /湖蓝强调色，干净冷静/);
    assert.match(themeCopy, /保存在本地外观设置里下次启动延续/);
    assert.doesNotMatch(
      themeCopy,
      /Light\/Dark|settings\.json|safeStorage|API key|accent|IDE/,
      'Theme settings visible copy must not leak implementation or English UI terms',
    );
  });

  it('keeps shared Button chrome from collapsing theme choice cards', async () => {
    const css = await readRendererContractCss();

    assert.match(
      css,
      /\.settingsThemeOption \{[\s\S]*height:\s*auto;[\s\S]*min-height:\s*48px;[\s\S]*justify-content:\s*stretch;[\s\S]*overflow:\s*hidden;[\s\S]*white-space:\s*normal;/,
      'Theme option cards must reset shared Button defaults instead of inheriting h-9/centered chrome',
    );
    assert.match(
      css,
      /\.settingsThemeOptionPreview \{[\s\S]*align-items:\s*stretch;[\s\S]*min-height:\s*116px;/,
      'Theme preview cards must reserve enough vertical space for preview plus label',
    );
    assert.match(
      css,
      /\.settingsThemePreview \{[\s\S]*max-height:\s*70px;[\s\S]*aspect-ratio:\s*16 \/ 8;[\s\S]*overflow:\s*hidden;/,
      'Theme preview mocks must be bounded so they cannot cover visible labels',
    );
    assert.match(
      css,
      /\.settingsThemePreviewPane\[data-mode="light"\] \{[\s\S]*background:\s*oklch\(1\.000 0 0\);[\s\S]*color:\s*oklch\(0\.18 0 0\);/,
      'Light theme preview must show the target-layout style white content surface, not the old parchment hue',
    );
    assert.match(
      css,
      /\.settingsThemePreviewPane\[data-mode="light"\] \.settingsThemePreviewSidebar \{[\s\S]*background:\s*oklch\(0\.955 0 0\);/,
      'Light theme preview sidebar must show the gray shell backplate',
    );
    assert.doesNotMatch(
      css,
      /settingsThemePreviewPane[\s\S]{0,260}oklch\([^)]*75\)/,
      'Theme preview tiles must not keep the old warm parchment hue after the gray-shell baseline',
    );
    assert.match(
      css,
      /\.settingsThemeLabel strong \{[\s\S]*overflow:\s*hidden;[\s\S]*text-overflow:\s*ellipsis;[\s\S]*white-space:\s*nowrap;/,
      'Long palette names must stay inside their option cards',
    );
  });
});
