import type { AgentRunEvent, AgentRunHeader, AgentRunStore, RuntimeEvent } from '@maka/core';
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
import {
  buildRuntimeEventModelReplayPlan,
  type TextModelMessage,
} from './model-history.js';

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
  unregisterRun(active: AgentRunActiveSession, run: AgentRun): void;
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
  'parentTurnId' | 'retriedFromTurnId' | 'regeneratedFromTurnId' | 'branchOfTurnId' | 'parentSessionId'
>>;

export interface AgentRunInput {
  sessionId: string;
  header: SessionHeader;
  userInput: UserMessageInput;
  store: SessionStore;
  runStore?: AgentRunStore;
  newId: () => string;
  now: () => number;
  hooks: AgentRunHooks;
}

export interface AgentRunBeginResult {
  backend: AgentBackend;
  backendInput: BackendSendInput;
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
  private runStoreAvailable = true;
  private failureClass: string | undefined;
  private failureMessage: string | undefined;
  private lastTs = 0;
  private sawCompletion = false;
  private finalStatus: { status: SessionStatus; blockedReason?: SessionBlockedReason } | undefined;
  private turnFailed = false;
  private finalized = false;

  constructor(private readonly input: AgentRunInput) {
    this.runId = input.newId();
    this.sessionId = input.sessionId;
    this.turnId = input.userInput.turnId;
    this.header = input.header;
    this.lineage = {
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

  recordRunTrace(event: RunTraceEvent): void {
    if (!this.input.runStore || !this.runStoreAvailable) return;
    this.enqueueRunStore('append trace event', async () => {
      await this.input.runStore?.appendEvent(this.sessionId, this.runId, traceToRunEvent(event, this.runId));
    });
  }

  async *execute(): AsyncIterable<SessionEvent> {
    try {
      const begin = await this.begin();
      for await (const ev of begin.backend.send(begin.backendInput)) {
        await this.recordSessionEvent(ev);
        yield ev;
      }
    } catch (error) {
      await this.recordFailure(error);
      throw error;
    } finally {
      await this.finalize();
    }
  }

  async begin(): Promise<AgentRunBeginResult> {
    await this.createRunRecord();

    const userMsg: UserMessage = {
      type: 'user',
      id: this.input.newId(),
      turnId: this.turnId,
      ts: this.input.now(),
      text: this.input.userInput.text,
      ...(this.input.userInput.attachments ? { attachments: this.input.userInput.attachments } : {}),
    };
    await this.input.store.appendMessage(this.sessionId, userMsg);
    await this.input.hooks.appendTurnState(this.sessionId, this.turnId, 'running', this.lineage);

    this.lastTs = this.input.now();

    if (!this.header.connectionLocked) {
      this.header = await this.input.hooks.updateHeader(this.sessionId, { connectionLocked: true });
    }

    this.active = await this.input.hooks.ensureActive(this.sessionId, this.header);
    this.input.hooks.registerRun(this.active, this);
    await this.markRunStarted(this.lastTs);

    await this.input.hooks.updateStatus(this.sessionId, 'running', undefined, this.lastTs);

    const legacyContext = await this.input.store.readMessages(this.sessionId);
    const runtimeContext = await this.buildRuntimeContextIfComplete(legacyContext);

    return {
      backend: this.active.backend,
      backendInput: {
        turnId: this.turnId,
        text: this.input.userInput.text,
        ...(this.input.userInput.attachments ? { attachments: this.input.userInput.attachments } : {}),
        context: legacyContext,
        ...(runtimeContext !== undefined ? { runtimeContext } : {}),
      },
    };
  }

  async recordSessionEvent(ev: SessionEvent): Promise<void> {
    this.lastTs = ev.ts;
    const transition = statusFromEvent(ev);
    if (transition && !this.stopped) {
      await this.input.hooks.updateStatus(this.sessionId, transition.status, transition.blockedReason, ev.ts);
      this.recordStatusFromTransition(ev, transition, ev.ts);
    }
    if ((ev.type === 'complete' || ev.type === 'abort') && !this.turnFailed) {
      this.sawCompletion = true;
      this.finalStatus = this.stopped
        ? { status: 'aborted' }
        : (transition ?? { status: 'active' });
      const turnStatus = turnStatusFromEvent(ev);
      if (turnStatus && !this.stopped) {
        await this.input.hooks.appendTurnState(this.sessionId, this.turnId, turnStatus.status, this.lineage, {
          ts: ev.ts,
          errorClass: turnStatus.errorClass,
        });
      }
    }
    if (ev.type === 'error') {
      this.turnFailed = true;
      this.finalStatus = transition ?? { status: 'blocked', blockedReason: 'unknown' };
      await this.input.hooks.appendTurnState(this.sessionId, this.turnId, 'failed', this.lineage, {
        ts: ev.ts,
        errorClass: ev.reason ?? ev.code ?? 'unknown',
      });
      this.markRunFailed(ev.reason ?? ev.code ?? 'unknown', ev.message, ev.ts);
    }
  }

  async recordRuntimeEvents(events: readonly RuntimeEvent[]): Promise<void> {
    if (!this.input.runStore || !this.runStoreAvailable || events.length === 0) return;
    for (const event of events) {
      await this.enqueueRunStore('append runtime event', async () => {
        await this.input.runStore?.appendRuntimeEvent(this.sessionId, this.runId, event);
      });
    }
  }

  async recordFailure(error: unknown): Promise<void> {
    this.finalStatus = { status: 'blocked', blockedReason: 'unknown' };
    await this.input.hooks.appendTurnState(this.sessionId, this.turnId, 'failed', this.lineage, {
      errorClass: error instanceof Error ? error.name : 'unknown',
    }).catch(() => {});
    this.markRunFailed(error instanceof Error ? error.name : 'unknown', errorMessage(error), this.input.now());
  }

  async finalize(): Promise<void> {
    if (this.finalized) return;
    this.finalized = true;
    const lastTs = this.lastTs || this.input.now();
    if (this.active) {
      this.input.hooks.unregisterRun(this.active, this);
      if (this.stopped) this.finalStatus = { status: 'aborted' };
    }
    const nextStatus = this.active && this.active.activeRuns.size > 0
      ? { status: 'running' as const }
      : (this.finalStatus ?? { status: 'active' as const });
    try {
      await this.input.hooks.updateHeader(this.sessionId, {
        lastUsedAt: lastTs,
        lastMessageAt: lastTs,
        hasUnread: true,
        ...statusPatch(nextStatus.status, lastTs, nextStatus.blockedReason),
      });
    } catch {
      // The user-visible turn already completed; preserve existing behavior.
    }
    if (this.sawCompletion) {
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

  private async buildRuntimeContextIfComplete(
    legacyContext: readonly StoredMessage[],
  ): Promise<RuntimeEvent[] | undefined> {
    if (!this.input.runStore || !this.runStoreAvailable) return undefined;
    try {
      const runtimeContext: RuntimeEvent[] = [];
      const runs = await this.input.runStore.listSessionRuns(this.sessionId);
      for (const run of runs) {
        if (run.runId === this.runId || run.turnId === this.turnId) continue;
        const events = await this.input.runStore.readRuntimeEvents(this.sessionId, run.runId);
        runtimeContext.push(
          ...events.filter((event) => event.runId !== this.runId && event.turnId !== this.turnId),
        );
      }
      if (runtimeContext.length === 0) return undefined;

      const runtimeReplayPlan = buildRuntimeEventModelReplayPlan(runtimeContext);
      const runtimeMessages = runtimeReplayPlan.textMessages;
      if (runtimeMessages.length === 0) return undefined;

      const legacyPriorMessages = materializeLegacyTextMessages(
        legacyContext.filter((message) => message.turnId !== this.turnId),
      );
      if (!runtimeMessagesCoverLegacy(runtimeMessages, legacyPriorMessages)) return undefined;
      return runtimeContext;
    } catch {
      return undefined;
    }
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
    const status = this.stopped || finalStatus?.status === 'aborted'
      ? 'cancelled'
      : finalStatus?.status === 'blocked'
        ? 'failed'
        : finalStatus?.status === 'waiting_for_user'
          ? 'waiting_permission'
          : 'completed';
    const isTerminal = status === 'completed' || status === 'failed' || status === 'cancelled';
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

  private enqueueRunStore(label: string, operation: () => Promise<void>): Promise<void> {
    if (!this.input.runStore || !this.runStoreAvailable) return Promise.resolve();
    const next = this.traceQueue.then(operation, operation).catch(async (error) => {
      this.runStoreAvailable = false;
      await this.enqueueTraceWriteFailure(error, label);
    });
    this.traceQueue = next.catch(() => {});
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

function materializeLegacyTextMessages(stored: readonly StoredMessage[]): TextModelMessage[] {
  const out: TextModelMessage[] = [];
  for (const message of stored) {
    if (message.type === 'user') {
      out.push({ role: 'user', content: message.text });
    } else if (message.type === 'assistant') {
      out.push({ role: 'assistant', content: message.text });
    }
  }
  return out;
}

function runtimeMessagesCoverLegacy(
  runtimeMessages: readonly TextModelMessage[],
  legacyMessages: readonly TextModelMessage[],
): boolean {
  if (runtimeMessages.length !== legacyMessages.length) return false;
  return legacyMessages.every((legacyMessage, index) => {
    const runtimeMessage = runtimeMessages[index];
    if (!runtimeMessage || runtimeMessage.role !== legacyMessage.role) return false;
    if (runtimeMessage.content === legacyMessage.content) return true;
    return (
      runtimeMessage.role === 'user' &&
      runtimeMessage.content.startsWith(`${legacyMessage.content}\n\n[attachment: `)
    );
  });
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
