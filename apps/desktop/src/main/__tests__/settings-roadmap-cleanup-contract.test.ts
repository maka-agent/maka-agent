import { strict as assert } from 'node:assert';
import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';
import { join } from 'node:path';

const repoRoot = process.cwd().endsWith('apps/desktop')
  ? join(process.cwd(), '..', '..')
  : process.cwd();

async function readRepo(path: string): Promise<string> {
  return readFile(join(repoRoot, path), 'utf8');
}

describe('Settings coming-soon cleanup contract', () => {
  it('does not keep the old generic ComingSoon page registry or fallback renderer', async () => {
    const src = await readRepo('apps/desktop/src/renderer/settings/SettingsModal.tsx');
    assert.doesNotMatch(src, /type\s+ComingSoonCopy\b/, 'Settings must not keep a generic roadmap-page copy registry');
    assert.doesNotMatch(src, /COMING_SOON_PAGES/, 'Settings must not route sections through an empty coming-soon registry');
    assert.doesNotMatch(src, /function\s+ComingSoonPage\b/, 'Settings must not keep the generic unimplemented-page template');
    assert.doesNotMatch(src, /function\s+ComingSoonSection\b/, 'Settings must not keep generic coming-soon sections');
  });

  it('does not expose nav-level comingSoon state or command-palette soon hints', async () => {
    const settings = await readRepo('apps/desktop/src/renderer/settings/SettingsModal.tsx');
    const providers = await readRepo('apps/desktop/src/renderer/settings/ProvidersPanel.tsx');
    const palette = await readRepo('apps/desktop/src/renderer/command-palette.tsx');
    const styles = await readRepo('apps/desktop/src/renderer/styles.css');
    assert.doesNotMatch(settings, /comingSoon\??:/, 'Settings nav items must not carry stale comingSoon flags');
    assert.doesNotMatch(settings, /settingsNavBadge/, 'Settings nav must not render stale Roadmap badges');
    assert.doesNotMatch(palette, /即将推出/, 'Command palette settings entries must not advertise dead coming-soon hints');
    assert.doesNotMatch(palette, /comingSoon/, 'Command palette must not read removed nav comingSoon flags');
    assert.doesNotMatch(providers, /即将支持的 OAuth 订阅登录/, 'Providers header must not advertise future OAuth login as a model-provider affordance');
    assert.doesNotMatch(providers, /即将推出|尚未实现|路线图/, 'ProvidersPanel must not show unavailable providers as visible roadmap copy');
    assert.doesNotMatch(styles, /ComingSoonPage|roadmap banner/, 'Settings CSS comments must not keep stale roadmap-page naming');
  });

  it('keeps feature status pages product-scoped instead of demo-version or future-roadmap copy', async () => {
    const settings = await readRepo('apps/desktop/src/renderer/settings/SettingsModal.tsx');

    assert.doesNotMatch(settings, /V0\.1|capture smoke|之后会加/, 'feature status pages must not read like demo-stage roadmap copy');
    assert.match(settings, /本地汇总/, 'Daily Review status badge should describe the shipped local aggregate mode');
    assert.match(settings, /今日 \/ 本周 \/ 本月/, 'Daily Review settings copy must mention the shipped range switcher');
    assert.match(settings, /复制 Markdown 摘要/, 'Daily Review settings copy must mention the shipped Markdown copy action');
    assert.match(settings, /本地自检/, 'Voice status badge should describe the shipped local smoke boundary');
  });

  it('keeps planned bot platforms out of the credentials-readiness flow', async () => {
    const settings = await readRepo('apps/desktop/src/renderer/settings/SettingsModal.tsx');

    assert.match(settings, /const BOT_PLANNED_COPY\b/, 'Settings bot page needs a dedicated planned-platform copy contract');
    assert.match(settings, /function botReadinessCopyForSupport\b/, 'Settings bot page must route readiness copy through support-aware presentation');
    assert.match(settings, /if \(support === 'planned'\) return BOT_PLANNED_COPY;/, 'planned bot platforms must not reuse credential-readiness copy');
    assert.doesNotMatch(settings, /机器人运行时尚未接入|代码中还没有这个平台的运行时|平台运行时尚未接入/, 'planned bot copy must not expose implementation-status placeholder language');
    assert.doesNotMatch(settings, /providerSupport === 'planned'\s*\?\s*\{\s*label: '未接入'/, 'planned bot list tags should use the shared planned copy');
  });
});
