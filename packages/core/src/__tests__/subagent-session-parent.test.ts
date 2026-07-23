import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { SessionSummary, SubagentSessionParent } from '../session.js';
import { childSessionsForParent, isSubagentSessionParent } from '../session.js';

const relation: SubagentSessionParent = {
  kind: 'subagent',
  parentSessionId: 'parent-session',
  spawnedBy: {
    parentRunId: 'parent-run',
    parentTurnId: 'parent-turn',
    toolCallId: 'tool-call',
  },
  lifecycle: 'foreground',
};

describe('subagent session parent relation', () => {
  test('strictly decodes standalone and swarm relations', () => {
    assert.equal(isSubagentSessionParent(relation), true);
    assert.equal(
      isSubagentSessionParent({
        ...relation,
        swarm: { swarmId: 'swarm-1', itemId: 'item-1' },
      }),
      true,
    );
  });

  test('rejects malformed, unsupported, or extended persisted relations', () => {
    assert.equal(isSubagentSessionParent({ ...relation, lifecycle: 'detached' }), false);
    assert.equal(
      isSubagentSessionParent({
        ...relation,
        spawnedBy: { parentRunId: 'parent-run', parentTurnId: 'parent-turn' },
      }),
      false,
    );
    assert.equal(isSubagentSessionParent({ ...relation, parentSessionId: 'bad\nid' }), false);
    assert.equal(isSubagentSessionParent({ ...relation, unexpected: true }), false);
  });

  test('derives reverse children without conflating ordinary branches', () => {
    const childA = summary('child-a', { subagentParent: relation });
    const branch = summary('branch', {
      parentSessionId: 'parent-session',
      branchOfTurnId: 'parent-turn',
    });
    const childB = summary('child-b', {
      subagentParent: { ...relation, swarm: { swarmId: 'swarm-1', itemId: 'item-1' } },
    });
    const otherChild = summary('other-child', {
      subagentParent: { ...relation, parentSessionId: 'other-parent' },
    });

    assert.deepEqual(
      childSessionsForParent([childA, branch, childB, otherChild], 'parent-session').map(
        (session) => session.id,
      ),
      ['child-a', 'child-b'],
    );
  });
});

function summary(id: string, overrides: Partial<SessionSummary> = {}): SessionSummary {
  return {
    id,
    cwd: '/tmp',
    name: id,
    isFlagged: false,
    isArchived: false,
    labels: [],
    hasUnread: false,
    status: 'active',
    backend: 'fake',
    llmConnectionSlug: 'fake',
    connectionLocked: false,
    model: 'fake-model',
    permissionMode: 'ask',
    collaborationMode: 'agent',
    orchestrationMode: 'default',
    ...overrides,
  };
}
