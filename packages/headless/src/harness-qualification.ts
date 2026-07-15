import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { FixedPromptTask } from './fixed-prompt-controller.js';
import { publishImmutableFile } from './immutable-file.js';

export interface HarnessOracleTaskResult {
  outcome: 'passed' | 'failed' | 'candidate_timeout';
  reward: number;
  attempts: number;
}

export interface HarnessOracleQualificationEvidence {
  schemaVersion: 1;
  taskSourceFingerprint: string;
  verifierPolicyFingerprint: string;
  targetCount: number;
  candidateTaskIds: string[];
  selectedTaskIds: string[];
  candidates: Array<HarnessOracleTaskResult & { taskId: string }>;
  fingerprint: string;
}

export interface QualifyHarnessTasksInput {
  candidateTasks: readonly FixedPromptTask[];
  targetCount: number;
  taskSourceFingerprint: string;
  verifierPolicy: {
    fingerprint: string;
    maxAttempts: number;
  };
  runOracle: (task: FixedPromptTask) => Promise<HarnessOracleTaskResult>;
}

export async function qualifyHarnessTasks(
  input: QualifyHarnessTasksInput,
): Promise<HarnessOracleQualificationEvidence> {
  assertQualificationInput(input);
  const candidates: HarnessOracleQualificationEvidence['candidates'] = [];
  const selectedTaskIds: string[] = [];
  for (const task of input.candidateTasks) {
    const result = await input.runOracle(task);
    candidates.push({ taskId: task.id, ...result });
    if (result.outcome === 'passed' && result.reward > 0) selectedTaskIds.push(task.id);
    if (selectedTaskIds.length === input.targetCount) break;
  }
  if (selectedTaskIds.length !== input.targetCount) {
    throw new Error(
      `only ${selectedTaskIds.length} of ${input.targetCount} tasks passed Oracle qualification in the frozen candidate pool`,
    );
  }
  return withFingerprint({
    schemaVersion: 1 as const,
    taskSourceFingerprint: input.taskSourceFingerprint,
    verifierPolicyFingerprint: input.verifierPolicy.fingerprint,
    targetCount: input.targetCount,
    candidateTaskIds: input.candidateTasks.map((task) => task.id),
    selectedTaskIds,
    candidates,
  });
}

export async function ensureHarnessOracleQualification(
  path: string,
  input: QualifyHarnessTasksInput,
): Promise<HarnessOracleQualificationEvidence> {
  const existing = await readEvidence(path);
  if (existing) return validateEvidence(existing, input);
  const evidence = await qualifyHarnessTasks(input);
  if (await publishImmutableFile(path, `${JSON.stringify(evidence, null, 2)}\n`)) return evidence;
  const concurrent = await readEvidence(path);
  if (!concurrent) throw new Error('concurrent Oracle qualification evidence disappeared after publication');
  return validateEvidence(concurrent, input);
}

function assertQualificationInput(input: QualifyHarnessTasksInput): void {
  if (!Number.isSafeInteger(input.targetCount) || input.targetCount < 1) {
    throw new Error('qualification targetCount must be a positive integer');
  }
  if (!Number.isSafeInteger(input.verifierPolicy.maxAttempts) || input.verifierPolicy.maxAttempts < 1) {
    throw new Error('qualification verifier maxAttempts must be a positive integer');
  }
  const ids = input.candidateTasks.map((task) => task.id);
  if (new Set(ids).size !== ids.length) throw new Error('qualification candidate task ids must be unique');
}

function validateEvidence(value: unknown, input: QualifyHarnessTasksInput): HarnessOracleQualificationEvidence {
  if (!isRecord(value) || value.schemaVersion !== 1 || typeof value.fingerprint !== 'string') {
    throw new Error('stored Oracle qualification evidence is malformed');
  }
  const { fingerprint, ...body } = value;
  const recomputed = fingerprintValue(body);
  if (fingerprint !== recomputed) throw new Error('stored Oracle qualification evidence fingerprint is invalid');
  const expectedTaskIds = input.candidateTasks.map((task) => task.id);
  if (
    value.taskSourceFingerprint !== input.taskSourceFingerprint
    || value.verifierPolicyFingerprint !== input.verifierPolicy.fingerprint
    || value.targetCount !== input.targetCount
    || JSON.stringify(value.candidateTaskIds) !== JSON.stringify(expectedTaskIds)
  ) {
    throw new Error('stored Oracle qualification evidence does not match this run');
  }
  if (!qualificationEvidenceBodyIsValid(value, expectedTaskIds, input.targetCount, input.verifierPolicy.maxAttempts)) {
    throw new Error('stored Oracle qualification evidence is malformed');
  }
  return value as unknown as HarnessOracleQualificationEvidence;
}

function qualificationEvidenceBodyIsValid(
  value: Record<string, unknown>,
  expectedTaskIds: readonly string[],
  targetCount: number,
  maxAttempts: number,
): boolean {
  if (!Array.isArray(value.selectedTaskIds) || !Array.isArray(value.candidates)) return false;
  if (
    value.selectedTaskIds.length !== targetCount
    || value.candidates.length < targetCount
    || value.candidates.length > expectedTaskIds.length
    || value.selectedTaskIds.some((taskId) => typeof taskId !== 'string')
    || new Set(value.selectedTaskIds).size !== value.selectedTaskIds.length
  ) return false;
  const selectedFromCandidates: string[] = [];
  for (const [index, candidate] of value.candidates.entries()) {
    if (!isRecord(candidate) || candidate.taskId !== expectedTaskIds[index]) return false;
    if (
      typeof candidate.reward !== 'number'
      || !Number.isFinite(candidate.reward)
      || typeof candidate.attempts !== 'number'
      || !Number.isSafeInteger(candidate.attempts)
      || candidate.attempts < 1
      || candidate.attempts > maxAttempts
    ) return false;
    if (candidate.outcome === 'passed') {
      if (candidate.reward <= 0) return false;
      selectedFromCandidates.push(candidate.taskId as string);
    } else if (
      (candidate.outcome !== 'failed' && candidate.outcome !== 'candidate_timeout')
      || candidate.reward !== 0
    ) return false;
  }
  return JSON.stringify(value.selectedTaskIds) === JSON.stringify(selectedFromCandidates);
}

function withFingerprint<T extends Record<string, unknown>>(body: T): T & { fingerprint: string } {
  return { ...body, fingerprint: fingerprintValue(body) };
}

function fingerprintValue(value: unknown): string {
  return `sha256:${createHash('sha256').update(canonicalJson(value)).digest('hex')}`;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (isRecord(value)) {
    return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

async function readEvidence(path: string): Promise<unknown | null> {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    if (isNotFound(error)) return null;
    throw error;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNotFound(error: unknown): boolean {
  return isRecord(error) && error.code === 'ENOENT';
}
