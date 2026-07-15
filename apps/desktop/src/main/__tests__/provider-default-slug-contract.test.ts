/**
 * Default slug derivation contract.
 *
 * The add form pre-fills its slug from nextSlug(providerType) and the save
 * path rejects anything that fails core's validateSlug. If derivation and
 * validation disagree for any catalog provider (as they did for the
 * mixed-case 'MiniMax' / 'MiniMax-cn' types, which derived to '-ini-ax' /
 * '-ini-ax-cn'), the user cannot add that provider without hand-editing the
 * slug. Data-driven over CATALOG_PROVIDER_TYPES so a new provider type is
 * covered automatically. Lives on the desktop side because nextSlug is
 * renderer code core cannot import; the registry-side invariants live in
 * packages/core/src/__tests__/provider-catalog-contract.test.ts.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { CATALOG_PROVIDER_TYPES, validateSlug } from '@maka/core';
import { nextSlug } from '../../renderer/settings/provider-panel-shared.js';

describe('provider default slug contract', () => {
  it('derives a slug that passes validateSlug for every catalog provider', () => {
    for (const type of CATALOG_PROVIDER_TYPES) {
      const slug = nextSlug(type, []);
      assert.equal(
        validateSlug(slug),
        null,
        `nextSlug('${type}') derived '${slug}', which validateSlug rejects — the add form would block the save`,
      );
    }
  });

  it('keeps collision-suffixed slugs valid too', () => {
    for (const type of CATALOG_PROVIDER_TYPES) {
      const first = nextSlug(type, []);
      const second = nextSlug(type, [first]);
      assert.notEqual(second, first, `${type} collision suffix must produce a distinct slug`);
      assert.equal(
        validateSlug(second),
        null,
        `nextSlug('${type}') collision fallback derived '${second}', which validateSlug rejects`,
      );
    }
  });

  it('always returns an unused slug even under dense collisions', () => {
    // The previous bounded search gave up after '-99' and fell back to a
    // timestamp suffix WITHOUT checking `existing`, so a dense slug space
    // could yield an already-taken slug the save path rejects. With the base
    // and -2..-99 all taken, the derivation must keep counting.
    const base = nextSlug('openai', []);
    const existing = [base, ...Array.from({ length: 98 }, (_, i) => `${base}-${i + 2}`)];
    const derived = nextSlug('openai', existing);
    assert.equal(derived, `${base}-100`);
    assert.ok(!existing.includes(derived), 'derived slug must not collide with existing slugs');
    assert.equal(validateSlug(derived), null);
  });
});
