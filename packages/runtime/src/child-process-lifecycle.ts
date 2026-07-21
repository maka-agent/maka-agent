import type { ChildProcess } from 'node:child_process';
import type { Readable } from 'node:stream';

import {
  DEFAULT_PROCESS_TERMINATION_GRACE_MS,
  terminateChildProcessTree,
} from './process-tree-terminator.js';

export const DEFAULT_PROCESS_IO_DRAIN_TIMEOUT_MS = DEFAULT_PROCESS_TERMINATION_GRACE_MS;

export interface ChildProcessLifecycleResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  /** False when local capture streams were destroyed at the I/O deadline. */
  ioDrained: boolean;
}

export interface ChildProcessLifecycle {
  completion: Promise<ChildProcessLifecycleResult>;
  terminate(): void;
  forceKill(): void;
}

interface ChildProcessLifecycleOptions {
  killGraceMs: number;
  ioDrainTimeoutMs: number;
  exitAcknowledgementMs?: number;
  /** Narrow test seam for an OS outcome that cannot be induced reliably. */
  signalProcessTree?: (signal: 'SIGTERM' | 'SIGKILL') => Promise<boolean>;
}

/**
 * Tracks direct-root exit separately from captured stream drain. Escaped
 * descendants may retain inherited pipe writers after the root has exited, so
 * stream drain is cut off independently rather than relying on ChildProcess
 * `close`, which combines both facts.
 */
export function manageChildProcessLifecycle(
  child: ChildProcess,
  outputStreams: readonly Readable[],
  options: ChildProcessLifecycleOptions,
): ChildProcessLifecycle {
  let exitCode: number | null = null;
  let signal: NodeJS.Signals | null = null;
  let rootExited = false;
  let ioDrainTimedOut = false;
  let settled = false;
  let terminationStarted = false;
  let killSent = false;
  let killTimer: NodeJS.Timeout | undefined;
  let exitAcknowledgementTimer: NodeJS.Timeout | undefined;
  let ioDrainTimer: NodeJS.Timeout | undefined;
  const pendingStreams = new Set(outputStreams.filter((stream) => !stream.readableEnded));

  let resolveCompletion!: (result: ChildProcessLifecycleResult) => void;
  let rejectCompletion!: (error: Error) => void;
  const completion = new Promise<ChildProcessLifecycleResult>((resolve, reject) => {
    resolveCompletion = resolve;
    rejectCompletion = reject;
  });

  const onExit = (code: number | null, exitSignal: NodeJS.Signals | null) => {
    if (settled) return;
    rootExited = true;
    exitCode = code;
    signal = exitSignal;
    if (exitAcknowledgementTimer) clearTimeout(exitAcknowledgementTimer);
    startIoDrainTimer();
    maybeFinish();
  };
  const onError = (error: Error) => {
    if (settled) return;
    settled = true;
    cleanup();
    rejectCompletion(error);
  };

  child.once('exit', onExit);
  child.once('error', onError);
  for (const stream of pendingStreams) {
    const drained = () => {
      pendingStreams.delete(stream);
      maybeFinish();
    };
    stream.once('end', drained);
    stream.once('close', drained);
    stream.once('error', drained);
  }

  function terminate(): void {
    if (settled || terminationStarted) return;
    terminationStarted = true;
    void signalTree('SIGTERM').then(() => {
      if (settled || killSent) return;
      killTimer = setTimeout(forceKill, options.killGraceMs);
    });
  }

  function forceKill(): void {
    if (settled || killSent) return;
    terminationStarted = true;
    killSent = true;
    if (killTimer) clearTimeout(killTimer);
    void signalTree('SIGKILL');
    if (rootExited) return;
    exitAcknowledgementTimer = setTimeout(() => {
      if (settled || rootExited) return;
      void signalTree('SIGKILL');
      ioDrainTimedOut = pendingStreams.size > 0;
      detachOutputStreams();
      fail(new Error('Child process did not acknowledge exit after forced termination'));
    }, options.exitAcknowledgementMs ?? DEFAULT_PROCESS_TERMINATION_GRACE_MS);
  }

  function signalTree(treeSignal: 'SIGTERM' | 'SIGKILL'): Promise<boolean> {
    try {
      return (
        options.signalProcessTree?.(treeSignal) ?? terminateChildProcessTree(child, treeSignal)
      ).catch(() => false);
    } catch {
      // Signalling remains best-effort; the acknowledgement deadline is authoritative.
      return Promise.resolve(false);
    }
  }

  function startIoDrainTimer(): void {
    if (pendingStreams.size === 0 || ioDrainTimer) return;
    ioDrainTimer = setTimeout(() => {
      if (settled || pendingStreams.size === 0) return;
      ioDrainTimedOut = true;
      detachOutputStreams();
      maybeFinish();
    }, options.ioDrainTimeoutMs);
  }

  function detachOutputStreams(): void {
    for (const stream of pendingStreams) stream.destroy();
    pendingStreams.clear();
  }

  function maybeFinish(): void {
    if (!rootExited || pendingStreams.size > 0) return;
    finish();
  }

  function finish(): void {
    if (settled) return;
    settled = true;
    cleanup();
    resolveCompletion({
      exitCode,
      signal,
      ioDrained: !ioDrainTimedOut,
    });
  }

  function fail(error: Error): void {
    if (settled) return;
    settled = true;
    cleanup();
    rejectCompletion(error);
  }

  function cleanup(): void {
    if (killTimer) clearTimeout(killTimer);
    if (exitAcknowledgementTimer) clearTimeout(exitAcknowledgementTimer);
    if (ioDrainTimer) clearTimeout(ioDrainTimer);
    child.removeListener('exit', onExit);
    child.removeListener('error', onError);
  }

  maybeFinish();
  return { completion, terminate, forceKill };
}
