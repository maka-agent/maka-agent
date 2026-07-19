import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import type { AnyPermissionRequestEvent } from '@maka/core/events';

import {
  AiSdkAutoApprovalReviewer,
  ApprovalCoordinator,
  type AutoApprovalReviewer,
} from '../approval-reviewer.js';
import { PermissionEngine } from '../permission-engine.js';
import { planDeclaredBashSandboxEscalation } from '../sandbox-escalation.js';

const command = 'printf ok > /outside/result.txt';
const cwd = '/workspace';
const declaration = {
  mode: 'require_escalated',
  justification: 'Write the requested result.',
} as const;
const args = { command, sandbox_permissions: declaration };

describe('ApprovalCoordinator', () => {
  test('routes ask to the user and marks the response as user-reviewed', async () => {
    const { engine, verdict } = escalationVerdict('ask');
    const emitted: AnyPermissionRequestEvent[] = [];
    const pending = new ApprovalCoordinator({}).resolve({
      mode: 'ask',
      verdict,
      permissionEngine: engine,
      context: { sessionId: 'session-1', turnId: 'turn-1', cwd, permissionMode: 'ask' },
      emitUserRequest: (event) => emitted.push(event),
    });
    assert.equal(emitted.length, 1);
    engine.recordResponse('turn-1', { requestId: verdict.event.requestId, decision: 'allow' });
    assert.deepEqual(await pending, {
      requestId: verdict.event.requestId,
      decision: 'allow',
      reviewer: 'user',
    });
  });

  test('routes execute to auto review without an interactive event', async () => {
    const { engine, verdict } = escalationVerdict('execute');
    const emitted: AnyPermissionRequestEvent[] = [];
    const reviewer: AutoApprovalReviewer = {
      review: async () => ({
        outcome: 'allow',
        riskLevel: 'high',
        rationale: 'Exact action is authorized.',
      }),
    };
    const response = await new ApprovalCoordinator({ autoReviewer: reviewer }).resolve({
      mode: 'execute',
      verdict,
      permissionEngine: engine,
      context: {
        sessionId: 'session-1',
        turnId: 'turn-1',
        cwd,
        permissionMode: 'execute',
        userIntent: 'Write this exact output outside the workspace.',
      },
      emitUserRequest: (event) => emitted.push(event),
    });
    assert.equal(emitted.length, 0);
    assert.equal(response.decision, 'allow');
    assert.equal(response.reviewer, 'auto_review');
    assert.equal(response.riskLevel, 'high');
  });

  test('fails closed when automatic review is unavailable or throws', async () => {
    for (const coordinator of [
      new ApprovalCoordinator({}),
      new ApprovalCoordinator({
        autoReviewer: {
          review: async () => {
            throw new Error('offline');
          },
        },
      }),
    ]) {
      const { engine, verdict } = escalationVerdict('execute');
      const response = await coordinator.resolve({
        mode: 'execute',
        verdict,
        permissionEngine: engine,
        context: { sessionId: 'session-1', turnId: 'turn-1', cwd, permissionMode: 'execute' },
        emitUserRequest: () => assert.fail('must not emit an interactive request'),
      });
      assert.equal(response.decision, 'deny');
      assert.equal(response.reviewer, 'auto_review');
      assert.equal(response.riskLevel, 'critical');
    }
  });
});

describe('AiSdkAutoApprovalReviewer', () => {
  test('accepts only the strict schema and sends no tool definitions', async () => {
    const calls: Record<string, unknown>[] = [];
    const reviewer = new AiSdkAutoApprovalReviewer({
      resolveModel: () => 'model',
      generateText: async (input) => {
        calls.push(input);
        return {
          text: '{"outcome":"allow","riskLevel":"medium","rationale":"Authorized exact action."}',
        };
      },
    });
    const decision = await reviewer.review({
      request: requestEvent(),
      context: { sessionId: 'session-1', turnId: 'turn-1', cwd, permissionMode: 'execute' },
    });
    assert.equal(decision.outcome, 'allow');
    assert.equal('tools' in calls[0]!, false);
  });

  test('retries invalid structured output only to the configured limit', async () => {
    let calls = 0;
    const reviewer = new AiSdkAutoApprovalReviewer({
      resolveModel: () => 'model',
      maxAttempts: 2,
      generateText: async () => {
        calls += 1;
        return { text: '{"outcome":"allow"}' };
      },
    });
    await assert.rejects(
      reviewer.review({
        request: requestEvent(),
        context: { sessionId: 'session-1', turnId: 'turn-1', cwd, permissionMode: 'execute' },
      }),
    );
    assert.equal(calls, 2);
  });

  test('times out even when the model adapter ignores the abort signal', {
    timeout: 1_000,
  }, async () => {
    const reviewer = new AiSdkAutoApprovalReviewer({
      resolveModel: () => 'model',
      timeoutMs: 10,
      maxAttempts: 1,
      generateText: async () => await new Promise(() => {}),
    });
    await assert.rejects(
      reviewer.review({
        request: requestEvent(),
        context: { sessionId: 'session-1', turnId: 'turn-1', cwd, permissionMode: 'execute' },
      }),
      /timed out/,
    );
  });

  test('does not call the model when the review was already aborted', async () => {
    const controller = new AbortController();
    controller.abort(new Error('turn stopped'));
    let calls = 0;
    const reviewer = new AiSdkAutoApprovalReviewer({
      resolveModel: () => 'model',
      generateText: async () => {
        calls += 1;
        return { text: '{"outcome":"deny","riskLevel":"high","rationale":"Denied."}' };
      },
    });
    await assert.rejects(
      reviewer.review({
        request: requestEvent(),
        context: { sessionId: 'session-1', turnId: 'turn-1', cwd, permissionMode: 'execute' },
        abortSignal: controller.signal,
      }),
      /turn stopped/,
    );
    assert.equal(calls, 0);
  });
});

function escalationVerdict(mode: 'ask' | 'execute') {
  let id = 0;
  const engine = new PermissionEngine({ newId: () => `id-${++id}`, now: () => 100 });
  const plan = planDeclaredBashSandboxEscalation({ declaration, command, cwd, mode, args });
  assert.equal(plan.kind, 'request');
  if (plan.kind !== 'request') throw new Error('Expected escalation request');
  const verdict = engine.evaluate({
    sessionId: 'session-1',
    turnId: 'turn-1',
    toolUseId: 'tool-1',
    toolName: 'Bash',
    args,
    mode,
    cwd,
    sandboxEscalationProposal: plan.proposal,
  });
  assert.equal(verdict.kind, 'prompt');
  if (verdict.kind !== 'prompt') throw new Error('Expected permission prompt');
  return { engine, verdict };
}

function requestEvent(): AnyPermissionRequestEvent {
  return {
    type: 'permission_request',
    kind: 'sandbox_escalation',
    id: 'event-1',
    turnId: 'turn-1',
    ts: 1,
    requestId: 'request-1',
    toolUseId: 'tool-1',
    toolName: 'Bash',
    category: 'shell_unsafe',
    reason: 'sandbox_escalation',
    args: undefined,
    command,
    cwd,
    justification: declaration.justification,
    intentHash: 'intent',
    commandHash: 'command',
    trigger: 'proactive',
    risk: {
      unsandboxedExecution: true,
      unrestrictedFileSystem: true,
      unrestrictedNetwork: true,
      protectedMetadataExposed: true,
    },
    alsoApprovesToolExecution: false,
    availableDecisions: ['allow_once', 'deny'],
    rememberForTurnAllowed: false,
  };
}
