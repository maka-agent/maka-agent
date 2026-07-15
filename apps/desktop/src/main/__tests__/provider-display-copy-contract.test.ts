/**
 * Provider display-copy locale contract.
 *
 * providerDisplay() localizes provider introduction copy zh / en through the
 * pure-data PROVIDER_DISPLAY_COPY map. COMPLETENESS is enforced at compile
 * time — the map `satisfies Record<ProviderType, …>`, so a newly registered
 * provider without a bilingual entry fails the build. What the type system
 * cannot see is whether an entry is actually bilingual: a zh description
 * pasted from the English registry text type-checks fine but ships an
 * untranslated card on the Chinese UI — exactly the gap this contract
 * prevents. Asserted over the imported data itself (the module is
 * React-free, so the main-process test runner loads it directly), not a
 * regex parse of TSX source.
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { PROVIDER_DISPLAY_COPY } from '../../renderer/settings/provider-display-copy.js';

const CJK = /[一-鿿]/;

describe('provider display copy contract', () => {
  it('keeps zh copy Chinese and en copy free of CJK for every provider', () => {
    const wrongLocale: string[] = [];
    for (const [type, copy] of Object.entries(PROVIDER_DISPLAY_COPY)) {
      if (!CJK.test(copy.zh.description) || CJK.test(copy.en.description)) wrongLocale.push(type);
    }
    assert.deepEqual(
      wrongLocale,
      [],
      'zh descriptions must contain Chinese text and en descriptions must not — '
        + `swapped or copied-through entries:\n  ${wrongLocale.join('\n  ')}`,
    );
  });

  it('ships non-empty names and descriptions in both locales', () => {
    const empty: string[] = [];
    for (const [type, copy] of Object.entries(PROVIDER_DISPLAY_COPY)) {
      for (const locale of ['zh', 'en'] as const) {
        if (!copy[locale].name.trim() || !copy[locale].description.trim()) empty.push(`${type} (${locale})`);
      }
    }
    assert.deepEqual(empty, [], `blank copy entries:\n  ${empty.join('\n  ')}`);
  });
});
