import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  MODEL_CALIBRATION_CASE_COUNTS,
  buildModelCalibrationDecision,
  buildModelCalibrationEnvironment,
  qualifyModelCalibrationResults,
  type ModelCalibrationCaseKind,
  type ModelCalibrationCaseResult,
  type ModelCalibrationConfigReport,
} from '../model-calibration.js';

describe('model calibration result contract', () => {
  test('freezes adapter-discovered model ids without provider-specific fields', () => {
    const left = buildModelCalibrationEnvironment({
      connection: {
        slug: 'my-openai-compatible-gateway',
        providerType: 'openai-compatible',
        baseUrl: 'http://127.0.0.1:8317/v1',
      },
      modelIds: ['model-b', 'model-a', 'model-b'],
    });
    const right = buildModelCalibrationEnvironment({
      connection: {
        slug: 'my-openai-compatible-gateway',
        providerType: 'openai-compatible',
        baseUrl: 'http://127.0.0.1:8317/v1',
      },
      modelIds: ['model-a', 'model-b'],
    });
    assert.deepEqual(left.modelIds, ['model-a', 'model-b']);
    assert.equal(left.environmentId, right.environmentId);
    assert.match(left.endpointId, /^sha256:/);
    assert.doesNotMatch(JSON.stringify(left), /127\.0\.0\.1|baseUrl|apiKey|authorization/i);
  });

  test('requires the exact 5/5/5/3/2 matrix', () => {
    const results = passingResults();
    assert.equal(results.length, 20);
    assert.deepEqual(countKinds(results), MODEL_CALIBRATION_CASE_COUNTS);
    assert.equal(qualifyModelCalibrationResults(results).main.qualified, true);
    assert.throws(() => qualifyModelCalibrationResults(results.slice(1)), /exactly 20/);
    assert.throws(
      () => qualifyModelCalibrationResults(results.map((result) => ({ ...result, kind: 'structured_json' }))),
      /requires 5 structured_json results/,
    );
    assert.throws(
      () => qualifyModelCalibrationResults([
        { ...results[0]!, success: 'false' as unknown as boolean },
        ...results.slice(1),
      ]),
      /success must be a boolean/,
    );
  });

  test('keeps Main and Curator thresholds independent', () => {
    const results = passingResults();
    results[0] = { ...results[0]!, success: false, terminalProtocolSuccess: false };
    results[1] = { ...results[1]!, success: false, terminalProtocolSuccess: false };
    let qualification = qualifyModelCalibrationResults(results);
    assert.equal(qualification.main.qualified, true);
    assert.equal(qualification.curator.qualified, false);

    results[1] = { ...results[1]!, success: true, terminalProtocolSuccess: true };
    qualification = qualifyModelCalibrationResults(results);
    assert.equal(qualification.curator.qualified, true);
    results[2] = { ...results[2]!, forbiddenToolCalls: 1 };
    assert.equal(qualifyModelCalibrationResults(results).curator.qualified, false);
  });

  test('requires two distinct main-qualified models, not two levels of one model', () => {
    const environment = calibrationEnvironment();
    let decision = buildModelCalibrationDecision(environment, [
      report('model-a', 'low'),
      report('model-a', 'medium'),
    ]);
    assert.equal(decision.status, 'BLOCKED');
    assert.deepEqual(decision.mainQualifiedModelIds, ['model-a']);

    decision = buildModelCalibrationDecision(environment, [
      report('model-a', 'low'),
      report('model-b', 'medium'),
    ]);
    assert.equal(decision.status, 'QUALIFIED');
    assert.deepEqual(decision.mainQualifiedModelIds, ['model-a', 'model-b']);
  });

  test('recomputes qualification from case evidence and rejects a forged pass flag', () => {
    const forged = report('model-a', 'low');
    forged.results[0] = { ...forged.results[0]!, toolAdjacencyError: true };
    assert.throws(
      () => buildModelCalibrationDecision(calibrationEnvironment(), [forged]),
      /qualification does not match case evidence/,
    );
  });

  test('accepts semantically equal qualification objects regardless of property order', () => {
    const reordered = report('model-a', 'low');
    const { main, curator } = reordered.qualification;
    reordered.qualification = {
      main: {
        timeoutRate: main.timeoutRate,
        qualified: main.qualified,
        forbiddenToolCalls: main.forbiddenToolCalls,
        terminalProtocolSuccessRate: main.terminalProtocolSuccessRate,
        toolAdjacencyErrors: main.toolAdjacencyErrors,
        successRate: main.successRate,
      },
      curator: {
        forbiddenToolCalls: curator.forbiddenToolCalls,
        successRate: curator.successRate,
        qualified: curator.qualified,
        toolAdjacencyErrors: curator.toolAdjacencyErrors,
        timeoutRate: curator.timeoutRate,
        terminalProtocolSuccessRate: curator.terminalProtocolSuccessRate,
      },
    };
    assert.equal(
      buildModelCalibrationDecision(calibrationEnvironment(), [reordered]).status,
      'BLOCKED',
    );
  });

  test('rejects reports for models outside the frozen environment', () => {
    assert.throws(
      () => buildModelCalibrationDecision(calibrationEnvironment(), [report('model-c', 'low')]),
      /outside the frozen environment/,
    );
  });

  test('freezes model ids and rejects an environment whose fingerprint no longer matches', () => {
    const environment = calibrationEnvironment();
    assert.throws(
      () => (environment.modelIds as string[]).push('model-c'),
      TypeError,
    );
    const forged = {
      ...environment,
      modelIds: [...environment.modelIds, 'model-c'],
    };
    assert.throws(
      () => buildModelCalibrationDecision(forged, [report('model-a', 'low')]),
      /environment fingerprint does not match/,
    );
  });
});

function passingResults(): ModelCalibrationCaseResult[] {
  let index = 0;
  return Object.entries(MODEL_CALIBRATION_CASE_COUNTS).flatMap(([kind, count]) => (
    Array.from({ length: count }, () => ({
      caseId: `case-${++index}`,
      kind: kind as ModelCalibrationCaseKind,
      success: true,
      terminalProtocolSuccess: true,
      timeout: false,
      toolAdjacencyError: false,
      forbiddenToolCalls: 0,
      latencyMs: 1,
      usage: { inputTokens: 1, outputTokens: 1, reasoningTokens: 0, totalTokens: 2 },
    }))
  ));
}

function report(modelId: string, thinkingLevel: 'low' | 'medium'): ModelCalibrationConfigReport {
  const results = passingResults();
  return {
    environmentId: calibrationEnvironment().environmentId,
    connectionSlug: 'connection',
    modelId,
    thinkingLevel,
    results,
    qualification: qualifyModelCalibrationResults(results),
  };
}

function calibrationEnvironment() {
  return buildModelCalibrationEnvironment({
    connection: {
      slug: 'connection',
      providerType: 'openai-compatible',
      baseUrl: 'https://gateway.example/v1',
    },
    modelIds: ['model-a', 'model-b'],
  });
}

function countKinds(results: readonly ModelCalibrationCaseResult[]): Record<string, number> {
  return Object.fromEntries(Object.keys(MODEL_CALIBRATION_CASE_COUNTS).map((kind) => [
    kind,
    results.filter((result) => result.kind === kind).length,
  ]));
}
