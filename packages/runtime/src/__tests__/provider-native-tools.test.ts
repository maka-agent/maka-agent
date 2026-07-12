import assert from 'node:assert/strict';
import test from 'node:test';
import { z } from 'zod';

import type { LlmConnection } from '@maka/core/llm-connections';
import { compileProviderTool } from '../provider-native-tools.js';
import type { MakaTool } from '../tool-runtime.js';

function connection(providerType: LlmConnection['providerType']): LlmConnection {
  return {
    slug: providerType,
    name: providerType,
    providerType,
    defaultModel: 'model',
    enabled: true,
    createdAt: 1,
    updatedAt: 1,
  };
}

function computerTool(): MakaTool {
  return {
    name: 'computer',
    description: 'desktop computer',
    parameters: z.object({ action: z.string() }),
    providerBinding: {
      kind: 'computer',
      environment: 'desktop',
      resolveDisplay: () => ({ widthPx: 1920, heightPx: 1200 }),
    },
    impl: () => ({ ok: true }),
  };
}

test('Anthropic compiles desktop computer to the provider-native display contract', () => {
  const compiled = compileProviderTool({
    connection: connection('anthropic'),
    tool: computerTool(),
    execute: async () => ({ ok: true }),
  });
  assert.equal(compiled.type, 'provider');
  assert.equal(compiled.id, 'anthropic.computer_20251124');
  assert.deepEqual(compiled.args, {
    displayWidthPx: 1920,
    displayHeightPx: 1200,
    enableZoom: true,
  });
  assert.equal(typeof compiled.execute, 'function');
});

test('providers without a native desktop contract get an explicit sized adapter', () => {
  const compiled = compileProviderTool({
    connection: connection('openai'),
    tool: computerTool(),
    execute: async () => ({ ok: true }),
  });
  assert.equal(compiled.type, undefined);
  assert.match(String(compiled.description), /exactly 1920x1200 pixels/);
  assert.match(String(compiled.description), /Do not rescale coordinates/);
});

test('Kimi Coding Plan stays a client-executed function tool', () => {
  const compiled = compileProviderTool({
    connection: connection('kimi-coding-plan'),
    tool: computerTool(),
    execute: async () => ({ ok: true }),
  });
  assert.equal(compiled.type, undefined);
  assert.equal(compiled.id, undefined);
  assert.match(String(compiled.description), /exactly 1920x1200 pixels/);
});

test('MiniMax stays a client-executed function tool', () => {
  for (const providerType of ['MiniMax', 'MiniMax-cn'] as const) {
    const compiled = compileProviderTool({
      connection: connection(providerType),
      tool: computerTool(),
      execute: async () => ({ ok: true }),
    });
    assert.equal(compiled.type, undefined);
    assert.equal(compiled.id, undefined);
    assert.match(String(compiled.description), /exactly 1920x1200 pixels/);
  }
});

test('invalid display contracts fail before a provider request is sent', () => {
  const tool = computerTool();
  tool.providerBinding = {
    kind: 'computer',
    environment: 'desktop',
    resolveDisplay: () => ({ widthPx: 0, heightPx: 1200 }),
  };
  assert.throws(
    () => compileProviderTool({
      connection: connection('anthropic'),
      tool,
      execute: async () => ({ ok: true }),
    }),
    /invalid computer display contract/,
  );
});
