import { randomUUID } from 'node:crypto';
import type { BackendKind, SessionEvent, SessionHeader, StoredMessage } from '@maka/core';
import type { BackendSendInput, PermissionDecision } from '@maka/core/backend-types';
import type { AgentBackend } from './ai-sdk-backend.js';
import type { SessionStore } from './session-manager.js';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export class FakeBackend implements AgentBackend {
  readonly kind: BackendKind = 'fake';
  readonly sessionId: string;
  private stopped = false;

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
    const turnId = input.turnId;
    const messageId = randomUUID();
    const attNames = (input.attachments ?? []).map((a) => a.name);
    const attLine = attNames.length > 0 ? `\nAttachments received: ${attNames.join(', ')}` : '';
    const text = `Fake backend received: ${input.text}${attLine}\n\nThis proves the session stream, JSONL storage, and renderer loop are connected.`;
    const chunks = text.match(/.{1,9}/g) ?? [text];

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
  }

  async respondToPermission(_decision: PermissionDecision): Promise<void> {}

  async dispose(): Promise<void> {}
}
