import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, test } from 'node:test';
import type {
  AutomationTarget,
  CreateAutomationDefinitionRequest,
  UpdateAutomationDefinitionRequest,
} from '@maka/core';
import {
  authenticateAutomationStoreWriter,
  openInteractiveAutomationStoreForWrite,
  type InteractiveAutomationStoreWriterFacade,
} from '../automation-store.js';
import {
  resolveStorageRoot,
  StorageRootAuthorityError,
  tryAcquireInteractiveRootOwner,
  type InteractiveRootOwner,
} from '../root-authority.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('Automation durable store', () => {
  test('prepare adjudicates mutation identity without granting commit authority', async () => {
    const { owner, writer } = await openWriter();
    try {
      const create = createRequest();
      const semanticCreate = {
        kind: 'create' as const,
        automationId: create.automationId,
        config: requestDefinition(create),
        enabled: create.enabled,
      };
      assert.deepEqual(await writer.prepareDefinitionMutation(semanticCreate), {
        status: 'ready',
        identity: 'genuinely_new',
      });

      const created = await writer.createDefinition(create);
      assert.equal(created.status, 'committed');
      if (created.status !== 'committed') return;
      const replay = await writer.prepareDefinitionMutation(semanticCreate);
      assert.equal(replay.status, 'replay');
      if (replay.status === 'replay')
        assert.deepEqual(replay.result, { ...created, replayed: true });

      const semanticConflict = await writer.prepareDefinitionMutation({
        ...semanticCreate,
        config: { ...semanticCreate.config, prompt: 'Different payload.' },
      });
      assert.equal(semanticConflict.status, 'conflict');
      if (semanticConflict.status === 'conflict') {
        assert.equal(semanticConflict.code, 'semantic_conflict');
        assert.equal(semanticConflict.identity, 'active');
      }

      const stale = await writer.prepareDefinitionMutation({
        kind: 'update',
        automationId: create.automationId,
        expectedRevision: 99,
        config: requestDefinition(updateRequest(99)),
      });
      assert.equal(stale.status, 'conflict');
      if (stale.status === 'conflict') assert.equal(stale.code, 'revision_mismatch');

      const ready = await writer.prepareDefinitionMutation({
        kind: 'update',
        automationId: create.automationId,
        expectedRevision: created.definition.revision,
        config: requestDefinition(updateRequest(created.definition.revision)),
      });
      assert.equal(ready.status, 'ready');
      if (ready.status === 'ready') {
        assert.equal(ready.identity, 'active');
        assert.deepEqual(ready.current, created.definition);
      }

      const admitted = await writer.admitFire(
        admitRequest(created.definition.revision, 'prepare-fire', 2_000, 3_000),
      );
      assert.equal(admitted.status, 'committed');
      if (admitted.status !== 'committed') return;
      const commitAfterPrepare = await writer.updateDefinition(
        updateRequest(created.definition.revision),
      );
      assert.equal(commitAfterPrepare.status, 'conflict');
      if (commitAfterPrepare.status === 'conflict') {
        assert.equal(commitAfterPrepare.code, 'revision_mismatch');
      }
      const blockedDelete = await writer.prepareDefinitionMutation({
        kind: 'delete',
        automationId: create.automationId,
        expectedRevision: admitted.definition.revision,
      });
      assert.equal(blockedDelete.status, 'conflict');
      if (blockedDelete.status === 'conflict') {
        assert.equal(blockedDelete.code, 'non_terminal_fire');
      }
    } finally {
      await writer.close();
      await owner.close();
    }
  });

  test('definition CAS and caller mutation identity survive semantic retries', async () => {
    const { owner, writer } = await openWriter();
    try {
      assert.equal(
        authenticateAutomationStoreWriter(writer),
        writer,
        'writer facade must carry runtime authenticity',
      );
      const create = {
        ...createRequest(),
        schedule: { kind: 'once' as const, delayMs: 1_000 },
      };
      const created = await writer.createDefinition(create);
      assert.equal(created.status, 'committed');
      if (created.status !== 'committed') return;
      assert.equal(created.definition.revision, 1);
      assert.deepEqual(created.definition.schedule, { kind: 'once', delayMs: 1_000 });
      assert.deepEqual(created.definition.target, heartbeatTarget());
      assert.equal((await writer.readCatalogSnapshot()).catalogRevision, 1);

      const createRetry = await writer.createDefinition({
        ...structuredClone(create),
        createdAt: 1_100,
        nextFireAt: 2_100,
      });
      assert.equal(createRetry.status, 'committed');
      if (createRetry.status === 'committed') assert.equal(createRetry.replayed, true);
      assert.equal((await writer.readCatalogSnapshot()).catalogRevision, 1);

      const reusedMutation = await writer.createDefinition({
        ...create,
        prompt: 'Different payload.',
      });
      assert.deepEqual(reusedMutation, {
        status: 'conflict',
        code: 'semantic_conflict',
        current: created.definition,
      });
      assert.equal((await writer.readCatalogSnapshot()).catalogRevision, 1);

      const stale = await writer.updateDefinition(updateRequest(created.definition.revision + 1));
      assert.equal(stale.status, 'conflict');
      if (stale.status === 'conflict') assert.equal(stale.code, 'revision_mismatch');

      const updatedRequest = updateRequest(created.definition.revision);
      const updated = await writer.updateDefinition(updatedRequest);
      assert.equal(updated.status, 'committed');
      if (updated.status !== 'committed') return;
      assert.equal(updated.definition.revision, 2);
      assert.equal((await writer.readCatalogSnapshot()).catalogRevision, 2);

      const updateRetry = await writer.updateDefinition({
        ...structuredClone(updatedRequest),
        updatedAt: 1_550,
        nextFireAt: 2_600,
      });
      assert.equal(updateRetry.status, 'committed');
      if (updateRetry.status === 'committed') {
        assert.equal(updateRetry.replayed, true);
        assert.deepEqual(updateRetry.definition, updated.definition);
      }

      const disableRequest = {
        automationId: 'automation-1',
        expectedRevision: updated.definition.revision,
        enabled: false,
        updatedAt: 1_600,
        nextFireAt: null,
      } as const;
      const disabled = await writer.setEnabled(disableRequest);
      assert.equal(disabled.status, 'committed');
      if (disabled.status !== 'committed') return;
      assert.equal(disabled.definition.status, 'disabled');
      assert.equal(disabled.definition.revision, updated.definition.revision + 1);
      const disableRetry = await writer.setEnabled({
        ...structuredClone(disableRequest),
        updatedAt: 1_650,
      });
      assert.equal(disableRetry.status, 'committed');
      if (disableRetry.status === 'committed') assert.equal(disableRetry.replayed, true);

      const sameRevisionDifferentMutation = await writer.updateDefinition({
        ...updateRequest(updated.definition.revision),
        updatedAt: 1_700,
      });
      assert.equal(sameRevisionDifferentMutation.status, 'conflict');
      if (sameRevisionDifferentMutation.status === 'conflict') {
        assert.equal(sameRevisionDifferentMutation.code, 'semantic_conflict');
      }

      const disabledOnce = await writer.createDefinition({
        ...createRequest(),
        automationId: 'disabled-once',
        schedule: { kind: 'once', delayMs: 5_000 },
        createdAt: 2_000,
        nextFireAt: 7_000,
        enabled: false,
      });
      assert.equal(disabledOnce.status, 'committed');
      if (disabledOnce.status !== 'committed') return;
      assert.equal(disabledOnce.definition.nextFireAt, null);
      assert.deepEqual(disabledOnce.definition.schedule, { kind: 'once', delayMs: 5_000 });
      const reenabledOnce = await writer.setEnabled({
        automationId: 'disabled-once',
        expectedRevision: disabledOnce.definition.revision,
        enabled: true,
        updatedAt: 2_100,
        nextFireAt: 7_100,
      });
      assert.equal(reenabledOnce.status, 'committed');
      if (reenabledOnce.status === 'committed') {
        assert.equal(reenabledOnce.definition.nextFireAt, 7_100);
        assert.deepEqual(reenabledOnce.definition.schedule, { kind: 'once', delayMs: 5_000 });
      }
    } finally {
      await writer.close();
      await owner.close();
    }
  });

  test('cron definition freezes its creator-derived execution template', async () => {
    const { owner, writer } = await openWriter();
    try {
      const target: AutomationTarget = {
        kind: 'cron',
        creatorSessionId: 'creator-session',
        freshSession: {
          cwd: '/workspace/project-a',
          backend: 'ai-sdk',
          llmConnectionSlug: 'work-account',
          model: 'gpt-5.4',
          thinkingLevel: 'high',
          permissionMode: 'explore',
        },
      };
      const result = await writer.createDefinition({
        ...createRequest(),
        automationId: 'cron-1',
        target,
        schedule: { kind: 'interval', intervalMs: 60_000 },
      });
      assert.equal(result.status, 'committed');
      if (result.status === 'committed') assert.deepEqual(result.definition.target, target);

      await assert.rejects(
        () =>
          writer.createDefinition({
            ...createRequest(),
            automationId: 'invalid.id',
          }),
        /invalid characters/,
      );
      await assert.rejects(
        () =>
          writer.createDefinition({
            ...createRequest(),
            automationId: 'incomplete-target',
            target: {
              kind: 'cron',
              creatorSessionId: 'creator-session',
              freshSession: {
                cwd: '/workspace/project-a',
                backend: 'ai-sdk',
                llmConnectionSlug: 'work-account',
                permissionMode: 'explore',
              },
            } as AutomationTarget,
          }),
        /missing field 'model'/,
      );

      const heartbeatCron = await writer.createDefinition({
        ...createRequest(),
        automationId: 'heartbeat-cron',
        target: heartbeatTarget(),
        schedule: { kind: 'cron', expression: '0 9 * * 1-5' },
      });
      assert.equal(heartbeatCron.status, 'committed');

      const raw = JSON.parse(
        await readFile(join(owner.capability.canonicalPath, 'automations.json'), 'utf8'),
      );
      assert.deepEqual(
        raw.definitions.find((item: { automationId: string }) => item.automationId === 'cron-1')
          .target,
        target,
      );
    } finally {
      await writer.close();
      await owner.close();
    }
  });

  test('a delete receipt permanently retires its Automation identity', async () => {
    const first = await openWriter();
    let create!: CreateAutomationDefinitionRequest;
    let deletedRevision!: number;
    try {
      create = createRequest();
      const created = await first.writer.createDefinition(create);
      assert.equal(created.status, 'committed');
      if (created.status !== 'committed') assert.fail('Automation create did not commit');
      const deleted = await first.writer.deleteDefinition({
        automationId: create.automationId,
        expectedRevision: created.definition.revision,
        deletedAt: 1_100,
      });
      assert.deepEqual(deleted, {
        status: 'deleted',
        replayed: false,
        automationId: create.automationId,
      });
      deletedRevision = (await first.writer.readCatalogSnapshot()).catalogRevision;
    } finally {
      await first.writer.close();
      await first.owner.close();
    }
    const persisted = JSON.parse(await readFile(join(first.root, 'automations.json'), 'utf8'));
    assert.equal(persisted.definitionMutations.length, 1);
    assert.equal(persisted.definitionMutations[0].kind, 'delete');
    assert.deepEqual(persisted.definitionMutations[0], {
      kind: 'delete',
      automationId: create.automationId,
      expectedRevision: 1,
    });

    const second = await openWriter(first.root);
    try {
      const retry = await second.writer.createDefinition({
        ...structuredClone(create),
        createdAt: 1_200,
        nextFireAt: 2_200,
      });
      assert.deepEqual(retry, {
        status: 'conflict',
        code: 'automation_identity_retired',
      });
      assert.equal(await second.writer.getDefinition(create.automationId), undefined);
      assert.equal((await second.writer.readCatalogSnapshot()).catalogRevision, deletedRevision);
    } finally {
      await second.writer.close();
      await second.owner.close();
    }
  });

  test('fire admission atomically advances schedule and permits one non-terminal fire', async () => {
    const { owner, writer } = await openWriter();
    try {
      const created = await writer.createDefinition(createRequest());
      assert.equal(created.status, 'committed');
      if (created.status !== 'committed') return;

      const admission = admitRequest(created.definition.revision, 'fire-1', 2_000, 3_000);
      const admitted = await writer.admitFire(admission);
      assert.equal(admitted.status, 'committed');
      if (admitted.status !== 'committed') return;
      assert.equal(admitted.definition.fireCount, 1);
      assert.equal(admitted.definition.nextFireAt, 3_000);
      assert.equal(admitted.fire.admission.definitionRevision, 1);
      assert.equal(admitted.fire.admission.targetSessionId, 'session-1');
      assert.deepEqual(admitted.fire.definitionAfterAdmission, admitted.definition);
      const admittedCatalog = await writer.readCatalogSnapshot();
      assert.equal(admittedCatalog.catalogRevision, 2);
      assert.deepEqual(admittedCatalog.definitions, [admitted.definition]);
      assert.deepEqual(admittedCatalog.fires, [admitted.fire]);

      const createRetry = await writer.createDefinition({
        ...createRequest(),
        createdAt: 1_500,
        nextFireAt: 2_500,
      });
      assert.equal(createRetry.status, 'committed');
      if (createRetry.status === 'committed') {
        assert.equal(createRetry.replayed, true);
        assert.deepEqual(createRetry.definition, admitted.definition);
      }

      const raw = JSON.parse(
        await readFile(join(owner.capability.canonicalPath, 'automations.json'), 'utf8'),
      );
      assert.equal(raw.definitions[0].fireCount, 1);
      assert.equal(raw.definitions[0].nextFireAt, 3_000);
      assert.equal(raw.fires[0].admission.fireId, 'fire-1');
      assert.equal(raw.definitionMutations.length, 1);
      assert.equal(Object.hasOwn(raw.definitionMutations[0], 'definition'), false);
      assert.equal(Object.hasOwn(raw.definitionMutations[0].config, 'revision'), false);
      assert.equal(Object.hasOwn(raw.definitionMutations[0].config, 'fireCount'), false);
      assert.equal(Object.hasOwn(raw.definitionMutations[0], 'createdAt'), false);
      assert.equal(Object.hasOwn(raw.definitionMutations[0], 'nextFireAt'), false);

      const sameFire = await writer.admitFire(structuredClone(admission));
      assert.equal(sameFire.status, 'committed');
      if (sameFire.status === 'committed') assert.equal(sameFire.replayed, true);
      assert.equal((await writer.readCatalogSnapshot()).catalogRevision, 2);

      const second = await writer.admitFire(
        admitRequest(admitted.definition.revision, 'fire-2', 3_000, 4_000),
      );
      assert.equal(second.status, 'conflict');
      if (second.status === 'conflict') assert.equal(second.code, 'non_terminal_fire');
      assert.equal((await writer.readCatalogSnapshot()).catalogRevision, 2);
      assert.equal((await writer.listNonTerminalFires()).length, 1);
    } finally {
      await writer.close();
      await owner.close();
    }
  });

  test('fire admission fails closed when the definition expired before admission', async () => {
    const { owner, writer } = await openWriter();
    try {
      const created = await writer.createDefinition({
        ...createRequest(),
        expiresAt: 2_050,
      });
      assert.equal(created.status, 'committed');
      if (created.status !== 'committed') return;

      const result = await writer.admitFire(
        admitRequest(created.definition.revision, 'fire-expired', 2_000, 3_000),
      );
      assert.equal(result.status, 'conflict');
      if (result.status === 'conflict') assert.equal(result.code, 'automation_expired');

      const catalog = await writer.readCatalogSnapshot();
      assert.equal(catalog.catalogRevision, 1);
      assert.deepEqual(catalog.definitions, [created.definition]);
      assert.deepEqual(catalog.fires, []);
    } finally {
      await writer.close();
      await owner.close();
    }
  });

  test('update affects future fire while delete fences an admitted fire', async () => {
    const { owner, writer } = await openWriter();
    try {
      const created = await writer.createDefinition(createRequest());
      assert.equal(created.status, 'committed');
      if (created.status !== 'committed') return;
      const admitted = await writer.admitFire(
        admitRequest(created.definition.revision, 'fire-in-flight', 2_000, 3_000),
      );
      assert.equal(admitted.status, 'committed');
      if (admitted.status !== 'committed') return;

      const update = {
        ...updateRequest(admitted.definition.revision),
        nextFireAt: 3_000,
        updatedAt: 2_200,
      };
      const updated = await writer.updateDefinition(update);
      assert.equal(updated.status, 'committed');
      if (updated.status !== 'committed') return;
      assert.equal(admitted.fire.admission.definitionRevision, 1);
      assert.equal(updated.definition.revision, admitted.definition.revision + 1);
      assert.equal(admitted.fire.definitionAfterAdmission.prompt, 'Check the deployment.');

      const blocked = await writer.deleteDefinition({
        automationId: 'automation-1',
        expectedRevision: updated.definition.revision,
        deletedAt: 2_300,
      });
      assert.equal(blocked.status, 'conflict');
      if (blocked.status === 'conflict') assert.equal(blocked.code, 'non_terminal_fire');

      await writer.settleFire({
        fireId: 'fire-in-flight',
        outcome: { kind: 'succeeded', settledAt: 2_400 },
      });
      const deleted = await writer.deleteDefinition({
        automationId: 'automation-1',
        expectedRevision: updated.definition.revision,
        deletedAt: 2_300,
      });
      assert.equal(deleted.status, 'deleted');
      assert.equal(await writer.getDefinition('automation-1'), undefined);
      const retry = await writer.deleteDefinition({
        automationId: 'automation-1',
        expectedRevision: updated.definition.revision,
        deletedAt: 2_900,
      });
      assert.deepEqual(retry, {
        status: 'deleted',
        replayed: true,
        automationId: 'automation-1',
      });
    } finally {
      await writer.close();
      await owner.close();
    }
  });

  test('terminal settlement is idempotent and survives authentic lease reopen', async () => {
    const first = await openWriter();
    const created = await first.writer.createDefinition(createRequest());
    assert.equal(created.status, 'committed');
    if (created.status !== 'committed') return;
    const firstAdmission = await first.writer.admitFire(
      admitRequest(created.definition.revision, 'fire-old', 2_000, 3_000),
    );
    assert.equal(firstAdmission.status, 'committed');
    if (firstAdmission.status !== 'committed') return;
    await first.writer.settleFire({
      fireId: 'fire-old',
      outcome: { kind: 'succeeded', settledAt: 2_500 },
    });
    const secondAdmission = await first.writer.admitFire(
      admitRequest(firstAdmission.definition.revision, 'fire-reopen', 3_000, 4_000),
    );
    assert.equal(secondAdmission.status, 'committed');
    if (secondAdmission.status !== 'committed') return;
    const outcome = {
      kind: 'outcome_unknown' as const,
      phase: 'after_run_start' as const,
      settledAt: 3_500,
    };
    const settled = await first.writer.settleFire({ fireId: 'fire-reopen', outcome });
    assert.equal(settled.status, 'committed');
    const settledRevision = (await first.writer.readCatalogSnapshot()).catalogRevision;
    assert.equal(settledRevision, 5);
    await first.writer.close();
    await first.owner.close();

    const second = await openWriter(first.root);
    try {
      const fire = await second.writer.getFire('fire-reopen');
      assert.deepEqual(fire?.outcome, outcome);
      assert.equal(await second.writer.getFire('fire-old'), undefined);
      const reopenedCatalog = await second.writer.readCatalogSnapshot();
      assert.equal(reopenedCatalog.catalogRevision, settledRevision);
      assert.deepEqual(
        reopenedCatalog.fires.map((item) => item.admission.fireId),
        ['fire-reopen'],
      );
      const replay = await second.writer.settleFire({ fireId: 'fire-reopen', outcome });
      assert.equal(replay.status, 'committed');
      if (replay.status === 'committed') assert.equal(replay.replayed, true);
      assert.equal((await second.writer.readCatalogSnapshot()).catalogRevision, settledRevision);
      const conflict = await second.writer.settleFire({
        fireId: 'fire-reopen',
        outcome: { kind: 'failed', settledAt: 3_600, errorCode: 'late', message: 'late' },
      });
      assert.deepEqual(conflict, { status: 'conflict', code: 'already_settled' });
      assert.equal((await second.writer.readCatalogSnapshot()).catalogRevision, settledRevision);
    } finally {
      await second.writer.close();
      await second.owner.close();
    }
  });

  test('same lease is singleton and writer/lease close are terminal', async () => {
    const { owner, writer } = await openWriter();
    const same = await openInteractiveAutomationStoreForWrite(owner.lease);
    assert.equal(same, writer);

    const writes = Array.from({ length: 8 }, (_, index) =>
      writer.createDefinition({
        ...createRequest(),
        automationId: `bulk-automation-${index}`,
      }),
    );
    const draining = writer.beginDrain();
    assert.equal(writer.lifecycle, 'draining');
    await assert.rejects(() => writer.listDefinitions(), /writer is draining/);
    await Promise.all(writes);
    await draining;
    await writer.close();
    assert.equal(writer.lifecycle, 'closed');
    await assert.rejects(() => writer.createDefinition(createRequest()), /writer is closed/);

    await owner.close();
    await assert.rejects(
      () => openInteractiveAutomationStoreForWrite(owner.lease),
      (error) => error instanceof StorageRootAuthorityError && error.code === 'invalid_lease',
    );
  });

  test('strict codec fails loud on corrupt and legacy snapshots', async () => {
    const root = await freshRoot();
    const capability = await resolveStorageRoot({ path: root, kind: 'interactive' });
    const owner = await tryAcquireInteractiveRootOwner(capability);
    assert.ok(owner);
    await writeFile(join(root, 'automations.json'), '{not-json', 'utf8');
    await assert.rejects(
      () => openInteractiveAutomationStoreForWrite(owner.lease),
      /not valid JSON/,
    );
    await writeFile(
      join(root, 'automations.json'),
      JSON.stringify({ version: 1, automations: [] }),
      'utf8',
    );
    await assert.rejects(
      () => openInteractiveAutomationStoreForWrite(owner.lease),
      /invalid schema/,
    );
    await writeFile(
      join(root, 'automations.json'),
      JSON.stringify({
        schemaVersion: 1,
        catalogRevision: 0,
        definitions: [],
        fires: [],
        definitionMutations: [],
        unexpected: true,
      }),
      'utf8',
    );
    await assert.rejects(
      () => openInteractiveAutomationStoreForWrite(owner.lease),
      /invalid schema/,
    );
    await owner.close();
  });
});

function heartbeatTarget(): AutomationTarget {
  return { kind: 'heartbeat', sessionId: 'session-1' };
}

function createRequest(): CreateAutomationDefinitionRequest {
  return {
    automationId: 'automation-1',
    name: 'Daily check',
    prompt: 'Check the deployment.',
    target: heartbeatTarget(),
    schedule: { kind: 'interval', intervalMs: 1_000 },
    maxFireCount: null,
    expiresAt: null,
    createdAt: 1_000,
    nextFireAt: 2_000,
    enabled: true,
  };
}

function updateRequest(expectedRevision: number): UpdateAutomationDefinitionRequest {
  return {
    automationId: 'automation-1',
    expectedRevision,
    name: 'Daily deployment check',
    prompt: 'Check the deployment and report status.',
    target: heartbeatTarget(),
    schedule: { kind: 'interval', intervalMs: 2_000 },
    maxFireCount: 10,
    expiresAt: null,
    updatedAt: 1_500,
    nextFireAt: 2_500,
  };
}

function requestDefinition(
  request: CreateAutomationDefinitionRequest | UpdateAutomationDefinitionRequest,
) {
  return {
    name: request.name,
    prompt: request.prompt,
    target: request.target,
    schedule: request.schedule,
    maxFireCount: request.maxFireCount,
    expiresAt: request.expiresAt,
  };
}

function admitRequest(
  expectedAutomationRevision: number,
  fireId: string,
  scheduledFor: number,
  nextFireAt: number | null,
) {
  return {
    admission: {
      fireId,
      automationId: 'automation-1',
      scheduledFor,
      admittedAt: scheduledFor + 100,
      targetSessionId: 'session-1',
      turnId: `turn-${fireId}`,
      runId: `run-${fireId}`,
      userMessageId: `message-${fireId}`,
    },
    expectedAutomationRevision,
    nextFireAt,
  };
}

async function freshRoot() {
  const root = await mkdtemp(join(tmpdir(), 'maka-automation-store-'));
  roots.push(root);
  return root;
}

async function openWriter(requestedRoot?: string): Promise<{
  root: string;
  owner: InteractiveRootOwner;
  writer: InteractiveAutomationStoreWriterFacade;
}> {
  const root = requestedRoot ?? (await freshRoot());
  const capability = await resolveStorageRoot({ path: root, kind: 'interactive' });
  const owner = await tryAcquireInteractiveRootOwner(capability);
  assert.ok(owner);
  const writer = await openInteractiveAutomationStoreForWrite(owner.lease);
  return { root, owner, writer };
}
