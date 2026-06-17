import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { z } from 'zod';
import { MockLanguageModelV3, convertArrayToReadableStream } from 'ai/test';
import type { LanguageModelV3StreamPart, LanguageModelV3Usage } from '@ai-sdk/provider';
import type { LlmConnection, SessionHeader } from '@maka/core';
import type { LlmCallRecord } from '@maka/core/usage-stats/types';
import type { RuntimeEvent } from '@maka/core/runtime-event';

import { AiSdkBackend, type MakaTool } from '../ai-sdk-backend.js';
import { PermissionEngine } from '../permission-engine.js';
import { buildLoadTool, type DeferredToolCatalog } from '../load-tool.js';
import { canonicalizeToolSet, toolSchemaCharsForDiagnostics } from '../request-shape.js';

// End-to-end through the live AiSdkBackend: the deferred catalog drives the
// per-step prepareStep activation, the durable seed reconstructs prior-turn
// loads, and the execute-boundary guard is fed by the live snapshot.

const ZERO_USAGE: LanguageModelV3Usage = {
  inputTokens: { total: 0, noCache: 0, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 0, text: 0, reasoning: 0 },
};

const catalog: DeferredToolCatalog = [
  { namespace: 'browser', summary: 'Browser automation', toolNames: ['browser_click'] },
];

function tools(implCalls: string[]): MakaTool[] {
  return [
    { name: 'Read', description: 'Read', parameters: z.object({ path: z.string().optional() }), permissionRequired: false, impl: () => ({ ok: true }) },
    buildLoadTool(catalog),
    {
      name: 'browser_click',
      description: 'Click in the browser',
      parameters: z.object({}),
      exposure: 'deferred',
      permissionRequired: false,
      impl: () => { implCalls.push('browser_click'); return { ok: true }; },
    },
  ];
}

interface BackendOpts {
  /** Override the deferred catalog (pass `null` to omit it entirely). */
  deferredCatalog?: DeferredToolCatalog | null;
  recordLlmCall?: (record: LlmCallRecord) => void;
}

function backend(model: MockLanguageModelV3, implCalls: string[], opts: BackendOpts = {}): AiSdkBackend {
  let n = 0;
  const resolvedCatalog = opts.deferredCatalog === null ? undefined : opts.deferredCatalog ?? catalog;
  return new AiSdkBackend({
    sessionId: 'session-1',
    header: header(),
    appendMessage: async () => {},
    connection: connection(),
    apiKey: 'sk-test',
    modelId: 'mock-model-id',
    permissionEngine: new PermissionEngine({ newId: () => 'perm', now: () => 1 }),
    modelFactory: () => model,
    tools: tools(implCalls),
    ...(resolvedCatalog ? { deferredCatalog: resolvedCatalog } : {}),
    ...(opts.recordLlmCall ? { recordLlmCall: opts.recordLlmCall } : {}),
    newId: () => `id-${++n}`,
    now: () => 1,
  });
}

describe('AiSdkBackend deferred tool loading', () => {
  test('step 0 hides an unloaded deferred tool but advertises load_tool', async () => {
    const captured: string[][] = [];
    const implCalls: string[] = [];
    await drain(backend(capturingModel(captured), implCalls).send({
      turnId: 'turn-1',
      text: 'hi',
      context: [],
    }));
    assert.ok(captured[0].includes('Read'), 'direct Read advertised');
    assert.ok(captured[0].includes('load_tool'), 'load_tool advertised');
    assert.ok(!captured[0].includes('browser_click'), 'unloaded deferred browser_click hidden');
  });

  test('durable seed: a prior-turn load_tool re-advertises the tool at the next turn (Slice 7)', async () => {
    const captured: string[][] = [];
    const implCalls: string[] = [];
    await drain(backend(capturingModel(captured), implCalls).send({
      turnId: 'turn-2',
      text: 'click it',
      context: [],
      runtimeContext: priorBrowserLoad('turn-1'),
    }));
    assert.ok(
      captured[0].includes('browser_click'),
      'browser_click must be advertised at turn 2 step 0 because it was loaded in turn 1',
    );
  });

  test('guard: same-step parallel load_tool(browser)+browser_click rejects the click (Slice 5 live)', async () => {
    const captured: string[][] = [];
    const implCalls: string[] = [];
    await drain(backend(parallelLoadUseModel(captured), implCalls).send({
      turnId: 'turn-1',
      text: 'load and click in one step',
      context: [],
    }));
    assert.equal(captured.length, 2, 'expected two steps (parallel call step, then a final step)');
    assert.ok(!captured[0].includes('browser_click'), 'browser_click is not advertised at step 0');
    assert.deepEqual(
      implCalls,
      [],
      'the real browser_click impl must never run when it was used before activation',
    );
  });

  test('diagnostics: a same-turn load is reflected in the recorded tool-schema cost (GPT-Pro P2)', async () => {
    const records: LlmCallRecord[] = [];
    const implCalls: string[] = [];
    // step 0 loads browser; browser_click activates at step 1 via prepareStep.
    await drain(backend(loadBrowserThenFinishModel(), implCalls, {
      recordLlmCall: (r) => records.push(r),
    }).send({ turnId: 'turn-1', text: 'load browser', context: [] }));

    assert.equal(records.length, 1, 'exactly one llm-call cost record for the turn');
    const toolSeg = records[0].promptSegments?.find((s) => s.kind === 'tool_schema');
    assert.ok(toolSeg, 'a tool_schema prompt segment was recorded');

    // The recorded cost must reflect the FINAL active set (Read + load_tool +
    // browser_click), not the lean step-0 set — otherwise the load turn
    // under-reports the heavy schema it actually sent on step 1.
    const providerTools = canonicalizeToolSet(tools([]), INVALID_FIXTURE).providerTools;
    const leanChars = toolSchemaCharsForDiagnostics(providerTools, ['Read', 'load_tool']);
    const loadedChars = toolSchemaCharsForDiagnostics(providerTools, ['Read', 'load_tool', 'browser_click']);
    assert.ok(loadedChars > leanChars, 'sanity: the loaded set is heavier than the lean set');
    assert.equal(toolSeg.chars, loadedChars, 'recorded tool-schema chars include the loaded browser_click');
    assert.equal(
      records[0].requestShapeChangeReason,
      'first_turn',
      'first turn establishes the baseline; the expansion sets the durable prefix for next turn',
    );
  });

  test('no catalog: a deferred-tagged tool stays advertised (GPT-Pro P3)', async () => {
    const captured: string[][] = [];
    const implCalls: string[] = [];
    // No deferredCatalog ⇒ deferral is off ⇒ the contract is "advertise everything".
    await drain(backend(capturingModel(captured), implCalls, { deferredCatalog: null }).send({
      turnId: 'turn-1',
      text: 'hi',
      context: [],
    }));
    assert.ok(
      captured[0].includes('browser_click'),
      'a tool tagged exposure:deferred must still be advertised when no catalog is configured',
    );
  });

  test('repair: a mis-cased deferred call after a mid-turn load repairs to the canonical name (Codex [P2])', async () => {
    const captured: string[][] = [];
    const implCalls: string[] = [];
    await drain(backend(loadThenMiscasedClickModel(captured), implCalls).send({
      turnId: 'turn-1',
      text: 'load browser then click',
      context: [],
    }));
    // Step 0 loads browser; step 1 emits the mis-cased BROWSER_CLICK. Because the
    // repair list follows the current step's active snapshot (not the frozen
    // step-0 set), the call repairs to canonical browser_click and runs — rather
    // than routing to `invalid`, which would leave implCalls empty.
    assert.ok(captured.length >= 2, 'expected at least the load step and the click step');
    assert.ok(captured[1].includes('browser_click'), 'browser_click is advertised at step 1 after the load');
    assert.deepEqual(implCalls, ['browser_click'], 'the mis-cased call repaired to browser_click and ran');
  });
});

// ---------------------------------------------------------------------------
// Mock models
// ---------------------------------------------------------------------------

function capturingModel(captured: string[][]): MockLanguageModelV3 {
  return new MockLanguageModelV3({
    doStream: async ({ tools: stepTools }) => {
      captured.push((stepTools ?? []).map((t) => t.name));
      const parts: LanguageModelV3StreamPart[] = [
        { type: 'stream-start', warnings: [] },
        { type: 'finish', finishReason: { unified: 'stop', raw: 'stop' }, usage: ZERO_USAGE },
      ];
      return { stream: convertArrayToReadableStream(parts) };
    },
  });
}

function parallelLoadUseModel(captured: string[][]): MockLanguageModelV3 {
  return new MockLanguageModelV3({
    doStream: async ({ tools: stepTools }) => {
      captured.push((stepTools ?? []).map((t) => t.name));
      const first = captured.length === 1;
      const parts: LanguageModelV3StreamPart[] = first
        ? [
            { type: 'stream-start', warnings: [] },
            { type: 'tool-call', toolCallId: 'tc-load', toolName: 'load_tool', input: JSON.stringify({ namespace: 'browser' }) },
            { type: 'tool-call', toolCallId: 'tc-click', toolName: 'browser_click', input: JSON.stringify({}) },
            { type: 'finish', finishReason: { unified: 'tool-calls', raw: 'tool_calls' }, usage: ZERO_USAGE },
          ]
        : [
            { type: 'stream-start', warnings: [] },
            { type: 'finish', finishReason: { unified: 'stop', raw: 'stop' }, usage: ZERO_USAGE },
          ];
      return { stream: convertArrayToReadableStream(parts) };
    },
  });
}

/** Placeholder invalid tool — only used to build providerTools for char math. */
const INVALID_FIXTURE: MakaTool = {
  name: 'invalid',
  description: 'x',
  parameters: z.object({}),
  impl: () => ({}),
};

/** Step 0 loads the browser namespace, then the turn finishes (no use). */
function loadBrowserThenFinishModel(): MockLanguageModelV3 {
  let step = 0;
  return new MockLanguageModelV3({
    doStream: async () => {
      step += 1;
      const parts: LanguageModelV3StreamPart[] =
        step === 1
          ? [
              { type: 'stream-start', warnings: [] },
              { type: 'tool-call', toolCallId: 'tc-load', toolName: 'load_tool', input: JSON.stringify({ namespace: 'browser' }) },
              { type: 'finish', finishReason: { unified: 'tool-calls', raw: 'tool_calls' }, usage: ZERO_USAGE },
            ]
          : [
              { type: 'stream-start', warnings: [] },
              { type: 'finish', finishReason: { unified: 'stop', raw: 'stop' }, usage: ZERO_USAGE },
            ];
      return { stream: convertArrayToReadableStream(parts) };
    },
  });
}

/**
 * Step 0 loads the browser namespace; step 1 emits a mis-cased `BROWSER_CLICK`
 * (a provider that case-drifts a tool that only became active this step). The
 * AI SDK can't match the upper-cased name, so it calls the repair callback.
 */
function loadThenMiscasedClickModel(captured: string[][]): MockLanguageModelV3 {
  return new MockLanguageModelV3({
    doStream: async ({ tools: stepTools }) => {
      captured.push((stepTools ?? []).map((t) => t.name));
      const step = captured.length;
      const parts: LanguageModelV3StreamPart[] =
        step === 1
          ? [
              { type: 'stream-start', warnings: [] },
              { type: 'tool-call', toolCallId: 'tc-load', toolName: 'load_tool', input: JSON.stringify({ namespace: 'browser' }) },
              { type: 'finish', finishReason: { unified: 'tool-calls', raw: 'tool_calls' }, usage: ZERO_USAGE },
            ]
          : step === 2
            ? [
                { type: 'stream-start', warnings: [] },
                { type: 'tool-call', toolCallId: 'tc-click', toolName: 'BROWSER_CLICK', input: JSON.stringify({}) },
                { type: 'finish', finishReason: { unified: 'tool-calls', raw: 'tool_calls' }, usage: ZERO_USAGE },
              ]
            : [
                { type: 'stream-start', warnings: [] },
                { type: 'finish', finishReason: { unified: 'stop', raw: 'stop' }, usage: ZERO_USAGE },
              ];
      return { stream: convertArrayToReadableStream(parts) };
    },
  });
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** A complete prior turn whose model called load_tool(browser) and got a result. */
function priorBrowserLoad(turnId: string): RuntimeEvent[] {
  const base = { invocationId: 'inv-1', runId: 'run-1', sessionId: 'session-1', turnId, ts: 1, partial: false } as const;
  return [
    { ...base, id: 'p-u', role: 'user', author: 'user', content: { kind: 'text', text: 'load browser' } },
    { ...base, id: 'p-call', role: 'model', author: 'agent', content: { kind: 'function_call', id: 'tc-prev', name: 'load_tool', args: { namespace: 'browser' } } },
    { ...base, id: 'p-resp', role: 'tool', author: 'tool', content: { kind: 'function_response', id: 'tc-prev', name: 'load_tool', result: { loaded: ['browser_click'] } } },
    { ...base, id: 'p-end', role: 'model', author: 'agent', status: 'completed', actions: { endInvocation: true } },
  ];
}

async function drain(iterable: AsyncIterable<unknown>): Promise<void> {
  for await (const _ of iterable) {
    void _;
  }
}

function header(): SessionHeader {
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
    llmConnectionSlug: 'c',
    connectionLocked: true,
    model: 'm',
    permissionMode: 'ask',
    schemaVersion: 1,
  };
}

function connection(): LlmConnection {
  return {
    slug: 'c',
    name: 'OpenAI',
    providerType: 'openai',
    defaultModel: 'mock-model-id',
    enabled: true,
    createdAt: 1,
    updatedAt: 1,
  };
}
