import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  openInteractiveAutomationStoreForWrite,
  type AutomationStoreWriter,
  type InteractiveAutomationStoreWriterFacade,
} from '@maka/storage';
import { openInteractiveExecutionStoresForWrite } from '@maka/storage/execution-stores';
import {
  resolveStorageRoot,
  tryAcquireInteractiveRootOwner,
  type InteractiveRootOwner,
} from '@maka/storage/root-authority';
import { HostAutomationCoordinator } from '../server/automation-coordinator.js';
import type { HostAutomationTurnInput } from '../server/root-turn-coordinator.js';
import type { ConnectionContext, OperationResidency } from '../server/operation-dispatcher.js';
import { SessionAdmissionGate } from '../server/session-admission-gate.js';

const context: ConnectionContext = {
  hostEpoch: 'automation-test-epoch',
  connectionId: 'automation-test-connection',
  surface: 'desktop',
  principal: 'local_os_user',
  acquireResidency: () => ({ release() {} }),
};

test('session close fences its owner, lets another Session continue, and waits for active fire', async () => {
  await withFixture(async (fixture) => {
    const terminal = deferred<{
      sessionId: string;
      turnId: string;
      runId: string;
      status: 'completed';
      terminalEventId: string;
    }>();
    let started: HostAutomationTurnInput | undefined;
    fixture.setTurnStart((input) => {
      started = input;
      return terminal.promise;
    });
    const target = await fixture.createSession();
    const other = await fixture.createSession();
    const definition = await fixture.seedActiveFire(target);
    await fixture.coordinator.recover();
    assert.ok(started);

    const close = fixture.coordinator.beginSessionClose(target);
    const blocked = await fixture.coordinator.create(toolCreate(target, 'blocked'));
    assert.equal(blocked.outcome, 'rejected');
    assert.equal(
      (
        await fixture.coordinator.pause({
          requester: { sessionId: target },
          id: definition.automationId,
        })
      ).outcome,
      'not_found_or_invalid',
    );
    const allowed = await fixture.coordinator.create(toolCreate(other, 'continues'));
    assert.equal(allowed.outcome, 'created');

    let settled = false;
    void close.settled.then(() => {
      settled = true;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(settled, false);
    assert.ok(await fixture.store.getDefinition(definition.automationId));

    terminal.resolve({
      sessionId: started!.sessionId,
      turnId: started!.turnId,
      runId: started!.runId,
      status: 'completed',
      terminalEventId: randomUUID(),
    });
    await close.settled;
    assert.equal(await fixture.store.getDefinition(definition.automationId), undefined);
    assert.equal((await fixture.store.listDefinitions()).length, 1);

    close.commit();
    close.commit();
    assert.equal(
      (await fixture.coordinator.create(toolCreate(target, 'still fenced'))).outcome,
      'rejected',
    );
  });
});

test('target Session close waits for a fresh-session fire owned by another Session', async () => {
  await withFixture(async (fixture) => {
    const terminal = deferred<{
      sessionId: string;
      turnId: string;
      runId: string;
      status: 'completed';
      terminalEventId: string;
    }>();
    fixture.setTurnStart(() => terminal.promise);
    const ownerSessionId = await fixture.createSession();
    const { definition, targetSessionId } = await fixture.seedFreshActiveFire(ownerSessionId);
    await fixture.coordinator.recover();

    const close = fixture.coordinator.beginSessionClose(targetSessionId);
    let settled = false;
    void close.settled.then(() => {
      settled = true;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(settled, false);

    const fire = (await fixture.store.listNonTerminalFires()).find(
      (item) => item.admission.automationId === definition.automationId,
    );
    assert.ok(fire);
    terminal.resolve({
      sessionId: targetSessionId,
      turnId: fire.admission.turnId,
      runId: fire.admission.runId,
      status: 'completed',
      terminalEventId: randomUUID(),
    });
    await close.settled;
    assert.ok(await fixture.store.getDefinition(definition.automationId));
    close.rollback();
  });
});

test('target Session close rejects when another owner fire cannot settle', async (t) => {
  await t.test('terminal rejection', async () => {
    const terminalFailure = new Error('Automation terminal failed');
    let drainRequests = 0;
    await withFixture(
      async (fixture) => {
        const terminal = deferred<{
          sessionId: string;
          turnId: string;
          runId: string;
          status: 'completed';
          terminalEventId: string;
        }>();
        fixture.setTurnStart(() => terminal.promise);
        const ownerSessionId = await fixture.createSession();
        const { definition, targetSessionId } = await fixture.seedFreshActiveFire(ownerSessionId);
        await fixture.coordinator.recover();

        const close = fixture.coordinator.beginSessionClose(targetSessionId);
        const rejected = assert.rejects(close.settled, (error) => error === terminalFailure);
        terminal.reject(terminalFailure);
        await rejected;

        assert.equal(drainRequests, 1);
        assert.ok(await fixture.store.getDefinition(definition.automationId));
        close.rollback();
      },
      { requestDrain: () => (drainRequests += 1) },
    );
  });

  await t.test('settlement persistence failure', async () => {
    const settlementFailure = new Error('Automation settlement persistence failed');
    let drainRequests = 0;
    await withFixture(
      async (fixture) => {
        const terminal = deferred<{
          sessionId: string;
          turnId: string;
          runId: string;
          status: 'completed';
          terminalEventId: string;
        }>();
        let started: HostAutomationTurnInput | undefined;
        fixture.setTurnStart((input) => {
          started = input;
          return terminal.promise;
        });
        const ownerSessionId = await fixture.createSession();
        const { definition, targetSessionId } = await fixture.seedFreshActiveFire(ownerSessionId);
        await fixture.coordinator.recover();
        assert.ok(started);

        const close = fixture.coordinator.beginSessionClose(targetSessionId);
        const rejected = assert.rejects(close.settled, (error) => error === settlementFailure);
        terminal.resolve({
          sessionId: started.sessionId,
          turnId: started.turnId,
          runId: started.runId,
          status: 'completed',
          terminalEventId: randomUUID(),
        });
        await rejected;

        assert.equal(drainRequests, 1);
        assert.ok(await fixture.store.getDefinition(definition.automationId));
        close.rollback();
      },
      {
        decorateStore: (store) =>
          automationStoreWithOverrides(store, {
            settleFire: async () => {
              throw settlementFailure;
            },
          }),
        requestDrain: () => (drainRequests += 1),
      },
    );
  });
});

test('queued heartbeat fire survives a later lifecycle fence and settles before cleanup', async () => {
  const dueSnapshotRead = deferred<void>();
  const createdAt = 1_000;
  const nextFireAt = createdAt + 20;
  let now = createdAt;
  await withFixture(
    async (fixture) => {
      const ownerSessionId = await fixture.createSession();
      const definition = await seedScheduledHeartbeatDefinition(fixture.store, ownerSessionId, {
        createdAt,
        nextFireAt,
        expiresAt: null,
      });
      const blockerEntered = deferred<void>();
      const releaseBlocker = deferred<void>();
      const blocker = fixture.sessionAdmission.run(ownerSessionId, async () => {
        blockerEntered.resolve();
        await releaseBlocker.promise;
      });
      await blockerEntered.promise;

      await fixture.coordinator.startScheduler();
      now = nextFireAt;
      await withTimeout(dueSnapshotRead.promise, 1_000, 'Due heartbeat sweep did not start');
      await waitForTurns(1);

      const lifecycle = fixture.sessionAdmission.beginSessionLifecycle(ownerSessionId);
      let close: ReturnType<HostAutomationCoordinator['beginSessionClose']> | undefined;
      const closeAdmission = fixture.sessionAdmission.run(ownerSessionId, (lease) => {
        close = fixture.coordinator.beginSessionClose(ownerSessionId, lease);
      });
      releaseBlocker.resolve();
      await blocker;
      await closeAdmission;
      assert.ok(close);
      await close.settled;

      assert.equal(await fixture.store.getDefinition(definition.automationId), undefined);
      const fire = (await fixture.store.readCatalogSnapshot()).fires.find(
        (item) => item.admission.automationId === definition.automationId,
      );
      if (!fire?.outcome) assert.fail('Queued heartbeat fire did not settle durably');
      assert.equal(fire.outcome.kind, 'succeeded');
      close.rollback();
      lifecycle.release();
    },
    {
      decorateStore: (store) => observeDueSnapshot(store, dueSnapshotRead),
      now: () => now,
    },
  );
});

test('queued expiry sweep disables before a later lifecycle cleanup without draining', async () => {
  const dueSnapshotRead = deferred<void>();
  const expiryDisabled = deferred<void>();
  const createdAt = 2_000;
  const nextFireAt = createdAt + 20;
  const expiresAt = createdAt + 40;
  let now = createdAt;
  let drainRequests = 0;
  await withFixture(
    async (fixture) => {
      const ownerSessionId = await fixture.createSession();
      const definition = await seedScheduledHeartbeatDefinition(fixture.store, ownerSessionId, {
        createdAt,
        nextFireAt,
        expiresAt,
      });
      const blockerEntered = deferred<void>();
      const releaseBlocker = deferred<void>();
      const blocker = fixture.sessionAdmission.run(ownerSessionId, async () => {
        blockerEntered.resolve();
        await releaseBlocker.promise;
      });
      await blockerEntered.promise;

      await fixture.coordinator.startScheduler();
      now = expiresAt + 1;
      await withTimeout(dueSnapshotRead.promise, 1_000, 'Expiry sweep did not start');
      await waitForTurns(1);

      const lifecycle = fixture.sessionAdmission.beginSessionLifecycle(ownerSessionId);
      let close: ReturnType<HostAutomationCoordinator['beginSessionClose']> | undefined;
      const closeAdmission = fixture.sessionAdmission.run(ownerSessionId, (lease) => {
        close = fixture.coordinator.beginSessionClose(ownerSessionId, lease);
      });
      releaseBlocker.resolve();
      await blocker;
      await closeAdmission;
      assert.ok(close);
      await close.settled;

      await withTimeout(expiryDisabled.promise, 1_000, 'Expiry disable did not commit');
      assert.equal(drainRequests, 0);
      assert.equal(await fixture.store.getDefinition(definition.automationId), undefined);
      close.rollback();
      lifecycle.release();
    },
    {
      decorateStore: (store) => {
        const observed = observeDueSnapshot(store, dueSnapshotRead);
        return automationStoreWithOverrides(observed, {
          setEnabled: async (request) => {
            const result = await store.setEnabled(request);
            if (!request.enabled && result.status === 'committed') expiryDisabled.resolve();
            return result;
          },
        });
      },
      now: () => now,
      requestDrain: () => (drainRequests += 1),
    },
  );
});

test('fresh-session reservation makes queued target admission visible to owner cleanup', async () => {
  const targetSessionId = 'queued-fresh-target';
  const reservationRegistered = deferred<void>();
  const createdAt = 3_000;
  const nextFireAt = createdAt + 20;
  let now = createdAt;
  let residencyCount = 0;
  const ids = [
    targetSessionId,
    'queued-fresh-fire',
    'queued-fresh-turn',
    'queued-fresh-run',
    'queued-fresh-message',
  ];
  await withFixture(
    async (fixture) => {
      const ownerSessionId = await fixture.createSession();
      const definition = await seedScheduledFreshDefinition(
        fixture.store,
        ownerSessionId,
        fixture.base,
        { createdAt, nextFireAt },
      );
      const blockerEntered = deferred<void>();
      const releaseBlocker = deferred<void>();
      const blocker = fixture.sessionAdmission.run(targetSessionId, async () => {
        blockerEntered.resolve();
        await releaseBlocker.promise;
      });
      await blockerEntered.promise;

      await fixture.coordinator.startScheduler();
      now = nextFireAt;
      await withTimeout(
        reservationRegistered.promise,
        1_000,
        'Fresh-session reservation was not registered',
      );

      const lifecycle = fixture.sessionAdmission.beginSessionLifecycle(ownerSessionId);
      let close: ReturnType<HostAutomationCoordinator['beginSessionClose']> | undefined;
      await fixture.sessionAdmission.run(ownerSessionId, (lease) => {
        close = fixture.coordinator.beginSessionClose(ownerSessionId, lease);
      });
      assert.ok(close);
      let closeSettled = false;
      void close.settled.then(() => {
        closeSettled = true;
      });
      await waitForTurns(2);
      assert.equal(closeSettled, false);

      releaseBlocker.resolve();
      await blocker;
      await close.settled;
      assert.equal(await fixture.store.getDefinition(definition.automationId), undefined);
      const fire = await fixture.store.getFire('queued-fresh-fire');
      if (!fire?.outcome) assert.fail('Queued fresh-session fire did not settle durably');
      assert.equal(fire.outcome.kind, 'succeeded');
      close.rollback();
      lifecycle.release();
    },
    {
      acquireResidency: () => {
        residencyCount += 1;
        if (residencyCount === 2) reservationRegistered.resolve();
        return { release() {} };
      },
      newId: () => {
        const id = ids.shift();
        assert.ok(id);
        return id;
      },
      now: () => now,
    },
  );
});

test('protocol update rejects transferring an Automation to another owner Session', async () => {
  await withFixture(async (fixture) => {
    const currentOwnerId = await fixture.createSession();
    const proposedOwnerId = await fixture.createSession();
    const definition = await fixture.seedDefinition(currentOwnerId);

    const result = await fixture.coordinator.handlers['automation.mutate'](
      protocolUpdate(definition, proposedOwnerId),
      context,
    );

    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.error.code, 'invalid_request');
      assert.match(result.error.message, /owner cannot be changed/);
    }
    const persisted = await fixture.store.getDefinition(definition.automationId);
    assert.ok(persisted);
    assert.equal(persisted.revision, definition.revision);
    assert.equal(isOwnedBy(persisted, currentOwnerId), true);
  });
});

test('a rollback cannot reopen a Session still fenced by a concurrent close holder', async () => {
  await withFixture(async (fixture) => {
    const target = await fixture.createSession();
    await fixture.seedDefinition(target);
    const first = fixture.coordinator.beginSessionClose(target);
    const second = fixture.coordinator.beginSessionClose(target);
    await Promise.all([first.settled, second.settled]);
    assert.equal(await fixture.store.listDefinitions().then((items) => items.length), 0);

    first.rollback();
    first.rollback();
    assert.equal(
      (await fixture.coordinator.create(toolCreate(target, 'still blocked'))).outcome,
      'rejected',
    );
    second.rollback();
    assert.equal(
      (await fixture.coordinator.create(toolCreate(target, 'reopened'))).outcome,
      'created',
    );
  });
});

test('unarchive releases a committed fence without bypassing a pending close holder', async () => {
  await withFixture(async (fixture) => {
    const target = await fixture.createSession();
    await fixture.seedDefinition(target);

    const archive = fixture.coordinator.beginSessionClose(target);
    await archive.settled;
    archive.commit();
    fixture.coordinator.unarchiveSession(target);
    assert.equal(
      (await fixture.coordinator.create(toolCreate(target, 'after unarchive'))).outcome,
      'created',
    );

    const committed = fixture.coordinator.beginSessionClose(target);
    const pending = fixture.coordinator.beginSessionClose(target);
    await committed.settled;
    committed.commit();
    fixture.coordinator.unarchiveSession(target);
    assert.equal(
      (await fixture.coordinator.create(toolCreate(target, 'pending still fences'))).outcome,
      'rejected',
    );

    pending.rollback();
    assert.equal(
      (await fixture.coordinator.create(toolCreate(target, 'pending released'))).outcome,
      'created',
    );
  });
});

test('admitted owner publications finish before close cleanup and cannot survive settled', async (t) => {
  await t.test('tool create publication', async () => {
    await withFixture(async (fixture) => {
      const target = await fixture.createSession();
      await racePublicationAgainstClose(fixture, target, async () => {
        const result = await fixture.coordinator.create(toolCreate(target, 'admitted tool create'));
        assert.equal(result.outcome, 'created');
      });
    });
  });

  await t.test('protocol create publication', async () => {
    await withFixture(async (fixture) => {
      const target = await fixture.createSession();
      await racePublicationAgainstClose(fixture, target, async () => {
        const result = await fixture.coordinator.handlers['automation.mutate'](
          protocolCreate(target),
          context,
        );
        assert.equal(result.ok, true);
        if (result.ok) assert.equal(result.result.kind, 'committed');
      });
    });
  });
});

test('session close joins an active admission lease without nested admission failure', async () => {
  await withFixture(async (fixture) => {
    const target = await fixture.createSession();
    await fixture.seedDefinition(target);

    let close: ReturnType<HostAutomationCoordinator['beginSessionClose']> | undefined;
    await fixture.sessionAdmission.run(target, async (lease) => {
      close = fixture.coordinator.beginSessionClose(target, lease);
      await close.settled;
    });

    assert.ok(close);
    assert.equal(
      (await fixture.store.listDefinitions()).filter((definition) => isOwnedBy(definition, target))
        .length,
      0,
    );
    close.rollback();
    assert.equal(
      (await fixture.coordinator.create(toolCreate(target, 'active lease reopened'))).outcome,
      'created',
    );
  });
});

test('active lease returns before heartbeat fire settlement unblocks close cleanup', async () => {
  await withFixture(async (fixture) => {
    const terminal = deferred<{
      sessionId: string;
      turnId: string;
      runId: string;
      status: 'completed';
      terminalEventId: string;
    }>();
    let started: HostAutomationTurnInput | undefined;
    fixture.setTurnStart((input) => {
      started = input;
      return terminal.promise;
    });
    const target = await fixture.createSession();
    const definition = await fixture.seedActiveFire(target);
    await fixture.coordinator.recover();
    assert.ok(started);

    let close: ReturnType<HostAutomationCoordinator['beginSessionClose']> | undefined;
    let laneReturned = false;
    const lane = fixture.sessionAdmission
      .run(target, (lease) => {
        close = fixture.coordinator.beginSessionClose(target, lease);
      })
      .then(() => {
        laneReturned = true;
      });
    await new Promise<void>((resolve) => setImmediate(resolve));
    const returnedBeforeTerminal = laneReturned;

    terminal.resolve({
      sessionId: started!.sessionId,
      turnId: started!.turnId,
      runId: started!.runId,
      status: 'completed',
      terminalEventId: randomUUID(),
    });
    await lane;
    assert.ok(close);
    await close.settled;

    assert.equal(returnedBeforeTerminal, true);
    assert.equal(await fixture.store.getDefinition(definition.automationId), undefined);
    close.rollback();
  });
});

test('global lifecycle fence rejects publication before the close callback enters its lane', async (t) => {
  await t.test('tool create', async () => {
    await withFixture(async (fixture) => {
      const target = await fixture.createSession();
      await lifecycleFenceBeforeCloseCallback(fixture, target, async () => {
        const result = await fixture.coordinator.create(toolCreate(target, 'lifecycle fenced'));
        assert.equal(result.outcome, 'rejected');
      });
    });
  });

  await t.test('protocol create', async () => {
    await withFixture(async (fixture) => {
      const target = await fixture.createSession();
      await lifecycleFenceBeforeCloseCallback(fixture, target, async () => {
        const result = await fixture.coordinator.handlers['automation.mutate'](
          protocolCreate(target),
          context,
        );
        assert.equal(result.ok, false);
        if (!result.ok) assert.equal(result.error.code, 'operation_conflict');
      });
    });
  });
});

type Fixture = Awaited<ReturnType<typeof createFixture>>;

interface FixtureOptions {
  readonly decorateStore?: (store: InteractiveAutomationStoreWriterFacade) => AutomationStoreWriter;
  readonly acquireResidency?: () => OperationResidency;
  readonly newId?: () => string;
  readonly requestDrain?: () => void;
  readonly now?: () => number;
}

async function withFixture(
  run: (fixture: Fixture) => Promise<void>,
  options: FixtureOptions = {},
): Promise<void> {
  const fixture = await createFixture(options);
  try {
    await run(fixture);
  } finally {
    await fixture.coordinator.close();
    await fixture.owner.close();
    await rm(fixture.base, { recursive: true, force: true });
  }
}

async function createFixture(options: FixtureOptions = {}) {
  const base = await mkdtemp(join(tmpdir(), 'maka-automation-coordinator-'));
  const capability = await resolveStorageRoot({ path: join(base, 'root'), kind: 'interactive' });
  const owner = await tryAcquireInteractiveRootOwner(capability);
  assert.ok(owner);
  if (!owner) throw new Error('Could not acquire test storage root');
  const stores = await openInteractiveExecutionStoresForWrite(owner.lease);
  const store = await openInteractiveAutomationStoreForWrite(owner.lease);
  let startTurn: (input: HostAutomationTurnInput) => Promise<{
    sessionId: string;
    turnId: string;
    runId: string;
    status: 'completed';
    terminalEventId: string;
  }> = async (input) => ({
    sessionId: input.sessionId,
    turnId: input.turnId,
    runId: input.runId,
    status: 'completed',
    terminalEventId: randomUUID(),
  });
  const root = {
    readRootState: () => ({ kind: 'idle' as const }),
    startAutomationTurn: async (input: HostAutomationTurnInput) => ({
      kind: 'started' as const,
      handle: { terminal: startTurn(input) },
    }),
  };
  const sessionAdmission = new SessionAdmissionGate();
  const coordinator = new HostAutomationCoordinator({
    store: options.decorateStore?.(store) ?? store,
    executionStores: stores,
    root,
    sessionAdmission,
    acquireResidency: options.acquireResidency ?? (() => ({ release() {} })),
    requestDrain:
      options.requestDrain ?? (() => assert.fail('Session close must not drain the Host')),
    newId: options.newId ?? randomUUID,
    now: options.now ?? Date.now,
  });
  return {
    base,
    owner: owner as InteractiveRootOwner,
    stores,
    store,
    coordinator,
    sessionAdmission,
    setTurnStart(next: typeof startTurn) {
      startTurn = next;
    },
    async createSession() {
      return (await stores.sessionStore.create(sessionInput(base))).id;
    },
    seedDefinition: (sessionId: string) => seedDefinition(store, sessionId),
    seedActiveFire: (sessionId: string) => seedActiveFire(store, sessionId),
    seedFreshActiveFire: (sessionId: string) => seedFreshActiveFire(store, sessionId, base),
  };
}

async function racePublicationAgainstClose(
  fixture: Fixture,
  sessionId: string,
  publish: () => Promise<void>,
): Promise<void> {
  const laneEntered = deferred<void>();
  const releaseLane = deferred<void>();
  const blocker = fixture.sessionAdmission.run(sessionId, async () => {
    laneEntered.resolve();
    await releaseLane.promise;
  });
  await laneEntered.promise;

  const publication = publish();
  const close = fixture.coordinator.beginSessionClose(sessionId);
  releaseLane.resolve();
  await blocker;
  await publication;
  await close.settled;

  assert.equal(
    (await fixture.store.listDefinitions()).filter((definition) => isOwnedBy(definition, sessionId))
      .length,
    0,
  );
}

async function lifecycleFenceBeforeCloseCallback(
  fixture: Fixture,
  sessionId: string,
  attemptPublication: () => Promise<void>,
): Promise<void> {
  await fixture.seedDefinition(sessionId);
  const laneEntered = deferred<void>();
  const releaseLane = deferred<void>();
  const blocker = fixture.sessionAdmission.run(sessionId, async () => {
    laneEntered.resolve();
    await releaseLane.promise;
  });
  await laneEntered.promise;

  const lifecycle = fixture.sessionAdmission.beginSessionLifecycle(sessionId);
  let close: ReturnType<HostAutomationCoordinator['beginSessionClose']> | undefined;
  const closeAdmission = fixture.sessionAdmission.run(sessionId, (lease) => {
    close = fixture.coordinator.beginSessionClose(sessionId, lease);
  });
  let publicationSettled = false;
  const publication = attemptPublication().then(() => {
    publicationSettled = true;
  });

  await new Promise<void>((resolve) => setImmediate(resolve));
  const settledBeforeLaneRelease = publicationSettled;
  releaseLane.resolve();
  await blocker;
  await publication;
  await closeAdmission;
  assert.ok(close);
  await close.settled;
  close.rollback();
  lifecycle.release();

  assert.equal(settledBeforeLaneRelease, true);
  assert.equal(
    (await fixture.store.listDefinitions()).filter((definition) => isOwnedBy(definition, sessionId))
      .length,
    0,
  );
}

function sessionInput(cwd: string) {
  return {
    cwd,
    backend: 'fake' as const,
    llmConnectionSlug: 'fake',
    model: 'fake-model',
    permissionMode: 'ask' as const,
  };
}

async function seedDefinition(store: InteractiveAutomationStoreWriterFacade, sessionId: string) {
  const now = Date.now();
  const result = await store.createDefinition({
    automationId: randomUUID(),
    name: 'owned definition',
    prompt: 'Run the owned definition.',
    target: { kind: 'heartbeat', sessionId },
    schedule: { kind: 'interval', intervalMs: 60_000 },
    maxFireCount: null,
    expiresAt: null,
    createdAt: now,
    nextFireAt: now + 60_000,
    enabled: true,
  });
  assert.equal(result.status, 'committed');
  if (result.status !== 'committed') throw new Error('Definition seed failed');
  return result.definition;
}

async function seedActiveFire(store: InteractiveAutomationStoreWriterFacade, sessionId: string) {
  const definition = await seedDefinition(store, sessionId);
  const admittedAt = definition.nextFireAt! + 1;
  const result = await store.admitFire({
    admission: {
      fireId: randomUUID(),
      automationId: definition.automationId,
      scheduledFor: definition.nextFireAt!,
      admittedAt,
      targetSessionId: sessionId,
      turnId: randomUUID(),
      runId: randomUUID(),
      userMessageId: randomUUID(),
    },
    expectedAutomationRevision: definition.revision,
    nextFireAt: admittedAt + 60_000,
  });
  assert.equal(result.status, 'committed');
  if (result.status !== 'committed') throw new Error('Fire seed failed');
  return result.definition;
}

async function seedFreshActiveFire(
  store: InteractiveAutomationStoreWriterFacade,
  ownerSessionId: string,
  cwd: string,
) {
  const now = Date.now();
  const created = await store.createDefinition({
    automationId: randomUUID(),
    name: 'fresh-session definition',
    prompt: 'Run in a fresh Session.',
    target: {
      kind: 'cron',
      creatorSessionId: ownerSessionId,
      freshSession: {
        cwd,
        backend: 'fake',
        llmConnectionSlug: 'fake',
        model: 'fake-model',
        permissionMode: 'explore',
      },
    },
    schedule: { kind: 'interval', intervalMs: 60_000 },
    maxFireCount: null,
    expiresAt: null,
    createdAt: now,
    nextFireAt: now + 60_000,
    enabled: true,
  });
  assert.equal(created.status, 'committed');
  if (created.status !== 'committed') throw new Error('Definition seed failed');
  const targetSessionId = randomUUID();
  const admittedAt = created.definition.nextFireAt! + 1;
  const admitted = await store.admitFire({
    admission: {
      fireId: randomUUID(),
      automationId: created.definition.automationId,
      scheduledFor: created.definition.nextFireAt!,
      admittedAt,
      targetSessionId,
      turnId: randomUUID(),
      runId: randomUUID(),
      userMessageId: randomUUID(),
    },
    expectedAutomationRevision: created.definition.revision,
    nextFireAt: admittedAt + 60_000,
  });
  assert.equal(admitted.status, 'committed');
  if (admitted.status !== 'committed') throw new Error('Fire seed failed');
  return { definition: admitted.definition, targetSessionId };
}

async function seedScheduledHeartbeatDefinition(
  store: InteractiveAutomationStoreWriterFacade,
  sessionId: string,
  timing: {
    readonly createdAt: number;
    readonly nextFireAt: number;
    readonly expiresAt: number | null;
  },
) {
  const result = await store.createDefinition({
    automationId: randomUUID(),
    name: 'scheduled heartbeat definition',
    prompt: 'Run the scheduled heartbeat.',
    target: { kind: 'heartbeat', sessionId },
    schedule: { kind: 'interval', intervalMs: 60_000 },
    maxFireCount: null,
    expiresAt: timing.expiresAt,
    createdAt: timing.createdAt,
    nextFireAt: timing.nextFireAt,
    enabled: true,
  });
  assert.equal(result.status, 'committed');
  if (result.status !== 'committed') throw new Error('Scheduled definition seed failed');
  return result.definition;
}

async function seedScheduledFreshDefinition(
  store: InteractiveAutomationStoreWriterFacade,
  ownerSessionId: string,
  cwd: string,
  timing: { readonly createdAt: number; readonly nextFireAt: number },
) {
  const result = await store.createDefinition({
    automationId: randomUUID(),
    name: 'scheduled fresh-session definition',
    prompt: 'Run after the target lane opens.',
    target: {
      kind: 'cron',
      creatorSessionId: ownerSessionId,
      freshSession: {
        cwd,
        backend: 'fake',
        llmConnectionSlug: 'fake',
        model: 'fake-model',
        permissionMode: 'explore',
      },
    },
    schedule: { kind: 'interval', intervalMs: 60_000 },
    maxFireCount: null,
    expiresAt: null,
    createdAt: timing.createdAt,
    nextFireAt: timing.nextFireAt,
    enabled: true,
  });
  assert.equal(result.status, 'committed');
  if (result.status !== 'committed') throw new Error('Fresh definition seed failed');
  return result.definition;
}

function toolCreate(sessionId: string, name: string) {
  return {
    requester: { sessionId },
    kind: 'heartbeat' as const,
    name,
    prompt: `Run ${name}.`,
    schedule: { type: 'interval' as const, seconds: 60 },
  };
}

function protocolCreate(sessionId: string) {
  return {
    mutation: {
      kind: 'create' as const,
      automationId: randomUUID(),
      definition: {
        kind: 'heartbeat' as const,
        name: 'admitted protocol create',
        prompt: 'Publish before cleanup.',
        executionTarget: { kind: 'existing_session' as const, sessionId },
        schedule: { type: 'interval' as const, seconds: 60 },
        maxFires: null,
        expiresAt: null,
      },
    },
  };
}

function protocolUpdate(
  definition: Awaited<ReturnType<typeof seedDefinition>>,
  proposedOwnerId: string,
) {
  return {
    mutation: {
      kind: 'update' as const,
      automationId: definition.automationId,
      expectedRevision: definition.revision,
      definition: {
        kind: 'heartbeat' as const,
        name: 'transferred definition',
        prompt: 'This update must be rejected.',
        executionTarget: { kind: 'existing_session' as const, sessionId: proposedOwnerId },
        schedule: { type: 'interval' as const, seconds: 60 },
        maxFires: null,
        expiresAt: null,
      },
    },
  };
}

function isOwnedBy(
  definition: Awaited<
    ReturnType<InteractiveAutomationStoreWriterFacade['listDefinitions']>
  >[number],
  sessionId: string,
): boolean {
  return definition.target.kind === 'heartbeat'
    ? definition.target.sessionId === sessionId
    : definition.target.creatorSessionId === sessionId;
}

function automationStoreWithOverrides(
  store: AutomationStoreWriter,
  overrides: Partial<
    Pick<AutomationStoreWriter, 'admitFire' | 'readCatalogSnapshot' | 'setEnabled' | 'settleFire'>
  >,
): AutomationStoreWriter {
  return new Proxy<AutomationStoreWriter>(Object.create(null), {
    get(_target, property) {
      if (Object.prototype.hasOwnProperty.call(overrides, property)) {
        return Reflect.get(overrides, property, overrides);
      }
      const value = Reflect.get(store, property, store);
      return typeof value === 'function' ? value.bind(store) : value;
    },
  });
}

function observeDueSnapshot(
  store: AutomationStoreWriter,
  dueSnapshotRead: ReturnType<typeof deferred<void>>,
): AutomationStoreWriter {
  let snapshotReads = 0;
  return automationStoreWithOverrides(store, {
    readCatalogSnapshot: async () => {
      const snapshot = await store.readCatalogSnapshot();
      snapshotReads += 1;
      if (snapshotReads === 2) dueSnapshotRead.resolve();
      return snapshot;
    },
  });
}

async function waitForTurns(count: number): Promise<void> {
  for (let turn = 0; turn < count; turn += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}
