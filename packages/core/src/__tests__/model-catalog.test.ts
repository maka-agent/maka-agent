import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import {
  buildModelCatalogEntries,
  validateChatDefaultModel,
} from '../model-catalog.js';
import type { ModelInfo } from '../llm-connections.js';

describe('ModelCatalogEntry', () => {
  it('normalizes Z.ai fetched models as provider_api facts without guessing unknown capabilities', () => {
    const models: ModelInfo[] = [
      { id: 'glm-4.5' },
      { id: 'glm-4.5-air' },
      { id: 'glm-4.6' },
      { id: 'glm-4.7', capabilities: { reasoning: true, functionCalling: true }, contextWindow: 128_000 },
      { id: 'glm-5' },
      { id: 'glm-5-turbo' },
      { id: 'glm-5.1' },
    ];
    const entries = buildModelCatalogEntries({
      providerType: 'zai-coding-plan',
      connectionSlug: 'zai-live',
      defaultModel: 'glm-4.7',
      models,
      modelSource: 'fetched',
      modelsFetchedAt: 1_800_000_000_000,
      now: 1_800_000_001_000,
    });

    assert.equal(entries.length, 7);
    assert.deepEqual(entries.map((entry) => entry.id), [
      'glm-4.5',
      'glm-4.5-air',
      'glm-4.6',
      'glm-4.7',
      'glm-5',
      'glm-5-turbo',
      'glm-5.1',
    ]);
    assert.equal(entries[0]?.source, 'provider_api');
    assert.equal(entries[0]?.capabilitySource, 'unknown');
    assert.deepEqual(entries[0]?.capabilities, {});
    const defaultEntry = entries.find((entry) => entry.id === 'glm-4.7');
    assert.equal(defaultEntry?.isDefault, true);
    assert.equal(defaultEntry?.capabilitySource, 'provider_api');
    assert.deepEqual(defaultEntry?.capabilities, { reasoning: true, functionCalling: true });
    assert.equal(defaultEntry?.contextWindow, 128_000);
  });

  it('keeps fallback source explicit and does not pretend static models were fetched', () => {
    const entries = buildModelCatalogEntries({
      providerType: 'openai-compatible',
      defaultModel: 'relay-static-model',
      fallbackModels: ['relay-static-model'],
      modelSource: 'fallback',
    });

    assert.equal(entries.length, 1);
    assert.equal(entries[0]?.source, 'static_catalog');
    assert.equal(entries[0]?.capabilitySource, 'unknown');
    assert.equal(entries[0]?.provenance.modelSource, 'fallback');
    assert.equal(entries[0]?.unavailableReason, 'none');
    assert.equal(entries[0]?.canUseAsChatDefault, true);
  });

  it('adds a blocked default entry when a live provider list no longer contains the selected model', () => {
    const entries = buildModelCatalogEntries({
      providerType: 'zai-coding-plan',
      defaultModel: 'glm-removed',
      models: [{ id: 'glm-4.7' }],
      modelSource: 'fetched',
      modelsFetchedAt: 1_800_000_000_000,
      now: 1_800_000_001_000,
    });

    const missingDefault = entries[0];
    assert.equal(missingDefault?.id, 'glm-removed');
    assert.equal(missingDefault?.source, 'unknown');
    assert.equal(missingDefault?.capabilitySource, 'unknown');
    assert.equal(missingDefault?.unavailableReason, 'not_in_live_list');
    assert.equal(missingDefault?.availability, 'blocked');
    assert.equal(missingDefault?.canUseAsChatDefault, false);

    const validation = validateChatDefaultModel({
      providerType: 'zai-coding-plan',
      defaultModel: 'glm-removed',
      models: [{ id: 'glm-4.7' }],
      modelSource: 'fetched',
      modelsFetchedAt: 1_800_000_000_000,
      now: 1_800_000_001_000,
    });
    assert.deepEqual(
      validation.ok ? validation : { ok: validation.ok, reason: validation.reason },
      { ok: false, reason: 'not_in_live_list' },
    );
  });

  it('blocks explicitly image-only models from becoming a chat default', () => {
    const input = {
      providerType: 'openai' as const,
      defaultModel: 'gpt-image-1',
      models: [{ id: 'gpt-image-1', capabilities: { imageGeneration: true, chat: false } }],
      modelSource: 'fetched' as const,
      modelsFetchedAt: 1_800_000_000_000,
      now: 1_800_000_001_000,
    };
    const [entry] = buildModelCatalogEntries(input);
    assert.equal(entry?.unavailableReason, 'unsupported_for_chat');
    assert.equal(entry?.availability, 'blocked');
    assert.equal(entry?.canUseAsChatDefault, false);
    assert.deepEqual(entry?.capabilities, { imageGeneration: true });

    const validation = validateChatDefaultModel(input);
    assert.deepEqual(
      validation.ok ? validation : { ok: validation.ok, reason: validation.reason },
      { ok: false, reason: 'unsupported_for_chat' },
    );
  });

  it('treats stale fetchedAt as a warning, not a send-blocking failure', () => {
    const input = {
      providerType: 'anthropic' as const,
      defaultModel: 'claude-sonnet-4-5-20250929',
      models: [{ id: 'claude-sonnet-4-5-20250929', capabilities: { reasoning: true } }],
      modelSource: 'fetched' as const,
      modelsFetchedAt: 1_700_000_000_000,
      now: 1_800_000_000_000,
      staleAfterMs: 7 * 24 * 60 * 60 * 1000,
    };
    const [entry] = buildModelCatalogEntries(input);
    assert.equal(entry?.unavailableReason, 'stale');
    assert.equal(entry?.availability, 'warning');
    assert.equal(entry?.canUseAsChatDefault, true);
    assert.deepEqual(validateChatDefaultModel(input).ok, true);
  });

  it('keeps unknown capability as unknown instead of warning like known false', () => {
    const input = {
      providerType: 'openai' as const,
      defaultModel: 'future-model',
      models: [{ id: 'future-model', capabilities: { vision: false, reasoning: undefined } }],
      modelSource: 'fetched' as const,
      modelsFetchedAt: 1_800_000_000_000,
      now: 1_800_000_001_000,
    };
    const [entry] = buildModelCatalogEntries(input);
    assert.equal(entry?.unavailableReason, 'none');
    assert.equal(entry?.canUseAsChatDefault, true);
    assert.deepEqual(entry?.capabilities, {});
  });
});
