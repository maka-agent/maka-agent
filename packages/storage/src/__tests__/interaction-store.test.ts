import assert from 'node:assert/strict';
import { chmod, link, lstat, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import type { InteractionCanonicalOutcome, InteractionRequest } from '@maka/core';
import {
  interactionLocator,
  openInteractiveInteractionStoreForWrite,
  type InteractiveInteractionStoreWriterFacade,
  type StoredInteractionRequest,
} from '../interaction-store.js';
import {
  resolveStorageRoot,
  tryAcquireInteractiveRootOwner,
  type InteractiveRootOwner,
} from '../root-authority.js';

const CRASH_TEMP = 'outcome.json.00000000-0000-4000-8000-000000000000.tmp';
const REQUEST_CRASH_TEMP = 'request.json.00000000-0000-4000-8000-000000000001.tmp';

describe('Interaction Store durability closure', () => {
  test('keeps the first valid outcome and returns canonical winner facts to every retry', async () => {
    await withStore(async ({ store }) => {
      const request = storedQuestion('request_winner', 1_000);
      const first = questionOutcome('first', 1_100);
      const competing = questionOutcome('competing', 1_200);

      const created = await store.establishRequest(request);
      assert.equal(created.status, 'stable');
      if (created.status !== 'stable') return;
      assert.deepEqual(created, {
        status: 'stable',
        matches: true,
        record: { request },
      });

      const establishedAgain = await store.establishRequest(request);
      assert.equal(establishedAgain.status, 'stable');
      if (establishedAgain.status !== 'stable') return;
      assert.equal(establishedAgain.matches, true);

      const conflicting = await store.establishRequest({ ...request, runId: 'run_2' });
      assert.equal(conflicting.status, 'stable');
      if (conflicting.status !== 'stable') return;
      assert.equal(conflicting.matches, false);
      assert.deepEqual(conflicting.record, { request });

      const committed = await store.commitOutcome(request.requestId, first);
      assert.equal(committed.status, 'stable');
      if (committed.status !== 'stable') return;
      const storedFirst = { ...identity(request), outcome: first };
      assert.deepEqual(committed, {
        status: 'stable',
        matches: true,
        record: { request, outcome: storedFirst },
      });

      const sameRetry = await store.commitOutcome(request.requestId, first);
      assert.equal(sameRetry.status, 'stable');
      if (sameRetry.status !== 'stable') return;
      assert.equal(sameRetry.matches, true);
      assert.deepEqual(sameRetry.record.outcome, committed.record.outcome);

      const loser = await store.commitOutcome(request.requestId, competing);
      assert.equal(loser.status, 'stable');
      if (loser.status !== 'stable') return;
      assert.equal(loser.matches, false);
      assert.deepEqual(loser.record.outcome, committed.record.outcome);
      assert.deepEqual(loser.record, committed.record);
    });
  });

  test('stabilizes a linked outcome and cleans its crash-cut temporary artifact internally', async () => {
    await withStore(async ({ root, store }) => {
      const request = storedQuestion('request_post_link', 2_000);
      const outcome = questionOutcome('durable', 2_100);
      await assertStableRequest(store, request);
      const locator = join(root, 'interactions', interactionLocator(request.requestId));
      const storedOutcome = { ...identity(request), outcome };
      const bytes = `${JSON.stringify(storedOutcome)}\n`;
      await writeFile(join(locator, CRASH_TEMP), bytes, { mode: 0o600 });
      await link(join(locator, CRASH_TEMP), join(locator, 'outcome.json'));

      const result = await store.commitOutcome(request.requestId, outcome);

      assert.equal(result.status, 'stable');
      if (result.status !== 'stable') return;
      assert.equal(result.matches, true);
      assert.deepEqual(result.record, { request, outcome: storedOutcome });
      await assert.rejects(readFile(join(locator, CRASH_TEMP)), { code: 'ENOENT' });
    });
  });

  test('returns unresolved when a linked outcome cannot be cleaned, then stabilizes the same winner', {
    skip:
      process.platform === 'win32' ||
      (typeof process.getuid === 'function' && process.getuid() === 0),
  }, async () => {
    await withStore(async ({ root, store }) => {
      const request = storedQuestion('request_cleanup_blocked', 3_000);
      const outcome = questionOutcome('winner', 3_100);
      await assertStableRequest(store, request);
      const locator = join(root, 'interactions', interactionLocator(request.requestId));
      const storedOutcome = { ...identity(request), outcome };
      const bytes = `${JSON.stringify(storedOutcome)}\n`;
      await writeFile(join(locator, CRASH_TEMP), bytes, { mode: 0o600 });
      await link(join(locator, CRASH_TEMP), join(locator, 'outcome.json'));
      await chmod(locator, 0o500);

      try {
        const unresolved = await store.commitOutcome(request.requestId, outcome);
        assert.equal(unresolved.status, 'unresolved');
        if (unresolved.status !== 'unresolved') return;
        assert.equal(unresolved.failure.code, 'io_failed');
      } finally {
        await chmod(locator, 0o700);
      }

      const stabilized = await store.commitOutcome(request.requestId, outcome);
      assert.equal(stabilized.status, 'stable');
      if (stabilized.status !== 'stable') return;
      assert.equal(stabilized.matches, true);
      assert.deepEqual(stabilized.record.outcome, storedOutcome);
      await assert.rejects(readFile(join(locator, CRASH_TEMP)), { code: 'ENOENT' });
    });
  });

  test('returns definitely_not_published for a real pre-link I/O failure', {
    skip:
      process.platform === 'win32' ||
      (typeof process.getuid === 'function' && process.getuid() === 0),
  }, async () => {
    await withStore(async ({ root, store }) => {
      const request = storedQuestion('request_pre_link', 4_000);
      const locator = join(root, 'interactions', interactionLocator(request.requestId));
      await mkdir(locator, { mode: 0o700 });
      await chmod(locator, 0o500);

      const result = await store.establishRequest(request);
      assert.equal(result.status, 'definitely_not_published');
      if (result.status !== 'definitely_not_published') return;
      assert.equal(result.failure.code, 'io_failed');
      await assert.rejects(lstat(locator), { code: 'ENOENT' });
      assert.equal(await store.readInteraction(request.requestId), undefined);
      assert.deepEqual(await store.listPending(), []);

      const retry = await store.establishRequest(request);
      assert.equal(retry.status, 'stable');
      if (retry.status !== 'stable') return;
      assert.equal(retry.matches, true);
      assert.deepEqual((await store.readInteraction(request.requestId))?.request, request);
    });
  });

  test('returns unresolved when a pre-link failure namespace cannot be closed', {
    skip:
      process.platform === 'win32' ||
      (typeof process.getuid === 'function' && process.getuid() === 0),
  }, async () => {
    await withStore(async ({ root, store }) => {
      const request = storedQuestion('request_pre_link_cleanup_blocked', 5_000);
      const locator = join(root, 'interactions', interactionLocator(request.requestId));
      const temporaryPath = join(locator, REQUEST_CRASH_TEMP);
      await mkdir(locator, { mode: 0o700 });
      await writeFile(temporaryPath, 'pre-link bytes', { mode: 0o600 });
      await chmod(locator, 0o500);

      try {
        const result = await store.establishRequest(request);
        assert.equal(result.status, 'unresolved');
        if (result.status !== 'unresolved') return;
        assert.equal(result.failure.code, 'io_failed');
        assert.equal(await readFile(temporaryPath, 'utf8'), 'pre-link bytes');
      } finally {
        await chmod(locator, 0o700);
      }

      const retry = await store.establishRequest(request);
      assert.equal(retry.status, 'stable');
      if (retry.status !== 'stable') return;
      assert.equal(retry.matches, true);
      await assert.rejects(lstat(temporaryPath), { code: 'ENOENT' });
      assert.deepEqual(await store.listPending(), [request]);
    });
  });

  test('recovers a complete existing record when wall clock moves behind request creation', async () => {
    await withRoot(async ({ root, owner, store }) => {
      const request = storedQuestion('request_clock_rollback', 9_000);
      const outcome = questionOutcome('accepted', 1_000);
      await assertStableRequest(store, request);
      const committed = await store.commitOutcome(request.requestId, outcome);
      assert.equal(committed.status, 'stable');
      if (committed.status !== 'stable') return;

      await owner.close();
      const capability = await resolveStorageRoot({ path: root, kind: 'interactive' });
      const successor = await tryAcquireInteractiveRootOwner(capability);
      assert.ok(successor);
      if (!successor) return;
      try {
        const reopened = await openInteractiveInteractionStoreForWrite(successor.lease);
        assert.deepEqual(await reopened.readInteraction(request.requestId), committed.record);
        assert.deepEqual(await reopened.listPending(), []);

        const established = await reopened.establishRequest(request);
        assert.equal(established.status, 'stable');
        if (established.status !== 'stable') return;
        assert.equal(established.matches, true);
        assert.deepEqual(established.record, committed.record);

        const existingOutcome = await reopened.commitOutcome(request.requestId, outcome);
        assert.equal(existingOutcome.status, 'stable');
        if (existingOutcome.status !== 'stable') return;
        assert.equal(existingOutcome.matches, true);
        assert.deepEqual(existingOutcome.record, committed.record);
      } finally {
        await successor.close();
      }
    });
  });
});

async function assertStableRequest(
  store: InteractiveInteractionStoreWriterFacade,
  request: StoredInteractionRequest,
): Promise<void> {
  const result = await store.establishRequest(request);
  assert.equal(result.status, 'stable');
  if (result.status === 'stable') assert.equal(result.matches, true);
}

function storedQuestion(requestId: string, createdAt: number): StoredInteractionRequest {
  return {
    sessionId: 'session_1',
    turnId: 'turn_1',
    runId: 'run_1',
    requestId,
    createdAt,
    request: questionRequest(),
  };
}

function questionRequest(): InteractionRequest {
  return {
    kind: 'question',
    toolUseId: 'tool_1',
    questions: [
      {
        question: 'Choose a value',
        options: [
          { label: 'First', description: 'Use the first value' },
          { label: 'Second', description: 'Use the second value' },
        ],
      },
    ],
  };
}

function questionOutcome(answer: string, committedAt: number): InteractionCanonicalOutcome {
  return { kind: 'question_answer', answers: [answer], committedAt };
}

function identity(request: StoredInteractionRequest) {
  return {
    sessionId: request.sessionId,
    turnId: request.turnId,
    runId: request.runId,
    requestId: request.requestId,
  };
}

async function withStore(run: (context: StoreContext) => Promise<void>): Promise<void> {
  await withRoot(run);
}

interface StoreContext {
  readonly root: string;
  readonly owner: InteractiveRootOwner;
  readonly store: InteractiveInteractionStoreWriterFacade;
}

async function withRoot(run: (context: StoreContext) => Promise<void>): Promise<void> {
  const base = await mkdtemp(join(tmpdir(), 'maka-interaction-store-'));
  const root = join(base, 'root');
  await mkdir(root);
  const capability = await resolveStorageRoot({ path: root, kind: 'interactive' });
  const owner = await tryAcquireInteractiveRootOwner(capability);
  assert.ok(owner);
  if (!owner) return;
  const store = await openInteractiveInteractionStoreForWrite(owner.lease);
  try {
    await run({ root, owner, store });
  } finally {
    await owner.close();
    await rm(owner.controlDirectory, { recursive: true, force: true });
    await rm(base, { recursive: true, force: true });
  }
}
