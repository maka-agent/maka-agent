import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { StoredMessage } from '@maka/core';
import {
  AUTO_RECAP_DISPLAY_LIMIT_BYTES,
  AUTO_RECAP_IDLE_MS,
  AUTO_RECAP_MIN_TURNS,
  RECAP_INSTRUCTION,
  buildRecapMessages,
  cleanRecapText,
  shouldAutoRecap,
} from '../session-recap.js';

// AUTO_RECAP_DISPLAY_LIMIT_BYTES itself is a plain constant (contract value
// consumed by the runner's idle-recap display suppression, exercised in
// pi-tui-runner.test.ts's "/recap command" suite). Pin its value here so a
// drift is caught next to the rest of the recap contract constants.
test('AUTO_RECAP_DISPLAY_LIMIT_BYTES is 500 bytes', () => {
  assert.equal(AUTO_RECAP_DISPLAY_LIMIT_BYTES, 500);
});

function userMessage(id: string, text: string): StoredMessage {
  return { type: 'user', id, turnId: id, ts: 1, text };
}

function assistantMessage(id: string, text: string): StoredMessage {
  return { type: 'assistant', id, turnId: id, ts: 1, text, modelId: 'model-1' };
}

function toolCallMessage(id: string, toolName: string): StoredMessage {
  return { type: 'tool_call', id, turnId: 't1', ts: 1, toolName, args: {} };
}

function toolResultMessage(id: string, isError: boolean): StoredMessage {
  return {
    type: 'tool_result',
    id,
    turnId: 't1',
    ts: 1,
    toolUseId: id,
    isError,
    content: { kind: 'text', text: 'ok' },
  };
}

describe('cleanRecapText', () => {
  test('collapses whitespace and trims', () => {
    assert.equal(cleanRecapText('  We   fixed\n\nthe   bug.  '), 'We fixed the bug.');
  });

  test('strips a leading Recap: label (case-insensitive)', () => {
    assert.equal(cleanRecapText('Recap: We fixed the bug.'), 'We fixed the bug.');
    assert.equal(cleanRecapText('RECAP:We fixed the bug.'), 'We fixed the bug.');
  });

  test('strips a leading Summary: label (case-insensitive)', () => {
    assert.equal(cleanRecapText('Summary:  We fixed the bug.'), 'We fixed the bug.');
    assert.equal(cleanRecapText('summary：We fixed the bug.'), 'We fixed the bug.');
  });

  test('strips a leading 回顾： label', () => {
    assert.equal(cleanRecapText('回顾：我们修复了问题。'), '我们修复了问题。');
  });

  test('strips one layer of wrapping quotes', () => {
    assert.equal(cleanRecapText('"We fixed the bug."'), 'We fixed the bug.');
    assert.equal(cleanRecapText("'We fixed the bug.'"), 'We fixed the bug.');
    assert.equal(cleanRecapText('“We fixed the bug.”'), 'We fixed the bug.');
  });

  test('truncates to 1200 characters with an ellipsis', () => {
    const long = 'a'.repeat(1300);
    const result = cleanRecapText(long);
    assert.equal(result.length, 1201);
    assert.equal(result.slice(0, 1200), 'a'.repeat(1200));
    assert.equal(result.at(-1), '…');
  });
});

describe('shouldAutoRecap', () => {
  test('idle-time boundary: 179999ms does not trigger, 180000ms does', () => {
    assert.equal(
      shouldAutoRecap({ idleMs: AUTO_RECAP_IDLE_MS - 1, mainTurnCount: 3, lastRecapMainTurnCount: 0 }),
      false,
    );
    assert.equal(
      shouldAutoRecap({ idleMs: AUTO_RECAP_IDLE_MS, mainTurnCount: 3, lastRecapMainTurnCount: 0 }),
      true,
    );
  });

  test('main-turn boundary: 2 turns does not trigger, 3 turns does', () => {
    assert.equal(
      shouldAutoRecap({ idleMs: AUTO_RECAP_IDLE_MS, mainTurnCount: AUTO_RECAP_MIN_TURNS - 1, lastRecapMainTurnCount: 0 }),
      false,
    );
    assert.equal(
      shouldAutoRecap({ idleMs: AUTO_RECAP_IDLE_MS, mainTurnCount: AUTO_RECAP_MIN_TURNS, lastRecapMainTurnCount: 0 }),
      true,
    );
  });

  test('watermark: equal main-turn count does not re-trigger', () => {
    assert.equal(
      shouldAutoRecap({ idleMs: AUTO_RECAP_IDLE_MS, mainTurnCount: 3, lastRecapMainTurnCount: 3 }),
      false,
    );
    assert.equal(
      shouldAutoRecap({ idleMs: AUTO_RECAP_IDLE_MS, mainTurnCount: 4, lastRecapMainTurnCount: 3 }),
      true,
    );
  });
});

describe('buildRecapMessages', () => {
  test('projects user/assistant/tool_call/tool_result and appends the instruction, skipping empty text and non-conversational rows', () => {
    const messages: StoredMessage[] = [
      userMessage('u1', 'Please fix the bug'),
      { type: 'user', id: 'u-empty', turnId: 'u-empty', ts: 1, text: '   ' },
      assistantMessage('a1', 'Looking into it'),
      { type: 'assistant', id: 'a-empty', turnId: 'a-empty', ts: 1, text: '', modelId: 'model-1' },
      toolCallMessage('tc1', 'bash'),
      toolResultMessage('tr1', false),
      toolResultMessage('tr2', true),
      { type: 'permission_decision', id: 'p1', turnId: 't1', ts: 1, toolUseId: 'tc1', toolName: 'bash', decision: 'allow' },
      { type: 'token_usage', id: 'k1', turnId: 't1', ts: 1, input: 10, output: 10 },
      { type: 'turn_state', id: 's1', turnId: 't1', ts: 1, status: 'completed', partialOutputRetained: false },
      { type: 'system_note', id: 'n1', ts: 1, kind: 'session_start' },
    ];

    const result = buildRecapMessages(messages, { contextWindow: undefined });

    assert.deepEqual(result, [
      { role: 'user', content: 'Please fix the bug' },
      { role: 'assistant', content: 'Looking into it' },
      { role: 'assistant', content: '[tool: bash]' },
      { role: 'assistant', content: '[tool result: ok]' },
      { role: 'assistant', content: '[tool result: error]' },
      { role: 'user', content: RECAP_INSTRUCTION },
    ]);
  });

  test('prefers displayText over text for user messages', () => {
    const messages: StoredMessage[] = [
      { type: 'user', id: 'u1', turnId: 'u1', ts: 1, text: 'model-facing envelope', displayText: 'what the user typed' },
    ];
    const result = buildRecapMessages(messages, { contextWindow: undefined });
    assert.deepEqual(result[0], { role: 'user', content: 'what the user typed' });
  });

  test('contextWindow undefined: never trims, even with many messages', () => {
    const messages: StoredMessage[] = Array.from({ length: 50 }, (_, i) => userMessage(`u${i}`, 'x'.repeat(500)));
    const result = buildRecapMessages(messages, { contextWindow: undefined });
    assert.equal(result.length, 51); // 50 projected + instruction
  });

  test('over budget: drops the trailing dangling tool placeholders first, keeping short head messages intact', () => {
    const head: StoredMessage[] = Array.from({ length: 8 }, (_, i) => userMessage(`u${i}`, 'short'));
    const danglingTail: StoredMessage[] = [
      toolCallMessage('tc-huge', 'x'.repeat(5000)),
      toolResultMessage('tr-huge', false),
    ];
    const messages = [...head, ...danglingTail];

    // Budget comfortably covers the 8 short head messages + instruction, but
    // not the huge trailing tool-call placeholder.
    const result = buildRecapMessages(messages, { contextWindow: 5407 });

    assert.equal(result.length, 9); // 8 head messages + instruction
    for (let i = 0; i < 8; i++) {
      assert.deepEqual(result[i], { role: 'user', content: 'short' });
    }
    assert.deepEqual(result.at(-1), { role: 'user', content: RECAP_INSTRUCTION });
  });

  test('over budget beyond the dangling-tool drop: trims from the head down to the last 4 messages plus the instruction', () => {
    const messages: StoredMessage[] = Array.from({ length: 6 }, (_, i) => userMessage(`u${i}`, `keep-${i}`));

    // A tiny context window forces the token budget negative, so trimming
    // proceeds all the way down to the floor.
    const result = buildRecapMessages(messages, { contextWindow: 100 });

    assert.equal(result.length, 5); // last 4 projected messages + instruction
    assert.deepEqual(result.slice(0, 4), [
      { role: 'user', content: 'keep-2' },
      { role: 'user', content: 'keep-3' },
      { role: 'user', content: 'keep-4' },
      { role: 'user', content: 'keep-5' },
    ]);
    assert.deepEqual(result.at(-1), { role: 'user', content: RECAP_INSTRUCTION });
  });
});
