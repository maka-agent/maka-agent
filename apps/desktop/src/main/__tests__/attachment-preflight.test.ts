import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { preflightAttachmentItems } from '../../renderer/attachment-preflight.js';

const CAP = 50 * 1024 * 1024;

describe('attachment preflight (before session create)', () => {
  test('rejects more than 8 items before any session is created', () => {
    const items = Array.from({ length: 9 }, () => ({
      size: 100,
      source: { type: 'file' as const, file: { size: 100 } },
    }));
    assert.throws(() => preflightAttachmentItems(items), /8/);
  });

  test('rejects an oversized File so no empty session is created', () => {
    assert.throws(
      () => preflightAttachmentItems([{ size: CAP + 1, source: { type: 'file', file: { size: CAP + 1 } } }]),
      /50MB/,
    );
  });

  test('rejects an oversized approval-token attachment by pending size', () => {
    assert.throws(
      () => preflightAttachmentItems([{ size: CAP + 1, source: { type: 'approval', approvalId: 'a1' } }]),
      /50MB/,
    );
  });

  test('rejects a duplicate approvalId', () => {
    assert.throws(
      () =>
        preflightAttachmentItems([
          { size: 10, source: { type: 'approval', approvalId: 'dup' } },
          { size: 10, source: { type: 'approval', approvalId: 'dup' } },
        ]),
      /重复/,
    );
  });

  test('passes approval tokens and files under the cap', () => {
    assert.doesNotThrow(() =>
      preflightAttachmentItems([
        { size: 100, source: { type: 'approval', approvalId: 'a1' } },
        { size: 100, source: { type: 'file', file: { size: 100 } } },
      ]),
    );
  });
});