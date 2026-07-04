import { promises as fs } from 'node:fs';
import { exec } from 'node:child_process';
import { glob as nodeGlob } from 'node:fs/promises';
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
  timedOut: boolean;
  aborted: boolean;
}

export interface WorkspaceReadFileInput {
  cwd: string;
  path: string;
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

export interface WorkspaceExecutor {
  readonly facts: WorkspaceExecutorFacts;
  exec(input: WorkspaceExecInput): Promise<WorkspaceExecResult>;
  readFile(input: WorkspaceReadFileInput): Promise<WorkspaceReadFileResult>;
  writeFile(input: WorkspaceWriteFileInput): Promise<WorkspaceWriteFileResult>;
  globFiles(input: WorkspaceGlobInput): Promise<WorkspaceGlobResult>;
  grepFiles(input: WorkspaceGrepInput): Promise<WorkspaceGrepResult>;
}

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
      timedOut: result.timedOut,
      aborted: result.aborted,
    };
  }

  async readFile(input: WorkspaceReadFileInput): Promise<WorkspaceReadFileResult> {
    return { content: await fs.readFile(input.path, 'utf8') };
  }

  async writeFile(input: WorkspaceWriteFileInput): Promise<WorkspaceWriteFileResult> {
    await fs.writeFile(input.path, input.content, 'utf8');
    return {
      ok: true,
      path: input.path,
      bytes: Buffer.byteLength(input.content, 'utf8'),
    };
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
