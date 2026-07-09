import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { SessionEvent } from '@maka/core/events';

import { AsyncEventQueue } from '../async-queue.js';
import {
  ModelAdapter,
  normalizeAiSdkUsage,
  type AiSdkStreamChunk,
} from '../model-adapter.js';

describe('ModelAdapter stream and error normalization', () => {
  test('normalizes provider text, reasoning, ignored tool chunks, and errors into SessionEvents', () => {
    const events: SessionEvent[] = [];
    const queue = new AsyncEventQueue<SessionEvent>();
    const adapter = newAdapter();
    const callbacks = {
      text: '',
      thinking: '',
      signature: undefined as string | undefined,
      onText(text: string) {
        this.text += text;
      },
      onTextComplete(text: string) {
        this.text = text;
      },
      onThinking(text: string) {
        this.thinking += text;
      },
      onThinkingSignature(signature: string) {
        this.signature = signature;
      },
    };
    const push = queue.push.bind(queue);
    queue.push = (event: SessionEvent) => {
      events.push(event);
      push(event);
    };

    const chunks: AiSdkStreamChunk[] = [
      { type: 'text-delta', text: 'hello ' },
      { type: 'text-delta', textDelta: 'world' },
      { type: 'reasoning', delta: 'think ' },
      { type: 'reasoning-delta', text: 'more' },
      { type: 'tool-call', toolCallId: 'tool-1', toolName: 'Read' },
      { type: 'tool-result', toolCallId: 'tool-1', result: { ok: true } },
      { type: 'error', error: Object.assign(new Error('429 rate limit'), { code: 429 }) },
      { type: 'unknown-provider-chunk' },
    ];

    for (const chunk of chunks) {
      adapter.handleStreamChunk(chunk, 'turn-1', 'assistant-1', queue, callbacks);
    }

    assert.equal(callbacks.text, 'hello world');
    assert.equal(callbacks.thinking, 'think more');
    assert.deepEqual(
      events.map((event) => event.type),
      ['text_delta', 'text_delta', 'thinking_delta', 'thinking_delta', 'error'],
    );
    assert.deepEqual(
      events
        .filter((event) => event.type === 'text_delta')
        .map((event) => event.text),
      ['hello ', 'world'],
    );
    assert.deepEqual(
      events
        .filter((event) => event.type === 'thinking_delta')
        .map((event) => event.text),
      ['think ', 'more'],
    );
    const error = events.find((event) => event.type === 'error') as Extract<SessionEvent, { type: 'error' }> | undefined;
    assert.equal(error?.reason, 'rate_limit');
    assert.equal(error?.code, '429');
    assert.equal(error?.message, 'Rate limit exceeded');
  });

  test('treats AI SDK v6 step boundaries (start-step / finish-step) as no-ops', () => {
    const events: SessionEvent[] = [];
    const queue = new AsyncEventQueue<SessionEvent>();
    const adapter = newAdapter();
    const callbacks = {
      textCalls: 0,
      thinkingCalls: 0,
      signatureCalls: 0,
      onText() { this.textCalls += 1; },
      onTextComplete() {},
      onThinking() { this.thinkingCalls += 1; },
      onThinkingSignature() { this.signatureCalls += 1; },
    };
    const push = queue.push.bind(queue);
    queue.push = (event: SessionEvent) => {
      events.push(event);
      push(event);
    };

    // The backend owns step accounting (count + per-step AssistantMessage flush
    // + messageId rotation), so the adapter must not emit events or touch the
    // text/thinking callbacks for step-boundary chunks.
    const chunks: AiSdkStreamChunk[] = [
      { type: 'start-step' } as AiSdkStreamChunk,
      { type: 'text-delta', text: 'one' },
      { type: 'finish-step', finishReason: { unified: 'tool-calls', raw: 'tool_calls' } } as AiSdkStreamChunk,
      { type: 'start-step' } as AiSdkStreamChunk,
      { type: 'text-delta', text: 'two' },
      { type: 'finish-step', finishReason: { unified: 'stop', raw: 'stop' } } as AiSdkStreamChunk,
    ];
    for (const chunk of chunks) {
      adapter.handleStreamChunk(chunk, 'turn-1', 'assistant-1', queue, callbacks);
    }

    // Only the two text deltas produce events / callbacks; boundaries are inert.
    assert.deepEqual(events.map((event) => event.type), ['text_delta', 'text_delta']);
    assert.equal(callbacks.textCalls, 2);
    assert.equal(callbacks.thinkingCalls, 0);
    assert.equal(callbacks.signatureCalls, 0);
  });

  test('captures the Anthropic reasoning signature without emitting an empty thinking delta', () => {
    const events: SessionEvent[] = [];
    const queue = new AsyncEventQueue<SessionEvent>();
    const adapter = newAdapter();
    const callbacks = {
      thinking: '',
      signature: undefined as string | undefined,
      onText() {},
      onTextComplete() {},
      onThinking(text: string) {
        this.thinking += text;
      },
      onThinkingSignature(signature: string) {
        this.signature = signature;
      },
    };
    const push = queue.push.bind(queue);
    queue.push = (event: SessionEvent) => {
      events.push(event);
      push(event);
    };

    // Mirrors the @ai-sdk/anthropic stream shape: reasoning text deltas, then a
    // standalone signature-only delta with empty text, then reasoning-end.
    const chunks: AiSdkStreamChunk[] = [
      { type: 'reasoning-start' } as AiSdkStreamChunk,
      { type: 'reasoning-delta', delta: 'weigh ' },
      { type: 'reasoning-delta', delta: 'options' },
      { type: 'reasoning-delta', delta: '', providerMetadata: { anthropic: { signature: 'sig-xyz' } } },
      { type: 'reasoning-end' } as AiSdkStreamChunk,
    ];
    for (const chunk of chunks) {
      adapter.handleStreamChunk(chunk, 'turn-1', 'assistant-1', queue, callbacks);
    }

    assert.equal(callbacks.thinking, 'weigh options');
    assert.equal(callbacks.signature, 'sig-xyz');
    // The empty signature-carrier delta must not become a thinking_delta event.
    assert.deepEqual(
      events.map((event) => event.type),
      ['thinking_delta', 'thinking_delta'],
    );
    assert.deepEqual(
      events
        .filter((event) => event.type === 'thinking_delta')
        .map((event) => event.text),
      ['weigh ', 'options'],
    );
  });

  test('classifies provider errors and maps finish reasons through adapter-owned helpers', () => {
    const adapter = newAdapter();

    assert.equal(adapter.classifyError(Object.assign(new Error('401 Authorization'), { code: 401 })), 'Auth');
    assert.equal(adapter.makeErrorEvent('turn-1', new Error('Model stream idle timeout after 120000ms')).reason, 'timeout');
    assert.equal(adapter.mapFinishReason('stop'), 'end_turn');
    assert.equal(adapter.mapFinishReason('length'), 'max_tokens');
    assert.equal(adapter.mapFinishReason('content-filter'), 'error');
    assert.equal(adapter.mapFinishReason('error'), 'error');
    assert.equal(adapter.mapFinishReason('tool-calls'), 'end_turn');
    assert.equal(adapter.mapFinishReason('provider-new-reason'), 'end_turn');
  });

  test('normalizes cache and reasoning usage variants in the adapter module', () => {
    assert.deepEqual(
      normalizeAiSdkUsage({
        promptTokens: 20,
        completionTokens: 5,
        totalTokens: 30,
        cacheReadInputTokens: 7,
        cacheCreationInputTokens: 3,
        inputTokenDetails: {
          reasoningTokens: 2,
        },
      }),
      {
        inputTokens: 20,
        outputTokens: 5,
        cacheHitInputTokens: 7,
        cacheMissInputTokens: 10,
        cacheMissInputSource: 'derived',
        cachedInputTokens: 7,
        cacheWriteInputTokens: 3,
        reasoningTokens: 2,
        totalTokens: 30,
      },
    );
  });

  test('preserves DeepSeek and OpenAI-compatible raw usage fields', () => {
    assert.deepEqual(
      normalizeAiSdkUsage(
        {
          promptTokens: 100,
          completionTokens: 20,
          prompt_cache_hit_tokens: 40,
          prompt_cache_miss_tokens: 60,
          prompt_tokens_details: {
            cached_tokens: 35,
          },
          completion_tokens_details: {
            reasoning_tokens: 8,
          },
        },
        { rawFinishReason: { unified: 'stop', raw: 'provider_stop' } },
      ),
      {
        inputTokens: 100,
        outputTokens: 20,
        cacheHitInputTokens: 40,
        cacheMissInputTokens: 60,
        cacheMissInputSource: 'explicit',
        cachedInputTokens: 40,
        cacheWriteInputTokens: 0,
        reasoningTokens: 8,
        totalTokens: 120,
        rawFinishReason: 'provider_stop',
        raw: {
          prompt_cache_hit_tokens: 40,
          prompt_cache_miss_tokens: 60,
          prompt_tokens_details: {
            cached_tokens: 35,
          },
          completion_tokens_details: {
            reasoning_tokens: 8,
          },
        },
      },
    );
  });

  test('normalizes AI SDK raw DeepSeek usage metadata and no-cache token details', () => {
    assert.deepEqual(
      normalizeAiSdkUsage(
        {
          inputTokens: 100,
          outputTokens: 20,
          inputTokenDetails: {
            noCacheTokens: 25,
            cacheReadTokens: 75,
          },
          outputTokenDetails: {
            reasoningTokens: 9,
          },
          raw: {
            prompt_cache_hit_tokens: 70,
            prompt_cache_miss_tokens: 30,
            prompt_tokens_details: {
              cached_tokens: 70,
            },
            completion_tokens_details: {
              reasoning_tokens: 11,
            },
          },
        },
        { rawFinishReason: 'stop' },
      ),
      {
        inputTokens: 100,
        outputTokens: 20,
        cacheHitInputTokens: 70,
        cacheMissInputTokens: 30,
        cacheMissInputSource: 'explicit',
        cachedInputTokens: 70,
        cacheWriteInputTokens: 0,
        reasoningTokens: 9,
        totalTokens: 120,
        rawFinishReason: 'stop',
        raw: {
          prompt_cache_hit_tokens: 70,
          prompt_cache_miss_tokens: 30,
          prompt_tokens_details: {
            cached_tokens: 70,
          },
          completion_tokens_details: {
            reasoning_tokens: 11,
          },
        },
      },
    );
  });

  test('normalizes direct DeepSeek snake_case usage totals', () => {
    assert.deepEqual(
      normalizeAiSdkUsage(
        {
          prompt_tokens: 1460,
          completion_tokens: 2,
          total_tokens: 1462,
          prompt_cache_hit_tokens: 1408,
          prompt_cache_miss_tokens: 52,
          prompt_tokens_details: {
            cached_tokens: 1408,
          },
        },
        { rawFinishReason: 'stop' },
      ),
      {
        inputTokens: 1460,
        outputTokens: 2,
        cacheHitInputTokens: 1408,
        cacheMissInputTokens: 52,
        cacheMissInputSource: 'explicit',
        cachedInputTokens: 1408,
        cacheWriteInputTokens: 0,
        reasoningTokens: 0,
        totalTokens: 1462,
        rawFinishReason: 'stop',
        raw: {
          prompt_tokens: 1460,
          completion_tokens: 2,
          total_tokens: 1462,
          prompt_cache_hit_tokens: 1408,
          prompt_cache_miss_tokens: 52,
          prompt_tokens_details: {
            cached_tokens: 1408,
          },
        },
      },
    );
  });

  test('derives cache miss input when explicit miss is absent and treats no cache data as fresh', () => {
    assert.equal(
      normalizeAiSdkUsage({
        inputTokens: 100,
        outputTokens: 10,
        cachedInputTokens: 30,
        cacheWriteInputTokens: 20,
      })?.cacheMissInputTokens,
      50,
    );
    assert.equal(
      normalizeAiSdkUsage({
        inputTokens: 100,
        outputTokens: 10,
        cachedInputTokens: 30,
        cacheWriteInputTokens: 20,
      })?.cacheMissInputSource,
      'derived',
    );

    assert.equal(
      normalizeAiSdkUsage({
        inputTokens: 100,
        outputTokens: 10,
      })?.cacheMissInputTokens,
      100,
    );
  });
});

function newAdapter(): ModelAdapter {
  return new ModelAdapter({
    connection: {
      slug: 'anthropic-main',
      name: 'Anthropic',
      providerType: 'anthropic',
      defaultModel: 'claude-sonnet-4-5-20250929',
      enabled: true,
      createdAt: 1,
      updatedAt: 1,
    },
    apiKey: 'sk-test',
    modelId: 'claude-sonnet-4-5-20250929',
    modelFactory: () => ({}),
    maxSteps: 50,
    newId: idGenerator(),
    now: monotonicClock(),
  });
}

function idGenerator(): () => string {
  let index = 0;
  return () => `id-${++index}`;
}

function monotonicClock(): () => number {
  let value = 1_000;
  return () => ++value;
}
