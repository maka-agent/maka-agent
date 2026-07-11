import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import type { ShellRunRecord, ShellRunStore } from '@maka/core';
import { ShellRunProcessManager, type ShellRunUpdate } from '../shell-run-manager.js';
import type { ShellPlan } from '../shell-detect.js';

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

    const record = await store.readShellRun('session-1', 'shell-run-1');
    assert.equal(record.status, 'completed');
    assert.equal(record.stdoutTail, 'hello');
    assert.ok(record.observedAt !== undefined);
    assert.equal(manager.liveCount(), 0);
  });

  test('spawns a detected PowerShell explicitly with non-interactive flags (not via shell:true)', async () => {
    // /bin/echo stands in for pwsh.exe: honouring the spawn plan means the
    // "shell" receives the flags plus the command as argv and echoes them back.
    const cwd = await mkdtemp(join(tmpdir(), 'maka-shell-run-'));
    const store = new MemoryShellRunStore();
    const manager = createManager(store);

    const result = await manager.runBash(shellInput({
      cwd,
      command: 'echo wired-marker',
      yieldTimeMs: 30_000,
      shell: { kind: 'pwsh', displayName: 'PowerShell 7 (pwsh)', exe: '/bin/echo' },
    }));

    assert.equal(result.kind, 'terminal');
    assert.equal(result.exitCode, 0);
    assert.ok(
      result.stdout.startsWith('-NoLogo -NoProfile -NonInteractive -Command echo wired-marker\n'),
      `flags then verbatim command, got: ${result.stdout}`,
    );
    assert.ok(result.stdout.includes('exit $LASTEXITCODE'), 'exit-code wrapper is part of the command argument');
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

  test('yields long commands as running ShellRuns and observes them through resource reads', async () => {
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
    assert.equal(initial.ref, 'maka://runtime/background-tasks/shell-run-1');
    assert.equal(initial.stdout, '');
    assert.equal(manager.liveCount(), 1);
    if (!initial.ref) throw new Error('expected ShellRun resource ref');

    const detail = await manager.readResource('session-1', initial.ref);
    assert.equal(detail.kind, 'shell_run');
    assert.equal(detail.status, 'running');
    assert.equal(detail.stdout, 'start');

    const summary = await manager.buildContextSummary('session-1');
    assert.match(summary ?? '', /ref=maka:\/\/runtime\/background-tasks\/shell-run-1/);

    await sleep(600);
    const completed = await manager.readResource('session-1', initial.ref);
    assert.equal(completed.kind, 'shell_run');
    assert.equal(completed.status, 'completed');
    assert.equal(completed.stdout, 'startdone');
    assert.equal(manager.liveCount(), 0);

    assert.equal(await manager.buildContextSummary('session-1'), undefined);
  });

  test('publishes the terminal state when a yielded ShellRun settles without a resource read', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'maka-shell-run-'));
    const store = new MemoryShellRunStore();
    const updates: ShellRunUpdate[] = [];
    const manager = createManager(store, (update) => updates.push(update));

    const initial = await manager.runBash(shellInput({
      cwd,
      command: 'printf "start"; sleep 0.5; printf "done"',
      yieldTimeMs: 250,
    }));
    assert.equal(initial.kind, 'shell_run');
    assert.equal(initial.status, 'running');

    await sleep(600);
    const terminal = updates.find((update) => update.result.status === 'completed');
    assert.equal(terminal?.sessionId, 'session-1');
    assert.equal(terminal?.sourceToolCallId, 'tool-1');
    assert.equal(terminal?.result.stdout, 'startdone');
    assert.equal(terminal?.result.exitCode, 0);
  });

  test('keeps terminal updatedAt after queued running flushes', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'maka-shell-run-'));
    const store = new MemoryShellRunStore({ updateDelayMs: 300 });
    const updates: ShellRunUpdate[] = [];
    const manager = createManager(store, (update) => updates.push(update));

    const initial = await manager.runBash(shellInput({
      cwd,
      command: 'printf "start"; sleep 0.1; printf "middle"; sleep 0.1',
      yieldTimeMs: 50,
    }));
    assert.equal(initial.kind, 'shell_run');

    await sleep(750);
    const latestRunning = updates.filter((update) => update.result.status === 'running').at(-1);
    const terminal = updates.find((update) => update.result.status === 'completed');
    assert.ok(latestRunning);
    assert.ok(terminal);
    assert.ok(terminal.result.updatedAt >= latestRunning.result.updatedAt);
  });

  test('persists stdout as the latest output stream when it follows stderr', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'maka-shell-run-'));
    const store = new MemoryShellRunStore();
    const updates: ShellRunUpdate[] = [];
    const manager = createManager(store, (update) => updates.push(update));

    const initial = await manager.runBash(shellInput({
      cwd,
      command: 'printf "warning\\n" >&2; sleep 0.5; printf "99%%\\n"',
      yieldTimeMs: 250,
    }));
    assert.equal(initial.kind, 'shell_run');

    await sleep(600);
    const terminal = updates.find((update) => update.result.status === 'completed');
    assert.equal(terminal?.result.latestOutputStream, 'stdout');
    assert.equal(
      (await store.readShellRun('session-1', 'shell-run-1')).latestOutputStream,
      'stdout',
    );
  });

  test('persists stderr as the latest output stream when it follows stdout', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'maka-shell-run-'));
    const store = new MemoryShellRunStore();
    const updates: ShellRunUpdate[] = [];
    const manager = createManager(store, (update) => updates.push(update));

    const initial = await manager.runBash(shellInput({
      cwd,
      command: 'printf "99%%\\n"; sleep 0.5; printf "warning\\n" >&2',
      yieldTimeMs: 250,
    }));
    assert.equal(initial.kind, 'shell_run');

    await sleep(600);
    const terminal = updates.find((update) => update.result.status === 'completed');
    assert.equal(terminal?.result.latestOutputStream, 'stderr');
  });

  test('publishes retained output after a ShellRun yields', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'maka-shell-run-'));
    const store = new MemoryShellRunStore();
    const updates: ShellRunUpdate[] = [];
    const manager = createManager(store, (update) => updates.push(update));

    const initial = await manager.runBash(shellInput({
      cwd,
      command: 'printf "start"; sleep 5',
      yieldTimeMs: 250,
    }));
    assert.equal(initial.kind, 'shell_run');
    const running = updates.find((update) => update.result.status === 'running');
    assert.equal(running?.result.stdout, 'start');

    await manager.terminateAll();
  });

  test('stops running ShellRuns by runtime ref only after the process has exited', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'maka-shell-run-'));
    const store = new MemoryShellRunStore();
    const manager = createManager(store);

    const initial = await manager.runBash(shellInput({
      cwd,
      command: 'printf "start"; sleep 5',
      yieldTimeMs: 250,
    }));
    assert.equal(initial.kind, 'shell_run');
    if (!initial.ref) throw new Error('expected ShellRun resource ref');

    const cancelled = await manager.stopResource('session-1', initial.ref);
    assert.equal(cancelled.status, 'cancelled');
    assert.equal(cancelled.cancelled, true);
    assert.equal(cancelled.exitCode, 130);
    assert.ok(cancelled.completedAt !== undefined);
    assert.equal(manager.liveCount(), 0);
  });

  test('reads a just-finished ShellRun without orphaning its durable record', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'maka-shell-run-'));
    const store = new MemoryShellRunStore({ updateDelayMs: 300 });
    const manager = createManager(store);

    const initial = await manager.runBash(shellInput({
      cwd,
      command: 'printf "start"; sleep 0.2; printf "done"',
      yieldTimeMs: 50,
    }));
    assert.equal(initial.kind, 'shell_run');
    assert.equal(initial.ref, 'maka://runtime/background-tasks/shell-run-1');

    const detail = await manager.readResource('session-1', initial.ref);
    assert.equal(detail.status, 'completed');
    assert.equal(detail.stdout, 'startdone');

    const stored = await store.readShellRun('session-1', 'shell-run-1');
    assert.equal(stored.status, 'completed');
    assert.equal(stored.orphanedReason, undefined);
  });

  test('stopping a just-finished ShellRun observes completion instead of orphaning it', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'maka-shell-run-'));
    const store = new MemoryShellRunStore({ updateDelayMs: 300 });
    const manager = createManager(store);

    const initial = await manager.runBash(shellInput({
      cwd,
      command: 'sleep 0.2',
      yieldTimeMs: 50,
    }));
    assert.equal(initial.kind, 'shell_run');
    assert.equal(initial.ref, 'maka://runtime/background-tasks/shell-run-1');

    const stopped = await manager.stopResource('session-1', initial.ref);
    assert.equal(stopped.status, 'completed');
    assert.equal(stopped.cancelled, false);

    const stored = await store.readShellRun('session-1', 'shell-run-1');
    assert.equal(stored.status, 'completed');
    assert.equal(stored.orphanedReason, undefined);
  });

  test('rejects list and malformed runtime resource refs', async () => {
    const store = new MemoryShellRunStore();
    const manager = createManager(store);

    await assert.rejects(
      manager.readResource('session-1', 'maka://runtime/background-tasks'),
      /Unsupported runtime resource ref/,
    );
    await assert.rejects(
      manager.readResource('session-1', 'maka://runtime/background-tasks/shell-run-1?view=tail'),
      /Unsupported runtime resource ref/,
    );
    await assert.rejects(
      manager.readResource('session-1', 'maka://runtime/background-tasks/shell-run-1#tail'),
      /Unsupported runtime resource ref/,
    );
  });

  test('aborting before the initial yield cancels instead of backgrounding', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'maka-shell-run-'));
    const store = new MemoryShellRunStore();
    const manager = createManager(store);
    const abort = new AbortController();

    const result = await manager.runBash(shellInput({
      cwd,
      command: 'printf "start"; sleep 5',
      yieldTimeMs: 30_000,
      abortSignal: abort.signal,
      emitOutput: () => abort.abort(),
    }));

    assert.equal(result.kind, 'terminal');
    assert.equal(result.status, 'cancelled');
    assert.equal(result.exitCode, 130);
    assert.equal(result.stdout, 'start');
    assert.equal(manager.liveCount(), 0);

    assert.equal(await manager.buildContextSummary('session-1'), undefined);
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

    const detail = await manager.readResource('session-1', 'maka://runtime/background-tasks/orphan-1');
    assert.equal(detail.status, 'orphaned');
    assert.match(detail.orphanedReason ?? '', /runtime restarted/);
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
    assert.ok(summary?.includes('ref=maka://runtime/background-tasks/running-1'));
    assert.ok(summary?.includes('visible-command'));
    assert.ok(!summary?.includes('stdout-secret'));
    assert.ok(!summary?.includes('stderr-secret'));
    assert.ok(summary?.includes('Use Read'));
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

    const detail = await manager.readResource('session-1', 'maka://runtime/background-tasks/done-1');
    assert.equal(detail.status, 'completed');
    assert.ok(detail.stdout.length < largeStdout.length);

    const stored = await store.readShellRun('session-1', 'done-1');
    assert.equal(stored.stdoutTail, largeStdout);
    assert.ok(stored.observedAt !== undefined);
  });
});

class MemoryShellRunStore implements ShellRunStore {
  private readonly records = new Map<string, Map<string, ShellRunRecord>>();

  constructor(private readonly options: { createDelayMs?: number; updateDelayMs?: number } = {}) {}

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
    if (this.options.updateDelayMs) await sleep(this.options.updateDelayMs);
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

function createManager(
  store: ShellRunStore,
  onShellRunUpdate?: (update: ShellRunUpdate) => void,
): ShellRunProcessManager {
  let id = 0;
  let now = 1_000;
  const input = {
    store,
    newId: () => `shell-run-${++id}`,
    now: () => ++now,
    flushIntervalMs: 10,
    killGraceMs: 50,
    ...(onShellRunUpdate ? { onShellRunUpdate } : {}),
  };
  return new ShellRunProcessManager(input);
}

function shellInput(input: {
  cwd: string;
  command: string;
  yieldTimeMs?: number;
  abortSignal?: AbortSignal;
  emitOutput?: (stream: 'stdout' | 'stderr', chunk: string) => void;
  shell?: ShellPlan;
}) {
  return {
    sessionId: 'session-1',
    sourceRunId: 'run-1',
    sourceTurnId: 'turn-1',
    sourceToolCallId: 'tool-1',
    cwd: input.cwd,
    command: input.command,
    ...(input.yieldTimeMs !== undefined ? { yieldTimeMs: input.yieldTimeMs } : {}),
    ...(input.abortSignal !== undefined ? { abortSignal: input.abortSignal } : {}),
    ...(input.shell !== undefined ? { shell: input.shell } : {}),
    emitOutput: input.emitOutput ?? (() => {}),
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
