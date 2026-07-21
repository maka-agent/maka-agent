import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import type { ShellRunSnapshotResult } from '@maka/core';
import type { RuntimeEvent } from '@maka/core/runtime-event';
import { isShellRunResourceRef } from '@maka/runtime';
import { openInteractiveExecutionStoresForWrite } from '@maka/storage/execution-stores';
import { openInteractiveRuntimePolicyStoresForWrite } from '@maka/storage/runtime-policy-stores';
import { tryAcquireInteractiveRootOwner } from '@maka/storage/root-authority';
import { RuntimeHostOperationError, type RuntimeHostConnection } from '../client/index.js';
import type { PtyReadResult } from '../protocol/index.js';
import {
  connectClient,
  type ExecutionFixture,
  PROCESS_TIMEOUT_MS,
  withExecutionRoot,
} from './support/execution-root-fixture.js';
import {
  startScriptedOpenAiProvider,
  type ScriptedOpenAiProvider,
} from './support/scripted-openai-provider.js';

test('keeps a real background pipe resource under one Host authority across Client detach', async () => {
  const toolCallId = `call-bash-pipe-${randomUUID()}`;
  const readyMarker = `PIPE_READY_${randomUUID()}`;
  const provider = await startScriptedOpenAiProvider({
    modelId: 'gpt-4o-mini-runtime-resource',
    toolCallId,
    toolName: 'Bash',
    toolArgs: {
      command: `node -e "console.log('${readyMarker}'); setInterval(function () {}, 1000)"`,
      run_in_background: true,
    },
    finalText: 'Background pipe started.',
  });

  try {
    await withExecutionRoot(async (fixture) => {
      await configureAiSdkSession(fixture, provider);
      const host = await fixture.startHost();
      let clientA: RuntimeHostConnection | undefined;
      let clientB: RuntimeHostConnection | undefined;
      try {
        clientA = await connectClient(fixture.root, 'desktop');
        const turnId = randomUUID();
        const started = await clientA.startTurn({
          sessionId: fixture.sessionId,
          turnId,
          content: { text: 'Start the requested long-running background pipe command.' },
        });
        const { ref } = await waitForCanonicalShellRunResult(fixture, started.runId, toolCallId);

        await clientA.close();
        clientA = undefined;
        clientB = await connectClient(fixture.root, 'tui');
        const ready = await waitForResourceOutput(clientB, fixture.sessionId, ref, readyMarker);
        assert.equal(ready.mode, 'pipes');
        assert.equal(ready.status, 'running');

        const stopped = await clientB.request(
          'resource.stop',
          { sessionId: fixture.sessionId, ref },
          PROCESS_TIMEOUT_MS,
        );
        assertTerminal(stopped);
        const terminal = await clientB.request('resource.query', {
          sessionId: fixture.sessionId,
          ref,
        });
        assertTerminal(terminal);

        const events = await readRuntimeEvents(fixture.runtimeEventsPath(started.runId));
        assertSingleToolAuthority(events, toolCallId);
        await waitForProviderRequestCount(provider, 2);
        assert.equal(provider.handlerErrors.length, 0);
      } finally {
        await Promise.allSettled([clientA?.close(), clientB?.close()]);
        await fixture.stopHost(host);
      }
    });
  } finally {
    await provider.close();
  }
});

test('transfers a real PTY controller after direct Client disconnect', {
  skip: process.platform === 'win32' ? 'POSIX PTY process' : false,
}, async () => {
  const toolCallId = `call-bash-pty-${randomUUID()}`;
  const readyMarker = `PTY_READY_${randomUUID()}`;
  const echoMarker = `INPUT_${randomUUID()}`;
  const provider = await startScriptedOpenAiProvider({
    modelId: 'gpt-4o-mini-runtime-resource',
    toolCallId,
    toolName: 'Bash',
    toolArgs: {
      command: `printf '${readyMarker}\\n'; while IFS= read -r line; do printf 'ECHO:%s\\n' "$line"; done`,
      run_in_background: true,
      pty: true,
    },
    finalText: 'Background PTY started.',
  });

  try {
    await withExecutionRoot(async (fixture) => {
      await configureAiSdkSession(fixture, provider);
      const host = await fixture.startHost();
      let clientA: RuntimeHostConnection | undefined;
      let clientB: RuntimeHostConnection | undefined;
      try {
        clientA = await connectClient(fixture.root, 'desktop');
        clientB = await connectClient(fixture.root, 'tui');
        const started = await clientA.startTurn({
          sessionId: fixture.sessionId,
          turnId: randomUUID(),
          content: { text: 'Start the requested PTY echo process.' },
        });
        const { ref } = await waitForCanonicalShellRunResult(fixture, started.runId, toolCallId);
        const first = await waitForPtySnapshot(clientA, fixture.sessionId, ref, readyMarker, null);
        const controllerA = await clientA.request('pty.acquire', {
          sessionId: fixture.sessionId,
          ref,
        });
        await assert.rejects(
          () => clientB!.request('pty.acquire', { sessionId: fixture.sessionId, ref }),
          isOperationError('controller_held'),
        );

        const unchanged = await clientA.request('pty.read', {
          sessionId: fixture.sessionId,
          ref,
          cursor: first.cursor,
        });
        assert.equal(unchanged.kind, 'unchanged');
        const controlled = await clientA.request('pty.control', {
          sessionId: fixture.sessionId,
          ref,
          controllerId: controllerA.controllerId,
          input: `${echoMarker}\r`,
          resize: { cols: 100, rows: 30 },
        });
        assert.equal(controlled.input?.accepted, true);
        assert.equal(controlled.resize?.applied, true);
        const echoed = await waitForPtySnapshot(
          clientA,
          fixture.sessionId,
          ref,
          `ECHO:${echoMarker}`,
          first.cursor,
        );
        assert.notEqual(echoed.cursor, first.cursor);
        assert.equal(echoed.resource.output.cols, 100);
        assert.equal(echoed.resource.output.rows, 30);

        await clientA.close();
        clientA = undefined;
        await waitForPtyController(clientB, fixture.sessionId, ref);
        const stopped = await clientB.request(
          'resource.stop',
          { sessionId: fixture.sessionId, ref },
          PROCESS_TIMEOUT_MS,
        );
        assertTerminal(stopped);
        await waitForProviderRequestCount(provider, 2);
        assert.equal(provider.handlerErrors.length, 0);
      } finally {
        await Promise.allSettled([clientA?.close(), clientB?.close()]);
        await fixture.stopHost(host);
      }
    });
  } finally {
    await provider.close();
  }
});

async function configureAiSdkSession(
  fixture: ExecutionFixture,
  provider: ScriptedOpenAiProvider,
): Promise<void> {
  const modelId = 'gpt-4o-mini-runtime-resource';
  const connectionSlug = `local-runtime-resource-${randomUUID()}`;
  const owner = await tryAcquireInteractiveRootOwner(fixture.capability);
  assert.ok(owner);
  if (!owner) throw new Error('Unable to acquire execution root for provider setup');
  try {
    const executionStores = await openInteractiveExecutionStoresForWrite(owner.lease);
    const policyStores = await openInteractiveRuntimePolicyStoresForWrite(owner.lease);
    const created = await policyStores.connectionCatalog.create({
      expectedCatalogRevision: 0,
      connection: {
        slug: connectionSlug,
        name: 'Local Runtime Resource acceptance provider',
        providerType: 'openai',
        baseUrl: provider.baseUrl,
        enabled: true,
        enabledModelIds: [modelId],
      },
    });
    assert.equal(created.kind, 'committed');
    if (created.kind !== 'committed') throw new Error('Provider connection was not committed');
    const connection = created.snapshot.connections[0];
    assert.ok(connection);
    if (!connection) throw new Error('Provider connection is missing');
    const credential = await policyStores.credentialVault.set({
      locator: { scope: 'connection', connectionId: connection.connectionId, kind: 'api_key' },
      expected: null,
      secret: `local-runtime-resource-key-${randomUUID()}`,
    });
    assert.equal(credential.kind, 'committed');
    const fetch = await policyStores.operations.beginModelFetch(connection.connectionId);
    assert.equal(fetch.kind, 'ready');
    if (fetch.kind !== 'ready') throw new Error('Provider model fetch was not ready');
    const fetched = await policyStores.operations.completeModelFetch(fetch.ticket, {
      models: [
        {
          id: modelId,
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
      llmConnectionSlug: connectionSlug,
      model: modelId,
      permissionMode: 'bypass',
    });
  } finally {
    await owner.close();
  }
}

async function waitForCanonicalShellRunResult(
  fixture: ExecutionFixture,
  runId: string,
  toolCallId: string,
): Promise<{ ref: string }> {
  const deadline = Date.now() + PROCESS_TIMEOUT_MS;
  while (true) {
    const events = await readRuntimeEvents(fixture.runtimeEventsPath(runId)).catch(() => []);
    const response = events.find(
      (event) => event.content?.kind === 'function_response' && event.content.id === toolCallId,
    );
    if (response?.content?.kind === 'function_response') {
      const result = response.content.result;
      assert.ok(result && typeof result === 'object');
      const shellRun = result as Record<string, unknown>;
      assert.equal(shellRun.kind, 'shell_run');
      assert.equal(typeof shellRun.ref, 'string');
      assert.equal(isShellRunResourceRef(shellRun.ref as string), true);
      return { ref: shellRun.ref as string };
    }
    if (Date.now() >= deadline) throw new Error('real Bash T2 result was not committed');
    await sleep(20);
  }
}

async function waitForResourceOutput(
  client: RuntimeHostConnection,
  sessionId: string,
  ref: string,
  marker: string,
): Promise<ShellRunSnapshotResult> {
  const deadline = Date.now() + PROCESS_TIMEOUT_MS;
  while (true) {
    const metadata = await client.request('resource.query', { sessionId, ref });
    assert.equal(metadata.status, 'running');
    const snapshot = await client.request('resource.read', { sessionId, ref });
    if (snapshot.mode === 'pipes' && snapshot.output.stdout.includes(marker)) return snapshot;
    if (Date.now() >= deadline) throw new Error('background pipe READY output was not observed');
    await sleep(20);
  }
}

async function waitForPtySnapshot(
  client: RuntimeHostConnection,
  sessionId: string,
  ref: string,
  marker: string,
  cursor: string | null,
): Promise<Extract<PtyReadResult, { kind: 'snapshot' }>> {
  const deadline = Date.now() + PROCESS_TIMEOUT_MS;
  while (true) {
    const result = await client.request('pty.read', { sessionId, ref, cursor });
    if (
      result.kind === 'snapshot' &&
      `${result.resource.output.scrollback}\n${result.resource.output.screen}`.includes(marker)
    ) {
      return result;
    }
    if (Date.now() >= deadline) throw new Error(`PTY output did not contain ${marker}`);
    await sleep(20);
  }
}

async function waitForPtyController(
  client: RuntimeHostConnection,
  sessionId: string,
  ref: string,
): Promise<void> {
  const deadline = Date.now() + PROCESS_TIMEOUT_MS;
  while (true) {
    try {
      await client.request('pty.acquire', { sessionId, ref });
      return;
    } catch (error) {
      if (!(error instanceof RuntimeHostOperationError) || error.code !== 'controller_held') {
        throw error;
      }
      if (Date.now() >= deadline) throw new Error('PTY controller was not released on disconnect');
      await sleep(20);
    }
  }
}

async function readRuntimeEvents(path: string): Promise<RuntimeEvent[]> {
  const content = await readFile(path, 'utf8');
  return content
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as RuntimeEvent);
}

function assertSingleToolAuthority(events: readonly RuntimeEvent[], toolCallId: string): void {
  const callIndexes: number[] = [];
  const dispatchIndexes: number[] = [];
  const responseIndexes: number[] = [];
  let operationId: string | undefined;
  for (const [index, event] of events.entries()) {
    if (event.content?.kind === 'function_call' && event.content.id === toolCallId) {
      callIndexes.push(index);
      operationId = event.refs?.operationId;
      assert.equal(event.refs?.toolCallId, toolCallId);
    }
    if (event.actions?.toolDispatch?.providerToolCallId === toolCallId) {
      dispatchIndexes.push(index);
      assert.equal(event.actions.toolDispatch.operationId, operationId);
      assert.equal(event.refs?.operationId, operationId);
      assert.equal(event.refs?.toolCallId, toolCallId);
    }
    if (event.content?.kind === 'function_response' && event.content.id === toolCallId) {
      responseIndexes.push(index);
      assert.equal(event.refs?.operationId, operationId);
      assert.equal(event.refs?.toolCallId, toolCallId);
    }
  }
  assert.equal(typeof operationId, 'string');
  assert.equal(callIndexes.length, 1);
  assert.equal(dispatchIndexes.length, 1);
  assert.equal(responseIndexes.length, 1);
  assert.ok(callIndexes[0]! < dispatchIndexes[0]!);
  assert.ok(dispatchIndexes[0]! < responseIndexes[0]!);
}

async function waitForProviderRequestCount(
  provider: ScriptedOpenAiProvider,
  expected: number,
): Promise<void> {
  const deadline = Date.now() + PROCESS_TIMEOUT_MS;
  while (provider.requests.length < expected) {
    if (Date.now() >= deadline) throw new Error('ai-sdk Tool loop did not return to the provider');
    await sleep(20);
  }
}

function assertTerminal(resource: { status: string }): void {
  assert.ok(
    ['completed', 'failed', 'timed_out', 'cancelled', 'orphaned'].includes(resource.status),
  );
}

function isOperationError(code: string): (error: unknown) => boolean {
  return (error) => error instanceof RuntimeHostOperationError && error.code === code;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
