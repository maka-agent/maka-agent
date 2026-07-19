import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { __TEST__ } from '../simple-bridge.js';

const { telegramAttachmentKind } = __TEST__;

describe('telegramAttachmentKind (PR-BOT-NON-TEXT-MESSAGE-ACK-0)', () => {
  it('returns undefined for a plain text message', () => {
    assert.equal(telegramAttachmentKind({ text: 'hello' }), undefined);
    assert.equal(telegramAttachmentKind({ caption: 'hi' }), undefined);
  });

  it('identifies photo messages (Telegram sends an array of sizes)', () => {
    assert.equal(
      telegramAttachmentKind({ photo: [{ file_id: 'a', width: 90, height: 90 }] }),
      'photo',
    );
  });

  it('treats an empty photo array as no photo', () => {
    // Telegram never sends an empty photo array, but be defensive.
    assert.equal(telegramAttachmentKind({ photo: [] }), undefined);
  });

  it('identifies voice / audio separately so the ack copy can differ', () => {
    assert.equal(telegramAttachmentKind({ voice: { file_id: 'v' } }), 'voice');
    assert.equal(telegramAttachmentKind({ audio: { file_id: 'a' } }), 'audio');
  });

  it('identifies stickers without confusing them with images', () => {
    assert.equal(telegramAttachmentKind({ sticker: { file_id: 's' } }), 'sticker');
  });

  it('identifies animation (GIFs) separately from video', () => {
    assert.equal(telegramAttachmentKind({ animation: { file_id: 'g' } }), 'animation');
    assert.equal(telegramAttachmentKind({ video: { file_id: 'v' } }), 'video');
    assert.equal(telegramAttachmentKind({ video_note: { file_id: 'vn' } }), 'video');
  });

  it('identifies generic documents', () => {
    assert.equal(telegramAttachmentKind({ document: { file_id: 'd' } }), 'document');
  });

  it('returns "unknown" for less common subtypes so they still get an ack', () => {
    assert.equal(telegramAttachmentKind({ location: { latitude: 0, longitude: 0 } }), 'unknown');
    assert.equal(telegramAttachmentKind({ contact: { phone_number: '+1' } }), 'unknown');
    assert.equal(telegramAttachmentKind({ poll: { question: 'q' } }), 'unknown');
    assert.equal(telegramAttachmentKind({ dice: { emoji: '🎲', value: 4 } }), 'unknown');
    assert.equal(telegramAttachmentKind({ venue: { title: 'v' } }), 'unknown');
  });

  it('defends against missing / non-object input', () => {
    assert.equal(telegramAttachmentKind(undefined), undefined);
    assert.equal(telegramAttachmentKind(null), undefined);
    assert.equal(telegramAttachmentKind('text'), undefined);
  });

  it('photo takes precedence over caption text presence', () => {
    // A photo with caption — kind should still be detectable so the
    // handler can route on attachment + text together.
    assert.equal(
      telegramAttachmentKind({
        photo: [{ file_id: 'a', width: 90, height: 90 }],
        caption: 'look at this',
      }),
      'photo',
    );
  });
});
