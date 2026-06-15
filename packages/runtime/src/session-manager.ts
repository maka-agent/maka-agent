/**
 * SessionManager — the public Runtime API.
 *
 * Ties together:
 *   SessionStore (storage)           — JSONL persistence
 *   AgentBackend (AiSdkBackend etc) — SDK adapter
 *   PermissionEngine                  — policy + parking
 *
 * Source: V0.1_TECH_SPEC.md §6.1, §9 (Phase 1 vertical path)
 *
 * NOTE: Imports `SessionStore` from `@maka/storage`. Storage
 * package authored in parallel; the interface is committed per
 * thread message (appendMessage / appendMessages return Promise<void>,
 * updateHeader returns updated SessionHeader, same-session writes serialized).
 */

import type {
  SessionEvent,
  TextDeltaEvent,
  CompleteEvent,
  ErrorEvent,
  AbortEvent,
  PermissionDecisionAckEvent,
  PermissionRequestEvent,
} from '@maka/core/events';
import type {
  SessionHeader,
  SessionBlockedReason,
  SessionStatus,
  SessionSummary,
  StoredMessage,
  TurnRecord,
  UserMessage,
  PermissionDecisionMessage,
  SystemNoteMessage,
  BackendKind,
} from '@maka/core/session';
import type {
  CreateSessionInput,
  BranchFromTurnInput,
  RegenerateTurnInput,
  RetryTurnInput,
  UserMessageInput,
  SessionListFilter,
} from '@maka/core/runtime-inputs';
import type { PermissionResponse } from '@maka/core/permission';
import type { PermissionMode } from '@maka/core/permission';
import { DEEP_RESEARCH_SESSION_LABEL, deriveTurnRecords, isDeepResearchSession, isTerminalRuntimeEvent } from '@maka/core';
import type { AgentRunHeader, AgentRunStore, RuntimeEvent } from '@maka/core';
import {
  compareRuntimeReadModelMessages,
  projectRuntimeEventsToStoredMessages,
  type RuntimeEventReadModelDiagnostic,
} from './runtime-event-read-model.js';

import type { AgentBackend } from './ai-sdk-backend.js';
import type { RunTraceRecorder } from './run-trace.js';
import { AgentRun, type AgentRunActiveSession, type AgentRunBeginResult, type AgentRunLineage } from './agent-run.js';
import { classifyAgentRunRecovery, type AgentRunRecoveryDecision } from './agent-run-recovery.js';
import { AiSdkFlow } from './ai-sdk-flow.js';
import type {
  InvocationResult,
  InvocationSource,
} from './invocation-context.js';
import { RuntimeRunner } from './runtime-runner.js';

export interface StopSessionInput {
  source?: 'stop_button';
}

// ============================================================================
// SessionStore contract (matches the storage package surface)
// ============================================================================

export interface SessionStore {
  create(input: CreateSessionInput): Promise<SessionHeader>;
  list(filter?: SessionListFilter): Promise<SessionSummary[]>;
  readHeader(sessionId: string): Promise<SessionHeader>;
  readMessages(sessionId: string): Promise<StoredMessage[]>;
  listTurns(sessionId: string): Promise<TurnRecord[]>;
  appendMessage(sessionId: string, m: StoredMessage): Promise<void>;
  appendMessages(sessionId: string, ms: StoredMessage[]): Promise<void>;
  updateHeader(sessionId: string, patch: Partial<SessionHeader>): Promise<SessionHeader>;
  archive(sessionId: string): Promise<void>;
  unarchive(sessionId: string): Promise<void>;
  setFlagged(sessionId: string, isFlagged: boolean): Promise<void>;
  rename(sessionId: string, name: string): Promise<void>;
  remove(sessionId: string): Promise<void>;
}

// ============================================================================
// BackendRegistry — factory dispatch by BackendKind
// ============================================================================

export interface BackendFactoryContext {
  sessionId: string;
  workspaceRoot: string;
  header: SessionHeader;
  store: SessionStore;
  recordRunTrace?: RunTraceRecorder;
}

export type BackendFactory = (ctx: BackendFactoryContext) => AgentBackend | Promise<AgentBackend>;

export class BackendRegistry {
  private readonly factories = new Map<BackendKind, BackendFactory>();

  register(kind: BackendKind, factory: BackendFactory): void {
    this.factories.set(kind, factory);
  }

  async build(kind: BackendKind, ctx: BackendFactoryContext): Promise<AgentBackend> {
    const f = this.factories.get(kind);
    if (!f) throw new Error(`No backend factory registered for kind="${kind}"`);
    return await f(ctx);
  }

  has(kind: BackendKind): boolean {
    return this.factories.has(kind);
  }
}

// ============================================================================
// SessionManager
// ============================================================================

export interface SessionManagerDeps {
  store: SessionStore;
  runStore?: AgentRunStore;
  backends: BackendRegistry;
  newId: () => string;
  now: () => number;
  runtimeSource?: InvocationSource;
  runtimeInvocationObserver?: (result: InvocationResult) => void | Promise<void>;
}

interface ActiveSession extends AgentRunActiveSession {
  sessionId: string;
  backend: AgentBackend;
  /** Tracks the latest header we've read (used to short-circuit some reads). */
  cachedHeader: SessionHeader;
  activeRuns: Map<string, AgentRun>;
  turnToRunId: Map<string, string>;
}

type SessionReadSource = 'runtime_events' | 'legacy_session_store';

interface SessionReadView {
  source: SessionReadSource;
  messages: StoredMessage[];
  turns: TurnRecord[];
  diagnostics: RuntimeEventReadModelDiagnostic[];
}

export class SessionManager {
  private readonly active = new Map<string, ActiveSession>();

  constructor(private readonly deps: SessionManagerDeps) {}

  // --------------------------------------------------------------------------
  // Session lifecycle
  // --------------------------------------------------------------------------

  async createSession(input: CreateSessionInput): Promise<SessionSummary> {
    const header = await this.deps.store.create(input);
    return headerToSummary(header);
  }

  async listSessions(filter?: SessionListFilter): Promise<SessionSummary[]> {
    return this.deps.store.list(filter);
  }

  async getMessages(sessionId: string): Promise<StoredMessage[]> {
    return (await this.readSessionView(sessionId)).messages;
  }

  async listTurns(sessionId: string): Promise<TurnRecord[]> {
    return (await this.readSessionView(sessionId)).turns;
  }

  async recoverInterruptedSessions(): Promise<string[]> {
    const interrupted = (await this.deps.store.list())
      .filter((session) => session.status !== 'archived');
    const recovered: string[] = [];
    for (const session of interrupted) {
      if (this.active.has(session.id)) continue;
      let messages: StoredMessage[] = [];
      let messagesReadable = true;
      try {
        messages = await this.deps.store.readMessages(session.id);
      } catch {
        messagesReadable = false;
      }

      if (this.deps.runStore) {
        const runRecovery = await this.recoverAgentRunsFromLedger(session.id, messages).catch(() => undefined);
        if (runRecovery?.hasLedger) {
          if (runRecovery.recovered) {
            await this.updateStatus(session.id, 'active').catch(() => {});
            recovered.push(session.id);
          } else if (!messagesReadable && (session.status === 'running' || session.status === 'waiting_for_user')) {
            await this.updateStatus(session.id, 'active').catch(() => {});
            recovered.push(session.id);
          }
          continue;
        }
      }

      if (!messagesReadable) {
        if (session.status === 'running' || session.status === 'waiting_for_user') {
          await this.updateStatus(session.id, 'active').catch(() => {});
          recovered.push(session.id);
        }
        continue;
      }

      const recoveries = interruptedTurnRecoveries(messages);
      if (recoveries.length === 0) continue;
      for (const recovery of recoveries) {
        await this.appendTurnState(session.id, recovery.turnId, 'failed', recovery.lineage, {
          errorClass: recovery.errorClass,
        }).catch(() => {});
      }
      if (session.status === 'running' || session.status === 'waiting_for_user') {
        await this.updateStatus(session.id, 'active').catch(() => {});
      }
      recovered.push(session.id);
    }
    return recovered;
  }

  async updateSession(
    sessionId: string,
    patch: Partial<SessionHeader>,
  ): Promise<SessionSummary> {
    const active = this.active.get(sessionId);
    const backendConfigChanged = changesBackendConfig(patch);
    if (active && backendConfigChanged && active.activeRuns.size > 0) {
      throw new Error('Cannot change backend configuration while a turn is running');
    }

    const next = await this.deps.store.updateHeader(sessionId, patch);
    if (active) {
      active.cachedHeader = next;
      if (backendConfigChanged) {
        // AgentBackend instances snapshot backend/model config at construction
        // time. If a stale session is rebound to a real default connection, the
        // next turn must build a fresh backend instead of reusing FakeBackend or
        // an AiSdkBackend pointed at a deleted connection.
        await this.disposeBackend(sessionId);
      }
    }
    return headerToSummary(next);
  }

  async archive(sessionId: string): Promise<void> {
    await this.deps.store.archive(sessionId);
    await this.disposeBackend(sessionId);
  }

  async unarchive(sessionId: string): Promise<void> {
    await this.deps.store.unarchive(sessionId);
  }

  async setSessionStatus(
    sessionId: string,
    status: SessionStatus,
    blockedReason?: SessionBlockedReason,
  ): Promise<SessionSummary> {
    const next = await this.deps.store.updateHeader(sessionId, statusPatch(status, this.deps.now(), blockedReason));
    const active = this.active.get(sessionId);
    if (active) active.cachedHeader = next;
    return headerToSummary(next);
  }

  async setFlagged(sessionId: string, isFlagged: boolean): Promise<void> {
    await this.deps.store.setFlagged(sessionId, isFlagged);
    const active = this.active.get(sessionId);
    if (active) active.cachedHeader = { ...active.cachedHeader, isFlagged };
  }

  async renameSession(sessionId: string, name: string): Promise<void> {
    await this.deps.store.rename(sessionId, name);
    const active = this.active.get(sessionId);
    if (active) active.cachedHeader = { ...active.cachedHeader, name };
  }

  async setPermissionMode(sessionId: string, mode: PermissionMode): Promise<SessionSummary> {
    const previous = await this.deps.store.readHeader(sessionId);
    const leavingDeepResearch = isDeepResearchSession(previous.labels) && mode !== 'explore';
    if (previous.permissionMode === mode && !leavingDeepResearch) return headerToSummary(previous);

    const active = this.active.get(sessionId);
    if (active && active.activeRuns.size > 0) {
      throw new Error('当前对话正在运行，等结束后再切换权限模式。');
    }
    if (previous.status === 'waiting_for_user') {
      throw new Error('当前有工具调用正在等待确认，处理后再切换权限模式。');
    }

    const next = await this.deps.store.updateHeader(sessionId, {
      permissionMode: mode,
      labels: leavingDeepResearch
        ? previous.labels.filter((label) => label !== DEEP_RESEARCH_SESSION_LABEL)
        : previous.labels,
    });
    await this.deps.store.appendMessage(sessionId, {
      type: 'system_note',
      id: this.deps.newId(),
      ts: this.deps.now(),
      kind: 'mode_change',
      data: { from: previous.permissionMode, to: mode },
    } satisfies SystemNoteMessage);

    if (active) {
      active.cachedHeader = next;
      // AiSdkBackend snapshots the header at construction time. Rebuild the
      // backend before the next turn so PermissionEngine receives the new mode.
      await this.disposeBackend(sessionId);
    }
    return headerToSummary(next);
  }

  async remove(sessionId: string): Promise<void> {
    await this.disposeBackend(sessionId);
    await this.deps.store.remove(sessionId);
  }

  // --------------------------------------------------------------------------
  // Send / stream — Phase 1 vertical heart
  // --------------------------------------------------------------------------

  /**
   * Send a user message and stream back normalized events. The caller
   * (desktop main) is expected to forward the events to the renderer over
   * the IPC bridge.
   *
   * Runtime v2 bridge:
   *   1. Create one AgentRun, which remains the persistence/ledger owner.
   *   2. Begin it to resolve the production backend and model context.
   *   3. Run AiSdkFlow through RuntimeRunner for canonical RuntimeEvents.
   *   4. Forward the original SessionEvents to callers unchanged.
   *   5. Drain the backend stream fully so stop/abort cleanup semantics stay intact.
   */
  async *sendMessage(
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
    // Append the abort SystemNote synchronously (matches §9 Step 6 step 4).
    await this.deps.store.appendMessage(sessionId, {
      type: 'system_note',
      id: this.deps.newId(),
      ts: this.deps.now(),
      kind: 'abort',
      ...(abortSource ? { data: { source: abortSource } } : {}),
    } satisfies SystemNoteMessage);
  }

  async *retryTurn(
    sessionId: string,
    input: RetryTurnInput,
  ): AsyncIterable<SessionEvent> {
    const source = await this.requireTurnForAction(sessionId, input.sourceTurnId, ['failed', 'aborted'], 'retry');
    const user = await this.requireUserMessageForTurn(sessionId, source.turnId);
    yield* this.sendMessage(sessionId, {
      turnId: input.turnId ?? this.deps.newId(),
      text: user.text,
      ...(user.attachments ? { attachments: user.attachments } : {}),
      parentTurnId: source.turnId,
      retriedFromTurnId: source.turnId,
    });
  }

  async *regenerateTurn(
    sessionId: string,
    input: RegenerateTurnInput,
  ): AsyncIterable<SessionEvent> {
    const source = await this.requireTurnForAction(sessionId, input.sourceTurnId, ['completed'], 'regenerate');
    const user = await this.requireUserMessageForTurn(sessionId, source.turnId);
    yield* this.sendMessage(sessionId, {
      turnId: input.turnId ?? this.deps.newId(),
      text: user.text,
      ...(user.attachments ? { attachments: user.attachments } : {}),
      parentTurnId: source.turnId,
      regeneratedFromTurnId: source.turnId,
    });
  }

  async branchFromTurn(
    sessionId: string,
    input: BranchFromTurnInput,
  ): Promise<SessionSummary> {
    const header = await this.deps.store.readHeader(sessionId);
    const { messages } = await this.readSessionView(sessionId);
    const copied = copyMessagesThroughTurnBoundary(messages, input.sourceTurnId);
    if (copied.length === 0) throw new Error(`Cannot branch from unknown turn ${input.sourceTurnId}`);
    const next = await this.deps.store.create({
      cwd: header.cwd,
      backend: header.backend,
      llmConnectionSlug: header.llmConnectionSlug,
      model: header.model,
      permissionMode: header.permissionMode,
      name: input.name ?? `${header.name} · 分支`,
      labels: header.labels,
      parentSessionId: sessionId,
      branchOfTurnId: input.sourceTurnId,
      status: 'active',
    });
    await this.deps.store.appendMessages(next.id, copied);
    await this.deps.store.appendMessage(next.id, {
      type: 'system_note',
      id: this.deps.newId(),
      ts: this.deps.now(),
      kind: 'session_start',
      data: { parentSessionId: sessionId, branchOfTurnId: input.sourceTurnId },
    });
    return headerToSummary(await this.deps.store.readHeader(next.id));
  }

  async respondToPermission(
    sessionId: string,
    response: PermissionResponse,
  ): Promise<void> {
    const active = this.active.get(sessionId);
    if (!active) return;
    await active.backend.respondToPermission(response);
  }

  // --------------------------------------------------------------------------
  // Internal helpers
  // --------------------------------------------------------------------------

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

  private async disposeBackend(sessionId: string): Promise<void> {
    const active = this.active.get(sessionId);
    if (!active) return;
    this.active.delete(sessionId);
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
    await this.updateHeader(sessionId, statusPatch(status, ts, blockedReason));
  }

  private async updateHeader(
    sessionId: string,
    patch: Partial<SessionHeader>,
  ): Promise<SessionHeader> {
    const next = await this.deps.store.updateHeader(sessionId, patch);
    const active = this.active.get(sessionId);
    if (active) active.cachedHeader = next;
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

  private async requireTurnForAction(
    sessionId: string,
    turnId: string,
    allowed: readonly TurnRecord['status'][],
    action: string,
  ): Promise<TurnRecord> {
    const turn = (await this.readSessionView(sessionId)).turns.find((candidate) => candidate.turnId === turnId);
    if (!turn) throw new Error(`Cannot ${action}: unknown turn ${turnId}`);
    if (!allowed.includes(turn.status)) {
      throw new Error(`Cannot ${action}: turn ${turnId} is ${turn.status}`);
    }
    return turn;
  }

  private async requireUserMessageForTurn(sessionId: string, turnId: string): Promise<UserMessage> {
    const user = (await this.readSessionView(sessionId)).messages
      .find((message): message is UserMessage => message.type === 'user' && message.turnId === turnId);
    if (!user) throw new Error(`Turn ${turnId} has no user message`);
    return user;
  }

  private async readSessionView(sessionId: string): Promise<SessionReadView> {
    const legacy = await this.readLegacyMessages(sessionId);
    const fallback = (diagnostics: RuntimeEventReadModelDiagnostic[] = []): SessionReadView => {
      if (!legacy.readable) throw legacy.error;
      return {
        source: 'legacy_session_store',
        messages: legacy.messages,
        turns: deriveTurnRecords(legacy.messages),
        diagnostics,
      };
    };

    if (runtimeReadSourceForcedLegacy()) {
      return fallback([readDiagnostic('unsupported_event', 'RuntimeEvent read projection disabled by MAKA_RUNTIME_READ_SOURCE')]);
    }
    if (!this.deps.runStore) {
      return fallback();
    }

    let runs: AgentRunHeader[];
    try {
      runs = await this.deps.runStore.listSessionRuns(sessionId);
    } catch {
      return fallback([readDiagnostic('unsupported_event', 'AgentRunStore.listSessionRuns failed')]);
    }
    if (runs.length === 0) {
      return fallback();
    }

    const events: RuntimeEvent[] = [];
    const ordered: Array<{ event: RuntimeEvent; runIndex: number; eventIndex: number }> = [];
    for (let runIndex = 0; runIndex < runs.length; runIndex += 1) {
      const run = runs[runIndex]!;
      if (!isTerminalRunStatus(run.status)) {
        return fallback([readDiagnostic('incomplete_event', 'RuntimeEvent read projection is not used for active runs', run)]);
      }

      let runEvents: RuntimeEvent[];
      try {
        runEvents = await this.deps.runStore.readRuntimeEvents(sessionId, run.runId);
      } catch (error) {
        return fallback([
          readDiagnostic('unsupported_event', 'AgentRunStore.readRuntimeEvents failed', {
            runId: run.runId,
            error: error instanceof Error ? error.message : String(error),
          }),
        ]);
      }

      if (runEvents.length === 0) {
        return fallback([readDiagnostic('incomplete_event', 'terminal run has no readable RuntimeEvent ledger', { runId: run.runId })]);
      }
      if (!runEvents.some(isTerminalRuntimeEvent)) {
        return fallback([readDiagnostic('incomplete_event', 'terminal run has no terminal RuntimeEvent', { runId: run.runId })]);
      }

      for (let eventIndex = 0; eventIndex < runEvents.length; eventIndex += 1) {
        ordered.push({ event: runEvents[eventIndex]!, runIndex, eventIndex });
      }
    }

    // RuntimeEvent-primary reads use session chronology across terminal runs,
    // with stable run/ledger/id tie-breakers. This matches legacy message
    // reads better than concatenating each run ledger in creation order when
    // overlapping runs complete out of order.
    ordered.sort((a, b) =>
      a.event.ts - b.event.ts ||
      a.runIndex - b.runIndex ||
      a.eventIndex - b.eventIndex ||
      a.event.id.localeCompare(b.event.id)
    );
    for (const item of ordered) events.push(item.event);

    const projected = projectRuntimeEventsToStoredMessages(events, { runHeaders: runs });
    if (hasHardProjectionDiagnostic(projected.diagnostics)) {
      return fallback(projected.diagnostics);
    }

    const diagnostics = [...projected.diagnostics];
    if (legacy.readable) {
      const compatibility = compareRuntimeReadModelMessages(projected.messages, legacy.messages);
      diagnostics.push(...compatibility.diagnostics);
      if (hasHardCompatibilityDiagnostic(compatibility.diagnostics)) {
        return fallback(diagnostics);
      }
    }

    return {
      source: 'runtime_events',
      messages: projected.messages,
      turns: deriveTurnRecords(projected.messages),
      diagnostics,
    };
  }

  private async readLegacyMessages(sessionId: string): Promise<
    | { readable: true; messages: StoredMessage[] }
    | { readable: false; error: unknown }
  > {
    try {
      return { readable: true, messages: await this.deps.store.readMessages(sessionId) };
    } catch (error) {
      return { readable: false, error };
    }
  }

  private async recoverAgentRunsFromLedger(
    sessionId: string,
    messages: readonly StoredMessage[],
  ): Promise<{ hasLedger: boolean; recovered: boolean }> {
    if (!this.deps.runStore) return { hasLedger: false, recovered: false };
    const runs = await this.deps.runStore.listSessionRuns(sessionId);
    if (runs.length === 0) return { hasLedger: false, recovered: false };

    let recovered = false;
    for (const run of runs) {
      const events = await this.deps.runStore.readEvents(sessionId, run.runId);
      const decision = classifyAgentRunRecovery(run, events, messages);
      if (!decision) continue;
      await this.applyAgentRunRecovery(sessionId, decision);
      recovered = true;
    }
    return { hasLedger: true, recovered };
  }

  private async applyAgentRunRecovery(
    sessionId: string,
    decision: AgentRunRecoveryDecision,
  ): Promise<void> {
    const ts = this.deps.now();
    if (decision.status === 'completed') {
      await this.deps.runStore?.updateRun(sessionId, decision.runId, {
        status: 'completed',
        completedAt: ts,
        updatedAt: ts,
      });
      await this.deps.runStore?.appendEvent(sessionId, decision.runId, {
        type: 'run_completed',
        id: this.deps.newId(),
        runId: decision.runId,
        sessionId,
        turnId: decision.turnId,
        ts,
        data: { recovered: true, ...decision.diagnostic },
      });
      await this.appendTurnState(sessionId, decision.turnId, 'completed', decision.lineage, { ts }).catch(() => {});
      return;
    }

    const failureClass = decision.failureClass ?? 'app_restarted';
    await this.deps.runStore?.updateRun(sessionId, decision.runId, {
      status: 'failed',
      completedAt: ts,
      updatedAt: ts,
      failureClass,
    });
    await this.deps.runStore?.appendEvent(sessionId, decision.runId, {
      type: 'run_failed',
      id: this.deps.newId(),
      runId: decision.runId,
      sessionId,
      turnId: decision.turnId,
      ts,
      data: { recovered: true, failureClass, ...decision.diagnostic },
    });
    await this.appendTurnState(sessionId, decision.turnId, 'failed', decision.lineage, {
      ts,
      errorClass: failureClass,
    }).catch(() => {});
  }
}

// ============================================================================
// Helpers
// ============================================================================

export function headerToSummary(h: SessionHeader): SessionSummary {
  const summary: SessionSummary = {
    id: h.id,
    name: h.name === 'New Session' ? 'New Chat' : h.name,
    isFlagged: h.isFlagged,
    isArchived: h.isArchived,
    labels: h.labels,
    hasUnread: h.hasUnread,
    status: h.status,
    ...(h.blockedReason ? { blockedReason: h.blockedReason } : {}),
    ...(h.statusUpdatedAt !== undefined ? { statusUpdatedAt: h.statusUpdatedAt } : {}),
    ...(h.parentSessionId ? { parentSessionId: h.parentSessionId } : {}),
    ...(h.branchOfTurnId ? { branchOfTurnId: h.branchOfTurnId } : {}),
    backend: h.backend,
    llmConnectionSlug: h.llmConnectionSlug,
    model: h.model,
    permissionMode: h.permissionMode ?? 'ask',
  };
  if (h.lastMessageAt !== undefined) {
    summary.lastMessageAt = h.lastMessageAt;
  }
  return summary;
}

function changesBackendConfig(patch: Partial<SessionHeader>): boolean {
  return 'backend' in patch || 'llmConnectionSlug' in patch || 'model' in patch;
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

interface InterruptedTurnRecovery {
  turnId: string;
  errorClass: string;
  lineage: Partial<Pick<UserMessageInput, 'parentTurnId' | 'retriedFromTurnId' | 'regeneratedFromTurnId' | 'branchOfTurnId' | 'parentSessionId'>>;
}

function interruptedTurnRecoveries(messages: readonly StoredMessage[]): InterruptedTurnRecovery[] {
  const byTurn = new Map<string, {
    hasAssistant: boolean;
    states: Array<Extract<StoredMessage, { type: 'turn_state' }>>;
  }>();
  for (const message of messages) {
    const turnId = (message as { turnId?: string }).turnId;
    if (!turnId) continue;
    const bucket = byTurn.get(turnId) ?? { hasAssistant: false, states: [] };
    if (message.type === 'assistant') bucket.hasAssistant = true;
    if (message.type === 'turn_state') bucket.states.push(message);
    byTurn.set(turnId, bucket);
  }

  const recoveries: InterruptedTurnRecovery[] = [];
  for (const [turnId, bucket] of byTurn) {
    const latest = bucket.states.at(-1);
    if (!latest) continue;
    if (latest.status === 'running') {
      recoveries.push({
        turnId,
        errorClass: 'app_restarted',
        lineage: turnStateLineage(latest),
      });
      continue;
    }
    const failed = [...bucket.states].reverse().find((state) => state.status === 'failed');
    if (latest.status === 'completed' && !bucket.hasAssistant && failed) {
      recoveries.push({
        turnId,
        errorClass: failed.errorClass ?? 'unknown',
        lineage: turnStateLineage(failed),
      });
    }
  }
  return recoveries;
}

function turnStateLineage(
  state: Extract<StoredMessage, { type: 'turn_state' }>,
): Partial<Pick<UserMessageInput, 'parentTurnId' | 'retriedFromTurnId' | 'regeneratedFromTurnId' | 'branchOfTurnId' | 'parentSessionId'>> {
  return {
    ...(state.parentTurnId ? { parentTurnId: state.parentTurnId } : {}),
    ...(state.retriedFromTurnId ? { retriedFromTurnId: state.retriedFromTurnId } : {}),
    ...(state.regeneratedFromTurnId ? { regeneratedFromTurnId: state.regeneratedFromTurnId } : {}),
    ...(state.branchOfTurnId ? { branchOfTurnId: state.branchOfTurnId } : {}),
    ...(state.parentSessionId ? { parentSessionId: state.parentSessionId } : {}),
  };
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
      if (event.stopReason === 'error') return { status: 'failed', errorClass: 'unknown' };
      if (event.stopReason === 'permission_handoff') return { status: 'running' };
      return { status: 'completed' };
    default:
      return undefined;
  }
}

function copyMessagesThroughTurnBoundary(messages: readonly StoredMessage[], turnId: string): StoredMessage[] {
  let lastIndex = -1;
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index]!;
    if ((message as { turnId?: string }).turnId === turnId) {
      lastIndex = index;
    }
  }
  if (lastIndex < 0) return [];
  // Branch v1 copies conversation context only. Turn metadata is intentionally
  // not copied into the child session; lineage lives on the child session
  // header (`parentSessionId` + `branchOfTurnId`) and future turns.
  return messages
    .slice(0, lastIndex + 1)
    .filter((message) => message.type !== 'turn_state');
}

function isTerminalRunStatus(status: AgentRunHeader['status']): boolean {
  return status === 'completed' || status === 'failed' || status === 'cancelled';
}

function hasHardProjectionDiagnostic(diagnostics: readonly RuntimeEventReadModelDiagnostic[]): boolean {
  return diagnostics.some((diagnostic) =>
    diagnostic.code === 'incomplete_event' ||
    diagnostic.code === 'unsupported_event' ||
    diagnostic.code === 'tool_use_id_mismatch'
  );
}

function hasHardCompatibilityDiagnostic(diagnostics: readonly RuntimeEventReadModelDiagnostic[]): boolean {
  // A projected view missing a legacy semantic row means RuntimeEvents cannot
  // yet render the public session faithfully. Extra projected rows are allowed:
  // for compatible runtime-ledger sessions they represent RuntimeEvents being
  // fresher than stale legacy rows, while diagnostics keep that mismatch visible.
  return diagnostics.some((diagnostic) => diagnostic.code === 'missing_legacy_message');
}

function readDiagnostic(
  code: RuntimeEventReadModelDiagnostic['code'],
  message: string,
  detail?: unknown,
): RuntimeEventReadModelDiagnostic {
  return {
    code,
    message,
    ...(detail !== undefined ? { detail } : {}),
  };
}

function runtimeReadSourceForcedLegacy(): boolean {
  return process.env.MAKA_RUNTIME_READ_SOURCE === 'legacy';
}

function blockedReasonFromErrorReason(reason: string | undefined): SessionBlockedReason {
  if (!reason) return 'unknown';
  if (reason === 'permission_required') return 'permission_required';
  if (reason === 'tool_failed') return 'tool_failed';
  if (reason === 'auth' || reason.includes('api_key') || reason.includes('connection')) return 'NO_REAL_CONNECTION';
  return 'unknown';
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

// Re-export the suppressed-unused types so this file is the canonical home
// for them. (Avoids TS "imported but unused" warnings.)
export type {
  TextDeltaEvent,
  CompleteEvent,
  ErrorEvent,
  AbortEvent,
  PermissionRequestEvent,
  PermissionDecisionAckEvent,
  PermissionDecisionMessage,
};
