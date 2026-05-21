/**
 * SessionManager — the public Runtime API.
 *
 * Ties together:
 *   SessionStore (storage)           — JSONL persistence
 *   AgentBackend (AiSdkBackend etc) — SDK adapter
 *   PermissionEngine                  — policy + parking
 *
 * Source: V0.1_TECH_SPEC.md §6.1, §9 (Phase 1 vertical path)
 *
 * NOTE: Imports `SessionStore` from `@maka/storage`. Storage
 * package authored in parallel; the interface is committed per
 * thread message (appendMessage / appendMessages return Promise<void>,
 * updateHeader returns updated SessionHeader, same-session writes serialized).
 */

import type {
  SessionEvent,
  TextDeltaEvent,
  CompleteEvent,
  ErrorEvent,
  AbortEvent,
  PermissionDecisionAckEvent,
  PermissionRequestEvent,
} from '@maka/core/events';
import type {
  SessionHeader,
  SessionSummary,
  StoredMessage,
  UserMessage,
  PermissionDecisionMessage,
  SystemNoteMessage,
  BackendKind,
} from '@maka/core/session';
import type {
  CreateSessionInput,
  UserMessageInput,
  SessionListFilter,
} from '@maka/core/runtime-inputs';
import type { PermissionResponse } from '@maka/core/permission';
import type { PermissionMode } from '@maka/core/permission';

import type { AgentBackend } from './ai-sdk-backend.js';

// ============================================================================
// SessionStore contract (matches the storage package surface)
// ============================================================================

export interface SessionStore {
  create(input: CreateSessionInput): Promise<SessionHeader>;
  list(filter?: SessionListFilter): Promise<SessionSummary[]>;
  readHeader(sessionId: string): Promise<SessionHeader>;
  readMessages(sessionId: string): Promise<StoredMessage[]>;
  appendMessage(sessionId: string, m: StoredMessage): Promise<void>;
  appendMessages(sessionId: string, ms: StoredMessage[]): Promise<void>;
  updateHeader(sessionId: string, patch: Partial<SessionHeader>): Promise<SessionHeader>;
  archive(sessionId: string): Promise<void>;
  unarchive(sessionId: string): Promise<void>;
  setFlagged(sessionId: string, isFlagged: boolean): Promise<void>;
  rename(sessionId: string, name: string): Promise<void>;
  remove(sessionId: string): Promise<void>;
}

// ============================================================================
// BackendRegistry — factory dispatch by BackendKind
// ============================================================================

export interface BackendFactoryContext {
  sessionId: string;
  workspaceRoot: string;
  header: SessionHeader;
  store: SessionStore;
}

export type BackendFactory = (ctx: BackendFactoryContext) => AgentBackend | Promise<AgentBackend>;

export class BackendRegistry {
  private readonly factories = new Map<BackendKind, BackendFactory>();

  register(kind: BackendKind, factory: BackendFactory): void {
    this.factories.set(kind, factory);
  }

  async build(kind: BackendKind, ctx: BackendFactoryContext): Promise<AgentBackend> {
    const f = this.factories.get(kind);
    if (!f) throw new Error(`No backend factory registered for kind="${kind}"`);
    return await f(ctx);
  }

  has(kind: BackendKind): boolean {
    return this.factories.has(kind);
  }
}

// ============================================================================
// SessionManager
// ============================================================================

export interface SessionManagerDeps {
  store: SessionStore;
  backends: BackendRegistry;
  newId: () => string;
  now: () => number;
}

interface ActiveSession {
  sessionId: string;
  backend: AgentBackend;
  /** Tracks the latest header we've read (used to short-circuit some reads). */
  cachedHeader: SessionHeader;
  activeStreams: number;
}

export class SessionManager {
  private readonly active = new Map<string, ActiveSession>();

  constructor(private readonly deps: SessionManagerDeps) {}

  // --------------------------------------------------------------------------
  // Session lifecycle
  // --------------------------------------------------------------------------

  async createSession(input: CreateSessionInput): Promise<SessionSummary> {
    const header = await this.deps.store.create(input);
    return headerToSummary(header);
  }

  async listSessions(filter?: SessionListFilter): Promise<SessionSummary[]> {
    return this.deps.store.list(filter);
  }

  async getMessages(sessionId: string): Promise<StoredMessage[]> {
    return this.deps.store.readMessages(sessionId);
  }

  async updateSession(
    sessionId: string,
    patch: Partial<SessionHeader>,
  ): Promise<SessionSummary> {
    const active = this.active.get(sessionId);
    const backendConfigChanged = changesBackendConfig(patch);
    if (active && backendConfigChanged && active.activeStreams > 0) {
      throw new Error('Cannot change backend configuration while a turn is running');
    }

    const next = await this.deps.store.updateHeader(sessionId, patch);
    if (active) {
      active.cachedHeader = next;
      if (backendConfigChanged) {
        // AgentBackend instances snapshot backend/model config at construction
        // time. If a stale session is rebound to a real default connection, the
        // next turn must build a fresh backend instead of reusing FakeBackend or
        // an AiSdkBackend pointed at a deleted connection.
        await this.disposeBackend(sessionId);
      }
    }
    return headerToSummary(next);
  }

  async archive(sessionId: string): Promise<void> {
    await this.deps.store.archive(sessionId);
    await this.disposeBackend(sessionId);
  }

  async unarchive(sessionId: string): Promise<void> {
    await this.deps.store.unarchive(sessionId);
  }

  async setFlagged(sessionId: string, isFlagged: boolean): Promise<void> {
    await this.deps.store.setFlagged(sessionId, isFlagged);
    const active = this.active.get(sessionId);
    if (active) active.cachedHeader = { ...active.cachedHeader, isFlagged };
  }

  async renameSession(sessionId: string, name: string): Promise<void> {
    await this.deps.store.rename(sessionId, name);
    const active = this.active.get(sessionId);
    if (active) active.cachedHeader = { ...active.cachedHeader, name };
  }

  async setPermissionMode(sessionId: string, mode: PermissionMode): Promise<SessionSummary> {
    const previous = await this.deps.store.readHeader(sessionId);
    if (previous.permissionMode === mode) return headerToSummary(previous);

    const active = this.active.get(sessionId);
    if (active && active.activeStreams > 0) {
      throw new Error('Cannot change permission mode while a turn is running');
    }

    const next = await this.deps.store.updateHeader(sessionId, { permissionMode: mode });
    await this.deps.store.appendMessage(sessionId, {
      type: 'system_note',
      id: this.deps.newId(),
      ts: this.deps.now(),
      kind: 'mode_change',
      data: { from: previous.permissionMode, to: mode },
    } satisfies SystemNoteMessage);

    if (active) {
      active.cachedHeader = next;
      // AiSdkBackend snapshots the header at construction time. Rebuild the
      // backend before the next turn so PermissionEngine receives the new mode.
      await this.disposeBackend(sessionId);
    }
    return headerToSummary(next);
  }

  async remove(sessionId: string): Promise<void> {
    await this.disposeBackend(sessionId);
    await this.deps.store.remove(sessionId);
  }

  // --------------------------------------------------------------------------
  // Send / stream — Phase 1 vertical heart
  // --------------------------------------------------------------------------

  /**
   * Send a user message and stream back normalized events. The caller
   * (desktop main) is expected to forward the events to the renderer over
   * the IPC bridge.
   *
   * Phase 1 vertical (§9):
   *   1. Append UserMessage to JSONL + flush.
   *   2. Lock connection (set connectionLocked=true) if not already.
   *   3. Lookup or build the AgentBackend for this session.
   *   4. backend.send(input) → forward events.
   *   5. Update lastMessageAt + hasUnread when complete.
   */
  async *sendMessage(
    sessionId: string,
    input: UserMessageInput,
  ): AsyncIterable<SessionEvent> {
    // 1. Read header (for backend kind + permissionMode + cwd + model).
    let header = await this.deps.store.readHeader(sessionId);

    // 2. Append the user message FIRST, before any backend startup. JSONL is
    //    the source of truth; even if backend init fails the message is
    //    recorded.
    const userMsg: UserMessage = {
      type: 'user',
      id: this.deps.newId(),
      turnId: input.turnId,
      ts: this.deps.now(),
      text: input.text,
      ...(input.attachments ? { attachments: input.attachments } : {}),
    };
    await this.deps.store.appendMessage(sessionId, userMsg);

    // 3. Lock connection right after the user message is flushed (§9 Step 2.3).
    //    Even if backend startup fails next, the session's backend choice is
    //    committed and won't drift.
    if (!header.connectionLocked) {
      header = await this.deps.store.updateHeader(sessionId, { connectionLocked: true });
    }

    // 4. Resolve / build backend.
    const active = await this.ensureActive(sessionId, header);

    // 5. Stream events from backend, side-tracking the latest ts for header
    //    bookkeeping when the turn completes.
    let lastTs = this.deps.now();
    let sawCompletion = false;
    active.activeStreams += 1;

    try {
      for await (const ev of active.backend.send({
        turnId: input.turnId,
        text: input.text,
        ...(input.attachments ? { attachments: input.attachments } : {}),
        context: await this.deps.store.readMessages(sessionId),
      })) {
        lastTs = ev.ts;
        if (ev.type === 'complete' || ev.type === 'abort') sawCompletion = true;
        yield ev;
      }
    } finally {
      active.activeStreams = Math.max(0, active.activeStreams - 1);
      // 6. Update header timestamps + unread flag exactly once per turn.
      try {
        await this.deps.store.updateHeader(sessionId, {
          lastUsedAt: lastTs,
          lastMessageAt: lastTs,
          hasUnread: true,
        });
      } catch {
        // Swallow header-update failures; the turn already completed at the
        // user-visible level.
      }
      // Persist a SystemNote marking the turn end (helps debug + recovery).
      if (sawCompletion) {
        const note: SystemNoteMessage = {
          type: 'system_note',
          id: this.deps.newId(),
          turnId: input.turnId,
          ts: lastTs,
          kind: 'session_resume',
        };
        await this.deps.store.appendMessage(sessionId, note).catch(() => {});
      }
    }
  }

  async stopSession(sessionId: string): Promise<void> {
    const active = this.active.get(sessionId);
    if (!active) return;
    await active.backend.stop('user_stop');
    // Append the abort SystemNote synchronously (matches §9 Step 6 step 4).
    await this.deps.store.appendMessage(sessionId, {
      type: 'system_note',
      id: this.deps.newId(),
      ts: this.deps.now(),
      kind: 'abort',
    } satisfies SystemNoteMessage);
  }

  async respondToPermission(
    sessionId: string,
    response: PermissionResponse,
  ): Promise<void> {
    const active = this.active.get(sessionId);
    if (!active) return;
    await active.backend.respondToPermission(response);
  }

  // --------------------------------------------------------------------------
  // Internal helpers
  // --------------------------------------------------------------------------

  private async ensureActive(
    sessionId: string,
    header: SessionHeader,
  ): Promise<ActiveSession> {
    const existing = this.active.get(sessionId);
    if (existing) {
      existing.cachedHeader = header;
      return existing;
    }
    const backend = await this.deps.backends.build(header.backend, {
      sessionId,
      workspaceRoot: header.workspaceRoot,
      header,
      store: this.deps.store,
    });
    const entry: ActiveSession = { sessionId, backend, cachedHeader: header, activeStreams: 0 };
    this.active.set(sessionId, entry);
    return entry;
  }

  private async disposeBackend(sessionId: string): Promise<void> {
    const active = this.active.get(sessionId);
    if (!active) return;
    this.active.delete(sessionId);
    try {
      await active.backend.dispose();
    } catch {
      // best-effort
    }
  }
}

// ============================================================================
// Helpers
// ============================================================================

export function headerToSummary(h: SessionHeader): SessionSummary {
  const summary: SessionSummary = {
    id: h.id,
    name: h.name === 'New Session' ? 'New Chat' : h.name,
    isFlagged: h.isFlagged,
    isArchived: h.isArchived,
    labels: h.labels,
    hasUnread: h.hasUnread,
    backend: h.backend,
    llmConnectionSlug: h.llmConnectionSlug,
    permissionMode: h.permissionMode ?? 'ask',
  };
  if (h.lastMessageAt !== undefined) {
    summary.lastMessageAt = h.lastMessageAt;
  }
  return summary;
}

function changesBackendConfig(patch: Partial<SessionHeader>): boolean {
  return 'backend' in patch || 'llmConnectionSlug' in patch || 'model' in patch;
}

// Re-export the suppressed-unused types so this file is the canonical home
// for them. (Avoids TS "imported but unused" warnings.)
export type {
  TextDeltaEvent,
  CompleteEvent,
  ErrorEvent,
  AbortEvent,
  PermissionRequestEvent,
  PermissionDecisionAckEvent,
  PermissionDecisionMessage,
};
