import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import type {
  AdditionalPermissionRequestEvent,
  PermissionRequestEvent,
  SandboxEscalationRequestEvent,
  UserQuestionRequestEvent,
} from '@maka/core';
import {
  activeInteractionFor,
  clearInteractions,
  dequeueInteractionByRequestId,
  dequeueInteractionByToolUseId,
  enqueueInteraction,
  type InteractionQueues,
} from '../interaction-queue.js';

function permission(requestId: string): PermissionRequestEvent {
  return {
    type: 'permission_request',
    id: `evt_${requestId}`,
    ts: 0,
    requestId,
    toolUseId: `call_${requestId}`,
    toolName: 'browser_snapshot',
  } as PermissionRequestEvent;
}

function question(requestId: string): UserQuestionRequestEvent {
  return {
    type: 'user_question_request',
    id: `evt_${requestId}`,
    ts: 0,
    requestId,
    toolUseId: `call_${requestId}`,
    turnId: 'turn_1',
    questions: [{ question: 'Choose', options: [{ label: 'A' }] }],
  };
}

function additionalPermission(requestId: string): AdditionalPermissionRequestEvent {
  return {
    type: 'permission_request',
    kind: 'additional_permissions',
    id: `evt_${requestId}`,
    turnId: 'turn_1',
    ts: 0,
    requestId,
    toolUseId: `call_${requestId}`,
    toolName: 'Write',
    category: 'file_write',
    reason: 'additional_permissions',
    args: undefined,
    cwd: '/workspace',
    justification: 'Write requires access to the requested path.',
    intentHash: `sha256:${'1'.repeat(64)}`,
    permissionsHash: `sha256:${'2'.repeat(64)}`,
    additionalPermissions: {
      fileSystem: { entries: [{ path: '/outside/file', access: 'write', scope: 'exact' }] },
    },
    risk: { outsideWorkspace: true, protectedMetadata: false, networkEnabled: false },
    alsoApprovesToolExecution: true,
    availableDecisions: ['allow_once', 'deny'],
    rememberForTurnAllowed: false,
  };
}

function sandboxEscalation(requestId: string): SandboxEscalationRequestEvent {
  return {
    type: 'permission_request',
    kind: 'sandbox_escalation',
    id: `evt_${requestId}`,
    turnId: 'turn_1',
    ts: 0,
    requestId,
    toolUseId: `call_${requestId}`,
    toolName: 'Bash',
    category: 'shell_unsafe',
    reason: 'sandbox_escalation',
    args: undefined,
    command: 'printf retry-ok > /tmp/retry.txt',
    cwd: '/workspace',
    justification: 'The exact command must write outside the workspace.',
    intentHash: `sha256:${'3'.repeat(64)}`,
    commandHash: `sha256:${'4'.repeat(64)}`,
    trigger: 'sandbox_denial',
    risk: {
      unsandboxedExecution: true,
      unrestrictedFileSystem: true,
      unrestrictedNetwork: true,
      protectedMetadataExposed: true,
    },
    alsoApprovesToolExecution: true,
    availableDecisions: ['allow_once', 'deny'],
    rememberForTurnAllowed: false,
  };
}

describe('composer interaction queue', () => {
  test('permission and question requests share one FIFO per session', () => {
    let queues: InteractionQueues = {};
    queues = enqueueInteraction(queues, 's', permission('permission'));
    queues = enqueueInteraction(queues, 's', question('question'));

    assert.equal(activeInteractionFor(queues, 's')?.requestId, 'permission');
    queues = dequeueInteractionByRequestId(queues, 's', 'permission');
    assert.equal(activeInteractionFor(queues, 's')?.requestId, 'question');
  });

  test('queues one-call additional permissions as ordinary composer interactions', () => {
    const queues = enqueueInteraction({}, 's', additionalPermission('additional'));
    const active = activeInteractionFor(queues, 's');
    assert.equal(active?.type, 'permission_request');
    if (active?.type === 'permission_request') {
      assert.equal(active.kind, 'additional_permissions');
      assert.equal(active.rememberForTurnAllowed, false);
    }
  });

  test('queues one-call sandbox escalation without turn memory', () => {
    const queues = enqueueInteraction({}, 's', sandboxEscalation('escalation'));
    const active = activeInteractionFor(queues, 's');
    assert.equal(active?.type, 'permission_request');
    if (active?.type === 'permission_request') {
      assert.equal(active.kind, 'sandbox_escalation');
      assert.equal(active.rememberForTurnAllowed, false);
    }
  });

  test('deduplicates replays and isolates sessions', () => {
    let queues: InteractionQueues = {};
    queues = enqueueInteraction(queues, 's1', question('a'));
    queues = enqueueInteraction(queues, 's1', question('a'));
    queues = enqueueInteraction(queues, 's2', permission('b'));

    assert.equal(queues.s1.length, 1);
    assert.equal(activeInteractionFor(queues, 's2')?.requestId, 'b');
  });

  test('tool completion and terminal events drain stale interactions', () => {
    let queues: InteractionQueues = {};
    queues = enqueueInteraction(queues, 's', permission('a'));
    queues = enqueueInteraction(queues, 's', question('b'));

    queues = dequeueInteractionByToolUseId(queues, 's', 'call_a');
    assert.equal(activeInteractionFor(queues, 's')?.requestId, 'b');
    assert.equal(dequeueInteractionByToolUseId(queues, 's', 'missing'), queues);

    queues = clearInteractions(queues, 's');
    assert.equal(activeInteractionFor(queues, 's'), undefined);
  });
});
