import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import {
  isTerminalShellRunStatus,
  type ShellRunStore,
} from '@maka/core';
import { createShellRunStore } from '@maka/storage';
import {
  RUNTIME_RESOURCE_COMMAND_MAX_BYTES,
  RUNTIME_RESOURCE_RESULT_MAX_BYTES,
} from '../protocol/index.js';
import type { ConnectionContext } from '../server/operation-dispatcher.js';
import { HostRuntimeResourceCoordinator } from '../server/runtime-resource-coordinator.js';

const TEMPORARY_WORKSPACES = new Set<string>();

after(async () => {
  await Promise.all(
    [...TEMPORARY_WORKSPACES].map((path) => rm(path, { recursive: true, force: true })),
  );
});

test('background residency spans calls, releases at terminal, and wire reads do not observe', async () => {
  const fixture = await createFixture();
  const marker = join(fixture.root, 'release');
  const run = await fixture.coordinator.runBackgroundBash(
    shellInput(
      fixture.root,
      nodeCommand(`
      const { existsSync } = require('node:fs');
      const marker = ${JSON.stringify(marker)};
      const timer = setInterval(() => {
        if (!existsSync(marker)) return;
        clearInterval(timer);
        process.stdout.write('released\\n');
      }, 10);
    `),
    ),
  );

  assert.equal(run.status, 'running');
  assert.equal(fixture.residency.count, 1);
  const query = await fixture.coordinator.handlers['resource.query'](
    { sessionId: 'session-1', ref: run.ref },
    context('query-client'),
  );
  const read = await fixture.coordinator.handlers['resource.read'](
    { sessionId: 'session-1', ref: run.ref },
    context('query-client'),
  );
  assert.equal(query.ok, true);
  assert.equal(read.ok, true);
  assert.equal(
    (await fixture.store.readShellRun('session-1', shellRunId(run.ref))).observedAt,
    undefined,
  );

  await writeFile(marker, 'release');
  await waitUntil(() => fixture.residency.count === 0);
  await waitForResource(fixture.coordinator, run.ref, (status) => status === 'completed');

  await fixture.coordinator.handlers['resource.query'](
    { sessionId: 'session-1', ref: run.ref },
    context('query-client'),
  );
  await fixture.coordinator.handlers['resource.read'](
    { sessionId: 'session-1', ref: run.ref },
    context('query-client'),
  );
  assert.equal(
    (await fixture.store.readShellRun('session-1', shellRunId(run.ref))).observedAt,
    undefined,
  );
  await fixture.coordinator.close();
});

for (const terminalPersistenceFailure of ['once', 'persistent'] as const) {
  test(`native settlement releases residency after ${terminalPersistenceFailure} final persistence failure`, async () => {
    const fixture = await createFixture({
      decorateStore: (backing) => {
        let failed = false;
        return decorateStore(backing, {
          updateShellRun: async (sessionId, shellRunId, patch) => {
            if (
              patch.status &&
              isTerminalShellRunStatus(patch.status) &&
              (terminalPersistenceFailure === 'persistent' || !failed)
            ) {
              failed = true;
              throw new Error('injected final persistence failure');
            }
            return backing.updateShellRun(sessionId, shellRunId, patch);
          },
        });
      },
    });
    const releasePath = join(fixture.root, 'settle');
    try {
      const run = await fixture.coordinator.runBackgroundBash(
        shellInput(
          fixture.root,
          nodeCommand(`
            const { existsSync } = require('node:fs');
            const timer = setInterval(() => {
              if (!existsSync(${JSON.stringify(releasePath)})) return;
              clearInterval(timer);
            }, 10);
          `),
        ),
      );
      assert.equal(run.status, 'running');
      assert.equal(fixture.residency.count, 1);

      await writeFile(releasePath, 'settle');
      await waitUntil(
        () => fixture.residency.count === 0 && fixture.coordinator.shellRuns.liveCount() === 0,
      );
      assert.equal(fixture.residency.acquired, 1);
      assert.equal(fixture.residency.released, 1);
      if (terminalPersistenceFailure === 'once') {
        await fixture.coordinator.close();
      } else {
        await assert.rejects(
          fixture.coordinator.close(),
          /Runtime resource coordinator failed to close cleanly/,
        );
      }
    } finally {
      await fixture.coordinator.close().catch(() => undefined);
    }
  });
}

test('persistent startup terminalization failure releases residency and makes close non-clean', async () => {
  const fixture = await createFixture({
    decorateStore: (backing) =>
      decorateStore(backing, {
        updateShellRun: async (sessionId, shellRunId, patch) => {
          if (patch.status === 'running') {
            throw new Error('injected running persistence failure');
          }
          if (patch.status === 'failed') {
            throw new Error('injected startup terminalization failure');
          }
          return backing.updateShellRun(sessionId, shellRunId, patch);
        },
      }),
  });
  try {
    await assert.rejects(
      fixture.coordinator.runBackgroundBash(
        shellInput(fixture.root, nodeCommand('setInterval(() => {}, 1000);')),
      ),
      /injected running persistence failure.*injected startup terminalization failure/,
    );

    assert.equal((await fixture.store.readShellRun('session-1', 'shell-run-1')).status, 'starting');
    assert.equal(fixture.coordinator.shellRuns.liveCount(), 0);
    assert.equal(fixture.residency.count, 0);
    assert.equal(fixture.residency.acquired, 1);
    assert.equal(fixture.residency.released, 1);
    await assert.rejects(
      fixture.coordinator.close(),
      /Runtime resource coordinator failed to close cleanly/,
    );
  } finally {
    await fixture.coordinator.close().catch(() => undefined);
  }
});

test('close waits for an admitted background launch blocked in durable creation', async () => {
  const createEntered = deferred<void>();
  const allowCreate = deferred<void>();
  const fixture = await createFixture({
    decorateStore: (backing) =>
      decorateStore(backing, {
        createShellRun: async (record) => {
          createEntered.resolve();
          await allowCreate.promise;
          return backing.createShellRun(record);
        },
      }),
  });
  const launch = fixture.coordinator.runBackgroundBash(
    shellInput(fixture.root, nodeCommand('setInterval(() => {}, 1000);')),
  );
  await createEntered.promise;

  fixture.coordinator.beginDrain();
  const closing = fixture.coordinator.close();
  let closeSettled = false;
  void closing.then(
    () => {
      closeSettled = true;
    },
    () => {
      closeSettled = true;
    },
  );
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(closeSettled, false);
  assert.equal(fixture.residency.count, 1);

  allowCreate.resolve();
  await assert.rejects(launch, /shutting down/);
  await closing;
  assert.equal(fixture.residency.count, 0);
  assert.equal(fixture.residency.released, 1);
});

test('wire projections bound long metadata and large pipe streams without observing stop', async () => {
  const fixture = await createFixture();
  const script = nodeCommand(`
    process.stdout.write('o'.repeat(70_000) + 'OUT-END\\n');
    process.stderr.write('e'.repeat(70_000) + 'ERR-END\\n');
    setInterval(() => {}, 1000);
  `);
  const command = `${script} # ${'metadata'.repeat(2_000)}`;
  try {
    const run = await fixture.coordinator.runBackgroundBash(shellInput(fixture.root, command));
    await waitUntil(async () => {
      const outcome = await fixture.coordinator.handlers['resource.read'](
        { sessionId: 'session-1', ref: run.ref },
        context('wire-reader'),
      );
      return (
        outcome.ok &&
        outcome.result.mode === 'pipes' &&
        outcome.result.output.stdout.includes('OUT-END') &&
        outcome.result.output.stderr.includes('ERR-END')
      );
    });
    const readResult = await fixture.coordinator.handlers['resource.read'](
      { sessionId: 'session-1', ref: run.ref },
      context('wire-reader'),
    );
    assert.ok(readResult.ok);
    if (!readResult.ok) return;
    assert.equal(readResult.result.mode, 'pipes');
    if (readResult.result.mode !== 'pipes') return;
    assert.ok(
      Buffer.byteLength(readResult.result.cmd, 'utf8') <= RUNTIME_RESOURCE_COMMAND_MAX_BYTES,
    );
    assert.ok(jsonBytes(readResult.result) <= RUNTIME_RESOURCE_RESULT_MAX_BYTES);
    assert.equal(readResult.result.output.stdoutTruncated, true);
    assert.equal(readResult.result.output.stderrTruncated, true);

    const queried = await fixture.coordinator.handlers['resource.query'](
      { sessionId: 'session-1', ref: run.ref },
      context('wire-reader'),
    );
    assert.equal(queried.ok, true);
    if (queried.ok) assert.ok(jsonBytes(queried.result) <= RUNTIME_RESOURCE_RESULT_MAX_BYTES);

    const stopped = await fixture.coordinator.handlers['resource.stop'](
      { sessionId: 'session-1', ref: run.ref },
      context('wire-reader'),
    );
    assert.equal(stopped.ok, true);
    if (stopped.ok) assert.ok(jsonBytes(stopped.result) <= RUNTIME_RESOURCE_RESULT_MAX_BYTES);
    assert.equal(
      (await fixture.store.readShellRun('session-1', shellRunId(run.ref))).observedAt,
      undefined,
    );
  } finally {
    await fixture.coordinator.close();
  }
});

test('wire metadata bounds JSON-escaped control characters for query and read', async () => {
  const fixture = await createFixture();
  const command = `${nodeCommand('setInterval(() => {}, 1000);')} # ${'\u0001'.repeat(12_000)}`;
  try {
    const run = await fixture.coordinator.runBackgroundBash(shellInput(fixture.root, command));
    const queried = await fixture.coordinator.handlers['resource.query'](
      { sessionId: 'session-1', ref: run.ref },
      context('escaped-metadata-reader'),
    );
    assert.equal(queried.ok, true);
    if (!queried.ok) return;
    assert.ok(jsonBytes(queried.result) <= RUNTIME_RESOURCE_RESULT_MAX_BYTES);

    const read = await fixture.coordinator.handlers['resource.read'](
      { sessionId: 'session-1', ref: run.ref },
      context('escaped-metadata-reader'),
    );
    assert.equal(read.ok, true);
    if (!read.ok) return;
    assert.ok(jsonBytes(read.result) <= RUNTIME_RESOURCE_RESULT_MAX_BYTES);
  } finally {
    await fixture.coordinator.close();
  }
});

test('PTY controller ownership transfers after release and disconnect while cursors track snapshots', {
  skip: process.platform === 'win32' ? 'PTY test requires POSIX' : false,
}, async () => {
  const fixture = await createFixture();
  try {
    const run = await fixture.coordinator.runBackgroundBash({
      ...shellInput(
        fixture.root,
        nodeCommand(`
          process.stdin.setRawMode?.(true);
          process.stdin.setEncoding('utf8');
          process.stdout.write('READY\\n');
          process.stdin.on('data', (chunk) => process.stdout.write('ECHO:' + chunk));
          setInterval(() => {}, 1000);
        `),
      ),
      pty: true,
    });
    const firstSnapshot = await waitForPtyText(fixture.coordinator, run.ref, /READY/);
    assert.equal(firstSnapshot.kind, 'snapshot');
    assert.ok(jsonBytes(firstSnapshot) <= RUNTIME_RESOURCE_RESULT_MAX_BYTES);

    const ownerOne = context('connection-1');
    const ownerTwo = context('connection-2');
    const acquiredOne = await fixture.coordinator.handlers['pty.acquire'](
      { sessionId: 'session-1', ref: run.ref },
      ownerOne,
    );
    assert.equal(acquiredOne.ok, true);
    if (!acquiredOne.ok) return;

    const held = await fixture.coordinator.handlers['pty.acquire'](
      { sessionId: 'session-1', ref: run.ref },
      ownerTwo,
    );
    assert.equal(held.ok, false);
    if (!held.ok) assert.equal(held.error.code, 'controller_held');

    const unchanged = await fixture.coordinator.handlers['pty.read'](
      { sessionId: 'session-1', ref: run.ref, cursor: firstSnapshot.cursor },
      ownerOne,
    );
    assert.equal(unchanged.ok, true);
    if (unchanged.ok) assert.equal(unchanged.result.kind, 'unchanged');

    const controlled = await fixture.coordinator.handlers['pty.control'](
      {
        sessionId: 'session-1',
        ref: run.ref,
        controllerId: acquiredOne.result.controllerId,
        input: 'hello',
      },
      ownerOne,
    );
    assert.deepEqual(controlled, {
      ok: true,
      result: { input: { accepted: true, bytes: 5 } },
    });
    const changed = await waitForPtyText(
      fixture.coordinator,
      run.ref,
      /ECHO:hello/,
      firstSnapshot.cursor,
    );
    assert.notEqual(changed.cursor, firstSnapshot.cursor);
    assert.ok(jsonBytes(changed) <= RUNTIME_RESOURCE_RESULT_MAX_BYTES);

    assert.deepEqual(
      await fixture.coordinator.handlers['pty.release'](
        {
          sessionId: 'session-1',
          ref: run.ref,
          controllerId: acquiredOne.result.controllerId,
        },
        ownerOne,
      ),
      { ok: true, result: { released: true } },
    );
    const acquiredTwo = await fixture.coordinator.handlers['pty.acquire'](
      { sessionId: 'session-1', ref: run.ref },
      ownerTwo,
    );
    assert.equal(acquiredTwo.ok, true);
    await fixture.coordinator.releaseConnection(ownerTwo.connectionId);
    const reacquired = await fixture.coordinator.handlers['pty.acquire'](
      { sessionId: 'session-1', ref: run.ref },
      ownerOne,
    );
    assert.equal(reacquired.ok, true);
    if (!reacquired.ok) return;

    const stopPromise = fixture.coordinator.handlers['resource.stop'](
      { sessionId: 'session-1', ref: run.ref },
      ownerOne,
    );
    const lateControlPromise = fixture.coordinator.handlers['pty.control'](
      {
        sessionId: 'session-1',
        ref: run.ref,
        controllerId: reacquired.result.controllerId,
        input: 'LATE',
      },
      ownerOne,
    );
    const stopped = await stopPromise;
    const lateControl = await lateControlPromise;
    assert.equal(stopped.ok, true);
    if (stopped.ok) {
      assert.equal(stopped.result.operation.kind, 'stop');
      assert.notEqual(stopped.result.status, 'running');
    }
    assert.equal(lateControl.ok, false);
    if (!lateControl.ok) assert.equal(lateControl.error.code, 'resource_terminal');
    const staleRelease = await fixture.coordinator.handlers['pty.release'](
      {
        sessionId: 'session-1',
        ref: run.ref,
        controllerId: reacquired.result.controllerId,
      },
      ownerOne,
    );
    assert.equal(staleRelease.ok, false);
    if (!staleRelease.ok) assert.equal(staleRelease.error.code, 'controller_invalid');
    await waitUntil(() => fixture.residency.count === 0);
  } finally {
    await fixture.coordinator.close();
  }
});

test('beginDrain closes admission, terminates live work, and releases residency', async () => {
  const fixture = await createFixture();
  const run = await fixture.coordinator.runBackgroundBash(
    shellInput(fixture.root, nodeCommand('setInterval(() => {}, 1000);')),
  );
  assert.equal(run.status, 'running');
  assert.equal(fixture.residency.count, 1);

  fixture.coordinator.beginDrain();
  assert.throws(
    () =>
      fixture.coordinator.runForegroundBash(
        shellInput(fixture.root, nodeCommand("process.stdout.write('no')")),
      ),
    /draining/,
  );
  await fixture.coordinator.close();
  assert.equal(fixture.residency.count, 0);
  await waitForResource(fixture.coordinator, run.ref, (status) => status !== 'running');
});

async function createFixture(
  options: {
    decorateStore?: (backing: ShellRunStore) => ShellRunStore;
  } = {},
) {
  const root = await mkdtemp(join(tmpdir(), 'maka-runtime-resource-'));
  TEMPORARY_WORKSPACES.add(root);
  const backing = createShellRunStore(root);
  const store = options.decorateStore?.(backing) ?? backing;
  const residency = { acquired: 0, count: 0, released: 0 };
  let id = 0;
  let now = 1_000;
  const coordinator = new HostRuntimeResourceCoordinator({
    store,
    newId: () => `shell-run-${++id}`,
    now: () => ++now,
    flushIntervalMs: 10,
    killGraceMs: 100,
    exitAcknowledgementMs: 500,
    acquireResidency: () => {
      residency.acquired += 1;
      residency.count += 1;
      let released = false;
      return {
        release: () => {
          assert.equal(released, false, 'residency token released more than once');
          released = true;
          residency.count -= 1;
          residency.released += 1;
        },
      };
    },
  });
  return { coordinator, residency, root, store };
}

function decorateStore(
  backing: ShellRunStore,
  overrides: {
    createShellRun?: ShellRunStore['createShellRun'];
    updateShellRun?: ShellRunStore['updateShellRun'];
  },
): ShellRunStore {
  return {
    createShellRun: overrides.createShellRun ?? ((record) => backing.createShellRun(record)),
    updateShellRun:
      overrides.updateShellRun ??
      ((sessionId, shellRunId, patch) =>
        backing.updateShellRun(sessionId, shellRunId, patch)),
    readShellRun: (sessionId, shellRunId) => backing.readShellRun(sessionId, shellRunId),
    listSessionShellRuns: (sessionId) => backing.listSessionShellRuns(sessionId),
  };
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

function shellInput(cwd: string, command: string) {
  return {
    sessionId: 'session-1',
    sourceRunId: 'run-1',
    sourceTurnId: 'turn-1',
    sourceToolCallId: `tool-${Math.random()}`,
    cwd,
    command,
    emitOutput: () => undefined,
  };
}

function context(connectionId: string): ConnectionContext {
  return {
    hostEpoch: 'test-epoch',
    connectionId,
    surface: 'desktop',
    principal: 'local_os_user',
    acquireResidency: () => ({ release: () => undefined }),
  };
}

async function waitForResource(
  coordinator: HostRuntimeResourceCoordinator,
  ref: string,
  predicate: (status: string) => boolean,
): Promise<void> {
  await waitUntil(async () => {
    const result = await coordinator.handlers['resource.query'](
      { sessionId: 'session-1', ref },
      context('poller'),
    );
    return result.ok && predicate(result.result.status);
  });
}

async function waitForPtyText(
  coordinator: HostRuntimeResourceCoordinator,
  ref: string,
  pattern: RegExp,
  previousCursor: string | null = null,
) {
  let snapshot:
    | Extract<
        Awaited<ReturnType<(typeof coordinator.handlers)['pty.read']>>,
        { ok: true }
      >['result']
    | undefined;
  let lastResult: unknown;
  await waitUntil(
    async () => {
      const result = await coordinator.handlers['pty.read'](
        { sessionId: 'session-1', ref, cursor: previousCursor },
        context('poller'),
      );
      lastResult = result;
      if (!result.ok || result.result.kind !== 'snapshot') return false;
      snapshot = result.result;
      const output = result.result.resource.output;
      return pattern.test(
        [output.scrollback, output.screen, output.lastAlternateScreen].filter(Boolean).join('\n'),
      );
    },
    5_000,
    () => `; last PTY result: ${JSON.stringify(lastResult)}`,
  );
  if (!snapshot || snapshot.kind !== 'snapshot') throw new Error('PTY snapshot was not observed');
  return snapshot;
}

async function waitUntil(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 5_000,
  timeoutDetail: () => string = () => '',
) {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate())) {
    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for runtime resource state${timeoutDetail()}`);
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
  }
}

function shellRunId(ref: string): string {
  return decodeURIComponent(new URL(ref).pathname.split('/').at(-1) ?? '');
}

function nodeCommand(script: string): string {
  const payload = Buffer.from(script, 'utf8').toString('base64');
  const bootstrap = `eval(Buffer.from('${payload}','base64').toString('utf8'))`;
  return `${shellQuote(process.execPath)} -e ${shellQuote(bootstrap)}`;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function jsonBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), 'utf8');
}
