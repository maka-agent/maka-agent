import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type {
  PromptAbRunManifest,
  PromptAbRunManifestInput,
} from './prompt-ab-types.js';

export function buildPromptAbRunManifest(input: PromptAbRunManifestInput): PromptAbRunManifest {
  const manifestWithoutFingerprint = withoutUndefined({
    schemaVersion: 'maka.prompt_ab.run_manifest.v1' as const,
    baselinePromptHash: input.baselinePromptHash,
    candidatePromptHash: input.candidatePromptHash,
    provider: input.provider,
    baseUrl: input.baseUrl,
    model: input.model,
    taskBudgetSec: input.taskBudgetSec,
    harborTimeoutMs: input.harborTimeoutMs,
    subjectFingerprint: input.subjectFingerprint,
    taskSourceFingerprint: input.taskSourceFingerprint,
    toolchainFingerprint: input.toolchainFingerprint,
    evaluationTaskIds: [...input.evaluationTaskIds],
    reps: input.reps,
    candidateLimit: input.candidateLimit,
    maxConcurrency: input.maxConcurrency,
    selectionMode: input.selectionMode,
    candidateTaskIds: input.candidateTaskIds ? [...input.candidateTaskIds] : undefined,
    maxExpertTimeEstimateMin: input.maxExpertTimeEstimateMin,
    targetEvaluationTaskCount: input.targetEvaluationTaskCount,
  });
  return {
    ...manifestWithoutFingerprint,
    fingerprint: `sha256:${createHash('sha256').update(canonicalJson(manifestWithoutFingerprint)).digest('hex')}`,
  };
}

export async function ensurePromptAbRunManifest(
  path: string,
  manifest: PromptAbRunManifest,
): Promise<PromptAbRunManifest> {
  let raw: string | undefined;
  try {
    raw = await readFile(path, 'utf8');
  } catch (error) {
    if (!isNotFound(error)) throw error;
  }
  if (raw === undefined) {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
    return manifest;
  }
  const existing = JSON.parse(raw) as PromptAbRunManifest;
  if (existing.fingerprint !== manifest.fingerprint) {
    throw new Error(
      `prompt A/B run manifest does not match existing run id: existing ${existing.fingerprint ?? 'missing'}, current ${manifest.fingerprint}. Use a new MAKA_PROMPT_AB_RUN_ID or restore the original run config.`,
    );
  }
  return existing;
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
