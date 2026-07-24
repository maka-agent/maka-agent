import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { executeRestrictedVerification } from '../restricted-verification.js';

describe('restricted verification executor', () => {
  it('executes an allowlisted read-only observation', async () => {
    let executions = 0;
    const result = await executeRestrictedVerification({
      boundary: boundary(),
      request: {
        toolName: 'Read',
        canonicalArgsHash: 'sha256:read-target',
        workspaceEffect: 'none',
      },
      execute: async () => {
        executions += 1;
        return 'current contents';
      },
    });

    assert.deepEqual(result, { status: 'observed', observation: 'current contents' });
    assert.equal(executions, 1);
  });

  it('blocks an immediate retry of the interrupted operation before execution', async () => {
    let executions = 0;
    const result = await executeRestrictedVerification({
      boundary: boundary(),
      request: {
        toolName: 'Write',
        canonicalArgsHash: 'sha256:original-args',
        workspaceEffect: 'local_mutation',
      },
      execute: async () => {
        executions += 1;
        return 'must not run';
      },
    });

    assert.equal(result.status, 'blocked');
    assert.equal(result.diagnostic.code, 'restricted_verification_violation');
    assert.equal(result.diagnostic.reason, 'original_operation_retry');
    assert.equal(executions, 0);
  });

  it('blocks non-read-only and non-allowlisted verification tools', async () => {
    const mutating = await executeRestrictedVerification({
      boundary: boundary(),
      request: {
        toolName: 'FormatJson',
        canonicalArgsHash: 'sha256:format',
        workspaceEffect: 'local_mutation',
      },
      execute: async () => 'must not run',
    });
    const unlisted = await executeRestrictedVerification({
      boundary: boundary(),
      request: {
        toolName: 'Fetch',
        canonicalArgsHash: 'sha256:fetch',
        workspaceEffect: 'none',
      },
      execute: async () => 'must not run',
    });

    assert.equal(mutating.status, 'blocked');
    assert.equal(mutating.diagnostic.reason, 'workspace_mutation_forbidden');
    assert.equal(unlisted.status, 'blocked');
    assert.equal(unlisted.diagnostic.reason, 'tool_not_allowlisted');
  });

  it('turns observation failures into the stable recovery diagnostic', async () => {
    const result = await executeRestrictedVerification({
      boundary: boundary(),
      request: {
        toolName: 'Read',
        canonicalArgsHash: 'sha256:read-target',
        workspaceEffect: 'none',
      },
      execute: async () => {
        throw new Error('EACCES: sensitive host detail');
      },
    });

    assert.equal(result.status, 'blocked');
    assert.deepEqual(result.diagnostic, {
      code: 'tool_recovery_observation_failed',
      operationId: 'operation-1',
      toolName: 'Read',
      reason: 'observation_failed',
    });
  });
});

function boundary() {
  return {
    operationId: 'operation-1',
    originalToolName: 'Write',
    originalCanonicalArgsHash: 'sha256:original-args',
    allowedReadOnlyToolNames: ['Read', 'Glob', 'Grep'],
  } as const;
}
