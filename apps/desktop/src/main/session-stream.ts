import { randomUUID } from 'node:crypto';
import { expertTeamIdFromLabels, resolveModelVisionSupport } from '@maka/core';
import type { SessionChangedReason, SessionEvent } from '@maka/core';
import type { LlmConnection } from '@maka/core/llm-connections';
import type { LlmCallRecord, ToolInvocationRecord } from '@maka/core/usage-stats/types';
import {
  AiSdkBackend,
  buildDefaultContextBudgetPolicy,
  buildExpertDispatchToolForTeamId,
  buildHostCapabilitiesFromBinding,
  buildLlmHistorySummarizer,
  buildMcpTools,
  buildProviderOptions,
  createProviderRequestCaptureRecorder,
  getAIModel,
  loadHistoryCompactBlocksFromArtifacts,
  loadSynthesisCacheBlocksFromArtifacts,
  persistSynthesisCacheBlocksToArtifacts,
  recordLlmCall,
  recordToolInvocation,
  resolveSelectedModelContextWindow,
} from '@maka/runtime';
import type {
  BackendFactory,
  GoalTurnOutcome,
  HostCapabilities,
  PermissionEngine,
  SessionActivityLease,
  SessionActivityRegistry,
  SessionManager,
  ToolArtifactRecorderInput,
  ToolResultArchiveReaderInput,
  ToolResultArchiveRecorderInput,
  buildPricingLookup,
} from '@maka/runtime';
import type { McpClientManager } from '@maka/mcp';
import {
  createArtifactStore,
  createAttachmentByteReader,
  createTelemetryRepo,
  openRuntimeEventPersistence,
  persistProviderRequestCaptureArtifact,
} from '@maka/storage';
import { WEB_SEARCH_TOOL_NAME } from './web-search/agent-tool.js';
import {
  computerUseAvailabilityForModel,
  computerUseToolsForModel,
} from './computer-use-model-tools.js';
import { errorCode, errorMessage, errorReason } from './chat-readiness.js';
import type { ReadyConnection } from './chat-readiness.js';
import type { assembleDesktopTools } from './tool-assembly.js';
import type { ToolArtifactPersistence } from './tool-artifact-persistence.js';
import type { createMainTaskLedgerWiring } from './task-ledger-wiring.js';
import type { createMainGoalWiring } from './goal-wiring.js';
import type { createSubscriptionModelFetch } from './subscription-model-fetch.js';
import type { createSystemPromptMainService } from './system-prompt-main.js';
import type { OpenGatewayService } from './open-gateway.js';
import { startDesktopSessionTurn, type SessionGoalBoundary } from './session-turn-stream.js';

type AssembledTools = ReturnType<typeof assembleDesktopTools>;
type SystemPromptMainService = ReturnType<typeof createSystemPromptMainService>;
type SubscriptionModelFetchBuilder = ReturnType<typeof createSubscriptionModelFetch>;
type TaskLedgerStore = ReturnType<typeof createMainTaskLedgerWiring>['store'];
type GoalWiring = ReturnType<typeof createMainGoalWiring>;
type ArtifactStore = ReturnType<typeof createArtifactStore>;
type TelemetryRepo = ReturnType<typeof createTelemetryRepo>;
type PricingLookup = ReturnType<typeof buildPricingLookup>;
type RuntimeCommitStore = Awaited<ReturnType<typeof openRuntimeEventPersistence>>['runtimeCommitStore'];

/**
 * Selected-model image-input capability, consulted before wiring AiSdkBackend.
 * Stored provider capabilities win; a bare model id falls back to in-repo
 * metadata (provider `/models` responses do not report image support).
 */
function modelSupportsVision(connection: LlmConnection, model: string): boolean {
  return resolveModelVisionSupport(connection.providerType, connection.models, model);
}

export interface AiSdkBackendFactoryDeps {
  isComputerUseRealModelE2e: boolean;
  ensureMcpReady: () => Promise<void>;
  getReadyConnection: (slug: string | null | undefined, model?: string) => Promise<ReadyConnection>;
  buildSubscriptionModelFetch: SubscriptionModelFetchBuilder;
  systemPromptService: SystemPromptMainService;
  mcpManager: McpClientManager;
  permissionEngine: PermissionEngine;
  taskLedgerStore: TaskLedgerStore;
  telemetryRepo: TelemetryRepo;
  artifactStore: ArtifactStore;
  desktopSessionSkillHosts: Map<string, HostCapabilities>;
  computerUseTools: AssembledTools['computerUseTools'];
  agentTeamLeadTools: AssembledTools['agentTeamLeadTools'];
  builtinTools: AssembledTools['builtinTools'];
  toolAvailability: AssembledTools['toolAvailability'];
  persistToolArtifacts: ToolArtifactPersistence['persistToolArtifacts'];
  persistArchivedToolResult: ToolArtifactPersistence['persistArchivedToolResult'];
  readArchivedToolResult: ToolArtifactPersistence['readArchivedToolResult'];
  runtimeCommitStore: RuntimeCommitStore;
  safeSendToRenderer: (channel: string, ...args: unknown[]) => void;
  getRuntime: () => SessionManager;
  getLookupPricing: () => PricingLookup;
}

/**
 * Build the real `ai-sdk` backend factory (arch R5). Pure move of main.ts's
 * `backends.register('ai-sdk', async (ctx) => …)` closure. Two module-scoped
 * seams that resolve AFTER the registration point are injected as accessors:
 * `getRuntime` (the SessionManager is constructed after registration) and
 * `getLookupPricing` (a mutable pricing lookup reassigned by usage IPC + startup;
 * read live per `recordLlmCall`, snapshotted once for the `lookupPricing` field —
 * matching the original module-`let` closure semantics exactly).
 */
export function createAiSdkBackendFactory(deps: AiSdkBackendFactoryDeps): BackendFactory {
  const {
    isComputerUseRealModelE2e,
    ensureMcpReady,
    getReadyConnection,
    buildSubscriptionModelFetch,
    systemPromptService,
    mcpManager,
    permissionEngine,
    taskLedgerStore,
    telemetryRepo,
    artifactStore,
    desktopSessionSkillHosts,
    computerUseTools,
    agentTeamLeadTools,
    builtinTools,
    toolAvailability,
    persistToolArtifacts,
    persistArchivedToolResult,
    readArchivedToolResult,
    runtimeCommitStore,
    safeSendToRenderer,
    getRuntime,
    getLookupPricing,
  } = deps;

  return async (ctx) => {
    // MCP is optional. A corrupt mcp.json remains visible in the MCP module,
    // but must not prevent builtin-only conversations from creating a backend.
    await ensureMcpReady().catch(() => {});
    const { connection, apiKey, model } = await getReadyConnection(ctx.header.llmConnectionSlug, ctx.header.model);
    const modelFetch = buildSubscriptionModelFetch(connection, ctx.sessionId, model);
    const memoryPromptSnapshot = await systemPromptService.buildLocalMemoryPromptFragment();
    const supportsVision = modelSupportsVision(connection, model);
    const candidateTools = isComputerUseRealModelE2e
      ? computerUseTools
      : ctx.tools
        ? [...ctx.tools]
        : [...builtinTools, ...buildMcpTools(mcpManager)];
    const candidateToolAvailability = isComputerUseRealModelE2e
      ? { economy: false, groups: [] }
      : toolAvailability;
    // Expert-team lead: a main session (ctx.tools undefined) labeled
    // `mode:expert-team:<teamId>` gets the team-bound expert_dispatch tool.
    // Child turns receive scoped `ctx.tools` and inherit the label, but must NOT
    // get expert_dispatch — members cannot spawn nested teams.
    const expertTeamId = ctx.tools ? undefined : expertTeamIdFromLabels(ctx.header.labels);
    const expertDispatchTool = expertTeamId
      ? buildExpertDispatchToolForTeamId(expertTeamId, { taskLedger: taskLedgerStore })
      : undefined;
    const agentTeam = ctx.agentTeam ?? (expertTeamId
      ? { role: 'lead' as const, teamId: expertTeamId, agentId: 'lead' }
      : undefined);
    const backendTools = computerUseToolsForModel(
      candidateTools,
      computerUseTools,
      supportsVision,
    );
    const backendToolAvailability = computerUseAvailabilityForModel(
      candidateToolAvailability,
      supportsVision,
    );
    const backendToolNames = new Set([
      ...backendTools.map((tool) => tool.name),
      ...(expertDispatchTool ? [expertDispatchTool.name, ...agentTeamLeadTools.map((tool) => tool.name)] : []),
    ]);
    const backendSkillHost = buildHostCapabilitiesFromBinding(backendToolNames);
    // Child backends share the parent sessionId but intentionally have a
    // narrower tool surface. They do not receive the Desktop Skill tool, so
    // they must not overwrite the parent session's resolver entry.
    if (!ctx.tools) desktopSessionSkillHosts.set(ctx.sessionId, backendSkillHost);

    return new AiSdkBackend({
      sessionId: ctx.sessionId,
      header: { ...ctx.header, model },
      appendMessage: ctx.appendMessage ?? ((message) => ctx.store.appendMessage(ctx.sessionId, message)),
      connection,
      apiKey: apiKey ?? '',
      modelId: model,
      permissionEngine,
      modelFactory: (input) => getAIModel({ ...input, fetch: modelFetch }),
      tools: expertDispatchTool
        ? [...backendTools, expertDispatchTool, ...agentTeamLeadTools]
        : backendTools,
      agentTeam,
      toolAvailability: backendToolAvailability,
      spawnChildAgent: (input) => getRuntime().spawnChildAgent(ctx.sessionId, input),
      listChildAgents: () => getRuntime().listChildAgents(ctx.sessionId),
      readChildAgentOutput: (input) => getRuntime().readChildAgentOutput(ctx.sessionId, input),
      providerOptions: buildProviderOptions(connection, model, ctx.header.thinkingLevel),
      contextBudget: buildDefaultContextBudgetPolicy(connection, {
        name: 'desktop-default-history-budget',
        modelId: model,
      }),
      systemPrompt: ({ cwd }) => systemPromptService.buildBackendSystemPrompt(ctx.header, cwd, {
        memoryFragment: memoryPromptSnapshot,
        childInstruction: ctx.systemPrompt,
        skillBudget: { contextWindow: resolveSelectedModelContextWindow(connection, model) },
        host: backendSkillHost,
      }),
      turnTailPrompt: ({ cwd, sessionId }) => systemPromptService.buildTurnTailPrompt(cwd, sessionId),
      shellRunContextSummary: ctx.shellRunContextSummary,
      lookupPricing: getLookupPricing(),
      recordLlmCall: (event: LlmCallRecord) => recordLlmCall({ repo: telemetryRepo, lookupPricing: getLookupPricing() }, event),
      recordToolInvocation: (event: ToolInvocationRecord) =>
        recordToolInvocation(
          { repo: telemetryRepo },
          // PR-AGENT-WEB-SEARCH-TOOL-0: scrub the query out of the
          // telemetry record. The agent passes the raw user query as
          // the tool argument; persisting it in `argsSummary` would
          // leak user-derived content into the usage log.
          event.toolName === WEB_SEARCH_TOOL_NAME
            ? { ...event, argsSummary: undefined }
            : event,
        ),
      recordToolArtifacts: (event: ToolArtifactRecorderInput) => persistToolArtifacts(ctx.header.cwd, event),
      archiveToolResult: (event: ToolResultArchiveRecorderInput) => persistArchivedToolResult(event),
      readToolResultArchive: (event: ToolResultArchiveReaderInput) => readArchivedToolResult(event),
      readAttachmentBytes: createAttachmentByteReader({ artifactStore, sessionId: ctx.sessionId }),
      ...(runtimeCommitStore
        ? { runtimeCommitSink: runtimeCommitStore }
        : {}),
      supportsVision,
      loadHistoryCompact: (event) => loadHistoryCompactBlocksFromArtifacts(artifactStore, event),
      loadHistoryCompactCheckpoint: ctx.loadHistoryCompactCheckpoint,
      summarizeHistoryCompact: buildLlmHistorySummarizer({
        // Reuse the same connection/model the session already drives, so the
        // summary stays consistent with the model that will consume it.
        resolveModel: () =>
          getAIModel({ connection, apiKey: apiKey ?? '', modelId: model, fetch: modelFetch }),
        providerOptions: buildProviderOptions(connection, model, ctx.header.thinkingLevel),
      }),
      loadSynthesisCache: (event) => loadSynthesisCacheBlocksFromArtifacts(artifactStore, event),
      writeSynthesisCache: (event) => persistSynthesisCacheBlocksToArtifacts(artifactStore, event, {
        onArtifactCreated: (artifact) => {
          safeSendToRenderer('artifacts:changed', {
            reason: 'created',
            artifactId: artifact.id,
            sessionId: artifact.sessionId,
            ts: Date.now(),
          });
        },
      }),
      recordRunTrace: ctx.recordRunTrace,
      ...(ctx.recordProviderRequestCapture
        ? {
            recordProviderRequestCapture: createProviderRequestCaptureRecorder({
              persistArtifact: async (capture) => {
                const artifact = await persistProviderRequestCaptureArtifact(artifactStore, {
                  sessionId: ctx.sessionId,
                  turnId: capture.turnId,
                  captureId: capture.captureId,
                  step: capture.step,
                  serializedRequest: capture.serializedRequest,
                  now: Date.now(),
                });
                return { artifactId: artifact.id };
              },
              recordLedger: ctx.recordProviderRequestCapture,
            }),
            recordProviderRequestAttempt: ctx.recordProviderRequestAttempt,
          }
        : {}),
      recordHistoryCompactCheckpoint: ctx.recordHistoryCompactCheckpoint,
      loadTurnRuntimeEvents: ctx.loadTurnRuntimeEvents,
      recordActiveFullCompactBlock: ctx.recordActiveFullCompactBlock,
      recordSemanticCompactBlock: ctx.recordSemanticCompactBlock,
      newId: randomUUID,
      now: Date.now,
    });
  };
}

interface StreamEventsOptions {
  turnId: string;
  goalBoundary: SessionGoalBoundary;
  activity?: SessionActivityLease;
  observeEvent?: (event: SessionEvent) => void;
}

interface StreamEventsResult {
  turnId: string;
  ok: boolean;
  error?: string;
  outcome: GoalTurnOutcome;
}

export type StreamEvents = (
  sessionId: string,
  iterator: AsyncIterable<SessionEvent>,
  options: StreamEventsOptions,
) => Promise<StreamEventsResult>;

export interface SessionStreamerDeps {
  sessionActivities: SessionActivityRegistry;
  goalWiring: GoalWiring;
  openGateway: OpenGatewayService;
  computerUseOverlay: AssembledTools['computerUseOverlay'];
  computerUseTools: AssembledTools['computerUseTools'];
  safeSendToRenderer: (channel: string, ...args: unknown[]) => void;
  emitSessionsChanged: (reason: SessionChangedReason, sessionId?: string) => void;
}

function isStatusChangingSessionEvent(event: SessionEvent): boolean {
  return event.type === 'permission_request' ||
    event.type === 'permission_decision_ack' ||
    event.type === 'complete' ||
    event.type === 'abort' ||
    event.type === 'error';
}

function isTurnStatusChangingSessionEvent(event: SessionEvent): boolean {
  return event.type === 'complete' || event.type === 'abort' || event.type === 'error';
}

/**
 * Session event fan-out plumbing (arch R5). Pure move of main.ts's `streamEvents`
 * plus its two event-classifier helpers. Returns the `streamEvents` function that
 * every turn-driving call site in main.ts drives; behavior is identical to the
 * in-main.ts original.
 */
export function createSessionStreamer(deps: SessionStreamerDeps): StreamEvents {
  const {
    sessionActivities,
    goalWiring,
    openGateway,
    computerUseOverlay,
    computerUseTools,
    safeSendToRenderer,
    emitSessionsChanged,
  } = deps;

  return function streamEvents(
    sessionId: string,
    iterator: AsyncIterable<SessionEvent>,
    options: StreamEventsOptions,
  ): Promise<StreamEventsResult> {
    let userAppendBroadcasted = false;
    const turnId = options.turnId;
    const started = startDesktopSessionTurn({
      sessionId,
      events: iterator,
      turnId,
      goalBoundary: options.goalBoundary,
      activities: sessionActivities,
      ...(options.activity ? { activity: options.activity } : {}),
      beginExternalTurn: (externalSessionId, externalTurnId) =>
        goalWiring.coordinator.beginExternalTurn(externalSessionId, externalTurnId),
      onEvent: (event) => {
        if (!userAppendBroadcasted) {
          emitSessionsChanged('message-appended', sessionId);
          userAppendBroadcasted = true;
        }
        safeSendToRenderer(`sessions:event:${sessionId}`, event);
        openGateway.publishSessionEvent(sessionId, event);
        if (isStatusChangingSessionEvent(event)) {
          emitSessionsChanged('status-change', sessionId);
        }
        if (isTurnStatusChangingSessionEvent(event)) {
          emitSessionsChanged('turn-status-change', sessionId);
          computerUseOverlay.clearForSession(sessionId);
          computerUseTools.clearSession(sessionId);
        }
        options.observeEvent?.(event);
      },
      onStreamError: (error) => {
        const event = {
          type: 'error',
          id: randomUUID(),
          turnId,
          ts: Date.now(),
          recoverable: false,
          code: errorCode(error),
          reason: errorReason(error),
          message: errorMessage(error),
        } satisfies SessionEvent;
        safeSendToRenderer(`sessions:event:${sessionId}`, event);
        openGateway.publishSessionEvent(sessionId, event);
        emitSessionsChanged('status-change', sessionId);
        emitSessionsChanged('turn-status-change', sessionId);
        computerUseOverlay.clearForSession(sessionId);
        computerUseTools.clearSession(sessionId);
      },
      onDrained: () => {
        emitSessionsChanged('message-appended', sessionId);
      },
    });
    if (started.kind === 'unavailable') throw new Error(started.reason);
    return started.completion.then((outcome) => {
      const failureReason = outcome.kind === 'errored' || outcome.kind === 'suspended'
        ? outcome.reason
        : undefined;
      return {
        turnId,
        ok: outcome.kind === 'completed',
        ...(failureReason ? { error: failureReason } : {}),
        outcome,
      };
    });
  };
}
