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
  buildCatalogChatModelChoices(connections: readonly LlmConnection[]): Array<{
    connectionSlug: string;
    providerType: string;
    model: string;
  }>;
  buildCatalogDailyReviewModelOptions(
    connections: readonly LlmConnection[],
    currentModelKey: string,
  ): Array<readonly [string, string]>;
  buildCatalogModelChoices(connection: LlmConnection): Array<{ id: string }>;
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
      choices.map((choice) => `${choice.connectionSlug}:${choice.model}`),
      ['codex-account:gpt-5.5'],
    );
  });

  it('keeps Daily Review enabled OAuth model choices while using leak-safe duplicate labels', async () => {
    const { buildCatalogDailyReviewModelOptions } = await importModelCatalogChoices();

    const options = buildCatalogDailyReviewModelOptions([
      connection({
        slug: 'claude-work',
        name: 'person@example.com',
        providerType: 'claude-subscription',
        models: [{ id: 'shared-model' }],
        modelSource: 'fetched',
      }),
      connection({
        slug: 'claude-home',
        name: 'private@example.com',
        providerType: 'claude-subscription',
        models: [{ id: 'shared-model' }],
        modelSource: 'fetched',
      }),
      connection({
        slug: 'gemini-account',
        name: 'user@example.com',
        providerType: 'gemini-cli',
        models: [{ id: 'gemini-2.5-pro' }],
        modelSource: 'fetched',
      }),
    ], '');

    assert.deepEqual(options, [
      ['claude-work::shared-model', 'shared-model · Claude Subscription (Pro / Max OAuth) · claude-work'],
      ['claude-home::shared-model', 'shared-model · Claude Subscription (Pro / Max OAuth) · claude-home'],
      ['gemini-account::gemini-2.5-pro', 'gemini-2.5-pro'],
    ]);
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
      ['openai-api::gpt-4o-mini', 'gpt-4o-mini'],
      ['openai-api::custom-model', 'custom-model'],
    ]);
  });

  it('includes a missing Settings default in catalog-derived model choices', async () => {
    const { buildCatalogModelChoices } = await importModelCatalogChoices();

    const choices = buildCatalogModelChoices(connection({
      slug: 'zai-live',
      providerType: 'zai-coding-plan',
      defaultModel: 'glm-saved',
      models: [{ id: 'glm-4.7' }],
      modelSource: 'fetched',
    }));

    assert.deepEqual(choices.map((choice) => choice.id), ['glm-saved', 'glm-4.7']);
  });
});
