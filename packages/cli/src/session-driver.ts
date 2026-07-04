import { randomUUID } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import type { SessionEvent } from '@maka/core/events';
import type { PermissionMode, PermissionResponse } from '@maka/core/permission';
import type { CreateSessionInput, UserMessageInput } from '@maka/core/runtime-inputs';
import type { SessionSummary, StoredMessage } from '@maka/core/session';

export interface MakaSessionRuntime {
  createSession(input: CreateSessionInput): Promise<SessionSummary>;
  listSessions(): Promise<SessionSummary[]>;
  getMessages(sessionId: string): Promise<StoredMessage[]>;
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

export interface MakaSessionSwitchResult {
  summary: SessionSummary;
  messages: StoredMessage[];
}

export interface MakaSessionDriver {
  listSessions(): Promise<SessionSummary[]>;
  sendPrompt(prompt: string): AsyncIterable<SessionEvent>;
  respondToPermission(response: PermissionResponse): Promise<void>;
  setModel(model: string): Promise<void>;
  setPermissionMode(mode: PermissionMode): Promise<void>;
  switchSession(sessionId: string): Promise<MakaSessionSwitchResult>;
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

  async listSessions(): Promise<SessionSummary[]> {
    return (await this.input.runtime.listSessions())
      .map((session, index) => ({ session, index }))
      .sort((left, right) => {
        const cwdDelta = cwdRank(left.session, this.input.cwd) - cwdRank(right.session, this.input.cwd);
        return cwdDelta !== 0 ? cwdDelta : left.index - right.index;
      })
      .map(({ session }) => session);
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

  async switchSession(sessionId: string): Promise<MakaSessionSwitchResult> {
    const summary = (await this.listSessions()).find((session) => session.id === sessionId);
    if (!summary) throw new Error(`Session not found: ${sessionId}`);
    if (summary.cwd) await assertSessionCwdExists(summary.cwd);
    // Enforce folder/connection before reading messages or committing any
    // internal state, so a rejected switch leaves the active session untouched.
    if (summary.cwd !== this.input.cwd) {
      throw new Error('Session belongs to a different folder; run Maka in that folder to resume it.');
    }
    if (summary.llmConnectionSlug !== this.input.llmConnectionSlug) {
      throw new Error('Session uses a different connection; run Maka with that connection to resume it.');
    }
    const messages = await this.input.runtime.getMessages(summary.id);
    this.sessionId = summary.id;
    this.model = summary.model;
    this.permissionMode = summary.permissionMode;
    return { summary, messages };
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

function cwdRank(session: SessionSummary, cwd: string): number {
  return session.cwd === cwd ? 0 : 1;
}

async function assertSessionCwdExists(cwd: string): Promise<void> {
  try {
    await realpath(cwd);
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      throw new Error(`Session cwd no longer exists: ${cwd}`);
    }
    throw error;
  }
}
