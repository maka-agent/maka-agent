import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import {
  auditCurrentMakaMemoryBaseline,
  buildCurrentMakaMemoryBaseline,
  buildNextCurrentMakaMemoryBaseline,
  loadCurrentMakaMemoryBaseline,
  parseCurrentMakaMemoryBaseline,
  writeCurrentMakaMemoryBaseline,
  writeCurrentMakaMemoryBaselineSnapshot,
} from '../memory-baseline.js';
import {
  MEMORY_BENCHMARK_FORMAT_V1,
  appendMemoryBenchmarkAttempt,
  buildMemoryBenchmarkManifest,
  hashMemoryBenchmarkArtifact,
  importHarborMemoryBenchmarkAttempt,
  planMemoryBenchmarkResume,
  type MemoryBenchmarkManifest,
} from '../memory-benchmark-manifest.js';
import {
  buildModelCalibrationEnvironment,
  qualifyModelCalibrationResults,
  type ModelCalibrationCaseKind,
  type ModelCalibrationCaseResult,
  type ModelCalibrationConfigReport,
} from '../model-calibration.js';

const commit = 'a'.repeat(40);
const writeOptions = { format: MEMORY_BENCHMARK_FORMAT_V1 } as const;

describe('Current Maka memory baseline', () => {
  test('freezes six probes, three formal calibrations, run identities, and known gaps', () => {
    const baseline = buildCurrentMakaMemoryBaseline(baselineInput());
    assert.equal(baseline.capabilityProbes.length, 6);
    assert.equal(baseline.calibrationReports.length, 3);
    assert.equal(baseline.calibrationDecision.status, 'QUALIFIED');
    assert.equal(baseline.runs.length, 3);
    assert.equal(baseline.knownGaps.length, 1);
    assert.match(baseline.fingerprint, /^sha256:[a-f0-9]{64}$/);
    assert.throws(() => (baseline.knownGaps as unknown[]).push({}), TypeError);
    assert.deepEqual(parseCurrentMakaMemoryBaseline(structuredClone(baseline)), baseline);

    assert.throws(
      () => buildCurrentMakaMemoryBaseline({ ...baselineInput(), capabilityProbes: baselineInput().capabilityProbes.slice(1) }),
      /exactly six capability probes/,
    );
    assert.throws(
      () => buildCurrentMakaMemoryBaseline({ ...baselineInput(), calibrationReports: baselineInput().calibrationReports.slice(1) }),
      /exactly three formal calibration reports/,
    );
    assert.throws(
      () => buildCurrentMakaMemoryBaseline({ ...baselineInput(), knownGaps: [] }),
      /explicit known-gaps record/,
    );
  });

  test('rejects mutated identity, foreign models, dirty commits, and unsafe evidence paths', () => {
    const baseline = structuredClone(buildCurrentMakaMemoryBaseline(baselineInput()));
    (baseline as unknown as { subjectCommit: string }).subjectCommit = 'b'.repeat(40);
    assert.throws(() => parseCurrentMakaMemoryBaseline(baseline), /frozen clean subject commit|fingerprint/);

    const input = baselineInput();
    const foreignRun = buildMemoryBenchmarkManifest({
      ...manifestInput('foreign', 'model-7'),
    });
    assert.throws(
      () => buildCurrentMakaMemoryBaseline({
        ...input,
        runs: [...input.runs, { runDirectory: 'runs/foreign', manifest: foreignRun, latencyArtifact: latencyArtifact(foreignRun) }],
      }),
      /outside the frozen environment/,
    );
    assert.throws(
      () => buildCurrentMakaMemoryBaseline({
        ...input,
        capabilityProbes: input.capabilityProbes.map((probe, index) => index === 0 ? { ...probe, evidencePath: '../secret' } : probe),
      }),
      /safe relative path/,
    );
  });

  test('reloads and rescans sealed artifacts offline, retaining invalid attempts for audit', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'maka-current-memory-baseline-'));
    try {
      const baseline = buildCurrentMakaMemoryBaseline(baselineInput());
      await writeBaselineEvidence(dir, baseline);
      for (const run of baseline.runs) await writePassingAttempt(dir, run.runDirectory, run.manifest);

      const baselinePath = join(dir, 'baseline.json');
      await writeCurrentMakaMemoryBaseline(baselinePath, baseline);
      const reloaded = await loadCurrentMakaMemoryBaseline(baselinePath);
      const snapshot = await auditCurrentMakaMemoryBaseline(dir, reloaded);
      assert.equal(snapshot.verdict, 'valid');
      assert.equal(snapshot.runs.length, 3);
      assert.equal(snapshot.runs.every((run) => run.score.passRate === 1), true);
      assert.equal(snapshot.runs.every((run) => run.resume.pendingAttempts.length === 0), true);

      const degradedInput = baselineInput();
      const degradedReport = structuredClone(degradedInput.calibrationReports[2]!.report);
      degradedReport.results = degradedReport.results.map((result, index) => index < 3
        ? { ...result, success: false, terminalProtocolSuccess: false }
        : result);
      degradedReport.qualification = qualifyModelCalibrationResults(degradedReport.results);
      const degradedEvidence = calibrationEvidence(degradedReport);
      degradedInput.calibrationReports[2] = {
        report: degradedReport,
        evidencePath: degradedInput.calibrationReports[2]!.evidencePath,
        evidenceDigest: hashMemoryBenchmarkArtifact(degradedEvidence),
      };
      const degradedBaseline = buildCurrentMakaMemoryBaseline(degradedInput);
      await writeFile(join(dir, degradedInput.calibrationReports[2]!.evidencePath), degradedEvidence, 'utf8');
      const degradedSnapshot = await auditCurrentMakaMemoryBaseline(dir, degradedBaseline);
      assert.equal(degradedBaseline.calibrationDecision.status, 'QUALIFIED', 'two qualified models still satisfy MC-0 calibration');
      assert.equal(degradedSnapshot.verdict, 'invalid', 'all three primary baseline configs must qualify');
      await writeFile(
        join(dir, degradedInput.calibrationReports[2]!.evidencePath),
        calibrationEvidence(baseline.calibrationReports[2]!.report),
        'utf8',
      );

      const snapshotPath = join(dir, 'snapshot.json');
      await writeCurrentMakaMemoryBaselineSnapshot(snapshotPath, snapshot);
      await assert.rejects(
        writeCurrentMakaMemoryBaselineSnapshot(snapshotPath, { ...snapshot, verdict: 'invalid' }),
        /different content/,
      );
      const reusedSecondInput = { ...baselineInput(), baselineId: 'current-maka-2026-07-12-02' };
      assert.throws(() => buildNextCurrentMakaMemoryBaseline(baseline, reusedSecondInput), /new run ids/);
      const freshSecondRuns = reusedSecondInput.runs.map((run, index) => {
        const manifest = buildMemoryBenchmarkManifest(manifestInput(
          `second-run-${index + 1}`,
          run.manifest.environment.modelId,
          reusedSecondInput.modelEnvironment.environmentId,
        ));
        return { runDirectory: `runs/second-run-${index + 1}`, manifest, latencyArtifact: latencyArtifact(manifest) };
      });
      const secondBaseline = buildNextCurrentMakaMemoryBaseline(baseline, { ...reusedSecondInput, runs: freshSecondRuns });
      assert.notEqual(secondBaseline.runs[0]!.manifest.runId, baseline.runs[0]!.manifest.runId);
      await assert.rejects(writeCurrentMakaMemoryBaseline(baselinePath, secondBaseline), /different content/);

      const firstRun = baseline.runs[0]!;
      const walPath = join(dir, firstRun.runDirectory, 'attempts.jsonl');
      const originalWal = await readFile(walPath, 'utf8');
      const foreignAttempt = JSON.parse(originalWal.trim()) as Record<string, unknown>;
      foreignAttempt.manifestFingerprint = `sha256:${'0'.repeat(64)}`;
      await writeFile(walPath, `${JSON.stringify(foreignAttempt)}\n`, 'utf8');
      const foreignWal = await auditCurrentMakaMemoryBaseline(dir, reloaded);
      assert.equal(foreignWal.verdict, 'invalid');
      assert.equal(foreignWal.evidenceInvalidRefs.includes(`${firstRun.runDirectory}/attempts.jsonl`), true);
      await writeFile(walPath, originalWal, 'utf8');

      const firstAttempt = planMemoryBenchmarkResume(firstRun.manifest, []).pendingAttempts[0]!;
      await writeFile(
        join(dir, firstRun.runDirectory, 'transcripts', `${firstAttempt.attemptId}.jsonl`),
        '{"role":"assistant","content":"tampered"}\n',
        'utf8',
      );
      const invalid = await auditCurrentMakaMemoryBaseline(dir, reloaded);
      assert.equal(invalid.verdict, 'invalid');
      assert.deepEqual(invalid.runs[0]!.score.invalidAttemptIds, [firstAttempt.attemptId]);
      assert.deepEqual(invalid.knownGaps, baseline.knownGaps);
      assert.equal(JSON.parse(await readFile(snapshotPath, 'utf8')).verdict, 'valid');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('reports pending resume work instead of treating an incomplete baseline as reusable', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'maka-current-memory-baseline-pending-'));
    try {
      const baseline = buildCurrentMakaMemoryBaseline(baselineInput());
      const snapshot = await auditCurrentMakaMemoryBaseline(dir, baseline);
      assert.equal(snapshot.verdict, 'invalid');
      assert.equal(snapshot.runs.every((run) => run.resume.pendingAttempts.length === 1), true);
      assert.equal(snapshot.runs.every((run) => run.score.completedAttempts === 0), true);

      const malformedRun = baseline.runs[0]!;
      await mkdir(join(dir, malformedRun.runDirectory), { recursive: true });
      await writeFile(join(dir, malformedRun.runDirectory, 'attempts.jsonl'), '{malformed}\n', 'utf8');
      const malformed = await auditCurrentMakaMemoryBaseline(dir, baseline);
      assert.equal(malformed.verdict, 'invalid');
      assert.equal(malformed.evidenceInvalidRefs.includes(`${malformedRun.runDirectory}/attempts.jsonl`), true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('rejects run configuration drift and does not follow a symlinked run root', async () => {
    const input = baselineInput();
    const driftedManifest = buildMemoryBenchmarkManifest({
      ...manifestInput('drifted-run', 'model-1', input.modelEnvironment.environmentId),
      environment: {
        gatewayId: input.modelEnvironment.environmentId,
        provider: 'openai-compatible',
        modelId: 'model-1',
        reasoningEffort: 'low',
      },
    });
    assert.throws(
      () => buildCurrentMakaMemoryBaseline({
        ...input,
        runs: input.runs.map((run, index) => index === 0
          ? { runDirectory: 'runs/drifted', manifest: driftedManifest, latencyArtifact: latencyArtifact(driftedManifest) }
          : run),
      }),
      /model and effort/,
    );
    const extraManifest = buildMemoryBenchmarkManifest(manifestInput(
      'uncalibrated-extra',
      'model-4',
      input.modelEnvironment.environmentId,
    ));
    assert.throws(
      () => buildCurrentMakaMemoryBaseline({
        ...input,
        runs: [...input.runs, {
          runDirectory: 'runs/uncalibrated-extra',
          manifest: extraManifest,
          latencyArtifact: latencyArtifact(extraManifest),
        }],
      }),
      /match exactly one formal calibration config/,
    );

    const root = await mkdtemp(join(tmpdir(), 'maka-current-memory-baseline-symlink-'));
    const outside = await mkdtemp(join(tmpdir(), 'maka-current-memory-baseline-outside-'));
    try {
      const baseline = buildCurrentMakaMemoryBaseline(input);
      await mkdir(join(root, 'runs'), { recursive: true });
      await symlink(outside, join(root, baseline.runs[0]!.runDirectory));
      const snapshot = await auditCurrentMakaMemoryBaseline(root, baseline);
      assert.equal(snapshot.verdict, 'invalid');
      assert.equal(snapshot.evidenceInvalidRefs.includes(`${baseline.runs[0]!.runDirectory}/attempts.jsonl`), true);
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });

  test('requires host-owned latency provenance', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'maka-current-memory-baseline-latency-'));
    try {
      const input = baselineInput();
      const first = input.runs[0]!;
      const attemptId = planMemoryBenchmarkResume(first.manifest, []).pendingAttempts[0]!.attemptId;
      const untrusted = `${JSON.stringify({
        schemaVersion: 'maka.memory_benchmark.latency.v1',
        source: 'model_reported',
        importedBy: 'agent',
        attempts: [{ attemptId, latencyMs: 0 }],
      })}\n`;
      const baseline = buildCurrentMakaMemoryBaseline({
        ...input,
        runs: input.runs.map((run, index) => index === 0
          ? { ...run, latencyArtifact: { path: 'latency.json', digest: hashMemoryBenchmarkArtifact(untrusted) } }
          : run),
      });
      await writeBaselineEvidence(dir, baseline);
      for (const run of baseline.runs) await writePassingAttempt(dir, run.runDirectory, run.manifest);
      await writeFile(join(dir, first.runDirectory, 'latency.json'), untrusted, 'utf8');
      const snapshot = await auditCurrentMakaMemoryBaseline(dir, baseline);
      assert.equal(snapshot.verdict, 'invalid');
      assert.equal(snapshot.runs[0]!.latency, null);

      const hiddenSecret = `{"apiKey":"sk-hidden","apiKey":"[REDACTED]","schemaVersion":"maka.memory_benchmark.latency.v1","source":"headless_runtime_events","importedBy":"host_post_exit","attempts":[{"attemptId":"${attemptId}","latencyMs":0}]}\n`;
      const hiddenSecretBaseline = buildCurrentMakaMemoryBaseline({
        ...input,
        runs: input.runs.map((run, index) => index === 0
          ? { ...run, latencyArtifact: { path: 'latency.json', digest: hashMemoryBenchmarkArtifact(hiddenSecret) } }
          : run),
      });
      await writeFile(join(dir, first.runDirectory, 'latency.json'), hiddenSecret, 'utf8');
      const secretSnapshot = await auditCurrentMakaMemoryBaseline(dir, hiddenSecretBaseline);
      assert.equal(secretSnapshot.verdict, 'invalid');
      assert.equal(secretSnapshot.runs[0]!.latency, null);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('marks matching-digest capability evidence invalid when it contains credentials', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'maka-current-memory-baseline-secret-'));
    try {
      const secretEvidence = '{"apiKey":"sk-live-secret"}\n';
      const input = baselineInput();
      const capabilityProbes = input.capabilityProbes.map((probe, index) => index === 0
        ? { ...probe, evidenceDigest: hashMemoryBenchmarkArtifact(secretEvidence) }
        : probe);
      const baseline = buildCurrentMakaMemoryBaseline({ ...input, capabilityProbes });
      await writeBaselineEvidence(dir, baseline);
      for (const run of baseline.runs) await writePassingAttempt(dir, run.runDirectory, run.manifest);
      await writeFile(join(dir, capabilityProbes[0]!.evidencePath), secretEvidence, 'utf8');
      const snapshot = await auditCurrentMakaMemoryBaseline(dir, baseline);
      assert.equal(snapshot.verdict, 'invalid');
      assert.deepEqual(snapshot.evidenceInvalidRefs, [capabilityProbes[0]!.evidencePath]);

      const mismatchedEvidence = capabilityEvidence(
        input.modelEnvironment.environmentId,
        capabilityProbes[0]!.modelId,
        'unsupported',
      );
      const mismatchBaseline = buildCurrentMakaMemoryBaseline({
        ...input,
        capabilityProbes: input.capabilityProbes.map((probe, index) => index === 0
          ? { ...probe, evidenceDigest: hashMemoryBenchmarkArtifact(mismatchedEvidence) }
          : probe),
      });
      await writeFile(join(dir, capabilityProbes[0]!.evidencePath), mismatchedEvidence, 'utf8');
      const mismatchSnapshot = await auditCurrentMakaMemoryBaseline(dir, mismatchBaseline);
      assert.equal(mismatchSnapshot.verdict, 'invalid');
      assert.equal(mismatchSnapshot.evidenceInvalidRefs.includes(capabilityProbes[0]!.evidencePath), true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

function baselineInput() {
  const environment = buildModelCalibrationEnvironment({
    connection: { slug: 'operator-gateway', providerType: 'openai-compatible', baseUrl: 'https://gateway.example/v1' },
    modelIds: ['model-1', 'model-2', 'model-3', 'model-4', 'model-5', 'model-6'],
  });
  const calibrationReports = ['model-1', 'model-2', 'model-3'].map((modelId) => {
    const report = calibrationReport(environment.environmentId, modelId);
    const evidence = calibrationEvidence(report);
    return {
      report,
      evidencePath: `calibration/${modelId}.json`,
      evidenceDigest: hashMemoryBenchmarkArtifact(evidence),
    };
  });
  const runs = calibrationReports.map((calibration, index) => {
    const manifest = buildMemoryBenchmarkManifest(manifestInput(
      `run-${index + 1}`,
      calibration.report.modelId,
      environment.environmentId,
    ));
    return { runDirectory: `runs/run-${index + 1}`, manifest, latencyArtifact: latencyArtifact(manifest) };
  });
  return {
    baselineId: 'current-maka-2026-07-12-01',
    subjectCommit: commit,
    modelEnvironment: environment,
    capabilityProbes: environment.modelIds.map((modelId) => ({
      environmentId: environment.environmentId,
      modelId,
      status: 'supported' as const,
      evidencePath: `capability/${modelId}.json`,
      evidenceDigest: hashMemoryBenchmarkArtifact(capabilityEvidence(environment.environmentId, modelId, 'supported')),
    })),
    calibrationReports,
    runs,
    knownGaps: [{
      id: 'current-memory-gap',
      summary: 'Current Maka has no Raven-native durable lifecycle yet.',
      evidenceRefs: [{ path: 'reports/current-gap.md', digest: hashMemoryBenchmarkArtifact('current gap evidence\n') }],
    }],
  };
}

function manifestInput(runId: string, modelId: string, gatewayId = 'foreign-environment') {
  return {
    runId,
    subject: { commit, dirty: false },
    environment: { gatewayId, provider: 'openai-compatible', modelId, reasoningEffort: 'medium' as const },
    strategy: { id: 'current-maka', configHash: `sha256:${'b'.repeat(64)}` },
    dataset: { id: 'smoke-v1', hash: `sha256:${'c'.repeat(64)}`, taskIds: ['smoke-01'] },
    repetitions: 1,
    artifactPaths: { attemptsJsonl: 'attempts.jsonl', tokenCsv: 'tokens.csv', verifierDirectory: 'verifiers', transcriptDirectory: 'transcripts' },
    redactionPolicyVersion: 'v1',
  };
}

async function writePassingAttempt(root: string, runDirectory: string, manifest: MemoryBenchmarkManifest): Promise<void> {
  const runRoot = join(root, runDirectory);
  const planned = planMemoryBenchmarkResume(manifest, []).pendingAttempts[0]!;
  const verifier = `${JSON.stringify({ verifier_result: { rewards: { reward: 1 } } })}\n`;
  const transcript = '{"role":"assistant","content":"fixture"}\n';
  const tokenRow = `${planned.attemptId},2,1,0,3`;
  await mkdir(join(runRoot, 'verifiers'), { recursive: true });
  await mkdir(join(runRoot, 'transcripts'), { recursive: true });
  await writeFile(join(runRoot, 'verifiers', `${planned.attemptId}.json`), verifier, 'utf8');
  await writeFile(join(runRoot, 'transcripts', `${planned.attemptId}.jsonl`), transcript, 'utf8');
  await writeFile(join(runRoot, 'tokens.csv'), `attempt_id,input_tokens,output_tokens,reasoning_tokens,total_tokens\n${tokenRow}\n`, 'utf8');
  await writeFile(join(runRoot, 'latency.json'), latencyContent(planned.attemptId), 'utf8');
  const imported = await importHarborMemoryBenchmarkAttempt({
    runRoot,
    manifest,
    attempt: planned,
    artifacts: {
      verifier: `verifiers/${planned.attemptId}.json`,
      transcript: `transcripts/${planned.attemptId}.jsonl`,
      tokenRecord: `tokens.csv#${planned.attemptId}`,
    },
  });
  await appendMemoryBenchmarkAttempt(runRoot, manifest, imported, writeOptions);
}

async function writeBaselineEvidence(root: string, baseline: ReturnType<typeof buildCurrentMakaMemoryBaseline>): Promise<void> {
  await mkdir(join(root, 'capability'), { recursive: true });
  await mkdir(join(root, 'calibration'), { recursive: true });
  await mkdir(join(root, 'reports'), { recursive: true });
  await Promise.all(baseline.capabilityProbes.map((probe) => writeFile(
    join(root, probe.evidencePath),
    capabilityEvidence(probe.environmentId, probe.modelId, probe.status),
    'utf8',
  )));
  await Promise.all(baseline.calibrationReports.map((calibration) => writeFile(
    join(root, calibration.evidencePath),
    calibrationEvidence(calibration.report),
    'utf8',
  )));
  await writeFile(join(root, 'reports/current-gap.md'), 'current gap evidence\n', 'utf8');
}

function calibrationEvidence(report: ModelCalibrationConfigReport): string {
  return `${JSON.stringify({
    schemaVersion: 'maka.model_calibration.evidence.v1',
    source: 'headless_calibration_run',
    importedBy: 'host_post_exit',
    report,
  })}\n`;
}

function capabilityEvidence(environmentId: string, modelId: string, status: 'supported' | 'unsupported' | 'failed'): string {
  return `${JSON.stringify({
    schemaVersion: 'maka.model_capability_probe.evidence.v1',
    source: 'runtime_capability_probe',
    importedBy: 'host_post_exit',
    environmentId,
    modelId,
    status,
  })}\n`;
}

function latencyArtifact(manifest: MemoryBenchmarkManifest) {
  const attemptId = planMemoryBenchmarkResume(manifest, []).pendingAttempts[0]!.attemptId;
  return { path: 'latency.json', digest: hashMemoryBenchmarkArtifact(latencyContent(attemptId)) };
}

function latencyContent(attemptId: string): string {
  return `${JSON.stringify({
    schemaVersion: 'maka.memory_benchmark.latency.v1',
    source: 'headless_runtime_events',
    importedBy: 'host_post_exit',
    attempts: [{ attemptId, latencyMs: 25 }],
  }, null, 2)}\n`;
}

function calibrationReport(environmentId: string, modelId: string): ModelCalibrationConfigReport {
  const results = calibrationResults();
  return {
    environmentId,
    connectionSlug: 'operator-gateway',
    modelId,
    thinkingLevel: 'medium',
    results,
    qualification: qualifyModelCalibrationResults(results),
  };
}

function calibrationResults(): ModelCalibrationCaseResult[] {
  const counts: Record<ModelCalibrationCaseKind, number> = {
    structured_json: 5,
    single_tool: 5,
    two_step_tool: 5,
    malformed_tool_recovery: 3,
    long_input_bounded_output: 2,
  };
  let index = 0;
  return Object.entries(counts).flatMap(([kind, count]) => Array.from({ length: count }, () => ({
    caseId: `case-${++index}`,
    kind: kind as ModelCalibrationCaseKind,
    success: true,
    terminalProtocolSuccess: true,
    timeout: false,
    toolAdjacencyError: false,
    forbiddenToolCalls: 0,
    latencyMs: 10,
    usage: { inputTokens: 2, outputTokens: 1, reasoningTokens: 0, totalTokens: 3 },
  })));
}
