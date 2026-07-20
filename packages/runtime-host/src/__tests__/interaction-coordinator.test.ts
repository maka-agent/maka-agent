import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { RuntimeInteractionFailStopError, RuntimeInteractionInvariantError } from '@maka/runtime';
import { openInteractiveExecutionStoresForWrite } from '@maka/storage/execution-stores';
import { resolveStorageRoot, tryAcquireInteractiveRootOwner } from '@maka/storage/root-authority';
import { HostInteractionAuthority } from '../server/interaction-coordinator.js';
import { SessionAdmissionGate } from '../server/session-admission-gate.js';
import { SessionContinuityCoordinator } from '../server/session-continuity-coordinator.js';

test('continuation identity mismatch immediately seals Interaction admission', async () => {
  const base = await mkdtemp(join(tmpdir(), 'maka-interaction-identity-'));
  const capability = await resolveStorageRoot({
    path: join(base, 'root'),
    kind: 'interactive',
  });
  const owner = await tryAcquireInteractiveRootOwner(capability);
  assert.ok(owner);
  if (!owner) return;
  const admission = new SessionAdmissionGate();
  const continuity = new SessionContinuityCoordinator(
    'identity-test-epoch',
    async () => null,
    admission,
  );
  try {
    const stores = await openInteractiveExecutionStoresForWrite(owner.lease);
    const authority = new HostInteractionAuthority(
      stores.interactionStore,
      continuity,
      admission,
      () => {
        throw new Error('Identity mismatch acquired Interaction residency');
      },
      () => undefined,
    );
    const run = authority.bindRun({
      sessionId: 'identity-session',
      turnId: 'identity-turn',
      runId: 'identity-run',
    });
    const rejected = run.acceptUserQuestionRequest({
      request: {
        type: 'user_question_request',
        id: 'identity-event',
        turnId: 'identity-turn',
        ts: 1,
        requestId: 'identity-request',
        toolUseId: 'identity-tool',
        questions: [
          {
            question: 'Should mismatched continuation identity be accepted?',
            options: [{ label: 'No' }, { label: 'Never' }],
          },
        ],
      },
      continuation: {
        requestId: 'identity-request',
        turnId: 'identity-turn',
        runId: 'different-run',
        applyAnswer: () => assert.fail('Identity mismatch applied an answer'),
        applyClosure: () => assert.fail('Identity mismatch applied a closure'),
      },
    });
    const signal = await authority.fatalSignal;
    assert.ok(signal.error instanceof RuntimeInteractionFailStopError);
    assert.ok(signal.error.authorityFailure instanceof RuntimeInteractionInvariantError);
    await assert.rejects(rejected, (error: unknown) => error === signal.error);
    assert.throws(
      () =>
        authority.bindRun({
          sessionId: 'later-session',
          turnId: 'later-turn',
          runId: 'later-run',
        }),
      (error: unknown) => error === signal.error,
    );
    await owner.close();
    authority.reclaimAfterOwnerIsolation();
  } finally {
    continuity.close();
    await owner.close();
    await rm(base, { recursive: true, force: true });
  }
});
