/**
 * Provider catalog contract — structural invariants over the registry.
 *
 * These invariants replace the per-provider add-flow E2E clones that used to
 * live in apps/desktop/e2e/providers.spec.ts. They are data-driven over
 * CATALOG_PROVIDER_TYPES, so adding a provider is covered automatically with
 * zero manual test updates. They assert *shape*, never snapshot values (no
 * "provider X's model is exactly Y"), so a legitimate model/endpoint refresh
 * does not churn this file.
 *
 * Brand-mark completeness (every catalog provider resolves to a real mark, not
 * the generic fallback) is asserted on the desktop side — core cannot import a
 * renderer module — in
 * apps/desktop/src/main/__tests__/icon-governance-contract.test.ts
 * ("renders a registered brand mark for every catalog provider").
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  CATALOG_PROVIDER_TYPES,
  PROVIDER_REGISTRY,
  type ProviderCatalogGroup,
} from '../provider-registry.js';

// Mirrors the ProviderCatalogGroup union in provider-registry.ts. A new group
// must be added here deliberately, which is the point: the catalog UI only
// knows how to render these buckets.
const CATALOG_GROUPS: ReadonlySet<ProviderCatalogGroup> = new Set([
  'recommended',
  'plans',
  'api',
  'aggregators',
  'local',
]);

describe('provider catalog contract — structural invariants over CATALOG_PROVIDER_TYPES', () => {
  it('gives every catalog provider a non-empty label and description', () => {
    for (const type of CATALOG_PROVIDER_TYPES) {
      const def = PROVIDER_REGISTRY[type];
      assert.ok(def.label.trim().length > 0, `${type} must carry a non-empty label`);
      assert.ok(def.description.trim().length > 0, `${type} must carry a non-empty description`);
    }
  });

  it('assigns every catalog provider a known catalog group', () => {
    for (const type of CATALOG_PROVIDER_TYPES) {
      const group = PROVIDER_REGISTRY[type].catalogGroup;
      assert.ok(
        group !== undefined && CATALOG_GROUPS.has(group),
        `${type} catalogGroup ${String(group)} must be one of ${[...CATALOG_GROUPS].join(', ')}`,
      );
    }
  });

  it('exposes a parseable endpoint source for every catalog provider', () => {
    // A provider must be able to name where its base URL comes from:
    //   - a concrete baseUrl (must be a valid absolute URL), or
    //   - a baseUrlTemplate whose placeholders resolve to a valid URL
    //     (account-scoped endpoints), or
    //   - a custom openai-compatible connection where the user supplies the URL
    //     at connect time.
    // Anything else means a broken endpoint the add flow could never complete.
    for (const type of CATALOG_PROVIDER_TYPES) {
      const def = PROVIDER_REGISTRY[type];
      if (def.baseUrl !== '') {
        assert.doesNotThrow(() => new URL(def.baseUrl), `${type} baseUrl ${def.baseUrl} must be a valid URL`);
        continue;
      }
      if (def.baseUrlTemplate !== undefined) {
        const resolved = def.baseUrlTemplate.replace(/\$\{[^}]+\}/g, 'placeholder');
        assert.doesNotThrow(
          () => new URL(resolved),
          `${type} baseUrlTemplate ${def.baseUrlTemplate} must yield a valid URL once its placeholders are filled`,
        );
        continue;
      }
      const isCustomConnection =
        def.runtimeAdapter.kind === 'openai-compatible' && def.runtimeAdapter.name === 'connection';
      assert.ok(
        isCustomConnection,
        `${type} has no baseUrl, no baseUrlTemplate, and is not a custom connection — it cannot source an endpoint`,
      );
    }
  });

  it('ships a well-formed default model set for every catalog provider', () => {
    for (const type of CATALOG_PROVIDER_TYPES) {
      const def = PROVIDER_REGISTRY[type];
      for (const id of def.fallbackModels) {
        assert.ok(id.trim().length > 0, `${type} ships an empty fallback model id`);
      }
      assert.equal(
        new Set(def.fallbackModels).size,
        def.fallbackModels.length,
        `${type} ships duplicate fallback model ids`,
      );
      if (def.fallbackModels.length > 0) {
        // The default model is the first shipped id: it must be non-empty and,
        // by construction, drawn from the provider's own shipped list.
        const defaultModel = def.fallbackModels[0]!;
        assert.ok(defaultModel.trim().length > 0, `${type} default model must be non-empty`);
        assert.ok(def.fallbackModels.includes(defaultModel), `${type} default model must belong to its shipped list`);
      }
      if (def.modelDiscovery.kind === 'fallback') {
        // Static-fallback discovery has no live /models source, so the shipped
        // snapshot is the only model source and must be non-empty.
        assert.ok(
          def.fallbackModels.length > 0,
          `${type} uses static-fallback discovery but ships no default model snapshot`,
        );
      }
    }
  });
});
