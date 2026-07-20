import type {
  AgentRunHeader,
  AgentRunStore,
  RuntimeEvent,
  RuntimeEventStore,
  ToolBoundaryProtocol,
} from '@maka/core';
import { isSessionInlineRun, isTerminalRuntimeEvent } from '@maka/core';
import type {
  CompleteEvent,
  QueueEnqueueOutcome,
  QueueUpdateEvent,
  SessionEvent,
  TokenUsageEvent,
} from '@maka/core/events';
import type {
  SessionBlockedReason,
  SessionHeader,
  SessionStatus,
  StoredMessage,
  SystemNoteMessage,
  TurnRecord,
  TurnStateMessage,
} from '@maka/core/session';
import { isDeepStrictEqual } from 'node:util';
import type { ChildAgentTurnInput, UserMessageInput } from '@maka/core/runtime-inputs';
import type { PermissionResponse } from '@maka/core/permission';
import {
  resolveEffectiveOrchestration,
  type EffectiveOrchestration,
} from '@maka/core/orchestration';
import type { UserQuestionResponse } from '@maka/core/user-question';
import {
  AgentRun,
  type AgentRunActiveSession,
  type AgentRunBeginResult,
  type AgentRunDurability,
  type AgentRunLineage,
  type RuntimeContinuationFailpoint,
} from './agent-run.js';
import { AiSdkFlow, mapSessionEventToRuntimeEvent } from './ai-sdk-flow.js';
import type { AgentBackend, SteeringLease } from '@maka/core/backend-types';
import type { AgentTeamExecutionContext, MakaTool } from './tool-runtime.js';
import type {
  InvocationContext,
  InvocationResult,
  InvocationSource,
} from './invocation-context.js';
import { RuntimeRunner } from './runtime-runner.js';
import type {
  BackendRegistry,
  CompactSessionInput,
  SessionStore,
  StopSessionInput,
} from './session-manager.js';
import type { ShellRunProcessManager } from './shell-run-manager.js';
import {
  buildStatusPatch,
  buildTurnStateMessage,
  normalizeStopSessionSource,
  turnHasRetainedOutput as messagesHaveRetainedOutput,
} from './session-projection-helpers.js';
import { assertAgentDefinitionRunnable, buildToolsForAgentDefinition } from './agent-catalog.js';
import { parseExpertAgentId, requireResolvedAgentDefinition } from './expert-catalog.js';
import { loadLatestHistoryCompactCheckpointFromRunLedger } from './history-compact-ledger.js';
import {
  canReplaceHistoryCompactCheckpoint,
  type HistoryCompactCheckpoint,
} from './history-compact-checkpoint.js';
import { shouldAppendContextCompactionFailedOpenNote } from './context-budget.js';
import {
  buildResumePlanFromRuntimeEvents,
  RuntimeContinuationRevalidationError,
  type RuntimeContinuation,
  type RuntimeContinuationSafetyObservation,
} from './runtime-resume.js';
import {
  matchingTerminalRuntimeEvents,
  terminalRunStatusFromRuntimeEvent,
} from './terminal-run-commit.js';
import {
  RuntimeInteractionFailStopError,
  RuntimeInteractionInvariantError,
} from './interaction-authority.js';
import {
  COMPOSITION_SUCCESSOR_EFFECTS_ISOLATED,
  RunExecution,
  RuntimeExecutionCoordinator,
  type RuntimeExecutionCapability,
  type RuntimeExecutionDrainHandle,
  type RuntimeInteractionFailStopHandle,
} from './run-execution.js';
import { isRuntimeLifecycleFatal } from './runtime-lifecycle-errors.js';
import { RuntimeMessageAuthorityInvariantError } from './message-authority.js';

export interface RuntimeKernelLike {
  installInteractionFailStop(
    error: RuntimeInteractionFailStopError,
  ): RuntimeInteractionFailStopHandle;
  beginRuntimeDrain(): RuntimeExecutionDrainHandle;
  startTurn(
    sessionId: string,
    input: UserMessageInput,
    options?: TurnStartOptions,
  ): AsyncIterable<SessionEvent>;
  resumeContinuation?(continuation: RuntimeContinuation): AsyncIterable<SessionEvent>;
  compactSession(sessionId: string, input?: CompactSessionInput): AsyncIterable<SessionEvent>;
  startChildTurn(
    sessionId: string,
    input: ChildAgentTurnInput,
    options?: ChildTurnStartOptions,
  ): AsyncIterable<SessionEvent>;
  startChildRetry?(
    sessionId: string,
    input: ChildAgentRetryInput,
    options?: ChildTurnStartOptions,
  ): AsyncIterable<SessionEvent>;
  stopSession(sessionId: string, input?: StopSessionInput): Promise<void>;
  respondToPermission(sessionId: string, response: PermissionResponse): Promise<void>;
  respondToUserQuestion?(sessionId: string, response: UserQuestionResponse): Promise<void>;
  /** Queue a user message for mid-turn injection at the next step boundary. */
  steer(sessionId: string, text: string): QueueEnqueueOutcome;
  /** Queue a user message to open the turn after the current one finishes. */
  queueMessage(sessionId: string, text: string): QueueEnqueueOutcome;
  /** Drain the followup queue into one `\n\n`-joined prompt, or null if empty. */
  drainFollowup(sessionId: string): string | null;
  /** Take back every queued message (both queues) as one `\n\n`-joined string. */
  retractQueue(sessionId: string): string;
  hasActiveRuns(sessionId: string): boolean;
  updateCachedHeader(sessionId: string, header: SessionHeader): void;
  invalidateBackend(sessionId: string): Promise<void>;
  disposeBackend(sessionId: string): Promise<void>;
}

export interface TurnStartOptions {
  runId?: string;
  userMessageId?: string;
  durability?: AgentRunDurability;
  onRunStarted?: (runId: string, initialHeader: SessionHeader) => void | Promise<void>;
}

export interface ChildAgentRetryInput {
  parentRunId: string;
  spec: ChildAgentTurnInput['spec'];
  continuation: RuntimeContinuation;
}

export interface ChildTurnStartOptions {
  onRunStarted?: (runId: string) => void | Promise<void>;
}

/**
 * An embedded session's pending-message queues plus its active event sink.
 * Hosted runtimes never instantiate this state; the Runtime Host owns their
 * admission, snapshots, leases, and follow-up drain.
 */
interface PendingSteeringMessage extends SteeringLease {}

/**
 * A pulled lease is bound to the turn that pulled it: only the issuing turn's
 * backend can settle it (ack/nack stay valid even after ownership moved to an
 * overlapping turn — invalidating a delivered lease would leave it in-flight
 * and redeliver an already-executed message), and no other turn's retract/
 * clear/release may reclaim it while its delivery is still undetermined.
 */
interface LeasedSteeringMessage extends PendingSteeringMessage {
  issuingTurnId: string;
}

interface SessionSteeringState {
  /** Messages waiting to be injected into the running turn at a step boundary. */
  steering: PendingSteeringMessage[];
  /**
   * Leased to the running turn's backend but not yet settled. pull() is the
   * single atomic commit point: an in-flight lease is committed to that
   * turn's delivery — retract/clear reclaim only QUEUED messages — and it
   * settles exactly once, decided solely by the persistence fact: ack when
   * the steering event is durably consumed (even under abort), nack when it
   * provably never persisted. Snapshots count in-flight as still pending so
   * the UI keeps showing the message until it lands in the transcript.
   */
  inFlight: LeasedSteeringMessage[];
  /** Messages waiting to open the next turn. */
  followup: string[];
  /** Pushes a `queue_update` into the active turn's stream; unset when idle. */
  sink?: (event: QueueUpdateEvent) => void;
  activeTurnId?: string;
}

export interface RuntimeKernelDeps {
  store: SessionStore;
  runStore?: AgentRunStore;
  runtimeEventStore?: RuntimeEventStore;
  /** Host capability; each run still gates it by the selected backend. */
  toolBoundaryProtocol?: ToolBoundaryProtocol;
  backends: BackendRegistry;
  newId: () => string;
  now: () => number;
  childTools?: readonly MakaTool[];
  runtimeSource?: InvocationSource;
  runtimeInvocationObserver?: (result: InvocationResult) => void | Promise<void>;
  repairRunRuntimeLedger?: (sessionId: string, runId: string) => Promise<boolean>;
  shellRuns?: ShellRunProcessManager;
  cleanupHistoryCompactArtifacts?: (input: HistoryCompactCleanupRequest) => Promise<void>;
  inspectContinuationSafety?: (sessionId: string) => Promise<RuntimeContinuationSafetyObservation>;
  safeBoundaryResumeEnabled?: boolean;
  continuationFailpoint?: (point: RuntimeContinuationFailpoint) => Promise<void>;
  execution: RuntimeExecutionCapability;
}

export interface HistoryCompactCleanupRequest {
  sessionId: string;
  checkpoint: HistoryCompactCheckpoint;
  runtimeEvents: readonly RuntimeEvent[];
}

interface ActiveSession extends AgentRunActiveSession {
  sessionId: string;
  backend: AgentBackend;
  cachedHeader: SessionHeader;
  activeRuns: Map<string, AgentRun>;
  turnToRunId: Map<string, string>;
}

interface StopTarget {
  execution: RunExecution;
  delivered: boolean;
}

interface StopOperation {
  abortSource: string | undefined;
  ts: number;
  statusProjected: boolean;
  turnProjections: Map<AgentRun, { id: string; message?: TurnStateMessage; projected: boolean }>;
  abortNote: SystemNoteMessage;
  abortNoteProjected: boolean;
  targets: Map<RunExecution, StopTarget>;
}

export class RuntimeKernel implements RuntimeKernelLike {
  private readonly executionCoordinator: RuntimeExecutionCoordinator;
  private runtimeDraining = false;
  private runtimeDrain: RuntimeExecutionDrainHandle | undefined;
  private readonly executionsBySession = new Map<string, Set<RunExecution>>();
  private readonly active = new Map<string, ActiveSession>();
  private readonly childActive = new Map<string, ActiveSession>();
  private readonly stopOperations = new Map<string, StopOperation>();
  private readonly stopAttempts = new Map<string, Promise<void>>();
  private readonly pendingTurnStarts = new Map<string, number>();
  private readonly historyCompactCheckpoints = new Map<
    string,
    HistoryCompactCheckpoint | undefined
  >();
  private readonly historyCompactCheckpointLoads = new Map<
    string,
    Promise<HistoryCompactCheckpoint | undefined>
  >();
  private readonly historyCompactCheckpointWrites = new Map<string, Promise<void>>();
  private readonly historyCompactCleanupWrites = new Map<string, Promise<void>>();
  private readonly pendingContinuationClaims = new Set<string>();
  private readonly pendingContinuationSessions = new Set<string>();
  private readonly steeringBySession = new Map<string, SessionSteeringState>();
  private readonly backendInvalidations = new Set<string>();
  private readonly backendDisposalFailures = new Map<string, { error: unknown }>();
  private readonly backendDisposals = new Map<string, Promise<void>>();

  constructor(private readonly deps: RuntimeKernelDeps) {
    if (deps.runStore && !deps.runtimeEventStore) {
      throw new Error('RuntimeEventStore is required when AgentRunStore is configured');
    }
    this.executionCoordinator = new RuntimeExecutionCoordinator(deps.execution);
  }

  installInteractionFailStop(
    error: RuntimeInteractionFailStopError,
  ): RuntimeInteractionFailStopHandle {
    return this.executionCoordinator.installFailStop(error);
  }

  beginRuntimeDrain(): RuntimeExecutionDrainHandle {
    if (this.runtimeDrain) return this.runtimeDrain;
    const fenced = this.executionCoordinator.beginCleanDrain();
    this.runtimeDraining = true;
    const isolation = fenced.executions.map((execution) => execution.beginCleanIsolation());
    const stop = this.stopExecutions(fenced.executions, { source: undefined }, 'redirect');
    const ownerIsolationDrain = settleRuntimeTasks([
      stop,
      ...isolation,
      ...fenced.executions.map((execution) => execution.waitForHostOwnerRelease()),
    ]).then(() => COMPOSITION_SUCCESSOR_EFFECTS_ISOLATED);
    this.runtimeDrain = Object.freeze({
      ownerIsolationDrain,
      reclaimDrain: fenced.reclaimDrain,
    });
    observeRuntimeTask(this.runtimeDrain.ownerIsolationDrain);
    observeRuntimeTask(this.runtimeDrain.reclaimDrain);
    return this.runtimeDrain;
  }

  async *startTurn(
    sessionId: string,
    input: UserMessageInput,
    options: TurnStartOptions = {},
  ): AsyncIterable<SessionEvent> {
    if (this.pendingContinuationSessions.has(sessionId)) {
      throw new Error('Cannot start a turn while a runtime continuation is being claimed');
    }
    const runId = options.runId ?? this.deps.newId();
    const execution = this.enterExecution(sessionId, input.turnId, runId);
    this.pendingTurnStarts.set(sessionId, (this.pendingTurnStarts.get(sessionId) ?? 0) + 1);
    let pending = true;
    try {
      execution.throwIfFailed();
      const header = await execution.wait(this.deps.store.readHeader(sessionId));
      execution.throwIfFailed();
      const workspaceIdentity =
        this.deps.safeBoundaryResumeEnabled === true && this.deps.inspectContinuationSafety
          ? (await execution.wait(this.deps.inspectContinuationSafety(sessionId))).workspaceIdentity
          : undefined;
      const run = new AgentRun({
        sessionId,
        header,
        userInput: input,
        runId,
        userMessageId: options.userMessageId,
        durability: options.durability,
        store: this.deps.store,
        runStore: this.deps.runStore,
        runtimeEventStore: this.deps.runtimeEventStore,
        ...(runtimeToolBoundaryProtocol(this.deps, header)
          ? { toolBoundaryProtocol: runtimeToolBoundaryProtocol(this.deps, header) }
          : {}),
        repairRunRuntimeLedger: this.deps.repairRunRuntimeLedger,
        newId: this.deps.newId,
        now: this.deps.now,
        ...(workspaceIdentity ? { workspaceIdentity } : {}),
        assertExecutionActive: () => execution.throwIfFailed(),
        hooks: {
          ensureActive: (targetSessionId, nextHeader) =>
            this.ensureExecutionBackend(execution, () =>
              this.ensureActive(targetSessionId, nextHeader),
            ),
          registerRun: (active, activeRun) => {
            this.registerParentRun(active, activeRun);
            if (pending) {
              pending = false;
              this.finishPendingTurnStart(sessionId, true);
            }
          },
          unregisterRun: (active, activeRun) => this.unregisterParentRun(active, activeRun),
          updateHeader: (targetSessionId, patch) => this.updateHeader(targetSessionId, patch),
          updateStatus: (targetSessionId, status, blockedReason, ts) =>
            this.updateStatus(targetSessionId, status, blockedReason, ts),
          appendTurnState: (targetSessionId, turnId, status, lineage, options) =>
            this.appendTurnState(targetSessionId, turnId, status, lineage, options),
        },
      });
      yield* this.runAgentTurn(
        sessionId,
        input,
        run,
        execution,
        true,
        options.onRunStarted
          ? (startedRunId) => options.onRunStarted?.(startedRunId, header)
          : undefined,
      );
    } finally {
      if (pending) this.finishPendingTurnStart(sessionId, false);
      execution.release();
    }
  }

  async *resumeContinuation(continuation: RuntimeContinuation): AsyncIterable<SessionEvent> {
    const claimKey = [
      continuation.sessionId,
      continuation.sourceRunId,
      continuation.sourceRuntimeEventHighWater,
    ].join(':');
    if (this.pendingContinuationClaims.has(claimKey)) {
      throw new Error('Runtime continuation source claim is already in progress');
    }
    if (this.pendingContinuationSessions.has(continuation.sessionId)) {
      throw new Error('Runtime continuation session claim is already in progress');
    }
    this.pendingContinuationClaims.add(claimKey);
    this.pendingContinuationSessions.add(continuation.sessionId);
    try {
      yield* this.resumeContinuationClaimed(continuation);
    } finally {
      this.pendingContinuationClaims.delete(claimKey);
      this.pendingContinuationSessions.delete(continuation.sessionId);
    }
  }

  private async *resumeContinuationClaimed(
    continuation: RuntimeContinuation,
  ): AsyncIterable<SessionEvent> {
    if (!this.deps.runStore || !this.deps.runtimeEventStore) {
      throw new Error('Runtime continuation requires AgentRunStore and RuntimeEventStore');
    }
    if (
      this.hasActiveRuns(continuation.sessionId) ||
      (this.pendingTurnStarts.get(continuation.sessionId) ?? 0) > 0
    ) {
      throw new Error('Cannot continue while another run is active');
    }

    const header = await this.deps.store.readHeader(continuation.sessionId);
    const sourceRun = await this.deps.runStore.readRun(
      continuation.sessionId,
      continuation.sourceRunId,
    );
    const sourceEvents = await this.deps.runtimeEventStore.readRuntimeEvents(
      continuation.sessionId,
      continuation.sourceRunId,
    );
    assertContinuationSourceUnchanged(continuation, sourceRun, sourceEvents, header.cwd);
    if (!this.deps.inspectContinuationSafety) {
      throw new Error('Runtime continuation requires an authoritative safety inspector');
    }
    const observation = await this.deps.inspectContinuationSafety(continuation.sessionId);
    assertContinuationSafetyUnchanged(continuation, observation);

    const sessionRuns = await this.deps.runStore.listSessionRuns(continuation.sessionId);
    const existingClaim = sessionRuns.find(
      (runHeader) =>
        runHeader.continuationSource?.sourceRunId === continuation.sourceRunId &&
        runHeader.continuationSource.sourceRuntimeEventHighWater ===
          continuation.sourceRuntimeEventHighWater,
    );
    if (existingClaim) {
      throw new RuntimeContinuationRevalidationError(
        'continuation_claim_conflict',
        `Runtime continuation source already has a continuation child: ${existingClaim.runId}`,
      );
    }
    const existingTarget = sessionRuns.find((runHeader) => runHeader.runId === continuation.runId);
    if (existingTarget) {
      throw new RuntimeContinuationRevalidationError(
        'target_run_conflict',
        'Runtime continuation target run already exists',
      );
    }

    const execution = this.enterExecution(
      continuation.sessionId,
      continuation.turnId,
      continuation.runId,
    );
    try {
      const userInput: UserMessageInput = {
        turnId: continuation.turnId,
        text: '',
        parentRunId: continuation.sourceRunId,
        parentTurnId: continuation.sourceTurnId,
      };
      const run = new AgentRun({
        sessionId: continuation.sessionId,
        header,
        userInput,
        runId: continuation.runId,
        invocationId: continuation.invocationId,
        store: this.deps.store,
        runStore: this.deps.runStore,
        runtimeEventStore: this.deps.runtimeEventStore,
        ...(runtimeToolBoundaryProtocol(this.deps, header)
          ? { toolBoundaryProtocol: runtimeToolBoundaryProtocol(this.deps, header) }
          : {}),
        repairRunRuntimeLedger: this.deps.repairRunRuntimeLedger,
        newId: this.deps.newId,
        now: this.deps.now,
        workspaceIdentity: continuation.safetySnapshot.workspaceIdentity,
        effectiveOrchestration: effectiveOrchestrationForRun(sourceRun, header),
        continuationFailpoint: this.deps.continuationFailpoint,
        assertExecutionActive: () => execution.throwIfFailed(),
        hooks: {
          ensureActive: (targetSessionId, nextHeader) =>
            this.ensureExecutionBackend(execution, () =>
              this.ensureActive(targetSessionId, nextHeader),
            ),
          registerRun: (active, activeRun) => this.registerParentRun(active, activeRun),
          unregisterRun: (active, activeRun) => this.unregisterParentRun(active, activeRun),
          updateHeader: (targetSessionId, patch) => this.updateHeader(targetSessionId, patch),
          updateStatus: (targetSessionId, status, blockedReason, ts) =>
            this.updateStatus(targetSessionId, status, blockedReason, ts),
          appendTurnState: (targetSessionId, turnId, status, lineage, options) =>
            this.appendTurnState(targetSessionId, turnId, status, lineage, options),
        },
      });

      yield* this.runAgentContinuation(continuation, run, execution);
    } finally {
      execution.release();
    }
  }

  async *compactSession(
    sessionId: string,
    input: CompactSessionInput = {},
  ): AsyncIterable<SessionEvent> {
    if (this.pendingContinuationSessions.has(sessionId)) {
      throw new Error('Cannot compact while a runtime continuation is being claimed.');
    }
    const turnId = input.turnId ?? this.deps.newId();
    const runId = this.deps.newId();
    const execution = this.enterExecution(sessionId, turnId, runId);
    try {
      execution.throwIfFailed();
      if (!this.deps.runStore || !this.deps.runtimeEventStore) {
        throw new Error('Runtime compaction requires AgentRunStore and RuntimeEventStore');
      }
      if (this.hasActiveRuns(sessionId)) {
        throw new Error('Cannot compact while a turn is running; wait for the turn to finish.');
      }

      const header = await execution.wait(this.deps.store.readHeader(sessionId));
      const run = new AgentRun({
        sessionId,
        header,
        userInput: { turnId, text: '' },
        runId,
        store: this.deps.store,
        runStore: this.deps.runStore,
        runtimeEventStore: this.deps.runtimeEventStore,
        ...(runtimeToolBoundaryProtocol(this.deps, header)
          ? { toolBoundaryProtocol: runtimeToolBoundaryProtocol(this.deps, header) }
          : {}),
        repairRunRuntimeLedger: this.deps.repairRunRuntimeLedger,
        newId: this.deps.newId,
        now: this.deps.now,
        effectiveOrchestration: resolveEffectiveOrchestration('default', undefined),
        assertExecutionActive: () => execution.throwIfFailed(),
        hooks: {
          ensureActive: (targetSessionId, nextHeader) =>
            this.ensureExecutionBackend(execution, () =>
              this.ensureActive(targetSessionId, nextHeader),
            ),
          registerRun: (active, activeRun) => this.registerParentRun(active, activeRun),
          unregisterRun: (active, activeRun) => this.unregisterParentRun(active, activeRun),
          updateHeader: (targetSessionId, patch) => this.updateHeader(targetSessionId, patch),
          updateStatus: (targetSessionId, status, blockedReason, ts) =>
            this.updateStatus(targetSessionId, status, blockedReason, ts),
          appendTurnState: (targetSessionId, nextTurnId, status, lineage, options) =>
            this.appendTurnState(targetSessionId, nextTurnId, status, lineage, options),
        },
      });

      const begin = await execution.begin(run, () => run.beginOperation());

      let terminalSettled = false;
      try {
        if (run.isStopped()) return;
        if (!begin.backend.compactHistory)
          throw new Error(`Backend ${header.backend} does not support runtime compaction`);
        const result = await execution.wait(
          execution.runReclaim(() =>
            begin.backend.compactHistory!({
              turnId: run.turnId,
              runtimeContext: begin.runtimeContext,
            }),
          ),
        );
        if (run.isStopped()) return;
        const tokenUsageEvent: TokenUsageEvent = {
          type: 'token_usage',
          id: this.deps.newId(),
          turnId: run.turnId,
          ts: this.deps.now(),
          input: 0,
          output: 0,
          ...(result.contextBudget ? { contextBudget: result.contextBudget } : {}),
        };
        const completeEvent: CompleteEvent = {
          type: 'complete',
          id: this.deps.newId(),
          turnId: run.turnId,
          ts: this.deps.now(),
          stopReason: 'end_turn',
        };
        const invocation = this.compactInvocationContext({
          sessionId,
          runId: run.runId,
          turnId: run.turnId,
          startedAt: begin.startedAt,
        });
        await execution.wait(
          run.acceptMappedEvent(
            tokenUsageEvent,
            mapSessionEventToRuntimeEvent(tokenUsageEvent, invocation),
            { requireTerminalWrite: true },
          ),
        );
        if (run.isStopped()) return;
        await execution.wait(run.recordStoredSessionEvent(tokenUsageEvent));
        if (run.isStopped()) return;
        if (shouldAppendContextCompactionFailedOpenNote(result.contextBudget)) {
          execution.throwIfFailed();
          const note: SystemNoteMessage = {
            type: 'system_note',
            id: this.deps.newId(),
            turnId: run.turnId,
            ts: this.deps.now(),
            kind: 'context_compaction_failed_open',
          };
          await execution.wait(this.deps.store.appendMessage(sessionId, note).catch(() => {}));
        }
        yield tokenUsageEvent;
        execution.throwIfFailed();
        if (run.isStopped()) return;
        const completeRuntimeEvent = mapSessionEventToRuntimeEvent(completeEvent, invocation);
        const closureReason = execution.claimTerminalEvent(completeRuntimeEvent);
        await execution.closeForClaim(closureReason);
        await execution.wait(
          run.acceptMappedEvent(completeEvent, completeRuntimeEvent, {
            requireTerminalWrite: true,
          }),
        );
        execution.throwIfFailed();
        if (run.isStopped()) return;
        terminalSettled = true;
        yield completeEvent;
      } catch (error) {
        if (execution.canonicalError) throw execution.canonicalError;
        if (isRuntimeLifecycleFatal(error)) throw error;
        await execution.failRun(error);
        terminalSettled = true;
        throw error;
      } finally {
        if (!execution.canonicalError) {
          if (!terminalSettled && !run.hasStopClaim()) {
            await execution.failRun(new RuntimeEventConsumerAbandonedError(run.runId));
          }
          await execution.finalize();
        }
      }
    } finally {
      execution.release();
    }
  }

  async *startChildTurn(
    sessionId: string,
    input: ChildAgentTurnInput,
    options: ChildTurnStartOptions = {},
  ): AsyncIterable<SessionEvent> {
    if (this.pendingContinuationSessions.has(sessionId)) {
      throw new Error('Cannot start a child turn while a runtime continuation is being claimed.');
    }
    const runId = this.deps.newId();
    const execution = this.enterExecution(sessionId, input.turnId, runId);
    try {
      execution.throwIfFailed();
      const parentHeader = await execution.wait(this.deps.store.readHeader(sessionId));
      execution.throwIfFailed();
      const definition = requireResolvedAgentDefinition(input.spec.id);
      const availableChildTools = this.deps.childTools ?? [];
      assertAgentDefinitionRunnable({
        parentPermissionMode: parentHeader.permissionMode,
        definition,
        tools: availableChildTools,
      });
      const childTools = buildToolsForAgentDefinition(availableChildTools, definition);
      const expertIdentity = parseExpertAgentId(definition.id);
      const agentTeam: AgentTeamExecutionContext | undefined = expertIdentity
        ? {
            role: 'member',
            teamId: expertIdentity.teamId,
            agentId: definition.id,
            parentRunId: input.parentRunId,
          }
        : undefined;
      const childHeader: SessionHeader = {
        ...parentHeader,
        permissionMode: definition.permissionMode,
        connectionLocked: true,
      };
      const userInput: UserMessageInput = {
        turnId: input.turnId,
        text: input.prompt,
        parentRunId: input.parentRunId,
        ...(input.resumedFromRunId ? { resumedFromRunId: input.resumedFromRunId } : {}),
        agentId: definition.id,
        agentName: definition.name,
      };
      const activeKey = childActiveKey(sessionId, input.turnId);
      const run = new AgentRun({
        sessionId,
        header: childHeader,
        userInput,
        runId,
        store: this.deps.store,
        runStore: this.deps.runStore,
        runtimeEventStore: this.deps.runtimeEventStore,
        ...(runtimeToolBoundaryProtocol(this.deps, childHeader)
          ? { toolBoundaryProtocol: runtimeToolBoundaryProtocol(this.deps, childHeader) }
          : {}),
        repairRunRuntimeLedger: this.deps.repairRunRuntimeLedger,
        newId: this.deps.newId,
        now: this.deps.now,
        effectiveOrchestration: resolveEffectiveOrchestration('default', undefined),
        recordSessionMessages: false,
        assertExecutionActive: () => execution.throwIfFailed(),
        hooks: {
          ensureActive: (targetSessionId, nextHeader) =>
            this.ensureExecutionBackend(execution, () =>
              this.ensureChildActive(
                activeKey,
                targetSessionId,
                nextHeader,
                definition.systemPrompt,
                childTools,
                agentTeam,
              ),
            ),
          registerRun: (active, activeRun) => {
            this.registerChildRun(activeKey, active, activeRun);
          },
          unregisterRun: (active, activeRun) =>
            this.unregisterChildRun(activeKey, active, activeRun),
          updateHeader: async (_targetSessionId, patch) => ({ ...childHeader, ...patch }),
          updateStatus: async () => {},
          appendTurnState: async () => {},
        },
      });

      yield* this.runAgentTurn(sessionId, userInput, run, execution, false, options.onRunStarted);
    } finally {
      execution.release();
    }
  }

  async *startChildRetry(
    sessionId: string,
    input: ChildAgentRetryInput,
    options: ChildTurnStartOptions = {},
  ): AsyncIterable<SessionEvent> {
    const { continuation } = input;
    if (continuation.sessionId !== sessionId) {
      throw new Error('Child retry continuation belongs to a different session');
    }
    if (this.pendingContinuationSessions.has(sessionId)) {
      throw new Error('Cannot retry a child turn while a runtime continuation is being claimed.');
    }
    const execution = this.enterExecution(sessionId, continuation.turnId, continuation.runId);
    try {
      execution.throwIfFailed();
      const parentHeader = await execution.wait(this.deps.store.readHeader(sessionId));
      execution.throwIfFailed();
      const definition = requireResolvedAgentDefinition(input.spec.id);
      const availableChildTools = this.deps.childTools ?? [];
      assertAgentDefinitionRunnable({
        parentPermissionMode: parentHeader.permissionMode,
        definition,
        tools: availableChildTools,
      });
      const childTools = buildToolsForAgentDefinition(availableChildTools, definition);
      const expertIdentity = parseExpertAgentId(definition.id);
      const agentTeam: AgentTeamExecutionContext | undefined = expertIdentity
        ? {
            role: 'member',
            teamId: expertIdentity.teamId,
            agentId: definition.id,
            parentRunId: input.parentRunId,
          }
        : undefined;
      const childHeader: SessionHeader = {
        ...parentHeader,
        permissionMode: definition.permissionMode,
        connectionLocked: true,
      };
      const userInput: UserMessageInput = {
        turnId: continuation.turnId,
        text: '',
        parentRunId: input.parentRunId,
        retriedFromRunId: continuation.sourceRunId,
        agentId: definition.id,
        agentName: definition.name,
      };
      const activeKey = childActiveKey(sessionId, continuation.turnId);
      const run = new AgentRun({
        sessionId,
        header: childHeader,
        userInput,
        runId: continuation.runId,
        invocationId: continuation.invocationId,
        store: this.deps.store,
        runStore: this.deps.runStore,
        runtimeEventStore: this.deps.runtimeEventStore,
        ...(runtimeToolBoundaryProtocol(this.deps, childHeader)
          ? { toolBoundaryProtocol: runtimeToolBoundaryProtocol(this.deps, childHeader) }
          : {}),
        repairRunRuntimeLedger: this.deps.repairRunRuntimeLedger,
        newId: this.deps.newId,
        now: this.deps.now,
        workspaceIdentity: continuation.safetySnapshot.workspaceIdentity,
        effectiveOrchestration: resolveEffectiveOrchestration('default', undefined),
        recordSessionMessages: false,
        assertExecutionActive: () => execution.throwIfFailed(),
        hooks: {
          ensureActive: (targetSessionId, nextHeader) =>
            this.ensureExecutionBackend(execution, () =>
              this.ensureChildActive(
                activeKey,
                targetSessionId,
                nextHeader,
                definition.systemPrompt,
                childTools,
                agentTeam,
              ),
            ),
          registerRun: (active, activeRun) =>
            this.registerChildRun(activeKey, active, activeRun),
          unregisterRun: (active, activeRun) =>
            this.unregisterChildRun(activeKey, active, activeRun),
          updateHeader: async (_targetSessionId, patch) => ({ ...childHeader, ...patch }),
          updateStatus: async () => {},
          appendTurnState: async () => {},
        },
      });

      // A provider retry replays the source ledger without recording a second
      // user prompt and without turning the child into a session continuation.
      yield* this.runAgentContinuation(
        continuation,
        run,
        execution,
        false,
        options.onRunStarted,
      );
    } finally {
      execution.release();
    }
  }

  private async *runAgentTurn(
    sessionId: string,
    input: UserMessageInput,
    run: AgentRun,
    execution: RunExecution,
    steering = false,
    onRunStarted?: (runId: string) => void | Promise<void>,
  ): AsyncIterable<SessionEvent> {
    const sessionEvents = new AsyncEventQueue<SessionEvent>();
    let flowDone = false;
    let interactionFailure:
      | RuntimeInteractionFailStopError
      | RuntimeInteractionInvariantError
      | undefined;
    let expectedInteractionStopCancellation = false;
    execution.onFailStop((error) => {
      interactionFailure ??= error;
      sessionEvents.fail(error);
    });
    const begin: AgentRunBeginResult = await execution.begin(run, () => run.begin());
    if (onRunStarted) {
      try {
        await execution.wait(
          execution.runSuccessorEffect('run_started_callback', async () => {
            execution.throwIfFailed();
            if (run.hasStopClaim()) return;
            await onRunStarted(run.runId);
          }),
        );
      } catch (error) {
        if (execution.canonicalError) throw execution.canonicalError;
        if (isRuntimeLifecycleFatal(error)) throw error;
        await execution.failRun(error);
        await execution.finalize();
        throw error;
      }
    }

    if (run.hasStopClaim()) {
      await execution.waitLogical(run.waitForStopCompletion());
      await execution.finalize();
      return;
    }
    const hostedMessageOwner =
      steering && this.deps.execution.kind === 'hosted'
        ? execution.bindMessageOwner()
        : undefined;
    // Steering is a top-level-turn affordance only; child agent turns run
    // without a queue. Ownership is established only AFTER run.begin()
    // succeeds (a failed begin must not leak a live owner into the next turn)
    // and is bound to this run's turnId: the pull hook re-checks that identity
    // so a stale or overlapping run can never drain messages queued for the
    // current owner. Released in the finally below, which covers every path
    // from here to turn end.
    let pullSteering: (() => readonly SteeringLease[]) | undefined;
    let ackSteering: ((leaseIds: readonly string[]) => void) | undefined;
    let nackSteering: ((leaseIds: readonly string[]) => void) | undefined;
    if (steering && this.deps.execution.kind === 'embedded') {
      const state = this.ensureSteering(sessionId);
      state.sink = (event) => {
        void sessionEvents.push(event).catch(() => {});
      };
      state.activeTurnId = run.turnId;
      // Lease, don't consume: pulled messages move to in-flight and only an
      // ack (durable + injected) removes them; a nack or a retract/clear/
      // release reclaims them, so an abort window can never drop text.
      pullSteering = () => {
        const current = this.steeringBySession.get(sessionId);
        if (!current || current.activeTurnId !== run.turnId) return [];
        if (current.steering.length === 0) return [];
        const leased = current.steering.splice(0);
        current.inFlight.push(
          ...leased.map((message) => ({ ...message, issuingTurnId: run.turnId })),
        );
        return leased.map((message) => ({ ...message }));
      };
      // Settlement is keyed by lease id + issuing turn, NOT by current
      // ownership: an overlapping turn that takes the owner slot must not
      // invalidate the issuer's ack (the message was delivered to ITS
      // provider) or intercept its nack. A late settle for a reclaimed lease
      // finds no match and is a no-op.
      ackSteering = (leaseIds) => {
        const current = this.steeringBySession.get(sessionId);
        if (!current) return;
        const ids = new Set(leaseIds);
        const before = current.inFlight.length;
        current.inFlight = current.inFlight.filter(
          (message) => !(ids.has(message.id) && message.issuingTurnId === run.turnId),
        );
        if (current.inFlight.length !== before) this.emitQueueUpdate(sessionId, current);
      };
      nackSteering = (leaseIds) => {
        const current = this.steeringBySession.get(sessionId);
        if (!current) return;
        const ids = new Set(leaseIds);
        const returned = current.inFlight.filter(
          (message) => ids.has(message.id) && message.issuingTurnId === run.turnId,
        );
        if (returned.length === 0) return;
        current.inFlight = current.inFlight.filter(
          (message) => !(ids.has(message.id) && message.issuingTurnId === run.turnId),
        );
        if (current.activeTurnId === run.turnId) {
          // Back to the FRONT of the queue: a re-pull at the next step
          // boundary preserves the user's original ordering.
          current.steering = [
            ...returned.map(({ id, messageId, text }) => ({ id, messageId, text })),
            ...current.steering,
          ];
        } else {
          // The issuer no longer owns the queue (an overlapping turn took
          // over and possibly released): it will never pull again, so the
          // steering queue would strand the text ownerless. The followup
          // queue is its only safe home — the same direction a release-time
          // fold takes.
          current.followup = [...returned.map((message) => message.text), ...current.followup];
        }
        this.emitQueueUpdate(sessionId, current);
      };
    }
    if (hostedMessageOwner) {
      pullSteering = () => hostedMessageOwner.pull();
      ackSteering = (leaseIds) => hostedMessageOwner.ack(leaseIds);
      nackSteering = (leaseIds) => hostedMessageOwner.nack(leaseIds);
    }

    const finishFlow = async (): Promise<void> => {
      if (flowDone) return;
      flowDone = true;
      try {
        await execution.finalize();
        execution.throwIfFailed();
        // Release ownership before closing the stream so the final queue
        // snapshot can still be delivered to its active sink.
        if (steering && this.deps.execution.kind === 'embedded') {
          this.releaseSteeringTurn(sessionId, run.turnId);
        }
        sessionEvents.close();
      } catch (error) {
        const failure = execution.canonicalError ?? error;
        if (isRuntimeLifecycleFatal(failure)) {
          interactionFailure ??= failure;
        }
        sessionEvents.fail(failure);
        throw failure;
      }
    };

    let terminalAccepted = false;
    const aiSdkFlow = new AiSdkFlow({
      backend: begin.backend,
      drainAfterTerminal: true,
      ...(this.deps.execution.kind === 'hosted'
        ? { interactionProjection: 'host-owned' as const }
        : {}),
      onSessionEvent: async (sessionEvent, runtimeEvent) => {
        execution.throwIfFailed();
        if (sessionEvent.type === 'error') {
          const closureReason = run.claimFailureTerminal(
            Object.assign(new Error(sessionEvent.message), {
              name: sessionEvent.reason ?? sessionEvent.code ?? 'RuntimeSessionError',
            }),
          );
          await execution.closeForClaim(closureReason);
        } else if (isTerminalRuntimeEvent(runtimeEvent)) {
          // The exact AgentRun claim is synchronous and therefore wins before
          // the first durable Interaction closure await.
          const closureReason = execution.claimTerminalEvent(runtimeEvent);
          await execution.closeForClaim(closureReason);
          terminalAccepted = true;
        }
        execution.throwIfFailed();
        await execution.wait(
          run.acceptMappedEvent(sessionEvent, runtimeEvent, {
            requireTerminalWrite: Boolean(this.deps.runtimeEventStore),
          }),
        );
        execution.throwIfFailed();
        await execution.wait(sessionEvents.push(sessionEvent));
      },
      onError: async (error) => {
        const canonicalError = execution.canonicalError;
        if (canonicalError) {
          interactionFailure ??= canonicalError;
          sessionEvents.fail(canonicalError);
          return;
        }
        if (execution.isExpectedStop(error, this.runtimeDraining)) {
          expectedInteractionStopCancellation = true;
          return;
        }
        if (isRuntimeLifecycleFatal(error)) {
          interactionFailure ??= error;
          sessionEvents.fail(error);
          return;
        }
        if (!isAsyncEventQueueClosed(error)) {
          try {
            await execution.failRun(error);
            execution.throwIfFailed();
            sessionEvents.fail(error);
          } catch (callbackError) {
            if (isRuntimeLifecycleFatal(callbackError)) {
              interactionFailure ??= callbackError;
              sessionEvents.fail(callbackError);
            }
            throw callbackError;
          }
        }
      },
      onFinally: async () => {
        if (interactionFailure || execution.canonicalError) return;
        if (run.hasPendingStop()) return;
        await finishFlow();
      },
    });
    const runner = new RuntimeRunner({
      flow: aiSdkFlow,
      providers: { newId: this.deps.newId, now: this.deps.now },
      stopOnTerminal: false,
      ...(run.toolBoundaryProtocol ? { toolBoundaryProtocol: run.toolBoundaryProtocol } : {}),
    });
    const runnerResult = execution.runReclaim(() =>
      runner
        .run({
          sessionId,
          invocationId: begin.initialRuntimeEvent.invocationId,
          runId: run.runId,
          turnId: run.turnId,
          ...(begin.backendInput.orchestration
            ? { orchestration: begin.backendInput.orchestration }
            : {}),
          text: input.text,
          ...(begin.backendInput.attachments
            ? { attachments: begin.backendInput.attachments }
            : {}),
          ...(begin.backendInput.quotes ? { quotes: begin.backendInput.quotes } : {}),
          context: begin.backendInput.context,
          ...(begin.backendInput.runtimeContext !== undefined
            ? { runtimeContext: begin.backendInput.runtimeContext }
            : {}),
          initialRuntimeEvent: begin.initialRuntimeEvent,
          source: this.deps.runtimeSource ?? 'desktop',
          lineage: run.lineage,
          ...(pullSteering ? { pullSteering } : {}),
          ...(ackSteering ? { ackSteering } : {}),
          ...(nackSteering ? { nackSteering } : {}),
        })
        .then(
          async (result) => {
            if (execution.canonicalError) throw execution.canonicalError;
            if (interactionFailure) throw interactionFailure;
            await finishFlow();
            if (!expectedInteractionStopCancellation) {
              execution.throwIfFailed();
              await this.deps.runtimeInvocationObserver?.(result);
              execution.throwIfFailed();
            }
            return result;
          },
          async (error) => {
            const failure = execution.canonicalError ?? error;
            if (isRuntimeLifecycleFatal(failure)) {
              interactionFailure ??= failure;
              sessionEvents.fail(failure);
              throw failure;
            }
            if (
              !execution.canonicalError &&
              !interactionFailure &&
              expectedInteractionStopCancellation &&
              execution.isExpectedStop(failure, this.runtimeDraining)
            ) {
              await finishFlow();
              return undefined;
            }
            try {
              await execution.failRun(failure);
              if (run.hasStopClaim()) {
                await finishFlow();
                return undefined;
              }
              execution.throwIfFailed();
              sessionEvents.fail(failure);
              await finishFlow();
            } catch (callbackError) {
              const callbackFailure = execution.canonicalError ?? callbackError;
              if (isRuntimeLifecycleFatal(callbackFailure)) {
                interactionFailure ??= callbackFailure;
              }
              sessionEvents.fail(callbackFailure);
              throw callbackFailure;
            }
            throw failure;
          },
        ),
    );
    // The event consumer may remain backpressured after the runner rejects.
    // This observer always fulfills; the control flow below awaits runnerResult.
    void runnerResult.catch(() => undefined);

    let consumerCompleted = false;
    let consumerFailure: unknown;
    let abandonmentFailure: unknown;
    let abandoned = false;
    try {
      try {
        for await (const event of sessionEvents) {
          yield event;
        }
        consumerCompleted = true;
        await execution.wait(runnerResult);
      } catch (error) {
        consumerFailure = error;
        throw error;
      }
    } finally {
      if (
        !consumerCompleted &&
        consumerFailure === undefined &&
        !terminalAccepted &&
        !interactionFailure &&
        !execution.canonicalError
      ) {
        abandoned = true;
        const abandonError = new RuntimeEventConsumerAbandonedError(run.runId);
        try {
          await execution.abandon(
            abandonError,
            () => sessionEvents.close(),
            () => begin.backend.stop('redirect'),
          );
        } catch (error) {
          abandonmentFailure = error;
        }
      } else if (!flowDone && !interactionFailure && !execution.canonicalError) {
        sessionEvents.close();
      }
      let runnerFailure: unknown;
      if (!abandoned && !interactionFailure && !execution.canonicalError) {
        try {
          await execution.wait(runnerResult);
        } catch (error) {
          runnerFailure = error;
        }
      }
      if (steering && this.deps.execution.kind === 'embedded') {
        this.releaseSteeringTurn(sessionId, run.turnId);
      }
      if (execution.canonicalError) throw execution.canonicalError;
      if (abandonmentFailure !== undefined) throw abandonmentFailure;
      if (isRuntimeLifecycleFatal(runnerFailure)) {
        throw runnerFailure;
      }
    }
  }

  private async *runAgentContinuation(
    continuation: RuntimeContinuation,
    run: AgentRun,
    execution: RunExecution,
    persistContinuationSource = true,
    onRunStarted?: (runId: string) => void | Promise<void>,
  ): AsyncIterable<SessionEvent> {
    const sessionEvents = new AsyncEventQueue<SessionEvent>();
    let flowDone = false;
    let interactionFailure:
      | RuntimeInteractionFailStopError
      | RuntimeInteractionInvariantError
      | undefined;
    let expectedInteractionStopCancellation = false;
    let terminalAccepted = false;
    execution.onFailStop((error) => {
      interactionFailure ??= error;
      sessionEvents.fail(error);
    });

    const begin = await execution.begin(run, () =>
      persistContinuationSource ? run.beginContinuation(continuation) : run.beginOperation(),
    );
    if (onRunStarted) {
      try {
        await execution.wait(
          execution.runSuccessorEffect('run_started_callback', async () => {
            execution.throwIfFailed();
            if (run.hasStopClaim()) return;
            await onRunStarted(run.runId);
          }),
        );
      } catch (error) {
        if (execution.canonicalError) throw execution.canonicalError;
        if (isRuntimeLifecycleFatal(error)) throw error;
        await execution.failRun(error);
        await execution.finalize();
        throw error;
      }
    }
    if (run.hasStopClaim()) {
      await execution.waitLogical(run.waitForStopCompletion());
      await execution.finalize();
      return;
    }

    const finishFlow = async (): Promise<void> => {
      if (flowDone) return;
      flowDone = true;
      try {
        await execution.finalize();
        execution.throwIfFailed();
        sessionEvents.close();
      } catch (error) {
        const failure = execution.canonicalError ?? error;
        if (isRuntimeLifecycleFatal(failure)) interactionFailure ??= failure;
        sessionEvents.fail(failure);
        throw failure;
      }
    };

    const aiSdkFlow = new AiSdkFlow({
      backend: begin.backend,
      drainAfterTerminal: true,
      ...(this.deps.execution.kind === 'hosted'
        ? { interactionProjection: 'host-owned' as const }
        : {}),
      onSessionEvent: async (sessionEvent, runtimeEvent) => {
        execution.throwIfFailed();
        if (sessionEvent.type === 'error') {
          const closureReason = run.claimFailureTerminal(
            Object.assign(new Error(sessionEvent.message), {
              name: sessionEvent.reason ?? sessionEvent.code ?? 'RuntimeSessionError',
            }),
          );
          await execution.closeForClaim(closureReason);
        } else if (isTerminalRuntimeEvent(runtimeEvent)) {
          const closureReason = execution.claimTerminalEvent(runtimeEvent);
          await execution.closeForClaim(closureReason);
          terminalAccepted = true;
        }
        execution.throwIfFailed();
        await execution.wait(
          run.acceptMappedEvent(sessionEvent, runtimeEvent, { requireTerminalWrite: true }),
        );
        execution.throwIfFailed();
        await execution.wait(sessionEvents.push(sessionEvent));
      },
      onError: async (error) => {
        const canonicalError = execution.canonicalError;
        if (canonicalError) {
          interactionFailure ??= canonicalError;
          sessionEvents.fail(canonicalError);
          return;
        }
        if (execution.isExpectedStop(error, this.runtimeDraining)) {
          expectedInteractionStopCancellation = true;
          return;
        }
        if (isRuntimeLifecycleFatal(error)) {
          interactionFailure ??= error;
          sessionEvents.fail(error);
          return;
        }
        if (!isAsyncEventQueueClosed(error)) {
          await execution.failRun(error);
          execution.throwIfFailed();
          sessionEvents.fail(error);
        }
      },
      onFinally: async () => {
        if (interactionFailure || execution.canonicalError || run.hasPendingStop()) return;
        await finishFlow();
      },
    });
    const runner = new RuntimeRunner({
      flow: aiSdkFlow,
      providers: { newId: this.deps.newId, now: this.deps.now },
      stopOnTerminal: false,
      ...(run.toolBoundaryProtocol ? { toolBoundaryProtocol: run.toolBoundaryProtocol } : {}),
      commitContinuationStart: async (event) => {
        execution.throwIfFailed();
        await execution.wait(run.recordRuntimeEvents([event], { requireTerminalWrite: true }));
        if (persistContinuationSource) {
          await this.deps.continuationFailpoint?.('after_continuation_start_committed');
        }
        execution.throwIfFailed();
      },
    });
    const runnerResult = execution.runReclaim(() =>
      runner
        .resume(continuation, {
          source: this.deps.runtimeSource ?? 'desktop',
          orchestration: run.effectiveOrchestration,
        })
        .then(
          async (result) => {
            if (execution.canonicalError) throw execution.canonicalError;
            if (interactionFailure) throw interactionFailure;
            await finishFlow();
            if (!expectedInteractionStopCancellation) {
              execution.throwIfFailed();
              await this.deps.runtimeInvocationObserver?.(result);
              execution.throwIfFailed();
            }
            return result;
          },
          async (error) => {
            const failure = execution.canonicalError ?? error;
            if (isRuntimeLifecycleFatal(failure)) {
              interactionFailure ??= failure;
              sessionEvents.fail(failure);
              throw failure;
            }
            if (
              expectedInteractionStopCancellation &&
              execution.isExpectedStop(failure, this.runtimeDraining)
            ) {
              await finishFlow();
              return undefined;
            }
            await execution.failRun(failure);
            if (run.hasStopClaim()) {
              await finishFlow();
              return undefined;
            }
            execution.throwIfFailed();
            sessionEvents.fail(failure);
            await finishFlow();
            throw failure;
          },
        ),
    );
    void runnerResult.catch(() => undefined);

    let consumerCompleted = false;
    let consumerFailure: unknown;
    let abandonmentFailure: unknown;
    let abandoned = false;
    try {
      try {
        for await (const event of sessionEvents) yield event;
        consumerCompleted = true;
        await execution.wait(runnerResult);
      } catch (error) {
        consumerFailure = error;
        throw error;
      }
    } finally {
      if (
        !consumerCompleted &&
        consumerFailure === undefined &&
        !terminalAccepted &&
        !interactionFailure &&
        !execution.canonicalError
      ) {
        abandoned = true;
        try {
          await execution.abandon(
            new RuntimeEventConsumerAbandonedError(run.runId),
            () => sessionEvents.close(),
            () => begin.backend.stop('redirect'),
          );
        } catch (error) {
          abandonmentFailure = error;
        }
      } else if (!flowDone && !interactionFailure && !execution.canonicalError) {
        sessionEvents.close();
      }
      let runnerFailure: unknown;
      if (!abandoned && !interactionFailure && !execution.canonicalError) {
        try {
          await execution.wait(runnerResult);
        } catch (error) {
          runnerFailure = error;
        }
      }
      if (execution.canonicalError) throw execution.canonicalError;
      if (abandonmentFailure !== undefined) throw abandonmentFailure;
      if (isRuntimeLifecycleFatal(runnerFailure)) throw runnerFailure;
    }
  }

  private compactInvocationContext(input: {
    sessionId: string;
    runId: string;
    turnId: string;
    startedAt: number;
  }): InvocationContext {
    const request = {
      sessionId: input.sessionId,
      invocationId: input.runId,
      runId: input.runId,
      turnId: input.turnId,
      text: '',
      context: [],
      source: this.deps.runtimeSource ?? 'desktop',
    } satisfies InvocationContext['request'];
    return {
      sessionId: input.sessionId,
      invocationId: input.runId,
      runId: input.runId,
      turnId: input.turnId,
      source: this.deps.runtimeSource ?? 'desktop',
      startedAt: input.startedAt,
      request,
      newId: this.deps.newId,
      now: this.deps.now,
    };
  }

  stopSession(sessionId: string, input: StopSessionInput = {}): Promise<void> {
    this.executionCoordinator.throwIfClosed();
    const existing = this.stopAttempts.get(sessionId);
    if (existing) return existing;
    const executions = [...(this.executionsBySession.get(sessionId) ?? [])];
    const attempt = this.stopExecutions(executions, input, 'user_stop').finally(() => {
      if (this.stopAttempts.get(sessionId) === attempt) this.stopAttempts.delete(sessionId);
    });
    this.stopAttempts.set(sessionId, attempt);
    return attempt;
  }

  private async stopExecutions(
    executions: readonly RunExecution[],
    input: StopSessionInput,
    reason: 'user_stop' | 'redirect',
  ): Promise<void> {
    const bySession = new Map<string, RunExecution[]>();
    for (const execution of executions) {
      const sessionExecutions = bySession.get(execution.sessionId) ?? [];
      sessionExecutions.push(execution);
      bySession.set(execution.sessionId, sessionExecutions);
    }
    // Close every stop claim synchronously before the first Interaction await.
    for (const execution of executions) {
      execution.claimStop(input.source, reason, input.mode ?? 'immediate');
    }
    await settleRuntimeTasks(
      [...bySession].map(([sessionId, sessionExecutions]) =>
        this.stopSessionExecutions(sessionId, sessionExecutions, input, reason),
      ),
    );
  }

  private async stopSessionExecutions(
    sessionId: string,
    executions: readonly RunExecution[],
    input: StopSessionInput,
    reason: 'user_stop' | 'redirect',
  ): Promise<void> {
    this.clearSteering(sessionId);
    let operation = this.stopOperations.get(sessionId);
    if (!operation) {
      const abortSource = normalizeStopSessionSource(input.source);
      const ts = this.deps.now();
      operation = {
        abortSource,
        ts,
        statusProjected: false,
        turnProjections: new Map(),
        abortNote: {
          type: 'system_note',
          id: this.deps.newId(),
          ts,
          kind: 'abort',
          ...(abortSource ? { data: { source: abortSource } } : {}),
        },
        abortNoteProjected: false,
        targets: new Map(),
      };
    }
    for (const execution of executions) {
      if (!execution.claimStop(input.source, reason, input.mode ?? 'immediate')) continue;
      operation.targets.set(
        execution,
        operation.targets.get(execution) ?? { execution, delivered: false },
      );
    }
    if (operation.targets.size === 0) return;
    this.stopOperations.set(sessionId, operation);

    const undelivered = [...operation.targets.values()].filter((target) => !target.delivered);
    await settleRuntimeTasks(
      undelivered.map(async (target) => {
        await target.execution.deliverStop();
        target.delivered = true;
      }),
    );

    const stoppedRuns = [...operation.targets.values()]
      .map((target) => target.execution.agentRun)
      .filter((run): run is AgentRun => run !== undefined && run.hasStopClaim());
    for (const run of stoppedRuns) {
      if (run.isSessionInline() && !operation.turnProjections.has(run)) {
        operation.turnProjections.set(run, { id: this.deps.newId(), projected: false });
      }
    }

    if (!operation.statusProjected && stoppedRuns.length > 0) {
      await this.updateStatus(sessionId, 'aborted', undefined, operation.ts);
      operation.statusProjected = true;
    }
    for (const [run, projection] of operation.turnProjections) {
      if (projection.projected) continue;
      projection.message ??= buildTurnStateMessage({
        id: projection.id,
        turnId: run.turnId,
        ts: operation.ts,
        status: 'aborted',
        lineage: run.lineage,
        ...(operation.abortSource ? { abortSource: operation.abortSource } : {}),
        partialOutputRetained: await this.turnHasRetainedOutput(sessionId, run.turnId),
      });
      await this.appendStopProjection(sessionId, projection.message);
      projection.projected = true;
    }
    if (!operation.abortNoteProjected && stoppedRuns.length > 0) {
      await this.appendStopProjection(sessionId, operation.abortNote);
      operation.abortNoteProjected = true;
    }
    for (const target of operation.targets.values()) target.execution.completeStop();
    this.stopOperations.delete(sessionId);
  }

  private finishPendingTurnStart(sessionId: string, _registered: boolean): void {
    const remaining = Math.max(0, (this.pendingTurnStarts.get(sessionId) ?? 1) - 1);
    if (remaining === 0) this.pendingTurnStarts.delete(sessionId);
    else this.pendingTurnStarts.set(sessionId, remaining);
  }

  private async appendStopProjection(sessionId: string, message: StoredMessage): Promise<void> {
    const existing = (await this.deps.store.readMessages(sessionId)).find(
      (candidate) => candidate.id === message.id,
    );
    if (existing) {
      if (!isDeepStrictEqual(existing, message)) {
        throw new Error(`stop projection ${message.id} conflicts with an existing message`);
      }
      return;
    }
    await this.deps.store.appendMessage(sessionId, message);
  }

  async respondToPermission(sessionId: string, response: PermissionResponse): Promise<void> {
    if (this.deps.execution.kind === 'hosted') {
      throw new RuntimeInteractionInvariantError(
        'Hosted permission answers must use the captured continuation',
      );
    }
    const activeSessions = this.activeSessionsFor(sessionId);
    await Promise.all(activeSessions.map((active) => active.backend.respondToPermission(response)));
  }

  async respondToUserQuestion(sessionId: string, response: UserQuestionResponse): Promise<void> {
    if (this.deps.execution.kind === 'hosted') {
      throw new RuntimeInteractionInvariantError(
        'Hosted question answers must use the captured continuation',
      );
    }
    const activeSessions = this.activeSessionsFor(sessionId);
    await Promise.all(
      activeSessions.map((active) => active.backend.respondToUserQuestion?.(response)),
    );
  }

  // --------------------------------------------------------------------------
  // Steering / followup queues (authoritative source of truth)
  // --------------------------------------------------------------------------

  steer(sessionId: string, text: string): QueueEnqueueOutcome {
    this.assertEmbeddedMessageQueue('steer');
    // Steering's delivery contract is anchored to the runtime event ledger
    // (fail-closed persist + durable-consume ack). Without a RuntimeEventStore
    // that anchor does not exist — same condition as requireTerminalWrite —
    // so fall back to a fresh turn, whose user message the SessionStore
    // persists with the ordinary turn-open guarantee.
    if (!this.deps.runtimeEventStore) return { kind: 'fallback' };
    // Double responsibility (codex): with no live steering owner to inject
    // into — the turn just ended, begin() failed, or only child/compact runs
    // are active (they never consume this queue) — tell the caller to open a
    // fresh turn instead so the message is never dropped.
    const state = this.liveSteeringState(sessionId);
    if (!state) return { kind: 'fallback' };
    const messageId = this.deps.newId();
    state.steering.push({ id: messageId, messageId, text });
    this.emitQueueUpdate(sessionId, state);
    return { kind: 'queued' };
  }

  queueMessage(sessionId: string, text: string): QueueEnqueueOutcome {
    this.assertEmbeddedMessageQueue('queueMessage');
    const state = this.liveSteeringState(sessionId);
    if (!state) return { kind: 'fallback' };
    state.followup.push(text);
    this.emitQueueUpdate(sessionId, state);
    return { kind: 'queued' };
  }

  drainFollowup(sessionId: string): string | null {
    this.assertEmbeddedMessageQueue('drainFollowup');
    const state = this.steeringBySession.get(sessionId);
    if (!state || state.followup.length === 0) return null;
    const drained = state.followup.splice(0);
    this.emitQueueUpdate(sessionId, state);
    return drained.join('\n\n');
  }

  retractQueue(sessionId: string): string {
    this.assertEmbeddedMessageQueue('retractQueue');
    const state = this.steeringBySession.get(sessionId);
    if (!state) return '';
    // Retract reclaims QUEUED messages only. pull() is the single atomic
    // commit point of delivery: an in-flight lease is already committed to
    // the running turn — its durable append may land at any moment, so
    // handing its text back to the user here would refill AND execute the
    // same directive. An in-flight lease settles only by the persistence
    // fact (ack when the ledger owns it, nack back to a queue otherwise).
    const all = [...state.steering.map((message) => message.text), ...state.followup];
    state.steering = [];
    state.followup = [];
    this.emitQueueUpdate(sessionId, state);
    return all.join('\n\n');
  }

  private ensureSteering(sessionId: string): SessionSteeringState {
    const existing = this.steeringBySession.get(sessionId);
    if (existing) return existing;
    const created: SessionSteeringState = { steering: [], inFlight: [], followup: [] };
    this.steeringBySession.set(sessionId, created);
    return created;
  }

  private assertEmbeddedMessageQueue(operation: string): void {
    if (this.deps.execution.kind === 'hosted') {
      throw new RuntimeMessageAuthorityInvariantError(
        `Hosted Runtime cannot ${operation}; the Runtime Host owns message admission and queues`,
      );
    }
  }

  /**
   * The session's steering state only while a steering-capable top-level run
   * owns it (sink registered after begin() succeeded and not yet released).
   * Child agent and compact runs never establish ownership, so their activity
   * alone yields undefined — enqueue must fall back rather than strand text.
   */
  private liveSteeringState(sessionId: string): SessionSteeringState | undefined {
    const state = this.steeringBySession.get(sessionId);
    return state?.sink ? state : undefined;
  }

  private emitQueueUpdate(sessionId: string, state: SessionSteeringState): void {
    state.sink?.({
      type: 'queue_update',
      id: this.deps.newId(),
      turnId: state.activeTurnId ?? '',
      ts: this.deps.now(),
      steering: [
        ...state.inFlight.map((message) => message.text),
        ...state.steering.map((message) => message.text),
      ],
      followup: [...state.followup],
    });
  }

  private clearSteering(sessionId: string): void {
    const state = this.steeringBySession.get(sessionId);
    if (!state) return;
    // Same commit-point rule as retractQueue: only QUEUED messages are
    // clearable. An in-flight lease is already committed to the running
    // turn's delivery and settles only by the persistence fact.
    if (state.steering.length === 0 && state.followup.length === 0) return;
    state.steering = [];
    state.followup = [];
    this.emitQueueUpdate(sessionId, state);
  }

  private releaseSteeringTurn(sessionId: string, turnId: string): void {
    const state = this.steeringBySession.get(sessionId);
    if (!state) return;
    // A release folds only the leases THIS turn issued; an overlapping turn's
    // in-flight lease stays for its issuer to settle (acked = delivered, so
    // folding it into followup would redeliver an already-executed message).
    const own = state.inFlight.filter((message) => message.issuingTurnId === turnId);
    if (state.activeTurnId !== turnId) {
      // Not (or no longer) the owner. The issuer's backend settles every
      // lease before its turn ends, so `own` is normally empty; this is a
      // backstop that keeps a never-settled lease from stranding invisibly.
      if (own.length === 0) return;
      state.inFlight = state.inFlight.filter((message) => message.issuingTurnId !== turnId);
      state.followup = [...own.map((message) => message.text), ...state.followup];
      this.emitQueueUpdate(sessionId, state);
      return;
    }
    // Stranded steering (arrived after the final step boundary, so no step is
    // left to consume it) becomes the head of the followup queue instead of
    // vanishing — the next turn opens with it first (grok-build safety). The
    // migration is a queue change, so emit the final snapshot BEFORE the sink
    // is cleared; otherwise observers stay on the stale pre-fold snapshot.
    if (state.steering.length > 0 || own.length > 0) {
      state.followup = [
        ...own.map((message) => message.text),
        ...state.steering.map((message) => message.text),
        ...state.followup,
      ];
      state.inFlight = state.inFlight.filter((message) => message.issuingTurnId !== turnId);
      state.steering = [];
      this.emitQueueUpdate(sessionId, state);
    }
    state.sink = undefined;
    state.activeTurnId = undefined;
  }

  hasActiveRuns(sessionId: string): boolean {
    return this.activeSessionsFor(sessionId).some((active) => active.activeRuns.size > 0);
  }

  updateCachedHeader(sessionId: string, header: SessionHeader): void {
    const active = this.active.get(sessionId);
    if (active) active.cachedHeader = header;
  }

  async invalidateBackend(sessionId: string): Promise<void> {
    this.backendInvalidations.add(sessionId);
    await this.flushBackendInvalidation(sessionId);
  }

  disposeBackend(sessionId: string): Promise<void> {
    const existing = this.backendDisposals.get(sessionId);
    if (existing) return existing;
    let resolveDisposition!: () => void;
    let rejectDisposition!: (error: unknown) => void;
    const disposition = new Promise<void>((resolve, reject) => {
      resolveDisposition = resolve;
      rejectDisposition = reject;
    });
    this.backendDisposals.set(sessionId, disposition);
    void this.disposeBackendOnce(sessionId).then(
      () => {
        if (this.backendDisposals.get(sessionId) === disposition) {
          this.backendDisposals.delete(sessionId);
        }
        resolveDisposition();
      },
      (error: unknown) => {
        rejectDisposition(error);
      },
    );
    return disposition;
  }

  private async disposeBackendOnce(sessionId: string): Promise<void> {
    const activeSessions = this.activeSessionsFor(sessionId);
    if (this.deps.execution.kind === 'hosted') {
      this.backendInvalidations.add(sessionId);
      try {
        await settleRuntimeTasks(
          activeSessions.map(async (active) => {
            await active.backend.dispose();
          }),
        );
      } catch (error) {
        this.backendDisposalFailures.set(sessionId, { error });
        throw error;
      }
      this.backendDisposalFailures.delete(sessionId);
      this.backendInvalidations.delete(sessionId);
      this.deleteBackendIdentity(sessionId);
      return;
    }
    this.backendInvalidations.delete(sessionId);
    this.deleteBackendIdentity(sessionId);
    for (const active of activeSessions) {
      try {
        await active.backend.dispose();
      } catch {
        // best-effort
      }
    }
  }

  private deleteBackendIdentity(sessionId: string): void {
    this.active.delete(sessionId);
    this.steeringBySession.delete(sessionId);
    this.historyCompactCheckpoints.delete(sessionId);
    this.historyCompactCheckpointLoads.delete(sessionId);
    for (const [key, active] of this.childActive.entries()) {
      if (active.sessionId === sessionId) this.childActive.delete(key);
    }
  }

  private activeSessionsFor(sessionId: string): ActiveSession[] {
    const sessions: ActiveSession[] = [];
    const active = this.active.get(sessionId);
    if (active) sessions.push(active);
    for (const child of this.childActive.values()) {
      if (child.sessionId === sessionId) sessions.push(child);
    }
    return sessions;
  }

  private loadHistoryCompactCheckpoint(
    sessionId: string,
  ): Promise<HistoryCompactCheckpoint | undefined> {
    if (this.historyCompactCheckpoints.has(sessionId)) {
      return Promise.resolve(this.historyCompactCheckpoints.get(sessionId));
    }
    const existing = this.historyCompactCheckpointLoads.get(sessionId);
    if (existing) return existing;
    if (!this.deps.runStore) return Promise.resolve(undefined);

    let guardedLoad: Promise<HistoryCompactCheckpoint | undefined>;
    guardedLoad = loadLatestHistoryCompactCheckpointFromRunLedger(this.deps.runStore, sessionId)
      .then((checkpoint) => {
        if (
          this.historyCompactCheckpointLoads.get(sessionId) === guardedLoad &&
          !this.historyCompactCheckpoints.has(sessionId)
        ) {
          this.historyCompactCheckpoints.set(sessionId, checkpoint);
        }
        return this.historyCompactCheckpoints.has(sessionId)
          ? this.historyCompactCheckpoints.get(sessionId)
          : checkpoint;
      })
      .finally(() => {
        if (this.historyCompactCheckpointLoads.get(sessionId) === guardedLoad) {
          this.historyCompactCheckpointLoads.delete(sessionId);
        }
      });
    this.historyCompactCheckpointLoads.set(sessionId, guardedLoad);
    return guardedLoad;
  }

  private recordHistoryCompactCheckpoint(
    sessionId: string,
    checkpoint: HistoryCompactCheckpoint,
    run: AgentRun | undefined,
  ): Promise<void> {
    if (!run) return Promise.reject(new Error('No active AgentRun for history compact checkpoint'));
    const previous = this.historyCompactCheckpointWrites.get(sessionId) ?? Promise.resolve();
    let tracked: Promise<void>;
    tracked = previous
      .catch(() => {})
      .then(async () => {
        const durableCheckpoint = await this.loadHistoryCompactCheckpoint(sessionId);
        if (!canReplaceHistoryCompactCheckpoint(durableCheckpoint, checkpoint)) {
          throw new Error('History compact checkpoint was superseded before persistence');
        }
        await run.recordHistoryCompactCheckpoint(checkpoint);
        this.historyCompactCheckpoints.set(sessionId, checkpoint);
        this.scheduleHistoryCompactCleanup(sessionId, checkpoint, run);
      })
      .finally(() => {
        if (this.historyCompactCheckpointWrites.get(sessionId) === tracked) {
          this.historyCompactCheckpointWrites.delete(sessionId);
        }
      });
    this.historyCompactCheckpointWrites.set(sessionId, tracked);
    return tracked;
  }

  private scheduleHistoryCompactCleanup(
    sessionId: string,
    checkpoint: HistoryCompactCheckpoint,
    run: AgentRun,
  ): void {
    if (
      !this.deps.cleanupHistoryCompactArtifacts ||
      !this.deps.runStore ||
      !this.deps.runtimeEventStore
    )
      return;
    const execution = this.executionForRun(run);
    const previous = this.historyCompactCleanupWrites.get(sessionId) ?? Promise.resolve();
    let tracked: Promise<void>;
    tracked = execution.runSuccessorEffect('history_cleanup', () =>
      previous
        .catch((error) => {
          if (isRuntimeLifecycleFatal(error)) throw error;
        })
        .then(async () => {
          const runs = (await this.deps.runStore!.listSessionRuns(sessionId)).filter(
            isSessionInlineRun,
          );
          const runtimeEvents: RuntimeEvent[] = [];
          for (const run of runs) {
            runtimeEvents.push(
              ...(await this.deps.runtimeEventStore!.readRuntimeEvents(sessionId, run.runId)),
            );
          }
          await this.deps.cleanupHistoryCompactArtifacts!({
            sessionId,
            checkpoint,
            runtimeEvents,
          });
        })
        .catch((error) => {
          if (isRuntimeLifecycleFatal(error)) throw error;
          // Cleanup is best-effort; Runtime replay remains available on ordinary failure.
        })
        .finally(() => {
          if (this.historyCompactCleanupWrites.get(sessionId) === tracked) {
            this.historyCompactCleanupWrites.delete(sessionId);
          }
        }),
    );
    this.historyCompactCleanupWrites.set(sessionId, tracked);
  }

  private enterExecution(sessionId: string, turnId: string, runId: string): RunExecution {
    const execution = this.executionCoordinator.enter({ sessionId, turnId, runId });
    const sessionExecutions = this.executionsBySession.get(sessionId) ?? new Set<RunExecution>();
    sessionExecutions.add(execution);
    this.executionsBySession.set(sessionId, sessionExecutions);
    void execution.reclaimDrain
      .finally(() => {
        sessionExecutions.delete(execution);
        if (
          sessionExecutions.size === 0 &&
          this.executionsBySession.get(sessionId) === sessionExecutions
        ) {
          this.executionsBySession.delete(sessionId);
        }
      })
      .catch(() => undefined);
    return execution;
  }

  private executionForRun(run: AgentRun): RunExecution {
    const execution = [...(this.executionsBySession.get(run.sessionId) ?? [])].find(
      (candidate) => candidate.runId === run.runId,
    );
    if (!execution) {
      throw new RuntimeInteractionInvariantError(
        `AgentRun ${run.runId} has no live RunExecution owner`,
      );
    }
    return execution;
  }

  private ensureExecutionBackend(
    execution: RunExecution,
    build: () => Promise<ActiveSession>,
  ): Promise<ActiveSession> {
    return execution.wait(execution.activateBackend(build));
  }

  private async ensureActive(sessionId: string, header: SessionHeader): Promise<ActiveSession> {
    const disposalFailure = this.backendDisposalFailures.get(sessionId);
    if (disposalFailure) throw disposalFailure.error;
    const existing = this.active.get(sessionId);
    if (existing) {
      existing.cachedHeader = header;
      return existing;
    }
    const backend = await this.deps.backends.build(header.backend, {
      sessionId,
      workspaceRoot: header.workspaceRoot,
      header,
      store: this.deps.store,
      execution: { kind: this.deps.execution.kind },
      recordRunTrace: (event) => {
        const active = this.active.get(sessionId);
        const runId = active?.turnToRunId.get(event.turnId);
        const run = runId ? active?.activeRuns.get(runId) : undefined;
        run?.recordRunTrace(event);
      },
      ...(this.deps.runStore
        ? {
            recordProviderRequestCapture: (capture) => {
              const active = this.active.get(sessionId);
              const runId = active?.turnToRunId.get(capture.turnId);
              const run = runId ? active?.activeRuns.get(runId) : undefined;
              if (!run)
                return Promise.reject(new Error('No active AgentRun for provider request capture'));
              return run.recordProviderRequestCapture(capture);
            },
            recordProviderRequestAttempt: (attempt) => {
              const active = this.active.get(sessionId);
              const runId = active?.turnToRunId.get(attempt.turnId);
              const run = runId ? active?.activeRuns.get(runId) : undefined;
              run?.recordProviderRequestAttempt(attempt);
            },
            loadHistoryCompactCheckpoint: () => this.loadHistoryCompactCheckpoint(sessionId),
            recordHistoryCompactCheckpoint: (
              checkpoint: HistoryCompactCheckpoint,
              turnId: string,
            ) => {
              const active = this.active.get(sessionId);
              const runId = active?.turnToRunId.get(turnId);
              const run = runId ? active?.activeRuns.get(runId) : undefined;
              return this.recordHistoryCompactCheckpoint(sessionId, checkpoint, run);
            },
            loadTurnRuntimeEvents: (turnId: string) => {
              const active = this.active.get(sessionId);
              const runId = active?.turnToRunId.get(turnId);
              const run = runId ? active?.activeRuns.get(runId) : undefined;
              if (!run)
                return Promise.reject(new Error('No active AgentRun for turn runtime events'));
              return run.loadTurnRuntimeEvents();
            },
          }
        : {}),
      recordActiveFullCompactBlock: (block) => {
        const active = this.active.get(sessionId);
        const runId = active?.turnToRunId.get(block.turnId);
        const run = runId ? active?.activeRuns.get(runId) : undefined;
        run?.recordActiveFullCompactBlock(block);
      },
      recordSemanticCompactBlock: (block) => {
        const active = this.active.get(sessionId);
        const runId = active?.turnToRunId.get(block.turnId);
        const run = runId ? active?.activeRuns.get(runId) : undefined;
        run?.recordSemanticCompactBlock(block);
      },
      shellRunContextSummary: () =>
        this.deps.shellRuns?.buildContextSummary(sessionId) ?? Promise.resolve(undefined),
    });
    const entry: ActiveSession = {
      sessionId,
      backend,
      cachedHeader: header,
      activeRuns: new Map(),
      turnToRunId: new Map(),
    };
    this.active.set(sessionId, entry);
    return entry;
  }

  private async ensureChildActive(
    activeKey: string,
    sessionId: string,
    header: SessionHeader,
    systemPrompt: string,
    tools: readonly MakaTool[],
    agentTeam?: AgentTeamExecutionContext,
  ): Promise<ActiveSession> {
    const disposalFailure = this.backendDisposalFailures.get(sessionId);
    if (disposalFailure) throw disposalFailure.error;
    const existing = this.childActive.get(activeKey);
    if (existing) {
      existing.cachedHeader = header;
      return existing;
    }
    const backend = await this.deps.backends.build(header.backend, {
      sessionId,
      workspaceRoot: header.workspaceRoot,
      header,
      store: this.deps.store,
      execution: { kind: this.deps.execution.kind },
      appendMessage: async () => {},
      systemPrompt,
      tools,
      ...(agentTeam ? { agentTeam } : {}),
      recordRunTrace: (event) => {
        const active = this.childActive.get(activeKey);
        const runId = active?.turnToRunId.get(event.turnId);
        const run = runId ? active?.activeRuns.get(runId) : undefined;
        run?.recordRunTrace(event);
      },
      ...(this.deps.runStore
        ? {
            recordProviderRequestCapture: (capture) => {
              const active = this.childActive.get(activeKey);
              const runId = active?.turnToRunId.get(capture.turnId);
              const run = runId ? active?.activeRuns.get(runId) : undefined;
              if (!run)
                return Promise.reject(new Error('No active AgentRun for provider request capture'));
              return run.recordProviderRequestCapture(capture);
            },
            recordProviderRequestAttempt: (attempt) => {
              const active = this.childActive.get(activeKey);
              const runId = active?.turnToRunId.get(attempt.turnId);
              const run = runId ? active?.activeRuns.get(runId) : undefined;
              run?.recordProviderRequestAttempt(attempt);
            },
            loadHistoryCompactCheckpoint: () => this.loadHistoryCompactCheckpoint(sessionId),
            recordHistoryCompactCheckpoint: (
              checkpoint: HistoryCompactCheckpoint,
              turnId: string,
            ) => {
              const active = this.childActive.get(activeKey);
              const runId = active?.turnToRunId.get(turnId);
              const run = runId ? active?.activeRuns.get(runId) : undefined;
              return this.recordHistoryCompactCheckpoint(sessionId, checkpoint, run);
            },
            // loadTurnRuntimeEvents is deliberately NOT injected for child
            // sessions: a child run has no top-level prior context, so a mid-turn
            // checkpoint built from its child-only ledger would claim to cover a
            // session-scoped projection prefix and poison the session-global
            // checkpoint cache/CAS for the parent projection. Child mid-turn
            // compaction stays disabled (the backend requires this seam) until
            // checkpoint streams are partitioned by lineage.
          }
        : {}),
      recordActiveFullCompactBlock: (block) => {
        const active = this.childActive.get(activeKey);
        const runId = active?.turnToRunId.get(block.turnId);
        const run = runId ? active?.activeRuns.get(runId) : undefined;
        run?.recordActiveFullCompactBlock(block);
      },
      recordSemanticCompactBlock: (block) => {
        const active = this.childActive.get(activeKey);
        const runId = active?.turnToRunId.get(block.turnId);
        const run = runId ? active?.activeRuns.get(runId) : undefined;
        run?.recordSemanticCompactBlock(block);
      },
    });
    const entry: ActiveSession = {
      sessionId,
      backend,
      cachedHeader: header,
      activeRuns: new Map(),
      turnToRunId: new Map(),
    };
    this.childActive.set(activeKey, entry);
    return entry;
  }

  private registerRun(active: AgentRunActiveSession, run: AgentRun): void {
    active.activeRuns.set(run.runId, run);
    active.turnToRunId.set(run.turnId, run.runId);
  }

  private registerParentRun(active: AgentRunActiveSession, run: AgentRun): void {
    this.active.set(active.sessionId, active as ActiveSession);
    this.registerRun(active, run);
  }

  private registerChildRun(activeKey: string, active: AgentRunActiveSession, run: AgentRun): void {
    this.childActive.set(activeKey, active as ActiveSession);
    this.registerRun(active, run);
  }

  private unregisterRun(active: AgentRunActiveSession, run: AgentRun): void {
    active.activeRuns.delete(run.runId);
    if (active.turnToRunId.get(run.turnId) === run.runId) {
      active.turnToRunId.delete(run.turnId);
    }
  }

  private async unregisterParentRun(active: AgentRunActiveSession, run: AgentRun): Promise<void> {
    this.unregisterRun(active, run);
    await this.flushBackendInvalidation(active.sessionId);
  }

  private async unregisterChildRun(
    activeKey: string,
    active: AgentRunActiveSession,
    run: AgentRun,
  ): Promise<void> {
    if (this.deps.execution.kind === 'hosted' && active.activeRuns.size === 1) {
      try {
        await active.backend.dispose();
      } catch (error) {
        this.backendInvalidations.add(active.sessionId);
        this.backendDisposalFailures.set(active.sessionId, { error });
        throw error;
      }
    }
    this.unregisterRun(active, run);
    if (active.activeRuns.size > 0) return;
    this.childActive.delete(activeKey);
    if (this.deps.execution.kind === 'hosted') {
      await this.flushBackendInvalidation(active.sessionId);
      return;
    }
    try {
      await active.backend.dispose();
    } catch {
      // best-effort
    }
    await this.flushBackendInvalidation(active.sessionId);
  }

  private async flushBackendInvalidation(sessionId: string): Promise<void> {
    if (!this.backendInvalidations.has(sessionId) || this.hasActiveRuns(sessionId)) return;
    await this.disposeBackend(sessionId);
  }

  private async updateStatus(
    sessionId: string,
    status: SessionStatus,
    blockedReason?: SessionBlockedReason,
    ts = this.deps.now(),
  ): Promise<void> {
    await this.updateHeader(sessionId, buildStatusPatch(status, ts, blockedReason));
  }

  private async updateHeader(
    sessionId: string,
    patch: Partial<SessionHeader>,
  ): Promise<SessionHeader> {
    const next = await this.deps.store.updateHeader(sessionId, patch);
    this.updateCachedHeader(sessionId, next);
    return next;
  }

  private async appendTurnState(
    sessionId: string,
    turnId: string,
    status: TurnRecord['status'],
    lineage: AgentRunLineage = {},
    options: { id?: string; ts?: number; errorClass?: string; abortSource?: string } = {},
  ): Promise<void> {
    const ts = options.ts ?? this.deps.now();
    await this.deps.store.appendMessage(
      sessionId,
      buildTurnStateMessage({
        id: options.id ?? this.deps.newId(),
        turnId,
        ts,
        status,
        lineage,
        ...(options.abortSource ? { abortSource: options.abortSource } : {}),
        ...(options.errorClass !== undefined ? { errorClass: options.errorClass } : {}),
        partialOutputRetained: await this.turnHasRetainedOutput(sessionId, turnId),
      }),
    );
  }

  private async turnHasRetainedOutput(sessionId: string, turnId: string): Promise<boolean> {
    const messages = await this.deps.store.readMessages(sessionId).catch(() => []);
    return messagesHaveRetainedOutput(messages, turnId);
  }
}

function assertContinuationSourceUnchanged(
  continuation: RuntimeContinuation,
  sourceRun: AgentRunHeader,
  sourceEvents: readonly RuntimeEvent[],
  currentCwd: string,
): void {
  if (
    sourceRun.runId !== continuation.sourceRunId ||
    sourceRun.turnId !== continuation.sourceTurnId ||
    sourceRun.sessionId !== continuation.sessionId
  ) {
    throw new RuntimeContinuationRevalidationError(
      'source_identity_changed',
      'Runtime continuation source run identity changed after planning',
    );
  }
  const terminalEvents = matchingTerminalRuntimeEvents(sourceRun, sourceEvents);
  const terminalStatus =
    terminalEvents.length === 1 ? terminalRunStatusFromRuntimeEvent(terminalEvents[0]!) : undefined;
  if (terminalStatus === undefined || terminalStatus !== sourceRun.status) {
    throw new RuntimeContinuationRevalidationError(
      'source_terminal_changed',
      'Runtime continuation source is no longer terminal',
    );
  }
  if (normalizeResumeCwd(sourceRun.cwd) !== normalizeResumeCwd(currentCwd)) {
    throw new RuntimeContinuationRevalidationError(
      'source_cwd_changed',
      'Runtime continuation workspace cwd changed after planning',
    );
  }
  if (sourceEvents.length !== continuation.sourceRuntimeEventHighWater) {
    throw new RuntimeContinuationRevalidationError(
      'source_high_water_changed',
      'Runtime continuation source high-water changed after planning',
    );
  }
  const mismatchedEvent = sourceEvents.find(
    (event) =>
      event.sessionId !== continuation.sessionId ||
      event.invocationId !== continuation.sourceInvocationId ||
      event.runId !== continuation.sourceRunId ||
      event.turnId !== continuation.sourceTurnId,
  );
  if (mismatchedEvent) {
    throw new RuntimeContinuationRevalidationError(
      'source_ledger_identity_changed',
      'Runtime continuation source ledger identity changed after planning',
    );
  }
  const replayPlan = buildResumePlanFromRuntimeEvents(sourceEvents, {
    expectedRuntimeEventHighWater: continuation.sourceRuntimeEventHighWater,
  });
  const sourceRuntimeContext = continuation.sourceRuntimeContext ?? continuation.runtimeContext;
  if (
    replayPlan.disposition !== 'safe_replay' ||
    !isDeepStrictEqual(replayPlan.replayRuntimeEvents, sourceRuntimeContext)
  ) {
    throw new RuntimeContinuationRevalidationError(
      'source_replay_changed',
      'Runtime continuation replay context changed after planning',
    );
  }
}

function normalizeResumeCwd(value: string): string {
  const normalized = value.replaceAll('\\', '/').replace(/\/+$/, '');
  return /^[A-Za-z]:\//.test(normalized) ? normalized.toLowerCase() : normalized;
}

function assertContinuationSafetyUnchanged(
  continuation: RuntimeContinuation,
  observation: RuntimeContinuationSafetyObservation,
): void {
  const snapshot = continuation.safetySnapshot;
  if (observation.workspaceIdentity !== snapshot.workspaceIdentity) {
    throw new RuntimeContinuationRevalidationError(
      'workspace_identity_changed',
      'Runtime continuation workspace identity changed after planning',
    );
  }
  if (!observation.backgroundOperationsSettled) {
    throw new RuntimeContinuationRevalidationError(
      'background_operation_started',
      'Runtime continuation background operation started after planning',
    );
  }
  const availableToolNames = new Set(observation.availableToolNames);
  const missingToolNames = snapshot.availableToolNames.filter(
    (name) => !availableToolNames.has(name),
  );
  if (missingToolNames.length > 0) {
    throw new RuntimeContinuationRevalidationError(
      'tool_catalog_changed',
      `Runtime continuation tool catalog changed after planning: ${missingToolNames.join(', ')}`,
    );
  }
  if (snapshot.workspaceCheckpoint) {
    const current = observation.workspaceCheckpoint;
    if (
      !current?.restored ||
      current.ref !== snapshot.workspaceCheckpoint.ref ||
      current.runtimeEventHighWater !== snapshot.workspaceCheckpoint.runtimeEventHighWater
    ) {
      throw new RuntimeContinuationRevalidationError(
        'workspace_checkpoint_changed',
        'Runtime continuation workspace checkpoint changed after planning',
      );
    }
  }
}

function childActiveKey(sessionId: string, turnId: string): string {
  return `${sessionId}:${turnId}`;
}

function runtimeToolBoundaryProtocol(
  deps: Pick<RuntimeKernelDeps, 'toolBoundaryProtocol'>,
  header: Pick<SessionHeader, 'backend'>,
): ToolBoundaryProtocol | undefined {
  return header.backend === 'ai-sdk' ? deps.toolBoundaryProtocol : undefined;
}

function effectiveOrchestrationForRun(
  run: AgentRunHeader,
  session: SessionHeader,
): EffectiveOrchestration {
  if (
    run.orchestrationMode !== undefined &&
    run.orchestrationSource !== undefined &&
    run.agentSwarmAuthorization !== undefined
  ) {
    return {
      mode: run.orchestrationMode,
      source: run.orchestrationSource,
      agentSwarmAuthorization: run.agentSwarmAuthorization,
    };
  }
  return resolveEffectiveOrchestration(session.orchestrationMode, undefined);
}

class AsyncEventQueueClosed extends Error {
  constructor() {
    super('Async event queue closed');
    this.name = 'AsyncEventQueueClosed';
  }
}

class RuntimeEventConsumerAbandonedError extends Error {
  constructor(runId: string) {
    super(`Runtime event consumer abandoned run ${runId}`);
    this.name = 'RuntimeEventConsumerAbandonedError';
  }
}

async function settleRuntimeTasks(tasks: readonly Promise<unknown>[]): Promise<void> {
  const outcomes = await Promise.all(
    tasks.map((task) =>
      task.then(
        () => ({ kind: 'fulfilled' as const }),
        (error: unknown) => ({ kind: 'rejected' as const, error }),
      ),
    ),
  );
  const failure = outcomes.find(
    (outcome): outcome is Extract<typeof outcome, { kind: 'rejected' }> =>
      outcome.kind === 'rejected',
  );
  if (failure) throw failure.error;
}

function observeRuntimeTask(task: Promise<unknown>): void {
  void task.catch(() => undefined);
}

function isAsyncEventQueueClosed(error: unknown): boolean {
  return error instanceof AsyncEventQueueClosed;
}

interface AsyncEventQueueEntry<T> {
  value: T;
  delivered: () => void;
  rejected: (error: unknown) => void;
}

class AsyncEventQueue<T> implements AsyncIterable<T> {
  private readonly values: Array<AsyncEventQueueEntry<T>> = [];
  private readonly waiters: Array<{
    resolve: (entry: AsyncEventQueueEntry<T> | undefined) => void;
    reject: (error: unknown) => void;
  }> = [];
  private closed = false;
  private failure: unknown;

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return this.consume()[Symbol.asyncIterator]();
  }

  push(value: T): Promise<void> {
    if (this.failure) return Promise.reject(this.failure);
    if (this.closed) return Promise.reject(new AsyncEventQueueClosed());
    return new Promise<void>((resolve, reject) => {
      const entry = { value, delivered: resolve, rejected: reject };
      const waiter = this.waiters.shift();
      if (waiter) {
        waiter.resolve(entry);
        return;
      }
      this.values.push(entry);
    });
  }

  fail(error: unknown): void {
    if (this.failure) return;
    this.failure = error;
    for (const value of this.values.splice(0)) value.rejected(error);
    for (const waiter of this.waiters.splice(0)) waiter.reject(error);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    const closed = new AsyncEventQueueClosed();
    for (const value of this.values.splice(0)) value.rejected(closed);
    for (const waiter of this.waiters.splice(0)) waiter.resolve(undefined);
  }

  private async *consume(): AsyncIterable<T> {
    while (true) {
      const entry = await this.nextEntry();
      if (!entry) return;
      try {
        yield entry.value;
      } finally {
        entry.delivered();
      }
    }
  }

  private nextEntry(): Promise<AsyncEventQueueEntry<T> | undefined> {
    if (this.values.length > 0) {
      const next = this.values.shift()!;
      return Promise.resolve(next);
    }
    if (this.failure) return Promise.reject(this.failure);
    if (this.closed) return Promise.resolve(undefined);
    return new Promise<AsyncEventQueueEntry<T> | undefined>((resolve, reject) => {
      this.waiters.push({ resolve, reject });
    });
  }
}

export type { AgentRunLineage };
