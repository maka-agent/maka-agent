import { constants } from 'node:fs';
import { access, realpath } from 'node:fs/promises';
import { delimiter, isAbsolute, join } from 'node:path';

import {
  resolveFilesystemWorkerBundle,
  type FilesystemWorkerResourceLocation,
} from './resource-resolver.js';

export interface FilesystemWorkerLaunchSpec {
  program: string;
  args: readonly string[];
  env: Readonly<Record<string, string>>;
  runtimeReadableRoots: readonly string[];
  executableRoots: readonly string[];
  grepExecutable?: string;
}

export type FilesystemWorkerLaunchSpecResult =
  | { ok: true; spec: FilesystemWorkerLaunchSpec }
  | {
      ok: false;
      reason: 'worker_bundle_unavailable' | 'runtime_executable_unavailable';
      message: string;
    };

export type FilesystemWorkerLaunchSpecProvider = () => Promise<FilesystemWorkerLaunchSpecResult>;

export interface CreateFilesystemWorkerLaunchSpecProviderInput {
  runtime: 'node' | 'electron';
  executable?: string;
  resourceLocation: FilesystemWorkerResourceLocation;
  hostEnv?: NodeJS.ProcessEnv;
  rgCandidates?: readonly string[];
  tmpdir?: string;
}

export function createFilesystemWorkerLaunchSpecProvider(
  input: CreateFilesystemWorkerLaunchSpecProviderInput,
): FilesystemWorkerLaunchSpecProvider {
  let cached: Promise<FilesystemWorkerLaunchSpecResult> | undefined;
  return () => {
    cached ??= resolveLaunchSpec(input);
    return cached;
  };
}

export function buildFilesystemWorkerEnv(
  runtime: 'node' | 'electron',
  hostEnv: NodeJS.ProcessEnv = process.env,
  controlledTmpdir = '/tmp',
): Readonly<Record<string, string>> {
  const env: Record<string, string> = { TMPDIR: controlledTmpdir };
  for (const key of ['LANG', 'LC_ALL', 'LC_CTYPE'] as const) {
    const value = hostEnv[key];
    if (value) env[key] = value;
  }
  if (runtime === 'electron') env.ELECTRON_RUN_AS_NODE = '1';
  return env;
}

async function resolveLaunchSpec(
  input: CreateFilesystemWorkerLaunchSpecProviderInput,
): Promise<FilesystemWorkerLaunchSpecResult> {
  const bundle = await resolveFilesystemWorkerBundle(input.resourceLocation);
  if (!bundle.ok) {
    return {
      ok: false,
      reason: 'worker_bundle_unavailable',
      message: `Filesystem worker bundle is unavailable (${bundle.reason}).`,
    };
  }

  const program = await resolveExecutable(input.executable ?? process.execPath);
  if (!program) {
    return {
      ok: false,
      reason: 'runtime_executable_unavailable',
      message: 'Filesystem worker runtime executable is unavailable.',
    };
  }

  const grepExecutable = await resolveRipgrepExecutable(
    input.rgCandidates ?? defaultRipgrepCandidates(input.hostEnv ?? process.env),
  );
  const args = [
    bundle.path,
    ...(grepExecutable ? ['--grep-executable', grepExecutable] : []),
  ];
  return {
    ok: true,
    spec: {
      program,
      args,
      env: buildFilesystemWorkerEnv(input.runtime, input.hostEnv, input.tmpdir),
      runtimeReadableRoots: [bundle.path],
      executableRoots: [program, ...(grepExecutable ? [grepExecutable] : [])],
      ...(grepExecutable ? { grepExecutable } : {}),
    },
  };
}

async function resolveRipgrepExecutable(candidates: readonly string[]): Promise<string | undefined> {
  for (const candidate of candidates) {
    const executable = await resolveExecutable(candidate);
    if (executable) return executable;
  }
  return undefined;
}

async function resolveExecutable(candidate: string): Promise<string | undefined> {
  if (!candidate || !isAbsolute(candidate)) return undefined;
  try {
    await access(candidate, constants.X_OK);
    return await realpath(candidate);
  } catch {
    return undefined;
  }
}

function defaultRipgrepCandidates(env: NodeJS.ProcessEnv): readonly string[] {
  const fromPath = (env.PATH ?? '')
    .split(delimiter)
    .filter(Boolean)
    .map((directory) => join(directory, 'rg'));
  return [...fromPath, '/opt/homebrew/bin/rg', '/usr/local/bin/rg', '/usr/bin/rg'];
}
