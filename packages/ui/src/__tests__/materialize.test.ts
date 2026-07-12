import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { AttachmentRef, StoredMessage } from '@maka/core';
import { materializeChat, materializeTurns } from '../materialize.js';

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
describe('materializeTurns mid-turn guidance', () => {
  test('keeps the turn prompt and surfaces a later user row as a steer timeline entry', () => {
    const messages: StoredMessage[] = [
      { type: 'user', id: 'u1', turnId: 't1', ts: 1, text: '这个项目的目的是？' },
      // Mid-turn guidance injected via sessions:injectGuidance — same turnId.
      { type: 'user', id: 'u2', turnId: 't1', ts: 4, text: '本地修改代码是做什么的' },
      { type: 'assistant', id: 'a1', turnId: 't1', ts: 5, text: '回答', modelId: 'fake-model' },
    ];
    const turns = materializeTurns(messages);
    assert.equal(turns.length, 1);
    assert.equal(turns[0].user?.text, '这个项目的目的是？');
    assert.equal(turns[0].user?.id, 'u1');
    const steers = turns[0].timeline.filter((item) => item.kind === 'steer');
    assert.equal(steers.length, 1);
    assert.equal(steers[0].kind, 'steer');
    assert.equal(steers[0].text, '本地修改代码是做什么的');
    assert.equal(steers[0].messageId, 'u2');
  });

  test('renders a guidance continuation as a steer followed by a text entry', () => {
    const messages: StoredMessage[] = [
      { type: 'user', id: 'u1', turnId: 't1', ts: 1, text: '这个项目的目的是？' },
      { type: 'assistant', id: 'a1', turnId: 't1', ts: 2, text: '回答一', modelId: 'fake-model' },
      // Late steer arrives after a text-only reply and triggers a follow-up pass.
      { type: 'user', id: 'u2', turnId: 't1', ts: 5, text: '补充两点' },
      // Guidance continuation produced a second assistant answer in the same turn.
      { type: 'assistant', id: 'a2', turnId: 't1', ts: 9, text: '好的，按两要点重新说明…', modelId: 'fake-model' },
    ];
    const turns = materializeTurns(messages);
    // Aggregate assistant concatenates steps (for copy/export).
    assert.equal(turns[0].assistant?.text, '回答一\n\n好的，按两要点重新说明…');
    const kinds = turns[0].timeline.map((item) => item.kind);
    // text(回答一) -> steer(补充两点) -> text(好的…)
    assert.deepEqual(kinds, ['text', 'steer', 'text']);
  });

  test('does not fragment a normal multi-step turn (no steer) into guidance blocks', () => {
    const messages: StoredMessage[] = [
      { type: 'user', id: 'u1', turnId: 't1', ts: 1, text: 'hello' },
      { type: 'assistant', id: 'a1', turnId: 't1', ts: 2, text: 'part 1', modelId: 'fake-model' },
      { type: 'assistant', id: 'a2', turnId: 't1', ts: 3, text: 'part 2', modelId: 'fake-model' },
    ];
    const turns = materializeTurns(messages);
    assert.equal(turns[0].assistant?.text, 'part 1\n\npart 2');
    const kinds = turns[0].timeline.map((item) => item.kind);
    assert.deepEqual(kinds, ['text', 'text']);
  });

  test('leaves no steer when a turn has only the prompt', () => {
    const messages: StoredMessage[] = [
      { type: 'user', id: 'u1', turnId: 't1', ts: 1, text: 'hello' },
      { type: 'assistant', id: 'a1', turnId: 't1', ts: 2, text: 'hi', modelId: 'fake-model' },
    ];
    const turns = materializeTurns(messages);
    assert.equal(turns[0].timeline.filter((item) => item.kind === 'steer').length, 0);
    assert.equal(turns[0].user?.text, 'hello');
  });
});
