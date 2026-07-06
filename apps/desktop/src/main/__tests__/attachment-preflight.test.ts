import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { preflightAttachmentItems } from '../../renderer/attachment-preflight.js';

describe('attachment preflight (before session create)', () => {
  test('rejects an oversized File so no empty session is created', () => {
    const over = 50 * 1024 * 1024 + 1;
    assert.throws(
      () => preflightAttachmentItems([{ source: { type: 'file', file: { size: over } } }] as never),
      /50MB/,
    );
  });

  test('passes approval tokens and files under the cap', () => {
    assert.doesNotThrow(() =>
      preflightAttachmentItems([{ source: { type: 'approval' } }] as never),
    );
    assert.doesNotThrow(() =>
      preflightAttachmentItems([{ source: { type: 'file', file: { size: 100 } } }] as never),
    );
  });
});