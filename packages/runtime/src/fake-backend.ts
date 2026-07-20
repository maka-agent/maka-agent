import { randomUUID } from 'node:crypto';
import type {
  BackendKind,
  SessionEvent,
  SessionHeader,
  StoredMessage,
  UserQuestionRequestEvent,
} from '@maka/core';
import { projectPublicToolIntentReview } from '@maka/core';
import type { AgentBackend, BackendSendInput, PermissionDecision } from '@maka/core/backend-types';
import { createCanonicalToolIntent } from '@maka/core/permission';
import type { UserQuestionResponse } from '@maka/core/user-question';
import type { SessionStore } from './session-manager.js';
import {
  RuntimeInteractionClosedError,
  RuntimeInteractionFailStopError,
  RuntimeInteractionInvariantError,
  type RuntimeInteractionClosureReason,
  type RuntimeInteractionFatalError,
  type RuntimeUserQuestionAnswer,
  type RuntimeUserQuestionContinuation,
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

export const FAKE_ASK_USER_QUESTION_PROMPT = '__e2e_ask_user_question__';

type PendingQuestion = {
  requestId: string;
  resolve(response: UserQuestionResponse | null): void;
  reject(error: unknown): void;
};

export class FakeBackend implements AgentBackend {
  readonly kind: BackendKind = 'fake';
  readonly sessionId: string;
  private stopped = false;
  private pendingQuestion: PendingQuestion | undefined;
  private currentTurnId: string | null = null;
  private currentRunId: string | null = null;
  private turnStreamActive = false;
  private interactionFailure: RuntimeInteractionFatalError | null = null;
  private hostedRun: RuntimeHostedRunControl | null = null;
  private readonly pendingDelays = new Set<{
    timer: ReturnType<typeof setTimeout>;
    reject(error: RuntimeInteractionFatalError): void;
  }>();

  constructor(
    private readonly ctx: {
      sessionId: string;
      header: SessionHeader;
      store: SessionStore;
      appendMessage?: (message: StoredMessage) => Promise<void>;
      execution: RuntimeBackendExecutionCapability;
    },
  ) {
    this.sessionId = ctx.sessionId;
  }

  [RUNTIME_BIND_HOSTED_RUN](control: RuntimeHostedRunControl): RuntimeHostedBackendRunBinding {
    if (this.ctx.execution.kind !== 'hosted') {
      throw new RuntimeInteractionInvariantError(
        'Cannot bind hosted control to embedded Fake backend',
      );
    }
    if (this.hostedRun) {
      throw new RuntimeInteractionInvariantError(
        `Fake backend already owns hosted run ${this.hostedRun.runId}`,
      );
    }
    this.hostedRun = control;
    let revoked = false;
    return {
      isolateRegisteredSuccessorEffects: (cause) =>
        cause.kind === 'fail_stop'
          ? this.installInteractionFailStop(cause.error)
          : Promise.resolve(),
      revoke: () => {
        if (revoked) return;
        revoked = true;
        if (this.hostedRun === control) this.hostedRun = null;
      },
    };
  }

  private installInteractionFailStop(error: RuntimeInteractionFailStopError): Promise<void> {
    this.interactionFailure = error;
    let cancellationFailure: { error: unknown } | undefined;
    const pending = this.pendingQuestion;
    if (pending) {
      this.pendingQuestion = undefined;
      try {
        pending.reject(error);
      } catch (error) {
        cancellationFailure = { error };
      }
    }
    try {
      this.rejectPendingDelays(error);
    } catch (delayError) {
      cancellationFailure ??= { error: delayError };
    }
    return cancellationFailure ? Promise.reject(cancellationFailure.error) : Promise.resolve();
  }

  async *send(input: BackendSendInput): AsyncIterable<SessionEvent> {
    const hostedRun =
      this.ctx.execution.kind === 'hosted' ? this.requireHostedRunControl() : undefined;
    if (hostedRun && !input.runId) {
      throw new RuntimeInteractionInvariantError(
        'Runtime Interaction authority requires an active Fake run',
      );
    }
    if (hostedRun && (this.currentTurnId !== null || this.currentRunId !== null)) {
      throw new RuntimeInteractionInvariantError(
        `Fake backend still owns Interaction state for run ${this.currentRunId ?? 'unknown'}`,
      );
    }
    if (hostedRun && (hostedRun.runId !== input.runId || hostedRun.turnId !== input.turnId)) {
      throw new RuntimeInteractionInvariantError(
        `Fake hosted control ${hostedRun.runId}/${hostedRun.turnId} does not match send ${input.runId}/${input.turnId}`,
      );
    }
    this.stopped = false;
    this.interactionFailure = null;
    this.currentTurnId = input.turnId;
    this.currentRunId = input.runId ?? null;
    this.turnStreamActive = true;
    try {
      yield* this.sendActiveTurn(input);
    } catch (error) {
      if (this.interactionFailure) throw this.interactionFailure;
      if (isRuntimeLifecycleFatal(error)) {
        this.interactionFailure ??= error;
      } else {
        this.claimRunFailure(input.turnId, error);
      }
      throw error;
    } finally {
      try {
        if (this.interactionFailure) throw this.interactionFailure;
        this.finishTurn(input.turnId);
      } finally {
        this.turnStreamActive = false;
      }
    }
  }

  private async *sendActiveTurn(input: BackendSendInput): AsyncIterable<SessionEvent> {
    if (input.text === FAKE_ASK_USER_QUESTION_PROMPT) {
      yield* this.sendQuestionScenario(input);
      return;
    }
    const turnId = input.turnId;
    const messageId = randomUUID();
    const attNames = (input.attachments ?? []).map((a) => a.name);
    const attLine = attNames.length > 0 ? `\nAttachments received: ${attNames.join(', ')}` : '';
    let text = `Fake backend received: ${input.text}${attLine}\n\nThis proves the session stream, JSONL storage, and renderer loop are connected.`;
    // Every delta must concatenate to text_complete; `.` would silently drop
    // line terminators and make structured Markdown reflow only at completion.
    const chunks = text.match(/[\s\S]{1,9}/g) ?? [text];

    // Mid-turn steering: drain the caller's pending steering at each step
    // boundary (here, between streamed chunks), echoing every message as a
    // `steering_message` so the ledger/transcript render the interjection, and
    // remembering them so the fake reply acknowledges them like a real model.
    const steered: string[] = [];
    // Lease accounting (backend-types contract): settlement is per LEASE,
    // never per batch. A lease is acked only after its OWN echoed event has
    // been received by the consumer — the fake has no durable ledger, so
    // consumption is its delivery boundary, and resuming past an event's
    // yield proves receipt. A consumer that detaches or throws lands in the
    // finally, which nacks exactly the leases whose events never crossed
    // their yield; batch settlement would nack an already-delivered lease
    // into a redelivery.
    const outstanding: string[] = [];
    const settleOutstanding = (leaseId: string): void => {
      const index = outstanding.indexOf(leaseId);
      if (index === -1) return;
      outstanding.splice(index, 1);
      input.ackSteering?.([leaseId]);
    };
    const drainSteering = (): Array<{ leaseId: string; event: SessionEvent }> => {
      const leases = input.pullSteering?.() ?? [];
      if (leases.length === 0) return [];
      outstanding.push(...leases.map((lease) => lease.id));
      return leases.map((lease) => {
        steered.push(lease.text);
        return {
          leaseId: lease.id,
          event: {
            type: 'steering_message',
            id: randomUUID(),
            turnId,
            ts: Date.now(),
            messageId: randomUUID(),
            text: lease.text,
          } satisfies SessionEvent,
        };
      });
    };

    try {
      for (const chunk of chunks) {
        if (this.stopped) {
          yield { type: 'abort', id: randomUUID(), turnId, ts: Date.now(), reason: 'user_stop' };
          yield {
            type: 'complete',
            id: randomUUID(),
            turnId,
            ts: Date.now(),
            stopReason: 'user_stop',
          };
          return;
        }
        await this.waitForDelay(45);
        for (const { leaseId, event } of drainSteering()) {
          yield event;
          settleOutstanding(leaseId);
        }
        yield {
          type: 'text_delta',
          id: randomUUID(),
          turnId,
          ts: Date.now(),
          messageId,
          text: chunk,
        };
      }

      // Final stranded drain (grok-build safety): a steer that landed after the
      // last boundary still lands in this turn instead of being lost.
      for (const { leaseId, event } of drainSteering()) {
        yield event;
        settleOutstanding(leaseId);
      }
      if (steered.length > 0) {
        const ack = `\n\nAcknowledged steering: ${steered.join(' | ')}`;
        text += ack;
        yield {
          type: 'text_delta',
          id: randomUUID(),
          turnId,
          ts: Date.now(),
          messageId,
          text: ack,
        };
      }

      const ts = Date.now();
      await this.appendMessage({
        type: 'assistant',
        id: messageId,
        turnId,
        ts,
        text,
        modelId: this.ctx.header.model,
      });
      yield { type: 'text_complete', id: randomUUID(), turnId, ts, messageId, text };
      yield { type: 'complete', id: randomUUID(), turnId, ts: Date.now(), stopReason: 'end_turn' };
    } finally {
      if (outstanding.length > 0) input.nackSteering?.(outstanding.splice(0));
    }
  }

  async stop(): Promise<void> {
    if (this.interactionFailure) throw this.interactionFailure;
    this.stopped = true;
    const turnId = this.currentTurnId;
    if (turnId !== null && !this.turnStreamActive && this.currentTurnId === turnId)
      this.finishTurn(turnId);
    if (this.ctx.execution.kind === 'embedded') {
      this.pendingQuestion?.resolve(null);
      this.pendingQuestion = undefined;
    }
  }

  async respondToPermission(_decision: PermissionDecision): Promise<void> {
    if (this.ctx.execution.kind === 'hosted') {
      throw new RuntimeInteractionInvariantError(
        'Hosted permission answers must use the captured continuation',
      );
    }
  }

  async respondToUserQuestion(response: UserQuestionResponse): Promise<void> {
    if (this.ctx.execution.kind === 'hosted') {
      throw new RuntimeInteractionInvariantError(
        'Hosted question answers must use the captured continuation',
      );
    }
    if (this.pendingQuestion?.requestId !== response.requestId) return;
    const pending = this.pendingQuestion;
    this.pendingQuestion = undefined;
    pending.resolve(response);
  }

  async dispose(): Promise<void> {
    if (this.interactionFailure) throw this.interactionFailure;
    if (this.currentTurnId !== null) await this.stop();
  }

  private async *sendQuestionScenario(input: BackendSendInput): AsyncIterable<SessionEvent> {
    // A real model needs time to produce its first tool call. Mirror that
    // boundary so a newly-created Desktop session can mount its event
    // subscription before this deterministic fake emits the request.
    await this.waitForDelay(100);
    const turnId = input.turnId;
    const hostedRun =
      this.ctx.execution.kind === 'hosted' ? this.requireHostedRunControl() : undefined;
    const hostedRunId = hostedRun?.runId;
    if (this.stopped) {
      yield { type: 'abort', id: randomUUID(), turnId, ts: Date.now(), reason: 'user_stop' };
      yield { type: 'complete', id: randomUUID(), turnId, ts: Date.now(), stopReason: 'user_stop' };
      return;
    }
    const toolUseId = randomUUID();
    const requestId = randomUUID();
    const stepId = randomUUID();
    const questions = [
      {
        question: '首批发布范围选哪个？',
        options: [
          { label: '邀请制', description: '先验证核心流程，再逐步扩大范围。' },
          { label: '公开测试', description: '允许所有访客注册，但保留 Beta 标识。' },
        ],
      },
      {
        question: '上线时间怎么安排？',
        options: [{ label: '本周' }, { label: '下周' }],
      },
      {
        question: '是否同步发布公告？',
        options: [{ label: '是' }, { label: '否' }],
      },
    ];
    const startedAt = Date.now();
    const intent = createCanonicalToolIntent({
      toolName: 'AskUserQuestion',
      args: { questions },
      cwd: this.ctx.header.cwd,
    });
    const review = projectPublicToolIntentReview(intent);
    await this.appendMessage({
      type: 'tool_call',
      id: toolUseId,
      turnId,
      stepId,
      ts: startedAt,
      toolName: 'AskUserQuestion',
      ...(review === undefined ? {} : { review }),
    });
    const toolStart: SessionEvent = {
      type: 'tool_start',
      id: randomUUID(),
      turnId,
      stepId,
      ts: startedAt,
      toolUseId,
      toolName: 'AskUserQuestion',
      ...(review === undefined ? {} : { review }),
    };

    let resolveResponse!: (response: UserQuestionResponse | null) => void;
    let rejectResponse!: (error: unknown) => void;
    const responsePromise = new Promise<UserQuestionResponse | null>((resolve, reject) => {
      resolveResponse = resolve;
      rejectResponse = reject;
    });
    if (hostedRun) void responsePromise.catch(() => undefined);
    this.pendingQuestion = { requestId, resolve: resolveResponse, reject: rejectResponse };
    const request: UserQuestionRequestEvent = {
      type: 'user_question_request',
      id: randomUUID(),
      turnId,
      ts: Date.now(),
      requestId,
      toolUseId,
      questions,
    };
    try {
      if (hostedRun) {
        await hostedRun.interactions.acceptUserQuestionRequest({
          request,
          continuation: this.createUserQuestionContinuation(hostedRunId!, turnId, requestId),
        });
      }
    } catch (error) {
      try {
        const pending = this.pendingQuestion;
        if (pending?.requestId === requestId) {
          this.pendingQuestion = undefined;
          pending.reject(error instanceof Error ? error : new Error(String(error)));
        }
      } catch {
        // Admission authority is the primary failure; local cleanup is best-effort.
      }
      if (isRuntimeLifecycleAdmissionOrFatal(error)) {
        if (isRuntimeLifecycleAdmission(error)) {
          this.claimRunFailure(turnId, error);
        }
        throw error;
      }
      throw new RuntimeInteractionFailStopError(
        `Could not confirm admission for Fake question ${requestId}`,
        error,
      );
    }
    yield toolStart;
    yield request;

    const response = await responsePromise;
    if (this.pendingQuestion?.requestId === requestId) this.pendingQuestion = undefined;
    if (!response || this.stopped) {
      yield { type: 'abort', id: randomUUID(), turnId, ts: Date.now(), reason: 'user_stop' };
      yield { type: 'complete', id: randomUUID(), turnId, ts: Date.now(), stopReason: 'user_stop' };
      return;
    }

    const result = {
      answers: questions.map((question, index) => ({
        question: question.question,
        answer: response.answers[index] ?? null,
      })),
    };
    const resultContent = { kind: 'json' as const, value: result };
    const resultTs = Date.now();
    await this.appendMessage({
      type: 'tool_result',
      id: randomUUID(),
      turnId,
      ts: resultTs,
      toolUseId,
      isError: false,
      content: resultContent,
    });
    yield {
      type: 'tool_result',
      id: randomUUID(),
      turnId,
      ts: resultTs,
      toolUseId,
      isError: false,
      content: resultContent,
    };

    const messageId = randomUUID();
    const text = `Fake question answers: ${response.answers.map((answer) => answer ?? '未回答').join(' / ')}`;
    for (const chunk of text.match(/[\s\S]{1,9}/g) ?? [text]) {
      yield {
        type: 'text_delta',
        id: randomUUID(),
        turnId,
        ts: Date.now(),
        messageId,
        text: chunk,
      };
    }
    const completedAt = Date.now();
    await this.appendMessage({
      type: 'assistant',
      id: messageId,
      turnId,
      ts: completedAt,
      text,
      modelId: this.ctx.header.model,
    });
    yield { type: 'text_complete', id: randomUUID(), turnId, ts: completedAt, messageId, text };
    yield { type: 'complete', id: randomUUID(), turnId, ts: Date.now(), stopReason: 'end_turn' };
  }

  private requireHostedRunControl(): RuntimeHostedRunControl {
    if (!this.hostedRun) {
      throw new RuntimeInteractionInvariantError(
        'Hosted Fake backend has no bound RunExecution control',
      );
    }
    return this.hostedRun;
  }

  private createUserQuestionContinuation(
    runId: string,
    turnId: string,
    requestId: string,
  ): RuntimeUserQuestionContinuation {
    return Object.freeze({
      runId,
      turnId,
      requestId,
      applyAnswer: (answer: RuntimeUserQuestionAnswer): void => {
        if (Object.hasOwn(answer, 'requestId')) {
          throw new RuntimeInteractionInvariantError(
            `Question continuation ${requestId} received a routed answer`,
          );
        }
        this.takePendingQuestion(requestId).resolve({
          requestId,
          answers: [...answer.answers],
        });
      },
      applyClosure: (reason: RuntimeInteractionClosureReason): void => {
        this.takePendingQuestion(requestId).reject(
          new RuntimeInteractionClosedError(requestId, reason),
        );
      },
    });
  }

  private takePendingQuestion(requestId: string): PendingQuestion {
    const pending = this.pendingQuestion;
    if (!pending || pending.requestId !== requestId) {
      throw new RuntimeInteractionInvariantError(`Question continuation did not take ${requestId}`);
    }
    this.pendingQuestion = undefined;
    return pending;
  }

  private finishTurn(turnId: string): void {
    if (this.currentTurnId !== turnId) return;
    if (this.ctx.execution.kind === 'embedded') {
      this.pendingQuestion?.resolve(null);
      this.pendingQuestion = undefined;
    }
    this.currentTurnId = null;
    this.currentRunId = null;
    this.interactionFailure = null;
    this.stopped = false;
  }

  private async waitForDelay(ms: number): Promise<void> {
    this.throwIfInteractionFailed();
    await new Promise<void>((resolve, reject) => {
      let pending!: {
        timer: ReturnType<typeof setTimeout>;
        reject(error: RuntimeInteractionFatalError): void;
      };
      const timer = setTimeout(() => {
        this.pendingDelays.delete(pending);
        resolve();
      }, ms);
      pending = {
        timer,
        reject: (error) => {
          clearTimeout(timer);
          this.pendingDelays.delete(pending);
          reject(error);
        },
      };
      this.pendingDelays.add(pending);
    });
    this.throwIfInteractionFailed();
  }

  private rejectPendingDelays(error: RuntimeInteractionFatalError): void {
    for (const pending of [...this.pendingDelays]) pending.reject(error);
  }

  private async appendMessage(message: StoredMessage): Promise<void> {
    this.throwIfInteractionFailed();
    const append =
      this.ctx.appendMessage ??
      ((next: StoredMessage) => this.ctx.store.appendMessage(this.sessionId, next));
    await append(message);
    this.throwIfInteractionFailed();
  }

  private throwIfInteractionFailed(): void {
    if (this.interactionFailure) throw this.interactionFailure;
  }

  private claimRunFailure(turnId: string, error: unknown): void {
    if (this.ctx.execution.kind === 'embedded') return;
    const control = this.requireHostedRunControl();
    if (control.turnId !== turnId) {
      throw new RuntimeInteractionInvariantError(
        `Fake failure turn ${turnId} does not match hosted run ${control.runId}/${control.turnId}`,
      );
    }
    control.claimFailure(error);
  }
}
