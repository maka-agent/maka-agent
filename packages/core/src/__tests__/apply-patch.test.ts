import { describe, test } from 'node:test';
import { expect } from '../test-helpers.js';
import {
  applyUpdateChunksToContent,
  assertSafePatchPath,
  canonicalizeApplyPatchHunks,
  parseApplyPatch,
  planApplyPatchMutations,
} from '../apply-patch.js';

describe('ApplyPatch', () => {
  test('parses add, update, and delete operations from one patch', () => {
    expect(
      parseApplyPatch(`*** Begin Patch
*** Add File: added.txt
+hello
*** Update File: changed.txt
@@
-before
+after
*** Delete File: removed.txt
*** End Patch`),
    ).toEqual({
      ok: true,
      value: {
        hunks: [
          { kind: 'add', path: 'added.txt', contents: 'hello\n' },
          {
            kind: 'update',
            path: 'changed.txt',
            chunks: [
              {
                oldLines: ['before'],
                newLines: ['after'],
                isEndOfFile: false,
              },
            ],
          },
          { kind: 'delete', path: 'removed.txt' },
        ],
      },
    });
  });

  test('applies update chunks in order while preserving CRLF endings', () => {
    expect(
      applyUpdateChunksToContent(
        'section\r\nold\r\nsection\r\nold\r\n',
        [
          {
            changeContext: 'section',
            oldLines: ['old'],
            newLines: ['first'],
            isEndOfFile: false,
          },
          {
            changeContext: 'section',
            oldLines: ['old'],
            newLines: ['second'],
            isEndOfFile: false,
          },
        ],
        'changed.txt',
      ),
    ).toEqual({
      ok: true,
      content: 'section\r\nfirst\r\nsection\r\nsecond\r\n',
    });
  });

  test('plans later operations against the state produced by earlier operations', () => {
    expect(
      planApplyPatchMutations(
        [
          { kind: 'add', path: 'same.txt', contents: 'before\n' },
          {
            kind: 'update',
            path: 'same.txt',
            chunks: [
              {
                oldLines: ['before'],
                newLines: ['after'],
                isEndOfFile: false,
              },
            ],
          },
        ],
        new Map(),
      ),
    ).toEqual([
      { operation: 'add', path: 'same.txt', content: 'before\n' },
      { operation: 'update', path: 'same.txt', content: 'after\n' },
    ]);
  });

  test('canonicalizes harmless aliases but rejects paths that can escape the workspace', () => {
    expect(canonicalizeApplyPatchHunks([{ kind: 'delete', path: './src//file.ts' }])).toEqual([
      { kind: 'delete', path: 'src/file.ts' },
    ]);
    expect(assertSafePatchPath('../outside.ts')).toBe(
      'path must not contain parent-directory segments',
    );
    expect(assertSafePatchPath('/tmp/outside.ts')).toBe('path must be relative');
    expect(assertSafePatchPath('C:outside.ts')).toBe(
      'path must not use drive-relative or alternate-stream syntax',
    );
  });

  test('rejects move operations before execution planning', () => {
    expect(
      parseApplyPatch(`*** Begin Patch
*** Update File: source.txt
*** Move to: destination.txt
@@
-before
+after
*** End Patch`),
    ).toEqual({
      ok: false,
      error: { code: 'invalid_hunk', message: 'Move to is not supported', lineNumber: 3 },
    });
  });

  test('matches change context as a tolerant whole line and searches after it', () => {
    expect(
      applyUpdateChunksToContent(
        'old\n  section   \nold\n',
        [
          {
            changeContext: 'section',
            oldLines: ['old'],
            newLines: ['new'],
            isEndOfFile: false,
          },
        ],
        'changed.txt',
      ),
    ).toEqual({ ok: true, content: 'old\n  section   \nnew\n' });
  });

  test('prefers the final matching block for an end-of-file hunk', () => {
    expect(
      applyUpdateChunksToContent(
        'same\nkeep\nsame\n',
        [{ oldLines: ['same'], newLines: ['last'], isEndOfFile: true }],
        'changed.txt',
      ),
    ).toEqual({ ok: true, content: 'same\nkeep\nlast\n' });
  });
});
