/**
 * Tests for createAiSdkConversationSummarizer — the ai-sdk-backed
 * LlmConversationSummarizer that CLI/desktop wiring inject into
 * buildLlmHistorySummarizer.
 *
 * Run: `npm --workspace @maka/runtime run test`
 */
import { describe, test } from 'node:test';
import { expect } from '../test-helpers.js';
import type { ModelMessage } from 'ai';
import {
  createAiSdkConversationSummarizer,
  type AiSdkGenerateTextOptions,
} from '../ai-sdk-conversation-summarizer.js';

const oneUserMessage = (): ModelMessage[] =>
  [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] as unknown as ModelMessage[];

describe('createAiSdkConversationSummarizer', () => {
  test('resolves the model and returns the generated summary text', async () => {
    const seen: AiSdkGenerateTextOptions[] = [];
    const summarize = createAiSdkConversationSummarizer({
      resolveModel: () => 'fake-model',
      maxOutputTokens: 2048,
      generateText: async (opts) => {
        seen.push(opts);
        return { text: '## Goal\n做到 X' };
      },
    });
    const messages = oneUserMessage();

    const text = await summarize({ system: 'sys', messages });

    expect(text).toBe('## Goal\n做到 X');
    expect(seen.length).toBe(1);
    expect(seen[0]!.model).toBe('fake-model');
    expect(seen[0]!.system).toBe('sys');
    expect(seen[0]!.messages).toBe(messages);
    expect(seen[0]!.maxOutputTokens).toBe(2048);
  });

  test('forwards abortSignal to generateText', async () => {
    const seen: AiSdkGenerateTextOptions[] = [];
    const summarize = createAiSdkConversationSummarizer({
      resolveModel: () => 'fake-model',
      generateText: async (opts) => {
        seen.push(opts);
        return { text: 'ok' };
      },
    });
    const ac = new AbortController();

    await summarize({ system: 'sys', messages: oneUserMessage(), abortSignal: ac.signal });

    expect(seen[0]!.abortSignal).toBe(ac.signal);
  });
});
