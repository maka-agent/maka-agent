import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { SessionEvent, SessionHeader, StoredMessage } from '@maka/core';
import { FAKE_ASK_USER_QUESTION_PROMPT, FakeBackend } from '../fake-backend.js';
import type { SessionStore } from '../session-manager.js';

test('text deltas preserve the exact completed response, including Markdown line breaks', async () => {
  const backend = new FakeBackend({
    sessionId: 'session-1',
    header: { model: 'fake-model' } as SessionHeader,
    store: {} as SessionStore,
    appendMessage: async () => {},
  });
  const deltas: string[] = [];
  let completedText = '';

  for await (const event of backend.send({
    turnId: 'turn-1',
    text: '结论先行。\n\n| 名称 | 状态 |\n| --- | --- |\n| A | 完成 |',
    context: [],
  })) {
    if (event.type === 'text_delta') deltas.push(event.text);
    if (event.type === 'text_complete') completedText = event.text;
  }

  assert.equal(deltas.join(''), completedText);
  assert.match(completedText, /\n\n\| 名称 \| 状态 \|/);
});

test('AskUserQuestion scenario parks the same turn until one response continues it', async () => {
  const appended: StoredMessage[] = [];
  const backend = new FakeBackend({
    sessionId: 'session-1',
    header: { model: 'fake-model' } as SessionHeader,
    store: {} as SessionStore,
    appendMessage: async (message) => { appended.push(message); },
  });
  const iterator = backend.send({
    turnId: 'turn-1',
    text: FAKE_ASK_USER_QUESTION_PROMPT,
    context: [],
  })[Symbol.asyncIterator]();

  assert.equal((await iterator.next()).value?.type, 'tool_start');
  const request = (await iterator.next()).value;
  assert.equal(request?.type, 'user_question_request');
  if (request?.type !== 'user_question_request') assert.fail('expected user question request');

  await backend.respondToUserQuestion({ requestId: request.requestId, answers: ['邀请制', null, '自定义节奏'] });

  const remaining: SessionEvent[] = [];
  for await (const event of { [Symbol.asyncIterator]: () => iterator }) remaining.push(event);
  assert.equal(remaining.filter((event) => event.type === 'tool_result').length, 1);
  assert.equal(remaining.at(-1)?.type, 'complete');
  const completed = remaining.find((event) => event.type === 'text_complete');
  assert.ok(completed?.type === 'text_complete');
  assert.match(completed.text, /邀请制.*未回答.*自定义节奏/s);
  assert.deepEqual(appended.map((message) => message.type), ['tool_call', 'tool_result', 'assistant']);
});
