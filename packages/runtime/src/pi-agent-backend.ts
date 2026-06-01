import type {
  BackendKind,
  PermissionDecisionMessage,
  SessionEvent,
  SessionHeader,
  ToolCallMessage,
  ToolOutputStream,
  ToolResultContent,
  ToolResultMessage,
} from '@maka/core';
import type { BackendSendInput, PermissionDecision } from '@maka/core/backend-types';
import { redactSecrets } from '@maka/core/redaction';
import type { ToolCategory } from '@maka/core/permission';

import type { AgentBackend, AppendMessageFn } from './ai-sdk-backend.js';
import { PermissionEngine } from './permission-engine.js';

export interface PiAgentBackendInput {
  sessionId: string;
  header: SessionHeader;
  appendMessage: AppendMessageFn;
  permissionEngine: PermissionEngine;
  transport: PiAgentTransport;
  newId?: () => string;
  now?: () => number;
}

export interface PiAgentTransport {
  send(input: PiAgentSendInput): AsyncIterable<PiAgentFrame>;
  stop?(reason: 'user_stop' | 'redirect'): Promise<void> | void;
  dispose?(): Promise<void> | void;
}

export interface PiAgentSendInput {
  sessionId: string;
  turnId: string;
  cwd: string;
  text: string;
}

export type PiAgentFrame =
  | { type: 'text_delta'; text: string; messageId?: string }
  | { type: 'text_complete'; text?: string; messageId?: string }
  | { type: 'tool_start'; toolUseId: string; toolName: string; args?: unknown; displayName?: string; intent?: string }
  | { type: 'tool_output_delta'; toolUseId: string; stream?: ToolOutputStream; chunk: string }
  | { type: 'tool_result'; toolUseId: string; isError?: boolean; content?: ToolResultContent | unknown }
  | {
      type: 'permission_request';
      toolUseId: string;
      toolName: string;
      args?: unknown;
      categoryHint?: ToolCategory;
      hint?: string;
    }
  | { type: 'error'; message: string; code?: string; details?: unknown }
  | { type: 'complete'; stopReason?: 'end_turn' | 'error' | 'max_tokens' };

export class PiAgentBackend implements AgentBackend {
  readonly kind: BackendKind = 'pi-agent';
  readonly sessionId: string;

  private readonly input: PiAgentBackendInput;
  private readonly newId: () => string;
  private readonly now: () => number;
  private stopped = false;
  private currentTurnId: string | null = null;
  private outputSeqByTool = new Map<string, number>();
  private writtenToolCalls = new Set<string>();
  private suppressedToolUseIds = new Set<string>();

  constructor(input: PiAgentBackendInput) {
    this.input = input;
    this.sessionId = input.sessionId;
    this.newId = input.newId ?? (() => crypto.randomUUID());
    this.now = input.now ?? (() => Date.now());
  }

  async *send(input: BackendSendInput): AsyncIterable<SessionEvent> {
    const turnId = input.turnId;
    const messageId = this.newId();
    let assistantText = '';
    let completedText = false;
    this.stopped = false;
    this.currentTurnId = turnId;
    this.outputSeqByTool = new Map();
    this.writtenToolCalls = new Set();
    this.suppressedToolUseIds = new Set();
    this.input.permissionEngine.beginTurn(turnId);

    try {
      for await (const rawFrame of this.input.transport.send({
        sessionId: this.sessionId,
        turnId,
        cwd: this.input.header.cwd,
        text: input.text,
      })) {
        if (this.stopped) {
          yield this.abortEvent(turnId);
          yield this.completeEvent(turnId, 'user_stop');
          return;
        }

        const frame = normalizePiAgentFrame(rawFrame);
        if (!frame) continue;

        switch (frame.type) {
          case 'text_delta': {
            const text = redactBoundedText(frame.text);
            assistantText += text;
            yield {
              type: 'text_delta',
              id: this.newId(),
              turnId,
              ts: this.now(),
              messageId: frame.messageId ?? messageId,
              text,
            };
            break;
          }
          case 'text_complete': {
            const text = redactBoundedText(frame.text ?? assistantText);
            completedText = true;
            await this.appendAssistant(turnId, frame.messageId ?? messageId, text);
            yield {
              type: 'text_complete',
              id: this.newId(),
              turnId,
              ts: this.now(),
              messageId: frame.messageId ?? messageId,
              text,
            };
            break;
          }
          case 'tool_start': {
            if (this.suppressedToolUseIds.has(frame.toolUseId)) break;
            await this.ensureToolCall(turnId, frame.toolUseId, frame.toolName, frame.args, frame.displayName, frame.intent);
            yield {
              type: 'tool_start',
              id: this.newId(),
              turnId,
              ts: this.now(),
              toolUseId: frame.toolUseId,
              toolName: frame.toolName,
              args: redactUnknown(frame.args),
              ...(frame.displayName ? { displayName: frame.displayName } : {}),
              ...(frame.intent ? { intent: redactBoundedText(frame.intent, 240) } : {}),
            };
            break;
          }
          case 'tool_output_delta': {
            if (this.suppressedToolUseIds.has(frame.toolUseId)) break;
            const seq = (this.outputSeqByTool.get(frame.toolUseId) ?? 0) + 1;
            this.outputSeqByTool.set(frame.toolUseId, seq);
            const redacted = redactBoundedText(frame.chunk);
            yield {
              type: 'tool_output_delta',
              id: this.newId(),
              turnId,
              ts: this.now(),
              sessionId: this.sessionId,
              toolCallId: frame.toolUseId,
              toolUseId: frame.toolUseId,
              seq,
              stream: frame.stream ?? 'stdout',
              chunk: redacted,
              redacted: redacted !== frame.chunk,
              createdAt: this.now(),
            };
            break;
          }
          case 'tool_result': {
            if (this.suppressedToolUseIds.has(frame.toolUseId)) break;
            const content = normalizeToolResultContent(frame.content);
            await this.appendToolResult(turnId, frame.toolUseId, Boolean(frame.isError), content);
            yield {
              type: 'tool_result',
              id: this.newId(),
              turnId,
              ts: this.now(),
              toolUseId: frame.toolUseId,
              isError: Boolean(frame.isError),
              content,
            };
            break;
          }
          case 'permission_request': {
            yield* this.handlePermissionRequest(turnId, frame);
            break;
          }
          case 'error': {
            yield {
              type: 'error',
              id: this.newId(),
              turnId,
              ts: this.now(),
              recoverable: false,
              ...(frame.code ? { code: frame.code } : {}),
              reason: 'pi_agent_error',
              message: redactBoundedText(frame.message),
              ...(frame.details ? { details: redactUnknown(frame.details) as Record<string, unknown> } : {}),
            };
            yield this.completeEvent(turnId, 'error');
            return;
          }
          case 'complete': {
            if (!completedText && assistantText.length > 0) {
              await this.appendAssistant(turnId, messageId, assistantText);
              yield {
                type: 'text_complete',
                id: this.newId(),
                turnId,
                ts: this.now(),
                messageId,
                text: assistantText,
              };
            }
            yield this.completeEvent(turnId, frame.stopReason ?? 'end_turn');
            return;
          }
        }
      }

      if (!completedText && assistantText.length > 0) {
        await this.appendAssistant(turnId, messageId, assistantText);
        yield {
          type: 'text_complete',
          id: this.newId(),
          turnId,
          ts: this.now(),
          messageId,
          text: assistantText,
        };
      }
      yield this.completeEvent(turnId, 'end_turn');
    } catch (error) {
      if (this.stopped) {
        yield this.abortEvent(turnId);
        yield this.completeEvent(turnId, 'user_stop');
        return;
      }
      yield {
        type: 'error',
        id: this.newId(),
        turnId,
        ts: this.now(),
        recoverable: false,
        reason: 'pi_agent_transport_error',
        message: redactBoundedText(error instanceof Error ? error.message : String(error)),
      };
      yield this.completeEvent(turnId, 'error');
    } finally {
      this.input.permissionEngine.endTurn(turnId, this.stopped ? 'aborted' : 'completed');
      this.currentTurnId = null;
      this.outputSeqByTool.clear();
      this.writtenToolCalls.clear();
      this.suppressedToolUseIds.clear();
      this.stopped = false;
    }
  }

  async stop(reason: 'user_stop' | 'redirect'): Promise<void> {
    this.stopped = true;
    if (this.currentTurnId !== null) {
      this.input.permissionEngine.endTurn(this.currentTurnId, 'aborted');
    }
    await this.input.transport.stop?.(reason);
  }

  async respondToPermission(decision: PermissionDecision): Promise<void> {
    if (this.currentTurnId === null) return;
    this.input.permissionEngine.recordResponse(this.currentTurnId, decision);
  }

  async dispose(): Promise<void> {
    if (this.currentTurnId !== null) {
      this.input.permissionEngine.endTurn(this.currentTurnId, 'aborted');
    }
    await this.input.transport.dispose?.();
  }

  private async *handlePermissionRequest(
    turnId: string,
    frame: Extract<PiAgentFrame, { type: 'permission_request' }>,
  ): AsyncIterable<SessionEvent> {
    await this.ensureToolCall(turnId, frame.toolUseId, frame.toolName, frame.args);
    const verdict = this.input.permissionEngine.evaluate({
      sessionId: this.sessionId,
      turnId,
      toolUseId: frame.toolUseId,
      toolName: frame.toolName,
      args: redactUnknown(frame.args),
      ...(frame.categoryHint ? { categoryHint: frame.categoryHint } : {}),
      mode: this.input.header.permissionMode,
      ...(frame.hint ? { hint: redactBoundedText(frame.hint, 240) } : {}),
    });

    if (verdict.kind === 'block') {
      this.suppressedToolUseIds.add(frame.toolUseId);
      const content: ToolResultContent = { kind: 'text', text: redactBoundedText(verdict.reason) };
      await this.appendToolResult(turnId, frame.toolUseId, true, content);
      yield this.toolResultEvent(turnId, frame.toolUseId, true, content);
      return;
    }

    if (verdict.kind === 'allow') return;

    yield verdict.event;
    let response: PermissionDecision;
    try {
      response = await verdict.parked;
    } catch (error) {
      const content: ToolResultContent = {
        kind: 'text',
        text: redactBoundedText(error instanceof Error ? error.message : String(error)),
      };
      await this.appendToolResult(turnId, frame.toolUseId, true, content);
      yield this.toolResultEvent(turnId, frame.toolUseId, true, content);
      return;
    }

    const decisionMsg: PermissionDecisionMessage = {
      type: 'permission_decision',
      id: response.requestId,
      turnId,
      ts: this.now(),
      toolUseId: frame.toolUseId,
      toolName: frame.toolName,
      decision: response.decision,
      ...(response.rememberForTurn !== undefined ? { rememberForTurn: response.rememberForTurn } : {}),
    };
    await this.input.appendMessage(decisionMsg);
    yield {
      type: 'permission_decision_ack',
      id: this.newId(),
      turnId,
      ts: this.now(),
      requestId: response.requestId,
      toolUseId: frame.toolUseId,
      decision: response.decision,
      ...(response.rememberForTurn !== undefined ? { rememberForTurn: response.rememberForTurn } : {}),
    };

    if (response.decision === 'deny') {
      this.suppressedToolUseIds.add(frame.toolUseId);
      const content: ToolResultContent = { kind: 'text', text: 'User denied permission' };
      await this.appendToolResult(turnId, frame.toolUseId, true, content);
      yield this.toolResultEvent(turnId, frame.toolUseId, true, content);
    }
  }

  private async ensureToolCall(
    turnId: string,
    toolUseId: string,
    toolName: string,
    args: unknown,
    displayName?: string,
    intent?: string,
  ): Promise<void> {
    if (this.writtenToolCalls.has(toolUseId)) return;
    this.writtenToolCalls.add(toolUseId);
    await this.input.appendMessage({
      type: 'tool_call',
      id: toolUseId,
      turnId,
      ts: this.now(),
      toolName,
      ...(displayName ? { displayName } : {}),
      ...(intent ? { intent: redactBoundedText(intent, 240) } : {}),
      args: redactUnknown(args),
    } satisfies ToolCallMessage);
  }

  private async appendAssistant(turnId: string, messageId: string, text: string): Promise<void> {
    await this.input.appendMessage({
      type: 'assistant',
      id: messageId,
      turnId,
      ts: this.now(),
      text,
      modelId: this.input.header.model,
    });
  }

  private async appendToolResult(
    turnId: string,
    toolUseId: string,
    isError: boolean,
    content: ToolResultContent,
  ): Promise<void> {
    await this.input.appendMessage({
      type: 'tool_result',
      id: this.newId(),
      turnId,
      ts: this.now(),
      toolUseId,
      isError,
      content,
    } satisfies ToolResultMessage);
  }

  private toolResultEvent(
    turnId: string,
    toolUseId: string,
    isError: boolean,
    content: ToolResultContent,
  ): SessionEvent {
    return {
      type: 'tool_result',
      id: this.newId(),
      turnId,
      ts: this.now(),
      toolUseId,
      isError,
      content,
    };
  }

  private abortEvent(turnId: string): SessionEvent {
    return { type: 'abort', id: this.newId(), turnId, ts: this.now(), reason: 'user_stop' };
  }

  private completeEvent(turnId: string, stopReason: 'end_turn' | 'user_stop' | 'error' | 'max_tokens'): SessionEvent {
    return { type: 'complete', id: this.newId(), turnId, ts: this.now(), stopReason };
  }
}

export function normalizePiAgentFrame(frame: unknown): PiAgentFrame | null {
  if (!frame || typeof frame !== 'object') return null;
  const value = frame as Record<string, unknown>;
  const type = typeof value.type === 'string' ? value.type : undefined;
  if (type === 'text_delta' && typeof value.text === 'string') {
    return { type, text: value.text, ...(typeof value.messageId === 'string' ? { messageId: value.messageId } : {}) };
  }
  if (type === 'text_complete') {
    return { type, ...(typeof value.text === 'string' ? { text: value.text } : {}), ...(typeof value.messageId === 'string' ? { messageId: value.messageId } : {}) };
  }
  if (type === 'tool_start' && typeof value.toolUseId === 'string' && typeof value.toolName === 'string') {
    return {
      type,
      toolUseId: value.toolUseId,
      toolName: value.toolName,
      args: value.args,
      ...(typeof value.displayName === 'string' ? { displayName: value.displayName } : {}),
      ...(typeof value.intent === 'string' ? { intent: value.intent } : {}),
    };
  }
  if (type === 'tool_output_delta' && typeof value.toolUseId === 'string' && typeof value.chunk === 'string') {
    const stream = value.stream === 'stderr' ? 'stderr' : 'stdout';
    return { type, toolUseId: value.toolUseId, stream, chunk: value.chunk };
  }
  if (type === 'tool_result' && typeof value.toolUseId === 'string') {
    return { type, toolUseId: value.toolUseId, isError: value.isError === true, content: value.content };
  }
  if (type === 'permission_request' && typeof value.toolUseId === 'string' && typeof value.toolName === 'string') {
    return {
      type,
      toolUseId: value.toolUseId,
      toolName: value.toolName,
      args: value.args,
      ...(isToolCategory(value.categoryHint) ? { categoryHint: value.categoryHint } : {}),
      ...(typeof value.hint === 'string' ? { hint: value.hint } : {}),
    };
  }
  if (type === 'error' && typeof value.message === 'string') {
    return {
      type,
      message: value.message,
      ...(typeof value.code === 'string' ? { code: value.code } : {}),
      ...(value.details !== undefined ? { details: value.details } : {}),
    };
  }
  if (type === 'complete') {
    const stopReason = value.stopReason === 'error' || value.stopReason === 'max_tokens'
      ? value.stopReason
      : 'end_turn';
    return { type, stopReason };
  }
  return null;
}

function normalizeToolResultContent(content: unknown): ToolResultContent {
  if (content && typeof content === 'object' && 'kind' in content) {
    return redactUnknown(content) as ToolResultContent;
  }
  if (typeof content === 'string') return { kind: 'text', text: redactBoundedText(content) };
  return { kind: 'json', value: redactUnknown(content) };
}

function redactBoundedText(text: string, maxChars = 8192): string {
  const redacted = redactSecrets(text);
  return redacted.length > maxChars ? `${redacted.slice(0, maxChars)}\n[内容已截断]` : redacted;
}

function redactUnknown(value: unknown): unknown {
  if (typeof value === 'string') return redactBoundedText(value);
  if (value === null || typeof value !== 'object') return value;
  try {
    return JSON.parse(redactSecrets(JSON.stringify(value)));
  } catch {
    return '[无法序列化的参数]';
  }
}

function isToolCategory(value: unknown): value is ToolCategory {
  return value === 'read' ||
    value === 'web_read' ||
    value === 'file_write' ||
    value === 'fs_destructive' ||
    value === 'shell_safe' ||
    value === 'shell_unsafe' ||
    value === 'git_destructive' ||
    value === 'network_send' ||
    value === 'privileged' ||
    value === 'custom_tool' ||
    value === 'subagent';
}
