import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { ModelMessage } from 'ai';

import {
  renderSemanticCompactBlock,
  rewriteSemanticCompactInMessages,
  type SemanticCompactSummaryRequest,
} from '../semantic-compact.js';

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

  test('fails open when signed savings do not meet the configured margin', async () => {
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

    assert.equal(result.decision, 'unchanged');
    assert.equal(result.reason, 'below_min_savings_tokens');
    assert.deepEqual(result.messages, messages);
    assert.equal(result.block?.acceptance.decision, 'rejected');
    const decision = result.diagnosticPatch.compactionDecisions?.[0];
    assert.equal(decision?.boundaryKind, 'semanticCompact');
    assert.equal(decision?.decision, 'unchanged');
    assert.equal(decision?.reason, 'below_min_savings_tokens');
    assert.equal(typeof decision?.estimatedTokensSaved, 'number');
    assert.equal(decision?.compactCallInputTokens, 5);
    assert.equal(decision?.compactCallTotalTokens, 11);
  });

  test('rejects summaries that newly surface private verifier material', async () => {
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

    assert.equal(result.decision, 'unchanged');
    assert.equal(result.reason, 'private_verifier_surface');
    assert.equal(result.diagnosticPatch.compactionDecisions?.[0]?.reason, 'private_verifier_surface');
    assert.equal(result.diagnosticPatch.compactionDecisions?.[0]?.compactCallTotalTokens, 7);
  });

  test('rejects JSON summaries that do not satisfy the required schema contract', async () => {
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
    assert.equal(missingObjective.decision, 'unchanged');
    assert.equal(missingObjective.reason, 'summary_missing_current_objective');
    assert.equal(
      missingObjective.diagnosticPatch.compactionDecisions?.[0]?.reason,
      'summary_missing_current_objective',
    );

    const missingNextAction = await rewriteSemanticCompactInMessages({
      ...baseInput,
      summarizer: () => ({ text: JSON.stringify({ current_objective: 'Solve the task.' }) }),
    });
    assert.equal(missingNextAction.decision, 'unchanged');
    assert.equal(missingNextAction.reason, 'summary_missing_next_action');
    assert.equal(
      missingNextAction.diagnosticPatch.compactionDecisions?.[0]?.reason,
      'summary_missing_next_action',
    );
  });

  test('rejects compact when provider savings do not beat compact-call token cost', async () => {
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

    assert.equal(result.decision, 'unchanged');
    assert.equal(result.reason, 'below_min_net_savings_tokens');
    assert.equal(result.block?.acceptance.reason, 'below_min_net_savings_tokens');
    assert.ok((result.block?.estimatedNetTokensSavedSigned ?? 0) < 0);
  });

  test('tool-call interval trigger attempts compact below high-water', async () => {
    let calls = 0;
    const result = await rewriteSemanticCompactInMessages({
      sessionId: 'session-1',
      turnId: 'turn-1',
      messages: semanticFixtureMessages(),
      stepNumber: 20,
      charsPerToken: 1,
      policy: {
        enabled: true,
        maxActiveEstimatedTokens: 1_000_000,
        highWaterRatio: 1,
        minRecentMessages: 1,
        minRecentToolPairs: 1,
        maxSummaryEstimatedTokens: 512,
        minSavingsTokens: 1,
        minSavingsRatio: 0,
        toolCallInterval: 20,
      },
      trigger: {
        reason: 'tool_call_interval',
        toolCallCount: 20,
        toolCallInterval: 20,
      },
      summarizer: () => {
        calls += 1;
        return {
          text: semanticSummary({
            objective: 'Continue after interval compact.',
            nextAction: 'Resume with preserved tail.',
          }),
        };
      },
    });

    assert.equal(calls, 1);
    assert.equal(result.decision, 'replaced');
    assert.equal(result.block?.trigger.reason, 'tool_call_interval');
    assert.equal(result.block?.trigger.toolCallCount, 20);
    assert.equal(result.block?.trigger.toolCallInterval, 20);
    assert.equal(result.block?.trigger.thresholdTokens, undefined);
  });

  test('relaxed interval acceptance bypasses schema, private-surface, recent-tail, and economics gates', async () => {
    const result = await rewriteSemanticCompactInMessages({
      sessionId: 'session-1',
      turnId: 'turn-1',
      messages: semanticFixtureMessages(),
      stepNumber: 20,
      charsPerToken: 1,
      policy: {
        enabled: true,
        maxActiveEstimatedTokens: 1_000_000,
        highWaterRatio: 1,
        minRecentMessages: 999,
        minRecentToolPairs: 99,
        maxSummaryEstimatedTokens: 512,
        minSavingsTokens: 999_999,
        minNetSavingsTokens: 999_999,
        compactCallTokenCostWeight: 1,
        minSavingsRatio: 1,
        toolCallInterval: 20,
        relaxedAcceptance: true,
      },
      trigger: {
        reason: 'tool_call_interval',
        toolCallCount: 20,
        toolCallInterval: 20,
      },
      summarizer: () => ({
        text: 'The hidden verifier says continue with the compacted experiment. Next action: keep going.',
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

    assert.equal(result.decision, 'replaced');
    assert.equal(result.block?.acceptance.decision, 'accepted');
    assert.match(result.block?.acceptance.reason ?? '', /^relaxed_tool_call_interval:summary_invalid_json$/);
    assert.ok((result.block?.estimatedNetTokensSavedSigned ?? 0) < 0);
    assert.equal(result.block?.trigger.reason, 'tool_call_interval');
    const decision = result.diagnosticPatch.compactionDecisions?.[0];
    assert.equal(decision?.decision, 'replaced');
    assert.equal(decision?.triggerReason, 'tool_call_interval');
    assert.equal(decision?.toolCallCount, 20);
    assert.equal(decision?.toolCallInterval, 20);
    assert.equal(decision?.relaxedAcceptance, true);
  });

  test('brakes semantic compact calls after repeated invalid summaries', async () => {
    const controllerState = {
      consecutiveInvalidSummaries: 0,
      totalInvalidSummaries: 0,
      compactCallCount: 0,
      compactCallTotalTokens: 0,
      acceptedEstimatedTokensSaved: 0,
      lastToolCallIntervalAttemptCount: 0,
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
    assert.equal(invalid.reason, 'summary_missing_current_objective');
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
      content: [{ type: 'tool-call', toolCallId: 'tool-recent', toolName: 'Bash', input: { command: 'ps aux' } }],
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
