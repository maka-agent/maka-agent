import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';

const execFileAsync = promisify(execFile);
const PROVIDER_IDS = ['anthropic', 'deepseek', 'google', 'minimax', 'minimax-cn', 'moonshotai-cn', 'openai', 'siliconflow', 'zai-coding-plan'];

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
