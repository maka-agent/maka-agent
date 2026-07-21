import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import type { AgentRunEvent, AgentRunHeader } from '@maka/core/agent-run';
import type { StoredMessage } from '@maka/core/session';
import { isTerminalRuntimeEvent, type RuntimeEvent } from '@maka/core/runtime-event';
import {
  openInteractiveExecutionStoresForRead,
  openInteractiveExecutionStoresForWrite,
  type RootTurnAdmission,
} from '@maka/storage/execution-stores';
import { openInteractiveRuntimePolicyStoresForWrite } from '@maka/storage/runtime-policy-stores';
import {
  tryAcquireInteractiveRootOwner,
  tryAcquireInteractiveRootReader,
} from '@maka/storage/root-authority';
import type { GoalProjection } from '../protocol/index.js';
import { RuntimeHostOperationError } from '../client/index.js';
import {
  connectClient,
  type ExecutionFixture,
  PROCESS_TIMEOUT_MS,
  waitForTerminalTurn,
  withExecutionRoot,
  withTimeout,
} from './support/execution-root-fixture.js';
import {
  type ScriptedOpenAiProvider,
  type ScriptedOpenAiResponse,
  startScriptedOpenAiProvider,
} from './support/scripted-openai-provider.js';

const MODEL_ID = 'gpt-4o-mini-goal-host';
const CONNECTION_SLUG = 'local-goal-host';

test('two UDS Clients share one paused Goal generation and one clear transition', async () => {
  const provider = await startScriptedOpenAiProvider({
    responses: pausedGoalResponses('share one paused Goal'),
  });
  try {
    await withExecutionRoot(async (fixture) => {
      await configureLocalModel(fixture, provider);
      const host = await fixture.startHost();
      const first = await connectClient(fixture.root, 'desktop');
      const second = await connectClient(fixture.root, 'tui');
      const turnId = randomUUID();
      try {
        await first.startTurn({
          sessionId: fixture.sessionId,
          turnId,
          content: { text: 'Set and pause the requested Goal.' },
        });
        await waitForTerminalTurn(first, fixture.sessionId, turnId);

        const fromFirst = await first.request('goal.query', { sessionId: fixture.sessionId });
        const fromSecond = await second.request('goal.query', { sessionId: fixture.sessionId });
        assert.deepEqual(fromSecond, fromFirst);
        assert.equal(fromFirst.kind, 'item');
        if (fromFirst.kind !== 'item') return;
        assert.equal(fromFirst.goal.status, 'paused');

        const cleared = await first.request('goal.clear', {
          sessionId: fixture.sessionId,
          goalId: fromFirst.goal.goalId,
        });
        assert.equal(cleared.kind, 'cleared');
        assert.equal(cleared.goal.goalId, fromFirst.goal.goalId);
        assert.equal(cleared.goal.revision, fromFirst.goal.revision + 1);
        assert.equal(cleared.goal.status, 'cleared');
        assert.deepEqual(await second.request('goal.query', { sessionId: fixture.sessionId }), {
          kind: 'item',
          goal: cleared.goal,
        });
      } finally {
        await first.close();
        await second.close();
        await fixture.stopHost(host);
      }

      assertSingleTerminalTurn(await fixture.readTurn(turnId));
      const facts = await readDurableFacts(fixture);
      assert.equal(facts.runs.length, 1);
      assert.equal(facts.messages.filter((message) => message.type === 'user').length, 1);
      const providerRequest = JSON.stringify(provider.requests[0]?.body);
      assert.ok(providerRequest.includes('Maka runtime sandbox context'));
      assert.ok(providerRequest.includes(fixture.root));
      const sandboxTrace = facts.agentEvents.find(
        (event) => event.turnId === turnId && event.type === 'sandbox_context_resolved',
      );
      assert.ok(sandboxTrace);
      assert.equal(JSON.stringify(sandboxTrace).includes(fixture.root), false);
    });
  } finally {
    await provider.close();
  }
});

test('Goal residency carries a disconnected Host through a second root Turn and natural exit', async () => {
  let releaseSecondTurn: (() => void) | undefined;
  const secondTurnGate = new Promise<void>((resolve) => {
    releaseSecondTurn = resolve;
  });
  const responses: ScriptedOpenAiResponse[] = [
    toolResponse('goal-set', 'GoalSet', {
      condition: 'finish the autonomous second turn',
      max_iterations: 4,
    }),
    textResponse('first-final', 'The Goal is armed.'),
    evaluationResponse('first-evaluation', {
      met: false,
      progress: true,
      reason: 'A second turn is still required',
    }),
    {
      ...textResponse('second-final', 'The autonomous second turn is complete.'),
      beforeRespond: secondTurnGate,
    },
    evaluationResponse('second-evaluation', {
      met: true,
      progress: true,
      reason: 'The second turn completed the Goal',
    }),
  ];
  const provider = await startScriptedOpenAiProvider({ responses });
  try {
    await withExecutionRoot(async (fixture) => {
      await configureLocalModel(fixture, provider);
      await fixture.createTasks(['Reconcile the Goal continuation task']);
      const host = await fixture.startHost({ idleGraceMs: 40 });
      const first = await connectClient(fixture.root, 'desktop');
      const second = await connectClient(fixture.root, 'tui');
      const firstTurnId = randomUUID();
      try {
        await first.startTurn({
          sessionId: fixture.sessionId,
          turnId: firstTurnId,
          content: { text: 'Arm the Goal and begin work.' },
        });
        await waitForTerminalTurn(second, fixture.sessionId, firstTurnId);
        await waitForRequestCount(provider, 4);
      } finally {
        await first.close();
        await second.close();
      }

      await sleep(120);
      assert.equal(host.child.exitCode, null, 'Goal residency must outlive the idle grace');
      assert.equal(host.child.signalCode, null, 'Goal residency must keep the Host alive');
      releaseSecondTurn?.();
      await fixture.waitForHostExit(host);

      const facts = await readDurableFacts(fixture);
      assert.equal(facts.runs.length, 2);
      assert.equal(new Set(facts.runs.map((run) => run.turnId)).size, 2);
      assert.equal(new Set(facts.runs.map((run) => run.runId)).size, 2);
      for (const run of facts.runs) {
        assert.equal(
          facts.runtimeEvents.filter(
            (event) => event.runId === run.runId && isTerminalRuntimeEvent(event),
          ).length,
          1,
        );
      }
      assert.equal(facts.messages.filter((message) => message.type === 'user').length, 2);
      const taskGateTraces = facts.agentEvents.filter(
        (event) => event.type === 'task_gate_decided',
      );
      assert.ok(taskGateTraces.length >= 1);
      assert.ok(
        taskGateTraces.some(
          (event) => event.turnId === firstTurnId && event.data?.decision === 'reminder_injected',
        ),
      );
      assert.deepEqual(provider.handlerErrors, []);
    });
  } finally {
    releaseSecondTurn?.();
    await provider.close();
  }
});

test('SIGKILL successor starts without an in-memory Goal and does not duplicate durable facts', {
  skip: process.platform === 'win32' ? 'POSIX process death gate' : false,
}, async () => {
  const provider = await startScriptedOpenAiProvider({
    responses: pausedGoalResponses('do not recover this paused Goal'),
  });
  try {
    await withExecutionRoot(async (fixture) => {
      await configureLocalModel(fixture, provider);
      const firstHost = await fixture.startHost();
      const firstClient = await connectClient(fixture.root, 'desktop');
      const turnId = randomUUID();
      let paused: GoalProjection;
      try {
        await firstClient.startTurn({
          sessionId: fixture.sessionId,
          turnId,
          content: { text: 'Set a Goal that remains paused.' },
        });
        await waitForTerminalTurn(firstClient, fixture.sessionId, turnId);
        const query = await firstClient.request('goal.query', { sessionId: fixture.sessionId });
        assert.equal(query.kind, 'item');
        if (query.kind !== 'item') return;
        paused = query.goal;
        assert.equal(paused.status, 'paused');
      } finally {
        await firstClient.close();
      }

      await fixture.killHost(firstHost);
      const successor = await fixture.startHost();
      assert.notEqual(successor.hostEpoch, firstHost.hostEpoch);
      const successorClient = await connectClient(fixture.root, 'tui');
      try {
        assert.deepEqual(
          await successorClient.request('goal.query', { sessionId: fixture.sessionId }),
          { kind: 'none' },
        );
      } finally {
        await successorClient.close();
        await fixture.stopHost(successor);
      }

      assertSingleTerminalTurn(await fixture.readTurn(turnId));
      const facts = await readDurableFacts(fixture);
      assert.equal(facts.runs.length, 1);
      assert.equal(facts.messages.filter((message) => message.type === 'user').length, 1);
      assert.deepEqual(provider.handlerErrors, []);
    });
  } finally {
    await provider.close();
  }
});

test('SIGKILL after durable Goal admission terminalizes without replaying the provider', {
  skip: process.platform === 'win32' ? 'POSIX process death gate' : false,
}, async () => {
  const provider = await startScriptedOpenAiProvider({
    responses: [
      toolResponse('goal-set-crash', 'GoalSet', {
        condition: 'survive the admission crash without replay',
        max_iterations: 4,
      }),
      textResponse('goal-armed-crash', 'The Goal is armed.'),
      evaluationResponse('goal-continue-crash', {
        met: false,
        progress: true,
        reason: 'A continuation is required',
      }),
      textResponse('normal-after-crash', 'A normal root Turn still works.'),
    ],
  });
  try {
    await withExecutionRoot(async (fixture) => {
      await configureLocalModel(fixture, provider);
      await fixture.createTasks(['Complete the post-crash continuation check']);
      const firstHost = await fixture.startHost({ goalAdmissionCommitFailpoint: true });
      const firstClient = await connectClient(fixture.root, 'desktop');
      const initialTurnId = randomUUID();
      const admissionCommitted = fixture.waitForGoalAdmissionCommit(firstHost);
      try {
        await firstClient.startTurn({
          sessionId: fixture.sessionId,
          turnId: initialTurnId,
          content: { text: 'Set the Goal and begin the first step.' },
        });
        const pendingGoalTurn = await admissionCommitted;
        assert.notEqual(pendingGoalTurn.turnId, initialTurnId);
        assert.equal(provider.requests.length, 3);
        await firstClient.close();
        await fixture.killHost(firstHost);

        const requestsAtCrash = provider.requests.length;
        const pendingAdmission = await readRootTurnAdmission(fixture, pendingGoalTurn.turnId);
        assert.deepEqual(pendingAdmission.origin, {
          kind: 'goal',
          goalId: pendingGoalTurn.goalId,
        });
        const successor = await fixture.startHost();
        const successorClient = await connectClient(fixture.root, 'tui');
        try {
          assert.deepEqual(
            await successorClient.request('goal.query', { sessionId: fixture.sessionId }),
            { kind: 'none' },
          );
          const recovered = await waitForTerminalTurn(
            successorClient,
            fixture.sessionId,
            pendingGoalTurn.turnId,
          );
          assert.equal(recovered.status, 'failed');
          if (recovered.status !== 'failed') assert.fail('Goal recovery was not terminal failed');
          assert.equal(recovered.failureClass, 'app_restarted');
          await assert.rejects(
            () =>
              successorClient.startTurn({
                sessionId: fixture.sessionId,
                turnId: pendingGoalTurn.turnId,
                content: pendingAdmission.normalizedInput,
              }),
            (error: unknown) =>
              error instanceof RuntimeHostOperationError && error.code === 'operation_conflict',
          );
          assert.equal(provider.requests.length, requestsAtCrash);

          const normalTurnId = randomUUID();
          await successorClient.startTurn({
            sessionId: fixture.sessionId,
            turnId: normalTurnId,
            content: { text: 'Run a normal root Turn after recovery.' },
          });
          const normal = await waitForTerminalTurn(
            successorClient,
            fixture.sessionId,
            normalTurnId,
          );
          assert.equal(normal.status, 'completed');
          assert.equal(provider.requests.length, requestsAtCrash + 1);
        } finally {
          await successorClient.close();
          await fixture.stopHost(successor);
        }

        const recoveredLedger = await fixture.readTurn(pendingGoalTurn.turnId);
        assertSingleTerminalTurn(recoveredLedger);
        assert.equal(recoveredLedger.runs[0]?.runId, pendingGoalTurn.runId);
        assert.equal(recoveredLedger.runs[0]?.collaborationMode, 'agent');
        assert.equal(recoveredLedger.runs[0]?.status, 'failed');
        assert.equal(recoveredLedger.runs[0]?.failureClass, 'app_restarted');
        const recoveredUser = recoveredLedger.userMessages[0];
        assert.equal(recoveredUser?.type, 'user');
        if (recoveredUser?.type !== 'user') assert.fail('Goal recovery lost its UserMessage');
        assert.deepEqual(recoveredUser.origin, {
          kind: 'goal',
          goalId: pendingGoalTurn.goalId,
        });
      } finally {
        await firstClient.close().catch(() => undefined);
        if (firstHost.child.exitCode === null && firstHost.child.signalCode === null) {
          await fixture.killHost(firstHost);
        }
      }
    });
  } finally {
    await provider.close();
  }
});

function pausedGoalResponses(condition: string): ScriptedOpenAiResponse[] {
  return [
    toolResponse('goal-set', 'GoalSet', { condition, max_iterations: 4 }),
    toolResponse('goal-pause', 'GoalPause', {}),
    textResponse('paused-final', 'The Goal is paused.'),
  ];
}

function toolResponse(id: string, name: string, args: unknown): ScriptedOpenAiResponse {
  return {
    kind: 'stream',
    modelId: MODEL_ID,
    id: `chatcmpl-${id}`,
    delta: {
      role: 'assistant',
      tool_calls: [
        {
          index: 0,
          id: `call:${id}`,
          type: 'function',
          function: { name, arguments: JSON.stringify(args) },
        },
      ],
    },
    finishReason: 'tool_calls',
  };
}

function textResponse(id: string, text: string): ScriptedOpenAiResponse {
  return {
    kind: 'stream',
    modelId: MODEL_ID,
    id: `chatcmpl-${id}`,
    delta: { role: 'assistant', content: text },
    finishReason: 'stop',
  };
}

function evaluationResponse(
  id: string,
  input: { met: boolean; progress: boolean; reason: string },
): ScriptedOpenAiResponse {
  return {
    kind: 'json',
    modelId: MODEL_ID,
    id: `chatcmpl-${id}`,
    text: JSON.stringify({
      met: input.met,
      impossible: false,
      progress: input.progress,
      waiting: false,
      reason: input.reason,
    }),
  };
}

async function configureLocalModel(
  fixture: ExecutionFixture,
  provider: ScriptedOpenAiProvider,
): Promise<void> {
  const owner = await tryAcquireInteractiveRootOwner(fixture.capability);
  assert.ok(owner);
  if (!owner) throw new Error('Unable to acquire execution root for model setup');
  try {
    const executionStores = await openInteractiveExecutionStoresForWrite(owner.lease);
    const policyStores = await openInteractiveRuntimePolicyStoresForWrite(owner.lease);
    const created = await policyStores.connectionCatalog.create({
      expectedCatalogRevision: 0,
      connection: {
        slug: CONNECTION_SLUG,
        name: 'Local Goal Host provider',
        providerType: 'openai',
        baseUrl: provider.baseUrl,
        enabled: true,
        enabledModelIds: [MODEL_ID],
      },
    });
    assert.equal(created.kind, 'committed');
    if (created.kind !== 'committed') return;
    const connection = created.snapshot.connections[0];
    assert.ok(connection);
    if (!connection) return;
    const credential = await policyStores.credentialVault.set({
      locator: {
        scope: 'connection',
        connectionId: connection.connectionId,
        kind: 'api_key',
      },
      expected: null,
      secret: `goal-host-key-${randomUUID()}`,
    });
    assert.equal(credential.kind, 'committed');
    const fetch = await policyStores.operations.beginModelFetch(connection.connectionId);
    assert.equal(fetch.kind, 'ready');
    if (fetch.kind !== 'ready') return;
    const fetched = await policyStores.operations.completeModelFetch(fetch.ticket, {
      models: [
        {
          id: MODEL_ID,
          apiProtocol: 'openai-chat',
          capabilities: { chat: true, functionCalling: true },
        },
      ],
      source: 'fetched',
      fetchedAt: Date.now(),
    });
    assert.equal(fetched.kind, 'committed');
    await executionStores.sessionStore.updateHeader(fixture.sessionId, {
      backend: 'ai-sdk',
      llmConnectionSlug: CONNECTION_SLUG,
      model: MODEL_ID,
    });
  } finally {
    await owner.close();
  }
}

async function readDurableFacts(fixture: ExecutionFixture): Promise<{
  runs: AgentRunHeader[];
  messages: StoredMessage[];
  agentEvents: AgentRunEvent[];
  runtimeEvents: RuntimeEvent[];
}> {
  const reader = await waitForReader(fixture);
  try {
    const stores = await openInteractiveExecutionStoresForRead(reader.lease);
    const runs = await stores.agentRunStore.listSessionRuns(fixture.sessionId);
    const messages = await stores.sessionStore.readMessages(fixture.sessionId);
    const agentEvents = (
      await Promise.all(
        runs.map((run) => stores.agentRunStore.readEvents(fixture.sessionId, run.runId)),
      )
    ).flat();
    const runtimeEvents = (
      await Promise.all(
        runs.map((run) =>
          stores.runtimeEventStore.readImmutableRuntimeEvents(fixture.sessionId, run.runId),
        ),
      )
    ).flat();
    return { runs, messages, agentEvents, runtimeEvents };
  } finally {
    await reader.close();
  }
}

async function readRootTurnAdmission(
  fixture: ExecutionFixture,
  turnId: string,
): Promise<RootTurnAdmission> {
  const reader = await waitForReader(fixture);
  try {
    const stores = await openInteractiveExecutionStoresForRead(reader.lease);
    const admission = await stores.agentRunStore.readRootTurnAdmission(fixture.sessionId, turnId);
    assert.ok(admission);
    return admission;
  } finally {
    await reader.close();
  }
}

async function waitForReader(fixture: ExecutionFixture) {
  const deadline = Date.now() + PROCESS_TIMEOUT_MS;
  while (true) {
    const reader = await tryAcquireInteractiveRootReader(fixture.capability);
    if (reader) return reader;
    if (Date.now() >= deadline) throw new Error('Execution root reader did not become available');
    await sleep(20);
  }
}

async function waitForRequestCount(
  provider: ScriptedOpenAiProvider,
  expected: number,
): Promise<void> {
  await withTimeout(
    (async () => {
      while (provider.requests.length < expected) await sleep(10);
    })(),
    PROCESS_TIMEOUT_MS,
    `Provider did not receive ${expected} requests`,
  );
}

function assertSingleTerminalTurn(ledger: {
  runs: AgentRunHeader[];
  userMessages: StoredMessage[];
  terminalEvents: RuntimeEvent[];
  classification: { kind: string };
}): void {
  assert.equal(ledger.runs.length, 1);
  assert.equal(ledger.userMessages.length, 1);
  assert.equal(ledger.terminalEvents.length, 1);
  assert.equal(ledger.classification.kind, 'fact');
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
