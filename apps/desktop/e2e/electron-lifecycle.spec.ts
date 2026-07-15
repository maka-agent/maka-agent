import { EventEmitter } from 'node:events';
import { test, expect } from '@playwright/test';
import {
  closeElectronApplication,
  type ClosableElectronApplication,
  type ElectronProcessHandle,
} from './electron-lifecycle.js';

class FakeElectronProcess extends EventEmitter implements ElectronProcessHandle {
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  killedWith: NodeJS.Signals | undefined;

  kill(signal: NodeJS.Signals): boolean {
    this.killedWith = signal;
    queueMicrotask(() => {
      this.signalCode = signal;
      this.emit('exit');
    });
    return true;
  }

  override once(event: 'exit', listener: () => void): this {
    return super.once(event, listener);
  }

  override off(event: 'exit', listener: () => void): this {
    return super.off(event, listener);
  }
}

test('force-kills Electron when graceful E2E teardown does not settle', async () => {
  const child = new FakeElectronProcess();
  const app: ClosableElectronApplication = {
    close: () => new Promise<void>(() => {}),
    process: () => child,
  };

  const settled = await Promise.race([
    closeElectronApplication(app, 0).then(() => true),
    new Promise<false>((resolve) => setTimeout(() => resolve(false), 25)),
  ]);

  expect(settled).toBe(true);
  expect(child.killedWith).toBe('SIGKILL');
});
