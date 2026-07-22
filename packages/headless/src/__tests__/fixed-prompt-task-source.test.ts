import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  fingerprintFixedPromptTask,
  fingerprintFixedPromptTaskTree,
  selectTasksByIds,
} from '../fixed-prompt-task-source.js';

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

test('per-task fingerprint is unaffected by another task changing', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'maka-task-identity-'));
  try {
    const taskA = { id: 'task-a', path: join(dir, 'task-a') };
    const taskB = { id: 'task-b', path: join(dir, 'task-b') };
    await mkdir(taskA.path, { recursive: true });
    await mkdir(taskB.path, { recursive: true });
    await writeFile(join(taskA.path, 'task.toml'), 'a-v1\n', 'utf8');
    await writeFile(join(taskB.path, 'task.toml'), 'b-v1\n', 'utf8');
    const before = await fingerprintFixedPromptTask(taskA);

    await writeFile(join(taskB.path, 'task.toml'), 'b-v2\n', 'utf8');

    assert.equal(await fingerprintFixedPromptTask(taskA), before);
    assert.notEqual(await fingerprintFixedPromptTask(taskB), before);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('selectTasksByIds preserves the requested order and returns the matching tasks', () => {
  const tasks = [
    { id: 'task-a', path: '/tasks/task-a' },
    { id: 'task-b', path: '/tasks/task-b' },
    { id: 'task-c', path: '/tasks/task-c' },
  ];

  const selected = selectTasksByIds(tasks, ['task-c', 'task-a']);

  assert.deepEqual(
    selected,
    [tasks[2], tasks[0]],
    'selection must follow the requested id order, not discovery order',
  );
});

test('selectTasksByIds rejects duplicate ids by default with the exact message', () => {
  const tasks = [
    { id: 'task-a', path: '/tasks/task-a' },
    { id: 'task-b', path: '/tasks/task-b' },
  ];

  assert.throws(
    () => selectTasksByIds(tasks, ['task-a', 'task-b', 'task-a']),
    new Error('duplicate task id(s): task-a'),
  );
});

test('selectTasksByIds passes duplicates through when rejectDuplicates is false', () => {
  const tasks = [{ id: 'task-a', path: '/tasks/task-a' }];

  const selected = selectTasksByIds(tasks, ['task-a', 'task-a'], { rejectDuplicates: false });

  assert.deepEqual(selected, [tasks[0], tasks[0]]);
});

test('selectTasksByIds reports unknown ids with the exact unlabeled message', () => {
  const tasks = [{ id: 'task-a', path: '/tasks/task-a' }];

  assert.throws(
    () => selectTasksByIds(tasks, ['task-a', 'nope', 'missing']),
    new Error('unknown task id(s): nope, missing'),
  );
});

test('selectTasksByIds prefixes the unknown-id message with the caller label', () => {
  const tasks = [{ id: 'task-a', path: '/tasks/task-a' }];

  assert.throws(
    () => selectTasksByIds(tasks, ['nope'], { label: 'pilotTaskIds', rejectDuplicates: false }),
    new Error('pilotTaskIds contains unknown task id(s): nope'),
  );
});
