import { spawn, type ChildProcess } from 'node:child_process';
import type { Readable } from 'node:stream';

import type { ShellSpawnPlan } from './shell-detect.js';
import { buildSpawnStdio, writeChildFdInputs, type ChildFdInput } from './child-fd-input.js';

export interface PipeProcessExit {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
}

export interface PipeProcessDriverOptions {
  plan: ShellSpawnPlan;
  cwd: string;
  env?: NodeJS.ProcessEnv;
  fdInputs?: readonly ChildFdInput[];
  onData: (stream: 'stdout' | 'stderr', data: string) => void;
  onExit: (exit: PipeProcessExit) => void;
  onFailure: (error: Error) => void;
}

export class PipeProcessDriver {
  readonly pid: number | undefined;
  readonly ready: Promise<void>;

  private readonly child: ChildProcess;
  private readonly stdout: Readable;
  private readonly stderr: Readable;
  private disposed = false;
  private exited = false;

  constructor(private readonly options: PipeProcessDriverOptions) {
    this.child = spawn(options.plan.file, options.plan.args, {
      cwd: options.cwd,
      env: options.env,
      shell: options.plan.useShellOption,
      stdio: buildSpawnStdio(options.fdInputs),
      detached: process.platform !== 'win32',
    });
    if (!this.child.stdout || !this.child.stderr) {
      this.child.kill('SIGKILL');
      throw new Error('Pipe process did not expose stdout and stderr');
    }
    this.stdout = this.child.stdout;
    this.stderr = this.child.stderr;
    this.pid = this.child.pid;
    this.stdout.setEncoding('utf8');
    this.stderr.setEncoding('utf8');
    this.stdout.on('data', this.onStdout);
    this.stderr.on('data', this.onStderr);
    this.child.on('close', this.onClose);
    this.child.on('error', this.onError);
    this.ready = waitForSpawn(this.child);
    try {
      writeChildFdInputs(this.child, options.fdInputs);
    } catch (error) {
      this.child.kill('SIGKILL');
      throw error;
    }
  }

  kill(signal: 'SIGTERM' | 'SIGKILL'): boolean {
    return this.child.kill(signal);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.stdout.off('data', this.onStdout);
    this.stderr.off('data', this.onStderr);
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

function waitForSpawn(child: ChildProcess): Promise<void> {
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
