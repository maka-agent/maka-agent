import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fingerprintFixedPromptTaskTree } from '../fixed-prompt-task-source.js';

test('task tree fingerprint is root-independent and content-sensitive', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'maka-task-tree-'));
  try {
    const left = join(dir, 'left', 'task-a');
    const right = join(dir, 'right', 'task-a');
    await mkdir(left, { recursive: true });
    await mkdir(right, { recursive: true });
    await writeFile(join(left, 'task.toml'), '[agent]\ntimeout_sec = 900\n', 'utf8');
    await writeFile(join(right, 'task.toml'), '[agent]\ntimeout_sec = 900\n', 'utf8');

    const leftFingerprint = await fingerprintFixedPromptTaskTree([{ id: 'task-a', path: left }]);
    const rightFingerprint = await fingerprintFixedPromptTaskTree([{ id: 'task-a', path: right }]);
    assert.equal(rightFingerprint, leftFingerprint);

    await writeFile(join(right, 'task.toml'), '[agent]\ntimeout_sec = 901\n', 'utf8');
    assert.notEqual(
      await fingerprintFixedPromptTaskTree([{ id: 'task-a', path: right }]),
      leftFingerprint,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
