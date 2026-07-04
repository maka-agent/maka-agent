import { promises as fs } from 'node:fs';
import { runShellWithBoundedTail } from './shell-exec.js';

export type WorkspaceIsolationKind = 'none' | 'worktree' | 'container' | 'remote';
export type WorkspaceWriteBackMode = 'direct' | 'diff_review';
export type WorkspaceNetworkMode = 'host' | 'sandbox' | 'disabled';
export type WorkspaceSecretMode = 'host_env' | 'brokered' | 'none';

export interface WorkspaceExecutorFacts {
  isolation: WorkspaceIsolationKind;
  writesAffectHost: boolean;
  writeBack: WorkspaceWriteBackMode;
  network: WorkspaceNetworkMode;
  secrets: WorkspaceSecretMode;
}

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
  path: string;
}

export interface WorkspaceReadFileResult {
  content: string;
}

export interface WorkspaceWriteFileInput {
  path: string;
  content: string;
}

export interface WorkspaceWriteFileResult {
  ok: boolean;
  path: string;
  bytes: number;
}

export interface WorkspaceExecutor {
  readonly facts: WorkspaceExecutorFacts;
  exec(input: WorkspaceExecInput): Promise<WorkspaceExecResult>;
  readFile(input: WorkspaceReadFileInput): Promise<WorkspaceReadFileResult>;
  writeFile(input: WorkspaceWriteFileInput): Promise<WorkspaceWriteFileResult>;
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
}

export function createLocalWorkspaceExecutor(): WorkspaceExecutor {
  return new LocalWorkspaceExecutor();
}
