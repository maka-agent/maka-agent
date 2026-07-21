import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import { RuntimeHostOperationError, type RuntimeHostConnection } from '../client/index.js';
import type {
  AutomationDefinitionInput,
  AutomationMutateResult,
  AutomationProjection,
  HostStatusResult,
} from '../protocol/index.js';
import { connectClient, withExecutionRoot } from './support/execution-root-fixture.js';

test('two UDS Clients share Automation CAS while timer residency survives Client detach', async () => {
  await withExecutionRoot(async (fixture) => {
    const host = await fixture.startHost({ idleGraceMs: 25 });
    const automationId = 'shared-automation';
    const definition: AutomationDefinitionInput = {
      kind: 'heartbeat',
      name: 'shared heartbeat',
      prompt: 'Complete this scheduled check.',
      executionTarget: { kind: 'existing_session', sessionId: fixture.sessionId },
      schedule: { type: 'interval', seconds: 1 },
      maxFires: 2,
      expiresAt: Date.now() + 60_000,
    };
    let desktop: RuntimeHostConnection | undefined;
    let tui: RuntimeHostConnection | undefined;
    let committed!: Extract<AutomationMutateResult, { kind: 'committed' | 'unchanged' }>;
    let createdRevision!: number;
    try {
      desktop = await connectClient(fixture.root, 'desktop');
      tui = await connectClient(fixture.root, 'tui');
      const created = await desktop.request('automation.mutate', {
        mutation: { kind: 'create', automationId, definition },
      });
      assert.equal(created.kind, 'committed');
      if (created.kind !== 'committed') assert.fail('Automation create did not commit');
      createdRevision = created.automation.revision;

      const replay = await tui.request('automation.mutate', {
        mutation: { kind: 'create', automationId, definition },
      });
      assert.equal(replay.kind, 'unchanged');
      assert.deepEqual(replay, { ...created, kind: 'unchanged' });

      const page = await tui.request('automation.query', {
        kind: 'list',
        limit: 16,
        revision: null,
        cursor: null,
      });
      assert.equal(page.kind, 'page');
      if (page.kind !== 'page') assert.fail('Automation list did not return a page');
      assert.deepEqual(page.items, [created.automation]);

      const updates = await Promise.allSettled([
        desktop.request('automation.mutate', {
          mutation: {
            kind: 'update',
            automationId,
            expectedRevision: created.automation.revision,
            definition: { ...definition, name: 'desktop won' },
          },
        }),
        tui.request('automation.mutate', {
          mutation: {
            kind: 'update',
            automationId,
            expectedRevision: created.automation.revision,
            definition: { ...definition, name: 'tui won' },
          },
        }),
      ]);
      const winners = updates.filter(
        (result): result is PromiseFulfilledResult<AutomationMutateResult> =>
          result.status === 'fulfilled',
      );
      const losers = updates.filter(
        (result): result is PromiseRejectedResult => result.status === 'rejected',
      );
      assert.equal(winners.length, 1);
      assert.equal(losers.length, 1);
      assert.ok(operationError('operation_conflict')(losers[0]?.reason));
      committed = winners[0]!.value as typeof committed;
      assert.equal(committed.kind, 'committed');
      assert.equal(committed.automation.revision, created.automation.revision + 1);
    } finally {
      await Promise.all([desktop?.close(), tui?.close()]);
    }

    await delay(1_250);
    assert.equal(host.child.exitCode, null);
    assert.equal(host.child.signalCode, null);

    let observer: RuntimeHostConnection | undefined;
    try {
      observer = await connectClient(fixture.root, 'run');
      assert.equal(observer.hostEpoch, host.hostEpoch);
      const fired = await waitForAutomationFire(observer, automationId);
      assert.equal(fired.name, committed.automation.name);
      assert.equal(fired.lastFire?.status, 'succeeded');
    } finally {
      await observer?.close();
      await fixture.stopHost(host);
    }

    await fixture.archiveSession();
    const successor = await fixture.startHost();
    let client: RuntimeHostConnection | undefined;
    try {
      client = await connectClient(fixture.root, 'desktop');
      const result = await client.request('automation.query', { kind: 'get', automationId });
      assert.equal(result.kind, 'item');
      if (result.kind !== 'item') assert.fail('Automation get did not return an item');
      assert.equal(result.automation.name, committed.automation.name);
      assert.ok(result.automation.revision >= committed.automation.revision);
      assert.equal(result.automation.lastFire?.status, 'succeeded');

      const replay = await client.request('automation.mutate', {
        mutation: {
          kind: 'update',
          automationId,
          expectedRevision: createdRevision,
          definition: { ...definition, name: committed.automation.name },
        },
      });
      assert.equal(replay.kind, 'unchanged');
      assert.equal(replay.automation.revision, result.automation.revision);
      assert.equal(replay.automation.lastFire?.fireId, result.automation.lastFire?.fireId);
    } finally {
      await client?.close();
      await fixture.stopHost(successor);
    }
  });
});

test('domain-invalid Automation mutations do not drain the Runtime Host', async () => {
  await withExecutionRoot(async (fixture) => {
    const seeded = await fixture.seedAutomationWithTerminalFires(2);
    const host = await fixture.startHost();
    const definition: AutomationDefinitionInput = {
      kind: 'heartbeat',
      name: 'canonical heartbeat',
      prompt: 'Complete this scheduled check.',
      executionTarget: { kind: 'existing_session', sessionId: fixture.sessionId },
      schedule: { type: 'interval', seconds: 1 },
      maxFires: null,
      expiresAt: Date.now() + 60_000,
    };
    let client: RuntimeHostConnection | undefined;
    try {
      client = await connectClient(fixture.root, 'desktop');
      for (const [automationId, name] of [
        ['nul-name', 'bad\0name'],
        ['non-nfc-name', 'Cafe\u0301'],
      ] as const) {
        await assert.rejects(
          client.request('automation.mutate', {
            mutation: { kind: 'create', automationId, definition: { ...definition, name } },
          }),
          operationError('invalid_request'),
        );
        const status: HostStatusResult = await client.request('host.status', {});
        assert.equal(status.hostEpoch, host.hostEpoch);
        assert.equal(status.state, 'ready');
      }

      await assert.rejects(
        client.request('automation.mutate', {
          mutation: {
            kind: 'update',
            automationId: seeded.automationId,
            expectedRevision: seeded.revision - 1,
            definition: { ...definition, maxFires: 1, expiresAt: null },
          },
        }),
        operationError('operation_conflict'),
      );

      await assert.rejects(
        client.request('automation.mutate', {
          mutation: {
            kind: 'update',
            automationId: seeded.automationId,
            expectedRevision: seeded.revision,
            definition: { ...definition, maxFires: 1, expiresAt: null },
          },
        }),
        operationError('invalid_request'),
      );

      const status: HostStatusResult = await client.request('host.status', {});
      assert.equal(status.hostEpoch, host.hostEpoch);
      assert.equal(status.state, 'ready');
      assert.equal(host.child.exitCode, null);
      assert.equal(host.child.signalCode, null);
    } finally {
      await client?.close();
      await fixture.stopHost(host);
    }
  });
});

test('a deleted Automation identity conflicts before its archived source is validated', async () => {
  await withExecutionRoot(async (fixture) => {
    const now = Date.now();
    const definition: AutomationDefinitionInput = {
      kind: 'cron',
      name: 'retired cron',
      prompt: 'This identity must stay retired.',
      executionTarget: {
        kind: 'fresh_session',
        sourceSessionId: fixture.sessionId,
        cwd: fixture.root,
        backend: 'fake',
        llmConnectionSlug: 'fake',
        model: 'fake-model',
        thinkingLevel: null,
        permissionMode: 'explore',
      },
      schedule: { type: 'interval', seconds: 3_600 },
      maxFires: null,
      expiresAt: now + 7_200_000,
    };
    const automationId = 'retired-after-delete';
    const host = await fixture.startHost({ frozenNow: now });
    let client: RuntimeHostConnection | undefined;
    try {
      client = await connectClient(fixture.root, 'desktop');
      const created = await client.request('automation.mutate', {
        mutation: { kind: 'create', automationId, definition },
      });
      assert.equal(created.kind, 'committed');
      const deleted = await client.request('automation.mutate', {
        mutation: {
          kind: 'delete',
          automationId,
          expectedRevision: created.automation.revision,
        },
      });
      assert.equal(deleted.kind, 'deleted');
    } finally {
      await client?.close();
      await fixture.stopHost(host);
    }

    await fixture.archiveSession();
    const successor = await fixture.startHost({ frozenNow: now });
    try {
      client = await connectClient(fixture.root, 'tui');
      await assert.rejects(
        client.request('automation.mutate', {
          mutation: { kind: 'create', automationId, definition },
        }),
        operationError('operation_conflict'),
      );
      const status: HostStatusResult = await client.request('host.status', {});
      assert.equal(status.state, 'ready');
    } finally {
      await client?.close();
      await fixture.stopHost(successor);
    }
  });
});

async function waitForAutomationFire(
  client: RuntimeHostConnection,
  automationId: string,
): Promise<AutomationProjection> {
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    const result = await client.request('automation.query', { kind: 'get', automationId });
    if (result.kind === 'item' && result.automation.lastFire) return result.automation;
    await delay(25);
  }
  assert.fail('Automation did not complete a fire');
}

function operationError(code: RuntimeHostOperationError['code']) {
  return (error: unknown): boolean =>
    error instanceof RuntimeHostOperationError && error.code === code;
}
