import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { glob as nodeGlob } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { promisify } from 'node:util';
import { runShellWithBoundedTail } from './shell-exec.js';

const execFileAsync = promisify(execFile);
const GREP_TIMEOUT_MS = 120_000;

export interface WorkspaceExecutorFacts {
  isolation: 'none' | 'worktree' | 'container' | 'remote';
  writesAffectHost: boolean;
  writeBack: 'direct' | 'diff_review';
  network: 'host' | 'sandbox' | 'disabled';
  secrets: 'host_env' | 'brokered' | 'none';
  gitMetadata: 'host_shared' | 'sandbox_local' | 'none';
}

export interface WorkspaceExecInput {
  command: string;
  cwd: string;
  timeoutMs?: number;
  abortSignal?: AbortSignal;
  emitOutput?: (stream: 'stdout' | 'stderr', chunk: string) => void;
}

export interface WorkspaceExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut?: boolean;
  aborted?: boolean;
}

export interface WorkspaceReadFileInput {
  cwd: string;
  path: string;
  label?: string;
  offset?: number;
  limit?: number;
}

export interface WorkspaceReadFileResult {
  content: string;
}

export interface WorkspaceWriteFileInput {
  cwd: string;
  path: string;
  label?: string;
  content: string;
}

export interface WorkspaceWriteFileResult {
  ok: boolean;
  path: string;
  bytes: number;
}

export interface WorkspaceGlobInput {
  cwd: string;
  pattern: string;
  searchCwd?: string;
}

export interface WorkspaceGlobResult {
  files: string[];
}

export interface WorkspaceGrepInput {
  cwd: string;
  pattern: string;
  path?: string;
  glob?: string;
  abortSignal?: AbortSignal;
}

export interface WorkspaceGrepResult {
  matches: string[];
}

export interface WorkspaceFileLockKeyInput {
  cwd: string;
  path: string;
}

export interface WorkspaceExecutor {
  facts: WorkspaceExecutorFacts;
  exec(input: WorkspaceExecInput): Promise<WorkspaceExecResult>;
  readFile(input: WorkspaceReadFileInput): Promise<WorkspaceReadFileResult>;
  writeFile(input: WorkspaceWriteFileInput): Promise<WorkspaceWriteFileResult>;
  globFiles(input: WorkspaceGlobInput): Promise<WorkspaceGlobResult>;
  grepFiles(input: WorkspaceGrepInput): Promise<WorkspaceGrepResult>;
  fileLockKey?(input: WorkspaceFileLockKeyInput): Promise<string>;
  diff?(): Promise<string>;
}

export class LocalWorkspaceExecutor implements WorkspaceExecutor {
  readonly facts: WorkspaceExecutorFacts = {
    isolation: 'none',
    writesAffectHost: true,
    writeBack: 'direct',
    network: 'host',
    secrets: 'host_env',
    gitMetadata: 'host_shared',
  };

  async exec(input: WorkspaceExecInput): Promise<WorkspaceExecResult> {
    return await runShellWithBoundedTail(input.command, {
      cwd: input.cwd,
      timeoutMs: input.timeoutMs ?? 120_000,
      abortSignal: input.abortSignal,
      emitOutput: input.emitOutput,
    });
  }

  async readFile(input: WorkspaceReadFileInput): Promise<WorkspaceReadFileResult> {
    const abs = await resolveExistingInsideCwd(input.cwd, input.path, input.label ?? 'Read');
    const content = await fs.readFile(abs, 'utf8');
    if (input.offset === undefined && input.limit === undefined) return { content };
    const lines = content.split('\n');
    const start = input.offset ?? 0;
    const end = input.limit ? start + input.limit : lines.length;
    return { content: lines.slice(start, end).join('\n') };
  }

  async writeFile(input: WorkspaceWriteFileInput): Promise<WorkspaceWriteFileResult> {
    const abs = await resolveWritableInsideCwd(input.cwd, input.path, input.label ?? 'Write');
    await fs.writeFile(abs, input.content, 'utf8');
    return { ok: true, path: abs, bytes: Buffer.byteLength(input.content, 'utf8') };
  }

  async globFiles(input: WorkspaceGlobInput): Promise<WorkspaceGlobResult> {
    assertRelativeGlobPattern(input.pattern);
    const base = input.searchCwd
      ? await resolveExistingInsideCwd(input.cwd, input.searchCwd, 'Glob cwd')
      : await fs.realpath(input.cwd);
    const files: string[] = [];
    for await (const f of nodeGlob(input.pattern, { cwd: base })) {
      const name = typeof f === 'string' ? f : (f as any).name;
      files.push(name.replaceAll('\\', '/'));
      if (files.length >= 200) break;
    }
    return { files };
  }

  async grepFiles(input: WorkspaceGrepInput): Promise<WorkspaceGrepResult> {
    const args = ['-n', '--no-heading', '--max-count=50'];
    if (input.glob) args.push('--glob', input.glob);
    args.push(input.pattern);
    const searchPath = input.path
      ? await resolveExistingInsideCwd(input.cwd, input.path, 'Grep')
      : await fs.realpath(input.cwd);
    args.push(searchPath);
    try {
      const { stdout } = await execFileAsync('rg', args, {
        cwd: input.cwd,
        maxBuffer: 5 * 1024 * 1024,
        timeout: GREP_TIMEOUT_MS,
        ...(input.abortSignal ? { signal: input.abortSignal } : {}),
      });
      return { matches: stdout.split('\n').filter(Boolean).slice(0, 200) };
    } catch (e: any) {
      if (e?.code === 1) return { matches: [] };
      throw e;
    }
  }

  async fileLockKey(input: WorkspaceFileLockKeyInput): Promise<string> {
    return resolve(await fs.realpath(input.cwd), input.path);
  }
}

export async function defaultWorkspaceFileLockKey(
  executor: WorkspaceExecutor,
  input: WorkspaceFileLockKeyInput,
): Promise<string> {
  return executor.fileLockKey
    ? await executor.fileLockKey(input)
    : JSON.stringify([executor.facts.isolation, input.cwd, input.path]);
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

function assertRelativeGlobPattern(pattern: string): void {
  if (isAbsolute(pattern) || pattern.split(/[\\/]+/).includes('..')) {
    throw new Error('Glob pattern must stay inside session cwd');
  }
}
