import type { ChildProcess } from 'node:child_process';
import { terminateChildProcessTree } from '@maka/runtime';

export interface ElectronProcessHandle {
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
  kill(signal: NodeJS.Signals): boolean;
  once(event: 'exit', listener: () => void): unknown;
  off(event: 'exit', listener: () => void): unknown;
}

type ProcessTreeTerminator = (
  child: ElectronProcessHandle,
  signal: 'SIGKILL',
) => Promise<boolean>;

const terminateElectronProcessTree: ProcessTreeTerminator = (child, signal) =>
  terminateChildProcessTree(child as ChildProcess, signal);

export interface ClosableElectronApplication {
  close(): Promise<void>;
  process(): ElectronProcessHandle;
}

export async function closeElectronApplication(
  app: ClosableElectronApplication,
  graceMs: number,
  terminateTree: ProcessTreeTerminator = terminateElectronProcessTree,
): Promise<void> {
  const child = app.process();
  const gracefulClose = app.close().then(
    () => true,
    () => false,
  );
  if (await settlesWithin(gracefulClose, graceMs)) return;

  if (child.exitCode === null && child.signalCode === null) {
    await terminateTree(child, 'SIGKILL');
  }
  if (!await waitForExit(child, 2_000)) {
    throw new Error('Electron process did not exit after SIGKILL');
  }
}

async function settlesWithin(promise: Promise<boolean>, timeoutMs: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<false>((resolve) => {
        timer = setTimeout(() => resolve(false), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function waitForExit(child: ElectronProcessHandle, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return true;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onExit: (() => void) | undefined;
  try {
    return await Promise.race([
      new Promise<true>((resolve) => {
        onExit = () => resolve(true);
        child.once('exit', onExit);
      }),
      new Promise<false>((resolve) => {
        timer = setTimeout(() => resolve(false), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
    if (onExit) child.off('exit', onExit);
  }
}
