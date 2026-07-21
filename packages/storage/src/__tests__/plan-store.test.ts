import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';

import { createPlanStore } from '../plan-store.js';

describe('FilePlanStore', () => {
  test('requires plain-text titles and descriptions for every step', async () => {
    await withStore(async (store) => {
      await assert.rejects(
        store.submitProposal({
          sessionId: 'session-1',
          turnId: 'turn-1',
          title: 'Plan',
          steps: [{ id: 'one', title: '**First step**', description: 'Do the work' }],
        }),
        /plain text without Markdown formatting/,
      );
      await assert.rejects(
        store.submitProposal({
          sessionId: 'session-1',
          turnId: 'turn-1',
          title: 'Plan',
          steps: [{ id: 'one', title: 'First step', description: '- Do the work' }],
        }),
        /plain text without Markdown formatting/,
      );
    });
  });

  test('persists proposal revisions and completes an approved execution', async () => {
    await withStore(async (store) => {
      const first = await store.submitProposal({
        sessionId: 'session-1',
        turnId: 'turn-1',
        title: 'First plan',
        steps: [{ id: 'inspect', title: 'Inspect code', description: 'Inspect the code' }],
      });
      const second = await store.submitProposal({
        sessionId: 'session-1',
        turnId: 'turn-2',
        title: 'Revised plan',
        steps: [
          { id: 'inspect', title: 'Inspect code', description: 'Inspect the code' },
          { id: 'implement', title: 'Implement change', description: 'Implement the change' },
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
        steps: [{ id: 'new', title: 'Start task', description: 'Start a different task' }],
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
        steps: [{ id: 'one', title: 'First step', description: 'One' }],
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

  test('abandons only the latest pending proposal without deleting its history', async () => {
    await withStore(async (store) => {
      const submitted = await store.submitProposal({
        sessionId: 'session-1',
        turnId: 'turn-1',
        title: 'Pending plan',
        steps: [{ id: 'one', title: 'First step', description: 'One' }],
      });
      const proposal = submitted.state.proposals[0]!;

      const abandoned = await store.abandonProposal({
        sessionId: 'session-1',
        proposalId: proposal.proposalId,
        reason: 'User exited Plan Mode',
      });

      assert.equal(abandoned.event.type, 'plan_abandoned');
      assert.equal(abandoned.state.proposals[0]?.status, 'stale');
      assert.equal(abandoned.state.proposals[0]?.title, 'Pending plan');
      await assert.rejects(
        store.approveProposal({
          sessionId: 'session-1',
          proposalId: proposal.proposalId,
          expectedRevision: proposal.revision,
        }),
        /latest pending plan proposal/,
      );
    });
  });

  test('replans an interrupted execution and retires it when the revision is approved', async () => {
    await withStore(async (store) => {
      const submitted = await store.submitProposal({
        sessionId: 'session-1',
        turnId: 'turn-1',
        title: 'Original plan',
        steps: [{ id: 'one', title: 'First step', description: 'One' }],
      });
      const originalProposal = submitted.state.proposals[0]!;
      const approved = await store.approveProposal({
        sessionId: 'session-1',
        proposalId: originalProposal.proposalId,
        expectedRevision: originalProposal.revision,
      });
      const originalExecution = approved.state.executions[0]!;
      await store.interruptActiveExecution('session-1', 'User stopped execution');

      const replanned = await store.submitProposal({
        sessionId: 'session-1',
        turnId: 'turn-2',
        title: 'Replanned remaining work',
        sourceExecutionId: originalExecution.executionId,
        steps: [{ id: 'one', title: 'Finish differently', description: 'Finish one differently' }],
      });
      const revision = replanned.state.proposals[1]!;
      assert.equal(revision.planId, originalProposal.planId);
      assert.equal(revision.revision, 2);
      assert.equal(revision.sourceExecutionId, originalExecution.executionId);

      const replacement = await store.approveProposal({
        sessionId: 'session-1',
        proposalId: revision.proposalId,
        expectedRevision: revision.revision,
      });
      assert.equal(replacement.state.executions[0]?.status, 'cancelled');
      assert.match(replacement.state.executions[0]?.cancelReason ?? '', /Replanned by proposal/);
      assert.equal(replacement.state.executions[1]?.status, 'active');
      assert.equal(
        replacement.state.activeExecutionId,
        replacement.state.executions[1]?.executionId,
      );
    });
  });

  test('allows the user to abandon an interrupted execution', async () => {
    await withStore(async (store) => {
      const submitted = await store.submitProposal({
        sessionId: 'session-1',
        turnId: 'turn-1',
        title: 'Interrupted plan',
        steps: [{ id: 'one', title: 'First step', description: 'One' }],
      });
      const proposal = submitted.state.proposals[0]!;
      const approved = await store.approveProposal({
        sessionId: 'session-1',
        proposalId: proposal.proposalId,
        expectedRevision: proposal.revision,
      });
      const execution = approved.state.executions[0]!;
      await store.interruptActiveExecution('session-1', 'User stopped execution');

      const cancelled = await store.cancelExecution({
        sessionId: 'session-1',
        executionId: execution.executionId,
        reason: 'User abandoned the interrupted plan',
      });

      assert.equal(cancelled.event.type, 'plan_execution_cancelled');
      assert.equal(cancelled.state.executions[0]?.status, 'cancelled');
      assert.equal(cancelled.state.activeExecutionId, undefined);
      await assert.rejects(
        store.cancelExecution({
          sessionId: 'session-1',
          executionId: execution.executionId,
          reason: 'Cancel twice',
        }),
        /cannot be cancelled/,
      );
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
