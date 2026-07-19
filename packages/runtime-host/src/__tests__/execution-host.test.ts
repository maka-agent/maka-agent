import assert from 'node:assert/strict';
import { fork, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { appendFile, chmod, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { connect, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { AgentRunHeader } from '@maka/core/agent-run';
import type { StoredMessage } from '@maka/core/session';
import { isTerminalRuntimeEvent } from '@maka/core/runtime-event';
import type { RuntimeEvent } from '@maka/core/runtime-event';
import { classifyTerminalRuntimeLedger, FAKE_ASK_USER_QUESTION_PROMPT } from '@maka/runtime';
import {
  openInteractiveExecutionStoresForRead,
  openInteractiveExecutionStoresForWrite,
} from '@maka/storage/execution-stores';
import {
  resolveRootControlNamespace,
  resolveStorageRoot,
  tryAcquireInteractiveRootOwner,
  tryAcquireInteractiveRootReader,
  type StorageRootCapability,
} from '@maka/storage/root-authority';
import {
  connectRuntimeHost,
  RuntimeHostOperationError,
  type RuntimeHostConnection,
} from '../client/index.js';
import {
  decodeHostFrame,
  RUNTIME_HOST_PROTOCOL_VERSION,
  type TurnSnapshot,
} from '../protocol/index.js';
import { FramedTransport } from '../transport/framed-transport.js';

const CURRENT_PROTOCOL = {
  min: RUNTIME_HOST_PROTOCOL_VERSION,
  max: RUNTIME_HOST_PROTOCOL_VERSION,
} as const;
const PROCESS_TIMEOUT_MS = 10_000;

test('two Clients share one execution after the starting Client disconnects', async () => {
  await withExecutionRoot(async (fixture) => {
    const host = await fixture.startHost();
    const first = await connectClient(fixture.root, 'desktop');
    const second = await connectClient(fixture.root, 'tui');
    const turnId = randomUUID();

    const started = await first.startTurn({
      sessionId: fixture.sessionId,
      turnId,
      text: FAKE_ASK_USER_QUESTION_PROMPT,
    });
    assert.equal(started.turnId, turnId);
    await assert.rejects(
      () =>
        second.startTurn({
          sessionId: fixture.sessionId,
          turnId: randomUUID(),
          text: 'must stay busy',
        }),
      operationError('session_busy'),
    );

    await first.close();
    const observed = await second.queryTurn({
      sessionId: fixture.sessionId,
      turnId,
    });
    assert.equal(observed.runId, started.runId);
    assert.ok(observed.status === 'running' || observed.status === 'waiting_permission');
    const stopped = await second.stopTurn(
      {
        sessionId: fixture.sessionId,
        turnId,
        runId: started.runId,
      },
      PROCESS_TIMEOUT_MS,
    );
    assert.equal(stopped.status, 'cancelled');

    const nextTurnId = randomUUID();
    const next = await second.startTurn({
      sessionId: fixture.sessionId,
      turnId: nextTurnId,
      text: FAKE_ASK_USER_QUESTION_PROMPT,
    });
    assert.deepEqual(
      await second.startTurn({
        sessionId: fixture.sessionId,
        turnId,
        text: FAKE_ASK_USER_QUESTION_PROMPT,
      }),
      stopped,
    );
    assert.deepEqual(
      await second.stopTurn({
        sessionId: fixture.sessionId,
        turnId,
        runId: started.runId,
      }),
      stopped,
    );
    const nextObserved = await second.queryTurn({
      sessionId: fixture.sessionId,
      turnId: nextTurnId,
    });
    assert.equal(nextObserved.runId, next.runId);
    assert.ok(nextObserved.status === 'running' || nextObserved.status === 'waiting_permission');
    await second.stopTurn(
      {
        sessionId: fixture.sessionId,
        turnId: nextTurnId,
        runId: next.runId,
      },
      PROCESS_TIMEOUT_MS,
    );
    await second.close();
    await fixture.stopHost(host);

    const ledger = await fixture.readTurn(turnId);
    assert.equal(ledger.runs.length, 1);
    assert.equal(ledger.userMessages.length, 1);
    assert.equal(ledger.terminalEvents.length, 1);
    assert.equal(ledger.classification.kind, 'fact');
    if (ledger.classification.kind === 'fact') {
      assert.equal(ledger.classification.fact.runStatus, 'cancelled');
      assert.notEqual(ledger.classification.fact.failureClass, 'app_restarted');
    }
  });
});

test('an archived Session rejects a new Turn before durable admission', async () => {
  await withExecutionRoot(async (fixture) => {
    await fixture.archiveSession();
    const host = await fixture.startHost();
    const client = await connectClient(fixture.root, 'desktop');
    const turnId = randomUUID();

    await assert.rejects(
      () =>
        client.startTurn({
          sessionId: fixture.sessionId,
          turnId,
          text: 'must not execute',
        }),
      operationError('session_archived'),
    );
    assert.equal((await client.status()).state, 'ready');
    await client.close();
    await fixture.stopHost(host);

    assert.deepEqual(await fixture.readTurnFootprint(turnId), {
      admitted: false,
      runCount: 0,
      userMessageCount: 0,
    });
  });
});

test('a killed Host is recovered exactly once before its successor becomes ready', {
  skip: process.platform === 'win32' ? 'POSIX process death gate' : false,
}, async () => {
  await withExecutionRoot(async (fixture) => {
    const firstHost = await fixture.startHost();
    const first = await connectClient(fixture.root, 'desktop');
    const turnId = randomUUID();
    const started = await first.startTurn({
      sessionId: fixture.sessionId,
      turnId,
      text: FAKE_ASK_USER_QUESTION_PROMPT,
    });

    await fixture.killHost(firstHost);
    await first.closed;
    const secondHost = await fixture.startHost();
    const second = await connectClient(fixture.root, 'tui');
    const recovered = await second.queryTurn({
      sessionId: fixture.sessionId,
      turnId,
    });
    assert.equal(recovered.status, 'failed');
    if (recovered.status === 'failed') assert.equal(recovered.failureClass, 'app_restarted');
    await second.close();
    await fixture.stopHost(secondHost);

    const thirdHost = await fixture.startHost();
    const third = await connectClient(fixture.root, 'run');
    const stable = await third.queryTurn({
      sessionId: fixture.sessionId,
      turnId,
    });
    assert.deepEqual(stable, recovered);
    assert.equal(stable.runId, started.runId);
    await third.close();
    await fixture.stopHost(thirdHost);

    const ledger = await fixture.readTurn(turnId);
    assert.equal(ledger.terminalEvents.length, 1);
    assert.equal(ledger.classification.kind, 'fact');
    if (ledger.classification.kind === 'fact') {
      assert.equal(ledger.classification.fact.failureClass, 'app_restarted');
    }
  });
});

test('graceful Host shutdown stops and drains an active Turn before releasing ownership', async () => {
  await withExecutionRoot(async (fixture) => {
    const host = await fixture.startHost();
    const client = await connectClient(fixture.root, 'desktop');
    const turnId = randomUUID();
    const started = await client.startTurn({
      sessionId: fixture.sessionId,
      turnId,
      text: FAKE_ASK_USER_QUESTION_PROMPT,
    });

    await fixture.stopHost(host);
    await client.closed;

    const successor = await fixture.startHost();
    const observer = await connectClient(fixture.root, 'tui');
    const stable = await observer.queryTurn({
      sessionId: fixture.sessionId,
      turnId,
    });
    assert.equal(stable.runId, started.runId);
    assert.equal(stable.status, 'cancelled');
    await observer.close();
    await fixture.stopHost(successor);

    const ledger = await fixture.readTurn(turnId);
    assert.equal(ledger.terminalEvents.length, 1);
    assert.equal(ledger.classification.kind, 'fact');
    if (ledger.classification.kind === 'fact') {
      assert.equal(ledger.classification.fact.runStatus, 'cancelled');
      assert.notEqual(ledger.classification.fact.failureClass, 'app_restarted');
    }
  });
});

test('a durable admission without a Run resumes before the Host becomes ready', async () => {
  await withExecutionRoot(async (fixture) => {
    const turnId = randomUUID();
    const { runId } = await fixture.seedAdmission(turnId, FAKE_ASK_USER_QUESTION_PROMPT);
    const host = await fixture.startHost();
    const client = await connectClient(fixture.root, 'tui');

    const recovered = await client.queryTurn({
      sessionId: fixture.sessionId,
      turnId,
    });
    assert.equal(recovered.runId, runId);
    assert.ok(recovered.status === 'running' || recovered.status === 'waiting_permission');
    await assert.rejects(
      () =>
        client.startTurn({
          sessionId: fixture.sessionId,
          turnId: randomUUID(),
          text: 'must remain behind the recovered admission',
        }),
      operationError('session_busy'),
    );
    const stopped = await client.stopTurn(
      {
        sessionId: fixture.sessionId,
        turnId,
        runId,
      },
      PROCESS_TIMEOUT_MS,
    );
    assert.equal(stopped.status, 'cancelled');
    await client.close();
    await fixture.stopHost(host);

    const ledger = await fixture.readTurn(turnId);
    assert.equal(ledger.runs.length, 1);
    assert.equal(ledger.userMessages.length, 1);
    assert.equal(ledger.terminalEvents.length, 1);
    assert.equal(ledger.classification.kind, 'fact');
    if (ledger.classification.kind === 'fact') {
      assert.notEqual(ledger.classification.fact.failureClass, 'app_restarted');
    }
  });
});

test('startup recovery restores the admitted UserMessage before terminalizing its Run', async () => {
  await withExecutionRoot(async (fixture) => {
    const turnId = randomUUID();
    const { runId, userMessageId } = await fixture.seedRunWithoutUserMessage(
      turnId,
      'recover the admitted message',
    );
    const host = await fixture.startHost();
    const client = await connectClient(fixture.root, 'tui');

    const recovered = await client.queryTurn({
      sessionId: fixture.sessionId,
      turnId,
    });
    assert.equal(recovered.runId, runId);
    assert.equal(recovered.status, 'failed');
    if (recovered.status === 'failed') {
      assert.equal(recovered.failureClass, 'app_restarted');
    }
    await client.close();
    await fixture.stopHost(host);

    const ledger = await fixture.readTurn(turnId);
    assert.equal(ledger.runs.length, 1);
    assert.equal(ledger.userMessages.length, 1);
    assert.equal(ledger.userMessages[0]?.id, userMessageId);
    assert.equal(ledger.terminalEvents.length, 1);
  });
});

test('startup recovery repairs a truncated RuntimeEvent tail before terminalizing the Run', async () => {
  await withExecutionRoot(async (fixture) => {
    const turnId = randomUUID();
    const { runId } = await fixture.seedRunWithoutUserMessage(
      turnId,
      'recover after a partial RuntimeEvent write',
    );
    const runtimeEventsPath = fixture.runtimeEventsPath(runId);
    await writeFile(runtimeEventsPath, '{"id":"truncated"', 'utf8');

    const host = await fixture.startHost();
    const client = await connectClient(fixture.root, 'tui');
    const recovered = await client.queryTurn({
      sessionId: fixture.sessionId,
      turnId,
    });
    assert.equal(recovered.status, 'failed');
    if (recovered.status === 'failed') {
      assert.equal(recovered.failureClass, 'app_restarted');
    }
    await client.close();
    await fixture.stopHost(host);

    const bytes = await readFile(runtimeEventsPath, 'utf8');
    assert.doesNotMatch(bytes, /truncated/);
    assertJsonLines(bytes);
    const ledger = await fixture.readTurn(turnId);
    assert.equal(ledger.terminalEvents.length, 1);
  });
});

test('startup recovery fails closed on a complete malformed RuntimeEvent record', async () => {
  await withExecutionRoot(async (fixture) => {
    const turnId = randomUUID();
    const { runId } = await fixture.seedRunWithoutUserMessage(
      turnId,
      'do not recover across durable corruption',
    );
    const runtimeEventsPath = fixture.runtimeEventsPath(runId);
    const malformed = '{"id":"malformed"\n';
    await writeFile(runtimeEventsPath, malformed, 'utf8');

    await fixture.expectHostStartupFailure();
    assert.equal(await readFile(runtimeEventsPath, 'utf8'), malformed);
    await fixture.assertOwnerAvailable();
  });
});

test('startup recovery fails closed on a complete malformed Session record', async () => {
  await withExecutionRoot(async (fixture) => {
    await fixture.seedRunWithoutUserMessage(
      randomUUID(),
      'do not rewrite durable Session corruption',
    );
    const sessionPath = fixture.sessionPath();
    const malformed = '{"type":"user"\n';
    await appendFile(sessionPath, malformed, 'utf8');
    const expected = await readFile(sessionPath, 'utf8');

    await fixture.expectHostStartupFailure();
    assert.equal(await readFile(sessionPath, 'utf8'), expected);
    await fixture.assertOwnerAvailable();
  });
});

test('startup recovery fails closed on a complete malformed AgentRun record', async () => {
  await withExecutionRoot(async (fixture) => {
    const { runId } = await fixture.seedRunWithoutUserMessage(
      randomUUID(),
      'do not recover across durable AgentRun corruption',
    );
    const eventsPath = fixture.eventsPath(runId);
    const malformed = '{"type":"run_started"\n';
    await writeFile(eventsPath, malformed, 'utf8');

    await fixture.expectHostStartupFailure();
    assert.equal(await readFile(eventsPath, 'utf8'), malformed);
    await fixture.assertOwnerAvailable();
  });
});

test('a pre-start durability failure rejects turn.start and drains the Host', {
  skip:
    process.platform === 'win32' || process.getuid?.() === 0 ? 'POSIX file-permission gate' : false,
}, async () => {
  await withExecutionRoot(async (fixture) => {
    const host = await fixture.startHost();
    const client = await connectClient(fixture.root, 'desktop');
    const turnId = randomUUID();
    const sessionPath = fixture.sessionPath();
    await chmod(sessionPath, 0o400);
    try {
      await assert.rejects(
        () =>
          client.startTurn({
            sessionId: fixture.sessionId,
            turnId,
            text: 'fail before the durable start barrier',
          }),
        operationError('internal_failure'),
      );
      await client.closed;
      await fixture.waitForHostExit(host);
    } finally {
      await chmod(sessionPath, 0o600);
    }

    const successor = await fixture.startHost();
    const observer = await connectClient(fixture.root, 'tui');
    const recovered = await observer.queryTurn({
      sessionId: fixture.sessionId,
      turnId,
    });
    assert.equal(recovered.status, 'failed');
    await observer.close();
    await fixture.stopHost(successor);

    const ledger = await fixture.readTurn(turnId);
    assert.equal(ledger.runs.length, 1);
    assert.equal(ledger.userMessages.length, 1);
    assert.equal(ledger.terminalEvents.length, 1);
  });
});

test('retry after a discarded turn.start response reuses the durable semantic admission', async () => {
  await withExecutionRoot(async (fixture) => {
    const host = await fixture.startHost();
    const turnId = randomUUID();
    const text = 'response loss must not duplicate this Turn';
    const dropped = await sendStartWithoutReadingResponse(host.endpoint, {
      sessionId: fixture.sessionId,
      turnId,
      text,
    });
    const observer = await connectClient(fixture.root, 'tui');
    const committed = await waitForTurn(observer, fixture.sessionId, turnId);
    dropped.destroy();

    const retried = await observer.startTurn({
      sessionId: fixture.sessionId,
      turnId,
      text,
    });
    assert.equal(retried.runId, committed.runId);
    await assert.rejects(
      () =>
        observer.startTurn({
          sessionId: fixture.sessionId,
          turnId,
          text: `${text} changed`,
        }),
      operationError('operation_conflict'),
    );
    const terminal = await waitForTerminalTurn(observer, fixture.sessionId, turnId);
    assert.equal(terminal.status, 'completed');
    await observer.close();
    await fixture.stopHost(host);

    const ledger = await fixture.readTurn(turnId);
    assert.equal(ledger.runs.length, 1);
    assert.equal(ledger.userMessages.length, 1);
    assert.equal(ledger.terminalEvents.length, 1);
  });
});

interface ExecutionHostHandle {
  child: ChildProcess;
  hostEpoch: string;
  endpoint: string;
}

interface TurnLedger {
  runs: AgentRunHeader[];
  userMessages: StoredMessage[];
  terminalEvents: RuntimeEvent[];
  classification: ReturnType<typeof classifyTerminalRuntimeLedger>;
}

class ExecutionFixture {
  readonly #children = new Set<ChildProcess>();

  constructor(
    readonly base: string,
    readonly root: string,
    readonly capability: StorageRootCapability<'interactive'>,
    readonly sessionId: string,
  ) {}

  sessionPath(): string {
    return join(this.root, 'sessions', this.sessionId, 'session.jsonl');
  }

  runtimeEventsPath(runId: string): string {
    return join(this.root, 'sessions', this.sessionId, 'runs', runId, 'runtime-events.jsonl');
  }

  eventsPath(runId: string): string {
    return join(this.root, 'sessions', this.sessionId, 'runs', runId, 'events.jsonl');
  }

  seedAdmission(turnId: string, text: string): Promise<{ runId: string; userMessageId: string }> {
    return this.seedTurnState(turnId, text, false);
  }

  async archiveSession(): Promise<void> {
    const owner = await tryAcquireInteractiveRootOwner(this.capability);
    assert.ok(owner);
    if (!owner) throw new Error('Unable to acquire execution root for archive');
    try {
      const stores = await openInteractiveExecutionStoresForWrite(owner.lease);
      await stores.sessionStore.archive(this.sessionId);
    } finally {
      await owner.close();
    }
  }

  seedRunWithoutUserMessage(
    turnId: string,
    text: string,
  ): Promise<{ runId: string; userMessageId: string }> {
    return this.seedTurnState(turnId, text, true);
  }

  private async seedTurnState(
    turnId: string,
    text: string,
    createRun: boolean,
  ): Promise<{ runId: string; userMessageId: string }> {
    const owner = await tryAcquireInteractiveRootOwner(this.capability);
    assert.ok(owner);
    if (!owner) throw new Error('Unable to acquire execution root for admission setup');
    try {
      const stores = await openInteractiveExecutionStoresForWrite(owner.lease);
      const admittedAt = Date.now();
      const result = await stores.agentRunStore.admitRootTurn({
        sessionId: this.sessionId,
        turnId,
        proposedRunId: randomUUID(),
        proposedUserMessageId: randomUUID(),
        normalizedInput: { text },
        admittedAt,
      });
      assert.equal(result.kind, 'admitted');
      if (createRun) {
        await stores.agentRunStore.createRun({
          runId: result.admission.runId,
          invocationId: result.admission.runId,
          sessionId: this.sessionId,
          turnId,
          status: 'created',
          backendKind: 'fake',
          llmConnectionSlug: 'fake',
          modelId: 'fake-model',
          cwd: this.root,
          permissionMode: 'ask',
          createdAt: admittedAt,
          updatedAt: admittedAt,
        });
      }
      return {
        runId: result.admission.runId,
        userMessageId: result.admission.userMessageId,
      };
    } finally {
      await owner.close();
    }
  }

  async startHost(): Promise<ExecutionHostHandle> {
    const child = this.spawnHost('inherit');
    const ready = await waitForHostReady(child);
    return { child, ...ready };
  }

  async expectHostStartupFailure(): Promise<void> {
    const child = this.spawnHost('ignore');
    await assert.rejects(() => waitForHostReady(child), /execution Host exited before readiness/);
    await withTimeout(waitForExit(child), PROCESS_TIMEOUT_MS, 'failed execution Host did not exit');
    this.#children.delete(child);
  }

  async assertOwnerAvailable(): Promise<void> {
    const owner = await tryAcquireInteractiveRootOwner(this.capability);
    assert.ok(owner);
    await owner?.close();
  }

  async stopHost(host: ExecutionHostHandle): Promise<void> {
    if (host.child.exitCode === null && host.child.signalCode === null) {
      host.child.kill('SIGTERM');
    }
    await withTimeout(waitForExit(host.child), PROCESS_TIMEOUT_MS, 'execution Host did not stop');
    this.#children.delete(host.child);
  }

  async killHost(host: ExecutionHostHandle): Promise<void> {
    host.child.kill('SIGKILL');
    await withTimeout(
      waitForExit(host.child),
      PROCESS_TIMEOUT_MS,
      'execution Host survived SIGKILL',
    );
    this.#children.delete(host.child);
  }

  async waitForHostExit(host: ExecutionHostHandle): Promise<void> {
    await withTimeout(
      waitForExit(host.child),
      PROCESS_TIMEOUT_MS,
      'draining execution Host did not exit',
    );
    this.#children.delete(host.child);
  }

  async readTurn(turnId: string): Promise<TurnLedger> {
    const reader = await acquireReader(this.capability);
    try {
      const stores = await openInteractiveExecutionStoresForRead(reader.lease);
      const admission = await stores.agentRunStore.readRootTurnAdmission(this.sessionId, turnId);
      assert.ok(admission);
      const runs = (await stores.agentRunStore.listSessionRuns(this.sessionId)).filter(
        (candidate) => candidate.turnId === turnId,
      );
      const run = await stores.agentRunStore.readRun(this.sessionId, admission.runId);
      const messages = await stores.sessionStore.readMessages(this.sessionId);
      const runtimeEvents = await stores.runtimeEventStore.readImmutableRuntimeEvents(
        this.sessionId,
        admission.runId,
      );
      return {
        runs,
        userMessages: messages.filter(
          (message) => message.type === 'user' && message.turnId === turnId,
        ),
        terminalEvents: runtimeEvents.filter(isTerminalRuntimeEvent),
        classification: classifyTerminalRuntimeLedger(run, runtimeEvents),
      };
    } finally {
      await reader.close();
    }
  }

  async readTurnFootprint(turnId: string): Promise<{
    admitted: boolean;
    runCount: number;
    userMessageCount: number;
  }> {
    const reader = await acquireReader(this.capability);
    try {
      const stores = await openInteractiveExecutionStoresForRead(reader.lease);
      const [admission, runs, messages] = await Promise.all([
        stores.agentRunStore.readRootTurnAdmission(this.sessionId, turnId),
        stores.agentRunStore.listSessionRuns(this.sessionId),
        stores.sessionStore.readMessages(this.sessionId),
      ]);
      return {
        admitted: admission !== undefined,
        runCount: runs.filter((run) => run.turnId === turnId).length,
        userMessageCount: messages.filter(
          (message) => message.type === 'user' && message.turnId === turnId,
        ).length,
      };
    } finally {
      await reader.close();
    }
  }

  async close(): Promise<void> {
    for (const child of this.#children) {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      await withTimeout(waitForExit(child), 1_000, 'cleanup Host did not exit').catch(
        () => undefined,
      );
    }
    await rm(join(resolveRootControlNamespace(), this.capability.rootId), {
      recursive: true,
      force: true,
    });
    await removePosixEndpointDirectories(this.capability.rootId);
    await rm(this.base, { recursive: true, force: true });
  }

  private spawnHost(stderr: 'inherit' | 'ignore'): ChildProcess {
    const child = fork(
      new URL('./fixtures/execution-host.js', import.meta.url),
      [this.root, this.capability.rootId, '60000'],
      { stdio: ['ignore', 'ignore', stderr, 'ipc'] },
    );
    this.#children.add(child);
    return child;
  }
}

async function withExecutionRoot(run: (fixture: ExecutionFixture) => Promise<void>): Promise<void> {
  const base = await mkdtemp(join(tmpdir(), 'maka-runtime-host-execution-'));
  const root = join(base, 'root');
  const capability = await resolveStorageRoot({
    path: root,
    kind: 'interactive',
  });
  const owner = await tryAcquireInteractiveRootOwner(capability);
  assert.ok(owner);
  let sessionId: string;
  try {
    const stores = await openInteractiveExecutionStoresForWrite(owner.lease);
    const session = await stores.sessionStore.create({
      cwd: root,
      backend: 'fake',
      llmConnectionSlug: 'fake',
      model: 'fake-model',
      permissionMode: 'ask',
    });
    sessionId = session.id;
  } finally {
    await owner.close();
  }
  const fixture = new ExecutionFixture(base, root, capability, sessionId);
  try {
    await run(fixture);
  } finally {
    await fixture.close();
  }
}

async function connectClient(
  rootPath: string,
  surface: 'desktop' | 'tui' | 'run',
): Promise<RuntimeHostConnection> {
  const result = await connectRuntimeHost({
    rootPath,
    surface,
    protocol: CURRENT_PROTOCOL,
  });
  assert.equal(result.kind, 'connected');
  return result.connection;
}

async function sendStartWithoutReadingResponse(
  endpoint: string,
  input: { sessionId: string; turnId: string; text: string },
): Promise<FramedTransport> {
  const transport = new FramedTransport(await openSocket(endpoint));
  await transport.write({
    kind: 'hello',
    clientInstanceId: randomUUID(),
    surface: 'desktop',
    protocolMin: CURRENT_PROTOCOL.min,
    protocolMax: CURRENT_PROTOCOL.max,
  });
  const handshake = decodeHostFrame(await transport.read(2_000));
  assert.ok('kind' in handshake);
  assert.equal(handshake.kind, 'accepted');
  await transport.write({
    requestId: randomUUID(),
    operation: 'turn.start',
    input,
  });
  return transport;
}

function openSocket(path: string): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = connect(path);
    const onError = (error: Error) => {
      socket.off('connect', onConnect);
      reject(error);
    };
    const onConnect = () => {
      socket.off('error', onError);
      resolve(socket);
    };
    socket.once('error', onError);
    socket.once('connect', onConnect);
  });
}

async function waitForTurn(
  connection: RuntimeHostConnection,
  sessionId: string,
  turnId: string,
): Promise<TurnSnapshot> {
  const deadline = Date.now() + PROCESS_TIMEOUT_MS;
  while (true) {
    try {
      return await connection.queryTurn({ sessionId, turnId });
    } catch (error) {
      if (!(error instanceof RuntimeHostOperationError) || error.code !== 'not_found') throw error;
      if (Date.now() >= deadline) throw new Error('Turn admission was not observed');
      await sleep(20);
    }
  }
}

async function waitForTerminalTurn(
  connection: RuntimeHostConnection,
  sessionId: string,
  turnId: string,
): Promise<TurnSnapshot> {
  const deadline = Date.now() + PROCESS_TIMEOUT_MS;
  while (true) {
    const snapshot = await connection.queryTurn({ sessionId, turnId });
    if (
      snapshot.status === 'completed' ||
      snapshot.status === 'failed' ||
      snapshot.status === 'cancelled'
    ) {
      return snapshot;
    }
    if (Date.now() >= deadline) throw new Error('Turn did not reach a terminal fact');
    await sleep(20);
  }
}

function operationError(code: RuntimeHostOperationError['code']) {
  return (error: unknown): boolean =>
    error instanceof RuntimeHostOperationError && error.code === code;
}

function assertJsonLines(bytes: string): void {
  for (const line of bytes.split('\n').filter(Boolean)) {
    assert.doesNotThrow(() => JSON.parse(line));
  }
}

function waitForHostReady(child: ChildProcess): Promise<{ hostEpoch: string; endpoint: string }> {
  return withTimeout(
    new Promise((resolve, reject) => {
      const cleanup = () => {
        child.off('error', onError);
        child.off('exit', onExit);
        child.off('message', onMessage);
      };
      const onError = (error: Error) => {
        cleanup();
        reject(error);
      };
      const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
        cleanup();
        reject(new Error(`execution Host exited before readiness: ${code ?? signal}`));
      };
      const onMessage = (message: unknown) => {
        if (!isHostReadyMessage(message)) return;
        cleanup();
        resolve({ hostEpoch: message.hostEpoch, endpoint: message.endpoint });
      };
      child.once('error', onError);
      child.once('exit', onExit);
      child.on('message', onMessage);
    }),
    PROCESS_TIMEOUT_MS,
    'execution Host did not become ready',
  );
}

function isHostReadyMessage(
  value: unknown,
): value is { type: 'ready'; hostEpoch: string; endpoint: string } {
  if (!value || typeof value !== 'object') return false;
  const message = value as Record<string, unknown>;
  return (
    message.type === 'ready' &&
    typeof message.hostEpoch === 'string' &&
    typeof message.endpoint === 'string'
  );
}

function waitForExit(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', () => resolve());
  });
}

async function acquireReader(capability: StorageRootCapability<'interactive'>) {
  const deadline = Date.now() + PROCESS_TIMEOUT_MS;
  while (true) {
    const reader = await tryAcquireInteractiveRootReader(capability);
    if (reader) return reader;
    if (Date.now() >= deadline)
      throw new Error('Interactive root reader could not acquire the released root');
    await sleep(20);
  }
}

async function removePosixEndpointDirectories(rootId: string): Promise<void> {
  if (process.platform === 'win32' || typeof process.getuid !== 'function') return;
  const prefix = `m-${process.getuid()}-${Buffer.from(rootId, 'hex').toString('base64url')}-`;
  const entries = await readdir('/tmp', { withFileTypes: true });
  await Promise.all(
    entries.map(async (entry) => {
      if (entry.isDirectory() && entry.name.startsWith(prefix)) {
        await rm(join('/tmp', entry.name), { recursive: true, force: true });
      }
    }),
  );
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([
    promise,
    new Promise<T>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(message)), timeoutMs);
    }),
  ]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
