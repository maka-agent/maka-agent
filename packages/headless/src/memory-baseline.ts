import { lstat, readFile, realpath } from 'node:fs/promises';
import { relative, resolve } from 'node:path';
import { buildRunManifestFingerprint } from './ab-manifest.js';
import {
  MEMORY_BENCHMARK_FORMAT_V1,
  assertMemoryBenchmarkArtifactRedacted,
  parseMemoryBenchmarkManifest,
  planMemoryBenchmarkResume,
  readMemoryBenchmarkAttempts,
  readVerifiedMemoryBenchmarkArtifact,
  recomputeMemoryBenchmarkScore,
  writeRedactedMemoryBenchmarkJson,
  type MemoryBenchmarkManifest,
  type MemoryBenchmarkAttemptArtifact,
  type MemoryBenchmarkResumePlan,
  type MemoryBenchmarkScore,
} from './memory-benchmark-manifest.js';
import {
  buildModelCalibrationConfigId,
  buildModelCalibrationDecision,
  type ModelCalibrationConfigReport,
  type ModelCalibrationDecision,
  type ModelCalibrationEnvironment,
  type ModelCalibrationTokenUsage,
} from './model-calibration.js';

export const MEMORY_BASELINE_SCHEMA_VERSION = 'maka.memory_benchmark.current_baseline.v2' as const;
const CURRENT_MAKA_TOKEN_SANITY_DATASET = 'terminal-bench-sample@2.0/log-summary-date-ranges';
const CURRENT_MAKA_TOKEN_SANITY_TASK = 'log-summary-date-ranges';
const CURRENT_MAKA_TOKEN_SANITY_HASH = 'sha256:bc214b360dec9e692f03f6a63599d880a7619569a00293f4c1a68c248767476e';

export interface MemoryBaselineCapabilityProbe {
  readonly environmentId: string;
  readonly modelId: string;
  readonly thinkingLevel: ModelCalibrationConfigReport['thinkingLevel'];
  readonly status: 'supported' | 'unsupported' | 'failed';
  readonly requestAccepted: boolean;
  readonly runtimeStatus: 'completed' | 'rejected' | 'failed';
  readonly errorClass?: string;
  readonly usageParsed: boolean;
  readonly usage: ModelCalibrationTokenUsage;
  readonly fallbackDetected: boolean;
  readonly latencyMs: number;
  readonly reasoningTokens: number;
  readonly providerHttpStatus?: number;
  readonly evidencePath: string;
  readonly evidenceDigest: string;
}

export interface MemoryBaselineKnownGap {
  readonly id: string;
  readonly summary: string;
  readonly evidenceRefs: readonly {
    readonly path: string;
    readonly digest: string;
  }[];
}

export interface MemoryBaselineRunReference {
  readonly runDirectory: string;
  readonly manifest: MemoryBenchmarkManifest;
  readonly latencyArtifact: {
    readonly path: string;
    readonly digest: string;
  };
}

export interface MemoryBaselineCalibrationEvidence {
  readonly report: ModelCalibrationConfigReport;
  readonly evidencePath: string;
  readonly evidenceDigest: string;
}

export interface CurrentMakaMemoryBaselineInput {
  readonly baselineId: string;
  readonly subjectCommit: string;
  readonly modelEnvironment: ModelCalibrationEnvironment;
  readonly capabilityProbes: readonly MemoryBaselineCapabilityProbe[];
  readonly calibrationReports: readonly MemoryBaselineCalibrationEvidence[];
  readonly runs: readonly MemoryBaselineRunReference[];
  readonly knownGaps: readonly MemoryBaselineKnownGap[];
}

export interface CurrentMakaMemoryBaseline extends CurrentMakaMemoryBaselineInput {
  readonly schemaVersion: typeof MEMORY_BASELINE_SCHEMA_VERSION;
  readonly calibrationDecision: ModelCalibrationDecision;
  readonly fingerprint: string;
}

export interface MemoryBaselineRunAudit {
  readonly runDirectory: string;
  readonly manifestFingerprint: string;
  readonly resume: MemoryBenchmarkResumePlan;
  readonly score: MemoryBenchmarkScore;
  readonly latency: {
    readonly attempts: number;
    readonly totalMs: number;
    readonly meanMs: number;
  } | null;
}

export interface CurrentMakaMemoryBaselineSnapshot {
  readonly schemaVersion: 'maka.memory_benchmark.current_baseline_snapshot.v2';
  readonly baselineFingerprint: string;
  readonly verdict: 'valid' | 'invalid';
  readonly calibrationDecision: ModelCalibrationDecision;
  readonly runs: readonly MemoryBaselineRunAudit[];
  readonly knownGaps: readonly MemoryBaselineKnownGap[];
  readonly evidenceInvalidRefs: readonly string[];
}

export function buildCurrentMakaMemoryBaseline(input: CurrentMakaMemoryBaselineInput): CurrentMakaMemoryBaseline {
  validateBaselineInput(input);
  const modelDecision = buildModelCalibrationDecision(input.modelEnvironment, input.calibrationReports.map((entry) => entry.report));
  const calibrationDecision: ModelCalibrationDecision = input.capabilityProbes.every((probe) => probe.status === 'supported')
    ? modelDecision
    : { ...modelDecision, status: 'BLOCKED' };
  const body = {
    schemaVersion: MEMORY_BASELINE_SCHEMA_VERSION,
    baselineId: input.baselineId,
    subjectCommit: input.subjectCommit,
    modelEnvironment: structuredClone(input.modelEnvironment),
    capabilityProbes: structuredClone(input.capabilityProbes),
    calibrationReports: structuredClone(input.calibrationReports),
    runs: input.runs.map((run) => ({
      runDirectory: run.runDirectory,
      manifest: parseMemoryBenchmarkManifest(structuredClone(run.manifest)),
      latencyArtifact: { ...run.latencyArtifact },
    })),
    knownGaps: structuredClone(input.knownGaps),
    calibrationDecision,
  };
  return deepFreeze({ ...body, fingerprint: buildRunManifestFingerprint(body) });
}

export function buildNextCurrentMakaMemoryBaseline(
  previousValue: CurrentMakaMemoryBaseline,
  input: CurrentMakaMemoryBaselineInput,
): CurrentMakaMemoryBaseline {
  const previous = parseCurrentMakaMemoryBaseline(previousValue);
  const next = buildCurrentMakaMemoryBaseline(input);
  if (next.baselineId === previous.baselineId) throw new Error('next current Maka baseline requires a new baselineId');
  const previousRunIds = new Set(previous.runs.map((run) => run.manifest.runId));
  const previousDirectories = new Set(previous.runs.map((run) => run.runDirectory));
  if (next.runs.some((run) => previousRunIds.has(run.manifest.runId))) throw new Error('next current Maka baseline requires new run ids');
  if (next.runs.some((run) => previousDirectories.has(run.runDirectory))) throw new Error('next current Maka baseline requires new run directories');
  return next;
}

export function parseCurrentMakaMemoryBaseline(value: unknown): CurrentMakaMemoryBaseline {
  if (!isRecord(value) || value.schemaVersion !== MEMORY_BASELINE_SCHEMA_VERSION) {
    throw new Error(`unsupported current Maka memory baseline schemaVersion: ${String(isRecord(value) ? value.schemaVersion ?? 'missing' : 'missing')}`);
  }
  const fingerprint = sha256(value.fingerprint, 'current Maka memory baseline fingerprint');
  const { fingerprint: _fingerprint, calibrationDecision: _decision, schemaVersion: _schemaVersion, ...input } = value;
  const rebuilt = buildCurrentMakaMemoryBaseline(input as unknown as CurrentMakaMemoryBaselineInput);
  if (rebuilt.fingerprint !== fingerprint) throw new Error('current Maka memory baseline fingerprint does not match its contents');
  if (JSON.stringify(rebuilt.calibrationDecision) !== JSON.stringify(value.calibrationDecision)) {
    throw new Error('current Maka memory baseline calibration decision does not match its evidence');
  }
  return rebuilt;
}

export async function loadCurrentMakaMemoryBaseline(path: string): Promise<CurrentMakaMemoryBaseline> {
  return parseCurrentMakaMemoryBaseline(JSON.parse(await readFile(path, 'utf8')) as unknown);
}

export async function auditCurrentMakaMemoryBaseline(
  baselineRoot: string,
  baselineValue: CurrentMakaMemoryBaseline,
): Promise<CurrentMakaMemoryBaselineSnapshot> {
  const baseline = parseCurrentMakaMemoryBaseline(baselineValue);
  const runs: MemoryBaselineRunAudit[] = [];
  const evidenceInvalidRefs: string[] = [];
  for (const probe of baseline.capabilityProbes) {
    try {
      const content = await readVerifiedMemoryBenchmarkArtifact(baselineRoot, probe.evidencePath, probe.evidenceDigest);
      const raw = content.toString('utf8');
      assertMemoryBenchmarkArtifactRedacted(raw);
      const evidence = JSON.parse(raw) as unknown;
      if (!isRecord(evidence)
        || evidence.schemaVersion !== 'maka.model_capability_probe.evidence.v2'
        || evidence.source !== 'runtime_capability_probe'
        || evidence.importedBy !== 'host_post_exit'
        || evidence.environmentId !== probe.environmentId
        || evidence.modelId !== probe.modelId
        || evidence.thinkingLevel !== probe.thinkingLevel
        || evidence.status !== probe.status
        || evidence.requestAccepted !== probe.requestAccepted
        || evidence.runtimeStatus !== probe.runtimeStatus
        || evidence.errorClass !== probe.errorClass
        || evidence.usageParsed !== probe.usageParsed
        || JSON.stringify(evidence.usage) !== JSON.stringify(probe.usage)
        || evidence.fallbackDetected !== probe.fallbackDetected
        || evidence.latencyMs !== probe.latencyMs
        || evidence.reasoningTokens !== probe.reasoningTokens
        || evidence.providerHttpStatus !== probe.providerHttpStatus) {
        throw new Error('capability probe evidence does not match its recorded result');
      }
    } catch {
      evidenceInvalidRefs.push(probe.evidencePath);
    }
  }
  for (const calibration of baseline.calibrationReports) {
    try {
      const content = await readVerifiedMemoryBenchmarkArtifact(
        baselineRoot,
        calibration.evidencePath,
        calibration.evidenceDigest,
      );
      assertMemoryBenchmarkArtifactRedacted(content.toString('utf8'));
      const evidence = JSON.parse(content.toString('utf8')) as unknown;
      if (!isRecord(evidence)
        || evidence.schemaVersion !== 'maka.model_calibration.evidence.v2'
        || evidence.source !== 'headless_calibration_run'
        || evidence.importedBy !== 'host_post_exit'
        || JSON.stringify(evidence.report) !== JSON.stringify(calibration.report)) {
        throw new Error('formal calibration evidence does not match its report');
      }
    } catch {
      evidenceInvalidRefs.push(calibration.evidencePath);
    }
  }
  for (const gap of baseline.knownGaps) {
    for (const ref of gap.evidenceRefs) {
      await verifyEvidence(baselineRoot, ref.path, ref.digest).catch(() => evidenceInvalidRefs.push(ref.path));
    }
  }
  for (const run of baseline.runs) {
    const runRoot = resolve(baselineRoot, run.runDirectory);
    let attempts: MemoryBenchmarkAttemptArtifact[] = [];
    let runRootValid = true;
    let resume = planMemoryBenchmarkResume(run.manifest, []);
    let score = invalidScore(run.manifest);
    try {
      await assertContainedRunRoot(baselineRoot, runRoot);
      attempts = await readMemoryBenchmarkAttempts(runRoot, run.manifest, baselineRoot);
      await verifyHarborTaskChecksums(runRoot, run.manifest, attempts, baselineRoot);
      resume = planMemoryBenchmarkResume(run.manifest, attempts);
      score = await recomputeMemoryBenchmarkScore(runRoot, run.manifest, attempts, baselineRoot);
    } catch {
      runRootValid = false;
      attempts = [];
      evidenceInvalidRefs.push(`${run.runDirectory}/${run.manifest.artifactPaths.attemptsJsonl}`);
    }
    let latency: MemoryBaselineRunAudit['latency'] = null;
    try {
      if (!runRootValid) throw new Error('baseline run root is invalid');
      latency = parseLatencyArtifact(
        await readVerifiedMemoryBenchmarkArtifact(runRoot, run.latencyArtifact.path, run.latencyArtifact.digest, baselineRoot),
        attempts.map((attempt) => attempt.attemptId),
      );
    } catch {
      evidenceInvalidRefs.push(`${run.runDirectory}/${run.latencyArtifact.path}`);
    }
    runs.push({
      runDirectory: run.runDirectory,
      manifestFingerprint: run.manifest.fingerprint,
      resume,
      score,
      latency,
    });
  }
  return deepFreeze({
    schemaVersion: 'maka.memory_benchmark.current_baseline_snapshot.v2',
    baselineFingerprint: baseline.fingerprint,
    verdict: baseline.calibrationDecision.status === 'QUALIFIED'
      && baseline.capabilityProbes.every((probe) => probe.status === 'supported')
      && baseline.calibrationReports.every((calibration) => calibration.report.qualification.main.qualified)
      && evidenceInvalidRefs.length === 0
      && runs.every((run) => run.resume.pendingAttempts.length === 0 && run.score.verdict === 'valid' && run.latency !== null)
      ? 'valid'
      : 'invalid',
    calibrationDecision: structuredClone(baseline.calibrationDecision),
    runs,
    knownGaps: structuredClone(baseline.knownGaps),
    evidenceInvalidRefs: evidenceInvalidRefs.sort(),
  });
}

async function verifyHarborTaskChecksums(
  runRoot: string,
  manifest: MemoryBenchmarkManifest,
  attempts: readonly MemoryBenchmarkAttemptArtifact[],
  containmentRoot: string,
): Promise<void> {
  for (const attempt of attempts) {
    const content = await readVerifiedMemoryBenchmarkArtifact(
      runRoot,
      attempt.artifacts.verifier,
      attempt.artifactDigests.verifier,
      containmentRoot,
    );
    const verifier = JSON.parse(content.toString('utf8')) as unknown;
    if (!isRecord(verifier)
      || typeof verifier.task_checksum !== 'string'
      || !/^[a-f0-9]{64}$/.test(verifier.task_checksum)
      || `sha256:${verifier.task_checksum}` !== manifest.dataset.hash) {
      throw new Error(`baseline Harbor task checksum does not match manifest for ${attempt.attemptId}`);
    }
  }
}

export async function writeCurrentMakaMemoryBaseline(
  path: string,
  baseline: CurrentMakaMemoryBaseline,
): Promise<void> {
  await writeRedactedMemoryBenchmarkJson(path, parseCurrentMakaMemoryBaseline(baseline), {
    format: MEMORY_BENCHMARK_FORMAT_V1,
  });
}

export async function writeCurrentMakaMemoryBaselineSnapshot(
  path: string,
  snapshot: CurrentMakaMemoryBaselineSnapshot,
): Promise<void> {
  await writeRedactedMemoryBenchmarkJson(path, snapshot, { format: MEMORY_BENCHMARK_FORMAT_V1 });
}

function validateBaselineInput(input: CurrentMakaMemoryBaselineInput): void {
  nonEmpty(input.baselineId, 'baselineId');
  if (!/^[a-f0-9]{40,64}$/.test(input.subjectCommit)) throw new Error('subjectCommit must be a lowercase git commit id');
  if (input.capabilityProbes.length !== 3) throw new Error('current Maka baseline requires exactly three capability probes');
  if (input.modelEnvironment.modelIds.length !== 1) throw new Error('current Maka baseline environment must contain exactly one model');
  if (input.calibrationReports.length !== 3) throw new Error('current Maka baseline requires exactly three formal calibration reports');
  if (input.runs.length === 0) throw new Error('current Maka baseline requires at least one benchmark run');
  if (input.knownGaps.length === 0) throw new Error('current Maka baseline requires an explicit known-gaps record');

  unique(input.capabilityProbes.map((probe) => buildModelCalibrationConfigId({
    environmentId: probe.environmentId,
    connectionSlug: input.modelEnvironment.connectionSlug,
    modelId: probe.modelId,
    thinkingLevel: probe.thinkingLevel,
  })), 'duplicate capability probe config');
  unique(input.calibrationReports.map((entry) => buildModelCalibrationConfigId(entry.report)), 'duplicate formal calibration config');
  unique(input.runs.map((run) => run.manifest.fingerprint), 'duplicate baseline run manifest');
  unique(input.knownGaps.map((gap) => gap.id), 'duplicate known gap id');
  const baselineModelId = input.modelEnvironment.modelIds[0]!;
  const requiredThinkingLevels = ['low', 'medium', 'high'];
  if (input.capabilityProbes.some((probe) => probe.modelId !== baselineModelId)) {
    throw new Error('capability probes must use the single model in the frozen environment');
  }
  if (input.calibrationReports.some((entry) => entry.report.modelId !== baselineModelId)) {
    throw new Error('formal calibration reports must use the single model in the frozen environment');
  }
  if (!sameStringSet(input.capabilityProbes.map((probe) => probe.thinkingLevel), requiredThinkingLevels)) {
    throw new Error('capability probes must cover low, medium, and high thinking levels');
  }
  if (!sameStringSet(input.calibrationReports.map((entry) => entry.report.thinkingLevel), requiredThinkingLevels)) {
    throw new Error('formal calibration reports must cover low, medium, and high thinking levels');
  }
  const probeConfigIds = input.capabilityProbes.map((probe) => buildModelCalibrationConfigId({
    environmentId: probe.environmentId,
    connectionSlug: input.modelEnvironment.connectionSlug,
    modelId: probe.modelId,
    thinkingLevel: probe.thinkingLevel,
  }));
  const reportConfigIds = input.calibrationReports.map((entry) => buildModelCalibrationConfigId(entry.report));
  if (!sameStringSet(probeConfigIds, reportConfigIds)) {
    throw new Error('capability probes and formal calibration reports must cover the same configs');
  }
  for (const calibration of input.calibrationReports) {
    relativePath(calibration.evidencePath, 'formal calibration evidencePath');
    sha256(calibration.evidenceDigest, 'formal calibration evidenceDigest');
    const report = calibration.report;
    if (!['low', 'medium', 'high'].includes(report.thinkingLevel)) {
      throw new Error(`formal calibration thinking level is not benchmark-compatible: ${report.modelId}`);
    }
    if (!input.runs.some((run) => run.manifest.environment.modelId === report.modelId
      && run.manifest.environment.reasoningEffort === report.thinkingLevel)) {
      throw new Error('baseline runs must cover every formally calibrated model and effort');
    }
    if (!input.runs.some((run) => run.manifest.environment.modelId === report.modelId
      && run.manifest.environment.reasoningEffort === report.thinkingLevel
      && run.manifest.dataset.id === CURRENT_MAKA_TOKEN_SANITY_DATASET
      && run.manifest.dataset.hash === CURRENT_MAKA_TOKEN_SANITY_HASH
      && sameStringSet(run.manifest.dataset.taskIds, [CURRENT_MAKA_TOKEN_SANITY_TASK]))) {
      throw new Error('baseline token sanity runs must cover low, medium, and high with the official log-summary-date-ranges task');
    }
  }

  for (const probe of input.capabilityProbes) {
    if (!['supported', 'unsupported', 'failed'].includes(probe.status)) throw new Error(`invalid capability probe status: ${probe.modelId}`);
    if (probe.environmentId !== input.modelEnvironment.environmentId) throw new Error(`capability probe belongs to another environment: ${probe.modelId}`);
    if (!input.modelEnvironment.modelIds.includes(probe.modelId)) throw new Error(`capability probe model is outside the frozen environment: ${probe.modelId}`);
    if (!['low', 'medium', 'high'].includes(probe.thinkingLevel)) {
      throw new Error(`capability probe thinking level is not benchmark-compatible: ${probe.modelId}`);
    }
    if (typeof probe.requestAccepted !== 'boolean'
      || typeof probe.usageParsed !== 'boolean'
      || typeof probe.fallbackDetected !== 'boolean') {
      throw new Error(`capability probe protocol flags are invalid: ${probe.modelId}:${probe.thinkingLevel}`);
    }
    if (!Number.isFinite(probe.latencyMs) || probe.latencyMs < 0) {
      throw new Error(`capability probe latency is invalid: ${probe.modelId}:${probe.thinkingLevel}`);
    }
    if (!Number.isSafeInteger(probe.reasoningTokens) || probe.reasoningTokens < 0) {
      throw new Error(`capability probe reasoning tokens are invalid: ${probe.modelId}:${probe.thinkingLevel}`);
    }
    if (!['completed', 'rejected', 'failed'].includes(probe.runtimeStatus)) {
      throw new Error(`capability probe runtime status is invalid: ${probe.modelId}:${probe.thinkingLevel}`);
    }
    if (probe.errorClass !== undefined && probe.errorClass.trim().length === 0) {
      throw new Error(`capability probe error class is invalid: ${probe.modelId}:${probe.thinkingLevel}`);
    }
    const usageValues = [
      probe.usage?.inputTokens,
      probe.usage?.outputTokens,
      probe.usage?.reasoningTokens,
      probe.usage?.totalTokens,
    ];
    if (!usageValues.every((value) => Number.isSafeInteger(value) && Number(value) >= 0)
      || probe.usage.totalTokens < probe.usage.inputTokens + probe.usage.outputTokens
      || probe.usage.reasoningTokens !== probe.reasoningTokens) {
      throw new Error(`capability probe usage is invalid: ${probe.modelId}:${probe.thinkingLevel}`);
    }
    if (probe.providerHttpStatus !== undefined
      && (!Number.isSafeInteger(probe.providerHttpStatus) || probe.providerHttpStatus < 100 || probe.providerHttpStatus > 599)) {
      throw new Error(`capability probe provider HTTP status is invalid: ${probe.modelId}:${probe.thinkingLevel}`);
    }
    if (probe.status === 'supported'
      && (!probe.requestAccepted
        || probe.runtimeStatus !== 'completed'
        || probe.errorClass !== undefined
        || !probe.usageParsed
        || probe.fallbackDetected
        || (probe.providerHttpStatus !== undefined
          && (probe.providerHttpStatus < 200 || probe.providerHttpStatus > 299)))) {
      throw new Error(`supported capability probe lacks accepted usage evidence or detected a fallback: ${probe.modelId}:${probe.thinkingLevel}`);
    }
    relativePath(probe.evidencePath, 'capability probe evidencePath');
    sha256(probe.evidenceDigest, 'capability probe evidenceDigest');
  }
  for (const run of input.runs) {
    relativePath(run.runDirectory, 'baseline runDirectory');
    relativePath(run.latencyArtifact.path, 'baseline latency artifact path');
    sha256(run.latencyArtifact.digest, 'baseline latency artifact digest');
    const manifest = parseMemoryBenchmarkManifest(run.manifest);
    if (manifest.subject.commit !== input.subjectCommit || manifest.subject.dirty) {
      throw new Error(`baseline run ${manifest.runId} does not use the frozen clean subject commit`);
    }
    if (!input.modelEnvironment.modelIds.includes(manifest.environment.modelId)) {
      throw new Error(`baseline run model is outside the frozen environment: ${manifest.environment.modelId}`);
    }
    if (manifest.environment.gatewayId !== input.modelEnvironment.environmentId
      || manifest.environment.provider !== input.modelEnvironment.providerType) {
      throw new Error(`baseline run ${manifest.runId} does not use the frozen model environment`);
    }
    const matchingCalibrations = input.calibrationReports.filter((calibration) => (
      calibration.report.modelId === manifest.environment.modelId
      && calibration.report.thinkingLevel === manifest.environment.reasoningEffort
    ));
    if (matchingCalibrations.length !== 1) {
      throw new Error(`baseline run ${manifest.runId} must match exactly one formal calibration config`);
    }
  }
  for (const gap of input.knownGaps) {
    nonEmpty(gap.id, 'known gap id');
    nonEmpty(gap.summary, 'known gap summary');
    if (gap.evidenceRefs.length === 0) throw new Error(`known gap ${gap.id} requires evidence refs`);
    gap.evidenceRefs.forEach((ref) => {
      relativePath(ref.path, `known gap ${gap.id} evidence ref`);
      sha256(ref.digest, `known gap ${gap.id} evidence digest`);
    });
  }
}

async function verifyEvidence(root: string, path: string, digest: string): Promise<void> {
  const content = await readVerifiedMemoryBenchmarkArtifact(root, path, digest);
  assertMemoryBenchmarkArtifactRedacted(content.toString('utf8'));
}

function parseLatencyArtifact(content: Buffer, expectedAttemptIds: readonly string[]): NonNullable<MemoryBaselineRunAudit['latency']> {
  const raw = content.toString('utf8');
  assertMemoryBenchmarkArtifactRedacted(raw);
  const value = JSON.parse(raw) as unknown;
  assertMemoryBenchmarkArtifactRedacted(value);
  if (!isRecord(value)
    || value.schemaVersion !== 'maka.memory_benchmark.latency.v1'
    || value.source !== 'headless_runtime_events'
    || value.importedBy !== 'host_post_exit'
    || !Array.isArray(value.attempts)) {
    throw new Error('memory benchmark latency artifact is invalid');
  }
  const seen = new Set<string>();
  let totalMs = 0;
  for (const entry of value.attempts) {
    if (!isRecord(entry) || typeof entry.attemptId !== 'string' || !Number.isFinite(entry.latencyMs) || Number(entry.latencyMs) < 0) {
      throw new Error('memory benchmark latency entry is invalid');
    }
    if (seen.has(entry.attemptId)) throw new Error('duplicate memory benchmark latency attempt');
    seen.add(entry.attemptId);
    totalMs += Number(entry.latencyMs);
  }
  if (!sameStringSet([...seen], expectedAttemptIds)) throw new Error('memory benchmark latency coverage does not match completed attempts');
  return { attempts: seen.size, totalMs, meanMs: seen.size === 0 ? 0 : totalMs / seen.size };
}

async function assertContainedRunRoot(baselineRoot: string, runRoot: string): Promise<void> {
  const lexical = relative(resolve(baselineRoot), resolve(runRoot));
  if (lexical.startsWith('..') || lexical === '') throw new Error('baseline run root must stay inside the baseline root');
  try {
    const entry = await lstat(runRoot);
    if (entry.isSymbolicLink() || !entry.isDirectory()) throw new Error('baseline run root must be a real directory');
    const [realBaseline, realRun] = await Promise.all([realpath(baselineRoot), realpath(runRoot)]);
    const physical = relative(realBaseline, realRun);
    if (physical.startsWith('..') || physical === '') throw new Error('baseline run root must not escape through a symlink');
  } catch (error) {
    if (!isRecord(error) || error.code !== 'ENOENT') throw error;
  }
}

function invalidScore(manifest: MemoryBenchmarkManifest): MemoryBenchmarkScore {
  return {
    expectedAttempts: manifest.dataset.taskIds.length * manifest.repetitions,
    completedAttempts: 0,
    authoritativeAttempts: 0,
    passedAttempts: 0,
    coverageRate: 0,
    passRate: null,
    invalidAttemptIds: [],
    verdict: 'invalid',
  };
}

function relativePath(value: string, label: string): void {
  nonEmpty(value, label);
  if (value.startsWith('/') || value.includes('\\') || value.split('/').some((part) => part === '..' || part === '')) {
    throw new Error(`${label} must be a safe relative path`);
  }
}

function sha256(value: unknown, label: string): string {
  if (typeof value !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(value)) throw new Error(`${label} must be a SHA-256 digest`);
  return value;
}

function nonEmpty(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || value.trim().length === 0) throw new Error(`${label} must be non-empty`);
}

function unique(values: readonly string[], label: string): void {
  if (new Set(values).size !== values.length) throw new Error(label);
}

function sameStringSet(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((entry) => right.includes(entry));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return value;
  Object.freeze(value);
  Object.values(value).forEach((entry) => deepFreeze(entry));
  return value;
}
