import { randomUUID } from 'node:crypto';
import type { SessionEvent } from '@maka/core/events';
import type { PermissionMode, PermissionResponse } from '@maka/core/permission';
import type { CreateSessionInput, UserMessageInput } from '@maka/core/runtime-inputs';
import type { SessionSummary } from '@maka/core/session';

export interface MakaSessionRuntime {
  createSession(input: CreateSessionInput): Promise<SessionSummary>;
  listSessions(): Promise<SessionSummary[]>;
  sendMessage(sessionId: string, input: UserMessageInput): AsyncIterable<SessionEvent>;
  stopSession(sessionId: string, input?: { source?: 'stop_button' }): Promise<void>;
  respondToPermission(sessionId: string, response: PermissionResponse): Promise<void>;
  setPermissionMode(sessionId: string, mode: PermissionMode): Promise<SessionSummary>;
  updateSession(sessionId: string, patch: { model: string }): Promise<SessionSummary>;
}

export interface MakaSessionDriverInput {
  runtime: MakaSessionRuntime;
  cwd: string;
  llmConnectionSlug: string;
  model: string;
  permissionMode?: PermissionMode;
  newId?: () => string;
}

export interface MakaSessionDriver {
  sendPrompt(prompt: string): AsyncIterable<SessionEvent>;
  respondToPermission(response: PermissionResponse): Promise<void>;
  setModel(model: string): Promise<void>;
  setPermissionMode(mode: PermissionMode): Promise<void>;
  switchSession(sessionId: string): Promise<SessionSummary>;
  stop(): Promise<void>;
  getSessionId(): string | null;
}

export function createMakaSessionDriver(input: MakaSessionDriverInput): MakaSessionDriver {
  return new RuntimeMakaSessionDriver(input);
}

class RuntimeMakaSessionDriver implements MakaSessionDriver {
  private sessionId: string | null = null;
  private model: string;
  private permissionMode: PermissionMode;
  private readonly newId: () => string;

  constructor(private readonly input: MakaSessionDriverInput) {
    this.newId = input.newId ?? randomUUID;
    this.model = input.model;
    this.permissionMode = input.permissionMode ?? 'ask';
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

  async respondToPermission(response: PermissionResponse): Promise<void> {
    if (!this.sessionId) throw new Error('Cannot respond to permission before a session starts.');
    await this.input.runtime.respondToPermission(this.sessionId, response);
  }

  async setModel(model: string): Promise<void> {
    if (this.sessionId) {
      const summary = await this.input.runtime.updateSession(this.sessionId, { model });
      this.model = summary.model;
      return;
    }
    this.model = model;
  }

  async setPermissionMode(mode: PermissionMode): Promise<void> {
    if (this.sessionId) {
      const summary = await this.input.runtime.setPermissionMode(this.sessionId, mode);
      this.permissionMode = summary.permissionMode;
      return;
    }
    this.permissionMode = mode;
  }

  async switchSession(sessionId: string): Promise<SessionSummary> {
    const summary = (await this.input.runtime.listSessions()).find((session) => session.id === sessionId);
    if (!summary) throw new Error(`Session not found: ${sessionId}`);
    this.sessionId = summary.id;
    this.model = summary.model;
    this.permissionMode = summary.permissionMode;
    return summary;
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
      model: this.model,
      permissionMode: this.permissionMode,
    });
    this.sessionId = session.id;
    return session.id;
  }
}
