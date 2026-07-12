import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { SessionHeader } from '@maka/core';
import { FakeBackend } from '../fake-backend.js';
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
