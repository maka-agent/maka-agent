import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { TestPermissionEngine } from '../test-helpers.js';
import {
  DEFAULT_SANDBOX_ESCALATION_GRANT_TTL_MS,
  SandboxEscalationError,
  planDeclaredBashSandboxEscalation,
  sandboxEscalationCommandHash,
} from '../sandbox-escalation.js';

const command = 'printf ok > /outside/result.txt';
const cwd = '/workspace';
const declaration = {
  mode: 'require_escalated',
  justification: 'The requested output directory is outside the workspace.',
} as const;
const args = { command, sandbox_permissions: declaration };

describe('sandbox escalation planning and one-shot grants', () => {
  test('requires an explicit declaration and applies fixed mode rules', () => {
    assert.deepEqual(
      planDeclaredBashSandboxEscalation({
        declaration: undefined,
        command,
        cwd,
        mode: 'execute',
        args,
      }),
      { kind: 'not_required' },
    );
    assert.equal(
      planDeclaredBashSandboxEscalation({
        declaration,
        command,
        cwd,
        mode: 'explore',
        args,
      }).kind,
      'block',
    );
    assert.equal(
      planDeclaredBashSandboxEscalation({
        declaration,
        command,
        cwd,
        mode: 'ask',
        args,
      }).kind,
      'request',
    );
    assert.equal(
      planDeclaredBashSandboxEscalation({
        declaration,
        command,
        cwd,
        mode: 'execute',
        args,
      }).kind,
      'request',
    );
    assert.deepEqual(
      planDeclaredBashSandboxEscalation({
        declaration,
        command,
        cwd,
        mode: 'bypass',
        args,
      }),
      { kind: 'not_required' },
    );
  });

  test('binds a grant to the exact command, cwd, intent, and one consumption', () => {
    let now = 100;
    let id = 0;
    const engine = new TestPermissionEngine({ newId: () => `id-${++id}`, now: () => now }, cwd);
    const plan = planDeclaredBashSandboxEscalation({
      declaration,
      command,
      cwd,
      mode: 'execute',
      args,
    });
    assert.equal(plan.kind, 'request');
    if (plan.kind !== 'request') return;
    const verdict = engine.evaluate({
      stage: 'sandbox_escalation',
      sessionId: 'session-1',
      turnId: 'turn-1',
      toolUseId: 'tool-1',
      toolName: 'Bash',
      args,
      mode: 'execute',
      cwd,
      proposal: plan.proposal,
    });
    assert.equal(verdict.kind, 'prompt');
    if (verdict.kind !== 'prompt') return;
    assert.equal(verdict.event.kind, 'sandbox_escalation');
    if (verdict.event.kind !== 'sandbox_escalation') return;
    assert.deepEqual(verdict.event.review, { kind: 'command', command, cwd });
    assert.equal(verdict.event.alsoApprovesToolExecution, false);
    engine.recordResponse('turn-1', {
      requestId: verdict.event.requestId,
      decision: 'allow',
      reviewer: 'auto_review',
      riskLevel: 'high',
    });

    assert.throws(
      () =>
        engine.consumeSandboxEscalationGrant({
          sessionId: 'session-1',
          turnId: 'turn-1',
          toolUseId: 'tool-1',
          toolName: 'Bash',
          intentHash: plan.proposal.intentHash,
          command: `${command} changed`,
          cwd,
        }),
      (error: unknown) =>
        error instanceof SandboxEscalationError &&
        error.reason === 'sandbox_escalation_command_mismatch',
    );

    const grant = engine.consumeSandboxEscalationGrant({
      sessionId: 'session-1',
      turnId: 'turn-1',
      toolUseId: 'tool-1',
      toolName: 'Bash',
      intentHash: plan.proposal.intentHash,
      command,
      cwd,
    });
    assert.equal(grant?.commandHash, sandboxEscalationCommandHash(command, cwd));
    assert.throws(
      () =>
        engine.consumeSandboxEscalationGrant({
          sessionId: 'session-1',
          turnId: 'turn-1',
          toolUseId: 'tool-1',
          toolName: 'Bash',
          intentHash: plan.proposal.intentHash,
          command,
          cwd,
        }),
      (error: unknown) =>
        error instanceof SandboxEscalationError &&
        error.reason === 'sandbox_escalation_grant_consumed',
    );
    now += DEFAULT_SANDBOX_ESCALATION_GRANT_TTL_MS;
  });

  test('expires an approved grant before execution', () => {
    let now = 100;
    let id = 0;
    const engine = new TestPermissionEngine({ newId: () => `id-${++id}`, now: () => now }, cwd);
    const plan = planDeclaredBashSandboxEscalation({
      declaration,
      command,
      cwd,
      mode: 'ask',
      args,
    });
    assert.equal(plan.kind, 'request');
    if (plan.kind !== 'request') return;
    const verdict = engine.evaluate({
      stage: 'sandbox_escalation',
      sessionId: 'session-1',
      turnId: 'turn-1',
      toolUseId: 'tool-1',
      toolName: 'Bash',
      args,
      mode: 'ask',
      cwd,
      proposal: plan.proposal,
    });
    assert.equal(verdict.kind, 'prompt');
    if (verdict.kind !== 'prompt') return;
    engine.recordResponse('turn-1', { requestId: verdict.event.requestId, decision: 'allow' });
    now += DEFAULT_SANDBOX_ESCALATION_GRANT_TTL_MS + 1;
    assert.throws(
      () =>
        engine.consumeSandboxEscalationGrant({
          sessionId: 'session-1',
          turnId: 'turn-1',
          toolUseId: 'tool-1',
          toolName: 'Bash',
          intentHash: plan.proposal.intentHash,
          command,
          cwd,
        }),
      (error: unknown) =>
        error instanceof SandboxEscalationError &&
        error.reason === 'sandbox_escalation_grant_expired',
    );
  });
});
