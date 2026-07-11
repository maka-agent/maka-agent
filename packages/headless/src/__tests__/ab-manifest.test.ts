import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { buildAbRunManifest, ensureAbRunManifest } from '../ab-manifest.js';
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
    assert.deepEqual(manifest.arms.map((arm) => `${arm.kind}:${arm.id}`), [
      'tools:tools-off',
      'tools:tools-on',
    ]);
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

      await assert.rejects(ensureAbRunManifest(path, manifest), /stored A\/B run manifest fingerprint is invalid/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
