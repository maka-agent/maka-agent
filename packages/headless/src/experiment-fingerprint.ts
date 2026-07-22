/**
 * Resume-safe experiment fingerprints shared by the Harbor A/B run scripts
 * (`run-prompt-ab`, `run-harness-ab`, `run-runtime-policy-ab`). The three
 * fingerprints — subject (the maka checkout under test), toolchain (Node +
 * Harbor + installed dependency lock), and task source (the selected task
 * directories) — feed the A/B run manifest, whose fingerprint gates resume in
 * `ensureAbRunManifest`. The bytes hashed here are therefore load-bearing: any
 * change to the payload shape or `kind` tags would change every prior run's
 * resume identity. This module is a straight promotion of the helpers that used
 * to live in `run-prompt-ab.mjs`; keep it byte-identical.
 *
 * The prompt-optimization runner keeps its own, deliberately distinct
 * fingerprints in `prompt-optimization-manifest.ts` (different `kind` tags,
 * held-in/held-out task split, git-based toolchain). They are not merged here
 * because doing so would change prompt-optimization resume identity.
 */

import { execFile as execFileCallback } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, readFile, readdir, readlink } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { buildRunManifestFingerprint } from './ab-manifest.js';
import type { FixedPromptTask } from './fixed-prompt-controller.js';

const execFile = promisify(execFileCallback);

type ReadGitOutput = (repoPath: string, args: readonly string[]) => Promise<string>;
type ReadToolOutput = (command: string, args: readonly string[]) => Promise<string>;

interface TaskDirectoryEntry {
  path: string;
  type: 'directory' | 'file' | 'other' | 'missing';
  executable?: boolean;
  hash?: string;
}

function hashBytes(bytes: Buffer): string {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

/** Canonical-JSON sha256 of a payload. Identical to the A/B run manifest
 * fingerprint, reused so the two never drift. */
function hashPayload(payload: unknown): string {
  return buildRunManifestFingerprint(payload);
}

async function gitOutput(repoPath: string, args: readonly string[]): Promise<string> {
  const { stdout } = await execFile('git', ['-C', repoPath, ...args], {
    encoding: 'utf8',
    maxBuffer: 1024 * 1024,
  });
  return stdout.trimEnd();
}

function isSha256Fingerprint(value: string): boolean {
  return /^sha256:[a-f0-9]{64}$/.test(value);
}

async function toolOutput(command: string, args: readonly string[]): Promise<string> {
  const { stdout, stderr } = await execFile(command, [...args], {
    encoding: 'utf8',
    maxBuffer: 1024 * 1024,
  });
  return `${stdout}${stderr}`.trim();
}

async function buildInstalledDependencyFingerprint(
  repoPath: string,
  envPrefix: string,
): Promise<{
  packageLockPath: string;
  packageLockHash: string;
  installedPackageLockPath: string;
  installedPackageLockHash: string;
}> {
  const packageLockPath = join(repoPath, 'package-lock.json');
  const installedLockPath = join(repoPath, 'node_modules/.package-lock.json');
  let packageLock: Buffer;
  let installedLock: Buffer;
  try {
    [packageLock, installedLock] = await Promise.all([
      readFile(packageLockPath),
      readFile(installedLockPath),
    ]);
  } catch (error) {
    throw new Error(
      `A/B toolchain fingerprint requires ${packageLockPath} and ${installedLockPath}. Run npm install in ${envPrefix}_MAKA_REPO, or set ${envPrefix}_TOOLCHAIN_FINGERPRINT to an explicit sha256:<64 lowercase hex> dependency snapshot. Cause: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return {
    packageLockPath: resolve(packageLockPath),
    packageLockHash: hashBytes(packageLock),
    installedPackageLockPath: resolve(installedLockPath),
    installedPackageLockHash: hashBytes(installedLock),
  };
}

export async function buildToolchainFingerprint(
  explicitToolchainFingerprint: string | undefined,
  readToolOutput: ReadToolOutput = toolOutput,
  repoPath: string = resolve(fileURLToPath(new URL('../../..', import.meta.url))),
  envPrefix = 'MAKA_PROMPT_AB',
): Promise<string> {
  if (explicitToolchainFingerprint && explicitToolchainFingerprint.trim().length > 0) {
    const value = explicitToolchainFingerprint.trim();
    if (!isSha256Fingerprint(value)) {
      throw new Error(
        `${envPrefix}_TOOLCHAIN_FINGERPRINT must be a sha256:<64 lowercase hex> content fingerprint`,
      );
    }
    return value;
  }
  let harborVersion: string;
  try {
    harborVersion = await readToolOutput('harbor', ['--version']);
  } catch (error) {
    harborVersion = `unavailable:${error instanceof Error ? error.message : String(error)}`;
  }
  return hashPayload({
    kind: 'prompt-ab-toolchain',
    node: process.version,
    harborVersion,
    dependencyInstallFingerprint: await buildInstalledDependencyFingerprint(repoPath, envPrefix),
  });
}

export async function buildSubjectFingerprint(
  repoPath: string,
  explicitSubjectFingerprint: string | undefined,
  readGitOutput: ReadGitOutput = gitOutput,
  envPrefix = 'MAKA_PROMPT_AB',
): Promise<string> {
  if (explicitSubjectFingerprint && explicitSubjectFingerprint.trim().length > 0) {
    const value = explicitSubjectFingerprint.trim();
    if (!isSha256Fingerprint(value)) {
      throw new Error(
        `${envPrefix}_EXPLICIT_SUBJECT_FINGERPRINT must be a sha256:<64 lowercase hex> content fingerprint`,
      );
    }
    return hashPayload({
      kind: 'prompt-ab-subject',
      explicitSubjectFingerprint: value,
    });
  }
  let gitRoot: string;
  let head: string;
  let status: string;
  try {
    [gitRoot, head, status] = await Promise.all([
      readGitOutput(repoPath, ['rev-parse', '--show-toplevel']),
      readGitOutput(repoPath, ['rev-parse', 'HEAD']),
      readGitOutput(repoPath, ['status', '--porcelain=v1', '--untracked-files=normal']),
    ]);
  } catch (error) {
    throw new Error(
      `${envPrefix}_MAKA_REPO must be a git checkout or ${envPrefix}_EXPLICIT_SUBJECT_FINGERPRINT must be set: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (status.length > 0) {
    throw new Error(
      `${envPrefix}_MAKA_REPO must be clean for resume-safe A/B runs. Commit/stash the changes, or set ${envPrefix}_EXPLICIT_SUBJECT_FINGERPRINT to an explicit content fingerprint. Dirty git status:\n${status}`,
    );
  }
  return hashPayload({
    kind: 'prompt-ab-subject',
    path: resolve(repoPath),
    gitRoot: resolve(gitRoot),
    head,
    dirty: false,
    statusHash: hashPayload({ status }),
    runtimeArtifactFingerprint: await buildRuntimeArtifactFingerprint(gitRoot),
  });
}

async function buildRuntimeArtifactFingerprint(repoRoot: string): Promise<string> {
  const artifactRoots = [
    'packages/headless/dist',
    'packages/core/dist',
    'packages/runtime/dist',
    'packages/storage/dist',
  ];
  return hashPayload({
    kind: 'prompt-ab-runtime-artifacts',
    artifacts: await Promise.all(
      artifactRoots.map(async (artifactPath) => ({
        path: artifactPath,
        entries: await hashOptionalDirectory(join(repoRoot, artifactPath)),
      })),
    ),
  });
}

export async function buildTaskSourceFingerprint(
  tasksRoot: string,
  tasks: readonly Pick<FixedPromptTask, 'id' | 'path'>[],
): Promise<string> {
  const taskEntries = [];
  for (const task of tasks) {
    taskEntries.push({
      id: task.id,
      path: resolve(task.path),
      entries: await hashTaskDirectory(task.path),
    });
  }
  return hashPayload({
    kind: 'prompt-ab-task-source',
    tasksRoot: resolve(tasksRoot),
    tasks: taskEntries,
  });
}

async function hashTaskDirectory(taskPath: string): Promise<TaskDirectoryEntry[]> {
  const root = resolve(taskPath);
  return await hashDirectory(root);
}

async function hashOptionalDirectory(path: string): Promise<TaskDirectoryEntry[]> {
  try {
    return await hashDirectory(resolve(path));
  } catch (error) {
    if (isNotFound(error)) return [{ path: '.', type: 'missing' }];
    throw error;
  }
}

async function hashDirectory(root: string): Promise<TaskDirectoryEntry[]> {
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
        `task source symlink is not supported in prompt A/B fingerprints: ${entryPath} -> ${await readlink(path)}`,
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

function isNotFound(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 'ENOENT'
  );
}
