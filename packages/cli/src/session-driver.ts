import { randomUUID } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import type { SessionEvent } from '@maka/core/events';
import type { PermissionMode, PermissionResponse } from '@maka/core/permission';
import type { UserQuestionResponse } from '@maka/core/user-question';
import type { BranchFromTurnInput, CreateSessionInput, UserMessageInput } from '@maka/core/runtime-inputs';
import type { SessionSummary, StoredMessage } from '@maka/core/session';
import type { ThinkingLevel } from '@maka/core/model-thinking';

export interface MakaSessionRuntime {
  createSession(input: CreateSessionInput): Promise<SessionSummary>;
  listSessions(): Promise<SessionSummary[]>;
  getMessages(sessionId: string): Promise<StoredMessage[]>;
  sendMessage(sessionId: string, input: UserMessageInput): AsyncIterable<SessionEvent>;
  compactSession(sessionId: string, input?: { turnId?: string }): AsyncIterable<SessionEvent>;
  stopSession(sessionId: string, input?: { source?: 'stop_button' }): Promise<void>;
  respondToPermission(sessionId: string, response: PermissionResponse): Promise<void>;
  respondToUserQuestion?(sessionId: string, response: UserQuestionResponse): Promise<void>;
  setPermissionMode(sessionId: string, mode: PermissionMode): Promise<SessionSummary>;
  updateSession(sessionId: string, patch: { model?: string; llmConnectionSlug?: string; thinkingLevel?: ThinkingLevel | undefined; name?: string }): Promise<SessionSummary>;
  // Rewind reuses the runtime's branch primitives: a non-destructive copy of the
  // transcript + RuntimeEvent ledger at a turn boundary, so resume correctness is
  // inherited and the original session's log is left intact. `branchBeforeTurn`
  // is the exclusive dual — it keeps everything strictly before the turn.
  branchFromTurn(sessionId: string, input: BranchFromTurnInput): Promise<SessionSummary>;
  branchBeforeTurn(sessionId: string, input: BranchFromTurnInput): Promise<SessionSummary>;
}

/** A turn the user can rewind to: its id plus a one-line label (its prompt). */
export interface RewindTarget {
  turnId: string;
  label: string;
}

/**
 * A rewind result: the branched session's summary + messages (as with a switch),
 * plus the chosen turn's full prompt so the caller can refill the editor for the
 * user to edit and resend.
 */
export interface MakaSessionRewindResult extends MakaSessionSwitchResult {
  prompt: string;
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
  getSessionResumeAvailability?(session: SessionSummary): Promise<SessionResumeAvailability>;
  sendPrompt(prompt: string): AsyncIterable<SessionEvent>;
  compactSession(): AsyncIterable<SessionEvent>;
  respondToPermission(response: PermissionResponse): Promise<void>;
  respondToUserQuestion?(response: UserQuestionResponse): Promise<void>;
  /**
   * Switch the active session's model, optionally rebinding it to another
   * connection at the same time (cross-provider `/model`). The next turn builds
   * a fresh backend on the new connection.
   */
  setModel(model: string, connectionSlug?: string): Promise<void>;
  setThinkingLevel(level: ThinkingLevel | undefined): Promise<void>;
  setPermissionMode(mode: PermissionMode): Promise<void>;
  renameSession(name: string): Promise<void>;
  switchSession(sessionId: string): Promise<MakaSessionSwitchResult>;
  /** Every prompted turn the user can rewind to, newest first. */
  listRewindTargets(): Promise<RewindTarget[]>;
  /**
   * Rewind to a turn: branch the session to the state just *before* that turn
   * (discarding it and everything after), switch onto the branch, and return the
   * turn's prompt so the caller can refill the editor for an edit-and-resend.
   */
  rewindToTurn(turnId: string): Promise<MakaSessionRewindResult>;
  /** Abandon the active session so the next prompt starts a fresh one. */
  startNewSession(): void;
  stop(): Promise<void>;
  getSessionId(): string | null;
}

export type SessionResumeAvailability =
  | { available: true }
  | { available: false; reason: string };

const MISSING_SESSION_CWD_REASON = 'Missing working directory';
const DELETED_SESSION_CWD_REASON = 'Working directory no longer exists';

export async function inspectSessionResumeAvailability(
  session: SessionSummary,
): Promise<SessionResumeAvailability> {
  if (!session.cwd) return { available: false, reason: MISSING_SESSION_CWD_REASON };
  try {
    await realpath(session.cwd);
    return { available: true };
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      return { available: false, reason: DELETED_SESSION_CWD_REASON };
    }
    throw error;
  }
}

export function createMakaSessionDriver(input: MakaSessionDriverInput): MakaSessionDriver {
  return new RuntimeMakaSessionDriver(input);
}

class RuntimeMakaSessionDriver implements MakaSessionDriver {
  private sessionId: string | null = null;
  private cwd: string;
  private model: string;
  // The connection the active/next session runs on. Mutable so a cross-provider
  // /model switch can rebind it; new sessions are created on this connection.
  private llmConnectionSlug: string;
  private thinkingLevel: ThinkingLevel | undefined;
  private permissionMode: PermissionMode;
  private readonly newId: () => string;

  constructor(private readonly input: MakaSessionDriverInput) {
    this.newId = input.newId ?? randomUUID;
    this.cwd = input.cwd;
    this.model = input.model;
    this.llmConnectionSlug = input.llmConnectionSlug;
    this.permissionMode = input.permissionMode ?? 'ask';
  }

  async *sendPrompt(prompt: string): AsyncIterable<SessionEvent> {
    const sessionId = await this.ensureSession(prompt);
    yield* this.input.runtime.sendMessage(sessionId, {
      turnId: this.newId(),
      text: prompt,
    });
  }

  async *compactSession(): AsyncIterable<SessionEvent> {
    if (!this.sessionId) throw new Error('Cannot compact before a session starts.');
    yield* this.input.runtime.compactSession(this.sessionId, { turnId: this.newId() });
  }

  async listSessions(): Promise<SessionSummary[]> {
    return (await this.input.runtime.listSessions())
      .map((session, index) => ({ session, index }))
      .sort((left, right) => {
        const cwdDelta = cwdRank(left.session, this.cwd) - cwdRank(right.session, this.cwd);
        return cwdDelta !== 0 ? cwdDelta : left.index - right.index;
      })
      .map(({ session }) => session);
  }

  async getSessionResumeAvailability(session: SessionSummary): Promise<SessionResumeAvailability> {
    return inspectSessionResumeAvailability(session);
  }

  async stop(): Promise<void> {
    if (!this.sessionId) return;
    await this.input.runtime.stopSession(this.sessionId, { source: 'stop_button' });
  }

  async respondToPermission(response: PermissionResponse): Promise<void> {
    if (!this.sessionId) throw new Error('Cannot respond to permission before a session starts.');
    await this.input.runtime.respondToPermission(this.sessionId, response);
  }

  async respondToUserQuestion(response: UserQuestionResponse): Promise<void> {
    if (!this.sessionId) throw new Error('Cannot respond to a user question before a session starts.');
    if (!this.input.runtime.respondToUserQuestion) throw new Error('User questions are unavailable on this runtime.');
    await this.input.runtime.respondToUserQuestion(this.sessionId, response);
  }

  async setModel(model: string, connectionSlug?: string): Promise<void> {
    // Only rebind the connection when a different one is asked for; a same-slug
    // /model is a plain model change and must not churn the backend needlessly.
    const nextConnection = connectionSlug && connectionSlug !== this.llmConnectionSlug ? connectionSlug : undefined;
    if (this.sessionId) {
      // Switching model (or connection) clears the per-model thinking variant.
      const summary = await this.input.runtime.updateSession(this.sessionId, {
        model,
        thinkingLevel: undefined,
        ...(nextConnection ? { llmConnectionSlug: nextConnection } : {}),
      });
      this.model = summary.model;
      this.llmConnectionSlug = summary.llmConnectionSlug;
      this.thinkingLevel = summary.thinkingLevel;
      return;
    }
    this.model = model;
    if (nextConnection) this.llmConnectionSlug = nextConnection;
    this.thinkingLevel = undefined;
  }

  async setThinkingLevel(level: ThinkingLevel | undefined): Promise<void> {
    if (this.sessionId) {
      const summary = await this.input.runtime.updateSession(this.sessionId, { thinkingLevel: level });
      this.thinkingLevel = summary.thinkingLevel;
      return;
    }
    this.thinkingLevel = level;
  }

  async setPermissionMode(mode: PermissionMode): Promise<void> {
    if (this.sessionId) {
      const summary = await this.input.runtime.setPermissionMode(this.sessionId, mode);
      this.permissionMode = summary.permissionMode;
      return;
    }
    this.permissionMode = mode;
  }

  async renameSession(name: string): Promise<void> {
    if (!this.sessionId) throw new Error('Cannot rename before a session starts.');
    await this.input.runtime.updateSession(this.sessionId, { name });
  }

  async switchSession(sessionId: string): Promise<MakaSessionSwitchResult> {
    const summary = (await this.listSessions()).find((session) => session.id === sessionId);
    if (!summary) throw new Error(`Session not found: ${sessionId}`);
    const availability = await inspectSessionResumeAvailability(summary);
    if (!availability.available) {
      if (!summary.cwd) throw new Error('Session has no working directory and cannot be resumed.');
      throw new Error(`Session cwd no longer exists: ${summary.cwd}`);
    }
    const sessionCwd = summary.cwd!;
    const messages = await this.input.runtime.getMessages(summary.id);
    this.sessionId = summary.id;
    this.cwd = sessionCwd;
    this.model = summary.model;
    this.llmConnectionSlug = summary.llmConnectionSlug;
    this.thinkingLevel = summary.thinkingLevel;
    this.permissionMode = summary.permissionMode;
    return { summary, messages };
  }

  async listRewindTargets(): Promise<RewindTarget[]> {
    if (!this.sessionId) return [];
    const messages = await this.input.runtime.getMessages(this.sessionId);
    // One target per turn that has a user prompt, in send order. The prompt text
    // is the label — it is what the user recognizes a turn by. Rewinding to a
    // turn resets to just *before* it (see rewindToTurn), so the latest turn is
    // itself a valid target (undo it, edit its prompt, resend) and no turn is
    // excluded. Turns with no user prompt (e.g. a /compact turn) never appear.
    const promptByTurn = new Map<string, string>();
    const order: string[] = [];
    for (const message of messages) {
      if (message.type !== 'user' || promptByTurn.has(message.turnId)) continue;
      promptByTurn.set(message.turnId, message.text);
      order.push(message.turnId);
    }
    return order
      .reverse()
      .map((turnId) => ({ turnId, label: firstLine(promptByTurn.get(turnId) ?? '') }));
  }

  async rewindToTurn(turnId: string): Promise<MakaSessionRewindResult> {
    if (!this.sessionId) throw new Error('Cannot rewind before a session starts.');
    // Read the turn's prompt from the *original* session before branching — the
    // branch drops this turn, so it must be captured first. The full text (not
    // the one-line label) is refilled into the editor for an edit-and-resend.
    const messages = await this.input.runtime.getMessages(this.sessionId);
    const prompt = messages.find(
      (message): message is Extract<StoredMessage, { type: 'user' }> =>
        message.type === 'user' && message.turnId === turnId,
    )?.text;
    if (prompt === undefined) throw new Error(`Cannot rewind to turn ${turnId}: no user prompt.`);
    // Branch to the state just before the turn (copies transcript + ledger up to,
    // but not including, it), then switch onto the branch. switchSession
    // re-validates folder/connection and loads the branched messages, so the
    // branch inherits the same resume guarantees as any resumed session and the
    // original session — including the discarded turn — is left untouched.
    const branch = await this.input.runtime.branchBeforeTurn(this.sessionId, { sourceTurnId: turnId });
    return { ...(await this.switchSession(branch.id)), prompt };
  }

  startNewSession(): void {
    // Drop the active session id only. The current model / thinking / permission
    // stay put, so the next prompt lazily creates a fresh session that inherits
    // them (via ensureSession). The old session is left intact on disk.
    this.sessionId = null;
  }

  getSessionId(): string | null {
    return this.sessionId;
  }

  private async ensureSession(prompt: string): Promise<string> {
    if (this.sessionId) return this.sessionId;
    const session = await this.input.runtime.createSession({
      cwd: this.cwd,
      name: prompt.slice(0, 42) || '新建对话',
      backend: 'ai-sdk',
      llmConnectionSlug: this.llmConnectionSlug,
      model: this.model,
      permissionMode: this.permissionMode,
      ...(this.thinkingLevel !== undefined ? { thinkingLevel: this.thinkingLevel } : {}),
    });
    this.sessionId = session.id;
    return session.id;
  }
}

function cwdRank(session: SessionSummary, cwd: string): number {
  return session.cwd === cwd ? 0 : 1;
}

/** First non-empty line of a prompt, for a compact rewind-target label. */
function firstLine(text: string): string {
  const line = text.split('\n').map((part) => part.trim()).find((part) => part.length > 0);
  return line ?? '(empty prompt)';
}
