import type { AgentRunStore, RuntimeEventStore } from '@maka/core';
import type { CompleteEvent, SessionEvent, TokenUsageEvent } from '@maka/core/events';
import type {
  SessionBlockedReason,
  SessionHeader,
  SessionStatus,
  SystemNoteMessage,
  TurnRecord,
} from '@maka/core/session';
import type { ChildAgentTurnInput, UserMessageInput } from '@maka/core/runtime-inputs';
import type { PermissionResponse } from '@maka/core/permission';
import { AgentRun, type AgentRunActiveSession, type AgentRunBeginResult, type AgentRunLineage } from './agent-run.js';
import { AiSdkFlow, mapSessionEventToRuntimeEvent } from './ai-sdk-flow.js';
import type { AgentBackend, MakaTool } from './ai-sdk-backend.js';
import type { InvocationContext, InvocationResult, InvocationSource } from './invocation-context.js';
import { RuntimeRunner } from './runtime-runner.js';
import type { BackendRegistry, CompactSessionInput, SessionStore, StopSessionInput } from './session-manager.js';
import {
  buildStatusPatch,
  buildTurnStateMessage,
  normalizeStopSessionSource,
  turnHasRetainedOutput as messagesHaveRetainedOutput,
} from './session-projection-helpers.js';
import {
  assertAgentDefinitionRunnable,
  buildToolsForAgentDefinition,
  requireBuiltinAgentDefinition,
} from './agent-catalog.js';

export interface RuntimeKernelLike {
  startTurn(sessionId: string, input: UserMessageInput): AsyncIterable<SessionEvent>;
  compactSession(sessionId: string, input?: CompactSessionInput): AsyncIterable<SessionEvent>;
  startChildTurn(sessionId: string, input: ChildAgentTurnInput): AsyncIterable<SessionEvent>;
  stopSession(sessionId: string, input?: StopSessionInput): Promise<void>;
  respondToPermission(sessionId: string, response: PermissionResponse): Promise<void>;
  hasActiveRuns(sessionId: string): boolean;
  updateCachedHeader(sessionId: string, header: SessionHeader): void;
  disposeBackend(sessionId: string): Promise<void>;
}

export interface RuntimeKernelDeps {
  store: SessionStore;
  runStore?: AgentRunStore;
  runtimeEventStore?: RuntimeEventStore;
  backends: BackendRegistry;
  newId: () => string;
  now: () => number;
  childTools?: readonly MakaTool[];
  runtimeSource?: InvocationSource;
  runtimeInvocationObserver?: (result: InvocationResult) => void | Promise<void>;
  repairRunRuntimeLedger?: (sessionId: string, runId: string) => Promise<boolean>;
}

interface ActiveSession extends AgentRunActiveSession {
  sessionId: string;
  backend: AgentBackend;
  cachedHeader: SessionHeader;
  activeRuns: Map<string, AgentRun>;
  turnToRunId: Map<string, string>;
}

export class RuntimeKernel implements RuntimeKernelLike {
  private readonly active = new Map<string, ActiveSession>();
  private readonly childActive = new Map<string, ActiveSession>();

  constructor(private readonly deps: RuntimeKernelDeps) {
    if (deps.runStore && !deps.runtimeEventStore) {
      throw new Error('RuntimeEventStore is required when AgentRunStore is configured');
    }
  }

  async *startTurn(
    sessionId: string,
    input: UserMessageInput,
  ): AsyncIterable<SessionEvent> {
    const header = await this.deps.store.readHeader(sessionId);
    const run = new AgentRun({
      sessionId,
      header,
      userInput: input,
      store: this.deps.store,
      runStore: this.deps.runStore,
      runtimeEventStore: this.deps.runtimeEventStore,
      repairRunRuntimeLedger: this.deps.repairRunRuntimeLedger,
      newId: this.deps.newId,
      now: this.deps.now,
      hooks: {
        ensureActive: (targetSessionId, nextHeader) => this.ensureActive(targetSessionId, nextHeader),
        registerRun: (active, activeRun) => this.registerRun(active, activeRun),
        unregisterRun: (active, activeRun) => this.unregisterRun(active, activeRun),
        updateHeader: (targetSessionId, patch) => this.updateHeader(targetSessionId, patch),
        updateStatus: (targetSessionId, status, blockedReason, ts) =>
          this.updateStatus(targetSessionId, status, blockedReason, ts),
        appendTurnState: (targetSessionId, turnId, status, lineage, options) =>
          this.appendTurnState(targetSessionId, turnId, status, lineage, options),
      },
    });

    yield* this.runAgentTurn(sessionId, input, run);
  }

  async *compactSession(
    sessionId: string,
    input: CompactSessionInput = {},
  ): AsyncIterable<SessionEvent> {
    if (!this.deps.runStore || !this.deps.runtimeEventStore) {
      throw new Error('Runtime compaction requires AgentRunStore and RuntimeEventStore');
    }
    if (this.hasActiveRuns(sessionId)) {
      throw new Error('Cannot compact while a turn is running; wait for the turn to finish.');
    }

    const header = await this.deps.store.readHeader(sessionId);
    const turnId = input.turnId ?? this.deps.newId();
    const run = new AgentRun({
      sessionId,
      header,
      userInput: { turnId, text: '' },
      store: this.deps.store,
      runStore: this.deps.runStore,
      runtimeEventStore: this.deps.runtimeEventStore,
      repairRunRuntimeLedger: this.deps.repairRunRuntimeLedger,
      newId: this.deps.newId,
      now: this.deps.now,
      hooks: {
        ensureActive: (targetSessionId, nextHeader) => this.ensureActive(targetSessionId, nextHeader),
        registerRun: (active, activeRun) => this.registerRun(active, activeRun),
        unregisterRun: (active, activeRun) => this.unregisterRun(active, activeRun),
        updateHeader: (targetSessionId, patch) => this.updateHeader(targetSessionId, patch),
        updateStatus: (targetSessionId, status, blockedReason, ts) =>
          this.updateStatus(targetSessionId, status, blockedReason, ts),
        appendTurnState: (targetSessionId, nextTurnId, status, lineage, options) =>
          this.appendTurnState(targetSessionId, nextTurnId, status, lineage, options),
      },
    });

    let begin: Awaited<ReturnType<typeof run.beginOperation>>;
    try {
      begin = await run.beginOperation();
    } catch (error) {
      await run.recordFailure(error);
      await run.finalize();
      throw error;
    }

    try {
      if (run.isStopped()) return;
      if (!begin.backend.compactHistory) throw new Error(`Backend ${header.backend} does not support runtime compaction`);
      const result = await begin.backend.compactHistory({ turnId: run.turnId, runtimeContext: begin.runtimeContext });
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
      await run.acceptMappedEvent(
        tokenUsageEvent,
        mapSessionEventToRuntimeEvent(tokenUsageEvent, invocation),
        { requireTerminalWrite: true },
      );
      if (run.isStopped()) return;
      await run.recordStoredSessionEvent(tokenUsageEvent);
      if (run.isStopped()) return;
      yield tokenUsageEvent;
      if (run.isStopped()) return;
      await run.acceptMappedEvent(
        completeEvent,
        mapSessionEventToRuntimeEvent(completeEvent, invocation),
        { requireTerminalWrite: true },
      );
      if (run.isStopped()) return;
      yield completeEvent;
    } catch (error) {
      await run.recordFailure(error);
      throw error;
    } finally {
      await run.finalize();
    }
  }

  async *startChildTurn(
    sessionId: string,
    input: ChildAgentTurnInput,
  ): AsyncIterable<SessionEvent> {
    const parentHeader = await this.deps.store.readHeader(sessionId);
    const definition = requireBuiltinAgentDefinition(input.spec.id);
    const availableChildTools = this.deps.childTools ?? [];
    assertAgentDefinitionRunnable({
      parentPermissionMode: parentHeader.permissionMode,
      definition,
      tools: availableChildTools,
    });
    const childTools = buildToolsForAgentDefinition(availableChildTools, definition);
    const childHeader: SessionHeader = {
      ...parentHeader,
      permissionMode: definition.permissionMode,
      connectionLocked: true,
    };
    const userInput: UserMessageInput = {
      turnId: input.turnId,
      text: input.prompt,
      parentRunId: input.parentRunId,
      agentId: definition.id,
      agentName: definition.name,
    };
    const activeKey = childActiveKey(sessionId, input.turnId);
    const run = new AgentRun({
      sessionId,
      header: childHeader,
      userInput,
      store: this.deps.store,
      runStore: this.deps.runStore,
      runtimeEventStore: this.deps.runtimeEventStore,
      repairRunRuntimeLedger: this.deps.repairRunRuntimeLedger,
      newId: this.deps.newId,
      now: this.deps.now,
      recordSessionMessages: false,
      hooks: {
        ensureActive: (targetSessionId, nextHeader) =>
          this.ensureChildActive(activeKey, targetSessionId, nextHeader, definition.systemPrompt, childTools),
        registerRun: (active, activeRun) => this.registerRun(active, activeRun),
        unregisterRun: (active, activeRun) => this.unregisterChildRun(activeKey, active, activeRun),
        updateHeader: async (_targetSessionId, patch) => ({ ...childHeader, ...patch }),
        updateStatus: async () => {},
        appendTurnState: async () => {},
      },
    });

    yield* this.runAgentTurn(sessionId, userInput, run);
  }

  private async *runAgentTurn(
    sessionId: string,
    input: UserMessageInput,
    run: AgentRun,
  ): AsyncIterable<SessionEvent> {
    const sessionEvents = new AsyncEventQueue<SessionEvent>();
    const abortController = new AbortController();
    let flowDone = false;
    let begin: AgentRunBeginResult;
    try {
      begin = await run.begin();
    } catch (error) {
      await run.recordFailure(error);
      await run.finalize();
      throw error;
    }

    const aiSdkFlow = new AiSdkFlow({
      backend: begin.backend,
      drainAfterTerminal: true,
      onSessionEvent: async (sessionEvent, runtimeEvent) => {
        await run.acceptMappedEvent(sessionEvent, runtimeEvent, {
          requireTerminalWrite: Boolean(this.deps.runtimeEventStore),
        });
        await sessionEvents.push(sessionEvent);
      },
      onError: async (error) => {
        if (!isAsyncEventQueueClosed(error)) {
          await run.recordFailure(error);
          sessionEvents.fail(error);
        }
      },
      onFinally: async () => {
        flowDone = true;
        try {
          await run.finalize();
          sessionEvents.close();
        } catch (error) {
          sessionEvents.fail(error);
          throw error;
        }
      },
    });
    const runner = new RuntimeRunner({
      flow: aiSdkFlow,
      providers: { newId: this.deps.newId, now: this.deps.now },
      stopOnTerminal: false,
    });
    const runnerResult = runner.run({
      sessionId,
      invocationId: begin.initialRuntimeEvent.invocationId,
      runId: run.runId,
      turnId: run.turnId,
      text: input.text,
      ...(begin.backendInput.attachments ? { attachments: begin.backendInput.attachments } : {}),
      context: begin.backendInput.context,
      ...(begin.backendInput.runtimeContext !== undefined ? { runtimeContext: begin.backendInput.runtimeContext } : {}),
      initialRuntimeEvent: begin.initialRuntimeEvent,
      source: this.deps.runtimeSource ?? 'desktop',
      lineage: run.lineage,
      abortSignal: abortController.signal,
    }).then(async (result) => {
      await this.deps.runtimeInvocationObserver?.(result);
      return result;
    }, (error) => {
      sessionEvents.fail(error);
      throw error;
    });

    try {
      for await (const event of sessionEvents) {
        yield event;
      }
      await runnerResult;
    } finally {
      if (!flowDone) {
        abortController.abort();
        sessionEvents.close();
      }
      await runnerResult.catch(() => undefined);
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

  async stopSession(sessionId: string, input: StopSessionInput = {}): Promise<void> {
    const activeSessions = this.activeSessionsFor(sessionId);
    if (activeSessions.length === 0) return;
    const abortSource = normalizeStopSessionSource(input.source);
    const activeRuns = activeSessions.flatMap((active) => [...active.activeRuns.values()]);
    for (const run of activeRuns) {
      run.stop(input.source);
    }
    await Promise.all(activeSessions.map((active) => active.backend.stop('user_stop')));
    await this.updateStatus(sessionId, 'aborted');
    for (const run of activeRuns.filter((activeRun) => !activeRun.lineage.parentRunId)) {
      await this.appendTurnState(
        sessionId,
        run.turnId,
        'aborted',
        run.lineage,
        { ts: this.deps.now(), abortSource },
      ).catch(() => {});
    }
    await this.deps.store.appendMessage(sessionId, {
      type: 'system_note',
      id: this.deps.newId(),
      ts: this.deps.now(),
      kind: 'abort',
      ...(abortSource ? { data: { source: abortSource } } : {}),
    } satisfies SystemNoteMessage);
  }

  async respondToPermission(sessionId: string, response: PermissionResponse): Promise<void> {
    const activeSessions = this.activeSessionsFor(sessionId);
    await Promise.all(activeSessions.map((active) => active.backend.respondToPermission(response)));
  }

  hasActiveRuns(sessionId: string): boolean {
    return this.activeSessionsFor(sessionId).some((active) => active.activeRuns.size > 0);
  }

  updateCachedHeader(sessionId: string, header: SessionHeader): void {
    const active = this.active.get(sessionId);
    if (active) active.cachedHeader = header;
  }

  async disposeBackend(sessionId: string): Promise<void> {
    const activeSessions = this.activeSessionsFor(sessionId);
    this.active.delete(sessionId);
    for (const [key, active] of this.childActive.entries()) {
      if (active.sessionId === sessionId) this.childActive.delete(key);
    }
    for (const active of activeSessions) {
      try {
        await active.backend.dispose();
      } catch {
        // best-effort
      }
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

  private async ensureActive(
    sessionId: string,
    header: SessionHeader,
  ): Promise<ActiveSession> {
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
      recordRunTrace: (event) => {
        const active = this.active.get(sessionId);
        const runId = active?.turnToRunId.get(event.turnId);
        const run = runId ? active?.activeRuns.get(runId) : undefined;
        run?.recordRunTrace(event);
      },
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
  ): Promise<ActiveSession> {
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
      appendMessage: async () => {},
      systemPrompt,
      tools,
      recordRunTrace: (event) => {
        const active = this.childActive.get(activeKey);
        const runId = active?.turnToRunId.get(event.turnId);
        const run = runId ? active?.activeRuns.get(runId) : undefined;
        run?.recordRunTrace(event);
      },
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

  private unregisterRun(active: AgentRunActiveSession, run: AgentRun): void {
    active.activeRuns.delete(run.runId);
    if (active.turnToRunId.get(run.turnId) === run.runId) {
      active.turnToRunId.delete(run.turnId);
    }
  }

  private async unregisterChildRun(
    activeKey: string,
    active: AgentRunActiveSession,
    run: AgentRun,
  ): Promise<void> {
    this.unregisterRun(active, run);
    if (active.activeRuns.size > 0) return;
    this.childActive.delete(activeKey);
    try {
      await active.backend.dispose();
    } catch {
      // best-effort
    }
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
    options: { ts?: number; errorClass?: string; abortSource?: string } = {},
  ): Promise<void> {
    const ts = options.ts ?? this.deps.now();
    await this.deps.store.appendMessage(sessionId, buildTurnStateMessage({
      id: this.deps.newId(),
      turnId,
      ts,
      status,
      lineage,
      ...(options.abortSource ? { abortSource: options.abortSource } : {}),
      ...(options.errorClass !== undefined ? { errorClass: options.errorClass } : {}),
      partialOutputRetained: await this.turnHasRetainedOutput(sessionId, turnId),
    }));
  }

  private async turnHasRetainedOutput(sessionId: string, turnId: string): Promise<boolean> {
    const messages = await this.deps.store.readMessages(sessionId).catch(() => []);
    return messagesHaveRetainedOutput(messages, turnId);
  }
}

function childActiveKey(sessionId: string, turnId: string): string {
  return `${sessionId}:${turnId}`;
}

class AsyncEventQueueClosed extends Error {
  constructor() {
    super('Async event queue closed');
    this.name = 'AsyncEventQueueClosed';
  }
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
