import assert from 'node:assert/strict';
import { fork, type ChildProcess } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { connect, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentRunHeader } from '@maka/core/agent-run';
import type { ArtifactRecord, ArtifactSource } from '@maka/core/artifacts';
import type { MessageContent } from '@maka/core/events';
import type { StoredMessage } from '@maka/core/session';
import type { Task } from '@maka/core/task-ledger';
import { isTerminalRuntimeEvent, type RuntimeEvent } from '@maka/core/runtime-event';
import { classifyTerminalRuntimeLedger } from '@maka/runtime';
import {
  openInteractiveAutomationStoreForWrite,
  type InteractionRecord,
  type PersistedLlmCallRecord,
  type StoredInteractionRequest,
} from '@maka/storage';
import {
  openInteractiveArtifactStoreForWrite,
  type InteractiveArtifactStoreWriter,
} from '@maka/storage/artifact-stores';
import {
  openInteractiveExecutionStoresForRead,
  openInteractiveExecutionStoresForWrite,
} from '@maka/storage/execution-stores';
import { openInteractiveTaskLedgerStoreForWrite } from '@maka/storage/task-ledger-store';
import { openInteractiveUsageStoresForWrite } from '@maka/storage/usage-stores';
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
} from '../../client/index.js';
import {
  decodeHostFrame,
  RUNTIME_HOST_PROTOCOL_VERSION,
  type OperationInput,
  type OperationKey,
  type RequestFrame,
  type RequestFrameFor,
  type TurnSnapshot,
} from '../../protocol/index.js';
import { FramedTransport } from '../../transport/framed-transport.js';

const CURRENT_PROTOCOL = {
  min: RUNTIME_HOST_PROTOCOL_VERSION,
  max: RUNTIME_HOST_PROTOCOL_VERSION,
} as const;
export const PROCESS_TIMEOUT_MS = 10_000;

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

export class ExecutionFixture {
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

  admissionStagingPath(turnId: string): string {
    return join(
      this.root,
      'sessions',
      this.sessionId,
      'turn-admissions',
      `${turnId}.json.${process.pid}.${randomUUID()}.tmp`,
    );
  }

  admissionPath(turnId: string): string {
    return join(this.root, 'sessions', this.sessionId, 'turn-admissions', `${turnId}.json`);
  }

  async seedUnlockedUserMessage(): Promise<void> {
    const owner = await tryAcquireInteractiveRootOwner(this.capability);
    assert.ok(owner);
    if (!owner) {
      throw new Error('Unable to acquire execution root for Session setup');
    }
    try {
      const stores = await openInteractiveExecutionStoresForWrite(owner.lease);
      await stores.sessionStore.appendMessage(this.sessionId, {
        type: 'user',
        id: randomUUID(),
        turnId: randomUUID(),
        ts: Date.now(),
        text: 'observational projection read',
      });
    } finally {
      await owner.close();
    }
  }

  seedAdmission(turnId: string, text: string): Promise<{ runId: string; userMessageId: string }> {
    return this.seedTurnState(turnId, { text }, false);
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

  async createTasks(subjects: readonly string[]): Promise<Task[]> {
    const owner = await tryAcquireInteractiveRootOwner(this.capability);
    assert.ok(owner);
    if (!owner) throw new Error('Unable to acquire execution root for Task Ledger setup');
    try {
      const store = await openInteractiveTaskLedgerStoreForWrite(owner.lease);
      return (
        await store.create(
          this.sessionId,
          subjects.map((subject) => ({ subject })),
        )
      ).created;
    } finally {
      await owner.close();
    }
  }

  async updateTask(taskRef: string, patch: unknown): Promise<Task> {
    const owner = await tryAcquireInteractiveRootOwner(this.capability);
    assert.ok(owner);
    if (!owner) throw new Error('Unable to acquire execution root for Task Ledger update');
    try {
      const store = await openInteractiveTaskLedgerStoreForWrite(owner.lease);
      return (await store.update(this.sessionId, taskRef, patch)).updated;
    } finally {
      await owner.close();
    }
  }

  async seedUsageRecords(records: readonly PersistedLlmCallRecord[]): Promise<void> {
    const owner = await tryAcquireInteractiveRootOwner(this.capability);
    assert.ok(owner);
    if (!owner) throw new Error('Unable to acquire execution root for telemetry setup');
    let stores: Awaited<ReturnType<typeof openInteractiveUsageStoresForWrite>> | undefined;
    try {
      const opened = await openInteractiveUsageStoresForWrite(owner.lease);
      stores = opened;
      await Promise.all(records.map((record) => opened.telemetry.recordLlmCall(record)));
    } finally {
      try {
        await stores?.close();
      } finally {
        await owner.close();
      }
    }
  }

  async seedAutomationFire(options: { runStarted?: boolean } = {}): Promise<{
    automationId: string;
    fireId: string;
    turnId: string;
    runId: string;
  }> {
    const owner = await tryAcquireInteractiveRootOwner(this.capability);
    assert.ok(owner);
    if (!owner) throw new Error('Unable to acquire execution root for Automation setup');
    const automationStore = await openInteractiveAutomationStoreForWrite(owner.lease);
    try {
      const stores = await openInteractiveExecutionStoresForWrite(owner.lease);
      const automationId = randomUUID();
      const fireId = randomUUID();
      const turnId = randomUUID();
      const runId = randomUUID();
      const userMessageId = randomUUID();
      const scheduledFor = Date.now();
      const admittedAt = scheduledFor + 1;
      const name = 'recovered heartbeat';
      const prompt = 'Complete the recovered Automation fire.';
      const created = await automationStore.createDefinition({
        automationId,
        name,
        prompt,
        target: { kind: 'heartbeat', sessionId: this.sessionId },
        schedule: { kind: 'interval', intervalMs: 60_000 },
        maxFireCount: null,
        expiresAt: admittedAt + 10 * 60_000,
        createdAt: scheduledFor,
        nextFireAt: scheduledFor,
        enabled: true,
      });
      assert.equal(created.status, 'committed');
      const admitted = await automationStore.admitFire({
        admission: {
          fireId,
          automationId,
          scheduledFor,
          admittedAt,
          targetSessionId: this.sessionId,
          turnId,
          runId,
          userMessageId,
        },
        expectedAutomationRevision: 1,
        nextFireAt: admittedAt + 60_000,
      });
      assert.equal(admitted.status, 'committed');

      if (options.runStarted) {
        const content = { text: `[Automation: ${name}]\n\n${prompt}` };
        const rootAdmission = await stores.agentRunStore.admitRootTurn({
          sessionId: this.sessionId,
          turnId,
          proposedRunId: runId,
          proposedUserMessageId: userMessageId,
          previousRootTurnId: null,
          normalizedInput: content,
          sourceMessages: [],
          origin: { kind: 'automation', automationId, fireId },
          admittedAt,
        });
        assert.equal(rootAdmission.admission.runId, runId);
        await stores.agentRunStore.createRun({
          runId,
          invocationId: runId,
          sessionId: this.sessionId,
          turnId,
          status: 'running',
          backendKind: 'fake',
          llmConnectionSlug: 'fake',
          modelId: 'fake-model',
          cwd: this.root,
          permissionMode: 'ask',
          automationId,
          automationFireId: fireId,
          createdAt: admittedAt,
          updatedAt: admittedAt,
        });
      }
      return { automationId, fireId, turnId, runId };
    } finally {
      await automationStore.beginDrain();
      await automationStore.close();
      await owner.close();
    }
  }

  async seedAutomationWithTerminalFires(fireCount: number): Promise<{
    automationId: string;
    revision: number;
  }> {
    assert.ok(Number.isSafeInteger(fireCount) && fireCount > 0);
    const owner = await tryAcquireInteractiveRootOwner(this.capability);
    assert.ok(owner);
    if (!owner) throw new Error('Unable to acquire execution root for Automation setup');
    const automationStore = await openInteractiveAutomationStoreForWrite(owner.lease);
    try {
      const automationId = randomUUID();
      const intervalMs = 60_000;
      const createdAt = Date.now();
      let nextFireAt = createdAt + intervalMs;
      const created = await automationStore.createDefinition({
        automationId,
        name: 'bounded fire count',
        prompt: 'Complete this scheduled check.',
        target: { kind: 'heartbeat', sessionId: this.sessionId },
        schedule: { kind: 'interval', intervalMs },
        maxFireCount: null,
        expiresAt: null,
        createdAt,
        nextFireAt,
        enabled: true,
      });
      assert.equal(created.status, 'committed');
      if (created.status !== 'committed') assert.fail('Automation create did not commit');
      let revision = created.definition.revision;
      for (let index = 0; index < fireCount; index += 1) {
        const fireId = randomUUID();
        const admittedAt = nextFireAt + 1;
        nextFireAt = admittedAt + intervalMs;
        const admitted = await automationStore.admitFire({
          admission: {
            fireId,
            automationId,
            scheduledFor: admittedAt - 1,
            admittedAt,
            targetSessionId: this.sessionId,
            turnId: randomUUID(),
            runId: randomUUID(),
            userMessageId: randomUUID(),
          },
          expectedAutomationRevision: revision,
          nextFireAt,
        });
        assert.equal(admitted.status, 'committed');
        if (admitted.status !== 'committed') assert.fail('Automation fire was not admitted');
        revision = admitted.definition.revision;
        const settled = await automationStore.settleFire({
          fireId,
          outcome: { kind: 'succeeded', settledAt: admittedAt + 1 },
        });
        assert.equal(settled.status, 'committed');
      }
      return { automationId, revision };
    } finally {
      await automationStore.beginDrain();
      await automationStore.close();
      await owner.close();
    }
  }

  async createArtifacts(
    inputs: readonly {
      id?: string;
      name: string;
      content: string | Uint8Array;
      kind?: 'file' | 'image';
      mimeType?: string;
      source?: ArtifactSource;
      now?: number;
    }[],
  ): Promise<ArtifactRecord[]> {
    const owner = await tryAcquireInteractiveRootOwner(this.capability);
    assert.ok(owner);
    if (!owner) throw new Error('Unable to acquire execution root for Artifact setup');
    let store: InteractiveArtifactStoreWriter | undefined;
    try {
      store = await openInteractiveArtifactStoreForWrite(owner.lease);
      const records: ArtifactRecord[] = [];
      for (const input of inputs) {
        records.push(
          await store.create({
            sessionId: this.sessionId,
            turnId: 'artifact-fixture-turn',
            name: input.name,
            content: input.content,
            kind: input.kind ?? 'file',
            ...(input.id === undefined ? {} : { id: input.id }),
            ...(input.mimeType === undefined ? {} : { mimeType: input.mimeType }),
            ...(input.now === undefined ? {} : { now: input.now }),
            source: input.source ?? 'fixture',
          }),
        );
      }
      return records;
    } finally {
      try {
        await store?.close();
      } finally {
        await owner.close();
      }
    }
  }

  async seedArtifactPublicationResidue(targetName = 'unpublished.txt'): Promise<string> {
    const directory = join(this.root, 'artifacts', this.sessionId);
    await mkdir(directory, { recursive: true });
    const targetHash = createHash('sha256').update(targetName).digest('hex');
    const stagingName = `.artifact-publish.${targetHash}.${randomUUID()}.tmp`;
    await writeFile(join(directory, stagingName), 'unpublished', { flag: 'wx' });
    return stagingName;
  }

  async artifactDirectoryEntries(): Promise<string[]> {
    return readdir(join(this.root, 'artifacts', this.sessionId));
  }

  seedRunWithoutUserMessage(
    turnId: string,
    content: MessageContent,
  ): Promise<{ runId: string; userMessageId: string }> {
    return this.seedTurnState(turnId, content, true);
  }

  private async seedTurnState(
    turnId: string,
    content: MessageContent,
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
        previousRootTurnId: null,
        normalizedInput: content,
        sourceMessages: [],
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

  async startHost(
    options: {
      frozenNow?: number;
      steppingNow?: number;
      idleGraceMs?: number;
      goalAdmissionCommitFailpoint?: boolean;
    } = {},
  ): Promise<ExecutionHostHandle> {
    let execArgv: string[] | undefined;
    if (options.frozenNow !== undefined || options.steppingNow !== undefined) {
      const preloadPath = join(this.base, `freeze-date-${randomUUID()}.cjs`);
      const source =
        options.frozenNow !== undefined
          ? `Date.now = () => ${JSON.stringify(options.frozenNow)};\n`
          : `let now = ${JSON.stringify(options.steppingNow)}; Date.now = () => ++now;\n`;
      await writeFile(preloadPath, source, 'utf8');
      execArgv = [...process.execArgv, '--require', preloadPath];
    }
    const child = this.spawnHost(
      'inherit',
      execArgv,
      options.idleGraceMs,
      options.goalAdmissionCommitFailpoint === true,
    );
    const ready = await waitForHostReady(child);
    return { child, ...ready };
  }

  async seedPendingQuestion(input: {
    turnId: string;
    runId: string;
    requestId?: string;
  }): Promise<StoredInteractionRequest> {
    const owner = await tryAcquireInteractiveRootOwner(this.capability);
    assert.ok(owner);
    if (!owner) throw new Error('Unable to acquire execution root for Interaction setup');
    try {
      const stores = await openInteractiveExecutionStoresForWrite(owner.lease);
      const request: StoredInteractionRequest = {
        sessionId: this.sessionId,
        turnId: input.turnId,
        runId: input.runId,
        requestId: input.requestId ?? randomUUID(),
        createdAt: Date.now(),
        request: {
          kind: 'question',
          toolUseId: randomUUID(),
          questions: [
            {
              question: 'Which release channel?',
              options: [{ label: 'Preview' }, { label: 'Stable' }],
            },
          ],
        },
      };
      const result = await stores.interactionStore.establishRequest(request);
      assert.equal(result.status, 'stable');
      assert.equal(result.matches, true);
      return result.record.request;
    } finally {
      await owner.close();
    }
  }

  async readInteraction(requestId: string): Promise<InteractionRecord | undefined> {
    const reader = await acquireReader(this.capability);
    try {
      const stores = await openInteractiveExecutionStoresForRead(reader.lease);
      return await stores.interactionStore.readInteraction(requestId);
    } finally {
      await reader.close();
    }
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

  waitForGoalAdmissionCommit(host: ExecutionHostHandle): Promise<{
    turnId: string;
    runId: string;
    goalId: string;
  }> {
    return withTimeout(
      new Promise((resolve, reject) => {
        const cleanup = () => {
          host.child.off('error', onError);
          host.child.off('exit', onExit);
          host.child.off('message', onMessage);
        };
        const onError = (error: Error) => {
          cleanup();
          reject(error);
        };
        const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
          cleanup();
          reject(new Error(`execution Host exited before Goal admission gate: ${code ?? signal}`));
        };
        const onMessage = (message: unknown) => {
          if (!isGoalAdmissionCommittedMessage(message)) return;
          cleanup();
          resolve({ turnId: message.turnId, runId: message.runId, goalId: message.goalId });
        };
        host.child.once('error', onError);
        host.child.once('exit', onExit);
        host.child.on('message', onMessage);
      }),
      PROCESS_TIMEOUT_MS,
      'execution Host did not reach the Goal admission commit gate',
    );
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

  private spawnHost(
    stderr: 'inherit' | 'ignore',
    execArgv?: readonly string[],
    idleGraceMs = 60_000,
    goalAdmissionCommitFailpoint = false,
  ): ChildProcess {
    const child = fork(
      new URL('../fixtures/execution-host.js', import.meta.url),
      [this.root, this.capability.rootId, String(idleGraceMs)],
      {
        stdio: ['ignore', 'ignore', stderr, 'ipc'],
        env: {
          ...process.env,
          HOME: join(this.base, 'home'),
          USERPROFILE: join(this.base, 'home'),
          ...(goalAdmissionCommitFailpoint
            ? { MAKA_RUNTIME_HOST_GOAL_ADMISSION_FAILPOINT: 'after_durable_commit' }
            : {}),
        },
        ...(execArgv ? { execArgv: [...execArgv] } : {}),
      },
    );
    this.#children.add(child);
    return child;
  }
}

export async function withExecutionRoot(
  run: (fixture: ExecutionFixture) => Promise<void>,
): Promise<void> {
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

export async function connectClient(
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

export async function sendRequestWithoutReadingResponse<K extends OperationKey>(
  endpoint: string,
  operation: K,
  input: OperationInput<K>,
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
  const request: RequestFrameFor<K> = {
    requestId: randomUUID(),
    operation,
    input,
  };
  await transport.write(request as RequestFrame);
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

export async function waitForTurn(
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

export async function waitForTerminalTurn(
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

function isGoalAdmissionCommittedMessage(value: unknown): value is {
  type: 'goal_admission_committed';
  turnId: string;
  runId: string;
  goalId: string;
} {
  if (!value || typeof value !== 'object') return false;
  const message = value as Record<string, unknown>;
  return (
    message.type === 'goal_admission_committed' &&
    typeof message.turnId === 'string' &&
    typeof message.runId === 'string' &&
    typeof message.goalId === 'string'
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

export function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  message: string,
): Promise<T> {
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
