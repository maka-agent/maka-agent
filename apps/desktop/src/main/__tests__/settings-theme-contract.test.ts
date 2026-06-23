import { strict as assert } from 'node:assert';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, it } from 'node:test';

const repoRoot = process.cwd().endsWith('apps/desktop')
  ? join(process.cwd(), '..', '..')
  : process.cwd();

async function readRepo(path: string): Promise<string> {
  return readFile(join(repoRoot, path), 'utf8');
}

describe('Settings theme page contract', () => {
  it('keeps instant appearance preview but surfaces persistence failures', async () => {
    const src = await readRepo('apps/desktop/src/renderer/settings/SettingsModal.tsx');
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
    const src = await readRepo('apps/desktop/src/renderer/settings/SettingsModal.tsx');
    const themePage = src.match(/function ThemeSettingsPage\([\s\S]*?function WebSearchSettingsPage/)?.[0] ?? '';

    assert.match(
      themePage,
      /const themePageMountedRef = useRef\(false\);[\s\S]*const themePersistTicketRef = useRef\(0\);/,
      'Theme page must track mounted state and the newest persistence request',
    );
    assert.match(
      themePage,
      /useEffect\(\(\) => \{[\s\S]*themePageMountedRef\.current = true;[\s\S]*return \(\) => \{[\s\S]*themePageMountedRef\.current = false;[\s\S]*themePersistTicketRef\.current \+= 1;/,
      'Theme page cleanup must invalidate in-flight appearance persistence requests',
    );
    assert.match(
      themePage,
      /const ticket = \+\+themePersistTicketRef\.current;[\s\S]*catch \(error\) \{[\s\S]*if \(themePageMountedRef\.current && ticket === themePersistTicketRef\.current\) \{[\s\S]*toast\.error\('保存外观设置失败', settingsActionErrorMessage\(error\)\);/,
      'Only the latest mounted theme persistence failure may show a toast',
    );
  });

  it('supports standard radiogroup keyboard navigation for appearance controls', async () => {
    const src = await readRepo('apps/desktop/src/renderer/settings/SettingsModal.tsx');
    const helperBlock = src.match(/function onSettingsRadioGroupKeyDown[\s\S]*?function radioTabIndex/)?.[0] ?? '';
    const themePage = src.match(/function ThemeSettingsPage\([\s\S]*?function WebSearchSettingsPage/)?.[0] ?? '';
    const segmentedBlock = src.match(/function Segmented[\s\S]*?function Switch/)?.[0] ?? '';

    assert.match(helperBlock, /nextRadioId\(current, values, event\.key\)/);
    assert.match(helperBlock, /event\.preventDefault\(\)/);
    assert.match(helperBlock, /onChange\(next\)/);
    assert.match(helperBlock, /const group = event\.currentTarget/);
    assert.match(helperBlock, /setTimeout\(\(\) => focusRadioValue\(group, next\), 0\)/);
    assert.match(themePage, /aria-label="主题"[\s\S]*onKeyDown=\{\(event\) => onSettingsRadioGroupKeyDown/);
    assert.match(themePage, /aria-label=\{group\.label\}[\s\S]*onKeyDown=\{\(event\) => onSettingsRadioGroupKeyDown/);
    assert.match(themePage, /data-radio-value=\{option\.value\}[\s\S]*tabIndex=\{radioTabIndex\(option\.value, props\.themePref/);
    assert.match(themePage, /data-radio-value=\{palette\}[\s\S]*tabIndex=\{radioTabIndex\(palette, currentPalette, group\.palettes\)\}/);
    assert.doesNotMatch(themePage, /界面密度|props\.density|setDensity|onDensityChange/);
    assert.match(segmentedBlock, /if \(props\.disabled\) return;[\s\S]*onSettingsRadioGroupKeyDown\(event, values, props\.value, props\.onChange\)/);
    assert.match(segmentedBlock, /aria-disabled=\{props\.disabled \? 'true' : undefined\}/);
    assert.match(segmentedBlock, /disabled=\{props\.disabled\}/);
    assert.match(segmentedBlock, /data-radio-value=\{value\}[\s\S]*tabIndex=\{radioTabIndex\(value, props\.value, values\)\}/);
  });

  it('keeps theme and palette radio cards on native <button>, not <Button>', async () => {
    // Regression guard for WAWQAQ msg 5f75daf6 — commit b40d097 swapped
    // these cards onto packages/ui's <Button>, which bakes in
    // `h-9 inline-flex bg-primary text-primary-foreground` Tailwind
    // utilities that collapse each card to a 36px-tall black pill and
    // hide the swatch + label. The radio-card pattern needs the custom
    // grid layout in `.settingsThemeOption`, so it must stay on
    // a native <button> element.
    const src = await readRepo('apps/desktop/src/renderer/settings/SettingsModal.tsx');
    const themePage = src.match(/function ThemeSettingsPage\([\s\S]*?function WebSearchSettingsPage/)?.[0] ?? '';
    // Source order: each radio-card block opens with `<button` (not `<Button`)
    // and the className appears later. The `\b` boundary keeps `<button` from
    // matching `<Button`. Strip `//` line comments and `/* */` block comments
    // first so the regression-explainer comments don't confuse the count.
    const themePageNoComments = themePage
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/[^\n]*/g, '');
    const lcButtonCount = (themePageNoComments.match(/<button\b/g) ?? []).length;
    const ucButtonCount = (themePageNoComments.match(/<Button\b/g) ?? []).length;
    assert.equal(
      ucButtonCount,
      0,
      `Theme/palette radio cards must use native <button>, not <Button> from packages/ui (found ${ucButtonCount} <Button> occurrences in the page)`,
    );
    assert.equal(
      lcButtonCount,
      2,
      `Expected exactly 2 native <button> elements (mode picker, palette picker), found ${lcButtonCount}`,
    );
    assert.match(themePage, /className="settingsThemeOption settingsThemeOptionPreview"/);
    assert.match(themePage, /className="settingsThemeOption settingsPaletteOption"/);
    assert.doesNotMatch(themePage, /界面密度|settingsDensitySwatch|setDensity/);
  });

  it('keeps theme page copy Chinese-first and user-facing', async () => {
    const src = await readRepo('apps/desktop/src/renderer/settings/SettingsModal.tsx');
    const themePage = src.match(/function ThemeSettingsPage\([\s\S]*?function WebSearchSettingsPage/)?.[0] ?? '';
    const themeCopy = [
      src.match(/const THEME_OPTIONS[\s\S]*?\];/)?.[0] ?? '',
      src.match(/const PALETTE_HELP[\s\S]*?\};/)?.[0] ?? '',
      themePage.match(/<p className="settingsHelpText">[\s\S]*?<\/p>/)?.[0] ?? '',
    ].join('\n');

    assert.match(themeCopy, /匹配 macOS 当前浅色或深色偏好。/);
    assert.match(themeCopy, /Maka 原本的紫色强调色/);
    assert.match(themeCopy, /湖蓝强调色，干净冷静/);
    assert.match(themeCopy, /保存在本地外观设置里下次启动延续/);
    assert.doesNotMatch(
      themeCopy,
      /Light\/Dark|settings\.json|safeStorage|API key|accent|IDE/,
      'Theme settings visible copy must not leak implementation or English UI terms',
    );
  });

  it('keeps shared Button chrome from collapsing theme choice cards', async () => {
    const css = await readRepo('apps/desktop/src/renderer/styles.css');

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
