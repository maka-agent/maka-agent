import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  evaluateMakaSkyContractTrace,
  MAKA_SKY_CONTRACT_CHECKS,
} from './cu-maka-sky-contract.mjs';
import { CU_E2E_SCENARIOS } from './cu-e2e-scenarios.mjs';

const target = { pid: 101, windowId: 11 };
const decoy = { pid: 202, windowId: 22 };

test('checked-in Codex Sky reference records the latest real behavior evidence', async () => {
  const reference = JSON.parse(await readFile(
    new URL('./fixtures/codex-sky-behavior-reference.json', import.meta.url),
    'utf8',
  ));
  assert.equal(reference.semanticMatrix.scenarioCount, 12);
  assert.equal(reference.semanticMatrix.allPassed, true);
  assert.deepEqual(reference.realExtensions, ['coordinate-click', 'drag', 'press-key']);
  assert.equal(reference.invariants.axDiffIsNotSoleBusinessOracle, true);
  assert.equal(reference.invariants.staleWrongTargetCount, 0);
  assert.equal(reference.invariants.coordinateUsesImmediatelyPrecedingScreenshot, true);
  assert.equal(reference.invariants.screenshotScope, 'window-or-app-local');
  assert.equal(reference.invariants.screenshotFormat, 'image/jpeg');
  assert.equal(reference.invariants.unrelatedDynamicContentIsUserIntervention, false);
});

function observation(overrides = {}) {
  return {
    observationId: 'obs-1',
    frameId: 'frame-1',
    epoch: 1,
    window: target,
    ...overrides,
  };
}

function action(overrides = {}) {
  return {
    actionId: 'action-1',
    fingerprint: 'fingerprint-1',
    kind: 'click_element',
    observationId: 'obs-1',
    frameId: 'frame-1',
    epoch: 1,
    window: target,
    sessionId: 'session-1',
    turnId: 'turn-1',
    ...overrides,
  };
}

test('every L1-L4 scenario references implemented Maka Sky contract checks', () => {
  for (const scenario of CU_E2E_SCENARIOS.filter(({ level }) =>
    ['L1', 'L2', 'L3', 'L4'].includes(level))) {
    assert.ok(scenario.contractChecks.length > 0, scenario.id);
    for (const check of scenario.contractChecks) {
      assert.equal(typeof MAKA_SKY_CONTRACT_CHECKS[check], 'function', `${scenario.id}: ${check}`);
    }
  }
});

test('accepts exact observation, frame, window, fresh-state, and duplicate rejection evidence', () => {
  const trace = {
    observations: [observation(), observation({
      observationId: 'obs-2',
      frameId: 'frame-2',
      epoch: 2,
    })],
    actions: [
      action(),
      action({ actionId: 'action-replay' }),
    ],
    outcomes: [
      {
        actionId: 'action-1',
        status: 'executed',
        verified: true,
        freshObservationId: 'obs-2',
      },
      {
        actionId: 'action-replay',
        status: 'rejected',
        reason: 'duplicate_action',
        dispatched: false,
      },
    ],
  };
  const evaluated = evaluateMakaSkyContractTrace([
    'observation-window-frame-binding',
    'fresh-post-action-observation',
    'duplicate-action-rejection',
  ], trace);
  assert.equal(evaluated.pass, true);
});

test('unrelated dynamic content is not intervention; target mutation uniquely refetches or goes stale', () => {
  const trace = {
    actions: [
      action({ actionId: 'dynamic-action' }),
      action({ actionId: 'stale-action', fingerprint: 'fingerprint-2' }),
    ],
    outcomes: [
      { actionId: 'dynamic-action', status: 'executed', verified: true },
      {
        actionId: 'stale-action',
        status: 'executed',
        refetch: {
          unique: true,
          identityPreserved: true,
          wrongTargetCount: 0,
        },
      },
    ],
    stateChanges: [
      { actionId: 'dynamic-action', kind: 'unrelated-dynamic-content' },
      { actionId: 'stale-action', kind: 'target-element-change' },
    ],
  };
  assert.equal(evaluateMakaSkyContractTrace([
    'unrelated-dynamic-content-tolerated',
    'identity-preserving-stale-resolution',
  ], trace).pass, true);

  trace.outcomes[0].reason = 'user_intervened';
  assert.equal(evaluateMakaSkyContractTrace([
    'unrelated-dynamic-content-tolerated',
  ], trace).pass, false);

  trace.outcomes[1].refetch.wrongTargetCount = 1;
  assert.equal(evaluateMakaSkyContractTrace([
    'identity-preserving-stale-resolution',
  ], trace).pass, false);
});

test('AX diff can describe a changed element but cannot be the sole business oracle', () => {
  const trace = {
    verifications: [
      {
        actionId: 'visible-diff',
        requiresBusinessOracle: true,
        sources: ['ax_diff', 'fixture_state'],
        axDiffChanged: true,
      },
      {
        actionId: 'business-only-change',
        requiresBusinessOracle: true,
        sources: ['fixture_state'],
        axDiffChanged: false,
      },
    ],
  };
  assert.equal(evaluateMakaSkyContractTrace(['ax-diff-secondary-oracle'], trace).pass, true);
  trace.verifications[0].sources = ['ax_diff'];
  assert.equal(evaluateMakaSkyContractTrace(['ax-diff-secondary-oracle'], trace).pass, false);
});

test('same-name targets require explicit occurrence selection', () => {
  const trace = {
    elementSelections: [
      { id: 'second-save', matchCount: 2, occurrence: 2, selectedOccurrence: 2 },
    ],
  };
  assert.equal(evaluateMakaSkyContractTrace(['explicit-occurrence-selection'], trace).pass, true);
  delete trace.elementSelections[0].occurrence;
  assert.equal(evaluateMakaSkyContractTrace(['explicit-occurrence-selection'], trace).pass, false);
});

test('coordinate, drag, and scroll bind the immediately preceding window-local JPEG', () => {
  const trace = {
    screenshots: [{
      screenshotId: 'shot-1',
      sequence: 4,
      scope: 'window',
      mimeType: 'image/jpeg',
      window: target,
    }],
    actions: [
      action({
        actionId: 'coordinate',
        kind: 'click_coordinate',
        sequence: 5,
        screenshotId: 'shot-1',
        immediatelyPrecedingScreenshotId: 'shot-1',
        coordinate: { x: 100, y: 120 },
      }),
      action({
        actionId: 'drag',
        kind: 'drag',
        fingerprint: 'drag',
        sequence: 5,
        screenshotId: 'shot-1',
        immediatelyPrecedingScreenshotId: 'shot-1',
      }),
      action({
        actionId: 'scroll',
        kind: 'scroll',
        fingerprint: 'scroll',
        sequence: 5,
        screenshotId: 'shot-1',
        immediatelyPrecedingScreenshotId: 'shot-1',
      }),
    ],
  };
  assert.equal(evaluateMakaSkyContractTrace([
    'immediately-preceding-local-screenshot',
  ], trace).pass, true);
  trace.screenshots[0].scope = 'desktop-atlas';
  assert.equal(evaluateMakaSkyContractTrace([
    'immediately-preceding-local-screenshot',
  ], trace).pass, false);
});

test('reference behavior coverage includes the 12-scenario matrix and real coordinate extensions', () => {
  const trace = {
    semanticBehaviors: [
      'full-state',
      'visible-ax-diff',
      'button-click',
      'set-value',
      'type-text',
      'select-text',
      'checkbox',
      'secondary-action',
      'scroll',
      'modal',
      'unique-stale-refetch',
      'ambiguous-occurrence',
      'coordinate-click',
      'drag',
      'press-key',
    ].map((id) => ({ id, evidenceClass: 'real-runtime', passed: true })),
  };
  assert.equal(evaluateMakaSkyContractTrace(['semantic-action-coverage'], trace).pass, true);
  trace.semanticBehaviors.find(({ id }) => id === 'coordinate-click').passed = false;
  assert.equal(evaluateMakaSkyContractTrace(['semantic-action-coverage'], trace).pass, false);
});

test('zoom creates a fresh crop frame before crop-local coordinates may execute', () => {
  const trace = {
    observations: [
      observation(),
      observation({
        observationId: 'zoom-obs',
        frameId: 'zoom-frame',
        epoch: 2,
        coordinateSpace: {
          kind: 'crop',
          parentObservationId: 'obs-1',
          originX: 400,
          originY: 200,
          width: 600,
          height: 400,
        },
      }),
    ],
    actions: [
      action({ actionId: 'zoom-1', kind: 'zoom' }),
      action({
        actionId: 'crop-click',
        fingerprint: 'crop-click',
        observationId: 'zoom-obs',
        frameId: 'zoom-frame',
        epoch: 2,
        fromZoomObservationId: 'zoom-obs',
        coordinate: { x: 50, y: 60 },
      }),
    ],
    outcomes: [
      { actionId: 'zoom-1', status: 'executed', freshObservationId: 'zoom-obs' },
      { actionId: 'crop-click', status: 'executed' },
    ],
  };
  assert.equal(evaluateMakaSkyContractTrace(['zoom-crop-coordinate-space'], trace).pass, true);

  trace.actions[1].observationId = 'obs-1';
  assert.equal(evaluateMakaSkyContractTrace(['zoom-crop-coordinate-space'], trace).pass, false);
});

test('two-window and occlusion evidence never permits retargeting or dispatch', () => {
  const trace = {
    actions: [
      action({ actionId: 'exact-window' }),
      action({ actionId: 'occluded', fingerprint: 'fingerprint-2' }),
    ],
    outcomes: [
      { actionId: 'exact-window', status: 'executed', actualWindow: target },
      {
        actionId: 'occluded',
        status: 'rejected',
        reason: 'target_occluded',
        dispatched: false,
      },
    ],
    windowSafety: [
      { actionId: 'exact-window', kind: 'two-window', expectedWindow: target, decoyWindow: decoy },
      { actionId: 'occluded', kind: 'occluded' },
    ],
  };
  assert.equal(evaluateMakaSkyContractTrace([
    'two-window-isolation',
    'occlusion-rejection',
  ], trace).pass, true);
});

test('negative-origin and mixed-scale mappings use the captured display transform', () => {
  const trace = {
    displayMappings: [
      {
        id: 'negative-origin',
        logicalBounds: { x: -1440, y: 0 },
        sourceBoundsPx: { x: 0, y: 0 },
        scaleFactor: 1,
        source: { x: 320, y: 240 },
        logical: { x: -1120, y: 240 },
      },
      {
        id: 'retina',
        logicalBounds: { x: 0, y: 0 },
        sourceBoundsPx: { x: 1440, y: 0 },
        scaleFactor: 2,
        source: { x: 2440, y: 800 },
        logical: { x: 500, y: 400 },
      },
    ],
  };
  assert.equal(evaluateMakaSkyContractTrace([
    'negative-origin-mapping',
    'mixed-scale-mapping',
  ], trace).pass, true);
});

test('keyboard ownership is exact, verified, editable, session-turn scoped, and revocable', () => {
  const click = action({ actionId: 'click-owner' });
  const validType = action({
    actionId: 'type-valid',
    fingerprint: 'type-valid',
    kind: 'type_text',
    ownershipId: 'owner-1',
  });
  const revokedType = action({
    actionId: 'type-revoked',
    fingerprint: 'type-revoked',
    kind: 'type_text',
    ownershipId: 'owner-1',
    ownershipRevoked: true,
  });
  const trace = {
    actions: [click, validType, revokedType],
    outcomes: [
      {
        actionId: 'click-owner',
        status: 'executed',
        verified: true,
        editable: true,
        ownershipId: 'owner-1',
      },
      { actionId: 'type-valid', status: 'executed' },
      { actionId: 'type-revoked', status: 'rejected', reason: 'target_changed', dispatched: false },
    ],
  };
  assert.equal(evaluateMakaSkyContractTrace(['keyboard-ownership'], trace).pass, true);

  trace.outcomes[2] = { actionId: 'type-revoked', status: 'executed' };
  assert.equal(evaluateMakaSkyContractTrace(['keyboard-ownership'], trace).pass, false);
});

test('focus and real-pointer safety is a hard L4 gate', () => {
  const safe = { safetySamples: [{ id: 'sample-1', agentMovedRealCursor: false, agentChangedUserFocus: false }] };
  assert.equal(evaluateMakaSkyContractTrace(['focus-cursor-safety'], safe).pass, true);

  safe.safetySamples[0].agentChangedUserFocus = true;
  assert.equal(evaluateMakaSkyContractTrace(['focus-cursor-safety'], safe).pass, false);
});
