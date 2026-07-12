import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  MAKA_AHE_CURRENT_COMPONENTS,
  MAKA_AHE_TARGET_PROTOCOL_VERSION,
  validateMakaAheChangeManifest,
  validateMakaAheRunResult,
  validateMakaAheTargetComponents,
} from '../ahe-target-protocol.js';
import {
  INVALID_MAKA_AHE_CHANGE_MANIFEST,
  INVALID_MAKA_AHE_COMPONENTS,
  VALID_MAKA_AHE_CHANGE_MANIFEST,
} from './ahe-target-protocol.fixtures.js';

describe('AHE target protocol', () => {
  it('accepts the current Maka component map', () => {
    const result = validateMakaAheTargetComponents(MAKA_AHE_CURRENT_COMPONENTS);

    assert.equal(result.ok, true);
  });

  it('rejects invalid component maps', () => {
    const result = validateMakaAheTargetComponents(INVALID_MAKA_AHE_COMPONENTS);

    assert.equal(result.ok, false);
    if (!result.ok) {
      assert(result.errors.some((error) => error.path === 'components[0].category'));
      assert(result.errors.some((error) => error.path === 'components[1].id'));
      assert(result.errors.some((error) => error.path === 'components[1].sourceRefs'));
    }
  });

  it('accepts a source-backed change manifest', () => {
    const result = validateMakaAheChangeManifest(VALID_MAKA_AHE_CHANGE_MANIFEST);

    assert.equal(result.ok, true);
  });

  it('lets the heavy-task component patch its policy owner', () => {
    const result = validateMakaAheChangeManifest({
      ...VALID_MAKA_AHE_CHANGE_MANIFEST,
      changedComponents: ['maka-heavy-task-policy'],
      patch: {
        applyMode: 'staged_patch',
        changedFiles: ['packages/headless/src/heavy-task-policy.ts'],
      },
    });

    assert.equal(result.ok, true);
  });

  it('rejects manifests that target unknown components or omit falsifiable evidence', () => {
    const result = validateMakaAheChangeManifest(INVALID_MAKA_AHE_CHANGE_MANIFEST);

    assert.equal(result.ok, false);
    if (!result.ok) {
      assert(result.errors.some((error) => error.path === 'changedComponents[0]'));
      assert(result.errors.some((error) => error.path === 'predictedFixes'));
      assert(result.errors.some((error) => error.path === 'rollbackCriteria'));
    }
  });

  it('rejects manifests that try to patch evidence-only components', () => {
    const result = validateMakaAheChangeManifest({
      ...VALID_MAKA_AHE_CHANGE_MANIFEST,
      changedComponents: ['maka-runtime-evidence'],
      patch: {
        applyMode: 'staged_patch',
        changedFiles: ['packages/core/src/runtime-event.ts'],
      },
    });

    assert.equal(result.ok, false);
    if (!result.ok) {
      assert(result.errors.some((error) => error.message.includes('evidence-only')));
    }
  });

  it('rejects patch paths outside changed editable component source refs', () => {
    const result = validateMakaAheChangeManifest({
      ...VALID_MAKA_AHE_CHANGE_MANIFEST,
      changedComponents: ['maka-system-prompt'],
      patch: {
        applyMode: 'staged_patch',
        changedFiles: ['packages/runtime/src/tool-runtime.ts'],
      },
    });

    assert.equal(result.ok, false);
    if (!result.ok) {
      assert(result.errors.some((error) => error.path === 'patch.changedFiles[0]'));
    }
  });

  it('rejects unsafe generated or repository-control patch paths', () => {
    const result = validateMakaAheChangeManifest({
      ...VALID_MAKA_AHE_CHANGE_MANIFEST,
      patch: {
        applyMode: 'staged_patch',
        changedFiles: ['packages/headless/dist/system-prompts.js', '../outside.ts', '.git/config'],
      },
    });

    assert.equal(result.ok, false);
    if (!result.ok) {
      assert(result.errors.some((error) => error.message.includes('generated')));
      assert(result.errors.some((error) => error.message.includes('traverse')));
      assert(result.errors.some((error) => error.message.includes('repository-control')));
    }
  });

  it('does not allow self-checks to claim official pass/fail', () => {
    const result = validateMakaAheRunResult({
      protocolVersion: MAKA_AHE_TARGET_PROTOCOL_VERSION,
      runId: 'run-candidate',
      snapshotId: 'snap-candidate',
      taskId: 'terminal-bench/sqlite-with-gcov',
      status: 'official_pass',
      scoreAuthority: 'self_check',
      score: 1,
    });

    assert.equal(result.ok, false);
    if (!result.ok) {
      assert(result.errors.some((error) => error.path === 'status'));
    }
  });
});
