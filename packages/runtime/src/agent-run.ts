import type {
  AgentRunEvent,
  AgentRunHeader,
  AgentRunStore,
  RuntimeEvent,
  RuntimeEventStore,
  ToolBoundaryProtocol,
} from '@maka/core';
import { DurableStoreWriteError, isSessionInlineRun, isTerminalRuntimeEvent } from '@maka/core';
import { redactSecrets } from '@maka/core/redaction';
import type {
  SessionBlockedReason,
  SessionHeader,
  SessionStatus,
  StoredMessage,
  SystemNoteMessage,
  TurnRecord,
  UserMessage,
} from '@maka/core/session';
import type { UserMessageInput } from '@maka/core/runtime-inputs';
import {
  resolveEffectiveOrchestration,
  type EffectiveOrchestration,
} from '@maka/core/orchestration';
import { failureClassFromCompleteStopReason, type SessionEvent } from '@maka/core/events';
import type { AgentBackend, BackendSendInput } from '@maka/core/backend-types';
import type { RunTraceEvent } from './run-trace.js';
import type { SessionStore, StopSessionInput } from './session-manager.js';
import type { ActiveFullCompactBlock } from './active-full-compact.js';
import type { SemanticCompactBlock } from './semantic-compact.js';
import type { HistoryCompactCheckpoint } from './history-compact-checkpoint.js';
import { buildRuntimeEventModelReplayPlan } from './model-history.js';
import {
  classifyRuntimeEventTerminalFact,
  projectRuntimeEventsToStoredMessages,
} from './runtime-event-read-model.js';
import { backfillRuntimeEventsFromStoredMessages } from './runtime-event-backfill.js';
import { buildStatusPatch, normalizeStopSessionSource } from './session-projection-helpers.js';
import {
  buildSyntheticTerminalRuntimeEvent,
  commitOrCreateTerminalRunFact,
  effectiveRunHeaderFromTerminalFact,
} from './terminal-run-commit.js';
import { AiSdkFlow } from './ai-sdk-flow.js';
import type { InvocationContext } from './invocation-context.js';
import { buildInitialUserRuntimeEvent } from './runtime-runner.js';
import type { RuntimeContinuation } from './runtime-resume.js';
import type {
  ProviderRequestAttemptRecord,
  ProviderRequestCaptureLedgerRecord,
} from './provider-request-telemetry.js';
import {
  RuntimeInteractionInvariantError,
  type RuntimeInteractionRunClosureReason,
} from './interaction-authority.js';
import {
  isRuntimeLifecycleFatal,
  throwIfRuntimeLifecycleFatal,
} from './runtime-lifecycle-errors.js';

export interface AgentRunActiveSession {
  sessionId: string;
  backend: AgentBackend;
  cachedHeader: SessionHeader;
  activeRuns: Map<string, AgentRun>;
  turnToRunId: Map<string, string>;
}

export interface AgentRunHooks {
  ensureActive(sessionId: string, header: SessionHeader): Promise<AgentRunActiveSession>;
  registerRun(active: AgentRunActiveSession, run: AgentRun): void;
  unregisterRun(active: AgentRunActiveSession, run: AgentRun): void | Promise<void>;
  updateHeader(sessionId: string, patch: Partial<SessionHeader>): Promise<SessionHeader>;
  updateStatus(
    sessionId: string,
    status: SessionStatus,
    blockedReason?: SessionBlockedReason,
    ts?: number,
  ): Promise<void>;
  appendTurnState(
    sessionId: string,
    turnId: string,
    status: TurnRecord['status'],
    lineage?: AgentRunLineage,
    options?: { ts?: number; errorClass?: string; abortSource?: string },
  ): Promise<void>;
}

export type AgentRunLineage = Partial<
  Pick<
    UserMessageInput,
    | 'parentRunId'
    | 'resumedFromRunId'
    | 'retriedFromRunId'
    | 'parentTurnId'
    | 'retriedFromTurnId'
    | 'regeneratedFromTurnId'
    | 'branchOfTurnId'
    | 'parentSessionId'
  >
>;

export type AgentRunDurability = 'best_effort' | 'required';

export interface AgentRunInput {
  sessionId: string;
  header: SessionHeader;
  userInput: UserMessageInput;
  runId?: string;
  userMessageId?: string;
  durability?: AgentRunDurability;
  store: SessionStore;
  runStore?: AgentRunStore;
  runtimeEventStore?: RuntimeEventStore;
  repairRunRuntimeLedger?: (sessionId: string, runId: string) => Promise<boolean>;
  newId: () => string;
  now: () => number;
  workspaceIdentity?: string;
  continuationFailpoint?: (point: RuntimeContinuationFailpoint) => Promise<void>;
  hooks: AgentRunHooks;
  recordSessionMessages?: boolean;
  invocationId?: string;
  /** Pre-resolved snapshot used by continuations; normal turns derive it from header + input. */
  effectiveOrchestration?: EffectiveOrchestration;
  /** Set only when this run's backend tool path is guarded by canonical T1. */
  toolBoundaryProtocol?: ToolBoundaryProtocol;
  /** In-memory execution fence checked before Runtime-owned persistence. */
  assertExecutionActive?: () => void;
}

export type RuntimeContinuationFailpoint =
  | 'after_run_created'
  | 'after_continuation_start_committed'
  | 'after_terminal_event_committed'
  | 'after_terminal_header_committed';

export interface AgentRunBeginResult {
  backend: AgentBackend;
  backendInput: BackendSendInput;
  initialRuntimeEvent: RuntimeEvent;
}

export interface AgentRunOperationBeginResult {
  backend: AgentBackend;
  runtimeContext: RuntimeEvent[];
  startedAt: number;
}

export interface AgentRunContinuationBeginResult {
  backend: AgentBackend;
  startedAt: number;
}

interface PriorRuntimeContext {
  events: RuntimeEvent[];
  runs: AgentRunHeader[];
}

interface PriorRunTerminalFactContext {
  events: RuntimeEvent[];
  run: AgentRunHeader;
}

type TerminalFactState =
  | { kind: 'empty' }
  | { kind: 'reserved'; event: RuntimeEvent }
  | { kind: 'writing'; event: RuntimeEvent; write: Promise<void> }
  | { kind: 'committed'; event: RuntimeEvent };

type TerminalHeaderState = { kind: 'pending' } | { kind: 'committed' };

type StopDeliveryState =
  | {
      kind: 'pending';
      completion: Promise<void>;
      complete: () => void;
    }
  | { kind: 'completed' };

type TerminalClaim =
  | {
      owner: 'stop';
      abortSource: string | undefined;
      delivery: StopDeliveryState;
      fact: TerminalFactState;
      header: TerminalHeaderState;
    }
  | {
      owner: 'event';
      cause: 'terminal_event' | 'failure';
      fact: TerminalFactState;
      header: TerminalHeaderState;
    };

type AgentRunTerminalState =
  | { phase: 'open' }
  | { phase: 'claimed'; claim: TerminalClaim }
  | { phase: 'finalizing'; claim: TerminalClaim; task: Promise<void> }
  | { phase: 'finalized'; claim: TerminalClaim }
  | { phase: 'finalization_failed'; claim: TerminalClaim; error: unknown };

export class AgentRun {
  readonly runId: string;
  readonly invocationId: string;
  readonly sessionId: string;
  readonly turnId: string;
  readonly toolBoundaryProtocol: ToolBoundaryProtocol | undefined;
  readonly lineage: AgentRunLineage;
  readonly effectiveOrchestration: EffectiveOrchestration;

  private header: SessionHeader;
  private active: AgentRunActiveSession | undefined;
  private traceQueue: Promise<void> = Promise.resolve();
  private runtimeEventQueue: Promise<void> = Promise.resolve();
  private runStoreAvailable = true;
  private runtimeEventStoreAvailable = true;
  private runtimeEventStoreFailure: unknown;
  private failureClass: string | undefined;
  private failureMessage: string | undefined;
  private lastTs = 0;
  private sawCompletion = false;
  private finalStatus: { status: SessionStatus; blockedReason?: SessionBlockedReason } | undefined;
  private turnFailed = false;
  private continuationActive = false;
  private terminalState: AgentRunTerminalState = { phase: 'open' };

  constructor(private readonly input: AgentRunInput) {
    if (input.runStore && !input.runtimeEventStore) {
      throw new Error('RuntimeEventStore is required when AgentRunStore is configured');
    }
    if (input.durability === 'required' && (!input.runStore || !input.runtimeEventStore)) {
      throw new Error('Required AgentRun durability needs AgentRunStore and RuntimeEventStore');
    }
    this.runId = input.runId ?? input.newId();
    this.invocationId = input.invocationId ?? this.runId;
    this.sessionId = input.sessionId;
    this.turnId = input.userInput.turnId;
    this.toolBoundaryProtocol = input.toolBoundaryProtocol;
    this.header = input.header;
    this.effectiveOrchestration =
      input.effectiveOrchestration ??
      resolveEffectiveOrchestration(
        input.header.orchestrationMode,
        input.userInput.turnOrchestration,
      );
    this.lineage = {
      ...(input.userInput.parentRunId ? { parentRunId: input.userInput.parentRunId } : {}),
      ...(input.userInput.resumedFromRunId
        ? { resumedFromRunId: input.userInput.resumedFromRunId }
        : {}),
      ...(input.userInput.retriedFromRunId
        ? { retriedFromRunId: input.userInput.retriedFromRunId }
        : {}),
      ...(input.userInput.parentTurnId ? { parentTurnId: input.userInput.parentTurnId } : {}),
      ...(input.userInput.retriedFromTurnId
        ? { retriedFromTurnId: input.userInput.retriedFromTurnId }
        : {}),
      ...(input.userInput.regeneratedFromTurnId
        ? { regeneratedFromTurnId: input.userInput.regeneratedFromTurnId }
        : {}),
      ...(input.userInput.branchOfTurnId ? { branchOfTurnId: input.userInput.branchOfTurnId } : {}),
      ...(input.userInput.parentSessionId
        ? { parentSessionId: input.userInput.parentSessionId }
        : {}),
    };
  }

  stop(source: StopSessionInput['source'] | undefined): boolean {
    if (this.terminalState.phase !== 'open') return false;
    let complete!: () => void;
    const completion = new Promise<void>((resolve) => {
      complete = resolve;
    });
    this.terminalState = {
      phase: 'claimed',
      claim: {
        owner: 'stop',
        abortSource: normalizeStopSessionSource(source),
        delivery: { kind: 'pending', completion, complete },
        fact: { kind: 'empty' },
        header: { kind: 'pending' },
      },
    };
    return true;
  }

  isStopped(): boolean {
    return this.terminalClaim()?.owner === 'stop';
  }

  isSessionInline(): boolean {
    return isSessionInlineRun({
      ...(this.lineage.parentRunId ? { parentRunId: this.lineage.parentRunId } : {}),
      ...(this.continuationActive ? { continuationSource: true } : {}),
    });
  }

  hasPendingStop(): boolean {
    const claim = this.terminalClaim();
    return claim?.owner === 'stop' && claim.delivery.kind === 'pending';
  }

  completeStop(): void {
    const claim = this.terminalClaim();
    if (claim?.owner !== 'stop' || claim.delivery.kind === 'completed') return;
    claim.delivery.complete();
    this.updateTerminalClaim({ ...claim, delivery: { kind: 'completed' } });
  }

  hasStopClaim(): boolean {
    return this.terminalClaim()?.owner === 'stop';
  }

  waitForStopCompletion(): Promise<void> {
    const claim = this.terminalClaim();
    return claim?.owner === 'stop' && claim.delivery.kind === 'pending'
      ? claim.delivery.completion
      : Promise.resolve();
  }

  recordRunTrace(event: RunTraceEvent): void {
    if (!this.input.runStore || !this.runStoreAvailable) return;
    this.enqueueRunStore('append trace event', async () => {
      await this.input.runStore?.appendEvent(
        this.sessionId,
        this.runId,
        traceToRunEvent(event, this.runId),
      );
    });
  }

  recordProviderRequestCapture(capture: ProviderRequestCaptureLedgerRecord): Promise<void> {
    if (!this.input.runStore) return Promise.reject(new Error('AgentRun store is not configured'));
    return this.enqueueRequiredProviderCapture('append provider request capture', async () => {
      const {
        schemaVersion,
        serializedRequest: _serializedRequest,
        ...data
      } = capture as ProviderRequestCaptureLedgerRecord & { serializedRequest?: string };
      await this.input.runStore?.appendEvent(
        this.sessionId,
        this.runId,
        {
          type: 'provider_request_captured',
          id: capture.captureId,
          runId: this.runId,
          sessionId: this.sessionId,
          turnId: capture.turnId,
          ts: this.input.now(),
          data: { schemaVersion, ...data },
        },
        { durable: true },
      );
    });
  }

  recordProviderRequestAttempt(attempt: ProviderRequestAttemptRecord): void {
    if (!this.input.runStore) return;
    this.enqueueBestEffortProviderAttempt('append provider request attempt', async () => {
      await this.input.runStore?.appendEvent(this.sessionId, this.runId, {
        type: 'provider_request_attempt_recorded',
        id: attempt.attemptId,
        runId: this.runId,
        sessionId: this.sessionId,
        turnId: attempt.turnId,
        ts: attempt.completedAt,
        data: { ...attempt },
      });
    });
  }

  recordActiveFullCompactBlock(block: ActiveFullCompactBlock): void {
    if (!this.input.runStore || !this.runStoreAvailable) return;
    this.enqueueRunStore('append active full compact block', async () => {
      await this.input.runStore?.appendEvent(this.sessionId, this.runId, {
        type: 'active_full_compact_block_recorded',
        id: this.input.newId(),
        runId: this.runId,
        sessionId: this.sessionId,
        turnId: block.turnId || this.turnId,
        ts: this.input.now(),
        data: {
          blockId: block.blockId,
          highWaterName: block.highWaterName,
          highWaterSeq: block.highWaterSeq,
          boundaryKind: 'activeFullCompact',
          block,
        },
      });
    });
  }

  recordHistoryCompactCheckpoint(checkpoint: HistoryCompactCheckpoint): Promise<void> {
    if (!this.input.runStore) return Promise.reject(new Error('AgentRun store is not configured'));
    if (!this.runStoreAvailable) return Promise.reject(new Error('AgentRun store is unavailable'));
    return this.enqueueRunStore(
      'append history compact checkpoint',
      async () => {
        await this.input.runStore?.appendEvent(this.sessionId, this.runId, {
          type: 'history_compact_checkpoint_recorded',
          id: this.input.newId(),
          runId: this.runId,
          sessionId: this.sessionId,
          turnId: this.turnId,
          ts: this.input.now(),
          data: {
            checkpointId: checkpoint.checkpointId,
            highWaterName: checkpoint.highWaterName,
            highWaterSeq: checkpoint.highWaterSeq,
            boundaryKind: 'historyCompact',
            checkpoint,
          },
        });
      },
      { rethrow: true },
    );
  }

  /**
   * Durable read of this run's RuntimeEvent ledger for the mid-turn capacity
   * invariant: waits for every write enqueued so far, then reads the store, so
   * a caller-derived coverage prefix can only ever span events that are
   * already persisted. Rejects when the store is unavailable — coverage must
   * never be computed over a projection the ledger cannot replay.
   */
  async loadTurnRuntimeEvents(): Promise<RuntimeEvent[]> {
    this.assertExecutionActive();
    if (!this.input.runtimeEventStore || !this.runtimeEventStoreAvailable) {
      throw new Error('RuntimeEvent store is unavailable for turn runtime events');
    }
    await this.runtimeEventQueue.catch((error) => {
      throwIfRuntimeLifecycleFatal(error);
    });
    this.assertExecutionActive();
    // A write may have failed while we waited; a snapshot from a store that
    // just went unavailable must not be treated as a complete durable read.
    if (!this.runtimeEventStoreAvailable) {
      throw new Error('RuntimeEvent store became unavailable for turn runtime events');
    }
    const events = await this.input.runtimeEventStore.readRuntimeEvents(this.sessionId, this.runId);
    this.assertExecutionActive();
    return events;
  }

  recordSemanticCompactBlock(block: SemanticCompactBlock): void {
    if (!this.input.runStore || !this.runStoreAvailable) return;
    this.enqueueRunStore('append semantic compact block', async () => {
      await this.input.runStore?.appendEvent(this.sessionId, this.runId, {
        type: 'semantic_compact_block_recorded',
        id: this.input.newId(),
        runId: this.runId,
        sessionId: this.sessionId,
        turnId: block.turnId || this.turnId,
        ts: this.input.now(),
        data: {
          blockId: block.blockId,
          highWaterName: block.highWaterName,
          highWaterSeq: block.highWaterSeq,
          boundaryKind: 'semanticCompact',
          block,
        },
      });
    });
  }

  async *execute(): AsyncIterable<SessionEvent> {
    let interactionFailure = false;
    try {
      const begin = await this.begin();
      const invocationId = begin.initialRuntimeEvent.invocationId;
      const source = 'desktop' as const;
      const request: InvocationContext['request'] = {
        sessionId: this.sessionId,
        invocationId,
        runId: this.runId,
        turnId: this.turnId,
        orchestration: this.effectiveOrchestration,
        text: this.input.userInput.text,
        ...(this.input.userInput.attachments
          ? { attachments: this.input.userInput.attachments }
          : {}),
        ...(this.input.userInput.quotes ? { quotes: this.input.userInput.quotes } : {}),
        context: begin.backendInput.context,
        ...(begin.backendInput.runtimeContext
          ? { runtimeContext: begin.backendInput.runtimeContext }
          : {}),
        initialRuntimeEvent: begin.initialRuntimeEvent,
        source,
        lineage: this.lineage,
      };
      const ctx: InvocationContext = {
        sessionId: this.sessionId,
        invocationId,
        runId: this.runId,
        turnId: this.turnId,
        source,
        startedAt: begin.initialRuntimeEvent.ts,
        request,
        newId: this.input.newId,
        now: this.input.now,
      };
      let acceptedSessionEvent: SessionEvent | undefined;
      const flow = new AiSdkFlow({
        backend: begin.backend,
        drainAfterTerminal: true,
        onSessionEvent: async (sessionEvent, runtimeEvent) => {
          await this.acceptMappedEvent(sessionEvent, runtimeEvent);
          acceptedSessionEvent = sessionEvent;
        },
      });
      for await (const _runtimeEvent of flow.run(ctx, {
        text: begin.backendInput.text,
        ...(begin.backendInput.attachments ? { attachments: begin.backendInput.attachments } : {}),
        ...(begin.backendInput.quotes ? { quotes: begin.backendInput.quotes } : {}),
        context: begin.backendInput.context,
        ...(begin.backendInput.runtimeContext
          ? { runtimeContext: begin.backendInput.runtimeContext }
          : {}),
      })) {
        if (acceptedSessionEvent) {
          yield acceptedSessionEvent;
          acceptedSessionEvent = undefined;
        }
      }
    } catch (error) {
      if (isRuntimeLifecycleFatal(error)) {
        interactionFailure = true;
        throw error;
      }
      try {
        await this.recordFailure(error);
      } catch (recordError) {
        if (isRuntimeLifecycleFatal(recordError)) {
          interactionFailure = true;
        }
        throw recordError;
      }
      throw error;
    } finally {
      if (!interactionFailure) await this.finalize();
    }
  }

  async acceptMappedEvent(
    sessionEvent: SessionEvent,
    runtimeEvent: RuntimeEvent,
    options: { requireTerminalWrite?: boolean } = {},
  ): Promise<void> {
    if (isTerminalRuntimeEvent(runtimeEvent)) {
      if (!isPermissionHandoffTerminal(runtimeEvent)) {
        await this.recordRuntimeEvents([runtimeEvent], {
          requireTerminalWrite:
            options.requireTerminalWrite ?? Boolean(this.input.runtimeEventStore),
        });
      }
      await this.recordSessionEvent(sessionEvent);
      return;
    }
    await this.recordSessionEvent(sessionEvent);
    if (!isNonTerminalErrorRuntimeEvent(runtimeEvent)) {
      // A steered user message is fail-CLOSED: the backend's delivery ack
      // waits on this consume, and the provider must never execute a
      // directive the ledger does not carry. Every other non-terminal event
      // stays fail-open (a trace gap, not a correctness gap).
      const steering =
        runtimeEvent.content?.kind === 'text' && runtimeEvent.content.steering === true;
      await this.recordRuntimeEvents([runtimeEvent], steering ? { requireDurableWrite: true } : {});
    }
  }

  /**
   * Synchronously fixes the exact Run's terminal owner before any hosted
   * Interaction closure await. A prior stop claim maps the natural event to
   * the existing aborted terminal; otherwise the event becomes the owner.
   */
  claimTerminalEvent(runtimeEvent: RuntimeEvent): RuntimeInteractionRunClosureReason {
    if (!isTerminalRuntimeEvent(runtimeEvent)) {
      throw new Error(`RuntimeEvent ${runtimeEvent.id} is not terminal`);
    }
    if (this.terminalState.phase === 'open') {
      this.terminalState = {
        phase: 'claimed',
        claim: {
          owner: 'event',
          cause: 'terminal_event',
          fact: { kind: 'reserved', event: runtimeEvent },
          header: { kind: 'pending' },
        },
      };
      return 'turn_terminal';
    }
    const claim = this.terminalClaim();
    if (!claim) {
      throw new RuntimeInteractionInvariantError(
        `Run ${this.runId} cannot claim a terminal event after failed finalization`,
      );
    }
    if (claim.fact.kind === 'empty') {
      this.updateTerminalClaim({
        ...claim,
        fact: {
          kind: 'reserved',
          event:
            claim.owner === 'stop'
              ? this.abortedRuntimeEvent(runtimeEvent)
              : claim.cause === 'failure'
                ? this.failedRuntimeEvent(runtimeEvent)
                : runtimeEvent,
        },
      });
    }
    return claim.owner === 'stop' ? 'turn_stopped' : 'turn_terminal';
  }

  /** Synchronously reserves the event owner for a failure that precedes a terminal event. */
  claimFailureTerminal(error?: unknown): RuntimeInteractionRunClosureReason {
    if (this.terminalState.phase === 'open') {
      this.terminalState = {
        phase: 'claimed',
        claim: {
          owner: 'event',
          cause: 'failure',
          fact: { kind: 'empty' },
          header: { kind: 'pending' },
        },
      };
      this.fixFailureSemantics(error);
      return 'turn_terminal';
    }
    const claim = this.terminalClaim();
    if (claim?.owner === 'event' && claim.cause === 'failure') {
      this.fixFailureSemantics(error);
    }
    return claim?.owner === 'stop' ? 'turn_stopped' : 'turn_terminal';
  }

  /** Prepare a synthetic terminal claim without performing persistence. */
  prepareFinalizationTerminal(): RuntimeInteractionRunClosureReason {
    this.assertExecutionActive();
    const lastTs = this.lastTs || this.input.now();
    if (this.isStopped()) this.finalStatus = { status: 'aborted' };
    if (!this.finalStatus) {
      this.finalStatus = { status: 'blocked', blockedReason: 'unknown' };
      this.failureClass = 'missing_terminal_event';
      this.failureMessage = 'run finalized without a terminal SessionEvent';
    }
    this.reserveFinalizationTerminal(this.finalStatus, lastTs);
    return this.terminalClaim()?.owner === 'stop' ? 'turn_stopped' : 'turn_terminal';
  }

  async begin(): Promise<AgentRunBeginResult> {
    this.assertExecutionActive();
    await this.createRunRecord();
    this.assertExecutionActive();

    let initialRuntimeEventId: string;
    if (this.recordsSessionMessages()) {
      const userMessageId = this.input.userMessageId ?? this.input.newId();
      const userMessageTs = this.input.now();
      initialRuntimeEventId = userMessageId;
      const userMsg: UserMessage = {
        type: 'user',
        id: userMessageId,
        turnId: this.turnId,
        ts: userMessageTs,
        text: this.input.userInput.text,
        ...(this.input.userInput.displayText !== undefined
          ? { displayText: this.input.userInput.displayText }
          : {}),
        ...(this.input.userInput.attachments
          ? { attachments: this.input.userInput.attachments }
          : {}),
        ...(this.input.userInput.quotes ? { quotes: this.input.userInput.quotes } : {}),
        ...(this.input.userInput.origin ? { origin: this.input.userInput.origin } : {}),
      };
      await this.executionWrite(() => this.input.store.appendMessage(this.sessionId, userMsg));
      await this.executionWrite(() =>
        this.input.hooks.appendTurnState(this.sessionId, this.turnId, 'running', this.lineage),
      );
      this.lastTs = userMessageTs;
    } else {
      initialRuntimeEventId = this.input.newId();
      this.lastTs = this.input.now();
    }

    const initialRuntimeEvent = this.buildInitialRuntimeEvent(initialRuntimeEventId, this.lastTs);
    await this.recordRuntimeEvents([initialRuntimeEvent], {
      requireDurableWrite: this.requiresDurablePersistence(),
    });
    this.assertExecutionActive();

    if (!this.header.connectionLocked) {
      this.header = await this.executionWrite(() =>
        this.input.hooks.updateHeader(this.sessionId, { connectionLocked: true }),
      );
    }

    this.assertExecutionActive();
    this.active = await this.input.hooks.ensureActive(this.sessionId, this.header);
    this.assertExecutionActive();
    this.input.hooks.registerRun(this.active, this);
    if (this.hasStopClaim()) {
      return {
        backend: this.active.backend,
        backendInput: {
          turnId: this.turnId,
          text: this.input.userInput.text,
          ...(this.input.userInput.attachments
            ? { attachments: this.input.userInput.attachments }
            : {}),
          context: [],
        },
        initialRuntimeEvent,
      };
    }
    await this.markRunStarted(this.lastTs);

    await this.executionWrite(() =>
      this.input.hooks.updateStatus(this.sessionId, 'running', undefined, this.lastTs),
    );

    const priorRuntimeContext = await this.buildPriorRuntimeContext();
    this.assertExecutionActive();
    const projectionContext = priorRuntimeContext
      ? projectRuntimeEventsToStoredMessages(priorRuntimeContext.events, {
          runHeaders: priorRuntimeContext.runs,
        }).messages
      : [];

    return {
      backend: this.active.backend,
      backendInput: {
        turnId: this.turnId,
        orchestration: this.effectiveOrchestration,
        text: this.input.userInput.text,
        ...(this.input.userInput.attachments
          ? { attachments: this.input.userInput.attachments }
          : {}),
        ...(this.input.userInput.quotes ? { quotes: this.input.userInput.quotes } : {}),
        context: projectionContext,
        ...(priorRuntimeContext ? { runtimeContext: priorRuntimeContext.events } : {}),
      },
      initialRuntimeEvent,
    };
  }

  async beginOperation(): Promise<AgentRunOperationBeginResult> {
    this.assertExecutionActive();
    await this.createRunRecord();
    this.assertExecutionActive();

    const startedAt = this.input.now();
    this.lastTs = startedAt;
    if (this.recordsSessionMessages()) {
      await this.executionWrite(() =>
        this.input.hooks.appendTurnState(this.sessionId, this.turnId, 'running', this.lineage, {
          ts: startedAt,
        }),
      );
    }

    if (!this.header.connectionLocked) {
      this.header = await this.executionWrite(() =>
        this.input.hooks.updateHeader(this.sessionId, { connectionLocked: true }),
      );
    }

    this.assertExecutionActive();
    this.active = await this.input.hooks.ensureActive(this.sessionId, this.header);
    this.assertExecutionActive();
    this.input.hooks.registerRun(this.active, this);
    if (this.hasStopClaim()) {
      return { backend: this.active.backend, runtimeContext: [], startedAt };
    }
    await this.markRunStarted(startedAt);

    await this.executionWrite(() =>
      this.input.hooks.updateStatus(this.sessionId, 'running', undefined, startedAt),
    );

    const priorRuntimeContext = await this.buildPriorRuntimeContext();
    this.assertExecutionActive();
    return {
      backend: this.active.backend,
      runtimeContext: priorRuntimeContext?.events ?? [],
      startedAt,
    };
  }

  async beginContinuation(
    continuation: RuntimeContinuation,
  ): Promise<AgentRunContinuationBeginResult> {
    this.assertExecutionActive();
    if (
      continuation.sessionId !== this.sessionId ||
      continuation.runId !== this.runId ||
      continuation.turnId !== this.turnId
    ) {
      throw new Error('Runtime continuation identity does not match the target AgentRun');
    }

    this.continuationActive = true;
    await this.createRunRecord(continuation);
    this.assertExecutionActive();
    await this.input.continuationFailpoint?.('after_run_created');
    this.assertExecutionActive();
    const startedAt = this.input.now();
    this.lastTs = startedAt;
    if (this.recordsSessionMessages()) {
      await this.executionWrite(() =>
        this.input.hooks.appendTurnState(this.sessionId, this.turnId, 'running', this.lineage, {
          ts: startedAt,
        }),
      );
    }

    if (!this.header.connectionLocked) {
      this.header = await this.executionWrite(() =>
        this.input.hooks.updateHeader(this.sessionId, { connectionLocked: true }),
      );
    }

    this.assertExecutionActive();
    this.active = await this.input.hooks.ensureActive(this.sessionId, this.header);
    this.assertExecutionActive();
    this.input.hooks.registerRun(this.active, this);
    if (this.hasStopClaim()) return { backend: this.active.backend, startedAt };
    await this.markRunStarted(startedAt);
    await this.executionWrite(() =>
      this.input.hooks.updateStatus(this.sessionId, 'running', undefined, startedAt),
    );

    return { backend: this.active.backend, startedAt };
  }

  private buildInitialRuntimeEvent(id: string, ts: number): RuntimeEvent {
    return buildInitialUserRuntimeEvent({
      id,
      invocationId: this.invocationId,
      runId: this.runId,
      sessionId: this.sessionId,
      turnId: this.turnId,
      ts,
      text: this.input.userInput.text,
      ...(this.input.userInput.displayText !== undefined
        ? { displayText: this.input.userInput.displayText }
        : {}),
      ...(this.input.userInput.attachments !== undefined
        ? { attachments: this.input.userInput.attachments }
        : {}),
      ...(this.input.userInput.quotes !== undefined ? { quotes: this.input.userInput.quotes } : {}),
      ...(this.toolBoundaryProtocol ? { toolBoundaryProtocol: this.toolBoundaryProtocol } : {}),
    });
  }

  async recordStoredSessionEvent(ev: SessionEvent): Promise<void> {
    this.assertExecutionActive();
    if (!this.recordsSessionMessages()) return;
    if (ev.type === 'token_usage') {
      await this.executionWrite(() =>
        this.input.store.appendMessage(this.sessionId, { ...ev } satisfies StoredMessage),
      );
    }
  }

  async recordSessionEvent(ev: SessionEvent): Promise<void> {
    this.assertExecutionActive();
    this.lastTs = ev.ts;
    const terminalInput = ev.type === 'complete' || ev.type === 'abort';
    const transition =
      terminalInput && this.hasFailureClaim()
        ? { status: 'blocked' as const, blockedReason: 'unknown' as const }
        : statusFromEvent(ev);
    const terminalSessionEvent =
      (ev.type === 'complete' || ev.type === 'abort') && !this.turnFailed;
    const turnStatus = terminalSessionEvent ? turnStatusFromEvent(ev) : undefined;
    if (terminalSessionEvent) {
      this.sawCompletion = true;
      this.finalStatus = this.isStopped()
        ? { status: 'aborted' }
        : (transition ?? { status: 'active' });
      // A terminal complete event can carry a failure without a preceding
      // error event. Record it now so finalize preserves the precise class.
      if (
        turnStatus?.status === 'failed' &&
        turnStatus.errorClass &&
        !this.failureClass &&
        !this.isStopped()
      ) {
        this.markRunFailed(
          turnStatus.errorClass,
          `turn ended with stopReason=${ev.type === 'complete' ? ev.stopReason : 'unknown'}`,
          ev.ts,
        );
      }
    }
    if (transition && !this.isStopped()) {
      if (terminalSessionEvent || ev.type === 'error') {
        await this.executionWrite(() =>
          this.input.hooks.updateStatus(
            this.sessionId,
            transition.status,
            transition.blockedReason,
            ev.ts,
          ),
        ).catch((error) => {
          throwIfRuntimeLifecycleFatal(error);
          return this.enqueueTraceWriteFailure(error, 'terminal session projection');
        });
      } else {
        await this.executionWrite(() =>
          this.input.hooks.updateStatus(
            this.sessionId,
            transition.status,
            transition.blockedReason,
            ev.ts,
          ),
        );
      }
      this.recordStatusFromTransition(ev, transition, ev.ts);
    }
    if (turnStatus && !this.isStopped() && this.recordsSessionMessages()) {
      const appendTurnState = this.executionWrite(() =>
        this.input.hooks.appendTurnState(
          this.sessionId,
          this.turnId,
          turnStatus.status,
          this.lineage,
          {
            ts: ev.ts,
            errorClass: turnStatus.errorClass,
            ...(turnStatus.status === 'aborted' && this.abortSource()
              ? { abortSource: this.abortSource() }
              : {}),
          },
        ),
      );
      if (terminalSessionEvent || ev.type === 'error') {
        await appendTurnState.catch((error) => {
          throwIfRuntimeLifecycleFatal(error);
          return this.enqueueTraceWriteFailure(error, 'terminal session projection');
        });
      } else {
        await appendTurnState;
      }
    }
    if (ev.type === 'error') {
      if (this.isStopped()) {
        this.finalStatus = { status: 'aborted' };
      } else {
        this.turnFailed = true;
        this.finalStatus = transition ?? { status: 'blocked', blockedReason: 'unknown' };
        if (this.recordsSessionMessages()) {
          await this.executionWrite(() =>
            this.input.hooks.appendTurnState(this.sessionId, this.turnId, 'failed', this.lineage, {
              ts: ev.ts,
              errorClass: ev.reason ?? ev.code ?? 'unknown',
            }),
          ).catch((error) => {
            throwIfRuntimeLifecycleFatal(error);
            return this.enqueueTraceWriteFailure(error, 'terminal session projection');
          });
        }
        this.markRunFailed(ev.reason ?? ev.code ?? 'unknown', ev.message, ev.ts);
      }
    }
  }

  async recordRuntimeEvents(
    events: readonly RuntimeEvent[],
    options: { requireTerminalWrite?: boolean; requireDurableWrite?: boolean } = {},
  ): Promise<void> {
    this.assertExecutionActive();
    if (events.length === 0) return;
    for (const event of events) {
      this.assertExecutionActive();
      const terminal = isTerminalRuntimeEvent(event);
      let eventForStore = event;
      if (terminal) {
        this.claimTerminalEvent(event);
        const fact = this.requireTerminalClaim().fact;
        if (fact.kind === 'writing' || fact.kind === 'committed') continue;
        if (fact.kind === 'empty') {
          throw new RuntimeInteractionInvariantError(
            `Run ${this.runId} terminal claim has no RuntimeEvent fact`,
          );
        }
        eventForStore = fact.event;
      }
      if (!this.input.runtimeEventStore || !this.runtimeEventStoreAvailable) {
        if (this.input.runtimeEventStore?.durability === 'canonical') {
          throw (
            this.runtimeEventStoreFailure ??
            new Error('canonical RuntimeEvent store is unavailable')
          );
        }
        if (terminal && options.requireTerminalWrite) {
          throw new Error('terminal RuntimeEvent store is unavailable');
        }
        if (options.requireDurableWrite && this.input.runtimeEventStore) {
          // The store exists but earlier writes failed: a durability-required
          // event (steering) must not silently skip the ledger.
          throw new Error('RuntimeEvent store is unavailable for a durability-required event');
        }
        continue;
      }
      const write = this.enqueueRuntimeEventStore(
        'append runtime event',
        async () => {
          await this.input.runtimeEventStore?.appendRuntimeEvent(
            this.sessionId,
            this.runId,
            eventForStore,
            { durable: terminal || options.requireDurableWrite === true },
          );
        },
        {
          rethrow:
            terminal ||
            options.requireTerminalWrite ||
            options.requireDurableWrite ||
            this.input.runtimeEventStore.durability === 'canonical',
        },
      );
      if (terminal) {
        const claim = this.requireTerminalClaim();
        this.updateTerminalClaim({
          ...claim,
          fact: { kind: 'writing', event: eventForStore, write },
        });
      }
      if (options.requireDurableWrite && !terminal) {
        // An append error is AMBIGUOUS: the bytes may have landed before the
        // failure (e.g. a close error after the write). For a
        // durability-required event the caller settles a delivery lease on
        // this outcome, so a false "not durable" would redeliver a message
        // the ledger already owns. Read the ledger back to disambiguate:
        // present ⇒ durable (continue on the ack path); absent or read-back
        // also failing ⇒ fail closed (rethrow ⇒ nack).
        try {
          await write;
        } catch (error) {
          throwIfRuntimeLifecycleFatal(error);
          if (error instanceof DurableStoreWriteError) throw error;
          if (!(await this.eventLandedInLedger(eventForStore.id))) throw error;
          // The write landed and the ledger answered a fresh read — the
          // failure was in the reporting, not the store. Lift the
          // unavailability latch so the rest of the turn (including its
          // required terminal write) keeps persisting; a genuinely broken
          // store re-latches on its next write.
          this.runtimeEventStoreAvailable = true;
        }
        continue;
      }
      await write;
      if (terminal) {
        const claim = this.requireTerminalClaim();
        if (claim.fact.kind === 'writing' && claim.fact.write === write) {
          this.updateTerminalClaim({
            ...claim,
            fact: { kind: 'committed', event: eventForStore },
          });
        }
      }
    }
  }

  private abortedRuntimeEvent(event: RuntimeEvent): RuntimeEvent {
    const { content: _content, ...rest } = event;
    void _content;
    return {
      ...rest,
      status: 'aborted',
      actions: {
        ...event.actions,
        endInvocation: true,
        stateDelta: {
          ...event.actions?.stateDelta,
          abortSource: this.abortSource() ?? 'user_stop',
        },
      },
    };
  }

  private failedRuntimeEvent(event: RuntimeEvent): RuntimeEvent {
    const failureClass = this.failureClass ?? 'unknown';
    const stateDelta = { ...event.actions?.stateDelta };
    delete stateDelta.abortSource;
    return {
      ...event,
      status: 'failed',
      content: {
        kind: 'error',
        code: failureClass,
        reason: failureClass,
        message: this.failureMessage ?? failureClass,
      },
      actions: {
        ...event.actions,
        endInvocation: true,
        stateDelta: {
          ...stateDelta,
          failureClass,
        },
      },
    };
  }

  async recordFailure(error: unknown): Promise<void> {
    this.assertExecutionActive();
    throwIfRuntimeLifecycleFatal(error);
    const reason = this.claimFailureTerminal(error);
    if (reason === 'turn_stopped') {
      this.finalStatus = { status: 'aborted' };
      return;
    }
    if (!this.hasFailureClaim()) return;
    const failureClass = this.failureClass ?? 'unknown';
    const message = this.failureMessage ?? errorMessage(error);
    this.markRunFailed(failureClass, message, this.input.now());
    if (this.recordsSessionMessages()) {
      await this.executionWrite(() =>
        this.input.hooks.appendTurnState(this.sessionId, this.turnId, 'failed', this.lineage, {
          errorClass: failureClass,
        }),
      ).catch((writeError) => {
        throwIfRuntimeLifecycleFatal(writeError);
        this.assertExecutionActive();
      });
    }
  }

  async finalize(): Promise<void> {
    if (this.terminalState.phase === 'finalized') return;
    if (this.terminalState.phase === 'finalization_failed') {
      throw this.terminalState.error;
    }
    if (this.terminalState.phase === 'finalizing') {
      return await this.terminalState.task;
    }
    this.assertExecutionActive();
    this.prepareFinalizationTerminal();
    const claim = this.requireTerminalClaim();
    const task = this.finalizeOnce().then(
      () => {
        this.terminalState = { phase: 'finalized', claim: this.requireTerminalClaim() };
      },
      (error) => {
        this.terminalState = {
          phase: 'finalization_failed',
          claim: this.requireTerminalClaim(),
          error,
        };
        throw error;
      },
    );
    this.terminalState = { phase: 'finalizing', claim, task };
    return await task;
  }

  private async finalizeOnce(): Promise<void> {
    const lastTs = this.lastTs || this.input.now();
    const active = this.active;
    const nextStatus =
      active && [...active.activeRuns.values()].some((run) => run !== this)
        ? { status: 'running' as const }
        : (this.finalStatus ?? { status: 'active' as const });
    let finalizeFailed = false;
    let finalizeFailure: unknown;
    try {
      this.assertExecutionActive();
      try {
        await this.executionWrite(() =>
          this.input.hooks.updateHeader(this.sessionId, {
            lastUsedAt: lastTs,
            lastMessageAt: lastTs,
            hasUnread: true,
            ...buildStatusPatch(nextStatus.status, lastTs, nextStatus.blockedReason),
          }),
        );
      } catch (error) {
        throwIfRuntimeLifecycleFatal(error);
        this.assertExecutionActive();
        // The user-visible turn already completed; preserve existing behavior.
      }
      this.assertExecutionActive();
      if (this.sawCompletion && this.recordsSessionMessages()) {
        await this.executionWrite(() =>
          this.input.store.appendMessage(this.sessionId, {
            type: 'system_note',
            id: this.input.newId(),
            turnId: this.turnId,
            ts: lastTs,
            kind: 'session_resume',
          } satisfies SystemNoteMessage),
        ).catch((error) => {
          throwIfRuntimeLifecycleFatal(error);
          this.assertExecutionActive();
        });
      }
      this.assertExecutionActive();
      await this.finishRun(this.finalStatus, lastTs);
    } catch (error) {
      finalizeFailed = true;
      finalizeFailure = error;
    }

    throwIfRuntimeLifecycleFatal(finalizeFailure);
    if (active) {
      this.assertExecutionActive();
      try {
        await this.input.hooks.unregisterRun(active, this);
        this.assertExecutionActive();
      } catch (error) {
        const restoreIdentity = (): void => {
          try {
            this.input.hooks.registerRun(active, this);
          } catch {
            // Preserve the finalization/fail-stop failure over local registry repair.
          }
        };
        try {
          this.assertExecutionActive();
        } catch (canonicalError) {
          restoreIdentity();
          throw canonicalError;
        }
        if (isRuntimeLifecycleFatal(error)) restoreIdentity();
        throw error;
      }
    }
    if (finalizeFailed) throw finalizeFailure;
  }

  private recordsSessionMessages(): boolean {
    return this.input.recordSessionMessages !== false;
  }

  private async createRunRecord(continuation?: RuntimeContinuation): Promise<void> {
    this.assertExecutionActive();
    if (!this.input.runStore) {
      if (continuation) throw new Error('Runtime continuation requires a durable run store');
      return;
    }
    const createdAt = this.input.now();
    const header: AgentRunHeader = {
      runId: this.runId,
      invocationId: this.invocationId,
      sessionId: this.sessionId,
      turnId: this.turnId,
      status: 'created',
      backendKind: this.header.backend,
      llmConnectionSlug: this.header.llmConnectionSlug,
      modelId: this.header.model,
      cwd: this.header.cwd,
      ...(this.input.workspaceIdentity ? { workspaceIdentity: this.input.workspaceIdentity } : {}),
      permissionMode: this.header.permissionMode,
      collaborationMode: this.header.collaborationMode ?? 'agent',
      orchestrationMode: this.effectiveOrchestration.mode,
      orchestrationSource: this.effectiveOrchestration.source,
      agentSwarmAuthorization: this.effectiveOrchestration.agentSwarmAuthorization,
      createdAt,
      updatedAt: createdAt,
      ...this.lineage,
      ...(continuation
        ? {
            continuationSource: {
              sourceInvocationId: continuation.sourceInvocationId,
              sourceRunId: continuation.sourceRunId,
              sourceTurnId: continuation.sourceTurnId,
              sourceRuntimeEventHighWater: continuation.sourceRuntimeEventHighWater,
            },
          }
        : {}),
      ...(this.input.userInput.agentId ? { agentId: this.input.userInput.agentId } : {}),
      ...(this.input.userInput.agentName ? { agentName: this.input.userInput.agentName } : {}),
      ...(this.input.userInput.origin?.kind === 'automation'
        ? {
            automationId: this.input.userInput.origin.automationId,
            ...(this.input.userInput.origin.fireId
              ? { automationFireId: this.input.userInput.origin.fireId }
              : {}),
          }
        : {}),
    };
    try {
      const durable = this.requiresDurablePersistence();
      await this.executionWrite(() => this.input.runStore!.createRun(header, { durable }));
      await this.executionWrite(() =>
        this.input.runStore!.appendEvent(
          this.sessionId,
          this.runId,
          {
            type: 'run_created',
            id: this.input.newId(),
            runId: this.runId,
            sessionId: this.sessionId,
            turnId: this.turnId,
            ts: createdAt,
            data: {
              textLength: this.input.userInput.text.length,
              attachmentCount: this.input.userInput.attachments?.length ?? 0,
              orchestrationMode: this.effectiveOrchestration.mode,
              orchestrationSource: this.effectiveOrchestration.source,
              agentSwarmAuthorization: this.effectiveOrchestration.agentSwarmAuthorization,
            },
          },
          { durable },
        ),
      );
    } catch (error) {
      this.assertExecutionActive();
      throwIfRuntimeLifecycleFatal(error);
      this.runStoreAvailable = false;
      if (this.requiresDurablePersistence()) throw error;
      this.enqueueTraceWriteFailure(error);
      if (continuation) throw error;
    }
  }

  private requiresDurablePersistence(): boolean {
    return this.input.durability === 'required';
  }

  private async buildPriorRuntimeContext(): Promise<PriorRuntimeContext | undefined> {
    this.assertExecutionActive();
    if (this.lineage.resumedFromRunId) {
      return await this.buildResumedChildRuntimeContext(this.lineage.resumedFromRunId);
    }
    if (this.lineage.parentRunId) return undefined;
    if (
      !this.input.runStore ||
      !this.input.runtimeEventStore ||
      !this.runStoreAvailable ||
      !this.runtimeEventStoreAvailable
    )
      return undefined;
    const runs = await this.input.runStore.listSessionRuns(this.sessionId);
    const priorRuns = runs.filter(
      (run) => run.runId !== this.runId && run.turnId !== this.turnId && isSessionInlineRun(run),
    );
    if (priorRuns.length === 0) return undefined;

    const ordered: Array<{ event: RuntimeEvent; runIndex: number; eventIndex: number }> = [];
    for (let runIndex = 0; runIndex < priorRuns.length; runIndex += 1) {
      const run = priorRuns[runIndex]!;
      if (!isTerminalRunStatus(run.status)) {
        const terminalFactContext = await this.readNonTerminalPriorRunWithTerminalFact(run);
        this.assertExecutionActive();
        if (!terminalFactContext) continue;
        priorRuns[runIndex] = terminalFactContext.run;
        for (let eventIndex = 0; eventIndex < terminalFactContext.events.length; eventIndex += 1) {
          const event = terminalFactContext.events[eventIndex]!;
          if (event.runId === this.runId || event.turnId === this.turnId) continue;
          ordered.push({ event, runIndex, eventIndex });
        }
        continue;
      }
      let events = await this.input.runtimeEventStore.readRuntimeEvents(this.sessionId, run.runId);
      this.assertExecutionActive();
      if (events.length === 0) {
        if (
          await this.executionWrite(
            () =>
              this.input.repairRunRuntimeLedger?.(this.sessionId, run.runId) ??
              Promise.resolve(false),
          )
        ) {
          events = await this.input.runtimeEventStore.readRuntimeEvents(this.sessionId, run.runId);
          this.assertExecutionActive();
        }
      }
      if (events.length === 0) {
        const recovered = await this.backfillMissingPriorRuntimeEvents(run);
        this.assertExecutionActive();
        if (recovered.length === 0 || !recovered.some(isTerminalRuntimeEvent)) {
          throw new Error(
            `Cannot build model context: RuntimeEvent ledger is missing for prior run ${run.runId}`,
          );
        }
        events = recovered;
      }
      if (!events.some(isTerminalRuntimeEvent)) {
        if (
          await this.executionWrite(
            () =>
              this.input.repairRunRuntimeLedger?.(this.sessionId, run.runId) ??
              Promise.resolve(false),
          )
        ) {
          events = await this.input.runtimeEventStore.readRuntimeEvents(this.sessionId, run.runId);
          this.assertExecutionActive();
        }
      }
      if (!events.some(isTerminalRuntimeEvent)) {
        throw new Error(
          `Cannot build model context: RuntimeEvent ledger has no terminal fact for prior run ${run.runId}`,
        );
      }
      let terminalFact = classifyRuntimeEventTerminalFact(run, events).fact;
      if (
        !terminalFact &&
        (await this.executionWrite(
          () =>
            this.input.repairRunRuntimeLedger?.(this.sessionId, run.runId) ??
            Promise.resolve(false),
        ))
      ) {
        events = await this.input.runtimeEventStore.readRuntimeEvents(this.sessionId, run.runId);
        this.assertExecutionActive();
        terminalFact = classifyRuntimeEventTerminalFact(run, events).fact;
      }
      if (!terminalFact) {
        throw new Error(
          `Cannot build model context: RuntimeEvent ledger has no valid terminal fact for prior run ${run.runId}`,
        );
      }
      priorRuns[runIndex] = effectiveRunHeaderFromTerminalFact(run, terminalFact);
      for (let eventIndex = 0; eventIndex < events.length; eventIndex += 1) {
        const event = events[eventIndex]!;
        if (event.runId === this.runId || event.turnId === this.turnId) continue;
        ordered.push({ event, runIndex, eventIndex });
      }
    }

    ordered.sort((a, b) => a.runIndex - b.runIndex || a.eventIndex - b.eventIndex);
    const events = ordered.map((item) => item.event);
    if (events.length === 0) return undefined;

    const runtimeReplayPlan = buildRuntimeEventModelReplayPlan(events);
    if (runtimeReplayPlan.items.length === 0) return undefined;
    return { events, runs: priorRuns };
  }

  private async buildResumedChildRuntimeContext(sourceRunId: string): Promise<PriorRuntimeContext> {
    if (
      !this.input.runStore ||
      !this.input.runtimeEventStore ||
      !this.runStoreAvailable ||
      !this.runtimeEventStoreAvailable
    ) {
      throw new Error('Child AgentRun resume requires durable run and RuntimeEvent stores');
    }

    const sessionRuns = await this.input.runStore.listSessionRuns(this.sessionId);
    this.assertExecutionActive();
    const runsById = new Map(sessionRuns.map((run) => [run.runId, run]));
    const reverseChain: AgentRunHeader[] = [];
    const visited = new Set<string>();
    let cursor: string | undefined = sourceRunId;
    while (cursor) {
      if (visited.has(cursor)) {
        throw new Error(`Child AgentRun resume lineage contains a cycle at ${cursor}`);
      }
      visited.add(cursor);
      const run = runsById.get(cursor);
      if (!run) throw new Error(`Child AgentRun resume source ${cursor} was not found`);
      if (!run.parentRunId || isSessionInlineRun(run)) {
        throw new Error(`AgentRun ${cursor} is not a resumable child run`);
      }
      if (!run.agentId || run.agentId !== this.input.userInput.agentId) {
        throw new Error(`Child AgentRun resume profile changed at ${cursor}`);
      }
      reverseChain.push(run);
      cursor = run.resumedFromRunId;
    }

    const chain = reverseChain.reverse();
    const effectiveRuns: AgentRunHeader[] = [];
    const events: RuntimeEvent[] = [];
    for (const run of chain) {
      const loaded = await this.loadRequiredChildResumeContext(run);
      this.assertExecutionActive();
      effectiveRuns.push(loaded.run);
      events.push(...loaded.events);
    }

    const replay = buildRuntimeEventModelReplayPlan(events);
    const unsafe = replay.diagnostics.find(
      (diagnostic) =>
        diagnostic.code === 'unmatched_tool_call' ||
        diagnostic.code === 'unmatched_tool_result' ||
        diagnostic.code === 'tool_id_mismatch' ||
        diagnostic.code === 'unsupported_role' ||
        diagnostic.code === 'unsupported_content',
    );
    if (unsafe) {
      throw new Error(`Child AgentRun resume history is unsafe: ${unsafe.code}`);
    }
    const first = replay.items[0];
    if (!first || first.kind !== 'text' || first.role !== 'user') {
      throw new Error('Child AgentRun resume history has no user-anchored replay boundary');
    }
    return { events, runs: effectiveRuns };
  }

  private async loadRequiredChildResumeContext(
    run: AgentRunHeader,
  ): Promise<{ events: RuntimeEvent[]; run: AgentRunHeader }> {
    this.assertExecutionActive();
    let events = await this.input.runtimeEventStore!.readRuntimeEvents(this.sessionId, run.runId);
    this.assertExecutionActive();
    if (events.length === 0 || !events.some(isTerminalRuntimeEvent)) {
      if (
        await this.executionWrite(
          () =>
            this.input.repairRunRuntimeLedger?.(this.sessionId, run.runId) ??
            Promise.resolve(false),
        )
      ) {
        events = await this.input.runtimeEventStore!.readRuntimeEvents(this.sessionId, run.runId);
        this.assertExecutionActive();
      }
    }
    if (events.length === 0 || !events.some(isTerminalRuntimeEvent)) {
      throw new Error(
        `Child AgentRun resume source ${run.runId} has no terminal RuntimeEvent fact`,
      );
    }
    const terminalFact = classifyRuntimeEventTerminalFact(run, events).fact;
    if (!terminalFact) {
      throw new Error(
        `Child AgentRun resume source ${run.runId} has an invalid terminal RuntimeEvent fact`,
      );
    }
    return { events, run: effectiveRunHeaderFromTerminalFact(run, terminalFact) };
  }

  private async readNonTerminalPriorRunWithTerminalFact(
    run: AgentRunHeader,
  ): Promise<PriorRunTerminalFactContext | undefined> {
    this.assertExecutionActive();
    if (!this.input.runtimeEventStore) return undefined;
    const events = await this.input.runtimeEventStore
      .readRuntimeEvents(this.sessionId, run.runId)
      .catch(() => []);
    const terminalFact = classifyRuntimeEventTerminalFact(run, events).fact;
    if (!terminalFact) return undefined;
    return { events, run: effectiveRunHeaderFromTerminalFact(run, terminalFact) };
  }

  private async backfillMissingPriorRuntimeEvents(run: AgentRunHeader): Promise<RuntimeEvent[]> {
    this.assertExecutionActive();
    let messages: StoredMessage[];
    try {
      messages = await this.input.store.readMessages(this.sessionId);
    } catch (error) {
      throwIfRuntimeLifecycleFatal(error);
      this.assertExecutionActive();
      return [];
    }
    this.assertExecutionActive();
    return backfillRuntimeEventsFromStoredMessages({ run, messages }).events;
  }

  private async markRunStarted(ts: number): Promise<void> {
    if (!this.input.runStore || !this.runStoreAvailable) return;
    const durable = this.requiresDurablePersistence();
    const write = this.enqueueRunStore(
      'mark run started',
      async () => {
        await this.input.runStore?.appendEvent(
          this.sessionId,
          this.runId,
          {
            type: 'run_started',
            id: this.input.newId(),
            runId: this.runId,
            sessionId: this.sessionId,
            turnId: this.turnId,
            ts,
          },
          { durable },
        );
        await this.input.runStore?.updateRun(
          this.sessionId,
          this.runId,
          { status: 'running', updatedAt: ts },
          { durable },
        );
      },
      { rethrow: durable },
    );
    if (durable) await write;
  }

  private recordStatusFromTransition(
    ev: SessionEvent,
    transition: { status: SessionStatus; blockedReason?: SessionBlockedReason },
    ts: number,
  ): void {
    if (!this.input.runStore || !this.runStoreAvailable) return;
    const status =
      transition.status === 'waiting_for_user'
        ? 'waiting_permission'
        : transition.status === 'aborted'
          ? 'cancelled'
          : transition.status === 'blocked'
            ? 'failed'
            : transition.status === 'active'
              ? 'completed'
              : 'running';
    if (isTerminalRunStatus(status)) return;
    this.enqueueRunStore('record run status', async () => {
      await this.input.runStore?.updateRun(this.sessionId, this.runId, { status, updatedAt: ts });
      await this.input.runStore?.appendEvent(this.sessionId, this.runId, {
        type: 'run_status_changed',
        id: this.input.newId(),
        runId: this.runId,
        sessionId: this.sessionId,
        turnId: this.turnId,
        ts,
        data: {
          sessionStatus: transition.status,
          ...(transition.blockedReason ? { blockedReason: transition.blockedReason } : {}),
        },
      });
    });
    if (ev.type === 'abort') {
      this.markRunCancelled(ev.reason, ts);
    }
  }

  private markRunFailed(failureClass: string, message: string, ts: number): void {
    if (!this.input.runStore || !this.runStoreAvailable) return;
    this.failureClass = failureClass;
    this.failureMessage = redactTraceString(message);
    if (this.input.runtimeEventStore) return;
    this.enqueueRunStore('mark run failed', async () => {
      await this.input.runStore?.updateRun(this.sessionId, this.runId, {
        status: 'failed',
        updatedAt: ts,
        completedAt: ts,
        failureClass,
        failureMessage: this.failureMessage,
      });
      await this.input.runStore?.appendEvent(this.sessionId, this.runId, {
        type: 'run_failed',
        id: this.input.newId(),
        runId: this.runId,
        sessionId: this.sessionId,
        turnId: this.turnId,
        ts,
        message: redactTraceString(message),
        data: { failureClass },
      });
    });
  }

  private markRunCancelled(reason: string | undefined, ts: number): void {
    if (!this.input.runStore || !this.runStoreAvailable) return;
    if (this.input.runtimeEventStore) return;
    this.enqueueRunStore('mark run cancelled', async () => {
      await this.input.runStore?.updateRun(this.sessionId, this.runId, {
        status: 'cancelled',
        updatedAt: ts,
        completedAt: ts,
      });
      await this.input.runStore?.appendEvent(this.sessionId, this.runId, {
        type: 'run_cancelled',
        id: this.input.newId(),
        runId: this.runId,
        sessionId: this.sessionId,
        turnId: this.turnId,
        ts,
        ...(reason ? { message: redactTraceString(reason) } : {}),
      });
    });
  }

  private async finishRun(
    finalStatus: { status: SessionStatus; blockedReason?: SessionBlockedReason } | undefined,
    ts: number,
  ): Promise<void> {
    await this.traceQueue.catch((error) => {
      throwIfRuntimeLifecycleFatal(error);
    });
    this.assertExecutionActive();
    if (!this.input.runStore || !this.runStoreAvailable) return;
    const status = this.runStatusForFinalStatus(finalStatus);
    const isTerminal = status === 'completed' || status === 'failed' || status === 'cancelled';
    if (isTerminal && this.input.runtimeEventStore) {
      await this.commitTerminalRun(finalStatus, ts);
      return;
    }
    await this.enqueueRunStore('finish run', async () => {
      await this.input.runStore?.updateRun(this.sessionId, this.runId, {
        status,
        updatedAt: ts,
        ...(isTerminal ? { completedAt: ts } : {}),
        ...(status === 'failed'
          ? {
              failureClass: this.failureClass ?? finalStatus?.blockedReason ?? 'unknown',
              ...(this.failureMessage ? { failureMessage: this.failureMessage } : {}),
            }
          : {}),
      });
      await this.input.runStore?.appendEvent(this.sessionId, this.runId, {
        type:
          status === 'cancelled'
            ? 'run_cancelled'
            : status === 'failed'
              ? 'run_failed'
              : status === 'completed'
                ? 'run_completed'
                : 'run_status_changed',
        id: this.input.newId(),
        runId: this.runId,
        sessionId: this.sessionId,
        turnId: this.turnId,
        ts,
        ...(status === 'failed'
          ? { data: { failureClass: this.failureClass ?? finalStatus?.blockedReason ?? 'unknown' } }
          : status === 'waiting_permission'
            ? {
                data: {
                  sessionStatus: 'waiting_for_user',
                  blockedReason: finalStatus?.blockedReason ?? 'permission_required',
                },
              }
            : {}),
      });
    });
    await this.traceQueue.catch((error) => {
      throwIfRuntimeLifecycleFatal(error);
    });
    this.assertExecutionActive();
  }

  private runStatusForFinalStatus(
    finalStatus: { status: SessionStatus; blockedReason?: SessionBlockedReason } | undefined,
  ): AgentRunHeader['status'] {
    if (this.hasFailureClaim()) return 'failed';
    if (this.isStopped() || finalStatus?.status === 'aborted') return 'cancelled';
    if (this.failureClass || finalStatus?.status === 'blocked') return 'failed';
    if (finalStatus?.status === 'waiting_for_user') return 'waiting_permission';
    return 'completed';
  }

  private async commitTerminalRun(
    finalStatus: { status: SessionStatus; blockedReason?: SessionBlockedReason } | undefined,
    ts: number,
  ): Promise<void> {
    this.assertExecutionActive();
    const claimed = this.requireTerminalClaim();
    if (claimed.header.kind === 'committed') return;
    const runStore = this.input.runStore;
    const runtimeEventStore = this.input.runtimeEventStore;
    if (
      !runStore ||
      !this.runStoreAvailable ||
      !runtimeEventStore ||
      !this.runtimeEventStoreAvailable
    )
      return;
    const fallbackStatus = claimed.owner === 'stop' ? 'cancelled' : 'failed';
    const fallbackFailureClass = this.failureClass ?? 'missing_terminal_event';
    const fallbackFailureMessage =
      this.failureMessage ?? 'run finalized without a terminal RuntimeEvent';
    try {
      const terminalClaim = this.requireTerminalClaim();
      if (terminalClaim.fact.kind === 'empty') {
        throw new Error('terminal RuntimeEvent claim is missing');
      }
      const terminalEvent = terminalClaim.fact.event;
      if (terminalClaim.fact.kind === 'writing') await terminalClaim.fact.write;
      this.assertExecutionActive();
      if (this.continuationActive) {
        await this.input.continuationFailpoint?.('after_terminal_event_committed');
        this.assertExecutionActive();
      }
      const commit = commitOrCreateTerminalRunFact({
        runStore,
        runtimeEventStore,
        newId: this.input.newId,
        sessionId: this.sessionId,
        runId: this.runId,
        turnId: this.turnId,
        ts,
        terminalEvent,
        ...((this.failureClass ?? finalStatus?.blockedReason)
          ? { failureClass: this.failureClass ?? finalStatus?.blockedReason }
          : {}),
        ...(this.failureMessage ? { failureMessage: this.failureMessage } : {}),
        ...(this.abortSource() || fallbackStatus === 'cancelled'
          ? { abortSource: this.abortSource() ?? 'user_stop' }
          : {}),
        fallbackStatus,
        fallbackInvocationId: this.invocationId,
        ...(fallbackStatus === 'failed' ? { fallbackFailureClass, fallbackFailureMessage } : {}),
        allowHeaderCommitFailure: true,
      });
      const result = await commit;
      this.assertExecutionActive();
      if (result.headerCommitted) {
        const current = this.requireTerminalClaim();
        this.updateTerminalClaim({ ...current, header: { kind: 'committed' } });
      }
      if (result.headerCommitted && this.continuationActive) {
        await this.input.continuationFailpoint?.('after_terminal_header_committed');
        this.assertExecutionActive();
      }
      if (result.headerCommitError !== undefined) {
        await this.enqueueTraceWriteFailure(result.headerCommitError, 'commit terminal run header');
      }
    } catch (error) {
      this.assertExecutionActive();
      throwIfRuntimeLifecycleFatal(error);
      this.runStoreAvailable = false;
      await this.enqueueTraceWriteFailure(error, 'commit terminal run header');
      throw error;
    }
    await this.traceQueue.catch((error) => {
      throwIfRuntimeLifecycleFatal(error);
    });
    this.assertExecutionActive();
  }

  private reserveFinalizationTerminal(
    finalStatus: { status: SessionStatus; blockedReason?: SessionBlockedReason } | undefined,
    ts: number,
  ): void {
    const existingClaim = this.terminalClaim();
    if (existingClaim && existingClaim.fact.kind !== 'empty') return;
    const runStatus = this.runStatusForFinalStatus(finalStatus);
    if (runStatus !== 'completed' && runStatus !== 'failed' && runStatus !== 'cancelled') return;
    if (!existingClaim) {
      this.failureClass ??= 'missing_terminal_event';
      this.failureMessage ??= 'run finalized without a terminal RuntimeEvent';
      this.claimFailureTerminal();
    }
    const status =
      this.terminalClaim()?.owner === 'stop' || finalStatus?.status === 'aborted'
        ? 'cancelled'
        : 'failed';
    const failureClass = this.hasFailureClaim()
      ? (this.failureClass ?? 'unknown')
      : 'missing_terminal_event';
    const failureMessage = this.failureMessage ?? 'run finalized without a terminal RuntimeEvent';
    if (status === 'failed') {
      this.failureClass = failureClass;
      this.failureMessage = failureMessage;
    }
    this.claimTerminalEvent(
      buildSyntheticTerminalRuntimeEvent({
        id: this.input.newId(),
        invocationId: this.invocationId,
        run: { sessionId: this.sessionId, runId: this.runId, turnId: this.turnId },
        status,
        ts,
        ...(status === 'failed' ? { failureClass, message: failureMessage } : {}),
        ...(status === 'cancelled' ? { abortSource: this.abortSource() ?? 'user_stop' } : {}),
      }),
    );
  }

  private terminalClaim(): TerminalClaim | undefined {
    return this.terminalState.phase === 'open' ? undefined : this.terminalState.claim;
  }

  private requireTerminalClaim(): TerminalClaim {
    const claim = this.terminalClaim();
    if (!claim) {
      throw new RuntimeInteractionInvariantError(`Run ${this.runId} has no terminal claim`);
    }
    return claim;
  }

  private updateTerminalClaim(claim: TerminalClaim): void {
    switch (this.terminalState.phase) {
      case 'open':
        throw new RuntimeInteractionInvariantError(
          `Run ${this.runId} cannot update a terminal claim before causality is fixed`,
        );
      case 'claimed':
        this.terminalState = { phase: 'claimed', claim };
        return;
      case 'finalizing':
        this.terminalState = { ...this.terminalState, claim };
        return;
      case 'finalized':
        this.terminalState = { phase: 'finalized', claim };
        return;
      case 'finalization_failed':
        this.terminalState = { ...this.terminalState, claim };
    }
  }

  private hasFailureClaim(): boolean {
    const claim = this.terminalClaim();
    return claim?.owner === 'event' && claim.cause === 'failure';
  }

  private fixFailureSemantics(error: unknown): void {
    this.turnFailed = true;
    this.finalStatus = { status: 'blocked', blockedReason: 'unknown' };
    if (this.failureClass) return;
    this.failureClass = error instanceof Error ? error.name : 'unknown';
    this.failureMessage = redactTraceString(errorMessage(error));
  }

  private abortSource(): string | undefined {
    const claim = this.terminalClaim();
    if (!claim) return undefined;
    if (claim.owner === 'stop') return claim.abortSource;
    if (claim.fact.kind === 'empty') return undefined;
    const stateDelta = claim.fact.event.actions?.stateDelta;
    return stateDelta && typeof stateDelta.abortSource === 'string'
      ? stateDelta.abortSource
      : undefined;
  }

  private assertExecutionActive(): void {
    this.input.assertExecutionActive?.();
  }

  private async executionWrite<T>(operation: () => Promise<T>): Promise<T> {
    this.assertExecutionActive();
    const result = await operation();
    this.assertExecutionActive();
    return result;
  }

  private enqueueRunStore(
    label: string,
    operation: () => Promise<void>,
    options: { rethrow?: boolean } = {},
  ): Promise<void> {
    if (!this.input.runStore || !this.runStoreAvailable) return Promise.resolve();
    const guardedOperation = () => this.executionWrite(operation);
    const next = this.traceQueue.then(guardedOperation, guardedOperation).catch(async (error) => {
      this.assertExecutionActive();
      throwIfRuntimeLifecycleFatal(error);
      this.runStoreAvailable = false;
      await this.enqueueTraceWriteFailure(error, label);
      if (options.rethrow) throw error;
    });
    this.traceQueue = next.catch(() => {});
    return next;
  }

  /**
   * Each physical provider request gets its own best-effort diagnostic row.
   * One failed attempt append must not suppress later attempts or poison the
   * general AgentRun store latch; a required capture independently gates every
   * provider dispatch.
   */
  private enqueueBestEffortProviderAttempt(label: string, operation: () => Promise<void>): void {
    const guardedOperation = () => this.executionWrite(operation);
    const next = this.traceQueue.then(guardedOperation, guardedOperation).catch(async (error) => {
      this.assertExecutionActive();
      throwIfRuntimeLifecycleFatal(error);
      await this.enqueueTraceWriteFailure(error, label);
    });
    this.traceQueue = next.catch(() => {});
  }

  /**
   * A prepared-request capture is a dispatch gate, not diagnostic telemetry.
   * Always attempt its durable append even when an earlier best-effort run
   * trace write marked the general run ledger unavailable; only this append's
   * own outcome may decide whether the provider request can be dispatched.
   */
  private enqueueRequiredProviderCapture(
    label: string,
    operation: () => Promise<void>,
  ): Promise<void> {
    const guardedOperation = () => this.executionWrite(operation);
    const next = this.traceQueue.then(guardedOperation, guardedOperation).catch(async (error) => {
      this.assertExecutionActive();
      throwIfRuntimeLifecycleFatal(error);
      await this.enqueueTraceWriteFailure(error, label);
      throw error;
    });
    this.traceQueue = next.catch(() => {});
    return next;
  }

  /**
   * Read-back disambiguation for a failed durability-required append: true
   * only when the ledger demonstrably contains the event. Any doubt (no
   * read-back capability, read failure, event absent) reports false so the
   * caller stays fail-closed.
   */
  private async eventLandedInLedger(eventId: string): Promise<boolean> {
    this.assertExecutionActive();
    const store = this.input.runtimeEventStore;
    if (!store?.readImmutableRuntimeEvents) return false;
    try {
      const events = await store.readImmutableRuntimeEvents(this.sessionId, this.runId);
      this.assertExecutionActive();
      return events.some((event) => event.id === eventId);
    } catch (error) {
      throwIfRuntimeLifecycleFatal(error);
      this.assertExecutionActive();
      return false;
    }
  }

  private enqueueRuntimeEventStore(
    label: string,
    operation: () => Promise<void>,
    options: { rethrow?: boolean } = {},
  ): Promise<void> {
    if (!this.input.runtimeEventStore || !this.runtimeEventStoreAvailable) return Promise.resolve();
    const guardedOperation = () => this.executionWrite(operation);
    const next = this.runtimeEventQueue
      .then(guardedOperation, guardedOperation)
      .catch(async (error) => {
        this.assertExecutionActive();
        throwIfRuntimeLifecycleFatal(error);
        this.runtimeEventStoreAvailable = false;
        this.runtimeEventStoreFailure = error;
        await this.enqueueTraceWriteFailure(error, label);
        if (options.rethrow) throw error;
      });
    this.runtimeEventQueue = next.catch(() => {});
    return next;
  }

  private async enqueueTraceWriteFailure(
    error: unknown,
    label = 'agent run store write',
  ): Promise<void> {
    const message = errorMessage(error);
    try {
      await this.executionWrite(async () => {
        await this.input.runStore?.updateRun(this.sessionId, this.runId, {
          traceWriteError: `${label}: ${message}`,
          updatedAt: this.input.now(),
        });
      });
      await this.executionWrite(
        () =>
          this.input.runStore?.appendEvent(this.sessionId, this.runId, {
            type: 'trace_write_failed',
            id: this.input.newId(),
            runId: this.runId,
            sessionId: this.sessionId,
            turnId: this.turnId,
            ts: this.input.now(),
            message,
          }) ?? Promise.resolve(),
      );
    } catch (error) {
      throwIfRuntimeLifecycleFatal(error);
      this.assertExecutionActive();
      // Diagnostic persistence failed too; never perturb model/tool execution.
    }
  }
}

function traceToRunEvent(event: RunTraceEvent, runId: string): AgentRunEvent {
  return {
    type: event.type,
    id: event.id,
    runId,
    sessionId: event.sessionId,
    turnId: event.turnId,
    ts: event.ts,
    message: redactTraceString(event.message),
    data: sanitizeTraceData(event.data),
  };
}

function sanitizeTraceData(
  data: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!data) return undefined;
  return Object.fromEntries(
    Object.entries(data)
      .filter(([, value]) => value !== undefined)
      .map(([key, value]) => [key, sanitizeTraceValue(value)]),
  );
}

function sanitizeTraceValue(value: unknown): unknown {
  if (typeof value === 'string') return redactTraceString(value);
  if (Array.isArray(value)) return value.slice(0, 50).map(sanitizeTraceValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .slice(0, 50)
        .map(([key, nested]) => [key, sanitizeTraceValue(nested)]),
    );
  }
  return value;
}

function redactTraceString(value: string): string {
  const redacted = redactSecrets(value);
  return redacted.length > 2_000 ? `${redacted.slice(0, 2_000)}...[truncated]` : redacted;
}

function errorMessage(error: unknown): string {
  return redactTraceString(error instanceof Error ? error.message : String(error));
}

function isTerminalRunStatus(status: AgentRunHeader['status']): boolean {
  return status === 'completed' || status === 'failed' || status === 'cancelled';
}

function isPermissionHandoffTerminal(event: RuntimeEvent): boolean {
  return event.actions?.stateDelta?.stopReason === 'permission_handoff';
}

function isNonTerminalErrorRuntimeEvent(event: RuntimeEvent): boolean {
  return event.content?.kind === 'error' && !isTerminalRuntimeEvent(event);
}

function statusFromEvent(
  event: SessionEvent,
): { status: SessionStatus; blockedReason?: SessionBlockedReason } | undefined {
  switch (event.type) {
    case 'permission_request':
      return { status: 'waiting_for_user', blockedReason: 'permission_required' };
    case 'permission_decision_ack':
      return event.decision === 'allow' ? { status: 'running' } : { status: 'aborted' };
    case 'error':
      return { status: 'blocked', blockedReason: blockedReasonFromErrorReason(event.reason) };
    case 'abort':
      return { status: 'aborted' };
    case 'complete':
      if (event.stopReason === 'permission_handoff')
        return { status: 'waiting_for_user', blockedReason: 'permission_required' };
      if (event.stopReason === 'user_stop') return { status: 'aborted' };
      if (event.stopReason === 'error') return { status: 'blocked', blockedReason: 'unknown' };
      return { status: 'active' };
    default:
      return undefined;
  }
}

function turnStatusFromEvent(
  event: SessionEvent,
): { status: TurnRecord['status']; errorClass?: string } | undefined {
  switch (event.type) {
    case 'abort':
      return { status: 'aborted' };
    case 'error':
      return { status: 'failed', errorClass: event.reason ?? event.code ?? 'unknown' };
    case 'complete':
      if (event.stopReason === 'user_stop') return { status: 'aborted' };
      const errorClass = failureClassFromCompleteStopReason(event.stopReason);
      if (errorClass) return { status: 'failed', errorClass };
      if (event.stopReason === 'permission_handoff') return { status: 'running' };
      return { status: 'completed' };
    default:
      return undefined;
  }
}

function blockedReasonFromErrorReason(reason: string | undefined): SessionBlockedReason {
  if (!reason) return 'unknown';
  if (reason === 'permission_required') return 'permission_required';
  if (reason === 'tool_failed') return 'tool_failed';
  if (reason === 'auth' || reason.includes('api_key') || reason.includes('connection'))
    return 'NO_REAL_CONNECTION';
  return 'unknown';
}
