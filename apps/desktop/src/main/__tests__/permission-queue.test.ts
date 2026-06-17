import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  activePermissionFor,
  clearPermissions,
  dequeuePermission,
  dequeuePermissionByToolUseId,
  enqueuePermission,
  type PermissionQueues,
} from '@maka/ui';
import type { PermissionRequestEvent } from '@maka/core';

// The renderer used to keep one pending permission per session, so a model that
// fired two tool calls in one step (browser_snapshot + browser_extract) had the
// second request overwrite the first — the first could never be answered and the
// turn hung. These cover the FIFO queue that replaced the single slot.

function req(requestId: string, toolName = 'browser_snapshot'): PermissionRequestEvent {
  return {
    type: 'permission_request',
    id: `evt_${requestId}`,
    ts: 0,
    requestId,
    toolUseId: `call_${requestId}`,
    toolName,
  } as unknown as PermissionRequestEvent;
}

describe('permission queue', () => {
  test('parallel requests both survive — the stranded browser_snapshot bug', () => {
    let q: PermissionQueues = {};
    q = enqueuePermission(q, 's', req('snapshot')); // snapshot requested first
    q = enqueuePermission(q, 's', req('extract', 'browser_extract')); // extract in parallel — used to overwrite
    assert.deepEqual(q['s'].map((r) => r.requestId), ['snapshot', 'extract']);

    // User answers extract; snapshot must remain (previously it was lost).
    q = dequeuePermission(q, 's', 'extract');
    assert.equal(activePermissionFor(q, 's')?.requestId, 'snapshot');
  });

  test('FIFO: the head is the active request and dequeuing it promotes the next', () => {
    let q: PermissionQueues = {};
    q = enqueuePermission(q, 's', req('a'));
    q = enqueuePermission(q, 's', req('b'));
    assert.equal(activePermissionFor(q, 's')?.requestId, 'a');
    q = dequeuePermission(q, 's', 'a');
    assert.equal(activePermissionFor(q, 's')?.requestId, 'b');
    q = dequeuePermission(q, 's', 'b');
    assert.equal(activePermissionFor(q, 's'), undefined);
  });

  test('enqueue dedups by requestId (e.g. a replayed snapshot event)', () => {
    let q: PermissionQueues = {};
    q = enqueuePermission(q, 's', req('a'));
    q = enqueuePermission(q, 's', req('a'));
    assert.equal(q['s'].length, 1);
  });

  test('clear drops every pending request for the session (turn ended/aborted)', () => {
    let q: PermissionQueues = {};
    q = enqueuePermission(q, 's', req('a'));
    q = enqueuePermission(q, 's', req('b'));
    q = clearPermissions(q, 's');
    assert.deepEqual(q['s'], []);
    assert.equal(activePermissionFor(q, 's'), undefined);
  });

  test('queues are isolated per session', () => {
    let q: PermissionQueues = {};
    q = enqueuePermission(q, 's1', req('a'));
    q = enqueuePermission(q, 's2', req('b'));
    assert.equal(activePermissionFor(q, 's1')?.requestId, 'a');
    assert.equal(activePermissionFor(q, 's2')?.requestId, 'b');
  });

  test('dequeuePermissionByToolUseId drains a request that ended without a decision', () => {
    // An expired/timed-out permission emits a tool_result (keyed by toolUseId),
    // not a permission_decision_ack — the renderer drains the stale entry on it.
    let q: PermissionQueues = {};
    q = enqueuePermission(q, 's', req('a')); // toolUseId call_a
    q = enqueuePermission(q, 's', req('b', 'browser_extract')); // toolUseId call_b
    q = dequeuePermissionByToolUseId(q, 's', 'call_a');
    assert.deepEqual(q['s'].map((r) => r.requestId), ['b']);
    // No-op (same reference) once it's gone — on the normal allow path the ack
    // already dequeued, so the later tool_result must not disturb the queue.
    assert.equal(dequeuePermissionByToolUseId(q, 's', 'call_a'), q);
  });

  test('activePermissionFor handles an undefined session and an empty queue', () => {
    assert.equal(activePermissionFor({}, undefined), undefined);
    assert.equal(activePermissionFor({ s: [] }, 's'), undefined);
  });
});
