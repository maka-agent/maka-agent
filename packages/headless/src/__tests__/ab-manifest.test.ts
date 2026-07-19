import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { buildAbRunManifest, ensureAbRunManifest, readAbRunManifest } from '../ab-manifest.js';
import { sha256 } from './helpers/hash-fixture.js';

describe('buildAbRunManifest', () => {
  test('records generic A/B arm identities for non-prompt experiments', () => {
    const manifest = buildAbRunManifest({
      experimentKind: 'tools',
      arms: [
        {
          id: 'tools-off',
          kind: 'tools',
          fingerprint: sha256('tools-off'),
          metadata: { toolProfile: 'standard' },
        },
        {
          id: 'tools-on',
          kind: 'tools',
          fingerprint: sha256('tools-on'),
          metadata: { toolProfile: 'standard-plus-new-tool' },
        },
      ],
      taskBudgetSec: 30 * 60,
      harborTimeoutMs: 35 * 60 * 1000,
      subjectFingerprint: 'subject:path=/repo;maka-head=abc123;dirty=false',
      taskSourceFingerprint: 'tasks:path=/cache/tasks;selected=task-a:/cache/tasks/a',
      toolchainFingerprint: sha256('c'),
      evaluationTaskIds: ['task-a'],
      reps: 3,
      candidateLimit: null,
      maxConcurrency: 16,
    });

    assert.equal(manifest.experimentKind, 'tools');
    assert.deepEqual(
      manifest.arms.map((arm) => `${arm.kind}:${arm.id}`),
      ['tools:tools-off', 'tools:tools-on'],
    );
    assert.match(manifest.fingerprint, /^sha256:[a-f0-9]{64}$/);
  });

  test('rejects a stored manifest whose body no longer matches its fingerprint', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'maka-ab-manifest-'));
    try {
      const manifest = buildAbRunManifest({
        experimentKind: 'runtime',
        arms: [
          { id: 'off', kind: 'runtime', fingerprint: sha256('off') },
          { id: 'on', kind: 'runtime', fingerprint: sha256('on') },
        ],
        taskBudgetSec: 1800,
        harborTimeoutMs: 2_100_000,
        subjectFingerprint: sha256('subject'),
        taskSourceFingerprint: sha256('tasks'),
        toolchainFingerprint: sha256('toolchain'),
        evaluationTaskIds: ['task-a'],
        reps: 1,
        candidateLimit: null,
        maxConcurrency: 1,
      });
      const path = join(dir, 'manifest.json');
      await writeFile(path, `${JSON.stringify({ ...manifest, taskBudgetSec: 60 })}\n`, 'utf8');

      await assert.rejects(
        ensureAbRunManifest(path, manifest),
        /stored A\/B run manifest fingerprint is invalid/,
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('reads and validates an existing immutable manifest without constructing a replacement', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'maka-ab-manifest-read-'));
    try {
      const manifest = buildAbRunManifest({
        experimentKind: 'runtime',
        metadata: {
          qualification: {
            agent: 'oracle',
            selectedTaskIds: ['task-a'],
          },
        },
        arms: [
          { id: 'off', kind: 'runtime', fingerprint: sha256('off') },
          { id: 'on', kind: 'runtime', fingerprint: sha256('on') },
        ],
        taskBudgetSec: 1800,
        harborTimeoutMs: 2_100_000,
        subjectFingerprint: sha256('subject'),
        taskSourceFingerprint: sha256('tasks'),
        toolchainFingerprint: sha256('toolchain'),
        evaluationTaskIds: ['task-a'],
        reps: 1,
        candidateLimit: null,
        maxConcurrency: 1,
      });
      const path = join(dir, 'manifest.json');
      await writeFile(path, `${JSON.stringify(manifest)}\n`, 'utf8');

      assert.deepEqual(await readAbRunManifest(path), manifest);
      assert.deepEqual(manifest.metadata, {
        qualification: { agent: 'oracle', selectedTaskIds: ['task-a'] },
      });
      assert.equal(await readAbRunManifest(join(dir, 'missing.json')), null);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('atomically chooses one canonical manifest when two processes create the same run', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'maka-ab-manifest-race-'));
    try {
      const base = {
        experimentKind: 'runtime' as const,
        arms: [
          { id: 'off', kind: 'runtime' as const, fingerprint: sha256('off') },
          { id: 'on', kind: 'runtime' as const, fingerprint: sha256('on') },
        ] as const,
        taskBudgetSec: 1800,
        harborTimeoutMs: 2_100_000,
        subjectFingerprint: sha256('subject'),
        taskSourceFingerprint: sha256('tasks'),
        toolchainFingerprint: sha256('toolchain'),
        evaluationTaskIds: ['task-a'],
        reps: 2,
        candidateLimit: null,
        maxConcurrency: 1,
      };
      const flash = buildAbRunManifest({ ...base, observedCostStopUsd: 20 });
      const pro = buildAbRunManifest({ ...base, observedCostStopUsd: 30 });
      const path = join(dir, 'manifest.json');

      const results = await Promise.allSettled([
        ensureAbRunManifest(path, flash),
        ensureAbRunManifest(path, pro),
      ]);

      assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
      assert.equal(results.filter((result) => result.status === 'rejected').length, 1);
      const stored = JSON.parse(await readFile(path, 'utf8'));
      assert.equal(
        stored.fingerprint === flash.fingerprint || stored.fingerprint === pro.fingerprint,
        true,
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
