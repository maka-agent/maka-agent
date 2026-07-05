import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { AttachmentRef, StoredMessage } from '@maka/core';
import { materializeChat } from '../materialize.js';

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
});
