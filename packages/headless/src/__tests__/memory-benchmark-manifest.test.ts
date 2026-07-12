import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { appendFile, mkdir, mkdtemp, readFile, rm, symlink, unlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { describe, test } from 'node:test';
import { buildRunManifestFingerprint } from '../ab-manifest.js';
import {
  MEMORY_BENCHMARK_FORMAT_V1,
  appendMemoryBenchmarkAttempt,
  buildMemoryBenchmarkManifest,
  ensureMemoryBenchmarkManifest,
  hashMemoryBenchmarkArtifact,
  importHarborMemoryBenchmarkAttempt,
  parseMemoryBenchmarkManifest,
  planMemoryBenchmarkResume,
  readMemoryBenchmarkAttempts,
  redactMemoryBenchmarkArtifact,
  recomputeMemoryBenchmarkScore,
  writeRedactedMemoryBenchmarkJson,
  writeRedactedMemoryBenchmarkText,
  type MemoryBenchmarkAttemptArtifact,
  type MemoryBenchmarkManifestInput,
} from '../memory-benchmark-manifest.js';
import { runVerifier } from '../verifier.js';
import { sha256 } from './helpers/hash-fixture.js';

const writeOptions = { format: MEMORY_BENCHMARK_FORMAT_V1 } as const;
const fixtureRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'src', '__tests__', 'fixtures', 'memory-benchmark');
const execFileAsync = promisify(execFile);

describe('memory benchmark manifest', () => {
  test('builds and parses a deterministic v1 run identity while allowing additive fields', () => {
    const input = manifestInput();

    const manifest = buildMemoryBenchmarkManifest(input);
    const rebuilt = buildMemoryBenchmarkManifest(input);

    assert.equal(manifest.schemaVersion, 'maka.memory_benchmark.run_manifest.v1');
    assert.match(manifest.fingerprint, /^sha256:[a-f0-9]{64}$/);
    assert.equal(rebuilt.fingerprint, manifest.fingerprint);
    const { fingerprint: _fingerprint, ...body } = manifest;
    const futureBody = { ...body, futureField: { enabled: true } };
    assert.deepEqual(parseMemoryBenchmarkManifest({
      ...futureBody,
      fingerprint: buildRunManifestFingerprint(futureBody),
    }), {
      ...futureBody,
      fingerprint: buildRunManifestFingerprint(futureBody),
    });
    assert.throws(
      () => parseMemoryBenchmarkManifest({ ...manifest, schemaVersion: 'maka.memory_benchmark.run_manifest.v2' }),
      /unsupported memory benchmark manifest schemaVersion/,
    );
  });

  test('copies caller-owned identity fields before freezing the fingerprint', () => {
    const input = manifestInput();
    const manifest = buildMemoryBenchmarkManifest(input);

    input.dataset.taskIds.push('task-c');
    input.strategy.id = 'mutated-after-build';

    assert.deepEqual(manifest.dataset.taskIds, ['task-a', 'task-b']);
    assert.equal(manifest.strategy.id, 'current_maka');
    assert.deepEqual(
      parseMemoryBenchmarkManifest(manifest).fingerprint,
      buildMemoryBenchmarkManifest(manifestInput()).fingerprint,
    );
  });

  test('atomically freezes one manifest identity and rejects tampering or config reuse', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'maka-memory-benchmark-manifest-'));
    try {
      const path = join(dir, 'manifest.json');
      const baseline = buildMemoryBenchmarkManifest(manifestInput());
      const candidate = buildMemoryBenchmarkManifest({
        ...manifestInput(),
        strategy: { id: 'deterministic_curator', configHash: sha256('candidate') },
      });

      assert.deepEqual(await ensureMemoryBenchmarkManifest(path, baseline, writeOptions), baseline);
      await assert.rejects(
        ensureMemoryBenchmarkManifest(path, candidate, writeOptions),
        /does not match existing run id/,
      );

      const stored = JSON.parse(await readFile(path, 'utf8'));
      await writeFile(path, `${JSON.stringify({ ...stored, repetitions: 9 })}\n`, 'utf8');
      await assert.rejects(
        ensureMemoryBenchmarkManifest(path, baseline, writeOptions),
        /memory benchmark manifest fingerprint is invalid/,
      );

      const racePath = join(dir, 'race-manifest.json');
      const race = await Promise.allSettled([
        ensureMemoryBenchmarkManifest(racePath, baseline, writeOptions),
        ensureMemoryBenchmarkManifest(racePath, candidate, writeOptions),
      ]);
      assert.equal(race.filter((result) => result.status === 'fulfilled').length, 1);
      assert.equal(race.filter((result) => result.status === 'rejected').length, 1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('redacts credentials without erasing token metrics or model identity', () => {
    const redacted = redactMemoryBenchmarkArtifact({
      modelId: 'gpt-5.4-mini',
      inputTokens: 123,
      reasoningTokens: 45,
      providerApiKey: 'sk-provider-secret-123456',
      token: 'opaque-session-value',
      cookie: 'session=opaque-cookie',
      nested: {
        Authorization: 'Bearer cpamc-secret-token',
        githubToken: 'opaque-github-token',
        awsSecretAccessKey: 'opaque-aws-secret',
        apiSecret: 'opaque-api-secret',
        cookieHeader: 'Cookie: session=opaque-cookie-value',
        githubEnv: 'GITHUB_TOKEN=opaque-github-env-token',
        message: [
          'request failed with sk-leaked-secret-987654',
          'Authorization: Basic dXNlcjpwYXNz',
          'OPENAI_API_KEY=opaque-openai-key',
          'client_secret=opaque-client-secret',
          'refresh_token=opaque-refresh-token',
          'https://user:password@example.test/?access_token=url-secret',
        ].join(' '),
      },
    });

    assert.deepEqual(redacted, {
      modelId: 'gpt-5.4-mini',
      inputTokens: 123,
      reasoningTokens: 45,
      providerApiKey: '[REDACTED]',
      token: '[REDACTED]',
      cookie: '[REDACTED]',
      nested: {
        Authorization: '[REDACTED]',
        githubToken: '[REDACTED]',
        awsSecretAccessKey: '[REDACTED]',
        apiSecret: '[REDACTED]',
        cookieHeader: 'Cookie: [REDACTED]',
        githubEnv: 'GITHUB_TOKEN=[REDACTED]',
        message: [
          'request failed with [REDACTED]',
          'Authorization: [REDACTED]',
          'OPENAI_API_KEY=[REDACTED]',
          'client_secret=[REDACTED]',
          'refresh_token=[REDACTED]',
          'https://[REDACTED]@example.test/?access_token=[REDACTED]',
        ].join(' '),
      },
    });
    assert.throws(
      () => parseMemoryBenchmarkManifest({
        ...buildMemoryBenchmarkManifest(manifestInput()),
        apiKey: 'sk-added-secret-123456',
      }),
      /contains unredacted credentials/,
    );
  });

  test('gates v1 writes, validates frozen identities, and redacts JSON/text artifacts', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'maka-memory-benchmark-write-gate-'));
    try {
      const manifestPath = join(dir, 'manifest.json');
      const manifest = buildMemoryBenchmarkManifest(manifestInput());
      await assert.rejects(
        ensureMemoryBenchmarkManifest(manifestPath, manifest, { format: 'disabled' } as never),
        /writing requires format=/,
      );
      await assert.rejects(
        ensureMemoryBenchmarkManifest(manifestPath, {
          ...manifest,
          schemaVersion: 'wrong',
          apiKey: 'sk-unvalidated-secret-123456',
        } as never, writeOptions),
        /unsupported memory benchmark manifest schemaVersion/,
      );
      await assert.rejects(readFile(manifestPath, 'utf8'), { code: 'ENOENT' });

      const jsonPath = join(dir, 'trace.json');
      const textPath = join(dir, 'error.txt');
      await writeRedactedMemoryBenchmarkJson(jsonPath, {
        inputTokens: 12,
        sessionToken: 'opaque-session-secret',
      }, writeOptions);
      await writeRedactedMemoryBenchmarkText(
        textPath,
        'provider failed: Bearer opaque-provider-secret',
        writeOptions,
      );
      assert.deepEqual(JSON.parse(await readFile(jsonPath, 'utf8')), {
        inputTokens: 12,
        sessionToken: '[REDACTED]',
      });
      assert.equal(await readFile(textPath, 'utf8'), 'provider failed: [REDACTED]');
      await assert.rejects(
        writeRedactedMemoryBenchmarkText(textPath, 'different content', writeOptions),
        /already exists with different content/,
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('rejects invalid commit and config/dataset hashes', () => {
    assert.throws(
      () => buildMemoryBenchmarkManifest({ ...manifestInput(), subject: { commit: 'x', dirty: false } }),
      /subject.commit must be a 40-64 character/,
    );
    assert.throws(
      () => buildMemoryBenchmarkManifest({
        ...manifestInput(),
        strategy: { id: 'current_maka', configHash: 'not-a-hash' },
      }),
      /strategy.configHash must be a sha256 fingerprint/,
    );
    assert.throws(
      () => buildMemoryBenchmarkManifest({
        ...manifestInput(),
        dataset: { ...manifestInput().dataset, hash: 'not-a-hash' },
      }),
      /dataset.hash must be a sha256 fingerprint/,
    );
  });

  test('persists completed attempts append-only and resumes after a torn final line', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'maka-memory-benchmark-resume-'));
    try {
      const manifest = buildMemoryBenchmarkManifest(manifestInput());
      const attemptsPath = join(dir, 'attempts.jsonl');
      const initial = planMemoryBenchmarkResume(manifest, []);
      const completed = attemptArtifact(manifest, initial.pendingAttempts[0]!);

      await appendMemoryBenchmarkAttempt(dir, manifest, completed, writeOptions);
      await appendFile(attemptsPath, '{"schemaVersion":', 'utf8');
      assert.deepEqual(await readMemoryBenchmarkAttempts(dir, manifest), [completed]);
      await appendMemoryBenchmarkAttempt(dir, manifest, completed, writeOptions);

      const stored = await readMemoryBenchmarkAttempts(dir, manifest);
      const resumed = planMemoryBenchmarkResume(manifest, stored);
      assert.equal(initial.pendingAttempts.length, 6);
      assert.equal(resumed.pendingAttempts.length, 5);
      assert.deepEqual(resumed.completedAttemptIds, [completed.attemptId]);
      await assert.rejects(
        appendMemoryBenchmarkAttempt(dir, manifest, {
          ...completed,
          artifacts: { ...completed.artifacts, transcript: 'transcripts/different.jsonl' },
        }, writeOptions),
        /already completed with different evidence/,
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('preserves a complete final WAL record that has no trailing newline', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'maka-memory-benchmark-valid-tail-'));
    try {
      const manifest = buildMemoryBenchmarkManifest(manifestInput());
      const planned = planMemoryBenchmarkResume(manifest, []).pendingAttempts;
      const first = attemptArtifact(manifest, planned[0]!);
      const second = attemptArtifact(manifest, planned[1]!);
      const walPath = join(dir, 'attempts.jsonl');
      await writeFile(walPath, JSON.stringify(first), 'utf8');

      await appendMemoryBenchmarkAttempt(dir, manifest, second, writeOptions);

      assert.deepEqual(await readMemoryBenchmarkAttempts(dir, manifest), [first, second]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('continues a queued append after an earlier append fails', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'maka-memory-benchmark-queue-recovery-'));
    try {
      const manifest = buildMemoryBenchmarkManifest(manifestInput());
      const planned = planMemoryBenchmarkResume(manifest, []).pendingAttempts;
      const first = attemptArtifact(manifest, planned[0]!);
      const second = attemptArtifact(manifest, planned[1]!);
      const walPath = join(dir, 'attempts.jsonl');
      await appendMemoryBenchmarkAttempt(dir, manifest, first, writeOptions);

      const conflicting = appendMemoryBenchmarkAttempt(dir, manifest, {
        ...first,
        artifacts: { ...first.artifacts, transcript: 'transcripts/conflict.jsonl' },
      }, writeOptions);
      const queued = appendMemoryBenchmarkAttempt(dir, manifest, second, writeOptions);

      await assert.rejects(conflicting, /already completed with different evidence/);
      await queued;
      assert.deepEqual(await readMemoryBenchmarkAttempts(dir, manifest), [first, second]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('derives the WAL path from the manifest and rejects a symlinked parent', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'maka-memory-benchmark-wal-layout-'));
    const outside = await mkdtemp(join(tmpdir(), 'maka-memory-benchmark-wal-outside-'));
    try {
      const manifest = buildMemoryBenchmarkManifest({
        ...manifestInput(),
        artifactPaths: { ...manifestInput().artifactPaths, attemptsJsonl: 'ledger/attempts.jsonl' },
      });
      const attempt = attemptArtifact(manifest, planMemoryBenchmarkResume(manifest, []).pendingAttempts[0]!);
      await symlink(outside, join(dir, 'ledger'));

      await assert.rejects(
        readMemoryBenchmarkAttempts(dir, manifest),
        /only real directories/,
      );
      await assert.rejects(
        appendMemoryBenchmarkAttempt(dir, manifest, attempt, writeOptions),
        /only real directories/,
      );
      await assert.rejects(readFile(join(outside, 'attempts.jsonl'), 'utf8'), { code: 'ENOENT' });
    } finally {
      await rm(dir, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });

  test('rejects a manifest object mutated after its fingerprint was built', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'maka-memory-benchmark-mutated-manifest-'));
    try {
      const manifest = buildMemoryBenchmarkManifest(manifestInput());
      manifest.artifactPaths.attemptsJsonl = 'redirected.jsonl';

      await assert.rejects(
        readMemoryBenchmarkAttempts(dir, manifest),
        /manifest fingerprint is invalid/,
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('serializes the same completed attempt across processes', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'maka-memory-benchmark-process-lock-'));
    try {
      const manifest = buildMemoryBenchmarkManifest(manifestInput());
      const attempt = attemptArtifact(manifest, planMemoryBenchmarkResume(manifest, []).pendingAttempts[0]!);
      const attemptPath = join(dir, 'attempt.json');
      const manifestPath = join(dir, 'manifest.json');
      const walPath = join(dir, 'attempts.jsonl');
      await writeFile(attemptPath, JSON.stringify(attempt), 'utf8');
      await writeFile(manifestPath, JSON.stringify(manifest), 'utf8');
      await writeFile(`${walPath}.lock`, '', 'utf8');
      const staleTime = new Date(Date.now() - 5_000);
      await utimes(`${walPath}.lock`, staleTime, staleTime);
      const moduleUrl = new URL('../memory-benchmark-manifest.js', import.meta.url).href;
      const script = `
        import { readFile } from 'node:fs/promises';
        const api = await import(process.env.MODULE_URL);
        const attempt = JSON.parse(await readFile(process.env.ATTEMPT_PATH, 'utf8'));
        const manifest = JSON.parse(await readFile(process.env.MANIFEST_PATH, 'utf8'));
        await api.appendMemoryBenchmarkAttempt(process.env.RUN_ROOT, manifest, attempt, { format: api.MEMORY_BENCHMARK_FORMAT_V1 });
      `;
      const env = {
        ...process.env,
        MODULE_URL: moduleUrl,
        ATTEMPT_PATH: attemptPath,
        MANIFEST_PATH: manifestPath,
        RUN_ROOT: dir,
      };

      await Promise.all([
        execFileAsync(process.execPath, ['--input-type=module', '-e', script], { env }),
        execFileAsync(process.execPath, ['--input-type=module', '-e', script], { env }),
      ]);
      assert.deepEqual(await readMemoryBenchmarkAttempts(dir, manifest), [attempt]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('does not steal an old lock while its owner process is alive', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'maka-memory-benchmark-live-lock-'));
    try {
      const manifest = buildMemoryBenchmarkManifest(manifestInput());
      const attempt = attemptArtifact(manifest, planMemoryBenchmarkResume(manifest, []).pendingAttempts[0]!);
      const walPath = join(dir, 'attempts.jsonl');
      const lockPath = `${walPath}.lock`;
      await writeFile(lockPath, `${JSON.stringify({ pid: process.pid, startedAt: Date.now() - 5_000 })}\n`, 'utf8');
      const staleTime = new Date(Date.now() - 5_000);
      await utimes(lockPath, staleTime, staleTime);
      let settled = false;
      const appending = appendMemoryBenchmarkAttempt(dir, manifest, attempt, writeOptions).finally(() => {
        settled = true;
      });

      await new Promise<void>((resolveWait) => setTimeout(resolveWait, 50));
      assert.equal(settled, false);
      await unlink(lockPath);
      await appending;
      assert.deepEqual(await readMemoryBenchmarkAttempts(dir, manifest), [attempt]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('recomputes scores by loading official verifier artifacts', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'maka-memory-benchmark-score-'));
    try {
      const manifest = buildMemoryBenchmarkManifest(manifestInput());
      const planned = planMemoryBenchmarkResume(manifest, []).pendingAttempts;
      const verifierContents = planned.map((_attempt, index) => `${JSON.stringify(
        index === 5 ? {} : { verifier_result: { rewards: { reward: index < 4 ? 1 : 0 } } },
      )}\n`);
      const transcriptContent = '{"role":"user","content":"fixture"}\n';
      const attempts = planned.map((attempt, index) => attemptArtifact(manifest, attempt, {
        verifierContent: verifierContents[index]!,
        transcriptContent,
        tokenRow: `${attempt.attemptId},1,1,1,3`,
      }));
      await mkdir(join(dir, 'verifiers'), { recursive: true });
      await mkdir(join(dir, 'transcripts'), { recursive: true });
      await Promise.all(attempts.map((attempt, index) => writeFile(
        join(dir, attempt.artifacts.verifier),
        verifierContents[index]!,
        'utf8',
      )));
      await Promise.all(attempts.map((attempt) => writeFile(
        join(dir, attempt.artifacts.transcript),
        transcriptContent,
        'utf8',
      )));
      await writeFile(join(dir, 'tokens.csv'), [
        'attempt_id,input_tokens,output_tokens,reasoning_tokens,total_tokens',
        ...attempts.map((attempt) => `${attempt.attemptId},1,1,1,3`),
        '',
      ].join('\n'), 'utf8');
      const imported = [
        ...await Promise.all(planned.slice(0, 5).map((attempt, index) => importHarborMemoryBenchmarkAttempt({
          runRoot: dir,
          manifest,
          attempt,
          artifacts: attempts[index]!.artifacts,
        }))),
        attempts[5]!,
      ];

      const secretTranscript = '{"role":"tool","\\u0061piKey":"opaque-key","apiKey":"[REDACTED]"}\n';
      await writeFile(join(dir, attempts[0]!.artifacts.transcript), secretTranscript, 'utf8');
      await assert.rejects(
        importHarborMemoryBenchmarkAttempt({
          runRoot: dir,
          manifest,
          attempt: planned[0]!,
          artifacts: attempts[0]!.artifacts,
        }),
        /unredacted credentials/,
      );
      await writeFile(join(dir, attempts[0]!.artifacts.transcript), transcriptContent, 'utf8');

      assert.deepEqual(await recomputeMemoryBenchmarkScore(dir, manifest, imported), {
        expectedAttempts: 6,
        completedAttempts: 6,
        authoritativeAttempts: 5,
        passedAttempts: 4,
        coverageRate: 5 / 6,
        passRate: 4 / 5,
        invalidAttemptIds: [imported[5]!.attemptId],
        verdict: 'invalid',
      });

      await writeFile(join(dir, 'tokens.csv'), [
        'attempt_id,input_tokens,output_tokens,reasoning_tokens,total_tokens',
        `${attempts[0]!.attemptId},1,,1,2`,
        ...attempts.slice(1).map((attempt) => `${attempt.attemptId},1,1,1,3`),
        '',
      ].join('\n'), 'utf8');
      const invalidTokens = await recomputeMemoryBenchmarkScore(dir, manifest, attempts);
      assert.equal(invalidTokens.invalidAttemptIds.includes(attempts[0]!.attemptId), true);
      assert.equal(invalidTokens.verdict, 'invalid');

      const unsafeTokenRow = `${attempts[0]!.attemptId},999999999999999999999999,1,1,999999999999999999999999`;
      await writeFile(join(dir, 'tokens.csv'), [
        'attempt_id,input_tokens,output_tokens,reasoning_tokens,total_tokens',
        unsafeTokenRow,
        ...attempts.slice(1).map((attempt) => `${attempt.attemptId},1,1,1,3`),
        '',
      ].join('\n'), 'utf8');
      await assert.rejects(
        importHarborMemoryBenchmarkAttempt({
          runRoot: dir,
          manifest,
          attempt: planned[0]!,
          artifacts: attempts[0]!.artifacts,
        }),
        /safe integers/,
      );

      await writeFile(join(dir, attempts[1]!.artifacts.transcript), '{"role":"assistant","content":"tampered"}\n', 'utf8');
      const tamperedTranscript = await recomputeMemoryBenchmarkScore(dir, manifest, attempts);
      assert.equal(tamperedTranscript.invalidAttemptIds.includes(attempts[1]!.attemptId), true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('rejects evidence outside the manifest layout and bare pass flags without Harbor reward provenance', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'maka-memory-benchmark-layout-'));
    try {
      const manifest = buildMemoryBenchmarkManifest(manifestInput());
      const planned = planMemoryBenchmarkResume(manifest, []).pendingAttempts[0]!;
      const transcriptContent = '{"role":"user","content":"fixture"}\n';
      const verifierContent = '{"passed":true}\n';
      const tokenRow = `${planned.attemptId},1,1,1,3`;
      const attempt = attemptArtifact(manifest, planned, { verifierContent, transcriptContent, tokenRow });
      const outsideLayout = {
        ...attempt,
        artifacts: { ...attempt.artifacts, verifier: 'other/verifier.json' },
      };
      await mkdir(join(dir, 'other'), { recursive: true });
      await mkdir(join(dir, 'transcripts'), { recursive: true });
      await writeFile(join(dir, 'other/verifier.json'), verifierContent, 'utf8');
      await writeFile(join(dir, attempt.artifacts.transcript), transcriptContent, 'utf8');
      await writeFile(join(dir, 'tokens.csv'), `attempt_id,input_tokens,output_tokens,reasoning_tokens,total_tokens\n${tokenRow}\n`, 'utf8');

      let score = await recomputeMemoryBenchmarkScore(dir, manifest, [outsideLayout]);
      assert.deepEqual(score.invalidAttemptIds, [attempt.attemptId]);

      await mkdir(join(dir, 'verifiers'), { recursive: true });
      await writeFile(join(dir, attempt.artifacts.verifier), verifierContent, 'utf8');
      score = await recomputeMemoryBenchmarkScore(dir, manifest, [attempt]);
      assert.deepEqual(score.invalidAttemptIds, [attempt.attemptId]);

      const malformedAuthorityContent = '{"authority":"local","reward":1}\n';
      const malformedAuthority = attemptArtifact(manifest, planned, {
        verifierContent: malformedAuthorityContent,
        transcriptContent,
        tokenRow,
      });
      await writeFile(join(dir, malformedAuthority.artifacts.verifier), malformedAuthorityContent, 'utf8');
      score = await recomputeMemoryBenchmarkScore(dir, manifest, [malformedAuthority]);
      assert.deepEqual(score.invalidAttemptIds, [attempt.attemptId]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('keeps the existing local Terminal-Bench verifier non-authoritative', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'maka-memory-benchmark-local-verifier-'));
    try {
      await writeFile(join(dir, 'marker.txt'), 'ok', 'utf8');
      const localVerifier = await runVerifier({
        verifier: {
          kind: 'terminal_bench',
          adapter: 'terminal-bench',
          instanceId: 'local-memory-fixture',
          testCommand: 'test -f marker.txt',
          protectedPaths: [],
        },
        taskRunId: 'run-1',
        attemptId: 'attempt-1',
        ts: 100,
        id: 'verifier-1',
        workspaceDir: dir,
      });
      const manifest = buildMemoryBenchmarkManifest({
        ...manifestInput(),
        dataset: { ...manifestInput().dataset, taskIds: ['task-a'] },
        repetitions: 1,
      });
      const planned = planMemoryBenchmarkResume(manifest, []).pendingAttempts[0]!;
      const verifierContent = `${JSON.stringify(localVerifier)}\n`;
      const transcriptContent = '{"role":"user","content":"fixture"}\n';
      const tokenRow = `${planned.attemptId},1,1,1,3`;
      const attempt = attemptArtifact(manifest, planned, { verifierContent, transcriptContent, tokenRow });
      await mkdir(join(dir, 'verifiers'), { recursive: true });
      await mkdir(join(dir, 'transcripts'), { recursive: true });
      await writeFile(join(dir, attempt.artifacts.verifier), verifierContent, 'utf8');
      await writeFile(join(dir, attempt.artifacts.transcript), transcriptContent, 'utf8');
      await writeFile(join(dir, 'tokens.csv'), `attempt_id,input_tokens,output_tokens,reasoning_tokens,total_tokens\n${tokenRow}\n`, 'utf8');

      const score = await recomputeMemoryBenchmarkScore(dir, manifest, [attempt]);
      assert.deepEqual(score.invalidAttemptIds, [attempt.attemptId]);
      assert.equal(score.authoritativeAttempts, 0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('loads the checked-in golden run and fake-provider paired A/B fixture', async () => {
    const pair = JSON.parse(await readFile(join(fixtureRoot, 'fake-paired-ab.json'), 'utf8')) as {
      baseline: { root: string; expectedPassRate: number };
      candidate: { root: string; expectedPassRate: number };
      expected: { sameDataset: boolean; distinctManifestFingerprints: boolean; passRateDelta: number };
    };
    const loadArm = async (root: string) => {
      const armRoot = join(fixtureRoot, root);
      const manifest = parseMemoryBenchmarkManifest(JSON.parse(await readFile(join(armRoot, 'manifest-v1.json'), 'utf8')));
      const attempts = await readMemoryBenchmarkAttempts(armRoot, manifest);
      return { manifest, score: await recomputeMemoryBenchmarkScore(armRoot, manifest, attempts) };
    };
    const [baseline, candidate] = await Promise.all([loadArm(pair.baseline.root), loadArm(pair.candidate.root)]);

    assert.equal(baseline.score.verdict, 'valid');
    assert.equal(candidate.score.verdict, 'valid');
    assert.equal(baseline.score.passRate, pair.baseline.expectedPassRate);
    assert.equal(candidate.score.passRate, pair.candidate.expectedPassRate);
    assert.equal(candidate.score.passRate! - baseline.score.passRate!, pair.expected.passRateDelta);
    assert.equal(baseline.manifest.dataset.hash === candidate.manifest.dataset.hash, pair.expected.sameDataset);
    assert.equal(
      baseline.manifest.fingerprint !== candidate.manifest.fingerprint,
      pair.expected.distinctManifestFingerprints,
    );
  });

  test('matches the checked-in secret-redaction snapshot', async () => {
    const snapshot = JSON.parse(await readFile(join(fixtureRoot, 'redaction-snapshot.json'), 'utf8')) as {
      input: unknown;
      expected: unknown;
    };
    assert.deepEqual(redactMemoryBenchmarkArtifact(snapshot.input), snapshot.expected);
  });
});

function manifestInput(): MemoryBenchmarkManifestInput {
  return {
      runId: 'memory-baseline-001',
    subject: {
      commit: 'd1bd67d90b877ad9ad0835d79b9ac2948add9fd8',
      dirty: false,
    },
    environment: {
      gatewayId: 'cpamc-local',
      provider: 'codex',
      modelId: 'gpt-5.4-mini',
      reasoningEffort: 'medium',
    },
      strategy: {
        id: 'current_maka',
        configHash: sha256('strategy'),
    },
      dataset: {
        id: 'maka-context-continuity-v1',
        hash: sha256('dataset'),
      taskIds: ['task-a', 'task-b'],
    },
    repetitions: 3,
    artifactPaths: {
      attemptsJsonl: 'attempts.jsonl',
      tokenCsv: 'tokens.csv',
      verifierDirectory: 'verifiers',
      transcriptDirectory: 'transcripts',
    },
    redactionPolicyVersion: 'maka.memory-benchmark.redaction.v1',
  };
}

function attemptArtifact(
  manifest: ReturnType<typeof buildMemoryBenchmarkManifest>,
  attempt: { attemptId: string; taskId: string; rep: number },
  content: {
    verifierContent?: string;
    transcriptContent?: string;
    tokenRow?: string;
  } = {},
): MemoryBenchmarkAttemptArtifact {
  const verifierContent = content.verifierContent ?? '{"verifier_result":{"rewards":{"reward":1}}}\n';
  const transcriptContent = content.transcriptContent ?? '{"role":"user","content":"fixture"}\n';
  const tokenRow = content.tokenRow ?? `${attempt.attemptId},1,1,1,3`;
  return {
    schemaVersion: 'maka.memory_benchmark.attempt_artifact.v1',
    ...attempt,
    manifestFingerprint: manifest.fingerprint,
    status: 'completed',
    artifacts: {
      verifier: `verifiers/${attempt.attemptId}.json`,
      transcript: `transcripts/${attempt.attemptId}.jsonl`,
      tokenRecord: `tokens.csv#${attempt.attemptId}`,
    },
    artifactDigests: {
      verifier: hashMemoryBenchmarkArtifact(verifierContent),
      transcript: hashMemoryBenchmarkArtifact(transcriptContent),
      tokenRecord: hashMemoryBenchmarkArtifact(tokenRow),
    },
    verifierProvenance: {
      source: 'harbor_result_json',
      importedBy: 'harbor_post_exit',
    },
  };
}
