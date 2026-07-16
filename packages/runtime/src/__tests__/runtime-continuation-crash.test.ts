import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, test } from 'node:test';

import type { AgentRunHeader, RuntimeEvent } from '@maka/core';
import {
  createAgentRunStore,
  createRuntimeEventStore,
  createSessionStore,
} from '@maka/storage';

import { type RuntimeContinuationFailpoint } from '../agent-run.js';
import { BackendRegistry, SessionManager } from '../session-manager.js';
import { FakeBackend } from '../fake-backend.js';

const CRASH_CHILD_ENV = 'MAKA_RUNTIME_CONTINUATION_CRASH_CHILD';
const FAILPOINTS: readonly RuntimeContinuationFailpoint[] = [
  'after_run_created',
  'after_continuation_start_committed',
  'after_terminal_event_committed',
  'after_terminal_header_committed',
];

if (process.env[CRASH_CHILD_ENV] === '1') {
  await runCrashChild();
} else {
  describe('runtime resume phase 1 process crash harness', () => {
    test('reopens and repairs every committed continuation prefix after SIGKILL', { timeout: 60_000 }, async () => {
      const root = await mkdtemp(join(tmpdir(), 'maka-runtime-continuation-crash-'));
      try {
        for (const failpoint of FAILPOINTS) {
          const workspaceRoot = join(root, failpoint);
          await crashContinuationAt(workspaceRoot, failpoint);

          const store = createSessionStore(workspaceRoot);
          const runStore = createAgentRunStore(workspaceRoot);
          const runtimeEventStore = createRuntimeEventStore(workspaceRoot);
          const [session] = await store.list();
          assert.ok(session, `${failpoint} did not persist a session`);
          const runsBeforeRecovery = await runStore.listSessionRuns(session.id);
          const continuation = runsBeforeRecovery.find((run) => run.continuationSource !== undefined);
          assert.ok(continuation, `${failpoint} did not persist the continuation claim`);
          assert.equal(continuation.continuationSource?.sourceRunId, 'source-run');
          const prefix = await runtimeEventStore.readRuntimeEvents(session.id, continuation.runId);
          assertPrefix(failpoint, continuation, prefix);

          const manager = createManager(workspaceRoot);
          const repeatedPlan = await manager.planAuthoritativeSafeBoundaryContinuation(session.id, {
            sourceRunId: 'source-run',
          });
          assert.equal(repeatedPlan.disposition, 'park');
          assert.deepEqual(repeatedPlan.rejectionReasons, ['continuation_already_exists']);

          await manager.recoverInterruptedSessions();
          const repaired = await runStore.readRun(session.id, continuation.runId);
          const repairedEvents = await runtimeEventStore.readRuntimeEvents(session.id, continuation.runId);
          const terminalEvents = repairedEvents.filter((event) => event.actions?.endInvocation === true);
          assert.equal(terminalEvents.length, 1, `${failpoint} must recover one terminal fact`);
          assert.ok(
            repaired.status === 'completed' || repaired.status === 'failed' || repaired.status === 'cancelled',
            `${failpoint} left the continuation non-terminal`,
          );
        }
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });
  });
}

async function runCrashChild(): Promise<void> {
  const workspaceRoot = requiredEnv('MAKA_RUNTIME_CONTINUATION_WORKSPACE');
  const failpoint = requiredEnv('MAKA_RUNTIME_CONTINUATION_FAILPOINT') as RuntimeContinuationFailpoint;
  const store = createSessionStore(workspaceRoot);
  const runStore = createAgentRunStore(workspaceRoot);
  const runtimeEventStore = createRuntimeEventStore(workspaceRoot);
  const backends = new BackendRegistry();
  backends.register('fake', (ctx) => new FakeBackend({
    sessionId: ctx.sessionId,
    header: ctx.header,
    store: ctx.store,
    appendMessage: ctx.appendMessage,
  }));
  let id = 0;
  const manager = new SessionManager({
    store,
    runStore,
    runtimeEventStore,
    backends,
    safeBoundaryResumeEnabled: true,
    inspectContinuationSafety: async () => stableSafetyObservation(),
    continuationFailpoint: async (point) => {
      if (point !== failpoint) return;
      process.stdout.write(`READY:${point}\n`);
      await new Promise<never>(() => {
        setInterval(() => {}, 1_000);
      });
    },
    newId: () => `id-${++id}`,
    now: (() => {
      let ts = 10;
      return () => ++ts;
    })(),
    runtimeSource: 'test',
  });
  const session = await manager.createSession({
    cwd: workspaceRoot,
    backend: 'fake',
    llmConnectionSlug: 'fake',
    model: 'fake-model',
    permissionMode: 'execute',
    name: 'continuation crash child',
  });
  await runStore.createRun(sourceHeader(session.id, workspaceRoot));
  for (const event of sourceEvents(session.id)) {
    await runtimeEventStore.appendRuntimeEvent(session.id, 'source-run', event);
  }
  const plan = await manager.planAuthoritativeSafeBoundaryContinuation(session.id, {
    sourceRunId: 'source-run',
  });
  if (!plan.continuation) throw new Error(`expected continuation: ${plan.rejectionReasons.join(',')}`);
  for await (const _event of manager.resumeSafeBoundaryContinuation(plan.continuation)) {
    // drain until the selected failpoint suspends the child
  }
  throw new Error(`continuation completed without reaching failpoint ${failpoint}`);
}

function createManager(workspaceRoot: string): SessionManager {
  const store = createSessionStore(workspaceRoot);
  const runStore = createAgentRunStore(workspaceRoot);
  const runtimeEventStore = createRuntimeEventStore(workspaceRoot);
  const backends = new BackendRegistry();
  backends.register('fake', (ctx) => new FakeBackend({
    sessionId: ctx.sessionId,
    header: ctx.header,
    store: ctx.store,
    appendMessage: ctx.appendMessage,
  }));
  let id = 100;
  return new SessionManager({
    store,
    runStore,
    runtimeEventStore,
    backends,
    safeBoundaryResumeEnabled: true,
    inspectContinuationSafety: async () => stableSafetyObservation(),
    newId: () => `recovery-id-${++id}`,
    now: Date.now,
    runtimeSource: 'test',
  });
}

async function crashContinuationAt(
  workspaceRoot: string,
  failpoint: RuntimeContinuationFailpoint,
): Promise<void> {
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url)], {
    cwd: dirname(fileURLToPath(import.meta.url)),
    env: {
      ...process.env,
      [CRASH_CHILD_ENV]: '1',
      MAKA_RUNTIME_CONTINUATION_WORKSPACE: workspaceRoot,
      MAKA_RUNTIME_CONTINUATION_FAILPOINT: failpoint,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => { stdout += chunk; });
  child.stderr.on('data', (chunk: string) => { stderr += chunk; });
  const exited = once(child, 'exit') as Promise<[number | null, NodeJS.Signals | null]>;
  const deadline = Date.now() + 10_000;
  while (!stdout.includes(`READY:${failpoint}\n`) && child.exitCode === null && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  if (!stdout.includes(`READY:${failpoint}\n`)) {
    child.kill('SIGKILL');
    await exited;
    throw new Error(`${failpoint} child did not reach boundary: ${stderr || stdout}`);
  }
  assert.equal(child.kill('SIGKILL'), true);
  const [exitCode, signal] = await exited;
  assert.ok(exitCode !== 0 || signal !== null);
}

function assertPrefix(
  failpoint: RuntimeContinuationFailpoint,
  header: AgentRunHeader,
  events: readonly RuntimeEvent[],
): void {
  if (failpoint === 'after_run_created') {
    assert.equal(header.status, 'created');
    assert.deepEqual(events, []);
    return;
  }
  assert.equal(events[0]?.actions?.stateDelta?.continuationStart, true);
  if (failpoint === 'after_continuation_start_committed') {
    assert.equal(events.some((event) => event.actions?.endInvocation === true), false);
    return;
  }
  assert.equal(events.filter((event) => event.actions?.endInvocation === true).length, 1);
  if (failpoint === 'after_terminal_event_committed') {
    assert.equal(['created', 'running'].includes(header.status), true);
    return;
  }
  assert.equal(header.status, 'completed');
}

function sourceHeader(sessionId: string, cwd: string): AgentRunHeader {
  return {
    runId: 'source-run',
    invocationId: 'source-invocation',
    sessionId,
    turnId: 'source-turn',
    status: 'failed',
    backendKind: 'fake',
    llmConnectionSlug: 'fake',
    modelId: 'fake-model',
    cwd,
    workspaceIdentity: 'workspace-1',
    permissionMode: 'execute',
    createdAt: 1,
    updatedAt: 2,
    completedAt: 2,
    failureClass: 'app_restarted',
  };
}

function sourceEvents(sessionId: string): RuntimeEvent[] {
  const identity = {
    sessionId,
    invocationId: 'source-invocation',
    runId: 'source-run',
    turnId: 'source-turn',
  };
  return [
    {
      ...identity,
      id: 'source-user',
      ts: 1,
      partial: false,
      author: 'user',
      role: 'user',
      content: { kind: 'text', text: 'continue after crash' },
    },
    {
      ...identity,
      id: 'source-terminal',
      ts: 2,
      partial: false,
      author: 'system',
      role: 'system',
      status: 'failed',
      actions: { endInvocation: true, stateDelta: { failureClass: 'app_restarted' } },
    },
  ];
}

function stableSafetyObservation() {
  return {
    workspaceIdentity: 'workspace-1',
    backgroundOperationsSettled: true,
    availableToolNames: [] as string[],
  };
}

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}
