import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { withAbRunLock } from '../ab-run-lock.js';

test('withAbRunLock excludes concurrent writers and releases after completion', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'maka-ab-lock-'));
  try {
    await withAbRunLock(dir, async () => {
      await assert.rejects(
        withAbRunLock(dir, async () => undefined),
        /A\/B run is already active/,
      );
    });
    await withAbRunLock(dir, async () => undefined);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
