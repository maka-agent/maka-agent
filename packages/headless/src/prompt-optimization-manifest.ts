import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, readFile, readdir, readlink, stat, writeFile } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { promisify } from 'node:util';
import type { FixedPromptTask } from './fixed-prompt-controller.js';
import type { PromptOptimizationProfileName } from './prompt-optimization-profile.js';
import { buildRunManifestFingerprint, ensureAbRunManifest } from './ab-manifest.js';

const execFileAsync = promisify(execFile);

export interface PromptOptimizationRunManifest {
  schemaVersion: 'maka.prompt_optimization.run_manifest.v1';
  runId: string;
  profile: PromptOptimizationProfileName;
  provider: string;
  baseUrl: string;
  model: string;
  rounds: number;
  baselineRuns: number;
  zScore: number;
  costCeilingUsd: number | undefined;
  maxConcurrency: number | null;
  maxInfraFailureRate: number | null;
  maxStableTaskDurationMs: number | null;
  minStableRatio: number | undefined;
  minStableHeldInTasks: number;
  minStableHeldOutTasks: number;
  runtimeProfile: unknown;
  subjectFingerprint: string;
  taskSourceFingerprint: string;
  toolchainFingerprint: string;
  heldInTaskIds: string[];
  heldOutTaskIds: string[];
  heldOutNoPatternTaskIds: string[];
  samplingBaseline: PromptOptimizationSamplingBaselineManifest;
  fingerprint: string;
}

export interface PromptOptimizationSamplingBaselineManifest {
  enabled: true;
  armId: 'sampling-baseline';
  taskSet: 'stable-held-in';
  budgetBasis: 'candidate-held-in';
  execution: 'parallel';
  primaryMetric: 'pass@1';
}

export interface PromptOptimizationRunManifestInput {
  runId: string;
  profile: PromptOptimizationProfileName;
  provider: string;
  baseUrl: string;
  model: string;
  rounds: number;
  baselineRuns: number;
  zScore: number;
  costCeilingUsd?: number;
  maxConcurrency?: number;
  maxInfraFailureRate?: number | null;
  maxStableTaskDurationMs?: number | null;
  minStableRatio?: number;
  minStableHeldInTasks: number;
  minStableHeldOutTasks: number;
  runtimeProfile: unknown;
  subjectFingerprint: string;
  taskSourceFingerprint: string;
  toolchainFingerprint: string;
  heldInTasks: readonly FixedPromptTask[];
  heldOutTasks: readonly FixedPromptTask[];
  heldOutNoPattern: readonly FixedPromptTask[];
}

interface TaskDirectoryEntry {
  path: string;
  type: 'directory' | 'file' | 'other';
  executable?: boolean;
  hash?: string;
}

export function buildPromptOptimizationRunManifest(
  input: PromptOptimizationRunManifestInput,
): PromptOptimizationRunManifest {
  const manifestWithoutFingerprint = withoutUndefined({
    schemaVersion: 'maka.prompt_optimization.run_manifest.v1' as const,
    runId: input.runId,
    profile: input.profile,
    provider: input.provider,
    baseUrl: input.baseUrl,
    model: input.model,
    rounds: input.rounds,
    baselineRuns: input.baselineRuns,
    zScore: input.zScore,
    costCeilingUsd: input.costCeilingUsd,
    maxConcurrency: input.maxConcurrency ?? null,
    maxInfraFailureRate: input.maxInfraFailureRate ?? null,
    maxStableTaskDurationMs: input.maxStableTaskDurationMs ?? null,
    minStableRatio: input.minStableRatio,
    minStableHeldInTasks: input.minStableHeldInTasks,
    minStableHeldOutTasks: input.minStableHeldOutTasks,
    runtimeProfile: input.runtimeProfile,
    subjectFingerprint: input.subjectFingerprint,
    taskSourceFingerprint: input.taskSourceFingerprint,
    toolchainFingerprint: input.toolchainFingerprint,
    heldInTaskIds: input.heldInTasks.map((task) => task.id),
    heldOutTaskIds: input.heldOutTasks.map((task) => task.id),
    heldOutNoPatternTaskIds: input.heldOutNoPattern.map((task) => task.id),
    samplingBaseline: {
      enabled: true,
      armId: 'sampling-baseline',
      taskSet: 'stable-held-in',
      budgetBasis: 'candidate-held-in',
      execution: 'parallel',
      primaryMetric: 'pass@1',
    } as const,
  });
  const { costCeilingUsd: _costCeilingUsd, ...fingerprintPayload } = manifestWithoutFingerprint;
  return {
    ...manifestWithoutFingerprint,
    fingerprint: buildRunManifestFingerprint(fingerprintPayload),
  };
}

export async function ensurePromptOptimizationRunManifest(
  path: string,
  manifest: PromptOptimizationRunManifest,
  runRoot: string,
): Promise<PromptOptimizationRunManifest> {
  if (!(await pathExists(path))) {
    const legacyArtifacts = [
      join(runRoot, 'controller', 'results.jsonl'),
      join(runRoot, 'prompt-repo'),
    ];
    const existing = [];
    for (const artifactPath of legacyArtifacts) {
      if (await pathExists(artifactPath)) existing.push(artifactPath);
    }
    if (existing.length > 0) {
      throw new Error(
        `prompt optimization run root already has artifacts but no prompt-optimization-manifest.json: ${existing.join(', ')}. Use a new MAKA_PROMPT_RUN_ID or move the legacy artifacts aside.`,
      );
    }
  }
  const migrated = await migrateLegacyPromptOptimizationManifest(path, manifest);
  if (migrated) return migrated;
  const legacyResumed = await resumeMigratedPromptOptimizationManifest(path, manifest);
  if (legacyResumed) return legacyResumed;
  try {
    const ensured = await ensureAbRunManifest(path, manifest);
    if (ensured.costCeilingUsd !== manifest.costCeilingUsd) {
      await writeFile(path, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
      return manifest;
    }
    return ensured;
  } catch (error) {
    if (
      error instanceof Error &&
      error.message.startsWith('A/B run manifest does not match existing run id:')
    ) {
      throw new Error(
        error.message.replace(
          'A/B run manifest does not match existing run id:',
          'prompt optimization run manifest does not match existing run id:',
        ),
      );
    }
    throw error;
  }
}

async function migrateLegacyPromptOptimizationManifest(
  path: string,
  manifest: PromptOptimizationRunManifest,
): Promise<PromptOptimizationRunManifest | undefined> {
  let existing: unknown;
  try {
    existing = JSON.parse(await readFile(path, 'utf8')) as unknown;
  } catch (error) {
    if (isNotFound(error)) return undefined;
    throw error;
  }
  if (
    typeof existing !== 'object' ||
    existing === null ||
    (existing as { schemaVersion?: unknown }).schemaVersion !==
      'maka.prompt_optimization.run_manifest.v1' ||
    'samplingBaseline' in existing
  ) {
    return undefined;
  }
  const existingFingerprint = (existing as { fingerprint?: unknown }).fingerprint;
  const {
    costCeilingUsd: _costCeilingUsd,
    fingerprint: _fingerprint,
    samplingBaseline: _sampling,
    ...legacyPayload
  } = manifest;
  if (
    existingFingerprint !== buildRunManifestFingerprint(legacyPayload) ||
    typeof existingFingerprint !== 'string'
  ) {
    return undefined;
  }
  // Existing WAL task events carry the legacy fingerprint. Add the immutable
  // sampling contract without changing that identity, otherwise resume fails
  // closed before it can consume the old evidence.
  const migrated = { ...manifest, fingerprint: existingFingerprint };
  await writeFile(path, `${JSON.stringify(migrated, null, 2)}\n`, 'utf8');
  return migrated;
}

async function resumeMigratedPromptOptimizationManifest(
  path: string,
  manifest: PromptOptimizationRunManifest,
): Promise<PromptOptimizationRunManifest | undefined> {
  let existing: unknown;
  try {
    existing = JSON.parse(await readFile(path, 'utf8')) as unknown;
  } catch (error) {
    if (isNotFound(error)) return undefined;
    throw error;
  }
  if (
    typeof existing !== 'object' ||
    existing === null ||
    (existing as { schemaVersion?: unknown }).schemaVersion !==
      'maka.prompt_optimization.run_manifest.v1' ||
    !('samplingBaseline' in existing)
  ) {
    return undefined;
  }
  const existingFingerprint = (existing as { fingerprint?: unknown }).fingerprint;
  if (typeof existingFingerprint !== 'string') return undefined;
  const {
    costCeilingUsd: _costCeilingUsd,
    fingerprint: _fingerprint,
    samplingBaseline: _sampling,
    ...legacyPayload
  } = manifest;
  if (existingFingerprint !== buildRunManifestFingerprint(legacyPayload)) return undefined;
  if (
    JSON.stringify((existing as { samplingBaseline?: unknown }).samplingBaseline) !==
    JSON.stringify(manifest.samplingBaseline)
  ) {
    return undefined;
  }
  const resumed = {
    ...(existing as PromptOptimizationRunManifest),
    costCeilingUsd: manifest.costCeilingUsd,
  };
  if ((existing as { costCeilingUsd?: unknown }).costCeilingUsd !== manifest.costCeilingUsd) {
    await writeFile(path, `${JSON.stringify(resumed, null, 2)}\n`, 'utf8');
  }
  return resumed;
}

export async function buildPromptOptimizationSubjectFingerprint(repoPath: string): Promise<string> {
  const [gitRoot, head, status] = await Promise.all([
    gitOutput(repoPath, 'rev-parse', '--show-toplevel'),
    gitOutput(repoPath, 'rev-parse', 'HEAD'),
    gitOutput(repoPath, 'status', '--porcelain=v1', '--untracked-files=normal'),
  ]);
  if (status.length > 0) {
    throw new Error(
      `MAKA_PROMPT_MAKA_REPO must be clean for resume-safe prompt optimization runs. Commit/stash the changes before running. Dirty git status:\n${status}`,
    );
  }
  return buildRunManifestFingerprint({
    kind: 'prompt-optimization-subject',
    repoPath: resolve(repoPath),
    gitRoot: resolve(gitRoot),
    head,
    dirty: false,
    runtimeArtifactFingerprint: await buildPromptOptimizationRuntimeArtifactFingerprint(gitRoot),
  });
}

export async function buildPromptOptimizationToolchainFingerprint(
  repoRoot: string,
): Promise<string> {
  const [gitRoot, head, status] = await Promise.all([
    gitOutput(repoRoot, 'rev-parse', '--show-toplevel'),
    gitOutput(repoRoot, 'rev-parse', 'HEAD'),
    gitOutput(repoRoot, 'status', '--porcelain=v1', '--untracked-files=normal'),
  ]);
  if (status.length > 0) {
    throw new Error(
      `execution checkout must be clean for resume-safe prompt optimization runs. Commit/stash the changes before running. Dirty git status:\n${status}`,
    );
  }
  return buildRunManifestFingerprint({
    kind: 'prompt-optimization-toolchain',
    repoRoot: resolve(repoRoot),
    gitRoot: resolve(gitRoot),
    head,
    node: process.version,
    runtimeArtifactFingerprint: await buildPromptOptimizationRuntimeArtifactFingerprint(gitRoot),
  });
}

async function buildPromptOptimizationRuntimeArtifactFingerprint(
  repoRoot: string,
): Promise<string> {
  const artifactRoots = [
    'packages/headless/dist',
    'packages/core/dist',
    'packages/runtime/dist',
    'packages/storage/dist',
  ];
  return buildRunManifestFingerprint({
    kind: 'prompt-optimization-runtime-artifacts',
    artifacts: await Promise.all(
      artifactRoots.map(async (artifactPath) => ({
        path: artifactPath,
        entries: await hashOptionalDirectory(join(repoRoot, artifactPath)),
      })),
    ),
  });
}

export async function buildPromptOptimizationTaskSourceFingerprint(
  tasksRoot: string,
  heldInTasks: readonly FixedPromptTask[],
  heldOutTasks: readonly FixedPromptTask[],
): Promise<string> {
  const taskPayload = async (task: FixedPromptTask) => ({
    id: task.id,
    path: resolve(task.path),
    metadata: task.metadata ?? null,
    entries: await hashTaskDirectory(task.path),
  });
  return buildRunManifestFingerprint({
    kind: 'prompt-optimization-task-source',
    tasksRoot: resolve(tasksRoot),
    heldInTasks: await Promise.all(heldInTasks.map(taskPayload)),
    heldOutTasks: await Promise.all(heldOutTasks.map(taskPayload)),
  });
}

async function gitOutput(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, {
    cwd,
    encoding: 'utf8',
    maxBuffer: 1024 * 1024,
  });
  return stdout.trimEnd();
}

async function hashTaskDirectory(taskPath: string): Promise<TaskDirectoryEntry[]> {
  const root = resolve(taskPath);
  const entries: TaskDirectoryEntry[] = [];
  await walkTaskDirectory(root, root, entries);
  return entries;
}

async function walkTaskDirectory(
  root: string,
  dir: string,
  entries: TaskDirectoryEntry[],
): Promise<void> {
  const children = await readdir(dir, { withFileTypes: true });
  children.sort((a, b) => a.name.localeCompare(b.name));
  for (const child of children) {
    const path = join(dir, child.name);
    const stats = await lstat(path);
    const entryPath = relative(root, path).split('\\').join('/');
    if (child.isDirectory()) {
      entries.push({ path: entryPath, type: 'directory' });
      await walkTaskDirectory(root, path, entries);
    } else if (child.isSymbolicLink()) {
      throw new Error(
        `task source symlink is not supported in prompt optimization fingerprints: ${entryPath} -> ${await readlink(path)}`,
      );
    } else if (child.isFile()) {
      entries.push({
        path: entryPath,
        type: 'file',
        executable: (stats.mode & 0o111) !== 0,
        hash: hashBytes(await readFile(path)),
      });
    } else {
      entries.push({ path: entryPath, type: 'other' });
    }
  }
}

async function hashOptionalDirectory(path: string): Promise<TaskDirectoryEntry[]> {
  try {
    return await hashTaskDirectory(path);
  } catch (error) {
    if (isNotFound(error)) return [{ path: '.', type: 'other' }];
    throw error;
  }
}

function hashBytes(bytes: Buffer): string {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (isNotFound(error)) return false;
    throw error;
  }
}

function isNotFound(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 'ENOENT'
  );
}

function withoutUndefined<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(
    Object.entries(value).filter(([, entryValue]) => entryValue !== undefined),
  ) as T;
}
