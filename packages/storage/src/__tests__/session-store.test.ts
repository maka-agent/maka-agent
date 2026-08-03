import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import type { CreateSessionInput } from '@maka/core';
import {
  createSessionStore,
  isSessionNotFoundError,
  type StableSessionCreateInput,
} from '../session-store.js';
import { OPERATIONAL_STATE_DATABASE_NAME } from '../operational-state-store.js';
import { createSqliteSessionMetadataStore } from '../sqlite-session-metadata-store.js';

describe('SQLite SessionStore', () => {
  test('persists session metadata and messages in one SQLite authority', async () => {
    const root = await mkdtemp(join(tmpdir(), 'maka-session-sqlite-'));
    const store = createSessionStore(root);
    try {
      const session = await store.create(makeInput());
      await store.appendMessage(session.id, {
        type: 'user',
        id: 'message-1',
        turnId: 'turn-1',
        ts: 10,
        text: 'hello from SQLite',
      });

      assert.equal((await store.readMessages(session.id))[0]?.id, 'message-1');
      const page = await store.listCatalogPage(undefined, undefined, 10);
      assert.equal(page.kind, 'page');
      if (page.kind !== 'page') assert.fail('expected a catalog page');
      assert.equal(page.records[0]?.summary.lastMessagePreview, 'hello from SQLite');
    } finally {
      await store.close?.();
    }

    const reopened = createSessionStore(root);
    try {
      const [session] = await reopened.listHeaders();
      assert.ok(session);
      assert.equal((await reopened.readMessages(session.id))[0]?.id, 'message-1');
    } finally {
      await reopened.close?.();
      await rm(root, { recursive: true, force: true });
    }
  });

  test('commits message and catalog projection atomically', async () => {
    const root = await mkdtemp(join(tmpdir(), 'maka-session-atomic-'));
    const store = createSessionStore(root);
    try {
      const session = await store.create(makeInput());
      const metadata = createSqliteSessionMetadataStore(
        join(root, OPERATIONAL_STATE_DATABASE_NAME),
      );
      try {
        await store.appendMessage(session.id, {
          type: 'assistant',
          id: 'message-1',
          turnId: 'turn-1',
          ts: 20,
          text: 'atomic preview',
          modelId: 'fake-model',
        });
        assert.equal((await metadata.readMessages(session.id))[0]?.id, 'message-1');
        assert.equal(
          (await metadata.listCatalogPage({}, undefined, 10)).records[0]?.lastMessagePreview,
          'atomic preview',
        );
      } finally {
        metadata.close();
      }
    } finally {
      await store.close?.();
      await rm(root, { recursive: true, force: true });
    }
  });

  test('deletes metadata and messages through the same transaction boundary', async () => {
    const root = await mkdtemp(join(tmpdir(), 'maka-session-delete-'));
    const store = createSessionStore(root);
    try {
      const session = await store.create(makeInput());
      await store.appendMessage(session.id, {
        type: 'user',
        id: 'message-1',
        turnId: 'turn-1',
        ts: 30,
        text: 'delete me',
      });
      await store.remove(session.id);
      await assert.rejects(store.readHeaderSnapshot(session.id), (error) => {
        assert.equal(isSessionNotFoundError(error), true);
        return true;
      });
      await assert.rejects(store.readMessages(session.id), (error) => {
        assert.equal(isSessionNotFoundError(error), true);
        return true;
      });
    } finally {
      await store.close?.();
      await rm(root, { recursive: true, force: true });
    }
  });

  test('creates memory extraction Sessions stably while hiding them from catalogs', async () => {
    const root = await mkdtemp(join(tmpdir(), 'maka-internal-memory-session-'));
    const store = createSessionStore(root);
    const sessionId = 'memory-operation-session';
    const requestFingerprint = `sha256:${'b'.repeat(64)}`;
    const input: StableSessionCreateInput = {
      ...makeInput({ name: 'Memory extraction' }),
      internalOwner: {
        kind: 'memory_extraction',
        operationId: 'memory-operation-1',
        parentSessionId: 'parent-session',
      },
    };
    try {
      await assert.rejects(
        () => store.create(input),
        /Internal Session ownership requires createStableSession/,
      );
      assert.equal(
        (await store.createStableSession({ sessionId, requestFingerprint, input })).kind,
        'created',
      );
      assert.equal(
        (await store.createStableSession({ sessionId, requestFingerprint, input })).kind,
        'existing',
      );
      assert.deepEqual(
        await store.createStableSession({
          sessionId,
          requestFingerprint,
          input: {
            ...input,
            internalOwner: {
              kind: 'memory_extraction',
              operationId: 'different-operation',
              parentSessionId: 'parent-session',
            },
          },
        }),
        { kind: 'conflict', reason: 'identity_mismatch' },
      );
      assert.deepEqual(await store.list(), []);
      const page = await store.listCatalogPage(undefined, undefined, 10);
      assert.equal(page.kind, 'page');
      if (page.kind !== 'page') assert.fail('Expected a Session catalog page');
      assert.deepEqual(page.records, []);
      await assert.rejects(() => store.readCatalogRecord(sessionId), isSessionNotFoundError);
      assert.deepEqual(
        (await store.listHeaders()).map((header) => header.id),
        [sessionId],
      );
      assert.deepEqual(
        (await store.readHeaderSnapshot(sessionId)).internalOwner,
        input.internalOwner,
      );
      await assert.rejects(
        () => store.updateHeader(sessionId, { internalOwner: undefined }),
        /Internal Session ownership is immutable/,
      );
    } finally {
      await store.close?.();
      await rm(root, { recursive: true, force: true });
    }
  });

  test('rejects external lineage on a memory extraction Session', async () => {
    const root = await mkdtemp(join(tmpdir(), 'maka-internal-memory-lineage-'));
    const store = createSessionStore(root);
    const base: StableSessionCreateInput = {
      ...makeInput({ name: 'Memory extraction' }),
      internalOwner: {
        kind: 'memory_extraction',
        operationId: 'memory-operation-1',
        parentSessionId: 'parent-session',
      },
    };
    try {
      const incompatible: StableSessionCreateInput[] = [
        { ...base, parentSessionId: 'parent-session', branchOfTurnId: 'turn-1' },
        {
          ...base,
          subagentParent: {
            kind: 'subagent',
            parentSessionId: 'parent-session',
            spawnedBy: {
              parentRunId: 'parent-run',
              parentTurnId: 'parent-turn',
              toolCallId: 'tool-call',
            },
            lifecycle: 'foreground',
          },
        },
        {
          ...base,
          revisionRootSessionId: 'revision-root',
          revisionParentSessionId: 'revision-parent',
          revisionOfTurnId: 'turn-1',
          revisionIndex: 2,
          revisionState: 'committed',
        },
      ];
      for (const [index, input] of incompatible.entries()) {
        await assert.rejects(
          () =>
            store.createStableSession({
              sessionId: `invalid-memory-session-${index}`,
              requestFingerprint: `sha256:${String(index).repeat(64)}`,
              input,
            }),
          /Invalid internal Session ownership|malformed fields/,
        );
      }
    } finally {
      await store.close?.();
      await rm(root, { recursive: true, force: true });
    }
  });
});

function makeInput(overrides: Partial<CreateSessionInput> = {}): CreateSessionInput {
  return {
    cwd: '/tmp/cwd',
    backend: 'fake',
    llmConnectionSlug: 'fake',
    model: 'fake-model',
    permissionMode: 'ask',
    name: 'Session',
    labels: [],
    ...overrides,
  };
}
