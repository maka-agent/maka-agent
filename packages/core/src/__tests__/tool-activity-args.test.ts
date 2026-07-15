import assert from 'node:assert/strict';
import { it } from 'node:test';

import {
  projectToolActivityArgs,
  projectWriteStdinInput,
  WRITE_STDIN_INPUT_PREVIEW_MAX_CHARS,
} from '../index.js';

it('projects WriteStdin activity to a bounded human-readable input preview', () => {
  const projected = projectToolActivityArgs('WriteStdin', {
    ref: 'maka://runtime/background-tasks/one',
    input: '中\r',
    size: { cols: 100, rows: 30 },
  });
  assert.deepEqual(projected, {
    ref: 'maka://runtime/background-tasks/one',
    inputPreview: { text: '中\\r', bytes: 4, truncated: false },
    size: { cols: 100, rows: 30 },
  });
  assert.doesNotMatch((projected as { inputPreview: { text: string } }).inputPreview.text, /\r/);
  assert.deepEqual(projectToolActivityArgs('WriteStdin', projected), projected);
  assert.deepEqual(projectToolActivityArgs('WriteStdin', 'malformed raw input'), {});
});

it('names terminal controls, redacts secrets, escapes invisible input, and caps previews', () => {
  assert.deepEqual(projectWriteStdinInput('\u0003'), {
    text: 'Ctrl-C',
    bytes: 1,
    truncated: false,
  });
  assert.deepEqual(projectWriteStdinInput('password=super-secret\n'), {
    text: 'password=[redacted]\\n',
    bytes: 22,
    truncated: false,
  });
  assert.deepEqual(projectWriteStdinInput('a\u202Eb'), {
    text: 'a\\u{202E}b',
    bytes: 5,
    truncated: false,
  });

  const long = projectWriteStdinInput('x'.repeat(WRITE_STDIN_INPUT_PREVIEW_MAX_CHARS + 20));
  assert.equal(long.text, 'x'.repeat(WRITE_STDIN_INPUT_PREVIEW_MAX_CHARS));
  assert.equal(long.bytes, WRITE_STDIN_INPUT_PREVIEW_MAX_CHARS + 20);
  assert.equal(long.truncated, true);
});

it('rejects projected previews that bypass the display safety boundary', () => {
  const ref = 'maka://runtime/background-tasks/one';
  for (const text of [
    'spoofed\nrow',
    'password=not-redacted',
    'x'.repeat(WRITE_STDIN_INPUT_PREVIEW_MAX_CHARS + 1),
  ]) {
    assert.deepEqual(projectToolActivityArgs('WriteStdin', {
      ref,
      inputPreview: { text, bytes: 20, truncated: false },
    }), { ref });
  }
});
