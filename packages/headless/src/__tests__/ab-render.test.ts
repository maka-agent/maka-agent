import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { renderAbComparisonMarkdown } from '../ab-render.js';
import { summarizeAbComparison } from '../ab-summary.js';
import {
  budgetExhausted,
  completed,
  contextBudgetSummary,
  continuationSummary,
  taskToolSummary,
  withTrace,
  withUsage,
} from './helpers/ab-summary-fixtures.js';

describe('renderAbComparisonMarkdown', () => {
  test('renders decision, budget, pass rate, and task-level delta without RSI acceptance language', () => {
    const result = summarizeAbComparison({
      runId: 'ab-run',
      roundId: 'ab-summary',
      baselineArmId: 'maka-baseline',
      candidateArmId: 'candidate',
      evaluationTaskIds: ['t1', 't2'],
      baselineRuns: [[completed('t1', false), completed('t2', false)], [completed('t1', false), completed('t2', true)]],
      candidateRuns: [[completed('t1', true), completed('t2', true)], [completed('t1', true), completed('t2', true)]],
      budgetMs: 600_000,
    });

    const markdown = renderAbComparisonMarkdown(result);

    assert.match(markdown, /Decision: B non-inferior \(non_inferiority_lower_bound_within_margin\)/);
    assert.match(markdown, /Budget: 600s task budget/);
    assert.match(markdown, /Evaluation pass rate: A=1\/4 = 0.25, B=4\/4 = 1/);
    assert.match(markdown, /Task-level delta: mean=0.75/);
    assert.doesNotMatch(markdown, /held-in|held-out|keep|discard|acceptance/i);
  });

  test('renders budget outcomes', () => {
    const result = summarizeAbComparison({
      runId: 'ab-run',
      roundId: 'ab-summary',
      baselineArmId: 'maka-baseline',
      candidateArmId: 'candidate',
      evaluationTaskIds: ['long-task'],
      baselineRuns: [[completed('long-task', true)]],
      candidateRuns: [[budgetExhausted('long-task')]],
      budgetMs: 600_000,
    });

    assert.match(renderAbComparisonMarkdown(result), /Budget outcomes: A timed_out=0, B timed_out=1/);
  });

  test('renders context budget policy and active prune subset diagnostics', () => {
    const baselineInactive = contextBudgetSummary({ prunedToolResults: 0 });
    const candidateActive = contextBudgetSummary({
      prunedToolResults: 2,
      activePrunedToolResults: 3,
      activeEstimatedTokensSaved: 450,
      activeArchiveFailures: 1,
      archivePlaceholders: 2,
      archivePlaceholderReasonCounts: { active_prune: 2 },
      retrievedArchiveToolResults: 1,
      retrievedArchiveEstimatedTokens: 120,
      archiveRetrievalSkipped: 3,
      archiveRetrievalSkippedReasonCounts: { max_bytes: 2, max_results: 1 },
      archiveRetrievalFailures: 1,
      archiveRetrievalFailureReasonCounts: { not_found: 1 },
    });
    const candidateInactive = contextBudgetSummary({ prunedToolResults: 0 });
    const result = summarizeAbComparison({
      runId: 'ab-run',
      roundId: 'ab-summary',
      baselineArmId: 'prune-off',
      candidateArmId: 'prune-on',
      evaluationTaskIds: ['t1', 't2'],
      baselineRuns: [[
        { ...completed('t1', true), contextBudgetPolicy: { enabled: false }, contextBudgetSummary: baselineInactive },
        { ...completed('t2', true), contextBudgetPolicy: { enabled: false }, contextBudgetSummary: baselineInactive },
      ]],
      candidateRuns: [[
        {
          ...completed('t1', true),
          contextBudgetPolicy: {
            enabled: true,
            name: 'harbor-cell-context-budget',
            staleToolResultPrune: { enabled: true, maxResultEstimatedTokens: 2048, minRecentTurnsFull: 2 },
            minRecentTurns: 2,
          },
          contextBudgetSummary: candidateActive,
        },
        {
          ...completed('t2', true),
          contextBudgetPolicy: {
            enabled: true,
            name: 'harbor-cell-context-budget',
            staleToolResultPrune: { enabled: true, maxResultEstimatedTokens: 2048, minRecentTurnsFull: 2 },
            minRecentTurns: 2,
          },
          contextBudgetSummary: candidateInactive,
        },
      ]],
    });

    const markdown = renderAbComparisonMarkdown(result);

    assert.match(markdown, /Context budget: A activated=0\/2 stale_pruned=0 active_pruned=0 active_tokens_saved=0 active_archive_failures=0 archive_placeholders=0 archive_placeholder_reasons=\{\} archive_write_failures=0 retrieved=0 retrieved_tokens=0 retrieval_skipped=0 retrieval_skipped_reasons=\{\} retrieval_failures=0 retrieval_failure_reasons=\{\}, B activated=1\/2 stale_pruned=2 active_pruned=3 active_tokens_saved=450 active_archive_failures=1 archive_placeholders=2 archive_placeholder_reasons=\{"active_prune":2\} archive_write_failures=0 retrieved=1 retrieved_tokens=120 retrieval_skipped=3 retrieval_skipped_reasons=\{"max_bytes":2,"max_results":1\} retrieval_failures=1 retrieval_failure_reasons=\{"not_found":1\}/);
    assert.match(markdown, /Active prune subset: A tasks=1 attempts=1 observed=1 missing=0 coverage=1 pass_rate=1 passed=1\/1 completed=1 timed_out=0 infra_failed=0 plumbing_failed=0 input=1 cache_hit=0 cache_miss=1 cache_write=0 output=1 total=2 cost_usd=0\.01 mean_duration_ms=100 activated=0\/1 stale_pruned=0 active_pruned=0 active_tokens_saved=0 active_archive_failures=0 archive_placeholders=0 archive_placeholder_reasons=\{\} archive_write_failures=0 retrieved=0 retrieved_tokens=0 retrieval_skipped=0 retrieval_skipped_reasons=\{\} retrieval_failures=0 retrieval_failure_reasons=\{\}, B tasks=1 attempts=1 observed=1 missing=0 coverage=1 pass_rate=1 passed=1\/1 completed=1 timed_out=0 infra_failed=0 plumbing_failed=0 input=1 cache_hit=0 cache_miss=1 cache_write=0 output=1 total=2 cost_usd=0\.01 mean_duration_ms=100 activated=1\/1 stale_pruned=2 active_pruned=3 active_tokens_saved=450 active_archive_failures=1 archive_placeholders=2 archive_placeholder_reasons=\{"active_prune":2\} archive_write_failures=0 retrieved=1 retrieved_tokens=120 retrieval_skipped=3 retrieval_skipped_reasons=\{"max_bytes":2,"max_results":1\} retrieval_failures=1 retrieval_failure_reasons=\{"not_found":1\}/);
    assert.match(markdown, /Context budget policy: A enabled=0\/2 snapshots=\[{"enabled":false}\], B enabled=2\/2 snapshots=/);
  });

  test('renders active prune subset pair coverage and full token cost', () => {
    const result = summarizeAbComparison({
      runId: 'ab-run',
      roundId: 'ab-summary',
      baselineArmId: 'prune-off',
      candidateArmId: 'prune-on',
      evaluationTaskIds: ['t1'],
      baselineRuns: [[]],
      candidateRuns: [[{
        ...withUsage(completed('t1', true), {
          input: 10,
          cacheHitInput: 3,
          cacheMissInput: 4,
          cacheWriteInput: 2,
          output: 5,
          reasoning: 1,
          total: 16,
          costUsd: 0.02,
          durationMs: 250,
        }),
        contextBudgetSummary: contextBudgetSummary({ activePrunedToolResults: 1 }),
      }]],
    });

    assert.match(renderAbComparisonMarkdown(result), /Active prune subset: A tasks=1 attempts=1 observed=0 missing=1 coverage=0 pass_rate=null passed=0\/0 completed=0 timed_out=0 infra_failed=0 plumbing_failed=0 input=0 cache_hit=0 cache_miss=0 cache_write=0 output=0 total=0 cost_usd=0 mean_duration_ms=null activated=0\/0 stale_pruned=0 active_pruned=0 active_tokens_saved=0 active_archive_failures=0 archive_placeholders=0 archive_placeholder_reasons=\{\} archive_write_failures=0 retrieved=0 retrieved_tokens=0 retrieval_skipped=0 retrieval_skipped_reasons=\{\} retrieval_failures=0 retrieval_failure_reasons=\{\}, B tasks=1 attempts=1 observed=1 missing=0 coverage=1 pass_rate=1 passed=1\/1 completed=1 timed_out=0 infra_failed=0 plumbing_failed=0 input=10 cache_hit=3 cache_miss=4 cache_write=2 output=5 total=16 cost_usd=0\.02 mean_duration_ms=250 activated=1\/1 stale_pruned=0 active_pruned=1 active_tokens_saved=0 active_archive_failures=0 archive_placeholders=0 archive_placeholder_reasons=\{\} archive_write_failures=0 retrieved=0 retrieved_tokens=0 retrieval_skipped=0 retrieval_skipped_reasons=\{\} retrieval_failures=0 retrieval_failure_reasons=\{\}/);
  });

  test('renders token cost usage', () => {
    const taskIds = Array.from({ length: 1000 }, (_, index) => `t${index}`);
    const result = summarizeAbComparison({
      runId: 'ab-run',
      roundId: 'ab-summary',
      baselineArmId: 'prune-off',
      candidateArmId: 'prune-on',
      evaluationTaskIds: taskIds,
      baselineRuns: [taskIds.map((taskId) => withUsage(
        completed(taskId, true),
        { input: 100, cacheHitInput: 20, cacheMissInput: 70, cacheWriteInput: 10, output: 30, reasoning: 5, total: 135, costUsd: 3, durationMs: 1000 },
      ))],
      candidateRuns: [taskIds.map((taskId) => withUsage(
        completed(taskId, true),
        { input: 60, cacheHitInput: 15, cacheMissInput: 40, cacheWriteInput: 5, output: 25, reasoning: 5, total: 90, costUsd: 2, durationMs: 800 },
      ))],
    });

    const markdown = renderAbComparisonMarkdown(result);

    assert.match(markdown, /Token\/cost: A input=100000 cache_hit=20000 cache_miss=70000 cache_write=10000 output=30000 total=135000 cost_usd=3000 mean_duration_ms=1000/);
    assert.match(markdown, /B input=60000 cache_hit=15000 cache_miss=40000 cache_write=5000 output=25000 total=90000 cost_usd=2000 mean_duration_ms=800/);
  });

  test('renders continuation cap diagnostics', () => {
    const result = summarizeAbComparison({
      runId: 'ab-run',
      roundId: 'ab-summary',
      baselineArmId: 'prune-off',
      candidateArmId: 'prune-on',
      evaluationTaskIds: ['t1', 't2'],
      budgetMs: 600_000,
      baselineRuns: [[
        { ...completed('t1', true), continuationSummary: continuationSummary({ turnsUsed: 2, continuedTurns: 1, stepCapHits: 1, totalRuntimeSteps: 42, turns: [
          { turnIndex: 0, status: 'failed', stepCapHit: true, runtimeSteps: 42 },
          { turnIndex: 1, status: 'completed', stepCapHit: false, runtimeSteps: 0 },
        ] }) },
        { ...completed('t2', false), continuationSummary: continuationSummary({ capExhausted: true, turnsUsed: 3, continuedTurns: 2, stepCapHits: 3, totalRuntimeSteps: 60, turns: [
          { turnIndex: 0, status: 'failed', stepCapHit: true, runtimeSteps: 20 },
          { turnIndex: 1, status: 'failed', stepCapHit: true, runtimeSteps: 20 },
          { turnIndex: 2, status: 'failed', stepCapHit: true, runtimeSteps: 20 },
        ] }) },
      ]],
      candidateRuns: [[
        { ...completed('t1', true), continuationSummary: continuationSummary({ turnsUsed: 1, totalRuntimeSteps: 20 }) },
        { ...completed('t2', true), continuationSummary: continuationSummary({ turnsUsed: 2, continuedTurns: 1, stepCapHits: 1, totalRuntimeSteps: 44, turns: [
          { turnIndex: 0, status: 'failed', stepCapHit: true, runtimeSteps: 44 },
          { turnIndex: 1, status: 'completed', stepCapHit: false, runtimeSteps: 0 },
        ] }) },
      ]],
    });

    assert.match(renderAbComparisonMarkdown(result), /Continuation: A enabled=2\/2 wall_timeout=600000ms turns=5 continued=3 step_cap_hits=4 per_turn_step_cap_hits=\[true,false,true,true,true\] cap_exhausted=1 runtime_steps=102 max_turns=3 max_total_steps=150, B enabled=2\/2 wall_timeout=600000ms turns=3 continued=1 step_cap_hits=1 per_turn_step_cap_hits=\[false,true,false\] cap_exhausted=0 runtime_steps=64 max_turns=3 max_total_steps=150/);
  });

  test('renders task experiment tool diagnostics', () => {
    const result = summarizeAbComparison({
      runId: 'ab-run',
      roundId: 'ab-summary',
      baselineArmId: 'task-tools-off',
      candidateArmId: 'task-tools-on',
      evaluationTaskIds: ['t1', 't2'],
      baselineRuns: [[completed('t1', true), completed('t2', true)]],
      candidateRuns: [[
        {
          ...completed('t1', true),
          taskToolSummary: taskToolSummary({
            todoWriteCalls: 5,
          }),
        },
        {
          ...completed('t2', true),
          taskToolSummary: taskToolSummary({
            todoWriteCalls: 3,
          }),
        },
      ]],
    });

    const markdown = renderAbComparisonMarkdown(result);
    assert.match(markdown, /Task tools: A activated=0\/0 todo_write=0, B activated=2\/2 todo_write=8/);
    assert.doesNotMatch(markdown, /\bcalls=/);
  });

  test('renders investigation refs', () => {
    const activatedSummary = contextBudgetSummary({ activePrunedToolResults: 1, activeEstimatedTokensSaved: 50 });
    const result = summarizeAbComparison({
      runId: 'ab-run',
      roundId: 'ab-summary',
      baselineArmId: 'prune-off',
      candidateArmId: 'active-prune-on',
      evaluationTaskIds: ['b-loss', 'activated', 'budget'],
      baselineRuns: [[
        withTrace(completed('b-loss', true), 'A', 'b-loss'),
        withTrace(completed('activated', true), 'A', 'activated'),
        withTrace(completed('budget', true), 'A', 'budget'),
      ]],
      candidateRuns: [[
        withTrace(completed('b-loss', false), 'B', 'b-loss'),
        { ...withTrace(completed('activated', true), 'B', 'activated'), id: 'event-B-activated-r0', contextBudgetSummary: activatedSummary },
        { ...budgetExhausted('budget'), id: 'event-B-budget-r0', roundId: 'ab-prune-on-r0-budget' },
      ]],
    });

    const markdown = renderAbComparisonMarkdown(result);

    assert.match(markdown, /Activated Attempts/);
    assert.match(markdown, /event-B-activated-r0.*\/traces\/B\/activated\/events\.jsonl/);
    assert.match(markdown, /B Loss Refs/);
    assert.match(markdown, /b-loss#r0.*\/logs\/B\/b-loss\/runtime-events\.jsonl/);
    assert.match(markdown, /Budget Discordant Refs/);
    assert.match(markdown, /budget#r0.*runtime_unavailable=budget_exhausted_before_cell_output/);
  });

  test('renders non-inferiority and budget-discordant refs', () => {
    const underpowered = summarizeAbComparison({
      runId: 'ab-run',
      roundId: 'ab-summary',
      baselineArmId: 'prune-off',
      candidateArmId: 'prune-on',
      evaluationTaskIds: Array.from({ length: 100 }, (_, index) => `t${index}`),
      baselineRuns: [Array.from({ length: 100 }, (_, index) => completed(`t${index}`, index < 100))],
      candidateRuns: [Array.from({ length: 100 }, (_, index) => completed(`t${index}`, index < 91))],
    });
    assert.match(renderAbComparisonMarkdown(underpowered), /Non-inferiority lower bound:/);

    const taskIds = Array.from({ length: 100 }, (_, index) => `t${index}`);
    const withBudgetDiscord = summarizeAbComparison({
      runId: 'ab-run',
      roundId: 'ab-summary',
      baselineArmId: 'prune-off',
      candidateArmId: 'prune-on',
      evaluationTaskIds: taskIds,
      baselineRuns: [[budgetExhausted('t0'), ...taskIds.slice(1).map((taskId) => completed(taskId, true))]],
      candidateRuns: [taskIds.map((taskId) => completed(taskId, true))],
    });

    const markdown = renderAbComparisonMarkdown(withBudgetDiscord);

    assert.match(markdown, /Budget Discordant Refs/);
    assert.match(markdown, /t0#r0/);
  });
});
