import { strict as assert } from 'node:assert';
import { mkdir, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, it } from 'node:test';
import { build } from 'esbuild';
import type { LlmConnection } from '@maka/core';

const REPO_ROOT = resolve(import.meta.dirname, '../../../../..');

type ModelCatalogChoicesModule = {
  buildCatalogRecommendedDefaultModel(providerType: LlmConnection['providerType']): string;
  buildCatalogChatModelChoices(connections: readonly LlmConnection[]): Array<{
    connectionSlug: string;
    providerType: string;
    model: string;
    label: string;
    connectionName?: string;
  }>;
  pickCatalogDefaultChatModel(connection: LlmConnection): {
    llmConnectionSlug: string;
    model: string;
  } | undefined;
  buildCatalogDailyReviewModelOptions(
    connections: readonly LlmConnection[],
    currentModelKey: string,
  ): Array<readonly [string, string]>;
  buildCatalogModelChoices(connection: LlmConnection): Array<{
    id: string;
    displayName?: string;
    source: string;
    recommendedRank?: number;
    lifecycle: string;
    docsUrl?: string;
    availability: string;
    unavailableReason: string;
    isDefault: boolean;
  }>;
};

async function importModelCatalogChoices(): Promise<ModelCatalogChoicesModule> {
  const outdir = await mkdtemp(resolve(tmpdir(), 'maka-model-catalog-choices-'));
  const outfile = resolve(outdir, 'model-catalog-choices.mjs');
  await mkdir(dirname(outfile), { recursive: true });
  await build({
    entryPoints: [resolve(REPO_ROOT, 'apps/desktop/src/renderer/model-catalog-choices.ts')],
    outfile,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node20',
    logLevel: 'silent',
  });
  return await import(`${pathToFileURL(outfile).href}?t=${Date.now()}`) as ModelCatalogChoicesModule;
}

function connection(overrides: Partial<LlmConnection> & Pick<LlmConnection, 'slug' | 'providerType'>): LlmConnection {
  return {
    name: overrides.slug,
    defaultModel: '',
    enabled: true,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

describe('model catalog picker helpers', () => {
  it('keeps Chat choices on send-wired providers and filters unsupported Codex ChatGPT models', async () => {
    const { buildCatalogChatModelChoices } = await importModelCatalogChoices();

    const choices = buildCatalogChatModelChoices([
      connection({
        slug: 'codex-account',
        providerType: 'codex-subscription',
        models: [{ id: 'gpt-5-codex' }, { id: 'gpt-5.5' }],
        modelSource: 'fetched',
      }),
      connection({
        slug: 'gemini-account',
        providerType: 'gemini-cli',
        models: [{ id: 'gemini-2.5-pro' }],
        modelSource: 'fetched',
      }),
    ]);

    assert.deepEqual(
      choices.map((choice) => `${choice.connectionSlug}:${choice.model}:${choice.label}`),
      ['codex-account:gpt-5.5:GPT-5.5'],
    );
  });

  it('surfaces connectionName for api-key connections but never for OAuth ones', async () => {
    const { buildCatalogChatModelChoices } = await importModelCatalogChoices();

    const choices = buildCatalogChatModelChoices([
      connection({
        slug: 'openrouter',
        name: 'Openrouter',
        providerType: 'openai-compatible',
        models: [{ id: 'anthropic/claude-sonnet-5' }],
        modelSource: 'fetched',
      }),
      connection({
        slug: 'claude-sub',
        name: 'person@example.com',
        providerType: 'claude-subscription',
        models: [{ id: 'claude-sonnet-4-5-20250929' }],
        modelSource: 'fetched',
      }),
      connection({
        slug: 'codex-account',
        name: 'person@example.com',
        providerType: 'codex-subscription',
        models: [{ id: 'gpt-5.5' }],
        modelSource: 'fetched',
      }),
    ]);

    const bySlug = new Map(choices.map((choice) => [choice.connectionSlug, choice]));
    assert.equal(bySlug.get('openrouter')?.connectionName, 'Openrouter');
    // OAuth connection.name embeds the account email — it must never reach
    // the picker's ChatModelChoice (PR-CHAT-CHROME-FIX-0).
    assert.equal(bySlug.get('claude-sub')?.connectionName, undefined);
    assert.equal(bySlug.get('codex-account')?.connectionName, undefined);
    for (const choice of choices) {
      assert.ok(!(choice.connectionName ?? '').includes('@example.com'));
    }
  });

  it('keeps Daily Review runtime-wired model choices while using leak-safe duplicate labels', async () => {
    const { buildCatalogDailyReviewModelOptions } = await importModelCatalogChoices();

    const options = buildCatalogDailyReviewModelOptions([
      connection({
        slug: 'claude-work',
        name: 'person@example.com',
        providerType: 'claude-subscription',
        models: [{ id: 'shared-model', displayName: 'Shared Model' }],
        modelSource: 'fetched',
      }),
      connection({
        slug: 'claude-home',
        name: 'private@example.com',
        providerType: 'claude-subscription',
        models: [{ id: 'shared-model', displayName: 'Shared Model' }],
        modelSource: 'fetched',
      }),
      connection({
        slug: 'gemini-account',
        name: 'user@example.com',
        providerType: 'gemini-cli',
        models: [{ id: 'gemini-2.5-pro', displayName: 'Gemini 2.5 Pro' }],
        modelSource: 'fetched',
      }),
      connection({
        slug: 'deepseek-api',
        name: 'DeepSeek account',
        providerType: 'deepseek',
        models: [{ id: 'deepseek-v4-flash' }],
        modelSource: 'fetched',
      }),
    ], '');

    assert.deepEqual(options, [
      ['claude-work::shared-model', 'Shared Model · Claude Subscription (Pro / Max OAuth) · claude-work'],
      ['claude-home::shared-model', 'Shared Model · Claude Subscription (Pro / Max OAuth) · claude-home'],
      ['deepseek-api::deepseek-v4-flash', 'DeepSeek V4 Flash'],
    ]);
    assert.ok(options.every(([value]) => !value.startsWith('gemini-account::')));
    assert.ok(options.every(([, label]) => !label.includes('@example.com')));
  });

  it('recovers a missing saved Daily Review model key as a raw option', async () => {
    const { buildCatalogDailyReviewModelOptions } = await importModelCatalogChoices();

    const options = buildCatalogDailyReviewModelOptions([
      connection({
        slug: 'openai-api',
        providerType: 'openai',
        models: [{ id: 'gpt-4o-mini' }],
        modelSource: 'fetched',
      }),
    ], 'openai-api::custom-model');

    assert.deepEqual(options, [
      ['openai-api::gpt-4o-mini', 'GPT-4o mini'],
      ['openai-api::custom-model', 'custom-model · 当前不可用'],
    ]);
  });

  it('keeps the current Daily Review value visible when its connection is unavailable', async () => {
    const { buildCatalogDailyReviewModelOptions } = await importModelCatalogChoices();

    assert.deepEqual(
      buildCatalogDailyReviewModelOptions([
        connection({
          slug: 'openai-api',
          name: 'person@example.com',
          providerType: 'openai',
          enabled: false,
          models: [{ id: 'gpt-4o-mini' }],
          modelSource: 'fetched',
        }),
      ], 'openai-api::gpt-4o-mini'),
      [['openai-api::gpt-4o-mini', 'gpt-4o-mini · openai-api · 当前不可用']],
    );

    assert.deepEqual(
      buildCatalogDailyReviewModelOptions([], 'deleted-openai::gpt-4o-mini'),
      [['deleted-openai::gpt-4o-mini', 'gpt-4o-mini · deleted-openai · 当前不可用']],
    );

    assert.deepEqual(
      buildCatalogDailyReviewModelOptions([
        connection({
          slug: 'openai-api',
          providerType: 'openai',
          models: [{ id: 'gpt-4o-mini' }],
          modelSource: 'fetched',
        }),
      ], 'openai-api::custom-model'),
      [
        ['openai-api::gpt-4o-mini', 'GPT-4o mini'],
        ['openai-api::custom-model', 'custom-model · 当前不可用'],
      ],
    );
  });

  it('derives new-connection defaults from catalog recommendations', async () => {
    const { buildCatalogRecommendedDefaultModel } = await importModelCatalogChoices();

    assert.equal(buildCatalogRecommendedDefaultModel('deepseek'), 'deepseek-v4-flash');
    assert.equal(buildCatalogRecommendedDefaultModel('openai-compatible'), '');
  });

  it('picks the new-chat default from the normalized catalog default entry', async () => {
    const { pickCatalogDefaultChatModel } = await importModelCatalogChoices();

    assert.deepEqual(
      pickCatalogDefaultChatModel(connection({
        slug: 'openai-api',
        providerType: 'openai',
        defaultModel: '  gpt-4o-mini  ',
        models: [{ id: 'gpt-4o-mini' }],
        modelSource: 'fetched',
      })),
      {
        llmConnectionSlug: 'openai-api',
        model: 'gpt-4o-mini',
      },
    );
  });

  it('keeps Settings model choices as catalog entries with missing-default state', async () => {
    const { buildCatalogModelChoices } = await importModelCatalogChoices();

    const choices = buildCatalogModelChoices(connection({
      slug: 'openai-api',
      providerType: 'openai',
      defaultModel: 'gpt-5',
      models: [{ id: 'gpt-4o-mini' }],
      modelSource: 'fetched',
    }));

    assert.deepEqual(
      choices.map((choice) => ({
        id: choice.id,
        displayName: choice.displayName,
        recommendedRank: choice.recommendedRank,
        lifecycle: choice.lifecycle,
        docsUrl: choice.docsUrl,
        availability: choice.availability,
        unavailableReason: choice.unavailableReason,
        isDefault: choice.isDefault,
      })),
      [
        {
          id: 'gpt-5',
          displayName: 'GPT-5',
          recommendedRank: 5,
          lifecycle: 'active',
          docsUrl: 'https://platform.openai.com/docs/models',
          availability: 'blocked',
          unavailableReason: 'not_in_live_list',
          isDefault: true,
        },
        {
          id: 'gpt-4o-mini',
          displayName: 'GPT-4o mini',
          recommendedRank: undefined,
          lifecycle: 'active',
          docsUrl: 'https://platform.openai.com/docs/models',
          availability: 'available',
          unavailableReason: 'none',
          isDefault: false,
        },
      ],
    );
  });

  it('derives static fallback counts from catalog entries', async () => {
    const { buildCatalogModelChoices } = await importModelCatalogChoices();

    const choices = buildCatalogModelChoices(connection({
      slug: 'deepseek-api',
      providerType: 'deepseek',
      defaultModel: 'deepseek-v4-flash',
      modelSource: 'fallback',
    }));

    assert.equal(choices.filter((choice) => choice.source === 'static_catalog').length, 4);
  });
});
