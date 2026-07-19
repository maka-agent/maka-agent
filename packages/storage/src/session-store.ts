import { mkdir, open, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import {
  decodeStoredMessageForRead,
  decodeStoredMessageForRecovery,
} from './execution-record-codec.js';
import { appendJsonl } from './jsonl-append.js';
import { classifyJsonRecord } from './json-prefix.js';
import { chainWrite } from './write-queue.js';
import {
  DEFAULT_SESSION_NAME,
  deriveTurnRecords,
  isPermissionMode,
  isSessionBlockedReason,
  isSessionStatus,
  normalizeUserSessionName,
} from '@maka/core';
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
  listForRecovery(): Promise<SessionHeader[]>;
  /** Read only the durable header without triggering connection-lock self-healing. */
  readHeaderSnapshot(sessionId: string): Promise<SessionHeader>;
  /** Read durable messages without triggering connection-lock self-healing. */
  readMessagesSnapshot(sessionId: string): Promise<StoredMessage[]>;
  /** Read messages for startup recovery, rejecting durable JSONL corruption. */
  readMessagesForRecovery(sessionId: string): Promise<StoredMessage[]>;
  /** Derive durable turns without triggering connection-lock self-healing. */
  listTurnsSnapshot(sessionId: string): Promise<TurnRecord[]>;
  readHeader(sessionId: string): Promise<SessionHeader>;
  readMessages(sessionId: string): Promise<StoredMessage[]>;
  listTurns(sessionId: string): Promise<TurnRecord[]>;
  appendMessage(sessionId: string, message: StoredMessage): Promise<void>;
  appendMessages(sessionId: string, messages: StoredMessage[]): Promise<void>;
  updateHeader(sessionId: string, patch: Partial<SessionHeader>): Promise<SessionHeader>;
  markSessionReadThrough(sessionId: string, readThroughTs: number): Promise<SessionHeader>;
  archive(sessionId: string): Promise<void>;
  unarchive(sessionId: string): Promise<void>;
  setFlagged(sessionId: string, isFlagged: boolean): Promise<void>;
  rename(sessionId: string, name: string): Promise<void>;
  setGeneratedTitleIfAbsent(sessionId: string, title: string): Promise<SessionHeader | null>;
  remove(sessionId: string): Promise<void>;
}

export function createSessionStore(workspaceRoot: string): SessionStore {
  return new FileSessionStore(workspaceRoot);
}

class FileSessionStore implements SessionStore {
  private static readonly HEADER_BUDGET = 8192;
  private static readonly MAX_HEADER_BYTES = 1024 * 1024;
  private static readonly TAIL_PREVIEW_BUDGET = 64 * 1024;
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
      resolvedName = DEFAULT_SESSION_NAME;
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
      titleIsManual: false,
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
      ...(input.thinkingLevel !== undefined ? { thinkingLevel: input.thinkingLevel } : {}),
      schemaVersion: 1,
    };

    await this.withQueue(id, async () => {
      await mkdir(this.sessionDir(id), { recursive: true });
      await writeFile(this.sessionPath(id), JSON.stringify(header) + '\n', 'utf8');
    });

    return header;
  }

  async list(filter?: SessionListFilter): Promise<SessionSummary[]> {
    let entries;
    try {
      entries = await readdir(this.sessionsRoot, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }

    // Phase 1: read each header plus a bounded tail preview. That keeps
    // list() proportional to the number of sessions rather than full
    // transcript size, while preserving sidebar previews and timestamp
    // fallback for sessions outside the top few.
    const withHeaders: Array<{
      id: string;
      header: SessionHeader;
      previewMessages: StoredMessage[];
    }> = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (!isSafeSessionId(entry.name)) continue;
      try {
        const header = await this.readHeaderOnly(entry.name);
        if (filter?.isArchived !== undefined && header.isArchived !== filter.isArchived) continue;
        if (filter?.isFlagged !== undefined && header.isFlagged !== filter.isFlagged) continue;
        if (filter?.labelSlug && !header.labels.includes(filter.labelSlug)) continue;
        const previewMessages = await this.readTailPreviewMessages(entry.name).catch(() => []);
        withHeaders.push({ id: entry.name, header, previewMessages });
      } catch {
        // Ignore malformed session folders in the sidebar.
      }
    }

    // Secondary key on id (lexicographic) so sessions with identical
    // lastMessageAt always sort in the same order - fixtures with
    // multiple sessions seeded at the same frozen timestamp would
    // otherwise drift across runs based on filesystem readdir order
    // (PR108k-yj per @kenji visual-smoke determinism). Negligible cost
    // for real users; identical lastMessageAt is rare in production.
    withHeaders.sort((a, b) => {
      const aLastMessageAt = maxTimestamp(
        a.header.lastMessageAt,
        latestVisibleMessageAt(a.previewMessages),
      );
      const bLastMessageAt = maxTimestamp(
        b.header.lastMessageAt,
        latestVisibleMessageAt(b.previewMessages),
      );
      const tsDelta = (bLastMessageAt ?? 0) - (aLastMessageAt ?? 0);
      if (tsDelta !== 0) return tsDelta;
      return a.header.id.localeCompare(b.header.id);
    });

    // Phase 2: full detail read only for the most recent 3 sessions.
    // For those, keep only the last 10 messages as preview. Remaining
    // sessions use the bounded tail preview from phase 1.
    const TOP_N = 3;
    const summaries: SessionSummary[] = [];
    for (let i = 0; i < withHeaders.length; i++) {
      const { header, previewMessages } = withHeaders[i];
      let messages: StoredMessage[] = previewMessages.slice(-10);
      if (i < TOP_N) {
        try {
          const result = await this.readFilePartsUnlocked(header.id);
          messages = result.messages.slice(-10);
        } catch {
          // Fall through to the bounded tail preview from phase 1.
        }
      }
      summaries.push(toSummary(header, messages));
    }
    return summaries;
  }

  async listForRecovery(): Promise<SessionHeader[]> {
    let entries;
    try {
      entries = await readdir(this.sessionsRoot, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
    const headers: SessionHeader[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || !isSafeSessionId(entry.name)) {
        throw new Error(`Invalid Session entry: ${entry.name}`);
      }
      headers.push(await this.readHeaderOnly(entry.name));
    }
    return headers.sort((a, b) => a.id.localeCompare(b.id));
  }

  async readHeader(sessionId: string): Promise<SessionHeader> {
    const { header, messages } = await this.readFileParts(sessionId);
    if (!header.connectionLocked && messages.some((message) => message.type === 'user')) {
      return this.updateHeader(sessionId, { connectionLocked: true });
    }
    return header;
  }

  async readHeaderSnapshot(sessionId: string): Promise<SessionHeader> {
    return this.readHeaderOnly(sessionId);
  }

  async readMessages(sessionId: string): Promise<StoredMessage[]> {
    const { header, messages } = await this.readFileParts(sessionId);
    if (!header.connectionLocked && messages.some((message) => message.type === 'user')) {
      await this.updateHeader(sessionId, { connectionLocked: true });
    }
    return messages;
  }

  async readMessagesSnapshot(sessionId: string): Promise<StoredMessage[]> {
    return (await this.readFileParts(sessionId)).messages;
  }

  async readMessagesForRecovery(sessionId: string): Promise<StoredMessage[]> {
    return (await this.readFilePartsUnlocked(sessionId, true)).messages;
  }

  async listTurnsSnapshot(sessionId: string): Promise<TurnRecord[]> {
    return deriveTurnRecords(await this.readMessagesSnapshot(sessionId));
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
      const payload = messages.map((message) => JSON.stringify(message)).join('\n') + '\n';
      await appendJsonl(this.sessionPath(sessionId), payload, {
        requireExistingRecord: true,
      });
    });
  }

  async updateHeader(sessionId: string, patch: Partial<SessionHeader>): Promise<SessionHeader> {
    let nextHeader: SessionHeader | undefined;
    await this.withQueue(sessionId, async () => {
      const { header, messages } = await this.readFilePartsUnlocked(sessionId);
      nextHeader = { ...header, ...patch };
      const lines = [
        JSON.stringify(nextHeader),
        ...messages.map((message) => JSON.stringify(message)),
      ];
      await this.writeAtomic(this.sessionPath(sessionId), lines.join('\n') + '\n');
    });
    if (!nextHeader) throw new Error(`Failed to update session ${sessionId}`);
    return nextHeader;
  }

  async markSessionReadThrough(sessionId: string, readThroughTs: number): Promise<SessionHeader> {
    let nextHeader: SessionHeader | undefined;
    await this.withQueue(sessionId, async () => {
      const { header, messages } = await this.readFilePartsUnlocked(sessionId);
      const effectiveLastMessageAt = maxTimestamp(
        header.lastMessageAt,
        latestVisibleMessageAt(messages),
      );
      if (
        !Number.isFinite(readThroughTs) ||
        !header.hasUnread ||
        (effectiveLastMessageAt !== undefined && effectiveLastMessageAt > readThroughTs)
      ) {
        nextHeader = header;
        return;
      }
      nextHeader = { ...header, hasUnread: false };
      const lines = [
        JSON.stringify(nextHeader),
        ...messages.map((message) => JSON.stringify(message)),
      ];
      await this.writeAtomic(this.sessionPath(sessionId), lines.join('\n') + '\n');
    });
    if (!nextHeader) throw new Error(`Failed to update session ${sessionId}`);
    return nextHeader;
  }

  async archive(sessionId: string): Promise<void> {
    const now = Date.now();
    await this.updateHeader(sessionId, {
      isArchived: true,
      archivedAt: now,
      status: 'archived',
      statusUpdatedAt: now,
    });
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
    await this.updateHeader(sessionId, { name: normalized.value, titleIsManual: true });
  }

  async setGeneratedTitleIfAbsent(sessionId: string, title: string): Promise<SessionHeader | null> {
    const normalized = normalizeUserSessionName(title);
    if (!normalized.ok) return null;
    let nextHeader: SessionHeader | null = null;
    await this.withQueue(sessionId, async () => {
      const { header, messages } = await this.readFilePartsUnlocked(sessionId);
      if (header.titleIsManual || header.name !== DEFAULT_SESSION_NAME) return;
      if (normalized.value === header.name) return;
      nextHeader = { ...header, name: normalized.value };
      const lines = [
        JSON.stringify(nextHeader),
        ...messages.map((message) => JSON.stringify(message)),
      ];
      await this.writeAtomic(this.sessionPath(sessionId), lines.join('\n') + '\n');
    });
    return nextHeader;
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

  private async readHeaderOnly(sessionId: string): Promise<SessionHeader> {
    // Fast path: read only the first JSON line (the header) without
    // parsing any message payload. Used by list() to quickly scan
    // all sessions before deciding which ones need detail reads.
    const path = this.sessionPath(sessionId);
    const handle = await open(path, 'r');
    try {
      const chunks: Buffer[] = [];
      let offset = 0;
      while (offset < FileSessionStore.MAX_HEADER_BYTES) {
        const buf = Buffer.alloc(
          Math.min(FileSessionStore.HEADER_BUDGET, FileSessionStore.MAX_HEADER_BYTES - offset),
        );
        const { bytesRead } = await handle.read(buf, 0, buf.length, offset);
        if (bytesRead === 0) break;
        chunks.push(buf.subarray(0, bytesRead));
        const region = Buffer.concat(chunks).toString('utf8');
        const firstNl = region.indexOf('\n');
        if (firstNl !== -1) {
          return migrateHeader(
            JSON.parse(region.slice(0, firstNl)) as StoredSessionHeader,
            sessionId,
          );
        }
        offset += bytesRead;
      }
      throw new Error(`Session ${sessionId}: cannot find header line`);
    } finally {
      await handle.close();
    }
  }

  private async readTailPreviewMessages(sessionId: string): Promise<StoredMessage[]> {
    const path = this.sessionPath(sessionId);
    const handle = await open(path, 'r');
    try {
      const { size } = await handle.stat();
      const start = Math.max(0, size - FileSessionStore.TAIL_PREVIEW_BUDGET);
      const length = size - start;
      if (length <= 0) return [];
      const buf = Buffer.alloc(length);
      const { bytesRead } = await handle.read(buf, 0, length, start);
      const text = buf.toString('utf8', 0, bytesRead);
      const rawLines = text.split('\n');
      // The first tail line is either the header (start === 0) or a partial JSONL line.
      const lines = rawLines.slice(1);
      const completeLines = text.endsWith('\n') ? lines : lines.slice(0, -1);
      const messages: StoredMessage[] = [];
      for (const line of completeLines) {
        if (line.trim().length === 0) continue;
        try {
          messages.push(decodeStoredMessageForRead(JSON.parse(line)));
        } catch {
          // Tail previews are best-effort; full reads still surface durable corruption notes.
        }
      }
      return messages;
    } finally {
      await handle.close();
    }
  }

  private async readFileParts(
    sessionId: string,
  ): Promise<{ header: SessionHeader; messages: StoredMessage[] }> {
    return this.readFilePartsUnlocked(sessionId);
  }

  private async readFilePartsUnlocked(
    sessionId: string,
    strict = false,
  ): Promise<{ header: SessionHeader; messages: StoredMessage[] }> {
    const text = await readFile(this.sessionPath(sessionId), 'utf8');
    const rawLines = text.split('\n');
    const endsWithNewline = text.endsWith('\n');
    const lines = rawLines
      .map((line, index) => ({ line, lineNumber: index + 1 }))
      .filter((entry) => entry.line.trim().length > 0);
    if (lines.length === 0 || !lines[0]) throw new Error(`Session ${sessionId} is empty`);
    const header = migrateHeader(JSON.parse(lines[0].line) as StoredSessionHeader, sessionId);
    const messages: StoredMessage[] = [];
    const lastLineNumber = lines.at(-1)?.lineNumber;
    for (const entry of lines.slice(1)) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(entry.line);
      } catch (error) {
        if (
          !endsWithNewline &&
          entry.lineNumber === lastLineNumber &&
          classifyJsonRecord(entry.line) === 'incomplete-prefix'
        )
          continue;
        if (strict) {
          const detail = error instanceof Error ? error.message : String(error);
          throw new Error(
            `Session ${sessionId} has a corrupt JSONL record at line ${entry.lineNumber}: ${detail}`,
          );
        }
        messages.push(createJsonlCorruptionNote(header, entry.lineNumber, error));
        continue;
      }
      try {
        messages.push(
          strict ? decodeStoredMessageForRecovery(parsed) : decodeStoredMessageForRead(parsed),
        );
      } catch (error) {
        if (strict) {
          const detail = error instanceof Error ? error.message : String(error);
          throw new Error(
            `Session ${sessionId} has a corrupt JSONL record at line ${entry.lineNumber}: ${detail}`,
          );
        }
        messages.push(createJsonlCorruptionNote(header, entry.lineNumber, error));
      }
    }
    return { header, messages };
  }

  private async writeAtomic(path: string, content: string): Promise<void> {
    await mkdir(dirname(path), { recursive: true });
    const tempPath = `${path}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`;
    await writeFile(tempPath, content, 'utf8');
    try {
      await replaceFileWithWindowsReaderRetry(tempPath, path);
    } finally {
      await rm(tempPath, { force: true }).catch(() => {});
    }
  }

  private withQueue(sessionId: string, operation: () => Promise<void>): Promise<void> {
    assertSafeSessionId(sessionId);
    return chainWrite(this.writeQueues, sessionId, operation);
  }
}

async function replaceFileWithWindowsReaderRetry(tempPath: string, path: string): Promise<void> {
  const attempts = process.platform === 'win32' ? 6 : 1;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      await rename(tempPath, path);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      const retryable = process.platform === 'win32' && (code === 'EPERM' || code === 'EACCES');
      if (!retryable || attempt === attempts) throw error;
      await delay(attempt * 10);
    }
  }
}

/** Shared guard for stores that derive filesystem paths from a session id. */
export function assertSafeSessionId(sessionId: string): void {
  if (!isSafeSessionId(sessionId)) {
    throw new Error('Invalid session id');
  }
}

export function isSafeSessionId(sessionId: string): boolean {
  return SESSION_ID_PATTERN.test(sessionId);
}

type StoredSessionHeader = Omit<
  SessionHeader,
  'backend' | 'model' | 'permissionMode' | 'status' | 'blockedReason' | 'titleIsManual'
> & {
  backend: string;
  model?: unknown;
  permissionMode?: unknown;
  status?: unknown;
  blockedReason?: unknown;
  titleIsManual?: unknown;
};

function createJsonlCorruptionNote(
  header: SessionHeader,
  lineNumber: number,
  error: unknown,
): StoredMessage {
  return {
    type: 'system_note',
    id: `jsonl-corrupt-${lineNumber}`,
    ts: header.lastUsedAt ?? header.createdAt,
    kind: 'error',
    data: {
      code: 'jsonl_parse_error',
      lineNumber,
      message: error instanceof Error ? error.message : 'Invalid JSONL message line',
    },
  };
}

function migrateHeader(header: StoredSessionHeader, sessionId: string): SessionHeader {
  const permissionMode = isPermissionMode(header.permissionMode) ? header.permissionMode : 'ask';
  const model =
    typeof header.model === 'string' && header.model.length > 0 ? header.model : 'default';
  const status = resolveMigratedStatus(header);
  const blockedReason =
    status === 'blocked' && isSessionBlockedReason(header.blockedReason)
      ? header.blockedReason
      : undefined;
  const statusFields = {
    status,
    blockedReason,
    statusUpdatedAt:
      header.statusUpdatedAt ??
      header.archivedAt ??
      header.lastMessageAt ??
      header.lastUsedAt ??
      header.createdAt,
  };
  const titleIsManual =
    typeof header.titleIsManual === 'boolean'
      ? header.titleIsManual
      : normalizeSessionName(header.name) !== DEFAULT_SESSION_NAME;
  if (header.backend === 'claude') {
    return normalizeMigratedHeader(
      { ...header, ...statusFields, titleIsManual, backend: 'ai-sdk', model, permissionMode },
      sessionId,
    );
  }
  if (header.backend === 'pi-agent') {
    return normalizeMigratedHeader(
      { ...header, ...statusFields, titleIsManual, backend: 'pi-agent', model, permissionMode },
      sessionId,
    );
  }
  if (header.backend === 'pi') {
    return normalizeMigratedHeader(
      { ...header, ...statusFields, titleIsManual, backend: 'pi-agent', model, permissionMode },
      sessionId,
    );
  }
  return normalizeMigratedHeader(
    {
      ...header,
      ...statusFields,
      titleIsManual,
      backend: header.backend === 'ai-sdk' ? 'ai-sdk' : 'fake',
      model,
      permissionMode,
    },
    sessionId,
  );
}

function resolveMigratedStatus(header: StoredSessionHeader): SessionHeader['status'] {
  if (header.isArchived) return 'archived';
  if (isSessionStatus(header.status) && header.status !== 'archived') return header.status;
  return 'active';
}

function normalizeMigratedHeader(header: SessionHeader, sessionId: string): SessionHeader {
  const valid =
    header.id === sessionId &&
    typeof header.workspaceRoot === 'string' &&
    typeof header.cwd === 'string' &&
    (header.pendingCwdReminder === undefined || isCwdReminder(header.pendingCwdReminder)) &&
    isFiniteNumber(header.createdAt) &&
    isFiniteNumber(header.lastUsedAt) &&
    (header.lastMessageAt === undefined || isFiniteNumber(header.lastMessageAt)) &&
    typeof header.name === 'string' &&
    typeof header.titleIsManual === 'boolean' &&
    typeof header.isFlagged === 'boolean' &&
    Array.isArray(header.labels) &&
    header.labels.every((label) => typeof label === 'string') &&
    typeof header.isArchived === 'boolean' &&
    (header.archivedAt === undefined || isFiniteNumber(header.archivedAt)) &&
    isSessionStatus(header.status) &&
    (header.blockedReason === undefined || isSessionBlockedReason(header.blockedReason)) &&
    (header.statusUpdatedAt === undefined || isFiniteNumber(header.statusUpdatedAt)) &&
    (header.parentSessionId === undefined || typeof header.parentSessionId === 'string') &&
    (header.branchOfTurnId === undefined || typeof header.branchOfTurnId === 'string') &&
    (header.lastReadMessageId === undefined || typeof header.lastReadMessageId === 'string') &&
    typeof header.hasUnread === 'boolean' &&
    isBackendKind(header.backend) &&
    typeof header.llmConnectionSlug === 'string' &&
    typeof header.connectionLocked === 'boolean' &&
    typeof header.model === 'string' &&
    isPermissionMode(header.permissionMode) &&
    header.schemaVersion === 1;
  if (!valid) {
    throw new Error(`Invalid session header for session ${sessionId}: malformed fields`);
  }
  return { ...header, name: normalizeSessionName(header.name) };
}

function isBackendKind(value: unknown): value is SessionHeader['backend'] {
  return value === 'ai-sdk' || value === 'fake' || value === 'pi-agent';
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isCwdReminder(value: unknown): value is NonNullable<SessionHeader['pendingCwdReminder']> {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { from?: unknown }).from === 'string' &&
    typeof (value as { to?: unknown }).to === 'string'
  );
}

function toSummary(header: SessionHeader, messages: StoredMessage[] = []): SessionSummary {
  const preview = lastMessagePreview(messages);
  const derivedLastMessageAt = latestVisibleMessageAt(messages);
  const lastMessageAt = maxTimestamp(header.lastMessageAt, derivedLastMessageAt);
  return {
    id: header.id,
    cwd: header.cwd,
    ...(header.pendingCwdReminder ? { pendingCwdReminder: header.pendingCwdReminder } : {}),
    name: normalizeSessionName(header.name),
    isFlagged: header.isFlagged,
    isArchived: header.isArchived,
    labels: header.labels,
    hasUnread: header.hasUnread,
    lastMessageAt,
    ...(preview ? { lastMessagePreview: preview } : {}),
    status: header.status,
    ...(header.blockedReason ? { blockedReason: header.blockedReason } : {}),
    ...(header.statusUpdatedAt !== undefined ? { statusUpdatedAt: header.statusUpdatedAt } : {}),
    ...(header.parentSessionId ? { parentSessionId: header.parentSessionId } : {}),
    ...(header.branchOfTurnId ? { branchOfTurnId: header.branchOfTurnId } : {}),
    backend: header.backend,
    llmConnectionSlug: header.llmConnectionSlug,
    connectionLocked: header.connectionLocked,
    model: header.model,
    permissionMode: header.permissionMode,
    ...(header.thinkingLevel !== undefined ? { thinkingLevel: header.thinkingLevel } : {}),
  };
}

function latestVisibleMessageAt(messages: StoredMessage[]): number | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]!;
    if (message.type === 'user' || message.type === 'assistant') return message.ts;
  }
  return undefined;
}

function maxTimestamp(left: number | undefined, right: number | undefined): number | undefined {
  if (left === undefined) return right;
  if (right === undefined) return left;
  return Math.max(left, right);
}

function normalizeSessionName(name: string): string {
  return name === 'New Session' ? DEFAULT_SESSION_NAME : name;
}

function lastMessagePreview(messages: StoredMessage[]): string | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]!;
    if (message.type === 'user') {
      // Prefer the human-facing view when the stored model text is a composed
      // envelope (e.g. explicit skill invocation).
      const text = normalizePreviewText(message.displayText ?? message.text);
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

export function createUserMessage(input: {
  turnId: string;
  text: string;
  displayText?: string;
  attachments?: UserMessage['attachments'];
}): UserMessage {
  return {
    type: 'user',
    id: randomUUID(),
    turnId: input.turnId,
    ts: Date.now(),
    text: input.text,
    ...(input.displayText !== undefined ? { displayText: input.displayText } : {}),
    attachments: input.attachments,
  };
}
