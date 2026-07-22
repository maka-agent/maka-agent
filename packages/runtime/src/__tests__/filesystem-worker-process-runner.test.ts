import assert from 'node:assert/strict';
import { type ChildProcess, spawn } from 'node:child_process';
import { EventEmitter, once } from 'node:events';
import { existsSync, promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';

import { manageChildProcessLifecycle } from '../child-process-lifecycle.js';
import { runFilesystemWorkerProcess } from '../filesystem-worker/process-runner.js';

describe('runFilesystemWorkerProcess', () => {
  test('fails boundedly after direct root exit when an escaped descendant retains output pipes', {
    skip: process.platform === 'win32',
  }, async () => {
    const dir = await fs.mkdtemp(join(tmpdir(), 'filesystem-worker-drain-'));
    const pidFile = join(dir, 'descendant.pid');
    const script = `
        const { spawn } = require('node:child_process');
        const { writeFileSync } = require('node:fs');
        process.stdout.write('root response\\n');
        process.stderr.write('root diagnostic\\n');
        const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 3000)'], {
          detached: true,
          stdio: ['ignore', 1, 2],
        });
        child.unref();
        writeFileSync(${JSON.stringify(pidFile)}, String(child.pid));
      `;
    let descendantPid: number | undefined;
    try {
      const startedAt = Date.now();
      const running = runFilesystemWorkerProcess({
        argv: [process.execPath, '-e', script],
        cwd: process.cwd(),
        env: process.env,
        stdin: '',
        timeoutMs: 10_000,
        ioDrainTimeoutMs: 100,
      });
      await assert.rejects(
        running,
        /Filesystem worker output did not drain before lifecycle deadline/,
      );
      const elapsedMs = Date.now() - startedAt;
      descendantPid = Number((await fs.readFile(pidFile, 'utf8')).trim());

      assert.ok(elapsedMs < 2_000, `worker waited ${elapsedMs}ms for inherited pipes`);
      assert.doesNotThrow(() => process.kill(descendantPid as number, 0));
    } finally {
      if (descendantPid) {
        try {
          process.kill(descendantPid, 'SIGKILL');
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
        }
      }
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  test('bounds timeout after escalating a child that ignores SIGTERM', {
    skip: process.platform === 'win32',
  }, async () => {
    const startedAt = Date.now();
    const result = await runFilesystemWorkerProcess({
      argv: [process.execPath, '-e', stubbornWorkerScript()],
      cwd: process.cwd(),
      env: process.env,
      stdin: '',
      timeoutMs: 150,
      killGraceMs: 75,
      ioDrainTimeoutMs: 100,
    });

    assert.equal(result.timedOut, true);
    assert.ok(Date.now() - startedAt < 2_000);
  });

  test('bounds abort after escalating a child that ignores SIGTERM', {
    skip: process.platform === 'win32',
  }, async () => {
    const controller = new AbortController();
    const startedAt = Date.now();
    const running = runFilesystemWorkerProcess({
      argv: [process.execPath, '-e', stubbornWorkerScript()],
      cwd: process.cwd(),
      env: process.env,
      stdin: '',
      timeoutMs: 10_000,
      abortSignal: controller.signal,
      killGraceMs: 75,
      ioDrainTimeoutMs: 100,
    });
    setTimeout(() => controller.abort(), 150);
    const result = await running;

    assert.equal(result.aborted, true);
    assert.ok(Date.now() - startedAt < 2_000);
  });

  test('does not spawn a worker for a pre-aborted signal', {
    skip: process.platform === 'win32',
  }, async () => {
    const dir = await fs.mkdtemp(join(tmpdir(), 'filesystem-worker-pre-abort-'));
    const marker = join(dir, 'spawned');
    const controller = new AbortController();
    controller.abort();
    try {
      const result = await runFilesystemWorkerProcess({
        argv: ['/bin/sh', '-c', `printf spawned > ${JSON.stringify(marker)}; sleep 5`],
        cwd: process.cwd(),
        env: process.env,
        stdin: '',
        timeoutMs: 10_000,
        abortSignal: controller.signal,
      });

      assert.equal(result.aborted, true);
      assert.equal(existsSync(marker), false);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  test('fails when forced termination is not acknowledged by the direct root', async () => {
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const exited = once(child, 'exit');
    try {
      const lifecycle = manageChildProcessLifecycle(child, [child.stdout, child.stderr], {
        killGraceMs: 10,
        exitAcknowledgementMs: 25,
        ioDrainTimeoutMs: 25,
        signalProcessTree: async () => true,
      });
      lifecycle.terminate();

      await assert.rejects(
        lifecycle.completion,
        /Child process did not acknowledge exit after forced termination/,
      );
      assert.equal(child.exitCode, null);
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      await exited;
    }
  });

  test('starts kill grace after TERM settles while force kill remains immediate', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    try {
      const delayedTerm = deferred<boolean>();
      const signals: NodeJS.Signals[] = [];
      const child = new EventEmitter() as unknown as ChildProcess;
      const lifecycle = manageChildProcessLifecycle(child, [], {
        killGraceMs: 10,
        ioDrainTimeoutMs: 25,
        signalProcessTree: (signal) => {
          signals.push(signal);
          return signal === 'SIGTERM' ? delayedTerm.promise : Promise.resolve(true);
        },
      });

      lifecycle.terminate();
      const delayedTermSettled = afterPromiseReactions(delayedTerm.promise);
      t.mock.timers.tick(10);
      assert.deepEqual(signals, ['SIGTERM']);

      delayedTerm.resolve(true);
      await delayedTermSettled;
      t.mock.timers.tick(9);
      assert.deepEqual(signals, ['SIGTERM']);
      t.mock.timers.tick(1);
      assert.deepEqual(signals, ['SIGTERM', 'SIGKILL']);
      child.emit('exit', null, 'SIGKILL');
      await lifecycle.completion;

      const pendingTerm = deferred<boolean>();
      const forcedSignals: NodeJS.Signals[] = [];
      const forcedChild = new EventEmitter() as unknown as ChildProcess;
      const forcedLifecycle = manageChildProcessLifecycle(forcedChild, [], {
        killGraceMs: 10,
        ioDrainTimeoutMs: 25,
        signalProcessTree: (signal) => {
          forcedSignals.push(signal);
          return signal === 'SIGTERM' ? pendingTerm.promise : Promise.resolve(true);
        },
      });

      forcedLifecycle.terminate();
      const pendingTermSettled = afterPromiseReactions(pendingTerm.promise);
      forcedLifecycle.forceKill();
      assert.deepEqual(forcedSignals, ['SIGTERM', 'SIGKILL']);

      pendingTerm.resolve(true);
      await pendingTermSettled;
      t.mock.timers.tick(10);
      assert.deepEqual(forcedSignals, ['SIGTERM', 'SIGKILL']);
      forcedChild.emit('exit', null, 'SIGKILL');
      await forcedLifecycle.completion;
    } finally {
      t.mock.timers.reset();
    }
  });

  test('bounds response overflow after escalating a child that ignores SIGTERM', {
    skip: process.platform === 'win32',
  }, async () => {
    const startedAt = Date.now();
    const result = await runFilesystemWorkerProcess({
      argv: [process.execPath, '-e', stubbornWorkerScript("process.stdout.write('overflow');")],
      cwd: process.cwd(),
      env: process.env,
      stdin: '',
      timeoutMs: 10_000,
      maxResponseBytes: 4,
      killGraceMs: 75,
      ioDrainTimeoutMs: 100,
    });

    assert.equal(result.responseOverflow, true);
    assert.equal(result.stdout, '');
    assert.ok(Date.now() - startedAt < 2_000);
  });
});

function stubbornWorkerScript(afterInstall = ''): string {
  return `
    process.on('SIGTERM', () => {});
    ${afterInstall}
    setInterval(() => {}, 1000);
  `;
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function afterPromiseReactions(promise: Promise<unknown>): Promise<void> {
  return new Promise((resolve, reject) => {
    void promise.then(
      () => setImmediate(resolve),
      (error: unknown) => reject(error),
    );
  });
}
