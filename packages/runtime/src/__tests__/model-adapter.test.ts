import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { createJsonErrorResponseHandler } from '@ai-sdk/provider-utils';
import type { SessionEvent } from '@maka/core/events';
import { z } from 'zod/v4';

import { AsyncEventQueue } from '../async-queue.js';
import {
  ModelAdapter,
  normalizeAiSdkUsage,
  type AiSdkStreamChunk,
} from '../model-adapter.js';

describe('ModelAdapter stream and error normalization', () => {
  test('resolves optional-key LocalAI without fabricating a credential', () => {
    const model = {};
    let observedApiKey: string | undefined;
    const adapter = new ModelAdapter({
      connection: {
        slug: 'localai',
        name: 'LocalAI',
        providerType: 'localai',
        defaultModel: 'qwen3-8b',
        enabled: true,
        createdAt: 1,
        updatedAt: 1,
      },
      apiKey: '',
      modelId: 'qwen3-8b',
      modelFactory: (input) => {
        observedApiKey = input.apiKey;
        return model;
      },
      maxSteps: 2,
      newId: idGenerator(),
      now: monotonicClock(),
    });

    assert.equal(adapter.resolveModel(), model);
    assert.equal(observedApiKey, '');
  });

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
    assert.equal(adapter.classifyError(new TypeError('terminated')), 'Network');
    const billingError = Object.assign(new Error('provider request failed'), { statusCode: 402 });
    assert.equal(adapter.classifyError(billingError), 'ProviderBilling');
    assert.equal(adapter.makeErrorEvent('turn-1', billingError).reason, 'provider_billing');
    assert.equal(adapter.makeErrorEvent('turn-1', new Error('Model stream idle timeout after 120000ms')).reason, 'timeout');
    assert.equal(adapter.mapFinishReason('stop'), 'end_turn');
    assert.equal(adapter.mapFinishReason('length'), 'max_tokens');
    assert.equal(adapter.mapFinishReason('content-filter'), 'error');
    assert.equal(adapter.mapFinishReason('error'), 'error');
    assert.equal(adapter.mapFinishReason('tool-calls'), 'end_turn');
    assert.equal(adapter.mapFinishReason('provider-new-reason'), 'end_turn');
  });

  test('projects a structured network error to a consistent reason and safe message', () => {
    const event = newAdapter().makeErrorEvent('turn-1', {
      message: 'fetch failed',
      detail: 'token=sk-live-secret-token-value',
    });

    assert.equal(event.reason, 'network');
    assert.equal(event.message, 'Network error');
    assert.equal(JSON.stringify(event).includes('sk-live-secret-token-value'), false);
  });

  test('retains Node connection copy without promoting retry classification', () => {
    const adapter = newAdapter();
    const error = new Error('connect ECONNREFUSED 127.0.0.1:443');
    const event = adapter.makeErrorEvent('turn-1', error);

    assert.equal(adapter.classifyError(error), 'Error');
    assert.equal(event.reason, undefined);
    assert.equal(event.message, 'Network error');
  });

  test('projects string provider errors through the same classification', () => {
    const event = newAdapter().makeErrorEvent('turn-1', 'fetch failed');

    assert.equal(event.reason, 'network');
    assert.equal(event.message, 'Network error');
  });

  test('keeps an unknown structured provider error generic', () => {
    const event = newAdapter().makeErrorEvent('turn-1', { message: 'provider exploded' });

    assert.equal(event.reason, undefined);
    assert.equal(event.message, 'Operation failed');
  });

  test('classifies provider context-length overflow errors as ContextLength', () => {
    const adapter = newAdapter();
    const overflow = (message: string, extra: Record<string, unknown> = {}) =>
      adapter.classifyError(Object.assign(new Error(message), { name: 'AI_APICallError', ...extra }));

    // A representative sample across the providers Maka supports.
    assert.equal(overflow('prompt is too long: 213462 tokens > 200000 maximum', { statusCode: 400 }), 'ContextLength'); // Anthropic
    assert.equal(overflow('413 request_too_large: Request exceeds the maximum size', { statusCode: 413 }), 'ContextLength'); // Anthropic 413
    assert.equal(overflow('Your input exceeds the context window of this model', { statusCode: 400 }), 'ContextLength'); // OpenAI
    assert.equal(overflow("Requested token count exceeds the model's maximum context length of 131072 tokens", { statusCode: 400 }), 'ContextLength'); // LiteLLM
    assert.equal(overflow('The input token count (1196265) exceeds the maximum number of tokens allowed (1048575)', { statusCode: 400 }), 'ContextLength'); // Google
    assert.equal(overflow("This model's maximum prompt length is 131072 but the request contains 537812 tokens", { statusCode: 400 }), 'ContextLength'); // xAI
    assert.equal(overflow('Please reduce the length of the messages or completion', { statusCode: 400 }), 'ContextLength'); // Groq
    assert.equal(overflow("This endpoint's maximum context length is 262144 tokens", { statusCode: 400 }), 'ContextLength'); // OpenRouter
    assert.equal(overflow('Prompt contains 5000 tokens; too large for model with 4096 maximum context length', { statusCode: 400 }), 'ContextLength'); // Mistral
    assert.equal(overflow('invalid params, context window exceeds limit', { statusCode: 400 }), 'ContextLength'); // MiniMax
    assert.equal(overflow('Your request exceeded model token limit: 200000 (requested: 260000)', { statusCode: 400 }), 'ContextLength'); // Kimi
    assert.equal(overflow('prompt token count of 21000 exceeds the limit of 16384', { statusCode: 400 }), 'ContextLength'); // GitHub Copilot
    assert.equal(overflow('the prompt contains too many tokens', { statusCode: 400 }), 'ContextLength'); // generic prompt-overflow wording

    // The classification covers the ORIGINAL error fields, not just the message.
    // A real AI SDK APICallError carries the provider's structured error JSON in
    // `data` (parsed by createJsonErrorResponseHandler) or `responseBody` — there
    // is NO top-level `.code` — so a structured code with a generic HTTP message
    // must classify from those fields (review round-7 P1-1).
    assert.equal(
      overflow('Bad Request', {
        statusCode: 400,
        data: { error: { message: 'Bad Request', type: 'invalid_request_error', code: 'context_length_exceeded' } },
      }),
      'ContextLength',
    );
    // Same provider JSON reachable only through the raw response body. The
    // body must be a shape the OpenAI errorSchema genuinely REJECTS (here:
    // missing the required error.message), because that is the only way a
    // real createJsonErrorResponseHandler leaves `data` absent while keeping
    // `responseBody` — a schema-valid body always produces `data` (round-8 P3).
    assert.equal(
      overflow('Bad Request', {
        statusCode: 400,
        responseBody: '{"error":{"code":"context_length_exceeded"}}',
      }),
      'ContextLength',
    );
    // Anthropic puts the structured identifier in data.error.type.
    assert.equal(
      overflow('Request Entity Too Large', {
        statusCode: 413,
        data: { type: 'error', error: { type: 'request_too_large', message: 'Request Entity Too Large' } },
      }),
      'ContextLength',
    );

    // Stream error parts are NOT Error instances: each provider enqueues its
    // parsed error value as `{type:'error', error}` on the fullStream, and the
    // classifier must accept the real shapes (review round-8 P1-1):
    // OpenAI Chat emits the INNER error object (openai-chat-language-model.ts:479)…
    assert.equal(
      adapter.classifyError({
        message: 'Bad Request',
        type: 'invalid_request_error',
        param: null,
        code: 'context_length_exceeded',
      }),
      'ContextLength',
    );
    // …OpenAI Responses emits the WHOLE error chunk (openai-responses-language-model.ts:2105)…
    assert.equal(
      adapter.classifyError({
        type: 'error',
        sequence_number: 3,
        error: { type: 'invalid_request_error', code: 'context_length_exceeded', message: 'Bad Request', param: null },
      }),
      'ContextLength',
    );
    // …Anthropic emits the inner {type, message} object (anthropic-messages-language-model.ts:2441)…
    assert.equal(
      adapter.classifyError({ type: 'invalid_request_error', message: 'prompt is too long: 213462 tokens > 200000 maximum' }),
      'ContextLength',
    );
    assert.equal(
      adapter.classifyError({ type: 'request_too_large', message: 'Request exceeds the maximum size' }),
      'ContextLength',
    );
    // …and openai-compatible emits a bare message STRING (openai-compatible-chat-language-model.ts:466).
    assert.equal(
      adapter.classifyError("Requested token count exceeds the model's maximum context length of 131072 tokens."),
      'ContextLength',
    );
    // Non-overflow object/string errors do not become ContextLength.
    assert.equal(
      adapter.classifyError({ type: 'invalid_request_error', message: 'missing required field' }),
      'Other',
    );

    // Specific overflow evidence outranks a generic 5xx (review round-8 P1-2):
    // LiteLLM-style proxies surface a provider overflow through a 503 wrapper,
    // both as a structured code and as message text (pi overflow fixture).
    assert.equal(
      overflow('Service Unavailable', {
        statusCode: 503,
        data: { error: { message: 'Service Unavailable', code: 'context_length_exceeded' } },
      }),
      'ContextLength',
    );
    assert.equal(
      overflow(
        "503 litellm.ServiceUnavailableError: litellm.MidStreamFallbackError: litellm.APIConnectionError: APIConnectionError: OpenAIException - Requested token count exceeds the model's maximum context length of 131072 tokens.",
        { statusCode: 503 },
      ),
      'ContextLength',
    );
    // A bare 413 with no body is itself input-side evidence: HTTP request
    // entity too large (Cerebras returns exactly this — review round-8 P1-3).
    assert.equal(overflow('Request Entity Too Large', { statusCode: 413 }), 'ContextLength');
    assert.equal(overflow('Payload Too Large', { statusCode: 413 }), 'ContextLength');
    assert.equal(overflow('', { statusCode: 413 }), 'ContextLength');
    // A structured code embedded in free text must not be misread by a weaker
    // substring heuristic checked earlier: "generate" contains "rate", and the
    // rate/auth substring heuristics rank BELOW overflow evidence (round-7 P1-2).
    assert.equal(
      overflow('Failed to generate response: context_length_exceeded', { statusCode: 400 }),
      'ContextLength',
    );
    // Explicit numeric statuses still outrank every text heuristic: a 5xx that
    // happens to mention rate stays ProviderUnavailable.
    assert.equal(
      overflow('Please rate limit your requests', { statusCode: 503 }),
      'ProviderUnavailable',
    );
    // The weak rate heuristic is word-shaped, not a substring: "generate" and
    // "separate" are not rate limits (review round-8 P2)…
    assert.notEqual(overflow('Failed to generate response', { statusCode: 400 }), 'RateLimit');
    assert.notEqual(overflow('Unable to separate response chunks', { statusCode: 400 }), 'RateLimit');
    // …while genuine rate wording without an explicit 429 still classifies.
    assert.equal(overflow('Please rate limit your requests', {}), 'RateLimit');
    assert.equal(overflow('rate_limit_exceeded: slow down', {}), 'RateLimit');

    // Exclusion-first: throttling/rate-limit wording must NOT be read as overflow
    // even when it superficially mentions tokens.
    assert.equal(overflow('Rate limit reached: too many tokens, please wait before trying again', { statusCode: 429 }), 'RateLimit');
    assert.notEqual(overflow('ThrottlingException: too many tokens, please wait before trying again', { statusCode: 400 }), 'ContextLength');
    // Unrelated 400s stay in their own buckets, never ContextLength: a token-free
    // size limit and an output-parameter error merely mention limits/tokens, and
    // misreading either would run (and persist) a pointless compaction + retry.
    assert.notEqual(overflow('invalid request: missing required field', { statusCode: 400 }), 'ContextLength');
    assert.notEqual(overflow('file size exceeds the limit of 10485760', { statusCode: 400 }), 'ContextLength');
    assert.notEqual(overflow('max_tokens is too many tokens for this model', { statusCode: 400 }), 'ContextLength');
    // An OUTPUT token cap is not an input overflow: compacting the history
    // cannot fix it, so it must never trigger a persisted compaction retry.
    assert.notEqual(overflow('Output token limit exceeded', { statusCode: 400 }), 'ContextLength');
    assert.notEqual(overflow('Maximum output token limit exceeded', { statusCode: 400 }), 'ContextLength');
    assert.notEqual(overflow('output token count of 8192 exceeds the limit of 4096', { statusCode: 400 }), 'ContextLength');
    assert.notEqual(overflow('completion token count of 8192 exceeds the limit of 4096', { statusCode: 400 }), 'ContextLength');
    assert.notEqual(overflow('max output token count of 8192 exceeds the limit of 4096', { statusCode: 400 }), 'ContextLength');
    // A generic prefix must not smuggle an output cap past the input-subject
    // constraints ("request" in "Invalid request:" is not the token subject):
    // output caps are excluded at the exclusion-first owner, wording-wide.
    assert.notEqual(overflow('Invalid request: output token count of 8192 exceeds the limit of 4096', { statusCode: 400 }), 'ContextLength');
    assert.notEqual(overflow('Invalid request: completion token count of 8192 exceeds the limit of 4096', { statusCode: 400 }), 'ContextLength');
    assert.notEqual(overflow('Invalid request: max output token count of 8192 exceeds the limit of 4096', { statusCode: 400 }), 'ContextLength');
    assert.notEqual(overflow('Invalid request: max_tokens is too many tokens for this model', { statusCode: 400 }), 'ContextLength');
    assert.notEqual(overflow('Invalid request: Maximum output token limit exceeded', { statusCode: 400 }), 'ContextLength');
    // Complete output-cap RELATIONS are excluded even when reworded — the
    // veto is not a fixed word order.
    assert.notEqual(overflow('Invalid request: completion has too many tokens for this model', { statusCode: 400 }), 'ContextLength');
    assert.notEqual(overflow('Invalid request: max_tokens token limit exceeded', { statusCode: 400 }), 'ContextLength');
    // ...including the passive voice, where the output subject FOLLOWS the
    // token predicate (review round-7 P1-3).
    assert.notEqual(overflow('Invalid input: too many tokens were requested for the completion', { statusCode: 400 }), 'ContextLength');
    // ...and the embedded-role permutation, where the output word sits INSIDE
    // the token phrase — even when a capacity statement follows in the same
    // message (review round-8 P1-4).
    assert.notEqual(
      overflow("Too many completion tokens were requested. This endpoint's maximum context length is 262144 tokens.", { statusCode: 400 }),
      'ContextLength',
    );
    assert.notEqual(overflow('Too many output tokens requested for this model', { statusCode: 400 }), 'ContextLength');
    assert.notEqual(
      overflow("Maximum completion tokens exceeded. This endpoint's maximum context length is 262144 tokens.", { statusCode: 400 }),
      'ContextLength',
    );
    // A bare capacity STATEMENT inside an unrelated error is not an overflow
    // relation: throttle/quota wording vetoes every free-text signal — only a
    // structured provider code is unconditional (review round-7 P1-4).
    assert.notEqual(
      overflow("ThrottlingException: quota exceeded. This endpoint's maximum context length is 262144 tokens.", { statusCode: 400 }),
      'ContextLength',
    );
    // ...while the input-side form of the same wording still classifies.
    assert.equal(overflow('Input token limit exceeded: 250000 tokens > 200000 maximum', { statusCode: 400 }), 'ContextLength');
    // The output-cap exclusions stay adjacency-tight: OpenAI's classic input
    // overflow mentions the completion and max_tokens without being an output
    // cap, and must keep classifying.
    assert.equal(overflow("This model's maximum context length is 8192 tokens. However, you requested 10240 tokens (10140 in the messages, 100 in the completion). Please reduce the length of the messages or completion.", { statusCode: 400 }), 'ContextLength');
    assert.equal(overflow("This model's maximum context length is 8192 tokens. However, you requested 10240 tokens (10140 in the messages, 100 in max_tokens). Please reduce the length of the messages or completion.", { statusCode: 400 }), 'ContextLength');
    // Structured provider evidence is the ONLY unconditional signal: a genuine
    // input overflow may word its message as an output-cap relation the text
    // vetoes would reject, and the context_length_exceeded code must still win.
    assert.equal(
      overflow('Invalid request: completion has too many tokens for this model', {
        statusCode: 400,
        data: { error: { message: 'Invalid request: completion has too many tokens for this model', code: 'context_length_exceeded' } },
      }),
      'ContextLength',
    );
    assert.equal(adapter.classifyError(Object.assign(new Error('401 Authorization'), { statusCode: 401 })), 'Auth');
  });

  test('classifies overflow wording that only survives in a schema-invalid responseBody (review round-9 P2)', async () => {
    const adapter = newAdapter();
    // The REAL failed-response handler, with the OpenAI-family error schema
    // (error must be an OBJECT with a message). When the provider body does
    // not match — `{error: string}` genuinely exists among OpenAI-compatible
    // providers — the handler degrades `message` to the statusText and keeps
    // the provider's wording ONLY in `responseBody`.
    const handler = createJsonErrorResponseHandler({
      errorSchema: z.object({ error: z.object({ message: z.string() }) }),
      errorToMessage: (data) => data.error.message,
    });
    const errorFromBody = async (body: string) => (await handler({
      response: new Response(body, { status: 400, statusText: 'Bad Request' }),
      url: 'https://api.example.test/v1/chat/completions',
      requestBodyValues: {},
    })).value;

    const overflowError = await errorFromBody('{"error":"Your input exceeds the context window of this model"}');
    // Prove the degradation is real before asserting on classification.
    assert.equal(overflowError.message, 'Bad Request');
    assert.equal(overflowError.data, undefined);
    assert.equal(adapter.classifyError(overflowError), 'ContextLength');
    // The veto layer runs on the same full text: an output-cap relation in the
    // body must not classify even with a capacity statement next to it.
    const outputCapError = await errorFromBody(
      '{"error":"Too many completion tokens were requested. This endpoint\'s maximum context length is 262144 tokens."}',
    );
    assert.notEqual(adapter.classifyError(outputCapError), 'ContextLength');
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

  test('treats provider usage without token values as unavailable', () => {
    assert.equal(normalizeAiSdkUsage({
      inputTokens: undefined,
      outputTokens: undefined,
      totalTokens: undefined,
    }), undefined);
  });

  test('treats incomplete provider usage as unavailable unless total can supply the missing side', () => {
    assert.equal(normalizeAiSdkUsage({ inputTokens: 12 }), undefined);
    assert.equal(normalizeAiSdkUsage({ outputTokens: 3 }), undefined);
    assert.equal(normalizeAiSdkUsage({ totalTokens: 15 }), undefined);

    assert.deepEqual(normalizeAiSdkUsage({ inputTokens: 12, totalTokens: 15 }), {
      inputTokens: 12,
      outputTokens: 3,
      cacheHitInputTokens: 0,
      cacheMissInputTokens: 12,
      cacheMissInputSource: 'derived',
      cachedInputTokens: 0,
      cacheWriteInputTokens: 0,
      reasoningTokens: 0,
      totalTokens: 15,
    });
    assert.deepEqual(normalizeAiSdkUsage({ outputTokens: 3, totalTokens: 15 }), {
      inputTokens: 12,
      outputTokens: 3,
      cacheHitInputTokens: 0,
      cacheMissInputTokens: 12,
      cacheMissInputSource: 'derived',
      cachedInputTokens: 0,
      cacheWriteInputTokens: 0,
      reasoningTokens: 0,
      totalTokens: 15,
    });
    assert.deepEqual(normalizeAiSdkUsage({ inputTokens: 0, outputTokens: 0 }), {
      inputTokens: 0,
      outputTokens: 0,
      cacheHitInputTokens: 0,
      cacheMissInputTokens: 0,
      cacheMissInputSource: 'derived',
      cachedInputTokens: 0,
      cacheWriteInputTokens: 0,
      reasoningTokens: 0,
      totalTokens: 0,
    });
  });

  test('derives totals from detail-only AI SDK usage', () => {
    assert.deepEqual(
      normalizeAiSdkUsage({
        inputTokens: {
          total: undefined,
          noCache: 10,
          cacheRead: 5,
          cacheWrite: 2,
        },
        outputTokens: {
          total: undefined,
          text: 4,
          reasoning: 3,
        },
      }),
      {
        inputTokens: 17,
        outputTokens: 7,
        cacheHitInputTokens: 5,
        cacheMissInputTokens: 10,
        cacheMissInputSource: 'explicit',
        cachedInputTokens: 5,
        cacheWriteInputTokens: 2,
        reasoningTokens: 3,
        totalTokens: 24,
      },
    );
  });

  test('derives totals from the public AI SDK 6 detail shape', () => {
    const usage = {
      inputTokens: undefined,
      outputTokens: undefined,
      totalTokens: undefined,
      inputTokenDetails: {
        noCacheTokens: 10,
        cacheReadTokens: 5,
        cacheWriteTokens: 2,
      },
      outputTokenDetails: {
        textTokens: 4,
        reasoningTokens: 3,
      },
    } as unknown as Parameters<typeof normalizeAiSdkUsage>[0];

    assert.deepEqual(normalizeAiSdkUsage(usage), {
      inputTokens: 17,
      outputTokens: 7,
      cacheHitInputTokens: 5,
      cacheMissInputTokens: 10,
      cacheMissInputSource: 'explicit',
      cachedInputTokens: 5,
      cacheWriteInputTokens: 2,
      reasoningTokens: 3,
      totalTokens: 24,
    });
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
