import type { Config } from './contracts.js';
import type {
  FixedPromptTask,
  FixedPromptTaskWalEvent,
  HarborTaskRunner,
} from './fixed-prompt-controller.js';

export interface SummarizePromptAbComparisonInput {
  runId: string;
  roundId: string;
  baselinePromptId: string;
  candidatePromptId: string;
  evaluationTaskIds: readonly string[];
  baselineRuns: readonly (readonly FixedPromptTaskWalEvent[])[];
  candidateRuns: readonly (readonly FixedPromptTaskWalEvent[])[];
  budgetMs?: number;
}

export interface RunPromptAbComparisonInput {
  runId: string;
  config: Config;
  baselinePromptPath: string;
  candidatePromptPath: string;
  candidatePromptId?: string;
  resultsJsonlPath: string;
  evaluationTasks: readonly FixedPromptTask[];
  reps?: number;
  maxConcurrency?: number;
  resumeFingerprint?: string;
  budgetMs?: number;
  harborRunner: HarborTaskRunner;
  now?: () => number;
  newId?: () => string;
}

export type PromptAbDecision =
  | 'candidate_better'
  | 'baseline_better'
  | 'inconclusive';

export interface PromptAbArmSummary {
  attempts: number;
  observed: number;
  valid: number;
  passed: number;
  passRate: number | null;
  completed: number;
  budgetExhausted: number;
  infraFailed: number;
  plumbingFailed: number;
  missing: number;
  coverageRate: number;
  totalCostUsd: number;
  meanDurationMs: number | null;
}

export interface PromptAbTaskArmSummary {
  observed: number;
  valid: number;
  passed: number;
  passRate: number | null;
  completed: number;
  budgetExhausted: number;
  infraFailed: number;
  plumbingFailed: number;
  missing: number;
}

export interface PromptAbTaskComparison {
  taskId: string;
  baseline: PromptAbTaskArmSummary;
  candidate: PromptAbTaskArmSummary;
  passRateDelta: number | null;
  outcome: 'candidate_win' | 'baseline_win' | 'tie' | 'missing';
}

export interface PromptAbTaskLevelSummary {
  comparableTasks: number;
  wins: number;
  losses: number;
  ties: number;
  signTestNonTieTasks: number;
  signTestPValue: number | null;
  missingTaskIds: string[];
  meanPassRateDelta: number | null;
  medianPassRateDelta: number | null;
  tasks: PromptAbTaskComparison[];
}

export interface PromptAbAttemptPairSummary {
  pairs: number;
  observedPairs: number;
  wins: number;
  losses: number;
  ties: number;
  missingPairIds: string[];
  budgetDiscordantPairIds: string[];
  infraOrPlumbingDiscordantPairIds: string[];
}

export interface PromptAbComparisonSummary {
  runId: string;
  roundId: string;
  baselinePromptId: string;
  candidatePromptId: string;
  taskCount: number;
  reps: number;
  budgetMs?: number;
  decision: PromptAbDecision;
  reason: string;
  baseline: PromptAbArmSummary;
  candidate: PromptAbArmSummary;
  taskLevel: PromptAbTaskLevelSummary;
  pairedAttempts: PromptAbAttemptPairSummary;
}

export interface PromptAbMetadataFilterInput {
  tasks: readonly FixedPromptTask[];
  maxExpertTimeEstimateMin?: number;
}

export interface PromptAbMetadataFilterResult {
  maxExpertTimeEstimateMin: number;
  candidateTaskCount: number;
  selectedTaskIds: string[];
  selectedTasks: FixedPromptTask[];
  rejected: {
    longExpertEstimateTaskIds: string[];
    missingExpertEstimateTaskIds: string[];
  };
}

export interface PromptAbCandidateTaskLimitResult {
  limit: number | null;
  inputTaskCount: number;
  selectedTaskIds: string[];
  selectedTasks: FixedPromptTask[];
  truncatedTaskIds: string[];
}

export interface PromptAbRunManifestInput {
  baselinePromptHash: string;
  candidatePromptHash: string;
  provider: string;
  baseUrl: string;
  model: string;
  taskBudgetSec: number;
  harborTimeoutMs: number;
  subjectFingerprint: string;
  taskSourceFingerprint: string;
  toolchainFingerprint: string;
  evaluationTaskIds: readonly string[];
  reps: number;
  candidateLimit: number | null;
  maxConcurrency: number;
  selectionMode?: 'explicit' | 'metadata';
  candidateTaskIds?: readonly string[];
  maxExpertTimeEstimateMin?: number | null;
  targetEvaluationTaskCount?: number | null;
}

export type PromptAbRunManifest = PromptAbRunManifestInput & {
  schemaVersion: 'maka.prompt_ab.run_manifest.v1';
  fingerprint: string;
  evaluationTaskIds: string[];
  candidateTaskIds?: string[];
};
