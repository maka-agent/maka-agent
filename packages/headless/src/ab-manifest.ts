import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type {
  AbRunManifest,
  AbRunManifestInput,
} from './ab-types.js';

export function buildAbRunManifest(input: AbRunManifestInput): AbRunManifest {
  const manifestWithoutFingerprint = withoutUndefined({
    schemaVersion: 'maka.ab.run_manifest.v1' as const,
    experimentKind: input.experimentKind,
    metadata: input.metadata,
    arms: input.arms.map((arm) => withoutUndefined({
      id: arm.id,
      kind: arm.kind,
      fingerprint: arm.fingerprint,
      metadata: arm.metadata,
    })) as [AbRunManifest['arms'][number], AbRunManifest['arms'][number]],
    taskBudgetSec: input.taskBudgetSec,
    harborTimeoutMs: input.harborTimeoutMs,
    subjectFingerprint: input.subjectFingerprint,
    taskSourceFingerprint: input.taskSourceFingerprint,
    toolchainFingerprint: input.toolchainFingerprint,
    evaluationTaskIds: [...input.evaluationTaskIds],
    reps: input.reps,
    candidateLimit: input.candidateLimit,
    maxConcurrency: input.maxConcurrency,
    maxConcurrentAttempts: input.maxConcurrentAttempts,
    observedCostStopUsd: input.observedCostStopUsd,
    selectionMode: input.selectionMode,
    candidateTaskIds: input.candidateTaskIds ? [...input.candidateTaskIds] : undefined,
    pilotTaskIds: input.pilotTaskIds ? [...input.pilotTaskIds] : undefined,
    maxExpertTimeEstimateMin: input.maxExpertTimeEstimateMin,
    targetEvaluationTaskCount: input.targetEvaluationTaskCount,
    nonInferiorityMargin: input.nonInferiorityMargin,
  });
  return {
    ...manifestWithoutFingerprint,
    fingerprint: buildRunManifestFingerprint(manifestWithoutFingerprint),
  };
}

export function buildRunManifestFingerprint(value: unknown): string {
  return `sha256:${createHash('sha256').update(canonicalJson(value)).digest('hex')}`;
}

export async function ensureAbRunManifest(
  path: string,
  manifest: AbRunManifest,
): Promise<AbRunManifest>;
export async function ensureAbRunManifest<T extends { fingerprint: string }>(
  path: string,
  manifest: T,
): Promise<T>;
export async function ensureAbRunManifest<T extends { fingerprint: string }>(
  path: string,
  manifest: T,
): Promise<T> {
  let raw: string | undefined;
  try {
    raw = await readFile(path, 'utf8');
  } catch (error) {
    if (!isNotFound(error)) throw error;
  }
  if (raw === undefined) {
    await mkdir(dirname(path), { recursive: true });
    try {
      await writeFile(path, `${JSON.stringify(manifest, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
      return manifest;
    } catch (error) {
      if (!isAlreadyExists(error)) throw error;
      raw = await readConcurrentManifest(path);
    }
  }
  const existing = JSON.parse(raw) as T;
  if (hasFullBodyFingerprint(existing)) {
    const { fingerprint: existingFingerprint, ...existingBody } = existing;
    const recomputedFingerprint = buildRunManifestFingerprint(existingBody);
    if (existingFingerprint !== recomputedFingerprint) {
      throw new Error(
        `stored A/B run manifest fingerprint is invalid: stored ${existingFingerprint ?? 'missing'}, recomputed ${recomputedFingerprint}`,
      );
    }
  }
  if (existing.fingerprint !== manifest.fingerprint) {
    throw new Error(
      `A/B run manifest does not match existing run id: existing ${existing.fingerprint ?? 'missing'}, current ${manifest.fingerprint}. Use a new run id or restore the original run config.`,
    );
  }
  return existing;
}

function hasFullBodyFingerprint(value: unknown): value is { schemaVersion: string; fingerprint: string } {
  if (!value || typeof value !== 'object' || !('schemaVersion' in value)) return false;
  const schemaVersion = (value as { schemaVersion?: unknown }).schemaVersion;
  return schemaVersion === 'maka.ab.run_manifest.v1';
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value)
      .filter(([, entryValue]) => entryValue !== undefined)
      .sort(([a], [b]) => a.localeCompare(b));
    return `{${entries.map(([key, entryValue]) => `${JSON.stringify(key)}:${canonicalJson(entryValue)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function withoutUndefined<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, entryValue]) => entryValue !== undefined)) as T;
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

async function readConcurrentManifest(path: string): Promise<string> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 10; attempt += 1) {
    try {
      const raw = await readFile(path, 'utf8');
      JSON.parse(raw);
      return raw;
    } catch (error) {
      lastError = error;
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  }
  throw lastError;
}
