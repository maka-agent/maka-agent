import { spawn, type ChildProcessByStdio } from 'node:child_process';
import type { Readable } from 'node:stream';

import type { ShellSpawnPlan } from './shell-detect.js';

export interface PipeProcessExit {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
}

export interface PipeProcessDriverOptions {
  plan: ShellSpawnPlan;
  cwd: string;
  onData: (stream: 'stdout' | 'stderr', data: string) => void;
  onExit: (exit: PipeProcessExit) => void;
  onFailure: (error: Error) => void;
}

type PipeChild = ChildProcessByStdio<null, Readable, Readable>;

export class PipeProcessDriver {
  readonly pid: number | undefined;
  readonly ready: Promise<void>;

  private readonly child: PipeChild;
  private disposed = false;
  private exited = false;

  constructor(private readonly options: PipeProcessDriverOptions) {
    this.child = spawn(options.plan.file, options.plan.args, {
      cwd: options.cwd,
      shell: options.plan.useShellOption,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
    });
    this.pid = this.child.pid;
    this.child.stdout.setEncoding('utf8');
    this.child.stderr.setEncoding('utf8');
    this.child.stdout.on('data', this.onStdout);
    this.child.stderr.on('data', this.onStderr);
    this.child.on('close', this.onClose);
    this.child.on('error', this.onError);
    this.ready = waitForSpawn(this.child);
  }

  kill(signal: 'SIGTERM' | 'SIGKILL'): boolean {
    return this.child.kill(signal);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.child.stdout.off('data', this.onStdout);
    this.child.stderr.off('data', this.onStderr);
    this.child.off('close', this.onClose);
    this.child.off('error', this.onError);
  }

  private readonly onStdout = (data: string): void => {
    if (!this.disposed && !this.exited) this.options.onData('stdout', data);
  };

  private readonly onStderr = (data: string): void => {
    if (!this.disposed && !this.exited) this.options.onData('stderr', data);
  };

  private readonly onClose = (exitCode: number | null, signal: NodeJS.Signals | null): void => {
    if (this.disposed || this.exited) return;
    this.exited = true;
    this.options.onExit({ exitCode, signal });
  };

  private readonly onError = (error: Error): void => {
    if (!this.disposed && !this.exited) this.options.onFailure(error);
  };
}

function waitForSpawn(child: PipeChild): Promise<void> {
  return new Promise((resolve, reject) => {
    const onSpawn = () => {
      cleanup();
      resolve();
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const cleanup = () => {
      child.off('spawn', onSpawn);
      child.off('error', onError);
    };
    child.once('spawn', onSpawn);
    child.once('error', onError);
  });
}
