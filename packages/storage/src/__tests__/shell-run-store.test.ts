import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import type { ShellRunRecord } from '@maka/core';
import { createShellRunStore } from '../shell-run-store.js';

describe('ShellRunStore', () => {
  it('creates, updates, reads, and lists ShellRuns under a session', async () => {
    await withStore(async (store, root) => {
      await store.createShellRun(record({ shellRunId: 'shell-2', startedAt: 2, updatedAt: 2 }));
      await store.createShellRun(record({ shellRunId: 'shell-1', startedAt: 1, updatedAt: 1 }));

      const updated = await store.updateShellRun('session-1', 'shell-1', {
        status: 'completed',
        exitCode: 0,
        stdoutTail: 'done',
        completedAt: 10,
        updatedAt: 10,
      });

      assert.equal(updated.status, 'completed');
      assert.equal(updated.stdoutTail, 'done');
      assert.deepEqual((await store.listSessionShellRuns('session-1')).map((run) => run.shellRunId), ['shell-1', 'shell-2']);
      assert.equal((await store.readShellRun('session-1', 'shell-1')).completedAt, 10);
      assert.equal(
        JSON.parse(await readFile(join(root, 'sessions', 'session-1', 'shell-runs', 'shell-1', 'shell-run.json'), 'utf8')).shellRunId,
        'shell-1',
      );
    });
  });

  it('rejects duplicate create without overwriting the existing record', async () => {
    await withStore(async (store, root) => {
      await store.createShellRun(record({ shellRunId: 'shell-1', command: 'first' }));

      await assert.rejects(
        () => store.createShellRun(record({ shellRunId: 'shell-1', command: 'second' })),
        /ShellRun already exists: shell-1/,
      );

      const raw = await readFile(join(root, 'sessions', 'session-1', 'shell-runs', 'shell-1', 'shell-run.json'), 'utf8');
      assert.equal(JSON.parse(raw).command, 'first');
    });
  });

  it('rejects malformed records and ignores malformed folders while listing', async () => {
    await withStore(async (store, root) => {
      await store.createShellRun(record({ shellRunId: 'shell-good' }));
      const badPath = join(root, 'sessions', 'session-1', 'shell-runs', 'shell-bad', 'shell-run.json');
      await mkdir(join(root, 'sessions', 'session-1', 'shell-runs', 'shell-bad'), { recursive: true });
      await writeFile(badPath, JSON.stringify({
        shellRunId: 'shell-bad',
        sessionId: 'session-1',
        status: 'mystery',
      }) + '\n', 'utf8');

      await assert.rejects(
        () => store.readShellRun('session-1', 'shell-bad'),
        /Invalid ShellRun record for shell-bad: malformed fields/,
      );
      assert.deepEqual((await store.listSessionShellRuns('session-1')).map((run) => run.shellRunId), ['shell-good']);
    });
  });

  it('rejects inconsistent ShellRun state fields', async () => {
    await withStore(async (store) => {
      await assert.rejects(
        () => store.createShellRun(record({ shellRunId: 'bad-completed', status: 'completed' })),
        /inconsistent state fields/,
      );

      await store.createShellRun(record({ shellRunId: 'running-1' }));
      await assert.rejects(
        () => store.updateShellRun('session-1', 'running-1', {
          exitCode: 0,
          updatedAt: 2,
        }),
        /inconsistent state fields/,
      );
      await assert.rejects(
        () => store.updateShellRun('session-1', 'running-1', {
          status: 'completed',
          updatedAt: 3,
        }),
        /inconsistent state fields/,
      );
    });
  });

  it('rejects unsafe session and shell run ids', async () => {
    await withStore(async (store) => {
      await assert.rejects(
        () => store.createShellRun(record({ sessionId: '../outside', shellRunId: 'shell-1' })),
        /Invalid session id/,
      );
      await assert.rejects(
        () => store.createShellRun(record({ sessionId: 'session-1', shellRunId: '../outside' })),
        /Invalid shell run id/,
      );
    });
  });
});

async function withStore(fn: (store: ReturnType<typeof createShellRunStore>, root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'maka-shell-run-store-'));
  try {
    await fn(createShellRunStore(root), root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function record(input: {
  sessionId?: string;
  shellRunId: string;
  command?: string;
  status?: ShellRunRecord['status'];
  startedAt?: number;
  updatedAt?: number;
}): ShellRunRecord {
  return {
    shellRunId: input.shellRunId,
    sessionId: input.sessionId ?? 'session-1',
    sourceRunId: 'run-1',
    sourceTurnId: 'turn-1',
    sourceToolCallId: 'tool-1',
    cwd: '/workspace',
    command: input.command ?? 'printf "ok"',
    status: input.status ?? 'running',
    startedAt: input.startedAt ?? 1,
    updatedAt: input.updatedAt ?? 1,
    stdoutTail: '',
    stderrTail: '',
    stdoutTruncated: false,
    stderrTruncated: false,
  };
}
