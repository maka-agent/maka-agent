import { constants } from 'node:fs';
import { access, realpath } from 'node:fs/promises';
import { delimiter, dirname, isAbsolute, join, resolve } from 'node:path';

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
  return () => (cached ??= resolveLaunchSpec(input));
}

export function buildFilesystemWorkerEnv(
  runtime: 'node' | 'electron',
  hostEnv: NodeJS.ProcessEnv = process.env,
  controlledTmpdir = '/tmp',
): Readonly<Record<string, string>> {
  const env: Record<string, string> = { TMPDIR: controlledTmpdir, OPENSSL_CONF: '/dev/null' };
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
      message: 'Filesystem worker runtime is unavailable.',
    };
  }
  const runtimeRoot = await resolveReadableRoot(resolve(dirname(program), '..'));
  if (!runtimeRoot) {
    return {
      ok: false,
      reason: 'runtime_executable_unavailable',
      message: 'Filesystem worker runtime root is unavailable.',
    };
  }
  const dependencyRoots = await resolveRuntimeDependencyRoots(program);
  const grepExecutable = await resolveRipgrepExecutable(
    input.rgCandidates ?? defaultRipgrepCandidates(input.hostEnv ?? process.env),
  );
  const electronFrameworks =
    input.runtime === 'electron'
      ? await resolveReadableRoot(resolve(dirname(program), '..', 'Frameworks'))
      : undefined;
  if (input.runtime === 'electron' && !electronFrameworks) {
    return {
      ok: false,
      reason: 'runtime_executable_unavailable',
      message: 'Electron framework roots are unavailable.',
    };
  }
  return {
    ok: true,
    spec: {
      program,
      args: [bundle.path, ...(grepExecutable ? ['--grep-executable', grepExecutable] : [])],
      env: buildFilesystemWorkerEnv(input.runtime, input.hostEnv, input.tmpdir),
      runtimeReadableRoots: unique([bundle.path, runtimeRoot, ...dependencyRoots]),
      executableRoots: unique([
        program,
        runtimeRoot,
        ...(electronFrameworks ? [electronFrameworks] : []),
        ...dependencyRoots,
        ...(grepExecutable ? [grepExecutable] : []),
      ]),
    },
  };
}

async function resolveRipgrepExecutable(
  candidates: readonly string[],
): Promise<string | undefined> {
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

async function resolveReadableRoot(candidate: string): Promise<string | undefined> {
  try {
    return await realpath(candidate);
  } catch {
    return undefined;
  }
}

function defaultRipgrepCandidates(env: NodeJS.ProcessEnv): readonly string[] {
  return [
    ...(env.PATH ?? '')
      .split(delimiter)
      .filter(Boolean)
      .map((directory) => join(directory, 'rg')),
    '/opt/homebrew/bin/rg',
    '/usr/local/bin/rg',
    '/usr/bin/rg',
  ];
}

async function resolveRuntimeDependencyRoots(program: string): Promise<readonly string[]> {
  const candidates = program.startsWith('/opt/homebrew/')
    ? ['/opt/homebrew/opt', '/opt/homebrew/Cellar']
    : program.startsWith('/usr/local/')
      ? ['/usr/local/opt', '/usr/local/Cellar']
      : [];
  const roots = await Promise.all(candidates.map(resolveReadableRoot));
  return roots.filter((root): root is string => root !== undefined);
}

function unique(values: readonly string[]): readonly string[] {
  return [...new Set(values)];
}
