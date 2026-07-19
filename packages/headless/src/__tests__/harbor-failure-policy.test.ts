import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { classifyExternalHarborBenchmarkFailure } from '../harbor-failure-policy.js';

describe('external Harbor benchmark failure policy', () => {
  test('lets model-side incomplete and budget outcomes fall through to Harbor scoring', () => {
    assert.deepEqual(
      classifyExternalHarborBenchmarkFailure({
        status: 'failed',
        errorClass: 'tool_step_cap_reached',
        taxonomy: 'agent_incomplete',
      }),
      { kind: 'budget_exhausted', shouldThrow: false, errorClass: 'tool_step_cap_reached' },
    );
    assert.deepEqual(
      classifyExternalHarborBenchmarkFailure({
        status: 'budget_exhausted',
        errorClass: 'budget_exhausted',
      }),
      { kind: 'budget_exhausted', shouldThrow: false, errorClass: 'budget_exhausted' },
    );
    assert.deepEqual(
      classifyExternalHarborBenchmarkFailure({
        status: 'failed',
        errorClass: 'incomplete_tool_calls',
      }),
      { kind: 'agent_incomplete', shouldThrow: false, errorClass: 'incomplete_tool_calls' },
    );
  });

  test('keeps setup and infrastructure failures as runner failures', () => {
    assert.deepEqual(
      classifyExternalHarborBenchmarkFailure({
        status: 'failed',
        errorClass: 'setup_failed',
        error: 'setup timeout while preparing fixture',
      }),
      { kind: 'infra_failure', shouldThrow: true, errorClass: 'setup_failed' },
    );
    assert.deepEqual(
      classifyExternalHarborBenchmarkFailure({
        status: 'failed',
        errorClass: 'docker_unavailable',
        error: 'container preflight failed',
      }),
      { kind: 'infra_failure', shouldThrow: true, errorClass: 'docker_unavailable' },
    );
  });

  test('completed runs never force a Harbor process error', () => {
    assert.deepEqual(
      classifyExternalHarborBenchmarkFailure({
        status: 'completed',
        errorClass: 'unsupported_adapter',
      }),
      { kind: 'none', shouldThrow: false },
    );
  });
});
