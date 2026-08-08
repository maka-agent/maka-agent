import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { connectionFallbackModelIds } from '../model-catalog.js';
import { lookupModelMetadata } from '../model-metadata.js';
import {
  SUPERSEDED_MODEL_ID_ALIASES,
  CATALOG_PROVIDER_TYPES,
  PROVIDER_DEFAULTS,
  PROVIDER_REGISTRY,
  READY_PROVIDER_TYPES,
  RECOMMENDED_PROVIDER_TYPES,
  backendKindOf,
  effectiveBaseUrl,
  migrateConnectionV1ToV2,
  normalizeConnectionBaseUrl,
  normalizeProviderType,
  persistedBaseUrl,
  providerAuthRequiresSecret,
  providerAuthSupportsApiKey,
  reconcileConnectionAfterModelFetch,
  validateConnectionBaseUrl,
  type ProviderType,
} from '../llm-connections.js';

test('provider registry satisfies shared structural invariants', () => {
  assert.equal(PROVIDER_DEFAULTS, PROVIDER_REGISTRY);
  const providerIds = new Set(Object.keys(PROVIDER_REGISTRY));
  for (const list of [CATALOG_PROVIDER_TYPES, READY_PROVIDER_TYPES, RECOMMENDED_PROVIDER_TYPES]) {
    assert.equal(
      list.every((id) => providerIds.has(id)),
      true,
    );
  }

  for (const [id, provider] of Object.entries(PROVIDER_REGISTRY)) {
    assert.ok(provider.label.trim(), `${id}: label`);
    assert.equal(validateConnectionBaseUrl(provider.baseUrl), null, `${id}: baseUrl`);
    assert.equal(
      provider.fallbackModels.every((modelId) => modelId === modelId.trim() && modelId.length > 0),
      true,
      `${id}: fallback model ids`,
    );
    assert.equal(
      new Set(provider.fallbackModels).size,
      provider.fallbackModels.length,
      `${id}: duplicate fallback model id`,
    );
  }

  for (const orderField of ['readyOrder', 'catalogOrder', 'recommendedOrder'] as const) {
    const orders = Object.values(PROVIDER_REGISTRY)
      .map((provider) => provider[orderField])
      .filter((order): order is number => order !== undefined);
    assert.equal(new Set(orders).size, orders.length, `${orderField} must be unique`);
  }
});

test('connection base URLs allow HTTP(S) and reject unsafe or malformed inputs', () => {
  for (const value of [
    undefined,
    null,
    '',
    '  ',
    'https://api.example.com/v1',
    'http://localhost:11434/v1',
    'http://192.168.1.50:8080',
    'HTTPS://api.example.com',
  ]) {
    assert.equal(validateConnectionBaseUrl(value), null, String(value));
  }

  for (const value of [
    'javascript:alert(1)',
    'file:///etc/passwd',
    'data:text/plain,bad',
    'vbscript:msgbox',
    'chrome-extension://abc/page.html',
    'ws://example.com',
    'wss://example.com',
    'ftp://example.com',
    'maka://settings',
    'not-a-url',
    'http:',
    `https://example.com/${'a'.repeat(2050)}`,
  ]) {
    assert.notEqual(validateConnectionBaseUrl(value), null, value);
  }

  const exactLimit = `https://example.com/${'a'.repeat(2048 - 'https://example.com/'.length)}`;
  assert.equal(exactLimit.length, 2048);
  assert.equal(validateConnectionBaseUrl(exactLimit), null);
});

test('persisted base URLs retain only meaningful overrides', () => {
  for (const value of [undefined, null, '', '  ', 'https://api.openai.com/v1']) {
    assert.equal(persistedBaseUrl('openai', value), undefined);
  }
  assert.equal(
    persistedBaseUrl('openai', '  https://proxy.example.com/v1  '),
    'https://proxy.example.com/v1',
  );
  assert.equal(
    persistedBaseUrl('openai-compatible', 'https://gateway.example.com/v1'),
    'https://gateway.example.com/v1',
  );
});

test('base URL normalization preserves clear intent and rejects untrusted runtime types', () => {
  assert.deepEqual(normalizeConnectionBaseUrl('  '), { ok: true, value: '' });
  assert.deepEqual(normalizeConnectionBaseUrl('  https://Example.com:443/V1  '), {
    ok: true,
    value: 'https://Example.com:443/V1',
  });

  for (const value of [
    'javascript:alert(1)',
    'file:///etc/passwd',
    'not-a-url',
    null,
    undefined,
    42,
    true,
    {},
    [],
    Symbol('value'),
    () => '',
    BigInt(1),
  ]) {
    assert.doesNotThrow(() => normalizeConnectionBaseUrl(value));
    assert.equal(normalizeConnectionBaseUrl(value).ok, false, String(value));
  }
});

test('unknown provider ids fail closed without breaking persisted connections', () => {
  const unknown = 'branch-only-provider' as ProviderType;
  assert.equal(backendKindOf({ providerType: unknown }), 'fake');
  assert.equal(
    effectiveBaseUrl({ providerType: unknown, baseUrl: 'https://example.test/v1' }),
    'https://example.test/v1',
  );
  assert.equal(effectiveBaseUrl({ providerType: unknown }), '');
  assert.equal(persistedBaseUrl(unknown, '  '), undefined);
  assert.equal(providerAuthRequiresSecret(unknown), false);
  assert.equal(providerAuthSupportsApiKey(unknown), false);
});

test('persisted provider aliases migrate without rewriting identity', () => {
  assert.equal(normalizeProviderType('codex-subscription'), 'openai-codex');
  assert.equal(normalizeProviderType('anthropic'), 'anthropic');
  assert.equal(normalizeProviderType('branch-only-provider'), 'branch-only-provider');

  const migrated = migrateConnectionV1ToV2({
    slug: 'codex-subscription',
    name: 'OpenAI OAuth',
    providerType: 'codex-subscription',
    defaultModel: 'gpt-5.5',
    enabled: true,
    createdAt: 1,
    updatedAt: 1,
  });
  assert.equal(migrated.providerType, 'openai-codex');
  assert.equal(migrated.slug, 'codex-subscription');
});

test('model reconciliation keeps live choices and repairs stale defaults', () => {
  assert.deepEqual(
    reconcileConnectionAfterModelFetch(
      { defaultModel: 'live', enabledModelIds: ['retired', 'live'] },
      [{ id: 'live' }, { id: 'other' }],
    ),
    { defaultModel: 'live', enabledModelIds: ['live'] },
  );
  assert.deepEqual(
    reconcileConnectionAfterModelFetch({ defaultModel: 'retired', enabledModelIds: ['retired'] }, [
      { id: '  live  ' },
      { id: '' },
      { id: 'live' },
    ]),
    { defaultModel: 'live', enabledModelIds: ['live'] },
  );
  assert.deepEqual(
    reconcileConnectionAfterModelFetch({ defaultModel: 'saved', enabledModelIds: ['saved'] }, []),
    { defaultModel: 'saved', enabledModelIds: ['saved'] },
  );
});

test('model reconciliation never invents a default the user cleared', () => {
  // Unchecking the default leaves a legitimate {no default, some enabled}
  // state. Repair had nothing to repair here, so it reached for "the first
  // still-enabled id" and handed the choice back — on every refresh, and on
  // every OAuth resync that runs before a connection list read.
  assert.deepEqual(
    reconcileConnectionAfterModelFetch(
      { defaultModel: '', enabledModelIds: ['kept', 'retired'], hasModelInventory: true },
      [{ id: 'kept' }, { id: 'fresh' }],
    ),
    { defaultModel: '', enabledModelIds: ['kept'] },
  );
  // Same with nothing enabled at all.
  assert.deepEqual(
    reconcileConnectionAfterModelFetch(
      { defaultModel: '', enabledModelIds: [], hasModelInventory: true },
      [{ id: 'fresh' }],
    ),
    { defaultModel: '', enabledModelIds: [] },
  );
  // The one exception: a connection that has never had a list to pick from.
  // The four providers with no `fallbackModels` are created with an empty
  // default, so discovery is the only place their first one can come from.
  assert.deepEqual(
    reconcileConnectionAfterModelFetch(
      { defaultModel: '', enabledModelIds: [], hasModelInventory: false },
      [{ id: 'first-live' }, { id: 'other' }],
    ),
    { defaultModel: 'first-live', enabledModelIds: ['first-live'] },
  );
  // Not an exception: a selection exists, so the user has had the list.
  assert.deepEqual(
    reconcileConnectionAfterModelFetch(
      { defaultModel: '', enabledModelIds: ['picked'], hasModelInventory: false },
      [{ id: 'picked' }, { id: 'other' }],
    ),
    { defaultModel: '', enabledModelIds: ['picked'] },
  );
});

test('a superseded model id migrates to the inventory that still offers it', () => {
  // Renaming, not retirement: the stored dated id and the curated alias name
  // the same model, so the user stays on it.
  assert.deepEqual(
    reconcileConnectionAfterModelFetch(
      {
        defaultModel: 'claude-haiku-4-5-20251001',
        enabledModelIds: ['claude-haiku-4-5-20251001'],
        hasModelInventory: true,
      },
      [{ id: 'claude-opus-5' }, { id: 'claude-haiku-4-5' }],
    ),
    { defaultModel: 'claude-haiku-4-5', enabledModelIds: ['claude-haiku-4-5'] },
  );
  // Both forms enabled collapse onto one entry rather than duplicating.
  assert.deepEqual(
    reconcileConnectionAfterModelFetch(
      {
        defaultModel: 'claude-haiku-4-5',
        enabledModelIds: ['claude-haiku-4-5', 'claude-haiku-4-5-20251001'],
        hasModelInventory: true,
      },
      [{ id: 'claude-haiku-4-5' }],
    ),
    { defaultModel: 'claude-haiku-4-5', enabledModelIds: ['claude-haiku-4-5'] },
  );
  // An id the alias table does not claim is still repaired against the live
  // list — retirement and renaming must not be conflated.
  assert.deepEqual(
    reconcileConnectionAfterModelFetch(
      {
        defaultModel: 'claude-opus-4-1-20250805',
        enabledModelIds: ['claude-opus-4-1-20250805'],
        hasModelInventory: true,
      },
      [{ id: 'claude-opus-5' }],
    ),
    { defaultModel: 'claude-opus-5', enabledModelIds: ['claude-opus-5'] },
  );
});

test('the superseded-id table only ever aliases a rename, never a retirement', () => {
  const offered = new Set(
    (Object.keys(PROVIDER_REGISTRY) as ProviderType[]).flatMap((providerType) => [
      ...connectionFallbackModelIds(providerType),
    ]),
  );
  for (const [supersededId, target] of Object.entries(SUPERSEDED_MODEL_ID_ALIASES)) {
    // A target nothing lists would send reconciliation straight back to the
    // "first live id" fallback this table exists to prevent.
    assert.ok(
      offered.has(target),
      `alias target ${target} is not offered by any curated inventory`,
    );
    assert.notEqual(supersededId, target);
    // The membership rule, machine-checked: a withdrawn model must be repaired
    // against the live list, never silently rewritten to a different model.
    assert.notEqual(
      lookupModelMetadata('anthropic', supersededId).lifecycle,
      'deprecated',
      `${supersededId} is deprecated, so it is retired rather than renamed`,
    );
  }
});
