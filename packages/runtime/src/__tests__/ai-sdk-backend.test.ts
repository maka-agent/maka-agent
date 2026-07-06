import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { describe, test } from 'node:test';
import type { ModelMessage } from 'ai';
import { MockLanguageModelV3, simulateReadableStream } from 'ai/test';
import type { LanguageModelV3StreamPart } from '@ai-sdk/provider';
import type { LlmConnection, SessionHeader } from '@maka/core';
import type { SessionEvent } from '@maka/core/events';
import type { RuntimeEvent } from '@maka/core/runtime-event';
import type { ToolResultMessage } from '@maka/core/session';
import type { LlmCallRecord } from '@maka/core/usage-stats/types';
import { z } from 'zod';
import {
  AiSdkBackend,
  INVALID_TOOL_NAME,
  MAX_ACTIVE_SUBAGENT_TOOLS_PER_TURN,
  TOOL_ERROR_RESULT_MAX_CHARS,
  formatSyntheticToolErrorText,
  normalizeAiSdkUsage,
  repairMakaToolCall,
  type MakaTool,
  type RunTraceEvent,
} from '../ai-sdk-backend.js';
import { LOAD_TOOLS_NAME } from '../tool-availability.js';
import { PermissionEngine } from '../permission-engine.js';
import {
  canonicalizeToolSet,
  computeRequestShapeDiagnostic,
} from '../request-shape.js';
import {
  ARCHIVED_TOOL_RESULT_PLACEHOLDER_KIND,
  ARCHIVED_TOOL_RESULT_REWRITE_VERSION,
  applyRuntimeEventContextBudget,
  buildHistoryCompactBlockFromSummary,
  type HistoryCompactBlock,
  type SynthesisCacheBlock,
} from '../context-budget.js';
import { buildRuntimeEventModelReplayPlan } from '../model-history.js';
import type { ActiveFullCompactBlock } from '../active-full-compact.js';
import type { SemanticCompactBlock } from '../semantic-compact.js';

describe('AiSdkBackend model history', () => {
  test('prefers RuntimeEvent prior messages and appends current user once', async () => {
    const model = completionModel();
    const backend = new AiSdkBackend({
      sessionId: 'session-1',
      header: header(),
      appendMessage: async () => {},
      connection: connection(),
      apiKey: 'sk-test',
      modelId: 'mock-model-id',
      permissionEngine: new PermissionEngine({ newId: () => 'permission-id', now: () => 1 }),
      modelFactory: () => model,
      tools: [],
      newId: idGenerator(),
      now: monotonicClock(),
    });

    await drain(backend.send({
      turnId: 'turn-current',
      text: 'current user',
      context: [
        { type: 'user', id: 'projection-u', turnId: 'turn-prev', ts: 1, text: 'projection user' },
        { type: 'assistant', id: 'projection-a', turnId: 'turn-prev', ts: 2, text: 'projection assistant', modelId: 'm' },
      ],
      runtimeContext: [
        runtimeTextEvent({ id: 'rt-u', turnId: 'turn-prev', role: 'user', author: 'user', text: 'runtime user' }),
        runtimeTextEvent({ id: 'rt-a', turnId: 'turn-prev', role: 'model', author: 'agent', text: 'runtime assistant' }),
        runtimeTextEvent({ id: 'rt-current', turnId: 'turn-current', role: 'user', author: 'user', text: 'current from runtime' }),
      ],
    }));

    assert.deepEqual(compactPrompt(model), [
      { role: 'user', content: [{ type: 'text', text: 'runtime user' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'runtime assistant' }] },
      { role: 'user', content: [{ type: 'text', text: 'current user' }] },
    ]);
  });

  test('uses StoredMessage projection when RuntimeEvent replay is empty', async () => {
    const model = completionModel();
    const backend = new AiSdkBackend({
      sessionId: 'session-1',
      header: header(),
      appendMessage: async () => {},
      connection: connection(),
      apiKey: 'sk-test',
      modelId: 'mock-model-id',
      permissionEngine: new PermissionEngine({ newId: () => 'permission-id', now: () => 1 }),
      modelFactory: () => model,
      tools: [],
      newId: idGenerator(),
      now: monotonicClock(),
    });

    await drain(backend.send({
      turnId: 'turn-current',
      text: 'current user',
      context: [
        { type: 'user', id: 'projection-u', turnId: 'turn-prev', ts: 1, text: 'projection user' },
        { type: 'assistant', id: 'projection-a', turnId: 'turn-prev', ts: 2, text: 'projection assistant', modelId: 'm' },
      ],
      runtimeContext: [
        {
          id: 'rt-terminal',
          invocationId: 'inv-1',
          runId: 'run-prev',
          sessionId: 'session-1',
          turnId: 'turn-prev',
          ts: 1,
          partial: false,
          role: 'model',
          author: 'agent',
          status: 'completed',
          actions: { endInvocation: true },
        },
      ],
    }));

    assert.deepEqual(compactPrompt(model), [
      { role: 'user', content: [{ type: 'text', text: 'projection user' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'projection assistant' }] },
      { role: 'user', content: [{ type: 'text', text: 'current user' }] },
    ]);
  });

  test('stored-message fallback keeps placeholder text when no reader is wired', async () => {
    const model = completionModel();
    const backend = new AiSdkBackend({
      sessionId: 'session-1',
      header: header(),
      appendMessage: async () => {},
      connection: connection(),
      apiKey: 'sk-test',
      modelId: 'mock-model-id',
      permissionEngine: new PermissionEngine({ newId: () => 'permission-id', now: () => 1 }),
      modelFactory: () => model,
      tools: [],
      newId: idGenerator(),
      now: monotonicClock(),
    });

    await drain(backend.send({
      turnId: 'turn-current',
      text: 'current user',
      context: [
        {
          type: 'user',
          id: 'projection-u',
          turnId: 'turn-prev',
          ts: 1,
          text: 'see the attached chart',
          attachments: [
            {
              kind: 'image',
              name: 'chart.png',
              mimeType: 'image/png',
              bytes: 123,
              ref: { kind: 'session_file', sessionId: 'sess-1', relativePath: 'attachments/chart.png' },
            },
          ],
        },
        { type: 'assistant', id: 'projection-a', turnId: 'turn-prev', ts: 2, text: 'projection assistant', modelId: 'm' },
      ],
      runtimeContext: [
        {
          id: 'rt-terminal',
          invocationId: 'inv-1',
          runId: 'run-prev',
          sessionId: 'session-1',
          turnId: 'turn-prev',
          ts: 1,
          partial: false,
          role: 'model',
          author: 'agent',
          status: 'completed',
          actions: { endInvocation: true },
        },
      ],
    }));

    const prompt = compactPrompt(model) as Array<{ role: string; content: unknown }>;
    const historicalUser = prompt[0];
    const parts = historicalUser.content as Array<{ type: string; text: string }>;
    const text = parts[0]?.text ?? '';
    assert.ok(text.includes('see the attached chart'), `expected user text in: ${text}`);
    assert.ok(
      text.includes('[attachment: chart.png (image/png)]'),
      `expected attachment ref preserved in stored-message fallback, got: ${text}`,
    );
  });

  test('stored-message fallback renders image attachments as image parts when a reader is wired', async () => {
    const pngBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 4, 5, 6]);
    const model = completionModel();
    const backend = new AiSdkBackend({
      sessionId: 'session-1',
      header: header(),
      appendMessage: async () => {},
      connection: connection(),
      apiKey: 'sk-test',
      modelId: 'mock-model-id',
      permissionEngine: new PermissionEngine({ newId: () => 'permission-id', now: () => 1 }),
      modelFactory: () => model,
      tools: [],
      newId: idGenerator(),
      now: monotonicClock(),
      readAttachmentBytes: async () => ({ ok: true, bytes: pngBytes }),
    } as never);

    await drain(backend.send({
      turnId: 'turn-current',
      text: 'current user',
      context: [
        {
          type: 'user',
          id: 'projection-u',
          turnId: 'turn-prev',
          ts: 1,
          text: 'see the attached chart',
          attachments: [
            {
              kind: 'image',
              name: 'chart.png',
              mimeType: 'image/png',
              bytes: 123,
              ref: { kind: 'session_file', sessionId: 'sess-1', relativePath: 'attachments/chart.png' },
            },
          ],
        },
        { type: 'assistant', id: 'projection-a', turnId: 'turn-prev', ts: 2, text: 'projection assistant', modelId: 'm' },
      ],
      runtimeContext: [
        {
          id: 'rt-terminal',
          invocationId: 'inv-1',
          runId: 'run-prev',
          sessionId: 'session-1',
          turnId: 'turn-prev',
          ts: 1,
          partial: false,
          role: 'model',
          author: 'agent',
          status: 'completed',
          actions: { endInvocation: true },
        },
      ],
    }));

    const prompt = compactPrompt(model) as Array<{ role: string; content: unknown }>;
    const historicalUser = prompt[0];
    const parts = historicalUser.content as Array<{ type: string; mediaType?: string }>;
    const imageLike = parts.find((p) => p.type !== 'text' && p.mediaType === 'image/png');
    assert.ok(imageLike, `expected a historical image/png part in stored-message fallback, got: ${JSON.stringify(parts)}`);
  });

  test('current-turn image attachment becomes a provider image part', async () => {
    const pngBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
    const model = completionModel();
    const backend = new AiSdkBackend({
      sessionId: 'session-1',
      header: header(),
      appendMessage: async () => {},
      connection: connection(),
      apiKey: 'sk-test',
      modelId: 'mock-model-id',
      permissionEngine: new PermissionEngine({ newId: () => 'permission-id', now: () => 1 }),
      modelFactory: () => model,
      tools: [],
      newId: idGenerator(),
      now: monotonicClock(),
      readAttachmentBytes: async () => ({ ok: true, bytes: pngBytes }),
    } as never);

    await drain(backend.send({
      turnId: 'turn-current',
      text: 'describe this chart',
      attachments: [
        {
          kind: 'image',
          name: 'chart.png',
          mimeType: 'image/png',
          bytes: pngBytes.length,
          ref: { kind: 'session_file', sessionId: 'session-1', relativePath: 'fake/chart.png' },
        },
      ],
      context: [],
      runtimeContext: [],
    }));

    const prompt = compactPrompt(model) as Array<{ role: string; content: unknown }>;
    const currentUser = prompt[prompt.length - 1];
    const parts = currentUser.content as Array<{ type: string; image?: unknown; mediaType?: string; text?: string; data?: unknown }>;
    // ai-sdk LanguageModelV3 normalizes CoreMessage image parts into generic
    // file parts at the provider boundary (mediaType carries image/png); the
    // image bytes must reach the provider as a non-text image/png part.
    const imageLike = parts.find((p) => p.type !== 'text' && p.mediaType === 'image/png');
    assert.ok(imageLike, `expected an image/png part in current user content, got: ${JSON.stringify(parts)}`);
  });

  test('RuntimeEvent replay renders historical image attachments as image parts', async () => {
    const pngBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 9, 8, 7]);
    const model = completionModel();
    const backend = new AiSdkBackend({
      sessionId: 'session-1',
      header: header(),
      appendMessage: async () => {},
      connection: connection(),
      apiKey: 'sk-test',
      modelId: 'mock-model-id',
      permissionEngine: new PermissionEngine({ newId: () => 'permission-id', now: () => 1 }),
      modelFactory: () => model,
      tools: [],
      newId: idGenerator(),
      now: monotonicClock(),
      readAttachmentBytes: async () => ({ ok: true, bytes: pngBytes }),
    } as never);

    await drain(backend.send({
      turnId: 'turn-current',
      text: 'follow-up question',
      context: [],
      runtimeContext: [
        runtimeEvent({
          id: 'rt-img',
          turnId: 'turn-prev',
          role: 'user',
          author: 'user',
          content: {
            kind: 'text',
            text: 'look at this chart',
            attachments: [
              {
                kind: 'image',
                name: 'pic.png',
                mimeType: 'image/png',
                bytes: 11,
                ref: { kind: 'session_file', sessionId: 'session-1', relativePath: 'fake/pic.png' },
              },
            ],
          },
        }),
        runtimeTextEvent({ id: 'rt-a', turnId: 'turn-prev', role: 'model', author: 'agent', text: 'noted' }),
      ],
    }));

    const prompt = compactPrompt(model) as Array<{ role: string; content: unknown }>;
    const historicalUser = prompt[0];
    const parts = historicalUser.content as Array<{ type: string; mediaType?: string }>;
    const imageLike = parts.find((p) => p.type !== 'text' && p.mediaType === 'image/png');
    assert.ok(imageLike, `expected a historical image/png part in replay, got: ${JSON.stringify(parts)}`);
  });

  test('preserves RuntimeEvent tool calls and results as structured AI SDK parts', async () => {
    const model = completionModel();
    const backend = new AiSdkBackend({
      sessionId: 'session-1',
      header: header(),
      appendMessage: async () => {},
      connection: connection(),
      apiKey: 'sk-test',
      modelId: 'mock-model-id',
      permissionEngine: new PermissionEngine({ newId: () => 'permission-id', now: () => 1 }),
      modelFactory: () => model,
      tools: [],
      newId: idGenerator(),
      now: monotonicClock(),
    });

    await drain(backend.send({
      turnId: 'turn-current',
      text: 'current user',
      context: [
        { type: 'user', id: 'projection-u', turnId: 'turn-prev', ts: 1, text: 'projection user' },
        { type: 'assistant', id: 'projection-a', turnId: 'turn-prev', ts: 2, text: 'projection assistant', modelId: 'm' },
      ],
      runtimeContext: [
        runtimeTextEvent({ id: 'rt-u', turnId: 'turn-prev', role: 'user', author: 'user', text: 'projection user' }),
        runtimeTextEvent({ id: 'rt-a', turnId: 'turn-prev', role: 'model', author: 'agent', text: 'projection assistant' }),
        runtimeEvent({
          id: 'rt-call',
          turnId: 'turn-prev',
          role: 'model',
          author: 'agent',
          content: { kind: 'function_call', id: 'tool-1', name: 'Read', args: { path: 'package.json' } },
        }),
        runtimeEvent({
          id: 'rt-result',
          turnId: 'turn-prev',
          role: 'tool',
          author: 'tool',
          content: { kind: 'function_response', id: 'tool-1', name: 'Read', result: 'contents', isError: false },
        }),
      ],
    }));

    assert.deepEqual(compactPrompt(model), [
      { role: 'user', content: [{ type: 'text', text: 'projection user' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'projection assistant' }] },
      {
        role: 'assistant',
        content: [{
          type: 'tool-call',
          toolCallId: 'tool-1',
          toolName: 'Read',
          input: { path: 'package.json' },
          providerExecuted: undefined,
          providerOptions: undefined,
        }],
      },
      {
        role: 'tool',
        content: [{
          type: 'tool-result',
          toolCallId: 'tool-1',
          toolName: 'Read',
          output: { type: 'text', value: 'contents' },
          providerOptions: undefined,
        }],
      },
      { role: 'user', content: [{ type: 'text', text: 'current user' }] },
    ]);
  });

  test('replays interleaved parallel RuntimeEvent tool calls as one provider tool-call block', async () => {
    const model = completionModel();
    const backend = new AiSdkBackend({
      sessionId: 'session-1',
      header: header(),
      appendMessage: async () => {},
      connection: connection(),
      apiKey: 'sk-test',
      modelId: 'mock-model-id',
      permissionEngine: new PermissionEngine({ newId: () => 'permission-id', now: () => 1 }),
      modelFactory: () => model,
      tools: [],
      newId: idGenerator(),
      now: monotonicClock(),
    });

    await drain(backend.send({
      turnId: 'turn-current',
      text: 'current user',
      context: [],
      runtimeContext: [
        runtimeTextEvent({ id: 'rt-u', turnId: 'turn-prev', role: 'user', author: 'user', text: 'inspect files' }),
        runtimeEvent({
          id: 'rt-call-0',
          turnId: 'turn-prev',
          role: 'model',
          author: 'agent',
          content: { kind: 'function_call', id: 'tool-0', name: 'Read', args: { path: 'main.cpp' } },
        }),
        runtimeEvent({
          id: 'rt-call-1',
          turnId: 'turn-prev',
          role: 'model',
          author: 'agent',
          content: { kind: 'function_call', id: 'tool-1', name: 'Read', args: { path: 'user.cpp' } },
        }),
        runtimeEvent({
          id: 'rt-result-0',
          turnId: 'turn-prev',
          role: 'tool',
          author: 'tool',
          content: { kind: 'function_response', id: 'tool-0', name: 'Read', result: 'main', isError: false },
        }),
        runtimeEvent({
          id: 'rt-call-2',
          turnId: 'turn-prev',
          role: 'model',
          author: 'agent',
          content: { kind: 'function_call', id: 'tool-2', name: 'Glob', args: { pattern: '*' } },
        }),
        runtimeEvent({
          id: 'rt-result-1',
          turnId: 'turn-prev',
          role: 'tool',
          author: 'tool',
          content: { kind: 'function_response', id: 'tool-1', name: 'Read', result: 'user', isError: false },
        }),
        runtimeEvent({
          id: 'rt-result-2',
          turnId: 'turn-prev',
          role: 'tool',
          author: 'tool',
          content: { kind: 'function_response', id: 'tool-2', name: 'Glob', result: ['main.cpp', 'user.cpp'], isError: false },
        }),
      ],
    }));

    assert.deepEqual(compactPrompt(model), [
      { role: 'user', content: [{ type: 'text', text: 'inspect files' }] },
      {
        role: 'assistant',
        content: [
          {
            type: 'tool-call',
            toolCallId: 'tool-0',
            toolName: 'Read',
            input: { path: 'main.cpp' },
            providerExecuted: undefined,
            providerOptions: undefined,
          },
          {
            type: 'tool-call',
            toolCallId: 'tool-1',
            toolName: 'Read',
            input: { path: 'user.cpp' },
            providerExecuted: undefined,
            providerOptions: undefined,
          },
          {
            type: 'tool-call',
            toolCallId: 'tool-2',
            toolName: 'Glob',
            input: { pattern: '*' },
            providerExecuted: undefined,
            providerOptions: undefined,
          },
        ],
      },
      {
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolCallId: 'tool-0',
            toolName: 'Read',
            output: { type: 'text', value: 'main' },
            providerOptions: undefined,
          },
          {
            type: 'tool-result',
            toolCallId: 'tool-1',
            toolName: 'Read',
            output: { type: 'text', value: 'user' },
            providerOptions: undefined,
          },
          {
            type: 'tool-result',
            toolCallId: 'tool-2',
            toolName: 'Glob',
            output: { type: 'json', value: ['main.cpp', 'user.cpp'] },
            providerOptions: undefined,
          },
        ],
      },
      { role: 'user', content: [{ type: 'text', text: 'current user' }] },
    ]);
  });

  test('archives stale RuntimeEvent tool results before replay placeholder rewrite', async () => {
    const model = completionModel();
    const archiveRequests: Array<{ runtimeEventId: string; serializedResult: string; bodySha256: string }> = [];
    const oldResult = { body: 'x'.repeat(500) };
    const backend = new AiSdkBackend({
      sessionId: 'session-1',
      header: header(),
      appendMessage: async () => {},
      connection: connection(),
      apiKey: 'sk-test',
      modelId: 'mock-model-id',
      permissionEngine: new PermissionEngine({ newId: () => 'permission-id', now: () => 1 }),
      modelFactory: () => model,
      tools: [],
      newId: idGenerator(),
      now: monotonicClock(),
      contextBudget: {
        name: 'archive-test',
        staleToolResultPrune: {
          enabled: true,
          maxResultEstimatedTokens: 1,
          minRecentTurnsFull: 0,
        },
        charsPerToken: 1,
      },
      archiveToolResult: async (event) => {
        archiveRequests.push({
          runtimeEventId: event.runtimeEventId,
          serializedResult: event.serializedResult,
          bodySha256: event.bodySha256,
        });
        return { artifactId: `artifact-${event.runtimeEventId}` };
      },
    });

    await drain(backend.send({
      turnId: 'turn-current',
      text: 'current user',
      context: [],
      runtimeContext: [
        runtimeEvent({
          id: 'rt-call',
          turnId: 'turn-prev',
          role: 'model',
          author: 'agent',
          content: { kind: 'function_call', id: 'tool-1', name: 'Read', args: { path: 'package.json' } },
        }),
        runtimeEvent({
          id: 'rt-result',
          turnId: 'turn-prev',
          role: 'tool',
          author: 'tool',
          content: { kind: 'function_response', id: 'tool-1', name: 'Read', result: oldResult, isError: false },
        }),
      ],
    }));

    assert.equal(archiveRequests.length, 1);
    assert.equal(archiveRequests[0]?.runtimeEventId, 'rt-result');
    assert.equal(archiveRequests[0]?.serializedResult, JSON.stringify(oldResult));
    assert.match(archiveRequests[0]?.bodySha256 ?? '', /^[a-f0-9]{64}$/);

    const prompt = JSON.stringify(compactPrompt(model));
    assert.match(prompt, /"kind":"maka\.archived_tool_result"/);
    assert.match(prompt, /"artifactId":"artifact-rt-result"/);
    assert.match(prompt, /"runtimeEventId":"rt-result"/);
    assert.equal(prompt.includes(oldResult.body), false);
  });

  test('preserves existing archive refs while adding newly archived refs', async () => {
    const model = completionModel();
    const existingResult = { body: 'EXISTING_ARCHIVE_REF_PAYLOAD'.repeat(20) };
    const newResult = { body: 'NEW_ARCHIVE_REF_PAYLOAD'.repeat(20) };
    const existingSerialized = JSON.stringify(existingResult);
    const backend = new AiSdkBackend({
      sessionId: 'session-1',
      header: header(),
      appendMessage: async () => {},
      connection: connection(),
      apiKey: 'sk-test',
      modelId: 'mock-model-id',
      permissionEngine: new PermissionEngine({ newId: () => 'permission-id', now: () => 1 }),
      modelFactory: () => model,
      tools: [],
      newId: idGenerator(),
      now: monotonicClock(),
      contextBudget: {
        name: 'existing-archive-ref-test',
        staleToolResultPrune: {
          enabled: true,
          maxResultEstimatedTokens: 1,
          minRecentTurnsFull: 0,
          archiveRefs: [{
            runtimeEventId: 'rt-result',
            toolCallId: 'tool-1',
            toolName: 'Read',
            artifactId: 'artifact-existing-rt-result',
            bodySha256: sha256(existingSerialized),
            originalEstimatedTokens: existingSerialized.length,
            originalBytes: utf8Bytes(existingSerialized),
            rewriteVersion: ARCHIVED_TOOL_RESULT_REWRITE_VERSION,
            reason: 'stale_tool_result_pruned_before_compact',
          }],
        },
        charsPerToken: 1,
      },
      archiveToolResult: async (event) =>
        event.runtimeEventId === 'rt-new-result'
          ? { artifactId: 'artifact-new-rt-result' }
          : undefined,
    });

    await drain(backend.send({
      turnId: 'turn-current',
      text: 'current user',
      context: [],
      runtimeContext: [
        runtimeEvent({
          id: 'rt-call',
          turnId: 'turn-prev',
          role: 'model',
          author: 'agent',
          content: { kind: 'function_call', id: 'tool-1', name: 'Read', args: { path: 'package.json' } },
        }),
        runtimeEvent({
          id: 'rt-result',
          turnId: 'turn-prev',
          role: 'tool',
          author: 'tool',
          content: { kind: 'function_response', id: 'tool-1', name: 'Read', result: existingResult, isError: false },
        }),
        runtimeEvent({
          id: 'rt-new-call',
          turnId: 'turn-new',
          role: 'model',
          author: 'agent',
          content: { kind: 'function_call', id: 'tool-2', name: 'Read', args: { path: 'new.txt' } },
        }),
        runtimeEvent({
          id: 'rt-new-result',
          turnId: 'turn-new',
          role: 'tool',
          author: 'tool',
          content: { kind: 'function_response', id: 'tool-2', name: 'Read', result: newResult, isError: false },
        }),
      ],
    }));

    const prompt = JSON.stringify(compactPrompt(model));
    assert.match(prompt, /"artifactId":"artifact-existing-rt-result"/);
    assert.match(prompt, /"artifactId":"artifact-new-rt-result"/);
    assert.equal(prompt.includes(existingResult.body), false);
    assert.equal(prompt.includes(newResult.body), false);
  });

  test('history search does not re-add stale full tool results after archive pruning', async () => {
    const model = completionModel();
    const events: SessionEvent[] = [];
    const oldResult = { body: 'SECRET_PAYLOAD_SHOULD_NOT_RETURN'.repeat(20) };
    const backend = new AiSdkBackend({
      sessionId: 'session-1',
      header: header(),
      appendMessage: async () => {},
      connection: connection(),
      apiKey: 'sk-test',
      modelId: 'mock-model-id',
      permissionEngine: new PermissionEngine({ newId: () => 'permission-id', now: () => 1 }),
      modelFactory: () => model,
      tools: [],
      newId: idGenerator(),
      now: monotonicClock(),
      contextBudget: {
        name: 'archive-search-test',
        maxHistoryTurns: 1,
        minRecentTurns: 0,
        staleToolResultPrune: {
          enabled: true,
          maxResultEstimatedTokens: 1,
          minRecentTurnsFull: 0,
        },
        historySearch: {
          enabled: true,
          maxResults: 1,
          around: 1,
          maxEstimatedTokens: 4096,
        },
        charsPerToken: 1,
      },
      archiveToolResult: async (event) => ({ artifactId: `artifact-${event.runtimeEventId}` }),
    });

    for await (const event of backend.send({
      turnId: 'turn-current',
      text: 'Find SECRET_PAYLOAD_SHOULD_NOT_RETURN',
      context: [],
      runtimeContext: [
        runtimeEvent({
          id: 'rt-call',
          turnId: 'turn-old',
          role: 'model',
          author: 'agent',
          content: { kind: 'function_call', id: 'tool-1', name: 'Read', args: { path: 'secret.txt' } },
        }),
        runtimeEvent({
          id: 'rt-result',
          turnId: 'turn-old',
          role: 'tool',
          author: 'tool',
          content: { kind: 'function_response', id: 'tool-1', name: 'Read', result: oldResult, isError: false },
        }),
        runtimeEvent({
          id: 'rt-new',
          turnId: 'turn-new',
          role: 'user',
          author: 'user',
          content: { kind: 'text', text: 'newer retained context' },
        }),
      ],
    })) {
      events.push(event);
    }

    const prompt = JSON.stringify(compactPrompt(model));
    assert.equal(prompt.includes(oldResult.body), false);
    const usage = events.find((event): event is Extract<SessionEvent, { type: 'token_usage' }> =>
      event.type === 'token_usage'
    );
    assert.equal(usage?.contextBudget?.archivePlaceholders, 1);
    assert.equal(usage?.contextBudget?.historySearchMatches, 0);
  });

  test('hydrates archived RuntimeEvent tool results for model replay when retrieval is enabled', async () => {
    const model = completionModel();
    const events: SessionEvent[] = [];
    let archivedBody = '';
    const oldResult = { body: 'retrieved 中文 archived payload 🙂'.repeat(3) };
    const backend = new AiSdkBackend({
      sessionId: 'session-1',
      header: header(),
      appendMessage: async () => {},
      connection: connection(),
      apiKey: 'sk-test',
      modelId: 'mock-model-id',
      permissionEngine: new PermissionEngine({ newId: () => 'permission-id', now: () => 1 }),
      modelFactory: () => model,
      tools: [],
      newId: idGenerator(),
      now: monotonicClock(),
      contextBudget: {
        name: 'archive-retrieval-test',
        staleToolResultPrune: {
          enabled: true,
          maxResultEstimatedTokens: 1,
          minRecentTurnsFull: 0,
        },
        archiveRetrieval: {
          enabled: true,
          maxResults: 1,
          maxEstimatedTokens: 1024,
          maxBytes: 1024,
        },
        charsPerToken: 1,
      },
      archiveToolResult: async (event) => {
        archivedBody = event.serializedResult;
        return { artifactId: `artifact-${event.runtimeEventId}` };
      },
      readToolResultArchive: async (event) => {
        if (event.originalBytes !== utf8Bytes(archivedBody)) {
          return { ok: false, reason: 'size_mismatch' };
        }
        return {
          ok: true,
          serializedResult: event.bodySha256 === sha256(archivedBody) ? archivedBody : 'tampered',
        };
      },
    });

    for await (const event of backend.send({
      turnId: 'turn-current',
      text: 'current user',
      context: [],
      runtimeContext: [
        runtimeEvent({
          id: 'rt-call',
          turnId: 'turn-prev',
          role: 'model',
          author: 'agent',
          content: { kind: 'function_call', id: 'tool-1', name: 'Read', args: { path: 'package.json' } },
        }),
        runtimeEvent({
          id: 'rt-result',
          turnId: 'turn-prev',
          role: 'tool',
          author: 'tool',
          content: { kind: 'function_response', id: 'tool-1', name: 'Read', result: oldResult, isError: false },
        }),
      ],
    })) {
      events.push(event);
    }

    const prompt = JSON.stringify(compactPrompt(model));
    assert.match(prompt, /retrieved 中文 archived payload/);
    assert.equal(prompt.includes('maka.archived_tool_result'), false);
    const usage = events.find((event): event is Extract<SessionEvent, { type: 'token_usage' }> =>
      event.type === 'token_usage'
    );
    assert.equal(usage?.contextBudget?.retrievedArchiveToolResults, 1);
    assert.equal(usage?.contextBudget?.archiveRetrievalFailures, 0);
  });

  test('gates archive hydration to RuntimeEvent turns selected by history search', async () => {
    const selectedResult = { body: 'PHASE7_SELECTED_SENTINEL'.repeat(20) };
    const unselectedResult = { body: 'PHASE7_UNSELECTED_SENTINEL'.repeat(20) };
    const result = await runArchiveGatedReplay({
      query: 'Find needle-a and recover its archived result',
      selectedResult,
      unselectedResult,
      selectedPath: 'needle-a.txt',
      unselectedPath: 'needle-b.txt',
    });

    assert.deepEqual(result.readRuntimeEventIds, ['rt-result-a']);
    assert.match(result.prompt, /PHASE7_SELECTED_SENTINEL/);
    assert.equal(result.prompt.includes('PHASE7_UNSELECTED_SENTINEL'), false);
    assert.equal(result.usage?.contextBudget?.archiveRetrievalMode, 'history_search_gated');
    assert.equal(result.usage?.contextBudget?.archiveRetrievalEligibleTurns, 1);
    assert.equal(result.usage?.contextBudget?.retrievedArchiveToolResults, 1);
    assert.equal(result.usage?.contextBudget?.historySearchMatches, 1);
  });

  test('gates archive hydration using searchable original tool result content', async () => {
    const selectedResult = { body: 'zzztokenbodyonly777'.repeat(20) };
    const unselectedResult = { body: 'other_payload'.repeat(20) };
    const result = await runArchiveGatedReplay({
      query: 'zzztokenbodyonly777',
      selectedResult,
      unselectedResult,
      selectedPath: 'selected.txt',
      unselectedPath: 'unselected.txt',
      selectedAfterUnselected: true,
    });

    assert.deepEqual(result.readRuntimeEventIds, ['rt-result-a']);
    assert.match(result.prompt, /zzztokenbodyonly777/);
    assert.equal(result.prompt.includes('other_payload'), false);
    assert.equal(result.usage?.contextBudget?.archiveRetrievalMode, 'history_search_gated');
    assert.equal(result.usage?.contextBudget?.retrievedArchiveToolResults, 1);
    assert.equal(result.usage?.contextBudget?.historySearchMatches, 1);
  });

  test('uses selected synthesis block instead of hydrating covered archived payload', async () => {
    const model = completionModel();
    const events: SessionEvent[] = [];
    const archivedBodies = new Map<string, string>();
    const readRuntimeEventIds: string[] = [];
    const writeInputs: Array<{ turnId: string; query: string }> = [];
    const oldResult = { body: 'RAW_SYNTHESIS_ARCHIVE_PAYLOAD'.repeat(20) };
    const serialized = JSON.stringify(oldResult);
    const block = synthesisBlock({
      queryKey: 'key-alpha',
      turnId: 'turn-alpha',
      runtimeEventId: 'rt-result-alpha',
      toolCallId: 'tool-alpha',
      artifactId: 'artifact-rt-result-alpha',
      bodySha256: sha256(serialized),
      originalEstimatedTokens: serialized.length,
      originalBytes: utf8Bytes(serialized),
    });
    const backend = new AiSdkBackend({
      sessionId: 'session-1',
      header: header(),
      appendMessage: async () => {},
      connection: connection(),
      apiKey: 'sk-test',
      modelId: 'mock-model-id',
      permissionEngine: new PermissionEngine({ newId: () => 'permission-id', now: () => 1 }),
      modelFactory: () => model,
      tools: [],
      newId: idGenerator(),
      now: monotonicClock(),
      contextBudget: {
        name: 'synthesis-cache-test',
        maxHistoryTurns: 1,
        minRecentTurns: 0,
        staleToolResultPrune: {
          enabled: true,
          maxResultEstimatedTokens: 1,
          minRecentTurnsFull: 0,
        },
        archiveRetrieval: {
          enabled: true,
          mode: 'history_search_gated',
          maxResults: 1,
          maxEstimatedTokens: 4096,
          maxBytes: 4096,
        },
        historySearch: {
          enabled: true,
          maxResults: 1,
          around: 1,
          maxEstimatedTokens: 4096,
        },
        synthesisCache: {
          enabled: true,
          mode: 'read_write',
          blocks: [block],
        },
        charsPerToken: 1,
      },
      archiveToolResult: async (event) => {
        archivedBodies.set(event.runtimeEventId, event.serializedResult);
        return { artifactId: `artifact-${event.runtimeEventId}` };
      },
      readToolResultArchive: async (event) => {
        readRuntimeEventIds.push(event.runtimeEventId);
        const body = archivedBodies.get(event.runtimeEventId);
        return body ? { ok: true, serializedResult: body } : { ok: false, reason: 'not_found' };
      },
      writeSynthesisCache: async (event) => {
        writeInputs.push({ turnId: event.turnId, query: event.source.query });
        return { blocks: [] };
      },
    });

    for await (const event of backend.send({
      turnId: 'turn-current',
      text: 'Recover key-alpha',
      context: [],
      runtimeContext: [
        runtimeEvent({
          id: 'rt-call-alpha',
          turnId: 'turn-alpha',
          role: 'model',
          author: 'agent',
          content: { kind: 'function_call', id: 'tool-alpha', name: 'Read', args: { path: 'key-alpha.txt' } },
        }),
        runtimeEvent({
          id: 'rt-result-alpha',
          turnId: 'turn-alpha',
          role: 'tool',
          author: 'tool',
          content: { kind: 'function_response', id: 'tool-alpha', name: 'Read', result: oldResult, isError: false },
        }),
        runtimeTextEvent({
          id: 'rt-new',
          turnId: 'turn-new',
          role: 'user',
          author: 'user',
          text: 'newer retained context',
        }),
      ],
    })) {
      events.push(event);
    }

    assert.deepEqual(readRuntimeEventIds, []);
    assert.deepEqual(writeInputs, []);
    const prompt = JSON.stringify(compactPrompt(model));
    assert.match(prompt, /maka_synthesis_cache_block/);
    assert.match(prompt, /SYNTHESIS_SENTINEL_KEY_ALPHA/);
    assert.equal(prompt.includes('RAW_SYNTHESIS_ARCHIVE_PAYLOAD'), false);
    const usage = events.find((event): event is Extract<SessionEvent, { type: 'token_usage' }> =>
      event.type === 'token_usage'
    );
    assert.equal(usage?.contextBudget?.synthesisCacheBlocksSelected, 1);
    assert.deepEqual(usage?.contextBudget?.synthesisCacheBlockIds, ['synth-key-alpha']);
    assert.equal(usage?.contextBudget?.retrievedArchiveToolResults, undefined);
  });

  test('loads synthesis blocks before archive retrieval', async () => {
    const model = completionModel();
    const events: SessionEvent[] = [];
    const archivedBodies = new Map<string, string>();
    const readRuntimeEventIds: string[] = [];
    const oldResult = { body: 'RAW_LOADED_SYNTHESIS_ARCHIVE_PAYLOAD'.repeat(20) };
    const serialized = JSON.stringify(oldResult);
    const block = synthesisBlock({
      queryKey: 'key-alpha',
      turnId: 'turn-alpha',
      runtimeEventId: 'rt-result-alpha',
      toolCallId: 'tool-alpha',
      artifactId: 'artifact-rt-result-alpha',
      bodySha256: sha256(serialized),
      originalEstimatedTokens: serialized.length,
      originalBytes: utf8Bytes(serialized),
    });
    let loadCalls = 0;
    const backend = new AiSdkBackend({
      sessionId: 'session-1',
      header: header(),
      appendMessage: async () => {},
      connection: connection(),
      apiKey: 'sk-test',
      modelId: 'mock-model-id',
      permissionEngine: new PermissionEngine({ newId: () => 'permission-id', now: () => 1 }),
      modelFactory: () => model,
      tools: [],
      newId: idGenerator(),
      now: monotonicClock(),
      contextBudget: {
        name: 'synthesis-cache-load-test',
        maxHistoryTurns: 1,
        minRecentTurns: 0,
        staleToolResultPrune: {
          enabled: true,
          maxResultEstimatedTokens: 1,
          minRecentTurnsFull: 0,
        },
        archiveRetrieval: {
          enabled: true,
          mode: 'history_search_gated',
          maxResults: 1,
          maxEstimatedTokens: 4096,
          maxBytes: 4096,
        },
        historySearch: {
          enabled: true,
          maxResults: 1,
          around: 1,
          maxEstimatedTokens: 4096,
        },
        synthesisCache: {
          enabled: true,
          maxBlocks: 1,
        },
        charsPerToken: 1,
      },
      archiveToolResult: async (event) => {
        archivedBodies.set(event.runtimeEventId, event.serializedResult);
        return { artifactId: `artifact-${event.runtimeEventId}` };
      },
      readToolResultArchive: async (event) => {
        readRuntimeEventIds.push(event.runtimeEventId);
        const body = archivedBodies.get(event.runtimeEventId);
        return body ? { ok: true, serializedResult: body } : { ok: false, reason: 'not_found' };
      },
      loadSynthesisCache: async () => {
        loadCalls += 1;
        return { blocks: [block] };
      },
    });

    for await (const event of backend.send({
      turnId: 'turn-current',
      text: 'Recover key-alpha',
      context: [],
      runtimeContext: [
        runtimeEvent({
          id: 'rt-call-alpha',
          turnId: 'turn-alpha',
          role: 'model',
          author: 'agent',
          content: { kind: 'function_call', id: 'tool-alpha', name: 'Read', args: { path: 'key-alpha.txt' } },
        }),
        runtimeEvent({
          id: 'rt-result-alpha',
          turnId: 'turn-alpha',
          role: 'tool',
          author: 'tool',
          content: { kind: 'function_response', id: 'tool-alpha', name: 'Read', result: oldResult, isError: false },
        }),
        runtimeTextEvent({
          id: 'rt-new',
          turnId: 'turn-new',
          role: 'user',
          author: 'user',
          text: 'newer retained context',
        }),
      ],
    })) {
      events.push(event);
    }

    assert.equal(loadCalls, 1);
    assert.deepEqual(readRuntimeEventIds, []);
    const prompt = JSON.stringify(compactPrompt(model));
    assert.match(prompt, /maka_synthesis_cache_block/);
    assert.equal(prompt.includes('RAW_LOADED_SYNTHESIS_ARCHIVE_PAYLOAD'), false);
    const usage = events.find((event): event is Extract<SessionEvent, { type: 'token_usage' }> =>
      event.type === 'token_usage'
    );
    assert.equal(usage?.contextBudget?.synthesisCacheBlocksLoaded, 1);
    assert.equal(usage?.contextBudget?.synthesisCacheBlocksSelected, 1);
  });

  test('writes synthesis cache after successful gated archive retrieval without injecting it into the same request', async () => {
    const model = completionModel();
    const events: SessionEvent[] = [];
    const archivedBodies = new Map<string, string>();
    const writeInputs: Array<{ sourceRefCount: number; hydratedHasRaw: boolean }> = [];
    const oldResult = { body: 'RAW_WRITE_SYNTHESIS_ARCHIVE_PAYLOAD'.repeat(20), key: 'key-alpha' };
    const serialized = JSON.stringify(oldResult);
    const writtenBlock = synthesisBlock({
      queryKey: 'key-alpha',
      turnId: 'turn-alpha',
      runtimeEventId: 'rt-result-alpha',
      toolCallId: 'tool-alpha',
      artifactId: 'artifact-rt-result-alpha',
      bodySha256: sha256(serialized),
      originalEstimatedTokens: serialized.length,
      originalBytes: utf8Bytes(serialized),
    });
    const backend = new AiSdkBackend({
      sessionId: 'session-1',
      header: header(),
      appendMessage: async () => {},
      connection: connection(),
      apiKey: 'sk-test',
      modelId: 'mock-model-id',
      permissionEngine: new PermissionEngine({ newId: () => 'permission-id', now: () => 1 }),
      modelFactory: () => model,
      tools: [],
      newId: idGenerator(),
      now: monotonicClock(),
      contextBudget: {
        name: 'synthesis-cache-write-test',
        maxHistoryTurns: 1,
        minRecentTurns: 0,
        staleToolResultPrune: {
          enabled: true,
          maxResultEstimatedTokens: 1,
          minRecentTurnsFull: 0,
        },
        archiveRetrieval: {
          enabled: true,
          mode: 'history_search_gated',
          maxResults: 1,
          maxEstimatedTokens: 4096,
          maxBytes: 4096,
        },
        historySearch: {
          enabled: true,
          maxResults: 1,
          around: 1,
          maxEstimatedTokens: 4096,
        },
        synthesisCache: {
          enabled: true,
          mode: 'read_write',
          maxBlocks: 1,
        },
        charsPerToken: 1,
      },
      archiveToolResult: async (event) => {
        archivedBodies.set(event.runtimeEventId, event.serializedResult);
        return { artifactId: `artifact-${event.runtimeEventId}` };
      },
      readToolResultArchive: async (event) => {
        const body = archivedBodies.get(event.runtimeEventId);
        return body ? { ok: true, serializedResult: body } : { ok: false, reason: 'not_found' };
      },
      writeSynthesisCache: async (input) => {
        writeInputs.push({
          sourceRefCount: input.source.retrievedArchiveRefs.length,
          hydratedHasRaw: JSON.stringify(input.source.hydratedRuntimeEvents).includes('RAW_WRITE_SYNTHESIS_ARCHIVE_PAYLOAD'),
        });
        return { blocks: [writtenBlock] };
      },
    });

    for await (const event of backend.send({
      turnId: 'turn-current',
      text: 'Recover key-alpha',
      context: [],
      runtimeContext: [
        runtimeEvent({
          id: 'rt-call-alpha',
          turnId: 'turn-alpha',
          role: 'model',
          author: 'agent',
          content: { kind: 'function_call', id: 'tool-alpha', name: 'Read', args: { path: 'key-alpha.txt' } },
        }),
        runtimeEvent({
          id: 'rt-result-alpha',
          turnId: 'turn-alpha',
          role: 'tool',
          author: 'tool',
          content: { kind: 'function_response', id: 'tool-alpha', name: 'Read', result: oldResult, isError: false },
        }),
        runtimeTextEvent({
          id: 'rt-new',
          turnId: 'turn-new',
          role: 'user',
          author: 'user',
          text: 'newer retained context',
        }),
      ],
    })) {
      events.push(event);
    }

    assert.deepEqual(writeInputs, [{ sourceRefCount: 1, hydratedHasRaw: true }]);
    const prompt = JSON.stringify(compactPrompt(model));
    assert.match(prompt, /RAW_WRITE_SYNTHESIS_ARCHIVE_PAYLOAD/);
    assert.equal(prompt.includes('SYNTHESIS_SENTINEL_KEY_ALPHA'), false);
    const usage = events.find((event): event is Extract<SessionEvent, { type: 'token_usage' }> =>
      event.type === 'token_usage'
    );
    assert.equal(usage?.contextBudget?.synthesisCacheWritesAttempted, 1);
    assert.equal(usage?.contextBudget?.synthesisCacheBlocksWritten, 1);
    assert.deepEqual(usage?.contextBudget?.synthesisCacheWrittenBlockIds, ['synth-key-alpha']);
  });

  test('falls back to gated archive retrieval when synthesis request asks for evidence', async () => {
    const model = completionModel();
    const events: SessionEvent[] = [];
    const archivedBodies = new Map<string, string>();
    const readRuntimeEventIds: string[] = [];
    const writeInputs: Array<{ turnId: string; query: string }> = [];
    const oldResult = { body: 'RAW_SYNTHESIS_ARCHIVE_PAYLOAD'.repeat(20) };
    const serialized = JSON.stringify(oldResult);
    const block = synthesisBlock({
      queryKey: 'key-alpha',
      turnId: 'turn-alpha',
      runtimeEventId: 'rt-result-alpha',
      toolCallId: 'tool-alpha',
      artifactId: 'artifact-rt-result-alpha',
      bodySha256: sha256(serialized),
      originalEstimatedTokens: serialized.length,
      originalBytes: utf8Bytes(serialized),
    });
    const backend = new AiSdkBackend({
      sessionId: 'session-1',
      header: header(),
      appendMessage: async () => {},
      connection: connection(),
      apiKey: 'sk-test',
      modelId: 'mock-model-id',
      permissionEngine: new PermissionEngine({ newId: () => 'permission-id', now: () => 1 }),
      modelFactory: () => model,
      tools: [],
      newId: idGenerator(),
      now: monotonicClock(),
      contextBudget: {
        name: 'synthesis-cache-raw-test',
        maxHistoryTurns: 1,
        minRecentTurns: 0,
        staleToolResultPrune: {
          enabled: true,
          maxResultEstimatedTokens: 1,
          minRecentTurnsFull: 0,
        },
        archiveRetrieval: {
          enabled: true,
          mode: 'history_search_gated',
          maxResults: 1,
          maxEstimatedTokens: 4096,
          maxBytes: 4096,
        },
        historySearch: {
          enabled: true,
          maxResults: 1,
          around: 1,
          maxEstimatedTokens: 4096,
        },
        synthesisCache: {
          enabled: true,
          mode: 'read_write',
          blocks: [block],
        },
        charsPerToken: 1,
      },
      archiveToolResult: async (event) => {
        archivedBodies.set(event.runtimeEventId, event.serializedResult);
        return { artifactId: `artifact-${event.runtimeEventId}` };
      },
      readToolResultArchive: async (event) => {
        readRuntimeEventIds.push(event.runtimeEventId);
        const body = archivedBodies.get(event.runtimeEventId);
        return body ? { ok: true, serializedResult: body } : { ok: false, reason: 'not_found' };
      },
      writeSynthesisCache: async (event) => {
        writeInputs.push({ turnId: event.turnId, query: event.source.query });
        return { blocks: [] };
      },
    });

    for await (const event of backend.send({
      turnId: 'turn-current',
      text: 'Show raw evidence for key-alpha',
      context: [],
      runtimeContext: [
        runtimeEvent({
          id: 'rt-call-alpha',
          turnId: 'turn-alpha',
          role: 'model',
          author: 'agent',
          content: { kind: 'function_call', id: 'tool-alpha', name: 'Read', args: { path: 'key-alpha.txt' } },
        }),
        runtimeEvent({
          id: 'rt-result-alpha',
          turnId: 'turn-alpha',
          role: 'tool',
          author: 'tool',
          content: { kind: 'function_response', id: 'tool-alpha', name: 'Read', result: oldResult, isError: false },
        }),
        runtimeTextEvent({
          id: 'rt-new',
          turnId: 'turn-new',
          role: 'user',
          author: 'user',
          text: 'newer retained context',
        }),
      ],
    })) {
      events.push(event);
    }

    assert.deepEqual(readRuntimeEventIds, ['rt-result-alpha']);
    assert.deepEqual(writeInputs, []);
    const prompt = JSON.stringify(compactPrompt(model));
    assert.match(prompt, /RAW_SYNTHESIS_ARCHIVE_PAYLOAD/);
    assert.equal(prompt.includes('maka_synthesis_cache_block'), false);
    const usage = events.find((event): event is Extract<SessionEvent, { type: 'token_usage' }> =>
      event.type === 'token_usage'
    );
    assert.equal(usage?.contextBudget?.synthesisCacheBlocksSelected, 0);
    assert.deepEqual(usage?.contextBudget?.synthesisCacheSkippedReasonCounts, {
      raw_evidence_requested: 1,
    });
    assert.equal(usage?.contextBudget?.retrievedArchiveToolResults, 1);
    assert.equal(usage?.contextBudget?.synthesisCacheWriteSkipped, 1);
    assert.deepEqual(usage?.contextBudget?.synthesisCacheWriteSkippedReasonCounts, {
      raw_evidence_requested: 1,
    });
  });

  test('manual compactHistory writes shared history compact artifacts and returns diagnostics', async () => {
    const writeInputs: Array<{ turnId: string; foldedIds: string[] }> = [];
    const oldEvents = [
      runtimeTextEvent({
        id: 'manual-compact-old-1',
        turnId: 'turn-old-1',
        role: 'user',
        author: 'user',
        text: 'manual alpha compact source '.repeat(12),
      }),
      runtimeTextEvent({
        id: 'manual-compact-old-2',
        turnId: 'turn-old-2',
        role: 'model',
        author: 'agent',
        text: 'manual beta compact source '.repeat(12),
      }),
    ];
    const backend = new AiSdkBackend({
      sessionId: 'session-1',
      header: header(),
      appendMessage: async () => {},
      connection: connection(),
      apiKey: 'sk-test',
      modelId: 'mock-model-id',
      permissionEngine: new PermissionEngine({ newId: () => 'permission-id', now: () => 1 }),
      modelFactory: () => completionModel(),
      tools: [],
      newId: idGenerator(),
      now: monotonicClock(),
      contextBudget: {
        name: 'manual-compact-test',
        maxHistoryEstimatedTokens: 10_000,
        minRecentTurns: 1,
        charsPerToken: 1,
      },
      writeHistoryCompact: async (input) => {
        writeInputs.push({
          turnId: input.turnId,
          foldedIds: input.source.foldedRuntimeEvents.map((event) => event.id),
        });
        return {
          blocks: [buildHistoryCompactBlockFromSummary({
            sessionId: input.sessionId,
            foldedRuntimeEvents: input.source.foldedRuntimeEvents,
            summary: 'MANUAL_HISTORY_COMPACT_SENTINEL',
            highWaterName: input.source.draftBlock.highWaterName,
            highWaterSeq: input.source.draftBlock.highWaterSeq,
            charsPerToken: input.limits.charsPerToken,
          })],
        };
      },
    });

    const result = await backend.compactHistory({
      turnId: 'turn-compact',
      runtimeContext: [
        ...oldEvents,
        runtimeTextEvent({
          id: 'manual-compact-recent',
          turnId: 'turn-recent',
          role: 'user',
          author: 'user',
          text: 'manual recent retained context',
        }),
      ],
    });

    assert.deepEqual(writeInputs, [{
      turnId: 'turn-compact',
      foldedIds: ['manual-compact-old-1', 'manual-compact-old-2'],
    }]);
    assert.equal(result.contextBudget?.historyCompactWritesAttempted, 1);
    assert.equal(result.contextBudget?.historyCompactBlocksWritten, 1);
    assert.equal(result.contextBudget?.compactionDecisions?.[0]?.decision, 'replaced');
    assert.equal(result.contextBudget?.compactionDecisions?.[0]?.boundaryKind, 'historyCompact');
  });

  test('manual compactHistory writes the current fold instead of reusing a loaded prefix block', async () => {
    const covered = [
      runtimeTextEvent({
        id: 'manual-prefix-old-1',
        turnId: 'turn-old-1',
        role: 'user',
        author: 'user',
        text: 'manual prefix alpha '.repeat(12),
      }),
      runtimeTextEvent({
        id: 'manual-prefix-old-2',
        turnId: 'turn-old-2',
        role: 'model',
        author: 'agent',
        text: 'manual prefix beta '.repeat(12),
      }),
    ];
    const loadedBlock = buildHistoryCompactBlockFromSummary({
      sessionId: 'session-1',
      foldedRuntimeEvents: covered,
      summary: 'OLD_MANUAL_HISTORY_COMPACT_SENTINEL',
      highWaterName: 'loaded-manual-compact',
      highWaterSeq: 1,
      charsPerToken: 1,
    });
    let loadCalls = 0;
    const writeInputs: string[][] = [];
    const backend = new AiSdkBackend({
      sessionId: 'session-1',
      header: header(),
      appendMessage: async () => {},
      connection: connection(),
      apiKey: 'sk-test',
      modelId: 'mock-model-id',
      permissionEngine: new PermissionEngine({ newId: () => 'permission-id', now: () => 1 }),
      modelFactory: () => completionModel(),
      tools: [],
      newId: idGenerator(),
      now: monotonicClock(),
      contextBudget: {
        name: 'manual-compact-test',
        maxHistoryEstimatedTokens: 10_000,
        minRecentTurns: 1,
        charsPerToken: 1,
      },
      loadHistoryCompact: async () => {
        loadCalls += 1;
        return { blocks: [loadedBlock] };
      },
      writeHistoryCompact: async (input) => {
        writeInputs.push(input.source.foldedRuntimeEvents.map((event) => event.id));
        return {
          blocks: [buildHistoryCompactBlockFromSummary({
            sessionId: input.sessionId,
            foldedRuntimeEvents: input.source.foldedRuntimeEvents,
            summary: 'NEW_MANUAL_HISTORY_COMPACT_SENTINEL',
            highWaterName: input.source.draftBlock.highWaterName,
            highWaterSeq: input.source.draftBlock.highWaterSeq,
            charsPerToken: input.limits.charsPerToken,
          })],
        };
      },
    });

    await backend.compactHistory({
      turnId: 'turn-compact',
      runtimeContext: [
        ...covered,
        runtimeTextEvent({
          id: 'manual-prefix-former-tail',
          turnId: 'turn-former-tail',
          role: 'user',
          author: 'user',
          text: 'manual former retained tail now foldable '.repeat(8),
        }),
        runtimeTextEvent({
          id: 'manual-prefix-recent',
          turnId: 'turn-recent',
          role: 'model',
          author: 'agent',
          text: 'manual recent retained context',
        }),
      ],
    });

    assert.equal(loadCalls, 0);
    assert.deepEqual(writeInputs, [[
      'manual-prefix-old-1',
      'manual-prefix-old-2',
      'manual-prefix-former-tail',
    ]]);
  });

  test('manual compactHistory is a no-op when context budget is disabled', async () => {
    let writes = 0;
    const backend = new AiSdkBackend({
      sessionId: 'session-1',
      header: header(),
      appendMessage: async () => {},
      connection: connection(),
      apiKey: 'sk-test',
      modelId: 'mock-model-id',
      permissionEngine: new PermissionEngine({ newId: () => 'permission-id', now: () => 1 }),
      modelFactory: () => completionModel(),
      tools: [],
      newId: idGenerator(),
      now: monotonicClock(),
      writeHistoryCompact: async () => {
        writes += 1;
        return { blocks: [] };
      },
    });

    const result = await backend.compactHistory({
      turnId: 'turn-compact',
      runtimeContext: [
        runtimeTextEvent({ id: 'old-1', turnId: 'turn-old-1', role: 'user', author: 'user', text: 'old alpha '.repeat(20) }),
        runtimeTextEvent({ id: 'old-2', turnId: 'turn-old-2', role: 'model', author: 'agent', text: 'old beta '.repeat(20) }),
      ],
    });

    assert.deepEqual(result, {});
    assert.equal(writes, 0);
  });

  test('manual compactHistory is a no-op when no durable writer is configured', async () => {
    const backend = new AiSdkBackend({
      sessionId: 'session-1',
      header: header(),
      appendMessage: async () => {},
      connection: connection(),
      apiKey: 'sk-test',
      modelId: 'mock-model-id',
      permissionEngine: new PermissionEngine({ newId: () => 'permission-id', now: () => 1 }),
      modelFactory: () => completionModel(),
      tools: [],
      newId: idGenerator(),
      now: monotonicClock(),
      contextBudget: {
        name: 'manual-compact-test',
        maxHistoryEstimatedTokens: 10_000,
        minRecentTurns: 1,
        charsPerToken: 1,
      },
    });

    const result = await backend.compactHistory({
      turnId: 'turn-compact',
      runtimeContext: [
        runtimeTextEvent({ id: 'old-1', turnId: 'turn-old-1', role: 'user', author: 'user', text: 'old alpha '.repeat(20) }),
        runtimeTextEvent({ id: 'old-2', turnId: 'turn-old-2', role: 'model', author: 'agent', text: 'old beta '.repeat(20) }),
      ],
    });

    assert.deepEqual(result, {});
  });

  test('manual compactHistory does not report replaced when durable write fails', async () => {
    const oldEvents = [
      runtimeTextEvent({
        id: 'manual-compact-old-1',
        turnId: 'turn-old-1',
        role: 'user',
        author: 'user',
        text: 'manual alpha compact source '.repeat(12),
      }),
      runtimeTextEvent({
        id: 'manual-compact-old-2',
        turnId: 'turn-old-2',
        role: 'model',
        author: 'agent',
        text: 'manual beta compact source '.repeat(12),
      }),
      runtimeTextEvent({
        id: 'manual-compact-recent',
        turnId: 'turn-recent',
        role: 'user',
        author: 'user',
        text: 'manual recent retained context',
      }),
    ];
    const backend = new AiSdkBackend({
      sessionId: 'session-1',
      header: header(),
      appendMessage: async () => {},
      connection: connection(),
      apiKey: 'sk-test',
      modelId: 'mock-model-id',
      permissionEngine: new PermissionEngine({ newId: () => 'permission-id', now: () => 1 }),
      modelFactory: () => completionModel(),
      tools: [],
      newId: idGenerator(),
      now: monotonicClock(),
      contextBudget: {
        name: 'manual-compact-test',
        maxHistoryEstimatedTokens: 10_000,
        minRecentTurns: 1,
        charsPerToken: 1,
      },
      writeHistoryCompact: async () => {
        throw new Error('artifact write failed');
      },
    });

    const result = await backend.compactHistory({
      turnId: 'turn-compact',
      runtimeContext: oldEvents,
    });

    assert.equal(result.contextBudget?.historyCompactWriteFailures, 1);
    assert.equal(result.contextBudget?.historyCompactBlockIds, undefined);
    assert.equal(result.contextBudget?.historyCompactBlocksSelected, undefined);
    assert.equal(result.contextBudget?.historyCompactedEvents, undefined);
    assert.equal(result.contextBudget?.highWaterReason, undefined);
    assert.deepEqual(
      result.contextBudget?.compactionDecisions?.map((decision) => decision.decision),
      ['failedOpen'],
    );
    assert.equal(result.contextBudget?.compactionDecisions?.[0]?.failOpenReason, 'write_failed');
  });

  test('stopping manual compactHistory does not poison the next backend turn', async () => {
    const writeGate = makeGate();
    let writeStarted: (() => void) | undefined;
    let writeAbortSignal: AbortSignal | undefined;
    const writeStartedPromise = new Promise<void>((resolve) => {
      writeStarted = resolve;
    });
    const backend = new AiSdkBackend({
      sessionId: 'session-1',
      header: header(),
      appendMessage: async () => {},
      connection: connection(),
      apiKey: 'sk-test',
      modelId: 'mock-model-id',
      permissionEngine: new PermissionEngine({ newId: () => 'permission-id', now: () => 1 }),
      modelFactory: () => textCompletionModel('NEXT_OK'),
      tools: [],
      newId: idGenerator(),
      now: monotonicClock(),
      contextBudget: {
        name: 'manual-compact-test',
        maxHistoryEstimatedTokens: 10_000,
        minRecentTurns: 1,
        charsPerToken: 1,
      },
      writeHistoryCompact: async (input) => {
        writeAbortSignal = input.abortSignal;
        writeStarted?.();
        await writeGate.promise;
        return {
          blocks: [buildHistoryCompactBlockFromSummary({
            sessionId: input.sessionId,
            foldedRuntimeEvents: input.source.foldedRuntimeEvents,
            summary: 'MANUAL_HISTORY_COMPACT_SENTINEL',
            highWaterName: input.source.draftBlock.highWaterName,
            highWaterSeq: input.source.draftBlock.highWaterSeq,
            charsPerToken: input.limits.charsPerToken,
          })],
        };
      },
    });

    const compactPromise = backend.compactHistory({
      turnId: 'turn-compact',
      runtimeContext: [
        runtimeTextEvent({ id: 'old-1', turnId: 'turn-old-1', role: 'user', author: 'user', text: 'old alpha '.repeat(20) }),
        runtimeTextEvent({ id: 'old-2', turnId: 'turn-old-2', role: 'model', author: 'agent', text: 'old beta '.repeat(20) }),
        runtimeTextEvent({ id: 'recent', turnId: 'turn-recent', role: 'user', author: 'user', text: 'recent' }),
      ],
    });
    await writeStartedPromise;
    assert.equal(writeAbortSignal?.aborted, false);
    await backend.stop('user_stop');
    assert.equal(writeAbortSignal?.aborted, true);
    writeGate.release();
    await compactPromise;

    const events: SessionEvent[] = [];
    for await (const event of backend.send({ turnId: 'turn-next', text: 'next', context: [] })) {
      events.push(event);
    }

    assert.equal(events.some((event) => event.type === 'text_delta' && event.text === 'NEXT_OK'), true);
  });

  test('stopped manual compactHistory stays suppressed when the next send starts before the writer returns', async () => {
    const writeGate = makeGate();
    let writeStarted: (() => void) | undefined;
    const writeStartedPromise = new Promise<void>((resolve) => {
      writeStarted = resolve;
    });
    const backend = new AiSdkBackend({
      sessionId: 'session-1',
      header: header(),
      appendMessage: async () => {},
      connection: connection(),
      apiKey: 'sk-test',
      modelId: 'mock-model-id',
      permissionEngine: new PermissionEngine({ newId: () => 'permission-id', now: () => 1 }),
      modelFactory: () => textCompletionModel('NEXT_OK'),
      tools: [],
      newId: idGenerator(),
      now: monotonicClock(),
      contextBudget: {
        name: 'manual-compact-test',
        maxHistoryEstimatedTokens: 10_000,
        minRecentTurns: 1,
        charsPerToken: 1,
      },
      writeHistoryCompact: async (input) => {
        writeStarted?.();
        await writeGate.promise;
        return {
          blocks: [buildHistoryCompactBlockFromSummary({
            sessionId: input.sessionId,
            foldedRuntimeEvents: input.source.foldedRuntimeEvents,
            summary: 'MANUAL_HISTORY_COMPACT_SENTINEL',
            highWaterName: input.source.draftBlock.highWaterName,
            highWaterSeq: input.source.draftBlock.highWaterSeq,
            charsPerToken: input.limits.charsPerToken,
          })],
        };
      },
    });

    const compactPromise = backend.compactHistory({
      turnId: 'turn-compact',
      runtimeContext: [
        runtimeTextEvent({ id: 'old-1', turnId: 'turn-old-1', role: 'user', author: 'user', text: 'old alpha '.repeat(20) }),
        runtimeTextEvent({ id: 'old-2', turnId: 'turn-old-2', role: 'model', author: 'agent', text: 'old beta '.repeat(20) }),
        runtimeTextEvent({ id: 'recent', turnId: 'turn-recent', role: 'user', author: 'user', text: 'recent' }),
      ],
    });
    await writeStartedPromise;
    await backend.stop('user_stop');

    const sendEventsPromise = (async () => {
      const events: SessionEvent[] = [];
      for await (const event of backend.send({ turnId: 'turn-next', text: 'next', context: [] })) {
        events.push(event);
      }
      return events;
    })();
    writeGate.release();

    const [compactResult, events] = await Promise.all([compactPromise, sendEventsPromise]);
    assert.equal(compactResult.contextBudget, undefined);
    assert.equal(events.some((event) => event.type === 'text_delta' && event.text === 'NEXT_OK'), true);
  });

  test('stopping after manual compactHistory returns does not poison the next backend turn', async () => {
    const backend = new AiSdkBackend({
      sessionId: 'session-1',
      header: header(),
      appendMessage: async () => {},
      connection: connection(),
      apiKey: 'sk-test',
      modelId: 'mock-model-id',
      permissionEngine: new PermissionEngine({ newId: () => 'permission-id', now: () => 1 }),
      modelFactory: () => textCompletionModel('NEXT_OK'),
      tools: [],
      newId: idGenerator(),
      now: monotonicClock(),
      contextBudget: {
        name: 'manual-compact-test',
        maxHistoryEstimatedTokens: 10_000,
        minRecentTurns: 1,
        charsPerToken: 1,
      },
      writeHistoryCompact: async (input) => ({
        blocks: [buildHistoryCompactBlockFromSummary({
          sessionId: input.sessionId,
          foldedRuntimeEvents: input.source.foldedRuntimeEvents,
          summary: 'MANUAL_HISTORY_COMPACT_SENTINEL',
          highWaterName: input.source.draftBlock.highWaterName,
          highWaterSeq: input.source.draftBlock.highWaterSeq,
          charsPerToken: input.limits.charsPerToken,
        })],
      }),
    });

    await backend.compactHistory({
      turnId: 'turn-compact',
      runtimeContext: [
        runtimeTextEvent({ id: 'old-1', turnId: 'turn-old-1', role: 'user', author: 'user', text: 'old alpha '.repeat(20) }),
        runtimeTextEvent({ id: 'old-2', turnId: 'turn-old-2', role: 'model', author: 'agent', text: 'old beta '.repeat(20) }),
        runtimeTextEvent({ id: 'recent', turnId: 'turn-recent', role: 'user', author: 'user', text: 'recent' }),
      ],
    });
    await backend.stop('user_stop');

    const events: SessionEvent[] = [];
    for await (const event of backend.send({ turnId: 'turn-next', text: 'next', context: [] })) {
      events.push(event);
    }

    assert.equal(events.some((event) => event.type === 'text_delta' && event.text === 'NEXT_OK'), true);
  });

  test('aborting the model stream mid-flight routes to the abort path instead of false success', async () => {
    const gate = makeGate();
    let streamReachedGate = false;
    const model = new MockLanguageModelV3({
      doStream: {
        stream: new ReadableStream<LanguageModelV3StreamPart>({
          async start(controller) {
            controller.enqueue({ type: 'stream-start', warnings: [] });
            controller.enqueue({ type: 'text-start', id: 'text-1' });
            controller.enqueue({ type: 'text-delta', id: 'text-1', delta: 'PARTIAL' });
            controller.enqueue({ type: 'text-end', id: 'text-1' });
            streamReachedGate = true;
            // Hold the stream open so stop() can flip this.aborted before the
            // finish chunk arrives. The mock ignores the abort signal on
            // purpose, simulating a provider that keeps yielding after abort.
            await gate.promise;
            controller.enqueue({
              type: 'finish',
              finishReason: { unified: 'stop', raw: 'stop' },
              usage: {
                inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
                outputTokens: { total: 1, text: 1, reasoning: 0 },
              },
            });
            controller.close();
          },
        }),
      },
    });
    const appended: string[] = [];
    const backend = new AiSdkBackend({
      sessionId: 'session-1',
      header: header(),
      appendMessage: async (message) => {
        appended.push(message.type);
      },
      connection: connection(),
      apiKey: 'sk-test',
      modelId: 'mock-model-id',
      permissionEngine: new PermissionEngine({ newId: () => 'permission-id', now: () => 1 }),
      modelFactory: () => model,
      tools: [],
      newId: idGenerator(),
      now: monotonicClock(),
    });
    const events: SessionEvent[] = [];
    const sendPromise = (async () => {
      for await (const event of backend.send({ turnId: 'turn-1', text: 'hi', context: [] })) {
        events.push(event);
      }
    })();
    await waitFor(() => streamReachedGate);
    await backend.stop('user_stop');
    gate.release();
    await sendPromise;

    // No partial assistant turn or usage should be persisted after a stop.
    assert.equal(appended.includes('assistant'), false);
    assert.equal(appended.includes('token_usage'), false);
    // The turn must close as a user_stop, not a false end_turn success.
    assert.equal(events.some((event) => event.type === 'abort' && event.reason === 'user_stop'), true);
    const completes = events.filter((event) => event.type === 'complete');
    assert.equal(completes.length > 0, true);
    assert.equal(
      completes.every((event) => (event as { stopReason?: string }).stopReason === 'user_stop'),
      true,
    );
  });

  test('writes host history compact block and replays the host summary in the same request', async () => {
    const model = completionModel();
    const events: SessionEvent[] = [];
    const writeInputs: Array<{ draftSummary: string; foldedIds: string[] }> = [];
    const oldEvents = [
      runtimeTextEvent({
        id: 'compact-old-1',
        turnId: 'turn-old-1',
        role: 'user',
        author: 'user',
        text: 'alpha compact source '.repeat(12),
      }),
      runtimeTextEvent({
        id: 'compact-old-2',
        turnId: 'turn-old-2',
        role: 'model',
        author: 'agent',
        text: 'beta compact source '.repeat(12),
      }),
    ];
    const backend = new AiSdkBackend({
      sessionId: 'session-1',
      header: header(),
      appendMessage: async () => {},
      connection: connection(),
      apiKey: 'sk-test',
      modelId: 'mock-model-id',
      permissionEngine: new PermissionEngine({ newId: () => 'permission-id', now: () => 1 }),
      modelFactory: () => model,
      tools: [],
      newId: idGenerator(),
      now: monotonicClock(),
      contextBudget: {
        name: 'history-compact-write-test',
        maxHistoryEstimatedTokens: 220,
        minRecentTurns: 1,
        charsPerToken: 1,
        historyCompact: {
          enabled: true,
          mode: 'read_write',
          highWaterRatio: 0.5,
          targetRatio: 0.2,
          minRecentTurns: 1,
          maxSummaryEstimatedTokens: 120,
        },
      },
      writeHistoryCompact: async (input) => {
        writeInputs.push({
          draftSummary: input.source.draftBlock.summary,
          foldedIds: input.source.foldedRuntimeEvents.map((event) => event.id),
        });
        return {
          blocks: [buildHistoryCompactBlockFromSummary({
            sessionId: input.sessionId,
            foldedRuntimeEvents: input.source.foldedRuntimeEvents,
            summary: 'HOST_HISTORY_COMPACT_SENTINEL',
            highWaterName: input.source.draftBlock.highWaterName,
            highWaterSeq: input.source.draftBlock.highWaterSeq,
            charsPerToken: input.limits.charsPerToken,
          })],
        };
      },
    });

    for await (const event of backend.send({
      turnId: 'turn-current',
      text: 'continue after compact',
      context: [],
      runtimeContext: [
        ...oldEvents,
        runtimeTextEvent({
          id: 'compact-recent',
          turnId: 'turn-recent',
          role: 'user',
          author: 'user',
          text: 'recent retained context',
        }),
      ],
    })) {
      events.push(event);
    }

    assert.deepEqual(writeInputs.map((input) => input.foldedIds), [['compact-old-1', 'compact-old-2']]);
    assert.match(writeInputs[0]?.draftSummary ?? '', /Compacted 2 older turns/);
    const prompt = JSON.stringify(compactPrompt(model));
    assert.match(prompt, /HOST_HISTORY_COMPACT_SENTINEL/);
    assert.equal(prompt.includes('alpha compact source'), false);
    assert.match(prompt, /recent retained context/);
    const usage = events.find((event): event is Extract<SessionEvent, { type: 'token_usage' }> =>
      event.type === 'token_usage'
    );
    assert.equal(usage?.contextBudget?.historyCompactWritesAttempted, 1);
    assert.equal(usage?.contextBudget?.historyCompactBlocksWritten, 1);
    assert.equal(usage?.contextBudget?.highWaterReason, 'history_compact');
    assert.deepEqual(
      usage?.contextBudget?.compactionDecisions?.[0]?.boundaryIds,
      usage?.contextBudget?.historyCompactWrittenBlockIds,
    );
    assert.equal(usage?.contextBudget?.compactionDecisions?.[0]?.decision, 'replaced');
    assert.equal(usage?.contextBudget?.compactionDecisions?.[0]?.boundaryKind, 'historyCompact');
  });

  test('read_write history compact fail-open sends original history when durable write fails', async () => {
    const model = completionModel();
    const events: SessionEvent[] = [];
    const oldEvents = [
      runtimeTextEvent({
        id: 'compact-fail-old-1',
        turnId: 'turn-old-1',
        role: 'user',
        author: 'user',
        text: 'fail alpha compact source '.repeat(12),
      }),
      runtimeTextEvent({
        id: 'compact-fail-old-2',
        turnId: 'turn-old-2',
        role: 'model',
        author: 'agent',
        text: 'fail beta compact source '.repeat(12),
      }),
    ];
    const backend = new AiSdkBackend({
      sessionId: 'session-1',
      header: header(),
      appendMessage: async () => {},
      connection: connection(),
      apiKey: 'sk-test',
      modelId: 'mock-model-id',
      permissionEngine: new PermissionEngine({ newId: () => 'permission-id', now: () => 1 }),
      modelFactory: () => model,
      tools: [],
      newId: idGenerator(),
      now: monotonicClock(),
      contextBudget: {
        name: 'history-compact-write-failure-test',
        maxHistoryEstimatedTokens: 220,
        minRecentTurns: 1,
        charsPerToken: 1,
        historyCompact: {
          enabled: true,
          mode: 'read_write',
          highWaterRatio: 0.5,
          targetRatio: 0.2,
          minRecentTurns: 1,
          maxSummaryEstimatedTokens: 120,
        },
      },
      writeHistoryCompact: async () => {
        throw new Error('artifact write failed');
      },
    });

    for await (const event of backend.send({
      turnId: 'turn-current',
      text: 'continue after compact write failure',
      context: [],
      runtimeContext: [
        ...oldEvents,
        runtimeTextEvent({
          id: 'compact-fail-recent',
          turnId: 'turn-recent',
          role: 'user',
          author: 'user',
          text: 'fail recent retained context',
        }),
      ],
    })) {
      events.push(event);
    }

    const prompt = JSON.stringify(compactPrompt(model));
    assert.match(prompt, /fail alpha compact source/);
    assert.match(prompt, /fail beta compact source/);
    assert.equal(prompt.includes('Compacted 2 older turns'), false);
    assert.match(prompt, /fail recent retained context/);
    const usage = events.find((event): event is Extract<SessionEvent, { type: 'token_usage' }> =>
      event.type === 'token_usage'
    );
    assert.equal(usage?.contextBudget?.historyCompactWriteFailures, 1);
    assert.equal(usage?.contextBudget?.historyCompactBlockIds, undefined);
    assert.equal(usage?.contextBudget?.historyCompactedEvents, undefined);
    assert.deepEqual(
      usage?.contextBudget?.compactionDecisions?.map((decision) => decision.decision),
      ['failedOpen'],
    );
  });

  test('loads persisted history compact blocks before replay and does not rewrite them', async () => {
    const model = completionModel();
    const events: SessionEvent[] = [];
    const oldEvents = [
      runtimeTextEvent({
        id: 'compact-load-old-1',
        turnId: 'turn-old-1',
        role: 'user',
        author: 'user',
        text: 'load alpha compact source '.repeat(12),
      }),
      runtimeTextEvent({
        id: 'compact-load-old-2',
        turnId: 'turn-old-2',
        role: 'model',
        author: 'agent',
        text: 'load beta compact source '.repeat(12),
      }),
    ];
    const loadedBlock = buildHistoryCompactBlockFromSummary({
      sessionId: 'session-1',
      foldedRuntimeEvents: oldEvents,
      summary: 'LOADED_HISTORY_COMPACT_SENTINEL',
      highWaterName: 'loaded-history-compact',
      highWaterSeq: 2,
      charsPerToken: 1,
    });
    let loadCalls = 0;
    let writeCalls = 0;
    const backend = new AiSdkBackend({
      sessionId: 'session-1',
      header: header(),
      appendMessage: async () => {},
      connection: connection(),
      apiKey: 'sk-test',
      modelId: 'mock-model-id',
      permissionEngine: new PermissionEngine({ newId: () => 'permission-id', now: () => 1 }),
      modelFactory: () => model,
      tools: [],
      newId: idGenerator(),
      now: monotonicClock(),
      contextBudget: {
        name: 'history-compact-load-test',
        maxHistoryEstimatedTokens: 10_000,
        minRecentTurns: 1,
        charsPerToken: 1,
        historyCompact: {
          enabled: true,
          mode: 'read_write',
          highWaterRatio: 0.000001,
          targetRatio: 0.2,
          tailEstimatedTokens: 1,
          minRecentTurns: 1,
          maxBlocks: 1,
          maxEstimatedTokens: 4096,
        },
      },
      loadHistoryCompact: async () => {
        loadCalls += 1;
        return { blocks: [loadedBlock] };
      },
      writeHistoryCompact: async () => {
        writeCalls += 1;
        return { blocks: [] };
      },
    });

    for await (const event of backend.send({
      turnId: 'turn-current',
      text: 'continue after loaded compact',
      context: [],
      runtimeContext: [
        ...oldEvents,
        runtimeTextEvent({
          id: 'compact-load-recent',
          turnId: 'turn-recent',
          role: 'user',
          author: 'user',
          text: 'loaded recent retained context',
        }),
      ],
    })) {
      events.push(event);
    }

    assert.equal(loadCalls, 1);
    assert.equal(writeCalls, 0);
    const prompt = JSON.stringify(compactPrompt(model));
    assert.match(prompt, /LOADED_HISTORY_COMPACT_SENTINEL/);
    assert.equal(prompt.includes('load alpha compact source'), false);
    assert.match(prompt, /loaded recent retained context/);
    const usage = events.find((event): event is Extract<SessionEvent, { type: 'token_usage' }> =>
      event.type === 'token_usage'
    );
    assert.equal(usage?.contextBudget?.historyCompactBlocksLoaded, 1);
    assert.equal(usage?.contextBudget?.historyCompactBlocksSelected, 1);
    assert.equal(usage?.contextBudget?.historyCompactWritesAttempted, undefined);
  });

  test('uses StoredMessage projection when RuntimeEvent tool results are unmatched', async () => {
    const model = completionModel();
    const backend = new AiSdkBackend({
      sessionId: 'session-1',
      header: header(),
      appendMessage: async () => {},
      connection: connection(),
      apiKey: 'sk-test',
      modelId: 'mock-model-id',
      permissionEngine: new PermissionEngine({ newId: () => 'permission-id', now: () => 1 }),
      modelFactory: () => model,
      tools: [],
      newId: idGenerator(),
      now: monotonicClock(),
    });

    await drain(backend.send({
      turnId: 'turn-current',
      text: 'current user',
      context: [
        { type: 'user', id: 'projection-u', turnId: 'turn-prev', ts: 1, text: 'projection user' },
        { type: 'assistant', id: 'projection-a', turnId: 'turn-prev', ts: 2, text: 'projection assistant', modelId: 'm' },
      ],
      runtimeContext: [
        runtimeTextEvent({ id: 'rt-u', turnId: 'turn-prev', role: 'user', author: 'user', text: 'runtime user' }),
        runtimeEvent({
          id: 'rt-unmatched-result',
          turnId: 'turn-prev',
          role: 'tool',
          author: 'tool',
          content: { kind: 'function_response', id: 'missing-call', name: 'Read', result: 'contents', isError: false },
        }),
      ],
    }));

    assert.deepEqual(compactPrompt(model), [
      { role: 'user', content: [{ type: 'text', text: 'projection user' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'projection assistant' }] },
      { role: 'user', content: [{ type: 'text', text: 'current user' }] },
    ]);
  });

  test('uses StoredMessage projection when RuntimeEvent replay has unsupported content', async () => {
    const model = completionModel();
    const backend = new AiSdkBackend({
      sessionId: 'session-1',
      header: header(),
      appendMessage: async () => {},
      connection: connection(),
      apiKey: 'sk-test',
      modelId: 'mock-model-id',
      permissionEngine: new PermissionEngine({ newId: () => 'permission-id', now: () => 1 }),
      modelFactory: () => model,
      tools: [],
      newId: idGenerator(),
      now: monotonicClock(),
    });

    await drain(backend.send({
      turnId: 'turn-current',
      text: 'current user',
      context: [
        { type: 'user', id: 'projection-u', turnId: 'turn-prev', ts: 1, text: 'projection user' },
        { type: 'assistant', id: 'projection-a', turnId: 'turn-prev', ts: 2, text: 'projection assistant', modelId: 'm' },
      ],
      runtimeContext: [
        runtimeTextEvent({ id: 'rt-u', turnId: 'turn-prev', role: 'user', author: 'user', text: 'runtime user' }),
        runtimeEvent({
          id: 'rt-error',
          turnId: 'turn-prev',
          role: 'system',
          author: 'system',
          content: { kind: 'error', reason: 'tool_failed', message: 'Tool failed' },
        }),
      ],
    }));

    assert.deepEqual(compactPrompt(model), [
      { role: 'user', content: [{ type: 'text', text: 'projection user' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'projection assistant' }] },
      { role: 'user', content: [{ type: 'text', text: 'current user' }] },
    ]);
  });

  test('uses StoredMessage projection instead of leaking unsupported thinking text', async () => {
    const model = completionModel();
    const openAiConnection = { ...connection(), providerType: 'openai' as const };
    const backend = new AiSdkBackend({
      sessionId: 'session-1',
      header: header(),
      appendMessage: async () => {},
      connection: openAiConnection,
      apiKey: 'sk-test',
      modelId: 'mock-model-id',
      permissionEngine: new PermissionEngine({ newId: () => 'permission-id', now: () => 1 }),
      modelFactory: () => model,
      tools: [],
      newId: idGenerator(),
      now: monotonicClock(),
    });

    await drain(backend.send({
      turnId: 'turn-current',
      text: 'current user',
      context: [
        { type: 'user', id: 'projection-u', turnId: 'turn-prev', ts: 1, text: 'projection user' },
        { type: 'assistant', id: 'projection-a', turnId: 'turn-prev', ts: 2, text: 'projection assistant', modelId: 'm' },
      ],
      runtimeContext: [
        runtimeTextEvent({ id: 'rt-u', turnId: 'turn-prev', role: 'user', author: 'user', text: 'projection user' }),
        runtimeEvent({
          id: 'rt-thinking',
          turnId: 'turn-prev',
          role: 'model',
          author: 'agent',
          content: { kind: 'thinking', text: 'private chain of thought', signature: 'sig-1' },
        }),
        runtimeTextEvent({ id: 'rt-a', turnId: 'turn-prev', role: 'model', author: 'agent', text: 'projection assistant' }),
      ],
    }));

    const promptJson = JSON.stringify(compactPrompt(model));
    assert.deepEqual(compactPrompt(model), [
      { role: 'user', content: [{ type: 'text', text: 'projection user' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'projection assistant' }] },
      { role: 'user', content: [{ type: 'text', text: 'current user' }] },
    ]);
    assert.equal(promptJson.includes('private chain of thought'), false);
  });
});

describe('AiSdkBackend error surfaces', () => {
  test('generalizes model setup errors before emitting renderer events', async () => {
    const backend = new AiSdkBackend({
      sessionId: 'session-1',
      header: header(),
      appendMessage: async () => {},
      connection: connection(),
      apiKey: 'sk-live-secret-token-value',
      modelId: 'claude-sonnet-4-5-20250929',
      permissionEngine: new PermissionEngine({ newId: () => 'permission-id', now: () => 1 }),
      modelFactory: () => {
        throw new Error('401 Authorization: Bearer sk-live-secret-token-value');
      },
      tools: [],
      newId: idGenerator(),
      now: () => 1,
    });

    const events: SessionEvent[] = [];
    for await (const event of backend.send({ turnId: 'turn-1', text: 'hi', context: [] })) {
      events.push(event);
    }

    const error = events.find((event): event is Extract<SessionEvent, { type: 'error' }> => event.type === 'error');
    assert.equal(error?.message, 'Authentication failed');
    assert.equal(JSON.stringify(events).includes('sk-live-secret-token-value'), false);
  });

  test('redacts and caps synthetic tool error text before storage and model return', () => {
    const raw = `provider exploded: Authorization: Bearer sk-live-secret-token-value ${'x'.repeat(5000)}`;
    const text = formatSyntheticToolErrorText(new Error(raw));

    assert.equal(text.includes('sk-live-secret-token-value'), false);
    assert.ok(text.includes('[redacted]'));
    assert.equal(text.length, TOOL_ERROR_RESULT_MAX_CHARS);
    assert.equal(text.endsWith('…'), true);
  });

  test('writeSyntheticToolResult never persists raw secret-shaped errors', async () => {
    const messages: ToolResultMessage[] = [];
    const events: SessionEvent[] = [];
    const backend = new AiSdkBackend({
      sessionId: 'session-1',
      header: header(),
      appendMessage: async (message) => {
        if (message.type === 'tool_result') messages.push(message);
      },
      connection: connection(),
      apiKey: 'sk-test',
      modelId: 'claude-sonnet-4-5-20250929',
      permissionEngine: new PermissionEngine({ newId: () => 'permission-id', now: () => 1 }),
      modelFactory: () => ({}),
      tools: [],
      newId: idGenerator(),
      now: () => 1,
    });

    await (backend as unknown as {
      writeSyntheticToolResult(
        toolUseId: string,
        turnId: string,
        text: string,
        queue: { push(event: SessionEvent): void },
      ): Promise<void>;
    }).writeSyntheticToolResult(
      'tool-1',
      'turn-1',
      'failed with api_key=sk-live-secret-token-value',
      { push: (event) => events.push(event) },
    );

    assert.equal(JSON.stringify(messages).includes('sk-live-secret-token-value'), false);
    assert.equal(JSON.stringify(events).includes('sk-live-secret-token-value'), false);
    assert.deepEqual(messages[0]?.content, events.find((event) => event.type === 'tool_result')?.content);
  });

  test('failed Bash results preserve terminal stdout and stderr as an error card', async () => {
    const messages: ToolResultMessage[] = [];
    const events: SessionEvent[] = [];
    const backend = new AiSdkBackend({
      sessionId: 'session-1',
      header: header(),
      appendMessage: async (message) => {
        if (message.type === 'tool_result') messages.push(message);
      },
      connection: connection(),
      apiKey: 'sk-test',
      modelId: 'claude-sonnet-4-5-20250929',
      permissionEngine: new PermissionEngine({ newId: () => 'permission-id', now: () => 1 }),
      modelFactory: () => ({}),
      tools: [],
      newId: idGenerator(),
      now: () => 1,
    });
    const tool: MakaTool = {
      name: 'Bash',
      description: 'shell',
      parameters: {},
      permissionRequired: false,
      impl: async () => {
        throw Object.assign(new Error('Command failed with exit code 2'), {
          code: 2,
          stdout: 'stdout before failure\nAuthorization: Bearer sk-live-secret-token-value',
          stderr: 'stderr before failure',
        });
      },
    };

    const execute = (backend as unknown as {
      wrapToolExecute(
        tool: MakaTool,
        turnId: string,
        queue: { push(event: SessionEvent): void },
      ): (args: unknown, ctx: { toolCallId: string; abortSignal: AbortSignal }) => Promise<unknown>;
    }).wrapToolExecute(tool, 'turn-1', { push: (event) => events.push(event) });

    const result = await execute(
      { command: 'printf out; printf err >&2; exit 2' },
      { toolCallId: 'tool-1', abortSignal: new AbortController().signal },
    );

    // In-turn result now folds in a redacted, bounded tail of stderr/stdout so
    // the model can see *why* the command failed (the full structured content
    // still goes to session history, asserted below).
    assert.deepEqual(result, {
      error: [
        '命令退出码 2',
        '--- stderr ---\nstderr before failure',
        '--- stdout ---\nstdout before failure\nAuthorization: Bearer [redacted]',
      ].join('\n\n'),
    });
    assert.equal(messages[0]?.isError, true);
    assert.deepEqual(messages[0]?.content, events.find((event) => event.type === 'tool_result')?.content);
    assert.deepEqual(messages[0]?.content, {
      kind: 'terminal',
      cwd: '/tmp/maka',
      cmd: 'printf out; printf err >&2; exit 2',
      exitCode: 2,
      stdout: 'stdout before failure\nAuthorization: Bearer [redacted]',
      stderr: 'stderr before failure',
    });
  });

  test('model stream timeout errors carry a stable reason for turn-history UI', () => {
    const backend = new AiSdkBackend({
      sessionId: 'session-1',
      header: header(),
      appendMessage: async () => {},
      connection: connection(),
      apiKey: 'sk-test',
      modelId: 'claude-sonnet-4-5-20250929',
      permissionEngine: new PermissionEngine({ newId: () => 'permission-id', now: () => 1 }),
      modelFactory: () => ({}),
      tools: [],
      newId: idGenerator(),
      now: () => 1,
    });

    const event = (backend as unknown as {
      makeErrorEvent(turnId: string, err: unknown): Extract<SessionEvent, { type: 'error' }>;
    }).makeErrorEvent('turn-1', new Error('Model stream idle timeout after 120000ms'));

    assert.equal(event.message, 'Request timed out');
    assert.equal(event.reason, 'timeout');
  });
});

describe('AiSdkBackend stop', () => {
  test('rejects parked permission requests for the active turn', async () => {
    const permissionEngine = new PermissionEngine({ newId: () => 'permission-id', now: () => 1 });
    permissionEngine.beginTurn('turn-1');
    const verdict = permissionEngine.evaluate({
      sessionId: 'session-1',
      turnId: 'turn-1',
      toolUseId: 'tool-1',
      toolName: 'Write',
      args: { path: 'notes.md', content: 'hello' },
      mode: 'ask',
    });
    assert.equal(verdict.kind, 'prompt');
    assert.equal(permissionEngine.pendingCount('turn-1'), 1);
    const parked = verdict.kind === 'prompt'
      ? verdict.parked.then(
          () => 'resolved',
          (error: Error) => error.message,
        )
      : Promise.resolve('not-prompt');
    const backend = new AiSdkBackend({
      sessionId: 'session-1',
      header: header(),
      appendMessage: async () => {},
      connection: connection(),
      apiKey: 'sk-test',
      modelId: 'claude-sonnet-4-5-20250929',
      permissionEngine,
      modelFactory: () => ({}),
      tools: [],
      newId: idGenerator(),
      now: () => 1,
    });

    (backend as unknown as { currentTurnId: string }).currentTurnId = 'turn-1';
    await backend.stop('user_stop');

    assert.match(await parked, /Turn turn-1 aborted before permission request permission-id was answered/);
    assert.equal(permissionEngine.pendingCount('turn-1'), 0);
  });
});

describe('AiSdkBackend usage telemetry', () => {
  test('normalizes standard LanguageModelUsage detail token fields', () => {
    const usage = normalizeAiSdkUsage({
      inputTokens: 100,
      outputTokens: 20,
      inputTokenDetails: {
        cacheReadTokens: 30,
        cacheWriteTokens: 10,
      },
      outputTokenDetails: {
        reasoningTokens: 5,
      },
    });

    assert.deepEqual(usage, {
      inputTokens: 100,
      outputTokens: 20,
      cacheHitInputTokens: 30,
      cacheMissInputTokens: 60,
      cacheMissInputSource: 'derived',
      cachedInputTokens: 30,
      cacheWriteInputTokens: 10,
      reasoningTokens: 5,
      totalTokens: 120,
    });
  });

  test('records aggregate totalUsage across AI SDK tool-loop steps', async () => {
    const messages: unknown[] = [];
    const events: SessionEvent[] = [];
    const llmRecords: LlmCallRecord[] = [];
    let streamCalls = 0;
    const model = new MockLanguageModelV3({
      doStream: async () => {
        streamCalls += 1;
        const chunks: LanguageModelV3StreamPart[] = streamCalls === 1
          ? [
              { type: 'stream-start', warnings: [] },
              {
                type: 'tool-call',
                toolCallId: 'tool-1',
                toolName: 'Read',
                input: JSON.stringify({ path: 'notes.md' }),
              },
              {
                type: 'finish',
                finishReason: { unified: 'tool-calls', raw: 'tool_calls' },
                usage: {
                  inputTokens: {
                    total: 100,
                    noCache: 70,
                    cacheRead: 20,
                    cacheWrite: 10,
                  },
                  outputTokens: {
                    total: 5,
                    text: 5,
                    reasoning: 0,
                  },
                },
              },
            ]
          : [
              { type: 'stream-start', warnings: [] },
              { type: 'text-start', id: 'text-1' },
              { type: 'text-delta', id: 'text-1', delta: 'done' },
              { type: 'text-end', id: 'text-1' },
              {
                type: 'finish',
                finishReason: { unified: 'stop', raw: 'stop' },
                usage: {
                  inputTokens: {
                    total: 200,
                    noCache: 100,
                    cacheRead: 80,
                    cacheWrite: 20,
                  },
                  outputTokens: {
                    total: 7,
                    text: 5,
                    reasoning: 2,
                  },
                },
              },
            ];
        return {
          stream: simulateReadableStream({
            chunks,
            initialDelayInMs: null,
            chunkDelayInMs: null,
          }),
        };
      },
    });
    const backend = new AiSdkBackend({
      sessionId: 'session-1',
      header: header(),
      appendMessage: async (message) => {
        messages.push(message);
      },
      connection: connection(),
      apiKey: 'sk-test',
      modelId: 'mock-model-id',
      permissionEngine: new PermissionEngine({ newId: () => 'permission-id', now: () => 1 }),
      modelFactory: () => model,
      tools: [testTool('Read', z.object({ path: z.string() }))],
      newId: idGenerator(),
      now: monotonicClock(),
      recordLlmCall: (record) => {
        llmRecords.push(record);
      },
    });

    for await (const event of backend.send({ turnId: 'turn-1', text: 'hi', context: [] })) {
      events.push(event);
    }

    const usageMessage = messages.find((message) =>
      (message as { type?: string }).type === 'token_usage'
    ) as {
      input?: number;
      output?: number;
      cacheHitInput?: number;
      cacheMissInput?: number;
      cacheMissInputSource?: string;
      cacheWriteInput?: number;
      cacheRead?: number;
      cacheCreation?: number;
      reasoning?: number;
      total?: number;
      rawFinishReason?: string;
    } | undefined;
    const usageEvent = events.find((event) => event.type === 'token_usage') as
      | Extract<SessionEvent, { type: 'token_usage' }>
      | undefined;

    assert.equal(streamCalls, 2);
    assert.equal(usageMessage?.input, 300);
    assert.equal(usageMessage?.output, 12);
    assert.equal(usageMessage?.cacheHitInput, 100);
    assert.equal(usageMessage?.cacheMissInput, 170);
    assert.equal(usageMessage?.cacheMissInputSource, 'explicit');
    assert.equal(usageMessage?.cacheWriteInput, 30);
    assert.equal(usageMessage?.cacheRead, 100);
    assert.equal(usageMessage?.cacheCreation, 30);
    assert.equal(usageMessage?.reasoning, 2);
    assert.equal(usageMessage?.total, 312);
    assert.equal(usageMessage?.rawFinishReason, 'stop');
    assert.equal(usageEvent?.input, 300);
    assert.equal(llmRecords[0]?.inputTokens, 300);
    assert.equal(llmRecords[0]?.outputTokens, 12);
    assert.equal(llmRecords[0]?.cacheHitInputTokens, 100);
    assert.equal(llmRecords[0]?.cacheMissInputTokens, 170);
    assert.equal(llmRecords[0]?.cacheWriteInputTokens, 30);
    assert.equal(llmRecords[0]?.reasoningTokens, 2);
    assert.equal(llmRecords[0]?.totalTokens, 312);
    assert.equal(llmRecords[0]?.rawFinishReason, 'stop');
  });

  test('records active tool-result prune diagnostics in usage telemetry', async () => {
    const messages: unknown[] = [];
    const events: SessionEvent[] = [];
    const llmRecords: LlmCallRecord[] = [];
    const largeBody = 'SECRET_PAYLOAD_SHOULD_BE_ARCHIVED'.repeat(200);
    let streamCalls = 0;
    const model = new MockLanguageModelV3({
      doStream: async () => {
        streamCalls += 1;
        const chunks: LanguageModelV3StreamPart[] = streamCalls === 1
          ? [
              { type: 'stream-start', warnings: [] },
              {
                type: 'tool-call',
                toolCallId: 'tool-1',
                toolName: 'Read',
                input: JSON.stringify({ path: 'notes.md' }),
              },
              {
                type: 'finish',
                finishReason: { unified: 'tool-calls', raw: 'tool_calls' },
                usage: { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } },
              },
            ]
          : [
              { type: 'stream-start', warnings: [] },
              { type: 'finish', finishReason: { unified: 'stop', raw: 'stop' }, usage: { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } } },
            ];
        return { stream: simulateReadableStream({ chunks, initialDelayInMs: null, chunkDelayInMs: null }) };
      },
    });
    const backend = new AiSdkBackend({
      sessionId: 'session-1',
      header: header(),
      appendMessage: async (message) => {
        messages.push(message);
      },
      connection: connection(),
      apiKey: 'sk-test',
      modelId: 'mock-model-id',
      permissionEngine: new PermissionEngine({ newId: () => 'permission-id', now: () => 1 }),
      modelFactory: () => model,
      tools: [{
        name: 'Read',
        description: 'Read description',
        parameters: z.object({ path: z.string() }),
        permissionRequired: false,
        impl: async () => ({ body: largeBody }),
      }],
      contextBudget: {
        activeToolResultPrune: { enabled: true, maxCurrentResultEstimatedTokens: 1 },
      },
      archiveToolResult: async () => ({ artifactId: 'artifact-tool-1' }),
      newId: idGenerator(),
      now: monotonicClock(),
      recordLlmCall: (record) => {
        llmRecords.push(record);
      },
    });

    for await (const event of backend.send({ turnId: 'turn-1', text: 'hi', context: [] })) {
      events.push(event);
    }

    const usageMessage = messages.find((message) =>
      (message as { type?: string }).type === 'token_usage'
    ) as { contextBudget?: Record<string, unknown> } | undefined;
    const usageEvent = events.find((event) => event.type === 'token_usage') as
      | (Extract<SessionEvent, { type: 'token_usage' }> & { contextBudget?: Record<string, unknown> })
      | undefined;
    const recordContextBudget = llmRecords[0]?.contextBudget as Record<string, unknown> | undefined;
    assert.equal(streamCalls, 2);
    for (const contextBudget of [usageMessage?.contextBudget, usageEvent?.contextBudget, recordContextBudget]) {
      assert.equal(contextBudget?.activePrunedToolResults, 1);
      assert.equal(contextBudget?.activeArchiveFailures, undefined);
      assert.ok((contextBudget?.activeEstimatedTokensSaved as number | undefined ?? 0) > 0);
    }
  });

  test('active full compact replaces the next step prompt after active tool-result prune', async () => {
    const messages: unknown[] = [];
    const events: SessionEvent[] = [];
    const llmRecords: LlmCallRecord[] = [];
    const recordedBlocks: ActiveFullCompactBlock[] = [];
    const largeBody = 'ACTIVE_FULL_COMPACT_RAW_TOOL_OUTPUT'.repeat(200);
    let streamCalls = 0;
    let secondProviderRequestSawRecordedBlock = false;
    const model = new MockLanguageModelV3({
      doStream: async () => {
        streamCalls += 1;
        if (streamCalls === 2) {
          secondProviderRequestSawRecordedBlock = recordedBlocks.length === 1;
        }
        const chunks: LanguageModelV3StreamPart[] = streamCalls === 1
          ? [
              { type: 'stream-start', warnings: [] },
              {
                type: 'tool-call',
                toolCallId: 'tool-1',
                toolName: 'Read',
                input: JSON.stringify({ path: 'notes.md' }),
              },
              {
                type: 'finish',
                finishReason: { unified: 'tool-calls', raw: 'tool_calls' },
                usage: { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } },
              },
            ]
          : [
              { type: 'stream-start', warnings: [] },
              { type: 'finish', finishReason: { unified: 'stop', raw: 'stop' }, usage: { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } } },
            ];
        return { stream: simulateReadableStream({ chunks, initialDelayInMs: null, chunkDelayInMs: null }) };
      },
    });
    const backend = new AiSdkBackend({
      sessionId: 'session-1',
      header: header(),
      appendMessage: async (message) => {
        messages.push(message);
      },
      connection: connection(),
      apiKey: 'sk-test',
      modelId: 'mock-model-id',
      permissionEngine: new PermissionEngine({ newId: () => 'permission-id', now: () => 1 }),
      modelFactory: () => model,
      tools: [{
        name: 'Read',
        description: 'Read description',
        parameters: z.object({ path: z.string() }),
        permissionRequired: false,
        impl: async () => ({ body: largeBody }),
      }],
      contextBudget: {
        charsPerToken: 1,
        activeToolResultPrune: { enabled: true, maxCurrentResultEstimatedTokens: 1 },
        activeFullCompact: {
          enabled: true,
          minStepNumber: 1,
          minRecentMessages: 0,
          maxActiveEstimatedTokens: 1,
          highWaterRatio: 0.1,
          maxSummaryEstimatedTokens: 512,
        },
      },
      archiveToolResult: async () => ({ artifactId: 'artifact-tool-1' }),
      newId: idGenerator(),
      now: monotonicClock(),
      recordLlmCall: (record) => {
        llmRecords.push(record);
      },
      recordActiveFullCompactBlock: (block) => {
        recordedBlocks.push(block);
      },
    });

    for await (const event of backend.send({ turnId: 'turn-1', text: 'hi', context: [] })) {
      events.push(event);
    }
    await Promise.resolve();

    assert.equal(streamCalls, 2);
    assert.equal(recordedBlocks.length, 1);
    assert.equal(secondProviderRequestSawRecordedBlock, true);
    assert.equal(recordedBlocks[0]?.kind, 'maka.active_full_compact_block');
    assert.equal(recordedBlocks[0]?.turnId, 'turn-1');
    assert.equal((recordedBlocks[0]?.sourceRefs.length ?? 0) > 0, true);
    assert.match(JSON.stringify(recordedBlocks[0]), /artifact-tool-1/);
    const secondPromptMessages = model.doStreamCalls[1]?.prompt ?? [];
    const secondPrompt = JSON.stringify(model.doStreamCalls[1]?.prompt.map((message) => ({
      role: message.role,
      content: message.content,
    })));
    assert.match(secondPrompt, /maka_active_full_compact_block/);
    assert.equal(secondPromptMessages.some((message) =>
      message.role === 'user' && JSON.stringify(message.content).includes('maka_active_full_compact_block')
    ), true);
    assert.equal(secondPromptMessages.some((message) =>
      message.role === 'system' && JSON.stringify(message.content).includes('maka_active_full_compact_block')
    ), false);
    assert.match(secondPrompt, /artifact-tool-1/);
    assert.equal(secondPrompt.includes('ACTIVE_FULL_COMPACT_RAW_TOOL_OUTPUT'), false);
    assert.doesNotMatch(secondPrompt, /providerSourceIds=/);
    assert.doesNotMatch(secondPrompt, /bodySha256=/);
    assert.doesNotMatch(secondPrompt, /source\(kind=/);

    const usageMessage = messages.find((message) =>
      (message as { type?: string }).type === 'token_usage'
    ) as { contextBudget?: Record<string, unknown> } | undefined;
    const usageEvent = events.find((event) => event.type === 'token_usage') as
      | (Extract<SessionEvent, { type: 'token_usage' }> & { contextBudget?: Record<string, unknown> })
      | undefined;
    const recordContextBudget = llmRecords[0]?.contextBudget as Record<string, unknown> | undefined;
    for (const contextBudget of [usageMessage?.contextBudget, usageEvent?.contextBudget, recordContextBudget]) {
      assert.equal(contextBudget?.activePrunedToolResults, 1);
      const decisions = contextBudget?.compactionDecisions as Array<Record<string, unknown>> | undefined;
      assert.equal(decisions?.some((decision) =>
        decision.boundaryKind === 'activeFullCompact' && decision.decision === 'replaced'
      ), true);
      assert.equal(typeof contextBudget?.highWaterRequestShapeHashBefore, 'string');
      assert.equal(typeof contextBudget?.highWaterRequestShapeHashAfter, 'string');
      assert.notEqual(
        contextBudget?.highWaterRequestShapeHashAfter,
        contextBudget?.highWaterRequestShapeHashBefore,
      );
    }
  });

  test('active full compact durable recorder is invoked synchronously', () => {
    const recordedBlocks: ActiveFullCompactBlock[] = [];
    const backend = new AiSdkBackend({
      sessionId: 'session-1',
      header: header(),
      appendMessage: async () => {},
      connection: connection(),
      apiKey: 'sk-test',
      modelId: 'mock-model-id',
      permissionEngine: new PermissionEngine({ newId: () => 'permission-id', now: () => 1 }),
      modelFactory: () => completionModel(),
      tools: [],
      newId: idGenerator(),
      now: monotonicClock(),
      recordActiveFullCompactBlock: (block) => {
        recordedBlocks.push(block);
      },
    });
    (backend as unknown as {
      recordActiveFullCompactBlock(block: ActiveFullCompactBlock): void;
    }).recordActiveFullCompactBlock(activeFullCompactBlockFixture());

    assert.equal(recordedBlocks.length, 1);
    assert.equal(recordedBlocks[0]?.blockId, 'afcompact-sync-test');
  });

  test('semantic compact records a separate no-tools summarizer LLM call', async () => {
    const messages: unknown[] = [];
    const events: SessionEvent[] = [];
    const llmRecords: LlmCallRecord[] = [];
    const recordedBlocks: SemanticCompactBlock[] = [];
    const largeBody = 'SEMANTIC_COMPACT_RAW_TOOL_OUTPUT'.repeat(180);
    let streamCalls = 0;
    const model = new MockLanguageModelV3({
      doGenerate: {
        content: [{
          type: 'text',
          text: JSON.stringify({
            current_objective: 'Finish the benchmark task.',
            user_constraints: ['Continue from public provider-visible context only.'],
            important_files_and_artifacts: [],
            commands_and_results: ['Read returned a large raw tool output.'],
            errors_and_fixes: [],
            failed_hypotheses: [],
            operational_state: ['Continue in the same session.'],
            public_verification_state: 'No verifier result claimed.',
            remaining_work: ['Continue after compact.'],
            next_action: 'Use the preserved recent tail to continue.',
            archive_refs_to_reread_if_needed: [],
          }),
        }],
        finishReason: { unified: 'stop', raw: 'stop' },
        usage: {
          inputTokens: { total: 21, noCache: 19, cacheRead: 2, cacheWrite: 0 },
          outputTokens: { total: 13, text: 13, reasoning: 0 },
        },
        warnings: [],
      },
      doStream: async () => {
        streamCalls += 1;
        const chunks: LanguageModelV3StreamPart[] = streamCalls === 1
          ? [
              { type: 'stream-start', warnings: [] },
              {
                type: 'tool-call',
                toolCallId: 'tool-semantic',
                toolName: 'Read',
                input: JSON.stringify({ path: 'large.log' }),
              },
              {
                type: 'finish',
                finishReason: { unified: 'tool-calls', raw: 'tool_calls' },
                usage: { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } },
              },
            ]
          : [
              { type: 'stream-start', warnings: [] },
              { type: 'finish', finishReason: { unified: 'stop', raw: 'stop' }, usage: { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } } },
            ];
        return { stream: simulateReadableStream({ chunks, initialDelayInMs: null, chunkDelayInMs: null }) };
      },
    });
    const backend = new AiSdkBackend({
      sessionId: 'session-1',
      header: header(),
      appendMessage: async (message) => {
        messages.push(message);
      },
      connection: connection(),
      apiKey: 'sk-test',
      modelId: 'mock-model-id',
      permissionEngine: new PermissionEngine({ newId: () => 'permission-id', now: () => 1 }),
      modelFactory: () => model,
      tools: [{
        name: 'Read',
        description: 'Read description',
        parameters: z.object({ path: z.string() }),
        permissionRequired: false,
        impl: async () => ({ body: largeBody }),
      }],
      contextBudget: {
        charsPerToken: 1,
        semanticCompact: {
          enabled: true,
          mode: 'replace',
          minStepNumber: 1,
          minRecentMessages: 0,
          maxActiveEstimatedTokens: 1,
          highWaterRatio: 0.1,
          maxSummaryEstimatedTokens: 1024,
          minSavingsTokens: 1,
          minSavingsRatio: 0,
        },
      },
      newId: idGenerator(),
      now: monotonicClock(),
      recordLlmCall: (record) => {
        llmRecords.push(record);
      },
      recordSemanticCompactBlock: (block) => {
        recordedBlocks.push(block);
      },
    });

    for await (const event of backend.send({ turnId: 'turn-1', text: 'hi', context: [] })) {
      events.push(event);
    }

    assert.equal(streamCalls, 2);
    assert.equal(model.doGenerateCalls.length, 1);
    assert.equal(recordedBlocks.length, 1);
    assert.equal(recordedBlocks[0]?.kind, 'maka.semantic_compact_block');
    const secondPrompt = JSON.stringify(model.doStreamCalls[1]?.prompt.map((message) => ({
      role: message.role,
      content: message.content,
    })));
    assert.match(secondPrompt, /maka_semantic_compact_block/);
    assert.doesNotMatch(secondPrompt, /SEMANTIC_COMPACT_RAW_TOOL_OUTPUT/);

    const semanticRecord = llmRecords.find((record) => record.callKind === 'semantic_compact');
    assert.ok(semanticRecord, 'expected semantic compact LLM record');
    assert.match(semanticRecord.callId ?? '', /^semantic_compact_turn-1_1_/);
    assert.equal(semanticRecord.inputTokens, 21);
    assert.equal(semanticRecord.outputTokens, 13);
    assert.equal(semanticRecord.cacheHitInputTokens, 2);
    assert.equal(semanticRecord.totalTokens, 34);

    const usageEvent = events.find((event) => event.type === 'token_usage') as
      | (Extract<SessionEvent, { type: 'token_usage' }> & { contextBudget?: Record<string, unknown> })
      | undefined;
    const decisions = usageEvent?.contextBudget?.compactionDecisions as Array<Record<string, unknown>> | undefined;
    assert.equal(decisions?.some((decision) =>
      decision.boundaryKind === 'semanticCompact'
        && decision.decision === 'replaced'
        && decision.compactCallTotalTokens === 34
    ), true);
  });

  test('active full compact keeps the accepted boundary projection across later AI SDK steps', async () => {
    const messages: unknown[] = [];
    const events: SessionEvent[] = [];
    const rawOne = 'ACTIVE_FULL_COMPACT_BOUNDARY_RAW_ONE'.repeat(160);
    const rawTwo = 'ACTIVE_FULL_COMPACT_BOUNDARY_RAW_TWO'.repeat(160);
    let streamCalls = 0;
    const model = new MockLanguageModelV3({
      doStream: async () => {
        streamCalls += 1;
        const chunks: LanguageModelV3StreamPart[] = streamCalls === 1
          ? [
              { type: 'stream-start', warnings: [] },
              {
                type: 'tool-call',
                toolCallId: 'tool-boundary-1',
                toolName: 'Read',
                input: JSON.stringify({ path: 'one.md' }),
              },
              {
                type: 'finish',
                finishReason: { unified: 'tool-calls', raw: 'tool_calls' },
                usage: { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } },
              },
            ]
          : streamCalls === 2
            ? [
                { type: 'stream-start', warnings: [] },
                {
                  type: 'tool-call',
                  toolCallId: 'tool-boundary-2',
                  toolName: 'Read',
                  input: JSON.stringify({ path: 'two.md' }),
                },
                {
                  type: 'finish',
                  finishReason: { unified: 'tool-calls', raw: 'tool_calls' },
                  usage: { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } },
                },
              ]
            : [
                { type: 'stream-start', warnings: [] },
                { type: 'finish', finishReason: { unified: 'stop', raw: 'stop' }, usage: { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } } },
              ];
        return { stream: simulateReadableStream({ chunks, initialDelayInMs: null, chunkDelayInMs: null }) };
      },
    });
    const backend = new AiSdkBackend({
      sessionId: 'session-1',
      header: header(),
      appendMessage: async (message) => {
        messages.push(message);
      },
      connection: connection(),
      apiKey: 'sk-test',
      modelId: 'mock-model-id',
      permissionEngine: new PermissionEngine({ newId: () => 'permission-id', now: () => 1 }),
      modelFactory: () => model,
      tools: [{
        name: 'Read',
        description: 'Read description',
        parameters: z.object({ path: z.string() }),
        permissionRequired: false,
        impl: async ({ path }) => ({ body: path === 'one.md' ? rawOne : rawTwo }),
      }],
      contextBudget: {
        charsPerToken: 1,
        activeFullCompact: {
          enabled: true,
          minStepNumber: 1,
          minRecentMessages: 0,
          maxActiveEstimatedTokens: 1,
          highWaterRatio: 0.1,
          maxSummaryEstimatedTokens: 512,
        },
      },
      newId: idGenerator(),
      now: monotonicClock(),
    });

    for await (const event of backend.send({ turnId: 'turn-1', text: 'hi', context: [] })) {
      events.push(event);
    }

    assert.equal(streamCalls, 3);
    const secondPrompt = JSON.stringify(model.doStreamCalls[1]?.prompt.map((message) => ({
      role: message.role,
      content: message.content,
    })));
    const thirdPrompt = JSON.stringify(model.doStreamCalls[2]?.prompt.map((message) => ({
      role: message.role,
      content: message.content,
    })));
    assert.equal(countActiveFullCompactMarkers(secondPrompt), 1);
    assert.equal(countActiveFullCompactMarkers(thirdPrompt), 2);
    assert.equal(thirdPrompt.includes('ACTIVE_FULL_COMPACT_BOUNDARY_RAW_ONE'), false);
    assert.equal(thirdPrompt.includes('ACTIVE_FULL_COMPACT_BOUNDARY_RAW_TWO'), false);
  });

  test('active full compact validate_only records diagnostics without replacing the next step prompt', async () => {
    const messages: unknown[] = [];
    const events: SessionEvent[] = [];
    const llmRecords: LlmCallRecord[] = [];
    const largeBody = 'VALIDATE_ONLY_RAW_TOOL_OUTPUT'.repeat(80);
    let streamCalls = 0;
    const model = new MockLanguageModelV3({
      doStream: async () => {
        streamCalls += 1;
        const chunks: LanguageModelV3StreamPart[] = streamCalls === 1
          ? [
              { type: 'stream-start', warnings: [] },
              {
                type: 'tool-call',
                toolCallId: 'tool-validate-only',
                toolName: 'Read',
                input: JSON.stringify({ path: 'notes.md' }),
              },
              {
                type: 'finish',
                finishReason: { unified: 'tool-calls', raw: 'tool_calls' },
                usage: { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } },
              },
            ]
          : [
              { type: 'stream-start', warnings: [] },
              { type: 'finish', finishReason: { unified: 'stop', raw: 'stop' }, usage: { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } } },
            ];
        return { stream: simulateReadableStream({ chunks, initialDelayInMs: null, chunkDelayInMs: null }) };
      },
    });
    const backend = new AiSdkBackend({
      sessionId: 'session-1',
      header: header(),
      appendMessage: async (message) => {
        messages.push(message);
      },
      connection: connection(),
      apiKey: 'sk-test',
      modelId: 'mock-model-id',
      permissionEngine: new PermissionEngine({ newId: () => 'permission-id', now: () => 1 }),
      modelFactory: () => model,
      tools: [{
        name: 'Read',
        description: 'Read description',
        parameters: z.object({ path: z.string() }),
        permissionRequired: false,
        impl: async () => ({ body: largeBody }),
      }],
      contextBudget: {
        charsPerToken: 1,
        activeFullCompact: {
          enabled: true,
          mode: 'validate_only',
          minStepNumber: 1,
          minRecentMessages: 0,
          maxActiveEstimatedTokens: 1,
          highWaterRatio: 0.1,
          maxSummaryEstimatedTokens: 512,
        },
      },
      newId: idGenerator(),
      now: monotonicClock(),
      recordLlmCall: (record) => {
        llmRecords.push(record);
      },
    });

    for await (const event of backend.send({ turnId: 'turn-1', text: 'hi', context: [] })) {
      events.push(event);
    }

    assert.equal(streamCalls, 2);
    const secondPrompt = JSON.stringify(model.doStreamCalls[1]?.prompt.map((message) => ({
      role: message.role,
      content: message.content,
    })));
    assert.doesNotMatch(secondPrompt, /maka_active_full_compact_block/);
    assert.match(secondPrompt, /VALIDATE_ONLY_RAW_TOOL_OUTPUT/);

    const usageEvent = events.find((event) => event.type === 'token_usage') as
      | (Extract<SessionEvent, { type: 'token_usage' }> & { contextBudget?: Record<string, unknown> })
      | undefined;
    const recordContextBudget = llmRecords[0]?.contextBudget as Record<string, unknown> | undefined;
    for (const contextBudget of [usageEvent?.contextBudget, recordContextBudget]) {
      const decisions = contextBudget?.compactionDecisions as Array<Record<string, unknown>> | undefined;
      assert.equal(decisions?.some((decision) =>
        decision.boundaryKind === 'activeFullCompact'
          && decision.decision === 'unchanged'
          && decision.reason === 'validate_only'
      ), true);
      assert.equal(
        contextBudget?.highWaterRequestShapeHashBefore,
        contextBudget?.highWaterRequestShapeHashAfter,
      );
    }
  });

  test('normalizes cache and reasoning tokens to messages, events, and telemetry', async () => {
    const messages: unknown[] = [];
    const events: SessionEvent[] = [];
    const llmRecords: LlmCallRecord[] = [];
    const runTraceEvents: Array<{ type: string; data?: Record<string, unknown> }> = [];
    let pricingLookupCalls = 0;
    const pricing = {
      modelKey: 'anthropic:mock-model-id',
      inputUsdPer1M: 3,
      outputUsdPer1M: 15,
      cacheReadUsdPer1M: 0.3,
      cacheWriteUsdPer1M: 3.75,
    };
    const chunks: LanguageModelV3StreamPart[] = [
      { type: 'stream-start', warnings: [] },
      { type: 'text-start', id: 'text-1' },
      { type: 'text-delta', id: 'text-1', delta: 'hello' },
      { type: 'text-end', id: 'text-1' },
      {
        type: 'finish',
        finishReason: { unified: 'stop', raw: 'stop' },
        usage: {
          inputTokens: {
            total: 10,
            noCache: 5,
            cacheRead: 3,
            cacheWrite: 2,
          },
          outputTokens: {
            total: 7,
            text: 5,
            reasoning: 2,
          },
        },
      },
    ];
    const model = new MockLanguageModelV3({
      doStream: {
        stream: simulateReadableStream({
          chunks,
          initialDelayInMs: null,
          chunkDelayInMs: null,
        }),
      },
    });
    const backend = new AiSdkBackend({
      sessionId: 'session-1',
      header: header(),
      appendMessage: async (message) => {
        messages.push(message);
      },
      connection: connection(),
      apiKey: 'sk-test',
      modelId: 'mock-model-id',
      permissionEngine: new PermissionEngine({ newId: () => 'permission-id', now: () => 1 }),
      modelFactory: () => model,
      tools: [],
      newId: idGenerator(),
      now: monotonicClock(),
      systemPrompt: 'durable system prompt',
      lookupPricing: (modelKey) => {
        pricingLookupCalls += 1;
        return modelKey === pricing.modelKey ? pricing : null;
      },
      recordLlmCall: (record) => {
        llmRecords.push(record);
      },
      recordRunTrace: (event) => {
        runTraceEvents.push(event);
      },
    });

    for await (const event of backend.send({ turnId: 'turn-1', text: 'hi', context: [] })) {
      events.push(event);
    }

    const usageMessage = messages.find((message) =>
      (message as { type?: string }).type === 'token_usage'
    ) as {
      input?: number;
      output?: number;
      cacheHitInput?: number;
      cacheMissInput?: number;
      cacheMissInputSource?: string;
      cacheWriteInput?: number;
      cacheRead?: number;
      cacheCreation?: number;
      reasoning?: number;
      total?: number;
      rawFinishReason?: string;
      costUsd?: number;
      systemPromptHash?: string;
      prefixHash?: string;
      prefixChangeReason?: string;
      requestShapeHash?: string;
      requestShapeChangeReason?: string;
    } | undefined;
    const usageEvent = events.find((event) => event.type === 'token_usage') as
      | Extract<SessionEvent, { type: 'token_usage' }>
      & { systemPromptHash?: string }
      | undefined;
    const expectedCostUsd = ((5 * 3) + (3 * 0.3) + (2 * 3.75) + (7 * 15)) / 1_000_000;
    const usageTrace = runTraceEvents.find((event) => event.type === 'usage_recorded');
    const startTrace = runTraceEvents.find((event) => event.type === 'model_stream_started');

    assert.equal((usageMessage as { type?: string } | undefined)?.type, 'token_usage');
    assert.equal((usageMessage as { turnId?: string } | undefined)?.turnId, 'turn-1');
    assert.equal(usageMessage?.input, 10);
    assert.equal(usageMessage?.output, 7);
    assert.equal(usageMessage?.cacheHitInput, 3);
    assert.equal(usageMessage?.cacheMissInput, 5);
    assert.equal(usageMessage?.cacheMissInputSource, 'explicit');
    assert.equal(usageMessage?.cacheWriteInput, 2);
    assert.equal(usageMessage?.cacheRead, 3);
    assert.equal(usageMessage?.cacheCreation, 2);
    assert.equal(usageMessage?.reasoning, 2);
    assert.equal(usageMessage?.total, 17);
    assert.equal(usageMessage?.rawFinishReason, 'stop');
    assert.equal(usageMessage?.systemPromptHash, usageEvent?.systemPromptHash);
    assert.ok(usageMessage?.systemPromptHash);
    assert.equal(usageMessage?.costUsd, expectedCostUsd);
    assert.equal(usageMessage?.prefixChangeReason, 'first_turn');
    assert.equal(usageMessage?.requestShapeChangeReason, 'first_turn');
    assert.ok(usageMessage?.prefixHash);
    assert.ok(usageMessage?.requestShapeHash);
    assert.equal(usageEvent?.input, 10);
    assert.equal(usageEvent?.output, 7);
    assert.equal(usageEvent?.cacheHitInput, 3);
    assert.equal(usageEvent?.cacheMissInput, 5);
    assert.equal(usageEvent?.cacheMissInputSource, 'explicit');
    assert.equal(usageEvent?.cacheWriteInput, 2);
    assert.equal(usageEvent?.cacheRead, 3);
    assert.equal(usageEvent?.cacheCreation, 2);
    assert.equal(usageEvent?.reasoning, 2);
    assert.equal(usageEvent?.total, 17);
    assert.equal(usageEvent?.rawFinishReason, 'stop');
    assert.equal(usageEvent?.systemPromptHash, usageMessage?.systemPromptHash);
    assert.equal(usageEvent?.costUsd, expectedCostUsd);
    assert.equal(usageEvent?.prefixChangeReason, 'first_turn');
    assert.equal(usageEvent?.requestShapeChangeReason, 'first_turn');
    assert.ok(usageEvent?.prefixHash);
    assert.ok(usageEvent?.requestShapeHash);
    assert.equal(llmRecords[0]?.inputTokens, 10);
    assert.equal(llmRecords[0]?.outputTokens, 7);
    assert.equal(llmRecords[0]?.cacheHitInputTokens, 3);
    assert.equal(llmRecords[0]?.cacheMissInputTokens, 5);
    assert.equal(llmRecords[0]?.cacheMissInputSource, 'explicit');
    assert.equal(llmRecords[0]?.cachedInputTokens, 3);
    assert.equal(llmRecords[0]?.cacheWriteInputTokens, 2);
    assert.equal(llmRecords[0]?.reasoningTokens, 2);
    assert.equal(llmRecords[0]?.totalTokens, 17);
    assert.equal(llmRecords[0]?.rawFinishReason, 'stop');
    assert.equal(llmRecords[0]?.systemPromptHash, usageMessage?.systemPromptHash);
    assert.equal(llmRecords[0]?.costUsd, expectedCostUsd);
    assert.equal(llmRecords[0]?.prefixChangeReason, 'first_turn');
    assert.equal(llmRecords[0]?.requestShapeChangeReason, 'first_turn');
    assert.ok(llmRecords[0]?.prefixHash);
    assert.ok(llmRecords[0]?.requestShapeHash);
    assert.equal(startTrace?.data?.systemPromptHash, usageMessage?.systemPromptHash);
    assert.equal(usageTrace?.data?.systemPromptHash, usageMessage?.systemPromptHash);
    assert.equal(usageTrace?.data?.costUsd, expectedCostUsd);
    assert.equal(pricingLookupCalls, 1);
  });
});

describe('AiSdkBackend request-shape diagnostics', () => {
  test('identical request shape keeps the same hash and reports stable after first turn', () => {
    const tools = canonicalizeToolSet([
      testTool('Read', z.object({ path: z.string() })),
      testTool('Bash', z.object({ command: z.string() })),
    ], testTool(INVALID_TOOL_NAME, z.object({ tool: z.string().optional() })));
    const first = computeRequestShapeDiagnostic({
      connection: connection(),
      modelId: 'mock-model-id',
      systemPrompt: 'durable system',
      providerOptions: { temperature: 0, nested: { b: 2, a: 1 } },
      providerTools: tools.providerTools,
      activeTools: tools.activeTools,
      priorMessages: [{ role: 'user', content: 'hello' }],
    }, undefined);
    const second = computeRequestShapeDiagnostic({
      connection: connection(),
      modelId: 'mock-model-id',
      systemPrompt: 'durable system',
      providerOptions: { nested: { a: 1, b: 2 }, temperature: 0 },
      providerTools: tools.providerTools,
      activeTools: tools.activeTools,
      priorMessages: [{ role: 'user', content: 'hello' }],
    }, first);

    assert.equal(first.prefixChangeReason, 'first_turn');
    assert.equal(first.requestShapeChangeReason, 'first_turn');
    assert.equal(second.prefixChangeReason, 'stable');
    assert.equal(second.requestShapeChangeReason, 'stable');
    assert.equal(second.prefixHash, first.prefixHash);
    assert.equal(second.requestShapeHash, first.requestShapeHash);
  });

  test('classifies targeted request-shape changes', () => {
    const tools = canonicalizeToolSet([
      testTool('Read', z.object({ path: z.string() })),
    ], testTool(INVALID_TOOL_NAME, z.object({ tool: z.string().optional() })));
    const baseInput = {
      connection: connection(),
      modelId: 'mock-model-id',
      systemPrompt: 'durable system',
      providerOptions: { temperature: 0 },
      providerTools: tools.providerTools,
      activeTools: tools.activeTools,
      priorMessages: [{ role: 'user' as const, content: 'hello' }],
    };
    const base = computeRequestShapeDiagnostic(baseInput, undefined);

    assert.equal(computeRequestShapeDiagnostic({
      ...baseInput,
      systemPrompt: 'changed system',
    }, base).prefixChangeReason, 'system_prompt_changed');
    assert.equal(computeRequestShapeDiagnostic({
      ...baseInput,
      providerTools: canonicalizeToolSet([
        testTool('Read', z.object({ path: z.string(), offset: z.number().optional() })),
      ], testTool(INVALID_TOOL_NAME, z.object({ tool: z.string().optional() }))).providerTools,
    }, base).prefixChangeReason, 'tool_schema_changed');
    assert.equal(computeRequestShapeDiagnostic({
      ...baseInput,
      providerOptions: { temperature: 1 },
    }, base).prefixChangeReason, 'provider_options_changed');
    assert.equal(computeRequestShapeDiagnostic({
      ...baseInput,
      modelId: 'other-model',
    }, base).prefixChangeReason, 'model_or_provider_changed');
    const historyChanged = computeRequestShapeDiagnostic({
      ...baseInput,
      priorMessages: [{ role: 'assistant' as const, content: 'hello' }],
    }, base);
    assert.equal(historyChanged.prefixChangeReason, 'stable');
    assert.equal(historyChanged.prefixHash, base.prefixHash);
    assert.equal(historyChanged.requestShapeChangeReason, 'history_projection_changed');
    assert.notEqual(historyChanged.requestShapeHash, base.requestShapeHash);
  });

  test('tool-result output hydration changes request shape without changing durable prefix', () => {
    const tools = canonicalizeToolSet([
      testTool('Read', z.object({ path: z.string() })),
    ], testTool(INVALID_TOOL_NAME, z.object({ tool: z.string().optional() })));
    const toolCallMessage: ModelMessage = {
      role: 'assistant',
      content: [{
        type: 'tool-call',
        toolCallId: 'tool-1',
        toolName: 'Read',
        input: { path: 'archive.txt' },
      }],
    };
    const placeholderToolResult: ModelMessage = {
      role: 'tool',
      content: [{
        type: 'tool-result',
        toolCallId: 'tool-1',
        toolName: 'Read',
        output: { type: 'text', value: '[archived placeholder]' },
      }],
    };
    const hydratedToolResult: ModelMessage = {
      role: 'tool',
      content: [{
        type: 'tool-result',
        toolCallId: 'tool-1',
        toolName: 'Read',
        output: { type: 'text', value: 'hydrated archive payload '.repeat(20) },
      }],
    };
    const baseInput = {
      connection: connection(),
      modelId: 'mock-model-id',
      systemPrompt: 'durable system',
      providerOptions: { temperature: 0 },
      providerTools: tools.providerTools,
      activeTools: tools.activeTools,
      priorMessages: [toolCallMessage, placeholderToolResult],
    };
    const placeholder = computeRequestShapeDiagnostic(baseInput, undefined);
    const hydrated = computeRequestShapeDiagnostic({
      ...baseInput,
      priorMessages: [toolCallMessage, hydratedToolResult],
    }, placeholder);

    assert.equal(hydrated.prefixChangeReason, 'stable');
    assert.equal(hydrated.prefixHash, placeholder.prefixHash);
    assert.equal(hydrated.requestShapeChangeReason, 'history_projection_changed');
    assert.notEqual(hydrated.requestShapeHash, placeholder.requestShapeHash);
  });

  test('tool canonicalization is independent of registration order and places invalid last', () => {
    const invalid = testTool(INVALID_TOOL_NAME, z.object({ tool: z.string().optional() }));
    const first = canonicalizeToolSet([
      testTool('Write', z.object({ path: z.string(), content: z.string() })),
      testTool('Read', z.object({ path: z.string() })),
    ], invalid);
    const second = canonicalizeToolSet([
      testTool('Read', z.object({ path: z.string() })),
      testTool('Write', z.object({ content: z.string(), path: z.string() })),
    ], invalid);

    assert.deepEqual(first.activeTools, ['Read', 'Write']);
    assert.deepEqual(first.providerTools.map((tool) => tool.name), ['Read', 'Write', INVALID_TOOL_NAME]);
    assert.deepEqual(second.providerTools.map((tool) => tool.name), ['Read', 'Write', INVALID_TOOL_NAME]);
    assert.equal(
      computeRequestShapeDiagnostic({
        connection: connection(),
        modelId: 'mock-model-id',
        providerTools: first.providerTools,
        activeTools: first.activeTools,
        priorMessages: [],
      }, undefined).componentHashes.toolSchemaHash,
      computeRequestShapeDiagnostic({
        connection: connection(),
        modelId: 'mock-model-id',
        providerTools: second.providerTools,
        activeTools: second.activeTools,
        priorMessages: [],
      }, undefined).componentHashes.toolSchemaHash,
    );
  });

  test('classifies strict enabled-group expansion as tool_source_enabled', () => {
    const invalid = testTool(INVALID_TOOL_NAME, z.object({ tool: z.string().optional() }));
    const initialTools = canonicalizeToolSet([
      testTool('Read', z.object({ path: z.string() })),
      testTool(LOAD_TOOLS_NAME, z.object({ group: z.string() })),
    ], invalid);
    const expandedTools = canonicalizeToolSet([
      testTool('Read', z.object({ path: z.string() })),
      testTool('WebFetch', z.object({ url: z.string() })),
      testTool(LOAD_TOOLS_NAME, z.object({ group: z.string() })),
    ], invalid);
    const groupCatalog = { web: ['WebFetch'] };
    const first = computeRequestShapeDiagnostic({
      connection: connection(),
      modelId: 'mock-model-id',
      providerTools: initialTools.providerTools,
      activeTools: initialTools.activeTools,
      priorMessages: [],
      toolAvailability: {
        mode: 'economy',
        enabledSourceIds: [],
        availableSourceIds: ['web'],
        connectorToolName: LOAD_TOOLS_NAME,
        visibleToolNamesBySource: groupCatalog,
      },
    }, undefined);
    const second = computeRequestShapeDiagnostic({
      connection: connection(),
      modelId: 'mock-model-id',
      providerTools: expandedTools.providerTools,
      activeTools: expandedTools.activeTools,
      priorMessages: [],
      toolAvailability: {
        mode: 'economy',
        enabledSourceIds: ['web'],
        availableSourceIds: [],
        connectorToolName: LOAD_TOOLS_NAME,
        visibleToolNamesBySource: groupCatalog,
      },
    }, first);

    assert.equal(second.prefixChangeReason, 'tool_schema_changed');
    assert.equal(second.requestShapeChangeReason, 'tool_schema_changed');
    assert.equal(second.toolSchemaChangeReason, 'tool_source_enabled');
    assert.notEqual(second.prefixHash, first.prefixHash);
  });

  test('backend full mode keeps the complete tool surface and omits the connector', async () => {
    const model = completionModel();
    const llmRecords: LlmCallRecord[] = [];
    const backend = new AiSdkBackend({
      sessionId: 'session-1',
      header: header(),
      appendMessage: async () => {},
      connection: connection(),
      apiKey: 'sk-test',
      modelId: 'mock-model-id',
      permissionEngine: new PermissionEngine({ newId: () => 'permission-id', now: () => 1 }),
      modelFactory: () => model,
      // No toolAvailability ⇒ full surface: every tool visible, no connector.
      tools: [
        testTool('Read', z.object({ path: z.string() })),
        testTool('WebFetch', z.object({ url: z.string() })),
      ],
      newId: idGenerator(),
      now: monotonicClock(),
      recordLlmCall: (record) => {
        llmRecords.push(record);
      },
    });

    await drain(backend.send({ turnId: 'turn-1', text: 'hi', context: [] }));

    assert.deepEqual(modelToolNames(model), sortedModelToolNames(['Read', 'WebFetch']));
    assert.equal(modelToolNames(model).includes(LOAD_TOOLS_NAME), false);
    // toolCount tracks the model-visible (active) tools — the two real tools.
    // The invalid fallback lives in providerTools but is never advertised, so
    // it is not counted (toolCount is the wire-visible subset).
    assert.equal(toolSchemaPromptSegment(llmRecords[0])?.toolCount, 2);
  });

  test('volatile turn-tail facts do not churn the durable prefix hash', async () => {
    const events: SessionEvent[] = [];
    const llmRecords: LlmCallRecord[] = [];
    const models: MockLanguageModelV3[] = [];
    let date = '2026-05-29';
    const backend = new AiSdkBackend({
      sessionId: 'session-1',
      header: header(),
      appendMessage: async () => {},
      connection: connection(),
      apiKey: 'sk-test',
      modelId: 'mock-model-id',
      permissionEngine: new PermissionEngine({ newId: () => 'permission-id', now: () => 1 }),
      modelFactory: () => {
        const model = completionModel();
        models.push(model);
        return model;
      },
      tools: [],
      newId: idGenerator(),
      now: monotonicClock(),
      systemPrompt: 'durable system prompt',
      turnTailPrompt: () => `Maka session environment:\n<env>\n  Today's date: ${date}\n</env>`,
      recordLlmCall: (record) => {
        llmRecords.push(record);
      },
    });

    for await (const event of backend.send({ turnId: 'turn-1', text: 'hi', context: [] })) {
      events.push(event);
    }
    date = '2026-05-30';
    for await (const event of backend.send({ turnId: 'turn-2', text: 'hi', context: [] })) {
      events.push(event);
    }

    const usageEvents = events.filter((event): event is Extract<SessionEvent, { type: 'token_usage' }> =>
      event.type === 'token_usage'
    );
    assert.equal(usageEvents[0]?.prefixChangeReason, 'first_turn');
    assert.equal(usageEvents[1]?.prefixChangeReason, 'stable');
    assert.equal(usageEvents[1]?.prefixHash, usageEvents[0]?.prefixHash);
    assert.equal(usageEvents[0]?.requestShapeChangeReason, 'first_turn');
    assert.equal(usageEvents[1]?.requestShapeChangeReason, 'stable');
    assert.equal(usageEvents[1]?.requestShapeHash, usageEvents[0]?.requestShapeHash);
    assert.equal(llmRecords[1]?.prefixChangeReason, 'stable');
    assert.equal(llmRecords[1]?.requestShapeChangeReason, 'stable');
    assert.match(JSON.stringify(compactPrompt(models[0]!)), /2026-05-29/);
    assert.match(JSON.stringify(compactPrompt(models[1]!)), /2026-05-30/);
    assert.equal(JSON.stringify(modelCallSettings(models[0]!)).includes('2026-05-29'), false);
    assert.equal(JSON.stringify(modelCallSettings(models[1]!)).includes('2026-05-30'), false);
  });
});

describe('AiSdkBackend context budget and prompt attribution', () => {
  test('context budget keeps whole recent turns and drops older turns', () => {
    const events = [
      runtimeTextEvent({ id: 'old-u', turnId: 'old', role: 'user', author: 'user', text: 'old user text' }),
      runtimeTextEvent({ id: 'old-a', turnId: 'old', role: 'model', author: 'agent', text: 'old assistant text' }),
      runtimeTextEvent({ id: 'new-u', turnId: 'new', role: 'user', author: 'user', text: 'new user text' }),
      runtimeTextEvent({ id: 'new-a', turnId: 'new', role: 'model', author: 'agent', text: 'new assistant text' }),
    ];

    const budgeted = applyRuntimeEventContextBudget(events, {
      name: 'test-budget',
      maxHistoryEstimatedTokens: 1,
      minRecentTurns: 1,
      charsPerToken: 1,
    });

    assert.ok(budgeted);
    assert.deepEqual([...new Set(budgeted.events.map((event) => event.turnId))], ['new']);
    assert.equal(budgeted.diagnostic.droppedTurns, 1);
    assert.equal(budgeted.diagnostic.keptTurns, 1);
    assert.equal(budgeted.diagnostic.droppedEvents, 2);
  });

  test('stale tool-result pruning replaces old payloads before budgeting and preserves replay pairing', () => {
    const oldResult = { body: 'x'.repeat(500) };
    const newResult = { body: 'y'.repeat(500) };
    const oldSerialized = JSON.stringify(oldResult);
    const events = [
      runtimeEvent({
        id: 'old-call',
        turnId: 'old',
        role: 'model',
        author: 'agent',
        content: { kind: 'function_call', id: 'tool-old', name: 'Read', args: { path: 'old.txt' } },
      }),
      runtimeEvent({
        id: 'old-result',
        turnId: 'old',
        role: 'tool',
        author: 'tool',
        content: { kind: 'function_response', id: 'tool-old', name: 'Read', result: oldResult },
      }),
      runtimeEvent({
        id: 'new-call',
        turnId: 'new',
        role: 'model',
        author: 'agent',
        content: { kind: 'function_call', id: 'tool-new', name: 'Read', args: { path: 'new.txt' } },
      }),
      runtimeEvent({
        id: 'new-result',
        turnId: 'new',
        role: 'tool',
        author: 'tool',
        content: { kind: 'function_response', id: 'tool-new', name: 'Read', result: newResult },
      }),
    ];

    const optOut = applyRuntimeEventContextBudget(events, {
      staleToolResultPrune: { enabled: false, maxResultEstimatedTokens: 1 },
      minRecentTurns: 1,
      charsPerToken: 1,
    });
    assert.equal(optOut, undefined);

    const missingArchive = applyRuntimeEventContextBudget(events, {
      staleToolResultPrune: {
        enabled: true,
        maxResultEstimatedTokens: 1,
        minRecentTurnsFull: 1,
      },
      minRecentTurns: 1,
      charsPerToken: 1,
    });
    assert.ok(missingArchive);
    assert.equal(missingArchive.diagnostic.prunedToolResults, undefined);
    assert.equal(missingArchive.diagnostic.archiveWriteFailures, 1);
    const missingArchiveOldResponse = missingArchive.events.find((event) => event.id === 'old-result');
    assert.equal(missingArchiveOldResponse?.content?.kind, 'function_response');
    assert.deepEqual(
      missingArchiveOldResponse?.content?.kind === 'function_response'
        ? missingArchiveOldResponse.content.result
        : undefined,
      oldResult,
    );

    const budgeted = applyRuntimeEventContextBudget(events, {
      staleToolResultPrune: {
        enabled: true,
        maxResultEstimatedTokens: 1,
        minRecentTurnsFull: 1,
        archiveRefs: [{
          runtimeEventId: 'old-result',
          toolCallId: 'tool-old',
          toolName: 'Read',
          artifactId: 'artifact-old-result',
          bodySha256: sha256(oldSerialized),
          originalEstimatedTokens: oldSerialized.length,
          originalBytes: utf8Bytes(oldSerialized),
          rewriteVersion: 1,
          reason: 'stale_tool_result_pruned_before_compact',
        }],
      },
      minRecentTurns: 1,
      charsPerToken: 1,
    });

    assert.ok(budgeted);
    assert.equal(budgeted.diagnostic.prunedToolResults, 1);
    assert.equal(budgeted.diagnostic.archivePlaceholders, 1);
    assert.equal(budgeted.diagnostic.archiveWriteFailures, undefined);
    assert.deepEqual(budgeted.diagnostic.archivePlaceholderReasonCounts, {
      stale_tool_result_pruned_before_compact: 1,
    });
    const oldResponse = budgeted.events.find((event) => event.id === 'old-result');
    assert.equal(oldResponse?.content?.kind, 'function_response');
    const oldResponseContent = oldResponse?.content;
    assert.equal(oldResponseContent?.kind, 'function_response');
    const placeholder = oldResponseContent?.kind === 'function_response'
      ? oldResponseContent.result as {
        kind?: string;
        rewriteVersion?: number;
        artifactId?: string;
        runtimeEventId?: string;
        toolCallId?: string;
        toolName?: string;
        bodySha256?: string;
      }
      : undefined;
    assert.equal(placeholder?.kind, ARCHIVED_TOOL_RESULT_PLACEHOLDER_KIND);
    assert.equal(placeholder?.rewriteVersion, 1);
    assert.equal(placeholder?.artifactId, 'artifact-old-result');
    assert.equal(placeholder?.runtimeEventId, 'old-result');
    assert.equal(placeholder?.toolCallId, 'tool-old');
    assert.equal(placeholder?.toolName, 'Read');
    assert.equal(placeholder?.bodySha256, sha256(oldSerialized));

    const newResponse = budgeted.events.find((event) => event.id === 'new-result');
    assert.equal(newResponse?.content?.kind, 'function_response');
    assert.deepEqual(
      newResponse?.content?.kind === 'function_response' ? newResponse.content.result : undefined,
      newResult,
    );

    const replayPlan = buildRuntimeEventModelReplayPlan(budgeted.events);
    assert.deepEqual(
      replayPlan.diagnostics.filter((diagnostic) =>
        diagnostic.code === 'unmatched_tool_result' || diagnostic.code === 'tool_id_mismatch'
      ),
      [],
    );
    const oldReplayResult = replayPlan.items.find((item) =>
      item.kind === 'tool_result' && item.toolCallId === 'tool-old'
    );
    assert.equal(oldReplayResult?.kind, 'tool_result');
    assert.equal(oldReplayResult?.eventId, 'old-result');
    assert.equal(oldReplayResult?.kind === 'tool_result' ? oldReplayResult.toolName : undefined, 'Read');
  });

  test('usage events include prompt segments and context budget diagnostics', async () => {
    const model = completionModel();
    const events: SessionEvent[] = [];
    const backend = new AiSdkBackend({
      sessionId: 'session-1',
      header: header(),
      appendMessage: async () => {},
      connection: connection(),
      apiKey: 'sk-test',
      modelId: 'mock-model-id',
      permissionEngine: new PermissionEngine({ newId: () => 'permission-id', now: () => 1 }),
      modelFactory: () => model,
      tools: [testTool('Read', z.object({ path: z.string() }))],
      newId: idGenerator(),
      now: monotonicClock(),
      systemPrompt: 'durable system',
      turnTailPrompt: 'volatile tail',
      contextBudget: {
        name: 'test-budget',
        maxHistoryEstimatedTokens: 1,
        minRecentTurns: 1,
        charsPerToken: 1,
      },
    });

    for await (const event of backend.send({
      turnId: 'turn-current',
      text: 'current user',
      context: [],
      runtimeContext: [
        runtimeTextEvent({ id: 'old-u', turnId: 'old', role: 'user', author: 'user', text: 'old user text' }),
        runtimeTextEvent({ id: 'old-a', turnId: 'old', role: 'model', author: 'agent', text: 'old assistant text' }),
        runtimeTextEvent({ id: 'new-u', turnId: 'new', role: 'user', author: 'user', text: 'new user text' }),
        runtimeTextEvent({ id: 'new-a', turnId: 'new', role: 'model', author: 'agent', text: 'new assistant text' }),
      ],
    })) {
      events.push(event);
    }

    assert.deepEqual(compactPrompt(model), [
      { role: 'system', content: 'durable system' },
      { role: 'user', content: [{ type: 'text', text: 'new user text' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'new assistant text' }] },
      { role: 'user', content: [{ type: 'text', text: 'current user\n\nvolatile tail' }] },
    ]);
    const usage = events.find((event): event is Extract<SessionEvent, { type: 'token_usage' }> =>
      event.type === 'token_usage'
    );
    assert.ok(usage);
    assert.equal(usage.contextBudget?.policyName, 'test-budget');
    assert.equal(usage.contextBudget?.droppedTurns, 1);
    assert.equal(usage.promptSegments?.some((segment) => segment.kind === 'prior_history'), true);
    assert.equal(usage.promptSegments?.some((segment) => segment.kind === 'tool_schema'), true);
    assert.equal(usage.promptSegments?.some((segment) => segment.kind === 'turn_tail'), true);
  });
});

describe('AiSdkBackend RunTrace', () => {
  test('records turn, model, usage, and completion trace events without changing SessionEvents', async () => {
    const trace: RunTraceEvent[] = [];
    const events: SessionEvent[] = [];
    const model = new MockLanguageModelV3({
      doStream: {
        stream: simulateReadableStream({
          chunks: [
            { type: 'stream-start', warnings: [] },
            { type: 'text-start', id: 'text-1' },
            { type: 'text-delta', id: 'text-1', delta: 'hello' },
            { type: 'text-end', id: 'text-1' },
            {
              type: 'finish',
              finishReason: { unified: 'stop', raw: 'stop' },
              usage: {
                inputTokens: {
                  total: 4,
                  noCache: 4,
                  cacheRead: 0,
                  cacheWrite: 0,
                },
                outputTokens: {
                  total: 2,
                  text: 1,
                  reasoning: 1,
                },
              },
            },
          ],
          initialDelayInMs: null,
          chunkDelayInMs: null,
        }),
      },
    });
    const backend = new AiSdkBackend({
      sessionId: 'session-1',
      header: header(),
      appendMessage: async () => {},
      connection: connection(),
      apiKey: 'sk-test',
      modelId: 'mock-model-id',
      permissionEngine: new PermissionEngine({ newId: () => 'permission-id', now: () => 1 }),
      modelFactory: () => model,
      tools: [],
      newId: idGenerator(),
      now: monotonicClock(),
      recordRunTrace: (event) => {
        trace.push(event);
      },
    });

    for await (const event of backend.send({ turnId: 'turn-1', text: 'hi', context: [] })) {
      events.push(event);
    }

    assert.deepEqual(
      trace.map((event) => event.type),
      ['turn_started', 'model_resolved', 'model_stream_started', 'usage_recorded', 'model_stream_completed'],
    );
    assert.deepEqual(
      trace.map((event) => event.phase),
      ['turn', 'model', 'model', 'usage', 'model'],
    );
    assert.equal(trace[0]?.sessionId, 'session-1');
    assert.equal(trace[0]?.turnId, 'turn-1');
    assert.equal(trace.find((event) => event.type === 'usage_recorded')?.data?.inputTokens, 4);
    assert.equal(trace.find((event) => event.type === 'usage_recorded')?.data?.reasoningTokens, 1);
    assert.deepEqual(
      events.map((event) => event.type).filter((type) => type === 'text_delta' || type === 'token_usage' || type === 'complete'),
      ['text_delta', 'token_usage', 'complete'],
    );
  });

  test('trace recorder failures are best-effort and do not change model execution', async () => {
    const events: SessionEvent[] = [];
    const model = new MockLanguageModelV3({
      doStream: {
        stream: simulateReadableStream({
          chunks: [
            { type: 'stream-start', warnings: [] },
            { type: 'text-start', id: 'text-1' },
            { type: 'text-delta', id: 'text-1', delta: 'hello' },
            { type: 'text-end', id: 'text-1' },
            {
              type: 'finish',
              finishReason: { unified: 'stop', raw: 'stop' },
              usage: {
                inputTokens: {
                  total: 1,
                  noCache: 1,
                  cacheRead: 0,
                  cacheWrite: 0,
                },
                outputTokens: {
                  total: 1,
                  text: 1,
                  reasoning: 0,
                },
              },
            },
          ],
          initialDelayInMs: null,
          chunkDelayInMs: null,
        }),
      },
    });
    const backend = new AiSdkBackend({
      sessionId: 'session-1',
      header: header(),
      appendMessage: async () => {},
      connection: connection(),
      apiKey: 'sk-test',
      modelId: 'mock-model-id',
      permissionEngine: new PermissionEngine({ newId: () => 'permission-id', now: () => 1 }),
      modelFactory: () => model,
      tools: [],
      newId: idGenerator(),
      now: monotonicClock(),
      recordRunTrace: () => {
        throw new Error('trace sink unavailable');
      },
    });

    for await (const event of backend.send({ turnId: 'turn-1', text: 'hi', context: [] })) {
      events.push(event);
    }

    assert.deepEqual(
      events.map((event) => event.type).filter((type) => type === 'text_delta' || type === 'token_usage' || type === 'complete'),
      ['text_delta', 'token_usage', 'complete'],
    );
  });


  test('records permission and tool trace events for denied tools', async () => {
    const trace: RunTraceEvent[] = [];
    const events: SessionEvent[] = [];
    const permissionEngine = new PermissionEngine({ newId: idGenerator(), now: () => 1 });
    const backend = new AiSdkBackend({
      sessionId: 'session-1',
      header: header('ask'),
      appendMessage: async () => {},
      connection: connection(),
      apiKey: 'sk-test',
      modelId: 'claude-sonnet-4-5-20250929',
      permissionEngine,
      modelFactory: () => ({}),
      tools: [],
      newId: idGenerator(),
      now: monotonicClock(),
      permissionTimeoutMs: 1_000,
    });
    (backend as unknown as {
      currentRunTrace: { emit(eventPhase: string, eventType: string, message: string, data?: Record<string, unknown>): void };
      currentWatchdog: { pause(): void; resume(): void };
    }).currentRunTrace = {
      emit: (phase, type, message, data) => {
        trace.push({
          id: `trace-${trace.length + 1}`,
          sessionId: 'session-1',
          turnId: 'turn-1',
          ts: trace.length + 1,
          phase: phase as RunTraceEvent['phase'],
          type: type as RunTraceEvent['type'],
          message,
          ...(data ? { data } : {}),
        });
      },
    };
    (backend as unknown as {
      currentWatchdog: { pause(): void; resume(): void };
    }).currentWatchdog = { pause() {}, resume() {} };
    const tool: MakaTool = {
      name: 'Write',
      description: 'write file',
      parameters: {},
      permissionRequired: true,
      impl: async () => ({ ok: true }),
    };
    const execute = (backend as unknown as {
      wrapToolExecute(
        tool: MakaTool,
        turnId: string,
        queue: { push(event: SessionEvent): void },
      ): (args: unknown, ctx: { toolCallId: string; abortSignal: AbortSignal }) => Promise<unknown>;
    }).wrapToolExecute(tool, 'turn-1', { push: (event) => events.push(event) });

    const pending = execute(
      { path: 'notes.md', content: 'hello' },
      { toolCallId: 'tool-1', abortSignal: new AbortController().signal },
    );
    await waitFor(() => events.some((event) => event.type === 'permission_request'));
    const request = events.find((event) => event.type === 'permission_request') as
      | Extract<SessionEvent, { type: 'permission_request' }>
      | undefined;
    assert.ok(request);
    permissionEngine.recordResponse('turn-1', {
      requestId: request.requestId,
      decision: 'deny',
    });
    await pending;

    assert.deepEqual(
      trace.map((event) => event.type),
      ['tool_started', 'permission_requested', 'permission_decided', 'tool_failed'],
    );
    assert.deepEqual(
      trace.map((event) => event.phase),
      ['tool', 'permission', 'permission', 'tool'],
    );
    assert.equal(trace.find((event) => event.type === 'permission_decided')?.data?.decision, 'deny');
    assert.equal(trace.find((event) => event.type === 'tool_failed')?.data?.errorClass, 'Permission');
  });

  test('records abort trace when stop is requested', async () => {
    const trace: RunTraceEvent[] = [];
    const permissionEngine = new PermissionEngine({ newId: () => 'permission-id', now: () => 1 });
    permissionEngine.beginTurn('turn-1');
    const verdict = permissionEngine.evaluate({
      sessionId: 'session-1',
      turnId: 'turn-1',
      toolUseId: 'tool-1',
      toolName: 'Write',
      args: { path: 'notes.md', content: 'hello' },
      mode: 'ask',
    });
    assert.equal(verdict.kind, 'prompt');
    const parked = verdict.kind === 'prompt'
      ? verdict.parked.then(
          () => 'resolved',
          (error: Error) => error.message,
        )
      : Promise.resolve('not-prompt');
    const backend = new AiSdkBackend({
      sessionId: 'session-1',
      header: header(),
      appendMessage: async () => {},
      connection: connection(),
      apiKey: 'sk-test',
      modelId: 'claude-sonnet-4-5-20250929',
      permissionEngine,
      modelFactory: () => ({}),
      tools: [],
      newId: idGenerator(),
      now: monotonicClock(),
    });
    (backend as unknown as {
      currentTurnId: string;
      currentRunTrace: { abortRequested(reason: string): void };
    }).currentTurnId = 'turn-1';
    (backend as unknown as {
      currentRunTrace: { abortRequested(reason: string): void };
    }).currentRunTrace = {
      abortRequested: (reason) => {
        trace.push({
          id: 'trace-1',
          sessionId: 'session-1',
          turnId: 'turn-1',
          ts: 1,
          phase: 'abort',
          type: 'abort_requested',
          message: 'Abort requested',
          data: { reason },
        });
      },
    };

    await backend.stop('redirect');

    assert.equal(trace.length, 1);
    assert.equal(trace[0]?.type, 'abort_requested');
    assert.equal(trace[0]?.data?.reason, 'redirect');
    assert.match(await parked, /Turn turn-1 aborted before permission request permission-id was answered/);
    assert.equal(permissionEngine.pendingCount('turn-1'), 0);
  });
});

describe('AiSdkBackend tool permission category hints', () => {
  test('permissionRequired=false fast path preserves tool-call/result ordering and telemetry', async () => {
    const messages: unknown[] = [];
    const events: SessionEvent[] = [];
    const telemetry: Array<{ status: string; toolCallId?: string; argsSummary?: string }> = [];
    let implCalled = false;
    const backend = new AiSdkBackend({
      sessionId: 'session-1',
      header: header('ask'),
      appendMessage: async (message) => {
        messages.push(message);
      },
      connection: connection(),
      apiKey: 'sk-test',
      modelId: 'claude-sonnet-4-5-20250929',
      permissionEngine: new PermissionEngine({ newId: () => 'permission-id', now: () => 1 }),
      modelFactory: () => ({}),
      tools: [],
      newId: idGenerator(),
      now: monotonicClock(),
      recordToolInvocation: (record) => {
        telemetry.push({ status: record.status, toolCallId: record.toolCallId, argsSummary: record.argsSummary });
      },
    });
    const tool: MakaTool = {
      name: 'Read',
      description: 'read file',
      parameters: {},
      permissionRequired: false,
      impl: async () => {
        implCalled = true;
        return { kind: 'text', text: 'hello' };
      },
    };
    const execute = (backend as unknown as {
      wrapToolExecute(
        tool: MakaTool,
        turnId: string,
        queue: { push(event: SessionEvent): void },
      ): (args: unknown, ctx: { toolCallId: string; abortSignal: AbortSignal }) => Promise<unknown>;
    }).wrapToolExecute(tool, 'turn-1', { push: (event) => events.push(event) });

    const result = await execute(
      {
        path: 'notes.md',
        authorization: 'Bearer opaque-session-value',
        apiKey: 'plain-provider-key',
        password: 'correct-horse-battery-staple',
      },
      { toolCallId: 'tool-1', abortSignal: new AbortController().signal },
    );

    assert.equal(implCalled, true);
    assert.deepEqual(result, { kind: 'text', text: 'hello' });
    assert.deepEqual(
      messages
        .map((message) => (message as { type?: string }).type)
        .filter((type) => type === 'tool_call' || type === 'tool_result'),
      ['tool_call', 'tool_result'],
    );
    assert.deepEqual(
      events
        .map((event) => event.type)
        .filter((type) => type === 'tool_start' || type === 'tool_result'),
      ['tool_start', 'tool_result'],
    );
    assert.equal(events.some((event) => event.type === 'permission_request'), false);
    assert.deepEqual(telemetry, [
      {
        status: 'success',
        toolCallId: 'tool-1',
        argsSummary: '{"path":"notes.md","authorization":"[redacted]","apiKey":"[redacted]","password":"[redacted]"}',
      },
    ]);
    assert.equal(JSON.stringify(telemetry).includes('opaque-session-value'), false);
    assert.equal(JSON.stringify(telemetry).includes('plain-provider-key'), false);
    assert.equal(JSON.stringify(telemetry).includes('correct-horse-battery-staple'), false);
  });

  test('permission prompt timeout expires one request, resumes watchdog, and writes an error result', async () => {
    const messages: unknown[] = [];
    const events: SessionEvent[] = [];
    const permissionEngine = new PermissionEngine({ newId: idGenerator(), now: () => 1 });
    let implCalled = false;
    let pauseCount = 0;
    let resumeCount = 0;
    const backend = new AiSdkBackend({
      sessionId: 'session-1',
      header: header('ask'),
      appendMessage: async (message) => {
        messages.push(message);
      },
      connection: connection(),
      apiKey: 'sk-test',
      modelId: 'claude-sonnet-4-5-20250929',
      permissionEngine,
      modelFactory: () => ({}),
      tools: [],
      newId: idGenerator(),
      now: () => 1,
      permissionTimeoutMs: 1,
    });
    const tool: MakaTool = {
      name: 'Write',
      description: 'write file',
      parameters: {},
      permissionRequired: true,
      impl: async () => {
        implCalled = true;
        return { ok: true };
      },
    };
    (backend as unknown as {
      currentWatchdog: { pause(): void; resume(): void };
    }).currentWatchdog = {
      pause: () => {
        pauseCount += 1;
      },
      resume: () => {
        resumeCount += 1;
      },
    };

    const execute = (backend as unknown as {
      wrapToolExecute(
        tool: MakaTool,
        turnId: string,
        queue: { push(event: SessionEvent): void },
      ): (args: unknown, ctx: { toolCallId: string; abortSignal: AbortSignal }) => Promise<unknown>;
    }).wrapToolExecute(tool, 'turn-1', { push: (event) => events.push(event) });

    const result = await execute(
      { path: 'notes.md', content: 'hello' },
      { toolCallId: 'tool-1', abortSignal: new AbortController().signal },
    );
    const permissionRequest = events.find((event) => event.type === 'permission_request') as
      | Extract<SessionEvent, { type: 'permission_request' }>
      | undefined;
    const toolResult = events.find((event) => event.type === 'tool_result') as
      | Extract<SessionEvent, { type: 'tool_result' }>
      | undefined;

    assert.equal(implCalled, false);
    assert.equal(pauseCount, 1);
    assert.equal(resumeCount, 1);
    assert.equal(permissionEngine.pendingCount('turn-1'), 0);
    assert.equal(permissionEngine.recordResponse('turn-1', {
      requestId: permissionRequest?.requestId ?? 'missing',
      decision: 'allow',
    }), null);
    assert.match((result as { error?: string }).error ?? '', /Permission flow aborted/);
    assert.match((result as { error?: string }).error ?? '', /timed out/);
    assert.equal(toolResult?.isError, true);
    assert.equal(
      messages.some((message) =>
        (message as { type?: string; toolUseId?: string; isError?: boolean }).type === 'tool_result' &&
        (message as { toolUseId?: string }).toolUseId === 'tool-1' &&
        (message as { isError?: boolean }).isError === true,
      ),
      true,
    );
  });

  test('permission denial records decision ack, resumes watchdog, and never runs impl', async () => {
    const messages: unknown[] = [];
    const events: SessionEvent[] = [];
    const permissionEngine = new PermissionEngine({ newId: idGenerator(), now: () => 1 });
    let implCalled = false;
    let pauseCount = 0;
    let resumeCount = 0;
    const backend = new AiSdkBackend({
      sessionId: 'session-1',
      header: header('ask'),
      appendMessage: async (message) => {
        messages.push(message);
      },
      connection: connection(),
      apiKey: 'sk-test',
      modelId: 'claude-sonnet-4-5-20250929',
      permissionEngine,
      modelFactory: () => ({}),
      tools: [],
      newId: idGenerator(),
      now: () => 1,
      permissionTimeoutMs: 1_000,
    });
    const tool: MakaTool = {
      name: 'Write',
      description: 'write file',
      parameters: {},
      permissionRequired: true,
      impl: async () => {
        implCalled = true;
        return { ok: true };
      },
    };
    (backend as unknown as {
      currentWatchdog: { pause(): void; resume(): void };
    }).currentWatchdog = {
      pause: () => {
        pauseCount += 1;
      },
      resume: () => {
        resumeCount += 1;
      },
    };
    const execute = (backend as unknown as {
      wrapToolExecute(
        tool: MakaTool,
        turnId: string,
        queue: { push(event: SessionEvent): void },
      ): (args: unknown, ctx: { toolCallId: string; abortSignal: AbortSignal }) => Promise<unknown>;
    }).wrapToolExecute(tool, 'turn-1', { push: (event) => events.push(event) });

    const pending = execute(
      { path: 'notes.md', content: 'hello' },
      { toolCallId: 'tool-1', abortSignal: new AbortController().signal },
    );
    await waitFor(() => events.some((event) => event.type === 'permission_request'));
    const request = events.find((event) => event.type === 'permission_request') as
      | Extract<SessionEvent, { type: 'permission_request' }>
      | undefined;
    assert.ok(request);

    const accepted = permissionEngine.recordResponse('turn-1', {
      requestId: request.requestId,
      decision: 'deny',
      rememberForTurn: true,
    });
    assert.ok(accepted);
    const result = await pending;

    assert.equal(implCalled, false);
    assert.equal(pauseCount, 1);
    assert.equal(resumeCount, 1);
    assert.deepEqual(result, { error: '用户已拒绝权限请求' });
    assert.equal(messages.some((message) => (message as { type?: string }).type === 'tool_call'), true);
    assert.equal(
      messages.some((message) =>
        (message as { type?: string; decision?: string; rememberForTurn?: boolean }).type === 'permission_decision' &&
        (message as { decision?: string }).decision === 'deny' &&
        (message as { rememberForTurn?: boolean }).rememberForTurn === true,
      ),
      true,
    );
    assert.equal(
      events.some((event) =>
        event.type === 'permission_decision_ack' &&
        event.decision === 'deny' &&
        event.rememberForTurn === true,
      ),
      true,
    );
    assert.equal(
      events.some((event) => event.type === 'tool_result' && event.toolUseId === 'tool-1' && event.isError === true),
      true,
    );
  });

  test('tool failure telemetry classifies and redacts generic implementation errors', async () => {
    const messages: unknown[] = [];
    const events: SessionEvent[] = [];
    const telemetry: Array<{ status: string; errorClass?: string; bytesOut: number }> = [];
    const backend = new AiSdkBackend({
      sessionId: 'session-1',
      header: header('ask'),
      appendMessage: async (message) => {
        messages.push(message);
      },
      connection: connection(),
      apiKey: 'sk-test',
      modelId: 'claude-sonnet-4-5-20250929',
      permissionEngine: new PermissionEngine({ newId: () => 'permission-id', now: () => 1 }),
      modelFactory: () => ({}),
      tools: [],
      newId: idGenerator(),
      now: monotonicClock(),
      recordToolInvocation: (record) => {
        telemetry.push({
          status: record.status,
          errorClass: record.errorClass,
          bytesOut: record.bytesOut ?? 0,
        });
      },
    });
    const tool: MakaTool = {
      name: 'Write',
      description: 'write file',
      parameters: {},
      permissionRequired: false,
      impl: async () => {
        const error = new Error('401 Authorization: Bearer sk-live-secret-token-value');
        Object.assign(error, { code: 401 });
        throw error;
      },
    };
    const execute = (backend as unknown as {
      wrapToolExecute(
        tool: MakaTool,
        turnId: string,
        queue: { push(event: SessionEvent): void },
      ): (args: unknown, ctx: { toolCallId: string; abortSignal: AbortSignal }) => Promise<unknown>;
    }).wrapToolExecute(tool, 'turn-1', { push: (event) => events.push(event) });

    const result = await execute(
      { path: 'notes.md', content: 'hello' },
      { toolCallId: 'tool-1', abortSignal: new AbortController().signal },
    );
    const resultText = (result as { error?: string }).error ?? '';
    const serialized = JSON.stringify({ messages, events, result });

    assert.match(resultText, /Authorization: Bearer \[redacted\]/);
    assert.equal(serialized.includes('sk-live-secret-token-value'), false);
    assert.equal(
      events.some((event) => event.type === 'tool_result' && event.toolUseId === 'tool-1' && event.isError === true),
      true,
    );
    assert.deepEqual(telemetry, [
      { status: 'error', errorClass: 'Auth', bytesOut: 0 },
    ]);
  });

  test('flushes output deltas before successful and failed tool results', async () => {
    const events: SessionEvent[] = [];
    const backend = new AiSdkBackend({
      sessionId: 'session-1',
      header: header('ask'),
      appendMessage: async () => {},
      connection: connection(),
      apiKey: 'sk-test',
      modelId: 'claude-sonnet-4-5-20250929',
      permissionEngine: new PermissionEngine({ newId: () => 'permission-id', now: () => 1 }),
      modelFactory: () => ({}),
      tools: [],
      newId: idGenerator(),
      now: monotonicClock(),
    });
    const successTool: MakaTool = {
      name: 'Streamer',
      description: 'streams output',
      parameters: {},
      permissionRequired: false,
      impl: async (_args, ctx) => {
        ctx.emitOutput('stdout', 'success chunk');
        return { ok: true };
      },
    };
    const failureTool: MakaTool = {
      name: 'Streamer',
      description: 'streams then fails',
      parameters: {},
      permissionRequired: false,
      impl: async (_args, ctx) => {
        ctx.emitOutput('stderr', 'failure chunk');
        throw new Error('tool failed');
      },
    };
    const wrap = (tool: MakaTool) => (backend as unknown as {
      wrapToolExecute(
        tool: MakaTool,
        turnId: string,
        queue: { push(event: SessionEvent): void },
      ): (args: unknown, ctx: { toolCallId: string; abortSignal: AbortSignal }) => Promise<unknown>;
    }).wrapToolExecute(tool, 'turn-1', { push: (event) => events.push(event) });

    await wrap(successTool)({}, {
      toolCallId: 'tool-success',
      abortSignal: new AbortController().signal,
    });
    await wrap(failureTool)({}, {
      toolCallId: 'tool-failure',
      abortSignal: new AbortController().signal,
    });
    const eventKeys = events.map((event) => `${event.type}:${'toolUseId' in event ? event.toolUseId : ''}`);

    assert.ok(
      eventKeys.indexOf('tool_output_delta:tool-success') <
      eventKeys.indexOf('tool_result:tool-success'),
      'successful tool output must flush before its result event',
    );
    assert.ok(
      eventKeys.indexOf('tool_output_delta:tool-failure') <
      eventKeys.indexOf('tool_result:tool-failure'),
      'failed tool output must flush before its result event',
    );
  });

  test('passes categoryHint through PermissionEngine before tool execution', async () => {
    const messages: unknown[] = [];
    const events: SessionEvent[] = [];
    const backend = new AiSdkBackend({
      sessionId: 'session-1',
      header: header('explore'),
      appendMessage: async (message) => {
        messages.push(message);
      },
      connection: connection(),
      apiKey: 'sk-test',
      modelId: 'claude-sonnet-4-5-20250929',
      permissionEngine: new PermissionEngine({ newId: () => 'permission-id', now: () => 1 }),
      modelFactory: () => ({}),
      tools: [],
      newId: idGenerator(),
      now: () => 1,
    });
    const tool: MakaTool = {
      name: 'ExploreAgent',
      description: 'read-only worker',
      parameters: {},
      permissionRequired: true,
      categoryHint: 'subagent',
      impl: async () => ({ ok: true }),
    };

    const execute = (backend as unknown as {
      wrapToolExecute(
        tool: MakaTool,
        turnId: string,
        queue: { push(event: SessionEvent): void },
      ): (args: unknown, ctx: { toolCallId: string; abortSignal: AbortSignal }) => Promise<unknown>;
    }).wrapToolExecute(tool, 'turn-1', { push: (event) => events.push(event) });

    const result = await execute({ objective: 'map PawWork subagent lifecycle' }, {
      toolCallId: 'tool-1',
      abortSignal: new AbortController().signal,
    });

    assert.deepEqual(result, { ok: true });
    assert.equal(events.some((event) => event.type === 'permission_request'), false);
    assert.equal(messages.some((message) => (message as { type?: string }).type === 'tool_result'), true);
    assert.equal(
      (messages.find((message) => (message as { type?: string }).type === 'tool_call') as { intent?: string } | undefined)?.intent,
      '只读探索：map PawWork subagent lifecycle',
    );
    assert.equal(
      (events.find((event) => event.type === 'tool_start') as { intent?: string } | undefined)?.intent,
      '只读探索：map PawWork subagent lifecycle',
    );
  });

  test('pauses stream watchdog while a foreground subagent tool is running', async () => {
    const backend = new AiSdkBackend({
      sessionId: 'session-1',
      header: header('explore'),
      appendMessage: async () => {},
      connection: connection(),
      apiKey: 'sk-test',
      modelId: 'claude-sonnet-4-5-20250929',
      permissionEngine: new PermissionEngine({ newId: () => 'permission-id', now: () => 1 }),
      modelFactory: () => ({}),
      tools: [],
      newId: idGenerator(),
      now: () => 1,
    });
    let pauseCount = 0;
    let resumeCount = 0;
    (backend as unknown as {
      currentWatchdog: { pause(): void; resume(): void };
    }).currentWatchdog = {
      pause: () => {
        pauseCount += 1;
      },
      resume: () => {
        resumeCount += 1;
      },
    };
    let release!: () => void;
    const tool: MakaTool = {
      name: 'agent_spawn',
      description: 'spawn child agent',
      parameters: {},
      permissionRequired: true,
      categoryHint: 'subagent',
      impl: async () => new Promise((resolve) => {
        release = () => resolve({ kind: 'subagent', agentName: 'Researcher', turnId: 'child-turn', status: 'completed', permissionMode: 'explore', summary: 'done', artifactIds: [] });
      }),
    };
    const execute = (backend as unknown as {
      wrapToolExecute(
        tool: MakaTool,
        turnId: string,
        queue: { push(event: SessionEvent): void },
      ): (args: unknown, ctx: { toolCallId: string; abortSignal: AbortSignal }) => Promise<unknown>;
    }).wrapToolExecute(tool, 'turn-1', { push: () => {} });

    const pending = execute({}, {
      toolCallId: 'tool-1',
      abortSignal: new AbortController().signal,
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.equal(pauseCount, 1);
    assert.equal(resumeCount, 0);
    release();
    await pending;
    assert.equal(resumeCount, 1);
  });

  test('pauses stream watchdog while a regular (non-subagent) tool is running', async () => {
    // A long Bash command (apt-get install, a build) must not trip the model
    // stream idle timeout: the model is between steps while the tool runs.
    const backend = new AiSdkBackend({
      sessionId: 'session-1',
      header: header('explore'),
      appendMessage: async () => {},
      connection: connection(),
      apiKey: 'sk-test',
      modelId: 'claude-sonnet-4-5-20250929',
      permissionEngine: new PermissionEngine({ newId: () => 'permission-id', now: () => 1 }),
      modelFactory: () => ({}),
      tools: [],
      newId: idGenerator(),
      now: () => 1,
    });
    let pauseCount = 0;
    let resumeCount = 0;
    (backend as unknown as {
      currentWatchdog: { pause(): void; resume(): void };
    }).currentWatchdog = {
      pause: () => {
        pauseCount += 1;
      },
      resume: () => {
        resumeCount += 1;
      },
    };
    let release!: () => void;
    const tool: MakaTool = {
      name: 'Bash',
      description: 'run a shell command',
      parameters: {},
      permissionRequired: false,
      impl: async () => new Promise((resolve) => {
        release = () => resolve({ kind: 'terminal', cwd: '/app', cmd: 'sleep 300', exitCode: 0, stdout: '', stderr: '' });
      }),
    };
    const execute = (backend as unknown as {
      wrapToolExecute(
        tool: MakaTool,
        turnId: string,
        queue: { push(event: SessionEvent): void },
      ): (args: unknown, ctx: { toolCallId: string; abortSignal: AbortSignal }) => Promise<unknown>;
    }).wrapToolExecute(tool, 'turn-1', { push: () => {} });

    const pending = execute({}, {
      toolCallId: 'tool-1',
      abortSignal: new AbortController().signal,
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.equal(pauseCount, 1);
    assert.equal(resumeCount, 0);
    release();
    await pending;
    assert.equal(resumeCount, 1);
  });

  test('caps concurrent read-only subagent tools in one turn', async () => {
    const messages: unknown[] = [];
    const events: SessionEvent[] = [];
    const backend = new AiSdkBackend({
      sessionId: 'session-1',
      header: header('explore'),
      appendMessage: async (message) => {
        messages.push(message);
      },
      connection: connection(),
      apiKey: 'sk-test',
      modelId: 'claude-sonnet-4-5-20250929',
      permissionEngine: new PermissionEngine({ newId: () => 'permission-id', now: () => 1 }),
      modelFactory: () => ({}),
      tools: [],
      newId: idGenerator(),
      now: () => 1,
    });
    let implStarted = 0;
    const release: Array<() => void> = [];
    const tool: MakaTool = {
      name: 'ExploreAgent',
      description: 'read-only worker',
      parameters: {},
      permissionRequired: true,
      categoryHint: 'subagent',
      impl: async () => {
        implStarted += 1;
        return new Promise((resolve) => {
          release.push(() => resolve({ ok: true }));
        });
      },
    };
    const execute = (backend as unknown as {
      wrapToolExecute(
        tool: MakaTool,
        turnId: string,
        queue: { push(event: SessionEvent): void },
      ): (args: unknown, ctx: { toolCallId: string; abortSignal: AbortSignal }) => Promise<unknown>;
    }).wrapToolExecute(tool, 'turn-1', { push: (event) => events.push(event) });

    const pending = Array.from({ length: MAX_ACTIVE_SUBAGENT_TOOLS_PER_TURN }, (_, index) => execute(
      { objective: `research ${index}` },
      { toolCallId: `tool-${index}`, abortSignal: new AbortController().signal },
    ));
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(implStarted, MAX_ACTIVE_SUBAGENT_TOOLS_PER_TURN);

    const rejected = await execute(
      { objective: 'overflow' },
      { toolCallId: 'tool-overflow', abortSignal: new AbortController().signal },
    );
    assert.deepEqual(rejected, {
      error: '只读探索并发过多：同一轮最多 5 个子代理。请等待已有探索完成后再继续。',
    });
    assert.equal(implStarted, MAX_ACTIVE_SUBAGENT_TOOLS_PER_TURN);
    assert.equal(events.some((event) => event.type === 'tool_result' && event.toolUseId === 'tool-overflow' && event.isError), true);
    assert.equal(JSON.stringify(messages).includes('tool-overflow'), true);

    release.forEach((resume) => resume());
    await Promise.all(pending);
  });

  test('maps structured subagent terminal states to persisted tool status', async () => {
    const messages: unknown[] = [];
    const events: SessionEvent[] = [];
    const telemetry: Array<{ status: string; toolCallId?: string }> = [];
    const backend = new AiSdkBackend({
      sessionId: 'session-1',
      header: header('explore'),
      appendMessage: async (message) => {
        messages.push(message);
      },
      connection: connection(),
      apiKey: 'sk-test',
      modelId: 'claude-sonnet-4-5-20250929',
      permissionEngine: new PermissionEngine({ newId: () => 'permission-id', now: () => 1 }),
      modelFactory: () => ({}),
      tools: [],
      newId: idGenerator(),
      now: () => 1,
      recordToolInvocation: (record) => {
        telemetry.push({ status: record.status, toolCallId: record.toolCallId });
      },
    });
    const tool: MakaTool = {
      name: 'ExploreAgent',
      description: 'read-only worker',
      parameters: {},
      permissionRequired: true,
      categoryHint: 'subagent',
      impl: async (args: unknown) => {
        const input = args as { reason?: string };
        return {
        kind: 'explore_agent',
        ok: false,
        mode: 'read_only',
        objective: 'bad scope',
        roots: [],
        queries: [],
        filesInspected: 0,
        filesSkipped: 0,
        bytesRead: 0,
        progress: [],
        candidateFiles: [],
        matches: [],
        notes: [],
          reason: input.reason === 'aborted' ? 'aborted' : 'invalid_root',
          message: input.reason === 'aborted' ? '只读探索已取消。' : '范围无效。',
        };
      },
    };
    const execute = (backend as unknown as {
      wrapToolExecute(
        tool: MakaTool,
        turnId: string,
        queue: { push(event: SessionEvent): void },
      ): (args: unknown, ctx: { toolCallId: string; abortSignal: AbortSignal }) => Promise<unknown>;
    }).wrapToolExecute(tool, 'turn-1', { push: (event) => events.push(event) });

    await execute({ objective: 'bad scope' }, {
      toolCallId: 'tool-failed',
      abortSignal: new AbortController().signal,
    });
    await execute({ objective: 'cancelled', reason: 'aborted' }, {
      toolCallId: 'tool-aborted',
      abortSignal: new AbortController().signal,
    });

    assert.equal(
      (messages.find((message) =>
        (message as { type?: string; toolUseId?: string }).type === 'tool_result' &&
        (message as { toolUseId?: string }).toolUseId === 'tool-failed',
      ) as { isError?: boolean } | undefined)?.isError,
      true,
    );
    assert.equal(
      (events.find((event) => event.type === 'tool_result' && event.toolUseId === 'tool-aborted') as { isError?: boolean } | undefined)?.isError,
      true,
    );
    assert.deepEqual(telemetry, [
      { status: 'error', toolCallId: 'tool-failed' },
      { status: 'aborted', toolCallId: 'tool-aborted' },
    ]);
  });

  test('maps foreground subagent terminal states to persisted tool status', async () => {
    const messages: unknown[] = [];
    const events: SessionEvent[] = [];
    const telemetry: Array<{ status: string; toolCallId?: string }> = [];
    const backend = new AiSdkBackend({
      sessionId: 'session-1',
      header: header('explore'),
      appendMessage: async (message) => {
        messages.push(message);
      },
      connection: connection(),
      apiKey: 'sk-test',
      modelId: 'claude-sonnet-4-5-20250929',
      permissionEngine: new PermissionEngine({ newId: () => 'permission-id', now: () => 1 }),
      modelFactory: () => ({}),
      tools: [],
      newId: idGenerator(),
      now: () => 1,
      recordToolInvocation: (record) => {
        telemetry.push({ status: record.status, toolCallId: record.toolCallId });
      },
    });
    const tool: MakaTool = {
      name: 'agent_spawn',
      description: 'spawn read-only worker',
      parameters: {},
      permissionRequired: true,
      categoryHint: 'subagent',
      impl: async (args: unknown) => {
        const input = args as { status: 'completed' | 'failed' | 'cancelled' };
        return {
          kind: 'subagent',
          agentName: 'Researcher',
          turnId: `child-${input.status}`,
          status: input.status,
          permissionMode: 'explore',
          summary: input.status,
          artifactIds: [],
        };
      },
    };
    const execute = (backend as unknown as {
      wrapToolExecute(
        tool: MakaTool,
        turnId: string,
        queue: { push(event: SessionEvent): void },
      ): (args: unknown, ctx: { toolCallId: string; abortSignal: AbortSignal }) => Promise<unknown>;
    }).wrapToolExecute(tool, 'turn-1', { push: (event) => events.push(event) });

    await execute({ status: 'failed' }, {
      toolCallId: 'tool-failed',
      abortSignal: new AbortController().signal,
    });
    await execute({ status: 'cancelled' }, {
      toolCallId: 'tool-cancelled',
      abortSignal: new AbortController().signal,
    });
    await execute({ status: 'completed' }, {
      toolCallId: 'tool-completed',
      abortSignal: new AbortController().signal,
    });

    assert.equal(
      (messages.find((message) =>
        (message as { type?: string; toolUseId?: string }).type === 'tool_result' &&
        (message as { toolUseId?: string }).toolUseId === 'tool-failed'
      ) as { isError?: boolean } | undefined)?.isError,
      true,
    );
    assert.equal(
      (events.find((event) => event.type === 'tool_result' && event.toolUseId === 'tool-cancelled') as { isError?: boolean } | undefined)?.isError,
      true,
    );
    assert.equal(
      (events.find((event) => event.type === 'tool_result' && event.toolUseId === 'tool-completed') as { isError?: boolean } | undefined)?.isError,
      false,
    );
    assert.deepEqual(telemetry, [
      { status: 'error', toolCallId: 'tool-failed' },
      { status: 'aborted', toolCallId: 'tool-cancelled' },
      { status: 'success', toolCallId: 'tool-completed' },
    ]);
  });

  test('maps aborted OfficeDocument results to aborted tool telemetry', async () => {
    const events: SessionEvent[] = [];
    const telemetry: Array<{ status: string; toolCallId?: string }> = [];
    const backend = new AiSdkBackend({
      sessionId: 'session-1',
      header: header('ask'),
      appendMessage: async () => {},
      connection: connection(),
      apiKey: 'sk-test',
      modelId: 'claude-sonnet-4-5-20250929',
      permissionEngine: new PermissionEngine({ newId: () => 'permission-id', now: () => 1 }),
      modelFactory: () => ({}),
      tools: [],
      newId: idGenerator(),
      now: () => 1,
      recordToolInvocation: (record) => {
        telemetry.push({ status: record.status, toolCallId: record.toolCallId });
      },
    });
    const tool: MakaTool = {
      name: 'OfficeDocument',
      description: 'read office',
      parameters: {},
      permissionRequired: false,
      impl: async () => ({
        kind: 'office_document',
        ok: false,
        operation: 'view',
        path: 'slides.pptx',
        args: ['view', 'slides.pptx', 'outline'],
        reason: 'officecli_aborted',
        message: 'officecli 操作已取消。',
      }),
    };
    const execute = (backend as unknown as {
      wrapToolExecute(
        tool: MakaTool,
        turnId: string,
        queue: { push(event: SessionEvent): void },
      ): (args: unknown, ctx: { toolCallId: string; abortSignal: AbortSignal }) => Promise<unknown>;
    }).wrapToolExecute(tool, 'turn-1', { push: (event) => events.push(event) });

    await execute({ path: 'slides.pptx', operation: 'view' }, {
      toolCallId: 'tool-office-aborted',
      abortSignal: new AbortController().signal,
    });

    assert.equal(
      (events.find((event) => event.type === 'tool_result') as { isError?: boolean } | undefined)?.isError,
      true,
    );
    assert.deepEqual(telemetry, [
      { status: 'aborted', toolCallId: 'tool-office-aborted' },
    ]);
  });
});

describe('AiSdkBackend tool-call repair', () => {
  test('repairs provider tool-name case drift to the canonical Maka tool name', () => {
    const repaired = repairMakaToolCall({
      toolCall: {
        toolCallId: 'tool-1',
        toolName: 'bash',
        input: '{"command":"pwd"}',
      },
      availableToolNames: ['Bash', 'Read'],
      error: new Error('No such tool'),
    });

    assert.equal(repaired?.toolName, 'Bash');
    assert.equal(repaired?.input, '{"command":"pwd"}');
  });

  test('routes unrepairable tool calls into the structured invalid tool', () => {
    const repaired = repairMakaToolCall({
      toolCall: {
        toolCallId: 'tool-1',
        toolName: 'DeleteEverything',
        input: '{"path":"/"}',
      },
      availableToolNames: ['Bash', 'Read'],
      error: new Error('No such tool: Authorization: Bearer sk-live-secret-token-value'),
    });

    assert.equal(repaired?.toolName, INVALID_TOOL_NAME);
    const input = JSON.parse(repaired?.input ?? '{}') as { tool?: string; error?: string };
    assert.equal(input.tool, 'DeleteEverything');
    assert.match(input.error ?? '', /No such tool/);
    assert.equal((input.error ?? '').includes('sk-live-secret-token-value'), false);
  });

  test('does not recursively repair the internal invalid tool', () => {
    const repaired = repairMakaToolCall({
      toolCall: {
        toolCallId: 'tool-1',
        toolName: INVALID_TOOL_NAME,
        input: '{}',
      },
      availableToolNames: ['Bash', 'Read'],
      error: new Error('Invalid tool failed'),
    });

    assert.equal(repaired, null);
  });
});

describe('AiSdkBackend loop-gate turn wiring', () => {
  test('send() resets ToolRuntime per turn (at turn start and at cleanup)', async () => {
    const model = completionModel();
    const backend = new AiSdkBackend({
      sessionId: 'session-1',
      header: header(),
      appendMessage: async () => {},
      connection: connection(),
      apiKey: 'sk-test',
      modelId: 'mock-model-id',
      permissionEngine: new PermissionEngine({ newId: () => 'permission-id', now: () => 1 }),
      modelFactory: () => model,
      tools: [],
      newId: idGenerator(),
      now: monotonicClock(),
    });

    // Spy on the real ToolRuntime the backend already constructed, counting how
    // many times send() resets it during one completed turn.
    const runtime = (backend as unknown as { toolRuntime: { resetTurnState: () => void } }).toolRuntime;
    const original = runtime.resetTurnState.bind(runtime);
    let resets = 0;
    runtime.resetTurnState = () => { resets += 1; original(); };

    await drain(backend.send({ turnId: 'turn-1', text: 'hi', context: [] }));

    // A completed turn resets the per-turn ToolRuntime state twice: once at the
    // START of the turn (so the loop-gate failure streak, subagent count, and
    // gating never carry over from the previous turn's teardown) and once at the
    // END via cleanupAfterTurn(). Removing the start-of-turn reset drops this to 1
    // and fails — which is what proves the wiring the ToolRuntime unit test alone
    // cannot.
    assert.equal(resets, 2, 'resetTurnState runs at turn start and at cleanup');
  });
});

async function runArchiveGatedReplay(input: {
  query: string;
  selectedResult: unknown;
  unselectedResult: unknown;
  selectedPath: string;
  unselectedPath: string;
  selectedAfterUnselected?: boolean;
}): Promise<{
  prompt: string;
  readRuntimeEventIds: string[];
  usage: Extract<SessionEvent, { type: 'token_usage' }> | undefined;
}> {
  const model = completionModel();
  const events: SessionEvent[] = [];
  const archivedBodies = new Map<string, string>();
  const readRuntimeEventIds: string[] = [];
  const backend = new AiSdkBackend({
    sessionId: 'session-1',
    header: header(),
    appendMessage: async () => {},
    connection: connection(),
    apiKey: 'sk-test',
    modelId: 'mock-model-id',
    permissionEngine: new PermissionEngine({ newId: () => 'permission-id', now: () => 1 }),
    modelFactory: () => model,
    tools: [],
    newId: idGenerator(),
    now: monotonicClock(),
    contextBudget: {
      name: 'archive-retrieval-gated-test',
      maxHistoryTurns: 1,
      minRecentTurns: 0,
      staleToolResultPrune: {
        enabled: true,
        maxResultEstimatedTokens: 1,
        minRecentTurnsFull: 0,
      },
      archiveRetrieval: {
        enabled: true,
        mode: 'history_search_gated',
        maxResults: 2,
        maxEstimatedTokens: 4096,
        maxBytes: 4096,
      },
      historySearch: {
        enabled: true,
        maxResults: 1,
        around: 1,
        maxEstimatedTokens: 4096,
      },
      charsPerToken: 1,
    },
    archiveToolResult: async (event) => {
      archivedBodies.set(event.runtimeEventId, event.serializedResult);
      return { artifactId: `artifact-${event.runtimeEventId}` };
    },
    readToolResultArchive: async (event) => {
      readRuntimeEventIds.push(event.runtimeEventId);
      const body = archivedBodies.get(event.runtimeEventId);
      assert.ok(body);
      return event.bodySha256 === sha256(body)
        ? { ok: true, serializedResult: body }
        : { ok: false, reason: 'corrupt' };
    },
  });
  const selectedEvents = archiveGatedTurnEvents('a', input.selectedPath, input.selectedResult);
  const unselectedEvents = archiveGatedTurnEvents('b', input.unselectedPath, input.unselectedResult);
  const runtimeContext = [
    ...(input.selectedAfterUnselected ? unselectedEvents : selectedEvents),
    ...(input.selectedAfterUnselected ? selectedEvents : unselectedEvents),
    runtimeTextEvent({
      id: 'rt-new',
      turnId: 'turn-new',
      role: 'user',
      author: 'user',
      text: 'newer retained context',
    }),
  ];

  for await (const event of backend.send({
    turnId: 'turn-current',
    text: input.query,
    context: [],
    runtimeContext,
  })) {
    events.push(event);
  }

  const prompt = JSON.stringify(compactPrompt(model));
  if (typeof prompt !== 'string') assert.fail('model prompt was not captured');
  const usage = events.find((event): event is Extract<SessionEvent, { type: 'token_usage' }> =>
    event.type === 'token_usage'
  );
  return { prompt, readRuntimeEventIds, usage };
}

function archiveGatedTurnEvents(
  suffix: 'a' | 'b',
  path: string,
  result: unknown,
): RuntimeEvent[] {
  return [
    runtimeEvent({
      id: `rt-call-${suffix}`,
      turnId: `turn-${suffix}`,
      role: 'model',
      author: 'agent',
      content: { kind: 'function_call', id: `tool-${suffix}`, name: 'Read', args: { path } },
    }),
    runtimeEvent({
      id: `rt-result-${suffix}`,
      turnId: `turn-${suffix}`,
      role: 'tool',
      author: 'tool',
      content: { kind: 'function_response', id: `tool-${suffix}`, name: 'Read', result, isError: false },
    }),
  ];
}

function textCompletionModel(text: string): MockLanguageModelV3 {
  const chunks: LanguageModelV3StreamPart[] = [
    { type: 'stream-start', warnings: [] },
    { type: 'text-start', id: 'text-1' },
    { type: 'text-delta', id: 'text-1', delta: text },
    { type: 'text-end', id: 'text-1' },
    {
      type: 'finish',
      finishReason: { unified: 'stop', raw: 'stop' },
      usage: {
        inputTokens: {
          total: 1,
          noCache: 1,
          cacheRead: 0,
          cacheWrite: 0,
        },
        outputTokens: {
          total: 1,
          text: 1,
          reasoning: 0,
        },
      },
    },
  ];
  return new MockLanguageModelV3({
    doStream: {
      stream: simulateReadableStream({
        chunks,
        initialDelayInMs: null,
        chunkDelayInMs: null,
      }),
    },
  });
}

function completionModel(): MockLanguageModelV3 {
  const chunks: LanguageModelV3StreamPart[] = [
    { type: 'stream-start', warnings: [] },
    {
      type: 'finish',
      finishReason: { unified: 'stop', raw: 'stop' },
      usage: {
        inputTokens: {
          total: 1,
          noCache: 1,
          cacheRead: 0,
          cacheWrite: 0,
        },
        outputTokens: {
          total: 1,
          text: 1,
          reasoning: 0,
        },
      },
    },
  ];
  return new MockLanguageModelV3({
    doStream: {
      stream: simulateReadableStream({
        chunks,
        initialDelayInMs: null,
        chunkDelayInMs: null,
      }),
    },
  });
}

function runtimeTextEvent(input: {
  id: string;
  turnId: string;
  role: 'user' | 'model';
  author: 'user' | 'agent';
  text: string;
}): RuntimeEvent {
  return {
    id: input.id,
    invocationId: 'inv-1',
    runId: 'run-prev',
    sessionId: 'session-1',
    turnId: input.turnId,
    ts: 1,
    partial: false,
    role: input.role,
    author: input.author,
    content: { kind: 'text', text: input.text },
  };
}

function runtimeEvent(input: {
  id: string;
  turnId: string;
  role: RuntimeEvent['role'];
  author: RuntimeEvent['author'];
  content?: RuntimeEvent['content'];
  status?: RuntimeEvent['status'];
  actions?: RuntimeEvent['actions'];
}): RuntimeEvent {
  return {
    id: input.id,
    invocationId: 'inv-1',
    runId: 'run-prev',
    sessionId: 'session-1',
    turnId: input.turnId,
    ts: 1,
    partial: false,
    role: input.role,
    author: input.author,
    ...(input.content ? { content: input.content } : {}),
    ...(input.status ? { status: input.status } : {}),
    ...(input.actions ? { actions: input.actions } : {}),
  };
}

function synthesisBlock(input: {
  queryKey: string;
  turnId: string;
  runtimeEventId: string;
  toolCallId: string;
  artifactId: string;
  bodySha256: string;
  originalEstimatedTokens: number;
  originalBytes: number;
}): SynthesisCacheBlock {
  return {
    kind: 'maka.synthesis_cache_block',
    version: 1,
    blockId: `synth-${input.queryKey}`,
    sessionId: 'session-1',
    createdAt: 2,
    highWaterName: `after-gated-${input.queryKey}`,
    highWaterSeq: 1,
    coverage: {
      queryKeys: [input.queryKey],
      turnIds: [input.turnId],
      runtimeEventIds: [input.runtimeEventId],
      toolNames: ['Read'],
      toolCallIds: [input.toolCallId],
      artifactIds: [input.artifactId],
      bodySha256: [input.bodySha256],
    },
    summary: 'SYNTHESIS_SENTINEL_KEY_ALPHA',
    limitations: ['Does not include raw tool output.'],
    sourceRefs: [{
      kind: 'archived_tool_result',
      sessionId: 'session-1',
      turnId: input.turnId,
      runtimeEventId: input.runtimeEventId,
      toolCallId: input.toolCallId,
      toolName: 'Read',
      artifactId: input.artifactId,
      bodySha256: input.bodySha256,
      originalEstimatedTokens: input.originalEstimatedTokens,
      originalBytes: input.originalBytes,
      placeholderReason: 'stale_tool_result_pruned_before_compact',
    }],
    createdFrom: 'gated_archive_retrieval',
  };
}

function compactPrompt(model: MockLanguageModelV3): unknown {
  return model.doStreamCalls[0]?.prompt.map((message) => ({
    role: message.role,
    content: message.content,
  }));
}

function activeFullCompactBlockFixture(): ActiveFullCompactBlock {
  return {
    kind: 'maka.active_full_compact_block',
    version: 1,
    blockId: 'afcompact-sync-test',
    sessionId: 'session-1',
    turnId: 'turn-1',
    createdAt: 1_001,
    highWaterName: 'sync-test',
    highWaterSeq: 1,
    trigger: {
      reason: 'manual_test',
      stepNumber: 2,
      estimatedTokensBefore: 100,
      thresholdTokens: 50,
    },
    coverage: {
      turnIds: ['turn-1'],
      runtimeEventIds: ['runtime-event-1'],
      providerMessageSourceIds: ['provider-message:0'],
      toolCallIds: [],
      contentKinds: ['text'],
      bodySha256: ['sha256-sync-test'],
    },
    summary: {
      schemaVersion: 1,
      text: 'persist synchronously before the next provider request',
    },
    limitations: [],
    sourceRefs: [{
      kind: 'provider_message',
      sourceId: 'provider-message:0',
      messageIndex: 0,
      sessionId: 'session-1',
      turnId: 'turn-1',
      runtimeEventId: 'runtime-event-1',
      contentKind: 'text',
      bodySha256: 'sha256-sync-test',
    }],
  };
}

function countActiveFullCompactMarkers(text: string): number {
  return text.match(/<maka_active_full_compact_block/g)?.length ?? 0;
}

function modelCallSettings(model: MockLanguageModelV3): unknown {
  const call = model.doStreamCalls[0] as unknown as Record<string, unknown> | undefined;
  if (!call) return {};
  const { prompt: _prompt, ...rest } = call;
  return rest;
}

function modelToolNames(model: MockLanguageModelV3): string[] {
  return sortedModelToolNames(Object.keys(modelTools(model)));
}

function modelTools(model: MockLanguageModelV3): Record<string, unknown> {
  const call = model.doStreamCalls[0] as unknown as Record<string, unknown> | undefined;
  const tools = call?.tools;
  if (!tools) return {};
  if (Array.isArray(tools)) {
    const out: Record<string, unknown> = {};
    for (const tool of tools) {
      if (tool && typeof tool === 'object') {
        const record = tool as Record<string, unknown>;
        const name = typeof record.name === 'string'
          ? record.name
          : typeof record.toolName === 'string'
            ? record.toolName
            : undefined;
        if (name) out[name] = tool;
      }
    }
    return out;
  }
  if (typeof tools === 'object') return tools as Record<string, unknown>;
  return {};
}

function sortedModelToolNames(toolNames: readonly string[]): string[] {
  return [...toolNames].sort((a, b) => {
    if (a === INVALID_TOOL_NAME) return 1;
    if (b === INVALID_TOOL_NAME) return -1;
    return a.localeCompare(b);
  });
}

function toolSchemaPromptSegment(record: LlmCallRecord | undefined): { toolCount?: number } | undefined {
  return record?.promptSegments?.find((segment) => segment.kind === 'tool_schema');
}

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

function utf8Bytes(text: string): number {
  return Buffer.byteLength(text, 'utf8');
}

function testTool(name: string, parameters: unknown): MakaTool {
  return {
    name,
    description: `${name} description`,
    parameters,
    permissionRequired: false,
    impl: async () => ({ ok: true }),
  };
}

async function drain(iterable: AsyncIterable<unknown>): Promise<void> {
  for await (const _ of iterable) {
    // consume
  }
}

function makeGate(): { promise: Promise<void>; release: () => void } {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

function header(permissionMode: SessionHeader['permissionMode'] = 'ask'): SessionHeader {
  return {
    id: 'session-1',
    workspaceRoot: '/tmp/maka',
    cwd: '/tmp/maka',
    createdAt: 1,
    lastUsedAt: 1,
    name: 'Test',
    isFlagged: false,
    labels: [],
    isArchived: false,
    status: 'active',
    statusUpdatedAt: 1,
    hasUnread: false,
    backend: 'ai-sdk',
    llmConnectionSlug: 'anthropic-main',
    connectionLocked: true,
    model: 'claude-sonnet-4-5-20250929',
    permissionMode,
    schemaVersion: 1,
  };
}

function connection(): LlmConnection {
  return {
    slug: 'anthropic-main',
    name: 'Anthropic',
    providerType: 'anthropic',
    defaultModel: 'claude-sonnet-4-5-20250929',
    enabled: true,
    createdAt: 1,
    updatedAt: 1,
  };
}

function idGenerator(): () => string {
  let index = 0;
  return () => `id-${++index}`;
}

function monotonicClock(): () => number {
  let value = 1_000;
  return () => ++value;
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  assert.fail('condition was not met before timeout');
}
