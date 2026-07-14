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
});
