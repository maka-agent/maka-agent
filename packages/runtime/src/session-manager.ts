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
  CompleteEvent,
  TextDeltaEvent,
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
  AgentSpec,
  ChildAgentTurnInput,
  CreateSessionInput,
  BranchFromTurnInput,
  RegenerateTurnInput,
  UserMessageInput,
  SessionListFilter,
} from '@maka/core/runtime-inputs';
import type { PermissionResponse } from '@maka/core/permission';
import type { PermissionMode } from '@maka/core/permission';
import { DEEP_RESEARCH_SESSION_LABEL, isDeepResearchSession } from '@maka/core';
import type { AgentRunEvent, AgentRunHeader, AgentRunStore, ArtifactRecord, RuntimeEvent, RuntimeEventStore } from '@maka/core';
import {
  type RuntimeEventTerminalFact,
} from './runtime-event-read-model.js';
import { RuntimeReadModel, RuntimeReadModelError, type RuntimeReadModelSessionView } from './runtime-read-model.js';
import { inspectAgentRunReadModel, type AgentRunInspectModel } from './agent-run-inspect.js';
import { firstRuntimeRepairRunId, RuntimeLedgerRepair } from './runtime-ledger-repair.js';
import {
  buildRecoveredTerminalRuntimeEvent,
  classifyTerminalRuntimeLedger,
  commitTerminalRunWithRuntimeFact,
  effectiveRunHeaderFromTerminalFact,
  terminalRunStatusFromRuntimeEvent,
} from './terminal-run-commit.js';

import type { AgentBackend, MakaTool } from './ai-sdk-backend.js';
import type { RunTraceRecorder } from './run-trace.js';
import type { ShellRunProcessManager } from './shell-run-manager.js';
import type { ActiveFullCompactBlock } from './active-full-compact.js';
import type { SemanticCompactBlock } from './semantic-compact.js';
import type { AgentRunLineage } from './agent-run.js';
import { classifyAgentRunRecovery, type AgentRunRecoveryDecision } from './agent-run-recovery.js';
import type {
  InvocationResult,
  InvocationSource,
} from './invocation-context.js';
import { RuntimeKernel, type RuntimeKernelLike } from './runtime-kernel.js';
import {
  buildStatusPatch,
  buildTurnStateMessage,
  turnHasRetainedOutput as messagesHaveRetainedOutput,
} from './session-projection-helpers.js';
import {
  listBuiltinAgentDefinitions,
  requireBuiltinAgentDefinition,
  type AgentDefinitionListItem,
} from './agent-catalog.js';

export interface StopSessionInput {
  source?: 'stop_button';
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
  recordRunTrace?: RunTraceRecorder;
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
    this.runtimeKernel = deps.runtimeKernel ?? new RuntimeKernel({
      ...deps,
      repairRunRuntimeLedger: (sessionId, runId) => this.repairMissingTerminalFactOnce(sessionId, runId),
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

  async getMessages(sessionId: string): Promise<StoredMessage[]> {
    return (await this.getSessionView(sessionId)).messages;
  }

  async listTurns(sessionId: string): Promise<TurnRecord[]> {
    return (await this.getSessionView(sessionId)).turns;
  }

  async recoverInterruptedSessions(): Promise<string[]> {
    const interrupted = (await this.deps.store.list())
      .filter((session) => session.status !== 'archived');
    const recovered = new Set<string>();
    for (const session of interrupted) {
      if (this.runtimeKernel.hasActiveRuns(session.id)) continue;
      if (this.deps.shellRuns) {
        const recoveredShellRuns = await this.deps.shellRuns.recoverOrphanedSession(session.id).catch(() => 0);
        if (recoveredShellRuns > 0) recovered.add(session.id);
      }
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
            recovered.add(session.id);
          } else if (!messagesReadable && (session.status === 'running' || session.status === 'waiting_for_user')) {
            await this.updateStatus(session.id, 'active').catch(() => {});
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
          await this.updateStatus(session.id, 'active').catch(() => {});
          recovered.add(session.id);
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
        // Same double-check as above: a message sent mid-recovery owns
        // the session status now (its own transitions will settle it).
        if (this.runtimeKernel.hasActiveRuns(session.id)) {
          recovered.add(session.id);
          continue;
        }
        await this.updateStatus(session.id, 'active').catch(() => {});
      }
      recovered.add(session.id);
    }
    return [...recovered];
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
    await this.deps.shellRuns?.terminateSession(sessionId);
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
    const next = await this.deps.store.updateHeader(sessionId, buildStatusPatch(status, this.deps.now(), blockedReason));
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
    await this.deps.shellRuns?.terminateSession(sessionId);
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
    const definition = requireBuiltinAgentDefinition(input.spec.id);
    const turnId = input.turnId ?? this.deps.newId();
    const startedAt = this.deps.now();
    const summary = new ChildAgentSummaryAccumulator();
    let aborted = input.abortSignal?.aborted === true;
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
      }
    } finally {
      input.abortSignal?.removeEventListener('abort', onAbort);
      if (aborted) await iterator.return?.();
    }

    const completedAt = this.deps.now();
    const run = await this.findRunByTurnId(sessionId, turnId);
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
      ...(run?.failureClass ? { failureClass: run.failureClass } : {}),
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
        .map(async (run): Promise<AgentRunHeader & { parentRunId: string }> => ({
          ...await this.effectiveRunHeaderFromRuntimeLedger(run),
          parentRunId: run.parentRunId,
        })),
    );
    return {
      definitions,
      runs: childRuns
        .map((run) => ({
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
          ...(run.completedAt !== undefined ? { durationMs: Math.max(0, run.completedAt - run.createdAt) } : {}),
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
    const inspected = await inspectAgentRunReadModel(this.deps.runStore, this.deps.runtimeEventStore, {
      sessionId,
      runId: header.runId,
      header,
    });
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

  async *regenerateTurn(
    sessionId: string,
    input: RegenerateTurnInput,
  ): AsyncIterable<SessionEvent> {
    // retry semantics merged into regenerate (#546): regenerate now accepts
    // failed/aborted turns too, not just completed — one action re-runs the
    // turn regardless of how the previous attempt ended.
    const source = await this.requireTurnForAction(sessionId, input.sourceTurnId, ['failed', 'aborted', 'completed'], 'regenerate');
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
    const sourceView = await this.getSessionView(sessionId);
    const { messages } = sourceView;
    const copied = copyMessagesThroughTurnBoundary(messages, input.sourceTurnId);
    if (copied.length === 0) throw new Error(`Cannot branch from unknown turn ${input.sourceTurnId}`);
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

  private async findRunByTurnId(
    sessionId: string,
    turnId: string,
  ): Promise<AgentRunHeader | undefined> {
    if (!this.deps.runStore) return undefined;
    const runs = await this.deps.runStore.listSessionRuns(sessionId).catch(() => []);
    const run = runs.find((candidate) => candidate.turnId === turnId);
    return run ? this.effectiveRunHeaderFromRuntimeLedger(run) : undefined;
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
      input.runId ? run.runId === input.runId : input.turnId ? run.turnId === input.turnId : false
    );
    if (!header) throw new Error('agent_output could not find the requested child agent run');
    if (!header.parentRunId) throw new Error('agent_output only reads child agent runs');
    return this.effectiveRunHeaderFromRuntimeLedger(header);
  }

  private async effectiveRunHeaderFromRuntimeLedger(run: AgentRunHeader): Promise<AgentRunHeader> {
    if (!this.deps.runtimeEventStore) return run;
    const runtimeEvents = await this.deps.runtimeEventStore.readRuntimeEvents(run.sessionId, run.runId).catch(() => undefined);
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

  private async requireTurnForAction(
    sessionId: string,
    turnId: string,
    allowed: readonly TurnRecord['status'][],
    action: string,
  ): Promise<TurnRecord> {
    const turn = (await this.getSessionView(sessionId)).turns.find((candidate) => candidate.turnId === turnId);
    if (!turn) throw new Error(`Cannot ${action}: unknown turn ${turnId}`);
    if (!allowed.includes(turn.status)) {
      throw new Error(`Cannot ${action}: turn ${turnId} is ${turn.status}`);
    }
    return turn;
  }

  private async requireUserMessageForTurn(sessionId: string, turnId: string): Promise<UserMessage> {
    const user = (await this.getSessionView(sessionId)).messages
      .find((message): message is UserMessage => message.type === 'user' && message.turnId === turnId);
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
        if (!await this.repairMissingTerminalFactOnce(sessionId, runId)) return view;
        repaired.add(runId);
      } catch (error) {
        if (!(error instanceof RuntimeReadModelError)) throw error;
        const runId = firstRuntimeRepairRunId(error.diagnostics, repaired);
        if (!runId) throw error;
        if (!await this.repairMissingTerminalFactOnce(sessionId, runId)) throw error;
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
    return await this.runtimeLedgerRepair?.repairMissingTerminalFactOnce(sessionId, runId) ?? false;
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
      const clonedRun = cloneRunHeaderForBranchCreate(sourceRun, childSessionId, runId);
      await this.deps.runStore.createRun(clonedRun);

      const sourceTerminalLedger = classifyTerminalRuntimeLedger(sourceRun, sourceEvents);
      const clonedEventBySourceId = new Map<string, RuntimeEvent>();
      for (const event of sourceEvents) {
        const clonedEvent = cloneRuntimeEventForBranch(event, {
          sessionId: childSessionId,
          runId,
          eventId: this.deps.newId(),
          invocationId: remapInvocationId(invocationIds, event.invocationId, this.deps.newId),
        });
        await this.deps.runtimeEventStore.appendRuntimeEvent(childSessionId, runId, clonedEvent);
        clonedEventBySourceId.set(event.id, clonedEvent);
      }

      if (sourceTerminalLedger.kind === 'fact' && isTerminalRunStatus(sourceRun.status)) {
        const terminalEvent = clonedEventBySourceId.get(sourceTerminalLedger.fact.terminalEvent.id);
        if (!terminalEvent) continue;
        await commitTerminalRunWithRuntimeFact({
          runStore: this.deps.runStore,
          newId: this.deps.newId,
          sessionId: childSessionId,
          runId,
          turnId: sourceRun.turnId,
          status: sourceTerminalLedger.fact.runStatus,
          ts: terminalEvent.ts,
          terminalEvent,
          terminalEventAlreadyPersisted: true,
          ...(sourceTerminalLedger.fact.failureClass ? { failureClass: sourceTerminalLedger.fact.failureClass } : {}),
          ...(sourceRun.failureMessage ? { failureMessage: sourceRun.failureMessage } : {}),
          ...(sourceTerminalLedger.fact.abortSource ? { abortSource: sourceTerminalLedger.fact.abortSource } : {}),
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
      if (inspected.sourceHealth.runtimeLedger === 'read_failed') continue;
      const terminalLedger = classifyTerminalRuntimeLedger(run, inspected.runtimeEvents);
      if (terminalLedger.kind === 'ambiguous') continue;
      if (isTerminalRunStatus(run.status) && !inspected.terminalRuntimeFact) {
        const repaired = await this.repairMissingTerminalFactOnce(sessionId, run.runId);
        if (repaired) {
          recovered = true;
        }
        continue;
      }
      const runtimeDecision = this.classifyRuntimeEventRecovery(inspected);
      const decision = runtimeDecision ?? classifyAgentRunRecovery(run, inspected.events);
      if (!decision) continue;
      if (await this.applyAgentRunRecovery(sessionId, decision, inspected)) {
        recovered = true;
      }
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
    inspected: AgentRunInspectModel,
  ): Promise<boolean> {
    if (!this.deps.runStore || !this.deps.runtimeEventStore) return false;
    const ts = this.deps.now();
    const terminalLedger = classifyTerminalRuntimeLedger(inspected.header, inspected.runtimeEvents);
    const existingTerminal = inspected.terminalRuntimeFact?.terminalEvent ??
      (terminalLedger.kind === 'incomplete_single_terminal' ? terminalLedger.terminalEvent : undefined);
    const status = existingTerminal ? terminalRunStatusFromRuntimeEvent(existingTerminal) ?? decision.status : decision.status;
    const failureClass = status === 'failed' ? decision.failureClass ?? 'app_restarted' : undefined;
    const abortSource = status === 'cancelled' ? decision.abortSource ?? 'unknown' : undefined;
    const terminalEvent = existingTerminal ?? buildRecoveredTerminalRuntimeEvent({
      id: this.deps.newId(),
      run: inspected.header,
      status,
      ts,
      recoveryReason: diagnosticRecoveryReason(decision.diagnostic),
      ...(inspected.runtimeEvents[0]?.invocationId ? { invocationId: inspected.runtimeEvents[0].invocationId } : {}),
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
        terminalEventAlreadyPersisted: existingTerminal !== undefined,
        ...(failureClass ? { failureClass } : {}),
        ...(abortSource ? { abortSource } : {}),
        runEventData: { recovered: true, ...decision.diagnostic },
        existingEvents: inspected.events,
      });
    } catch {
      return false;
    }

    await this.appendTerminalTurnStateIfNeeded(sessionId, decision, terminalTurnStatus(status), {
      ts,
      ...(failureClass ? { errorClass: failureClass } : {}),
      ...(abortSource ? { abortSource } : {}),
    }).catch(() => {});
    return true;
  }

  private async appendTerminalTurnStateIfNeeded(
    sessionId: string,
    decision: AgentRunRecoveryDecision,
    status: TurnRecord['status'],
    options: { ts: number; errorClass?: string; abortSource?: string },
  ): Promise<void> {
    if (decision.lineage.parentRunId) return;
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
    cwd: h.cwd,
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
  if (h.thinkingLevel !== undefined) summary.thinkingLevel = h.thinkingLevel;
  if (h.lastMessageAt !== undefined) {
    summary.lastMessageAt = h.lastMessageAt;
  }
  return summary;
}

export function changesBackendConfig(patch: Partial<SessionHeader>): boolean {
  return 'backend' in patch || 'llmConnectionSlug' in patch || 'model' in patch || 'thinkingLevel' in patch;
}

function agentRunStatusForSpawnResult(status: AgentRunHeader['status']): SpawnChildAgentResult['status'] {
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
        if (event.stopReason === 'error') this.terminalStatus = 'failed';
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

function cloneRunHeaderForBranchCreate(
  sourceRun: AgentRunHeader,
  childSessionId: string,
  runId: string,
): AgentRunHeader {
  const cloned = { ...sourceRun, sessionId: childSessionId, runId };
  if (isTerminalRunStatus(sourceRun.status)) {
    cloned.status = 'running';
    delete cloned.completedAt;
    delete cloned.failureClass;
    delete cloned.failureMessage;
    delete cloned.abortSource;
  }
  return cloned;
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
    ...(header.regeneratedFromTurnId ? { regeneratedFromTurnId: header.regeneratedFromTurnId } : {}),
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
