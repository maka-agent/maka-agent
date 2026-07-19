/**
 * SessionManager — the public Runtime API.
 *
 * Ties together:
 *   SessionStore (storage)           — JSONL persistence
 *   AgentBackend (AiSdkBackend etc) — SDK adapter
 *   PermissionEngine                  — policy + parking
 *
 * `SessionStore` comes from `@maka/storage`; its public interface owns
 * persistence and same-session serialization semantics.
 */

import type {
  SessionEvent,
  CompleteEvent,
  TextDeltaEvent,
  ErrorEvent,
  AbortEvent,
  PermissionDecisionAckEvent,
  PermissionRequestEvent,
  QueueEnqueueOutcome,
  ShellRunUpdate,
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
  AgentSpec,
  ChildAgentTurnInput,
  CreateSessionInput,
  BranchFromTurnInput,
  RegenerateTurnInput,
  UserMessageInput,
  SessionListFilter,
} from '@maka/core/runtime-inputs';
import type { PermissionResponse } from '@maka/core/permission';
import type { UserQuestionResponse } from '@maka/core/user-question';
import type { PermissionMode } from '@maka/core/permission';
import {
  DEFAULT_SESSION_NAME,
  DEEP_RESEARCH_SESSION_LABEL,
  failureClassFromCompleteStopReason,
  isDeepResearchSession,
} from '@maka/core';
import type {
  AgentRunEvent,
  AgentRunHeader,
  AgentRunStore,
  ArtifactRecord,
  RuntimeEvent,
  RuntimeEventStore,
} from '@maka/core';
import { type RuntimeEventTerminalFact } from './runtime-event-read-model.js';
import {
  RuntimeReadModel,
  RuntimeReadModelError,
  type RuntimeReadModelSessionView,
} from './runtime-read-model.js';
import { inspectAgentRunReadModel, type AgentRunInspectModel } from './agent-run-inspect.js';
import { firstRuntimeRepairRunId, RuntimeLedgerRepair } from './runtime-ledger-repair.js';
import {
  buildRecoveredTerminalRuntimeEvent,
  classifyTerminalRuntimeLedger,
  commitTerminalRunWithRuntimeFact,
  effectiveRunHeaderFromTerminalFact,
  terminalRunStatusFromRuntimeEvent,
} from './terminal-run-commit.js';

import type { AgentBackend, BackendStopMode } from '@maka/core/backend-types';
import type { AgentTeamExecutionContext, MakaTool } from './tool-runtime.js';
import type { RunTraceRecorder } from './run-trace.js';
import type { ShellRunProcessManager } from './shell-run-manager.js';
import type { ActiveFullCompactBlock } from './active-full-compact.js';
import type { SemanticCompactBlock } from './semantic-compact.js';
import type { HistoryCompactCheckpoint } from './history-compact-checkpoint.js';
import type { AgentRunLineage } from './agent-run.js';
import { classifyAgentRunRecovery, type AgentRunRecoveryDecision } from './agent-run-recovery.js';
import type { InvocationResult, InvocationSource } from './invocation-context.js';
import { RuntimeKernel, type RuntimeKernelLike, type TurnStartOptions } from './runtime-kernel.js';
import { fallbackSessionTitle, sessionTitleSource } from './session-title.js';
import type { HistoryCompactCleanupRequest } from './runtime-kernel.js';
import {
  buildStatusPatch,
  buildTurnStateMessage,
  turnHasRetainedOutput as messagesHaveRetainedOutput,
} from './session-projection-helpers.js';
import { listBuiltinAgentDefinitions, type AgentDefinitionListItem } from './agent-catalog.js';
import { requireResolvedAgentDefinition } from './expert-catalog.js';

export interface StopSessionInput {
  source?: 'stop_button' | 'benchmark_deadline';
  mode?: BackendStopMode;
}

export interface CompactSessionInput {
  turnId?: string;
}

export interface SpawnChildAgentInput {
  parentRunId: string;
  turnId?: string;
  spec: AgentSpec;
  prompt: string;
  abortSignal?: AbortSignal;
  onReady?: (input: { turnId: string; agentId: string; agentName: string }) => void | Promise<void>;
  /** Presentation-only observer for projecting child activity into a parent surface. */
  onEvent?: (event: SessionEvent) => void;
}

export interface SpawnChildAgentResult {
  agentId: string;
  agentName: string;
  turnId: string;
  runId?: string;
  status: 'completed' | 'failed' | 'cancelled' | 'running' | 'waiting_permission';
  permissionMode: PermissionMode;
  summary: string;
  artifactIds: string[];
  startedAt: number;
  completedAt: number;
  durationMs: number;
  eventCount: number;
  failureClass?: string;
}

const CHILD_AGENT_SUMMARY_MAX_CHARS = 4_000;
const MAX_RUNTIME_LEDGER_REPAIR_ATTEMPTS = 8;

export interface AgentListItem {
  runId: string;
  turnId: string;
  parentRunId: string;
  agentId?: string;
  agentName?: string;
  status: AgentRunHeader['status'];
  permissionMode: AgentRunHeader['permissionMode'];
  createdAt: number;
  updatedAt: number;
  completedAt?: number;
  durationMs?: number;
  failureClass?: string;
}

export interface AgentListResult {
  definitions: AgentDefinitionListItem[];
  runs: AgentListItem[];
}

export interface AgentOutputInput {
  runId?: string;
  turnId?: string;
  maxEvents?: number;
}

export interface AgentOutputResult {
  header: AgentRunHeader;
  events: AgentRunEvent[];
  runtimeEvents: RuntimeEvent[];
  sourceHealth: AgentRunInspectModel['sourceHealth'];
  diagnostics: AgentRunInspectModel['diagnostics'];
  artifacts: ArtifactRecord[];
  truncated: {
    events: boolean;
    runtimeEvents: boolean;
    diagnostics: boolean;
  };
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
  markSessionReadThrough(sessionId: string, readThroughTs: number): Promise<SessionHeader>;
  archive(sessionId: string): Promise<void>;
  unarchive(sessionId: string): Promise<void>;
  setFlagged(sessionId: string, isFlagged: boolean): Promise<void>;
  rename(sessionId: string, name: string): Promise<void>;
  setGeneratedTitleIfAbsent?(sessionId: string, title: string): Promise<SessionHeader | null>;
  remove(sessionId: string): Promise<void>;
}

export interface StrictRecoverySessionStore extends SessionStore {
  listForRecovery(): Promise<SessionHeader[]>;
  readMessagesForRecovery(sessionId: string): Promise<StoredMessage[]>;
}

export interface StrictRecoveryAgentRunStore extends AgentRunStore {
  listSessionRunsForRecovery(sessionId: string): Promise<AgentRunHeader[]>;
  readEventsForRecovery(sessionId: string, runId: string): Promise<AgentRunEvent[]>;
}

export interface StrictRecoveryStores {
  sessionStore: StrictRecoverySessionStore;
  agentRunStore: StrictRecoveryAgentRunStore;
}

// ============================================================================
// BackendRegistry — factory dispatch by BackendKind
// ============================================================================

export interface BackendFactoryContext {
  sessionId: string;
  workspaceRoot: string;
  header: SessionHeader;
  store: SessionStore;
  appendMessage?: (message: StoredMessage) => Promise<void>;
  /**
   * Child-agent instruction channel. Only `ensureChildActive` populates
   * this; the main-session `ensureActive` path leaves it undefined. A
   * main-session factory that needs a system prompt must source it from
   * its own closure (the desktop path and the headless benchmark path
   * both do this) — do NOT route a main-session prompt through this
   * field, it is semantically the child instruction, not the session
   * system prompt.
   */
  systemPrompt?: string;
  tools?: readonly MakaTool[];
  /** Trusted child expert-team identity. Main-session factories leave this undefined. */
  agentTeam?: AgentTeamExecutionContext;
  recordRunTrace?: RunTraceRecorder;
  loadHistoryCompactCheckpoint?: () => Promise<HistoryCompactCheckpoint | undefined>;
  recordHistoryCompactCheckpoint?: (
    checkpoint: HistoryCompactCheckpoint,
    turnId: string,
  ) => Promise<void>;
  /**
   * Durable read of the given turn's persisted RuntimeEvents from the
   * authoritative run ledger. Mid-turn capacity compaction derives its
   * coverage pool from this read, so covered events are persisted by
   * construction before any checkpoint that folds them.
   */
  loadTurnRuntimeEvents?: (turnId: string) => Promise<RuntimeEvent[]>;
  recordActiveFullCompactBlock?: (block: ActiveFullCompactBlock) => void;
  recordSemanticCompactBlock?: (block: SemanticCompactBlock) => void;
  shellRunContextSummary?: () => Promise<string | undefined>;
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
  childTools?: readonly MakaTool[];
  listArtifactsForTurn?: (sessionId: string, turnId: string) => Promise<ArtifactRecord[]>;
  runtimeSource?: InvocationSource;
  runtimeInvocationObserver?: (result: InvocationResult) => void | Promise<void>;
  runtimeKernel?: RuntimeKernelLike;
  shellRuns?: ShellRunProcessManager;
  cleanupHistoryCompactArtifacts?: (input: HistoryCompactCleanupRequest) => Promise<void>;
  generateSessionTitle?: (input: {
    sessionId: string;
    header: SessionHeader;
    sourceText: string;
  }) => Promise<string | undefined>;
  onSessionTitleChanged?: (sessionId: string) => void;
}

export class SessionManager {
  private readonly runtimeKernel: RuntimeKernelLike;
  private readonly runtimeLedgerRepair?: RuntimeLedgerRepair;

  constructor(private readonly deps: SessionManagerDeps) {
    if (deps.runStore && !deps.runtimeEventStore) {
      throw new Error('RuntimeEventStore is required when AgentRunStore is configured');
    }
    if (deps.runStore && deps.runtimeEventStore) {
      this.runtimeLedgerRepair = new RuntimeLedgerRepair({
        runStore: deps.runStore,
        runtimeEventStore: deps.runtimeEventStore,
        readMessages: (sessionId) => deps.store.readMessages(sessionId),
        appendTurnState: (sessionId, turnId, status, lineage, options) =>
          this.appendTurnState(sessionId, turnId, status, lineage, options),
        newId: deps.newId,
        now: deps.now,
      });
    }
    this.runtimeKernel =
      deps.runtimeKernel ??
      new RuntimeKernel({
        ...deps,
        repairRunRuntimeLedger: (sessionId, runId) =>
          this.repairMissingTerminalFactOnce(sessionId, runId),
      });
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

  /** Invalidate backend snapshots now, or immediately after active turns settle. */
  async refreshIdleBackends(): Promise<void> {
    const sessions = await this.deps.store.list();
    await Promise.all(sessions.map((session) => this.runtimeKernel.invalidateBackend(session.id)));
  }

  async getMessages(sessionId: string): Promise<StoredMessage[]> {
    return (await this.getSessionView(sessionId)).messages;
  }

  async listTurns(sessionId: string): Promise<TurnRecord[]> {
    return (await this.getSessionView(sessionId)).turns;
  }

  async listShellRunUpdates(sessionId: string): Promise<ShellRunUpdate[]> {
    const shellRuns = this.deps.shellRuns;
    if (!shellRuns) return [];

    const ownUpdates = await shellRuns.listSessionUpdates(sessionId);
    const ownToolCalls = new Set(ownUpdates.map((update) => update.sourceToolCallId));
    const messages = await this.getMessages(sessionId);
    const bashToolCalls = new Set(
      messages.flatMap((message) =>
        message.type === 'tool_call' && message.toolName === 'Bash' ? [message.id] : [],
      ),
    );
    const inherited = new Map<
      string,
      {
        ref: string;
        turnId: string;
        toolUseId: string;
        result: ShellRunUpdate['result'];
      }
    >();
    for (const message of messages) {
      if (
        message.type === 'tool_result' &&
        bashToolCalls.has(message.toolUseId) &&
        !ownToolCalls.has(message.toolUseId) &&
        message.content.kind === 'shell_run' &&
        message.content.status === 'running'
      ) {
        const { operation: _operation, ...result } = message.content;
        inherited.set(message.toolUseId, {
          ref: message.content.ref,
          turnId: message.turnId,
          toolUseId: message.toolUseId,
          result,
        });
      }
    }
    if (inherited.size === 0) return ownUpdates;

    const parentSessionId = (await this.deps.store.readHeader(sessionId)).parentSessionId;
    if (!parentSessionId) return ownUpdates;
    const inheritedUpdates = await Promise.all(
      [...inherited.values()].map(async (candidate) => {
        const owner = await this.resolveShellRunOwner(parentSessionId, candidate.ref);
        return {
          sessionId,
          ownership: owner
            ? {
                kind: 'source_owned',
                sourceSessionId: parentSessionId,
                ownerSessionId: owner.sessionId,
              }
            : { kind: 'source_unavailable', sourceSessionId: parentSessionId },
          sourceTurnId: candidate.turnId,
          sourceToolCallId: candidate.toolUseId,
          result: owner?.result ?? candidate.result,
        } satisfies ShellRunUpdate;
      }),
    );
    return [...ownUpdates, ...inheritedUpdates];
  }

  async recoverInterruptedSessions(): Promise<string[]> {
    return this.recoverInterruptedSessionsWithPolicy({ kind: 'best_effort' });
  }

  async recoverInterruptedSessionsStrict(stores: StrictRecoveryStores): Promise<string[]> {
    if (stores.sessionStore !== this.deps.store || stores.agentRunStore !== this.deps.runStore) {
      throw new Error('Strict recovery stores must match the SessionManager composition');
    }
    return this.recoverInterruptedSessionsWithPolicy({ kind: 'strict', stores });
  }

  private async recoverInterruptedSessionsWithPolicy(policy: RecoveryPolicy): Promise<string[]> {
    const interrupted = (await listSessionsForRecovery(this.deps.store, policy)).filter(
      (session) => session.status !== 'archived',
    );
    const recovered = new Set<string>();
    for (const session of interrupted) {
      if (this.runtimeKernel.hasActiveRuns(session.id)) continue;
      if (this.deps.shellRuns) {
        const recoveredShellRuns = await recoverOr(
          policy,
          () => this.deps.shellRuns!.recoverOrphanedSession(session.id),
          0,
        );
        if (recoveredShellRuns > 0) recovered.add(session.id);
      }
      let messages: StoredMessage[] = [];
      let messagesReadable = true;
      try {
        messages =
          policy.kind === 'strict'
            ? await policy.stores.sessionStore.readMessagesForRecovery(session.id)
            : await this.deps.store.readMessages(session.id);
      } catch (error) {
        if (policy.kind === 'strict') throw error;
        messagesReadable = false;
      }

      if (this.deps.runStore) {
        const runRecovery = await recoverOr(
          policy,
          () => this.recoverAgentRunsFromLedger(session.id, policy),
          undefined,
        );
        if (runRecovery?.hasLedger) {
          if (runRecovery.recovered) {
            await recoverOr(policy, () => this.updateStatus(session.id, 'active'), undefined);
            recovered.add(session.id);
          } else if (
            !messagesReadable &&
            (session.status === 'running' || session.status === 'waiting_for_user')
          ) {
            await recoverOr(policy, () => this.updateStatus(session.id, 'active'), undefined);
            recovered.add(session.id);
          }
          continue;
        }
      }

      if (!messagesReadable) {
        if (session.status === 'running' || session.status === 'waiting_for_user') {
          // Recovery may run in BACKGROUND startup (#456): re-check for a
          // run the user started while this session's recovery was in
          // flight, so we never stomp a live run's status.
          if (this.runtimeKernel.hasActiveRuns(session.id)) continue;
          await recoverOr(policy, () => this.updateStatus(session.id, 'active'), undefined);
          recovered.add(session.id);
        }
        continue;
      }

      const recoveries = interruptedTurnRecoveries(messages);
      if (recoveries.length === 0) continue;
      for (const recovery of recoveries) {
        await recoverOr(
          policy,
          () =>
            this.appendTurnState(session.id, recovery.turnId, 'failed', recovery.lineage, {
              errorClass: recovery.errorClass,
            }),
          undefined,
        );
      }
      if (session.status === 'running' || session.status === 'waiting_for_user') {
        // Same double-check as above: a message sent mid-recovery owns
        // the session status now (its own transitions will settle it).
        if (this.runtimeKernel.hasActiveRuns(session.id)) {
          recovered.add(session.id);
          continue;
        }
        await recoverOr(policy, () => this.updateStatus(session.id, 'active'), undefined);
      }
      recovered.add(session.id);
    }
    return [...recovered];
  }

  async updateSession(sessionId: string, patch: Partial<SessionHeader>): Promise<SessionSummary> {
    const backendConfigChanged = changesBackendConfig(patch);
    if (backendConfigChanged && this.runtimeKernel.hasActiveRuns(sessionId)) {
      throw new Error('Cannot change backend configuration while a turn is running');
    }

    const { name, titleIsManual: _titleIsManual, ...rest } = patch;
    if (name !== undefined) await this.deps.store.rename(sessionId, name);
    const next =
      Object.keys(rest).length > 0
        ? await this.deps.store.updateHeader(sessionId, rest)
        : await this.deps.store.readHeader(sessionId);
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
    const shellRunClose = await this.deps.shellRuns?.terminateSession(sessionId);
    try {
      await this.deps.store.archive(sessionId);
    } catch (error) {
      if (shellRunClose) this.deps.shellRuns?.rollbackSessionClose(shellRunClose);
      throw error;
    }
    if (shellRunClose) await this.deps.shellRuns?.commitSessionClose(shellRunClose);
    await this.runtimeKernel.disposeBackend(sessionId);
  }

  async unarchive(sessionId: string): Promise<void> {
    await this.deps.store.unarchive(sessionId);
    this.deps.shellRuns?.resumeSession(sessionId);
  }

  async setSessionStatus(
    sessionId: string,
    status: SessionStatus,
    blockedReason?: SessionBlockedReason,
  ): Promise<SessionSummary> {
    const next = await this.deps.store.updateHeader(
      sessionId,
      buildStatusPatch(status, this.deps.now(), blockedReason),
    );
    this.runtimeKernel.updateCachedHeader(sessionId, next);
    return headerToSummary(next);
  }

  async setFlagged(sessionId: string, isFlagged: boolean): Promise<void> {
    await this.deps.store.setFlagged(sessionId, isFlagged);
    const header = await this.deps.store.readHeader(sessionId).catch(() => undefined);
    if (header) this.runtimeKernel.updateCachedHeader(sessionId, header);
  }

  async markSessionRead(sessionId: string, readThroughTs: number | undefined): Promise<void> {
    if (readThroughTs === undefined || !Number.isFinite(readThroughTs)) return;
    const next = await this.deps.store.markSessionReadThrough(sessionId, readThroughTs);
    this.runtimeKernel.updateCachedHeader(sessionId, next);
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
    const shellRunClose = await this.deps.shellRuns?.terminateSession(sessionId);
    try {
      await this.runtimeKernel.disposeBackend(sessionId);
      await this.deps.store.remove(sessionId);
    } catch (error) {
      if (shellRunClose) this.deps.shellRuns?.rollbackSessionClose(shellRunClose);
      throw error;
    }
    if (shellRunClose) await this.deps.shellRuns?.commitSessionClose(shellRunClose);
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
    options: TurnStartOptions = {},
  ): AsyncIterable<SessionEvent> {
    const sourceText = sessionTitleSource(input);
    const onRunStarted = this.deps.generateSessionTitle
      ? async (runId: string, header: SessionHeader) => {
          await options.onRunStarted?.(runId, header);
          if (
            !header.connectionLocked &&
            !header.titleIsManual &&
            header.name === DEFAULT_SESSION_NAME &&
            sourceText
          ) {
            void this.generateTitleInBackground(sessionId, header, sourceText);
          }
        }
      : options.onRunStarted;
    yield* this.runtimeKernel.startTurn(sessionId, input, { ...options, onRunStarted });
  }

  private async generateTitleInBackground(
    sessionId: string,
    header: SessionHeader,
    sourceText: string,
  ): Promise<void> {
    let generated: string | undefined;
    try {
      generated = await this.deps.generateSessionTitle?.({ sessionId, header, sourceText });
    } catch {}
    try {
      const title = generated ?? fallbackSessionTitle(sourceText);
      if (!title) return;
      const next = await this.deps.store.setGeneratedTitleIfAbsent?.(sessionId, title);
      if (!next) return;
      this.runtimeKernel.updateCachedHeader(sessionId, next);
      this.deps.onSessionTitleChanged?.(sessionId);
    } catch {}
  }

  async *compactSession(
    sessionId: string,
    input: CompactSessionInput = {},
  ): AsyncIterable<SessionEvent> {
    yield* this.runtimeKernel.compactSession(sessionId, input);
  }

  async *startChildTurn(
    sessionId: string,
    input: ChildAgentTurnInput,
  ): AsyncIterable<SessionEvent> {
    yield* this.runtimeKernel.startChildTurn(sessionId, input);
  }

  async spawnChildAgent(
    sessionId: string,
    input: SpawnChildAgentInput,
  ): Promise<SpawnChildAgentResult> {
    const definition = requireResolvedAgentDefinition(input.spec.id);
    const turnId = input.turnId ?? this.deps.newId();
    const startedAt = this.deps.now();
    const summary = new ChildAgentSummaryAccumulator();
    let aborted = input.abortSignal?.aborted === true;
    await input.onReady?.({ turnId, agentId: definition.id, agentName: definition.name });
    const iterator = this.startChildTurn(sessionId, {
      turnId,
      parentRunId: input.parentRunId,
      spec: input.spec,
      prompt: input.prompt,
    })[Symbol.asyncIterator]();
    const onAbort = () => {
      aborted = true;
      void iterator.return?.();
    };
    if (input.abortSignal && !input.abortSignal.aborted) {
      input.abortSignal.addEventListener('abort', onAbort, { once: true });
    }
    try {
      while (!aborted) {
        const next = await iterator.next();
        if (next.done) break;
        summary.add(next.value);
        try {
          input.onEvent?.(next.value);
        } catch {
          // A presentation observer must not change the child run outcome.
        }
      }
    } finally {
      input.abortSignal?.removeEventListener('abort', onAbort);
      if (aborted) await iterator.return?.();
    }

    const completedAt = this.deps.now();
    const run = await this.findRunByTurnId(sessionId, turnId);
    const failureClass = run?.failureClass ?? summary.failureClass;
    const artifacts = this.deps.listArtifactsForTurn
      ? await this.deps.listArtifactsForTurn(sessionId, turnId)
      : [];
    return {
      agentId: definition.id,
      agentName: definition.name,
      turnId,
      ...(run?.runId ? { runId: run.runId } : {}),
      status: run ? agentRunStatusForSpawnResult(run.status) : summary.status(aborted),
      permissionMode: definition.permissionMode,
      summary: summary.text(),
      artifactIds: artifacts.map((artifact) => artifact.id),
      startedAt,
      completedAt,
      durationMs: Math.max(0, completedAt - startedAt),
      eventCount: summary.eventCount,
      ...(failureClass ? { failureClass } : {}),
    };
  }

  async listChildAgents(sessionId: string): Promise<AgentListResult> {
    const header = await this.deps.store.readHeader(sessionId);
    const definitions = listBuiltinAgentDefinitions({
      parentPermissionMode: header.permissionMode,
      tools: this.deps.childTools ?? [],
    });
    if (!this.deps.runStore) return { definitions, runs: [] };
    const runs = await this.deps.runStore.listSessionRuns(sessionId);
    const childRuns = await Promise.all(
      runs
        .filter((run): run is AgentRunHeader & { parentRunId: string } => !!run.parentRunId)
        .map(
          async (run): Promise<AgentRunHeader & { parentRunId: string }> => ({
            ...(await this.effectiveRunHeaderFromRuntimeLedger(run)),
            parentRunId: run.parentRunId,
          }),
        ),
    );
    return {
      definitions,
      runs: childRuns.map((run) => ({
        runId: run.runId,
        turnId: run.turnId,
        parentRunId: run.parentRunId,
        ...(run.agentId ? { agentId: run.agentId } : {}),
        ...(run.agentName ? { agentName: run.agentName } : {}),
        status: run.status,
        permissionMode: run.permissionMode,
        createdAt: run.createdAt,
        updatedAt: run.updatedAt,
        ...(run.completedAt !== undefined ? { completedAt: run.completedAt } : {}),
        ...(run.completedAt !== undefined
          ? { durationMs: Math.max(0, run.completedAt - run.createdAt) }
          : {}),
        ...(run.failureClass ? { failureClass: run.failureClass } : {}),
      })),
    };
  }

  async readChildAgentOutput(
    sessionId: string,
    input: AgentOutputInput,
  ): Promise<AgentOutputResult> {
    if (!this.deps.runStore || !this.deps.runtimeEventStore) {
      throw new Error('agent_output requires AgentRunStore and RuntimeEventStore');
    }
    const header = await this.findChildRunForOutput(sessionId, input);
    const inspected = await inspectAgentRunReadModel(
      this.deps.runStore,
      this.deps.runtimeEventStore,
      {
        sessionId,
        runId: header.runId,
        header,
      },
    );
    const artifacts = this.deps.listArtifactsForTurn
      ? await this.deps.listArtifactsForTurn(sessionId, header.turnId)
      : [];
    const maxEvents = normalizeAgentOutputMaxEvents(input.maxEvents);
    return {
      header: inspected.header,
      events: tail(inspected.events, maxEvents),
      runtimeEvents: tail(inspected.runtimeEvents, maxEvents),
      sourceHealth: inspected.sourceHealth,
      diagnostics: tail(inspected.diagnostics, maxEvents),
      artifacts,
      truncated: {
        events: inspected.events.length > maxEvents,
        runtimeEvents: inspected.runtimeEvents.length > maxEvents,
        diagnostics: inspected.diagnostics.length > maxEvents,
      },
    };
  }

  async stopSession(sessionId: string, input: StopSessionInput = {}): Promise<void> {
    await this.runtimeKernel.stopSession(sessionId, input);
  }

  /** Queue a user message for mid-turn injection at the next step boundary. */
  steer(sessionId: string, text: string): QueueEnqueueOutcome {
    return this.runtimeKernel.steer(sessionId, text);
  }

  /** Queue a user message to open the turn after the current one finishes. */
  queueMessage(sessionId: string, text: string): QueueEnqueueOutcome {
    return this.runtimeKernel.queueMessage(sessionId, text);
  }

  /** Drain the followup queue into one `\n\n`-joined prompt, or null if empty. */
  drainFollowup(sessionId: string): string | null {
    return this.runtimeKernel.drainFollowup(sessionId);
  }

  /** Take back every queued message (both queues) as one `\n\n`-joined string. */
  retractQueue(sessionId: string): string {
    return this.runtimeKernel.retractQueue(sessionId);
  }

  async *regenerateTurn(
    sessionId: string,
    input: RegenerateTurnInput,
  ): AsyncIterable<SessionEvent> {
    // retry semantics merged into regenerate (#546): regenerate now accepts
    // failed/aborted turns too, not just completed — one action re-runs the
    // turn regardless of how the previous attempt ended.
    const source = await this.requireTurnForAction(
      sessionId,
      input.sourceTurnId,
      ['failed', 'aborted', 'completed'],
      'regenerate',
    );
    const user = await this.requireUserMessageForTurn(sessionId, source.turnId);
    yield* this.sendMessage(sessionId, {
      turnId: input.turnId ?? this.deps.newId(),
      text: user.text,
      ...(user.displayText !== undefined ? { displayText: user.displayText } : {}),
      ...(user.attachments ? { attachments: user.attachments } : {}),
      parentTurnId: source.turnId,
      regeneratedFromTurnId: source.turnId,
    });
  }

  async branchFromTurn(sessionId: string, input: BranchFromTurnInput): Promise<SessionSummary> {
    const sourceView = await this.getSessionView(sessionId);
    // Inclusive: keep everything up to and including the chosen turn. A found
    // turn always has at least its own messages, so an empty copy means the
    // turn does not exist.
    const copied = copyMessagesThroughTurnBoundary(sourceView.messages, input.sourceTurnId);
    if (copied.length === 0)
      throw new Error(`Cannot branch from unknown turn ${input.sourceTurnId}`);
    return this.createBranchSession(sessionId, sourceView, copied, input);
  }

  async branchBeforeTurn(sessionId: string, input: BranchFromTurnInput): Promise<SessionSummary> {
    const sourceView = await this.getSessionView(sessionId);
    // Exclusive dual of branchFromTurn: keep everything strictly before the
    // chosen turn, dropping it and every later turn. An empty copy is valid
    // here (the turn is the first one) — it branches to a fresh, empty context.
    const copied = copyMessagesBeforeTurn(sourceView.messages, input.sourceTurnId);
    if (copied === null) throw new Error(`Cannot branch before unknown turn ${input.sourceTurnId}`);
    return this.createBranchSession(sessionId, sourceView, copied, input);
  }

  private async createBranchSession(
    sessionId: string,
    sourceView: RuntimeReadModelSessionView,
    copied: StoredMessage[],
    input: BranchFromTurnInput,
  ): Promise<SessionSummary> {
    const header = await this.deps.store.readHeader(sessionId);
    const next = await this.deps.store.create({
      cwd: header.cwd,
      backend: header.backend,
      llmConnectionSlug: header.llmConnectionSlug,
      model: header.model,
      thinkingLevel: header.thinkingLevel,
      permissionMode: header.permissionMode,
      name: input.name ?? `${header.name} · 分支`,
      labels: header.labels,
      parentSessionId: sessionId,
      branchOfTurnId: input.sourceTurnId,
      status: 'active',
    });
    await this.cloneBranchRuntimeLedger(next.id, sourceView, copied);
    if (copied.length > 0) await this.deps.store.appendMessages(next.id, copied);
    await this.deps.store.appendMessage(next.id, {
      type: 'system_note',
      id: this.deps.newId(),
      ts: this.deps.now(),
      kind: 'session_start',
      data: { parentSessionId: sessionId, branchOfTurnId: input.sourceTurnId },
    });
    return headerToSummary(await this.deps.store.readHeader(next.id));
  }

  async respondToPermission(sessionId: string, response: PermissionResponse): Promise<void> {
    await this.runtimeKernel.respondToPermission(sessionId, response);
  }

  async respondToUserQuestion(sessionId: string, response: UserQuestionResponse): Promise<void> {
    await this.runtimeKernel.respondToUserQuestion?.(sessionId, response);
  }

  // --------------------------------------------------------------------------
  // Internal helpers
  // --------------------------------------------------------------------------

  private async findRunByTurnId(
    sessionId: string,
    turnId: string,
  ): Promise<AgentRunHeader | undefined> {
    if (!this.deps.runStore) return undefined;
    const runs = await this.deps.runStore.listSessionRuns(sessionId).catch(() => []);
    const run = runs.find((candidate) => candidate.turnId === turnId);
    return run ? this.effectiveRunHeaderFromRuntimeLedger(run) : undefined;
  }

  private async resolveShellRunOwner(
    firstParentSessionId: string,
    ref: string,
  ): Promise<{ sessionId: string; result: ShellRunUpdate['result'] } | undefined> {
    const shellRuns = this.deps.shellRuns;
    if (!shellRuns) return undefined;
    let ownerSessionId: string | undefined = firstParentSessionId;
    const visited = new Set<string>();
    while (ownerSessionId && !visited.has(ownerSessionId)) {
      visited.add(ownerSessionId);
      try {
        return {
          sessionId: ownerSessionId,
          result: await shellRuns.inspectResource(ownerSessionId, ref),
        };
      } catch (error) {
        if (!isNotFoundError(error)) throw error;
        try {
          ownerSessionId = (await this.deps.store.readHeader(ownerSessionId)).parentSessionId;
        } catch (headerError) {
          if (isNotFoundError(headerError)) return undefined;
          throw headerError;
        }
      }
    }
    return undefined;
  }

  private async findChildRunForOutput(
    sessionId: string,
    input: AgentOutputInput,
  ): Promise<AgentRunHeader> {
    if (Number(!!input.runId) + Number(!!input.turnId) !== 1) {
      throw new Error('agent_output requires exactly one of runId or turnId');
    }
    const runs = await this.deps.runStore?.listSessionRuns(sessionId);
    const header = runs?.find((run) =>
      input.runId ? run.runId === input.runId : input.turnId ? run.turnId === input.turnId : false,
    );
    if (!header) throw new Error('agent_output could not find the requested child agent run');
    if (!header.parentRunId) throw new Error('agent_output only reads child agent runs');
    return this.effectiveRunHeaderFromRuntimeLedger(header);
  }

  private async effectiveRunHeaderFromRuntimeLedger(run: AgentRunHeader): Promise<AgentRunHeader> {
    if (!this.deps.runtimeEventStore) return run;
    const runtimeEvents = await this.deps.runtimeEventStore
      .readRuntimeEvents(run.sessionId, run.runId)
      .catch(() => undefined);
    if (!runtimeEvents) return run;
    const ledger = classifyTerminalRuntimeLedger(run, runtimeEvents);
    return ledger.kind === 'fact' ? effectiveRunHeaderFromTerminalFact(run, ledger.fact) : run;
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
    await this.deps.store.appendMessage(
      sessionId,
      buildTurnStateMessage({
        id: this.deps.newId(),
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

  private async requireTurnForAction(
    sessionId: string,
    turnId: string,
    allowed: readonly TurnRecord['status'][],
    action: string,
  ): Promise<TurnRecord> {
    const turn = (await this.getSessionView(sessionId)).turns.find(
      (candidate) => candidate.turnId === turnId,
    );
    if (!turn) throw new Error(`Cannot ${action}: unknown turn ${turnId}`);
    if (!allowed.includes(turn.status)) {
      throw new Error(`Cannot ${action}: turn ${turnId} is ${turn.status}`);
    }
    return turn;
  }

  private async requireUserMessageForTurn(sessionId: string, turnId: string): Promise<UserMessage> {
    const user = (await this.getSessionView(sessionId)).messages.find(
      (message): message is UserMessage => message.type === 'user' && message.turnId === turnId,
    );
    if (!user) throw new Error(`Turn ${turnId} has no user message`);
    return user;
  }

  private async getSessionView(sessionId: string): Promise<RuntimeReadModelSessionView> {
    const repaired = new Set<string>();
    for (let attempt = 0; attempt < MAX_RUNTIME_LEDGER_REPAIR_ATTEMPTS; attempt += 1) {
      try {
        const view = await this.readModel().getSessionView(sessionId);
        const runId = firstRuntimeRepairRunId(view.diagnostics, repaired);
        if (!runId) return view;
        if (!(await this.repairMissingTerminalFactOnce(sessionId, runId))) return view;
        repaired.add(runId);
      } catch (error) {
        if (!(error instanceof RuntimeReadModelError)) throw error;
        const runId = firstRuntimeRepairRunId(error.diagnostics, repaired);
        if (!runId) throw error;
        if (!(await this.repairMissingTerminalFactOnce(sessionId, runId))) throw error;
        repaired.add(runId);
      }
    }
    return this.readModel().getSessionView(sessionId);
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

  private async repairMissingTerminalFactOnce(sessionId: string, runId: string): Promise<boolean> {
    return (
      (await this.runtimeLedgerRepair?.repairMissingTerminalFactOnce(sessionId, runId)) ?? false
    );
  }

  private async cloneBranchRuntimeLedger(
    childSessionId: string,
    sourceView: RuntimeReadModelSessionView,
    copiedMessages: readonly StoredMessage[],
  ): Promise<void> {
    if (!this.deps.runStore || !this.deps.runtimeEventStore) return;
    const copiedTurnIds = new Set<string>();
    for (const message of copiedMessages) {
      if ('turnId' in message && typeof message.turnId === 'string')
        copiedTurnIds.add(message.turnId);
    }
    if (copiedTurnIds.size === 0) return;

    for (const sourceRun of sourceView.runs) {
      if (!copiedTurnIds.has(sourceRun.turnId)) continue;
      const sourceEvents = sourceView.events.filter(
        (event) => event.runId === sourceRun.runId && copiedTurnIds.has(event.turnId),
      );
      if (sourceEvents.length === 0) continue;

      const runId = this.deps.newId();
      const invocationId = this.deps.newId();
      const clonedRun = cloneRunHeaderForBranchCreate(
        sourceRun,
        childSessionId,
        runId,
        invocationId,
      );
      await this.deps.runStore.createRun(clonedRun);

      const sourceTerminalLedger = classifyTerminalRuntimeLedger(sourceRun, sourceEvents);
      const clonedEventBySourceId = new Map<string, RuntimeEvent>();
      for (const event of sourceEvents) {
        const clonedEvent = cloneRuntimeEventForBranch(event, {
          sessionId: childSessionId,
          runId,
          eventId: this.deps.newId(),
          invocationId,
        });
        await this.deps.runtimeEventStore.appendRuntimeEvent(childSessionId, runId, clonedEvent);
        clonedEventBySourceId.set(event.id, clonedEvent);
      }

      if (sourceTerminalLedger.kind === 'fact' && isTerminalRunStatus(sourceRun.status)) {
        const terminalEvent = clonedEventBySourceId.get(sourceTerminalLedger.fact.terminalEvent.id);
        if (!terminalEvent) continue;
        await commitTerminalRunWithRuntimeFact({
          runStore: this.deps.runStore,
          runtimeEventStore: this.deps.runtimeEventStore,
          newId: this.deps.newId,
          sessionId: childSessionId,
          runId,
          turnId: sourceRun.turnId,
          status: sourceTerminalLedger.fact.runStatus,
          ts: terminalEvent.ts,
          terminalEvent,
          ...(sourceTerminalLedger.fact.failureClass
            ? { failureClass: sourceTerminalLedger.fact.failureClass }
            : {}),
          ...(sourceRun.failureMessage ? { failureMessage: sourceRun.failureMessage } : {}),
          ...(sourceTerminalLedger.fact.abortSource
            ? { abortSource: sourceTerminalLedger.fact.abortSource }
            : {}),
          runEventData: {
            recovered: true,
            recoveryReason: 'branch_runtime_ledger_clone',
            sourceSessionId: sourceRun.sessionId,
            sourceRunId: sourceRun.runId,
          },
        });
      }
    }
  }

  private async recoverAgentRunsFromLedger(
    sessionId: string,
    policy: RecoveryPolicy = { kind: 'best_effort' },
  ): Promise<{ hasLedger: boolean; recovered: boolean }> {
    if (!this.deps.runStore || !this.deps.runtimeEventStore)
      return { hasLedger: false, recovered: false };
    const runs =
      policy.kind === 'strict'
        ? await policy.stores.agentRunStore.listSessionRunsForRecovery(sessionId)
        : await this.deps.runStore.listSessionRuns(sessionId);
    if (runs.length === 0) return { hasLedger: false, recovered: false };

    let recovered = false;
    for (const run of runs) {
      if (policy.kind === 'strict') {
        await policy.stores.agentRunStore.readEventsForRecovery(sessionId, run.runId);
      }
      const inspected = await inspectAgentRunReadModel(
        this.deps.runStore,
        this.deps.runtimeEventStore,
        { sessionId, runId: run.runId, header: run },
      );
      if (inspected.sourceHealth.runtimeLedger === 'read_failed') {
        if (policy.kind === 'strict') {
          throw new Error(`RuntimeEvent ledger is unreadable for run ${run.runId}`);
        }
        continue;
      }
      if (
        policy.kind === 'strict' &&
        inspected.diagnostics.some(
          (diagnostic) =>
            diagnostic.code === 'operational_ledger_read_failed' ||
            diagnostic.code === 'operational_event_corrupt',
        )
      ) {
        throw new Error(`AgentRun event ledger is unreadable for run ${run.runId}`);
      }
      const terminalLedger = classifyTerminalRuntimeLedger(run, inspected.runtimeEvents);
      if (terminalLedger.kind === 'ambiguous') {
        if (policy.kind === 'strict') {
          throw new Error(`RuntimeEvent ledger has ambiguous terminal facts for run ${run.runId}`);
        }
        continue;
      }
      if (isTerminalRunStatus(run.status) && !inspected.terminalRuntimeFact) {
        const repaired = await this.repairMissingTerminalFactOnce(sessionId, run.runId);
        if (repaired) {
          recovered = true;
        } else if (policy.kind === 'strict') {
          throw new Error(`Unable to repair the terminal RuntimeEvent fact for run ${run.runId}`);
        }
        continue;
      }
      const runtimeDecision = this.classifyRuntimeEventRecovery(inspected);
      const decision = runtimeDecision ?? classifyAgentRunRecovery(run, inspected.events);
      if (!decision) continue;
      if (await this.applyAgentRunRecovery(sessionId, decision, inspected, policy)) {
        recovered = true;
      }
    }
    return { hasLedger: true, recovered };
  }

  private classifyRuntimeEventRecovery(
    inspected: AgentRunInspectModel,
  ): AgentRunRecoveryDecision | undefined {
    if (isTerminalRunStatus(inspected.header.status) || !inspected.terminalRuntimeFact)
      return undefined;
    return runtimeTerminalFactToRecoveryDecision(inspected.header, inspected.terminalRuntimeFact);
  }

  private async applyAgentRunRecovery(
    sessionId: string,
    decision: AgentRunRecoveryDecision,
    inspected: AgentRunInspectModel,
    policy: RecoveryPolicy = { kind: 'best_effort' },
  ): Promise<boolean> {
    if (!this.deps.runStore || !this.deps.runtimeEventStore) return false;
    const ts = this.deps.now();
    const terminalLedger = classifyTerminalRuntimeLedger(inspected.header, inspected.runtimeEvents);
    const existingTerminal =
      inspected.terminalRuntimeFact?.terminalEvent ??
      (terminalLedger.kind === 'incomplete_single_terminal'
        ? terminalLedger.terminalEvent
        : undefined);
    const status = existingTerminal
      ? (terminalRunStatusFromRuntimeEvent(existingTerminal) ?? decision.status)
      : decision.status;
    const failureClass =
      status === 'failed' ? (decision.failureClass ?? 'app_restarted') : undefined;
    const abortSource = status === 'cancelled' ? (decision.abortSource ?? 'unknown') : undefined;
    const terminalEvent =
      existingTerminal ??
      buildRecoveredTerminalRuntimeEvent({
        id: this.deps.newId(),
        run: inspected.header,
        status,
        ts,
        recoveryReason: diagnosticRecoveryReason(decision.diagnostic),
        ...(inspected.runtimeEvents[0]?.invocationId
          ? { invocationId: inspected.runtimeEvents[0].invocationId }
          : {}),
        ...(failureClass ? { failureClass, message: failureClass } : {}),
        ...(abortSource ? { abortSource } : {}),
        ...(decision.diagnostic ? { diagnostic: decision.diagnostic } : {}),
      });
    try {
      await commitTerminalRunWithRuntimeFact({
        runStore: this.deps.runStore,
        runtimeEventStore: this.deps.runtimeEventStore,
        newId: this.deps.newId,
        sessionId,
        runId: decision.runId,
        turnId: decision.turnId,
        status,
        ts,
        terminalEvent,
        ...(failureClass ? { failureClass } : {}),
        ...(abortSource ? { abortSource } : {}),
        runEventData: { recovered: true, ...decision.diagnostic },
        existingEvents: inspected.events,
      });
    } catch (error) {
      if (policy.kind === 'strict') throw error;
      return false;
    }

    await recoverOr(
      policy,
      () =>
        this.appendTerminalTurnStateIfNeeded(
          sessionId,
          decision,
          terminalTurnStatus(status),
          {
            ts,
            ...(failureClass ? { errorClass: failureClass } : {}),
            ...(abortSource ? { abortSource } : {}),
          },
          policy,
        ),
      undefined,
    );
    return true;
  }

  private async appendTerminalTurnStateIfNeeded(
    sessionId: string,
    decision: AgentRunRecoveryDecision,
    status: TurnRecord['status'],
    options: { ts: number; errorClass?: string; abortSource?: string },
    policy: RecoveryPolicy = { kind: 'best_effort' },
  ): Promise<void> {
    if (decision.lineage.parentRunId) return;
    const messages = await recoverOr(
      policy,
      () => this.deps.store.readMessages(sessionId),
      [] as StoredMessage[],
    );
    const latest = latestTurnState(messages, decision.turnId);
    if (latest && isTerminalTurnStatus(latest.status) && latest.status === status) return;
    await this.appendTurnState(sessionId, decision.turnId, status, decision.lineage, options);
  }
}

type RecoveryPolicy = { kind: 'best_effort' } | { kind: 'strict'; stores: StrictRecoveryStores };

function listSessionsForRecovery(
  store: SessionStore,
  policy: RecoveryPolicy,
): Promise<Array<SessionHeader | SessionSummary>> {
  return policy.kind === 'strict' ? policy.stores.sessionStore.listForRecovery() : store.list();
}

async function recoverOr<T>(
  policy: RecoveryPolicy,
  operation: () => Promise<T>,
  fallback: T,
): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (policy.kind === 'strict') throw error;
    return fallback;
  }
}

// ============================================================================
// Helpers
// ============================================================================

export function headerToSummary(h: SessionHeader): SessionSummary {
  const summary: SessionSummary = {
    id: h.id,
    cwd: h.cwd,
    ...(h.pendingCwdReminder ? { pendingCwdReminder: h.pendingCwdReminder } : {}),
    name: h.name === 'New Session' ? DEFAULT_SESSION_NAME : h.name,
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
    connectionLocked: h.connectionLocked,
    model: h.model,
    permissionMode: h.permissionMode ?? 'ask',
  };
  if (h.thinkingLevel !== undefined) summary.thinkingLevel = h.thinkingLevel;
  if (h.lastMessageAt !== undefined) {
    summary.lastMessageAt = h.lastMessageAt;
  }
  return summary;
}

function isNotFoundError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

export function changesBackendConfig(patch: Partial<SessionHeader>): boolean {
  return (
    'backend' in patch ||
    'llmConnectionSlug' in patch ||
    'model' in patch ||
    'thinkingLevel' in patch ||
    'cwd' in patch
  );
}

function agentRunStatusForSpawnResult(
  status: AgentRunHeader['status'],
): SpawnChildAgentResult['status'] {
  if (status === 'waiting_permission') return 'waiting_permission';
  if (status === 'cancelled') return 'cancelled';
  if (status === 'failed') return 'failed';
  if (status === 'running' || status === 'created') return 'running';
  return 'completed';
}

function trimSummary(text: string): string {
  const trimmed = text.trim();
  return trimmed.length <= CHILD_AGENT_SUMMARY_MAX_CHARS
    ? trimmed
    : `${trimmed.slice(0, CHILD_AGENT_SUMMARY_MAX_CHARS - 1)}…`;
}

class ChildAgentSummaryAccumulator {
  eventCount = 0;
  failureClass: string | undefined;
  private terminalStatus: SpawnChildAgentResult['status'] | undefined;
  private lastTextComplete = '';
  private textDeltaTail = '';
  private textDeltaTruncated = false;
  private lastError = '';

  add(event: SessionEvent): void {
    this.eventCount += 1;
    switch (event.type) {
      case 'text_complete':
        this.lastTextComplete = trimSummary(event.text);
        break;
      case 'text_delta':
        this.appendTextDelta(event.text);
        break;
      case 'error':
        this.terminalStatus = 'failed';
        this.lastError = trimSummary(event.message);
        break;
      case 'abort':
        this.terminalStatus = 'cancelled';
        break;
      case 'complete':
        this.failureClass = failureClassFromCompleteStopReason(event.stopReason);
        if (this.failureClass) this.terminalStatus = 'failed';
        else if (event.stopReason === 'user_stop') this.terminalStatus = 'cancelled';
        else this.terminalStatus = 'completed';
        break;
    }
  }

  status(aborted: boolean): SpawnChildAgentResult['status'] {
    if (aborted) return 'cancelled';
    return this.terminalStatus ?? 'running';
  }

  text(): string {
    if (this.lastTextComplete.trim()) return this.lastTextComplete;
    if (this.textDeltaTail.trim()) {
      return this.textDeltaTruncated
        ? `…${this.textDeltaTail.slice(1)}`
        : this.textDeltaTail.trim();
    }
    return this.lastError;
  }

  private appendTextDelta(text: string): void {
    this.textDeltaTail += text;
    if (this.textDeltaTail.length <= CHILD_AGENT_SUMMARY_MAX_CHARS) return;
    this.textDeltaTruncated = true;
    this.textDeltaTail = this.textDeltaTail.slice(-CHILD_AGENT_SUMMARY_MAX_CHARS);
  }
}

interface InterruptedTurnRecovery {
  turnId: string;
  errorClass: string;
  lineage: Partial<
    Pick<
      UserMessageInput,
      | 'parentTurnId'
      | 'retriedFromTurnId'
      | 'regeneratedFromTurnId'
      | 'branchOfTurnId'
      | 'parentSessionId'
    >
  >;
}

function interruptedTurnRecoveries(messages: readonly StoredMessage[]): InterruptedTurnRecovery[] {
  const byTurn = new Map<
    string,
    {
      hasAssistant: boolean;
      states: Array<Extract<StoredMessage, { type: 'turn_state' }>>;
    }
  >();
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
): Partial<
  Pick<
    UserMessageInput,
    | 'parentTurnId'
    | 'retriedFromTurnId'
    | 'regeneratedFromTurnId'
    | 'branchOfTurnId'
    | 'parentSessionId'
  >
> {
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

function cloneRunHeaderForBranchCreate(
  sourceRun: AgentRunHeader,
  childSessionId: string,
  runId: string,
  invocationId: string,
): AgentRunHeader {
  const cloned = { ...sourceRun, invocationId, sessionId: childSessionId, runId };
  if (isTerminalRunStatus(sourceRun.status)) {
    cloned.status = 'running';
    delete cloned.completedAt;
    delete cloned.failureClass;
    delete cloned.failureMessage;
    delete cloned.abortSource;
  }
  return cloned;
}

function copyMessagesThroughTurnBoundary(
  messages: readonly StoredMessage[],
  turnId: string,
): StoredMessage[] {
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
  return messages.slice(0, lastIndex + 1).filter((message) => message.type !== 'turn_state');
}

// Exclusive dual of copyMessagesThroughTurnBoundary: every message belonging to
// a turn strictly before the chosen one, dropping it and every later turn.
// Returns null when the turn is absent (so the caller can reject an unknown
// turn), and an empty array when the turn is the first one (a valid branch into
// empty context). Membership, not array position, decides what to keep: the read
// model does not guarantee a turn's messages are contiguous or that a user
// prompt precedes its turn_state in array order, so a positional slice could
// drop an earlier turn's prompt. turn_state is dropped for the same reason as in
// the inclusive copy — lineage lives on the child header, not copied metadata.
function copyMessagesBeforeTurn(
  messages: readonly StoredMessage[],
  turnId: string,
): StoredMessage[] | null {
  const turnOrder: string[] = [];
  const seen = new Set<string>();
  for (const message of messages) {
    const messageTurnId = (message as { turnId?: string }).turnId;
    if (messageTurnId && !seen.has(messageTurnId)) {
      seen.add(messageTurnId);
      turnOrder.push(messageTurnId);
    }
  }
  const cut = turnOrder.indexOf(turnId);
  if (cut < 0) return null;
  const keep = new Set(turnOrder.slice(0, cut));
  return messages.filter((message) => {
    if (message.type === 'turn_state') return false;
    const messageTurnId = (message as { turnId?: string }).turnId;
    return messageTurnId !== undefined && keep.has(messageTurnId);
  });
}

function isTerminalRunStatus(status: AgentRunHeader['status']): boolean {
  return status === 'completed' || status === 'failed' || status === 'cancelled';
}

function isTerminalTurnStatus(status: TurnRecord['status']): boolean {
  return status === 'completed' || status === 'failed' || status === 'aborted';
}

function terminalTurnStatus(status: AgentRunRecoveryDecision['status']): TurnRecord['status'] {
  if (status === 'cancelled') return 'aborted';
  return status;
}

function diagnosticRecoveryReason(diagnostic: Record<string, unknown> | undefined): string {
  const recoveryReason = diagnostic?.recoveryReason;
  return typeof recoveryReason === 'string' && recoveryReason.length > 0
    ? recoveryReason
    : 'agent_run_recovery';
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
    lineage: headerLineage(header),
  };
}

function headerLineage(header: AgentRunHeader): AgentRunRecoveryDecision['lineage'] {
  return {
    ...(header.parentRunId ? { parentRunId: header.parentRunId } : {}),
    ...(header.parentTurnId ? { parentTurnId: header.parentTurnId } : {}),
    ...(header.retriedFromTurnId ? { retriedFromTurnId: header.retriedFromTurnId } : {}),
    ...(header.regeneratedFromTurnId
      ? { regeneratedFromTurnId: header.regeneratedFromTurnId }
      : {}),
    ...(header.branchOfTurnId ? { branchOfTurnId: header.branchOfTurnId } : {}),
    ...(header.parentSessionId ? { parentSessionId: header.parentSessionId } : {}),
  };
}

function normalizeAgentOutputMaxEvents(value: number | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 20;
  return Math.min(100, Math.max(1, Math.floor(value)));
}

function tail<T>(items: readonly T[], max: number): T[] {
  if (items.length <= max) return [...items];
  return items.slice(items.length - max);
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
