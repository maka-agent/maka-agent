import { projectToolActivityArgs } from '@maka/core';
import type {
  SessionEvent,
  ToolActivityKind,
  ToolOutputStream,
  ToolResultContent,
  ToolResultEvent,
  ToolStartEvent,
} from '@maka/core/events';
import type {
  PermissionDecisionMessage,
  ToolCallMessage,
  ToolResultMessage,
} from '@maka/core/session';
import type { PermissionDecision } from '@maka/core/backend-types';
import type { AgentSpec } from '@maka/core/runtime-inputs';
import type {
  PermissionMode,
  ToolCategory,
  ToolExecutionFacts,
  ToolPermissionRule,
} from '@maka/core/permission';
import { classifyToolUse } from '@maka/core/permission';
import type { LlmConnection } from '@maka/core/llm-connections';
import type {
  UserQuestion,
  UserQuestionResponse,
  UserQuestionResult,
} from '@maka/core/user-question';
import { computerUseApprovalSummary } from '@maka/core';
import type { SessionHeader } from '@maka/core/session';
import type { ToolInvocationRecord } from '@maka/core/usage-stats/types';
import { redactSecrets } from '@maka/core/redaction';

import type { PermissionEngine } from './permission-engine.js';
import type { AsyncEventQueue } from './async-queue.js';
import {
  recordToolArtifactsSafely,
  type ToolArtifactRecorder,
} from './tool-artifacts.js';
import { createToolOutputDeltaEmitter } from './tool-output-delta.js';
import { truncateToolOutput } from './tool-output.js';
import { stableHash } from './request-shape.js';
import type { RunTraceLike } from './run-trace.js';
import { TurnScopedAwaitRegistry } from './turn-scoped-await-registry.js';
import {
  AdditionalPermissionError,
  revalidateAdditionalPermissionProposal,
  type AdditionalPermissionPlannerContext,
  type AdditionalPermissionPlanResult,
  type ToolExecutionPermissionContext,
} from './additional-permissions.js';
import {
  ApprovalCoordinator,
  type AutoApprovalReviewContext,
} from './approval-reviewer.js';
import {
  SandboxEscalationError,
  type SandboxEscalationPlanResult,
  type SandboxEscalationPlannerContext,
} from './sandbox-escalation.js';
import { ChildAgentRunLimiter } from './child-agent-run-limiter.js';

export type ToolModelOutputPart =
  | { type: 'text'; text: string }
  | { type: 'image-data'; data: string; mediaType: string };

export interface ToolModelOutput {
  type: 'content';
  value: ToolModelOutputPart[];
}

export interface MakaTool<P = any, R = unknown> {
  /** Canonical (Claude-SDK-style) name. Pi adapter translates to canonical. */
  name: string;
  /** Human-readable description shown to the model. */
  description: string;
  /** Zod schema describing the tool's argument shape. */
  parameters: unknown;
  /**
   * If `false`, the base mode policy is skipped unless invocation-local rules
   * are present. Explicit deny rules still apply to every tool.
   */
  permissionRequired?: boolean;
  /** Optional UI display name. */
  displayName?: string;
  /** Stable semantic category used by UI presentation; never carries styling. */
  activityKind?: ToolActivityKind;
  /** Optional trusted category override for custom tools. */
  categoryHint?: ToolCategory;
  /** Optional trusted facts about the executor that runs this tool. */
  executionFacts?: ToolExecutionFacts;
  /** Optional permission/persistence projection derived from isolated execution args. */
  permissionArgs?: (
    args: P,
    context: Pick<MakaToolContext, 'sessionId' | 'turnId' | 'toolCallId'>,
  ) => unknown;
  /** Optional trusted platform sandbox availability for this tool. */
  sandbox?: {
    platformSandboxAvailable: boolean;
  } | ((context: { permissionMode: PermissionMode; cwd: string; args: P }) => {
    platformSandboxAvailable: boolean;
  });
  /** Trusted runtime planner for one-call permission expansion. */
  planAdditionalPermissions?: (
    args: P,
    context: AdditionalPermissionPlannerContext,
  ) => Promise<AdditionalPermissionPlanResult> | AdditionalPermissionPlanResult;
  /** Trusted runtime planner for one-call unsandboxed Bash execution. */
  planSandboxEscalation?: (
    args: P,
    context: SandboxEscalationPlannerContext,
  ) => Promise<SandboxEscalationPlanResult> | SandboxEscalationPlanResult;
  /** Real tool implementation. Called only after permission allows. */
  impl: (args: P, ctx: MakaToolContext) => Promise<R> | R;
  /** Optional provider-visible content mapping, used for screenshot image parts. */
  toModelOutput?: (options: {
    toolCallId: string;
    input: unknown;
    output: unknown;
  }) => ToolModelOutput | Promise<ToolModelOutput>;
}

export interface MakaToolContext {
  sessionId: string;
  runId?: string;
  turnId: string;
  /** Session working directory. */
  cwd: string;
  permissionMode?: PermissionMode;
  toolCallId: string;
  abortSignal: AbortSignal;
  emitOutput: (stream: ToolOutputStream, chunk: string) => void;
  /** Trusted expert-team identity supplied by RuntimeKernel/backend wiring. */
  agentTeam?: AgentTeamExecutionContext;
  /** One-call grants already approved and consumed by ToolRuntime. */
  permissionContext?: ToolExecutionPermissionContext;
  spawnChildAgent?: (input: {
    spec: AgentSpec;
    prompt: string;
    onReady?: (input: { turnId: string; agentId: string; agentName: string }) => void | Promise<void>;
    onEvent?: (event: SessionEvent) => void;
  }) => Promise<unknown>;
  listChildAgents?: () => Promise<unknown>;
  readChildAgentOutput?: (input: { runId?: string; turnId?: string; maxEvents?: number }) => Promise<unknown>;
  askUserQuestion?: (questions: UserQuestion[]) => Promise<UserQuestionResult>;
}

export interface AgentTeamExecutionContext {
  role: 'lead' | 'member';
  teamId: string;
  agentId: string;
  /** Lead AgentRun that owns this team execution. Required for members. */
  parentRunId?: string;
}

export type AppendMessageFn = (m: ToolCallMessage | ToolResultMessage | PermissionDecisionMessage) => Promise<void>;
export type ToolTelemetryRecorder = (record: ToolInvocationRecord) => void;

/**
 * Per-step tool-availability gating for the execute boundary. `ToolAvailabilityRuntime`
 * installs it each turn: `gatedNames` is the static set of tools that may be
 * hidden this turn (group members when economy is on); `activeNames` returns the
 * model-visible set for the step currently executing, recomputed before each
 * step. The guard rejects a *gated* tool that is not yet active — core tools and
 * the repair fallback are never in `gatedNames`, so they are never gated.
 */
export interface ToolGating {
  gatedNames: ReadonlySet<string>;
  activeNames: () => ReadonlySet<string>;
}

export const TOOL_ERROR_RESULT_MAX_CHARS = 4000;
export const MAX_ACTIVE_SUBAGENT_TOOLS_PER_TURN = 5;
export const MAX_ACTIVE_CHILD_AGENT_RUNS_PER_TURN = 5;
export const DEFAULT_PERMISSION_TIMEOUT_MS = 300_000;

/**
 * Loop-gate: block a tool call once this many byte-identical calls (same tool +
 * same args) have FAILED back-to-back with nothing different in between. Mirrors
 * opencode's doom-loop threshold (#92: "same tool+args failing N times"). A
 * success, or any different tool/args, resets the streak — so legitimate polling
 * (re-run the same status check until it passes) and iterate-then-retry (edit a
 * file, re-run the same failing test) are never gated; only a no-progress loop of
 * identical *failures* is.
 */
export const LOOP_GATE_IDENTICAL_THRESHOLD = 3;

const SUBAGENT_TOOL_LIMIT_MESSAGE = '只读探索并发过多：同一轮最多 5 个子代理。请等待已有探索完成后再继续。';

export interface ToolRuntimeInput {
  sessionId: string;
  header: SessionHeader;
  connection: LlmConnection;
  modelId: string;
  appendMessage: AppendMessageFn;
  permissionEngine: PermissionEngine;
  newId: () => string;
  now: () => number;
  getPermissionPauseTarget: () => { pause(): void; resume(): void } | null;
  getCurrentRunId?: () => string | undefined;
  agentTeam?: AgentTeamExecutionContext;
  /**
   * Id of the assistant step currently streaming, stamped onto each tool call's
   * `tool_start` event so model replay can group a step's reasoning + tool calls
   * into one provider assistant message. Undefined leaves the step unpaired
   * (legacy per-turn behavior).
   */
  getCurrentStepId?: () => string | undefined;
  spawnChildAgent?: (input: {
    parentRunId: string;
    spec: AgentSpec;
    prompt: string;
    abortSignal: AbortSignal;
    onReady?: (input: { turnId: string; agentId: string; agentName: string }) => void | Promise<void>;
    onEvent?: (event: SessionEvent) => void;
  }) => Promise<unknown>;
  listChildAgents?: () => Promise<unknown>;
  readChildAgentOutput?: (input: { runId?: string; turnId?: string; maxEvents?: number }) => Promise<unknown>;
  getRunTrace?: () => RunTraceLike | null;
  permissionTimeoutMs?: number;
  permissionRules?: readonly ToolPermissionRule[];
  recordToolInvocation?: ToolTelemetryRecorder;
  recordToolArtifacts?: ToolArtifactRecorder;
  approvalCoordinator?: ApprovalCoordinator;
  getAutoApprovalReviewContext?: () => Omit<
    AutoApprovalReviewContext,
    'sessionId' | 'turnId' | 'cwd' | 'permissionMode'
  >;
}

export class ToolRuntime {
  private readonly userQuestions = new TurnScopedAwaitRegistry<
    UserQuestionResponse,
    { toolUseId: string; questions: UserQuestion[] }
  >();
  private activeSubagentToolCount = 0;
  private childAgentRunLimiter = new ChildAgentRunLimiter(MAX_ACTIVE_CHILD_AGENT_RUNS_PER_TURN);
  /**
   * Tool-availability gating for the execute boundary. Set by the backend each
   * turn from `ToolAvailabilityRuntime`. Undefined when gating is off (economy
   * off / no hidden groups) — the guard is then fully inert.
   */
  private gating?: ToolGating;
  /**
   * Loop-gate state: the signature (tool + canonical args) of the last *failed*
   * call and how many byte-identical calls have failed back-to-back, including
   * the most recent. A success or a different call clears it (see
   * {@link recordLoopGateOutcome}). Only a consecutive count is needed, so two
   * fields suffice. Reset each turn.
   */
  private lastFailedToolCallSignature: string | undefined;
  private failedToolCallStreak = 0;
  private lastAmbiguousComputerSignature: string | undefined;
  private readonly recentSandboxDenials = new Set<string>();
  private readonly autoReviewEscalationAttempts = new Map<string, 'pending' | 'denied'>();
  private readonly approvalCoordinator: ApprovalCoordinator;

  constructor(private readonly input: ToolRuntimeInput) {
    this.approvalCoordinator = input.approvalCoordinator ?? new ApprovalCoordinator({});
  }

  beginTurn(turnId: string): void {
    this.resetTurnState();
    this.userQuestions.beginTurn(turnId);
  }

  endTurn(turnId: string, reason: 'completed' | 'aborted' = 'completed'): void {
    this.userQuestions.endTurn(
      turnId,
      (requestId) => new Error(`Turn ${turnId} ${reason} before user question ${requestId} was answered`),
    );
    this.resetTurnState();
  }

  respondToUserQuestion(turnId: string, response: UserQuestionResponse): boolean {
    if (!response || typeof response.requestId !== 'string' || !Array.isArray(response.answers)) {
      throw new Error('Invalid user question response');
    }
    const pending = this.userQuestions.entries(turnId)
      .find(([requestId]) => requestId === response.requestId)?.[1];
    if (!pending) return false;
    if (
      response.answers.length !== pending.questions.length
      || response.answers.some((answer) => answer !== null && (typeof answer !== 'string' || answer.length === 0))
    ) {
      throw new Error('Invalid user question response');
    }
    return this.userQuestions.resolve(turnId, response.requestId, response) !== null;
  }

  pendingUserQuestionCount(turnId: string): number {
    return this.userQuestions.pendingCount(turnId);
  }

  wrapToolExecute(
    tool: MakaTool,
    turnId: string,
    queue: AsyncEventQueue<SessionEvent> | { push(event: SessionEvent): void },
  ) {
    return async (
      args: unknown,
      ctx: { toolCallId: string; abortSignal: AbortSignal },
    ): Promise<unknown> => this.executeTool(tool, turnId, queue, args, ctx);
  }

  /**
   * Install the per-step tool-availability gating used at the execute boundary.
   * The backend recomputes the active snapshot before each step; the guard in
   * `executeTool` rejects a gated tool whose name is not in it. Pass `undefined`
   * to disable gating.
   */
  setGating(gating: ToolGating | undefined): void {
    this.gating = gating;
  }

  resetTurnState(): void {
    const priorChildAgentRunLimiter = this.childAgentRunLimiter;
    this.childAgentRunLimiter = new ChildAgentRunLimiter(MAX_ACTIVE_CHILD_AGENT_RUNS_PER_TURN);
    priorChildAgentRunLimiter.close(
      new Error('Child agent run permit scope ended before capacity became available'),
    );
    this.activeSubagentToolCount = 0;
    this.gating = undefined;
    this.lastFailedToolCallSignature = undefined;
    this.failedToolCallStreak = 0;
    this.lastAmbiguousComputerSignature = undefined;
    this.recentSandboxDenials.clear();
    this.autoReviewEscalationAttempts.clear();
  }

  /**
   * Record the terminal outcome of one tool call for the loop-gate. A success (or
   * any call with a different signature) resets the streak; a failure with the
   * same signature as the last failure extends it. Called once per call at every
   * exit — the pre-impl guards call it explicitly before their early returns, and
   * the impl section calls it from its `finally`. The pre-block itself is the one
   * exception: a blocked call records nothing, so the streak stays parked at the
   * threshold and every further identical repeat keeps being blocked.
   */
  private recordLoopGateOutcome(signature: string, failed: boolean): void {
    if (!failed) {
      this.lastFailedToolCallSignature = undefined;
      this.failedToolCallStreak = 0;
      return;
    }
    if (signature === this.lastFailedToolCallSignature) {
      this.failedToolCallStreak += 1;
    } else {
      this.lastFailedToolCallSignature = signature;
      this.failedToolCallStreak = 1;
    }
  }

  async writeSyntheticToolResult(
    toolUseId: string,
    turnId: string,
    text: string,
    queue: AsyncEventQueue<SessionEvent> | { push(event: SessionEvent): void },
  ): Promise<void> {
    const content: ToolResultContent = { kind: 'text', text: formatSyntheticToolErrorText(text) };
    const msg: ToolResultMessage = {
      type: 'tool_result',
      id: this.input.newId(),
      turnId,
      ts: this.input.now(),
      toolUseId,
      isError: true,
      content,
    };
    await this.input.appendMessage(msg);
    queue.push({
      type: 'tool_result',
      id: this.input.newId(),
      turnId,
      ts: this.input.now(),
      toolUseId,
      isError: true,
      content,
    } satisfies ToolResultEvent);
  }

  private async executeTool(
    tool: MakaTool,
    turnId: string,
    queue: AsyncEventQueue<SessionEvent> | { push(event: SessionEvent): void },
    args: unknown,
    ctx: { toolCallId: string; abortSignal: AbortSignal },
  ): Promise<unknown> {
    const executionArgs = snapshotToolArgs(args);
    const toolUseId = ctx.toolCallId;
    let permissionArgs = executionArgs;
    let permissionArgsError: unknown;
    try {
      permissionArgs = tool.permissionArgs
        ? snapshotToolArgs(tool.permissionArgs(structuredClone(executionArgs) as never, {
            sessionId: this.input.sessionId,
            turnId,
            toolCallId: toolUseId,
          }))
        : executionArgs;
    } catch (error) {
      permissionArgsError = error;
    }
    const persistedArgs = tool.categoryHint === 'computer_use'
      ? snapshotToolArgs(computerUseApprovalSummary(permissionArgs))
      : permissionArgs;
    const now = this.input.now();
    const toolIntent = describeToolIntent(tool, persistedArgs);
    const trace = this.input.getRunTrace?.() ?? null;

    const stepId = this.input.getCurrentStepId?.();
    const callMsg: ToolCallMessage = {
      type: 'tool_call',
      id: toolUseId,
      turnId,
      ts: now,
      toolName: tool.name,
      ...(tool.activityKind ? { activityKind: tool.activityKind } : {}),
      ...(tool.displayName ? { displayName: tool.displayName } : {}),
      ...(toolIntent ? { intent: toolIntent } : {}),
      args: structuredClone(persistedArgs),
      // Persist the same step id the tool_start event carries so the UI
      // timeline and post-restart backfill can pair this call with its step.
      ...(stepId !== undefined ? { stepId } : {}),
    };
    await this.input.appendMessage(callMsg);
    const startEv: ToolStartEvent = {
      type: 'tool_start',
      id: this.input.newId(),
      turnId,
      ts: now,
      toolUseId,
      toolName: tool.name,
      ...(tool.activityKind ? { activityKind: tool.activityKind } : {}),
      args: structuredClone(persistedArgs),
      ...(tool.displayName ? { displayName: tool.displayName } : {}),
      ...(toolIntent ? { intent: toolIntent } : {}),
      ...(stepId !== undefined ? { stepId } : {}),
    };
    queue.push(startEv);
    trace?.emit('tool', 'tool_started', 'Tool execution started', {
      toolUseId,
      toolName: tool.name,
      permissionRequired: tool.permissionRequired !== false,
      ...(tool.categoryHint !== undefined ? { categoryHint: tool.categoryHint } : {}),
    });
    const callSignature = `${tool.name} ${loopGateArgsKey(executionArgs, toolUseId)}`;
    const computerSemanticSignature = tool.categoryHint === 'computer_use'
      ? computerUseSemanticSignature(permissionArgs)
      : undefined;
    if (permissionArgsError !== undefined) {
      const msg = tool.categoryHint === 'computer_use'
        ? 'Computer Use arguments failed validation'
        : formatSyntheticToolErrorText(permissionArgsError);
      await this.writeSyntheticToolResult(toolUseId, turnId, msg, queue);
      this.input.recordToolInvocation?.({
        sessionId: this.input.sessionId,
        turnId,
        toolCallId: toolUseId,
        toolName: tool.name,
        providerId: this.input.connection.providerType,
        modelId: this.input.modelId,
        durationMs: 0,
        status: 'error',
        errorClass: 'InvalidArguments',
        argsSummary: tool.categoryHint === 'computer_use'
          ? summarizePersistedArgs(persistedArgs)
          : summarizeArgs(tool.name, executionArgs),
        bytesIn: byteLength(persistedArgs),
        bytesOut: byteLength(msg),
        startedAt: now,
      });
      trace?.emit('tool', 'tool_failed', 'Tool arguments failed validation', {
        toolUseId,
        toolName: tool.name,
        status: 'error',
        errorClass: 'InvalidArguments',
      });
      this.recordLoopGateOutcome(callSignature, true);
      return this.errorReturn(msg);
    }

    // Loop-gate (#92): block this call up front — before the guards and the real
    // impl — if this exact call (tool + canonical args) has already FAILED
    // back-to-back the last (THRESHOLD-1) times. Re-running an identical failing
    // call cannot change the outcome; it only drains the turn. Checked first so a
    // tool that keeps failing the availability guard (not loaded) or permission
    // also trips it — those rejections count as failures (see
    // recordLoopGateOutcome). A success or any different call resets the streak,
    // so polling and iterate-then-retry are never gated. Recoverable: the model
    // is told to change its approach. The block itself records no outcome, so the
    // streak stays parked and every further identical repeat stays blocked.
    if (
      computerSemanticSignature
      && computerSemanticSignature === this.lastAmbiguousComputerSignature
    ) {
      const reason = formatAmbiguousComputerLoopGateText();
      await this.writeSyntheticToolResult(toolUseId, turnId, reason, queue);
      trace?.emit('tool', 'tool_failed', 'Blocked repeated ambiguous Computer Use target', {
        toolUseId,
        toolName: tool.name,
        status: 'error',
        errorClass: 'AmbiguousComputerTarget',
      });
      return this.errorReturn(reason);
    }
    if (
      this.lastAmbiguousComputerSignature
      && computerSemanticSignature
      && computerSemanticSignature !== this.lastAmbiguousComputerSignature
    ) {
      this.lastAmbiguousComputerSignature = undefined;
    }
    if (
      callSignature === this.lastFailedToolCallSignature
      && this.failedToolCallStreak >= LOOP_GATE_IDENTICAL_THRESHOLD - 1
    ) {
      const reason = formatLoopGateText(tool.name);
      await this.writeSyntheticToolResult(toolUseId, turnId, reason, queue);
      trace?.emit('tool', 'tool_failed', 'Loop-gate blocked a repeated identical failing call', {
        toolUseId,
        toolName: tool.name,
        status: 'error',
        errorClass: 'LoopGate',
      });
      return this.errorReturn(reason);
    }

    // Tool-availability execute-boundary guard (Codex Δ5). Uses the step-start
    // snapshot, NOT a cumulative loaded-set: if one step emits `load_tools(g)`
    // and a tool from group `g` in parallel, that tool is not yet active (it
    // activates only at the next step's `prepareStep`), so it is rejected here —
    // before permission eval and before the real impl. This also closes the AI
    // SDK `activeTools` leak (vercel/ai#8653). The rejection is recoverable: the
    // model loads via `load_tools`, then retries next step.
    if (this.gating && this.gating.gatedNames.has(tool.name) && !this.gating.activeNames().has(tool.name)) {
      const reason = formatDeferredNotLoadedText(tool.name);
      await this.writeSyntheticToolResult(toolUseId, turnId, reason, queue);
      trace?.emit('tool', 'tool_failed', 'Deferred tool used before load', {
        toolUseId,
        toolName: tool.name,
        status: 'error',
        errorClass: 'DeferredNotLoaded',
      });
      this.recordLoopGateOutcome(callSignature, true);
      return this.errorReturn(reason);
    }

    let additionalPlan: AdditionalPermissionPlanResult = { kind: 'not_required' };
    if (tool.planAdditionalPermissions) {
      try {
        const plannerContext: AdditionalPermissionPlannerContext = Object.freeze({
          sessionId: this.input.sessionId,
          turnId,
          toolUseId,
          toolName: tool.name,
          category: classifyToolUse({
            toolName: tool.name,
            args: executionArgs,
            ...(tool.categoryHint !== undefined ? { categoryHint: tool.categoryHint } : {}),
          }),
          cwd: this.input.header.cwd,
          mode: this.input.header.permissionMode,
          args: executionArgs,
        });
        const planned = await tool.planAdditionalPermissions(
          executionArgs as never,
          plannerContext,
        );
        if (!isAdditionalPermissionPlanResult(planned)) {
          throw new AdditionalPermissionError({
            stage: 'planning',
            reason: 'invalid_additional_permissions',
            message: 'Additional permission planner returned an invalid result.',
          });
        }
        additionalPlan = planned;
      } catch (error) {
        additionalPlan = {
          kind: 'block',
          reason: 'invalid_additional_permissions',
          message: formatSyntheticToolErrorText(error),
        };
      }
      if (additionalPlan.kind === 'block') {
        const reason = formatSyntheticToolErrorText(additionalPlan.message);
        trace?.emit('permission', 'permission_failed', 'Additional permission planning failed', {
          toolUseId,
          toolName: tool.name,
          requestKind: 'additional_permissions',
          reason: additionalPlan.reason,
        });
        await this.writeSyntheticToolResult(toolUseId, turnId, reason, queue);
        this.recordLoopGateOutcome(callSignature, true);
        return this.errorReturn(reason);
      }
    }

    let escalationPlan: SandboxEscalationPlanResult = { kind: 'not_required' };
    if (tool.planSandboxEscalation) {
      try {
        const plannerContext: SandboxEscalationPlannerContext = Object.freeze({
          sessionId: this.input.sessionId,
          turnId,
          toolUseId,
          toolName: tool.name,
          category: classifyToolUse({
            toolName: tool.name,
            args: executionArgs,
            ...(tool.categoryHint !== undefined ? { categoryHint: tool.categoryHint } : {}),
          }),
          cwd: this.input.header.cwd,
          mode: this.input.header.permissionMode,
          args: executionArgs,
          ...(this.recentSandboxDenials.has(
            sandboxDenialKey(tool.name, this.input.header.cwd, executionArgs),
          ) ? { recentSandboxDenial: true } : {}),
        });
        const planned = await tool.planSandboxEscalation(
          executionArgs as never,
          plannerContext,
        );
        if (!isSandboxEscalationPlanResult(planned)) {
          throw new SandboxEscalationError({
            stage: 'planning',
            reason: 'invalid_sandbox_escalation',
            message: 'Sandbox escalation planner returned an invalid result.',
          });
        }
        escalationPlan = planned;
      } catch (error) {
        escalationPlan = {
          kind: 'block',
          reason: 'invalid_sandbox_escalation',
          message: formatSyntheticToolErrorText(error),
        };
      }
      if (escalationPlan.kind === 'block') {
        const reason = formatSyntheticToolErrorText(escalationPlan.message);
        trace?.emit('permission', 'sandbox_escalation_failed', 'Sandbox escalation planning failed', {
          toolUseId,
          toolName: tool.name,
          reason: escalationPlan.reason,
        });
        await this.writeSyntheticToolResult(toolUseId, turnId, reason, queue);
        this.recordLoopGateOutcome(callSignature, true);
        return this.errorReturn(reason);
      }
    }

    if (additionalPlan.kind === 'request' && escalationPlan.kind === 'request') {
      const reason = 'A tool call cannot request additional permissions and unsandboxed execution together.';
      await this.writeSyntheticToolResult(toolUseId, turnId, reason, queue);
      this.recordLoopGateOutcome(callSignature, true);
      return this.errorReturn(reason);
    }

    let autoReviewEscalationKey: string | undefined;
    if (this.input.header.permissionMode === 'execute' && escalationPlan.kind === 'request') {
      autoReviewEscalationKey = `${turnId}\u0000${escalationPlan.proposal.commandHash}`;
      const priorAttempt = this.autoReviewEscalationAttempts.get(autoReviewEscalationKey);
      if (priorAttempt) {
        const reason = priorAttempt === 'pending'
          ? '相同的 sandbox 提权请求正在自动审批；为防止重复送审，本轮不会再次执行。'
          : '相同的 sandbox 提权请求已在当前轮次中被自动审批拒绝；需要用户发送新的消息后才能重新申请。';
        trace?.emit('permission', 'sandbox_escalation_failed', 'Repeated automatic escalation review blocked', {
          toolUseId,
          toolName: tool.name,
          reason: 'sandbox_escalation_denied',
        });
        await this.writeSyntheticToolResult(toolUseId, turnId, reason, queue);
        this.recordLoopGateOutcome(callSignature, true);
        return this.errorReturn(reason);
      }
      this.autoReviewEscalationAttempts.set(autoReviewEscalationKey, 'pending');
    }

    if (
      tool.permissionRequired !== false
      || (this.input.permissionRules?.length ?? 0) > 0
      || additionalPlan.kind === 'request'
      || escalationPlan.kind === 'request'
    ) {
      const verdict = this.input.permissionEngine.evaluate({
        sessionId: this.input.sessionId,
        turnId,
        toolUseId,
        toolName: tool.name,
        args: structuredClone(
          additionalPlan.kind === 'request' ? executionArgs : permissionArgs,
        ),
        ...(tool.categoryHint !== undefined ? { categoryHint: tool.categoryHint } : {}),
        ...(tool.executionFacts !== undefined ? { executionFacts: tool.executionFacts } : {}),
        permissionRequired: tool.permissionRequired !== false,
        ...(this.input.permissionRules !== undefined ? { permissionRules: this.input.permissionRules } : {}),
        ...(tool.sandbox !== undefined ? {
          sandbox: typeof tool.sandbox === 'function'
            ? tool.sandbox({
              permissionMode: this.input.header.permissionMode,
              cwd: this.input.header.cwd,
              args: structuredClone(executionArgs),
            })
            : tool.sandbox,
        } : {}),
        mode: this.input.header.permissionMode,
        cwd: escalationPlan.kind === 'request'
          ? escalationPlan.proposal.cwd
          : this.input.header.cwd,
        ...(additionalPlan.kind === 'request'
          ? { additionalPermissionProposal: additionalPlan.proposal }
          : {}),
        ...(escalationPlan.kind === 'request'
          ? { sandboxEscalationProposal: escalationPlan.proposal }
          : {}),
      });

      if (verdict.kind === 'block') {
        if (autoReviewEscalationKey) {
          this.autoReviewEscalationAttempts.set(autoReviewEscalationKey, 'denied');
        }
        if (verdict.decisionEvent) {
          await this.input.appendMessage({
            type: 'permission_decision',
            id: verdict.decisionEvent.requestId,
            turnId,
            ts: verdict.decisionEvent.ts,
            toolUseId,
            toolName: tool.name,
            decision: 'deny',
          });
          queue.push(verdict.decisionEvent);
        }
        trace?.emit('permission', 'permission_failed', 'Permission blocked tool execution', {
          toolUseId,
          toolName: tool.name,
          verdict: verdict.kind,
          reason: verdict.reason,
        });
        await this.writeSyntheticToolResult(toolUseId, turnId, verdict.reason, queue);
        trace?.emit('tool', 'tool_failed', 'Tool execution failed before implementation', {
          toolUseId,
          toolName: tool.name,
          status: 'error',
          errorClass: 'Permission',
        });
        this.recordLoopGateOutcome(callSignature, true);
        return this.errorReturn(verdict.reason);
      }

      if (verdict.kind === 'prompt') {
        const reviewContext: AutoApprovalReviewContext = {
          sessionId: this.input.sessionId,
          turnId,
          cwd: escalationPlan.kind === 'request'
            ? escalationPlan.proposal.cwd
            : this.input.header.cwd,
          permissionMode: this.input.header.permissionMode,
          ...this.input.getAutoApprovalReviewContext?.(),
        };
        const isEscalation = verdict.event.kind === 'sandbox_escalation';
        trace?.emit('permission', 'approval_routed', 'Permission request routed to reviewer', {
          requestId: verdict.event.requestId,
          toolUseId,
          toolName: tool.name,
          reviewer: this.input.header.permissionMode === 'execute' ? 'auto_review' : 'user',
          requestKind: verdict.event.kind,
        });
        trace?.emit('permission', isEscalation
          ? 'sandbox_escalation_requested'
          : 'permission_requested', 'Permission requested', {
          requestId: verdict.event.requestId,
          toolUseId,
          toolName: tool.name,
          category: verdict.event.category,
          requestKind: verdict.event.kind,
        });
        let response: PermissionDecision;
        try {
          response = await this.awaitPermissionDecision(
            verdict,
            turnId,
            () => this.approvalCoordinator.resolve({
              mode: this.input.header.permissionMode,
              verdict,
              permissionEngine: this.input.permissionEngine,
              context: reviewContext,
              emitUserRequest: (event) => queue.push(event),
              abortSignal: ctx.abortSignal,
            }),
          );
        } catch (err) {
          if (autoReviewEscalationKey) {
            this.autoReviewEscalationAttempts.set(autoReviewEscalationKey, 'denied');
          }
          const msg = formatSyntheticToolErrorText(err);
          const reason = formatSyntheticToolErrorText(`Permission flow aborted: ${msg}`);
          trace?.emit('permission', 'permission_failed', 'Permission flow failed', {
            requestId: verdict.event.requestId,
            toolUseId,
            toolName: tool.name,
            requestKind: verdict.event.kind ?? 'tool_permission',
            reason: err instanceof AdditionalPermissionError
              ? err.reason
              : err instanceof SandboxEscalationError
                ? err.reason
                : reason,
          });
          if (isEscalation) {
            trace?.emit('permission', 'sandbox_escalation_failed', 'Sandbox escalation flow failed', {
              requestId: verdict.event.requestId,
              toolUseId,
              toolName: tool.name,
              reason,
            });
          }
          await this.writeSyntheticToolResult(toolUseId, turnId, reason, queue);
          trace?.emit('tool', 'tool_failed', 'Tool execution failed before implementation', {
            toolUseId,
            toolName: tool.name,
            status: 'error',
            errorClass: 'Permission',
          });
          this.recordLoopGateOutcome(callSignature, true);
          return this.errorReturn(reason);
        }

        const decisionMsg: PermissionDecisionMessage = {
          type: 'permission_decision',
          id: response.requestId,
          turnId,
          ts: this.input.now(),
          toolUseId,
          toolName: tool.name,
          decision: response.decision,
          ...(response.rememberForTurn !== undefined ? { rememberForTurn: response.rememberForTurn } : {}),
          ...(response.reviewer !== undefined ? { reviewer: response.reviewer } : {}),
          ...(response.rationale !== undefined ? { rationale: response.rationale } : {}),
          ...(response.riskLevel !== undefined ? { riskLevel: response.riskLevel } : {}),
        };
        await this.input.appendMessage(decisionMsg);
        queue.push({
          type: 'permission_decision_ack',
          id: this.input.newId(),
          turnId,
          ts: this.input.now(),
          requestId: response.requestId,
          toolUseId,
          decision: response.decision,
          ...(response.rememberForTurn !== undefined ? { rememberForTurn: response.rememberForTurn } : {}),
          ...(response.reviewer !== undefined ? { reviewer: response.reviewer } : {}),
          ...(response.rationale !== undefined ? { rationale: response.rationale } : {}),
          ...(response.riskLevel !== undefined ? { riskLevel: response.riskLevel } : {}),
        });
        trace?.emit('permission', 'permission_decided', 'Permission decision recorded', {
          requestId: response.requestId,
          toolUseId,
          toolName: tool.name,
          decision: response.decision,
          requestKind: verdict.event.kind ?? 'tool_permission',
          ...(response.rememberForTurn !== undefined ? { rememberForTurn: response.rememberForTurn } : {}),
          ...(response.reviewer !== undefined ? { reviewer: response.reviewer } : {}),
          ...(response.riskLevel !== undefined ? { riskLevel: response.riskLevel } : {}),
        });

        if (response.decision === 'deny') {
          if (autoReviewEscalationKey && response.reviewer === 'auto_review') {
            this.autoReviewEscalationAttempts.set(autoReviewEscalationKey, 'denied');
          }
          const reason = response.reviewer === 'auto_review'
            ? `自动审批已拒绝权限请求${response.rationale ? `：${response.rationale}` : ''}`
            : '用户已拒绝权限请求';
          if (isEscalation) {
            trace?.emit('permission', 'sandbox_escalation_denied', 'Sandbox escalation denied', {
              requestId: response.requestId,
              toolUseId,
              toolName: tool.name,
              reviewer: response.reviewer ?? 'user',
            });
          }
          await this.writeSyntheticToolResult(toolUseId, turnId, reason, queue);
          trace?.emit('tool', 'tool_failed', 'Tool execution failed before implementation', {
            toolUseId,
            toolName: tool.name,
            status: 'error',
            errorClass: 'Permission',
          });
          this.recordLoopGateOutcome(callSignature, true);
          return this.errorReturn(reason);
        }
        if (autoReviewEscalationKey) {
          this.autoReviewEscalationAttempts.delete(autoReviewEscalationKey);
        }
        if (isEscalation) {
          trace?.emit('permission', 'sandbox_escalation_granted', 'Sandbox escalation granted', {
            requestId: response.requestId,
            toolUseId,
            toolName: tool.name,
            reviewer: response.reviewer ?? 'user',
            commandHash: verdict.event.kind === 'sandbox_escalation'
              ? verdict.event.commandHash
              : undefined,
          });
        }
      } else {
        if (autoReviewEscalationKey) {
          this.autoReviewEscalationAttempts.delete(autoReviewEscalationKey);
        }
        trace?.emit('permission', 'permission_decided', 'Permission allowed tool execution', {
          toolUseId,
          toolName: tool.name,
          decision: 'allow',
          category: verdict.category,
        });
      }
    }

    const reservedSubagentSlot = this.reserveSubagentSlot(tool);
    if (!reservedSubagentSlot) {
      trace?.emit('tool', 'tool_failed', 'Tool execution rejected by runtime limit', {
        toolUseId,
        toolName: tool.name,
        errorClass: 'RuntimeLimit',
      });
      await this.writeSyntheticToolResult(toolUseId, turnId, SUBAGENT_TOOL_LIMIT_MESSAGE, queue);
      this.recordLoopGateOutcome(callSignature, true);
      return this.errorReturn(SUBAGENT_TOOL_LIMIT_MESSAGE);
    }

    let permissionContext: ToolExecutionPermissionContext | undefined;
    if (additionalPlan.kind === 'request') {
      try {
        await revalidateAdditionalPermissionProposal({
          proposal: additionalPlan.proposal,
          cwd: this.input.header.cwd,
        });
        const additionalGrant = this.input.permissionEngine.consumeAdditionalPermissionGrant({
          sessionId: this.input.sessionId,
          turnId,
          toolUseId,
          toolName: tool.name,
          intentHash: additionalPlan.proposal.intentHash,
        });
        if (!additionalGrant) {
          throw new AdditionalPermissionError({
            stage: 'consume',
            reason: 'grant_unavailable',
            message: 'Approved additional permission grant was unavailable.',
          });
        }
        permissionContext = Object.freeze({ additionalGrant });
      } catch (error) {
        const reason = formatSyntheticToolErrorText(error);
        trace?.emit('permission', 'permission_failed', 'Additional permission could not be applied', {
          toolUseId,
          toolName: tool.name,
          requestKind: 'additional_permissions',
          reason: error instanceof AdditionalPermissionError
            ? error.reason
            : 'invalid_additional_permissions',
        });
        await this.writeSyntheticToolResult(toolUseId, turnId, reason, queue);
        this.recordLoopGateOutcome(callSignature, true);
        this.releaseSubagentSlot(tool);
        return this.errorReturn(reason);
      }
    }
    if (escalationPlan.kind === 'request') {
      try {
        const sandboxEscalationGrant = this.input.permissionEngine.consumeSandboxEscalationGrant({
          sessionId: this.input.sessionId,
          turnId,
          toolUseId,
          toolName: tool.name,
          intentHash: escalationPlan.proposal.intentHash,
          command: escalationPlan.proposal.command,
          cwd: escalationPlan.proposal.cwd,
        });
        if (!sandboxEscalationGrant) {
          throw new SandboxEscalationError({
            stage: 'consume',
            reason: 'sandbox_escalation_intent_mismatch',
            message: 'Approved sandbox escalation grant was unavailable.',
          });
        }
        permissionContext = Object.freeze({
          ...(permissionContext ?? {}),
          sandboxEscalationGrant,
        });
        trace?.emit('permission', 'sandbox_escalation_applied', 'Sandbox escalation applied', {
          toolUseId,
          toolName: tool.name,
          commandHash: sandboxEscalationGrant.commandHash,
        });
      } catch (error) {
        const reason = formatSyntheticToolErrorText(error);
        trace?.emit('permission', 'sandbox_escalation_failed', 'Sandbox escalation could not be applied', {
          toolUseId,
          toolName: tool.name,
          reason: error instanceof SandboxEscalationError
            ? error.reason
            : 'sandbox_escalation_failed',
        });
        await this.writeSyntheticToolResult(toolUseId, turnId, reason, queue);
        this.recordLoopGateOutcome(callSignature, true);
        this.releaseSubagentSlot(tool);
        return this.errorReturn(reason);
      }
    }
    const startedAt = this.input.now();
    const output = createToolOutputDeltaEmitter({
      sessionId: this.input.sessionId,
      turnId,
      toolUseId,
      newId: this.input.newId,
      now: this.input.now,
      push: (event) => queue.push(event),
    });
    // Loop-gate outcome for the real impl. Default failed; the success path below
    // overwrites it from the derived result status, and the finally records it
    // once for every exit (return or throw). The pre-impl guards record their own
    // failures above, since they early-return before this point.
    let attemptFailed = true;
    try {
      // Pause the stream idle watchdog for the whole tool execution. In the
      // ai-sdk step loop a tool runs *between* model requests — the tool-call
      // step's stream already finished and the next request has not started —
      // so provider silence here is expected, not a stalled model stream. A
      // long-running tool (apt-get install, a build, an ML training step, a
      // subagent loop) must not trip the idle timeout and abort the whole
      // invocation; the tool carries its own timeout (e.g. Bash timeout_ms)
      // and the trial/run layer is the outer backstop.
      const pauseTarget = this.input.getPermissionPauseTarget();
      pauseTarget?.pause();
      try {
        const runId = this.input.getCurrentRunId?.();
        const result = await tool.impl(structuredClone(executionArgs) as never, {
          sessionId: this.input.sessionId,
          turnId,
          ...(runId ? { runId } : {}),
          cwd: this.input.header.cwd,
          permissionMode: this.input.header.permissionMode,
          toolCallId: toolUseId,
          abortSignal: ctx.abortSignal,
          emitOutput: output.emit,
          ...(this.input.agentTeam ? { agentTeam: this.input.agentTeam } : {}),
          ...(permissionContext ? { permissionContext } : {}),
          ...(this.input.listChildAgents ? { listChildAgents: this.input.listChildAgents } : {}),
          ...(this.input.readChildAgentOutput ? { readChildAgentOutput: this.input.readChildAgentOutput } : {}),
          ...(this.buildSpawnChildAgentContext(ctx.abortSignal)),
          askUserQuestion: (questions) => this.askUserQuestion(turnId, toolUseId, questions, queue),
        });
        output.flush();
        const durationMs = this.input.now() - startedAt;

        const content = coerceResultContent(result);
        const toolResultStatus = deriveToolResultStatus(content, result);
        if (hasSandboxDenial(content)) {
          const denialKey = sandboxDenialKey(tool.name, this.input.header.cwd, executionArgs);
          this.recentSandboxDenials.add(denialKey);
          this.recentSandboxDenials.add(sandboxDenialKey('Bash', this.input.header.cwd, {
            command: content.cmd,
          }));
          trace?.emit('sandbox', 'sandbox_denial_detected', 'Command likely failed because of sandbox enforcement', {
            toolUseId,
            toolName: tool.name,
            commandHash: denialKey,
          });
        }
        const resultMsg: ToolResultMessage = {
          type: 'tool_result',
          id: this.input.newId(),
          turnId,
          ts: this.input.now(),
          toolUseId,
          isError: toolResultStatus !== 'success',
          content,
          durationMs,
        };
        await this.input.appendMessage(resultMsg);
        queue.push({
          type: 'tool_result',
          id: this.input.newId(),
          turnId,
          ts: this.input.now(),
          toolUseId,
          isError: toolResultStatus !== 'success',
          content,
          durationMs,
        } satisfies ToolResultEvent);

        this.input.recordToolInvocation?.({
          sessionId: this.input.sessionId,
          turnId,
          toolCallId: toolUseId,
          toolName: tool.name,
          providerId: this.input.connection.providerType,
          modelId: this.input.modelId,
          durationMs,
          status: toolResultStatus,
          argsSummary: tool.categoryHint === 'computer_use'
            ? summarizePersistedArgs(persistedArgs)
            : summarizeArgs(tool.name, executionArgs),
          bytesIn: byteLength(persistedArgs),
          bytesOut: byteLength(result),
          startedAt,
        });
        trace?.emit('tool', 'tool_completed', 'Tool execution completed', {
          toolUseId,
          toolName: tool.name,
          durationMs,
          status: toolResultStatus,
        });

        void recordToolArtifactsSafely(
          {
            sessionId: this.input.sessionId,
            turnId,
            toolUseId,
            toolName: tool.name,
            cwd: this.input.header.cwd,
            args: structuredClone(persistedArgs),
            result,
          },
          this.input.recordToolArtifacts,
          (message) => {
            queue.push({
              type: 'tool_progress',
              id: this.input.newId(),
              turnId,
              ts: this.input.now(),
              toolUseId,
              chunk: message,
            });
          },
        );

        attemptFailed = toolResultStatus !== 'success';
        if (isAmbiguousComputerFailure(result)) {
          this.lastAmbiguousComputerSignature = computerSemanticSignature;
        } else if (computerSemanticSignature) {
          this.lastAmbiguousComputerSignature = undefined;
        }
        return result;
      } finally {
        pauseTarget?.resume();
      }
    } catch (err) {
      output.flush();
      const terminalFailure = coerceTerminalFailure(tool, this.input.header.cwd, executionArgs, err);
      if (terminalFailure) {
        if (terminalFailure.sandboxDenied) {
          const denialKey = sandboxDenialKey(tool.name, this.input.header.cwd, executionArgs);
          this.recentSandboxDenials.add(denialKey);
          trace?.emit('sandbox', 'sandbox_denial_detected', 'Command likely failed because of sandbox enforcement', {
            toolUseId,
            toolName: tool.name,
            commandHash: denialKey,
          });
        }
        const durationMs = Math.max(0, this.input.now() - startedAt);
        const resultMsg: ToolResultMessage = {
          type: 'tool_result',
          id: this.input.newId(),
          turnId,
          ts: this.input.now(),
          toolUseId,
          isError: true,
          content: terminalFailure.content,
          durationMs,
        };
        await this.input.appendMessage(resultMsg);
        queue.push({
          type: 'tool_result',
          id: this.input.newId(),
          turnId,
          ts: this.input.now(),
          toolUseId,
          isError: true,
          content: terminalFailure.content,
          durationMs,
        } satisfies ToolResultEvent);
        this.input.recordToolInvocation?.({
          sessionId: this.input.sessionId,
          turnId,
          toolCallId: toolUseId,
          toolName: tool.name,
          providerId: this.input.connection.providerType,
          modelId: this.input.modelId,
          durationMs,
          status: 'error',
          errorClass: classifyError(err),
          argsSummary: tool.categoryHint === 'computer_use'
            ? summarizePersistedArgs(persistedArgs)
            : summarizeArgs(tool.name, executionArgs),
          bytesIn: byteLength(persistedArgs),
          bytesOut: byteLength(terminalFailure.content),
          startedAt,
        });
        trace?.emit('tool', 'tool_failed', 'Tool execution failed', {
          toolUseId,
          toolName: tool.name,
          durationMs,
          status: 'error',
          errorClass: classifyError(err),
        });
        return this.errorReturn(terminalFailure.message);
      }
      const msg = tool.categoryHint === 'computer_use'
        ? `Computer Use failed: ${classifyError(err)}`
        : formatSyntheticToolErrorText(err);
      await this.writeSyntheticToolResult(toolUseId, turnId, msg, queue);
      this.input.recordToolInvocation?.({
        sessionId: this.input.sessionId,
        turnId,
        toolCallId: toolUseId,
        toolName: tool.name,
        providerId: this.input.connection.providerType,
        modelId: this.input.modelId,
        durationMs: Math.max(0, this.input.now() - startedAt),
        status: 'error',
        errorClass: classifyError(err),
        argsSummary: tool.categoryHint === 'computer_use'
          ? summarizePersistedArgs(persistedArgs)
          : summarizeArgs(tool.name, executionArgs),
        bytesIn: byteLength(persistedArgs),
        bytesOut: 0,
        startedAt,
      });
      trace?.emit('tool', 'tool_failed', 'Tool execution failed', {
        toolUseId,
        toolName: tool.name,
        durationMs: Math.max(0, this.input.now() - startedAt),
        status: 'error',
        errorClass: classifyError(err),
      });
      return this.errorReturn(msg);
    } finally {
      this.recordLoopGateOutcome(callSignature, attemptFailed);
      if (reservedSubagentSlot) this.releaseSubagentSlot(tool);
    }
  }

  private async awaitPermissionDecision(
    verdict: Extract<ReturnType<PermissionEngine['evaluate']>, { kind: 'prompt' }>,
    turnId: string,
    resolve: () => Promise<PermissionDecision> = () => verdict.parked,
  ): Promise<PermissionDecision> {
    const timeoutMs = this.input.permissionTimeoutMs ?? DEFAULT_PERMISSION_TIMEOUT_MS;
    const pauseTarget = this.input.getPermissionPauseTarget();
    pauseTarget?.pause();
    try {
      if (timeoutMs <= 0) return await resolve();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          const reason = `Permission request ${verdict.event.requestId} timed out after ${timeoutMs}ms`;
          this.input.permissionEngine.expireRequest(turnId, verdict.event.requestId, reason);
          reject(new Error(reason));
        }, timeoutMs);
      });
      try {
        return await Promise.race([resolve(), timeout]);
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }
    } finally {
      pauseTarget?.resume();
    }
  }

  private reserveSubagentSlot(tool: MakaTool): boolean {
    if (tool.categoryHint !== 'subagent') return true;
    if (this.activeSubagentToolCount >= MAX_ACTIVE_SUBAGENT_TOOLS_PER_TURN) return false;
    this.activeSubagentToolCount += 1;
    return true;
  }

  private releaseSubagentSlot(tool: MakaTool): void {
    if (tool.categoryHint !== 'subagent') return;
    this.activeSubagentToolCount = Math.max(0, this.activeSubagentToolCount - 1);
  }

  private errorReturn(message: string): unknown {
    return { error: message };
  }

  private buildSpawnChildAgentContext(
    abortSignal: AbortSignal,
  ): Pick<MakaToolContext, 'spawnChildAgent'> {
    const parentRunId = this.input.getCurrentRunId?.();
    const spawnChildAgent = this.input.spawnChildAgent;
    if (!parentRunId || !spawnChildAgent) return {};
    const limiter = this.childAgentRunLimiter;
    return {
      spawnChildAgent: async (input) => {
        const permit = await limiter.acquire(abortSignal);
        try {
          if (abortSignal.aborted) {
            throw abortSignal.reason instanceof Error
              ? abortSignal.reason
              : new Error('Child agent run cancelled before it started');
          }
          return await spawnChildAgent({
            parentRunId,
            spec: input.spec,
            prompt: input.prompt,
            abortSignal,
            ...(input.onReady ? { onReady: input.onReady } : {}),
            ...(input.onEvent ? { onEvent: input.onEvent } : {}),
          });
        } finally {
          permit.release();
        }
      },
    };
  }

  private async askUserQuestion(
    turnId: string,
    toolUseId: string,
    questions: UserQuestion[],
    queue: AsyncEventQueue<SessionEvent> | { push(event: SessionEvent): void },
  ): Promise<UserQuestionResult> {
    const requestId = this.input.newId();
    const parked = this.userQuestions.park(turnId, requestId, { toolUseId, questions });
    queue.push({
      type: 'user_question_request',
      id: this.input.newId(),
      turnId,
      ts: this.input.now(),
      requestId,
      toolUseId,
      questions,
    });
    const response = await parked;
    return {
      answers: questions.map((question, index) => ({
        question: question.question,
        answer: response.answers[index] ?? null,
      })),
    };
  }
}

/**
 * Recoverable message returned when a gated tool is invoked before its group is
 * loaded. Tells the model exactly how to self-correct: load via `load_tools`,
 * then retry on a later step.
 */
export function formatDeferredNotLoadedText(toolName: string): string {
  return (
    `Tool "${toolName}" is available but not loaded yet. ` +
    `Call load_tools to load its group first, then call "${toolName}" on a later step.`
  );
}

/**
 * Canonical key for a tool call's args; order-independent so identical calls
 * match. Hashed, not the raw args, so large Write/Edit payloads are not retained
 * (only the last signature is kept per turn). Args that cannot be canonicalized
 * (cyclic / throwing getters — impossible for JSON tool args, but be safe) fall
 * back to the unique call id, so distinct calls never collapse into one signature
 * and trip a false block, and no raw args are retained.
 */
function loopGateArgsKey(args: unknown, callId: string): string {
  try {
    return stableHash(args ?? null);
  } catch {
    return `unhashable:${callId}`;
  }
}

function computerUseSemanticSignature(args: unknown): string | undefined {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return undefined;
  const record = args as Record<string, unknown>;
  if (
    record.action !== 'click_element'
    && record.action !== 'set_value'
    && record.action !== 'select_text'
    && record.action !== 'secondary_action'
  ) return undefined;
  try {
    const elementIdentity = stableElementIdentity(record.element_identity);
    return stableHash({
      action: record.action,
      app: record.app,
      window_id: record.window_id,
      ...(elementIdentity === undefined
        ? { element_id: record.element_id }
        : { element_identity: elementIdentity }),
      value: record.value,
      text: record.text,
    });
  } catch {
    return undefined;
  }
}

function stableElementIdentity(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const record = value as Record<string, unknown>;
  return {
    role: record.role,
    label: record.label,
    value: record.value,
    frame: record.frame,
  };
}

/**
 * Recoverable message returned when the loop-gate blocks a repeated identical
 * failing call. Tells the model the retry is pointless and to change its approach.
 */
export function formatLoopGateText(toolName: string): string {
  return (
    `Blocked: this exact ${toolName} call (identical arguments) has already failed ` +
    `repeatedly with no change between attempts, so it was not run again — the result ` +
    `would be the same. Change the arguments or take a different step (for example ` +
    `Read the file or inspect the relevant state) before retrying.`
  );
}

export function formatAmbiguousComputerLoopGateText(): string {
  return (
    'Blocked: this Computer Use semantic target was already rejected as ambiguous '
    + 'after a fresh observation. Do not retry the same element identity or guess '
    + 'between duplicates; choose a uniquely identified target or stop.'
  );
}

export function formatSyntheticToolErrorText(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  const redacted = redactSecrets(raw || 'Tool failed');
  if (redacted.length <= TOOL_ERROR_RESULT_MAX_CHARS) return redacted;
  return `${redacted.slice(0, TOOL_ERROR_RESULT_MAX_CHARS - 1)}…`;
}

/**
 * Structured provider error identifiers that mean the INPUT exceeded the
 * model's context window. These come from the provider's error JSON and are
 * the ONLY unconditional overflow evidence: free-text signals are vetoable.
 */
const CONTEXT_OVERFLOW_PROVIDER_CODES: ReadonlySet<string> = new Set([
  'context_length_exceeded', // OpenAI & OpenAI-compatible: error.code
  'model_context_window_exceeded', // z.ai: error.code
  'request_too_large', // Anthropic byte-size overflow (HTTP 413): error.type
]);

/**
 * A provider failure normalized into classification evidence. classifyError's
 * real input domain is NOT just Error instances: a request-level failure is
 * an AI SDK `APICallError` (provider JSON parsed in `data`, raw in
 * `responseBody`; no top-level `.code`), while an in-stream error part
 * carries the provider's parsed error VALUE — OpenAI Chat emits the inner
 * `{message, type?, code?}` object, OpenAI Responses the whole
 * `{type:'error', error:{type, code, message}}` chunk, Anthropic the inner
 * `{type, message}` object, and openai-compatible a bare message string.
 * Shapes read from the provider sources, never invented.
 */
interface ProviderErrorEvidence {
  /** Lowercased composite of the textual fields, for pattern evidence. */
  text: string;
  /** Explicit HTTP status from a field ('' when absent) — never a substring. */
  statusCode: string;
  /** Top-level code field as a string ('' when absent). */
  code: string;
  /** Structured provider identifiers (code/type), lowercased. */
  structuredCodes: string[];
}

/** Collects `code`/`type` strings from a payload and from its `error` wrapper. */
function collectStructuredCodes(payload: unknown, out: string[]): void {
  const fromRecord = (record: unknown) => {
    if (typeof record !== 'object' || record === null) return;
    for (const key of ['code', 'type'] as const) {
      const value = (record as Record<string, unknown>)[key];
      if (typeof value === 'string' && value) out.push(value.toLowerCase());
    }
  };
  fromRecord(payload);
  if (typeof payload === 'object' && payload !== null) {
    fromRecord((payload as { error?: unknown }).error);
  }
}

function normalizeErrorEvidence(error: unknown): ProviderErrorEvidence | undefined {
  if (error instanceof Error) {
    const code = 'code' in error ? String((error as { code?: unknown }).code) : '';
    const statusCode = 'statusCode' in error
      ? String((error as { statusCode?: unknown }).statusCode)
      : 'status' in error
        ? String((error as { status?: unknown }).status)
        : '';
    const rawBody = (error as { responseBody?: unknown }).responseBody;
    const body = typeof rawBody === 'string' ? rawBody : '';
    const structuredCodes: string[] = [];
    collectStructuredCodes((error as { data?: unknown }).data, structuredCodes);
    if (structuredCodes.length === 0 && body) {
      // The failed-response handler keeps the raw body even when the provider
      // JSON failed the schema (which is exactly when `data` is absent).
      try {
        collectStructuredCodes(JSON.parse(body), structuredCodes);
      } catch {
        // Not JSON — no structured evidence.
      }
    }
    return {
      // The raw body joins the text evidence: when the provider JSON fails
      // the error schema, `message` degrades to the statusText and the body
      // is the ONLY carrier of the provider's wording (e.g. an
      // OpenAI-compatible `{error: string}` overflow). Positives and vetoes
      // both run over the same full text.
      text: `${error.name} ${code} ${statusCode} ${error.message}${body ? ` ${body}` : ''}`.toLowerCase(),
      statusCode,
      code,
      structuredCodes,
    };
  }
  if (typeof error === 'string') {
    const structuredCodes: string[] = [];
    try {
      collectStructuredCodes(JSON.parse(error), structuredCodes);
    } catch {
      // A plain message string — text evidence only.
    }
    return { text: error.toLowerCase(), statusCode: '', code: '', structuredCodes };
  }
  if (typeof error === 'object' && error !== null) {
    const record = error as Record<string, unknown>;
    const field = (key: string): string => {
      const value = record[key];
      return typeof value === 'string' || typeof value === 'number' ? String(value) : '';
    };
    const structuredCodes: string[] = [];
    collectStructuredCodes(record, structuredCodes);
    let text: string;
    try {
      // Serialize the whole value so message/code text is evidence no matter
      // which of the known provider shapes carried it.
      text = JSON.stringify(error).toLowerCase();
    } catch {
      text = String(error).toLowerCase();
    }
    return {
      text,
      statusCode: field('statusCode') || field('status'),
      code: field('code'),
      structuredCodes,
    };
  }
  return undefined;
}

/**
 * Provider context-length overflow signatures. A request-level 400/413 whose
 * message matches one of these means the input exceeded the model's context
 * window — the reactive-recovery trigger (issue #882 PR 2). The set is ported
 * from pi's battle-tested table and covers the providers Maka ships in its
 * registry (Anthropic, OpenAI/-compatible, Google, xAI, Groq, OpenRouter,
 * Mistral, MiniMax, Kimi/Moonshot, Together, llama.cpp/LM Studio/Ollama, …).
 * Matched against the ORIGINAL error's composite fields (name, code, status,
 * message), never the generalized string. All of these are free-text evidence
 * and can be vetoed by NON_CONTEXT_OVERFLOW_PATTERNS: a capacity statement or
 * overflow phrase quoted inside a throttling/quota error must not trigger
 * recovery — only a structured provider code is unconditional.
 */
const CONTEXT_OVERFLOW_PATTERNS: readonly RegExp[] = [
  /prompt is too long/i, // Anthropic token overflow
  /request_too_large/i, // Anthropic request byte-size overflow (HTTP 413)
  /input is too long for requested model/i, // Amazon Bedrock
  /exceeds the context window/i, // OpenAI (Completions & Responses)
  /exceeds (?:the )?(?:model'?s )?maximum context length(?: of [\d,]+ tokens?|\s*\([\d,]+\))?/i, // OpenAI-compatible proxies (LiteLLM)
  /input token count.*exceeds the maximum/i, // Google (Gemini)
  /maximum prompt length is \d+/i, // xAI (Grok)
  /reduce the length of the messages/i, // Groq
  /maximum context length is \d+ tokens/i, // OpenRouter (most backends)
  /exceeds (?:the )?maximum allowed input length of [\d,]+ tokens?/i, // OpenRouter/Poolside
  /input \(\d+ tokens\) is longer than the model'?s context length \(\d+ tokens\)/i, // Together AI
  // GitHub Copilot: "prompt token count of X exceeds the limit of Y". The INPUT
  // subject is required — a bare "token count of N exceeds the limit of M" also
  // matches output/completion caps, and a bare "exceeds the limit of N" matches
  // file-size and other quota errors; neither is fixable by history compaction.
  /(?:prompt|input|context|message)[^.]{0,80}token count of [\d,]+ exceeds the limit of [\d,]+/i,
  /exceeds the available context size/i, // llama.cpp server
  /greater than the context length/i, // LM Studio
  /context window exceeds limit/i, // MiniMax
  /exceeded model token limit/i, // Kimi For Coding
  /too large for model with \d+ maximum context length/i, // Mistral
  /prompt has [\d,]+ tokens?, but the configured context size is [\d,]+ tokens?/i, // DS4 server
  /model_context_window_exceeded/i, // z.ai non-standard finish_reason surfaced as error text
  /prompt too long; exceeded (?:max )?context length/i, // Ollama explicit overflow error
  /context[_ ]length[_ ]exceeded/i, // OpenAI structured error code (also generic)
  // Ambiguous token-limit wording that is an input overflow only when an
  // input-like word is the subject. `request` is deliberately NOT in the
  // subject list: it appears in generic prefixes ("Invalid request: ...")
  // without saying anything about which side of the token budget overflowed.
  /(?:prompt|input|context|message)[^.]{0,80}too many tokens/i,
  /(?:prompt|input|context|message)[^.]{0,80}token limit exceeded/i,
];

/**
 * Wording that looks token-shaped but is NOT an input overflow: throttling /
 * quota / rate limiting, and complete OUTPUT-cap relations in every observed
 * permutation of role word (output/completion/max_tokens) and token
 * predicate — subject before predicate ("completion has too many tokens",
 * "max_tokens token limit exceeded"), predicate before subject ("too many
 * tokens were requested for the completion"), the count-of form ("output
 * token count of N exceeds"), the role word embedded inside the phrase
 * ("too many completion tokens were requested"), and the role-tokens-exceed
 * form ("Maximum completion tokens exceeded"). Noun phrases alone (e.g.
 * "completion token count") are not excluded: they also appear as usage
 * breakdowns inside genuine input-overflow messages, and "(prompt +
 * completion) exceed" combined-budget wording stays classifiable because the
 * role word is not adjacent to "tokens".
 */
const NON_CONTEXT_OVERFLOW_PATTERNS: readonly RegExp[] = [
  /rate limit/i,
  /too many requests/i,
  /throttl/i,
  /quota/i,
  /(?:output|completion|max_tokens)\b[^.]{0,60}(?:too many tokens|token limit exceeded)/i,
  /(?:too many tokens|token limit exceeded)[^.]{0,60}\b(?:output|completion|max_tokens)/i,
  /(?:output|completion)\s+token\s+(?:count|limit)[^.]{0,40}exceed/i,
  /too many (?:output|completion|max_tokens)[^.]{0,20}tokens/i,
  /\b(?:output|completion|max_tokens)\s+tokens?\b[^.]{0,20}exceed/i,
];

/**
 * Two-layer overflow detection on an error's raw text (the composite of its
 * original name/code/status/message). Triggering recovery requires positive
 * evidence of an INPUT overflow — the one class history compaction can fix:
 * 1. Vetoes first: throttling/quota wording and complete output-cap relations
 *    disqualify every free-text signal. Free text is never unconditional — a
 *    capacity statement quoted inside a throttle error is not an overflow.
 * 2. Positive overflow relations count only when nothing vetoed. Structured
 *    provider codes (the unconditional evidence) are classifyError's job,
 *    checked before this text layer ever runs.
 */
export function isContextOverflowErrorText(text: string): boolean {
  if (!text) return false;
  if (NON_CONTEXT_OVERFLOW_PATTERNS.some((pattern) => pattern.test(text))) return false;
  return CONTEXT_OVERFLOW_PATTERNS.some((pattern) => pattern.test(text));
}

/**
 * Classifies a provider error by DESCENDING evidence strength over the
 * normalized evidence (Error, string, or plain stream-error-part object):
 * abort → 402 → 429 → 401/403 (numeric fields, never substrings) → the
 * provider's structured overflow code → bare 413 (HTTP: request entity too
 * large — itself input-side evidence, Cerebras sends it with no body) →
 * vetoable free-text overflow relations → generic 5xx → weak word
 * heuristics. Specific overflow evidence outranks a generic 5xx because
 * proxies (LiteLLM) wrap provider overflows in 503s; the weak heuristics
 * rank last so "generate" can never become a rate limit.
 */
export function classifyError(error: unknown): string {
  const evidence = normalizeErrorEvidence(error);
  if (!evidence) return 'Other';
  const { text, statusCode, code, structuredCodes } = evidence;
  if (text.includes('abort')) return 'Abort';
  if (statusCode === '402' || code === '402') return 'ProviderBilling';
  if (statusCode === '429' || code === '429') return 'RateLimit';
  if (statusCode === '401' || statusCode === '403' || code === '401' || code === '403') return 'Auth';
  // Structured provider evidence: the parsed error JSON's code/type is the
  // only unconditional signal for a context overflow.
  if (structuredCodes.some((c) => CONTEXT_OVERFLOW_PROVIDER_CODES.has(c))) return 'ContextLength';
  if (statusCode === '413' || code === '413') return 'ContextLength';
  // Free-text overflow relations on the composite text, veto-first inside.
  if (isContextOverflowErrorText(text)) return 'ContextLength';
  if (/^5\d\d$/.test(statusCode) || /^5\d\d$/.test(code)) return 'ProviderUnavailable';
  // Weak word heuristics, last: they only catch errors that carried no
  // stronger evidence for any other class. `rate` must be word-shaped
  // ("generate"/"separate" are not rate limits) while still matching the
  // rate_limit/RateLimitError identifier spellings.
  if (/\brate\b|rate[_-]?limit/.test(text)) return 'RateLimit';
  if (text.includes('auth')) return 'Auth';
  if (text.includes('timeout')) return 'Timeout';
  if (
    text.includes('network')
    || text.includes('fetch')
    || /\btypeerror\b.*\bterminated\b/.test(text)
  ) return 'Network';
  return error instanceof Error ? (error.name || 'Other') : 'Other';
}

export function errorPresentationFromClass(errorClass: string): {
  reason?: string;
  message?: string;
} {
  switch (errorClass) {
    case 'ContextLength':
      return { reason: 'context_overflow', message: 'Context window exceeded' };
    case 'Timeout':
      return { reason: 'timeout', message: 'Request timed out' };
    case 'Auth':
      return { reason: 'auth', message: 'Authentication failed' };
    case 'ProviderBilling':
      return { reason: 'provider_billing', message: 'Provider billing required' };
    case 'ProviderUnavailable':
      return { reason: 'provider_unavailable', message: 'Provider returned an error' };
    case 'RateLimit':
      return { reason: 'rate_limit', message: 'Rate limit exceeded' };
    case 'Network':
      return { reason: 'network', message: 'Network error' };
    default:
      return {};
  }
}

function coerceResultContent(raw: unknown): ToolResultContent {
  if (typeof raw === 'string') return { kind: 'text', text: raw };
  if (raw && typeof raw === 'object') {
    const obj = raw as { kind?: string; text?: string };
    if (typeof obj.kind === 'string') return raw as ToolResultContent;
    if (typeof obj.text === 'string') return { kind: 'text', text: obj.text };
    return { kind: 'json', value: raw };
  }
  return { kind: 'text', text: String(raw ?? '') };
}

function coerceTerminalFailure(
  tool: MakaTool,
  cwd: string,
  args: unknown,
  err: unknown,
): {
  content: Extract<ToolResultContent, { kind: 'terminal' }>;
  message: string;
  sandboxDenied: boolean;
} | null {
  if (tool.name !== 'Bash' || !err || typeof err !== 'object') return null;
  const error = err as {
    code?: unknown;
    stdout?: unknown;
    stderr?: unknown;
    stdoutTruncated?: unknown;
    stderrTruncated?: unknown;
    reason?: unknown;
    sandboxed?: unknown;
    sandboxType?: unknown;
  };
  if (typeof error.code !== 'number') return null;
  const command = args && typeof args === 'object' && typeof (args as { command?: unknown }).command === 'string'
    ? (args as { command: string }).command
    : '';
  const stdout = redactSecrets(String(error.stdout ?? ''));
  const stderr = redactSecrets(String(error.stderr ?? ''));
  const sandboxDenied = error.reason === 'sandbox_denial' && error.sandboxed === true;
  return {
    content: {
      kind: 'terminal',
      cwd,
      cmd: redactSecrets(command),
      status: error.code === 124 ? 'timed_out' : error.code === 130 ? 'cancelled' : 'failed',
      exitCode: error.code,
      output: {
        mode: 'pipes',
        stdout,
        stderr,
        stdoutTruncated: error.stdoutTruncated === true,
        stderrTruncated: error.stderrTruncated === true,
        redacted: stdout !== String(error.stdout ?? '') || stderr !== String(error.stderr ?? ''),
      },
      ...(sandboxDenied ? {
        sandboxDenial: {
          likely: true,
          ...(error.sandboxType === 'macos-seatbelt' || error.sandboxType === 'linux'
            ? { backend: error.sandboxType }
            : {}),
          recovery: 'require_escalated',
        },
      } : {}),
    },
    // The in-turn result the model acts on is just this message (the structured
    // content above goes to session history). Without the actual output the
    // model is blind to *why* the command failed, so fold in a bounded tail of
    // stderr/stdout — the tail is where shell errors land.
    message: buildTerminalFailureMessage(error.code, stdout, stderr, sandboxDenied),
    sandboxDenied,
  };
}

function buildTerminalFailureMessage(
  code: number,
  stdout: string,
  stderr: string,
  sandboxDenied: boolean,
): string {
  const parts = [`命令退出码 ${code}`];
  const view = (text: string) =>
    truncateToolOutput(text, { maxLines: 40, maxBytes: 1500, direction: 'tail' }).content.trim();
  const stderrView = view(stderr);
  if (stderrView) parts.push(`--- stderr ---\n${stderrView}`);
  const stdoutView = view(stdout);
  if (stdoutView) parts.push(`--- stdout ---\n${stdoutView}`);
  if (sandboxDenied) {
    parts.push(
      '该失败很可能来自 Maka sandbox。若完成用户当前请求确实需要在 sandbox 外执行，请使用完全相同的命令重新调用 Bash，并显式传入 sandbox_permissions: { mode: "require_escalated", justification: "具体原因" }。不要静默绕过 sandbox，也不要在更小范围的 additional permissions 足够时请求完全提权。',
    );
  }
  return parts.join('\n\n');
}

function hasSandboxDenial(
  content: ToolResultContent,
): content is Extract<ToolResultContent, { kind: 'terminal' } | { kind: 'shell_run' }> {
  return (content.kind === 'terminal' || content.kind === 'shell_run')
    && content.sandboxDenial?.likely === true;
}

function sandboxDenialKey(toolName: string, cwd: string, args: unknown): string {
  const command = args && typeof args === 'object' && typeof (args as { command?: unknown }).command === 'string'
    ? (args as { command: string }).command
    : '';
  return `${toolName}\u0000${cwd}\u0000${command}`;
}

function deriveToolResultStatus(
  content: ToolResultContent,
  raw?: unknown,
): ToolInvocationRecord['status'] {
  if (
    raw
    && typeof raw === 'object'
    && typeof (raw as { error?: unknown }).error === 'string'
    && (raw as { error: string }).error.length > 0
  ) return 'error';
  if (content.kind === 'explore_agent' && content.ok === false) {
    return content.reason === 'aborted' ? 'aborted' : 'error';
  }
  if (content.kind === 'subagent') {
    if (content.status === 'completed') return 'success';
    if (content.status === 'cancelled') return 'aborted';
    return 'error';
  }
  if (content.kind === 'rive_workflow' && content.ok === false) return 'error';
  if (content.kind === 'web_search_error') return 'error';
  if (content.kind === 'office_document' && content.ok === false) {
    return content.reason === 'officecli_aborted' ? 'aborted' : 'error';
  }
  // Bash returns terminal facts instead of throwing for ordinary shell failure.
  // The explicit status is the shared classification point for isError,
  // telemetry, and loop-gate failure streaks.
  if (content.kind === 'terminal') {
    if (content.status === 'completed') return 'success';
    if (content.status === 'cancelled') return 'aborted';
    return 'error';
  }
  if (
    content.kind === 'shell_run'
    && content.operation?.kind === 'pty_control'
    && content.operation.failed
  ) return 'error';
  // All other structured results are successful tool executions. That includes
  // ShellRun observations: their embedded process status stays model-visible,
  // but reading or returning the observation itself succeeded.
  return 'success';
}

function isAmbiguousComputerFailure(raw: unknown): boolean {
  return Boolean(
    raw
    && typeof raw === 'object'
    && (raw as { error?: unknown }).error === 'stale_frame'
    && (raw as { failureClass?: unknown }).failureClass === 'ambiguous_target',
  );
}

function summarizeArgs(toolName: string, args: unknown): string {
  const projected = projectToolActivityArgs(toolName, args);
  const raw = typeof projected === 'string' ? projected : JSON.stringify(projected ?? null);
  const text = toolName === 'WriteStdin' ? raw : redactSecrets(raw);
  return text.length <= 512 ? text : `${text.slice(0, 511)}…`;
}

function summarizePersistedArgs(args: unknown): string {
  const raw = typeof args === 'string' ? args : JSON.stringify(args ?? null);
  const text = redactSecrets(raw);
  return text.length <= 512 ? text : `${text.slice(0, 511)}…`;
}

function describeToolIntent(tool: MakaTool, args: unknown): string | undefined {
  if (tool.categoryHint !== 'subagent' || tool.name !== 'ExploreAgent') return undefined;
  if (!args || typeof args !== 'object') return undefined;
  const objective = (args as { objective?: unknown }).objective;
  if (typeof objective !== 'string') return undefined;
  const normalized = redactSecrets(objective.replace(/\s+/g, ' ').trim());
  if (normalized.length === 0) return undefined;
  const capped = normalized.length <= 180 ? normalized : `${normalized.slice(0, 179)}…`;
  return `只读探索：${capped}`;
}

function isAdditionalPermissionPlanResult(
  value: unknown,
): value is AdditionalPermissionPlanResult {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const result = value as Record<string, unknown>;
  if (result.kind === 'not_required') return true;
  if (result.kind === 'request') {
    return Boolean(result.proposal && typeof result.proposal === 'object');
  }
  return result.kind === 'block'
    && typeof result.reason === 'string'
    && typeof result.message === 'string';
}

function isSandboxEscalationPlanResult(value: unknown): value is SandboxEscalationPlanResult {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const result = value as Record<string, unknown>;
  if (result.kind === 'not_required') return true;
  if (result.kind === 'request') {
    return Boolean(result.proposal && typeof result.proposal === 'object');
  }
  return result.kind === 'block'
    && typeof result.reason === 'string'
    && typeof result.message === 'string';
}

function byteLength(value: unknown): number {
  if (value === undefined) return 0;
  const text = typeof value === 'string' ? value : JSON.stringify(value ?? null);
  return Buffer.byteLength(text, 'utf8');
}

function snapshotToolArgs(value: unknown): unknown {
  return snapshotJsonValue(value, new WeakSet<object>());
}

function snapshotJsonValue(value: unknown, seen: WeakSet<object>): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (seen.has(value)) throw new Error('Tool arguments must not contain cycles');
  seen.add(value);
  if (Array.isArray(value)) {
    return Object.freeze(value.map((entry) => snapshotJsonValue(entry, seen)));
  }
  const output: Record<string, unknown> = {};
  for (const key of Object.keys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !('value' in descriptor)) {
      throw new Error(`Tool argument ${key} must be a plain data property`);
    }
    output[key] = snapshotJsonValue(descriptor.value, seen);
  }
  return Object.freeze(output);
}
