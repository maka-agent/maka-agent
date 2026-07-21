import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, open, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import type { ShellRunPatch, ShellRunRecord } from '@maka/core';
import {
  authenticateInteractiveShellRunWriter,
  createShellRunStore,
  openInteractiveShellRunStoreForWrite,
} from '../shell-run-store.js';
import {
  resolveStorageRoot,
  StorageRootAuthorityError,
  tryAcquireInteractiveRootOwner,
} from '../root-authority.js';

describe('ShellRunStore', () => {
  it('creates, updates, reads, and lists ShellRuns under a session', async () => {
    await withStore(async (store, root) => {
      await store.createShellRun(record({ shellRunId: 'shell-2', startedAt: 2, updatedAt: 2 }));
      await store.createShellRun(
        record({ shellRunId: 'shell-1', status: 'starting', startedAt: 1, updatedAt: 1 }),
      );

      const running = await store.updateShellRun('session-1', 'shell-1', {
        status: 'running',
        updatedAt: 2,
      });

      const updated = await store.updateShellRun('session-1', 'shell-1', {
        status: 'completed',
        exitCode: 0,
        output: pipeOutput({ stdout: 'done', latestStream: 'stdout' }),
        completedAt: 10,
        updatedAt: 10,
      });

      assert.equal(updated.status, 'completed');
      assert.equal(updated.output.mode === 'pipes' ? updated.output.stdout : '', 'done');
      assert.equal(
        updated.output.mode === 'pipes' ? updated.output.latestStream : undefined,
        'stdout',
      );
      assert.equal(running.revision, 2);
      assert.equal(updated.revision, 3);
      assert.deepEqual(
        (await store.listSessionShellRuns('session-1')).map((run) => run.shellRunId),
        ['shell-1', 'shell-2'],
      );
      assert.equal((await store.readShellRun('session-1', 'shell-1')).completedAt, 10);
      assert.equal(
        JSON.parse(
          await readFile(
            join(root, 'sessions', 'session-1', 'shell-runs', 'shell-1', 'shell-run.json'),
            'utf8',
          ),
        ).shellRunId,
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

      const raw = await readFile(
        join(root, 'sessions', 'session-1', 'shell-runs', 'shell-1', 'shell-run.json'),
        'utf8',
      );
      assert.equal(JSON.parse(raw).command, 'first');
    });
  });

  it('round-trips sandbox execution and one-shot escalation audit facts', async () => {
    await withStore(async (store) => {
      const created = await store.createShellRun({
        ...record({ shellRunId: 'shell-escalated' }),
        sandboxExecution: { type: 'none', enforced: false },
        sandboxEscalation: { commandHash: 'command-hash', unsandboxed: true },
      });

      assert.deepEqual(created.sandboxExecution, { type: 'none', enforced: false });
      assert.deepEqual(created.sandboxEscalation, {
        commandHash: 'command-hash',
        unsandboxed: true,
      });
      assert.deepEqual(
        (await store.readShellRun('session-1', 'shell-escalated')).sandboxEscalation,
        created.sandboxEscalation,
      );
    });
  });

  it('rejects inconsistent sandbox execution audit facts', async () => {
    await withStore(async (store) => {
      await assert.rejects(
        () =>
          store.createShellRun({
            ...record({ shellRunId: 'shell-invalid-enforcement' }),
            sandboxExecution: { type: 'macos-seatbelt', enforced: false },
          }),
        /malformed fields/,
      );
      await assert.rejects(
        () =>
          store.createShellRun({
            ...record({ shellRunId: 'shell-invalid-escalation' }),
            sandboxExecution: { type: 'macos-seatbelt', enforced: true },
            sandboxEscalation: { commandHash: 'command-hash', unsandboxed: true },
          }),
        /malformed fields/,
      );
    });
  });

  it('increments revision only when durable state changes', async () => {
    await withStore(async (store) => {
      await store.createShellRun(record({ shellRunId: 'shell-1' }));

      const unchanged = await store.updateShellRun('session-1', 'shell-1', {
        exitCode: undefined,
        failureMessage: undefined,
      });
      const changed = await store.updateShellRun('session-1', 'shell-1', {
        output: pipeOutput({ stdout: 'next' }),
        updatedAt: 2,
      });

      assert.equal(unchanged.revision, 1);
      assert.equal(changed.revision, 2);
    });
  });

  it('retries lifecycle intent durably after an output-only successor', async (t) => {
    if (process.platform === 'win32') {
      t.skip('POSIX directory durability only');
      return;
    }
    await withStore(async (store, root) => {
      await store.createShellRun(record({ shellRunId: 'shell-1', status: 'starting' }));
      const runDir = join(root, 'sessions', 'session-1', 'shell-runs', 'shell-1');
      await chmod(runDir, 0o300);
      try {
        try {
          const handle = await open(runDir, 'r');
          await handle.close();
          t.skip('Directory permissions do not block the durability barrier');
          return;
        } catch (error) {
          if (!isPermissionError(error)) throw error;
        }

        const lifecyclePatch: ShellRunPatch = {
          status: 'running',
          output: pipeOutput({ stdout: 'lifecycle' }),
          updatedAt: 2,
        };
        await assert.rejects(
          () => store.updateShellRun('session-1', 'shell-1', lifecyclePatch),
          isPermissionError,
        );

        const successor = await store.updateShellRun('session-1', 'shell-1', {
          output: pipeOutput({ stdout: 'successor' }),
          updatedAt: 3,
        });
        assert.equal(successor.output.mode === 'pipes' ? successor.output.stdout : '', 'successor');

        await assert.rejects(
          () => store.updateShellRun('session-1', 'shell-1', lifecyclePatch),
          isPermissionError,
        );
      } finally {
        await chmod(runDir, 0o700);
      }
    });
  });

  it('records only the first terminal observation under concurrent updates', async () => {
    await withStore(async (store) => {
      await store.createShellRun(
        record({
          shellRunId: 'shell-1',
          status: 'completed',
          completedAt: 2,
          exitCode: 0,
        }),
      );

      const [first, second] = await Promise.all([
        store.updateShellRun('session-1', 'shell-1', { observedAt: 10 }),
        store.updateShellRun('session-1', 'shell-1', { observedAt: 20 }),
      ]);

      assert.equal(first.observedAt, 10);
      assert.equal(second.observedAt, 10);
      assert.equal(second.revision, 2);
      assert.equal((await store.readShellRun('session-1', 'shell-1')).revision, 2);
    });
  });

  it('allows starting launch failures and rejects status regression or terminal rewrites', async () => {
    await withStore(async (store) => {
      await store.createShellRun(record({ shellRunId: 'failed-launch', status: 'starting' }));
      const failed = await store.updateShellRun('session-1', 'failed-launch', {
        status: 'failed',
        failureMessage: 'spawn failed',
        completedAt: 2,
        updatedAt: 2,
      });
      assert.equal(failed.status, 'failed');

      await store.createShellRun(record({ shellRunId: 'lost-launch', status: 'starting' }));
      const orphaned = await store.updateShellRun('session-1', 'lost-launch', {
        status: 'orphaned',
        failureMessage: 'host restarted before launch outcome was known',
        completedAt: 2,
        updatedAt: 2,
      });
      assert.equal(orphaned.status, 'orphaned');

      await assert.rejects(
        () =>
          store.updateShellRun('session-1', 'failed-launch', {
            status: 'running',
            completedAt: undefined,
            failureMessage: undefined,
            updatedAt: 3,
          }),
        /Invalid ShellRun status transition: failed -> running/,
      );
      await assert.rejects(
        () =>
          store.updateShellRun('session-1', 'failed-launch', {
            failureMessage: 'different failure',
            updatedAt: 3,
          }),
        /ShellRun terminal outcome is immutable: failed/,
      );
    });
  });

  it('keeps launch identity and output mode immutable', async () => {
    await withStore(async (store) => {
      await store.createShellRun(record({ shellRunId: 'shell-1' }));

      await assert.rejects(
        () =>
          store.updateShellRun('session-1', 'shell-1', {
            command: 'replacement',
          } as unknown as ShellRunPatch),
        /ShellRun field is immutable: command/,
      );
      await assert.rejects(
        () =>
          store.updateShellRun('session-1', 'shell-1', {
            output: {
              mode: 'pty',
              screen: '',
              scrollback: '',
              cols: 80,
              rows: 24,
              cursor: { x: 0, y: 0, visible: true },
              alternateScreen: false,
              truncated: false,
              redacted: false,
            },
          }),
        /ShellRun output mode is immutable: pipes/,
      );
      await assert.rejects(
        () =>
          store.createShellRun({
            ...record({ shellRunId: 'shell-with-operation' }),
            operation: { kind: 'stop', applied: true },
          } as unknown as ShellRunRecord),
        /malformed fields/,
      );
    });
  });

  it('rejects malformed records and ignores malformed folders while listing', async () => {
    await withStore(async (store, root) => {
      await store.createShellRun(record({ shellRunId: 'shell-good' }));
      const badPath = join(
        root,
        'sessions',
        'session-1',
        'shell-runs',
        'shell-bad',
        'shell-run.json',
      );
      await mkdir(join(root, 'sessions', 'session-1', 'shell-runs', 'shell-bad'), {
        recursive: true,
      });
      await writeFile(
        badPath,
        JSON.stringify({
          shellRunId: 'shell-bad',
          sessionId: 'session-1',
          status: 'mystery',
        }) + '\n',
        'utf8',
      );

      await assert.rejects(
        () => store.readShellRun('session-1', 'shell-bad'),
        /Invalid ShellRun record for shell-bad: malformed fields/,
      );
      assert.deepEqual(
        (await store.listSessionShellRuns('session-1')).map((run) => run.shellRunId),
        ['shell-good'],
      );
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
        () =>
          store.updateShellRun('session-1', 'running-1', {
            exitCode: 0,
            updatedAt: 2,
          }),
        /inconsistent state fields/,
      );
      await assert.rejects(
        () =>
          store.updateShellRun('session-1', 'running-1', {
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

  it('binds the authenticated interactive writer to the live root lease', async () => {
    const root = await mkdtemp(join(tmpdir(), 'maka-shell-run-authority-'));
    const capability = await resolveStorageRoot({ path: root, kind: 'interactive' });
    const owner = await tryAcquireInteractiveRootOwner(capability);
    assert.ok(owner);
    try {
      const writer = await openInteractiveShellRunStoreForWrite(owner.lease);
      assert.equal(authenticateInteractiveShellRunWriter(writer), writer);
      await writer.createShellRun(record({ shellRunId: 'lease-bound', status: 'starting' }));
      assert.equal((await writer.readShellRun('session-1', 'lease-bound')).status, 'starting');

      await owner.close();
      await assert.rejects(
        () => writer.listSessionShellRuns('session-1'),
        (error: unknown) =>
          error instanceof StorageRootAuthorityError && error.code === 'invalid_lease',
      );
      await assert.rejects(
        () =>
          writer.updateShellRun('session-1', 'lease-bound', {
            status: 'running',
            updatedAt: 2,
          }),
        (error: unknown) =>
          error instanceof StorageRootAuthorityError && error.code === 'invalid_lease',
      );
    } finally {
      await owner.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});

async function withStore(
  fn: (store: ReturnType<typeof createShellRunStore>, root: string) => Promise<void>,
): Promise<void> {
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
  completedAt?: number;
  exitCode?: number;
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
    ...(input.completedAt !== undefined ? { completedAt: input.completedAt } : {}),
    ...(input.exitCode !== undefined ? { exitCode: input.exitCode } : {}),
    revision: 1,
    output: pipeOutput(),
  };
}

function pipeOutput(
  input: { stdout?: string; stderr?: string; latestStream?: 'stdout' | 'stderr' } = {},
): Extract<ShellRunRecord['output'], { mode: 'pipes' }> {
  return {
    mode: 'pipes',
    stdout: input.stdout ?? '',
    stderr: input.stderr ?? '',
    ...(input.latestStream ? { latestStream: input.latestStream } : {}),
    stdoutTruncated: false,
    stderrTruncated: false,
    redacted: false,
  };
}

function isPermissionError(error: unknown): boolean {
  return (
    (error as NodeJS.ErrnoException).code === 'EACCES' ||
    (error as NodeJS.ErrnoException).code === 'EPERM'
  );
}
