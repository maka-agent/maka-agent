/**
 * Tests for `@maka/ui` materializeTurns — the read-only projection from
 * StoredMessage[] into ordered turn view-models (per kenji UI-04).
 *
 * Lives in the desktop workspace because that's where node:test is
 * already wired; the subject under test is the renderer-facing helper.
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { deriveTurnLineageMap, materializeTurns } from '@maka/ui';
import type { StoredMessage } from '@maka/core';

function userMsg(turnId: string, ts: number, text: string, id?: string): StoredMessage {
  return { type: 'user', id: id ?? `u-${turnId}`, turnId, ts, text };
}

function assistantMsg(turnId: string, ts: number, text: string, modelId = 'm', id?: string): StoredMessage {
  return { type: 'assistant', id: id ?? `a-${turnId}`, turnId, ts, text, modelId };
}

function toolCallMsg(turnId: string, ts: number, id: string, toolName = 'Bash'): StoredMessage {
  return { type: 'tool_call', id, turnId, ts, toolName, args: {} };
}

function toolResultMsg(turnId: string, ts: number, toolUseId: string, isError = false): StoredMessage {
  return {
    type: 'tool_result',
    id: `r-${toolUseId}`,
    turnId,
    ts,
    toolUseId,
    isError,
    content: { kind: 'text', text: 'ok' },
  };
}

describe('materializeTurns', () => {
  it('groups one full turn into user → tools → assistant', () => {
    const turns = materializeTurns([
      userMsg('t1', 100, 'hello'),
      toolCallMsg('t1', 101, 'call-1', 'Read'),
      toolResultMsg('t1', 102, 'call-1'),
      assistantMsg('t1', 103, 'hi'),
    ]);
    assert.equal(turns.length, 1);
    const [turn] = turns;
    assert.ok(turn);
    assert.equal(turn.turnId, 't1');
    assert.equal(turn.user?.text, 'hello');
    assert.equal(turn.assistant?.text, 'hi');
    assert.equal(turn.tools.length, 1);
    assert.equal(turn.tools[0]?.toolName, 'Read');
    assert.equal(turn.tools[0]?.status, 'completed');
    assert.equal(turn.status, 'completed');
  });

  it('preserves turn order across multiple turns and isolates tools', () => {
    const turns = materializeTurns([
      userMsg('t1', 100, 'q1'),
      toolCallMsg('t1', 101, 'c1'),
      toolResultMsg('t1', 102, 'c1'),
      assistantMsg('t1', 103, 'a1'),
      userMsg('t2', 200, 'q2'),
      toolCallMsg('t2', 201, 'c2'),
      toolResultMsg('t2', 202, 'c2'),
      assistantMsg('t2', 203, 'a2'),
    ]);
    assert.equal(turns.length, 2);
    assert.equal(turns[0]?.turnId, 't1');
    assert.equal(turns[1]?.turnId, 't2');
    // Tool from turn 1 must not leak into turn 2 (the core regression we'd
    // catch if turn grouping ever fell back to a global tools panel).
    assert.equal(turns[0]?.tools.length, 1);
    assert.equal(turns[1]?.tools.length, 1);
    assert.equal(turns[0]?.tools[0]?.toolUseId, 'c1');
    assert.equal(turns[1]?.tools[0]?.toolUseId, 'c2');
  });

  it('marks an unmatched tool_call as interrupted within its turn', () => {
    const turns = materializeTurns([
      userMsg('t1', 100, 'q'),
      // tool_call without a matching tool_result — turn was abandoned mid-run.
      toolCallMsg('t1', 101, 'c-abort'),
    ]);
    assert.equal(turns.length, 1);
    assert.equal(turns[0]?.tools[0]?.status, 'interrupted');
  });

  it('surfaces canceled ExploreAgent results as interrupted instead of failed', () => {
    const turns = materializeTurns([
      userMsg('t1', 100, 'q'),
      toolCallMsg('t1', 101, 'explore-1', 'ExploreAgent'),
      {
        type: 'tool_result',
        id: 'r-explore-1',
        turnId: 't1',
        ts: 102,
        toolUseId: 'explore-1',
        isError: true,
        content: {
          kind: 'explore_agent',
          ok: false,
          mode: 'read_only',
          objective: 'scan cancelled',
          roots: [],
          queries: [],
          filesInspected: 0,
          filesSkipped: 0,
          bytesRead: 0,
          progress: [],
          candidateFiles: [],
          matches: [],
          notes: [],
          reason: 'aborted',
          message: '只读探索已取消。',
        },
      } as StoredMessage,
    ]);
    assert.equal(turns[0]?.tools[0]?.status, 'interrupted');
  });

  it('routes live in-flight tools into the latest turn when no matching tool_call is persisted', () => {
    // Scenario: user sent a message, server hasn't persisted the tool_call
    // yet, but a live event stream surfaced a "running" tool. It should
    // land inside the active turn, not float at the bottom.
    const turns = materializeTurns(
      [userMsg('t1', 100, 'q'), assistantMsg('t1', 999, 'placeholder')],
      [
        {
          toolUseId: 'live-1',
          toolName: 'Bash',
          status: 'running',
          args: { command: 'pwd' },
        },
      ],
    );
    assert.equal(turns.length, 1);
    assert.equal(turns[0]?.tools.length, 1);
    assert.equal(turns[0]?.tools[0]?.toolUseId, 'live-1');
    assert.equal(turns[0]?.tools[0]?.status, 'running');
  });

  it('falls back to __loose for messages without a turnId', () => {
    const turns = materializeTurns([
      // Legacy / fake-backend message: missing turnId at the type level
      // through an explicit cast, since real persisted messages always
      // carry one but defensive code paths must still render.
      { type: 'user', id: 'u-legacy', text: 'pre-turnId era', ts: 50 } as unknown as StoredMessage,
    ]);
    assert.equal(turns.length, 1);
    assert.equal(turns[0]?.turnId, '__loose');
    assert.equal(turns[0]?.user?.text, 'pre-turnId era');
  });

  it('captures modelId, durationMs, and assistantThinking from the assistant message', () => {
    const turns = materializeTurns([
      userMsg('t1', 100, 'q'),
      {
        type: 'assistant',
        id: 'a1',
        turnId: 't1',
        ts: 5_100,
        text: 'final',
        modelId: 'claude-sonnet-4-5',
        thinking: { text: 'first I considered...' },
      } as StoredMessage,
    ]);
    assert.equal(turns[0]?.modelId, 'claude-sonnet-4-5');
    assert.equal(turns[0]?.durationMs, 5000);
    assert.equal(turns[0]?.assistantThinking, 'first I considered...');
  });

  it('concatenates per-step assistant messages into one answer with the first step id and last ts', () => {
    // A multi-step turn persists one AssistantMessage per model step; the turn
    // view-model joins their text (and thinking) in order, anchors on the first
    // step id, and measures durationMs to the final step.
    const turns = materializeTurns([
      userMsg('t1', 100, 'q'),
      toolCallMsg('t1', 101, 'c1'),
      toolResultMsg('t1', 102, 'c1'),
      {
        type: 'assistant',
        id: 'step-1',
        turnId: 't1',
        ts: 103,
        text: 'first, I check the file',
        modelId: 'claude-sonnet-4-5',
        thinking: { text: 'reasoning one' },
      } as StoredMessage,
      {
        type: 'assistant',
        id: 'step-2',
        turnId: 't1',
        ts: 205,
        text: 'here is the answer',
        modelId: 'claude-sonnet-4-5',
        thinking: { text: 'reasoning two' },
      } as StoredMessage,
    ]);
    assert.equal(turns.length, 1);
    assert.equal(turns[0]?.assistant?.id, 'step-1');
    assert.equal(turns[0]?.assistant?.text, 'first, I check the file\n\nhere is the answer');
    assert.equal(turns[0]?.assistant?.ts, 205);
    assert.equal(turns[0]?.assistantThinking, 'reasoning one\n\nreasoning two');
    assert.equal(turns[0]?.durationMs, 105);
  });

  it('leaves durationMs undefined when assistant message is missing (in-progress turn)', () => {
    const turns = materializeTurns([userMsg('t1', 100, 'q')]);
    assert.equal(turns[0]?.durationMs, undefined);
    assert.equal(turns[0]?.assistantThinking, undefined);
    // In-progress is the absence of assistant; UI renders "进行中" pill.
    assert.equal(turns[0]?.assistant, undefined);
  });

  it('surfaces persisted turn status + lineage fields', () => {
    const turns = materializeTurns([
      userMsg('old', 1, 'first'),
      {
        type: 'turn_state',
        id: 'state-old',
        turnId: 'old',
        ts: 2,
        status: 'aborted',
        abortedAt: 2,
        partialOutputRetained: false,
      },
      userMsg('retry', 3, 'first'),
      {
        type: 'turn_state',
        id: 'state-retry',
        turnId: 'retry',
        ts: 4,
        status: 'running',
        parentTurnId: 'old',
        retriedFromTurnId: 'old',
        partialOutputRetained: false,
      },
    ]);

    assert.equal(turns[0]?.status, 'aborted');
    assert.equal(turns[0]?.abortedAt, 2);
    assert.equal(turns[1]?.status, 'running');
    assert.equal(turns[1]?.parentTurnId, 'old');
    assert.equal(turns[1]?.retriedFromTurnId, 'old');
  });

  it('sums token_usage messages within the turn', () => {
    const turns = materializeTurns([
      userMsg('t1', 100, 'q'),
      {
        type: 'token_usage',
        id: 'tu-1',
        turnId: 't1',
        ts: 110,
        input: 1000,
        output: 200,
        cacheMissInput: 800,
        cacheRead: 150,
        reasoning: 20,
        costUsd: 0.01,
      } as StoredMessage,
      {
        type: 'token_usage',
        id: 'tu-2',
        turnId: 't1',
        ts: 120,
        input: 500,
        output: 50,
        cacheMissInput: 300,
        cacheRead: 100,
        reasoning: 5,
        costUsd: 0.005,
      } as StoredMessage,
      assistantMsg('t1', 200, 'a'),
    ]);
    assert.equal(turns[0]?.tokens?.input, 1500);
    assert.equal(turns[0]?.tokens?.output, 250);
    assert.equal(turns[0]?.tokens?.cacheMiss, 1100);
    assert.equal(turns[0]?.tokens?.cacheRead, 250);
    assert.equal(turns[0]?.tokens?.reasoning, 25);
    // Use a tolerance since FP add may produce 0.015000000000000001 etc.
    assert.ok(
      turns[0]?.tokens?.costUsd !== undefined &&
        Math.abs(turns[0]!.tokens!.costUsd - 0.015) < 1e-6,
    );
  });

  it('merges live tool over persisted tool keeping the latest status', () => {
    // Persisted shows completed (server thinks it ended); live event says
    // it's actually still running. UI should prefer the live status so a
    // late-completing tool doesn't show stale "completed" while the user
    // is still seeing the in-flight spinner elsewhere.
    const turns = materializeTurns(
      [
        userMsg('t1', 100, 'q'),
        toolCallMsg('t1', 101, 'c1'),
        toolResultMsg('t1', 102, 'c1'),
      ],
      [
        {
          toolUseId: 'c1',
          toolName: 'Bash',
          status: 'running',
          args: {},
        },
      ],
    );
    assert.equal(turns[0]?.tools.length, 1);
    assert.equal(turns[0]?.tools[0]?.status, 'running');
  });

  it('persisted `interrupted` wins when live is still in-flight (PR-UI-12 @xuan review)', () => {
    // After turn abort: persisted JSONL has a `tool_call` but no
    // `tool_result`, so materializeTools marks it `interrupted`. If the
    // live event handler missed cleaning up (e.g. error path didn't get
    // a per-tool patch), live stays `running`. Without the scoped merge
    // exception, live `running` would mask persisted `interrupted` and
    // the UI would keep showing the in-flight spinner for an aborted
    // tool. The exception is intentionally scoped to live being still
    // in-flight (pending / running / waiting_permission) — if live has
    // already moved to `completed` or `errored`, live wins per the
    // general rule.
    const turns = materializeTurns(
      [
        userMsg('t1', 100, 'q'),
        toolCallMsg('t1', 101, 'c1'),
        // no tool_result → persisted status === 'interrupted'
      ],
      [
        {
          toolUseId: 'c1',
          toolName: 'Bash',
          status: 'running',
          args: {},
          outputChunks: [
            { seq: 0, stream: 'stdout', text: 'hello\n', redacted: false, createdAt: 100 },
          ],
        },
      ],
    );
    assert.equal(turns[0]?.tools.length, 1);
    assert.equal(turns[0]?.tools[0]?.status, 'interrupted');
    // Output chunks must survive the merge — chunks come from live.
    assert.equal(turns[0]?.tools[0]?.outputChunks?.length, 1);
  });
});

describe('deriveTurnLineageMap', () => {
  it('derives reverse links without mutating old turns', () => {
    const map = deriveTurnLineageMap([
      { turnId: 'old' },
      { turnId: 'retry', retriedFromTurnId: 'old' },
      { turnId: 'regen', regeneratedFromTurnId: 'old' },
    ]);

    assert.deepEqual(map.get('old'), {
      retriedToTurnId: 'retry',
      regeneratedToTurnId: 'regen',
    });
  });

  it('returns empty map when no descendants', () => {
    const map = deriveTurnLineageMap([
      { turnId: 'solo-a' },
      { turnId: 'solo-b' },
    ]);
    assert.equal(map.size, 0);
  });

  it('retriedTo only when no regenerate descendant exists', () => {
    const map = deriveTurnLineageMap([
      { turnId: 'origin' },
      { turnId: 'retry-1', retriedFromTurnId: 'origin' },
    ]);
    assert.deepEqual(map.get('origin'), { retriedToTurnId: 'retry-1' });
    assert.equal(map.get('origin')?.regeneratedToTurnId, undefined);
  });

  it('regeneratedTo only when no retry descendant exists', () => {
    const map = deriveTurnLineageMap([
      { turnId: 'origin' },
      { turnId: 'regen-1', regeneratedFromTurnId: 'origin' },
    ]);
    assert.deepEqual(map.get('origin'), { regeneratedToTurnId: 'regen-1' });
    assert.equal(map.get('origin')?.retriedToTurnId, undefined);
  });

  it('multi-retry uses last-wins semantics (most recent retry surfaced)', () => {
    // Two retries off the same origin: the most recent one in the
    // input array wins. UI consumers can show "已重新生成 → turn ${id}"
    // pointing at the latest attempt; older retries are still findable
    // by scanning the turn list for `retriedFromTurnId === origin`.
    const map = deriveTurnLineageMap([
      { turnId: 'origin' },
      { turnId: 'retry-1', retriedFromTurnId: 'origin' },
      { turnId: 'retry-2', retriedFromTurnId: 'origin' },
      { turnId: 'retry-3', retriedFromTurnId: 'origin' },
    ]);
    assert.equal(map.get('origin')?.retriedToTurnId, 'retry-3');
  });

  it('mixed retry + regenerate descendants populate both fields independently', () => {
    const map = deriveTurnLineageMap([
      { turnId: 'origin' },
      { turnId: 'retry-1', retriedFromTurnId: 'origin' },
      { turnId: 'regen-1', regeneratedFromTurnId: 'origin' },
      { turnId: 'regen-2', regeneratedFromTurnId: 'origin' },
    ]);
    const entry = map.get('origin');
    assert.equal(entry?.retriedToTurnId, 'retry-1');
    assert.equal(entry?.regeneratedToTurnId, 'regen-2'); // last regen wins
  });

  it('multiple origins each get their own entry', () => {
    const map = deriveTurnLineageMap([
      { turnId: 'origin-a' },
      { turnId: 'origin-b' },
      { turnId: 'retry-a', retriedFromTurnId: 'origin-a' },
      { turnId: 'retry-b', retriedFromTurnId: 'origin-b' },
    ]);
    assert.equal(map.size, 2);
    assert.equal(map.get('origin-a')?.retriedToTurnId, 'retry-a');
    assert.equal(map.get('origin-b')?.retriedToTurnId, 'retry-b');
  });

  it('descendant turns without a lineage parent do not appear as origins', () => {
    // A bare turn list (no parents pointing to anything) produces an
    // empty map even if the turns themselves carry no lineage fields.
    const map = deriveTurnLineageMap([
      { turnId: 'a' },
      { turnId: 'b' },
      { turnId: 'c' },
    ]);
    assert.equal(map.size, 0);
  });

  it('helper is pure (no mutation of input)', () => {
    const input = [
      { turnId: 'origin' },
      { turnId: 'retry', retriedFromTurnId: 'origin' },
    ] as const;
    const before = JSON.stringify(input);
    deriveTurnLineageMap(input);
    assert.equal(JSON.stringify(input), before);
  });
});
