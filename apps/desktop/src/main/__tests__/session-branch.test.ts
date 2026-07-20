import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { it } from 'node:test';
import { assertSessionWorkspaceAvailable } from '../project-context-root.js';
import { handleBranchBeforeTurn, handleBranchFromTurn } from '../session-branch.js';

it('does not create a branch when the source session workspace is unavailable', async () => {
  const deletedRoot = await mkdtemp(join(tmpdir(), 'maka-branch-deleted-workspace-'));
  await rm(deletedRoot, { recursive: true, force: true });
  let branchCalled = false;
  let emitted = false;

  await assert.rejects(
    () => handleBranchFromTurn('session-a', { sourceTurnId: 'turn-a' }, {
      ensureSessionWorkspaceAvailable: async () => assertSessionWorkspaceAvailable(deletedRoot),
      branchFromTurn: async () => {
        branchCalled = true;
        throw new Error('branch must not run');
      },
      emitCreated: () => {
        emitted = true;
      },
    }),
    /SESSION_WORKSPACE_UNAVAILABLE/,
  );

  assert.equal(branchCalled, false);
  assert.equal(emitted, false);
});

it('does not create a before-turn branch when the source session workspace is unavailable', async () => {
  const deletedRoot = await mkdtemp(join(tmpdir(), 'maka-branch-before-deleted-workspace-'));
  await rm(deletedRoot, { recursive: true, force: true });
  let branchCalled = false;
  let emitted = false;

  await assert.rejects(
    () => handleBranchBeforeTurn('session-a', { sourceTurnId: 'turn-a' }, {
      ensureSessionWorkspaceAvailable: async () => assertSessionWorkspaceAvailable(deletedRoot),
      branchBeforeTurn: async () => {
        branchCalled = true;
        throw new Error('branch must not run');
      },
      emitCreated: () => {
        emitted = true;
      },
    }),
    /SESSION_WORKSPACE_UNAVAILABLE/,
  );

  assert.equal(branchCalled, false);
  assert.equal(emitted, false);
});

it('routes branchBeforeTurn through the workspace gate and emits created', async () => {
  let branchCalledWith: { id: string; sourceTurnId: string } | undefined;
  let emittedId: string | undefined;
  const result = await handleBranchBeforeTurn('session-a', { sourceTurnId: 'turn-a' }, {
    ensureSessionWorkspaceAvailable: async () => {},
    branchBeforeTurn: async (id, input) => {
      branchCalledWith = { id, sourceTurnId: input.sourceTurnId };
      return {
        id: 'child-session',
        name: 'Child',
        cwd: '/tmp',
        backend: 'fake',
        llmConnectionSlug: 'c',
        model: 'm',
        permissionMode: 'ask',
        status: 'active',
        createdAt: 1,
        updatedAt: 1,
        parentSessionId: id,
        branchOfTurnId: input.sourceTurnId,
      } as never;
    },
    emitCreated: (id) => {
      emittedId = id;
    },
  });
  assert.deepEqual(branchCalledWith, { id: 'session-a', sourceTurnId: 'turn-a' });
  assert.equal(emittedId, 'child-session');
  assert.equal(result.id, 'child-session');
});
