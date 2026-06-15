import { randomUUID } from 'node:crypto';
import { appendFile, mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { AgentRunEvent, AgentRunHeader, AgentRunStore, RuntimeEvent } from '@maka/core';

const SAFE_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

export function createAgentRunStore(workspaceRoot: string): AgentRunStore {
  return new FileAgentRunStore(workspaceRoot);
}

class FileAgentRunStore implements AgentRunStore {
  private readonly sessionsRoot: string;
  private readonly writeQueues = new Map<string, Promise<void>>();

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
    let text: string;
    try {
      text = await readFile(this.runtimeEventsPath(sessionId, runId), 'utf8');
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

  private async readRunUnlocked(sessionId: string, runId: string): Promise<AgentRunHeader> {
    assertSafeId(sessionId, 'Invalid session id');
    assertSafeId(runId, 'Invalid run id');
    return JSON.parse(await readFile(this.runPath(sessionId, runId), 'utf8')) as AgentRunHeader;
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

  private runtimeEventsPath(sessionId: string, runId: string): string {
    return join(this.runDir(sessionId, runId), 'runtime-events.jsonl');
  }

  private withQueue(sessionId: string, runId: string, operation: () => Promise<void>): Promise<void> {
    assertSafeId(sessionId, 'Invalid session id');
    assertSafeId(runId, 'Invalid run id');
    const key = `${sessionId}:${runId}`;
    const previous = this.writeQueues.get(key) ?? Promise.resolve();
    const next = previous.then(operation, operation);
    this.writeQueues.set(
      key,
      next.catch(() => {
        // Keep the chain alive after failures.
      }),
    );
    return next;
  }
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

function sanitizeJson(_key: string, value: unknown): unknown {
  return value === undefined ? undefined : value;
}
