import { promises as fs } from 'node:fs';
import { exec } from 'node:child_process';
import { glob as nodeGlob } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { promisify } from 'node:util';
import type { ToolExecutionFacts } from '@maka/core/permission';
import { runShellWithBoundedTail } from './shell-exec.js';

const execAsync = promisify(exec);

export type WorkspaceIsolationKind = ToolExecutionFacts['isolation'];
export type WorkspaceWriteBackMode = ToolExecutionFacts['writeBack'];
export type WorkspaceNetworkMode = ToolExecutionFacts['network'];
export type WorkspaceSecretMode = ToolExecutionFacts['secrets'];
export type WorkspaceExecutorFacts = ToolExecutionFacts;

export const LOCAL_WORKSPACE_EXECUTOR_FACTS: WorkspaceExecutorFacts = {
  isolation: 'none',
  writesAffectHost: true,
  writeBack: 'direct',
  network: 'host',
  secrets: 'host_env',
};

export interface WorkspaceExecInput {
  command: string;
  cwd: string;
  timeoutMs: number;
  abortSignal?: AbortSignal;
  emitOutput?: (stream: 'stdout' | 'stderr', chunk: string) => void;
}

export interface WorkspaceExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  stdoutTruncated?: boolean;
  stderrTruncated?: boolean;
  timedOut: boolean;
  aborted: boolean;
}

export interface WorkspaceReadFileInput {
  cwd: string;
  path: string;
  offset?: number;
  limit?: number;
}

export interface WorkspaceReadFileResult {
  content: string;
}

export interface WorkspaceWriteFileInput {
  cwd: string;
  path: string;
  content: string;
}

export interface WorkspaceWriteFileResult {
  ok: boolean;
  path: string;
  bytes: number;
}

export interface WorkspaceResolvePathInput {
  cwd: string;
  path: string;
  label: string;
}

export interface WorkspaceResolvePathResult {
  path: string;
}

export interface WorkspaceWriteLockKeyInput {
  cwd: string;
  path: string;
}

export interface WorkspaceWriteLockKeyResult {
  key: string;
}

export interface WorkspaceGlobInput {
  cwd: string;
  pattern: string;
  limit?: number;
}

export interface WorkspaceGlobResult {
  files: string[];
}

export interface WorkspaceGrepInput {
  cwd: string;
  pattern: string;
  path: string;
  glob?: string;
  maxCountPerFile: number;
  limit: number;
  timeoutMs: number;
  abortSignal?: AbortSignal;
}

export interface WorkspaceGrepResult {
  matches: string[];
}

export interface WorkspaceExecutorFactsProvider {
  readonly facts: WorkspaceExecutorFacts;
}

export interface WorkspaceCommandExecutor {
  exec(input: WorkspaceExecInput): Promise<WorkspaceExecResult>;
}

export interface WorkspaceReadFileExecutor {
  readFile(input: WorkspaceReadFileInput): Promise<WorkspaceReadFileResult>;
}

export interface WorkspaceWriteFileExecutor {
  writeFile(input: WorkspaceWriteFileInput): Promise<WorkspaceWriteFileResult>;
}

export interface WorkspaceExistingPathResolver {
  resolveExistingPath(input: WorkspaceResolvePathInput): Promise<WorkspaceResolvePathResult>;
}

export interface WorkspaceWritablePathResolver {
  resolveWritablePath(input: WorkspaceResolvePathInput): Promise<WorkspaceResolvePathResult>;
}

export interface WorkspaceWriteLockProvider {
  writeLockKey(input: WorkspaceWriteLockKeyInput): Promise<WorkspaceWriteLockKeyResult>;
}

export interface WorkspaceGlobFilesExecutor {
  globFiles(input: WorkspaceGlobInput): Promise<WorkspaceGlobResult>;
}

export interface WorkspaceGrepFilesExecutor {
  grepFiles(input: WorkspaceGrepInput): Promise<WorkspaceGrepResult>;
}

export type WorkspaceBashExecutor = WorkspaceExecutorFactsProvider & WorkspaceCommandExecutor;

export type WorkspaceReadExecutor =
  & WorkspaceExecutorFactsProvider
  & WorkspaceExistingPathResolver
  & WorkspaceReadFileExecutor;

export type WorkspaceWriteExecutor =
  & WorkspaceExecutorFactsProvider
  & WorkspaceWritablePathResolver
  & WorkspaceWriteLockProvider
  & WorkspaceWriteFileExecutor;

export type WorkspaceEditExecutor =
  & WorkspaceExecutorFactsProvider
  & WorkspaceExistingPathResolver
  & WorkspaceWriteLockProvider
  & WorkspaceReadFileExecutor
  & WorkspaceWriteFileExecutor;

export type WorkspaceGlobExecutor =
  & WorkspaceExecutorFactsProvider
  & WorkspaceExistingPathResolver
  & WorkspaceGlobFilesExecutor;

export type WorkspaceGrepExecutor =
  & WorkspaceExecutorFactsProvider
  & WorkspaceExistingPathResolver
  & WorkspaceGrepFilesExecutor;

export type WorkspaceSearchExecutor = WorkspaceGlobExecutor & WorkspaceGrepExecutor;

export interface WorkspaceExecutor
  extends WorkspaceBashExecutor,
    WorkspaceReadExecutor,
    WorkspaceWriteExecutor,
    WorkspaceEditExecutor,
    WorkspaceGlobExecutor,
    WorkspaceGrepExecutor {}

export class LocalWorkspaceExecutor implements WorkspaceExecutor {
  readonly facts = LOCAL_WORKSPACE_EXECUTOR_FACTS;

  async exec(input: WorkspaceExecInput): Promise<WorkspaceExecResult> {
    const result = await runShellWithBoundedTail(input.command, {
      cwd: input.cwd,
      timeoutMs: input.timeoutMs,
      ...(input.abortSignal ? { abortSignal: input.abortSignal } : {}),
      ...(input.emitOutput ? { emitOutput: input.emitOutput } : {}),
    });
    return {
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: result.timedOut ? 124 : result.aborted ? 130 : result.exitCode,
      stdoutTruncated: result.stdoutTruncated,
      stderrTruncated: result.stderrTruncated,
      timedOut: result.timedOut,
      aborted: result.aborted,
    };
  }

  async readFile(input: WorkspaceReadFileInput): Promise<WorkspaceReadFileResult> {
    const content = await fs.readFile(input.path, 'utf8');
    if (input.offset === undefined && input.limit === undefined) return { content };
    const lines = content.split('\n');
    const start = input.offset ?? 0;
    const end = input.limit ? start + input.limit : lines.length;
    return { content: lines.slice(start, end).join('\n') };
  }

  async writeFile(input: WorkspaceWriteFileInput): Promise<WorkspaceWriteFileResult> {
    await fs.writeFile(input.path, input.content, 'utf8');
    return {
      ok: true,
      path: input.path,
      bytes: Buffer.byteLength(input.content, 'utf8'),
    };
  }

  async resolveExistingPath(input: WorkspaceResolvePathInput): Promise<WorkspaceResolvePathResult> {
    return { path: await resolveExistingInsideCwd(input.cwd, input.path, input.label) };
  }

  async resolveWritablePath(input: WorkspaceResolvePathInput): Promise<WorkspaceResolvePathResult> {
    return { path: await resolveWritableInsideCwd(input.cwd, input.path, input.label) };
  }

  async writeLockKey(input: WorkspaceWriteLockKeyInput): Promise<WorkspaceWriteLockKeyResult> {
    return { key: resolve(await fs.realpath(input.cwd), input.path) };
  }

  async globFiles(input: WorkspaceGlobInput): Promise<WorkspaceGlobResult> {
    const files: string[] = [];
    const limit = input.limit ?? 200;
    for await (const file of nodeGlob(input.pattern, { cwd: input.cwd })) {
      files.push(typeof file === 'string' ? file : (file as { name: string }).name);
      if (files.length >= limit) break;
    }
    return { files };
  }

  async grepFiles(input: WorkspaceGrepInput): Promise<WorkspaceGrepResult> {
    const args = ['-n', '--no-heading', `--max-count=${input.maxCountPerFile}`];
    if (input.glob) args.push('--glob', input.glob);
    args.push(input.pattern, input.path);
    const command = `rg ${args.map(shellEscape).join(' ')}`;
    try {
      const { stdout } = await execAsync(command, {
        cwd: input.cwd,
        maxBuffer: 5 * 1024 * 1024,
        timeout: input.timeoutMs,
        ...(input.abortSignal ? { signal: input.abortSignal } : {}),
      });
      return { matches: stdout.split('\n').filter(Boolean).slice(0, input.limit) };
    } catch (error: any) {
      if (error?.code === 1) return { matches: [] };
      throw error;
    }
  }
}

export function createLocalWorkspaceExecutor(): WorkspaceExecutor {
  return new LocalWorkspaceExecutor();
}

function shellEscape(arg: string): string {
  return `'${arg.replaceAll("'", "'\\''")}'`;
}

async function resolveWritableInsideCwd(cwd: string, inputPath: string, label: string): Promise<string> {
  if (isAbsolute(inputPath)) {
    throw new Error(`${label} path must be relative to session cwd`);
  }
  const root = await fs.realpath(cwd);
  const candidate = resolve(root, inputPath);
  if (!isInside(root, candidate)) {
    throw new Error(`${label} path must stay inside session cwd`);
  }
  const parent = await fs.realpath(dirname(candidate));
  if (!isInside(root, parent)) {
    throw new Error(`${label} path must stay inside session cwd`);
  }
  return candidate;
}

async function resolveExistingInsideCwd(cwd: string, inputPath: string, label: string): Promise<string> {
  if (isAbsolute(inputPath)) {
    throw new Error(`${label} path must be relative to session cwd`);
  }
  const root = await fs.realpath(cwd);
  const candidate = resolve(root, inputPath);
  if (!isInside(root, candidate)) {
    throw new Error(`${label} path must stay inside session cwd`);
  }
  const target = await fs.realpath(candidate);
  if (!isInside(root, target)) {
    throw new Error(`${label} path must stay inside session cwd`);
  }
  return target;
}

function isInside(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}
