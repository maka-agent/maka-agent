import type {
  SessionEvent,
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
import type { ToolCategory } from '@maka/core/permission';
import type { LlmConnection } from '@maka/core/llm-connections';
import type { SessionHeader } from '@maka/core/session';
import type { ToolInvocationRecord, ToolSourceId } from '@maka/core/usage-stats/types';
import { redactSecrets } from '@maka/core/redaction';

import type { PermissionEngine } from './permission-engine.js';
import type { AsyncEventQueue } from './async-queue.js';
import {
  recordToolArtifactsSafely,
  type ToolArtifactRecorder,
} from './tool-artifacts.js';
import { createToolOutputDeltaEmitter } from './tool-output-delta.js';
import type { RunTraceLike } from './run-trace.js';

export interface MakaTool<P = any, R = unknown> {
  /** Canonical (Claude-SDK-style) name. Pi adapter translates to canonical. */
  name: string;
  /** Human-readable description shown to the model. */
  description: string;
  /** Zod schema describing the tool's argument shape. */
  parameters: unknown;
  /**
   * Exposure tier. `direct` (the default when omitted) tools are advertised to
   * the model every turn. `deferred` tools are withheld from the model-visible
   * `activeTools` set until loaded on demand via `load_tool`, keeping their
   * schema out of the per-turn prompt. Dispatch works regardless of exposure —
   * a deferred tool stays in `providerTools` so it is callable once activated.
   */
  exposure?: 'direct' | 'deferred';
  /**
   * If `false`, the wrap layer skips PermissionEngine.evaluate() entirely.
   * Defaults to `true` (always go through the engine).
   */
  permissionRequired?: boolean;
  /** Optional UI display name. */
  displayName?: string;
  /** Optional trusted category override for custom tools. */
  categoryHint?: ToolCategory;
  /** Optional source grouping used by opt-in tool source economy mode. */
  toolSource?: {
    id: ToolSourceId;
    label?: string;
    description?: string;
  };
  /** Real tool implementation. Called only after permission allows. */
  impl: (args: P, ctx: MakaToolContext) => Promise<R> | R;
}

export interface MakaToolContext {
  sessionId: string;
  turnId: string;
  /** Session working directory. */
  cwd: string;
  toolCallId: string;
  abortSignal: AbortSignal;
  emitOutput: (stream: ToolOutputStream, chunk: string) => void;
}

export type AppendMessageFn = (m: ToolCallMessage | ToolResultMessage | PermissionDecisionMessage) => Promise<void>;
export type ToolTelemetryRecorder = (record: ToolInvocationRecord) => void;

export const TOOL_ERROR_RESULT_MAX_CHARS = 4000;
export const MAX_ACTIVE_SUBAGENT_TOOLS_PER_TURN = 5;
export const DEFAULT_PERMISSION_TIMEOUT_MS = 300_000;

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
  getRunTrace?: () => RunTraceLike | null;
  permissionTimeoutMs?: number;
  recordToolInvocation?: ToolTelemetryRecorder;
  recordToolArtifacts?: ToolArtifactRecorder;
}

export class ToolRuntime {
  private activeSubagentToolCount = 0;
  /**
   * Per-step active-tool snapshot provider for deferred-tool gating (Layer 1,
   * Slice 5). Set by the backend each turn (from `prepareStep`'s
   * `onActiveSnapshot`); returns the names advertised to the model for the step
   * currently executing. Undefined when deferred loading is off — the guard is
   * then fully inert.
   */
  private stepActivation?: () => ReadonlySet<string>;

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
   * Install the per-step active-tool snapshot provider used to gate deferred
   * tools. The backend recomputes the snapshot before each step; the guard in
   * `executeTool` rejects a deferred tool whose name is not in it. Pass
   * `undefined` to disable gating.
   */
  setStepActivation(get: (() => ReadonlySet<string>) | undefined): void {
    this.stepActivation = get;
  }

  resetTurnState(): void {
    this.activeSubagentToolCount = 0;
    this.stepActivation = undefined;
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

    const callMsg: ToolCallMessage = {
      type: 'tool_call',
      id: toolUseId,
      turnId,
      ts: now,
      toolName: tool.name,
      ...(tool.displayName ? { displayName: tool.displayName } : {}),
      ...(toolIntent ? { intent: toolIntent } : {}),
      args,
    };
    await this.input.appendMessage(callMsg);
    const startEv: ToolStartEvent = {
      type: 'tool_start',
      id: this.input.newId(),
      turnId,
      ts: now,
      toolUseId,
      toolName: tool.name,
      args,
      ...(tool.displayName ? { displayName: tool.displayName } : {}),
      ...(toolIntent ? { intent: toolIntent } : {}),
    };
    queue.push(startEv);
    trace?.emit('tool', 'tool_started', 'Tool execution started', {
      toolUseId,
      toolName: tool.name,
      permissionRequired: tool.permissionRequired !== false,
      ...(tool.categoryHint !== undefined ? { categoryHint: tool.categoryHint } : {}),
    });

    // Deferred-tool execute-boundary guard (Layer 1, Slice 5; Codex Δ5). Uses
    // the step-start snapshot, NOT a cumulative loaded-set: if one step emits
    // `load_tool(x)` and a tool from `x` in parallel, that tool is not yet
    // active (it activates only at the next step's `prepareStep`), so it is
    // rejected here — before permission eval and before the real impl. This
    // also closes the AI SDK `activeTools` leak (vercel/ai#8653). The rejection
    // is recoverable: the model loads via `load_tool`, then retries next step.
    if (tool.exposure === 'deferred' && this.stepActivation && !this.stepActivation().has(tool.name)) {
      const reason = formatDeferredNotLoadedText(tool.name);
      await this.writeSyntheticToolResult(toolUseId, turnId, reason, queue);
      trace?.emit('tool', 'tool_failed', 'Deferred tool used before load', {
        toolUseId,
        toolName: tool.name,
        status: 'error',
        errorClass: 'DeferredNotLoaded',
      });
      return this.errorReturn(reason);
    }

    if (tool.permissionRequired !== false) {
      const verdict = this.input.permissionEngine.evaluate({
        sessionId: this.input.sessionId,
        turnId,
        toolUseId,
        toolName: tool.name,
        args,
        ...(tool.categoryHint !== undefined ? { categoryHint: tool.categoryHint } : {}),
        mode: this.input.header.permissionMode,
      });

      if (verdict.kind === 'block') {
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
    try {
      const result = await tool.impl(args as never, {
        sessionId: this.input.sessionId,
        turnId,
        cwd: this.input.header.cwd,
        toolCallId: toolUseId,
        abortSignal: ctx.abortSignal,
        emitOutput: output.emit,
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
        argsSummary: summarizeArgs(args),
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

      return result;
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
          argsSummary: summarizeArgs(args),
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
        argsSummary: summarizeArgs(args),
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
}

/**
 * Recoverable message returned when a deferred tool is invoked before its group
 * is loaded. Tells the model exactly how to self-correct: load via `load_tool`,
 * then retry on a later step.
 */
export function formatDeferredNotLoadedText(toolName: string): string {
  return (
    `Tool "${toolName}" is available but not loaded yet. ` +
    `Call load_tool to load its group first, then call "${toolName}" on a later step.`
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
  const text = `${error.name} ${code} ${error.message}`.toLowerCase();
  if (text.includes('abort')) return 'Abort';
  if (text.includes('rate') || code === '429') return 'RateLimit';
  if (text.includes('auth') || code === '401' || code === '403') return 'Auth';
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
  const error = err as { code?: unknown; stdout?: unknown; stderr?: unknown };
  if (typeof error.code !== 'number') return null;
  const command = args && typeof args === 'object' && typeof (args as { command?: unknown }).command === 'string'
    ? (args as { command: string }).command
    : '';
  return {
    content: {
      kind: 'terminal',
      cwd,
      cmd: redactSecrets(command),
      exitCode: error.code,
      stdout: redactSecrets(String(error.stdout ?? '')),
      stderr: redactSecrets(String(error.stderr ?? '')),
    },
    message: `命令退出码 ${error.code}`,
  };
}

function deriveToolResultStatus(content: ToolResultContent): ToolInvocationRecord['status'] {
  if (content.kind === 'explore_agent' && content.ok === false) {
    return content.reason === 'aborted' ? 'aborted' : 'error';
  }
  if (content.kind === 'rive_workflow' && content.ok === false) return 'error';
  if (content.kind === 'web_search_error') return 'error';
  if (content.kind === 'office_document' && content.ok === false) {
    return content.reason === 'officecli_aborted' ? 'aborted' : 'error';
  }
  return 'success';
}

function summarizeArgs(args: unknown): string {
  const text = typeof args === 'string' ? args : JSON.stringify(args ?? null);
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
