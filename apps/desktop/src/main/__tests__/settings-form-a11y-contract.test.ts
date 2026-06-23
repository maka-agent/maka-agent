import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, it } from 'node:test';

const repoRoot = process.cwd().endsWith('apps/desktop')
  ? join(process.cwd(), '..', '..')
  : process.cwd();

async function readRepo(path: string): Promise<string> {
  return readFile(join(repoRoot, path), 'utf8');
}

function openingTags(source: string, tagName: 'input' | 'select' | 'textarea'): string[] {
  const tags: string[] = [];
  const re = new RegExp(`<${tagName}\\b`, 'g');
  let match: RegExpExecArray | null;
  while ((match = re.exec(source))) {
    const start = match.index;
    let cursor = start;
    let inQuote: '"' | "'" | null = null;
    while (cursor < source.length) {
      const ch = source[cursor];
      if (inQuote) {
        if (ch === inQuote) inQuote = null;
      } else if (ch === '"' || ch === "'") {
        inQuote = ch;
      } else if (ch === '>' && source[cursor - 1] !== '=') {
        tags.push(source.slice(start, cursor + 1));
        break;
      }
      cursor += 1;
    }
  }
  return tags;
}

describe('Settings form accessibility labels', () => {
  it('keeps Settings secondary surfaces close to reference implementation card geometry', async () => {
    const styles = await readRepo('apps/desktop/src/renderer/styles.css');
    const connectionRow = styles.match(/\.settingsConnectionRow\s*\{[\s\S]*?\}/)?.[0] ?? '';
    const connectionBadge = styles.match(/\.settingsConnectionBadge\s*\{[\s\S]*?\}/)?.[0] ?? '';
    const settingsBadge = styles.match(/\.settingsBadge\s*\{[\s\S]*?\}/)?.[0] ?? '';
    const authContract = styles.match(/\.settingsAuthContract\s*\{[\s\S]*?\}/)?.[0] ?? '';
    // PR-DELETE-ORPHAN-CSS: `.providerEmpty` / `.providerCard` were
    // orphan classes (no TSX consumer); the comma-grouped rule
    // collapsed to `.settingsRow` alone.
    const providerSurfaces = styles.match(/\.settingsRow\s*\{[\s\S]*?\}/g)?.at(0) ?? '';
    const catalogTabsButton = styles.match(/\.catalogTab\s*\{[\s\S]*?\}/)?.[0] ?? '';
    const providerCatalogCard = styles.match(/\.providerCatalogCard\s*\{[\s\S]*?\}/)?.[0] ?? '';
    // PR-DELETE-ORPHAN-CSS: `.providerIcon` was an orphan class
    // (no TSX consumer); the geometry pin moved to the live model
    // table cells which carry the same border-radius family.
    const providerIcon = '';
    const providerCatalogBadge = styles.match(/\.providerCatalogTitle em,\n\.providerCatalogCount\s*\{[\s\S]*?\}/)?.[0] ?? '';
    const providerUnavailableBadge = styles.match(/\.providerCatalogCard\[data-status="unavailable"\]::after\s*\{[\s\S]*?\}/)?.[0] ?? '';
    const providerExperimentalBadge = styles.match(/\.providerCatalogCard\[data-status="experimental"\]::after\s*\{[\s\S]*?\}/)?.[0] ?? '';
    const modelTable = styles.match(/\.modelTable\s*\{[\s\S]*?\}/)?.[0] ?? '';
    const modelTableRow = styles.match(/\.modelTableRow\s*\{[\s\S]*?\}/)?.[0] ?? '';
    const modelTableEmpty = styles.match(/\.modelTableEmpty\s*\{[\s\S]*?\}/)?.[0] ?? '';
    const modelTableChip = styles.match(/\.modelTableChip\s*\{[\s\S]*?\}/)?.[0] ?? '';
    const modelTableDefaultBadge = styles.match(/\.modelTableDefaultBadge\s*\{[\s\S]*?\}/)?.[0] ?? '';
    const settingsRow = styles.match(/\.settingsRow\s*\{[\s\S]*?\}/g)?.at(-1) ?? '';
    const settingsRowValue = styles.match(/\.settingsRow > span\s*\{[\s\S]*?\}/)?.[0] ?? '';
    const settingsRowTitle = styles.match(/\.settingsRow strong\s*\{[\s\S]*?\}/)?.[0] ?? '';

    assert.match(connectionRow, /border-radius:\s*8px;/, 'Settings connection cards should use reference implementation rounded-lg geometry');
    assert.match(connectionRow, /box-shadow:\s*0 1px 3px rgba\(0, 0, 0, 0\.03\);/, 'Settings connection cards should use reference implementation near-flat card shadow');
    assert.match(authContract, /border-radius:\s*8px;/, 'Nested auth contract cards should stay on the same 8px radius');
    assert.match(authContract, /box-shadow:\s*0 1px 3px rgba\(0, 0, 0, 0\.03\);/, 'Nested auth contract cards should keep the same near-flat shadow');
    // PR-DELETE-ORPHAN-CSS: `.providerEmpty` / `.providerCard` were
    // orphan; only `.settingsRow` remains in the live rule. The
    // border-radius / shadow geometry still applies via the same
    // rule which is captured by `providerSurfaces` now.
    assert.match(catalogTabsButton, /border-radius:\s*8px;/, 'Settings model category tabs should use reference implementation rounded-lg geometry');
    assert.match(providerCatalogCard, /border-radius:\s*8px;/, 'Settings provider catalog cards should use reference implementation rounded-lg geometry');
    // PR-DELETE-ORPHAN-CSS: providerIcon assertion removed (orphan).
    assert.match(modelTable, /border-radius:\s*8px;/, 'Settings model table should use the same 8px secondary-surface radius');
    assert.match(modelTable, /box-shadow:\s*0 1px 3px rgba\(0, 0, 0, 0\.03\);/, 'Settings model table should stay near-flat instead of returning to legacy panel shadows');
    assert.match(modelTableRow, /border-radius:\s*8px;/, 'Settings model rows should use compact 8px row geometry');
    assert.match(modelTableEmpty, /border-radius:\s*8px;/, 'Settings model table empty state should align with the same 8px geometry');
    assert.match(providerCatalogBadge, /border-radius:\s*4px;/, 'Provider catalog badges should use compact squared target-layout style corners, not pills');
    assert.match(providerUnavailableBadge, /border-radius:\s*4px;/, 'Provider unavailable badges should use compact squared target-layout style corners, not pills');
    assert.match(providerExperimentalBadge, /border-radius:\s*4px;/, 'Provider experimental badges should use compact squared target-layout style corners, not pills');
    assert.match(modelTableChip, /border-radius:\s*4px;/, 'Settings model capability chips should use compact squared target-layout style corners, not pills');
    assert.match(modelTableDefaultBadge, /border-radius:\s*4px;/, 'Settings model default badge should use compact squared target-layout style corners, not pills');
    assert.match(connectionBadge, /border-radius:\s*4px;/, 'Settings status badges should use compact squared target-layout style corners, not pills');
    assert.match(settingsBadge, /border-radius:\s*4px;/, 'Generic Settings badges should use compact squared target-layout style corners, not pills');
    assert.doesNotMatch(providerCatalogBadge, /border-radius:\s*999px;/, 'Provider catalog badges must not regress to pill-shaped chrome');
    assert.doesNotMatch(providerUnavailableBadge, /border-radius:\s*999px;/, 'Provider unavailable badges must not regress to pill-shaped chrome');
    assert.doesNotMatch(providerExperimentalBadge, /border-radius:\s*999px;/, 'Provider experimental badges must not regress to pill-shaped chrome');
    assert.doesNotMatch(modelTableChip, /border-radius:\s*999px;/, 'Settings model capability chips must not regress to pill-shaped chrome');
    assert.doesNotMatch(modelTableDefaultBadge, /border-radius:\s*999px;/, 'Settings model default badge must not regress to pill-shaped chrome');
    assert.doesNotMatch(connectionBadge, /border-radius:\s*999px;/, 'Settings connection badges must not regress to pill-shaped chrome');
    assert.doesNotMatch(settingsBadge, /border-radius:\s*999px;/, 'Generic Settings badges must not regress to pill-shaped chrome');
    assert.match(settingsRow, /display:\s*grid;/, 'Settings rows should use a stable label/value grid instead of flex auto sizing');
    assert.match(settingsRow, /grid-template-columns:\s*minmax\(150px,\s*0\.36fr\)\s+minmax\(0,\s*1fr\);/, 'Settings rows need a protected label column and shrinkable value column');
    assert.match(settingsRowValue, /overflow-wrap:\s*anywhere;/, 'Long Settings values such as workspace paths should wrap in the value column');
    assert.match(settingsRowValue, /text-align:\s*right;/, 'Short Settings values should keep the existing right-aligned summary rhythm');
    assert.match(settingsRowTitle, /white-space:\s*nowrap;/, 'Settings row labels must not collapse to one Chinese character per line');
  });

  it('keeps migrated Settings text fields and action buttons on shared UI primitives', async () => {
    const settings = await readRepo('apps/desktop/src/renderer/settings/SettingsModal.tsx');
    const passwordInput = await readRepo('apps/desktop/src/renderer/settings/password-input.tsx');
    const providersPanel = await readRepo('apps/desktop/src/renderer/settings/ProvidersPanel.tsx');

    assert.match(settings, /SelectItem,[\s\S]*SelectPopup,[\s\S]*SelectPortal,[\s\S]*SelectPositioner,[\s\S]*SelectRoot,[\s\S]*SelectTrigger,[\s\S]*SelectValue,/);
    assert.match(passwordInput, /import \{ Button, Input, useToast \} from '@maka\/ui';/);
    assert.match(providersPanel, /import \{ Button, PrimitiveTabs, PrimitiveTabsList, PrimitiveTabsTrigger, Input, RelativeTime, Textarea, useToast, useModalA11y \} from '@maka\/ui';/);
    assert.match(settings, /function SettingsSelect<T extends string>/);
    assert.match(settings, /<SelectPositioner alignItemWithTrigger=\{false\} sideOffset=\{6\}>/);

    // ThemeSettingsPage uses native <button> on purpose for the radio-card
    // pickers (mode / palette): the cards are a custom grid with a preview
    // tile + label, and the shared <Button>'s baked-in Tailwind
    // utilities (`h-9 inline-flex bg-primary text-primary-foreground`) collapse
    // the card to a 36px-tall black pill. See `settings-theme-contract.test.ts`
    // which pins the inverse direction (radio cards must stay native).
    // For the general SettingsModal coverage we strip that block out before
    // asserting `no <button>` so the form-primitive rule still bites everywhere
    // else (action buttons, header buttons, etc.).
    const themeBlockRange = (() => {
      const start = settings.indexOf('function ThemeSettingsPage(');
      const end = settings.indexOf('function WebSearchSettingsPage(', start);
      return { start, end };
    })();
    assert.ok(themeBlockRange.start >= 0 && themeBlockRange.end > themeBlockRange.start, 'ThemeSettingsPage block must exist for the radio-card exception window');
    const settingsExceptTheme =
      settings.slice(0, themeBlockRange.start) + settings.slice(themeBlockRange.end);

    for (const [path, source] of [
      ['SettingsModal.tsx (outside ThemeSettingsPage)', settingsExceptTheme],
      ['password-input.tsx', passwordInput],
    ] as const) {
      assert.doesNotMatch(source, /<input\b/, `${path} must use the shared Input primitive for Settings text fields`);
      assert.doesNotMatch(source, /<textarea\b/, `${path} must use the shared Textarea primitive for Settings text areas`);
      assert.doesNotMatch(source, /<select\b/, `${path} must use the Base UI Select primitive for Settings selects`);
      assert.doesNotMatch(source, /<button\b/, `${path} must use the shared Button primitive for Settings buttons`);
      assert.doesNotMatch(source, /className="maka-button/, `${path} must not keep legacy maka-button styling on migrated actions`);
    }

    assert.doesNotMatch(providersPanel, /<input\b/, 'ProvidersPanel must use the shared Input primitive for Settings text fields');
    assert.doesNotMatch(providersPanel, /<textarea\b/, 'ProvidersPanel must use the shared Textarea primitive for Settings text areas');
    assert.doesNotMatch(providersPanel, /<select\b/, 'ProvidersPanel must use the Base UI Select primitive for Settings selects');
    assert.doesNotMatch(providersPanel, /<button\b/, 'ProvidersPanel must use the shared Button primitive for Settings buttons');
  });

  it('keeps shared Settings password copy actions guarded and failure-visible', async () => {
    const passwordInput = await readRepo('apps/desktop/src/renderer/settings/password-input.tsx');

    assert.match(passwordInput, /const toast = useToast\(\)/);
    assert.match(passwordInput, /const copyingRef = useRef\(false\)/);
    assert.match(passwordInput, /if \(copyingRef\.current\) return;/);
    assert.match(passwordInput, /setCopying\(true\)/);
    assert.match(passwordInput, /disabled=\{copying\}/);
    assert.match(passwordInput, /aria-label=\{copying \? '复制中' : justCopied \? '已复制' : '复制'\}/);
    assert.match(passwordInput, /toast\.error\('复制失败', '剪贴板不可用或被系统拒绝。'\)/);
    assert.doesNotMatch(
      passwordInput,
      /clipboard unavailable; silent|catch \{\s*\/\*/,
      'credential copy failures must not be silent',
    );
  });

  it('keeps every Settings input/select/textarea named for assistive tech', async () => {
    for (const path of [
      'apps/desktop/src/renderer/settings/SettingsModal.tsx',
      'apps/desktop/src/renderer/settings/ProvidersPanel.tsx',
    ]) {
      const src = await readRepo(path);
      for (const tagName of ['input', 'select', 'textarea'] as const) {
        for (const tag of openingTags(src, tagName)) {
          assert.match(
            tag,
            /aria-label=|ariaLabel=/,
            `${path} has unnamed <${tagName}>: ${tag.replace(/\s+/g, ' ').slice(0, 180)}`,
          );
        }
      }
    }
  });

  it('names the high-risk Settings fields found by the real app AX sweep', async () => {
    const settings = await readRepo('apps/desktop/src/renderer/settings/SettingsModal.tsx');
    const providers = await readRepo('apps/desktop/src/renderer/settings/ProvidersPanel.tsx');

    for (const label of [
      'Telegram 代理地址',
      'Discord 代理地址',
      '允许的用户 ID',
      '联网搜索真实查询',
      '代理服务器地址',
      '代理端口',
      '开放网关监听地址',
      '开放网关端口',
      '开放网关会话 sessionId',
      '按模型或工具筛选请求记录',
      '请求状态筛选',
      'MEMORY.md 内容',
    ]) {
      assert.ok(
        settings.includes(`aria-label="${label}"`) || settings.includes(`ariaLabel="${label}"`),
        `SettingsModal must label ${label}`,
      );
    }

    for (const label of [
      '模型供应商连接标识',
      '模型供应商显示名称',
      '模型供应商服务地址',
      '模型供应商默认模型',
      '模型连接标识',
      '搜索模型',
    ]) {
      assert.ok(providers.includes(`aria-label="${label}"`), `ProvidersPanel must label ${label}`);
    }
  });

  it('keeps Settings sidebar navigation groups named', async () => {
    const settings = await readRepo('apps/desktop/src/renderer/settings/SettingsModal.tsx');
    const settingsSurface = settings.match(/function SettingsSurface\([\s\S]*?function SettingsPage/)?.[0] ?? '';

    assert.match(settingsSurface, /<nav aria-label="设置分组">/);
    assert.match(
      settingsSurface,
      /<div key=\{group\} className="settingsNavGroup" role="group" aria-label=\{group\}>/,
      'Settings sidebar groups must expose the visible group title to assistive tech',
    );
    assert.doesNotMatch(
      settingsSurface,
      /<div key=\{group\} className="settingsNavGroup">\s*<div className="settingsNavGroupLabel">\{group\}<\/div>/,
      'Settings sidebar navigation groups must not regress to anonymous visual-only labels',
    );
  });
});
