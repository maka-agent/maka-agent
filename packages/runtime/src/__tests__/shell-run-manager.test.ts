import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import type { ShellRunRecord, ShellRunStore } from '@maka/core';
import { ShellRunProcessManager } from '../shell-run-manager.js';

describe('ShellRunProcessManager', () => {
  test('persists every Bash run and returns observed terminal results for quick commands', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'maka-shell-run-'));
    const store = new MemoryShellRunStore();
    const manager = createManager(store);

    const result = await manager.runBash(shellInput({
      cwd,
      command: 'printf "hello"',
      yieldTimeMs: 30_000,
    }));

    assert.equal(result.kind, 'terminal');
    assert.equal(result.status, 'completed');
    assert.equal(result.exitCode, 0);
    assert.equal(result.stdout, 'hello');
    assert.equal(result.shellRunId, 'shell-run-1');

    const record = await store.readShellRun('session-1', 'shell-run-1');
    assert.equal(record.status, 'completed');
    assert.equal(record.stdoutTail, 'hello');
    assert.ok(record.observedAt !== undefined);
    assert.equal(manager.liveCount(), 0);
  });

  test('does not leak live slots when a process exits before durable create resolves', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'maka-shell-run-'));
    const store = new MemoryShellRunStore({ createDelayMs: 100 });
    const manager = createManager(store);

    const result = await manager.runBash(shellInput({
      cwd,
      command: 'printf "done"',
      yieldTimeMs: 30_000,
    }));

    assert.equal(result.kind, 'terminal');
    assert.equal(result.status, 'completed');
    assert.equal(manager.liveCount(), 0);
  });

  test('yields long commands as running ShellRuns and observes them on wait', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'maka-shell-run-'));
    const store = new MemoryShellRunStore();
    const manager = createManager(store);

    const initial = await manager.runBash(shellInput({
      cwd,
      command: 'printf "start"; sleep 0.5; printf "done"',
      yieldTimeMs: 250,
    }));

    assert.equal(initial.kind, 'shell_run');
    assert.equal(initial.status, 'running');
    assert.equal(initial.shellRunId, 'shell-run-1');
    assert.equal(initial.stdout, 'start');
    assert.equal(manager.liveCount(), 1);

    const listed = await manager.status('session-1');
    assert.equal(listed.kind, 'shell_run_list');
    assert.deepEqual(listed.shellRuns.map((run) => [run.shellRunId, run.status]), [['shell-run-1', 'running']]);

    const waited = await manager.wait('session-1', 'shell-run-1', 5_000);
    assert.equal(waited.status, 'completed');
    assert.equal(waited.stdout, 'startdone');
    assert.ok(waited.observedAt !== undefined);
    assert.equal(manager.liveCount(), 0);

    const afterObserve = await manager.status('session-1');
    assert.equal(afterObserve.kind, 'shell_run_list');
    assert.deepEqual(afterObserve.shellRuns, []);
  });

  test('cancels running ShellRuns only after the process has exited', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'maka-shell-run-'));
    const store = new MemoryShellRunStore();
    const manager = createManager(store);

    const initial = await manager.runBash(shellInput({
      cwd,
      command: 'printf "start"; sleep 5',
      yieldTimeMs: 250,
    }));
    assert.equal(initial.kind, 'shell_run');

    const cancelled = await manager.cancel('session-1', initial.shellRunId);
    assert.equal(cancelled.status, 'cancelled');
    assert.equal(cancelled.cancelled, true);
    assert.equal(cancelled.exitCode, 130);
    assert.ok(cancelled.completedAt !== undefined);
    assert.equal(manager.liveCount(), 0);
  });

  test('marks durable running records without live handles as orphaned', async () => {
    const store = new MemoryShellRunStore();
    const manager = createManager(store);
    await store.createShellRun(record({
      shellRunId: 'orphan-1',
      command: 'sleep 10',
      status: 'running',
    }));

    const recovered = await manager.recoverOrphanedSession('session-1');
    assert.equal(recovered, 1);

    const detail = await manager.status('session-1', 'orphan-1');
    assert.equal(detail.kind, 'shell_run');
    assert.equal(detail.status, 'orphaned');
    assert.match(detail.orphanedReason ?? '', /runtime restarted/);
    assert.ok(detail.observedAt !== undefined);
  });

  test('context summary lists metadata without stdout or stderr tails', async () => {
    const store = new MemoryShellRunStore();
    const manager = createManager(store);
    await store.createShellRun(record({
      shellRunId: 'running-1',
      command: 'printf "visible-command"',
      status: 'running',
      stdoutTail: 'stdout-secret',
      stderrTail: 'stderr-secret',
    }));

    const summary = await manager.buildContextSummary('session-1');
    assert.ok(summary?.includes('shellRunId=running-1'));
    assert.ok(summary?.includes('visible-command'));
    assert.ok(!summary?.includes('stdout-secret'));
    assert.ok(!summary?.includes('stderr-secret'));
    assert.ok(summary?.includes('Use ShellStatus'));
  });

  test('observing terminal ShellRuns does not compact the durable output tail', async () => {
    const store = new MemoryShellRunStore();
    const manager = createManager(store);
    const largeStdout = 'x'.repeat(80_000);
    await store.createShellRun(record({
      shellRunId: 'done-1',
      command: 'printf large',
      status: 'completed',
      exitCode: 0,
      completedAt: 2,
      stdoutTail: largeStdout,
    }));

    const detail = await manager.status('session-1', 'done-1');
    assert.equal(detail.kind, 'shell_run');
    assert.equal(detail.status, 'completed');
    assert.ok(detail.stdout.length < largeStdout.length);

    const stored = await store.readShellRun('session-1', 'done-1');
    assert.equal(stored.stdoutTail, largeStdout);
    assert.ok(stored.observedAt !== undefined);
  });
});

class MemoryShellRunStore implements ShellRunStore {
  private readonly records = new Map<string, Map<string, ShellRunRecord>>();

  constructor(private readonly options: { createDelayMs?: number } = {}) {}

  async createShellRun(record: ShellRunRecord): Promise<ShellRunRecord> {
    if (this.options.createDelayMs) await sleep(this.options.createDelayMs);
    const session = this.session(record.sessionId);
    if (session.has(record.shellRunId)) throw new Error(`ShellRun already exists: ${record.shellRunId}`);
    session.set(record.shellRunId, cloneRecord(record));
    return cloneRecord(record);
  }

  async updateShellRun(
    sessionId: string,
    shellRunId: string,
    patch: Partial<ShellRunRecord>,
  ): Promise<ShellRunRecord> {
    const session = this.session(sessionId);
    const current = session.get(shellRunId);
    if (!current) throw new Error(`ShellRun not found: ${shellRunId}`);
    const next = {
      ...current,
      ...patch,
      sessionId,
      shellRunId,
    };
    session.set(shellRunId, cloneRecord(next));
    return cloneRecord(next);
  }

  async readShellRun(sessionId: string, shellRunId: string): Promise<ShellRunRecord> {
    const current = this.session(sessionId).get(shellRunId);
    if (!current) throw new Error(`ShellRun not found: ${shellRunId}`);
    return cloneRecord(current);
  }

  async listSessionShellRuns(sessionId: string): Promise<ShellRunRecord[]> {
    return [...this.session(sessionId).values()].map(cloneRecord);
  }

  private session(sessionId: string): Map<string, ShellRunRecord> {
    let session = this.records.get(sessionId);
    if (!session) {
      session = new Map();
      this.records.set(sessionId, session);
    }
    return session;
  }
}

function createManager(store: ShellRunStore): ShellRunProcessManager {
  let id = 0;
  let now = 1_000;
  return new ShellRunProcessManager({
    store,
    newId: () => `shell-run-${++id}`,
    now: () => ++now,
    flushIntervalMs: 10,
    killGraceMs: 50,
  });
}

function shellInput(input: {
  cwd: string;
  command: string;
  yieldTimeMs?: number;
}) {
  return {
    sessionId: 'session-1',
    sourceRunId: 'run-1',
    sourceTurnId: 'turn-1',
    sourceToolCallId: 'tool-1',
    cwd: input.cwd,
    command: input.command,
    ...(input.yieldTimeMs !== undefined ? { yieldTimeMs: input.yieldTimeMs } : {}),
    emitOutput: () => {},
  };
}

function record(input: {
  shellRunId: string;
  command: string;
  status: ShellRunRecord['status'];
  exitCode?: number;
  completedAt?: number;
  stdoutTail?: string;
  stderrTail?: string;
}): ShellRunRecord {
  return {
    shellRunId: input.shellRunId,
    sessionId: 'session-1',
    sourceRunId: 'run-1',
    sourceTurnId: 'turn-1',
    sourceToolCallId: 'tool-1',
    cwd: '/workspace',
    command: input.command,
    status: input.status,
    ...(input.exitCode !== undefined ? { exitCode: input.exitCode } : {}),
    startedAt: 1,
    updatedAt: 1,
    ...(input.completedAt !== undefined ? { completedAt: input.completedAt } : {}),
    stdoutTail: input.stdoutTail ?? '',
    stderrTail: input.stderrTail ?? '',
    stdoutTruncated: false,
    stderrTruncated: false,
  };
}

function cloneRecord(record: ShellRunRecord): ShellRunRecord {
  return { ...record };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
