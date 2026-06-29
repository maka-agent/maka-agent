import { execFile } from 'node:child_process';
import { realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';
import { isDeepStrictEqual, promisify } from 'node:util';
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
import { hashCandidateRationale, hashHeldInTaskSet } from './prompt-candidate-loop.js';
import type { PromptAcceptanceResult } from './prompt-acceptance-policy.js';
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

export async function assertPromptRepoMatchesReplayState(input: {
  gitRootPath: string;
  expectedHead: string;
  programPath: string;
  systemPromptGitPath: string;
}): Promise<void> {
  const head = await gitOutput(input.gitRootPath, 'rev-parse', 'HEAD');
  if (head !== input.expectedHead) {
    throw new Error(`prompt repo HEAD does not match resumed RSI WAL state: expected ${input.expectedHead}, got ${head}`);
  }
  const programGitPath = await toGitRelativePath(input.gitRootPath, input.programPath);
  const promptGitPaths = [
    programGitPath,
    input.systemPromptGitPath,
  ];
  for (const path of [...new Set(promptGitPaths)]) {
    if (!(await gitExitZero(input.gitRootPath, 'ls-files', '--error-unmatch', '--', path))) {
      throw new Error(`prompt repo prompt file must be tracked before RSI run: ${path}`);
    }
  }
  const [worktreeClean, indexClean] = await Promise.all([
    gitExitZero(input.gitRootPath, 'diff', '--quiet', '--', ...promptGitPaths),
    gitExitZero(input.gitRootPath, 'diff', '--cached', '--quiet', '--', ...promptGitPaths),
  ]);
  if (!worktreeClean || !indexClean) {
    throw new Error(`prompt repo has uncommitted prompt file changes: ${promptGitPaths.join(', ')}`);
  }
}

export function assertReplayedDecisionMatchesResult(
  decision: PromptCandidateDecisionEvent,
  result: PromptAcceptanceResult,
): void {
  const replayedDecision = {
    decision: result.decision,
    reason: result.reason,
    candidateCommitSha: result.candidateCommitSha,
    previousLastKeptCommitSha: result.previousLastKeptCommitSha,
    lastKeptCommitSha: result.lastKeptCommitSha,
    previousHeldInReferencePassEligibleRate: result.previousHeldInReferencePassEligibleRate,
    heldInReferencePassEligibleRate: result.heldInReferencePassEligibleRate,
    originalCommitSha: result.originalCommitSha,
    originalHeldOutPassEligibleRate: result.originalHeldOutPassEligibleRate,
    heldInPassRateNoiseBand: result.heldInPassRateNoiseBand,
    heldOutPassRateNoiseBand: result.heldOutPassRateNoiseBand,
    rewardHackScan: result.rewardHackScan,
    metrics: result.metrics,
  };
  const persistedDecision = {
    decision: decision.decision,
    reason: decision.reason,
    candidateCommitSha: decision.candidateCommitSha,
    previousLastKeptCommitSha: decision.previousLastKeptCommitSha,
    lastKeptCommitSha: decision.lastKeptCommitSha,
    previousHeldInReferencePassEligibleRate: decision.previousHeldInReferencePassEligibleRate,
    heldInReferencePassEligibleRate: decision.heldInReferencePassEligibleRate,
    originalCommitSha: decision.originalCommitSha,
    originalHeldOutPassEligibleRate: decision.originalHeldOutPassEligibleRate,
    heldInPassRateNoiseBand: decision.heldInPassRateNoiseBand,
    heldOutPassRateNoiseBand: decision.heldOutPassRateNoiseBand,
    rewardHackScan: decision.rewardHackScan,
    metrics: decision.metrics,
  };
  if (!isDeepStrictEqual(persistedDecision, replayedDecision)) {
    throw new Error(`RSI WAL replay decision mismatch for ${decision.roundId}`);
  }
}

export function assertCandidateMatchesStableTaskSet(
  candidate: PromptCandidateCommittedEvent,
  stableHeldInTaskIds: readonly string[],
): void {
  assertCandidateEventSelfConsistent(candidate);
  const actualHash = hashHeldInTaskSet(candidate.heldInTaskIds);
  const expectedHash = hashHeldInTaskSet(stableHeldInTaskIds);
  if (candidate.heldInTaskSetHash !== actualHash || candidate.heldInTaskSetHash !== expectedHash) {
    throw new Error(`RSI WAL replay candidate task-set mismatch for ${candidate.roundId}`);
  }
}

export async function buildPromptOptimizationReplayPlan(input: {
  events: readonly FixedPromptWalEvent[];
  promptRepoDir: string;
  systemPromptGitPath: string;
  runId?: string;
  resumeFingerprint?: string;
  strictRoundState?: boolean;
}): Promise<PromptOptimizationReplayPlan> {
  if (input.runId) assertWalBelongsToRun(input.events, input.runId);
  const state = await derivePromptOptimizationReplayState({
    events: input.events,
    promptRepoDir: input.promptRepoDir,
    systemPromptGitPath: input.systemPromptGitPath,
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
    if (!taskEventMatchesPromptIdentity(event, input.expectedPromptHash)) {
      throw new Error(`RSI WAL replay prompt hash mismatch for ${event.roundId}/${event.taskId}`);
    }
    mergeReplayedTaskEvent(byTaskId, event);
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
  assertCandidateMatchesStableTaskSet(candidate, input.heldInTaskIds);
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
  systemPromptGitPath?: string;
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
      if (candidate && !taskEventMatchesPromptIdentity(event, candidate.promptHash)) {
        throw new Error(`RSI WAL replay prompt hash mismatch for ${event.roundId}/${event.taskId}`);
      }
    }
    if (event.type === 'prompt_candidate_committed') {
      if (candidateByRoundId.has(event.roundId)) {
        throw new Error(`RSI WAL replay found duplicate candidate commit for ${event.roundId}`);
      }
      if (input.strictRoundState) {
        assertCandidateEventSelfConsistent(event);
        assertCandidateRoundCanFollow(event.roundId, candidateByRoundId.size, decisionByRoundId.size);
        await assertCandidateParentMatchesExpectedHead({
          candidate: event,
          promptRepoDir: input.promptRepoDir,
          expectedParentSha: expectedPromptRepoHead,
        });
        if (!input.systemPromptGitPath) {
          throw new Error('RSI WAL replay requires system prompt path for strict candidate replay');
        }
        await assertCandidateChangesOnlySystemPrompt({
          candidate: event,
          promptRepoDir: input.promptRepoDir,
          systemPromptGitPath: input.systemPromptGitPath,
        });
        await assertCandidatePromptHashMatchesCommit({
          candidate: event,
          promptRepoDir: input.promptRepoDir,
          systemPromptGitPath: input.systemPromptGitPath,
        });
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

function assertWalBelongsToRun(events: readonly FixedPromptWalEvent[], runId: string): void {
  const otherRun = events.find((event) => event.runId !== runId);
  if (otherRun) {
    throw new Error(`RSI WAL replay found events for a different runId: expected ${runId}, got ${otherRun.runId}`);
  }
}

function assertCandidateEventSelfConsistent(candidate: PromptCandidateCommittedEvent): void {
  if (candidate.heldInTaskSetHash !== hashHeldInTaskSet(candidate.heldInTaskIds)) {
    throw new Error(`RSI WAL replay candidate task-set mismatch for ${candidate.roundId}`);
  }
  if (candidate.candidateRationaleHash !== hashCandidateRationale(candidate.candidateRationale)) {
    throw new Error(`RSI WAL replay candidate rationale mismatch for ${candidate.roundId}`);
  }
}

function assertCandidateRoundCanFollow(
  roundId: string,
  existingCandidateCount: number,
  existingDecisionCount: number,
): void {
  const roundIndex = roundIndexFromRoundId(roundId);
  if (roundIndex === undefined) {
    throw new Error(`RSI WAL replay found invalid candidate round id for ${roundId}`);
  }
  if (roundIndex !== existingCandidateCount || roundIndex !== existingDecisionCount) {
    throw new Error(`RSI WAL replay found candidate round gap for ${roundId}`);
  }
}

function roundIndexFromRoundId(roundId: string): number | undefined {
  const match = /^round-(\d+)$/.exec(roundId);
  if (!match) return undefined;
  return Number(match[1]);
}

async function assertCandidateParentMatchesExpectedHead(input: {
  candidate: PromptCandidateCommittedEvent;
  promptRepoDir: string;
  expectedParentSha: string;
}): Promise<void> {
  let parentSha: string;
  try {
    parentSha = await gitOutput(input.promptRepoDir, 'rev-parse', `${input.candidate.commitSha}^`);
  } catch {
    throw new Error(`RSI WAL replay found candidate parent mismatch for ${input.candidate.roundId}`);
  }
  if (parentSha !== input.expectedParentSha) {
    throw new Error(`RSI WAL replay found candidate parent mismatch for ${input.candidate.roundId}`);
  }
}

async function assertCandidatePromptHashMatchesCommit(input: {
  candidate: PromptCandidateCommittedEvent;
  promptRepoDir: string;
  systemPromptGitPath: string;
}): Promise<void> {
  let systemPrompt: string;
  try {
    systemPrompt = await gitBlob(input.promptRepoDir, `${input.candidate.commitSha}:${input.systemPromptGitPath}`);
  } catch {
    throw new Error(`RSI WAL replay candidate prompt hash mismatch for ${input.candidate.roundId}`);
  }
  if (hashSystemPrompt(systemPrompt) !== input.candidate.promptHash) {
    throw new Error(`RSI WAL replay candidate prompt hash mismatch for ${input.candidate.roundId}`);
  }
}

async function assertCandidateChangesOnlySystemPrompt(input: {
  candidate: PromptCandidateCommittedEvent;
  promptRepoDir: string;
  systemPromptGitPath: string;
}): Promise<void> {
  let changedFiles: string[];
  try {
    const output = await gitOutput(
      input.promptRepoDir,
      'diff-tree',
      '--no-commit-id',
      '--name-only',
      '-r',
      input.candidate.commitSha,
    );
    changedFiles = output === '' ? [] : output.split('\n');
  } catch {
    throw new Error(`RSI WAL replay candidate changed unexpected files for ${input.candidate.roundId}`);
  }
  if (changedFiles.length !== 1 || changedFiles[0] !== input.systemPromptGitPath) {
    throw new Error(`RSI WAL replay candidate changed unexpected files for ${input.candidate.roundId}`);
  }
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
    attributionMatchesRound(event, input.runId, input.roundId));
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

function attributionMatchesRound(
  event: FixedPromptWalEvent,
  runId: string,
  roundId: string,
): event is RsiControllerAttributionEvent {
  return event.type === 'rsi_controller_attribution'
    && event.runId === runId
    && event.roundId === roundId;
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

function mergeReplayedTaskEvent(
  byTaskId: Map<string, FixedPromptTaskWalEvent>,
  event: FixedPromptTaskWalEvent,
): void {
  const existing = byTaskId.get(event.taskId);
  if (!existing) {
    byTaskId.set(event.taskId, event);
    return;
  }
  if (existing.type === 'task_infra_failed') {
    byTaskId.set(event.taskId, event);
    return;
  }
  throw new Error(`RSI WAL replay duplicate task event for ${event.roundId}/${event.taskId}`);
}

function taskEventMatchesPromptIdentity(
  event: FixedPromptTaskWalEvent,
  expectedPromptHash: string,
): boolean {
  if (event.type === 'task_infra_failed') return true;
  return promptHashForReplayIdentity(event) === expectedPromptHash;
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

async function gitExitZero(cwd: string, ...args: string[]): Promise<boolean> {
  try {
    await execFileAsync('git', args, { cwd });
    return true;
  } catch {
    return false;
  }
}

async function toGitRelativePath(gitRootPath: string, filePath: string): Promise<string> {
  const [rootPath, absolutePath] = await Promise.all([
    realpath(gitRootPath),
    realpath(isAbsolute(filePath) ? filePath : resolve(gitRootPath, filePath)),
  ]);
  const gitPath = relative(rootPath, absolutePath).split('\\').join('/');
  if (gitPath === '' || gitPath === '..' || gitPath.startsWith('../')) {
    throw new Error(`prompt repo prompt file must stay inside git root: ${filePath}`);
  }
  return gitPath;
}
