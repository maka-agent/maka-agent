import type { AgentRunEvent, AgentRunHeader, AgentRunStore, RuntimeEvent, RuntimeEventStore } from '@maka/core';
import { isTerminalRuntimeEvent } from '@maka/core';
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
import type { SessionEvent } from '@maka/core/events';
import type { BackendSendInput } from '@maka/core/backend-types';
import type { AgentBackend } from './ai-sdk-backend.js';
import type { RunTraceEvent } from './run-trace.js';
import type { SessionStore, StopSessionInput } from './session-manager.js';
import type { ActiveFullCompactBlock } from './active-full-compact.js';
import type { SemanticCompactBlock } from './semantic-compact.js';
import { buildRuntimeEventModelReplayPlan } from './model-history.js';
import {
  classifyRuntimeEventTerminalFact,
  projectRuntimeEventsToStoredMessages,
} from './runtime-event-read-model.js';
import { backfillRuntimeEventsFromStoredMessages } from './runtime-event-backfill.js';
import {
  buildStatusPatch,
  normalizeStopSessionSource,
} from './session-projection-helpers.js';
import {
  commitOrCreateTerminalRunFact,
  effectiveRunHeaderFromTerminalFact,
} from './terminal-run-commit.js';
import {
  AiSdkFlow,
} from './ai-sdk-flow.js';
import type { InvocationContext } from './invocation-context.js';
import { buildInitialUserRuntimeEvent } from './runtime-runner.js';

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
  updateStatus(sessionId: string, status: SessionStatus, blockedReason?: SessionBlockedReason, ts?: number): Promise<void>;
  appendTurnState(
    sessionId: string,
    turnId: string,
    status: TurnRecord['status'],
    lineage?: AgentRunLineage,
    options?: { ts?: number; errorClass?: string; abortSource?: string },
  ): Promise<void>;
}

export type AgentRunLineage = Partial<Pick<
  UserMessageInput,
  'parentRunId' | 'parentTurnId' | 'retriedFromTurnId' | 'regeneratedFromTurnId' | 'branchOfTurnId' | 'parentSessionId'
>>;

export interface AgentRunInput {
  sessionId: string;
  header: SessionHeader;
  userInput: UserMessageInput;
  store: SessionStore;
  runStore?: AgentRunStore;
  runtimeEventStore?: RuntimeEventStore;
  repairRunRuntimeLedger?: (sessionId: string, runId: string) => Promise<boolean>;
  newId: () => string;
  now: () => number;
  hooks: AgentRunHooks;
  recordSessionMessages?: boolean;
}

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

interface PriorRuntimeContext {
  events: RuntimeEvent[];
  runs: AgentRunHeader[];
}

interface PriorRunTerminalFactContext {
  events: RuntimeEvent[];
  run: AgentRunHeader;
}

export class AgentRun {
  readonly runId: string;
  readonly sessionId: string;
  readonly turnId: string;
  readonly lineage: AgentRunLineage;

  private header: SessionHeader;
  private active: AgentRunActiveSession | undefined;
  private stopped = false;
  private abortSource: string | undefined;
  private traceQueue: Promise<void> = Promise.resolve();
  private runtimeEventQueue: Promise<void> = Promise.resolve();
  private runStoreAvailable = true;
  private runtimeEventStoreAvailable = true;
  private failureClass: string | undefined;
  private failureMessage: string | undefined;
  private lastTs = 0;
  private sawCompletion = false;
  private finalStatus: { status: SessionStatus; blockedReason?: SessionBlockedReason } | undefined;
  private turnFailed = false;
  private finalized = false;
  private terminalRuntimeEventRecorded = false;
  private terminalRuntimeEventForRunCommit: RuntimeEvent | undefined;
  private terminalRunHeaderCommitted = false;

  constructor(private readonly input: AgentRunInput) {
    if (input.runStore && !input.runtimeEventStore) {
      throw new Error('RuntimeEventStore is required when AgentRunStore is configured');
    }
    this.runId = input.newId();
    this.sessionId = input.sessionId;
    this.turnId = input.userInput.turnId;
    this.header = input.header;
    this.lineage = {
      ...(input.userInput.parentRunId ? { parentRunId: input.userInput.parentRunId } : {}),
      ...(input.userInput.parentTurnId ? { parentTurnId: input.userInput.parentTurnId } : {}),
      ...(input.userInput.retriedFromTurnId ? { retriedFromTurnId: input.userInput.retriedFromTurnId } : {}),
      ...(input.userInput.regeneratedFromTurnId ? { regeneratedFromTurnId: input.userInput.regeneratedFromTurnId } : {}),
      ...(input.userInput.branchOfTurnId ? { branchOfTurnId: input.userInput.branchOfTurnId } : {}),
      ...(input.userInput.parentSessionId ? { parentSessionId: input.userInput.parentSessionId } : {}),
    };
  }

  stop(source: StopSessionInput['source'] | undefined): void {
    this.stopped = true;
    this.abortSource = normalizeStopSessionSource(source);
  }

  isStopped(): boolean {
    return this.stopped;
  }

  recordRunTrace(event: RunTraceEvent): void {
    if (!this.input.runStore || !this.runStoreAvailable) return;
    this.enqueueRunStore('append trace event', async () => {
      await this.input.runStore?.appendEvent(this.sessionId, this.runId, traceToRunEvent(event, this.runId));
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
    try {
      const begin = await this.begin();
      const invocationId = begin.initialRuntimeEvent.invocationId;
      const source = 'desktop' as const;
      const request: InvocationContext['request'] = {
        sessionId: this.sessionId,
        invocationId,
        runId: this.runId,
        turnId: this.turnId,
        text: this.input.userInput.text,
        ...(this.input.userInput.attachments ? { attachments: this.input.userInput.attachments } : {}),
        context: begin.backendInput.context,
        ...(begin.backendInput.runtimeContext ? { runtimeContext: begin.backendInput.runtimeContext } : {}),
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
        context: begin.backendInput.context,
        ...(begin.backendInput.runtimeContext ? { runtimeContext: begin.backendInput.runtimeContext } : {}),
      })) {
        if (acceptedSessionEvent) {
          yield acceptedSessionEvent;
          acceptedSessionEvent = undefined;
        }
      }
    } catch (error) {
      await this.recordFailure(error);
      throw error;
    } finally {
      await this.finalize();
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
          requireTerminalWrite: options.requireTerminalWrite ?? Boolean(this.input.runtimeEventStore),
        });
      }
      await this.recordSessionEvent(sessionEvent);
      return;
    }
    await this.recordSessionEvent(sessionEvent);
    if (!isNonTerminalErrorRuntimeEvent(runtimeEvent)) {
      await this.recordRuntimeEvents([runtimeEvent]);
    }
  }

  async begin(): Promise<AgentRunBeginResult> {
    await this.createRunRecord();

    let initialRuntimeEventId: string;
    if (this.recordsSessionMessages()) {
      const userMessageId = this.input.newId();
      const userMessageTs = this.input.now();
      initialRuntimeEventId = userMessageId;
      const userMsg: UserMessage = {
        type: 'user',
        id: userMessageId,
        turnId: this.turnId,
        ts: userMessageTs,
        text: this.input.userInput.text,
        ...(this.input.userInput.attachments ? { attachments: this.input.userInput.attachments } : {}),
      };
      await this.input.store.appendMessage(this.sessionId, userMsg);
      await this.input.hooks.appendTurnState(this.sessionId, this.turnId, 'running', this.lineage);
      this.lastTs = userMessageTs;
    } else {
      initialRuntimeEventId = this.input.newId();
      this.lastTs = this.input.now();
    }

    const initialRuntimeEvent = this.buildInitialRuntimeEvent(initialRuntimeEventId, this.lastTs);
    await this.recordRuntimeEvents([initialRuntimeEvent]);

    if (!this.header.connectionLocked) {
      this.header = await this.input.hooks.updateHeader(this.sessionId, { connectionLocked: true });
    }

    this.active = await this.input.hooks.ensureActive(this.sessionId, this.header);
    this.input.hooks.registerRun(this.active, this);
    await this.markRunStarted(this.lastTs);

    await this.input.hooks.updateStatus(this.sessionId, 'running', undefined, this.lastTs);

    const priorRuntimeContext = await this.buildPriorRuntimeContext();
    const projectionContext = priorRuntimeContext
      ? projectRuntimeEventsToStoredMessages(priorRuntimeContext.events, { runHeaders: priorRuntimeContext.runs }).messages
      : [];

    return {
      backend: this.active.backend,
      backendInput: {
        turnId: this.turnId,
        text: this.input.userInput.text,
        ...(this.input.userInput.attachments ? { attachments: this.input.userInput.attachments } : {}),
        context: projectionContext,
        ...(priorRuntimeContext ? { runtimeContext: priorRuntimeContext.events } : {}),
      },
      initialRuntimeEvent,
    };
  }

  async beginOperation(): Promise<AgentRunOperationBeginResult> {
    await this.createRunRecord();

    const startedAt = this.input.now();
    this.lastTs = startedAt;
    if (this.recordsSessionMessages()) {
      await this.input.hooks.appendTurnState(this.sessionId, this.turnId, 'running', this.lineage, { ts: startedAt });
    }

    if (!this.header.connectionLocked) {
      this.header = await this.input.hooks.updateHeader(this.sessionId, { connectionLocked: true });
    }

    this.active = await this.input.hooks.ensureActive(this.sessionId, this.header);
    this.input.hooks.registerRun(this.active, this);
    await this.markRunStarted(startedAt);

    await this.input.hooks.updateStatus(this.sessionId, 'running', undefined, startedAt);

    const priorRuntimeContext = await this.buildPriorRuntimeContext();
    return {
      backend: this.active.backend,
      runtimeContext: priorRuntimeContext?.events ?? [],
      startedAt,
    };
  }

  private buildInitialRuntimeEvent(id: string, ts: number): RuntimeEvent {
    return buildInitialUserRuntimeEvent({
      id,
      invocationId: this.runId,
      runId: this.runId,
      sessionId: this.sessionId,
      turnId: this.turnId,
      ts,
      text: this.input.userInput.text,
      ...(this.input.userInput.attachments !== undefined ? { attachments: this.input.userInput.attachments } : {}),
    });
  }

  async recordStoredSessionEvent(ev: SessionEvent): Promise<void> {
    if (!this.recordsSessionMessages()) return;
    if (ev.type === 'token_usage') {
      await this.input.store.appendMessage(this.sessionId, { ...ev } satisfies StoredMessage);
    }
  }

  async recordSessionEvent(ev: SessionEvent): Promise<void> {
    this.lastTs = ev.ts;
    const transition = statusFromEvent(ev);
    const terminalSessionEvent = (ev.type === 'complete' || ev.type === 'abort') && !this.turnFailed;
    const turnStatus = terminalSessionEvent ? turnStatusFromEvent(ev) : undefined;
    if (terminalSessionEvent) {
      this.sawCompletion = true;
      if (ev.type === 'abort' && !this.abortSource) this.abortSource = ev.reason;
      if (ev.type === 'complete' && ev.stopReason === 'user_stop' && !this.abortSource) this.abortSource = 'user_stop';
      this.finalStatus = this.stopped
        ? { status: 'aborted' }
        : (transition ?? { status: 'active' });
      // A complete(error) without a preceding error event leaves failureClass
      // unset — record it now so finalize does not fall back to 'unknown'.
      if (turnStatus?.status === 'failed' && turnStatus.errorClass && !this.failureClass && !this.stopped) {
        this.markRunFailed(turnStatus.errorClass, 'turn ended with stopReason=error', ev.ts);
      }
    }
    if (transition && !this.stopped) {
      if (terminalSessionEvent || ev.type === 'error') {
        await this.input.hooks.updateStatus(this.sessionId, transition.status, transition.blockedReason, ev.ts)
          .catch((error) => this.enqueueTraceWriteFailure(error, 'terminal session projection'));
      } else {
        await this.input.hooks.updateStatus(this.sessionId, transition.status, transition.blockedReason, ev.ts);
      }
      this.recordStatusFromTransition(ev, transition, ev.ts);
    }
    if (turnStatus && !this.stopped && this.recordsSessionMessages()) {
      const appendTurnState = this.input.hooks.appendTurnState(this.sessionId, this.turnId, turnStatus.status, this.lineage, {
        ts: ev.ts,
        errorClass: turnStatus.errorClass,
        ...(turnStatus.status === 'aborted' && this.abortSource ? { abortSource: this.abortSource } : {}),
      });
      if (terminalSessionEvent || ev.type === 'error') {
        await appendTurnState.catch((error) => this.enqueueTraceWriteFailure(error, 'terminal session projection'));
      } else {
        await appendTurnState;
      }
    }
    if (ev.type === 'error') {
      if (this.stopped) {
        this.finalStatus = { status: 'aborted' };
      } else {
        this.turnFailed = true;
        this.finalStatus = transition ?? { status: 'blocked', blockedReason: 'unknown' };
        if (this.recordsSessionMessages()) {
          await this.input.hooks.appendTurnState(this.sessionId, this.turnId, 'failed', this.lineage, {
            ts: ev.ts,
            errorClass: ev.reason ?? ev.code ?? 'unknown',
          }).catch((error) => this.enqueueTraceWriteFailure(error, 'terminal session projection'));
        }
        this.markRunFailed(ev.reason ?? ev.code ?? 'unknown', ev.message, ev.ts);
      }
    }
  }

  async recordRuntimeEvents(
    events: readonly RuntimeEvent[],
    options: { requireTerminalWrite?: boolean } = {},
  ): Promise<void> {
    if (events.length === 0) return;
    for (const event of events) {
      const eventForStore = this.runtimeEventForStore(event);
      const terminal = isTerminalRuntimeEvent(eventForStore);
      if (terminal && this.terminalRuntimeEventRecorded) continue;
      if (!this.input.runtimeEventStore || !this.runtimeEventStoreAvailable) {
        if (terminal && options.requireTerminalWrite) {
          throw new Error('terminal RuntimeEvent store is unavailable');
        }
        continue;
      }
      await this.enqueueRuntimeEventStore('append runtime event', async () => {
        await this.input.runtimeEventStore?.appendRuntimeEvent(this.sessionId, this.runId, eventForStore);
      }, { rethrow: terminal || options.requireTerminalWrite });
      if (terminal) {
        this.terminalRuntimeEventRecorded = true;
        this.terminalRuntimeEventForRunCommit = eventForStore;
      }
    }
  }

  private runtimeEventForStore(event: RuntimeEvent): RuntimeEvent {
    if (!this.stopped || !isTerminalRuntimeEvent(event)) return event;
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
          abortSource: this.abortSource ?? 'user_stop',
        },
      },
    };
  }

  async recordFailure(error: unknown): Promise<void> {
    if (this.stopped) {
      this.finalStatus = { status: 'aborted' };
      return;
    }
    this.finalStatus = { status: 'blocked', blockedReason: 'unknown' };
    if (this.recordsSessionMessages()) {
      await this.input.hooks.appendTurnState(this.sessionId, this.turnId, 'failed', this.lineage, {
        errorClass: error instanceof Error ? error.name : 'unknown',
      }).catch(() => {});
    }
    this.markRunFailed(error instanceof Error ? error.name : 'unknown', errorMessage(error), this.input.now());
  }

  async finalize(): Promise<void> {
    if (this.finalized) return;
    this.finalized = true;
    const lastTs = this.lastTs || this.input.now();
    if (this.active) {
      await this.input.hooks.unregisterRun(this.active, this);
      if (this.stopped) this.finalStatus = { status: 'aborted' };
    }
    if (!this.finalStatus && !this.stopped) {
      this.finalStatus = { status: 'blocked', blockedReason: 'unknown' };
      this.markRunFailed('missing_terminal_event', 'run finalized without a terminal SessionEvent', lastTs);
    }
    const nextStatus = this.active && this.active.activeRuns.size > 0
      ? { status: 'running' as const }
      : (this.finalStatus ?? { status: 'active' as const });
    try {
      await this.input.hooks.updateHeader(this.sessionId, {
        lastUsedAt: lastTs,
        lastMessageAt: lastTs,
        hasUnread: true,
        ...buildStatusPatch(nextStatus.status, lastTs, nextStatus.blockedReason),
      });
    } catch {
      // The user-visible turn already completed; preserve existing behavior.
    }
    if (this.sawCompletion && this.recordsSessionMessages()) {
      await this.input.store.appendMessage(this.sessionId, {
        type: 'system_note',
        id: this.input.newId(),
        turnId: this.turnId,
        ts: lastTs,
        kind: 'session_resume',
      } satisfies SystemNoteMessage).catch(() => {});
    }
    await this.finishRun(this.finalStatus, lastTs);
  }

  private recordsSessionMessages(): boolean {
    return this.input.recordSessionMessages !== false;
  }

  private async createRunRecord(): Promise<void> {
    if (!this.input.runStore) return;
    const createdAt = this.input.now();
    const header: AgentRunHeader = {
      runId: this.runId,
      sessionId: this.sessionId,
      turnId: this.turnId,
      status: 'created',
      backendKind: this.header.backend,
      llmConnectionSlug: this.header.llmConnectionSlug,
      modelId: this.header.model,
      cwd: this.header.cwd,
      permissionMode: this.header.permissionMode,
      createdAt,
      updatedAt: createdAt,
      ...this.lineage,
      ...(this.input.userInput.agentId ? { agentId: this.input.userInput.agentId } : {}),
      ...(this.input.userInput.agentName ? { agentName: this.input.userInput.agentName } : {}),
    };
    try {
      await this.input.runStore.createRun(header);
      await this.input.runStore.appendEvent(this.sessionId, this.runId, {
        type: 'run_created',
        id: this.input.newId(),
        runId: this.runId,
        sessionId: this.sessionId,
        turnId: this.turnId,
        ts: createdAt,
        data: {
          textLength: this.input.userInput.text.length,
          attachmentCount: this.input.userInput.attachments?.length ?? 0,
        },
      });
    } catch (error) {
      this.runStoreAvailable = false;
      this.enqueueTraceWriteFailure(error);
    }
  }

  private async buildPriorRuntimeContext(): Promise<PriorRuntimeContext | undefined> {
    if (this.lineage.parentRunId) return undefined;
    if (
      !this.input.runStore ||
      !this.input.runtimeEventStore ||
      !this.runStoreAvailable ||
      !this.runtimeEventStoreAvailable
    ) return undefined;
    const runs = await this.input.runStore.listSessionRuns(this.sessionId);
    const priorRuns = runs.filter((run) =>
      run.runId !== this.runId &&
      run.turnId !== this.turnId &&
      !run.parentRunId
    );
    if (priorRuns.length === 0) return undefined;

    const ordered: Array<{ event: RuntimeEvent; runIndex: number; eventIndex: number }> = [];
    for (let runIndex = 0; runIndex < priorRuns.length; runIndex += 1) {
      const run = priorRuns[runIndex]!;
      if (!isTerminalRunStatus(run.status)) {
        const terminalFactContext = await this.readNonTerminalPriorRunWithTerminalFact(run);
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
      if (events.length === 0) {
        if (await this.input.repairRunRuntimeLedger?.(this.sessionId, run.runId)) {
          events = await this.input.runtimeEventStore.readRuntimeEvents(this.sessionId, run.runId);
        }
      }
      if (events.length === 0) {
        const recovered = await this.backfillMissingPriorRuntimeEvents(run);
        if (recovered.length === 0 || !recovered.some(isTerminalRuntimeEvent)) {
          throw new Error(`Cannot build model context: RuntimeEvent ledger is missing for prior run ${run.runId}`);
        }
        events = recovered;
      }
      if (!events.some(isTerminalRuntimeEvent)) {
        if (await this.input.repairRunRuntimeLedger?.(this.sessionId, run.runId)) {
          events = await this.input.runtimeEventStore.readRuntimeEvents(this.sessionId, run.runId);
        }
      }
      if (!events.some(isTerminalRuntimeEvent)) {
        throw new Error(`Cannot build model context: RuntimeEvent ledger has no terminal fact for prior run ${run.runId}`);
      }
      let terminalFact = classifyRuntimeEventTerminalFact(run, events).fact;
      if (!terminalFact && await this.input.repairRunRuntimeLedger?.(this.sessionId, run.runId)) {
        events = await this.input.runtimeEventStore.readRuntimeEvents(this.sessionId, run.runId);
        terminalFact = classifyRuntimeEventTerminalFact(run, events).fact;
      }
      if (!terminalFact) {
        throw new Error(`Cannot build model context: RuntimeEvent ledger has no valid terminal fact for prior run ${run.runId}`);
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

  private async readNonTerminalPriorRunWithTerminalFact(
    run: AgentRunHeader,
  ): Promise<PriorRunTerminalFactContext | undefined> {
    if (!this.input.runtimeEventStore) return undefined;
    const events = await this.input.runtimeEventStore.readRuntimeEvents(this.sessionId, run.runId).catch(() => []);
    const terminalFact = classifyRuntimeEventTerminalFact(run, events).fact;
    if (!terminalFact) return undefined;
    return { events, run: effectiveRunHeaderFromTerminalFact(run, terminalFact) };
  }

  private async backfillMissingPriorRuntimeEvents(run: AgentRunHeader): Promise<RuntimeEvent[]> {
    let messages: StoredMessage[];
    try {
      messages = await this.input.store.readMessages(this.sessionId);
    } catch {
      return [];
    }
    return backfillRuntimeEventsFromStoredMessages({ run, messages }).events;
  }

  private async markRunStarted(ts: number): Promise<void> {
    if (!this.input.runStore || !this.runStoreAvailable) return;
    this.enqueueRunStore('mark run started', async () => {
      await this.input.runStore?.updateRun(this.sessionId, this.runId, { status: 'running', updatedAt: ts });
      await this.input.runStore?.appendEvent(this.sessionId, this.runId, {
        type: 'run_started',
        id: this.input.newId(),
        runId: this.runId,
        sessionId: this.sessionId,
        turnId: this.turnId,
        ts,
      });
    });
  }

  private recordStatusFromTransition(
    ev: SessionEvent,
    transition: { status: SessionStatus; blockedReason?: SessionBlockedReason },
    ts: number,
  ): void {
    if (!this.input.runStore || !this.runStoreAvailable) return;
    const status = transition.status === 'waiting_for_user'
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
        data: { sessionStatus: transition.status, ...(transition.blockedReason ? { blockedReason: transition.blockedReason } : {}) },
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
    await this.traceQueue.catch(() => {});
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
        type: status === 'cancelled'
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
            ? { data: { sessionStatus: 'waiting_for_user', blockedReason: finalStatus?.blockedReason ?? 'permission_required' } }
            : {}),
      });
    });
    await this.traceQueue.catch(() => {});
  }

  private runStatusForFinalStatus(
    finalStatus: { status: SessionStatus; blockedReason?: SessionBlockedReason } | undefined,
  ): AgentRunHeader['status'] {
    if (this.stopped || finalStatus?.status === 'aborted') return 'cancelled';
    if (finalStatus?.status === 'blocked') return 'failed';
    if (finalStatus?.status === 'waiting_for_user') return 'waiting_permission';
    return 'completed';
  }

  private async commitTerminalRun(
    finalStatus: { status: SessionStatus; blockedReason?: SessionBlockedReason } | undefined,
    ts: number,
  ): Promise<void> {
    if (this.terminalRunHeaderCommitted) return;
    const runStore = this.input.runStore;
    const runtimeEventStore = this.input.runtimeEventStore;
    if (!runStore || !this.runStoreAvailable || !runtimeEventStore || !this.runtimeEventStoreAvailable) return;
    const fallbackStatus = this.stopped || finalStatus?.status === 'aborted' ? 'cancelled' : 'failed';
    const fallbackFailureClass = 'missing_terminal_event';
    const fallbackFailureMessage = this.failureMessage ?? 'run finalized without a terminal RuntimeEvent';
    try {
      const result = await commitOrCreateTerminalRunFact({
        runStore,
        runtimeEventStore,
        newId: this.input.newId,
        sessionId: this.sessionId,
        runId: this.runId,
        turnId: this.turnId,
        ts,
        ...(this.terminalRuntimeEventForRunCommit
          ? {
              terminalEvent: this.terminalRuntimeEventForRunCommit,
              terminalEventAlreadyPersisted: true,
            }
          : {}),
        ...(this.failureClass ?? finalStatus?.blockedReason
          ? { failureClass: this.failureClass ?? finalStatus?.blockedReason }
          : {}),
        ...(this.failureMessage ? { failureMessage: this.failureMessage } : {}),
        ...(this.abortSource || fallbackStatus === 'cancelled'
          ? { abortSource: this.abortSource ?? 'user_stop' }
          : {}),
        fallbackStatus,
        fallbackInvocationId: this.runId,
        ...(fallbackStatus === 'failed' ? { fallbackFailureClass, fallbackFailureMessage } : {}),
        allowHeaderCommitFailure: true,
      });
      if (result.createdTerminalEvent && result.status === 'failed') {
        this.failureClass = result.failureClass ?? fallbackFailureClass;
        this.failureMessage = fallbackFailureMessage;
      }
      this.terminalRuntimeEventRecorded = true;
      this.terminalRuntimeEventForRunCommit = result.terminalEvent;
      this.terminalRunHeaderCommitted = result.headerCommitted;
      if (result.headerCommitError !== undefined) {
        await this.enqueueTraceWriteFailure(result.headerCommitError, 'commit terminal run header');
      }
    } catch (error) {
      this.runStoreAvailable = false;
      await this.enqueueTraceWriteFailure(error, 'commit terminal run header');
      throw error;
    }
    await this.traceQueue.catch(() => {});
  }

  private enqueueRunStore(label: string, operation: () => Promise<void>): Promise<void> {
    if (!this.input.runStore || !this.runStoreAvailable) return Promise.resolve();
    const next = this.traceQueue.then(operation, operation).catch(async (error) => {
      this.runStoreAvailable = false;
      await this.enqueueTraceWriteFailure(error, label);
    });
    this.traceQueue = next.catch(() => {});
    return next;
  }

  private enqueueRuntimeEventStore(
    label: string,
    operation: () => Promise<void>,
    options: { rethrow?: boolean } = {},
  ): Promise<void> {
    if (!this.input.runtimeEventStore || !this.runtimeEventStoreAvailable) return Promise.resolve();
    const next = this.runtimeEventQueue.then(operation, operation).catch(async (error) => {
      this.runtimeEventStoreAvailable = false;
      await this.enqueueTraceWriteFailure(error, label);
      if (options.rethrow) throw error;
    });
    this.runtimeEventQueue = next.catch(() => {});
    return next;
  }

  private async enqueueTraceWriteFailure(error: unknown, label = 'agent run store write'): Promise<void> {
    const message = errorMessage(error);
    try {
      await this.input.runStore?.updateRun(this.sessionId, this.runId, {
        traceWriteError: `${label}: ${message}`,
        updatedAt: this.input.now(),
      });
      await this.input.runStore?.appendEvent(this.sessionId, this.runId, {
        type: 'trace_write_failed',
        id: this.input.newId(),
        runId: this.runId,
        sessionId: this.sessionId,
        turnId: this.turnId,
        ts: this.input.now(),
        message,
      });
    } catch {
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

function sanitizeTraceData(data: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
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

function statusFromEvent(event: SessionEvent): { status: SessionStatus; blockedReason?: SessionBlockedReason } | undefined {
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
      if (event.stopReason === 'permission_handoff') return { status: 'waiting_for_user', blockedReason: 'permission_required' };
      if (event.stopReason === 'user_stop') return { status: 'aborted' };
      if (event.stopReason === 'error') return { status: 'blocked', blockedReason: 'unknown' };
      return { status: 'active' };
    default:
      return undefined;
  }
}

function turnStatusFromEvent(event: SessionEvent): { status: TurnRecord['status']; errorClass?: string } | undefined {
  switch (event.type) {
    case 'abort':
      return { status: 'aborted' };
    case 'error':
      return { status: 'failed', errorClass: event.reason ?? event.code ?? 'unknown' };
    case 'complete':
      if (event.stopReason === 'user_stop') return { status: 'aborted' };
      if (event.stopReason === 'error') return { status: 'failed', errorClass: 'runtime_error' };
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
  if (reason === 'auth' || reason.includes('api_key') || reason.includes('connection')) return 'NO_REAL_CONNECTION';
  return 'unknown';
}
