import { createHash, randomUUID } from 'node:crypto';
import { appendFile, link, lstat, mkdir, readFile, realpath, stat, truncate, unlink, writeFile } from 'node:fs/promises';
import { dirname, relative, resolve } from 'node:path';
import { buildRunManifestFingerprint } from './ab-manifest.js';
import { harborOfficialVerifierOutputFromArtifacts } from './harbor-official-artifacts.js';

export const MEMORY_BENCHMARK_MANIFEST_SCHEMA_VERSION = 'maka.memory_benchmark.run_manifest.v1' as const;
export const MEMORY_BENCHMARK_FORMAT_V1 = 'maka.memory_benchmark.v1' as const;

export type MemoryBenchmarkReasoningEffort = 'default' | 'low' | 'medium' | 'high';

export interface MemoryBenchmarkManifestInput {
  runId: string;
  subject: {
    commit: string;
    dirty: boolean;
  };
  environment: {
    gatewayId: string;
    provider: string;
    modelId: string;
    reasoningEffort: MemoryBenchmarkReasoningEffort;
  };
  strategy: {
    id: string;
    configHash: string;
  };
  dataset: {
    id: string;
    hash: string;
    taskIds: string[];
  };
  repetitions: number;
  artifactPaths: {
    attemptsJsonl: string;
    tokenCsv: string;
    verifierDirectory: string;
    transcriptDirectory: string;
  };
  redactionPolicyVersion: string;
}

export interface MemoryBenchmarkManifest extends MemoryBenchmarkManifestInput {
  schemaVersion: typeof MEMORY_BENCHMARK_MANIFEST_SCHEMA_VERSION;
  fingerprint: string;
  [key: string]: unknown;
}

export interface MemoryBenchmarkWriteOptions {
  format: typeof MEMORY_BENCHMARK_FORMAT_V1;
}

export interface MemoryBenchmarkAttemptArtifact {
  schemaVersion: 'maka.memory_benchmark.attempt_artifact.v1';
  attemptId: string;
  manifestFingerprint: string;
  taskId: string;
  rep: number;
  status: 'completed';
  artifacts: {
    verifier: string;
    transcript: string;
    tokenRecord: string;
  };
  artifactDigests: {
    verifier: string;
    transcript: string;
    tokenRecord: string;
  };
  verifierProvenance: {
    source: 'harbor_result_json';
    importedBy: 'harbor_post_exit';
  };
  [key: string]: unknown;
}

export interface MemoryBenchmarkPlannedAttempt {
  attemptId: string;
  taskId: string;
  rep: number;
}

export interface MemoryBenchmarkResumePlan {
  completedAttemptIds: string[];
  pendingAttempts: MemoryBenchmarkPlannedAttempt[];
}

export interface ImportHarborMemoryBenchmarkAttemptInput {
  runRoot: string;
  manifest: MemoryBenchmarkManifest;
  attempt: MemoryBenchmarkPlannedAttempt;
  artifacts: MemoryBenchmarkAttemptArtifact['artifacts'];
}

export interface MemoryBenchmarkScore {
  expectedAttempts: number;
  completedAttempts: number;
  authoritativeAttempts: number;
  passedAttempts: number;
  coverageRate: number;
  passRate: number | null;
  invalidAttemptIds: string[];
  verdict: 'valid' | 'invalid';
}

const attemptAppendQueues = new Map<string, Promise<void>>();

export function buildMemoryBenchmarkManifest(input: MemoryBenchmarkManifestInput): MemoryBenchmarkManifest {
  assertMemoryBenchmarkArtifactRedacted(input);
  validateManifestBody(input);
  const body = {
    schemaVersion: MEMORY_BENCHMARK_MANIFEST_SCHEMA_VERSION,
    runId: input.runId,
    subject: { ...input.subject },
    environment: { ...input.environment },
    strategy: { ...input.strategy },
    dataset: { ...input.dataset, taskIds: [...input.dataset.taskIds] },
    repetitions: input.repetitions,
    artifactPaths: { ...input.artifactPaths },
    redactionPolicyVersion: input.redactionPolicyVersion,
  };
  return {
    ...body,
    fingerprint: buildRunManifestFingerprint(body),
  };
}

export function parseMemoryBenchmarkManifest(value: unknown): MemoryBenchmarkManifest {
  if (!isRecord(value)) throw new Error('memory benchmark manifest must be an object');
  if (value.schemaVersion !== MEMORY_BENCHMARK_MANIFEST_SCHEMA_VERSION) {
    throw new Error(`unsupported memory benchmark manifest schemaVersion: ${String(value.schemaVersion ?? 'missing')}`);
  }
  assertMemoryBenchmarkArtifactRedacted(value);
  validateManifestBody(value);
  sha256(value.fingerprint, 'memory benchmark manifest fingerprint');
  const { fingerprint, ...body } = value;
  const recomputed = buildRunManifestFingerprint(body);
  if (fingerprint !== recomputed) {
    throw new Error(`memory benchmark manifest fingerprint is invalid: stored ${fingerprint}, recomputed ${recomputed}`);
  }
  return value as MemoryBenchmarkManifest;
}

export async function ensureMemoryBenchmarkManifest(
  path: string,
  manifest: MemoryBenchmarkManifest,
  options: MemoryBenchmarkWriteOptions,
): Promise<MemoryBenchmarkManifest> {
  requireV1WriteFormat(options);
  const candidate = validatedManifestSnapshot(manifest);
  let raw: string | undefined;
  try {
    raw = await readFile(path, 'utf8');
  } catch (error) {
    if (!isNotFound(error)) throw error;
  }

  if (raw === undefined) {
    await mkdir(dirname(path), { recursive: true });
    const tempPath = `${path}.tmp-${process.pid}-${randomUUID()}`;
    try {
      await writeFile(tempPath, `${JSON.stringify(candidate, null, 2)}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
      await link(tempPath, path);
      return candidate;
    } catch (error) {
      if (!isAlreadyExists(error)) throw error;
      raw = await readFile(path, 'utf8');
    } finally {
      await unlink(tempPath).catch((error: unknown) => {
        if (!isNotFound(error)) throw error;
      });
    }
  }

  const existing = parseMemoryBenchmarkManifest(JSON.parse(raw));
  if (existing.fingerprint !== candidate.fingerprint) {
    throw new Error(
      `memory benchmark manifest does not match existing run id: existing ${existing.fingerprint}, current ${candidate.fingerprint}. Use a new run id or restore the original run config.`,
    );
  }
  return existing;
}

export function redactMemoryBenchmarkArtifact<T>(value: T): T {
  return redactValue(value, undefined) as T;
}

export function hashMemoryBenchmarkArtifact(value: string | Uint8Array): string {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

export async function writeRedactedMemoryBenchmarkJson(
  path: string,
  value: unknown,
  options: MemoryBenchmarkWriteOptions,
): Promise<void> {
  requireV1WriteFormat(options);
  await mkdir(dirname(path), { recursive: true });
  await publishImmutableFile(path, `${JSON.stringify(redactMemoryBenchmarkArtifact(value), null, 2)}\n`);
}

export async function writeRedactedMemoryBenchmarkText(
  path: string,
  value: string,
  options: MemoryBenchmarkWriteOptions,
): Promise<void> {
  requireV1WriteFormat(options);
  await mkdir(dirname(path), { recursive: true });
  await publishImmutableFile(path, redactString(value));
}

export function planMemoryBenchmarkResume(
  manifest: MemoryBenchmarkManifest,
  completedAttempts: readonly MemoryBenchmarkAttemptArtifact[],
): MemoryBenchmarkResumePlan {
  const frozenManifest = validatedManifestSnapshot(manifest);
  const completedIds = new Set<string>();
  for (const attempt of completedAttempts) {
    validateAttemptArtifact(attempt);
    if (attempt.manifestFingerprint !== frozenManifest.fingerprint) {
      throw new Error(`memory benchmark attempt ${attempt.attemptId} does not belong to manifest ${frozenManifest.fingerprint}`);
    }
    const expectedId = buildMemoryBenchmarkAttemptId(frozenManifest, attempt.taskId, attempt.rep);
    if (attempt.attemptId !== expectedId) {
      throw new Error(`memory benchmark attemptId is invalid for ${attempt.taskId} rep ${attempt.rep}`);
    }
    if (completedIds.has(attempt.attemptId)) {
      throw new Error(`duplicate memory benchmark attemptId: ${attempt.attemptId}`);
    }
    completedIds.add(attempt.attemptId);
  }

  const pendingAttempts: MemoryBenchmarkPlannedAttempt[] = [];
  for (const taskId of frozenManifest.dataset.taskIds) {
    for (let rep = 1; rep <= frozenManifest.repetitions; rep += 1) {
      const attemptId = buildMemoryBenchmarkAttemptId(frozenManifest, taskId, rep);
      if (!completedIds.has(attemptId)) pendingAttempts.push({ attemptId, taskId, rep });
    }
  }
  return {
    completedAttemptIds: [...completedIds].sort(),
    pendingAttempts,
  };
}

export async function readMemoryBenchmarkAttempts(
  runRoot: string,
  manifest: MemoryBenchmarkManifest,
): Promise<MemoryBenchmarkAttemptArtifact[]> {
  const frozenManifest = validatedManifestSnapshot(manifest);
  const path = await resolveManifestAttemptWalPath(runRoot, frozenManifest, false);
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (error) {
    if (isNotFound(error)) return [];
    throw error;
  }
  const lines = raw.split('\n');
  const attempts: MemoryBenchmarkAttemptArtifact[] = [];
  const seen = new Set<string>();
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    if (line.trim().length === 0) continue;
    let attempt: unknown;
    try {
      attempt = JSON.parse(line);
    } catch (error) {
      if (index === lines.length - 1 && !raw.endsWith('\n')) break;
      throw error;
    }
    validateAttemptArtifact(attempt);
    if (seen.has(attempt.attemptId)) throw new Error(`duplicate memory benchmark attemptId: ${attempt.attemptId}`);
    seen.add(attempt.attemptId);
    attempts.push(attempt);
  }
  return attempts;
}

export async function appendMemoryBenchmarkAttempt(
  runRoot: string,
  manifest: MemoryBenchmarkManifest,
  attempt: MemoryBenchmarkAttemptArtifact,
  options: MemoryBenchmarkWriteOptions,
): Promise<void> {
  requireV1WriteFormat(options);
  const frozenManifest = validatedManifestSnapshot(manifest);
  validateAttemptArtifact(attempt);
  planMemoryBenchmarkResume(frozenManifest, [attempt]);
  const path = await resolveManifestAttemptWalPath(runRoot, frozenManifest, true);
  const previous = attemptAppendQueues.get(path) ?? Promise.resolve();
  const current = previous.catch(() => undefined).then(() => withAttemptFileLock(path, async () => {
    const existing = await readMemoryBenchmarkAttempts(runRoot, frozenManifest);
    const matching = existing.find((entry) => entry.attemptId === attempt.attemptId);
    if (matching) {
      if (JSON.stringify(matching) !== JSON.stringify(attempt)) {
        throw new Error(`memory benchmark attempt ${attempt.attemptId} is already completed with different evidence`);
      }
      return;
    }
    await mkdir(dirname(path), { recursive: true });
    await prepareJsonlTailForAppend(path);
    await appendFile(path, `${JSON.stringify(attempt)}\n`, { encoding: 'utf8', mode: 0o600 });
  }));
  attemptAppendQueues.set(path, current);
  try {
    await current;
  } finally {
    if (attemptAppendQueues.get(path) === current) attemptAppendQueues.delete(path);
  }
}

export async function importHarborMemoryBenchmarkAttempt(
  input: ImportHarborMemoryBenchmarkAttemptInput,
): Promise<MemoryBenchmarkAttemptArtifact> {
  const manifest = validatedManifestSnapshot(input.manifest);
  const attemptId = buildMemoryBenchmarkAttemptId(manifest, input.attempt.taskId, input.attempt.rep);
  if (input.attempt.attemptId !== attemptId) {
    throw new Error('memory benchmark planned attempt does not match its manifest identity');
  }
  const unsealed: MemoryBenchmarkAttemptArtifact = {
    schemaVersion: 'maka.memory_benchmark.attempt_artifact.v1',
    ...input.attempt,
    manifestFingerprint: manifest.fingerprint,
    status: 'completed',
    artifacts: { ...input.artifacts },
    artifactDigests: {
      verifier: `sha256:${'0'.repeat(64)}`,
      transcript: `sha256:${'0'.repeat(64)}`,
      tokenRecord: `sha256:${'0'.repeat(64)}`,
    },
    verifierProvenance: {
      source: 'harbor_result_json',
      importedBy: 'harbor_post_exit',
    },
  };
  validateAttemptArtifactLayout(manifest, unsealed);
  const verifierPath = await resolveArtifactPath(input.runRoot, input.artifacts.verifier);
  const transcriptPath = await resolveArtifactPath(input.runRoot, input.artifacts.transcript);
  const [verifierContent, transcriptContent, tokenRow] = await Promise.all([
    readFile(verifierPath),
    readFile(transcriptPath),
    readAndValidateTokenRecord(input.runRoot, input.artifacts.tokenRecord, attemptId),
  ]);
  const verifierResult = parseHarborResultArtifact(verifierContent);
  assertMemoryBenchmarkArtifactRedacted(verifierResult);
  assertRedactedTranscriptContent(transcriptContent);
  const sealed: MemoryBenchmarkAttemptArtifact = {
    ...unsealed,
    artifactDigests: {
      verifier: hashMemoryBenchmarkArtifact(verifierContent),
      transcript: hashMemoryBenchmarkArtifact(transcriptContent),
      tokenRecord: hashMemoryBenchmarkArtifact(tokenRow),
    },
  };
  validateAttemptArtifact(sealed);
  return sealed;
}

export function buildMemoryBenchmarkAttemptId(
  manifest: MemoryBenchmarkManifest,
  taskId: string,
  rep: number,
): string {
  if (!manifest.dataset.taskIds.includes(taskId)) throw new Error(`unknown memory benchmark taskId: ${taskId}`);
  if (!Number.isSafeInteger(rep) || rep < 1 || rep > manifest.repetitions) {
    throw new Error(`memory benchmark rep must be between 1 and ${manifest.repetitions}`);
  }
  return buildRunManifestFingerprint({
    kind: 'maka.memory_benchmark.attempt.v1',
    manifestFingerprint: manifest.fingerprint,
    taskId,
    rep,
  });
}

export async function recomputeMemoryBenchmarkScore(
  runRoot: string,
  manifest: MemoryBenchmarkManifest,
  attempts: readonly MemoryBenchmarkAttemptArtifact[],
): Promise<MemoryBenchmarkScore> {
  const frozenManifest = validatedManifestSnapshot(manifest);
  const resume = planMemoryBenchmarkResume(frozenManifest, attempts);
  const authoritative: Array<{ attemptId: string; passed: boolean }> = [];
  const invalidAttemptIds: string[] = [];
  for (const attempt of attempts) {
    try {
      validateAttemptArtifactLayout(frozenManifest, attempt);
      const transcriptPath = await resolveArtifactPath(runRoot, attempt.artifacts.transcript);
      const transcriptContent = await readVerifiedArtifact(transcriptPath, attempt.artifactDigests.transcript, 'transcript');
      assertRedactedTranscriptContent(transcriptContent);
      const tokenRow = await readAndValidateTokenRecord(
        runRoot,
        attempt.artifacts.tokenRecord,
        attempt.attemptId,
      );
      if (hashMemoryBenchmarkArtifact(tokenRow) !== attempt.artifactDigests.tokenRecord) {
        throw new Error(`memory benchmark token CSV row digest does not match for ${attempt.attemptId}`);
      }
      const verifierPath = await resolveArtifactPath(runRoot, attempt.artifacts.verifier);
      const verifierContent = await readVerifiedArtifact(verifierPath, attempt.artifactDigests.verifier, 'verifier');
      const verifierResult = parseHarborResultArtifact(verifierContent);
      assertMemoryBenchmarkArtifactRedacted(verifierResult);
      const verifier = harborOfficialVerifierOutputFromArtifacts({ resultJson: verifierResult });
      if (!verifier.authority?.authoritative || verifier.authority.source !== 'official_harbor_verifier') {
        invalidAttemptIds.push(attempt.attemptId);
        continue;
      }
      authoritative.push({ attemptId: attempt.attemptId, passed: verifier.passed });
    } catch {
      invalidAttemptIds.push(attempt.attemptId);
    }
  }
  const passed = authoritative.filter((attempt) => attempt.passed);
  const expectedAttempts = frozenManifest.dataset.taskIds.length * frozenManifest.repetitions;
  invalidAttemptIds.sort();
  const complete = resume.pendingAttempts.length === 0;
  return {
    expectedAttempts,
    completedAttempts: attempts.length,
    authoritativeAttempts: authoritative.length,
    passedAttempts: passed.length,
    coverageRate: expectedAttempts === 0 ? 0 : authoritative.length / expectedAttempts,
    passRate: authoritative.length === 0 ? null : passed.length / authoritative.length,
    invalidAttemptIds,
    verdict: complete && invalidAttemptIds.length === 0 ? 'valid' : 'invalid',
  };
}

function validateManifestBody(value: unknown): void {
  const manifest = record(value, 'memory benchmark manifest');
  nonEmptyString(manifest.runId, 'memory benchmark manifest runId');
  const subject = record(manifest.subject, 'memory benchmark manifest subject');
  gitCommit(subject.commit, 'memory benchmark manifest subject.commit');
  if (typeof subject.dirty !== 'boolean') throw new Error('memory benchmark manifest subject.dirty must be a boolean');

  const environment = record(manifest.environment, 'memory benchmark manifest environment');
  nonEmptyString(environment.gatewayId, 'memory benchmark manifest environment.gatewayId');
  nonEmptyString(environment.provider, 'memory benchmark manifest environment.provider');
  nonEmptyString(environment.modelId, 'memory benchmark manifest environment.modelId');
  if (!['default', 'low', 'medium', 'high'].includes(String(environment.reasoningEffort))) {
    throw new Error('memory benchmark manifest environment.reasoningEffort must be default, low, medium, or high');
  }

  const strategy = record(manifest.strategy, 'memory benchmark manifest strategy');
  nonEmptyString(strategy.id, 'memory benchmark manifest strategy.id');
  sha256(strategy.configHash, 'memory benchmark manifest strategy.configHash');

  const dataset = record(manifest.dataset, 'memory benchmark manifest dataset');
  nonEmptyString(dataset.id, 'memory benchmark manifest dataset.id');
  sha256(dataset.hash, 'memory benchmark manifest dataset.hash');
  stringIds(dataset.taskIds, 'memory benchmark manifest dataset.taskIds');

  if (!Number.isSafeInteger(manifest.repetitions) || Number(manifest.repetitions) < 1) {
    throw new Error('memory benchmark manifest repetitions must be a positive integer');
  }

  const artifactPaths = record(manifest.artifactPaths, 'memory benchmark manifest artifactPaths');
  for (const key of ['attemptsJsonl', 'tokenCsv', 'verifierDirectory', 'transcriptDirectory']) {
    relativeArtifactPath(artifactPaths[key], `memory benchmark manifest artifactPaths.${key}`);
  }
  nonEmptyString(manifest.redactionPolicyVersion, 'memory benchmark manifest redactionPolicyVersion');
}

function validatedManifestSnapshot(manifest: MemoryBenchmarkManifest): MemoryBenchmarkManifest {
  return parseMemoryBenchmarkManifest(structuredClone(manifest));
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`${label} must be an object`);
  return value;
}

function nonEmptyString(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || value.trim().length === 0) throw new Error(`${label} must be a non-empty string`);
}

function gitCommit(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || !/^[a-f0-9]{40,64}$/.test(value)) {
    throw new Error(`${label} must be a 40-64 character lowercase hexadecimal commit id`);
  }
}

function sha256(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(value)) {
    throw new Error(`${label} must be a sha256 fingerprint`);
  }
}

function relativeArtifactPath(value: unknown, label: string): asserts value is string {
  nonEmptyString(value, label);
  const normalized = value.replaceAll('\\', '/');
  if (normalized.startsWith('/') || /^[A-Za-z]:\//.test(normalized) || normalized.split('/').includes('..')) {
    throw new Error(`${label} must stay inside the benchmark run root`);
  }
}

function stringIds(value: unknown, label: string): asserts value is string[] {
  if (!Array.isArray(value) || value.length === 0 || value.some((entry) => typeof entry !== 'string' || entry.length === 0)) {
    throw new Error(`${label} must be a non-empty string array`);
  }
  if (new Set(value).size !== value.length) throw new Error(`${label} must not contain duplicates`);
}

function validateAttemptArtifact(value: unknown): asserts value is MemoryBenchmarkAttemptArtifact {
  const attempt = record(value, 'memory benchmark attempt artifact');
  if (attempt.schemaVersion !== 'maka.memory_benchmark.attempt_artifact.v1') {
    throw new Error(`unsupported memory benchmark attempt schemaVersion: ${String(attempt.schemaVersion ?? 'missing')}`);
  }
  assertMemoryBenchmarkArtifactRedacted(attempt);
  nonEmptyString(attempt.attemptId, 'memory benchmark attempt attemptId');
  sha256(attempt.attemptId, 'memory benchmark attempt attemptId');
  sha256(attempt.manifestFingerprint, 'memory benchmark attempt manifestFingerprint');
  nonEmptyString(attempt.taskId, 'memory benchmark attempt taskId');
  if (!Number.isSafeInteger(attempt.rep) || Number(attempt.rep) < 1) {
    throw new Error('memory benchmark attempt rep must be a positive integer');
  }
  if (attempt.status !== 'completed') throw new Error('memory benchmark attempt status must be completed');
  const artifacts = record(attempt.artifacts, 'memory benchmark attempt artifacts');
  relativeArtifactPath(artifacts.verifier, 'memory benchmark attempt artifacts.verifier');
  relativeArtifactPath(artifacts.transcript, 'memory benchmark attempt artifacts.transcript');
  nonEmptyString(artifacts.tokenRecord, 'memory benchmark attempt artifacts.tokenRecord');
  const artifactDigests = record(attempt.artifactDigests, 'memory benchmark attempt artifactDigests');
  sha256(artifactDigests.verifier, 'memory benchmark attempt artifactDigests.verifier');
  sha256(artifactDigests.transcript, 'memory benchmark attempt artifactDigests.transcript');
  sha256(artifactDigests.tokenRecord, 'memory benchmark attempt artifactDigests.tokenRecord');
  const verifierProvenance = record(attempt.verifierProvenance, 'memory benchmark attempt verifierProvenance');
  if (verifierProvenance.source !== 'harbor_result_json' || verifierProvenance.importedBy !== 'harbor_post_exit') {
    throw new Error('memory benchmark attempt verifierProvenance must identify a Harbor post-exit result import');
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function assertMemoryBenchmarkArtifactRedacted(value: unknown): void {
  if (JSON.stringify(redactMemoryBenchmarkArtifact(value)) !== JSON.stringify(value)) {
    throw new Error('memory benchmark artifact contains unredacted credentials');
  }
}

function assertRedactedTextContent(value: Uint8Array, label: string): void {
  const text = Buffer.from(value).toString('utf8');
  if (redactString(text) !== text) throw new Error(`${label} contains unredacted credentials`);
}

function assertRedactedTranscriptContent(value: Uint8Array): void {
  assertRedactedTextContent(value, 'memory benchmark transcript artifact');
  const text = Buffer.from(value).toString('utf8');
  for (const [index, line] of text.split('\n').entries()) {
    if (line.trim().length === 0) continue;
    let record: unknown;
    try {
      record = JSON.parse(line);
    } catch {
      throw new Error(`memory benchmark transcript artifact line ${index + 1} must be valid JSONL`);
    }
    assertMemoryBenchmarkArtifactRedacted(record);
  }
}

function redactValue(value: unknown, key: string | undefined): unknown {
  if (key !== undefined && isSensitiveKey(key)) return '[REDACTED]';
  if (typeof value === 'string') return redactString(value);
  if (Array.isArray(value)) return value.map((entry) => redactValue(entry, undefined));
  if (isRecord(value)) {
    return Object.fromEntries(Object.entries(value).map(([entryKey, entryValue]) => [
      entryKey,
      redactValue(entryValue, entryKey),
    ]));
  }
  return value;
}

function isSensitiveKey(key: string): boolean {
  const normalized = key.replace(/[^a-z0-9]/gi, '').toLowerCase();
  return normalized === 'authorization'
    || normalized === 'password'
    || normalized === 'secret'
    || normalized === 'token'
    || normalized === 'cookie'
    || normalized === 'setcookie'
    || normalized === 'credentials'
    || normalized === 'credential'
    || normalized.includes('secret')
    || normalized.endsWith('password')
    || normalized.endsWith('credential')
    || normalized.endsWith('credentials')
    || (normalized.endsWith('token') && !normalized.endsWith('tokens'))
    || normalized.endsWith('apikey')
    || normalized.endsWith('apikeyfile')
    || normalized.endsWith('accesstoken')
    || normalized.endsWith('refreshtoken')
    || normalized.endsWith('sessiontoken')
    || normalized.endsWith('authtoken')
    || normalized.endsWith('clientsecret')
    || normalized.endsWith('privatekey')
    || normalized.endsWith('signingkey');
}

function redactString(value: string): string {
  return value
    .replace(
      /("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')(\s*:\s*)(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^,}\]\r\n]+)/g,
      (match, keyLiteral: string, separator: string) => {
        let key: string;
        try {
          key = keyLiteral.startsWith('"') ? String(JSON.parse(keyLiteral)) : keyLiteral.slice(1, -1);
        } catch {
          return match;
        }
        return isSensitiveKey(key) ? `${keyLiteral}${separator}"[REDACTED]"` : match;
      },
    )
    .replace(/\b(Cookie|Set-Cookie)\s*:\s*[^\r\n]+/gi, '$1: [REDACTED]')
    .replace(/\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/-]+=*/gi, '[REDACTED]')
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, '[REDACTED]')
    .replace(/\bgh[opusr]_[A-Za-z0-9]{12,}\b/g, '[REDACTED]')
    .replace(/\bxox[baprs]-[A-Za-z0-9-]{8,}\b/g, '[REDACTED]')
    .replace(/([?&](?:api[_-]?key|access[_-]?token|token|key)=)[^&#\s]+/gi, '$1[REDACTED]')
    .replace(/(\b[A-Za-z0-9_.-]*(?:api[_-]?key|(?:access|refresh|session|auth)?[_-]?token|client[_-]?secret|password|credential|secret)\s*[:=]\s*)[^\s,;]+/gi, '$1[REDACTED]')
    .replace(/:\/\/[^/\s:@]+:[^@\s/]+@/g, '://[REDACTED]@')
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, '[REDACTED]');
}

function isNotFound(error: unknown): boolean {
  return typeof error === 'object'
    && error !== null
    && 'code' in error
    && (error as { code?: unknown }).code === 'ENOENT';
}

function isAlreadyExists(error: unknown): boolean {
  return typeof error === 'object'
    && error !== null
    && 'code' in error
    && (error as { code?: unknown }).code === 'EEXIST';
}

function requireV1WriteFormat(options: MemoryBenchmarkWriteOptions): void {
  if (options?.format !== MEMORY_BENCHMARK_FORMAT_V1) {
    throw new Error(`memory benchmark v1 writing requires format=${MEMORY_BENCHMARK_FORMAT_V1}`);
  }
}

async function publishImmutableFile(path: string, content: string): Promise<void> {
  const tempPath = `${path}.tmp-${process.pid}-${randomUUID()}`;
  try {
    await writeFile(tempPath, content, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    try {
      await link(tempPath, path);
      return;
    } catch (error) {
      if (!isAlreadyExists(error)) throw error;
    }
    const existing = await readFile(path, 'utf8');
    if (existing !== content) throw new Error(`memory benchmark artifact already exists with different content: ${path}`);
  } finally {
    await unlink(tempPath).catch((error: unknown) => {
      if (!isNotFound(error)) throw error;
    });
  }
}

async function withAttemptFileLock<T>(path: string, action: () => Promise<T>): Promise<T> {
  const lockPath = `${path}.lock`;
  await mkdir(dirname(path), { recursive: true });
  const deadline = Date.now() + 5_000;
  while (true) {
    const tempLockPath = `${lockPath}.tmp-${process.pid}-${randomUUID()}`;
    try {
      await writeFile(tempLockPath, `${JSON.stringify({ pid: process.pid, startedAt: Date.now() })}\n`, {
        encoding: 'utf8',
        flag: 'wx',
        mode: 0o600,
      });
      await link(tempLockPath, lockPath);
      break;
    } catch (error) {
      if (!isAlreadyExists(error)) throw error;
      const ownerPid = await readLockOwnerPid(lockPath);
      if ((ownerPid !== undefined && !isProcessAlive(ownerPid))
        || (ownerPid === undefined && await isMalformedLockStale(lockPath))) {
        await unlink(lockPath).catch((unlinkError: unknown) => {
          if (!isNotFound(unlinkError)) throw unlinkError;
        });
        continue;
      }
      if (Date.now() >= deadline) throw new Error(`memory benchmark attempt WAL is locked: ${path}`);
      await new Promise<void>((resolveWait) => setTimeout(resolveWait, 10));
    } finally {
      await unlink(tempLockPath).catch((error: unknown) => {
        if (!isNotFound(error)) throw error;
      });
    }
  }
  try {
    return await action();
  } finally {
    await unlink(lockPath).catch((error: unknown) => {
      if (!isNotFound(error)) throw error;
    });
  }
}

async function readLockOwnerPid(lockPath: string): Promise<number | undefined> {
  try {
    const value = JSON.parse(await readFile(lockPath, 'utf8')) as { pid?: unknown };
    return Number.isSafeInteger(value.pid) && Number(value.pid) > 0 ? Number(value.pid) : undefined;
  } catch {
    return undefined;
  }
}

async function isMalformedLockStale(lockPath: string): Promise<boolean> {
  try {
    return Date.now() - (await stat(lockPath)).mtimeMs >= 1_000;
  } catch (error) {
    if (isNotFound(error)) return true;
    throw error;
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !isNodeError(error, 'ESRCH');
  }
}

async function prepareJsonlTailForAppend(path: string): Promise<void> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (error) {
    if (isNotFound(error)) return;
    throw error;
  }
  if (raw.length === 0 || raw.endsWith('\n')) return;
  const lastNewline = raw.lastIndexOf('\n');
  const finalLine = raw.slice(lastNewline + 1);
  try {
    const parsed = JSON.parse(finalLine) as unknown;
    validateAttemptArtifact(parsed);
  } catch {
    await truncate(path, lastNewline < 0 ? 0 : lastNewline + 1);
    return;
  }
  await appendFile(path, '\n', { encoding: 'utf8', mode: 0o600 });
}

async function resolveManifestAttemptWalPath(
  runRoot: string,
  manifest: MemoryBenchmarkManifest,
  createParent: boolean,
): Promise<string> {
  const artifactPath = manifest.artifactPaths.attemptsJsonl;
  relativeArtifactPath(artifactPath, 'memory benchmark manifest artifactPaths.attemptsJsonl');
  const root = resolve(runRoot);
  const path = resolve(root, artifactPath);
  const relativePath = relative(root, path);
  if (relativePath.startsWith('..') || relativePath === '') {
    throw new Error('memory benchmark attempt WAL must resolve inside the run root');
  }
  await validateDirectoryPathWithoutSymlinks(root, dirname(path), createParent);
  try {
    const entry = await lstat(path);
    if (entry.isSymbolicLink()) throw new Error('memory benchmark attempt WAL must not be a symlink');
    const [realRoot, realPath] = await Promise.all([realpath(root), realpath(path)]);
    const realRelativePath = relative(realRoot, realPath);
    if (realRelativePath.startsWith('..') || realRelativePath === '') {
      throw new Error('memory benchmark attempt WAL must not escape through a symlink');
    }
    return realPath;
  } catch (error) {
    if (!isNotFound(error)) throw error;
    return path;
  }
}

async function validateDirectoryPathWithoutSymlinks(
  root: string,
  target: string,
  createMissing: boolean,
): Promise<void> {
  const relativePath = relative(root, target);
  if (relativePath.startsWith('..')) throw new Error('memory benchmark artifact parent must stay inside the run root');
  let current = root;
  for (const segment of relativePath.split(/[\\/]/).filter(Boolean)) {
    current = resolve(current, segment);
    try {
      const entry = await lstat(current);
      if (entry.isSymbolicLink() || !entry.isDirectory()) {
        throw new Error('memory benchmark artifact parent must contain only real directories');
      }
    } catch (error) {
      if (!isNotFound(error)) throw error;
      if (!createMissing) return;
      await mkdir(current, { mode: 0o700 });
    }
  }
}

function validateAttemptArtifactLayout(
  manifest: MemoryBenchmarkManifest,
  attempt: MemoryBenchmarkAttemptArtifact,
): void {
  assertArtifactUnderDirectory(
    attempt.artifacts.verifier,
    manifest.artifactPaths.verifierDirectory,
    'verifier',
  );
  assertArtifactUnderDirectory(
    attempt.artifacts.transcript,
    manifest.artifactPaths.transcriptDirectory,
    'transcript',
  );
  const separator = attempt.artifacts.tokenRecord.indexOf('#');
  const tokenCsv = separator < 0 ? attempt.artifacts.tokenRecord : attempt.artifacts.tokenRecord.slice(0, separator);
  if (normalizeArtifactPath(tokenCsv) !== normalizeArtifactPath(manifest.artifactPaths.tokenCsv)) {
    throw new Error('memory benchmark token record must use manifest artifactPaths.tokenCsv');
  }
}

function assertArtifactUnderDirectory(artifactPath: string, directory: string, label: string): void {
  const normalizedArtifact = normalizeArtifactPath(artifactPath);
  const normalizedDirectory = normalizeArtifactPath(directory).replace(/\/$/, '');
  if (!normalizedArtifact.startsWith(`${normalizedDirectory}/`)) {
    throw new Error(`memory benchmark ${label} artifact must be inside its manifest directory`);
  }
}

function normalizeArtifactPath(path: string): string {
  return path.replaceAll('\\', '/').replace(/^\.\//, '');
}

async function resolveArtifactPath(runRoot: string, artifactPath: string): Promise<string> {
  relativeArtifactPath(artifactPath, 'memory benchmark artifact path');
  const root = resolve(runRoot);
  const resolved = resolve(root, artifactPath);
  const relativePath = relative(root, resolved);
  if (relativePath.startsWith('..') || relativePath === '') {
    throw new Error('memory benchmark artifact path must resolve inside the run root');
  }
  const [realRoot, realArtifact] = await Promise.all([realpath(root), realpath(resolved)]);
  const realRelativePath = relative(realRoot, realArtifact);
  if (realRelativePath.startsWith('..') || realRelativePath === '') {
    throw new Error('memory benchmark artifact path must not escape through a symlink');
  }
  return realArtifact;
}

async function readAndValidateTokenRecord(
  runRoot: string,
  tokenRecord: string,
  attemptId: string,
): Promise<string> {
  const separator = tokenRecord.indexOf('#');
  if (separator <= 0 || tokenRecord.slice(separator + 1) !== attemptId) {
    throw new Error(`memory benchmark tokenRecord must reference its attemptId: ${attemptId}`);
  }
  const tokenPath = await resolveArtifactPath(runRoot, tokenRecord.slice(0, separator));
  const rows = (await readFile(tokenPath, 'utf8')).trimEnd().split('\n').map((line) => line.split(','));
  const header = rows.shift();
  const expectedHeader = ['attempt_id', 'input_tokens', 'output_tokens', 'reasoning_tokens', 'total_tokens'];
  if (!header || header.join(',') !== expectedHeader.join(',')) {
    throw new Error('memory benchmark token CSV header is invalid');
  }
  const matching = rows.filter((row) => row[0] === attemptId);
  if (matching.length !== 1) throw new Error(`memory benchmark token CSV must contain exactly one row for ${attemptId}`);
  const serializedRow = matching[0]!.join(',');
  const rawValues = matching[0]!.slice(1);
  if (rawValues.length !== 4 || rawValues.some((value) => !/^(0|[1-9][0-9]*)$/.test(value))) {
    throw new Error(`memory benchmark token CSV row is invalid for ${attemptId}`);
  }
  const values = rawValues.map(Number);
  if (values.some((value) => !Number.isSafeInteger(value))) {
    throw new Error(`memory benchmark token CSV values must be safe integers for ${attemptId}`);
  }
  const reconciledTotal = values[0]! + values[1]! + values[2]!;
  if (!Number.isSafeInteger(reconciledTotal)) {
    throw new Error(`memory benchmark token CSV values must be safe integers for ${attemptId}`);
  }
  if (values[3] !== reconciledTotal) {
    throw new Error(`memory benchmark token CSV total does not reconcile for ${attemptId}`);
  }
  return serializedRow;
}

async function readVerifiedArtifact(path: string, expectedDigest: string, label: string): Promise<Buffer> {
  const content = await readFile(path);
  if (hashMemoryBenchmarkArtifact(content) !== expectedDigest) {
    throw new Error(`memory benchmark ${label} artifact digest does not match`);
  }
  return content;
}

function parseHarborResultArtifact(content: Uint8Array): Record<string, unknown> {
  const value = JSON.parse(Buffer.from(content).toString('utf8')) as unknown;
  const result = record(value, 'memory benchmark Harbor result artifact');
  if ('authority' in result) {
    if (!isRecord(result.authority)) {
      throw new Error('memory benchmark verifier artifact authority must be an object');
    }
    if (result.authority.source !== 'official_harbor_verifier' || result.authority.authoritative !== true) {
      throw new Error('memory benchmark verifier artifact is explicitly non-authoritative');
    }
  }
  const direct = finiteNumber(result.reward) || finiteNumber(result.score);
  const metrics = isRecord(result.metrics) && (finiteNumber(result.metrics.reward) || finiteNumber(result.metrics.score));
  const verifierResult = isRecord(result.verifier_result) ? result.verifier_result : undefined;
  const rewards = verifierResult && isRecord(verifierResult.rewards) ? verifierResult.rewards : undefined;
  const nested = rewards && (finiteNumber(rewards.reward) || finiteNumber(rewards.score));
  if (!direct && !metrics && !nested) {
    throw new Error('memory benchmark verifier artifact must contain a Harbor reward or score');
  }
  return result;
}

function finiteNumber(value: unknown): boolean {
  return typeof value === 'number' && Number.isFinite(value);
}

function isNodeError(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && (error as { code?: unknown }).code === code;
}
