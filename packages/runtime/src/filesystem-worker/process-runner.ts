import { spawn, type ChildProcessByStdio } from 'node:child_process';
import type { Readable, Writable } from 'node:stream';

import {
  DEFAULT_PROCESS_TERMINATION_GRACE_MS,
  terminateChildProcessTree,
} from '../process-tree-terminator.js';

export const FILESYSTEM_WORKER_MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
export const FILESYSTEM_WORKER_MAX_STDERR_BYTES = 1024 * 1024;
export const FILESYSTEM_WORKER_DEFAULT_TIMEOUT_MS = 120_000;

export interface FilesystemWorkerProcessRunInput {
  argv: readonly string[];
  cwd: string;
  env: Readonly<Record<string, string | undefined>>;
  stdin: string;
  timeoutMs?: number;
  abortSignal?: AbortSignal;
  maxResponseBytes?: number;
  maxStderrBytes?: number;
  killGraceMs?: number;
}

export interface FilesystemWorkerProcessRunResult {
  exitCode: number;
  stdout: string;
  stderrTail: string;
  timedOut: boolean;
  aborted: boolean;
  responseOverflow: boolean;
}

export type FilesystemWorkerProcessRunner = (
  input: FilesystemWorkerProcessRunInput,
) => Promise<FilesystemWorkerProcessRunResult>;

type WorkerChildProcess = ChildProcessByStdio<Writable, Readable, Readable>;

export async function runFilesystemWorkerProcess(
  input: FilesystemWorkerProcessRunInput,
): Promise<FilesystemWorkerProcessRunResult> {
  const program = input.argv[0];
  if (!program) throw new Error('Filesystem worker argv must include a program.');
  const child = spawn(program, input.argv.slice(1), {
    cwd: input.cwd,
    env: input.env as NodeJS.ProcessEnv,
    shell: false,
    stdio: ['pipe', 'pipe', 'pipe'],
    detached: process.platform !== 'win32',
  }) as WorkerChildProcess;
  return await observeWorker(child, input);
}

async function observeWorker(
  child: WorkerChildProcess,
  input: FilesystemWorkerProcessRunInput,
): Promise<FilesystemWorkerProcessRunResult> {
  return await new Promise((resolvePromise, reject) => {
    const responseLimit = input.maxResponseBytes ?? FILESYSTEM_WORKER_MAX_RESPONSE_BYTES;
    const stderrLimit = input.maxStderrBytes ?? FILESYSTEM_WORKER_MAX_STDERR_BYTES;
    const timeoutMs = input.timeoutMs ?? FILESYSTEM_WORKER_DEFAULT_TIMEOUT_MS;
    const killGraceMs = input.killGraceMs ?? DEFAULT_PROCESS_TERMINATION_GRACE_MS;
    const stdoutChunks: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrTail: Buffer<ArrayBufferLike> = Buffer.alloc(0);
    let responseOverflow = false;
    let termination: 'timeout' | 'abort' | 'overflow' | undefined;
    let settled = false;
    let killTimer: NodeJS.Timeout | undefined;

    const timeout = setTimeout(() => terminate('timeout'), timeoutMs);
    const abort = () => terminate('abort');
    if (input.abortSignal) {
      if (input.abortSignal.aborted) abort();
      else input.abortSignal.addEventListener('abort', abort, { once: true });
    }
    child.stdout.on('data', (chunk: Buffer) => {
      if (responseOverflow) return;
      stdoutBytes += chunk.length;
      if (stdoutBytes > responseLimit) {
        responseOverflow = true;
        stdoutChunks.length = 0;
        terminate('overflow');
      } else {
        stdoutChunks.push(chunk);
      }
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderrTail = appendBoundedTail(stderrTail, chunk, stderrLimit);
    });
    child.once('error', (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    });
    child.once('close', (exitCode) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolvePromise({
        exitCode: exitCode ?? 1,
        stdout: responseOverflow ? '' : Buffer.concat(stdoutChunks).toString('utf8'),
        stderrTail: stderrTail.toString('utf8'),
        timedOut: termination === 'timeout',
        aborted: termination === 'abort',
        responseOverflow,
      });
    });
    child.stdin.once('error', () => {});
    child.stdin.end(input.stdin);

    function terminate(reason: 'timeout' | 'abort' | 'overflow'): void {
      if (termination || settled) return;
      termination = reason;
      terminateChildProcessTree(child, 'SIGTERM');
      killTimer = setTimeout(() => terminateChildProcessTree(child, 'SIGKILL'), killGraceMs);
    }

    function cleanup(): void {
      clearTimeout(timeout);
      if (killTimer) clearTimeout(killTimer);
      input.abortSignal?.removeEventListener('abort', abort);
    }
  });
}

function appendBoundedTail(current: Buffer, chunk: Buffer, limit: number): Buffer {
  if (limit <= 0) return Buffer.alloc(0);
  if (chunk.length >= limit) return chunk.subarray(chunk.length - limit);
  if (current.length + chunk.length <= limit) return Buffer.concat([current, chunk]);
  return Buffer.concat([current.subarray(current.length - (limit - chunk.length)), chunk]);
}
