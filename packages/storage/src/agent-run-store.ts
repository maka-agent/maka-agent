import { randomUUID } from 'node:crypto';
import { appendFile, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { chainWrite } from './write-queue.js';
import {
  AGENT_RUN_STATUSES,
  isPermissionMode,
  type AgentRunEvent,
  type AgentRunEventType,
  type AgentRunHeader,
  type AgentRunStore,
  type RuntimeEvent,
  type RuntimeEventStore,
} from '@maka/core';

const SAFE_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

export function createAgentRunStore(workspaceRoot: string): AgentRunStore {
  return new FileAgentRunStore(workspaceRoot);
}

export function createRuntimeEventStore(workspaceRoot: string): RuntimeEventStore {
  return new FileRuntimeEventStore(workspaceRoot);
}

class FileAgentRunStore implements AgentRunStore {
  private readonly sessionsRoot: string;
  private readonly writeQueues = new Map<string, Promise<void>>();
  private readonly projectionWriteQueues = new Map<string, Promise<void>>();

  constructor(workspaceRoot: string) {
    this.sessionsRoot = join(workspaceRoot, 'sessions');
  }

  async createRun(header: AgentRunHeader): Promise<AgentRunHeader> {
    assertSafeId(header.sessionId, 'Invalid session id');
    assertSafeId(header.runId, 'Invalid run id');
    await this.withQueue(header.sessionId, header.runId, async () => {
      await mkdir(this.runDir(header.sessionId, header.runId), { recursive: true });
      await writeAtomic(this.runPath(header.sessionId, header.runId), JSON.stringify(header, sanitizeJson) + '\n');
    });
    await this.withProjectionQueue(header.sessionId, 'history_compact_checkpoint_recorded', async () => {
      await this.initializeEventProjectionUnlocked(
        header.sessionId,
        header.runId,
        'history_compact_checkpoint_recorded',
      );
    }).catch(() => {
      // Projection initialization is derived state; recovery can rebuild it from the run ledger.
    });
    return header;
  }

  async updateRun(sessionId: string, runId: string, patch: Partial<AgentRunHeader>): Promise<AgentRunHeader> {
    let next: AgentRunHeader | undefined;
    await this.withQueue(sessionId, runId, async () => {
      const current = await this.readRunUnlocked(sessionId, runId);
      next = { ...current, ...patch, sessionId, runId };
      await writeAtomic(this.runPath(sessionId, runId), JSON.stringify(next, sanitizeJson) + '\n');
    });
    if (!next) throw new Error(`Failed to update run ${runId}`);
    return next;
  }

  async readRun(sessionId: string, runId: string): Promise<AgentRunHeader> {
    return this.readRunUnlocked(sessionId, runId);
  }

  async listSessionRuns(sessionId: string): Promise<AgentRunHeader[]> {
    assertSafeId(sessionId, 'Invalid session id');
    const runsRoot = this.runsRoot(sessionId);
    let entries;
    try {
      entries = await readdir(runsRoot, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
    const headers: AgentRunHeader[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || !isSafeId(entry.name)) continue;
      try {
        headers.push(await this.readRunUnlocked(sessionId, entry.name));
      } catch {
        // Malformed run folders should not hide the rest of the session.
      }
    }
    return headers.sort((a, b) => a.createdAt - b.createdAt || a.runId.localeCompare(b.runId));
  }

  async appendEvent(sessionId: string, runId: string, event: AgentRunEvent): Promise<void> {
    assertSafeId(sessionId, 'Invalid session id');
    assertSafeId(runId, 'Invalid run id');
    if (event.type === 'history_compact_checkpoint_recorded') {
      await this.withProjectionQueue(sessionId, event.type, async () => {
        await rm(this.eventProjectionPath(sessionId, event.type), { force: true });
        await this.appendRunEvent(sessionId, runId, event);
        await this.writeEventProjectionUnlocked(sessionId, event.type, event).catch(() => {
          // The canonical event is durable; a missing derived projection safely replays raw history.
        });
      });
      return;
    }
    await this.appendRunEvent(sessionId, runId, event);
  }

  private async appendRunEvent(sessionId: string, runId: string, event: AgentRunEvent): Promise<void> {
    await this.withQueue(sessionId, runId, async () => {
      await mkdir(this.runDir(sessionId, runId), { recursive: true });
      await appendFile(this.eventsPath(sessionId, runId), JSON.stringify(event, sanitizeJson) + '\n', 'utf8');
    });
  }

  async readEvents(sessionId: string, runId: string): Promise<AgentRunEvent[]> {
    assertSafeId(sessionId, 'Invalid session id');
    assertSafeId(runId, 'Invalid run id');
    let text: string;
    try {
      text = await readFile(this.eventsPath(sessionId, runId), 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
    const header = await this.readRunUnlocked(sessionId, runId);
    const rawLines = text.split('\n');
    const endsWithNewline = text.endsWith('\n');
    const lines = rawLines
      .map((line, index) => ({ line, lineNumber: index + 1 }))
      .filter((entry) => entry.line.trim().length > 0);
    const lastLineNumber = lines.at(-1)?.lineNumber;
    const events: AgentRunEvent[] = [];
    for (const entry of lines) {
      try {
        events.push(JSON.parse(entry.line) as AgentRunEvent);
      } catch (error) {
        if (!endsWithNewline && entry.lineNumber === lastLineNumber) continue;
        events.push({
          type: 'event_corrupt',
          id: `run-event-corrupt-${entry.lineNumber}`,
          runId,
          sessionId,
          turnId: header.turnId,
          ts: header.updatedAt,
          message: error instanceof Error ? error.message : 'Invalid AgentRun event JSONL line',
          data: { lineNumber: entry.lineNumber },
        });
      }
    }
    return events;
  }

  async readEventProjection(
    sessionId: string,
    type: AgentRunEventType,
  ): Promise<AgentRunEvent | null | undefined> {
    assertSafeId(sessionId, 'Invalid session id');
    return this.readEventProjectionUnlocked(sessionId, type);
  }

  async repairEventProjection(
    sessionId: string,
    type: AgentRunEventType,
    event: AgentRunEvent | null,
  ): Promise<void> {
    assertSafeId(sessionId, 'Invalid session id');
    if (event !== null && !isProjectedAgentRunEvent(event, sessionId, type)) {
      throw new Error(`Invalid AgentRun event projection repair for ${type}`);
    }
    await this.withProjectionQueue(sessionId, type, async () => {
      await this.writeEventProjectionUnlocked(sessionId, type, event);
    });
  }

  private async readRunUnlocked(sessionId: string, runId: string): Promise<AgentRunHeader> {
    assertSafeId(sessionId, 'Invalid session id');
    assertSafeId(runId, 'Invalid run id');
    return normalizeAgentRunHeader(JSON.parse(await readFile(this.runPath(sessionId, runId), 'utf8')), sessionId, runId);
  }

  private runsRoot(sessionId: string): string {
    assertSafeId(sessionId, 'Invalid session id');
    return join(this.sessionsRoot, sessionId, 'runs');
  }

  private runDir(sessionId: string, runId: string): string {
    assertSafeId(runId, 'Invalid run id');
    return join(this.runsRoot(sessionId), runId);
  }

  private runPath(sessionId: string, runId: string): string {
    return join(this.runDir(sessionId, runId), 'run.json');
  }

  private eventsPath(sessionId: string, runId: string): string {
    return join(this.runDir(sessionId, runId), 'events.jsonl');
  }

  private eventProjectionPath(sessionId: string, type: AgentRunEventType): string {
    return join(this.sessionsRoot, sessionId, 'projections', `${type}.json`);
  }

  private withQueue(sessionId: string, runId: string, operation: () => Promise<void>): Promise<void> {
    assertSafeId(sessionId, 'Invalid session id');
    assertSafeId(runId, 'Invalid run id');
    return chainWrite(this.writeQueues, `${sessionId}:${runId}`, operation);
  }

  private withProjectionQueue(
    sessionId: string,
    type: AgentRunEventType,
    operation: () => Promise<void>,
  ): Promise<void> {
    return chainWrite(this.projectionWriteQueues, `${sessionId}:${type}`, operation);
  }

  private async readEventProjectionUnlocked(
    sessionId: string,
    type: AgentRunEventType,
  ): Promise<AgentRunEvent | null | undefined> {
    let raw: string;
    try {
      raw = await readFile(this.eventProjectionPath(sessionId, type), 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
    const parsed = JSON.parse(raw) as { version?: unknown; event?: unknown };
    if (parsed.version !== 1 || !Object.hasOwn(parsed, 'event')) {
      throw new Error(`Invalid AgentRun event projection for ${type}`);
    }
    if (parsed.event === null) return null;
    if (!isProjectedAgentRunEvent(parsed.event, sessionId, type)) {
      throw new Error(`Invalid AgentRun event projection for ${type}`);
    }
    return parsed.event;
  }

  private async writeEventProjectionUnlocked(
    sessionId: string,
    type: AgentRunEventType,
    event: AgentRunEvent | null,
  ): Promise<void> {
    await writeAtomic(
      this.eventProjectionPath(sessionId, type),
      JSON.stringify({ version: 1, event }, sanitizeJson) + '\n',
    );
  }

  private async initializeEventProjectionUnlocked(
    sessionId: string,
    currentRunId: string,
    type: AgentRunEventType,
  ): Promise<void> {
    try {
      await readFile(this.eventProjectionPath(sessionId, type), 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      const runs = await readdir(this.runsRoot(sessionId), { withFileTypes: true });
      if (runs.some((entry) => entry.isDirectory() && isSafeId(entry.name) && entry.name !== currentRunId)) {
        return;
      }
      await this.writeEventProjectionUnlocked(sessionId, type, null);
    }
  }
}

class FileRuntimeEventStore implements RuntimeEventStore {
  private readonly sessionsRoot: string;
  private readonly writeQueues = new Map<string, Promise<void>>();

  constructor(workspaceRoot: string) {
    this.sessionsRoot = join(workspaceRoot, 'sessions');
  }

  async appendRuntimeEvent(sessionId: string, runId: string, event: RuntimeEvent): Promise<void> {
    assertSafeId(sessionId, 'Invalid session id');
    assertSafeId(runId, 'Invalid run id');
    await this.withQueue(sessionId, runId, async () => {
      await mkdir(this.runDir(sessionId, runId), { recursive: true });
      await appendFile(this.runtimeEventsPath(sessionId, runId), JSON.stringify(event, sanitizeJson) + '\n', 'utf8');
    });
  }

  async readRuntimeEvents(sessionId: string, runId: string): Promise<RuntimeEvent[]> {
    assertSafeId(sessionId, 'Invalid session id');
    assertSafeId(runId, 'Invalid run id');
    return readRuntimeEventJsonl(this.runtimeEventsPath(sessionId, runId), runId);
  }

  async readSessionRuntimeEvents(sessionId: string): Promise<RuntimeEvent[]> {
    assertSafeId(sessionId, 'Invalid session id');
    const runsRoot = this.runsRoot(sessionId);
    let entries;
    try {
      entries = await readdir(runsRoot, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
    const ordered: Array<{ event: RuntimeEvent; runId: string; eventIndex: number }> = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || !isSafeId(entry.name)) continue;
      const events = await this.readRuntimeEvents(sessionId, entry.name);
      for (let eventIndex = 0; eventIndex < events.length; eventIndex += 1) {
        ordered.push({ event: events[eventIndex]!, runId: entry.name, eventIndex });
      }
    }
    ordered.sort((a, b) =>
      a.event.ts - b.event.ts ||
      a.runId.localeCompare(b.runId) ||
      a.eventIndex - b.eventIndex ||
      a.event.id.localeCompare(b.event.id)
    );
    return ordered.map((item) => item.event);
  }

  private runsRoot(sessionId: string): string {
    assertSafeId(sessionId, 'Invalid session id');
    return join(this.sessionsRoot, sessionId, 'runs');
  }

  private runDir(sessionId: string, runId: string): string {
    assertSafeId(runId, 'Invalid run id');
    return join(this.runsRoot(sessionId), runId);
  }

  private runtimeEventsPath(sessionId: string, runId: string): string {
    return join(this.runDir(sessionId, runId), 'runtime-events.jsonl');
  }

  private withQueue(sessionId: string, runId: string, operation: () => Promise<void>): Promise<void> {
    assertSafeId(sessionId, 'Invalid session id');
    assertSafeId(runId, 'Invalid run id');
    return chainWrite(this.writeQueues, `${sessionId}:${runId}`, operation);
  }
}

async function readRuntimeEventJsonl(path: string, runId: string): Promise<RuntimeEvent[]> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  const rawLines = text.split('\n');
  const endsWithNewline = text.endsWith('\n');
  const lines = rawLines
    .map((line, index) => ({ line, lineNumber: index + 1 }))
    .filter((entry) => entry.line.trim().length > 0);
  const lastLineNumber = lines.at(-1)?.lineNumber;
  const events: RuntimeEvent[] = [];
  for (const entry of lines) {
    try {
      events.push(JSON.parse(entry.line) as RuntimeEvent);
    } catch (error) {
      if (!endsWithNewline && entry.lineNumber === lastLineNumber) continue;
      const message = error instanceof Error ? error.message : 'Invalid JSON';
      throw new Error(`Invalid RuntimeEvent JSONL line ${entry.lineNumber} for run ${runId}: ${message}`);
    }
  }
  return events;
}

function isProjectedAgentRunEvent(
  value: unknown,
  sessionId: string,
  type: AgentRunEventType,
): value is AgentRunEvent {
  if (!value || typeof value !== 'object') return false;
  const event = value as Partial<AgentRunEvent>;
  return event.type === type
    && event.sessionId === sessionId
    && typeof event.id === 'string'
    && typeof event.runId === 'string'
    && typeof event.turnId === 'string'
    && Number.isFinite(event.ts);
}

async function writeAtomic(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tempPath = `${path}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`;
  await writeFile(tempPath, content, 'utf8');
  await rename(tempPath, path);
}

function assertSafeId(value: string, message: string): void {
  if (!isSafeId(value)) throw new Error(message);
}

function isSafeId(value: string): boolean {
  return SAFE_ID_PATTERN.test(value);
}

function normalizeAgentRunHeader(value: unknown, sessionId: string, runId: string): AgentRunHeader {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`Invalid AgentRun header for run ${runId}: expected an object`);
  }
  const record = value as Partial<AgentRunHeader>;
  const requiredStrings = [
    record.runId,
    record.sessionId,
    record.turnId,
    record.llmConnectionSlug,
    record.modelId,
    record.cwd,
  ];
  const optionalStrings = [
    record.parentRunId,
    record.agentId,
    record.agentName,
    record.parentTurnId,
    record.retriedFromTurnId,
    record.regeneratedFromTurnId,
    record.branchOfTurnId,
    record.parentSessionId,
    record.failureClass,
    record.failureMessage,
    record.traceWriteError,
  ];
  const valid = requiredStrings.every((item) => typeof item === 'string') &&
    record.sessionId === sessionId &&
    record.runId === runId &&
    (AGENT_RUN_STATUSES as readonly string[]).includes(String(record.status)) &&
    isBackendKind(record.backendKind) &&
    isPermissionMode(record.permissionMode) &&
    isFiniteNumber(record.createdAt) &&
    isFiniteNumber(record.updatedAt) &&
    (record.completedAt === undefined || isFiniteNumber(record.completedAt)) &&
    optionalStrings.every((item) => item === undefined || typeof item === 'string');
  if (!valid) {
    throw new Error(`Invalid AgentRun header for run ${runId}: malformed fields`);
  }
  return record as AgentRunHeader;
}

function isBackendKind(value: unknown): boolean {
  return value === 'ai-sdk' || value === 'fake' || value === 'pi-agent';
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function sanitizeJson(_key: string, value: unknown): unknown {
  return value === undefined ? undefined : value;
}
