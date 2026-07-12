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
import type { ToolCategory, ToolExecutionFacts, ToolPermissionRule } from '@maka/core/permission';
import type { LlmConnection } from '@maka/core/llm-connections';
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
  /** Real tool implementation. Called only after permission allows. */
  impl: (args: P, ctx: MakaToolContext) => Promise<R> | R;
}

export interface MakaToolContext {
  sessionId: string;
  runId?: string;
  turnId: string;
  /** Session working directory. */
  cwd: string;
  toolCallId: string;
  abortSignal: AbortSignal;
  emitOutput: (stream: ToolOutputStream, chunk: string) => void;
  spawnChildAgent?: (input: {
    spec: AgentSpec;
    prompt: string;
  }) => Promise<unknown>;
  listChildAgents?: () => Promise<unknown>;
  readChildAgentOutput?: (input: { runId?: string; turnId?: string; maxEvents?: number }) => Promise<unknown>;
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
  }) => Promise<unknown>;
  listChildAgents?: () => Promise<unknown>;
  readChildAgentOutput?: (input: { runId?: string; turnId?: string; maxEvents?: number }) => Promise<unknown>;
  getRunTrace?: () => RunTraceLike | null;
  permissionTimeoutMs?: number;
  permissionRules?: readonly ToolPermissionRule[];
  recordToolInvocation?: ToolTelemetryRecorder;
  recordToolArtifacts?: ToolArtifactRecorder;
}

export class ToolRuntime {
  private activeSubagentToolCount = 0;
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

  constructor(private readonly input: ToolRuntimeInput) {}

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
    this.activeSubagentToolCount = 0;
    this.gating = undefined;
    this.lastFailedToolCallSignature = undefined;
    this.failedToolCallStreak = 0;
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
    const toolUseId = ctx.toolCallId;
    const now = this.input.now();
    const toolIntent = describeToolIntent(tool, args);
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
      args,
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
      args,
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
    const callSignature = `${tool.name} ${loopGateArgsKey(args, toolUseId)}`;
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

    if (tool.permissionRequired !== false || (this.input.permissionRules?.length ?? 0) > 0) {
      const verdict = this.input.permissionEngine.evaluate({
        sessionId: this.input.sessionId,
        turnId,
        toolUseId,
        toolName: tool.name,
        args,
        ...(tool.categoryHint !== undefined ? { categoryHint: tool.categoryHint } : {}),
        ...(tool.executionFacts !== undefined ? { executionFacts: tool.executionFacts } : {}),
        permissionRequired: tool.permissionRequired !== false,
        ...(this.input.permissionRules !== undefined ? { permissionRules: this.input.permissionRules } : {}),
        mode: this.input.header.permissionMode,
      });

      if (verdict.kind === 'block') {
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
        queue.push(verdict.event);
        trace?.emit('permission', 'permission_requested', 'Permission requested', {
          requestId: verdict.event.requestId,
          toolUseId,
          toolName: tool.name,
          category: verdict.event.category,
        });
        let response: PermissionDecision;
        try {
          response = await this.awaitPermissionDecision(verdict, turnId);
        } catch (err) {
          const msg = formatSyntheticToolErrorText(err);
          const reason = formatSyntheticToolErrorText(`Permission flow aborted: ${msg}`);
          trace?.emit('permission', 'permission_failed', 'Permission flow failed', {
            requestId: verdict.event.requestId,
            toolUseId,
            toolName: tool.name,
            reason,
          });
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
        });
        trace?.emit('permission', 'permission_decided', 'Permission decision recorded', {
          requestId: response.requestId,
          toolUseId,
          toolName: tool.name,
          decision: response.decision,
          ...(response.rememberForTurn !== undefined ? { rememberForTurn: response.rememberForTurn } : {}),
        });

        if (response.decision === 'deny') {
          const reason = '用户已拒绝权限请求';
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
      } else {
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
        const result = await tool.impl(args as never, {
          sessionId: this.input.sessionId,
          turnId,
          ...(runId ? { runId } : {}),
          cwd: this.input.header.cwd,
          toolCallId: toolUseId,
          abortSignal: ctx.abortSignal,
          emitOutput: output.emit,
          ...(this.input.listChildAgents ? { listChildAgents: this.input.listChildAgents } : {}),
          ...(this.input.readChildAgentOutput ? { readChildAgentOutput: this.input.readChildAgentOutput } : {}),
          ...(this.buildSpawnChildAgentContext(ctx.abortSignal)),
        });
        output.flush();
        const durationMs = this.input.now() - startedAt;

        const content = coerceResultContent(result);
        const toolResultStatus = deriveToolResultStatus(content);
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
          argsSummary: summarizeArgs(tool.name, args),
          bytesIn: byteLength(args),
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
            args,
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
        return result;
      } finally {
        pauseTarget?.resume();
      }
    } catch (err) {
      output.flush();
      const terminalFailure = coerceTerminalFailure(tool, this.input.header.cwd, args, err);
      if (terminalFailure) {
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
          argsSummary: summarizeArgs(tool.name, args),
          bytesIn: byteLength(args),
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
      const msg = formatSyntheticToolErrorText(err);
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
        argsSummary: summarizeArgs(tool.name, args),
        bytesIn: byteLength(args),
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
  ): Promise<PermissionDecision> {
    const timeoutMs = this.input.permissionTimeoutMs ?? DEFAULT_PERMISSION_TIMEOUT_MS;
    const pauseTarget = this.input.getPermissionPauseTarget();
    pauseTarget?.pause();
    try {
      if (timeoutMs <= 0) return await verdict.parked;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          const reason = `Permission request ${verdict.event.requestId} timed out after ${timeoutMs}ms`;
          this.input.permissionEngine.expireRequest(turnId, verdict.event.requestId, reason);
          reject(new Error(reason));
        }, timeoutMs);
      });
      try {
        return await Promise.race([verdict.parked, timeout]);
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
    if (!parentRunId || !this.input.spawnChildAgent) return {};
    return {
      spawnChildAgent: (input) => this.input.spawnChildAgent?.({
        parentRunId,
        spec: input.spec,
        prompt: input.prompt,
        abortSignal,
      }) ?? Promise.reject(new Error('spawnChildAgent is unavailable')),
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

export function formatSyntheticToolErrorText(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  const redacted = redactSecrets(raw || 'Tool failed');
  if (redacted.length <= TOOL_ERROR_RESULT_MAX_CHARS) return redacted;
  return `${redacted.slice(0, TOOL_ERROR_RESULT_MAX_CHARS - 1)}…`;
}

export function classifyError(error: unknown): string {
  if (!(error instanceof Error)) return 'Other';
  const code = 'code' in error ? String((error as { code?: unknown }).code) : '';
  const statusCode = 'statusCode' in error
    ? String((error as { statusCode?: unknown }).statusCode)
    : 'status' in error
      ? String((error as { status?: unknown }).status)
      : '';
  const text = `${error.name} ${code} ${statusCode} ${error.message}`.toLowerCase();
  if (text.includes('abort')) return 'Abort';
  if (statusCode === '402' || code === '402') return 'ProviderBilling';
  if (text.includes('rate') || statusCode === '429' || code === '429') return 'RateLimit';
  if (text.includes('auth') || statusCode === '401' || statusCode === '403' || code === '401' || code === '403') return 'Auth';
  if (/^5\d\d$/.test(statusCode) || /^5\d\d$/.test(code)) return 'ProviderUnavailable';
  if (text.includes('timeout')) return 'Timeout';
  if (text.includes('network') || text.includes('fetch')) return 'Network';
  return error.name || 'Other';
}

export function errorReasonFromClass(errorClass: string): string | undefined {
  switch (errorClass) {
    case 'Timeout':
      return 'timeout';
    case 'Auth':
      return 'auth';
    case 'ProviderBilling':
      return 'provider_billing';
    case 'ProviderUnavailable':
      return 'provider_unavailable';
    case 'RateLimit':
      return 'rate_limit';
    case 'Network':
      return 'network';
    default:
      return undefined;
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
): { content: Extract<ToolResultContent, { kind: 'terminal' }>; message: string } | null {
  if (tool.name !== 'Bash' || !err || typeof err !== 'object') return null;
  const error = err as {
    code?: unknown;
    stdout?: unknown;
    stderr?: unknown;
    stdoutTruncated?: unknown;
    stderrTruncated?: unknown;
  };
  if (typeof error.code !== 'number') return null;
  const command = args && typeof args === 'object' && typeof (args as { command?: unknown }).command === 'string'
    ? (args as { command: string }).command
    : '';
  const stdout = redactSecrets(String(error.stdout ?? ''));
  const stderr = redactSecrets(String(error.stderr ?? ''));
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
    },
    // The in-turn result the model acts on is just this message (the structured
    // content above goes to session history). Without the actual output the
    // model is blind to *why* the command failed, so fold in a bounded tail of
    // stderr/stdout — the tail is where shell errors land.
    message: buildTerminalFailureMessage(error.code, stdout, stderr),
  };
}

function buildTerminalFailureMessage(code: number, stdout: string, stderr: string): string {
  const parts = [`命令退出码 ${code}`];
  const view = (text: string) =>
    truncateToolOutput(text, { maxLines: 40, maxBytes: 1500, direction: 'tail' }).content.trim();
  const stderrView = view(stderr);
  if (stderrView) parts.push(`--- stderr ---\n${stderrView}`);
  const stdoutView = view(stdout);
  if (stdoutView) parts.push(`--- stdout ---\n${stdoutView}`);
  return parts.join('\n\n');
}

function deriveToolResultStatus(content: ToolResultContent): ToolInvocationRecord['status'] {
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

function summarizeArgs(toolName: string, args: unknown): string {
  const projected = projectToolActivityArgs(toolName, args);
  const raw = typeof projected === 'string' ? projected : JSON.stringify(projected ?? null);
  const text = toolName === 'WriteStdin' ? raw : redactSecrets(raw);
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

function byteLength(value: unknown): number {
  if (value === undefined) return 0;
  const text = typeof value === 'string' ? value : JSON.stringify(value ?? null);
  return Buffer.byteLength(text, 'utf8');
}
