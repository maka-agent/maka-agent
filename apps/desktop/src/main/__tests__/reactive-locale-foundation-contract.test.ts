import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';

const REPO_ROOT = resolve(import.meta.dirname, '../../../../..');

function rendererSource(file: string): string {
  return readFileSync(resolve(REPO_ROOT, 'apps/desktop/src/renderer', file), 'utf8');
}

function repoSource(file: string): string {
  return readFileSync(resolve(REPO_ROOT, file), 'utf8');
}

describe('reactive locale foundation', () => {
  it('owns one persisted preference and one test override in AppShell state', () => {
    const source = rendererSource('app-shell.tsx');
    const systemLocale = rendererSource('use-system-ui-locale.ts');
    const main = rendererSource('main.tsx');
    const shellAppearance = rendererSource('use-shell-appearance.ts');
    const html = rendererSource('index.html');

    assert.match(source, /useState<UiLocalePreference>\('auto'\)/);
    assert.match(source, /useState<UiLocale \| null>\(null\)/);
    assert.match(
      source,
      /const systemUiLocale = useSystemUiLocale\(\)/,
    );
    assert.match(
      source,
      /const uiLocale = resolveUiLocale\(uiLocalePreference, systemUiLocale, uiLocaleOverride\)/,
    );
    assert.equal(
      (source.match(/resolveUiLocale\(/g) ?? []).length,
      1,
      'AppShell must derive one locale exactly once',
    );
    assert.match(shellAppearance, /setUiLocalePreference\(preference\)/);
    assert.match(shellAppearance, /setUiLocaleOverride\(smoke\?\.locale \?\? null\)/);
    assert.match(
      source,
      /<LocaleProvider locale=\{uiLocale\} override=\{uiLocaleOverride\}>[\s\S]*?<ToastProvider>[\s\S]*?<AppShellOverlays/,
    );
    assert.match(html, /<html lang="en">/, 'the static fallback must match the unsupported-language fallback');
    assert.match(html, /aria-label="Maka"/, 'the pre-JavaScript skeleton must not ship Chinese-only copy');
    assert.match(systemLocale, /resolveSystemUiLocale\(navigator\.languages\)/);
    assert.match(systemLocale, /addEventListener\('languagechange'/);
    assert.match(systemLocale, /removeEventListener\('languagechange'/);
    assert.ok(
      main.indexOf('syncUiLocaleDocument(readSystemUiLocale())')
        < main.indexOf('prefetchOnboardingSnapshot()'),
      'the preload document language must follow the system before asynchronous hydration',
    );
  });

  it('feeds the persisted settings result back into React without a DOM side channel', () => {
    const appShell = rendererSource('app-shell.tsx');
    const shellAppearance = rendererSource('use-shell-appearance.ts');
    const overlays = rendererSource('app-shell-overlays.tsx');
    const modal = rendererSource('settings/SettingsModal.tsx');
    const surface = rendererSource('settings/settings-surface.tsx');
    const appearance = rendererSource('settings/appearance-settings-page.tsx');
    const theme = rendererSource('theme.ts');

    assert.match(overlays, /setUiLocalePreference: \(preference: UiLocalePreference\) => void/);
    assert.match(modal, /onUiLocalePreferenceChange\(preference: UiLocalePreference\): void/);
    assert.match(shellAppearance, /const \[uiLocaleUpdateGate\] = useState\(createUiLocaleUpdateGate\)/);
    assert.match(shellAppearance, /uiLocaleUpdateGate\.beginHydration\(\)/);
    assert.match(shellAppearance, /uiLocaleUpdateGate\.commitHydration\(/);
    assert.match(appShell, /uiLocaleUpdateGate=\{uiLocaleUpdateGate\}/);
    assert.match(surface, /uiLocaleUpdateGate: UiLocaleUpdateGate/);
    assert.doesNotMatch(surface, /useState\(createUiLocaleUpdateGate\)/);
    assert.match(
      surface,
      /uiLocaleUpdateGate\.commit\([\s\S]*next\.personalization\.uiLocale,[\s\S]*props\.onUiLocalePreferenceChange,[\s\S]*\);[\s\S]*if \(settingsModalMountedRef\.current/,
      'locale success must reach AppShell independently of local Settings ownership',
    );
    assert.doesNotMatch(appearance, /applyUiLocale/);
    assert.doesNotMatch(theme, /applyUiLocale|UiLocalePreference/);
  });

  it('keeps e2e-fixture locale overrides in the same provider path', () => {
    const source = rendererSource('app-shell-e2e-fixture.ts');
    const shellAppearance = rendererSource('use-shell-appearance.ts');

    assert.match(source, /setUiLocaleOverride: Dispatch<SetStateAction<UiLocale \| null>>/);
    assert.match(source, /setUiLocaleOverride\(state\.locale \?\? null\)/);
    assert.doesNotMatch(source, /data-maka-e2e-fixture-locale/);
    assert.ok(
      shellAppearance.indexOf('setUiLocaleOverride(smoke?.locale ?? null)')
        < shellAppearance.indexOf('uiLocaleUpdateGate.commitHydration('),
      'e2e-fixture override hydration must not be gated by persisted preference hydration',
    );
  });

  it('uses the reactive locale for desktop copy and Intl formatting', () => {
    const onboarding = rendererSource('OnboardingHero.tsx');
    const artifact = rendererSource('artifact-pane.tsx');
    const toolPreview = repoSource('packages/ui/src/tool-activity/builtin-preview.ts');

    assert.match(onboarding, /useUiLocale\(\)/);
    assert.match(artifact, /useUiLocale\(\)/);
    assert.match(artifact, /formatRelativeTimestamp\(record\.createdAt, Date\.now\(\), locale\)/);
    assert.doesNotMatch(onboarding, /detectUiLocale/);
    assert.doesNotMatch(toolPreview, /detectUiLocale/);
    assert.match(toolPreview, /locale: UiLocale/);
  });

  it('keeps provider catalog copy on the same reactive locale path', () => {
    const display = rendererSource('settings/provider-display.tsx');
    const copy = rendererSource('settings/provider-display-copy.ts');

    assert.doesNotMatch(display, /detectUiLocale/);
    assert.match(display, /locale: UiLocale/);
    assert.doesNotMatch(display, /locale:\s*UiLocale\s*=/, 'providerDisplay must not infer a locale');
    assert.match(copy, /satisfies Record<ProviderType, UiCatalog<ProviderCopy>>/);
    assert.doesNotMatch(copy, /ProviderDisplayLocale/);

    for (const file of [
      'OnboardingHero.tsx',
      'settings/provider-add-form.tsx',
      'settings/provider-catalog.tsx',
      'settings/provider-connection-detail.tsx',
      'settings/ProvidersPanel.tsx',
    ]) {
      const source = rendererSource(file);
      assert.match(source, /useUiLocale\(\)/, `${file} must consume the reactive locale`);
      assert.doesNotMatch(
        source,
        /providerDisplay\([^,\n)]+\)/,
        `${file} must pass the reactive locale to providerDisplay`,
      );
    }
  });
});
