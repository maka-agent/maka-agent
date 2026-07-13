import assert from 'node:assert/strict';
import test from 'node:test';

import {
  sanitizeCuDirectReport,
  sanitizeCuModelPlans,
} from './cu-report-sanitize.mjs';

test('CU reports keep metrics while dropping typed text, coordinates, URL secrets, and trace payloads', () => {
  const secret = 'secret-canary';
  const report = sanitizeCuDirectReport({
    schemaVersion: 1,
    evidenceClass: 'real-runtime',
    scenarioId: 'l1-single-click',
    model: 'gpt-test',
    baseUrl: `https://user:${secret}@example.test/v1?token=${secret}`,
    actions: [{
      action: { type: 'type', text: secret, x: 12, y: 34 },
      durationMs: 5,
      text: `computer.type failed: unsupported_action ${secret}`,
    }],
    traces: [{
      type: 'dispatch',
      actionType: 'type',
      expectedPid: 42,
      winnerPid: 84,
      title: secret,
      raw: { secret },
      durationMs: 4,
    }],
  });
  const serialized = JSON.stringify(report);

  assert.equal(report.endpointOrigin, 'https://example.test');
  assert.deepEqual(report.actions, [{
    type: 'type',
    durationMs: 5,
    resultCode: 'unsupported_action',
  }]);
  assert.deepEqual(report.traces, [{
    type: 'dispatch',
    actionType: 'type',
    expectedPid: 42,
    winnerPid: 84,
    durationMs: 4,
  }]);
  assert.doesNotMatch(serialized, new RegExp(secret));
  assert.doesNotMatch(serialized, /"x":12|"y":34/);
});

test('model plans expose only turn and action types', () => {
  const plans = sanitizeCuModelPlans([{
    turn: 1,
    responseId: 'private-response',
    actions: [{ type: 'click', x: 20, y: 40 }, { type: 'type', text: 'private' }],
  }]);
  assert.deepEqual(plans, [{
    turn: 1,
    actionTypes: ['click', 'type'],
  }]);
});
