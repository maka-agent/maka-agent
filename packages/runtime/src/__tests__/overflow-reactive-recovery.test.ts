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
 *  - 'done'     → final assistant text, finish stop
 *  - 'overflow' → the provider rejects with a context-length 400 (doStream
 *                 throws; the SDK surfaces it as a fullStream error chunk and
 *                 rejects finishReason — the fake-end_turn latent-bug path)
 *  - 'error500' → a non-overflow provider failure (never a recovery trigger)
 */
type CallKind = 'tool' | 'done' | 'overflow' | 'error500';

interface ReactiveFixtureOptions {
  script: CallKind[];
  contextWindow?: number;
  reserveTokens?: number;
  midTurnEnabled?: boolean;
  withoutPriorTurns?: boolean;
  bigPriors?: boolean;
  summarize?: () => Promise<string | undefined> | string | undefined;
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
  llmCalls: Array<{ status?: string; errorClass?: string }>;
  persist: (event: SessionEvent) => void;
}

function buildReactiveFixture(options: ReactiveFixtureOptions): ReactiveFixture {
  const contextWindow = options.contextWindow ?? 200_000;
  const reserveTokens = options.reserveTokens ?? 1_000;
  const recorded: HistoryCompactCheckpoint[] = [];
  const toolExecutions: string[] = [];
  const events: SessionEvent[] = [];
  const llmCalls: Array<{ status?: string; errorClass?: string }> = [];
  const counters = { summarizerCalls: 0 };
  const usage = (input: number, output: number) => ({
    inputTokens: { total: input, noCache: input, cacheRead: 0, cacheWrite: 0 },
    outputTokens: { total: output, text: output, reasoning: 0 },
  });
  const toolCallChunks = (id: string): LanguageModelV3StreamPart[] => [
    { type: 'stream-start', warnings: [] },
    { type: 'tool-call', toolCallId: id, toolName: 'Read', input: JSON.stringify({ path: 'one.md' }) },
    { type: 'finish', finishReason: { unified: 'tool-calls', raw: 'tool_calls' }, usage: usage(100, 20) },
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
    const chunks = kind === 'tool' ? toolCallChunks(`tool-${call}`) : doneChunks();
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
  const seams = midTurnEnabled
    ? {
        summarizeHistoryCompact: async () => {
          counters.summarizerCalls += 1;
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
    appendMessage: async () => {},
    connection: { ...connection(), models: [{ id: 'mock-model-id', contextWindow }] },
    apiKey: 'sk-test',
    modelId: 'mock-model-id',
    permissionEngine: new PermissionEngine({ newId: () => 'permission-id', now: () => 1 }),
    modelFactory: () => model,
    tools: [
      {
        name: 'Read',
        description: 'Read description',
        parameters: z.object({ path: z.string() }),
        permissionRequired: false,
        impl: async (args: { path: string }) => {
          toolExecutions.push(args.path);
          return { body: RAW_SPAN_ONE };
        },
      },
    ],
    contextBudget: {
      name: 'reactive-test',
      maxHistoryEstimatedTokens: 100_000,
      minRecentTurns: 1,
      historyCompact: {
        enabled: true,
        mode: 'read_write',
        ...(midTurnEnabled ? { midTurn: { enabled: true, reserveTokens } } : {}),
      },
    },
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
    persist,
  };
}

async function runTurn(fixture: ReactiveFixture): Promise<void> {
  for await (const event of fixture.backend.send({
    runId: 'run-1',
    turnId: 'turn-1',
    headAnchorRuntimeEvent: fixture.anchor,
    text: ANCHOR_TEXT,
    context: [],
    runtimeContext: [...fixture.priorEvents],
  })) {
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
