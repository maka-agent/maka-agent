import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { ComputerUseIntentValidationError } from '../computer-use.js';
import {
  decodeInteractionAnswer,
  decodeInteractionCanonicalOutcome,
  decodeInteractionRequest,
  interactionCanonicalOutcomesEquivalent,
  isInteractionAnswerValidForRequest,
  isInteractionCanonicalOutcomeValidForRequest,
  projectInteractionPermissionRequest,
  projectInteractionQuestionRequest,
  type InteractionRequest,
} from '../interaction.js';
import {
  TurnPermissionMemory,
  createCanonicalToolIntent,
  preToolUse,
  projectAdditionalPermissionReview,
  type AdditionalPermissionRequest,
  type PermissionRequest,
  type SandboxEscalationRequest,
  type ToolCategory,
} from '../permission.js';
import {
  InteractionPermissionProjectionError,
  canonicalToolExecutionArgs,
  projectPublicToolApprovalReview,
  publicToolCommandSemanticText,
} from '../tool-intent.js';

function projectAskToolPermission(toolName: string, args: unknown, categoryHint?: ToolCategory) {
  const intent = createCanonicalToolIntent({
    toolName,
    args,
    cwd: '/workspace',
    ...(categoryHint === undefined ? {} : { categoryHint }),
  });
  const verdict = preToolUse({
    intent,
    mode: 'ask',
    turnMemory: new TurnPermissionMemory(),
  });
  assert.equal(verdict.kind, 'prompt');
  if (verdict.kind !== 'prompt') throw new Error('Expected permission prompt');
  const payload: PermissionRequest = {
    requestId: `request-${toolName}`,
    toolUseId: `tool-${toolName}`,
    ...verdict.prompt,
  };
  return {
    intent,
    payload,
    request: projectInteractionPermissionRequest(payload),
  };
}

describe('tool permission Interaction projection', () => {
  test('round-trips Browser navigate, click, and type risk semantics', () => {
    const cases = [
      projectAskToolPermission('browser_navigate', {
        url: 'https://example.test/account?token=opaque-token&tab=billing',
      }),
      projectAskToolPermission('browser_click', {
        target: { kind: 'selector', value: '#confirm' },
      }),
      projectAskToolPermission('browser_type', {
        target: { kind: 'selector', value: '#password' },
        text: 'Authorization: Basic dXNlcjpwYXNz=',
        submit: true,
      }),
    ];

    assert.deepEqual(cases[0]!.request.prompt.review, {
      kind: 'browser',
      action: 'navigate',
      url: 'https://example.test/account?token=REDACTED&tab=billing',
    });
    assert.deepEqual(cases[1]!.request.prompt.review, {
      kind: 'browser',
      action: 'click',
      ref: '#confirm',
    });
    assert.deepEqual(cases[2]!.request.prompt.review, {
      kind: 'browser',
      action: 'type',
      ref: '#password',
      text: 'Authorization: Basic REDACTED',
      submit: true,
    });
    assert.deepEqual(canonicalToolExecutionArgs(cases[2]!.intent), {
      target: { kind: 'selector', value: '#password' },
      text: 'Authorization: Basic dXNlcjpwYXNz=',
      submit: true,
    });
    for (const { request } of cases) {
      assert.deepEqual(decodeInteractionRequest(JSON.parse(JSON.stringify(request))), request);
      assert.ok(Object.isFrozen(request));
      assert.ok(Object.isFrozen(request.prompt));
    }
  });

  test('projects ask-mode patch operations without diff content', () => {
    const deleted = projectAskToolPermission('patch', {
      callId: 'patch-1',
      operation: { type: 'delete_file', path: 'src/legacy.ts' },
    });
    const updated = projectAskToolPermission('apply_patch', {
      operation: {
        type: 'update_file',
        path: 'src/current.ts',
        diff: 'PRIVATE_PATCH_BODY',
      },
    });

    assert.deepEqual(deleted.request.prompt.review, {
      kind: 'patch',
      operation: 'delete_file',
      path: 'src/legacy.ts',
      cwd: '/workspace',
    });
    assert.deepEqual(updated.request.prompt.review, {
      kind: 'patch',
      operation: 'update_file',
      path: 'src/current.ts',
      cwd: '/workspace',
    });
    assert.equal(JSON.stringify(updated.request).includes('PRIVATE_PATCH_BODY'), false);
    assert.equal(
      JSON.stringify(canonicalToolExecutionArgs(updated.intent)).includes('PRIVATE_PATCH_BODY'),
      true,
    );
  });

  test('uses the Computer Use registry before creating durable Interaction data', () => {
    const projected = projectAskToolPermission('maka_computer', {
      action: 'set_value',
      app: 'Editor',
      window_id: 7,
      observation_id: 'frame-private-7',
      element_id: 'field-private-2',
      element_identity: {
        token: 'element-private-token',
        role: 'AXTextField',
        label: 'API token',
        value: 'token=old/private-value',
      },
      value: 'token=new/private-value',
    });

    assert.deepEqual(projected.request.prompt.review, {
      kind: 'computer_use',
      action: 'set_value',
      app: 'Editor',
      windowId: 7,
    });
    assert.deepEqual(canonicalToolExecutionArgs(projected.intent), {
      action: 'set_value',
      observation_id: 'frame-private-7',
      element_id: 'field-private-2',
      value: 'token=new/private-value',
    });
    assert.deepEqual(
      decodeInteractionRequest(JSON.parse(JSON.stringify(projected.request))),
      projected.request,
    );

    for (const args of [
      { action: 'future_action', app: 'Editor' },
      { action: 'type', observation_id: 'frame-7', text: 'x' },
    ]) {
      assert.throws(
        () => projectAskToolPermission('maka_computer', args),
        ComputerUseIntentValidationError,
      );
    }
  });

  test('rejects generic, incomplete, and identity-mismatched public reviews', () => {
    const write = projectAskToolPermission('Write', {
      path: 'a.txt',
      content: 'private body',
    }).request;

    assert.throws(() =>
      decodeInteractionRequest({
        ...write,
        prompt: {
          ...write.prompt,
          review: { kind: 'generic', incomplete: true },
        },
      }),
    );
    assert.throws(() =>
      decodeInteractionRequest({
        ...write,
        prompt: {
          ...write.prompt,
          category: 'network_send',
          reason: 'network',
        },
      }),
    );
    assert.throws(
      () =>
        projectAskToolPermission(
          'mcp__server__send',
          { serverId: 'server', toolName: 'send', arguments: {} },
          'network_send',
        ),
      InteractionPermissionProjectionError,
    );
  });

  test('validates remember permission against the concrete agent producer identity', () => {
    const explore = projectAskToolPermission('ExploreAgent', {
      objective: 'Inspect the local permission boundary',
      roots: ['packages/core/src'],
      queries: ['remember scope'],
    }).request;
    assert.equal(explore.prompt.kind, 'tool_permission');
    if (explore.prompt.kind !== 'tool_permission') throw new Error('Expected tool permission');
    assert.equal(explore.prompt.rememberForTurnAllowed, false);
    assert.throws(() =>
      decodeInteractionRequest({
        ...explore,
        prompt: {
          ...explore.prompt,
          rememberForTurnAllowed: true,
        },
      }),
    );

    const spawned = projectAskToolPermission('agent_spawn', {
      profile: 'local_read',
      task: 'Inspect the local permission boundary',
      write_back: 'summary',
      isolation: 'same_workspace',
    }).request;
    assert.equal(spawned.prompt.kind, 'tool_permission');
    if (spawned.prompt.kind !== 'tool_permission') throw new Error('Expected tool permission');
    assert.equal(spawned.prompt.rememberForTurnAllowed, true);
    assert.deepEqual(decodeInteractionRequest(JSON.parse(JSON.stringify(spawned))), spawned);
  });

  test('durable request rejects raw args and public free-text additions', () => {
    const projected = projectAskToolPermission('browser_type', {
      target: { kind: 'selector', value: '#field' },
      text: 'private typed value',
    });
    assert.throws(() =>
      projectInteractionPermissionRequest({
        ...projected.payload,
        args: { text: 'private typed value' },
      } as PermissionRequest),
    );
    assert.throws(() =>
      decodeInteractionRequest({
        ...projected.request,
        prompt: {
          ...projected.request.prompt,
          rationale: 'private reviewer rationale',
        },
      }),
    );
  });
});

describe('Bash approval evidence', () => {
  test('supports complete Authorization literals through the real permission path', () => {
    const cases = [
      ['echo Authorization: Basic dXNlcjpwYXNz=', 'echo Authorization: Basic REDACTED'],
      [
        `echo '{"Authorization":"Bearer bearer-token_1","keep":"visible"}'`,
        `echo '{"Authorization":"Bearer REDACTED","keep":"visible"}'`,
      ],
      [
        String.raw`echo "{\"Authorization\":\"Bearer bearer-token_1\",\"keep\":\"visible\"}"`,
        String.raw`echo "{\"Authorization\":\"Bearer REDACTED\",\"keep\":\"visible\"}"`,
      ],
      [
        "curl -H 'Authorization: Bearer bearer-token_1' https://example.test",
        "curl -H 'Authorization: Bearer REDACTED' https://example.test",
      ],
    ] as const;

    for (const [command, expected] of cases) {
      const { request } = projectAskToolPermission('Bash', { command });
      assert.equal(request.prompt.review.kind, 'command');
      if (request.prompt.review.kind !== 'command') continue;
      assert.equal(publicToolCommandSemanticText(request.prompt.review), expected);
      assert.deepEqual(decodeInteractionRequest(JSON.parse(JSON.stringify(request))), request);
    }
  });

  test('fails closed for mismatched expansion closers and process substitution', () => {
    for (const command of [
      'echo $(echo }; token=printf; $token executed)',
      'cat <(echo token=secret; printf leaked); echo safe',
      'cat >(echo token=secret; printf leaked); echo safe',
      'cat <(cat >(echo token=secret; printf leaked)); echo safe',
    ]) {
      assert.throws(
        () => projectAskToolPermission('Bash', { command }),
        InteractionPermissionProjectionError,
        command,
      );
    }
  });

  test('rejects ambiguous hex outside Git object positions and keeps literal Git objects', () => {
    for (const length of [39, 40, 41, 63, 64, 65, 80]) {
      const objectId = 'a'.repeat(length);
      const nonGitCommand = `echo ${objectId}`;
      const command = `git reset --hard ${objectId}`;

      if (length < 40) {
        const { request } = projectAskToolPermission('Bash', { command: nonGitCommand });
        assert.deepEqual(request.prompt.review, {
          kind: 'command',
          command: nonGitCommand,
          cwd: '/workspace',
        });
      } else {
        assert.throws(
          () => projectAskToolPermission('Bash', { command: nonGitCommand }),
          InteractionPermissionProjectionError,
        );
      }

      if (length === 39 || length === 40 || length === 64) {
        const { request } = projectAskToolPermission('Bash', { command });
        assert.equal(request.prompt.category, 'git_destructive');
        assert.deepEqual(request.prompt.review, {
          kind: 'command',
          command,
          cwd: '/workspace',
        });
      } else {
        assert.throws(
          () => projectAskToolPermission('Bash', { command }),
          InteractionPermissionProjectionError,
        );
      }
    }

    assert.throws(
      () =>
        projectAskToolPermission('browser_navigate', {
          url: `https://example.test/${'b'.repeat(41)}`,
        }),
      InteractionPermissionProjectionError,
    );
  });

  test('fails closed for provider tokens and incomplete shell secret syntax', () => {
    for (const command of [
      'echo ghp_abcdefghijklmnopqrstuvwxyz',
      'echo token=$(printf opaque-substitution); rm file.txt',
      'echo `printf token=opaque-secret`; rm file.txt',
    ]) {
      assert.throws(
        () => projectAskToolPermission('Bash', { command }),
        InteractionPermissionProjectionError,
        command,
      );
    }
  });

  test('canonically escapes unsafe display characters without conflating literal escapes', () => {
    const unsafe = projectAskToolPermission('Bash', { command: "printf 'a\u00A0b'" }).request;
    const literal = projectAskToolPermission('Bash', {
      command: String.raw`printf 'a\u{00A0}b'`,
    }).request;
    assert.equal(unsafe.prompt.review.kind, 'command');
    assert.equal(literal.prompt.review.kind, 'command');
    if (unsafe.prompt.review.kind !== 'command' || literal.prompt.review.kind !== 'command') return;

    assert.equal(unsafe.prompt.review.command, String.raw`printf 'a\u{00A0}b'`);
    assert.equal(literal.prompt.review.command, String.raw`printf 'a\\u{00A0}b'`);
    assert.notEqual(unsafe.prompt.review.command, literal.prompt.review.command);
    assert.throws(() =>
      decodeInteractionRequest({
        ...unsafe,
        prompt: {
          ...unsafe.prompt,
          review: { ...unsafe.prompt.review, command: "printf 'a\u00A0b'" },
        },
      }),
    );
  });
});

describe('additional and sandbox permission Interaction', () => {
  test('round-trips safe additional-permission risk without profile or justification', () => {
    const review = projectAdditionalPermissionReview({
      cwd: '/workspace',
      profile: {
        fileSystem: {
          entries: [{ path: '/tmp/output', access: 'write', scope: 'subtree' }],
        },
        network: { enabled: true },
      },
    });
    const payload: AdditionalPermissionRequest = {
      kind: 'additional_permissions',
      requestId: 'request-additional',
      toolUseId: 'tool-write',
      toolName: 'Write',
      category: 'file_write',
      reason: 'additional_permissions',
      review,
      risk: {
        outsideWorkspace: true,
        protectedMetadata: false,
        networkEnabled: true,
      },
      alsoApprovesToolExecution: false,
      availableDecisions: ['allow_once', 'deny'],
    };
    const request = projectInteractionPermissionRequest(payload);

    assert.deepEqual(decodeInteractionRequest(JSON.parse(JSON.stringify(request))), request);
    assert.deepEqual(request.prompt, {
      kind: 'additional_permissions',
      toolName: 'Write',
      category: 'file_write',
      reason: 'additional_permissions',
      review,
      risk: payload.risk,
      alsoApprovesToolExecution: false,
      availableDecisions: ['allow_once', 'deny'],
    });
    for (const extra of [{ profile: payload }, { justification: 'private rationale' }]) {
      assert.throws(() =>
        decodeInteractionRequest({
          ...request,
          prompt: { ...request.prompt, ...extra },
        }),
      );
    }
  });

  test('binds additional category and network risk to the public review', () => {
    const base: AdditionalPermissionRequest = {
      kind: 'additional_permissions',
      requestId: 'request-additional',
      toolUseId: 'tool-read',
      toolName: 'Read',
      category: 'read',
      reason: 'additional_permissions',
      review: projectAdditionalPermissionReview({
        cwd: '/workspace',
        profile: { network: { enabled: true } },
      }),
      risk: {
        outsideWorkspace: false,
        protectedMetadata: false,
        networkEnabled: true,
      },
      alsoApprovesToolExecution: false,
      availableDecisions: ['allow_once', 'deny'],
    };

    assert.doesNotThrow(() => projectInteractionPermissionRequest(base));
    assert.throws(() => projectInteractionPermissionRequest({ ...base, category: 'file_write' }));
    assert.throws(() =>
      projectInteractionPermissionRequest({
        ...base,
        risk: { ...base.risk, networkEnabled: false },
      }),
    );
    assert.throws(() =>
      projectInteractionPermissionRequest({
        ...base,
        alsoApprovesToolExecution: true,
      } as unknown as AdditionalPermissionRequest),
    );

    let decisionReads = 0;
    const accessorDecisions = ['allow_once', 'deny'];
    Object.defineProperty(accessorDecisions, '0', {
      enumerable: true,
      get() {
        decisionReads += 1;
        return 'allow_once';
      },
    });
    assert.throws(() =>
      projectInteractionPermissionRequest({
        ...base,
        availableDecisions: accessorDecisions,
      } as unknown as AdditionalPermissionRequest),
    );
    assert.equal(decisionReads, 0);
  });

  test('binds sandbox escalation to the same safe Bash command review', () => {
    const intent = createCanonicalToolIntent({
      toolName: 'Bash',
      cwd: '/workspace',
      args: { command: 'echo token=opaque-secret; rm file.txt' },
    });
    const review = projectPublicToolApprovalReview(intent);
    assert.equal(review.kind, 'command');
    if (review.kind !== 'command') return;
    const payload: SandboxEscalationRequest = {
      kind: 'sandbox_escalation',
      requestId: 'request-sandbox',
      toolUseId: 'tool-bash',
      toolName: 'Bash',
      category: intent.category,
      reason: 'sandbox_escalation',
      review,
      trigger: 'sandbox_denial',
      risk: {
        unsandboxedExecution: true,
        unrestrictedFileSystem: true,
        unrestrictedNetwork: true,
        protectedMetadataExposed: true,
      },
      alsoApprovesToolExecution: true,
      availableDecisions: ['allow_once', 'deny'],
    };
    const request = projectInteractionPermissionRequest(payload);

    assert.equal(request.prompt.kind, 'sandbox_escalation');
    assert.deepEqual(decodeInteractionRequest(JSON.parse(JSON.stringify(request))), request);
    assert.throws(() =>
      projectInteractionPermissionRequest({
        ...payload,
        category: 'shell_unsafe',
      }),
    );
    assert.throws(() =>
      projectInteractionPermissionRequest({
        ...payload,
        risk: { ...payload.risk, unrestrictedNetwork: false as true },
      }),
    );
  });
});

describe('Interaction answers and outcomes', () => {
  const permission = projectAskToolPermission('Write', {
    path: 'a.txt',
    content: 'private',
  }).request;
  const question = projectInteractionQuestionRequest({
    toolUseId: 'tool-question',
    questions: [
      {
        question: 'Is sk-abcdefghijklmnop the value you meant?',
        options: [{ label: 'Yes', description: 'Use the selected value' }, { label: 'No' }],
      },
    ],
  });

  test('round-trips bounded questions and validates answer arity', () => {
    assert.deepEqual(decodeInteractionRequest(JSON.parse(JSON.stringify(question))), question);
    const answer = decodeInteractionAnswer({
      kind: 'question',
      answers: ['Yes'],
    });
    assert.equal(isInteractionAnswerValidForRequest(question, answer), true);
    assert.equal(
      isInteractionAnswerValidForRequest(question, {
        kind: 'question',
        answers: ['Yes', 'No'],
      }),
      false,
    );
  });

  test('allows remember only for eligible tool permission approvals', () => {
    const allowed = decodeInteractionAnswer({
      kind: 'permission',
      decision: 'allow',
      rememberForTurn: true,
    });
    assert.equal(isInteractionAnswerValidForRequest(permission, allowed), true);
    assert.throws(() =>
      decodeInteractionAnswer({
        kind: 'permission',
        decision: 'deny',
        rememberForTurn: true,
      }),
    );
  });

  test('canonical outcome excludes rationale and equivalence uses execution semantics', () => {
    const first = decodeInteractionCanonicalOutcome({
      kind: 'permission_answer',
      decision: 'allow',
      rememberForTurn: false,
      reviewer: 'user',
      riskLevel: 'high',
      committedAt: 1,
    });
    const retry = decodeInteractionCanonicalOutcome({
      kind: 'permission_answer',
      decision: 'allow',
      rememberForTurn: false,
      reviewer: 'auto_review',
      riskLevel: 'low',
      committedAt: 2,
    });
    assert.equal(interactionCanonicalOutcomesEquivalent(first, retry), true);
    assert.throws(() =>
      decodeInteractionCanonicalOutcome({
        kind: 'permission_answer',
        decision: 'allow',
        rememberForTurn: false,
        reviewer: 'user',
        rationale: 'private reviewer rationale',
        committedAt: 1,
      }),
    );
  });

  test('timed_out closes permissions but not questions', () => {
    const outcome = decodeInteractionCanonicalOutcome({
      kind: 'closure',
      reason: 'timed_out',
      committedAt: 1,
    });
    assert.equal(isInteractionCanonicalOutcomeValidForRequest(permission, outcome), true);
    assert.equal(isInteractionCanonicalOutcomeValidForRequest(question, outcome), false);
  });

  test('request identity and total serialized size are bounded', () => {
    assert.throws(() =>
      projectInteractionPermissionRequest({
        ...projectAskToolPermission('Write', { path: 'a.txt', content: 'x' }).payload,
        requestId: '',
      }),
    );
    const oversized: InteractionRequest = {
      kind: 'question',
      toolUseId: 'tool-question',
      questions: Array.from({ length: 3 }, () => ({
        question: '\\'.repeat(1024),
        options: Array.from({ length: 3 }, () => ({
          label: '\\'.repeat(256),
          description: '\\'.repeat(512),
        })),
      })),
    };
    assert.throws(() => decodeInteractionRequest(oversized));

    const intent = createCanonicalToolIntent({
      toolName: 'Bash',
      args: { command: 'x'.repeat(8 * 1024) },
      cwd: '/'.repeat(4 * 1024),
    });
    const verdict = preToolUse({
      intent,
      mode: 'ask',
      turnMemory: new TurnPermissionMemory(),
    });
    assert.equal(verdict.kind, 'prompt');
    if (verdict.kind !== 'prompt') throw new Error('Expected permission prompt');
    assert.throws(
      () =>
        projectInteractionPermissionRequest({
          requestId: 'request-oversized',
          toolUseId: 'tool-oversized',
          ...verdict.prompt,
        }),
      InteractionPermissionProjectionError,
    );

    const valid = projectAskToolPermission('Write', { path: 'a.txt', content: 'x' }).payload;
    assert.throws(
      () =>
        projectInteractionPermissionRequest({
          ...valid,
          category: 'not-a-category',
        } as unknown as PermissionRequest),
      (error: unknown) =>
        error instanceof Error && !(error instanceof InteractionPermissionProjectionError),
    );
  });
});
