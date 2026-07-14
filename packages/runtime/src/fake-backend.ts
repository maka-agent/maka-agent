import { randomUUID } from 'node:crypto';
import type { BackendKind, SessionEvent, SessionHeader, StoredMessage } from '@maka/core';
import type { AgentBackend, BackendSendInput, PermissionDecision } from '@maka/core/backend-types';
import type { UserQuestionResponse } from '@maka/core/user-question';
import type { SessionStore } from './session-manager.js';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
export const FAKE_ASK_USER_QUESTION_PROMPT = '__e2e_ask_user_question__';

type PendingQuestion = {
  requestId: string;
  resolve(response: UserQuestionResponse | null): void;
};

export class FakeBackend implements AgentBackend {
  readonly kind: BackendKind = 'fake';
  readonly sessionId: string;
  private stopped = false;
  private pendingQuestion: PendingQuestion | undefined;

  constructor(private readonly ctx: {
    sessionId: string;
    header: SessionHeader;
    store: SessionStore;
    appendMessage?: (message: StoredMessage) => Promise<void>;
  }) {
    this.sessionId = ctx.sessionId;
  }

  async *send(input: BackendSendInput): AsyncIterable<SessionEvent> {
    this.stopped = false;
    if (input.text === FAKE_ASK_USER_QUESTION_PROMPT) {
      yield* this.sendQuestionScenario(input);
      return;
    }
    const turnId = input.turnId;
    const messageId = randomUUID();
    const attNames = (input.attachments ?? []).map((a) => a.name);
    const attLine = attNames.length > 0 ? `\nAttachments received: ${attNames.join(', ')}` : '';
    const text = `Fake backend received: ${input.text}${attLine}\n\nThis proves the session stream, JSONL storage, and renderer loop are connected.`;
    // Every delta must concatenate to text_complete; `.` would silently drop
    // line terminators and make structured Markdown reflow only at completion.
    const chunks = text.match(/[\s\S]{1,9}/g) ?? [text];

    for (const chunk of chunks) {
      if (this.stopped) {
        yield { type: 'abort', id: randomUUID(), turnId, ts: Date.now(), reason: 'user_stop' };
        yield { type: 'complete', id: randomUUID(), turnId, ts: Date.now(), stopReason: 'user_stop' };
        return;
      }
      await sleep(45);
      yield { type: 'text_delta', id: randomUUID(), turnId, ts: Date.now(), messageId, text: chunk };
    }

    const ts = Date.now();
    const appendMessage = this.ctx.appendMessage ?? ((message: StoredMessage) =>
      this.ctx.store.appendMessage(this.sessionId, message));
    await appendMessage({
      type: 'assistant',
      id: messageId,
      turnId,
      ts,
      text,
      modelId: this.ctx.header.model,
    });
    yield { type: 'text_complete', id: randomUUID(), turnId, ts, messageId, text };
    yield { type: 'complete', id: randomUUID(), turnId, ts: Date.now(), stopReason: 'end_turn' };
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.pendingQuestion?.resolve(null);
    this.pendingQuestion = undefined;
  }

  async respondToPermission(_decision: PermissionDecision): Promise<void> {}

  async respondToUserQuestion(response: UserQuestionResponse): Promise<void> {
    if (this.pendingQuestion?.requestId !== response.requestId) return;
    const pending = this.pendingQuestion;
    this.pendingQuestion = undefined;
    pending.resolve(response);
  }

  async dispose(): Promise<void> {}

  private async *sendQuestionScenario(input: BackendSendInput): AsyncIterable<SessionEvent> {
    // A real model needs time to produce its first tool call. Mirror that
    // boundary so a newly-created Desktop session can mount its event
    // subscription before this deterministic fake emits the request.
    await sleep(100);
    const turnId = input.turnId;
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
    const appendMessage = this.ctx.appendMessage ?? ((message: StoredMessage) =>
      this.ctx.store.appendMessage(this.sessionId, message));
    const startedAt = Date.now();
    await appendMessage({
      type: 'tool_call',
      id: toolUseId,
      turnId,
      stepId,
      ts: startedAt,
      toolName: 'AskUserQuestion',
      args: { questions },
    });
    yield {
      type: 'tool_start',
      id: randomUUID(),
      turnId,
      stepId,
      ts: startedAt,
      toolUseId,
      toolName: 'AskUserQuestion',
      args: { questions },
    };

    let resolveResponse!: (response: UserQuestionResponse | null) => void;
    const responsePromise = new Promise<UserQuestionResponse | null>((resolve) => {
      resolveResponse = resolve;
    });
    this.pendingQuestion = { requestId, resolve: resolveResponse };
    yield {
      type: 'user_question_request',
      id: randomUUID(),
      turnId,
      ts: Date.now(),
      requestId,
      toolUseId,
      questions,
    };

    const response = await responsePromise;
    if (this.pendingQuestion?.requestId === requestId) this.pendingQuestion = undefined;
    if (!response || this.stopped) {
      yield { type: 'abort', id: randomUUID(), turnId, ts: Date.now(), reason: 'user_stop' };
      yield { type: 'complete', id: randomUUID(), turnId, ts: Date.now(), stopReason: 'user_stop' };
      return;
    }

    const result = {
      answers: questions.map((question, index) => ({ question: question.question, answer: response.answers[index] ?? null })),
    };
    const resultContent = { kind: 'json' as const, value: result };
    const resultTs = Date.now();
    await appendMessage({
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
      yield { type: 'text_delta', id: randomUUID(), turnId, ts: Date.now(), messageId, text: chunk };
    }
    const completedAt = Date.now();
    await appendMessage({
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
}
