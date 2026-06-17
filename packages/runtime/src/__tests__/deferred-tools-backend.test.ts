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
import {
  ToolAvailabilityRuntime,
  LOAD_TOOLS_NAME,
  type ToolAvailabilityConfig,
} from '../tool-availability.js';
import { toolSchemaCharsForDiagnostics } from '../request-shape.js';

// End-to-end through the live AiSdkBackend: the availability config drives the
// per-step prepareStep activation, the durable seed reconstructs prior-turn
// loads, and the execute-boundary guard is fed by the live snapshot.

const ZERO_USAGE: LanguageModelV3Usage = {
  inputTokens: { total: 0, noCache: 0, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 0, text: 0, reasoning: 0 },
};

const config: ToolAvailabilityConfig = {
  economy: true,
  groups: [{ id: 'browser', toolNames: ['browser_click'], label: 'Browser automation' }],
};

function tools(implCalls: string[]): MakaTool[] {
  return [
    { name: 'Read', description: 'Read', parameters: z.object({ path: z.string().optional() }), permissionRequired: false, impl: () => ({ ok: true }) },
    {
      name: 'browser_click',
      description: 'Click in the browser',
      parameters: z.object({}),
      permissionRequired: false,
      impl: () => { implCalls.push('browser_click'); return { ok: true }; },
    },
  ];
}

interface BackendOpts {
  /** Override the availability config (pass `null` to omit it ⇒ full surface). */
  toolAvailability?: ToolAvailabilityConfig | null;
  recordLlmCall?: (record: LlmCallRecord) => void;
}

function backend(model: MockLanguageModelV3, implCalls: string[], opts: BackendOpts = {}): AiSdkBackend {
  let n = 0;
  const resolved = opts.toolAvailability === null ? undefined : opts.toolAvailability ?? config;
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
    ...(resolved ? { toolAvailability: resolved } : {}),
    ...(opts.recordLlmCall ? { recordLlmCall: opts.recordLlmCall } : {}),
    newId: () => `id-${++n}`,
    now: () => 1,
  });
}

describe('AiSdkBackend deferred tool loading', () => {
  test('step 0 hides an unloaded group tool but advertises load_tools', async () => {
    const captured: string[][] = [];
    const implCalls: string[] = [];
    await drain(backend(capturingModel(captured), implCalls).send({
      turnId: 'turn-1',
      text: 'hi',
      context: [],
    }));
    assert.ok(captured[0].includes('Read'), 'ungrouped Read advertised');
    assert.ok(captured[0].includes(LOAD_TOOLS_NAME), 'load_tools advertised');
    assert.ok(!captured[0].includes('browser_click'), 'unloaded browser_click hidden');
  });

  test('durable seed: a prior-turn load re-advertises the tool at the next turn', async () => {
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

  test('guard: same-step parallel load_tools(browser)+browser_click rejects the click (live)', async () => {
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

  test('diagnostics: a same-turn load is reflected in the recorded tool-schema cost', async () => {
    const records: LlmCallRecord[] = [];
    const implCalls: string[] = [];
    // step 0 loads browser; browser_click activates at step 1 via prepareStep.
    await drain(backend(loadBrowserThenFinishModel(), implCalls, {
      recordLlmCall: (r) => records.push(r),
    }).send({ turnId: 'turn-1', text: 'load browser', context: [] }));

    assert.equal(records.length, 1, 'exactly one llm-call cost record for the turn');
    const toolSeg = records[0].promptSegments?.find((s) => s.kind === 'tool_schema');
    assert.ok(toolSeg, 'a tool_schema prompt segment was recorded');

    // The recorded cost must reflect the FINAL active set (Read + load_tools +
    // browser_click), not the lean step-0 set — otherwise the load turn
    // under-reports the heavy schema it actually sent on step 1. Use the real
    // runtime so the provider tool set (incl. the connector) matches the backend.
    const providerTools = new ToolAvailabilityRuntime(tools([]), config, INVALID_FIXTURE).prepare([]).providerTools;
    const leanChars = toolSchemaCharsForDiagnostics(providerTools, ['Read', LOAD_TOOLS_NAME]);
    const loadedChars = toolSchemaCharsForDiagnostics(providerTools, ['Read', LOAD_TOOLS_NAME, 'browser_click']);
    assert.ok(loadedChars > leanChars, 'sanity: the loaded set is heavier than the lean set');
    assert.equal(toolSeg.chars, loadedChars, 'recorded tool-schema chars include the loaded browser_click');
    assert.equal(
      records[0].requestShapeChangeReason,
      'first_turn',
      'first turn establishes the baseline; the expansion sets the durable prefix for next turn',
    );
  });

  test('high-water "after" hash stays consistent with the final recorded requestShapeHash across a same-turn load', async () => {
    const records: LlmCallRecord[] = [];
    const implCalls: string[] = [];
    const be = backend(loadBrowserThenFinishModel(), implCalls, { recordLlmCall: (r) => records.push(r) });
    // Real high-water reasons only arise from the synthesis-cache subsystem
    // (selectSynthesisCacheForReplay needs valid cache blocks + matching
    // history). Inject just the marker by wrapping buildPriorMessages so this
    // targets the diagnostics-consistency invariant, not that subsystem.
    type PriorReplayish = { contextBudget?: Record<string, unknown> };
    const patch = be as unknown as { buildPriorMessages: (input: unknown) => Promise<PriorReplayish> };
    const realBuildPriorMessages = patch.buildPriorMessages.bind(be);
    patch.buildPriorMessages = async (input: unknown) => {
      const prior = await realBuildPriorMessages(input);
      return { ...prior, contextBudget: { ...(prior.contextBudget ?? {}), highWaterReason: 'synthesis_cache_select' } };
    };

    await drain(be.send({ turnId: 'turn-1', text: 'load browser', context: [] }));

    assert.equal(records.length, 1, 'one llm-call record for the turn');
    const cb = records[0].contextBudget;
    assert.ok(cb?.highWaterRequestShapeHashAfter, 'a high-water "after" hash was recorded');
    // The same-turn load makes the final active set differ from step-0, so this
    // equality fails if "after" is left at the step-0 hash (the bug).
    assert.equal(
      cb.highWaterRequestShapeHashAfter,
      records[0].requestShapeHash,
      'high-water "after" must equal the final recorded requestShapeHash',
    );
    assert.equal(cb.highWaterRequestShapeHashBefore, undefined, 'first turn has no pre-turn baseline');
  });

  test('economy off: every tool stays advertised, no connector', async () => {
    const captured: string[][] = [];
    const implCalls: string[] = [];
    // economy off ⇒ the contract is "advertise everything", no load_tools.
    await drain(backend(capturingModel(captured), implCalls, { toolAvailability: null }).send({
      turnId: 'turn-1',
      text: 'hi',
      context: [],
    }));
    assert.ok(captured[0].includes('browser_click'), 'a group tool is advertised when economy is off');
    assert.ok(!captured[0].includes(LOAD_TOOLS_NAME), 'no connector in full mode');
  });

  test('repair: a mis-cased group call after a mid-turn load repairs to the canonical name', async () => {
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
            { type: 'tool-call', toolCallId: 'tc-load', toolName: LOAD_TOOLS_NAME, input: JSON.stringify({ group: 'browser' }) },
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

/** Step 0 loads the browser group, then the turn finishes (no use). */
function loadBrowserThenFinishModel(): MockLanguageModelV3 {
  let step = 0;
  return new MockLanguageModelV3({
    doStream: async () => {
      step += 1;
      const parts: LanguageModelV3StreamPart[] =
        step === 1
          ? [
              { type: 'stream-start', warnings: [] },
              { type: 'tool-call', toolCallId: 'tc-load', toolName: LOAD_TOOLS_NAME, input: JSON.stringify({ group: 'browser' }) },
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
 * Step 0 loads the browser group; step 1 emits a mis-cased `BROWSER_CLICK`
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
              { type: 'tool-call', toolCallId: 'tc-load', toolName: LOAD_TOOLS_NAME, input: JSON.stringify({ group: 'browser' }) },
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

/** A complete prior turn whose model called load_tools(browser) and got a result. */
function priorBrowserLoad(turnId: string): RuntimeEvent[] {
  const base = { invocationId: 'inv-1', runId: 'run-1', sessionId: 'session-1', turnId, ts: 1, partial: false } as const;
  return [
    { ...base, id: 'p-u', role: 'user', author: 'user', content: { kind: 'text', text: 'load browser' } },
    { ...base, id: 'p-call', role: 'model', author: 'agent', content: { kind: 'function_call', id: 'tc-prev', name: LOAD_TOOLS_NAME, args: { group: 'browser' } } },
    { ...base, id: 'p-resp', role: 'tool', author: 'tool', content: { kind: 'function_response', id: 'tc-prev', name: LOAD_TOOLS_NAME, result: { loaded: ['browser_click'] } } },
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
