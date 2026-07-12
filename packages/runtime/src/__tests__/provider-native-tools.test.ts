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
    name: 'maka_computer',
    description: 'desktop computer',
    parameters: z.object({ action: z.string() }),
    providerBinding: {
      kind: 'computer',
      environment: 'desktop',
      wireMode: 'function',
      resolveDisplay: () => ({ widthPx: 1920, heightPx: 1200 }),
    },
    impl: () => ({ ok: true }),
  };
}

test('all target providers compile Maka Computer as the same function tool', () => {
  for (const providerType of [
    'anthropic',
    'claude-subscription',
    'openai',
    'kimi-coding-plan',
    'MiniMax',
    'MiniMax-cn',
  ] as const) {
    const compiled = compileProviderTool({
      connection: connection(providerType),
      tool: computerTool(),
      execute: async () => ({ ok: true }),
    });
    assert.equal(compiled.type, undefined);
    assert.equal(compiled.id, undefined);
    assert.equal(typeof compiled.execute, 'function');
    assert.match(String(compiled.description), /exactly 1920x1200 pixels/);
    assert.match(String(compiled.description), /Do not rescale coordinates/);
  }
});

test('invalid display contracts fail before a provider request is sent', () => {
  const tool = computerTool();
  tool.providerBinding = {
    kind: 'computer',
    environment: 'desktop',
    wireMode: 'function',
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
