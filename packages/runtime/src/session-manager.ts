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
import { DEEP_RESEARCH_SESSION_LABEL, isDeepResearchSession } from '@maka/core';
import type { AgentRunHeader, AgentRunStore, RuntimeEvent, RuntimeEventStore } from '@maka/core';
import {
  type RuntimeEventTerminalFact,
} from './runtime-event-read-model.js';
import { RuntimeReadModel, type RuntimeReadModelSessionView } from './runtime-read-model.js';
import { inspectAgentRunReadModel, type AgentRunInspectModel } from './agent-run-inspect.js';

import type { AgentBackend } from './ai-sdk-backend.js';
import type { RunTraceRecorder } from './run-trace.js';
import type { AgentRunLineage } from './agent-run.js';
import { classifyAgentRunRecovery, type AgentRunRecoveryDecision } from './agent-run-recovery.js';
import type {
  InvocationResult,
  InvocationSource,
} from './invocation-context.js';
import { RuntimeKernel, type RuntimeKernelLike } from './runtime-kernel.js';

export interface StopSessionInput {
  source?: 'stop_button';
}

// ============================================================================
// SessionStore contract (matches the storage package surface)
// ============================================================================

// StoredMessage rows remain a projection/cache surface for existing public
// shapes. RuntimeEventStore is the semantic conversation ledger.
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
  runtimeEventStore?: RuntimeEventStore;
  backends: BackendRegistry;
  newId: () => string;
  now: () => number;
  runtimeSource?: InvocationSource;
  runtimeInvocationObserver?: (result: InvocationResult) => void | Promise<void>;
  runtimeKernel?: RuntimeKernelLike;
}

export class SessionManager {
  private readonly runtimeKernel: RuntimeKernelLike;

  constructor(private readonly deps: SessionManagerDeps) {
    this.runtimeKernel = deps.runtimeKernel ?? new RuntimeKernel(deps);
  }

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
    return (await this.readModel().getSessionView(sessionId)).messages;
  }

  async listTurns(sessionId: string): Promise<TurnRecord[]> {
    return (await this.readModel().getSessionView(sessionId)).turns;
  }

  async recoverInterruptedSessions(): Promise<string[]> {
    const interrupted = (await this.deps.store.list())
      .filter((session) => session.status !== 'archived');
    const recovered: string[] = [];
    for (const session of interrupted) {
      if (this.runtimeKernel.hasActiveRuns(session.id)) continue;
      let messages: StoredMessage[] = [];
      let messagesReadable = true;
      try {
        messages = await this.deps.store.readMessages(session.id);
      } catch {
        messagesReadable = false;
      }

      if (this.deps.runStore) {
        const runRecovery = await this.recoverAgentRunsFromLedger(session.id).catch(() => undefined);
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
    const backendConfigChanged = changesBackendConfig(patch);
    if (backendConfigChanged && this.runtimeKernel.hasActiveRuns(sessionId)) {
      throw new Error('Cannot change backend configuration while a turn is running');
    }

    const next = await this.deps.store.updateHeader(sessionId, patch);
    this.runtimeKernel.updateCachedHeader(sessionId, next);
    if (backendConfigChanged) {
      // AgentBackend instances snapshot backend/model config at construction
      // time. If a stale session is rebound to a real default connection, the
      // next turn must build a fresh backend instead of reusing FakeBackend or
      // an AiSdkBackend pointed at a deleted connection.
      await this.runtimeKernel.disposeBackend(sessionId);
    }
    return headerToSummary(next);
  }

  async archive(sessionId: string): Promise<void> {
    await this.deps.store.archive(sessionId);
    await this.runtimeKernel.disposeBackend(sessionId);
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
    this.runtimeKernel.updateCachedHeader(sessionId, next);
    return headerToSummary(next);
  }

  async setFlagged(sessionId: string, isFlagged: boolean): Promise<void> {
    await this.deps.store.setFlagged(sessionId, isFlagged);
    const header = await this.deps.store.readHeader(sessionId).catch(() => undefined);
    if (header) this.runtimeKernel.updateCachedHeader(sessionId, header);
  }

  async renameSession(sessionId: string, name: string): Promise<void> {
    await this.deps.store.rename(sessionId, name);
    const header = await this.deps.store.readHeader(sessionId).catch(() => undefined);
    if (header) this.runtimeKernel.updateCachedHeader(sessionId, header);
  }

  async setPermissionMode(sessionId: string, mode: PermissionMode): Promise<SessionSummary> {
    const previous = await this.deps.store.readHeader(sessionId);
    const leavingDeepResearch = isDeepResearchSession(previous.labels) && mode !== 'explore';
    if (previous.permissionMode === mode && !leavingDeepResearch) return headerToSummary(previous);

    if (this.runtimeKernel.hasActiveRuns(sessionId)) {
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

    this.runtimeKernel.updateCachedHeader(sessionId, next);
    // AiSdkBackend snapshots the header at construction time. Rebuild the
    // backend before the next turn so PermissionEngine receives the new mode.
    await this.runtimeKernel.disposeBackend(sessionId);
    return headerToSummary(next);
  }

  async remove(sessionId: string): Promise<void> {
    await this.runtimeKernel.disposeBackend(sessionId);
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
   * Runtime v2 bridge: SessionManager remains the public facade; RuntimeKernel
   * owns AgentRun/AiSdkFlow/RuntimeRunner orchestration and ledger recording.
   */
  async *sendMessage(
    sessionId: string,
    input: UserMessageInput,
  ): AsyncIterable<SessionEvent> {
    yield* this.runtimeKernel.startTurn(sessionId, input);
  }

  async stopSession(sessionId: string, input: StopSessionInput = {}): Promise<void> {
    await this.runtimeKernel.stopSession(sessionId, input);
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
    const sourceView = await this.readModel().getSessionView(sessionId);
    const { messages } = sourceView;
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
    await this.cloneBranchRuntimeLedger(next.id, sourceView, copied);
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
    await this.runtimeKernel.respondToPermission(sessionId, response);
  }

  // --------------------------------------------------------------------------
  // Internal helpers
  // --------------------------------------------------------------------------

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
    this.runtimeKernel.updateCachedHeader(sessionId, next);
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
    const turn = (await this.readModel().getSessionView(sessionId)).turns.find((candidate) => candidate.turnId === turnId);
    if (!turn) throw new Error(`Cannot ${action}: unknown turn ${turnId}`);
    if (!allowed.includes(turn.status)) {
      throw new Error(`Cannot ${action}: turn ${turnId} is ${turn.status}`);
    }
    return turn;
  }

  private async requireUserMessageForTurn(sessionId: string, turnId: string): Promise<UserMessage> {
    const user = (await this.readModel().getSessionView(sessionId)).messages
      .find((message): message is UserMessage => message.type === 'user' && message.turnId === turnId);
    if (!user) throw new Error(`Turn ${turnId} has no user message`);
    return user;
  }

  private readModel(): RuntimeReadModel {
    if (!this.deps.runStore || !this.deps.runtimeEventStore) {
      throw new Error('RuntimeReadModel requires AgentRunStore and RuntimeEventStore');
    }
    return new RuntimeReadModel({
      runStore: this.deps.runStore,
      runtimeEventStore: this.deps.runtimeEventStore,
      projectionCache: this.deps.store,
    });
  }

  private async cloneBranchRuntimeLedger(
    childSessionId: string,
    sourceView: RuntimeReadModelSessionView,
    copiedMessages: readonly StoredMessage[],
  ): Promise<void> {
    if (!this.deps.runStore || !this.deps.runtimeEventStore) return;
    const copiedTurnIds = new Set<string>();
    for (const message of copiedMessages) {
      if ('turnId' in message && typeof message.turnId === 'string') copiedTurnIds.add(message.turnId);
    }
    if (copiedTurnIds.size === 0) return;

    for (const sourceRun of sourceView.runs) {
      if (!copiedTurnIds.has(sourceRun.turnId)) continue;
      const sourceEvents = sourceView.events.filter((event) =>
        event.runId === sourceRun.runId &&
        copiedTurnIds.has(event.turnId)
      );
      if (sourceEvents.length === 0) continue;

      const runId = this.deps.newId();
      const invocationIds = new Map<string, string>();
      await this.deps.runStore.createRun({
        ...sourceRun,
        sessionId: childSessionId,
        runId,
      });

      for (const event of sourceEvents) {
        await this.deps.runtimeEventStore.appendRuntimeEvent(
          childSessionId,
          runId,
          cloneRuntimeEventForBranch(event, {
            sessionId: childSessionId,
            runId,
            eventId: this.deps.newId(),
            invocationId: remapInvocationId(invocationIds, event.invocationId, this.deps.newId),
          }),
        );
      }
    }
  }

  private async recoverAgentRunsFromLedger(
    sessionId: string,
  ): Promise<{ hasLedger: boolean; recovered: boolean }> {
    if (!this.deps.runStore || !this.deps.runtimeEventStore) return { hasLedger: false, recovered: false };
    const runs = await this.deps.runStore.listSessionRuns(sessionId);
    if (runs.length === 0) return { hasLedger: false, recovered: false };

    let recovered = false;
    for (const run of runs) {
      const inspected = await inspectAgentRunReadModel(
        this.deps.runStore,
        this.deps.runtimeEventStore,
        { sessionId, runId: run.runId, header: run },
      );
      const runtimeDecision = this.classifyRuntimeEventRecovery(inspected);
      const decision = runtimeDecision ?? classifyAgentRunRecovery(run, inspected.events);
      if (!decision) continue;
      await this.applyAgentRunRecovery(sessionId, decision, inspected.events);
      recovered = true;
    }
    return { hasLedger: true, recovered };
  }

  private classifyRuntimeEventRecovery(
    inspected: AgentRunInspectModel,
  ): AgentRunRecoveryDecision | undefined {
    if (isTerminalRunStatus(inspected.header.status) || !inspected.terminalRuntimeFact) return undefined;
    return runtimeTerminalFactToRecoveryDecision(inspected.header, inspected.terminalRuntimeFact);
  }

  private async applyAgentRunRecovery(
    sessionId: string,
    decision: AgentRunRecoveryDecision,
    existingEvents: readonly { type: string }[] = [],
  ): Promise<void> {
    const ts = this.deps.now();
    if (decision.status === 'completed') {
      await this.deps.runStore?.updateRun(sessionId, decision.runId, {
        status: 'completed',
        completedAt: ts,
        updatedAt: ts,
      });
      if (!hasTerminalAgentRunEvent(existingEvents)) {
        await this.deps.runStore?.appendEvent(sessionId, decision.runId, {
          type: 'run_completed',
          id: this.deps.newId(),
          runId: decision.runId,
          sessionId,
          turnId: decision.turnId,
          ts,
          data: { recovered: true, ...decision.diagnostic },
        });
      }
      await this.appendTerminalTurnStateIfNeeded(sessionId, decision, 'completed', { ts }).catch(() => {});
      return;
    }

    if (decision.status === 'cancelled') {
      await this.deps.runStore?.updateRun(sessionId, decision.runId, {
        status: 'cancelled',
        completedAt: ts,
        updatedAt: ts,
      });
      if (!hasTerminalAgentRunEvent(existingEvents)) {
        await this.deps.runStore?.appendEvent(sessionId, decision.runId, {
          type: 'run_cancelled',
          id: this.deps.newId(),
          runId: decision.runId,
          sessionId,
          turnId: decision.turnId,
          ts,
          data: { recovered: true, ...decision.diagnostic },
        });
      }
      await this.appendTerminalTurnStateIfNeeded(sessionId, decision, 'aborted', {
        ts,
        abortSource: decision.abortSource,
      }).catch(() => {});
      return;
    }

    const failureClass = decision.failureClass ?? 'app_restarted';
    await this.deps.runStore?.updateRun(sessionId, decision.runId, {
      status: 'failed',
      completedAt: ts,
      updatedAt: ts,
      failureClass,
    });
    if (!hasTerminalAgentRunEvent(existingEvents)) {
      await this.deps.runStore?.appendEvent(sessionId, decision.runId, {
        type: 'run_failed',
        id: this.deps.newId(),
        runId: decision.runId,
        sessionId,
        turnId: decision.turnId,
        ts,
        data: { recovered: true, failureClass, ...decision.diagnostic },
      });
    }
    await this.appendTerminalTurnStateIfNeeded(sessionId, decision, 'failed', {
      ts,
      errorClass: failureClass,
    }).catch(() => {});
  }

  private async appendTerminalTurnStateIfNeeded(
    sessionId: string,
    decision: AgentRunRecoveryDecision,
    status: TurnRecord['status'],
    options: { ts: number; errorClass?: string; abortSource?: string },
  ): Promise<void> {
    const messages = await this.deps.store.readMessages(sessionId).catch(() => []);
    const latest = latestTurnState(messages, decision.turnId);
    if (latest && isTerminalTurnStatus(latest.status) && latest.status === status) return;
    await this.appendTurnState(sessionId, decision.turnId, status, decision.lineage, options);
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

function cloneRuntimeEventForBranch(
  event: RuntimeEvent,
  ids: { sessionId: string; runId: string; eventId: string; invocationId: string },
): RuntimeEvent {
  return {
    ...event,
    id: ids.eventId,
    invocationId: ids.invocationId,
    sessionId: ids.sessionId,
    runId: ids.runId,
  };
}

function remapInvocationId(
  mapping: Map<string, string>,
  sourceInvocationId: string,
  newId: () => string,
): string {
  const existing = mapping.get(sourceInvocationId);
  if (existing) return existing;
  const next = newId();
  mapping.set(sourceInvocationId, next);
  return next;
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

function isTerminalTurnStatus(status: TurnRecord['status']): boolean {
  return status === 'completed' || status === 'failed' || status === 'aborted';
}

function hasTerminalAgentRunEvent(events: readonly { type: string }[]): boolean {
  return events.some((event) =>
    event.type === 'run_completed' ||
    event.type === 'run_failed' ||
    event.type === 'run_cancelled'
  );
}

function latestTurnState(
  messages: readonly StoredMessage[],
  turnId: string,
): Extract<StoredMessage, { type: 'turn_state' }> | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.type === 'turn_state' && message.turnId === turnId) return message;
  }
  return undefined;
}

function runtimeTerminalFactToRecoveryDecision(
  header: AgentRunHeader,
  fact: RuntimeEventTerminalFact,
): AgentRunRecoveryDecision {
  return {
    runId: fact.runId,
    turnId: fact.turnId,
    status: fact.runStatus,
    ...(fact.failureClass ? { failureClass: fact.failureClass } : {}),
    ...(fact.abortSource ? { abortSource: fact.abortSource } : {}),
    diagnostic: {
      recoveryReason: 'runtime_event_terminal_fact',
      runtimeEventId: fact.terminalEvent.id,
      runtimeEventStatus: fact.terminalEvent.status,
    },
    lineage: {
      ...(header.parentTurnId ? { parentTurnId: header.parentTurnId } : {}),
      ...(header.retriedFromTurnId ? { retriedFromTurnId: header.retriedFromTurnId } : {}),
      ...(header.regeneratedFromTurnId ? { regeneratedFromTurnId: header.regeneratedFromTurnId } : {}),
      ...(header.branchOfTurnId ? { branchOfTurnId: header.branchOfTurnId } : {}),
      ...(header.parentSessionId ? { parentSessionId: header.parentSessionId } : {}),
    },
  };
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
