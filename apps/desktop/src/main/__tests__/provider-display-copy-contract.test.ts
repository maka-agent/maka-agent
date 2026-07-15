/**
 * Provider display-copy completeness contract.
 *
 * providerDisplay() localizes provider introduction copy zh / en through the
 * PROVIDER_DISPLAY_COPY map in provider-display.tsx. Any catalog provider
 * missing from that map silently falls back to the registry's English
 * description — which is exactly the "no Chinese introduction on a Chinese
 * UI" gap this contract exists to prevent.
 *
 * Data-driven over CATALOG_PROVIDER_TYPES (like the brand-mark completeness
 * check in icon-governance-contract.test.ts) so a newly registered catalog
 * provider is caught automatically: every type must carry a non-empty zh AND
 * en description, the zh copy must actually be Chinese (contains CJK), and
 * the en copy must not contain CJK. The registry fallback path in
 * providerDisplay() remains only for unknown persisted provider types.
 *
 * This is a source-grep contract, not a DOM render — we don't pull React
 * into the desktop test runner.
 */

import { strict as assert } from 'node:assert';
import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';
import { resolve } from 'node:path';
import { CATALOG_PROVIDER_TYPES } from '@maka/core';

const REPO_ROOT = resolve(import.meta.dirname, '../../../../..');
const PROVIDER_DISPLAY_FILE = resolve(
  REPO_ROOT,
  'apps/desktop/src/renderer/settings/provider-display.tsx',
);

const CJK = /[一-鿿]/;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Matches one `type: { zh: {...}, en: {...} }` entry (quoted or bare key). */
function copyEntry(src: string, type: string): { zh: string; en: string } | null {
  const key = escapeRegExp(type);
  const entry = new RegExp(
    `\\n  (?:'${key}'|${key}): \\{\\n`
    + `    zh: \\{ name: '[^']+', description: '([^']+)'(?:, badge: '[^']+')? \\},\\n`
    + `    en: \\{ name: '[^']+', description: '([^']+)'(?:, badge: '[^']+')? \\},\\n`
    + `  \\},`,
  ).exec(src);
  if (!entry) return null;
  return { zh: entry[1]!, en: entry[2]! };
}

describe('provider display copy contract', () => {
  it('ships non-empty zh and en introduction copy for every catalog provider', async () => {
    const src = await readFile(PROVIDER_DISPLAY_FILE, 'utf8');
    const missing: string[] = [];
    for (const type of CATALOG_PROVIDER_TYPES) {
      const copy = copyEntry(src, type);
      if (!copy || !copy.zh.trim() || !copy.en.trim()) missing.push(type);
    }
    assert.deepEqual(
      missing,
      [],
      'every catalog provider must carry bilingual introduction copy in PROVIDER_DISPLAY_COPY '
        + '(the registry fallback is English-only, which ships an untranslated card on the '
        + `Chinese UI) — add zh + en entries for:\n  ${missing.join('\n  ')}`,
    );
  });

  it('keeps zh copy Chinese and en copy free of CJK for every catalog provider', async () => {
    const src = await readFile(PROVIDER_DISPLAY_FILE, 'utf8');
    const wrongLocale: string[] = [];
    for (const type of CATALOG_PROVIDER_TYPES) {
      const copy = copyEntry(src, type);
      if (!copy) continue; // completeness is the previous test's finding
      if (!CJK.test(copy.zh) || CJK.test(copy.en)) wrongLocale.push(type);
    }
    assert.deepEqual(
      wrongLocale,
      [],
      'zh descriptions must contain Chinese text and en descriptions must not — '
        + `swapped or copied-through entries:\n  ${wrongLocale.join('\n  ')}`,
    );
  });
});
