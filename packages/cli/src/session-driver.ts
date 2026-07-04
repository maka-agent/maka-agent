import { randomUUID } from 'node:crypto';
import type { SessionEvent } from '@maka/core/events';
import type { CreateSessionInput, UserMessageInput } from '@maka/core/runtime-inputs';
import type { SessionSummary } from '@maka/core/session';

export interface MakaSessionRuntime {
  createSession(input: CreateSessionInput): Promise<SessionSummary>;
  sendMessage(sessionId: string, input: UserMessageInput): AsyncIterable<SessionEvent>;
  stopSession(sessionId: string, input?: { source?: 'stop_button' }): Promise<void>;
}

export interface MakaSessionDriverInput {
  runtime: MakaSessionRuntime;
  cwd: string;
  llmConnectionSlug: string;
  model: string;
  newId?: () => string;
}

export interface MakaSessionDriver {
  sendPrompt(prompt: string): AsyncIterable<SessionEvent>;
  stop(): Promise<void>;
  getSessionId(): string | null;
}

export function createMakaSessionDriver(input: MakaSessionDriverInput): MakaSessionDriver {
  return new RuntimeMakaSessionDriver(input);
}

class RuntimeMakaSessionDriver implements MakaSessionDriver {
  private sessionId: string | null = null;
  private readonly newId: () => string;

  constructor(private readonly input: MakaSessionDriverInput) {
    this.newId = input.newId ?? randomUUID;
  }

  async *sendPrompt(prompt: string): AsyncIterable<SessionEvent> {
    const sessionId = await this.ensureSession(prompt);
    yield* this.input.runtime.sendMessage(sessionId, {
      turnId: this.newId(),
      text: prompt,
    });
  }

  async stop(): Promise<void> {
    if (!this.sessionId) return;
    await this.input.runtime.stopSession(this.sessionId, { source: 'stop_button' });
  }

  getSessionId(): string | null {
    return this.sessionId;
  }

  private async ensureSession(prompt: string): Promise<string> {
    if (this.sessionId) return this.sessionId;
    const session = await this.input.runtime.createSession({
      cwd: this.input.cwd,
      name: prompt.slice(0, 42) || '新建对话',
      backend: 'ai-sdk',
      llmConnectionSlug: this.input.llmConnectionSlug,
      model: this.input.model,
      permissionMode: 'bypass',
    });
    this.sessionId = session.id;
    return session.id;
  }
}
