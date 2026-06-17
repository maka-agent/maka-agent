import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { z } from 'zod';
import { MockLanguageModelV3, convertArrayToReadableStream } from 'ai/test';
import type { LanguageModelV3StreamPart, LanguageModelV3Usage } from '@ai-sdk/provider';

import { ModelAdapter } from '../model-adapter.js';
import { canonicalizeToolSet } from '../request-shape.js';
import { buildDeferredPrepareStep } from '../deferred-activation.js';
import { buildLoadTool, type DeferredToolCatalog } from '../load-tool.js';
import type { MakaTool } from '../tool-runtime.js';

const ZERO_USAGE: LanguageModelV3Usage = {
  inputTokens: { total: 0, noCache: 0, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 0, text: 0, reasoning: 0 },
};

function makaTool(name: string, exposure?: 'direct' | 'deferred'): MakaTool {
  return {
    name,
    description: `${name} tool`,
    parameters: z.object({ q: z.string().optional() }),
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
    maxSteps: 4,
    newId: () => 'id',
    now: () => 0,
  });
}

describe('prepareStep activates a deferred tool within the same turn (Codex Δ1)', () => {
  test('a tool loaded at step 0 reaches the provider at step 1', async () => {
    const catalog: DeferredToolCatalog = [
      { namespace: 'rive', summary: 'Rive workflows', toolNames: ['RiveWorkflow'] },
    ];
    // The real load_tool carries the { namespace } schema, so the SDK parses the
    // tool-call input correctly (a generic schema would strip `namespace`).
    const tools: MakaTool[] = [
      makaTool('Read'),
      buildLoadTool(catalog),
      makaTool('RiveWorkflow', 'deferred'),
    ];
    const invalid = makaTool('invalid');

    // The model-visible names doStream receives, per step.
    const toolsPerStep: string[][] = [];

    const model = new MockLanguageModelV3({
      doStream: async ({ tools: stepTools }) => {
        const names = (stepTools ?? []).map((t) => t.name);
        toolsPerStep.push(names);
        const isFirstStep = toolsPerStep.length === 1;
        const parts: LanguageModelV3StreamPart[] = isFirstStep
          ? [
              { type: 'stream-start', warnings: [] },
              { type: 'tool-call', toolCallId: 'tc1', toolName: 'load_tool', input: JSON.stringify({ namespace: 'rive' }) },
              { type: 'finish', finishReason: { unified: 'tool-calls', raw: 'tool_calls' }, usage: ZERO_USAGE },
            ]
          : [
              { type: 'stream-start', warnings: [] },
              { type: 'finish', finishReason: { unified: 'stop', raw: 'stop' }, usage: ZERO_USAGE },
            ];
        return { stream: convertArrayToReadableStream(parts) };
      },
    });

    // Build the ai-sdk tools dict the backend would build, with a working
    // load_tool execute that returns the thin activation result.
    const canonical = canonicalizeToolSet(tools, invalid);
    const aiSdkTools: Record<string, unknown> = {};
    for (const t of canonical.providerTools) {
      aiSdkTools[t.name] = {
        description: t.description,
        inputSchema: t.parameters,
        execute: t.name === 'load_tool' ? () => ({ loaded: ['RiveWorkflow'] }) : () => ({ ok: true }),
      };
    }

    const prepareStep = buildDeferredPrepareStep({ tools, invalidTool: invalid, catalog });

    const result = await newAdapter().startStream({
      model,
      messages: [{ role: 'user', content: 'animate it' }],
      tools: aiSdkTools,
      activeTools: canonical.activeTools,
      prepareStep,
      system: 'sys',
      abortSignal: new AbortController().signal,
      repairToolCall: async () => null,
    });
    for await (const _chunk of result.fullStream) {
      void _chunk;
    }

    assert.equal(toolsPerStep.length, 2, 'expected two model steps (load then use)');
    assert.ok(!toolsPerStep[0].includes('RiveWorkflow'), 'step 0 must NOT see the deferred RiveWorkflow');
    assert.ok(toolsPerStep[0].includes('load_tool'), 'step 0 sees load_tool');
    assert.ok(toolsPerStep[1].includes('RiveWorkflow'), 'step 1 MUST see RiveWorkflow after the load');
  });
});
