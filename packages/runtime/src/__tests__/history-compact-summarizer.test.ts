/**
 * Tests for buildLlmHistorySummarizer — the AI-SDK-backed LLM summary that
 * replaces the deterministic excerpt draft when wiring injects it.
 *
 * Run: `npm --workspace @maka/runtime run test`
 */
import { describe, test } from 'node:test';
import { expect } from '../test-helpers.js';
import type { RuntimeEvent, RuntimeEventContent } from '@maka/core/runtime-event';
import type { HistoryCompactWriteInput } from '../ai-sdk-backend.js';
import { buildLlmHistorySummarizer, type AiSdkGenerateTextLike } from '../history-compact-summarizer.js';

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

function inputWith(events: RuntimeEvent[], abortSignal?: AbortSignal): HistoryCompactWriteInput {
  return {
    sessionId: 'sess-1',
    turnId: 'turn-1',
    source: {
      draftBlock: {} as HistoryCompactWriteInput['source']['draftBlock'],
      foldedRuntimeEvents: events,
    },
    limits: {
      maxBlocks: 1,
      maxBlockEstimatedTokens: 2048,
      maxEstimatedTokens: 4096,
      charsPerToken: 4,
    },
    ...(abortSignal ? { abortSignal } : {}),
  };
}

describe('buildLlmHistorySummarizer', () => {
  test('returns the LLM summary and sends the tool-bearing conversation to generateText', async () => {
    const seen: Array<{ system: string; messages: unknown[] }> = [];
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
        content: { kind: 'function_call', id: 'fc1', name: 'read', args: { path: 'package.json' } },
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
    // summarizer 收到的是模型可见的含 tool 对话，而不是纯文本摘要
    expect(serialized).toContain('package.json');
    expect(serialized).toContain('maka');
  });

  test('produces schema-valid tool-result messages (toolName + wrapped output) and does not fall back', async () => {
    const seen: Array<{ messages: unknown[] }> = [];
    const generateText: AiSdkGenerateTextLike = async (opts) => {
      seen.push(opts);
      return { text: '## Goal\nX' };
    };
    const summarize = buildLlmHistorySummarizer({ resolveModel: () => 'fake-model', generateText });

    const events: RuntimeEvent[] = [
      ev({ role: 'user', author: 'user', content: { kind: 'text', text: '读 package.json' } }),
      ev({
        role: 'model',
        author: 'agent',
        content: { kind: 'function_call', id: 'fc1', name: 'read', args: { path: 'package.json' } },
      }),
      ev({
        role: 'tool',
        author: 'tool',
        content: { kind: 'function_response', id: 'fc1', name: 'read', result: { name: 'maka' } },
      }),
      ev({ role: 'model', author: 'agent', content: { kind: 'text', text: 'ok' } }),
    ];

    const result = await summarize(inputWith(events));
    expect(result).toBe('## Goal\nX');

    const messages = seen[0]!.messages as Array<{
      role: string;
      content: Array<{ type: string; toolName?: string; output?: unknown }>;
    }>;
    const toolPart = messages.find((m) => m.role === 'tool')!.content[0]!;
    expect(toolPart.type).toBe('tool-result');
    // toolName must be present (AI SDK v6 tool-result content requires it)
    expect(toolPart.toolName).toBe('read');
    // output must be the {type, value} wrapper, not the raw result object
    expect(toolPart.output).toEqual({ type: 'json', value: { name: 'maka' } });
  });

  test('fail-open: returns undefined when generateText throws, so runtime falls back to the draft', async () => {
    const generateText: AiSdkGenerateTextLike = async () => {
      throw new Error('model down');
    };
    const summarize = buildLlmHistorySummarizer({ resolveModel: () => 'fake-model', generateText });

    const result = await summarize(
      inputWith([ev({ role: 'user', author: 'user', content: { kind: 'text', text: 'hi' } })]),
    );

    expect(result).toBe(undefined);
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
});
