import { createHash } from 'node:crypto';
import type { FixedPromptTask } from './fixed-prompt-controller.js';
import type { HarnessOracleTaskResult } from './harness-qualification.js';

export class HarnessOracleAuditExecutionError extends Error {
  constructor(readonly status: 'timed_out' | 'infra_failed') {
    super(`Oracle audit execution ${status}`);
    this.name = 'HarnessOracleAuditExecutionError';
  }
}

export interface HarnessOracleQualificationIdentity {
  taskFingerprint: string;
  verifierPolicyFingerprint: string;
  environmentFingerprint: string;
  runtimeFingerprint: string;
}

export interface HarnessOracleRegistryEntry {
  schemaVersion: 1;
  taskId: string;
  qualificationKey: string;
  identity: HarnessOracleQualificationIdentity;
  execution: {
    status: 'completed' | 'timed_out' | 'infra_failed';
  };
  oracle: HarnessOracleTaskResult | null;
  fingerprint: string;
}

export interface HarnessOracleRegistrySnapshot {
  schemaVersion: 1;
  taskIds: string[];
  entries: HarnessOracleRegistryEntry[];
  provenance: {
    issuer: 'github-actions';
    repository: string;
    runId: string;
  };
  fingerprint: string;
}

export interface HarnessOracleAuditTask {
  task: FixedPromptTask;
  identity: HarnessOracleQualificationIdentity;
}

export interface AuditHarnessOracleRegistryInput {
  tasks: readonly HarnessOracleAuditTask[];
  existingSnapshot?: HarnessOracleRegistrySnapshot;
  provenance: HarnessOracleRegistrySnapshot['provenance'];
  runOracle: (task: FixedPromptTask) => Promise<HarnessOracleTaskResult>;
}

export interface HarnessOracleAuditResult {
  snapshot: HarnessOracleRegistrySnapshot;
  executedTaskIds: string[];
}

export type HarnessOracleAnnotationState =
  | 'missing'
  | 'stale'
  | 'passed'
  | 'failed'
  | 'timed_out'
  | 'infra_failed';

export interface HarnessOracleAnnotation {
  taskId: string;
  state: HarnessOracleAnnotationState;
  qualificationKey: string;
  evidenceFingerprint?: string;
}

export async function auditHarnessOracleRegistry(
  input: AuditHarnessOracleRegistryInput,
): Promise<HarnessOracleAuditResult> {
  if (input.existingSnapshot) assertSnapshotFingerprint(input.existingSnapshot);
  const existingByKey = new Map(
    (input.existingSnapshot?.entries ?? []).map((entry) => [entry.qualificationKey, entry]),
  );
  const entries: HarnessOracleRegistryEntry[] = [];
  const executedTaskIds: string[] = [];
  for (const { task, identity } of input.tasks) {
    const qualificationKey = qualificationKeyFor(task.id, identity);
    const existing = existingByKey.get(qualificationKey);
    if (existing) {
      entries.push(existing);
      continue;
    }
    executedTaskIds.push(task.id);
    let execution: HarnessOracleRegistryEntry['execution'];
    let oracle: HarnessOracleTaskResult | null;
    try {
      oracle = await input.runOracle(task);
      execution = { status: 'completed' };
    } catch (error) {
      oracle = null;
      execution = {
        status: error instanceof HarnessOracleAuditExecutionError ? error.status : 'infra_failed',
      };
    }
    entries.push(withFingerprint({
      schemaVersion: 1 as const,
      taskId: task.id,
      qualificationKey,
      identity: { ...identity },
      execution,
      oracle,
    }));
  }
  const snapshot = withFingerprint({
    schemaVersion: 1 as const,
    taskIds: input.tasks.map(({ task }) => task.id),
    entries,
    provenance: { ...input.provenance },
  });
  return { snapshot, executedTaskIds };
}

export function resolveHarnessOracleAnnotations(
  tasks: readonly HarnessOracleAuditTask[],
  snapshot: HarnessOracleRegistrySnapshot | null,
): HarnessOracleAnnotation[] {
  if (snapshot) assertSnapshotFingerprint(snapshot);
  const entriesByTaskId = new Map((snapshot?.entries ?? []).map((entry) => [entry.taskId, entry]));
  return tasks.map(({ task, identity }) => {
    const qualificationKey = qualificationKeyFor(task.id, identity);
    const entry = entriesByTaskId.get(task.id);
    if (!entry) return { taskId: task.id, state: 'missing', qualificationKey };
    if (entry.qualificationKey !== qualificationKey) {
      return { taskId: task.id, state: 'stale', qualificationKey, evidenceFingerprint: entry.fingerprint };
    }
    return {
      taskId: task.id,
      state: annotationState(entry),
      qualificationKey,
      evidenceFingerprint: entry.fingerprint,
    };
  });
}

function annotationState(entry: HarnessOracleRegistryEntry): HarnessOracleAnnotationState {
  if (entry.execution.status === 'timed_out') return 'timed_out';
  if (entry.execution.status === 'infra_failed') return 'infra_failed';
  if (entry.oracle?.outcome === 'passed') return 'passed';
  if (entry.oracle?.outcome === 'candidate_timeout') return 'timed_out';
  return 'failed';
}

function qualificationKeyFor(taskId: string, identity: HarnessOracleQualificationIdentity): string {
  return fingerprintValue({ schemaVersion: 1, taskId, identity });
}

function assertSnapshotFingerprint(snapshot: HarnessOracleRegistrySnapshot): void {
  const { fingerprint, ...body } = snapshot;
  if (fingerprint !== fingerprintValue(body)) {
    throw new Error('Oracle registry snapshot fingerprint is invalid');
  }
  if (
    snapshot.schemaVersion !== 1
    || new Set(snapshot.taskIds).size !== snapshot.taskIds.length
    || snapshot.entries.length !== snapshot.taskIds.length
    || snapshot.entries.some((entry, index) => !registryEntryIsValid(entry, snapshot.taskIds[index]))
  ) {
    throw new Error('Oracle registry entry is malformed');
  }
}

function registryEntryIsValid(entry: HarnessOracleRegistryEntry, expectedTaskId: string | undefined): boolean {
  if (
    entry.schemaVersion !== 1
    || entry.taskId !== expectedTaskId
    || entry.fingerprint !== fingerprintValue(withoutFingerprint(entry))
    || entry.qualificationKey !== qualificationKeyFor(entry.taskId, entry.identity)
    || !qualificationIdentityIsValid(entry.identity)
  ) return false;
  if (entry.execution.status !== 'completed') {
    return (entry.execution.status === 'timed_out' || entry.execution.status === 'infra_failed')
      && entry.oracle === null;
  }
  const oracle = entry.oracle;
  if (
    oracle === null
    || !Number.isSafeInteger(oracle.attempts)
    || oracle.attempts < 1
    || !Number.isFinite(oracle.reward)
  ) return false;
  if (oracle.outcome === 'passed') return oracle.reward > 0;
  return (oracle.outcome === 'failed' || oracle.outcome === 'candidate_timeout') && oracle.reward === 0;
}

function qualificationIdentityIsValid(identity: HarnessOracleQualificationIdentity): boolean {
  return [
    identity.taskFingerprint,
    identity.verifierPolicyFingerprint,
    identity.environmentFingerprint,
    identity.runtimeFingerprint,
  ].every((value) => typeof value === 'string' && value.length > 0);
}

function withoutFingerprint<T extends { fingerprint: string }>(value: T): Omit<T, 'fingerprint'> {
  const { fingerprint: _fingerprint, ...body } = value;
  return body;
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
