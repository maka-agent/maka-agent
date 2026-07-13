import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { createWorkspaceWritePermissionProfile } from '@maka/core/permission-profile';

import { PermissionEngine } from '../permission-engine.js';
import {
  DEFAULT_SANDBOX_ESCALATION_GRANT_TTL_MS,
  SandboxEscalationError,
  planDeclaredBashSandboxEscalation,
  sandboxEscalationCommandHash,
  type SandboxEscalationGrant,
} from '../sandbox-escalation.js';
import type { SandboxTransformRequest, SandboxTransformResult } from '../sandbox/index.js';
import {
  SandboxedCommandWorkspaceExecutor,
  type WorkspaceExecutor,
} from '../workspace-executor.js';

const command = 'printf ok > /outside/result.txt';
const cwd = '/workspace';
const declaration = {
  mode: 'require_escalated',
  justification: 'The requested output directory is outside the workspace.',
} as const;
const args = { command, sandbox_permissions: declaration };

describe('sandbox escalation planning and one-shot grants', () => {
  test('requires an explicit declaration and applies fixed mode rules', () => {
    assert.deepEqual(planDeclaredBashSandboxEscalation({
      declaration: undefined, command, cwd, mode: 'execute', args,
    }), { kind: 'not_required' });
    assert.equal(planDeclaredBashSandboxEscalation({
      declaration, command, cwd, mode: 'explore', args,
    }).kind, 'block');
    assert.equal(planDeclaredBashSandboxEscalation({
      declaration, command, cwd, mode: 'ask', args,
    }).kind, 'request');
    assert.equal(planDeclaredBashSandboxEscalation({
      declaration, command, cwd, mode: 'execute', args,
    }).kind, 'request');
    assert.deepEqual(planDeclaredBashSandboxEscalation({
      declaration, command, cwd, mode: 'bypass', args,
    }), { kind: 'not_required' });
  });

  test('binds an approved grant to the exact command, cwd, intent, and one consumption', () => {
    let now = 100;
    let id = 0;
    const engine = new PermissionEngine({ newId: () => `id-${++id}`, now: () => now });
    const plan = planDeclaredBashSandboxEscalation({
      declaration, command, cwd, mode: 'execute', args,
    });
    assert.equal(plan.kind, 'request');
    if (plan.kind !== 'request') return;
    const verdict = engine.evaluate({
      sessionId: 'session-1', turnId: 'turn-1', toolUseId: 'tool-1', toolName: 'Bash',
      args, mode: 'execute', cwd, sandboxEscalationProposal: plan.proposal,
    });
    assert.equal(verdict.kind, 'prompt');
    if (verdict.kind !== 'prompt') return;
    assert.equal(verdict.event.kind, 'sandbox_escalation');
    assert.equal(verdict.event.alsoApprovesToolExecution, false);
    engine.recordResponse('turn-1', {
      requestId: verdict.event.requestId,
      decision: 'allow',
      reviewer: 'auto_review',
      riskLevel: 'high',
      rationale: 'Exact action is authorized.',
    });

    assert.throws(() => engine.consumeSandboxEscalationGrant({
      sessionId: 'session-1', turnId: 'turn-1', toolUseId: 'tool-1', toolName: 'Bash',
      intentHash: plan.proposal.intentHash, command: `${command} changed`, cwd,
    }), (error: unknown) => error instanceof SandboxEscalationError
      && error.reason === 'sandbox_escalation_command_mismatch');

    const grant = engine.consumeSandboxEscalationGrant({
      sessionId: 'session-1', turnId: 'turn-1', toolUseId: 'tool-1', toolName: 'Bash',
      intentHash: plan.proposal.intentHash, command, cwd,
    });
    assert.equal(grant?.commandHash, sandboxEscalationCommandHash(command, cwd));
    assert.throws(() => engine.consumeSandboxEscalationGrant({
      sessionId: 'session-1', turnId: 'turn-1', toolUseId: 'tool-1', toolName: 'Bash',
      intentHash: plan.proposal.intentHash, command, cwd,
    }), (error: unknown) => error instanceof SandboxEscalationError
      && error.reason === 'sandbox_escalation_grant_consumed');
    now += DEFAULT_SANDBOX_ESCALATION_GRANT_TTL_MS;
  });

  test('expires an approved grant before execution', () => {
    let now = 100;
    let id = 0;
    const engine = new PermissionEngine({ newId: () => `id-${++id}`, now: () => now });
    const plan = planDeclaredBashSandboxEscalation({ declaration, command, cwd, mode: 'ask', args });
    assert.equal(plan.kind, 'request');
    if (plan.kind !== 'request') return;
    const verdict = engine.evaluate({
      sessionId: 'session-1', turnId: 'turn-1', toolUseId: 'tool-1', toolName: 'Bash',
      args, mode: 'ask', cwd, sandboxEscalationProposal: plan.proposal,
    });
    assert.equal(verdict.kind, 'prompt');
    if (verdict.kind !== 'prompt') return;
    engine.recordResponse('turn-1', { requestId: verdict.event.requestId, decision: 'allow' });
    now += DEFAULT_SANDBOX_ESCALATION_GRANT_TTL_MS + 1;
    assert.throws(() => engine.consumeSandboxEscalationGrant({
      sessionId: 'session-1', turnId: 'turn-1', toolUseId: 'tool-1', toolName: 'Bash',
      intentHash: plan.proposal.intentHash, command, cwd,
    }), (error: unknown) => error instanceof SandboxEscalationError
      && error.reason === 'sandbox_escalation_grant_expired');
  });
});

describe('SandboxedCommandWorkspaceExecutor escalation enforcement', () => {
  test('uses preference=forbid only for an exact trusted grant', async () => {
    const calls: SandboxTransformRequest[] = [];
    const executor = executorWithGrantCapture(calls);
    const result = await executor.exec({
      command,
      cwd,
      timeoutMs: 1_000,
      permissionContext: { sandboxEscalationGrant: grant() },
    });
    assert.equal(calls[0]?.preference, 'forbid');
    assert.equal(calls[0]?.additionalPermissions, undefined);
    assert.equal(result.sandboxType, 'none');
    assert.equal(result.sandboxed, false);
  });

  test('rejects command mismatch before transform or process execution', async () => {
    const calls: SandboxTransformRequest[] = [];
    const executor = executorWithGrantCapture(calls);
    await assert.rejects(executor.exec({
      command: `${command} changed`,
      cwd,
      timeoutMs: 1_000,
      permissionContext: { sandboxEscalationGrant: grant() },
    }), (error: unknown) => error instanceof SandboxEscalationError
      && error.reason === 'sandbox_escalation_command_mismatch');
    assert.equal(calls.length, 0);
  });
});

function grant(): SandboxEscalationGrant {
  return {
    grantId: 'grant-1', sessionId: 'session-1', turnId: 'turn-1', toolUseId: 'tool-1',
    toolName: 'Bash', intentHash: 'intent', commandHash: sandboxEscalationCommandHash(command, cwd),
    command, cwd,
    risk: {
      unsandboxedExecution: true, unrestrictedFileSystem: true,
      unrestrictedNetwork: true, protectedMetadataExposed: true,
    },
    issuedAt: 1, expiresAt: 10,
  };
}

function executorWithGrantCapture(calls: SandboxTransformRequest[]): SandboxedCommandWorkspaceExecutor {
  return new SandboxedCommandWorkspaceExecutor({
    inner: {} as WorkspaceExecutor,
    getSandboxContext: () => ({
      profile: createWorkspaceWritePermissionProfile(),
      workspaceRoots: [cwd],
      sandboxManager: {
        transform(request: SandboxTransformRequest): SandboxTransformResult {
          calls.push(request);
          return {
            ok: true,
            exec: {
              argv: [request.command.program, ...request.command.args], cwd: request.command.cwd,
              sandboxType: 'none', effectiveProfile: request.command.profile,
            },
            sandboxType: 'none', requiresSandbox: false, preference: request.preference ?? 'auto',
          };
        },
      },
    }),
    runProcess: async () => ({
      exitCode: 0, stdout: '', stderr: '', stdoutTruncated: false, stderrTruncated: false,
      timedOut: false, aborted: false,
    }),
  });
}
