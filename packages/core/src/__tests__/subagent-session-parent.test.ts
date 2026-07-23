import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type {
  SessionSummary,
  SubagentSessionParent,
  SubagentSessionRuntime,
  SubagentSessionSpawn,
} from '../session.js';
import {
  childSessionsForParent,
  isSubagentSessionParent,
  isSubagentSessionRuntime,
  isSubagentSessionSpawn,
  subagentSessionRuntimeSummary,
} from '../session.js';
import { isPermissionModeWithinCeiling } from '../permission.js';

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

const runtime: SubagentSessionRuntime = {
  schemaVersion: 1,
  definitionVersion: 1,
  agentId: 'local-read',
  agentName: 'Local Read',
  profile: 'local_read',
  systemPrompt: 'Read the assigned workspace task.',
  toolNames: ['Read', 'Glob', 'Grep'],
  categoryPolicy: { read: 'allow' },
  permissionCeiling: 'ask',
};

const spawn: SubagentSessionSpawn = {
  schemaVersion: 1,
  requestFingerprint: 'a'.repeat(64),
  initialTurnId: 'child-turn',
  initialRunId: 'child-run',
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

  test('strictly decodes the immutable runtime snapshot and permission ceiling', () => {
    assert.equal(isSubagentSessionRuntime(runtime), true);
    assert.equal(isSubagentSessionRuntime({ ...runtime, toolNames: ['Read', 'Read'] }), false);
    assert.equal(isSubagentSessionRuntime({ ...runtime, definitionVersion: 0 }), false);
    assert.equal(
      isSubagentSessionRuntime({ ...runtime, categoryPolicy: { unknown: 'allow' } }),
      false,
    );
    assert.equal(isSubagentSessionRuntime({ ...runtime, permissionCeiling: 'invalid' }), false);
    assert.equal(isSubagentSessionRuntime({ ...runtime, unexpected: true }), false);
    assert.deepEqual(subagentSessionRuntimeSummary(runtime), {
      schemaVersion: 1,
      definitionVersion: 1,
      agentId: 'local-read',
      agentName: 'Local Read',
      profile: 'local_read',
      toolNames: ['Read', 'Glob', 'Grep'],
      permissionCeiling: 'ask',
    });

    assert.equal(isPermissionModeWithinCeiling('explore', 'ask'), true);
    assert.equal(isPermissionModeWithinCeiling('ask', 'ask'), true);
    assert.equal(isPermissionModeWithinCeiling('execute', 'ask'), false);
    assert.equal(isPermissionModeWithinCeiling('bypass', 'execute'), false);
  });

  test('strictly decodes the initial child-spawn identity', () => {
    assert.equal(isSubagentSessionSpawn(spawn), true);
    assert.equal(isSubagentSessionSpawn({ ...spawn, requestFingerprint: 'not-a-hash' }), false);
    assert.equal(isSubagentSessionSpawn({ ...spawn, schemaVersion: 2 }), false);
    assert.equal(isSubagentSessionSpawn({ ...spawn, extra: true }), false);
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
