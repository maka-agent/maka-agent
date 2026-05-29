import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_IMPORTED_TEXT_FILE_BYTES,
  MAX_IMPORTED_TEXT_FILE_COUNT,
  preflightDroppedTextFilesForPromptImport,
} from '../text-file-import.js';

describe('dropped text file import preflight', () => {
  it('accepts bounded clipboard/drop file batches', () => {
    assert.deepEqual(preflightDroppedTextFilesForPromptImport([
      { size: 128 },
      { size: MAX_IMPORTED_TEXT_FILE_BYTES },
    ]), { ok: true });
  });

  it('rejects empty, too many, and oversize batches before renderer reads file text', () => {
    assert.deepEqual(preflightDroppedTextFilesForPromptImport([]), { ok: false, reason: 'missing' });
    assert.deepEqual(
      preflightDroppedTextFilesForPromptImport(Array.from({ length: MAX_IMPORTED_TEXT_FILE_COUNT + 1 }, () => ({ size: 1 }))),
      { ok: false, reason: 'too-many-files' },
    );
    assert.deepEqual(
      preflightDroppedTextFilesForPromptImport([{ size: MAX_IMPORTED_TEXT_FILE_BYTES + 1 }]),
      { ok: false, reason: 'too-large' },
    );
  });
});
