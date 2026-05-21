import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { isPermissionMode } from '@maka/core';
import type {
  CreateSessionInput,
  SessionHeader,
  SessionListFilter,
  SessionSummary,
  StoredMessage,
  UserMessage,
} from '@maka/core';

export interface SessionStore {
  create(input: CreateSessionInput): Promise<SessionHeader>;
  list(filter?: SessionListFilter): Promise<SessionSummary[]>;
  readHeader(sessionId: string): Promise<SessionHeader>;
  readMessages(sessionId: string): Promise<StoredMessage[]>;
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
    const header: SessionHeader = {
      id,
      workspaceRoot: this.workspaceRoot,
      cwd: input.cwd,
      createdAt: now,
      lastUsedAt: now,
      name: input.name ?? 'New Chat',
      isFlagged: false,
      labels: input.labels ?? [],
      isArchived: false,
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
    return summaries.sort((a, b) => (b.lastMessageAt ?? 0) - (a.lastMessageAt ?? 0));
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
    await this.updateHeader(sessionId, { isArchived: true, archivedAt: Date.now() });
  }

  async unarchive(sessionId: string): Promise<void> {
    await this.updateHeader(sessionId, { isArchived: false, archivedAt: undefined });
  }

  async setFlagged(sessionId: string, isFlagged: boolean): Promise<void> {
    await this.updateHeader(sessionId, { isFlagged });
  }

  async rename(sessionId: string, name: string): Promise<void> {
    const trimmed = name.trim();
    if (!trimmed) throw new Error('Session name cannot be empty');
    // Cap length so a wildly long pasted name can't make the sidebar list
    // unreadable; the layout itself also truncates with ellipsis.
    const bounded = trimmed.length > 80 ? trimmed.slice(0, 80) : trimmed;
    await this.updateHeader(sessionId, { name: bounded });
  }

  async remove(sessionId: string): Promise<void> {
    await this.withQueue(sessionId, async () => {
      await rm(this.sessionDir(sessionId), { recursive: true, force: true });
    });
  }

  private sessionDir(sessionId: string): string {
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

type StoredSessionHeader = Omit<SessionHeader, 'backend' | 'permissionMode'> & {
  backend: string;
  permissionMode?: unknown;
};

function migrateHeader(header: StoredSessionHeader): SessionHeader {
  const permissionMode = isPermissionMode(header.permissionMode) ? header.permissionMode : 'ask';
  if (header.backend === 'claude') {
    return { ...header, backend: 'ai-sdk', permissionMode };
  }
  if (header.backend === 'pi') {
    return { ...header, backend: 'fake', permissionMode };
  }
  return {
    ...header,
    backend: header.backend === 'ai-sdk' ? 'ai-sdk' : 'fake',
    permissionMode,
  };
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
    backend: header.backend,
    llmConnectionSlug: header.llmConnectionSlug,
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
