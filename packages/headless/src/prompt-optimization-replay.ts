import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { hashSystemPrompt } from './fixed-prompt-controller.js';
import type {
  FixedPromptControllerResult,
  FixedPromptTaskCompletedEvent,
  FixedPromptTaskPlumbingFailedEvent,
  FixedPromptTaskWalEvent,
  FixedPromptWalEvent,
  PromptCandidateCommittedEvent,
  PromptCandidateDecisionEvent,
  RsiControllerAttributionEvent,
} from './fixed-prompt-controller.js';
import { validateRsiControllerAttribution } from './rsi-controller-attribution.js';

const execFileAsync = promisify(execFile);

export interface PromptOptimizationReplayState {
  seedCommitSha: string;
  lastKeptCommitSha: string;
  expectedPromptRepoHead: string;
  candidateByRoundId: ReadonlyMap<string, PromptCandidateCommittedEvent>;
  decisionByRoundId: ReadonlyMap<string, PromptCandidateDecisionEvent>;
}

export interface PromptOptimizationReplayPlan {
  state: PromptOptimizationReplayState;
  seedPromptHash: string;
  historicalBaselineEvidenceRequired: boolean;
}

export interface ReplayedPromptDecisionRound {
  decision: PromptCandidateDecisionEvent;
  heldIn: FixedPromptControllerResult;
  heldOut: FixedPromptControllerResult | undefined;
  attribution: RsiControllerAttributionEvent;
}

export async function buildPromptOptimizationReplayPlan(input: {
  events: readonly FixedPromptWalEvent[];
  promptRepoDir: string;
  systemPromptGitPath: string;
  runId?: string;
  resumeFingerprint?: string;
  strictRoundState?: boolean;
}): Promise<PromptOptimizationReplayPlan> {
  const state = await derivePromptOptimizationReplayState({
    events: input.events,
    promptRepoDir: input.promptRepoDir,
    ...(input.runId ? { runId: input.runId } : {}),
    ...(input.resumeFingerprint ? { resumeFingerprint: input.resumeFingerprint } : {}),
    ...(input.strictRoundState !== undefined ? { strictRoundState: input.strictRoundState } : {}),
  });
  return {
    state,
    seedPromptHash: await readSeedSystemPromptHash({
      promptRepoDir: input.promptRepoDir,
      seedCommitSha: state.seedCommitSha,
      systemPromptGitPath: input.systemPromptGitPath,
    }),
    historicalBaselineEvidenceRequired: hasHistoricalPromptOptimizationState(state),
  };
}

function replayControllerSweep(input: {
  events: readonly FixedPromptWalEvent[];
  runId: string;
  roundId: string;
  taskIds: readonly string[];
  expectedPromptHash: string;
  resumeFingerprint?: string;
  resultsTsvPath: string;
}): FixedPromptControllerResult | undefined {
  const requested = new Set(input.taskIds);
  const matched = input.events.filter((event): event is FixedPromptTaskWalEvent =>
    isTaskEvent(event)
    && event.runId === input.runId
    && event.roundId === input.roundId
    && requested.has(event.taskId));
  if (matched.length === 0) return undefined;
  if (input.resumeFingerprint === undefined) {
    throw new Error(`RSI WAL replay requires a resume fingerprint for ${input.roundId}`);
  }

  const byTaskId = new Map<string, FixedPromptTaskWalEvent>();
  for (const event of matched) {
    if (event.resumeFingerprint !== input.resumeFingerprint) {
      throw new Error(`RSI WAL replay identity mismatch for ${event.roundId}/${event.taskId}`);
    }
    const eventPromptHash = promptHashForReplayIdentity(event);
    if (eventPromptHash !== undefined && eventPromptHash !== input.expectedPromptHash) {
      throw new Error(`RSI WAL replay prompt hash mismatch for ${event.roundId}/${event.taskId}`);
    }
    if (byTaskId.has(event.taskId)) {
      throw new Error(`RSI WAL replay duplicate task event for ${event.roundId}/${event.taskId}`);
    }
    byTaskId.set(event.taskId, event);
  }

  if (byTaskId.size !== input.taskIds.length) return undefined;
  const orderedEvents = input.taskIds.map((taskId) => byTaskId.get(taskId)!);
  return {
    taskIds: [...input.taskIds],
    events: orderedEvents,
    totalTokens: sum(orderedEvents.map((event) => eventHasRunArtifacts(event) ? event.tokenSummary.total : 0)),
    totalCostUsd: sum(orderedEvents.map((event) => eventHasRunArtifacts(event) ? event.tokenSummary.costUsd : 0)),
    resultsTsvPath: input.resultsTsvPath,
  };
}

function replayRequiredControllerSweep(
  input: Parameters<typeof replayControllerSweep>[0] & { missingEvidenceMessage: string },
): FixedPromptControllerResult {
  const result = replayControllerSweep(input);
  if (!result) throw new Error(input.missingEvidenceMessage);
  return result;
}

export function replayPromptBaselinePartition(input: Parameters<typeof replayControllerSweep>[0] & {
  partition: 'held-in' | 'held-out';
  required: boolean;
}): FixedPromptControllerResult | undefined {
  if (!input.required) return replayControllerSweep(input);
  return replayRequiredControllerSweep({
    ...input,
    missingEvidenceMessage: `RSI WAL replay missing required baseline ${input.partition} evidence for ${input.roundId}`,
  });
}

export function replayPromptDecisionRound(input: {
  events: readonly FixedPromptWalEvent[];
  state: PromptOptimizationReplayState;
  runId: string;
  roundId: string;
  heldInTaskIds: readonly string[];
  heldOutTaskIds: readonly string[];
  resumeFingerprint?: string;
  heldInResultsTsvPath: string;
  heldOutResultsTsvPath: string;
}): ReplayedPromptDecisionRound | undefined {
  const decision = input.state.decisionByRoundId.get(input.roundId);
  if (!decision) return undefined;
  const candidate = input.state.candidateByRoundId.get(input.roundId);
  if (!candidate) {
    throw new Error(`RSI WAL replay missing candidate commit for decided ${input.roundId}`);
  }
  if (!decision.rewardHackScan) {
    throw new Error(`RSI WAL replay missing reward-hack scan evidence for ${input.roundId}`);
  }
  const attribution = replayDecisionAttribution({
    events: input.events,
    runId: input.runId,
    roundId: input.roundId,
    candidate,
    decision,
  });
  const heldIn = replayRequiredControllerSweep({
    events: input.events,
    runId: input.runId,
    roundId: input.roundId,
    taskIds: input.heldInTaskIds,
    expectedPromptHash: candidate.promptHash,
    ...(input.resumeFingerprint ? { resumeFingerprint: input.resumeFingerprint } : {}),
    resultsTsvPath: input.heldInResultsTsvPath,
    missingEvidenceMessage: `RSI WAL replay missing held-in task evidence for ${input.roundId}`,
  });
  const heldOut = replayControllerSweep({
    events: input.events,
    runId: input.runId,
    roundId: input.roundId,
    taskIds: input.heldOutTaskIds,
    expectedPromptHash: candidate.promptHash,
    ...(input.resumeFingerprint ? { resumeFingerprint: input.resumeFingerprint } : {}),
    resultsTsvPath: input.heldOutResultsTsvPath,
  });
  return {
    decision,
    heldIn,
    heldOut,
    attribution,
  };
}

async function readSeedSystemPromptHash(input: {
  promptRepoDir: string;
  seedCommitSha: string;
  systemPromptGitPath: string;
}): Promise<string> {
  const systemPrompt = await gitBlob(input.promptRepoDir, `${input.seedCommitSha}:${input.systemPromptGitPath}`);
  return hashSystemPrompt(systemPrompt);
}

export async function derivePromptOptimizationReplayState(input: {
  events: readonly FixedPromptWalEvent[];
  promptRepoDir: string;
  runId?: string;
  resumeFingerprint?: string;
  strictRoundState?: boolean;
}): Promise<PromptOptimizationReplayState> {
  const seedCommitSha = await gitOutput(input.promptRepoDir, 'rev-list', '--max-parents=0', 'HEAD');
  let lastKeptCommitSha = seedCommitSha;
  let expectedPromptRepoHead = seedCommitSha;
  const candidateByRoundId = new Map<string, PromptCandidateCommittedEvent>();
  const decisionByRoundId = new Map<string, PromptCandidateDecisionEvent>();

  for (const event of input.events) {
    if (!matchesRun(event, input.runId)) continue;
    if (
      input.resumeFingerprint !== undefined
      && isTaskEvent(event)
      && event.resumeFingerprint !== input.resumeFingerprint
    ) {
      throw new Error(`RSI WAL replay identity mismatch for ${event.roundId}/${event.taskId}`);
    }
    if (isTaskEvent(event) && event.roundId.startsWith('round-')) {
      const candidate = candidateByRoundId.get(event.roundId);
      if (!candidate && input.strictRoundState) {
        throw new Error(`RSI WAL replay found task evidence before candidate commit for ${event.roundId}`);
      }
      const eventPromptHash = promptHashForReplayIdentity(event);
      if (candidate && eventPromptHash !== undefined && eventPromptHash !== candidate.promptHash) {
        throw new Error(`RSI WAL replay prompt hash mismatch for ${event.roundId}/${event.taskId}`);
      }
    }
    if (event.type === 'prompt_candidate_committed') {
      if (candidateByRoundId.has(event.roundId)) {
        throw new Error(`RSI WAL replay found duplicate candidate commit for ${event.roundId}`);
      }
      candidateByRoundId.set(event.roundId, event);
      expectedPromptRepoHead = event.commitSha;
      continue;
    }
    if (event.type === 'prompt_candidate_decided') {
      if (decisionByRoundId.has(event.roundId)) {
        throw new Error(`RSI WAL replay found duplicate prompt decision for ${event.roundId}`);
      }
      const candidate = candidateByRoundId.get(event.roundId);
      if (!candidate && input.strictRoundState) {
        throw new Error(`RSI WAL replay found decision without candidate commit for ${event.roundId}`);
      }
      if (candidate && candidate.commitSha !== event.candidateCommitSha) {
        throw new Error(`RSI WAL replay found decision candidate mismatch for ${event.roundId}`);
      }
      if (input.strictRoundState && event.previousLastKeptCommitSha !== lastKeptCommitSha) {
        throw new Error(`RSI WAL replay found stale previous last-kept for ${event.roundId}`);
      }
      const expectedLastKept = event.decision === 'keep' ? event.candidateCommitSha : event.previousLastKeptCommitSha;
      if (input.strictRoundState && event.lastKeptCommitSha !== expectedLastKept) {
        throw new Error(`RSI WAL replay found invalid last-kept for ${event.roundId}`);
      }
      if (input.strictRoundState && event.originalCommitSha !== seedCommitSha) {
        throw new Error(`RSI WAL replay found original commit mismatch for ${event.roundId}`);
      }
      decisionByRoundId.set(event.roundId, event);
      lastKeptCommitSha = event.lastKeptCommitSha;
      expectedPromptRepoHead = event.lastKeptCommitSha;
      continue;
    }
  }

  return {
    seedCommitSha,
    lastKeptCommitSha,
    expectedPromptRepoHead,
    candidateByRoundId,
    decisionByRoundId,
  };
}

function hasHistoricalPromptOptimizationState(state: PromptOptimizationReplayState): boolean {
  return state.candidateByRoundId.size > 0
    || state.decisionByRoundId.size > 0
    || state.expectedPromptRepoHead !== state.seedCommitSha;
}

function replayDecisionAttribution(input: {
  events: readonly FixedPromptWalEvent[];
  runId: string;
  roundId: string;
  candidate: PromptCandidateCommittedEvent;
  decision: PromptCandidateDecisionEvent;
}): RsiControllerAttributionEvent {
  const decisionIndex = input.events.findIndex((event) => event === input.decision);
  if (decisionIndex < 0) {
    throw new Error(`RSI WAL replay missing decision event for ${input.roundId}`);
  }
  const preDecisionAttribution = input.events.slice(0, decisionIndex).find((event) =>
    attributionMatchesCandidate(event, input.runId, input.roundId, input.candidate));
  if (preDecisionAttribution) {
    throw new Error(`RSI WAL replay found RSI attribution before decision for ${input.roundId}`);
  }

  let attribution: RsiControllerAttributionEvent | undefined;
  for (const event of input.events.slice(decisionIndex + 1)) {
    if (!matchesRun(event, input.runId)) continue;
    if (event.type === 'prompt_candidate_committed') break;
    if (event.type !== 'rsi_controller_attribution' || event.roundId !== input.roundId) continue;
    assertAttributionMatchesCandidate(event, input.candidate, input.roundId);
    if (attribution) {
      throw new Error(`RSI WAL replay found duplicate RSI attribution for ${input.roundId}`);
    }
    attribution = event;
  }
  if (!attribution) {
    throw new Error(`RSI WAL replay missing post-decision RSI attribution evidence for ${input.roundId}`);
  }
  const attributionValidation = validateRsiControllerAttribution({
    attribution,
    candidateRationale: input.candidate.candidateRationale,
    heldInTaskIds: input.candidate.heldInTaskIds,
    decision: input.decision,
  });
  if (attributionValidation.malformed || attributionValidation.outOfScope) {
    throw new Error(`RSI WAL replay invalid RSI attribution evidence for ${input.roundId}`);
  }
  return attribution;
}

function attributionMatchesCandidate(
  event: FixedPromptWalEvent,
  runId: string,
  roundId: string,
  candidate: PromptCandidateCommittedEvent,
): event is RsiControllerAttributionEvent {
  return event.type === 'rsi_controller_attribution'
    && event.runId === runId
    && event.roundId === roundId
    && event.candidateCommitSha === candidate.commitSha;
}

function assertAttributionMatchesCandidate(
  event: RsiControllerAttributionEvent,
  candidate: PromptCandidateCommittedEvent,
  roundId: string,
): void {
  if (event.candidateCommitSha !== candidate.commitSha) {
    throw new Error(`RSI WAL replay found attribution candidate mismatch for ${roundId}`);
  }
  if (event.heldInTaskSetHash !== candidate.heldInTaskSetHash) {
    throw new Error(`RSI WAL replay found attribution task-set mismatch for ${roundId}`);
  }
  if (event.candidateRationaleHash !== candidate.candidateRationaleHash) {
    throw new Error(`RSI WAL replay found attribution rationale mismatch for ${roundId}`);
  }
}

function matchesRun(event: FixedPromptWalEvent, runId: string | undefined): boolean {
  return runId === undefined || event.runId === runId;
}

function isTaskEvent(event: FixedPromptWalEvent): event is FixedPromptTaskWalEvent {
  return event.type === 'task_completed'
    || event.type === 'task_infra_failed'
    || event.type === 'task_budget_exhausted'
    || event.type === 'task_plumbing_failed';
}

function promptHashForReplayIdentity(event: FixedPromptTaskWalEvent): string | undefined {
  if (event.type === 'task_completed') return event.promptHash;
  if (event.type === 'task_plumbing_failed') return event.promptHash ?? event.expectedPromptHash;
  if (event.type === 'task_budget_exhausted') return event.expectedPromptHash;
  return undefined;
}

function eventHasRunArtifacts(
  event: FixedPromptTaskWalEvent,
): event is FixedPromptTaskCompletedEvent | FixedPromptTaskPlumbingFailedEvent {
  return event.type === 'task_completed' || event.type === 'task_plumbing_failed';
}

function sum(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

async function gitOutput(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd, encoding: 'utf8' });
  return stdout.trim();
}

async function gitBlob(cwd: string, refPath: string): Promise<string> {
  const { stdout } = await execFileAsync('git', ['show', refPath], { cwd, encoding: 'utf8' });
  return stdout;
}
