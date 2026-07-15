import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { FixedPromptTask } from './fixed-prompt-controller.js';

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
  verifierPolicyFingerprint: string;
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
    verifierPolicyFingerprint: input.verifierPolicyFingerprint,
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
  await mkdir(dirname(path), { recursive: true });
  try {
    await writeFile(path, `${JSON.stringify(evidence, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
    return evidence;
  } catch (error) {
    if (!isAlreadyExists(error)) throw error;
    const concurrent = await readEvidence(path);
    if (!concurrent) throw error;
    return validateEvidence(concurrent, input);
  }
}

function assertQualificationInput(input: QualifyHarnessTasksInput): void {
  if (!Number.isSafeInteger(input.targetCount) || input.targetCount < 1) {
    throw new Error('qualification targetCount must be a positive integer');
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
    || value.verifierPolicyFingerprint !== input.verifierPolicyFingerprint
    || value.targetCount !== input.targetCount
    || JSON.stringify(value.candidateTaskIds) !== JSON.stringify(expectedTaskIds)
  ) {
    throw new Error('stored Oracle qualification evidence does not match this run');
  }
  return value as unknown as HarnessOracleQualificationEvidence;
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

function isAlreadyExists(error: unknown): boolean {
  return isRecord(error) && error.code === 'EEXIST';
}
