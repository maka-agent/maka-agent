import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { MockLanguageModelV3, simulateReadableStream } from 'ai/test';
import type { LanguageModelV3StreamPart } from '@ai-sdk/provider';
import type { LlmConnection, SessionHeader } from '@maka/core';
import type { SessionEvent } from '@maka/core/events';
import type { RuntimeEvent } from '@maka/core/runtime-event';
import type { AgentBackend, BackendSendInput } from '@maka/core/backend-types';
import { z } from 'zod';
import { AiSdkBackend } from '../ai-sdk-backend.js';
import { AiSdkFlow, createSessionEventMapMemory, mapSessionEventToRuntimeEvent } from '../ai-sdk-flow.js';
import type { InvocationContext } from '../invocation-context.js';
import { PermissionEngine } from '../permission-engine.js';
import { applyRuntimeEventContextBudget, isHistoryCompactContentEvent } from '../context-budget.js';
import type { HistoryCompactCheckpoint } from '../history-compact-checkpoint.js';
import type { ContextBudgetDiagnostic } from '@maka/core/usage-stats/types';

const RAW_SPAN_ONE = 'RAW_SPAN_ONE_'.repeat(24);
const RAW_SPAN_TWO = 'RAW_SPAN_TWO_'.repeat(160);
const ANCHOR_TEXT = 'compact this very long turn but keep my exact words';

interface MidTurnFixture {
  backend: AiSdkBackend;
  model: MockLanguageModelV3;
  recorded: HistoryCompactCheckpoint[];
  recordedBeforeThirdRequest: () => boolean;
  toolExecutions: string[];
  summarizerCalls: number;
  priorEvents: RuntimeEvent[];
  anchor: RuntimeEvent;
  events: SessionEvent[];
  messages: unknown[];
}

interface MidTurnFixtureOptions {
  contextWindow?: number;
  reserveTokens?: number;
  summarize?: () => Promise<string | undefined> | string | undefined;
  branch?: string;
  /** Omit the prior turns so the compaction pool has no safe completed span. */
  withoutPriorTurns?: boolean;
}

function buildFixture(options: MidTurnFixtureOptions = {}): MidTurnFixture {
  const contextWindow = options.contextWindow ?? 2_000;
  const reserveTokens = options.reserveTokens ?? 1_500;
  const recorded: HistoryCompactCheckpoint[] = [];
  const toolExecutions: string[] = [];
  const events: SessionEvent[] = [];
  const messages: unknown[] = [];
  let recordedAtThirdRequest = false;
  const fixture = { summarizerCalls: 0 };
  const usage = (input: number, output: number) => ({
    inputTokens: { total: input, noCache: input, cacheRead: 0, cacheWrite: 0 },
    outputTokens: { total: output, text: output, reasoning: 0 },
  });
  const toolCallChunks = (id: string, path: string): LanguageModelV3StreamPart[] => [
    { type: 'stream-start', warnings: [] },
    { type: 'tool-call', toolCallId: id, toolName: 'Read', input: JSON.stringify({ path }) },
    {
      type: 'finish',
      finishReason: { unified: 'tool-calls', raw: 'tool_calls' },
      usage: usage(id === 'tool-1' ? 100 : 150, id === 'tool-1' ? 20 : 30),
    },
  ];
  const model = new MockLanguageModelV3({
    doStream: async (streamOptions: { abortSignal?: AbortSignal }) => {
      // A real transport rejects immediately on an already-aborted signal; the
      // mock must mirror that so an exhausted turn never streams the
      // over-budget request.
      if (streamOptions.abortSignal?.aborted) {
        throw Object.assign(new Error('aborted'), { name: 'AbortError' });
      }
      const call = model.doStreamCalls.length;
      if (call === 3) recordedAtThirdRequest = recorded.length > 0;
      const chunks: LanguageModelV3StreamPart[] = call === 1
        ? toolCallChunks('tool-1', 'one.md')
        : call === 2
          ? toolCallChunks('tool-2', 'two.md')
          : [
              { type: 'stream-start', warnings: [] },
              { type: 'text-start', id: 'text-1' },
              { type: 'text-delta', id: 'text-1', delta: 'done' },
              { type: 'text-end', id: 'text-1' },
              { type: 'finish', finishReason: { unified: 'stop', raw: 'stop' }, usage: usage(120, 10) },
            ];
      return { stream: simulateReadableStream({ chunks, initialDelayInMs: null, chunkDelayInMs: null }) };
    },
  });
  const priorEvents: RuntimeEvent[] = options.withoutPriorTurns ? [] : [
    runtimeTextEvent('prior-user', 'turn-0', 'user', `PRIOR_FACT question ${'p'.repeat(120)}`),
    runtimeTextEvent('prior-model', 'turn-0', 'model', `PRIOR_FACT answer ${'q'.repeat(120)}`),
  ];
  const anchor: RuntimeEvent = {
    ...runtimeTextEvent('anchor-1', 'turn-1', 'user', ANCHOR_TEXT),
    ...(options.branch !== undefined ? { branch: options.branch } : {}),
  };
  const backend = new AiSdkBackend({
    sessionId: 'session-1',
    header: header(),
    appendMessage: async (message) => { messages.push(message); },
    connection: { ...connection(), models: [{ id: 'mock-model-id', contextWindow }] },
    apiKey: 'sk-test',
    modelId: 'mock-model-id',
    permissionEngine: new PermissionEngine({ newId: () => 'permission-id', now: () => 1 }),
    modelFactory: () => model,
    tools: [{
      name: 'Read',
      description: 'Read description',
      parameters: z.object({ path: z.string() }),
      permissionRequired: false,
      impl: async (args: { path: string }) => {
        toolExecutions.push(args.path);
        return { body: args.path === 'one.md' ? RAW_SPAN_ONE : RAW_SPAN_TWO };
      },
    }],
    contextBudget: {
      name: 'mid-turn-test',
      maxHistoryEstimatedTokens: 100_000,
      minRecentTurns: 1,
      historyCompact: {
        enabled: true,
        mode: 'read_write',
        midTurn: { enabled: true, reserveTokens },
      },
    },
    summarizeHistoryCompact: async () => {
      fixture.summarizerCalls += 1;
      const summary = options.summarize ? await options.summarize() : 'MID_TURN_SUMMARY_SENTINEL';
      return summary;
    },
    recordHistoryCompactCheckpoint: (checkpoint) => { recorded.push(checkpoint); },
    newId: idGenerator(),
    now: monotonicClock(),
  });
  return {
    backend,
    model,
    recorded,
    recordedBeforeThirdRequest: () => recordedAtThirdRequest,
    toolExecutions,
    get summarizerCalls() { return fixture.summarizerCalls; },
    priorEvents,
    anchor,
    events,
    messages,
  };
}

async function runFixtureTurn(fixture: MidTurnFixture, options: { branch?: string } = {}): Promise<void> {
  for await (const event of fixture.backend.send({
    runId: 'run-1',
    turnId: 'turn-1',
    ...(options.branch !== undefined ? { branch: options.branch } : {}),
    headAnchorRuntimeEvent: fixture.anchor,
    text: ANCHOR_TEXT,
    context: [],
    runtimeContext: [...fixture.priorEvents, fixture.anchor],
  })) {
    fixture.events.push(event);
  }
}

function promptJson(fixture: MidTurnFixture, call: number): string {
  return JSON.stringify(fixture.model.doStreamCalls[call]?.prompt.map((message) => ({
    role: message.role,
    content: message.content,
  })));
}

describe('mid-turn capacity compaction in the streaming backend', () => {
  test('compacts over the high water, persists first, and continues the same turn', async () => {
    const fixture = buildFixture();
    await runFixtureTurn(fixture);

    // The turn ran three steps and completed normally.
    assert.equal(fixture.model.doStreamCalls.length, 3);
    const complete = fixture.events.find((event) => event.type === 'complete');
    assert.equal(complete?.type === 'complete' ? complete.stopReason : undefined, 'end_turn');

    // A mid_turn checkpoint was durably recorded before the third request.
    assert.equal(fixture.recorded.length, 1);
    assert.equal(fixture.recordedBeforeThirdRequest(), true);
    const checkpoint = fixture.recorded[0]!;
    assert.equal(checkpoint.phase, 'mid_turn');
    assert.deepEqual(checkpoint.headAnchor, { runtimeEventId: 'anchor-1', turnId: 'turn-1' });
    // Coverage: [prior-user, prior-model, anchor, call-1, result-1].
    assert.equal(checkpoint.coverage.eventCount, 5);

    // The next step's prompt is [compact block, verbatim head anchor, preserved tail].
    const thirdPrompt = promptJson(fixture, 2);
    assert.match(thirdPrompt, /maka_history_compact_checkpoint/);
    assert.match(thirdPrompt, /MID_TURN_SUMMARY_SENTINEL/);
    assert.equal(thirdPrompt.includes(ANCHOR_TEXT), true);
    // The replaced raw span (first tool result and prior turns) is gone...
    assert.equal(thirdPrompt.includes('RAW_SPAN_ONE_'), false);
    assert.equal(thirdPrompt.includes('PRIOR_FACT'), false);
    // ...while the reserved tail (second tool call/result pair) stays verbatim.
    assert.equal(thirdPrompt.includes('RAW_SPAN_TWO_'), true);
    assert.match(thirdPrompt, /tool-2/);

    // Completed tool calls are not executed again.
    assert.deepEqual(fixture.toolExecutions, ['one.md', 'two.md']);

    // The compaction decision lands in the usage diagnostics with phase mid_turn.
    const usageEvent = fixture.events.find((event) => event.type === 'token_usage') as
      | { contextBudget?: ContextBudgetDiagnostic }
      | undefined;
    const decisions = usageEvent?.contextBudget?.compactionDecisions ?? [];
    const midTurnDecision = decisions.find((decision) => decision.phase === 'mid_turn');
    assert.equal(midTurnDecision?.decision, 'replaced');
    assert.equal(midTurnDecision?.reason, 'context_limit');
    assert.deepEqual(midTurnDecision?.boundaryIds, [checkpoint.checkpointId]);
  });

  test('recovery re-projection with ctx.branch replays the checkpoint without the raw span', async () => {
    const fixture = buildFixture({ branch: 'lane-7' });
    await runFixtureTurn(fixture, { branch: 'lane-7' });
    assert.equal(fixture.recorded.length, 1);
    const checkpoint = fixture.recorded[0]!;

    // Rebuild the durable ledger exactly the way AiSdkFlow maps the yielded
    // SessionEvents (same ctx incl. branch), then re-project as a recovery.
    const ctx: InvocationContext = {
      sessionId: 'session-1',
      invocationId: 'run-1',
      runId: 'run-1',
      turnId: 'turn-1',
      branch: 'lane-7',
      source: 'desktop',
      startedAt: 1,
      request: { sessionId: 'session-1', turnId: 'turn-1', text: ANCHOR_TEXT, source: 'desktop' },
      newId: () => 'ledger-id',
      now: () => 1,
    };
    const memory = createSessionEventMapMemory();
    const currentTurnLedger = fixture.events
      .map((event) => mapSessionEventToRuntimeEvent(event, ctx, memory))
      .filter((event) => event.partial !== true)
      .filter((event) => {
        const kind = event.content?.kind;
        return kind === 'text' || kind === 'thinking' || kind === 'function_call' || kind === 'function_response';
      })
      .filter(isHistoryCompactContentEvent);
    for (const event of currentTurnLedger) {
      assert.equal(event.branch, 'lane-7');
    }
    const ledger = [...fixture.priorEvents, fixture.anchor, ...currentTurnLedger];

    const replay = applyRuntimeEventContextBudget(ledger, {
      maxHistoryEstimatedTokens: 100_000,
      minRecentTurns: 1,
      historyCompact: {
        enabled: true,
        mode: 'read_write',
        checkpoint,
        highWaterRatio: 0.000001,
        tailEstimatedTokens: 1,
      },
    });

    assert.ok(replay);
    const replayIds = replay.events.map((event) => event.id);
    // Replay validated: the compact block leads, the head anchor is verbatim,
    // and no covered raw event is re-injected.
    assert.equal(replayIds[0], `history-compact:${checkpoint.checkpointId}`);
    assert.equal(replayIds.includes('anchor-1'), true);
    assert.deepEqual(replay.events[1], fixture.anchor);
    assert.equal(replayIds.includes('prior-user'), false);
    assert.equal(replayIds.includes('prior-model'), false);
    const replayJson = JSON.stringify(replay.events);
    assert.equal(replayJson.includes('RAW_SPAN_ONE_'), false);
    assert.equal(replayJson.includes('RAW_SPAN_TWO_'), true);
  });

  test('ends the turn with context_budget_exhausted when over the window with no safe span', async () => {
    // No prior turns and a window the first step's usage already exceeds: the
    // pool is [anchor, one open call/result pair], so no safe completed span.
    const fixture = buildFixture({ contextWindow: 120, reserveTokens: 100, withoutPriorTurns: true });
    await runFixtureTurn(fixture);

    const complete = fixture.events.find((event) => event.type === 'complete');
    assert.equal(complete?.type, 'complete');
    if (complete?.type !== 'complete') return;
    assert.equal(complete.stopReason, 'context_budget_exhausted');
    assert.equal(complete.contextBudgetExhaustedDetail, 'no_safe_completed_span');
    // Explicit outcome, not a raw provider error.
    assert.equal(fixture.events.some((event) => event.type === 'error'), false);
    // The over-budget request was aborted before it could stream (the second
    // doStream attempt sees an already-aborted signal and rejects).
    assert.equal(fixture.model.doStreamCalls.length <= 2, true);
    assert.equal(fixture.events.some((event) => event.type === 'tool_start' && event.toolName === 'Read' && JSON.stringify(event.args).includes('two.md')), false);
  });

  test('ends the turn with summarizer_failed detail when over the window and the summary fails', async () => {
    // Estimate at the first boundary ≈ 120 real usage + result chars/4 ≈ 200;
    // window 150 puts it over the hard cap while priors leave a safe span.
    const fixture = buildFixture({
      contextWindow: 150,
      reserveTokens: 100,
      summarize: () => { throw new Error('summarizer down'); },
    });
    await runFixtureTurn(fixture);

    const complete = fixture.events.find((event) => event.type === 'complete');
    assert.equal(complete?.type, 'complete');
    if (complete?.type !== 'complete') return;
    assert.equal(complete.stopReason, 'context_budget_exhausted');
    assert.equal(complete.contextBudgetExhaustedDetail, 'summarizer_failed');
  });

  test('ends the turn with head_anchor_exceeds_capacity when even the minimal projection cannot fit', async () => {
    // Priors leave a safe span and the summary succeeds, but the minimal
    // [block, anchor, open pair] projection still exceeds the tiny window.
    const fixture = buildFixture({ contextWindow: 120, reserveTokens: 100 });
    await runFixtureTurn(fixture);

    const complete = fixture.events.find((event) => event.type === 'complete');
    assert.equal(complete?.type, 'complete');
    if (complete?.type !== 'complete') return;
    assert.equal(complete.stopReason, 'context_budget_exhausted');
    assert.equal(complete.contextBudgetExhaustedDetail, 'head_anchor_exceeds_capacity');
  });

  test('fails open under the window when the summarizer fails, with a diagnostic', async () => {
    const fixture = buildFixture({ summarize: () => undefined });
    await runFixtureTurn(fixture);

    // The turn still completes; the third request keeps the raw span.
    assert.equal(fixture.model.doStreamCalls.length, 3);
    const complete = fixture.events.find((event) => event.type === 'complete');
    assert.equal(complete?.type === 'complete' ? complete.stopReason : undefined, 'end_turn');
    assert.equal(fixture.recorded.length, 0);
    const thirdPrompt = promptJson(fixture, 2);
    assert.equal(thirdPrompt.includes('RAW_SPAN_ONE_'), true);
    assert.equal(thirdPrompt.includes('maka_history_compact_checkpoint'), false);

    const usageEvent = fixture.events.find((event) => event.type === 'token_usage') as
      | { contextBudget?: ContextBudgetDiagnostic }
      | undefined;
    const decisions = usageEvent?.contextBudget?.compactionDecisions ?? [];
    const failedOpen = decisions.find(
      (decision) => decision.phase === 'mid_turn' && decision.decision === 'failedOpen',
    );
    assert.equal(failedOpen?.failOpenReason, 'summarizer_failed');
  });

  test('AiSdkFlow forwards branch and the head anchor to backend.send', async () => {
    const sendInputs: BackendSendInput[] = [];
    const anchor = runtimeTextEvent('anchor-1', 'turn-1', 'user', ANCHOR_TEXT);
    const fakeBackend: AgentBackend = {
      kind: 'ai-sdk',
      sessionId: 'session-1',
      // eslint-disable-next-line @typescript-eslint/require-await
      async *send(input: BackendSendInput): AsyncIterable<SessionEvent> {
        sendInputs.push(input);
        yield { type: 'complete', id: 'complete-1', turnId: input.turnId, ts: 2, stopReason: 'end_turn' };
      },
      stop: async () => {},
      respondToPermission: async () => {},
      dispose: async () => {},
    };
    const flow = new AiSdkFlow({ backend: fakeBackend });
    const ctx: InvocationContext = {
      sessionId: 'session-1',
      invocationId: 'run-1',
      runId: 'run-1',
      turnId: 'turn-1',
      branch: 'lane-7',
      source: 'desktop',
      startedAt: 1,
      request: {
        sessionId: 'session-1',
        turnId: 'turn-1',
        text: 'hello',
        source: 'desktop',
        initialRuntimeEvent: anchor,
      },
      newId: idGenerator(),
      now: monotonicClock(),
    };
    for await (const _event of flow.run(ctx, { text: 'hello', context: [] })) {
      // drain
    }
    assert.equal(sendInputs.length, 1);
    assert.equal(sendInputs[0]?.branch, 'lane-7');
    assert.equal(sendInputs[0]?.headAnchorRuntimeEvent, anchor);
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
