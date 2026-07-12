const MUTATING_ACTIONS = new Set([
  'click_element',
  'set_value',
  'click_coordinate',
  'type_text',
  'press_key',
  'scroll',
  'drag',
]);

const STALE_REASONS = new Set(['stale_element', 'stale_frame', 'target_changed']);

function result(pass, message, detail = {}) {
  return { pass, message, ...detail };
}

function indexTrace(trace) {
  return {
    observations: new Map((trace.observations ?? []).map((entry) => [entry.observationId, entry])),
    actions: new Map((trace.actions ?? []).map((entry) => [entry.actionId, entry])),
    outcomes: new Map((trace.outcomes ?? []).map((entry) => [entry.actionId, entry])),
  };
}

function sameWindow(left, right) {
  return left?.pid === right?.pid && left?.windowId === right?.windowId;
}

function assertObservationBinding(trace) {
  const indexed = indexTrace(trace);
  const failures = [];
  for (const action of trace.actions ?? []) {
    if (!MUTATING_ACTIONS.has(action.kind)) continue;
    const observation = indexed.observations.get(action.observationId);
    if (
      !observation
      || action.frameId !== observation.frameId
      || action.epoch !== observation.epoch
      || !sameWindow(action.window, observation.window)
    ) {
      failures.push(action.actionId);
    }
  }
  return result(
    failures.length === 0,
    failures.length === 0
      ? 'every mutating action is bound to its observation, frame, epoch, and window'
      : `unbound actions: ${failures.join(', ')}`,
    { failures },
  );
}

function assertFreshPostActionObservation(trace) {
  const indexed = indexTrace(trace);
  const failures = [];
  for (const outcome of trace.outcomes ?? []) {
    if (outcome.status !== 'executed') continue;
    const action = indexed.actions.get(outcome.actionId);
    if (!action || !MUTATING_ACTIONS.has(action.kind)) continue;
    const fresh = indexed.observations.get(outcome.freshObservationId);
    if (!fresh || fresh.observationId === action.observationId) failures.push(outcome.actionId);
  }
  return result(
    failures.length === 0,
    failures.length === 0
      ? 'every executed mutation returns a fresh observation'
      : `missing fresh observations: ${failures.join(', ')}`,
    { failures },
  );
}

function assertDuplicateActionRejection(trace) {
  const seen = new Set();
  const failures = [];
  const indexed = indexTrace(trace);
  for (const action of trace.actions ?? []) {
    const fingerprint = action.fingerprint;
    if (!fingerprint || !seen.has(fingerprint)) {
      if (fingerprint) seen.add(fingerprint);
      continue;
    }
    const outcome = indexed.outcomes.get(action.actionId);
    if (
      outcome?.status !== 'rejected'
      || outcome.reason !== 'duplicate_action'
      || outcome.dispatched === true
    ) {
      failures.push(action.actionId);
    }
  }
  return result(
    failures.length === 0,
    failures.length === 0
      ? 'replayed action fingerprints fail closed before dispatch'
      : `duplicate actions were not rejected: ${failures.join(', ')}`,
    { failures },
  );
}

function assertDynamicContentClassification(trace) {
  const indexed = indexTrace(trace);
  const failures = [];
  for (const change of trace.stateChanges ?? []) {
    const outcome = indexed.outcomes.get(change.actionId);
    if (change.kind === 'unrelated-dynamic-content') {
      if (outcome?.reason === 'user_intervened') failures.push(change.actionId);
      continue;
    }
    if (change.kind !== 'target-element-change') continue;
    const rejectedStale = outcome?.status === 'rejected'
      && STALE_REASONS.has(outcome.reason)
      && outcome.dispatched !== true;
    const uniqueRefetch = outcome?.status === 'executed'
      && outcome.refetch?.unique === true
      && outcome.refetch?.identityPreserved === true
      && outcome.refetch?.wrongTargetCount === 0;
    if (!rejectedStale && !uniqueRefetch) {
      failures.push(change.actionId);
    }
  }
  return result(
    failures.length === 0,
    failures.length === 0
      ? 'unrelated dynamic content is tolerated and stale targets either uniquely refetch or fail closed'
      : `misclassified state changes: ${failures.join(', ')}`,
    { failures },
  );
}

function assertAxDiffIsSecondaryOracle(trace) {
  const failures = [];
  for (const verification of trace.verifications ?? []) {
    if (verification.requiresBusinessOracle !== true) continue;
    const sources = new Set(verification.sources ?? []);
    if (
      sources.size === 0
      || [...sources].every((source) => source === 'ax_diff')
    ) {
      failures.push(verification.actionId);
    }
  }
  return result(
    failures.length === 0,
    failures.length === 0
      ? 'AX diff is evidence, but every business effect has an independent postcondition oracle'
      : `AX diff was the sole business oracle: ${failures.join(', ')}`,
    { failures },
  );
}

function assertExplicitOccurrenceSelection(trace) {
  const failures = [];
  for (const selection of trace.elementSelections ?? []) {
    if (selection.matchCount <= 1) continue;
    if (
      !Number.isInteger(selection.occurrence)
      || selection.occurrence < 1
      || selection.occurrence > selection.matchCount
      || selection.selectedOccurrence !== selection.occurrence
    ) {
      failures.push(selection.id);
    }
  }
  return result(
    failures.length === 0,
    failures.length === 0
      ? 'same-name elements require an explicit, verified occurrence'
      : `ambiguous element selections: ${failures.join(', ')}`,
    { failures },
  );
}

function assertImmediatelyPrecedingLocalScreenshot(trace) {
  const screenshots = new Map((trace.screenshots ?? []).map((entry) => [entry.screenshotId, entry]));
  const failures = [];
  for (const action of trace.actions ?? []) {
    if (!('coordinate' in action) && action.kind !== 'drag' && action.kind !== 'scroll') continue;
    const screenshot = screenshots.get(action.screenshotId);
    if (
      !screenshot
      || action.screenshotId !== action.immediatelyPrecedingScreenshotId
      || screenshot.sequence !== action.sequence - 1
      || !['window', 'app'].includes(screenshot.scope)
      || screenshot.mimeType !== 'image/jpeg'
      || !sameWindow(screenshot.window, action.window)
    ) {
      failures.push(action.actionId);
    }
  }
  return result(
    failures.length === 0,
    failures.length === 0
      ? 'coordinate actions bind the immediately preceding app/window-local JPEG'
      : `invalid screenshot bindings: ${failures.join(', ')}`,
    { failures },
  );
}

const REQUIRED_SEMANTIC_BEHAVIORS = new Set([
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
]);

function assertSemanticActionCoverage(trace) {
  const passed = new Set(
    (trace.semanticBehaviors ?? [])
      .filter((entry) => entry.evidenceClass === 'real-runtime' && entry.passed === true)
      .map((entry) => entry.id),
  );
  const failures = [...REQUIRED_SEMANTIC_BEHAVIORS].filter((id) => !passed.has(id));
  return result(
    failures.length === 0,
    failures.length === 0
      ? 'Codex-reference semantic, coordinate, drag, key, scroll, and modal behaviors have real evidence'
      : `missing real behavior evidence: ${failures.join(', ')}`,
    { failures },
  );
}

function assertZoomCoordinateSpace(trace) {
  const indexed = indexTrace(trace);
  const failures = [];
  for (const action of trace.actions ?? []) {
    if (action.kind !== 'zoom') continue;
    const outcome = indexed.outcomes.get(action.actionId);
    if (outcome?.status !== 'executed') continue;
    const fresh = indexed.observations.get(outcome.freshObservationId);
    const coordinateSpace = fresh?.coordinateSpace;
    if (
      !fresh
      || fresh.observationId === action.observationId
      || coordinateSpace?.kind !== 'crop'
      || coordinateSpace.parentObservationId !== action.observationId
      || !Number.isFinite(coordinateSpace.originX)
      || !Number.isFinite(coordinateSpace.originY)
      || !(coordinateSpace.width > 0)
      || !(coordinateSpace.height > 0)
    ) {
      failures.push(action.actionId);
    }
  }
  for (const action of trace.actions ?? []) {
    if (!action.fromZoomObservationId || !('coordinate' in action)) continue;
    if (action.observationId !== action.fromZoomObservationId) failures.push(action.actionId);
  }
  return result(
    failures.length === 0,
    failures.length === 0
      ? 'zoom creates a fresh crop coordinate space and follow-up coordinates bind to it'
      : `ambiguous zoom coordinates: ${failures.join(', ')}`,
    { failures },
  );
}

function assertIsolationAndOcclusion(trace) {
  const indexed = indexTrace(trace);
  const failures = [];
  for (const expectation of trace.windowSafety ?? []) {
    const outcome = indexed.outcomes.get(expectation.actionId);
    if (expectation.kind === 'two-window') {
      const action = indexed.actions.get(expectation.actionId);
      if (
        !sameWindow(action?.window, expectation.expectedWindow)
        || outcome?.actualWindow && !sameWindow(outcome.actualWindow, expectation.expectedWindow)
      ) {
        failures.push(expectation.actionId);
      }
    }
    if (
      expectation.kind === 'occluded'
      && (
        outcome?.status !== 'rejected'
        || outcome.reason !== 'target_occluded'
        || outcome.dispatched === true
      )
    ) {
      failures.push(expectation.actionId);
    }
  }
  return result(
    failures.length === 0,
    failures.length === 0
      ? 'window identity is preserved and occluded targets fail closed'
      : `window safety failures: ${failures.join(', ')}`,
    { failures },
  );
}

function assertDisplayMappings(trace) {
  const failures = [];
  for (const mapping of trace.displayMappings ?? []) {
    const expectedX = mapping.logicalBounds.x
      + (mapping.source.x - mapping.sourceBoundsPx.x) / mapping.scaleFactor;
    const expectedY = mapping.logicalBounds.y
      + (mapping.source.y - mapping.sourceBoundsPx.y) / mapping.scaleFactor;
    if (
      Math.abs(expectedX - mapping.logical.x) > 1e-6
      || Math.abs(expectedY - mapping.logical.y) > 1e-6
    ) {
      failures.push(mapping.id);
    }
  }
  return result(
    failures.length === 0,
    failures.length === 0
      ? 'negative-origin and mixed-scale mappings preserve the captured transform'
      : `invalid display mappings: ${failures.join(', ')}`,
    { failures },
  );
}

function assertKeyboardOwnership(trace) {
  const indexed = indexTrace(trace);
  const clicks = new Map();
  const failures = [];
  for (const outcome of trace.outcomes ?? []) {
    const action = indexed.actions.get(outcome.actionId);
    if (
      action?.kind === 'click_element'
      && outcome.status === 'executed'
      && outcome.verified === true
      && outcome.editable === true
    ) {
      clicks.set(outcome.ownershipId, action);
    }
  }
  for (const action of trace.actions ?? []) {
    if (!['type_text', 'press_key'].includes(action.kind)) continue;
    const outcome = indexed.outcomes.get(action.actionId);
    const click = clicks.get(action.ownershipId);
    const valid = click
      && click.sessionId === action.sessionId
      && click.turnId === action.turnId
      && sameWindow(click.window, action.window)
      && action.ownershipRevoked !== true;
    if (valid) continue;
    if (outcome?.status !== 'rejected' || outcome.dispatched === true) {
      failures.push(action.actionId);
    }
  }
  return result(
    failures.length === 0,
    failures.length === 0
      ? 'keyboard actions require an unrevoked verified editable click in the same session, turn, and window'
      : `invalid keyboard ownership: ${failures.join(', ')}`,
    { failures },
  );
}

export const MAKA_SKY_CONTRACT_CHECKS = Object.freeze({
  'observation-window-frame-binding': assertObservationBinding,
  'fresh-post-action-observation': assertFreshPostActionObservation,
  'duplicate-action-rejection': assertDuplicateActionRejection,
  'ax-diff-secondary-oracle': assertAxDiffIsSecondaryOracle,
  'unrelated-dynamic-content-tolerated': assertDynamicContentClassification,
  'identity-preserving-stale-resolution': assertDynamicContentClassification,
  'explicit-occurrence-selection': assertExplicitOccurrenceSelection,
  'immediately-preceding-local-screenshot': assertImmediatelyPrecedingLocalScreenshot,
  'semantic-action-coverage': assertSemanticActionCoverage,
  'zoom-crop-coordinate-space': assertZoomCoordinateSpace,
  'two-window-isolation': assertIsolationAndOcclusion,
  'occlusion-rejection': assertIsolationAndOcclusion,
  'negative-origin-mapping': assertDisplayMappings,
  'mixed-scale-mapping': assertDisplayMappings,
  'keyboard-ownership': assertKeyboardOwnership,
  'focus-cursor-safety': (trace) => {
    const violations = (trace.safetySamples ?? []).filter((sample) =>
      sample.agentMovedRealCursor || sample.agentChangedUserFocus);
    return result(
      violations.length === 0,
      violations.length === 0
        ? 'agent caused no real cursor movement or user-focus change'
        : 'agent changed the real cursor or user focus',
      { failures: violations.map((sample) => sample.id) },
    );
  },
});

export function evaluateMakaSkyContractTrace(requiredChecks, trace) {
  const checks = {};
  for (const name of requiredChecks) {
    const check = MAKA_SKY_CONTRACT_CHECKS[name];
    if (!check) throw new Error(`unknown Maka Sky contract check "${name}"`);
    checks[name] = check(trace);
  }
  return {
    pass: Object.values(checks).every((entry) => entry.pass),
    checks,
  };
}
