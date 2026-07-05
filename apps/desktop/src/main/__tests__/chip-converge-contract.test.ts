import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT } from './css-test-helpers.js';

const read = (rel: string) => readFileSync(join(REPO_ROOT, rel), 'utf8');

// #520 PR9 commit 2: settings status chips converge onto a dedicated Chip
// primitive (squared, compact, status-tone), NOT the pill Badge primitive.
// Badge and Chip are two distinct UI roles — pill Badge for emphasis markers
// (health/permission center), squared Chip for dense settings status rows.
// This contract keeps the two tracks apart and locks Chip to radius-control.
test('chip converge (#520 PR9)', async () => {
  // 1. Chip primitive exists + carries data-slot
  const chipSrc = read('packages/ui/src/primitives/chip.tsx');
  assert.match(chipSrc, /export function Chip/, 'Chip primitive must be exported');
  assert.match(chipSrc, /["']?data-slot["']?\s*[:=]\s*["']chip["']/, 'Chip must carry data-slot="chip"');

  // 2. Chip locks radius-control (squared), never pill
  assert.match(chipSrc, /rounded-\[var\(--radius-control\)\]/, 'Chip must use radius-control (squared, not pill)');
  assert.doesNotMatch(chipSrc, /rounded-\[var\(--radius-pill\)\]/, 'Chip must not regress to pill');

  // 3. index.ts re-exports Chip
  const indexSrc = read('packages/ui/src/index.ts');
  assert.match(indexSrc, /export (?:\*|\{[^}]*\bChip\b[^}]*\}) from ['"]\.\/primitives\/chip\.js['"]/, 'index.ts must re-export Chip');

  // 4. settings CSS chips retired (.settingsBadge / .settingsConnectionBadge)
  const botCss = read('apps/desktop/src/renderer/styles/settings/bot.css');
  assert.doesNotMatch(botCss, /\.settingsBadge\s*\{/, '.settingsBadge CSS rule must be retired');
  const connCss = read('apps/desktop/src/renderer/styles/settings/connection.css');
  assert.doesNotMatch(connCss, /\.settingsConnectionBadge\s*[\{[,]/, '.settingsConnectionBadge CSS rule must be retired');

  // 5. settings chip sites import and use Chip primitive, not the CSS spans
  const CHIP_IMPORT_RE =
    /import\s+\{[^}]*\bChip\b[^}]*\}\s+from\s+['"][^'"]*?(?:@maka\/ui|primitives\/chip\.js)['"]/;
  const settingsChipFiles = [
    'apps/desktop/src/renderer/settings/provider-connection-detail.tsx',
    'apps/desktop/src/renderer/settings/provider-add-form.tsx',
    'apps/desktop/src/renderer/settings/web-search-settings-page.tsx',
    'apps/desktop/src/renderer/settings/memory-settings-page.tsx',
    'apps/desktop/src/renderer/settings/account-settings-page.tsx',
    'apps/desktop/src/renderer/settings/provider-oauth-section.tsx',
  ];
  for (const rel of settingsChipFiles) {
    const src = read(rel);
    assert.match(src, CHIP_IMPORT_RE, `${rel} must import Chip`);
    assert.doesNotMatch(src, /className=["'][^"']*settingsBadge/, `${rel} must not use .settingsBadge span`);
    assert.doesNotMatch(src, /className=["'][^"']*settingsConnectionBadge/, `${rel} must not use .settingsConnectionBadge span`);
  }

  // 6. Badge primitive stays pill — dual-track Badge (pill) + Chip (squared) preserved
  const badgeSrc = read('packages/ui/src/primitives/badge.tsx');
  assert.match(badgeSrc, /rounded-\[var\(--radius-pill\)\]/, 'Badge stays pill (dual-track with Chip)');
});