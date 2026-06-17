import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { z } from 'zod';
import { MockLanguageModelV3, convertArrayToReadableStream } from 'ai/test';
import type { LanguageModelV3StreamPart, LanguageModelV3Usage } from '@ai-sdk/provider';

const ZERO_USAGE: LanguageModelV3Usage = {
  inputTokens: { total: 0, noCache: 0, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 0, text: 0, reasoning: 0 },
};

// Minimal valid V3 stream: start then immediately finish. Annotated so the
// 'stop' / 'stream-start' literals are checked against the part union.
const STREAM_PARTS: LanguageModelV3StreamPart[] = [
  { type: 'stream-start', warnings: [] },
  { type: 'finish', finishReason: { unified: 'stop', raw: 'stop' }, usage: ZERO_USAGE },
];

import { ModelAdapter } from '../model-adapter.js';
import { canonicalizeToolSet } from '../request-shape.js';
import type { MakaTool } from '../tool-runtime.js';

// A tool with a real (non-trivial) zod schema so the AI SDK actually serializes it.
function tool(name: string, exposure?: 'direct' | 'deferred'): MakaTool {
  return {
    name,
    description: `${name} tool`,
    parameters: z.object({ q: z.string().describe('an argument') }),
    impl: () => ({ ok: true }),
    ...(exposure ? { exposure } : {}),
  };
}

function newAdapter(): ModelAdapter {
  return new ModelAdapter({
    connection: { providerType: 'openai' } as never,
    apiKey: 'test',
    modelId: 'mock',
    modelFactory: () => ({}),
    providerOptions: {},
    maxSteps: 2,
    newId: () => 'id',
    now: () => 0,
  });
}

/**
 * Drive the real ModelAdapter.startStream path with a mock model and report the
 * tool names the provider actually received in doStream — i.e. what crosses the
 * wire after the AI SDK applies `activeTools`.
 */
async function toolNamesSeenByProvider(loaded: ReadonlySet<string>): Promise<string[]> {
  const tools: MakaTool[] = [tool('Read'), tool('load_tool'), tool('Rive', 'deferred')];
  const invalid = tool('invalid');
  const canonical = canonicalizeToolSet(tools, invalid, loaded);

  const aiSdkTools: Record<string, unknown> = {};
  for (const t of canonical.providerTools) {
    aiSdkTools[t.name] = { description: t.description, inputSchema: t.parameters };
  }

  let seen: string[] = [];
  const model = new MockLanguageModelV3({
    doStream: async ({ tools }) => {
      seen = (tools ?? []).map((t) => t.name);
      return { stream: convertArrayToReadableStream(STREAM_PARTS) };
    },
  });

  const result = await newAdapter().startStream({
    model,
    messages: [{ role: 'user', content: 'hi' }],
    tools: aiSdkTools,
    activeTools: canonical.activeTools,
    system: 'sys',
    abortSignal: new AbortController().signal,
    repairToolCall: async () => null,
  });
  // Drain the stream so streamText materializes the provider call.
  for await (const _chunk of result.fullStream) {
    void _chunk;
  }
  return seen;
}

describe('deferred tools are trimmed from the provider request (wire-level)', () => {
  test('an unloaded deferred tool never reaches the model; invalid is never advertised', async () => {
    const seen = await toolNamesSeenByProvider(new Set());
    assert.ok(seen.includes('Read'), 'direct Read should reach the provider');
    assert.ok(seen.includes('load_tool'), 'load_tool should reach the provider');
    assert.ok(!seen.includes('Rive'), 'unloaded deferred Rive must NOT reach the provider');
    assert.ok(!seen.includes('invalid'), 'invalid is providerTools-only, never advertised');
  });

  test('a loaded deferred tool does reach the model (ratchet activates it)', async () => {
    const seen = await toolNamesSeenByProvider(new Set(['Rive']));
    assert.ok(seen.includes('Rive'), 'loaded deferred Rive should reach the provider');
    assert.ok(seen.includes('Read'), 'direct tools stay present after a load');
  });
});
