import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { z } from 'zod';
import { MockLanguageModelV4, convertArrayToReadableStream } from 'ai/test';
import type { LanguageModelV4StreamPart, LanguageModelV4Usage } from '@ai-sdk/provider';

import { ModelAdapter } from '../model-adapter.js';
import type { ModelToolSet, ToolCallPart } from '../model-protocol.js';
import { ToolAvailabilityRuntime, LOAD_TOOLS_NAME } from '../tool-availability.js';
import type { MakaTool } from '../tool-runtime.js';

const ZERO_USAGE: LanguageModelV4Usage = {
  inputTokens: { total: 0, noCache: 0, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 0, text: 0, reasoning: 0 },
};

function makaTool(name: string): MakaTool {
  return {
    name,
    description: `${name} tool`,
    parameters: z.object({ q: z.string().optional() }),
    impl: () => ({ ok: true }),
  };
}

function newAdapter(): ModelAdapter {
  return new ModelAdapter({
    connection: { providerType: 'openai' } as never,
    apiKey: 'test',
    modelId: 'mock',
    modelFactory: () => ({}),
    providerOptions: {},
    newId: () => 'id',
    now: () => 0,
  });
}

describe('Runtime request projection activates deferred tools', () => {
  test('a group loaded by one provider step reaches the next provider request', async () => {
    const invalid = makaTool('invalid');
    const runtime = new ToolAvailabilityRuntime(
      [makaTool('Read'), makaTool('RiveWorkflow')],
      { economy: true, groups: [{ id: 'rive', toolNames: ['RiveWorkflow'], label: 'Rive' }] },
      invalid,
    );
    const plan = runtime.prepare([]);

    // The model-visible names doStream receives, per step.
    const toolsPerStep: string[][] = [];

    const model = new MockLanguageModelV4({
      doStream: async ({ tools: stepTools }) => {
        const names = (stepTools ?? []).map((t) => t.name);
        toolsPerStep.push(names);
        const isFirstStep = toolsPerStep.length === 1;
        const parts: LanguageModelV4StreamPart[] = isFirstStep
          ? [
              { type: 'stream-start', warnings: [] },
              // The real load_tools carries the { group } schema, so the SDK
              // parses the tool-call input correctly.
              {
                type: 'tool-call',
                toolCallId: 'tc1',
                toolName: LOAD_TOOLS_NAME,
                input: JSON.stringify({ group: 'rive' }),
              },
              {
                type: 'finish',
                finishReason: { unified: 'tool-calls', raw: 'tool_calls' },
                usage: ZERO_USAGE,
              },
            ]
          : [
              { type: 'stream-start', warnings: [] },
              { type: 'finish', finishReason: { unified: 'stop', raw: 'stop' }, usage: ZERO_USAGE },
            ];
        return { stream: convertArrayToReadableStream(parts) };
      },
    });

    // Build the schema-only tool set the backend passes to ModelAdapter.
    const modelTools: ModelToolSet = {};
    for (const t of plan.providerTools) {
      modelTools[t.name] = {
        description: t.description,
        inputSchema: t.parameters,
      };
    }

    const adapter = newAdapter();
    const first = await adapter.startStream({
      model,
      messages: [{ role: 'user', content: 'animate it' }],
      tools: modelTools,
      activeTools: plan.activeTools,
      system: 'sys',
      abortSignal: new AbortController().signal,
      repairToolCall: async () => null,
    });
    const returnedToolCalls: ToolCallPart[] = [];
    for await (const event of first.events) {
      if (event.kind === 'tool-call') returnedToolCalls.push(event.toolCall);
    }
    const projected = plan.projectActiveTools!({
      completedSteps: [{ toolCalls: returnedToolCalls }],
    });
    const second = await adapter.startStream({
      model,
      messages: [{ role: 'user', content: 'animate it' }],
      tools: modelTools,
      activeTools: projected.activeTools,
      system: 'sys',
      abortSignal: new AbortController().signal,
      repairToolCall: async () => null,
    });
    for await (const _event of second.events) void _event;

    assert.equal(toolsPerStep.length, 2, 'expected two model steps (load then use)');
    assert.ok(
      !toolsPerStep[0].includes('RiveWorkflow'),
      'step 0 must NOT see the hidden RiveWorkflow',
    );
    assert.ok(toolsPerStep[0].includes(LOAD_TOOLS_NAME), 'step 0 sees load_tools');
    assert.ok(
      toolsPerStep[1].includes('RiveWorkflow'),
      'step 1 MUST see RiveWorkflow after the load',
    );
  });
});
