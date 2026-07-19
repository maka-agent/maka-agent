import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import type { AgentRunHeader } from '@maka/core';
import { createTaskRunStore } from '@maka/headless';
import { createAgentRunStore, createRuntimeEventStore, createSessionStore } from '@maka/storage';
import {
  inspectResolvedTarget,
  resolveInspectTarget,
  type InspectCommandStores,
} from '../inspect-command.js';

describe('unified inspect target resolution', () => {
  test('does not guess when one id names multiple entity kinds and AgentRuns', async () => {
    await withStores(async (stores) => {
      const first = await createSession(stores, 'First');
      const second = await createSession(stores, 'Second');
      const sharedId = first.id;
      await stores.agentRunStore.createRun(runHeader(first.id, sharedId));
      await stores.agentRunStore.createRun(runHeader(second.id, sharedId));
      await stores.taskRunStore.appendEvent(sharedId, {
        type: 'task_run_created',
        id: 'task-created',
        taskRunId: sharedId,
        ts: 1,
        taskId: 'task-1',
        configId: 'config-1',
      });

      const resolution = await resolveInspectTarget(stores, { id: sharedId });

      assert.equal(resolution.status, 'ambiguous');
      const agentSessionIds = [first.id, second.id].sort();
      assert.deepEqual(resolution.document.candidates, [
        { kind: 'agent-run', id: sharedId, sessionId: agentSessionIds[0] },
        { kind: 'agent-run', id: sharedId, sessionId: agentSessionIds[1] },
        { kind: 'session', id: sharedId },
        { kind: 'task-run', id: sharedId },
      ]);
    });
  });

  test('uses explicit kind and Session to resolve duplicate AgentRun ids', async () => {
    await withStores(async (stores) => {
      const first = await createSession(stores, 'First');
      const second = await createSession(stores, 'Second');
      await stores.agentRunStore.createRun(runHeader(first.id, 'run-shared'));
      await stores.agentRunStore.createRun(runHeader(second.id, 'run-shared'));

      const ambiguous = await resolveInspectTarget(stores, {
        id: 'run-shared',
        requestedKind: 'agent-run',
      });
      assert.equal(ambiguous.status, 'ambiguous');

      const resolved = await resolveInspectTarget(stores, {
        id: 'run-shared',
        requestedKind: 'agent-run',
        sessionId: second.id,
      });
      assert.equal(resolved.status, 'resolved');
      if (resolved.status !== 'resolved') return;
      const document = await inspectResolvedTarget(stores, resolved.candidate);
      assert.equal(document.kind, 'agent_run');
      if (document.kind !== 'agent_run') return;
      assert.equal(document.agentRun.sessionId, second.id);
    });
  });

  test('returns a stable not-found resolution document', async () => {
    await withStores(async (stores) => {
      const resolution = await resolveInspectTarget(stores, { id: 'missing' });
      assert.equal(resolution.status, 'not_found');
      assert.deepEqual(resolution.document, {
        schemaVersion: 'maka.inspect_resolution.v1',
        kind: 'inspect_resolution',
        query: { id: 'missing' },
        status: 'not_found',
        candidates: [],
      });
    });
  });
});

async function createSession(stores: InspectCommandStores, name: string) {
  return stores.sessionStore.create({
    cwd: '/tmp/workspace',
    name,
    backend: 'fake',
    llmConnectionSlug: 'fake',
    model: 'fake-model',
    permissionMode: 'ask',
  });
}

function runHeader(sessionId: string, runId: string): AgentRunHeader {
  return {
    runId,
    sessionId,
    turnId: `turn-${sessionId}`,
    status: 'completed',
    backendKind: 'fake',
    llmConnectionSlug: 'fake',
    modelId: 'fake-model',
    cwd: '/tmp/workspace',
    permissionMode: 'ask',
    createdAt: 1,
    updatedAt: 2,
    completedAt: 2,
  };
}

async function withStores(run: (stores: InspectCommandStores) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'maka-unified-inspect-'));
  try {
    await run({
      sessionStore: createSessionStore(root),
      agentRunStore: createAgentRunStore(root),
      runtimeEventStore: createRuntimeEventStore(root),
      taskRunStore: createTaskRunStore(root),
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
