/**
 * Tests for buildLlmHistorySummarizer — the AI-SDK-backed LLM summary that
 * replaces the deterministic excerpt draft when wiring injects it.
 *
 * Run: `npm --workspace @maka/runtime run test`
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { expect } from '../test-helpers.js';
import type { RuntimeEvent, RuntimeEventContent } from '@maka/core/runtime-event';
import type { HistoryCompactSummaryInput } from '../ai-sdk-backend.js';
import {
  buildLlmHistorySummarizer,
  type AiSdkGenerateTextLike,
} from '../history-compact-summarizer.js';
import { buildHistoryCompactCheckpoint } from '../history-compact-checkpoint.js';

const ts = 1_700_000_000_000;
let __seq = 0;
function ev(overrides: Partial<RuntimeEvent> & { content?: RuntimeEventContent }): RuntimeEvent {
  __seq += 1;
  return {
    id: `evt-${__seq}`,
    invocationId: 'inv-1',
    runId: 'run-1',
    sessionId: 'sess-1',
    turnId: 'turn-1',
    ts: ts + __seq,
    partial: false,
    ...overrides,
  } as RuntimeEvent;
}

function inputWith(events: RuntimeEvent[], abortSignal?: AbortSignal): HistoryCompactSummaryInput {
  return {
    sessionId: 'sess-1',
    turnId: 'turn-1',
    source: { foldedRuntimeEvents: events },
    ...(abortSignal ? { abortSignal } : {}),
  };
}

describe('buildLlmHistorySummarizer', () => {
  test('returns the LLM summary and sends the text-safe conversation to generateText', async () => {
    const seen: Array<{ instructions: string; messages: unknown[] }> = [];
    const generateText: AiSdkGenerateTextLike = async (opts) => {
      seen.push(opts);
      return { text: '## Goal\n做到 X' };
    };

    const summarize = buildLlmHistorySummarizer({ resolveModel: () => 'fake-model', generateText });

    const events: RuntimeEvent[] = [
      ev({ role: 'user', author: 'user', content: { kind: 'text', text: '读 package.json' } }),
      ev({
        role: 'model',
        author: 'agent',
        content: {
          kind: 'function_call',
          id: 'fc1',
          name: 'read',
          review: { kind: 'path', operation: 'read', path: 'package.json', cwd: '/workspace' },
        },
      }),
      ev({
        role: 'tool',
        author: 'tool',
        content: { kind: 'function_response', id: 'fc1', name: 'read', result: { name: 'maka' } },
      }),
      ev({ role: 'model', author: 'agent', content: { kind: 'text', text: '项目名是 maka' } }),
    ];

    const result = await summarize(inputWith(events));

    expect(result).toBe('## Goal\n做到 X');
    expect(seen.length).toBe(1);
    const serialized = JSON.stringify(seen[0]!.messages);
    // The summarizer receives the safe user/model text around the omitted tool pair.
    expect(serialized).toContain('package.json');
    expect(serialized).toContain('maka');
  });

  test('inherits the session provider options without imposing a compaction-only output cap', async () => {
    let seen: Parameters<AiSdkGenerateTextLike>[0] | undefined;
    const providerOptions = { openaiCompatible: { reasoningEffort: 'high' } };
    const summarize = buildLlmHistorySummarizer({
      resolveModel: () => 'fake-model',
      providerOptions,
      generateText: async (options) => {
        seen = options;
        return { text: '## Goal\nX' };
      },
    });

    await summarize(
      inputWith([ev({ role: 'user', author: 'user', content: { kind: 'text', text: 'hi' } })]),
    );

    expect(seen?.providerOptions).toBe(providerOptions);
    expect(seen?.maxOutputTokens).toBe(undefined);
  });

  test('omits public-review tool pairs from summarizer provider history', async () => {
    const seen: Array<{ messages: unknown[] }> = [];
    const generateText: AiSdkGenerateTextLike = async (opts) => {
      seen.push(opts);
      return { text: '## Goal\nX' };
    };
    const summarize = buildLlmHistorySummarizer({ resolveModel: () => 'fake-model', generateText });

    const events: RuntimeEvent[] = [
      ev({ role: 'user', author: 'user', content: { kind: 'text', text: 'inspect the project' } }),
      ev({
        role: 'model',
        author: 'agent',
        content: {
          kind: 'function_call',
          id: 'fc1',
          name: 'read',
          review: {
            kind: 'path',
            operation: 'read',
            path: 'PRIVATE_CONFIG_PATH',
            cwd: '/workspace',
          },
        },
      }),
      ev({
        role: 'tool',
        author: 'tool',
        content: {
          kind: 'function_response',
          id: 'fc1',
          name: 'read',
          result: { secret: 'PRIVATE_TOOL_RESULT' },
        },
      }),
      ev({ role: 'model', author: 'agent', content: { kind: 'text', text: 'safe conclusion' } }),
    ];

    const result = await summarize(inputWith(events));
    expect(result).toBe('## Goal\nX');

    expect(seen[0]!.messages).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'inspect the project' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'safe conclusion' }] },
    ]);
    const serialized = JSON.stringify(seen[0]!.messages);
    expect(serialized.includes('PRIVATE_CONFIG_PATH')).toBe(false);
    expect(serialized.includes('PRIVATE_TOOL_RESULT')).toBe(false);
  });

  test('projects persisted tool-result envelopes to the original provider-visible values', async () => {
    let seen: Parameters<AiSdkGenerateTextLike>[0] | undefined;
    const summarize = buildLlmHistorySummarizer({
      resolveModel: () => 'fake-model',
      generateText: async (options) => {
        seen = options;
        return { text: '## Goal\nX' };
      },
    });
    const events: RuntimeEvent[] = [
      ev({
        role: 'model',
        author: 'agent',
        content: {
          kind: 'function_call',
          id: 'json-call',
          name: 'read',
          args: { path: 'data.json' },
        },
      }),
      ev({
        role: 'tool',
        author: 'tool',
        content: {
          kind: 'function_response',
          id: 'json-call',
          name: 'read',
          result: { kind: 'json', value: { content: { ok: true } } },
        },
      }),
      ev({
        role: 'model',
        author: 'agent',
        content: {
          kind: 'function_call',
          id: 'text-call',
          name: 'read',
          args: { path: 'notes.txt' },
        },
      }),
      ev({
        role: 'tool',
        author: 'tool',
        content: {
          kind: 'function_response',
          id: 'text-call',
          name: 'read',
          result: { kind: 'text', text: 'file contents' },
        },
      }),
    ];

    await summarize(inputWith(events));

    expect(seen?.messages).toEqual([
      {
        role: 'assistant',
        content: [
          {
            type: 'tool-call',
            toolCallId: 'json-call',
            toolName: 'read',
            input: { path: 'data.json' },
          },
        ],
      },
      {
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolCallId: 'json-call',
            toolName: 'read',
            output: { type: 'json', value: { content: { ok: true } } },
          },
        ],
      },
      {
        role: 'assistant',
        content: [
          {
            type: 'tool-call',
            toolCallId: 'text-call',
            toolName: 'read',
            input: { path: 'notes.txt' },
          },
        ],
      },
      {
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolCallId: 'text-call',
            toolName: 'read',
            output: { type: 'text', value: 'file contents' },
          },
        ],
      },
    ]);
  });

  test('surfaces provider failures so the runtime can report the real compact reason', async () => {
    const generateText: AiSdkGenerateTextLike = async () => {
      throw new Error('model down');
    };
    const summarize = buildLlmHistorySummarizer({ resolveModel: () => 'fake-model', generateText });

    await assert.rejects(
      summarize(
        inputWith([ev({ role: 'user', author: 'user', content: { kind: 'text', text: 'hi' } })]),
      ),
      /provider_error/,
    );
  });

  test('surfaces an exhausted output budget instead of reporting a generic empty summary', async () => {
    const summarize = buildLlmHistorySummarizer({
      resolveModel: () => 'fake-model',
      generateText: async () => ({ text: '', finishReason: 'length' }),
    });

    await assert.rejects(
      summarize(
        inputWith([ev({ role: 'user', author: 'user', content: { kind: 'text', text: 'hi' } })]),
      ),
      /output_length/,
    );
  });

  test('rejects non-empty partial text when the provider exhausted its output budget', async () => {
    const summarize = buildLlmHistorySummarizer({
      resolveModel: () => 'fake-model',
      generateText: async () => ({ text: '## Goal\npartial summary', finishReason: 'length' }),
    });

    await assert.rejects(
      summarize(
        inputWith([ev({ role: 'user', author: 'user', content: { kind: 'text', text: 'hi' } })]),
      ),
      /output_length/,
    );
  });

  test('returns undefined without calling generateText when there are no events to summarize', async () => {
    let called = false;
    const generateText: AiSdkGenerateTextLike = async () => {
      called = true;
      return { text: 'should not reach' };
    };
    const summarize = buildLlmHistorySummarizer({ resolveModel: () => 'fake-model', generateText });

    const result = await summarize(inputWith([]));

    expect(result).toBe(undefined);
    expect(called).toBe(false);
  });

  test('rolling summary sends the prior summary plus only newly folded events', async () => {
    const seen: unknown[] = [];
    const summarize = buildLlmHistorySummarizer({
      resolveModel: () => 'fake-model',
      generateText: async (options) => {
        seen.push(options.messages);
        return { text: 'rolled' };
      },
    });
    const old = ev({
      role: 'user',
      author: 'user',
      content: { kind: 'text', text: 'ALREADY_SUMMARIZED_RAW' },
    });
    const newer = ev({
      role: 'model',
      author: 'agent',
      content: { kind: 'text', text: 'NEWLY_EVICTED_RAW' },
    });
    const previousCheckpoint = buildHistoryCompactCheckpoint({
      sessionId: 'sess-1',
      coveredRuntimeEvents: [old],
      summary: 'PRIOR_SUMMARY',
    });
    const input = inputWith([old, newer]);

    const result = await summarize({
      ...input,
      previousCheckpoint,
      newlyFoldedRuntimeEvents: [newer],
    });

    expect(result).toBe('rolled');
    const serialized = JSON.stringify(seen[0]);
    expect(serialized).toContain('PRIOR_SUMMARY');
    expect(serialized).toContain('NEWLY_EVICTED_RAW');
    expect(serialized.includes('ALREADY_SUMMARIZED_RAW')).toBe(false);
  });
});
