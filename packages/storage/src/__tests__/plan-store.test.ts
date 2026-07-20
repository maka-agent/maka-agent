import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';

import { createPlanStore } from '../plan-store.js';

describe('FilePlanStore', () => {
  test('persists proposal revisions and completes an approved execution', async () => {
    await withStore(async (store) => {
      const first = await store.submitProposal({
        sessionId: 'session-1',
        turnId: 'turn-1',
        title: 'First plan',
        steps: [{ id: 'inspect', description: 'Inspect the code' }],
      });
      const second = await store.submitProposal({
        sessionId: 'session-1',
        turnId: 'turn-2',
        title: 'Revised plan',
        steps: [
          { id: 'inspect', description: 'Inspect the code' },
          { id: 'implement', description: 'Implement the change' },
        ],
      });

      assert.equal(first.state.proposals[0]?.status, 'pending_approval');
      assert.equal(second.state.proposals[0]?.status, 'stale');
      assert.equal(second.state.proposals[1]?.revision, 2);
      assert.equal(second.state.proposals[1]?.planId, first.state.proposals[0]?.planId);

      const proposal = second.state.proposals[1]!;
      const approved = await store.approveProposal({
        sessionId: 'session-1',
        proposalId: proposal.proposalId,
        expectedRevision: proposal.revision,
        expectedStoreVersion: second.state.storeVersion,
      });
      assert.equal(approved.state.activeExecutionId, approved.state.executions[0]?.executionId);

      const execution = approved.state.executions[0]!;
      const completed = await store.updateExecution({
        sessionId: 'session-1',
        executionId: execution.executionId,
        steps: execution.steps.map((step) => ({ id: step.id, status: 'completed' })),
      });
      assert.equal(completed.event.type, 'plan_execution_completed');
      assert.equal(completed.state.activeExecutionId, undefined);
      assert.equal((await store.readState('session-1')).executions[0]?.status, 'completed');

      const nextPlan = await store.submitProposal({
        sessionId: 'session-1',
        turnId: 'turn-3',
        title: 'A different plan',
        steps: [{ id: 'new', description: 'Start a different task' }],
      });
      assert.notEqual(nextPlan.state.proposals[2]?.planId, proposal.planId);
      assert.equal(nextPlan.state.proposals[2]?.revision, 1);
    });
  });

  test('serializes concurrent approval and returns the same execution id', async () => {
    await withStore(async (store) => {
      const submitted = await store.submitProposal({
        sessionId: 'session-1',
        turnId: 'turn-1',
        title: 'Plan',
        steps: [{ id: 'one', description: 'One' }],
      });
      const proposal = submitted.state.proposals[0]!;
      const input = {
        sessionId: 'session-1',
        proposalId: proposal.proposalId,
        expectedRevision: proposal.revision,
      };
      const [left, right] = await Promise.all([
        store.approveProposal(input),
        store.approveProposal(input),
      ]);
      assert.equal(left.state.executions.length, 1);
      assert.equal(right.state.executions.length, 1);
      assert.equal(left.state.activeExecutionId, right.state.activeExecutionId);
    });
  });

  test('interrupt is a no-op when a queued mutation already ended the execution', async () => {
    await withStore(async (store) => {
      assert.equal(await store.interruptActiveExecution('session-1', 'shutdown'), null);
    });
  });
});

async function withStore(
  run: (store: ReturnType<typeof createPlanStore>) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'maka-plan-store-'));
  try {
    await run(createPlanStore(root));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
