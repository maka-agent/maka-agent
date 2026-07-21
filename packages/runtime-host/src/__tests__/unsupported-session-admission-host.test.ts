import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { DEEP_RESEARCH_SESSION_LABEL } from '@maka/core';
import type { SessionHeader } from '@maka/core/session';
import { openInteractiveExecutionStoresForWrite } from '@maka/storage/execution-stores';
import { tryAcquireInteractiveRootOwner } from '@maka/storage/root-authority';
import { RuntimeHostOperationError } from '../client/index.js';
import {
  connectClient,
  type ExecutionFixture,
  withExecutionRoot,
} from './support/execution-root-fixture.js';

test('Plan turn.start fails closed before root admission durability', async () => {
  await withExecutionRoot(async (fixture) => {
    await updateSessionHeader(fixture, { collaborationMode: 'plan' });
    const host = await fixture.startHost();
    const turnId = randomUUID();
    try {
      const client = await connectClient(fixture.root, 'desktop');
      try {
        await assert.rejects(
          client.startTurn({
            sessionId: fixture.sessionId,
            turnId,
            content: { text: 'Do not execute Plan mode as a normal agent.' },
          }),
          unavailableSessionMode,
        );
      } finally {
        await client.close();
      }
    } finally {
      await fixture.stopHost(host);
    }
    assert.deepEqual(await readExecutionFootprint(fixture), {
      admissionCount: 0,
      runCount: 0,
      userMessageCount: 0,
    });
  });
});

test('Deep Research idle message submit fails closed before root admission durability', async () => {
  await withExecutionRoot(async (fixture) => {
    await updateSessionHeader(fixture, { labels: [DEEP_RESEARCH_SESSION_LABEL] });
    const host = await fixture.startHost();
    try {
      const client = await connectClient(fixture.root, 'desktop');
      try {
        await assert.rejects(
          client.request('turn.message.submit', {
            originHostEpoch: host.hostEpoch,
            sessionId: fixture.sessionId,
            messageId: randomUUID(),
            content: { text: 'Do not execute Deep Research as a normal agent.' },
            placement: 'current_turn',
          }),
          unavailableSessionMode,
        );
      } finally {
        await client.close();
      }
    } finally {
      await fixture.stopHost(host);
    }
    assert.deepEqual(await readExecutionFootprint(fixture), {
      admissionCount: 0,
      runCount: 0,
      userMessageCount: 0,
    });
  });
});

function unavailableSessionMode(error: unknown): boolean {
  return error instanceof RuntimeHostOperationError && error.code === 'operation_unavailable';
}

async function updateSessionHeader(
  fixture: ExecutionFixture,
  patch: Partial<SessionHeader>,
): Promise<void> {
  const owner = await tryAcquireInteractiveRootOwner(fixture.capability);
  assert.ok(owner);
  try {
    const stores = await openInteractiveExecutionStoresForWrite(owner.lease);
    await stores.sessionStore.updateHeader(fixture.sessionId, patch);
  } finally {
    await owner.close();
  }
}

async function readExecutionFootprint(fixture: ExecutionFixture): Promise<{
  admissionCount: number;
  runCount: number;
  userMessageCount: number;
}> {
  const owner = await tryAcquireInteractiveRootOwner(fixture.capability);
  assert.ok(owner);
  try {
    const stores = await openInteractiveExecutionStoresForWrite(owner.lease);
    const [admissions, runs, messages] = await Promise.all([
      stores.agentRunStore.listRootTurnAdmissionsForRecovery(fixture.sessionId),
      stores.agentRunStore.listSessionRuns(fixture.sessionId),
      stores.sessionStore.readMessages(fixture.sessionId),
    ]);
    return {
      admissionCount: admissions.length,
      runCount: runs.length,
      userMessageCount: messages.filter((message) => message.type === 'user').length,
    };
  } finally {
    await owner.close();
  }
}
