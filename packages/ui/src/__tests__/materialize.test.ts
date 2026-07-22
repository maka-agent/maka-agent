import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { AttachmentRef, StoredMessage } from '@maka/core';
import {
  materializeChat,
  materializeTurns,
  overlayLiveTurn,
  type TurnTimelineItem,
} from '../materialize.js';

const imageAttachment: AttachmentRef = {
  kind: 'image',
  name: 'chart.png',
  mimeType: 'image/png',
  bytes: 1024,
  ref: { kind: 'session_file', sessionId: 's1', relativePath: 'chart.png' },
};

const codeAttachment: AttachmentRef = {
  kind: 'code',
  name: 'main.ts',
  mimeType: 'text/typescript',
  bytes: 512,
  ref: { kind: 'workspace_file', relativePath: 'src/main.ts' },
};

describe('materializeChat attachments', () => {
  test('projects user message attachments onto the chat item', () => {
    const messages: StoredMessage[] = [
      { type: 'user', id: 'm1', turnId: 't1', ts: 1, text: 'see this', attachments: [imageAttachment, codeAttachment] },
    ];
    const items = materializeChat(messages);
    assert.equal(items.length, 1);
    assert.deepEqual(items[0].attachments, [imageAttachment, codeAttachment]);
  });

  test('leaves attachments absent when the user message has none', () => {
    const messages: StoredMessage[] = [
      { type: 'user', id: 'm1', turnId: 't1', ts: 1, text: 'plain prompt' },
    ];
    const items = materializeChat(messages);
    assert.equal(items.length, 1);
    assert.equal(items[0].attachments, undefined);
  });

  test('surfaces automatic context compaction system notes inline', () => {
    const messages: StoredMessage[] = [
      { type: 'system_note', id: 'note-1', turnId: 't1', ts: 1, kind: 'context_compacted' },
    ];
    const items = materializeChat(messages);
    assert.equal(items.length, 1);
    assert.equal(items[0].role, 'system');
    assert.equal(items[0].text, 'Context compacted to keep this session within the model window.');
  });

  test('surfaces history compaction fail-open notices inline', () => {
    const messages: StoredMessage[] = [
      { type: 'system_note', id: 'note-1', turnId: 't1', ts: 1, kind: 'context_compaction_failed_open' },
    ];
    const items = materializeChat(messages);
    assert.equal(items.length, 1);
    assert.equal(items[0].role, 'system');
    assert.equal(
      items[0].text,
      'Context summary failed; the session continued without a new summary.',
    );
  });

  test('surfaces a step-limit system notice inline', () => {
    const items = materializeChat([
      { type: 'system_note', id: 'note-1', turnId: 't1', ts: 1, kind: 'step_limit' },
    ]);

    assert.equal(items.length, 1);
    assert.equal(items[0].role, 'system');
    assert.equal(
      items[0].text,
      'Reached the configured step limit. The task may be incomplete. Send “continue” to resume.',
    );
  });
});

// ── #1307: reasoning + tool calls fold into collapsible Processing blocks ─────

function userMsg(turnId: string, ts: number, text: string): StoredMessage {
  return { type: 'user', id: `u-${turnId}`, turnId, ts, text };
}

function assistantStep(
  turnId: string,
  ts: number,
  id: string,
  text: string,
  thinking?: string,
): StoredMessage {
  return {
    type: 'assistant',
    id,
    turnId,
    ts,
    text,
    modelId: 'm',
    ...(thinking !== undefined ? { thinking: { text: thinking } } : {}),
  } as StoredMessage;
}

function toolCallStep(turnId: string, ts: number, id: string, stepId: string, toolName = 'Read'): StoredMessage {
  return { type: 'tool_call', id, turnId, ts, toolName, args: {}, stepId };
}

function toolResult(turnId: string, ts: number, toolUseId: string): StoredMessage {
  return { type: 'tool_result', id: `r-${toolUseId}`, turnId, ts, toolUseId, isError: false, content: { kind: 'text', text: 'ok' } };
}

function childKinds(item: TurnTimelineItem | undefined): string[] {
  return item?.kind === 'processing' ? item.children.map((child) => child.kind) : [];
}

describe('materializeTurns processing grouping (#1307)', () => {
  test('folds a pure-thinking run into one processing block', () => {
    const turns = materializeTurns([
      userMsg('t1', 100, 'q'),
      assistantStep('t1', 101, 'a1', '', 'reasoning only'),
    ]);
    const timeline = turns[0]!.timeline;
    assert.deepEqual(timeline.map((item) => item.kind), ['processing']);
    assert.deepEqual(childKinds(timeline[0]), ['thinking']);
  });

  test('folds a pure-tools run into one processing block', () => {
    const turns = materializeTurns([
      userMsg('t1', 100, 'q'),
      toolCallStep('t1', 101, 'c1', 'a1'),
      toolResult('t1', 102, 'c1'),
      assistantStep('t1', 103, 'a1', ''),
    ]);
    const timeline = turns[0]!.timeline;
    assert.deepEqual(timeline.map((item) => item.kind), ['processing']);
    assert.deepEqual(childKinds(timeline[0]), ['tools']);
  });

  test('keeps interleaved thinking + tools inside one block, in order', () => {
    const turns = materializeTurns([
      userMsg('t1', 100, 'q'),
      toolCallStep('t1', 101, 'c1', 'a1'),
      toolResult('t1', 102, 'c1'),
      assistantStep('t1', 103, 'a1', '', 'think then call'),
    ]);
    const timeline = turns[0]!.timeline;
    assert.deepEqual(timeline.map((item) => item.kind), ['processing']);
    // Reasoning renders above the tools it precedes, full timeline preserved.
    assert.deepEqual(childKinds(timeline[0]), ['thinking', 'tools']);
  });

  test('answer text is a boundary: two steps yield several processing blocks around the texts', () => {
    const turns = materializeTurns([
      userMsg('t1', 100, 'q'),
      toolCallStep('t1', 101, 'c1', 'a1'),
      toolResult('t1', 102, 'c1'),
      assistantStep('t1', 103, 'a1', 'step one', 'think one'),
      toolCallStep('t1', 104, 'c2', 'a2'),
      toolResult('t1', 105, 'c2'),
      assistantStep('t1', 106, 'a2', 'step two', 'think two'),
    ]);
    const timeline = turns[0]!.timeline;
    // thinking, text, tools, thinking, text, tools ->
    // processing[thinking], text, processing[tools, thinking], text, processing[tools]
    assert.deepEqual(timeline.map((item) => item.kind), [
      'processing',
      'text',
      'processing',
      'text',
      'processing',
    ]);
    assert.deepEqual(childKinds(timeline[0]), ['thinking']);
    assert.deepEqual(childKinds(timeline[2]), ['tools', 'thinking']);
    assert.deepEqual(childKinds(timeline[4]), ['tools']);
    assert.equal((timeline[1] as { text: string }).text, 'step one');
    assert.equal((timeline[3] as { text: string }).text, 'step two');
  });

  test('live overlay path folds a streaming step the same way as settled history', () => {
    const timeline = overlayLiveTurn([], {
      turnId: 't1',
      phase: 'streamed',
      steps: [{
        stepId: 'a1',
        thinking: { text: '先测试工具', truncated: false, complete: false },
        tools: [{ toolUseId: 'c1', toolName: 'Read', stepId: 'a1', status: 'running', args: {} }],
      }],
    })[0]?.timeline;
    assert.deepEqual(timeline?.map((item) => item.kind), ['processing']);
    assert.deepEqual(childKinds(timeline?.[0]), ['thinking', 'tools']);
    // The live processing block keeps its answer texts as boundaries: a live
    // step with text splits reasoning/tools out of the answer.
    const withText = overlayLiveTurn([], {
      turnId: 't2',
      phase: 'streamed',
      steps: [{
        stepId: 'a1',
        thinking: { text: 'think', truncated: false, complete: true },
        text: { text: 'answer', truncated: false, complete: false },
        tools: [{ toolUseId: 'c2', toolName: 'Bash', stepId: 'a1', status: 'running', args: {} }],
      }],
    })[0]?.timeline;
    assert.deepEqual(withText?.map((item) => item.kind), ['processing', 'text', 'processing']);
  });
});
