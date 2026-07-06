/**
 * Tests for buildLlmHistorySummarizer — the host-supplied LLM summary that
 * replaces the deterministic excerpt draft when wiring injects it.
 *
 * Run: `npm --workspace @maka/runtime run test`
 */
import { describe, test } from 'node:test';
import { expect } from '../test-helpers.js';
import type { RuntimeEvent, RuntimeEventContent } from '@maka/core/runtime-event';
import type { HistoryCompactWriteInput } from '../ai-sdk-backend.js';
import { buildLlmHistorySummarizer, type LlmConversationSummarizer } from '../history-compact-summarizer.js';

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
  test('returns the LLM summary and sends the tool-bearing conversation to the summarizer', async () => {
    const seen: Array<{ system: string; messages: unknown[] }> = [];
    const summarizeConversation: LlmConversationSummarizer = async (req) => {
      seen.push(req);
      return '## Goal\n做到 X';
    };

    const summarize = buildLlmHistorySummarizer({ summarizeConversation });

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

  test('fail-open: returns undefined when the summarizer throws, so runtime falls back to the draft', async () => {
    const summarizeConversation: LlmConversationSummarizer = async () => {
      throw new Error('model down');
    };
    const summarize = buildLlmHistorySummarizer({ summarizeConversation });

    const result = await summarize(
      inputWith([ev({ role: 'user', author: 'user', content: { kind: 'text', text: 'hi' } })]),
    );

    expect(result).toBe(undefined);
  });

  test('returns undefined without calling the summarizer when there are no events to summarize', async () => {
    let called = false;
    const summarizeConversation: LlmConversationSummarizer = async () => {
      called = true;
      return 'should not reach';
    };
    const summarize = buildLlmHistorySummarizer({ summarizeConversation });

    const result = await summarize(inputWith([]));

    expect(result).toBe(undefined);
    expect(called).toBe(false);
  });
});
