import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { setImmediate as flushMacrotask } from 'node:timers/promises';
import { MockLanguageModelV3, simulateReadableStream } from 'ai/test';
import type { LanguageModelV3StreamPart } from '@ai-sdk/provider';
import type { LlmConnection, SessionHeader } from '@maka/core';
import type { SessionEvent } from '@maka/core/events';
import type { RuntimeEvent } from '@maka/core/runtime-event';
import { z } from 'zod';
import { AiSdkBackend } from '../ai-sdk-backend.js';
import { createSessionEventMapMemory, mapSessionEventToRuntimeEvent } from '../ai-sdk-flow.js';
import type { InvocationContext } from '../invocation-context.js';
import { PermissionEngine } from '../permission-engine.js';
import type { HistoryCompactCheckpoint } from '../history-compact-checkpoint.js';

const RAW_SPAN_ONE = 'RAW_SPAN_ONE_'.repeat(24);
const ANCHOR_TEXT = 'reactive overflow recovery keep my exact words';
const OVERFLOW_MESSAGE = 'prompt is too long: 213462 tokens > 200000 maximum';

/**
 * Per-provider-request script. Each entry drives one `doStream` invocation:
 *  - 'tool'     → a Read tool call (completes a step, appends a durable pair)
 *  - 'bigtool'  → assistant text (sentinel) + a Read with a huge result, so the
 *                 proactive capacity trigger fires at this step's boundary
 *  - 'bigread'  → a pure Read with a huge result and NO step text, so the
 *                 durable pair is the trailing span a recovery fold must keep
 *                 verbatim in the tail (the prune-resurrection shape)
 *  - 'load'     → a `load_tools` call activating the gated 'big' group
 *  - 'gated'    → a call to the gated `Big` tool
 *  - 'done'     → final assistant text, finish stop
 *  - 'overflow' → the provider rejects with a context-length 400 (doStream
 *                 throws; the SDK surfaces it as a fullStream error chunk and
 *                 rejects finishReason — the fake-end_turn latent-bug path)
 *  - 'overflowPart' → OpenAI CHAT in-stream failure exactly as the locked
 *                 provider transform produces it: the error part value is the
 *                 INNER parsed error object (never an Error instance) and the
 *                 flush trailer is a finish part with finishReason 'error'
 *                 (openai-chat-language-model.ts:478-479 + flush) — the
 *                 round-8 P1-1 end-to-end shape
 *  - 'overflowPartResponses' → OpenAI RESPONSES in-stream failure: the error
 *                 part value is the WHOLE {type:'error', error:{...}} chunk
 *                 and the flush trailer keeps finishReason 'other' (the
 *                 isErrorChunk branch never reassigns it) — locks recovery
 *                 against per-family trailer drift
 *  - 'error500' → a non-overflow provider failure (never a recovery trigger)
 */
type CallKind =
  | 'tool' | 'bigtool' | 'bigread' | 'load' | 'gated' | 'done'
  | 'overflow' | 'overflowPart' | 'overflowPartResponses' | 'error500';

const RETRY_STEP_TEXT_SENTINEL = 'RETRY_STEP_TEXT_SENTINEL reasoning before the big read';
const BIG_RESULT = 'BIG_RESULT_'.repeat(200);

interface ReactiveFixtureOptions {
  script: CallKind[];
  contextWindow?: number;
  reserveTokens?: number;
  midTurnEnabled?: boolean;
  withoutPriorTurns?: boolean;
  bigPriors?: boolean;
  summarize?: () => Promise<string | undefined> | string | undefined;
  /** Explicit send-level step budget forwarded to the backend. */
  maxSteps?: number;
  /** The FIRST tool step reports an unusable usage object (no token counts). */
  firstStepUsageMissing?: boolean;
  /** Economy tool availability with the gated `Big` tool behind `load_tools`. */
  gatedToolGroup?: boolean;
  /**
   * appendMessage yields several macrotasks before resolving, so the pump
   * genuinely lags inside flushStep (text_complete not yet enqueued,
   * flushedSteps not yet incremented) while the SDK's loop advances to the
   * next prepareStep — the P1-A race window.
   */
  slowAppendMessage?: boolean;
  /** Enable the active tool-result prune with a small threshold + archive seam. */
  activeToolResultPrune?: boolean;
}

interface ReactiveLlmCall {
  status?: string;
  errorClass?: string;
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
}

interface ReactiveFixture {
  backend: AiSdkBackend;
  model: MockLanguageModelV3;
  recorded: HistoryCompactCheckpoint[];
  toolExecutions: string[];
  summarizerCalls: () => number;
  anchor: RuntimeEvent;
  priorEvents: RuntimeEvent[];
  events: SessionEvent[];
  llmCalls: ReactiveLlmCall[];
  /** JSON of each summarizer call's folded runtime events (coverage evidence). */
  summarizedSources: string[];
  persist: (event: SessionEvent) => void;
}

function buildReactiveFixture(options: ReactiveFixtureOptions): ReactiveFixture {
  const contextWindow = options.contextWindow ?? 200_000;
  const reserveTokens = options.reserveTokens ?? 1_000;
  const recorded: HistoryCompactCheckpoint[] = [];
  const toolExecutions: string[] = [];
  const events: SessionEvent[] = [];
  const llmCalls: ReactiveLlmCall[] = [];
  const counters = { summarizerCalls: 0 };
  const usage = (input: number, output: number) => ({
    inputTokens: { total: input, noCache: input, cacheRead: 0, cacheWrite: 0 },
    outputTokens: { total: output, text: output, reasoning: 0 },
  });
  const toolCallChunks = (
    call: number,
    toolName: string,
    args: object,
    leadingText?: string,
  ): LanguageModelV3StreamPart[] => [
    { type: 'stream-start', warnings: [] },
    ...(leadingText
      ? ([
          { type: 'text-start', id: `step-text-${call}` },
          { type: 'text-delta', id: `step-text-${call}`, delta: leadingText },
          { type: 'text-end', id: `step-text-${call}` },
        ] satisfies LanguageModelV3StreamPart[])
      : []),
    { type: 'tool-call', toolCallId: `tool-${call}`, toolName, input: JSON.stringify(args) },
    {
      type: 'finish',
      finishReason: { unified: 'tool-calls', raw: 'tool_calls' },
      // An unusable first-step usage: the SDK accepts the object but the
      // adapter's normalization fails closed (undefined), the #972 shape.
      usage: options.firstStepUsageMissing && call === 1
        ? ({ inputTokens: {}, outputTokens: {} } as ReturnType<typeof usage>)
        : usage(100, 20),
    },
  ];
  const doneChunks = (): LanguageModelV3StreamPart[] => [
    { type: 'stream-start', warnings: [] },
    { type: 'text-start', id: 'text-1' },
    { type: 'text-delta', id: 'text-1', delta: 'done' },
    { type: 'text-end', id: 'text-1' },
    { type: 'finish', finishReason: { unified: 'stop', raw: 'stop' }, usage: usage(120, 10) },
  ];
  const streamForCall = (call: number): ReadableStream<LanguageModelV3StreamPart> => {
    const kind = options.script[call - 1];
    if (kind === 'overflow') {
      throw Object.assign(new Error(OVERFLOW_MESSAGE), { name: 'AI_APICallError', statusCode: 400 });
    }
    if (kind === 'error500') {
      throw Object.assign(new Error('internal server error'), { name: 'AI_APICallError', statusCode: 500 });
    }
    if (kind === 'overflowPart' || kind === 'overflowPartResponses') {
      // The 200 response starts streaming, then the provider sends the error
      // inside the SSE stream. Each shape below is exactly what the locked
      // provider transform enqueues — no cross-family mixing:
      // Chat forwards the INNER error object and its flush emits a finish
      // part with finishReason 'error'; Responses forwards the WHOLE error
      // chunk and its flush keeps the initial finishReason 'other'.
      const errorValue = kind === 'overflowPart'
        ? { message: 'Bad Request', type: 'invalid_request_error', param: null, code: 'context_length_exceeded' }
        : {
            type: 'error',
            sequence_number: 1,
            error: { type: 'invalid_request_error', code: 'context_length_exceeded', message: 'Bad Request', param: null },
          };
      const trailerReason = kind === 'overflowPart'
        ? { unified: 'error' as const, raw: undefined }
        : { unified: 'other' as const, raw: undefined };
      return simulateReadableStream({
        chunks: [
          { type: 'stream-start', warnings: [] },
          { type: 'error', error: errorValue },
          { type: 'finish', finishReason: trailerReason, usage: usage(0, 0) },
        ] satisfies LanguageModelV3StreamPart[],
        initialDelayInMs: null,
        chunkDelayInMs: null,
      });
    }
    const chunks =
      kind === 'tool' ? toolCallChunks(call, 'Read', { path: 'one.md' })
      : kind === 'bigtool' ? toolCallChunks(call, 'Read', { path: 'big.md' }, RETRY_STEP_TEXT_SENTINEL)
      : kind === 'bigread' ? toolCallChunks(call, 'Read', { path: 'big.md' })
      : kind === 'load' ? toolCallChunks(call, 'load_tools', { group: 'big' })
      : kind === 'gated' ? toolCallChunks(call, 'Big', { q: 'run' })
      : doneChunks();
    return simulateReadableStream({ chunks, initialDelayInMs: null, chunkDelayInMs: null });
  };
  const model = new MockLanguageModelV3({
    doStream: async (
      streamOptions: { abortSignal?: AbortSignal },
    ): Promise<{ stream: ReadableStream<LanguageModelV3StreamPart> }> => {
      if (streamOptions.abortSignal?.aborted) {
        throw Object.assign(new Error('aborted'), { name: 'AbortError' });
      }
      return { stream: streamForCall(model.doStreamCalls.length) };
    },
  });

  const priorChars = options.bigPriors ? 4_000 : 120;
  const priorEvents: RuntimeEvent[] = options.withoutPriorTurns ? [] : [
    runtimeTextEvent('prior-user', 'turn-0', 'user', `PRIOR_FACT question ${'p'.repeat(priorChars)}`),
    runtimeTextEvent('prior-model', 'turn-0', 'model', `PRIOR_FACT answer ${'q'.repeat(priorChars)}`),
  ];
  const anchor = runtimeTextEvent('anchor-1', 'turn-1', 'user', ANCHOR_TEXT);

  const ledger: RuntimeEvent[] = [anchor];
  const ledgerCtx: InvocationContext = {
    sessionId: 'session-1',
    invocationId: 'run-1',
    runId: 'run-1',
    turnId: 'turn-1',
    source: 'desktop',
    startedAt: 1,
    request: { sessionId: 'session-1', turnId: 'turn-1', text: ANCHOR_TEXT, source: 'desktop' },
    newId: idGenerator(),
    now: monotonicClock(),
  };
  const ledgerMemory = createSessionEventMapMemory();
  const persist = (event: SessionEvent): void => {
    const mapped = mapSessionEventToRuntimeEvent(event, ledgerCtx, ledgerMemory);
    if (mapped.partial === true) return;
    if (mapped.content?.kind === 'error') return;
    ledger.push(mapped);
  };

  const midTurnEnabled = options.midTurnEnabled ?? true;
  const summarizedSources: string[] = [];
  const seams = midTurnEnabled
    ? {
        summarizeHistoryCompact: async (input: { source: { foldedRuntimeEvents: RuntimeEvent[] } }) => {
          counters.summarizerCalls += 1;
          summarizedSources.push(JSON.stringify(input.source.foldedRuntimeEvents));
          return options.summarize ? await options.summarize() : 'REACTIVE_SUMMARY_SENTINEL';
        },
        recordHistoryCompactCheckpoint: (checkpoint: HistoryCompactCheckpoint) => { recorded.push(checkpoint); },
        loadTurnRuntimeEvents: async (turnId: string) => {
          await flushMacrotask();
          return ledger.filter((event) => event.turnId === turnId);
        },
      }
    : {};

  const backend = new AiSdkBackend({
    sessionId: 'session-1',
    header: header(),
    appendMessage: async () => {
      if (!options.slowAppendMessage) return;
      for (let i = 0; i < 5; i += 1) await flushMacrotask();
    },
    connection: { ...connection(), models: [{ id: 'mock-model-id', contextWindow }] },
    apiKey: 'sk-test',
    modelId: 'mock-model-id',
    permissionEngine: new PermissionEngine({ newId: () => 'permission-id', now: () => 1 }),
    modelFactory: () => model,
    ...(options.maxSteps !== undefined ? { maxSteps: options.maxSteps } : {}),
    tools: [
      {
        name: 'Read',
        description: 'Read description',
        parameters: z.object({ path: z.string() }),
        permissionRequired: false,
        impl: async (args: { path: string }) => {
          toolExecutions.push(args.path);
          return { body: args.path === 'big.md' ? BIG_RESULT : RAW_SPAN_ONE };
        },
      },
      ...(options.gatedToolGroup
        ? [{
            name: 'Big',
            description: 'Gated capability behind the big group',
            parameters: z.object({ q: z.string() }),
            permissionRequired: false,
            impl: async () => {
              toolExecutions.push('BIG_EXEC');
              return { ok: true };
            },
          }]
        : []),
    ],
    ...(options.gatedToolGroup
      ? { toolAvailability: { economy: true, groups: [{ id: 'big', toolNames: ['Big'] }] } }
      : {}),
    contextBudget: {
      name: 'reactive-test',
      maxHistoryEstimatedTokens: 100_000,
      minRecentTurns: 1,
      historyCompact: {
        enabled: true,
        mode: 'read_write',
        ...(midTurnEnabled ? { midTurn: { enabled: true, reserveTokens } } : {}),
      },
      ...(options.activeToolResultPrune
        ? { activeToolResultPrune: { enabled: true, maxCurrentResultEstimatedTokens: 100 } }
        : {}),
    },
    ...(options.activeToolResultPrune
      ? { archiveToolResult: () => ({ artifactId: 'artifact-archived-1' }) }
      : {}),
    ...seams,
    recordLlmCall: (record) => { llmCalls.push(record as (typeof llmCalls)[number]); },
    newId: idGenerator(),
    now: monotonicClock(),
  });

  return {
    backend,
    model,
    recorded,
    toolExecutions,
    summarizerCalls: () => counters.summarizerCalls,
    anchor,
    priorEvents,
    events,
    llmCalls,
    summarizedSources,
    persist,
  };
}

async function runTurn(fixture: ReactiveFixture, consumer: 'immediate' | 'slow' = 'immediate'): Promise<void> {
  for await (const event of fixture.backend.send({
    runId: 'run-1',
    turnId: 'turn-1',
    headAnchorRuntimeEvent: fixture.anchor,
    text: ANCHOR_TEXT,
    context: [],
    runtimeContext: [...fixture.priorEvents],
  })) {
    if (consumer === 'slow') {
      // Scheduling perturbation (same as the mid-turn suite): hold the durable
      // write back across several macrotasks so the ledger genuinely lags the
      // SDK's step progression.
      await flushMacrotask();
      await flushMacrotask();
      await flushMacrotask();
    }
    // The consumer persists every non-partial event to the durable ledger,
    // exactly like AgentRun, so the reactive compaction pool can span the
    // completed steps.
    fixture.persist(event);
    fixture.events.push(event);
  }
}

function complete(fixture: ReactiveFixture): Extract<SessionEvent, { type: 'complete' }> | undefined {
  return fixture.events.find((event) => event.type === 'complete') as
    | Extract<SessionEvent, { type: 'complete' }>
    | undefined;
}

describe('reactive overflow recovery in the streaming backend', () => {
  test('a request-level context-length 400 ends as a real error, never a fake end_turn', async () => {
    // The latent bug: a provider that rejects the request (doStream throws) is
    // surfaced as a fullStream error chunk while finishReason rejects. The old
    // path caught that rejection as `stop` and emitted a CompleteEvent with
    // end_turn plus success telemetry — a silent fabrication. Without the
    // mid-turn seam there is nothing to recover, so the honest terminal is a
    // real error carrying the provider's classification.
    const fixture = buildReactiveFixture({ script: ['overflow'], midTurnEnabled: false });
    await runTurn(fixture);

    assert.equal(fixture.model.doStreamCalls.length, 1);
    // Real error terminal, never a fabricated end_turn success.
    assert.equal(complete(fixture)?.stopReason, 'error');
    // A first-class error event carrying the overflow classification.
    const errorEvent = fixture.events.find((event) => event.type === 'error') as
      | Extract<SessionEvent, { type: 'error' }>
      | undefined;
    assert.equal(errorEvent !== undefined, true);
    assert.equal(errorEvent?.reason, 'context_overflow');
    // The old fake-success path emitted end_turn with success telemetry; the
    // fixed path never records this dead request as a successful call.
    assert.equal(fixture.llmCalls.some((call) => call.status === 'success'), false);
  });

  test('a non-overflow provider failure ends as a real error without any recovery attempt', async () => {
    const fixture = buildReactiveFixture({ script: ['error500'], bigPriors: true });
    await runTurn(fixture);

    assert.equal(fixture.model.doStreamCalls.length, 1);
    assert.equal(complete(fixture)?.stopReason, 'error');
    assert.equal(fixture.events.some((event) => event.type === 'error'), true);
    // Not a context-length error → no compaction, no retry.
    assert.equal(fixture.recorded.length, 0);
    assert.equal(fixture.summarizerCalls(), 0);
  });

  test('compacts once and retries after a mid-stream context-length overflow', async () => {
    // A tool step completes, then the provider rejects the second request with
    // a context-length 400 even though our proactive estimate stayed under the
    // window. Reactive recovery folds a safe completed prefix into a durable
    // mid_turn checkpoint and resends once; the retry succeeds and the turn
    // completes normally on the compacted projection.
    const fixture = buildReactiveFixture({ script: ['tool', 'overflow', 'done'], bigPriors: true });
    await runTurn(fixture);

    assert.equal(fixture.model.doStreamCalls.length, 3);
    assert.equal(complete(fixture)?.stopReason, 'end_turn');
    assert.equal(fixture.events.some((event) => event.type === 'error'), false);
    // Exactly one recovery compaction happened, tagged as an overflow trigger.
    assert.equal(fixture.recorded.length, 1);
    assert.equal(fixture.recorded[0]!.phase, 'mid_turn');
    assert.equal(fixture.summarizerCalls(), 1);
    // The completed tool step was not re-executed on the retry.
    assert.deepEqual(fixture.toolExecutions, ['one.md']);
    // Send-level usage owner (review P1-2): the terminal record carries BOTH
    // attempts' completed steps — the first attempt's tool step (100/20) plus
    // the retry's final step (120/10) — not just the last attempt's totalUsage.
    const lastCall = fixture.llmCalls.at(-1);
    assert.equal(lastCall?.status, 'success');
    assert.equal(lastCall?.inputTokens, 220);
    assert.equal(lastCall?.outputTokens, 30);
    assert.equal(lastCall?.totalTokens, 250);
  });

  test('recovers from a plain-object in-stream error part, not just Error instances (review round-8 P1-1)', async () => {
    // Providers deliver in-stream failures as parsed plain objects (or bare
    // strings), never Error instances. The recovery decision must classify
    // the real shape; an instanceof Error gate silently downgraded every
    // genuine in-stream overflow to an unrecoverable terminal error.
    const fixture = buildReactiveFixture({ script: ['tool', 'overflowPart', 'done'], bigPriors: true });
    await runTurn(fixture);

    assert.equal(fixture.model.doStreamCalls.length, 3);
    assert.equal(complete(fixture)?.stopReason, 'end_turn');
    assert.equal(fixture.events.some((event) => event.type === 'error'), false);
    assert.equal(fixture.recorded.length, 1);
    assert.equal(fixture.recorded[0]!.phase, 'mid_turn');
  });

  test('recovers from the Responses-family in-stream error shape with its non-error finish trailer (review round-9 P3)', async () => {
    // Same failure, different family: the error part value is the WHOLE
    // {type:'error', error:{...}} chunk and the trailer finish keeps
    // finishReason 'other'. The recovery decision truncates at the error part,
    // so trailer drift across provider families must not change the outcome.
    const fixture = buildReactiveFixture({ script: ['tool', 'overflowPartResponses', 'done'], bigPriors: true });
    await runTurn(fixture);

    assert.equal(fixture.model.doStreamCalls.length, 3);
    assert.equal(complete(fixture)?.stopReason, 'end_turn');
    assert.equal(fixture.events.some((event) => event.type === 'error'), false);
    assert.equal(fixture.recorded.length, 1);
    assert.equal(fixture.recorded[0]!.phase, 'mid_turn');
  });

  test('the recovery baseline is the request the provider rejected, not the attempt-initial messages', async () => {
    // Review P1-1 repro: four completed tool steps grow the provider-visible
    // request far beyond the attempt's INITIAL messages. The fold shrinks the
    // real rejected request but is larger than that initial request, so a
    // baseline anchored to the initial messages refuses it as
    // replacement_not_smaller and the turn dies on the exact scenario reactive
    // recovery exists for — same-turn tool growth. The unique baseline owner
    // is the verdict owner's per-request payload measure of the request that
    // actually went out.
    const fixture = buildReactiveFixture({ script: ['tool', 'tool', 'tool', 'tool', 'overflow', 'done'] });
    await runTurn(fixture);

    assert.equal(complete(fixture)?.stopReason, 'end_turn');
    assert.equal(fixture.events.some((event) => event.type === 'error'), false);
    assert.equal(fixture.recorded.length, 1);
    assert.equal(fixture.model.doStreamCalls.length, 6);
    // The four completed tool steps ran exactly once each.
    assert.deepEqual(fixture.toolExecutions, ['one.md', 'one.md', 'one.md', 'one.md']);
  });

  test('an unusable first-attempt step usage fails the whole record closed even when the retry succeeds', async () => {
    // Review P1-2, fail-closed direction: the first attempt's completed step
    // has an unusable usage sample. The retry's totalUsage is valid but covers
    // only the retry, so recording it as the whole send would fabricate a
    // partial cost as complete (#972). No record at all is the truthful
    // outcome; the turn itself still completes.
    const fixture = buildReactiveFixture({
      script: ['tool', 'overflow', 'done'],
      bigPriors: true,
      firstStepUsageMissing: true,
    });
    await runTurn(fixture);

    assert.equal(complete(fixture)?.stopReason, 'end_turn');
    assert.equal(fixture.llmCalls.length, 0);
  });

  test('a retry only gets the remaining step budget under an explicit maxSteps (review P1-3)', async () => {
    // maxSteps=2: one completed tool step before the overflow leaves a budget
    // of exactly one step for the retry. The retry's tool step consumes it and
    // the send ends at the explicit step limit — a fresh full budget would run
    // a third step and a fourth provider request, breaching the send-level cap
    // and its tool side effects.
    const fixture = buildReactiveFixture({
      script: ['tool', 'overflow', 'tool', 'done'],
      bigPriors: true,
      maxSteps: 2,
    });
    await runTurn(fixture);

    assert.equal(fixture.model.doStreamCalls.length, 3);
    assert.deepEqual(fixture.toolExecutions, ['one.md', 'one.md']);
    assert.equal(complete(fixture)?.stopReason, 'step_limit');
  });

  test('a completed retry step\'s assistant text is never dropped by a post-retry compaction (review P1-A)', async () => {
    // Review round-2 P1-A repro: the SDK numbers prepareStep steps per
    // streamText call, but flushedSteps / replacedStepNumber / lastShapeFailure
    // are SEND-level. After a retry, attempt-local step 1 satisfies the
    // durability wait with attempt 1's flushed boundary, so a capacity
    // compaction at the retry's own step boundary can read the ledger BEFORE
    // the pump has flushed the retry step's text_complete — and because the
    // replacement projection replaces the whole message list, that streamed
    // assistant text silently vanishes from both the covered span and the
    // preserved tail. Same shape as PR 1's finding B, re-opened across the
    // attempt boundary. The lag lever is a slow appendMessage: the pump gets
    // stuck INSIDE flushStep (text_complete not yet enqueued, flushedSteps not
    // yet incremented) while the immediate consumer has drained everything
    // already pushed — so `consumed >= pushed` holds and only the send-global
    // flushedSteps bound can still hold the ledger read back.
    const fixture = buildReactiveFixture({
      // High water 400: the first attempt's boundary (~usage 100 + small
      // delta) stays under it, the retry step's huge result (~BIG_RESULT/4)
      // crosses it, so the capacity trigger fires exactly at the retry's own
      // step boundary.
      script: ['tool', 'overflow', 'bigtool', 'done'],
      bigPriors: true,
      contextWindow: 2_000,
      reserveTokens: 1_600,
      slowAppendMessage: true,
    });
    await runTurn(fixture);

    // The turn completes on the compacted projections (recovery fold + the
    // post-retry capacity fold), with the retry's step text streamed out.
    assert.equal(complete(fixture)?.stopReason, 'end_turn');
    assert.equal(
      fixture.events.some((event) => event.type === 'text_complete' && event.text.includes('RETRY_STEP_TEXT_SENTINEL')),
      true,
    );
    // The projection accounts for that text: it survives either verbatim in
    // the final request or inside a summarized covered span — never silently
    // dropped from both.
    const finalPrompt = JSON.stringify(fixture.model.doStreamCalls.at(-1)?.prompt);
    const inTail = finalPrompt.includes('RETRY_STEP_TEXT_SENTINEL');
    const inCoveredSpan = fixture.summarizedSources.join('\n').includes('RETRY_STEP_TEXT_SENTINEL');
    assert.equal(inTail || inCoveredSpan, true);
  });

  test('a same-turn load_tools activation survives the retry (review P1-B)', async () => {
    // Review round-2 P1-B repro: active tools were re-derived per streamText
    // call from seed groups + that call's own steps. The retry's steps start
    // empty, so a group loaded before the overflow was silently revoked — the
    // gated tool disappeared from the provider request and the execute
    // boundary rejected it. Activation must accumulate monotonically in the
    // availability owner for the whole send.
    const fixture = buildReactiveFixture({
      script: ['load', 'overflow', 'gated', 'done'],
      bigPriors: true,
      gatedToolGroup: true,
    });
    await runTurn(fixture);

    assert.equal(complete(fixture)?.stopReason, 'end_turn');
    assert.equal(fixture.events.some((event) => event.type === 'error'), false);
    // The retry request still advertises the gated tool...
    const retryRequestTools = JSON.stringify(fixture.model.doStreamCalls[2]?.tools ?? []);
    assert.equal(retryRequestTools.includes('"Big"') || retryRequestTools.includes("'Big'"), true);
    // ...and it executes for real after the retry.
    assert.equal(fixture.toolExecutions.includes('BIG_EXEC'), true);
  });

  test('an actively pruned tool result stays a placeholder in the retry request (review round-3 P1)', async () => {
    // Review round-3 P1 repro: the active tool-result prune derives its
    // eligible tool-call IDs from `options.steps` and early-returns on an
    // empty set. The retry's fresh streamText starts with empty steps, while
    // the recovery projection is rebuilt from the durable ledger — which holds
    // the ORIGINAL raw result, not the provider-only placeholder. The retry
    // request therefore resurrected the archived raw body, breaking the
    // active-prune invariant (an archived result never re-enters provider
    // context) and inviting a second overflow. Third instance of the same
    // disease: attempt-local `steps` consumed as send-level state.
    //
    // 'bigread' keeps the step text-free so the durable pair is the POOL'S
    // trailing span: the safe boundary cannot split the pair, retreats before
    // the call, and the fold re-materializes the pair verbatim in the tail —
    // from the ledger, which holds the raw body, not the placeholder.
    const fixture = buildReactiveFixture({
      script: ['bigread', 'overflow', 'done'],
      bigPriors: true,
      activeToolResultPrune: true,
    });
    await runTurn(fixture);

    assert.equal(complete(fixture)?.stopReason, 'end_turn');
    // The rejected request had already pruned the big result to a placeholder.
    const overflowPrompt = JSON.stringify(fixture.model.doStreamCalls[1]?.prompt);
    assert.equal(overflowPrompt.includes('BIG_RESULT_'), false);
    assert.equal(overflowPrompt.includes('artifact-archived-1'), true);
    // The retry request must keep the placeholder — never the raw body.
    const retryPrompt = JSON.stringify(fixture.model.doStreamCalls[2]?.prompt);
    assert.equal(retryPrompt.includes('BIG_RESULT_'), false);
    assert.equal(retryPrompt.includes('artifact-archived-1'), true);
  });

  test('a second overflow after the single retry ends as a real error', async () => {
    const fixture = buildReactiveFixture({ script: ['tool', 'overflow', 'overflow'], bigPriors: true });
    await runTurn(fixture);

    // The latch permits exactly one compact-and-retry; the retry's overflow is
    // terminal, not a third attempt.
    assert.equal(fixture.model.doStreamCalls.length, 3);
    assert.equal(complete(fixture)?.stopReason, 'error');
    assert.equal(fixture.events.some((event) => event.type === 'error'), true);
    assert.equal(fixture.recorded.length, 1);
    assert.equal(fixture.llmCalls.at(-1)?.errorClass, 'ContextLength');
  });

  test('no recovery seam means a context-length overflow ends as a real error', async () => {
    const fixture = buildReactiveFixture({ script: ['tool', 'overflow'], midTurnEnabled: false, bigPriors: true });
    await runTurn(fixture);

    assert.equal(fixture.model.doStreamCalls.length, 2);
    assert.equal(complete(fixture)?.stopReason, 'error');
    assert.equal(fixture.recorded.length, 0);
    assert.equal(fixture.summarizerCalls(), 0);
  });

  test('an overflow with no foldable completed span ends as a real error', async () => {
    // First-request overflow with no prior turns: the pool is just the current
    // user message, so there is no safe completed span to fold. Recovery is not
    // possible, so the provider error is surfaced honestly (not a fake success,
    // and not a synthesized context_budget_exhausted — the provider rejected).
    const fixture = buildReactiveFixture({ script: ['overflow'], withoutPriorTurns: true });
    await runTurn(fixture);

    assert.equal(fixture.model.doStreamCalls.length, 1);
    assert.equal(complete(fixture)?.stopReason, 'error');
    assert.equal(fixture.events.some((event) => event.type === 'error'), true);
    assert.equal(fixture.recorded.length, 0);
  });
});

function runtimeTextEvent(id: string, turnId: string, role: 'user' | 'model', text: string): RuntimeEvent {
  return {
    id,
    sessionId: 'session-1',
    runId: 'run-1',
    turnId,
    invocationId: 'run-1',
    ts: 1_800_000_000_000,
    partial: false,
    role,
    author: role === 'user' ? 'user' : 'agent',
    content: { kind: 'text', text },
  };
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
    llmConnectionSlug: 'anthropic-main',
    connectionLocked: true,
    model: 'mock-model-id',
    permissionMode: 'ask',
    schemaVersion: 1,
  };
}

function connection(): LlmConnection {
  return {
    slug: 'anthropic-main',
    name: 'Anthropic',
    providerType: 'anthropic',
    defaultModel: 'mock-model-id',
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
