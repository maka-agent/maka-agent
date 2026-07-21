import { spawn, type ChildProcess } from 'node:child_process';
import type { Readable } from 'node:stream';

import type { ShellSpawnPlan } from './shell-detect.js';
import { buildSpawnStdio, writeChildFdInputs, type ChildFdInput } from './child-fd-input.js';

export interface PipeProcessExit {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
}

export interface PipeProcessDriverOptions {
  plan: ShellSpawnPlan;
  cwd: string;
  env?: NodeJS.ProcessEnv;
  fdInputs?: readonly ChildFdInput[];
  onData: (stream: 'stdout' | 'stderr', data: string) => void;
  onExit: (exit: PipeProcessExit) => void;
  onFailure: (error: Error) => void;
  outputDrainMs: number;
}

export class PipeProcessDriver {
  readonly pid: number | undefined;
  readonly ready: Promise<void>;

  private readonly child: ChildProcess;
  private readonly stdout: Readable;
  private readonly stderr: Readable;
  private disposed = false;
  private settled = false;
  private stdoutEnded = false;
  private stderrEnded = false;
  private rootExit: Omit<PipeProcessExit, 'stdoutTruncated' | 'stderrTruncated'> | undefined;
  private drainTimer: NodeJS.Timeout | undefined;

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
    this.stdout.on('end', this.onStdoutEnd);
    this.stderr.on('end', this.onStderrEnd);
    this.child.on('exit', this.onRootExit);
    this.child.on('close', this.onCloseFallback);
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
    if (this.drainTimer) clearTimeout(this.drainTimer);
    this.stdout.off('data', this.onStdout);
    this.stderr.off('data', this.onStderr);
    this.stdout.off('end', this.onStdoutEnd);
    this.stderr.off('end', this.onStderrEnd);
    this.child.off('exit', this.onRootExit);
    this.child.off('close', this.onCloseFallback);
    this.child.off('error', this.onError);
  }

  private readonly onStdout = (data: string): void => {
    if (!this.disposed && !this.settled) this.options.onData('stdout', data);
  };

  private readonly onStderr = (data: string): void => {
    if (!this.disposed && !this.settled) this.options.onData('stderr', data);
  };

  private readonly onStdoutEnd = (): void => {
    this.stdoutEnded = true;
    this.settleAfterDrain();
  };

  private readonly onStderrEnd = (): void => {
    this.stderrEnded = true;
    this.settleAfterDrain();
  };

  private readonly onRootExit = (exitCode: number | null, signal: NodeJS.Signals | null): void => {
    if (this.disposed || this.rootExit) return;
    this.rootExit = { exitCode, signal };
    this.settleAfterDrain();
    if (!this.settled && !this.drainTimer) {
      this.drainTimer = setTimeout(this.expireDrain, this.options.outputDrainMs);
    }
  };

  private readonly onCloseFallback = (
    exitCode: number | null,
    signal: NodeJS.Signals | null,
  ): void => {
    if (!this.rootExit) this.onRootExit(exitCode, signal);
  };

  private readonly expireDrain = (): void => {
    this.drainTimer = undefined;
    if (this.disposed || this.settled || !this.rootExit) return;
    const stdoutTruncated = !this.stdoutEnded;
    const stderrTruncated = !this.stderrEnded;
    if (stdoutTruncated) this.stdout.destroy();
    if (stderrTruncated) this.stderr.destroy();
    this.settle(stdoutTruncated, stderrTruncated);
  };

  private settleAfterDrain(): void {
    if (!this.rootExit || !this.stdoutEnded || !this.stderrEnded) return;
    this.settle(false, false);
  }

  private settle(stdoutTruncated: boolean, stderrTruncated: boolean): void {
    if (this.disposed || this.settled || !this.rootExit) return;
    this.settled = true;
    if (this.drainTimer) clearTimeout(this.drainTimer);
    this.drainTimer = undefined;
    this.options.onExit({ ...this.rootExit, stdoutTruncated, stderrTruncated });
  }

  private readonly onError = (error: Error): void => {
    if (!this.disposed && !this.settled) this.options.onFailure(error);
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
