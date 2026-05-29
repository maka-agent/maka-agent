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
    const providerCatalog = await readRepo('packages/core/src/llm-connections.ts');
    assert.doesNotMatch(settings, /comingSoon\??:/, 'Settings nav items must not carry stale comingSoon flags');
    assert.doesNotMatch(settings, /settingsNavBadge/, 'Settings nav must not render stale Roadmap badges');
    assert.doesNotMatch(palette, /即将推出/, 'Command palette settings entries must not advertise dead coming-soon hints');
    assert.doesNotMatch(palette, /comingSoon/, 'Command palette must not read removed nav comingSoon flags');
    assert.doesNotMatch(providers, /即将支持的 OAuth 订阅登录/, 'Providers header must not advertise future OAuth login as a model-provider affordance');
    assert.doesNotMatch(providers, /即将推出|尚未实现|路线图/, 'ProvidersPanel must not show unavailable providers as visible roadmap copy');
    assert.doesNotMatch(providers, /providerComingSoon|未开放配置|聊天发送未开放|未进入配置入口/, 'ProvidersPanel must use product-state account copy instead of coming-soon configuration copy');
    assert.doesNotMatch(providerCatalog, /catalogBadge:\s*'Soon'|future phase/, 'provider catalog metadata must not keep soon/future-phase copy');
    assert.doesNotMatch(styles, /ComingSoonPage|roadmap banner|providerComingSoon|providerCatalogSoon/, 'Settings CSS must not keep stale coming-soon/provider-roadmap naming');
  });

  it('keeps feature status pages product-scoped instead of demo-version or future-roadmap copy', async () => {
    const settings = await readRepo('apps/desktop/src/renderer/settings/SettingsModal.tsx');

    assert.doesNotMatch(settings, /V0\.1|capture smoke|之后会加|后续版本开放/, 'feature status pages must not read like demo-stage roadmap copy');
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
    assert.doesNotMatch(settings, /机器人运行时尚未接入|代码中还没有这个平台的运行时|平台运行时尚未接入|运行时未开放|可用运行时|开放前|收发 smoke/, 'planned bot copy must not expose implementation-status placeholder language');
    assert.doesNotMatch(settings, /providerSupport === 'planned'\s*\?\s*\{\s*label: '未接入'/, 'planned bot list tags should use the shared planned copy');
  });

  it('keeps Permission Center copy scoped to current product boundaries', async () => {
    const settings = await readRepo('apps/desktop/src/renderer/settings/SettingsModal.tsx');
    const permissionPage = settings.match(/function PermissionCenterPage\(\)[\s\S]*?function CapabilityRow/);

    assert.ok(permissionPage, 'Permission Center page block must exist');
    assert.match(permissionPage![0], /只读取系统权限与功能能力的当前快照/, 'Permission Center must explain the current read-only snapshot boundary');
    assert.match(permissionPage![0], /系统设置 → 隐私与安全性/, 'Permission Center must point users to the current OS permission path');
    assert.doesNotMatch(
      permissionPage![0],
      /原生 helper|上线后|接入后|即将可用|未接入/,
      'Permission Center visible copy must not expose implementation roadmap/helper language',
    );
  });

  it('keeps Health Center copy scoped to read-only current signals', async () => {
    const settings = await readRepo('apps/desktop/src/renderer/settings/SettingsModal.tsx');
    const healthPage = settings.match(/function HealthCenterPage\(\)[\s\S]*?function HealthSummaryTile/);

    assert.ok(healthPage, 'Health Center page block must exist');
    assert.match(healthPage![0], /只汇总当前已记录的健康信号/, 'Health Center must explain its current read-only signal boundary');
    assert.match(healthPage![0], /发送通路以运行态探测结果为准/, 'Health Center must keep validation and operational runtime distinct');
    assert.doesNotMatch(
      healthPage![0],
      /接入后|落地后|即将|路线图|尚未实现|TODO|V0\.1/,
      'Health Center visible copy must not read like future roadmap or demo-stage copy',
    );
  });
});
