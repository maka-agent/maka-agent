import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { it } from 'node:test';
import { assertSessionWorkspaceAvailable } from '../project-context-root.js';
import { handleBranchFromTurn } from '../session-branch.js';
import { handleReviseBeforeTurn } from '../session-revision.js';

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

it('routes reviseBeforeTurn through the workspace gate and emits one created version', async () => {
  let revised: { id: string; sourceTurnId: string } | undefined;
  let emittedId: string | undefined;
  const result = await handleReviseBeforeTurn('session-a', { sourceTurnId: 'turn-a' }, {
    ensureSessionWorkspaceAvailable: async () => {},
    reviseBeforeTurn: async (id, input) => {
      revised = { id, sourceTurnId: input.sourceTurnId };
      return { id: 'revision-session' } as never;
    },
    emitCreated: (id) => { emittedId = id; },
  });
  assert.deepEqual(revised, { id: 'session-a', sourceTurnId: 'turn-a' });
  assert.equal(emittedId, 'revision-session');
  assert.equal(result.id, 'revision-session');
});
