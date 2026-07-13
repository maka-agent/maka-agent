import assert from 'node:assert/strict';
import test from 'node:test';

import {
  sanitizeCuDirectReport,
  sanitizeCuModelPlans,
  sanitizeCuReport,
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

test('report sanitizer preserves validated attribution and drops arbitrary fields', () => {
  const report = sanitizeCuReport({
    schemaVersion: 1,
    evidenceClass: 'real-runtime',
    scenarioId: 'l0-observe-only',
    producer: 'cu-real-model-launcher',
    transportClass: 'live-network',
    policyMode: 'bypassed',
    provider: 'openai',
    model: 'gpt-5.4',
    status: 'inconclusive',
    failure: 'private provider body',
    loopStatus: { private: true },
    turns: [{ text: 'private' }],
    state: { private: true },
    display: { private: true },
    traces: [{
      type: 'dispatch',
      actionType: 'click_element',
      path: 'private-path',
      effect: 'private-effect',
      address: 'ax',
      tool: 'click',
    }],
  });
  assert.equal(report.producer, 'cu-real-model-launcher');
  assert.equal(report.provider, 'openai');
  assert.equal(report.model, 'gpt-5.4');
  assert.deepEqual(report.traces, [{
    type: 'dispatch',
    actionType: 'click_element',
    address: 'ax',
    tool: 'click',
  }]);
  const serialized = JSON.stringify(report);
  assert.doesNotMatch(serialized, /private/);
  assert.doesNotMatch(serialized, /loopStatus|turns|display/);
});
