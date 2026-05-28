import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { deriveTurnRecords, isPermissionMode, isSessionBlockedReason, isSessionStatus, normalizeUserSessionName } from '@maka/core';
import type {
  CreateSessionInput,
  SessionHeader,
  SessionListFilter,
  SessionSummary,
  StoredMessage,
  TurnRecord,
  UserMessage,
} from '@maka/core';

const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

export interface SessionStore {
  create(input: CreateSessionInput): Promise<SessionHeader>;
  list(filter?: SessionListFilter): Promise<SessionSummary[]>;
  readHeader(sessionId: string): Promise<SessionHeader>;
  readMessages(sessionId: string): Promise<StoredMessage[]>;
  listTurns(sessionId: string): Promise<TurnRecord[]>;
  appendMessage(sessionId: string, message: StoredMessage): Promise<void>;
  appendMessages(sessionId: string, messages: StoredMessage[]): Promise<void>;
  updateHeader(sessionId: string, patch: Partial<SessionHeader>): Promise<SessionHeader>;
  archive(sessionId: string): Promise<void>;
  unarchive(sessionId: string): Promise<void>;
  setFlagged(sessionId: string, isFlagged: boolean): Promise<void>;
  rename(sessionId: string, name: string): Promise<void>;
  remove(sessionId: string): Promise<void>;
}

export function createSessionStore(workspaceRoot: string): SessionStore {
  return new FileSessionStore(workspaceRoot);
}

class FileSessionStore implements SessionStore {
  private readonly sessionsRoot: string;
  private readonly writeQueues = new Map<string, Promise<void>>();

  constructor(private readonly workspaceRoot: string) {
    this.sessionsRoot = join(workspaceRoot, 'sessions');
  }

  async create(input: CreateSessionInput): Promise<SessionHeader> {
    const now = Date.now();
    const id = randomUUID();
    // PR-UI-IPC-2 (@kenji msg 0474c3fe + @xuan msg 88d96a87):
    // session name write contract. If caller passed undefined,
    // use the canonical default; otherwise normalize the
    // user-supplied name through the same `normalizeUserSessionName`
    // gate that `rename` and `branchFromTurn` use. Empty-after-
    // sanitize on an explicit input is a REJECT — we do NOT
    // silently fall back to default, that would swallow the
    // user's intent (per @xuan caller-semantics lock).
    let resolvedName: string;
    if (input.name === undefined) {
      resolvedName = 'New Chat';
    } else {
      const normalized = normalizeUserSessionName(input.name);
      if (!normalized.ok) {
        throw new Error(normalized.error);
      }
      resolvedName = normalized.value;
    }
    const header: SessionHeader = {
      id,
      workspaceRoot: this.workspaceRoot,
      cwd: input.cwd,
      createdAt: now,
      lastUsedAt: now,
      name: resolvedName,
      isFlagged: false,
      labels: input.labels ?? [],
      isArchived: false,
      status: input.status ?? 'active',
      ...(input.blockedReason ? { blockedReason: input.blockedReason } : {}),
      statusUpdatedAt: now,
      ...(input.parentSessionId ? { parentSessionId: input.parentSessionId } : {}),
      ...(input.branchOfTurnId ? { branchOfTurnId: input.branchOfTurnId } : {}),
      hasUnread: false,
      backend: input.backend,
      llmConnectionSlug: input.llmConnectionSlug,
      connectionLocked: false,
      model: input.model ?? 'default',
      permissionMode: input.permissionMode,
      schemaVersion: 1,
    };

    await this.withQueue(id, async () => {
      await mkdir(this.sessionDir(id), { recursive: true });
      await writeFile(this.sessionPath(id), JSON.stringify(header) + '\n', 'utf8');
    });

    return header;
  }

  async list(filter?: SessionListFilter): Promise<SessionSummary[]> {
    await mkdir(this.sessionsRoot, { recursive: true });
    const entries = await import('node:fs/promises').then((fs) => fs.readdir(this.sessionsRoot, { withFileTypes: true }));
    const summaries: SessionSummary[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (!isSafeSessionId(entry.name)) continue;
      try {
        const { header, messages } = await this.readFileParts(entry.name);
        if (filter?.isArchived !== undefined && header.isArchived !== filter.isArchived) continue;
        if (filter?.isFlagged !== undefined && header.isFlagged !== filter.isFlagged) continue;
        if (filter?.labelSlug && !header.labels.includes(filter.labelSlug)) continue;
        summaries.push(toSummary(header, messages));
      } catch {
        // Ignore malformed session folders in the sidebar.
      }
    }
    // Secondary key on `id` (lexicographic) so sessions with identical
    // lastMessageAt always sort in the same order — fixtures with
    // multiple sessions seeded at the same frozen timestamp would
    // otherwise drift across runs based on filesystem readdir order
    // (PR108k-yj per @kenji visual-smoke determinism). Negligible cost
    // for real users; identical lastMessageAt is rare in production.
    return summaries.sort((a, b) => {
      const tsDelta = (b.lastMessageAt ?? 0) - (a.lastMessageAt ?? 0);
      if (tsDelta !== 0) return tsDelta;
      return a.id.localeCompare(b.id);
    });
  }

  async readHeader(sessionId: string): Promise<SessionHeader> {
    const { header, messages } = await this.readFileParts(sessionId);
    if (!header.connectionLocked && messages.some((message) => message.type === 'user')) {
      return this.updateHeader(sessionId, { connectionLocked: true });
    }
    return header;
  }

  async readMessages(sessionId: string): Promise<StoredMessage[]> {
    const { header, messages } = await this.readFileParts(sessionId);
    if (!header.connectionLocked && messages.some((message) => message.type === 'user')) {
      await this.updateHeader(sessionId, { connectionLocked: true });
    }
    return messages;
  }

  async listTurns(sessionId: string): Promise<TurnRecord[]> {
    return deriveTurnRecords(await this.readMessages(sessionId));
  }

  async appendMessage(sessionId: string, message: StoredMessage): Promise<void> {
    await this.appendMessages(sessionId, [message]);
  }

  async appendMessages(sessionId: string, messages: StoredMessage[]): Promise<void> {
    if (messages.length === 0) return;
    await this.withQueue(sessionId, async () => {
      await mkdir(this.sessionDir(sessionId), { recursive: true });
      const payload = messages.map((message) => JSON.stringify(message)).join('\n') + '\n';
      await import('node:fs/promises').then((fs) => fs.appendFile(this.sessionPath(sessionId), payload, 'utf8'));
    });
  }

  async updateHeader(sessionId: string, patch: Partial<SessionHeader>): Promise<SessionHeader> {
    let nextHeader: SessionHeader | undefined;
    await this.withQueue(sessionId, async () => {
      const { header, messages } = await this.readFilePartsUnlocked(sessionId);
      nextHeader = { ...header, ...patch };
      const lines = [JSON.stringify(nextHeader), ...messages.map((message) => JSON.stringify(message))];
      await this.writeAtomic(this.sessionPath(sessionId), lines.join('\n') + '\n');
    });
    if (!nextHeader) throw new Error(`Failed to update session ${sessionId}`);
    return nextHeader;
  }

  async archive(sessionId: string): Promise<void> {
    const now = Date.now();
    await this.updateHeader(sessionId, { isArchived: true, archivedAt: now, status: 'archived', statusUpdatedAt: now });
  }

  async unarchive(sessionId: string): Promise<void> {
    await this.updateHeader(sessionId, {
      isArchived: false,
      archivedAt: undefined,
      status: 'active',
      blockedReason: undefined,
      statusUpdatedAt: Date.now(),
    });
  }

  async setFlagged(sessionId: string, isFlagged: boolean): Promise<void> {
    await this.updateHeader(sessionId, { isFlagged });
  }

  async rename(sessionId: string, name: string): Promise<void> {
    // PR-UI-IPC-2: same `normalizeUserSessionName` chokepoint as
    // create + branch. Replaces the older inline trim + length-80
    // cap with the shared helper so all three write paths go
    // through a single contract (control char strip, bidi/zero-
    // width defense, NFC, code-point cap, typed reject).
    const normalized = normalizeUserSessionName(name);
    if (!normalized.ok) {
      throw new Error(normalized.error);
    }
    await this.updateHeader(sessionId, { name: normalized.value });
  }

  async remove(sessionId: string): Promise<void> {
    await this.withQueue(sessionId, async () => {
      await rm(this.sessionDir(sessionId), { recursive: true, force: true });
    });
  }

  private sessionDir(sessionId: string): string {
    assertSafeSessionId(sessionId);
    return join(this.sessionsRoot, sessionId);
  }

  private sessionPath(sessionId: string): string {
    return join(this.sessionDir(sessionId), 'session.jsonl');
  }

  private async readFileParts(sessionId: string): Promise<{ header: SessionHeader; messages: StoredMessage[] }> {
    return this.readFilePartsUnlocked(sessionId);
  }

  private async readFilePartsUnlocked(sessionId: string): Promise<{ header: SessionHeader; messages: StoredMessage[] }> {
    const text = await readFile(this.sessionPath(sessionId), 'utf8');
    const lines = text.split('\n').filter((line) => line.trim().length > 0);
    if (lines.length === 0 || !lines[0]) throw new Error(`Session ${sessionId} is empty`);
    const header = migrateHeader(JSON.parse(lines[0]) as StoredSessionHeader);
    const messages = lines.slice(1).map((line) => JSON.parse(line) as StoredMessage);
    return { header, messages };
  }

  private async writeAtomic(path: string, content: string): Promise<void> {
    await mkdir(dirname(path), { recursive: true });
    const tempPath = `${path}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(tempPath, content, 'utf8');
    await rename(tempPath, path);
  }

  private withQueue(sessionId: string, operation: () => Promise<void>): Promise<void> {
    assertSafeSessionId(sessionId);
    const previous = this.writeQueues.get(sessionId) ?? Promise.resolve();
    const next = previous.then(operation, operation);
    this.writeQueues.set(
      sessionId,
      next.catch(() => {
        // Keep the chain alive after failures.
      }),
    );
    return next;
  }
}

function assertSafeSessionId(sessionId: string): void {
  if (!isSafeSessionId(sessionId)) {
    throw new Error('Invalid session id');
  }
}

function isSafeSessionId(sessionId: string): boolean {
  return SESSION_ID_PATTERN.test(sessionId);
}

type StoredSessionHeader = Omit<SessionHeader, 'backend' | 'model' | 'permissionMode' | 'status' | 'blockedReason'> & {
  backend: string;
  model?: unknown;
  permissionMode?: unknown;
  status?: unknown;
  blockedReason?: unknown;
};

function migrateHeader(header: StoredSessionHeader): SessionHeader {
  const permissionMode = isPermissionMode(header.permissionMode) ? header.permissionMode : 'ask';
  const model = typeof header.model === 'string' && header.model.length > 0 ? header.model : 'default';
  const status = resolveMigratedStatus(header);
  const blockedReason = status === 'blocked' && isSessionBlockedReason(header.blockedReason)
    ? header.blockedReason
    : undefined;
  const statusFields = {
    status,
    blockedReason,
    statusUpdatedAt: header.statusUpdatedAt ?? header.archivedAt ?? header.lastMessageAt ?? header.lastUsedAt ?? header.createdAt,
  };
  if (header.backend === 'claude') {
    return { ...header, ...statusFields, backend: 'ai-sdk', model, permissionMode };
  }
  if (header.backend === 'pi') {
    return { ...header, ...statusFields, backend: 'fake', model, permissionMode };
  }
  return {
    ...header,
    ...statusFields,
    backend: header.backend === 'ai-sdk' ? 'ai-sdk' : 'fake',
    model,
    permissionMode,
  };
}

function resolveMigratedStatus(header: StoredSessionHeader): SessionHeader['status'] {
  if (header.isArchived) return 'archived';
  if (isSessionStatus(header.status) && header.status !== 'archived') return header.status;
  return 'active';
}

function toSummary(header: SessionHeader, messages: StoredMessage[] = []): SessionSummary {
  const preview = lastMessagePreview(messages);
  return {
    id: header.id,
    name: normalizeSessionName(header.name),
    isFlagged: header.isFlagged,
    isArchived: header.isArchived,
    labels: header.labels,
    hasUnread: header.hasUnread,
    lastMessageAt: header.lastMessageAt,
    ...(preview ? { lastMessagePreview: preview } : {}),
    status: header.status,
    ...(header.blockedReason ? { blockedReason: header.blockedReason } : {}),
    ...(header.statusUpdatedAt !== undefined ? { statusUpdatedAt: header.statusUpdatedAt } : {}),
    ...(header.parentSessionId ? { parentSessionId: header.parentSessionId } : {}),
    ...(header.branchOfTurnId ? { branchOfTurnId: header.branchOfTurnId } : {}),
    backend: header.backend,
    llmConnectionSlug: header.llmConnectionSlug,
    model: header.model,
    permissionMode: header.permissionMode,
  };
}

function normalizeSessionName(name: string): string {
  return name === 'New Session' ? 'New Chat' : name;
}

function lastMessagePreview(messages: StoredMessage[]): string | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]!;
    if (message.type === 'user') {
      const text = normalizePreviewText(message.text);
      if (text) return truncatePreview(text);
      if (message.attachments && message.attachments.length > 0) return '附件';
    }
    if (message.type === 'assistant') {
      const text = normalizePreviewText(message.text);
      if (text) return truncatePreview(text);
    }
  }
  return undefined;
}

function normalizePreviewText(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function truncatePreview(text: string, maxLength = 96): string {
  const chars = Array.from(text);
  if (chars.length <= maxLength) return text;
  return `${chars.slice(0, maxLength - 1).join('')}…`;
}

export function createUserMessage(input: { turnId: string; text: string; attachments?: UserMessage['attachments'] }): UserMessage {
  return {
    type: 'user',
    id: randomUUID(),
    turnId: input.turnId,
    ts: Date.now(),
    text: input.text,
    attachments: input.attachments,
  };
}
