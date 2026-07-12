import type {
  AssistantMessage,
  BackendKind,
  LlmConnection,
  SessionEvent,
  SessionHeader,
  StoredMessage,
  ToolPermissionRule,
  ToolInvocationRecord,
} from '@maka/core';
import type {
  AgentBackend,
  BackendSendInput,
  PermissionDecision,
} from '@maka/core/backend-types';
import type { CuAction } from '@maka/core';

import { AsyncEventQueue } from './async-queue.js';
import { convertOpenAIComputerAction } from './openai-computer-actions.js';
import type {
  OpenAIComputerCall,
  OpenAIComputerDialect,
  OpenAIComputerSafetyCheck,
  OpenAIComputerScreenshot,
} from './openai-computer-codec.js';
import {
  runOpenAIComputerLoop,
  type OpenAIComputerTransport,
} from './openai-computer-loop.js';
import { PermissionEngine } from './permission-engine.js';
import {
  DEFAULT_PERMISSION_TIMEOUT_MS,
  ToolRuntime,
  formatSyntheticToolErrorText,
  type MakaTool,
} from './tool-runtime.js';

export interface OpenAIComputerBackendInput {
  sessionId: string;
  header: SessionHeader;
  connection: LlmConnection;
  modelId: string;
  dialect: OpenAIComputerDialect;
  transport: OpenAIComputerTransport;
  computerTool: MakaTool;
  appendMessage: (message: StoredMessage) => Promise<void>;
  permissionEngine: PermissionEngine;
  display?: {
    widthPx: number;
    heightPx: number;
    environment: 'browser' | 'mac' | 'windows' | 'linux';
  };
  maxTurns?: number;
  permissionTimeoutMs?: number;
  permissionRules?: readonly ToolPermissionRule[];
  recordToolInvocation?: (record: ToolInvocationRecord) => void;
  newId?: () => string;
  now?: () => number;
}

export class OpenAIComputerBackend implements AgentBackend {
  readonly kind: BackendKind = 'ai-sdk';
  readonly sessionId: string;

  private readonly newId: () => string;
  private readonly now: () => number;
  private readonly toolRuntime: ToolRuntime;
  private currentTurnId: string | null = null;
  private currentRunId: string | null = null;
  private abortController: AbortController | null = null;
  private pumpDone: Promise<void> | null = null;
  private stopped = false;
  private disposed = false;
  private safetyAuthorizedActions = 0;
  private captureAuthorized = false;
  private telemetryRecorded = new Set<string>();

  constructor(private readonly input: OpenAIComputerBackendInput) {
    if (input.computerTool.name !== 'computer') {
      throw new Error(`OpenAIComputerBackend requires the computer MakaTool, received "${input.computerTool.name}"`);
    }
    this.sessionId = input.sessionId;
    this.newId = input.newId ?? (() => crypto.randomUUID());
    this.now = input.now ?? (() => Date.now());
    this.toolRuntime = new ToolRuntime({
      sessionId: input.sessionId,
      header: input.header,
      connection: input.connection,
      modelId: input.modelId,
      appendMessage: async (message) => input.appendMessage(message),
      permissionEngine: input.permissionEngine,
      newId: this.newId,
      now: this.now,
      getPermissionPauseTarget: () => null,
      getCurrentRunId: () => this.currentRunId ?? undefined,
      permissionTimeoutMs: input.permissionTimeoutMs,
      permissionRules: input.permissionRules,
      recordToolInvocation: (record) => {
        if (record.toolCallId) this.telemetryRecorded.add(record.toolCallId);
        input.recordToolInvocation?.(record);
      },
    });
  }

  async *send(input: BackendSendInput): AsyncIterable<SessionEvent> {
    if (this.disposed) throw new Error('OpenAIComputerBackend is disposed');
    if (this.pumpDone) throw new Error('OpenAIComputerBackend already has an active turn');

    const turnId = input.turnId;
    const queue = new AsyncEventQueue<SessionEvent>();
    const abortController = new AbortController();
    this.currentTurnId = turnId;
    this.currentRunId = input.runId ?? null;
    this.abortController = abortController;
    this.stopped = false;
    this.safetyAuthorizedActions = 0;
    this.captureAuthorized = false;
    this.telemetryRecorded.clear();
    this.input.permissionEngine.beginTurn(turnId);

    const pump = this.runPump(input, queue, abortController.signal);
    this.pumpDone = pump;

    try {
      for await (const event of queue) yield event;
    } finally {
      await pump.catch(() => {});
      this.cleanupTurn(turnId, pump);
    }
  }

  async stop(reason: 'user_stop' | 'redirect'): Promise<void> {
    this.stopped = true;
    this.abortController?.abort(reason);
    if (this.currentTurnId) {
      this.input.permissionEngine.endTurn(this.currentTurnId, 'aborted');
    }
    await this.pumpDone?.catch(() => {});
  }

  async respondToPermission(decision: PermissionDecision): Promise<void> {
    if (!this.currentTurnId) return;
    this.input.permissionEngine.recordResponse(this.currentTurnId, decision);
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    await this.stop('user_stop');
  }

  private async runPump(
    input: BackendSendInput,
    queue: AsyncEventQueue<SessionEvent>,
    signal: AbortSignal,
  ): Promise<void> {
    const turnId = input.turnId;
    try {
      const result = await runOpenAIComputerLoop({
        dialect: this.input.dialect,
        model: this.input.modelId,
        prompt: input.text,
        transport: this.input.transport,
        signal,
        maxTurns: this.input.maxTurns,
        display: this.input.display,
        acknowledgeSafetyChecks: (checks, call) =>
          this.authorizeSafetyChecks(turnId, checks, call, queue, signal),
        executor: {
          execute: (action, actionSignal) =>
            this.executeComputerAction(turnId, action, queue, actionSignal),
        },
        screenshot: {
          capture: (captureSignal) =>
            this.captureScreenshot(turnId, queue, captureSignal),
        },
      });

      if (result.status !== 'completed') {
        const message = result.status === 'safety_blocked'
          ? 'OpenAI computer safety check was not approved'
          : `OpenAI computer action is unsupported: ${result.failure.message}`;
        queue.push(this.errorEvent(turnId, message, `openai_computer_${result.status}`));
        queue.push(this.completeEvent(turnId, 'error'));
        return;
      }

      const messageId = this.newId();
      const text = result.response.text;
      await this.input.appendMessage({
        type: 'assistant',
        id: messageId,
        turnId,
        ts: this.now(),
        text,
        modelId: this.input.modelId,
      } satisfies AssistantMessage);
      queue.push({
        type: 'text_complete',
        id: this.newId(),
        turnId,
        ts: this.now(),
        messageId,
        text,
      });
      queue.push(this.completeEvent(turnId, 'end_turn'));
    } catch (error) {
      if (signal.aborted || this.stopped) {
        queue.push({
          type: 'abort',
          id: this.newId(),
          turnId,
          ts: this.now(),
          reason: 'user_stop',
        });
        queue.push(this.completeEvent(turnId, 'user_stop'));
      } else {
        queue.push(this.errorEvent(
          turnId,
          formatSyntheticToolErrorText(error),
          'openai_computer_error',
        ));
        queue.push(this.completeEvent(turnId, 'error'));
      }
    } finally {
      queue.close();
    }
  }

  private async executeComputerAction(
    turnId: string,
    action: CuAction,
    queue: AsyncEventQueue<SessionEvent>,
    signal: AbortSignal,
  ): Promise<OpenAIComputerScreenshot | void> {
    const safetyAuthorized = this.safetyAuthorizedActions > 0;
    if (safetyAuthorized) this.safetyAuthorizedActions -= 1;
    const tool = this.toolForExecution(safetyAuthorized);
    const args = computerToolArgs(action);
    const toolCallId = this.newId();
    const startedAt = this.now();
    const result = await this.toolRuntime.wrapToolExecute(tool, turnId, queue)(
      args,
      { toolCallId, abortSignal: signal },
    );
    this.recordPreExecutionFailureTelemetry(toolCallId, turnId, args, result, startedAt);
    const failure = computerToolFailure(result);
    if (failure) throw new Error(failure);
    this.captureAuthorized = true;
    const screenshot = computerToolScreenshot(result);
    if (screenshot) {
      this.captureAuthorized = false;
      return screenshot;
    }
  }

  private async captureScreenshot(
    turnId: string,
    queue: AsyncEventQueue<SessionEvent>,
    signal: AbortSignal,
  ): Promise<OpenAIComputerScreenshot> {
    const tool = this.toolForExecution(this.captureAuthorized);
    this.captureAuthorized = false;
    const args = { action: 'screenshot' };
    const toolCallId = this.newId();
    const startedAt = this.now();
    const result = await this.toolRuntime.wrapToolExecute(tool, turnId, queue)(
      args,
      { toolCallId, abortSignal: signal },
    );
    this.recordPreExecutionFailureTelemetry(toolCallId, turnId, args, result, startedAt);
    const failure = computerToolFailure(result);
    if (failure) throw new Error(failure);
    const screenshot = computerToolScreenshot(result);
    if (!screenshot) throw new Error('computer screenshot action returned no screenshot');
    return screenshot;
  }

  private toolForExecution(permissionAlreadyGranted: boolean): MakaTool {
    const computerTool = this.input.computerTool;
    return {
      ...computerTool,
      ...(permissionAlreadyGranted ? { permissionRequired: false } : {}),
      impl: async (args, context) => {
        const result = await computerTool.impl(args, context);
        const failure = computerToolFailure(result);
        if (failure) throw new Error(failure);
        return result;
      },
    };
  }

  private recordPreExecutionFailureTelemetry(
    toolCallId: string,
    turnId: string,
    args: unknown,
    result: unknown,
    startedAt: number,
  ): void {
    if (
      !this.input.recordToolInvocation
      || this.telemetryRecorded.has(toolCallId)
      || !computerToolFailure(result)
    ) {
      return;
    }
    const durationMs = Math.max(0, this.now() - startedAt);
    const serializedArgs = JSON.stringify(args);
    this.telemetryRecorded.add(toolCallId);
    this.input.recordToolInvocation({
      sessionId: this.sessionId,
      turnId,
      toolCallId,
      toolName: this.input.computerTool.name,
      providerId: this.input.connection.providerType,
      modelId: this.input.modelId,
      durationMs,
      status: 'error',
      errorClass: 'Permission',
      argsSummary: `computer.${String((args as { action?: unknown } | null)?.action ?? 'unknown')}`,
      bytesIn: new TextEncoder().encode(serializedArgs).byteLength,
      bytesOut: 0,
      startedAt,
    });
  }

  private async authorizeSafetyChecks(
    turnId: string,
    checks: OpenAIComputerSafetyCheck[],
    call: OpenAIComputerCall,
    queue: AsyncEventQueue<SessionEvent>,
    signal: AbortSignal,
  ): Promise<boolean> {
    if (signal.aborted) return false;
    const toolUseId = call.callId;
    const verdict = this.input.permissionEngine.evaluate({
      sessionId: this.sessionId,
      turnId,
      toolUseId,
      toolName: this.input.computerTool.name,
      args: {
        action: 'openai_safety_check',
        checks,
      },
      categoryHint: 'computer_use',
      permissionRequired: true,
      permissionRules: this.input.permissionRules,
      mode: 'ask',
      hint: checks.map((check) => check.message ?? check.code ?? check.id).join('\n'),
    });

    if (verdict.kind === 'block') {
      if (verdict.decisionEvent) {
        await this.input.appendMessage({
          type: 'permission_decision',
          id: verdict.decisionEvent.requestId,
          turnId,
          ts: verdict.decisionEvent.ts,
          toolUseId,
          toolName: this.input.computerTool.name,
          decision: 'deny',
        });
        queue.push(verdict.decisionEvent);
      }
      return false;
    }
    if (verdict.kind === 'allow') {
      this.safetyAuthorizedActions = countConvertedActions(call);
      return true;
    }

    queue.push(verdict.event);
    let response: PermissionDecision;
    try {
      response = await this.awaitPermission(verdict, turnId);
    } catch {
      return false;
    }
    await this.input.appendMessage({
      type: 'permission_decision',
      id: response.requestId,
      turnId,
      ts: this.now(),
      toolUseId,
      toolName: this.input.computerTool.name,
      decision: response.decision,
      ...(response.rememberForTurn !== undefined
        ? { rememberForTurn: response.rememberForTurn }
        : {}),
    });
    queue.push({
      type: 'permission_decision_ack',
      id: this.newId(),
      turnId,
      ts: this.now(),
      requestId: response.requestId,
      toolUseId,
      decision: response.decision,
      ...(response.rememberForTurn !== undefined
        ? { rememberForTurn: response.rememberForTurn }
        : {}),
    });
    if (response.decision !== 'allow') return false;
    this.safetyAuthorizedActions = countConvertedActions(call);
    return true;
  }

  private async awaitPermission(
    verdict: Extract<ReturnType<PermissionEngine['evaluate']>, { kind: 'prompt' }>,
    turnId: string,
  ): Promise<PermissionDecision> {
    const timeoutMs = this.input.permissionTimeoutMs ?? DEFAULT_PERMISSION_TIMEOUT_MS;
    if (timeoutMs <= 0) return verdict.parked;
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
      if (timer) clearTimeout(timer);
    }
  }

  private errorEvent(turnId: string, message: string, reason: string): SessionEvent {
    return {
      type: 'error',
      id: this.newId(),
      turnId,
      ts: this.now(),
      recoverable: false,
      reason,
      message,
    };
  }

  private completeEvent(
    turnId: string,
    stopReason: 'end_turn' | 'user_stop' | 'error',
  ): SessionEvent {
    return {
      type: 'complete',
      id: this.newId(),
      turnId,
      ts: this.now(),
      stopReason,
    };
  }

  private cleanupTurn(turnId: string, pump: Promise<void>): void {
    this.input.permissionEngine.endTurn(turnId, this.stopped ? 'aborted' : 'completed');
    if (this.pumpDone === pump) this.pumpDone = null;
    this.currentTurnId = null;
    this.currentRunId = null;
    this.abortController = null;
    this.safetyAuthorizedActions = 0;
    this.captureAuthorized = false;
    this.telemetryRecorded.clear();
    this.toolRuntime.resetTurnState();
    this.stopped = false;
  }
}

function countConvertedActions(call: OpenAIComputerCall): number {
  return call.actions.reduce((count, action) => {
    const conversion = convertOpenAIComputerAction(action);
    return conversion.ok ? count + conversion.actions.length : count;
  }, 0);
}

function computerToolArgs(action: CuAction): Record<string, unknown> {
  switch (action.type) {
    case 'screenshot':
    case 'cursor_position':
      return { action: action.type };
    case 'mouse_move':
    case 'left_click':
    case 'right_click':
    case 'middle_click':
    case 'double_click':
    case 'triple_click':
    case 'left_mouse_down':
    case 'left_mouse_up':
      return {
        action: action.type,
        coordinate: [action.coordinate.x, action.coordinate.y],
        ...('text' in action && action.text !== undefined ? { text: action.text } : {}),
      };
    case 'left_click_drag':
      return {
        action: action.type,
        start_coordinate: [action.startCoordinate.x, action.startCoordinate.y],
        coordinate: [action.coordinate.x, action.coordinate.y],
        ...(action.text !== undefined ? { text: action.text } : {}),
      };
    case 'type':
    case 'key':
      return { action: action.type, text: action.text };
    case 'hold_key':
      return { action: action.type, text: action.text, duration: action.durationMs / 1000 };
    case 'scroll':
      return {
        action: action.type,
        coordinate: [action.coordinate.x, action.coordinate.y],
        scroll_direction: action.scrollDirection,
        scroll_amount: action.scrollAmount,
        ...(action.text !== undefined ? { text: action.text } : {}),
      };
    case 'wait':
      return { action: action.type, duration: action.durationMs / 1000 };
    case 'zoom':
      return {
        action: action.type,
        region: [action.region.x1, action.region.y1, action.region.x2, action.region.y2],
      };
  }
}

function computerToolFailure(result: unknown): string | undefined {
  if (!result || typeof result !== 'object') return undefined;
  const value = result as { error?: unknown; text?: unknown };
  if (typeof value.error === 'string') return value.error;
  if (
    typeof value.text === 'string'
    && (value.text.includes(' failed:') || value.text.includes(' aborted'))
  ) {
    return value.text;
  }
  return undefined;
}

function computerToolScreenshot(result: unknown): OpenAIComputerScreenshot | undefined {
  if (!result || typeof result !== 'object') return undefined;
  const screenshot = (result as {
    screenshot?: { base64?: unknown; mimeType?: unknown };
  }).screenshot;
  if (
    typeof screenshot?.base64 !== 'string'
    || (screenshot.mimeType !== 'image/png' && screenshot.mimeType !== 'image/jpeg')
  ) {
    return undefined;
  }
  return {
    base64: screenshot.base64,
    mimeType: screenshot.mimeType,
  };
}
