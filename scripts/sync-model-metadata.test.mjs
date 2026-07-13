import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';

const execFileAsync = promisify(execFile);
const PROVIDER_IDS = ['anthropic', 'cerebras', 'deepseek', 'fireworks-ai', 'google', 'minimax', 'minimax-cn', 'mistral', 'moonshotai-cn', 'nvidia', 'openai', 'siliconflow', 'togetherai', 'xai', 'zai-coding-plan'];

function withRequiredProviders(openai) {
  return Object.fromEntries(PROVIDER_IDS.map((id) => {
    const fallback = {
      id,
      name: id,
      api: `https://api.example.com/${id}`,
      doc: 'https://example.com/models',
      models: {
        model: {
          name: 'Model', reasoning: false, tool_call: false,
          limit: { context: 1, output: 1 },
        },
      },
    };
    return [id, id === 'openai' ? { ...fallback, ...openai } : fallback];
  }));
}

test('sync-model-metadata maps models.dev modalities into Maka metadata', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'maka-model-metadata-'));
  const input = join(directory, 'api.json');
  const output = join(directory, 'generated.ts');
  await writeFile(input, JSON.stringify(withRequiredProviders({
    doc: 'https://example.com/models',
    models: {
      'vision-model': {
        id: 'vision-model', name: 'Vision Model', reasoning: true, tool_call: true,
        modalities: { input: ['text', 'image'], output: ['text'] },
        limit: { context: 128_000, output: 16_000 },
      },
      'text-model': {
        id: 'text-model', name: 'Text Model', reasoning: false, tool_call: false,
        modalities: { input: ['text'], output: ['text'] },
        limit: { context: 32_000, output: 4_000 }, status: 'deprecated',
      },
      'unknown-modality-model': {
        id: 'unknown-modality-model', name: 'Unknown Modality Model', reasoning: false, tool_call: false,
        limit: { context: 32_000, output: 4_000 },
      },
    },
  })));

  await execFileAsync(process.execPath, [
    'scripts/sync-model-metadata.mjs', '--input', input, '--output', output,
  ]);

  const generated = await readFile(output, 'utf8');
  assert.match(generated, /"vision":true,"reasoning":true,"functionCalling":true/);
  assert.match(generated, /"text-model".*"lifecycle":"deprecated".*"vision":false/);
  assert.match(generated, /"unknown-modality-model".*"capabilities":\{"reasoning":false,"functionCalling":false\}/);
  assert.match(generated, /export const GENERATED_MODELS_DEV_METADATA/);
  assert.match(generated, /export const GENERATED_MODELS_DEV_PROVIDER_FACTS/);
});

test('sync-model-metadata vendors xAI provider facts and exact model ids', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'maka-model-metadata-'));
  const input = join(directory, 'api.json');
  const output = join(directory, 'generated.ts');
  const catalog = withRequiredProviders({});
  catalog.xai = {
    ...catalog.xai,
    name: 'xAI',
    models: {
      'grok-4.5': {
        id: 'grok-4.5', name: 'Grok 4.5', reasoning: true, tool_call: true,
        modalities: { input: ['text', 'image'], output: ['text'] },
        limit: { context: 500_000, output: 500_000 },
      },
    },
  };
  await writeFile(input, JSON.stringify(catalog));

  await execFileAsync(process.execPath, [
    'scripts/sync-model-metadata.mjs', '--input', input, '--output', output,
  ]);

  const generated = await readFile(output, 'utf8');
  assert.match(generated, /"xai": \{/);
  assert.match(generated, /"xai": \{"id":"xai","name":"xAI"/);
  assert.match(generated, /"grok-4\.5": \{"displayName":"Grok 4\.5"/);
});

test('sync-model-metadata vendors Cerebras provider facts and exact model ids', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'maka-model-metadata-'));
  const input = join(directory, 'api.json');
  const output = join(directory, 'generated.ts');
  const catalog = withRequiredProviders({});
  catalog.cerebras = {
    ...catalog.cerebras,
    name: 'Cerebras',
    doc: 'https://inference-docs.cerebras.ai/models/overview',
    models: {
      'gpt-oss-120b': {
        id: 'gpt-oss-120b', name: 'GPT OSS 120B', reasoning: true, tool_call: true,
        modalities: { input: ['text'], output: ['text'] },
        limit: { context: 131_072, output: 40_960 },
      },
    },
  };
  await writeFile(input, JSON.stringify(catalog));

  await execFileAsync(process.execPath, [
    'scripts/sync-model-metadata.mjs', '--input', input, '--output', output,
  ]);

  const generated = await readFile(output, 'utf8');
  assert.match(generated, /"cerebras": \{/);
  assert.match(generated, /"cerebras": \{"id":"cerebras","name":"Cerebras"/);
  assert.match(generated, /"gpt-oss-120b": \{"displayName":"GPT OSS 120B"/);
});

test('sync-model-metadata vendors Mistral provider facts and exact model ids', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'maka-model-metadata-'));
  const input = join(directory, 'api.json');
  const output = join(directory, 'generated.ts');
  const catalog = withRequiredProviders({});
  catalog.mistral = {
    ...catalog.mistral,
    name: 'Mistral',
    api: undefined,
    doc: 'https://docs.mistral.ai/getting-started/models/',
    models: {
      'mistral-large-latest': {
        id: 'mistral-large-latest', name: 'Mistral Large', reasoning: false, tool_call: true,
        modalities: { input: ['text', 'image'], output: ['text'] },
        limit: { context: 128_000, output: 128_000 },
      },
    },
  };
  await writeFile(input, JSON.stringify(catalog));

  await execFileAsync(process.execPath, [
    'scripts/sync-model-metadata.mjs', '--input', input, '--output', output,
  ]);

  const generated = await readFile(output, 'utf8');
  assert.match(generated, /"mistral": \{/);
  assert.match(generated, /"mistral": \{"id":"mistral","name":"Mistral","doc":"https:\/\/docs\.mistral\.ai\/getting-started\/models\/"\}/);
  assert.match(generated, /"mistral-large-latest": \{"displayName":"Mistral Large"/);
});

test('sync-model-metadata vendors Together AI provider facts and exact model ids', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'maka-model-metadata-'));
  const input = join(directory, 'api.json');
  const output = join(directory, 'generated.ts');
  const catalog = withRequiredProviders({});
  catalog.togetherai = {
    ...catalog.togetherai,
    name: 'Together AI',
    api: undefined,
    doc: 'https://docs.together.ai/docs/serverless-models',
    models: {
      'openai/gpt-oss-20b': {
        id: 'openai/gpt-oss-20b', name: 'GPT OSS 20B', reasoning: true, tool_call: true,
        modalities: { input: ['text'], output: ['text'] },
        limit: { context: 131_072, output: 131_072 },
      },
    },
  };
  await writeFile(input, JSON.stringify(catalog));

  await execFileAsync(process.execPath, [
    'scripts/sync-model-metadata.mjs', '--input', input, '--output', output,
  ]);

  const generated = await readFile(output, 'utf8');
  assert.match(generated, /"togetherai": \{/);
  assert.match(generated, /"togetherai": \{"id":"togetherai","name":"Together AI","doc":"https:\/\/docs\.together\.ai\/docs\/serverless-models"\}/);
  assert.match(generated, /"openai\/gpt-oss-20b": \{"displayName":"GPT OSS 20B"/);
});

test('sync-model-metadata vendors Fireworks AI provider facts and exact model ids', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'maka-model-metadata-'));
  const input = join(directory, 'api.json');
  const output = join(directory, 'generated.ts');
  const catalog = withRequiredProviders({});
  catalog['fireworks-ai'] = {
    ...catalog['fireworks-ai'],
    name: 'Fireworks AI',
    api: 'https://api.fireworks.ai/inference/v1/',
    models: {
      'accounts/fireworks/models/kimi-k2p6': {
        id: 'accounts/fireworks/models/kimi-k2p6', name: 'Kimi K2.6', reasoning: true, tool_call: true,
        modalities: { input: ['text', 'image'], output: ['text'] },
        limit: { context: 262_000, output: 262_000 },
      },
    },
  };
  await writeFile(input, JSON.stringify(catalog));

  await execFileAsync(process.execPath, [
    'scripts/sync-model-metadata.mjs', '--input', input, '--output', output,
  ]);

  const generated = await readFile(output, 'utf8');
  assert.match(generated, /"fireworks-ai": \{/);
  assert.match(generated, /"fireworks-ai": \{"id":"fireworks-ai","name":"Fireworks AI","api":"https:\/\/api\.fireworks\.ai\/inference\/v1\/"/);
  assert.match(generated, /"accounts\/fireworks\/models\/kimi-k2p6": \{"displayName":"Kimi K2\.6"/);
});

test('sync-model-metadata vendors NVIDIA provider facts and exact model ids', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'maka-model-metadata-'));
  const input = join(directory, 'api.json');
  const output = join(directory, 'generated.ts');
  const catalog = withRequiredProviders({});
  catalog.nvidia = {
    ...catalog.nvidia,
    name: 'Nvidia',
    api: 'https://integrate.api.nvidia.com/v1',
    doc: 'https://docs.api.nvidia.com/nim/',
    models: {
      'nvidia/nemotron-3-super-120b-a12b': {
        id: 'nvidia/nemotron-3-super-120b-a12b',
        name: 'Nemotron 3 Super',
        reasoning: true,
        tool_call: true,
        modalities: { input: ['text'], output: ['text'] },
        limit: { context: 262_144, output: 262_144 },
      },
    },
  };
  await writeFile(input, JSON.stringify(catalog));

  await execFileAsync(process.execPath, [
    'scripts/sync-model-metadata.mjs', '--input', input, '--output', output,
  ]);

  const generated = await readFile(output, 'utf8');
  assert.match(generated, /"nvidia": \{/);
  assert.match(generated, /"nvidia": \{"id":"nvidia","name":"Nvidia","api":"https:\/\/integrate\.api\.nvidia\.com\/v1"/);
  assert.match(generated, /"nvidia\/nemotron-3-super-120b-a12b": \{"displayName":"Nemotron 3 Super"/);
});

test('sync-model-metadata rejects incomplete upstream model data', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'maka-model-metadata-'));
  const input = join(directory, 'api.json');
  await writeFile(input, JSON.stringify(withRequiredProviders({
    doc: 'https://example.com/models', models: { broken: { name: 'Broken' } },
  })));

  await assert.rejects(
    execFileAsync(process.execPath, ['scripts/sync-model-metadata.mjs', '--input', input]),
    /unsupported shape/,
  );
});

test('sync-model-metadata rejects a missing configured provider', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'maka-model-metadata-'));
  const input = join(directory, 'api.json');
  await writeFile(input, JSON.stringify({ openai: { doc: 'https://example.com', models: {} } }));

  await assert.rejects(
    execFileAsync(process.execPath, ['scripts/sync-model-metadata.mjs', '--input', input]),
    /provider anthropic is missing/,
  );
});

test('sync-model-metadata rejects an option without a value', async () => {
  await assert.rejects(
    execFileAsync(process.execPath, ['scripts/sync-model-metadata.mjs', '--output']),
    /--output requires a value/,
  );
});
