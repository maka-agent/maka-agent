import type { AgentRunStore, RuntimeEventStore } from '@maka/core';
import type { SessionEvent } from '@maka/core/events';
import type {
  SessionBlockedReason,
  SessionHeader,
  SessionStatus,
  StoredMessage,
  SystemNoteMessage,
  TurnRecord,
} from '@maka/core/session';
import type { UserMessageInput } from '@maka/core/runtime-inputs';
import type { PermissionResponse } from '@maka/core/permission';
import { AgentRun, type AgentRunActiveSession, type AgentRunBeginResult, type AgentRunLineage } from './agent-run.js';
import { AiSdkFlow } from './ai-sdk-flow.js';
import type { AgentBackend } from './ai-sdk-backend.js';
import type { InvocationResult, InvocationSource } from './invocation-context.js';
import { RuntimeRunner } from './runtime-runner.js';
import type { BackendRegistry, SessionStore, StopSessionInput } from './session-manager.js';

export interface RuntimeKernelLike {
  startTurn(sessionId: string, input: UserMessageInput): AsyncIterable<SessionEvent>;
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
  runtimeSource?: InvocationSource;
  runtimeInvocationObserver?: (result: InvocationResult) => void | Promise<void>;
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

  constructor(private readonly deps: RuntimeKernelDeps) {}

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
      onSessionEvent: async (sessionEvent) => {
        await run.recordSessionEvent(sessionEvent);
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
        await run.finalize();
        sessionEvents.close();
      },
    });
    const runner = new RuntimeRunner({
      flow: aiSdkFlow,
      providers: { newId: this.deps.newId, now: this.deps.now },
      stopOnTerminal: false,
    });
    const runnerResult = runner.run({
      sessionId,
      runId: run.runId,
      turnId: run.turnId,
      text: input.text,
      ...(begin.backendInput.attachments ? { attachments: begin.backendInput.attachments } : {}),
      context: begin.backendInput.context,
      ...(begin.backendInput.runtimeContext !== undefined ? { runtimeContext: begin.backendInput.runtimeContext } : {}),
      source: this.deps.runtimeSource ?? 'desktop',
      lineage: run.lineage,
      abortSignal: abortController.signal,
    }).then(async (result) => {
      await run.recordRuntimeEvents(result.events);
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

  async stopSession(sessionId: string, input: StopSessionInput = {}): Promise<void> {
    const active = this.active.get(sessionId);
    if (!active) return;
    const abortSource = normalizeStopSessionSource(input.source);
    await active.backend.stop('user_stop');
    const activeRuns = [...active.activeRuns.values()];
    for (const run of activeRuns) {
      run.stop(input.source);
    }
    await this.updateStatus(sessionId, 'aborted');
    for (const run of activeRuns) {
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
    const active = this.active.get(sessionId);
    if (!active) return;
    await active.backend.respondToPermission(response);
  }

  hasActiveRuns(sessionId: string): boolean {
    return (this.active.get(sessionId)?.activeRuns.size ?? 0) > 0;
  }

  updateCachedHeader(sessionId: string, header: SessionHeader): void {
    const active = this.active.get(sessionId);
    if (active) active.cachedHeader = header;
  }

  async disposeBackend(sessionId: string): Promise<void> {
    const active = this.active.get(sessionId);
    if (!active) return;
    this.active.delete(sessionId);
    try {
      await active.backend.dispose();
    } catch {
      // best-effort
    }
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

  private async updateStatus(
    sessionId: string,
    status: SessionStatus,
    blockedReason?: SessionBlockedReason,
    ts = this.deps.now(),
  ): Promise<void> {
    await this.updateHeader(sessionId, statusPatch(status, ts, blockedReason));
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
    await this.deps.store.appendMessage(sessionId, {
      type: 'turn_state',
      id: this.deps.newId(),
      turnId,
      ts,
      status,
      ...(lineage.parentTurnId ? { parentTurnId: lineage.parentTurnId } : {}),
      ...(lineage.retriedFromTurnId ? { retriedFromTurnId: lineage.retriedFromTurnId } : {}),
      ...(lineage.regeneratedFromTurnId ? { regeneratedFromTurnId: lineage.regeneratedFromTurnId } : {}),
      ...(lineage.branchOfTurnId ? { branchOfTurnId: lineage.branchOfTurnId } : {}),
      ...(lineage.parentSessionId ? { parentSessionId: lineage.parentSessionId } : {}),
      ...(status === 'aborted' ? { abortedAt: ts } : {}),
      ...(status === 'aborted' && options.abortSource ? { abortSource: options.abortSource } : {}),
      ...(status === 'failed' ? { errorClass: options.errorClass ?? 'unknown' } : {}),
      partialOutputRetained: await this.turnHasRetainedOutput(sessionId, turnId),
    });
  }

  private async turnHasRetainedOutput(sessionId: string, turnId: string): Promise<boolean> {
    const messages = await this.deps.store.readMessages(sessionId).catch(() => []);
    return messages.some((message) =>
      (message.type === 'assistant' && message.turnId === turnId && message.text.trim().length > 0) ||
      (message.type === 'tool_result' && message.turnId === turnId),
    );
  }
}

function statusPatch(
  status: SessionStatus,
  ts: number,
  blockedReason?: SessionBlockedReason,
): Pick<SessionHeader, 'status' | 'blockedReason' | 'statusUpdatedAt'> {
  return {
    status,
    blockedReason: status === 'blocked' ? (blockedReason ?? 'unknown') : undefined,
    statusUpdatedAt: ts,
  };
}

function normalizeStopSessionSource(source: StopSessionInput['source'] | undefined): string | undefined {
  switch (source) {
    case 'stop_button': return 'renderer.stop_button';
    case undefined: return undefined;
  }
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
