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

import type { AgentBackend } from './ai-sdk-backend.js';

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
  backends: BackendRegistry;
  newId: () => string;
  now: () => number;
}

interface ActiveSession {
  sessionId: string;
  backend: AgentBackend;
  /** Tracks the latest header we've read (used to short-circuit some reads). */
  cachedHeader: SessionHeader;
  activeStreams: number;
  activeTurnIds: Set<string>;
  activeTurnLineage: Map<string, Partial<Pick<UserMessageInput, 'parentTurnId' | 'retriedFromTurnId' | 'regeneratedFromTurnId' | 'branchOfTurnId' | 'parentSessionId'>>>;
  stoppedTurnIds: Set<string>;
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
    return this.deps.store.readMessages(sessionId);
  }

  async listTurns(sessionId: string): Promise<TurnRecord[]> {
    return this.deps.store.listTurns(sessionId);
  }

  async recoverInterruptedSessions(): Promise<string[]> {
    const interrupted = (await this.deps.store.list())
      .filter((session) => session.status !== 'archived');
    const recovered: string[] = [];
    for (const session of interrupted) {
      if (this.active.has(session.id)) continue;
      let messages: StoredMessage[];
      try {
        messages = await this.deps.store.readMessages(session.id);
      } catch {
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
    if (active && backendConfigChanged && active.activeStreams > 0) {
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
    if (active && active.activeStreams > 0) {
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
   * Phase 1 vertical (§9):
   *   1. Append UserMessage to JSONL + flush.
   *   2. Lock connection (set connectionLocked=true) if not already.
   *   3. Lookup or build the AgentBackend for this session.
   *   4. backend.send(input) → forward events.
   *   5. Update lastMessageAt + hasUnread when complete.
   */
  async *sendMessage(
    sessionId: string,
    input: UserMessageInput,
  ): AsyncIterable<SessionEvent> {
    // 1. Read header (for backend kind + permissionMode + cwd + model).
    let header = await this.deps.store.readHeader(sessionId);

    // 2. Append the user message FIRST, before any backend startup. JSONL is
    //    the source of truth; even if backend init fails the message is
    //    recorded.
    const userMsg: UserMessage = {
      type: 'user',
      id: this.deps.newId(),
      turnId: input.turnId,
      ts: this.deps.now(),
      text: input.text,
      ...(input.attachments ? { attachments: input.attachments } : {}),
    };
    await this.deps.store.appendMessage(sessionId, userMsg);
    await this.appendTurnState(sessionId, input.turnId, 'running', input);

    let lastTs = this.deps.now();
    let sawCompletion = false;
    let finalStatus: { status: SessionStatus; blockedReason?: SessionBlockedReason } | undefined;
    let active: ActiveSession | undefined;
    let activeStreamTracked = false;
    let turnFailed = false;

    try {
      // 3. Lock connection right after the user message is flushed (§9 Step 2.3).
      //    Even if backend startup fails next, the session's backend choice is
      //    committed and won't drift.
      if (!header.connectionLocked) {
        header = await this.deps.store.updateHeader(sessionId, { connectionLocked: true });
      }

      // 4. Resolve / build backend.
      active = await this.ensureActive(sessionId, header);

      // 5. Stream events from backend, side-tracking the latest ts for header
      //    bookkeeping when the turn completes.
      await this.updateStatus(sessionId, 'running', undefined, lastTs);
      active.activeStreams += 1;
      activeStreamTracked = true;
      active.activeTurnIds.add(input.turnId);
      active.activeTurnLineage.set(input.turnId, {
        ...(input.parentTurnId ? { parentTurnId: input.parentTurnId } : {}),
        ...(input.retriedFromTurnId ? { retriedFromTurnId: input.retriedFromTurnId } : {}),
        ...(input.regeneratedFromTurnId ? { regeneratedFromTurnId: input.regeneratedFromTurnId } : {}),
        ...(input.branchOfTurnId ? { branchOfTurnId: input.branchOfTurnId } : {}),
        ...(input.parentSessionId ? { parentSessionId: input.parentSessionId } : {}),
      });

      for await (const ev of active.backend.send({
        turnId: input.turnId,
        text: input.text,
        ...(input.attachments ? { attachments: input.attachments } : {}),
        context: await this.deps.store.readMessages(sessionId),
      })) {
        lastTs = ev.ts;
        const transition = statusFromEvent(ev);
        const stoppedDuringTurn = active.stoppedTurnIds.has(input.turnId);
        if (transition && !stoppedDuringTurn) {
          await this.updateStatus(sessionId, transition.status, transition.blockedReason, ev.ts);
        }
        if ((ev.type === 'complete' || ev.type === 'abort') && !turnFailed) {
          sawCompletion = true;
          finalStatus = stoppedDuringTurn
            ? { status: 'aborted' }
            : (transition ?? { status: 'active' });
          const turnStatus = turnStatusFromEvent(ev);
          if (turnStatus && !stoppedDuringTurn) {
            await this.appendTurnState(sessionId, input.turnId, turnStatus.status, input, {
              ts: ev.ts,
              errorClass: turnStatus.errorClass,
            });
          }
        }
        if (ev.type === 'error') {
          turnFailed = true;
          finalStatus = transition ?? { status: 'blocked', blockedReason: 'unknown' };
          await this.appendTurnState(sessionId, input.turnId, 'failed', input, {
            ts: ev.ts,
            errorClass: ev.reason ?? ev.code ?? 'unknown',
          });
        }
        yield ev;
      }
    } catch (error) {
      finalStatus = { status: 'blocked', blockedReason: 'unknown' };
      await this.appendTurnState(sessionId, input.turnId, 'failed', input, {
        errorClass: error instanceof Error ? error.name : 'unknown',
      }).catch(() => {});
      throw error;
    } finally {
      if (active && activeStreamTracked) {
        const stoppedDuringTurn = active.stoppedTurnIds.has(input.turnId);
        active.activeStreams = Math.max(0, active.activeStreams - 1);
        active.activeTurnIds.delete(input.turnId);
        active.activeTurnLineage.delete(input.turnId);
        active.stoppedTurnIds.delete(input.turnId);
        if (stoppedDuringTurn) {
          finalStatus = { status: 'aborted' };
        }
      }
      const nextStatus = active && active.activeStreams > 0
        ? { status: 'running' as const }
        : (finalStatus ?? { status: 'active' as const });
      // 6. Update header timestamps + unread flag exactly once per turn.
      try {
        await this.deps.store.updateHeader(sessionId, {
          lastUsedAt: lastTs,
          lastMessageAt: lastTs,
          hasUnread: true,
          ...statusPatch(nextStatus.status, lastTs, nextStatus.blockedReason),
        });
      } catch {
        // Swallow header-update failures; the turn already completed at the
        // user-visible level.
      }
      // Persist a SystemNote marking the turn end (helps debug + recovery).
      if (sawCompletion) {
        const note: SystemNoteMessage = {
          type: 'system_note',
          id: this.deps.newId(),
          turnId: input.turnId,
          ts: lastTs,
          kind: 'session_resume',
        };
        await this.deps.store.appendMessage(sessionId, note).catch(() => {});
      }
    }
  }

  async stopSession(sessionId: string, input: StopSessionInput = {}): Promise<void> {
    const active = this.active.get(sessionId);
    if (!active) return;
    const abortSource = normalizeStopSessionSource(input.source);
    await active.backend.stop('user_stop');
    for (const turnId of active.activeTurnIds) {
      active.stoppedTurnIds.add(turnId);
    }
    await this.updateStatus(sessionId, 'aborted');
    for (const turnId of active.activeTurnIds) {
      await this.appendTurnState(
        sessionId,
        turnId,
        'aborted',
        active.activeTurnLineage.get(turnId) ?? {},
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
    const messages = await this.deps.store.readMessages(sessionId);
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
    });
    const entry: ActiveSession = {
      sessionId,
      backend,
      cachedHeader: header,
      activeStreams: 0,
      activeTurnIds: new Set(),
      activeTurnLineage: new Map(),
      stoppedTurnIds: new Set(),
    };
    this.active.set(sessionId, entry);
    return entry;
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
    const next = await this.deps.store.updateHeader(sessionId, statusPatch(status, ts, blockedReason));
    const active = this.active.get(sessionId);
    if (active) active.cachedHeader = next;
  }

  private async appendTurnState(
    sessionId: string,
    turnId: string,
    status: TurnRecord['status'],
    lineage: Partial<Pick<UserMessageInput, 'parentTurnId' | 'retriedFromTurnId' | 'regeneratedFromTurnId' | 'branchOfTurnId' | 'parentSessionId'>> = {},
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
    const turn = (await this.deps.store.listTurns(sessionId)).find((candidate) => candidate.turnId === turnId);
    if (!turn) throw new Error(`Cannot ${action}: unknown turn ${turnId}`);
    if (!allowed.includes(turn.status)) {
      throw new Error(`Cannot ${action}: turn ${turnId} is ${turn.status}`);
    }
    return turn;
  }

  private async requireUserMessageForTurn(sessionId: string, turnId: string): Promise<UserMessage> {
    const user = (await this.deps.store.readMessages(sessionId))
      .find((message): message is UserMessage => message.type === 'user' && message.turnId === turnId);
    if (!user) throw new Error(`Turn ${turnId} has no user message`);
    return user;
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
