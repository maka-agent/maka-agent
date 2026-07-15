import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { ModelMessage } from 'ai';

import {
  renderSemanticCompactBlock,
  rewriteSemanticCompactInMessages,
  validateSemanticCompactBlockForSourceIndex,
  validateSemanticCompactReplacementShape,
  type SemanticCompactSummaryRequest,
} from '../semantic-compact.js';
import { buildActiveFullCompactSourceIndex } from '../active-full-compact.js';

describe('semantic compact', () => {
  test('replaces an older span with a no-tools LLM summary and preserves recent tool pairs', async () => {
    let requestSeen: SemanticCompactSummaryRequest | undefined;
    const messages = semanticFixtureMessages();

    const result = await rewriteSemanticCompactInMessages({
      sessionId: 'session-1',
      turnId: 'turn-1',
      messages,
      stepNumber: 2,
      charsPerToken: 1,
      policy: {
        enabled: true,
        maxActiveEstimatedTokens: 1,
        highWaterRatio: 0.1,
        minRecentMessages: 1,
        minRecentToolPairs: 1,
        maxSummaryEstimatedTokens: 1024,
        minSavingsTokens: 1,
        minSavingsRatio: 0,
      },
      requestShapeHashForMessages: (stepMessages) => `shape:${stepMessages.length}:${JSON.stringify(stepMessages).length}`,
      summarizer: (request) => {
        requestSeen = request;
        assert.equal('tools' in request, false);
        assert.equal('toolChoice' in request, false);
        assert.equal('prepareStep' in request, false);
        assert.doesNotMatch(JSON.stringify(request.messages), /recent-result/);
        assert.match(JSON.stringify(request.messages), /Return ONLY a valid JSON object/);
        assert.doesNotMatch(JSON.stringify(request.messages), /source_manifest/);
        return {
          text: semanticSummary({
            objective: 'Solve the task while keeping the service running.',
            nextAction: 'Continue from the preserved recent tool result.',
            commands: ['Earlier output showed a large build log.'],
          }),
          usage: {
            inputTokens: 10,
            outputTokens: 12,
            cacheHitInputTokens: 0,
            cacheMissInputTokens: 10,
            cacheMissInputSource: 'explicit',
            cacheWriteInputTokens: 0,
            reasoningTokens: 0,
            totalTokens: 22,
            cachedInputTokens: 0,
          },
          finishReason: 'stop',
        };
      },
    });

    assert.equal(result.decision, 'replaced');
    assert.ok(requestSeen, 'expected injected summarizer to be called');
    assert.equal(requestSeen.maxOutputTokens, 4096);
    assert.equal(result.block?.kind, 'maka.semantic_compact_block');
    assert.equal(result.block?.acceptance.decision, 'accepted');
    assert.ok((result.block?.estimatedTokensSavedSigned ?? 0) > 0);
    assert.deepEqual(result.block?.preservedTail.toolCallIds, ['tool-recent']);
    assert.equal(result.messages.some((message) =>
      message.role === 'user' && JSON.stringify(message.content).includes('maka_semantic_compact_block')
    ), true);
    assert.equal(result.messages.some((message) =>
      message.role === 'assistant' && JSON.stringify(message.content).includes('tool-recent')
    ), true);
    assert.equal(result.messages.some((message) =>
      message.role === 'tool' && JSON.stringify(message.content).includes('recent-result')
    ), true);

    const decisions = result.diagnosticPatch.compactionDecisions ?? [];
    assert.equal(decisions[0]?.boundaryKind, 'semanticCompact');
    assert.equal(decisions[0]?.decision, 'replaced');
    assert.equal(decisions[0]?.compactCallInputTokens, 10);
    assert.equal(decisions[0]?.compactCallOutputTokens, 12);
    assert.equal(decisions[0]?.compactCallTotalTokens, 22);
    assert.equal(typeof result.diagnosticPatch.highWaterRequestShapeHashBefore, 'string');
    assert.equal(typeof result.diagnosticPatch.highWaterRequestShapeHashAfter, 'string');
  });

  test('fails open and retains original messages when signed savings do not meet the configured margin', async () => {
    const messages = semanticFixtureMessages();
    const result = await rewriteSemanticCompactInMessages({
      sessionId: 'session-1',
      turnId: 'turn-1',
      messages,
      stepNumber: 2,
      charsPerToken: 1,
      policy: {
        enabled: true,
        maxActiveEstimatedTokens: 1,
        highWaterRatio: 0.1,
        minRecentMessages: 1,
        minRecentToolPairs: 1,
        maxSummaryEstimatedTokens: 512,
        minSavingsTokens: 50_000,
        minSavingsRatio: 0,
      },
      summarizer: () => ({
        text: semanticSummary({
          objective: 'Solve the task.',
          nextAction: 'Continue from preserved context.',
        }),
        usage: {
          inputTokens: 5,
          outputTokens: 6,
          cacheHitInputTokens: 0,
          cacheMissInputTokens: 5,
          cacheMissInputSource: 'explicit',
          cacheWriteInputTokens: 0,
          reasoningTokens: 0,
          totalTokens: 11,
          cachedInputTokens: 0,
        },
      }),
    });

    assert.equal(result.decision, 'failedOpen');
    assert.equal(result.reason, 'below_min_savings_tokens');
    assert.deepEqual(result.messages, messages);
    assert.equal(result.block?.acceptance.decision, 'rejected');
    assert.equal(result.block?.acceptance.reason, 'below_min_savings_tokens');
    assert.deepEqual(result.failure, {
      kind: 'maka.semantic_compact_failure',
      stage: 'economics',
      reason: 'below_min_savings_tokens',
      reasons: ['below_min_savings_tokens'],
      retryable: false,
    });
    const decision = result.diagnosticPatch.compactionDecisions?.[0];
    assert.equal(decision?.boundaryKind, 'semanticCompact');
    assert.equal(decision?.decision, 'failedOpen');
    assert.equal(decision?.reason, 'below_min_savings_tokens');
    assert.equal(decision?.failOpenReason, 'below_min_savings_tokens');
    assert.deepEqual(decision?.skippedReasonCounts, { below_min_savings_tokens: 1 });
    assert.equal(typeof decision?.estimatedTokensSaved, 'number');
    assert.equal(decision?.compactCallInputTokens, 5);
    assert.equal(decision?.compactCallTotalTokens, 11);
  });

  test('fails open when summaries newly surface private verifier material', async () => {
    const result = await rewriteSemanticCompactInMessages({
      sessionId: 'session-1',
      turnId: 'turn-1',
      messages: semanticFixtureMessages(),
      stepNumber: 2,
      charsPerToken: 1,
      policy: {
        enabled: true,
        maxActiveEstimatedTokens: 1,
        highWaterRatio: 0.1,
        minRecentMessages: 1,
        maxSummaryEstimatedTokens: 512,
        minSavingsTokens: 1,
        minSavingsRatio: 0,
      },
      summarizer: () => ({
        text: semanticSummary({
          objective: 'The hidden verifier says this will pass.',
          nextAction: 'Continue.',
        }),
        usage: {
          inputTokens: 3,
          outputTokens: 4,
          cacheHitInputTokens: 0,
          cacheMissInputTokens: 3,
          cacheMissInputSource: 'explicit',
          cacheWriteInputTokens: 0,
          reasoningTokens: 0,
          totalTokens: 7,
          cachedInputTokens: 0,
        },
      }),
    });

    assert.equal(result.decision, 'failedOpen');
    assert.equal(result.block?.acceptance.decision, 'rejected');
    assert.equal(result.block?.acceptance.reason, 'private_verifier_surface');
    assert.equal(result.diagnosticPatch.compactionDecisions?.[0]?.reason, 'private_verifier_surface');
    assert.deepEqual(result.diagnosticPatch.compactionDecisions?.[0]?.skippedReasonCounts, {
      private_verifier_surface: 1,
    });
    assert.equal(result.diagnosticPatch.compactionDecisions?.[0]?.compactCallTotalTokens, 7);
  });

  test('fails open when JSON summaries do not satisfy the schema contract', async () => {
    const baseInput = {
      sessionId: 'session-1',
      turnId: 'turn-1',
      messages: semanticFixtureMessages(),
      stepNumber: 2,
      charsPerToken: 1,
      policy: {
        enabled: true,
        maxActiveEstimatedTokens: 1,
        highWaterRatio: 0.1,
        minRecentMessages: 1,
        maxSummaryEstimatedTokens: 512,
        minSavingsTokens: 1,
        minSavingsRatio: 0,
      },
    } as const;

    const missingObjective = await rewriteSemanticCompactInMessages({
      ...baseInput,
      summarizer: () => ({ text: JSON.stringify({ next_action: 'Continue from preserved context.' }) }),
    });
    assert.equal(missingObjective.decision, 'failedOpen');
    assert.deepEqual(missingObjective.messages, baseInput.messages);
    assert.equal(missingObjective.failure?.stage, 'summary');
    assert.equal(missingObjective.failure?.reason, 'summary_missing_current_objective');
    assert.equal(
      missingObjective.diagnosticPatch.compactionDecisions?.[0]?.reason,
      'summary_missing_current_objective',
    );

    const missingNextAction = await rewriteSemanticCompactInMessages({
      ...baseInput,
      summarizer: () => ({ text: JSON.stringify({ current_objective: 'Solve the task.' }) }),
    });
    assert.equal(missingNextAction.decision, 'failedOpen');
    assert.deepEqual(missingNextAction.messages, baseInput.messages);
    assert.equal(missingNextAction.failure?.stage, 'summary');
    assert.equal(missingNextAction.failure?.reason, 'summary_missing_next_action');
    assert.equal(
      missingNextAction.diagnosticPatch.compactionDecisions?.[0]?.reason,
      'summary_missing_next_action',
    );
    assert.equal(missingNextAction.block, undefined);
  });

  test('does not reject valid summaries just because they exceed the soft summary target', async () => {
    const result = await rewriteSemanticCompactInMessages({
      sessionId: 'session-1',
      turnId: 'turn-1',
      messages: semanticFixtureMessages(),
      stepNumber: 2,
      charsPerToken: 1,
      policy: {
        enabled: true,
        maxActiveEstimatedTokens: 1,
        highWaterRatio: 0.1,
        minRecentMessages: 1,
        maxSummaryEstimatedTokens: 1,
        minSavingsTokens: 1,
        minSavingsRatio: 0,
      },
      summarizer: () => ({
        text: semanticSummary({
          objective: 'Continue after compact with complete continuity state.',
          nextAction: 'Resume with the preserved recent tool result.',
          commands: ['Earlier output showed a large build log that does not need to remain verbatim.'],
        }),
      }),
    });

    assert.equal(result.decision, 'replaced');
    assert.equal(result.block?.acceptance.decision, 'accepted');
    assert.notEqual(result.reason, 'summary_too_large');
  });

  test('fails open when provider savings do not beat compact-call token cost', async () => {
    const result = await rewriteSemanticCompactInMessages({
      sessionId: 'session-1',
      turnId: 'turn-1',
      messages: semanticFixtureMessages(),
      stepNumber: 2,
      charsPerToken: 1,
      policy: {
        enabled: true,
        maxActiveEstimatedTokens: 1,
        highWaterRatio: 0.1,
        minRecentMessages: 1,
        maxSummaryEstimatedTokens: 512,
        minSavingsTokens: 1,
        minNetSavingsTokens: 1,
        compactCallTokenCostWeight: 1,
        minSavingsRatio: 0,
      },
      summarizer: () => ({
        text: semanticSummary({
          objective: 'Continue after compact.',
          nextAction: 'Resume with preserved tail.',
        }),
        usage: {
          inputTokens: 999_999,
          outputTokens: 1,
          cacheHitInputTokens: 0,
          cacheMissInputTokens: 999_999,
          cacheMissInputSource: 'explicit',
          cacheWriteInputTokens: 0,
          reasoningTokens: 0,
          totalTokens: 1_000_000,
          cachedInputTokens: 0,
        },
      }),
    });

    assert.equal(result.decision, 'failedOpen');
    assert.equal(result.block?.acceptance.decision, 'rejected');
    assert.equal(result.block?.acceptance.reason, 'non_positive_net_savings');
    assert.equal(result.diagnosticPatch.compactionDecisions?.[0]?.reason, 'non_positive_net_savings');
    assert.ok((result.block?.estimatedNetTokensSavedSigned ?? 0) < 0);
  });

  test('fails open on zero or negative provider savings even when configured thresholds are zero', async () => {
    const messages = [
      { role: 'user', content: 'old' } as ModelMessage,
      { role: 'user', content: 'current' } as ModelMessage,
    ];
    const result = await rewriteSemanticCompactInMessages({
      sessionId: 'session-1',
      turnId: 'turn-1',
      messages,
      stepNumber: 2,
      charsPerToken: 1,
      policy: {
        enabled: true,
        maxActiveEstimatedTokens: 1,
        highWaterRatio: 0.1,
        minRecentMessages: 1,
        minSavingsTokens: 0,
        minSavingsRatio: 0,
        minNetSavingsTokens: 0,
        compactCallTokenCostWeight: 0,
      },
      summarizer: () => ({
        text: semanticSummary({ objective: 'Continue.', nextAction: 'Keep the current user message.' }),
      }),
    });

    assert.equal(result.decision, 'failedOpen');
    assert.deepEqual(result.messages, messages);
    assert.equal(result.failure?.stage, 'economics');
    assert.equal(result.failure?.reason, 'non_positive_savings');
    assert.ok((result.block?.estimatedTokensSavedSigned ?? 1) <= 0);
  });

  test('brakes semantic compact calls after malformed summaries', async () => {
    const controllerState = {
      consecutiveInvalidSummaries: 0,
      totalInvalidSummaries: 0,
      compactCallCount: 0,
      compactCallTotalTokens: 0,
      acceptedEstimatedTokensSaved: 0,
    };
    let calls = 0;
    const policy = {
      enabled: true,
      maxActiveEstimatedTokens: 1,
      highWaterRatio: 0.1,
      minRecentMessages: 1,
      maxSummaryEstimatedTokens: 512,
      minSavingsTokens: 1,
      minSavingsRatio: 0,
      maxConsecutiveInvalidSummaries: 1,
      invalidSummaryCooldownSteps: 3,
    } as const;

    const invalid = await rewriteSemanticCompactInMessages({
      sessionId: 'session-1',
      turnId: 'turn-1',
      messages: semanticFixtureMessages(),
      stepNumber: 2,
      charsPerToken: 1,
      policy,
      controllerState,
      summarizer: () => {
        calls += 1;
        return { text: JSON.stringify({ next_action: 'Continue.' }) };
      },
    });
    assert.equal(invalid.decision, 'failedOpen');
    assert.equal(invalid.failure?.reason, 'summary_missing_current_objective');
    assert.equal(calls, 1);
    assert.equal(controllerState.consecutiveInvalidSummaries, 1);

    const cooled = await rewriteSemanticCompactInMessages({
      sessionId: 'session-1',
      turnId: 'turn-1',
      messages: semanticFixtureMessages(),
      stepNumber: 3,
      charsPerToken: 1,
      policy,
      controllerState,
      summarizer: () => {
        calls += 1;
        return { text: semanticSummary({ objective: 'Should not run.', nextAction: 'Should not run.' }) };
      },
    });
    assert.equal(cooled.decision, 'unchanged');
    assert.equal(cooled.reason, 'semantic_compact_cooldown');
    assert.equal(calls, 1);

    const resumed = await rewriteSemanticCompactInMessages({
      sessionId: 'session-1',
      turnId: 'turn-1',
      messages: semanticFixtureMessages(),
      stepNumber: 6,
      charsPerToken: 1,
      policy,
      controllerState,
      summarizer: () => {
        calls += 1;
        return { text: semanticSummary({ objective: 'Runs after cooldown.', nextAction: 'Continue.' }) };
      },
    });
    assert.notEqual(resumed.reason, 'semantic_compact_cooldown');
    assert.equal(calls, 2);
  });

  test('brakes semantic compact calls after repeated summarizer failures', async () => {
    const controllerState = {
      consecutiveInvalidSummaries: 0,
      totalInvalidSummaries: 0,
      compactCallCount: 0,
      compactCallTotalTokens: 0,
      acceptedEstimatedTokensSaved: 0,
    };
    let calls = 0;
    const policy = {
      enabled: true,
      maxActiveEstimatedTokens: 1,
      highWaterRatio: 0.1,
      minRecentMessages: 1,
      maxSummaryEstimatedTokens: 512,
      minSavingsTokens: 1,
      minSavingsRatio: 0,
      maxConsecutiveInvalidSummaries: 1,
      invalidSummaryCooldownSteps: 3,
    } as const;

    const failed = await rewriteSemanticCompactInMessages({
      sessionId: 'session-1',
      turnId: 'turn-1',
      messages: semanticFixtureMessages(),
      stepNumber: 2,
      charsPerToken: 1,
      policy,
      controllerState,
      summarizer: () => {
        calls += 1;
        throw new Error('boom');
      },
    });
    assert.equal(failed.reason, 'summarizer_failed');
    assert.equal(failed.decision, 'failedOpen');
    assert.equal(failed.failure?.stage, 'summarizer');
    assert.equal(failed.failure?.retryable, true);
    assert.equal(controllerState.consecutiveInvalidSummaries, 1);

    const cooled = await rewriteSemanticCompactInMessages({
      sessionId: 'session-1',
      turnId: 'turn-1',
      messages: semanticFixtureMessages(),
      stepNumber: 3,
      charsPerToken: 1,
      policy,
      controllerState,
      summarizer: () => {
        calls += 1;
        return { text: semanticSummary({ objective: 'Should not run.', nextAction: 'Should not run.' }) };
      },
    });
    assert.equal(cooled.decision, 'unchanged');
    assert.equal(cooled.reason, 'semantic_compact_cooldown');
    assert.equal(calls, 1);
  });

  test('times out a summarizer that ignores abort and reports a typed failure', async () => {
    const messages = semanticFixtureMessages();
    const result = await rewriteSemanticCompactInMessages({
      sessionId: 'session-1',
      turnId: 'turn-1',
      messages,
      stepNumber: 2,
      charsPerToken: 1,
      policy: {
        enabled: true,
        maxActiveEstimatedTokens: 1,
        highWaterRatio: 0.1,
        minRecentMessages: 1,
        minSavingsTokens: 1,
        minSavingsRatio: 0,
        timeoutMs: 5,
      },
      summarizer: () => new Promise<never>(() => {}),
    });

    assert.equal(result.decision, 'failedOpen');
    assert.deepEqual(result.messages, messages);
    assert.equal(result.reason, 'summarizer_timeout');
    assert.deepEqual(result.failure, {
      kind: 'maka.semantic_compact_failure',
      stage: 'summarizer',
      reason: 'summarizer_timeout',
      reasons: ['summarizer_timeout'],
      retryable: true,
    });
    assert.equal(result.diagnosticPatch.compactionDecisions?.[0]?.decision, 'failedOpen');
    assert.equal(result.diagnosticPatch.compactionDecisions?.[0]?.failOpenReason, 'summarizer_timeout');
  });

  test('requires every covered source ref before a semantic compact block is replaceable', async () => {
    const messages = semanticFixtureMessages();
    const result = await rewriteSemanticCompactInMessages({
      sessionId: 'session-1',
      turnId: 'turn-1',
      messages,
      stepNumber: 2,
      charsPerToken: 1,
      policy: {
        enabled: true,
        maxActiveEstimatedTokens: 1,
        highWaterRatio: 0.1,
        minRecentMessages: 1,
        minRecentToolPairs: 1,
        minSavingsTokens: 1,
        minSavingsRatio: 0,
      },
      summarizer: () => ({
        text: semanticSummary({ objective: 'Continue safely.', nextAction: 'Use the preserved tail.' }),
      }),
    });
    assert.equal(result.decision, 'replaced');
    const index = buildActiveFullCompactSourceIndex({
      sessionId: 'session-1',
      turnId: 'turn-1',
      messages,
      stepNumber: 2,
      charsPerToken: 1,
    });
    const invalidBlock = { ...result.block!, sourceRefs: [] };

    const validation = validateSemanticCompactBlockForSourceIndex(invalidBlock, index, {
      requiredSourceIds: result.block!.coverage.providerMessageSourceIds,
      charsPerToken: 1,
    });

    assert.equal(validation.valid, false);
    assert.equal(validation.reasons.includes('source_refs_missing'), true);
  });

  test('validates current-user, tool-pair, and signed-thinking preservation before replacement', async () => {
    const messages = semanticFixtureMessages();
    const result = await rewriteSemanticCompactInMessages({
      sessionId: 'session-1',
      turnId: 'turn-1',
      messages,
      stepNumber: 2,
      charsPerToken: 1,
      policy: {
        enabled: true,
        maxActiveEstimatedTokens: 1,
        highWaterRatio: 0.1,
        minRecentMessages: 1,
        minRecentToolPairs: 1,
        minSavingsTokens: 1,
        minSavingsRatio: 0,
      },
      summarizer: () => ({
        text: semanticSummary({ objective: 'Continue safely.', nextAction: 'Use the preserved tail.' }),
      }),
    });
    assert.equal(result.decision, 'replaced');
    const valid = validateSemanticCompactReplacementShape({
      originalMessages: messages,
      replacementMessages: result.messages,
      block: result.block!,
    });
    assert.equal(valid.valid, true);

    const missingToolResult = result.messages.filter((message) => message.role !== 'tool');
    const toolValidation = validateSemanticCompactReplacementShape({
      originalMessages: messages,
      replacementMessages: missingToolResult,
      block: result.block!,
    });
    assert.equal(toolValidation.valid, false);
    assert.equal(toolValidation.reasons.includes('tool_pair_split'), true);

    const missingThinking = result.messages.map((message) => {
      const content = (message as { content?: unknown }).content;
      if (message.role !== 'assistant' || !Array.isArray(content)) return message;
      return {
        ...message,
        content: content.filter((part) =>
          !(part && typeof part === 'object' && 'type' in part && part.type === 'reasoning')
        ),
      } as ModelMessage;
    });
    const thinkingValidation = validateSemanticCompactReplacementShape({
      originalMessages: messages,
      replacementMessages: missingThinking,
      block: result.block!,
    });
    assert.equal(thinkingValidation.valid, false);
    assert.equal(thinkingValidation.reasons.includes('thinking_pair_split'), true);
  });

  test('renders restoration cards and archive refs without raw source hashes as prose', async () => {
    const result = await rewriteSemanticCompactInMessages({
      sessionId: 'session-1',
      turnId: 'turn-1',
      messages: semanticFixtureMessages(),
      stepNumber: 2,
      charsPerToken: 1,
      policy: {
        enabled: true,
        maxActiveEstimatedTokens: 1,
        highWaterRatio: 0.1,
        minRecentMessages: 1,
        maxSummaryEstimatedTokens: 512,
        minSavingsTokens: 1,
        minSavingsRatio: 0,
      },
      summarizer: () => ({
        text: semanticSummary({
          objective: 'Continue after compact.',
          nextAction: 'Resume with preserved tail.',
        }),
      }),
    });

    assert.equal(result.decision, 'replaced');
    const rendered = renderSemanticCompactBlock(result.block!);
    assert.match(rendered, /maka_semantic_compact_block/);
    assert.match(rendered, /restoration_state_cards|coverage:/);
    assert.doesNotMatch(rendered, /providerSourceIds=/);
  });
});

function semanticFixtureMessages(): ModelMessage[] {
  return [
    { role: 'user', content: 'Please fix the build and keep the service running. '.repeat(80) } as ModelMessage,
    { role: 'assistant', content: 'I ran configure and saw a linker failure. '.repeat(80) } as ModelMessage,
    {
      role: 'assistant',
      content: [{ type: 'tool-call', toolCallId: 'tool-old', toolName: 'Bash', input: { command: 'make test' } }],
    } as ModelMessage,
    {
      role: 'tool',
      content: [{ type: 'tool-result', toolCallId: 'tool-old', toolName: 'Bash', result: { body: 'OLD_BUILD_LOG '.repeat(800) } }],
    } as unknown as ModelMessage,
    {
      role: 'assistant',
      content: [
        {
          type: 'reasoning',
          text: 'Check whether the service is still running.',
          providerOptions: { anthropic: { signature: 'signed-reasoning' } },
        },
        { type: 'tool-call', toolCallId: 'tool-recent', toolName: 'Bash', input: { command: 'ps aux' } },
      ],
    } as ModelMessage,
    {
      role: 'tool',
      content: [{ type: 'tool-result', toolCallId: 'tool-recent', toolName: 'Bash', result: { body: 'recent-result service still running' } }],
    } as unknown as ModelMessage,
    { role: 'user', content: 'Continue.' } as ModelMessage,
  ];
}

function semanticSummary(input: {
  objective: string;
  nextAction: string;
  commands?: string[];
}): string {
  return JSON.stringify({
    current_objective: input.objective,
    user_constraints: ['Keep task-local state and public context only.'],
    important_files_and_artifacts: [],
    commands_and_results: input.commands ?? ['No important command result.'],
    errors_and_fixes: [],
    failed_hypotheses: [],
    operational_state: ['Continue in the same session.'],
    public_verification_state: 'No verifier result claimed.',
    remaining_work: ['Continue the task.'],
    next_action: input.nextAction,
    archive_refs_to_reread_if_needed: [],
  });
}
