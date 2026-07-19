import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  commandResourceScope,
  hashNormalizedArgs,
  matchPermissionGrant,
  normalizePermissionArgs,
} from '../permission-grants.js';
import type { TaskPermissionGrant, TaskPermissionRequest } from '../task-contracts.js';

const request: TaskPermissionRequest = {
  schemaVersion: 1,
  requestId: 'req-1',
  taskRunId: 'run-1',
  attemptId: 'attempt-1',
  toolCallId: 'tool-call-1',
  toolName: 'Bash',
  normalizedArgsHash: hashNormalizedArgs({ command: 'echo ok', nested: { b: 2, a: 1 } }),
  resourceScope: commandResourceScope('echo ok'),
  reason: 'shell command',
  preview: { argKeys: ['command'] },
  requestedAt: 100,
  expiresAt: 200,
};

function grant(overrides: Partial<TaskPermissionGrant> = {}): TaskPermissionGrant {
  return {
    schemaVersion: 1,
    grantId: 'grant-1',
    requestId: 'req-1',
    taskRunId: 'run-1',
    attemptId: 'attempt-1',
    toolCallId: 'tool-call-1',
    toolName: 'Bash',
    normalizedArgsHash: request.normalizedArgsHash,
    resourceScope: request.resourceScope,
    decision: 'allow',
    actor: { kind: 'test', id: 'unit' },
    source: 'test_fixture',
    decidedAt: 110,
    expiresAt: 190,
    ...overrides,
  };
}

describe('permission grant helpers', () => {
  test('normalizes and hashes args with stable recursive key ordering', () => {
    assert.deepEqual(normalizePermissionArgs({ z: 1, a: { d: true, b: ['x', { y: 2, x: 1 }] } }), {
      a: { b: ['x', { x: 1, y: 2 }], d: true },
      z: 1,
    });
    assert.equal(
      hashNormalizedArgs({ b: 2, a: { d: 4, c: 3 } }),
      hashNormalizedArgs({ a: { c: 3, d: 4 }, b: 2 }),
    );
  });

  test('matches only narrow unexpired allow grants', () => {
    assert.equal(matchPermissionGrant(request, [grant()], 150)?.grantId, 'grant-1');
    assert.equal(matchPermissionGrant(request, [grant({ decision: 'deny' })], 150), undefined);
    assert.equal(
      matchPermissionGrant(request, [grant({ taskRunId: 'other-run' })], 150),
      undefined,
    );
    assert.equal(
      matchPermissionGrant(request, [grant({ attemptId: 'other-attempt' })], 150),
      undefined,
    );
    assert.equal(
      matchPermissionGrant(request, [grant({ toolCallId: 'other-tool-call' })], 150),
      undefined,
    );
    assert.equal(matchPermissionGrant(request, [grant({ toolName: 'Edit' })], 150), undefined);
    assert.equal(
      matchPermissionGrant(
        request,
        [grant({ normalizedArgsHash: hashNormalizedArgs({ command: 'whoami' }) })],
        150,
      ),
      undefined,
    );
    assert.equal(
      matchPermissionGrant(
        request,
        [grant({ resourceScope: { kind: 'tool', value: 'Bash', mode: 'execute' } })],
        150,
      ),
      undefined,
    );
    assert.equal(matchPermissionGrant(request, [grant({ expiresAt: 149 })], 150), undefined);
  });

  test('summarizes command resource scope without embedding raw command text', () => {
    const secretCommand =
      'curl -H "Authorization: Bearer SECRET_TOKEN_123456" https://example.test';
    const scope = commandResourceScope(secretCommand);

    assert.equal(scope.kind, 'command');
    assert.equal(scope.mode, 'execute');
    assert.match(scope.value, /^bash-command:sha256:[a-f0-9]{16}$/);
    assert.equal(scope.value.includes('curl'), false);
    assert.equal(scope.value.includes('Authorization'), false);
    assert.equal(scope.value.includes('SECRET_TOKEN_123456'), false);
    assert.equal(scope.value.includes('example.test'), false);
  });

  test('allows short-lived cross-attempt grants only when attemptId is omitted', () => {
    assert.equal(
      matchPermissionGrant(request, [grant({ attemptId: undefined })], 150)?.grantId,
      'grant-1',
    );
  });
});
