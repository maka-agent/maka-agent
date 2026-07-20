import type {
  BackendKind,
  PermissionDecisionMessage,
  SessionEvent,
  SessionHeader,
  ToolCallMessage,
  ToolOutputStream,
  ToolResultContent,
  ToolResultMessage,
  TokenUsageMessage,
} from '@maka/core';
import {
  decodeCanonicalToolResultContent,
  InteractionPermissionProjectionError,
  projectPublicToolIntentReview,
  type CanonicalToolIntent,
  type PublicToolIntentReview,
} from '@maka/core';
import type { BackendSendInput, PermissionDecision } from '@maka/core/backend-types';
import { redactSecrets } from '@maka/core/redaction';
import {
  createCanonicalToolIntent,
  isToolCategory,
  type ToolCategory,
} from '@maka/core/permission';

import type { AgentBackend } from '@maka/core/backend-types';
import type { AppendMessageFn } from './ai-sdk-backend.js';
import { PermissionEngine } from './permission-engine.js';
import {
  RuntimeInteractionFailStopError,
  RuntimeInteractionAdmissionRejectedError,
  RuntimeInteractionInvariantError,
  type RuntimeInteractionClosureReason,
  type RuntimeInteractionFatalError,
  type RuntimePermissionAnswer,
  type RuntimePermissionContinuation,
} from './interaction-authority.js';
import {
  RUNTIME_BIND_HOSTED_RUN,
  type RuntimeBackendExecutionCapability,
  type RuntimeHostedBackendRunBinding,
  type RuntimeHostedRunControl,
} from './run-execution.js';
import {
  isRuntimeLifecycleAdmission,
  isRuntimeLifecycleAdmissionOrFatal,
  isRuntimeLifecycleFatal,
} from './runtime-lifecycle-errors.js';
import { requireBuiltinAgentDefinitionByProfile } from './agent-catalog.js';
import { stableHash } from './request-shape.js';

export interface PiAgentBackendInput {
  sessionId: string;
  header: SessionHeader;
  appendMessage: AppendMessageFn;
  permissionEngine: PermissionEngine;
  execution: RuntimeBackendExecutionCapability;
  transport: PiAgentTransport;
  newId?: () => string;
  now?: () => number;
}

export interface PiAgentTransport {
  send(input: PiAgentSendInput): AsyncIterable<PiAgentFrame>;
  stop?(reason: 'user_stop' | 'redirect'): Promise<void> | void;
  dispose?(): Promise<void> | void;
  /**
   * Resolves once this transport's admitted sends can no longer conflict with
   * a successor Runtime owner. This does not attest to descendant process exit.
   */
  isolateRegisteredSuccessorSideEffects?(): Promise<void> | void;
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
  | {
      type: 'tool_start';
      toolUseId: string;
      toolName: string;
      args?: unknown;
      displayName?: string;
    }
  | { type: 'tool_output_delta'; toolUseId: string; stream?: ToolOutputStream; chunk: string }
  | {
      type: 'tool_result';
      toolUseId: string;
      isError?: boolean;
      content?: ToolResultContent | unknown;
    }
  | {
      type: 'token_usage';
      input: number;
      output: number;
      cacheHitInput?: number;
      cacheMissInput?: number;
      cacheWriteInput?: number;
      reasoning?: number;
      total?: number;
      costUsd?: number;
    }
  | {
      type: 'permission_request';
      toolUseId: string;
      toolName: string;
      args?: unknown;
      categoryHint?: ToolCategory;
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
  private currentRunId: string | null = null;
  private turnStreamActive = false;
  private interactionFailure: RuntimeInteractionFatalError | null = null;
  private hostedRun: RuntimeHostedRunControl | null = null;
  private outputSeqByTool = new Map<string, number>();
  private toolCallsByUseId = new Map<
    string,
    {
      toolName: string;
      intent: CanonicalToolIntent;
      args: unknown;
      producerFingerprint: string;
    }
  >();
  private suppressedToolUseIds = new Set<string>();

  constructor(input: PiAgentBackendInput) {
    this.input = input;
    this.sessionId = input.sessionId;
    this.newId = input.newId ?? (() => crypto.randomUUID());
    this.now = input.now ?? (() => Date.now());
  }

  [RUNTIME_BIND_HOSTED_RUN](control: RuntimeHostedRunControl): RuntimeHostedBackendRunBinding {
    if (this.input.execution.kind !== 'hosted') {
      throw new RuntimeInteractionInvariantError(
        'Cannot bind hosted control to embedded Pi backend',
      );
    }
    if (this.hostedRun) {
      throw new RuntimeInteractionInvariantError(
        `Pi backend already owns hosted run ${this.hostedRun.runId}`,
      );
    }
    if (typeof this.input.transport.isolateRegisteredSuccessorSideEffects !== 'function') {
      throw new RuntimeInteractionInvariantError(
        'Hosted Pi transport must acknowledge registered successor-side-effect isolation',
      );
    }
    this.hostedRun = control;
    let revoked = false;
    return {
      isolateRegisteredSuccessorEffects: (cause) =>
        cause.kind === 'fail_stop'
          ? this.installInteractionFailStop(cause.error)
          : this.isolateTransportSuccessorSideEffects(),
      revoke: () => {
        if (revoked) return;
        revoked = true;
        if (this.hostedRun === control) this.hostedRun = null;
      },
    };
  }

  private installInteractionFailStop(error: RuntimeInteractionFailStopError): Promise<void> {
    this.interactionFailure = error;
    const turnId = this.currentTurnId;
    let cancellationFailure: { error: unknown } | undefined;
    if (turnId !== null) {
      try {
        this.input.permissionEngine.rejectPending(turnId, error);
      } catch (cancellationError) {
        cancellationFailure = { error: cancellationError };
      }
    }
    let transportStop: Promise<void>;
    try {
      transportStop = Promise.resolve(this.input.transport.stop?.('redirect'));
    } catch (transportError) {
      transportStop = Promise.reject(transportError);
    }
    return settlePiIsolation([
      cancellationFailure ? Promise.reject(cancellationFailure.error) : Promise.resolve(),
      transportStop,
      this.isolateTransportSuccessorSideEffects(),
    ]);
  }

  private isolateTransportSuccessorSideEffects(): Promise<void> {
    const isolate = this.input.transport.isolateRegisteredSuccessorSideEffects;
    if (!isolate) {
      return Promise.reject(
        new RuntimeInteractionInvariantError(
          'Hosted Pi transport has no successor-side-effect isolation acknowledgment',
        ),
      );
    }
    try {
      return Promise.resolve(isolate.call(this.input.transport));
    } catch (error) {
      return Promise.reject(error);
    }
  }

  async *send(input: BackendSendInput): AsyncIterable<SessionEvent> {
    const hostedRun =
      this.input.execution.kind === 'hosted' ? this.requireHostedRunControl() : undefined;
    if (hostedRun && !input.runId) {
      throw new RuntimeInteractionInvariantError(
        'Runtime Interaction authority requires an active Pi run',
      );
    }
    if (hostedRun && (this.currentTurnId !== null || this.currentRunId !== null)) {
      throw new RuntimeInteractionInvariantError(
        `Pi backend still owns Interaction state for run ${this.currentRunId ?? 'unknown'}`,
      );
    }
    if (hostedRun && (hostedRun.runId !== input.runId || hostedRun.turnId !== input.turnId)) {
      throw new RuntimeInteractionInvariantError(
        `Pi hosted control ${hostedRun.runId}/${hostedRun.turnId} does not match send ${input.runId}/${input.turnId}`,
      );
    }
    const turnId = input.turnId;
    let messageId = this.newId();
    let currentProviderMessageId: string | undefined;
    const usedMessageIds = new Set([messageId]);
    let assistantText = '';
    let assistantPersisted = false;
    let textCompleteEmitted = false;
    let stepHasTools = false;
    const activeToolUseIds = new Set<string>();
    this.stopped = false;
    this.interactionFailure = null;
    this.currentTurnId = turnId;
    this.outputSeqByTool = new Map();
    this.toolCallsByUseId = new Map();
    this.suppressedToolUseIds = new Set();
    this.input.permissionEngine.beginTurn(turnId);
    this.currentRunId = input.runId ?? null;
    this.turnStreamActive = true;

    const beginStep = (preferredMessageId?: string, nextProviderMessageId?: string): void => {
      let nextMessageId = preferredMessageId;
      while (!nextMessageId || usedMessageIds.has(nextMessageId)) nextMessageId = this.newId();
      messageId = nextMessageId;
      currentProviderMessageId = nextProviderMessageId;
      usedMessageIds.add(messageId);
      assistantText = '';
      assistantPersisted = false;
      textCompleteEmitted = false;
      stepHasTools = false;
      activeToolUseIds.clear();
    };
    const persistAssistant = async (): Promise<void> => {
      if (assistantPersisted || assistantText.length === 0) return;
      await this.appendAssistant(turnId, messageId, assistantText);
      assistantPersisted = true;
    };
    const completeStepText = async (): Promise<
      Extract<SessionEvent, { type: 'text_complete' }> | undefined
    > => {
      if (textCompleteEmitted || assistantText.length === 0) return undefined;
      await persistAssistant();
      textCompleteEmitted = true;
      return {
        type: 'text_complete',
        id: this.newId(),
        turnId,
        ts: this.now(),
        messageId,
        text: assistantText,
      };
    };
    const prepareTextStep = (providerMessageId?: string): void => {
      const stepEnded = textCompleteEmitted || (stepHasTools && activeToolUseIds.size === 0);
      if (stepEnded) {
        const preferredMessageId =
          providerMessageId !== currentProviderMessageId ? providerMessageId : undefined;
        beginStep(preferredMessageId, providerMessageId);
      } else if (providerMessageId && providerMessageId !== currentProviderMessageId) {
        beginStep(providerMessageId, providerMessageId);
      }
    };

    try {
      for await (const rawFrame of this.input.transport.send({
        sessionId: this.sessionId,
        turnId,
        cwd: this.input.header.cwd,
        text: input.text,
      })) {
        if (this.stopped) {
          await persistAssistant();
          yield this.abortEvent(turnId);
          yield this.completeEvent(turnId, 'user_stop');
          return;
        }

        const frame = normalizePiAgentFrame(rawFrame);
        if (!frame) continue;

        switch (frame.type) {
          case 'text_delta': {
            prepareTextStep(frame.messageId);
            const text = redactBoundedText(frame.text);
            assistantText += text;
            yield {
              type: 'text_delta',
              id: this.newId(),
              turnId,
              ts: this.now(),
              messageId,
              text,
            };
            break;
          }
          case 'text_complete': {
            prepareTextStep(frame.messageId);
            const text = redactBoundedText(frame.text ?? assistantText);
            assistantText = text;
            const complete = await completeStepText();
            if (complete) yield complete;
            break;
          }
          case 'tool_start': {
            const frameArgs = structuredClone(frame.args);
            const suppressed = this.suppressedToolUseIds.has(frame.toolUseId);
            if (!suppressed) await persistAssistant();
            const intent = await this.ensureToolCall(
              turnId,
              frame.toolUseId,
              frame.toolName,
              frameArgs,
              {
                ...(frame.displayName ? { displayName: frame.displayName } : {}),
                stepId: messageId,
              },
            );
            if (suppressed) break;
            stepHasTools = true;
            activeToolUseIds.add(frame.toolUseId);
            const review = optionalPiToolReview(intent);
            yield {
              type: 'tool_start',
              id: this.newId(),
              turnId,
              ts: this.now(),
              toolUseId: frame.toolUseId,
              toolName: frame.toolName,
              ...(this.input.execution.kind === 'embedded'
                ? { args: structuredClone(this.toolCallsByUseId.get(frame.toolUseId)!.args) }
                : {}),
              ...(review === undefined ? {} : { review }),
              ...(frame.displayName ? { displayName: frame.displayName } : {}),
              stepId: messageId,
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
            activeToolUseIds.delete(frame.toolUseId);
            if (stepHasTools && activeToolUseIds.size === 0) {
              const complete = await completeStepText();
              if (complete) yield complete;
            }
            break;
          }
          case 'token_usage': {
            const event = this.tokenUsageEvent(turnId, frame);
            await this.appendMessage(event);
            yield event;
            break;
          }
          case 'permission_request': {
            yield* this.handlePermissionRequest(turnId, frame);
            break;
          }
          case 'error': {
            const failure = Object.assign(new Error(frame.message), {
              name: frame.code ?? 'PiAgentError',
            });
            this.claimRunFailure(turnId, failure);
            await persistAssistant();
            yield {
              type: 'error',
              id: this.newId(),
              turnId,
              ts: this.now(),
              recoverable: false,
              ...(frame.code ? { code: frame.code } : {}),
              reason: 'pi_agent_error',
              message: redactBoundedText(frame.message),
              ...(frame.details
                ? { details: redactUnknown(frame.details) as Record<string, unknown> }
                : {}),
            };
            yield this.completeEvent(turnId, 'error');
            return;
          }
          case 'complete': {
            const complete = await completeStepText();
            if (complete) yield complete;
            yield this.completeEvent(turnId, frame.stopReason ?? 'end_turn');
            return;
          }
        }
      }

      const complete = await completeStepText();
      if (complete) yield complete;
      yield this.completeEvent(turnId, 'end_turn');
    } catch (error) {
      if (this.interactionFailure) throw this.interactionFailure;
      if (isRuntimeLifecycleAdmission(error)) {
        this.claimRunFailure(turnId, error);
        throw error;
      }
      if (isRuntimeLifecycleFatal(error)) {
        this.interactionFailure ??= error;
        throw error;
      }
      if (this.stopped) {
        await persistAssistant();
        yield this.abortEvent(turnId);
        yield this.completeEvent(turnId, 'user_stop');
        return;
      }
      this.claimRunFailure(turnId, error);
      await persistAssistant();
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
      try {
        if (this.interactionFailure) throw this.interactionFailure;
        this.finishTurn(turnId);
      } finally {
        this.turnStreamActive = false;
      }
    }
  }

  async stop(reason: 'user_stop' | 'redirect'): Promise<void> {
    if (this.interactionFailure) throw this.interactionFailure;
    this.stopped = true;
    const turnId = this.currentTurnId;
    const [transportResult] = await Promise.allSettled([
      this.input.transport.stop?.(reason) ?? Promise.resolve(),
    ]);
    if (turnId !== null && this.currentTurnId === turnId) {
      if (this.turnStreamActive) {
        this.input.permissionEngine.endTurn(turnId, 'aborted');
      } else {
        this.finishTurn(turnId);
      }
    }
    if (transportResult.status === 'rejected') throw transportResult.reason;
  }

  async respondToPermission(decision: PermissionDecision): Promise<void> {
    if (this.input.execution.kind === 'hosted') {
      throw new RuntimeInteractionInvariantError(
        'Hosted permission answers must use the captured continuation',
      );
    }
    if (this.currentTurnId === null) return;
    this.input.permissionEngine.recordResponse(this.currentTurnId, decision);
  }

  async dispose(): Promise<void> {
    if (this.interactionFailure) throw this.interactionFailure;
    const turnId = this.currentTurnId;
    if (turnId !== null) this.stopped = true;
    const [transportResult] = await Promise.allSettled([
      this.input.transport.dispose?.() ?? Promise.resolve(),
    ]);
    if (turnId !== null && this.currentTurnId === turnId) {
      if (this.turnStreamActive) {
        this.input.permissionEngine.endTurn(turnId, 'aborted');
      } else {
        this.finishTurn(turnId);
      }
    }
    if (transportResult.status === 'rejected') throw transportResult.reason;
  }

  private async *handlePermissionRequest(
    turnId: string,
    frame: Extract<PiAgentFrame, { type: 'permission_request' }>,
  ): AsyncIterable<SessionEvent> {
    const frameArgs = structuredClone(frame.args);
    const intent = await this.ensureToolCall(
      turnId,
      frame.toolUseId,
      frame.toolName,
      frameArgs,
      frame.categoryHint ? { categoryHint: frame.categoryHint } : {},
    );
    const hostedRun =
      this.input.execution.kind === 'hosted' ? this.requireHostedRunControl() : undefined;
    const hostedRunId = hostedRun?.runId;
    const verdict = this.input.permissionEngine.evaluate({
      stage: 'base',
      sessionId: this.sessionId,
      turnId,
      toolUseId: frame.toolUseId,
      intent,
      mode: this.input.header.permissionMode,
    });

    if (verdict.kind === 'block') {
      this.suppressedToolUseIds.add(frame.toolUseId);
      const content: ToolResultContent = { kind: 'text', text: redactBoundedText(verdict.reason) };
      await this.appendToolResult(turnId, frame.toolUseId, true, content);
      yield this.toolResultEvent(turnId, frame.toolUseId, true, content);
      return;
    }

    if (verdict.kind === 'allow') return;

    if (hostedRun) {
      void verdict.parked.catch(() => undefined);
      const continuation = this.createPermissionContinuation(
        hostedRunId!,
        turnId,
        verdict.event.requestId,
      );
      try {
        await hostedRun.interactions.acceptPermissionRequest({
          request: verdict.event,
          ...(verdict.rememberScopeId ? { rememberScopeId: verdict.rememberScopeId } : {}),
          continuation,
        });
      } catch (error) {
        let rejected = false;
        try {
          rejected =
            this.input.permissionEngine.rejectRequest(
              turnId,
              verdict.event.requestId,
              error instanceof Error ? error : new Error(String(error)),
            ) !== null;
        } catch {
          // Admission authority is the primary failure; local cleanup is best-effort.
        }
        if (isRuntimeLifecycleAdmission(error)) {
          this.claimRunFailure(turnId, error);
        }
        if (rejected) await verdict.parked.catch(() => undefined);
        if (isRuntimeLifecycleAdmissionOrFatal(error)) {
          throw error;
        }
        throw new RuntimeInteractionFailStopError(
          `Could not confirm admission for Pi permission ${verdict.event.requestId}`,
          error,
        );
      }
    }
    yield verdict.event;
    let response: PermissionDecision;
    try {
      response = await verdict.parked;
    } catch (error) {
      if (isRuntimeLifecycleFatal(error)) {
        this.interactionFailure ??= error;
        throw error;
      }
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
      ...(response.rememberForTurn !== undefined
        ? { rememberForTurn: response.rememberForTurn }
        : {}),
    };
    await this.appendMessage(decisionMsg);
    yield {
      type: 'permission_decision_ack',
      id: this.newId(),
      turnId,
      ts: this.now(),
      requestId: response.requestId,
      toolUseId: frame.toolUseId,
      decision: response.decision,
      ...(response.rememberForTurn !== undefined
        ? { rememberForTurn: response.rememberForTurn }
        : {}),
    };

    if (response.decision === 'deny') {
      this.suppressedToolUseIds.add(frame.toolUseId);
      const content: ToolResultContent = { kind: 'text', text: '用户已拒绝权限请求' };
      await this.appendToolResult(turnId, frame.toolUseId, true, content);
      yield this.toolResultEvent(turnId, frame.toolUseId, true, content);
    }
  }

  private requireHostedRunControl(): RuntimeHostedRunControl {
    if (!this.hostedRun) {
      throw new RuntimeInteractionInvariantError(
        'Hosted Pi backend has no bound RunExecution control',
      );
    }
    return this.hostedRun;
  }

  private createPermissionContinuation(
    runId: string,
    turnId: string,
    requestId: string,
  ): RuntimePermissionContinuation {
    return Object.freeze({
      runId,
      turnId,
      requestId,
      applyAnswer: (answer: RuntimePermissionAnswer): void => {
        if (Object.hasOwn(answer, 'requestId')) {
          throw new RuntimeInteractionInvariantError(
            `Pi permission continuation ${requestId} received a routed answer`,
          );
        }
        const applied = this.input.permissionEngine.recordResponse(
          turnId,
          piPermissionResponse(requestId, answer),
          { resolveRememberedSiblings: false },
        );
        if (!applied) {
          throw new RuntimeInteractionInvariantError(
            `Pi permission continuation did not take ${requestId} from turn ${turnId}`,
          );
        }
      },
      applyClosure: (reason: RuntimeInteractionClosureReason): void => {
        const applied = this.input.permissionEngine.closeRequest(turnId, requestId, reason);
        if (!applied) {
          throw new RuntimeInteractionInvariantError(
            `Pi permission closure did not take ${requestId} from turn ${turnId}`,
          );
        }
      },
    });
  }

  private finishTurn(turnId: string): void {
    if (this.currentTurnId !== turnId) return;
    this.input.permissionEngine.endTurn(turnId, this.stopped ? 'aborted' : 'completed');
    this.currentTurnId = null;
    this.currentRunId = null;
    this.outputSeqByTool.clear();
    this.toolCallsByUseId.clear();
    this.suppressedToolUseIds.clear();
    this.interactionFailure = null;
    this.stopped = false;
  }

  private async appendMessage(message: Parameters<AppendMessageFn>[0]): Promise<void> {
    this.throwIfInteractionFailed();
    await this.input.appendMessage(message);
    this.throwIfInteractionFailed();
  }

  private throwIfInteractionFailed(): void {
    if (this.interactionFailure) throw this.interactionFailure;
  }

  private claimRunFailure(turnId: string, error: unknown): void {
    if (this.input.execution.kind === 'embedded') return;
    const control = this.requireHostedRunControl();
    if (control.turnId !== turnId) {
      throw new RuntimeInteractionInvariantError(
        `Pi failure turn ${turnId} does not match hosted run ${control.runId}/${control.turnId}`,
      );
    }
    control.claimFailure(error);
  }

  private async ensureToolCall(
    turnId: string,
    toolUseId: string,
    toolName: string,
    args: unknown,
    metadata: {
      categoryHint?: ToolCategory;
      displayName?: string;
      stepId?: string;
    } = {},
  ): Promise<CanonicalToolIntent> {
    const producerArgs = preparePiIntentArgs(toolName, args);
    const producerFingerprint = stableHash(producerArgs ?? null);
    const existing = this.toolCallsByUseId.get(toolUseId);
    if (existing) {
      if (existing.toolName !== toolName || existing.producerFingerprint !== producerFingerprint) {
        throw new Error(`Pi tool call ${toolUseId} changed after its first frame`);
      }
      return existing.intent;
    }
    let intent: CanonicalToolIntent;
    try {
      intent = createCanonicalToolIntent({
        toolName,
        args: producerArgs,
        cwd: this.input.header.cwd,
        ...(metadata.categoryHint === undefined ? {} : { categoryHint: metadata.categoryHint }),
      });
    } catch {
      throw new RuntimeInteractionAdmissionRejectedError(toolUseId, 'invalid_request');
    }
    const privateArgs = structuredClone(args);
    this.toolCallsByUseId.set(toolUseId, {
      toolName,
      intent,
      args: privateArgs,
      producerFingerprint,
    });
    const review = optionalPiToolReview(intent);
    await this.appendMessage({
      type: 'tool_call',
      id: toolUseId,
      turnId,
      ts: this.now(),
      toolName,
      ...(this.input.execution.kind === 'embedded' ? { args: structuredClone(privateArgs) } : {}),
      ...(metadata.displayName ? { displayName: metadata.displayName } : {}),
      ...(review === undefined ? {} : { review }),
      ...(metadata.stepId ? { stepId: metadata.stepId } : {}),
    } satisfies ToolCallMessage);
    return intent;
  }

  private async appendAssistant(turnId: string, messageId: string, text: string): Promise<void> {
    await this.appendMessage({
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
    await this.appendMessage({
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

  private tokenUsageEvent(
    turnId: string,
    frame: Extract<PiAgentFrame, { type: 'token_usage' }>,
  ): TokenUsageMessage {
    const cacheHitInput = frame.cacheHitInput ?? 0;
    const cacheWriteInput = frame.cacheWriteInput ?? 0;
    return {
      type: 'token_usage',
      id: this.newId(),
      turnId,
      ts: this.now(),
      input: frame.input,
      output: frame.output,
      ...(cacheHitInput > 0 ? { cacheHitInput, cacheRead: cacheHitInput } : {}),
      ...(frame.cacheMissInput !== undefined
        ? { cacheMissInput: frame.cacheMissInput, cacheMissInputSource: 'explicit' }
        : {}),
      ...(cacheWriteInput > 0 ? { cacheWriteInput, cacheCreation: cacheWriteInput } : {}),
      ...(frame.reasoning !== undefined ? { reasoning: frame.reasoning } : {}),
      ...(frame.total !== undefined ? { total: frame.total } : {}),
      ...(frame.costUsd !== undefined ? { costUsd: frame.costUsd } : {}),
    };
  }

  private abortEvent(turnId: string): SessionEvent {
    return { type: 'abort', id: this.newId(), turnId, ts: this.now(), reason: 'user_stop' };
  }

  private completeEvent(
    turnId: string,
    stopReason: 'end_turn' | 'user_stop' | 'error' | 'max_tokens',
  ): SessionEvent {
    return { type: 'complete', id: this.newId(), turnId, ts: this.now(), stopReason };
  }
}

function piPermissionResponse(
  requestId: string,
  answer: RuntimePermissionAnswer,
): PermissionDecision {
  return {
    requestId,
    decision: answer.decision,
    ...(answer.rememberForTurn !== undefined ? { rememberForTurn: answer.rememberForTurn } : {}),
    ...(answer.reviewer !== undefined ? { reviewer: answer.reviewer } : {}),
    ...(answer.riskLevel !== undefined ? { riskLevel: answer.riskLevel } : {}),
  };
}

function optionalPiToolReview(intent: CanonicalToolIntent): PublicToolIntentReview | undefined {
  try {
    return projectPublicToolIntentReview(intent);
  } catch (error) {
    if (error instanceof InteractionPermissionProjectionError) return undefined;
    throw error;
  }
}

function preparePiIntentArgs(toolName: string, args: unknown): unknown {
  if (toolName !== 'agent_spawn' || !args || typeof args !== 'object' || Array.isArray(args)) {
    return args;
  }
  const input = args as Record<string, unknown>;
  if (typeof input.profile !== 'string') return args;
  const definition = requireBuiltinAgentDefinitionByProfile(input.profile);
  return {
    ...input,
    write_back: input.write_back ?? definition.contract.defaultWriteBack,
    isolation: input.isolation ?? definition.contract.workspace,
  };
}

export function normalizePiAgentFrame(frame: unknown): PiAgentFrame | null {
  if (!frame || typeof frame !== 'object') return null;
  const value = frame as Record<string, unknown>;
  const type = typeof value.type === 'string' ? value.type : undefined;
  if (type === 'text_delta' && typeof value.text === 'string') {
    return {
      type,
      text: value.text,
      ...(typeof value.messageId === 'string' ? { messageId: value.messageId } : {}),
    };
  }
  if (type === 'text_complete') {
    return {
      type,
      ...(typeof value.text === 'string' ? { text: value.text } : {}),
      ...(typeof value.messageId === 'string' ? { messageId: value.messageId } : {}),
    };
  }
  if (
    type === 'tool_start' &&
    typeof value.toolUseId === 'string' &&
    typeof value.toolName === 'string'
  ) {
    return {
      type,
      toolUseId: value.toolUseId,
      toolName: value.toolName,
      args: value.args ?? null,
      ...(typeof value.displayName === 'string' ? { displayName: value.displayName } : {}),
    };
  }
  if (
    type === 'tool_output_delta' &&
    typeof value.toolUseId === 'string' &&
    typeof value.chunk === 'string'
  ) {
    const stream = value.stream === 'stderr' ? 'stderr' : 'stdout';
    return { type, toolUseId: value.toolUseId, stream, chunk: value.chunk };
  }
  if (type === 'tool_result' && typeof value.toolUseId === 'string') {
    return {
      type,
      toolUseId: value.toolUseId,
      isError: value.isError === true,
      content: value.content ?? null,
    };
  }
  if (type === 'token_usage') {
    const input = finiteNumber(value.input);
    const output = finiteNumber(value.output);
    if (input === undefined || output === undefined) return null;
    return {
      type,
      input,
      output,
      ...numberField('cacheHitInput', value.cacheHitInput),
      ...numberField('cacheMissInput', value.cacheMissInput),
      ...numberField('cacheWriteInput', value.cacheWriteInput),
      ...numberField('reasoning', value.reasoning),
      ...numberField('total', value.total),
      ...numberField('costUsd', value.costUsd),
    };
  }
  if (
    type === 'permission_request' &&
    typeof value.toolUseId === 'string' &&
    typeof value.toolName === 'string'
  ) {
    return {
      type,
      toolUseId: value.toolUseId,
      toolName: value.toolName,
      args: value.args ?? null,
      ...(isToolCategory(value.categoryHint) ? { categoryHint: value.categoryHint } : {}),
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
    const stopReason =
      value.stopReason === 'error' || value.stopReason === 'max_tokens'
        ? value.stopReason
        : 'end_turn';
    return { type, stopReason };
  }
  return null;
}

function numberField<K extends string>(key: K, value: unknown): { [P in K]?: number } {
  const number = finiteNumber(value);
  return number === undefined ? {} : ({ [key]: number } as { [P in K]?: number });
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function normalizeToolResultContent(content: unknown): ToolResultContent {
  if (typeof content === 'string') return { kind: 'text', text: redactBoundedText(content) };
  const redacted = redactUnknown(content ?? null);
  try {
    return decodeCanonicalToolResultContent(redacted);
  } catch {
    return { kind: 'json', value: redacted };
  }
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

async function settlePiIsolation(tasks: readonly Promise<unknown>[]): Promise<void> {
  let failure: { error: unknown } | undefined;
  await Promise.all(
    tasks.map(async (task) => {
      try {
        await task;
      } catch (error) {
        failure ??= { error };
      }
    }),
  );
  if (failure) throw failure.error;
}
