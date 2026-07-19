import { createHash, randomUUID } from 'node:crypto';
import {
  appendFile,
  link,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { appendJsonl } from './jsonl-append.js';
import {
  decodeAgentRunEvent,
  decodeAgentRunHeader,
  decodeRuntimeEvent,
} from './execution-record-codec.js';
import { classifyJsonRecord } from './json-prefix.js';
import { syncDirectory, syncDirectoryChain, syncFile } from './stable-storage.js';
import { chainWrite } from './write-queue.js';
import {
  DurableStoreWriteError,
  isTerminalRuntimeEvent,
  type AgentRunEvent,
  type AgentRunEventType,
  type AgentRunHeader,
  type AgentRunStore,
  type RuntimeEvent,
  type RuntimeEventStore,
} from '@maka/core';

const SAFE_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const EXCLUSIVE_TEMP_SUFFIX_PATTERN =
  /^\d+\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.tmp$/;

export const ROOT_TURN_ADMISSION_SCHEMA_VERSION = 1 as const;

export interface RootTurnAdmissionInput {
  text: string;
}

export interface RootTurnAdmission {
  schemaVersion: typeof ROOT_TURN_ADMISSION_SCHEMA_VERSION;
  sessionId: string;
  turnId: string;
  runId: string;
  userMessageId: string;
  normalizedInput: RootTurnAdmissionInput;
  admittedAt: number;
}

export interface AdmitRootTurnInput {
  sessionId: string;
  turnId: string;
  proposedRunId: string;
  proposedUserMessageId: string;
  normalizedInput: RootTurnAdmissionInput;
  admittedAt: number;
}

export type AdmitRootTurnResult =
  | { kind: 'admitted'; admission: RootTurnAdmission }
  | { kind: 'existing'; admission: RootTurnAdmission }
  | { kind: 'conflict'; admission: RootTurnAdmission };

export interface RootTurnAdmissionStore {
  admitRootTurn(input: AdmitRootTurnInput): Promise<AdmitRootTurnResult>;
  readRootTurnAdmission(sessionId: string, turnId: string): Promise<RootTurnAdmission | undefined>;
  listRootTurnAdmissionsForRecovery(sessionId: string): Promise<RootTurnAdmission[]>;
}

export interface DurableAgentRunStore extends AgentRunStore, RootTurnAdmissionStore {
  listSessionRunsForRecovery(sessionId: string): Promise<AgentRunHeader[]>;
  readEventsForRecovery(sessionId: string, runId: string): Promise<AgentRunEvent[]>;
  readEventProjection(
    sessionId: string,
    type: AgentRunEventType,
  ): Promise<AgentRunEvent | null | undefined>;
  repairEventProjection(
    sessionId: string,
    type: AgentRunEventType,
    event: AgentRunEvent | null,
    options?: { replaceEventId?: string },
  ): Promise<void>;
}

export interface DurableRuntimeEventStore extends RuntimeEventStore {
  readImmutableRuntimeEvents(sessionId: string, runId: string): Promise<RuntimeEvent[]>;
}

interface RuntimePartialSnapshot {
  version: 1;
  event: RuntimeEvent;
  afterEventId?: string;
}

export function createAgentRunStore(workspaceRoot: string): DurableAgentRunStore {
  return new FileAgentRunStore(workspaceRoot);
}

export function createRuntimeEventStore(workspaceRoot: string): DurableRuntimeEventStore {
  return new FileRuntimeEventStore(workspaceRoot);
}

class FileAgentRunStore implements DurableAgentRunStore {
  private readonly durabilityRoot: string;
  private readonly sessionsRoot: string;
  private readonly writeQueues = new Map<string, Promise<void>>();
  private readonly projectionWriteQueues = new Map<string, Promise<void>>();

  constructor(workspaceRoot: string) {
    this.durabilityRoot = resolve(workspaceRoot);
    this.sessionsRoot = join(this.durabilityRoot, 'sessions');
  }

  async createRun(
    header: AgentRunHeader,
    options: { durable?: boolean } = {},
  ): Promise<AgentRunHeader> {
    assertSafeId(header.sessionId, 'Invalid session id');
    assertSafeId(header.runId, 'Invalid run id');
    await this.withQueue(header.sessionId, header.runId, async () => {
      const created = await writeExclusiveAtomic(
        this.runPath(header.sessionId, header.runId),
        JSON.stringify(header, sanitizeJson) + '\n',
        options,
        this.durabilityRoot,
      );
      if (!created) throw new Error(`Agent run already exists: ${header.runId}`);
    });
    await this.withProjectionQueue(
      header.sessionId,
      'history_compact_checkpoint_recorded',
      async () => {
        await this.initializeEventProjectionUnlocked(
          header.sessionId,
          header.runId,
          'history_compact_checkpoint_recorded',
        );
      },
    ).catch(() => {
      // Projection initialization is derived state; recovery can rebuild it from the run ledger.
    });
    return header;
  }

  async admitRootTurn(input: AdmitRootTurnInput): Promise<AdmitRootTurnResult> {
    assertSafeId(input.sessionId, 'Invalid session id');
    assertSafeId(input.turnId, 'Invalid turn id');
    assertSafeId(input.proposedRunId, 'Invalid run id');
    assertSafeId(input.proposedUserMessageId, 'Invalid user message id');
    const normalizedInput = normalizeRootTurnAdmissionInput(input.normalizedInput);
    if (!Number.isSafeInteger(input.admittedAt) || input.admittedAt < 0) {
      throw new Error('Invalid root turn admission timestamp');
    }
    const admission: RootTurnAdmission = {
      schemaVersion: ROOT_TURN_ADMISSION_SCHEMA_VERSION,
      sessionId: input.sessionId,
      turnId: input.turnId,
      runId: input.proposedRunId,
      userMessageId: input.proposedUserMessageId,
      normalizedInput,
      admittedAt: input.admittedAt,
    };
    const path = this.rootTurnAdmissionPath(input.sessionId, input.turnId);
    const created = await writeExclusiveAtomic(
      path,
      JSON.stringify(admission) + '\n',
      { durable: true },
      this.durabilityRoot,
    );
    if (created) return { kind: 'admitted', admission };
    const existing = await this.readRootTurnAdmission(input.sessionId, input.turnId);
    if (!existing) throw new Error(`Root turn admission disappeared: ${input.turnId}`);
    return existing.normalizedInput.text === normalizedInput.text
      ? { kind: 'existing', admission: existing }
      : { kind: 'conflict', admission: existing };
  }

  async readRootTurnAdmission(
    sessionId: string,
    turnId: string,
  ): Promise<RootTurnAdmission | undefined> {
    assertSafeId(sessionId, 'Invalid session id');
    assertSafeId(turnId, 'Invalid turn id');
    let raw: string;
    try {
      raw = await readFile(this.rootTurnAdmissionPath(sessionId, turnId), 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
    return normalizeRootTurnAdmission(JSON.parse(raw), sessionId, turnId);
  }

  async listRootTurnAdmissionsForRecovery(sessionId: string): Promise<RootTurnAdmission[]> {
    assertSafeId(sessionId, 'Invalid session id');
    const admissionsRoot = this.rootTurnAdmissionsRoot(sessionId);
    let entries;
    try {
      entries = await readdir(admissionsRoot, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
    const admissions: RootTurnAdmission[] = [];
    let removedStagingFile = false;
    for (const entry of entries) {
      if (!entry.isFile()) {
        throw new Error(`Invalid root turn admission entry: ${entry.name}`);
      }
      const turnId = turnIdFromAdmissionFile(entry.name);
      if (turnId) {
        admissions.push((await this.readRootTurnAdmission(sessionId, turnId)) as RootTurnAdmission);
        continue;
      }
      if (isRootTurnAdmissionTemp(entry.name)) {
        await rm(join(admissionsRoot, entry.name), { force: true });
        removedStagingFile = true;
        continue;
      }
      throw new Error(`Invalid root turn admission entry: ${entry.name}`);
    }
    if (removedStagingFile) await syncDirectory(admissionsRoot);
    return admissions.sort(
      (a, b) => a.admittedAt - b.admittedAt || a.turnId.localeCompare(b.turnId),
    );
  }

  async updateRun(
    sessionId: string,
    runId: string,
    patch: Partial<AgentRunHeader>,
    options: { durable?: boolean } = {},
  ): Promise<AgentRunHeader> {
    let next: AgentRunHeader | undefined;
    await this.withQueue(sessionId, runId, async () => {
      const current = await this.readRunUnlocked(sessionId, runId);
      next = { ...current, ...patch, sessionId, runId };
      await writeAtomic(this.runPath(sessionId, runId), JSON.stringify(next, sanitizeJson) + '\n', {
        ...options,
        durabilityRoot: this.durabilityRoot,
      });
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

  async listSessionRunsForRecovery(sessionId: string): Promise<AgentRunHeader[]> {
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
      if (!entry.isDirectory() || !isSafeId(entry.name)) {
        throw new Error(`Invalid AgentRun entry for session ${sessionId}: ${entry.name}`);
      }
      try {
        headers.push(await this.readRunUnlocked(sessionId, entry.name));
      } catch (error) {
        if (
          isMissingFile(error) &&
          (await this.removeUncommittedRunDirectory(sessionId, entry.name))
        ) {
          continue;
        }
        throw error;
      }
    }
    return headers.sort((a, b) => a.createdAt - b.createdAt || a.runId.localeCompare(b.runId));
  }

  async appendEvent(
    sessionId: string,
    runId: string,
    event: AgentRunEvent,
    options: { durable?: boolean } = {},
  ): Promise<void> {
    assertSafeId(sessionId, 'Invalid session id');
    assertSafeId(runId, 'Invalid run id');
    if (event.type === 'history_compact_checkpoint_recorded') {
      await this.withProjectionQueue(sessionId, event.type, async () => {
        let current: AgentRunEvent | null | undefined;
        try {
          current = await this.readEventProjectionUnlocked(sessionId, event.type);
        } catch {
          current = undefined;
        }
        await rm(this.eventProjectionPath(sessionId, event.type), {
          force: true,
        });
        await this.appendRunEvent(sessionId, runId, event, options);
        const projected = shouldPreserveCheckpointProjectionDuringAppend(current, event)
          ? current!
          : event;
        await this.writeEventProjectionUnlocked(sessionId, event.type, projected).catch(() => {
          // The canonical event is durable; a missing derived projection safely replays raw history.
        });
      });
      return;
    }
    await this.appendRunEvent(sessionId, runId, event, options);
  }

  private async appendRunEvent(
    sessionId: string,
    runId: string,
    event: AgentRunEvent,
    options: { durable?: boolean },
  ): Promise<void> {
    await this.withQueue(sessionId, runId, async () => {
      await mkdir(this.runDir(sessionId, runId), { recursive: true });
      await appendJsonl(
        this.eventsPath(sessionId, runId),
        JSON.stringify(event, sanitizeJson) + '\n',
        { ...options, durabilityRoot: this.durabilityRoot },
      );
    });
  }

  async readEvents(sessionId: string, runId: string): Promise<AgentRunEvent[]> {
    return this.readEventsWithPolicy(sessionId, runId, false);
  }

  async readEventsForRecovery(sessionId: string, runId: string): Promise<AgentRunEvent[]> {
    return this.readEventsWithPolicy(sessionId, runId, true);
  }

  private async readEventsWithPolicy(
    sessionId: string,
    runId: string,
    strict: boolean,
  ): Promise<AgentRunEvent[]> {
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
            `AgentRun ${runId} has a corrupt JSONL record at line ${entry.lineNumber}: ${detail}`,
          );
        }
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
        continue;
      }
      try {
        events.push(
          decodeAgentRunEvent(parsed, {
            sessionId,
            runId,
            turnId: header.turnId,
          }),
        );
      } catch (error) {
        if (strict) {
          const detail = error instanceof Error ? error.message : String(error);
          throw new Error(
            `AgentRun ${runId} has a corrupt JSONL record at line ${entry.lineNumber}: ${detail}`,
          );
        }
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
    options: { replaceEventId?: string } = {},
  ): Promise<void> {
    assertSafeId(sessionId, 'Invalid session id');
    if (event !== null && !isProjectedAgentRunEvent(event, sessionId, type)) {
      throw new Error(`Invalid AgentRun event projection repair for ${type}`);
    }
    await this.withProjectionQueue(sessionId, type, async () => {
      let current: AgentRunEvent | null | undefined;
      try {
        current = await this.readEventProjectionUnlocked(sessionId, type);
      } catch {
        current = undefined;
      }
      if (
        current?.id !== options.replaceEventId &&
        shouldPreserveProjectionDuringRepair(current, event, type)
      )
        return;
      await this.writeEventProjectionUnlocked(sessionId, type, event);
    });
  }

  private async readRunUnlocked(sessionId: string, runId: string): Promise<AgentRunHeader> {
    assertSafeId(sessionId, 'Invalid session id');
    assertSafeId(runId, 'Invalid run id');
    return decodeAgentRunHeader(
      JSON.parse(await readFile(this.runPath(sessionId, runId), 'utf8')),
      { sessionId, runId },
    );
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

  private rootTurnAdmissionPath(sessionId: string, turnId: string): string {
    return join(this.rootTurnAdmissionsRoot(sessionId), `${turnId}.json`);
  }

  private rootTurnAdmissionsRoot(sessionId: string): string {
    return join(this.sessionsRoot, sessionId, 'turn-admissions');
  }

  private async removeUncommittedRunDirectory(sessionId: string, runId: string): Promise<boolean> {
    const directory = this.runDir(sessionId, runId);
    const entries = await readdir(directory, { withFileTypes: true });
    if (entries.some((entry) => !entry.isFile() || !isExclusiveWriteTemp(entry.name, 'run.json'))) {
      return false;
    }
    await rm(directory, { recursive: true });
    await syncDirectory(this.runsRoot(sessionId));
    return true;
  }

  private withQueue(
    sessionId: string,
    runId: string,
    operation: () => Promise<void>,
  ): Promise<void> {
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
      const runs = await readdir(this.runsRoot(sessionId), {
        withFileTypes: true,
      });
      if (
        runs.some(
          (entry) => entry.isDirectory() && isSafeId(entry.name) && entry.name !== currentRunId,
        )
      ) {
        return;
      }
      await this.writeEventProjectionUnlocked(sessionId, type, null);
    }
  }
}

function shouldPreserveCheckpointProjectionDuringAppend(
  current: AgentRunEvent | null | undefined,
  candidate: AgentRunEvent,
): boolean {
  if (!current) return false;
  const currentSourceBound = historyCompactProjectionIsSourceBound(current);
  const candidateSourceBound = historyCompactProjectionIsSourceBound(candidate);
  if (currentSourceBound !== candidateSourceBound) return currentSourceBound;
  const currentCoverage = historyCompactProjectionCoverage(current);
  const candidateCoverage = historyCompactProjectionCoverage(candidate);
  return (
    currentCoverage !== undefined &&
    (candidateCoverage === undefined || currentCoverage > candidateCoverage)
  );
}

function shouldPreserveProjectionDuringRepair(
  current: AgentRunEvent | null | undefined,
  candidate: AgentRunEvent | null,
  type: AgentRunEventType,
): boolean {
  if (!current) return false;
  if (type !== 'history_compact_checkpoint_recorded') return true;
  const currentSourceBound = historyCompactProjectionIsSourceBound(current);
  const candidateSourceBound = candidate ? historyCompactProjectionIsSourceBound(candidate) : false;
  if (currentSourceBound !== candidateSourceBound) return currentSourceBound;
  const currentCoverage = historyCompactProjectionCoverage(current);
  const candidateCoverage = candidate && historyCompactProjectionCoverage(candidate);
  return (
    currentCoverage !== undefined &&
    (candidateCoverage === null ||
      candidateCoverage === undefined ||
      currentCoverage >= candidateCoverage)
  );
}

function historyCompactProjectionIsSourceBound(event: AgentRunEvent): boolean {
  const checkpoint = event.data?.checkpoint;
  if (!checkpoint || typeof checkpoint !== 'object') return false;
  const source = (checkpoint as { source?: unknown }).source;
  if (!source || typeof source !== 'object') return false;
  return (source as { kind?: unknown }).kind === 'runtime_event_projection';
}

function historyCompactProjectionCoverage(event: AgentRunEvent): number | undefined {
  const checkpoint = event.data?.checkpoint;
  if (!checkpoint || typeof checkpoint !== 'object') return undefined;
  const coverage = (checkpoint as { coverage?: unknown }).coverage;
  if (!coverage || typeof coverage !== 'object') return undefined;
  const eventCount = (coverage as { eventCount?: unknown }).eventCount;
  return typeof eventCount === 'number' && Number.isSafeInteger(eventCount) && eventCount >= 0
    ? eventCount
    : undefined;
}

class FileRuntimeEventStore implements DurableRuntimeEventStore {
  private readonly durabilityRoot: string;
  private readonly sessionsRoot: string;
  private readonly writeQueues = new Map<string, Promise<void>>();

  constructor(workspaceRoot: string) {
    this.durabilityRoot = resolve(workspaceRoot);
    this.sessionsRoot = join(this.durabilityRoot, 'sessions');
  }

  async appendRuntimeEvent(
    sessionId: string,
    runId: string,
    event: RuntimeEvent,
    options: { durable?: boolean } = {},
  ): Promise<void> {
    assertSafeId(sessionId, 'Invalid session id');
    assertSafeId(runId, 'Invalid run id');
    await this.withQueue(sessionId, runId, async () => {
      await mkdir(this.runDir(sessionId, runId), { recursive: true });
      const partial = partialRuntimeStream(event);
      if (partial) {
        const partialPath = this.runtimePartialPath(sessionId, runId, partial.key);
        try {
          await readFile(partialPath, 'utf8');
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
          const immutableEvents = await readRuntimeEventJsonl(
            this.runtimeEventsPath(sessionId, runId),
            await this.readRunHeader(sessionId, runId),
          );
          if (
            immutableEvents.some((item) => completedPartialRuntimeStreamKey(item) === partial.key)
          ) {
            return;
          }
          const metadata: RuntimePartialSnapshot = {
            version: 1,
            event: partial.snapshot,
            ...(immutableEvents.at(-1)?.id ? { afterEventId: immutableEvents.at(-1)!.id } : {}),
          };
          await writeAtomic(partialPath, JSON.stringify(metadata, sanitizeJson) + '\n', {
            ...options,
            durabilityRoot: this.durabilityRoot,
          });
        }
        if (partial.text) {
          if (options.durable) {
            await appendFileDurably(partialPath, partial.text, this.durabilityRoot);
          } else {
            await appendFile(partialPath, partial.text, 'utf8');
          }
        }
        return;
      }
      await appendJsonl(
        this.runtimeEventsPath(sessionId, runId),
        JSON.stringify(event, sanitizeJson) + '\n',
        { ...options, durabilityRoot: this.durabilityRoot },
      );
      const completedPartialKey = completedPartialRuntimeStreamKey(event);
      if (completedPartialKey) {
        await rm(this.runtimePartialPath(sessionId, runId, completedPartialKey), {
          force: true,
        }).catch(() => {
          // The immutable final is already durable. Reads suppress any stale snapshot.
        });
      }
    });
  }

  async ensureTerminalRuntimeEventDurable(
    sessionId: string,
    runId: string,
    event: RuntimeEvent,
  ): Promise<void> {
    assertSafeId(sessionId, 'Invalid session id');
    assertSafeId(runId, 'Invalid run id');
    if (event.partial || !isTerminalRuntimeEvent(event)) {
      throw new Error(
        'Only a final terminal RuntimeEvent can cross the terminal durability barrier',
      );
    }
    await this.withQueue(sessionId, runId, async () => {
      const path = this.runtimeEventsPath(sessionId, runId);
      const header = await this.readRunHeader(sessionId, runId);
      const existing = await readRuntimeEventJsonl(path, header);
      const matching = existing.filter((candidate) => candidate.id === event.id);
      if (matching.length > 1) {
        throw new Error(`RuntimeEvent ${event.id} appears more than once in run ${runId}`);
      }
      if (matching.length === 1) {
        const canonical = JSON.parse(JSON.stringify(event, sanitizeJson)) as RuntimeEvent;
        if (!isDeepStrictEqual(matching[0], canonical)) {
          throw new Error(`RuntimeEvent ${event.id} does not match the durable ledger record`);
        }
        try {
          await syncFile(path);
          await syncDirectoryChain(dirname(path), this.durabilityRoot);
        } catch (error) {
          throw new DurableStoreWriteError(
            `Terminal RuntimeEvent did not reach stable storage: ${path}`,
            error,
          );
        }
        return;
      }
      const existingTerminal = existing.find(isTerminalRuntimeEvent);
      if (existingTerminal) {
        throw new Error(`Run ${runId} already has terminal RuntimeEvent ${existingTerminal.id}`);
      }
      await appendJsonl(path, JSON.stringify(event, sanitizeJson) + '\n', {
        durable: true,
        durabilityRoot: this.durabilityRoot,
      });
    });
  }

  async readRuntimeEvents(sessionId: string, runId: string): Promise<RuntimeEvent[]> {
    assertSafeId(sessionId, 'Invalid session id');
    assertSafeId(runId, 'Invalid run id');
    const events = await readRuntimeEventJsonl(
      this.runtimeEventsPath(sessionId, runId),
      await this.readRunHeader(sessionId, runId),
    );
    const partials = await this.readRuntimePartials(sessionId, runId);
    const completedPartialKeys = new Set(
      events
        .map(completedPartialRuntimeStreamKey)
        .filter((key): key is string => key !== undefined),
    );
    const visiblePartials = partials.filter(({ event }) => {
      const key = partialRuntimeStream(event)?.key;
      return !key || !completedPartialKeys.has(key);
    });
    return mergeRuntimePartialSnapshots(events, visiblePartials);
  }

  async readImmutableRuntimeEvents(sessionId: string, runId: string): Promise<RuntimeEvent[]> {
    assertSafeId(sessionId, 'Invalid session id');
    assertSafeId(runId, 'Invalid run id');
    return readRuntimeEventJsonl(
      this.runtimeEventsPath(sessionId, runId),
      await this.readRunHeader(sessionId, runId),
    );
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
    const ordered: Array<{
      event: RuntimeEvent;
      runId: string;
      eventIndex: number;
    }> = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || !isSafeId(entry.name)) continue;
      const events = await this.readRuntimeEvents(sessionId, entry.name);
      for (let eventIndex = 0; eventIndex < events.length; eventIndex += 1) {
        ordered.push({
          event: events[eventIndex]!,
          runId: entry.name,
          eventIndex,
        });
      }
    }
    ordered.sort(
      (a, b) =>
        a.event.ts - b.event.ts ||
        a.runId.localeCompare(b.runId) ||
        a.eventIndex - b.eventIndex ||
        a.event.id.localeCompare(b.event.id),
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

  private async readRunHeader(sessionId: string, runId: string): Promise<AgentRunHeader> {
    return decodeAgentRunHeader(
      JSON.parse(await readFile(join(this.runDir(sessionId, runId), 'run.json'), 'utf8')),
      {
        sessionId,
        runId,
      },
    );
  }

  private runtimePartialsDir(sessionId: string, runId: string): string {
    return join(this.runDir(sessionId, runId), 'runtime-partials');
  }

  private runtimePartialPath(sessionId: string, runId: string, key: string): string {
    return join(this.runtimePartialsDir(sessionId, runId), `${key}.partial`);
  }

  private async readRuntimePartials(
    sessionId: string,
    runId: string,
  ): Promise<RuntimePartialSnapshot[]> {
    let entries;
    try {
      entries = await readdir(this.runtimePartialsDir(sessionId, runId), {
        withFileTypes: true,
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
    const partials: RuntimePartialSnapshot[] = [];
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.partial')) continue;
      const key = entry.name.slice(0, -'.partial'.length);
      try {
        const stored = await readFile(this.runtimePartialPath(sessionId, runId, key), 'utf8');
        const headerEnd = stored.indexOf('\n');
        if (headerEnd < 0) continue;
        const snapshot = JSON.parse(stored.slice(0, headerEnd)) as RuntimePartialSnapshot;
        if (snapshot.version !== 1 || !snapshot.event?.partial) continue;
        const event = snapshot.event;
        if (event.content?.kind === 'text' || event.content?.kind === 'thinking') {
          event.content = {
            ...event.content,
            text: stored.slice(headerEnd + 1),
          };
        }
        partials.push({ ...snapshot, event });
      } catch {
        // A replaceable partial snapshot must never make the immutable ledger unreadable.
      }
    }
    return partials;
  }

  private withQueue(
    sessionId: string,
    runId: string,
    operation: () => Promise<void>,
  ): Promise<void> {
    assertSafeId(sessionId, 'Invalid session id');
    assertSafeId(runId, 'Invalid run id');
    return chainWrite(this.writeQueues, `${sessionId}:${runId}`, operation);
  }
}

function mergeRuntimePartialSnapshots(
  immutableEvents: readonly RuntimeEvent[],
  snapshots: readonly RuntimePartialSnapshot[],
): RuntimeEvent[] {
  const leading: RuntimePartialSnapshot[] = [];
  const afterEvent = new Map<string, RuntimePartialSnapshot[]>();
  for (const snapshot of snapshots) {
    if (!snapshot.afterEventId) {
      leading.push(snapshot);
      continue;
    }
    const grouped = afterEvent.get(snapshot.afterEventId) ?? [];
    grouped.push(snapshot);
    afterEvent.set(snapshot.afterEventId, grouped);
  }
  const order = (a: RuntimePartialSnapshot, b: RuntimePartialSnapshot) =>
    a.event.ts - b.event.ts || a.event.id.localeCompare(b.event.id);
  const merged = leading.sort(order).map(({ event }) => event);
  for (const event of immutableEvents) {
    merged.push(event);
    const anchored = afterEvent.get(event.id);
    if (!anchored) continue;
    merged.push(...anchored.sort(order).map((snapshot) => snapshot.event));
    afterEvent.delete(event.id);
  }
  for (const orphaned of afterEvent.values()) {
    merged.push(...orphaned.sort(order).map((snapshot) => snapshot.event));
  }
  return merged;
}

function partialRuntimeStream(event: RuntimeEvent):
  | {
      key: string;
      snapshot: RuntimeEvent;
      text: string;
    }
  | undefined {
  if (!event.partial || event.status !== undefined || event.actions) return undefined;
  const content = event.content;
  let identity: string | undefined;
  let text = '';
  if (
    content?.kind === 'text' &&
    content.attachments === undefined &&
    event.refs?.providerEventId &&
    hasOnlyKeys(event.refs, ['providerEventId'])
  ) {
    identity = `${content.kind}:provider:${event.refs.providerEventId}`;
    text = content.text;
  } else if (
    content?.kind === 'thinking' &&
    content.signature === undefined &&
    event.refs?.providerEventId &&
    hasOnlyKeys(event.refs, ['providerEventId'])
  ) {
    identity = `${content.kind}:provider:${event.refs.providerEventId}`;
    text = content.text;
  } else if (!content && event.refs?.toolCallId && hasOnlyKeys(event.refs, ['toolCallId'])) {
    identity = `tool:call:${event.refs.toolCallId}`;
  }
  if (!identity) return undefined;
  const key = runtimePartialStreamKey(identity, event);
  const snapshot =
    content?.kind === 'text' || content?.kind === 'thinking'
      ? { ...event, content: { ...content, text: '' } }
      : event;
  return { key, snapshot, text };
}

function completedPartialRuntimeStreamKey(event: RuntimeEvent): string | undefined {
  if (event.partial) return undefined;
  const content = event.content;
  let identity: string | undefined;
  if ((content?.kind === 'text' || content?.kind === 'thinking') && event.refs?.providerEventId) {
    identity = `${content.kind}:provider:${event.refs.providerEventId}`;
  } else if (content?.kind === 'function_response' && event.refs?.toolCallId) {
    identity = `tool:call:${event.refs.toolCallId}`;
  }
  return identity ? runtimePartialStreamKey(identity, event) : undefined;
}

function runtimePartialStreamKey(identity: string, event: RuntimeEvent): string {
  return createHash('sha256')
    .update(
      JSON.stringify([
        identity,
        event.sessionId,
        event.invocationId,
        event.runId,
        event.turnId,
        event.branch ?? null,
        event.role,
        event.author,
      ]),
    )
    .digest('hex');
}

function hasOnlyKeys(value: object, allowed: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

async function readRuntimeEventJsonl(
  path: string,
  expected: AgentRunHeader,
): Promise<RuntimeEvent[]> {
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
      const message = error instanceof Error ? error.message : 'Invalid JSON';
      throw new Error(
        `Invalid RuntimeEvent JSONL line ${entry.lineNumber} for run ${expected.runId}: ${message}`,
      );
    }
    try {
      events.push(decodeRuntimeEvent(parsed, expected));
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Invalid RuntimeEvent';
      throw new Error(
        `Invalid RuntimeEvent JSONL line ${entry.lineNumber} for run ${expected.runId}: ${message}`,
      );
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
  return (
    event.type === type &&
    event.sessionId === sessionId &&
    typeof event.id === 'string' &&
    typeof event.runId === 'string' &&
    typeof event.turnId === 'string' &&
    Number.isFinite(event.ts)
  );
}

interface AtomicWriteOptions {
  durable?: boolean;
  durabilityRoot?: string;
}

async function writeAtomic(
  path: string,
  content: string,
  options: AtomicWriteOptions = {},
): Promise<void> {
  try {
    await writeAtomicUnchecked(path, content, options);
  } catch (error) {
    if (!options.durable || error instanceof DurableStoreWriteError) throw error;
    throw new DurableStoreWriteError(
      `Durable atomic write did not reach stable storage: ${path}`,
      error,
    );
  }
}

async function appendFileDurably(
  path: string,
  content: string,
  durabilityRoot: string,
): Promise<void> {
  try {
    const handle = await open(path, 'a');
    try {
      await handle.appendFile(content, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    await syncDirectoryChain(dirname(path), durabilityRoot);
  } catch (error) {
    if (error instanceof DurableStoreWriteError) throw error;
    throw new DurableStoreWriteError(`Durable append did not reach stable storage: ${path}`, error);
  }
}

async function writeAtomicUnchecked(
  path: string,
  content: string,
  options: AtomicWriteOptions,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tempPath = `${path}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`;
  if (options.durable) {
    const handle = await open(tempPath, 'wx', 0o600);
    try {
      await handle.writeFile(content, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
  } else {
    await writeFile(tempPath, content, 'utf8');
  }
  await rename(tempPath, path);
  if (options.durable) {
    if (!options.durabilityRoot) {
      throw new Error('Durable atomic write requires a durability root');
    }
    await syncDirectoryChain(dirname(path), options.durabilityRoot);
  }
}

async function writeExclusiveAtomic(
  path: string,
  content: string,
  options: { durable?: boolean },
  durabilityRoot: string,
): Promise<boolean> {
  try {
    return await writeExclusiveAtomicUnchecked(path, content, options, durabilityRoot);
  } catch (error) {
    if (!options.durable || error instanceof DurableStoreWriteError) throw error;
    throw new DurableStoreWriteError(
      `Durable exclusive write did not reach stable storage: ${path}`,
      error,
    );
  }
}

async function writeExclusiveAtomicUnchecked(
  path: string,
  content: string,
  options: { durable?: boolean },
  durabilityRoot: string,
): Promise<boolean> {
  const directory = dirname(path);
  await mkdir(directory, { recursive: true });
  const tempPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  const handle = await open(tempPath, 'wx', 0o600);
  try {
    await handle.writeFile(content, 'utf8');
    if (options.durable) await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await link(tempPath, path);
    await unlink(tempPath);
    if (options.durable) await syncDirectoryChain(directory, durabilityRoot);
    return true;
  } catch (error) {
    await unlink(tempPath).catch(() => {});
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      if (options.durable) {
        await syncFile(path);
        await syncDirectoryChain(directory, durabilityRoot);
      }
      return false;
    }
    throw error;
  }
}

function assertSafeId(value: string, message: string): void {
  if (!isSafeId(value)) throw new Error(message);
}

function isSafeId(value: string): boolean {
  return SAFE_ID_PATTERN.test(value);
}

function normalizeRootTurnAdmission(
  value: unknown,
  sessionId: string,
  turnId: string,
): RootTurnAdmission {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Invalid root turn admission for turn ${turnId}: expected an object`);
  }
  const record = value as Record<string, unknown>;
  const valid =
    record.schemaVersion === ROOT_TURN_ADMISSION_SCHEMA_VERSION &&
    record.sessionId === sessionId &&
    record.turnId === turnId &&
    typeof record.runId === 'string' &&
    isSafeId(record.runId) &&
    typeof record.userMessageId === 'string' &&
    isSafeId(record.userMessageId) &&
    Number.isSafeInteger(record.admittedAt) &&
    (record.admittedAt as number) >= 0 &&
    hasExactKeys(record, [
      'schemaVersion',
      'sessionId',
      'turnId',
      'runId',
      'userMessageId',
      'normalizedInput',
      'admittedAt',
    ]);
  if (!valid) {
    throw new Error(`Invalid root turn admission for turn ${turnId}: malformed fields`);
  }
  return {
    schemaVersion: ROOT_TURN_ADMISSION_SCHEMA_VERSION,
    sessionId,
    turnId,
    runId: record.runId as string,
    userMessageId: record.userMessageId as string,
    normalizedInput: normalizeRootTurnAdmissionInput(record.normalizedInput),
    admittedAt: record.admittedAt as number,
  };
}

function normalizeRootTurnAdmissionInput(value: unknown): RootTurnAdmissionInput {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Invalid root turn normalized input: expected an object');
  }
  const record = value as Record<string, unknown>;
  if (
    !hasExactKeys(record, ['text']) ||
    typeof record.text !== 'string' ||
    record.text.length === 0
  ) {
    throw new Error('Invalid root turn normalized input');
  }
  return { text: record.text };
}

function turnIdFromAdmissionFile(name: string): string | undefined {
  if (!name.endsWith('.json')) return undefined;
  const turnId = name.slice(0, -'.json'.length);
  return isSafeId(turnId) ? turnId : undefined;
}

function isRootTurnAdmissionTemp(name: string): boolean {
  const marker = '.json.';
  const markerIndex = name.indexOf(marker);
  if (markerIndex < 1) return false;
  return (
    isSafeId(name.slice(0, markerIndex)) &&
    EXCLUSIVE_TEMP_SUFFIX_PATTERN.test(name.slice(markerIndex + marker.length))
  );
}

function isExclusiveWriteTemp(name: string, targetName: string): boolean {
  const prefix = `${targetName}.`;
  return name.startsWith(prefix) && EXCLUSIVE_TEMP_SUFFIX_PATTERN.test(name.slice(prefix.length));
}

function hasExactKeys(record: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(record);
  return keys.length === expected.length && expected.every((key) => Object.hasOwn(record, key));
}

function isMissingFile(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT';
}

function sanitizeJson(_key: string, value: unknown): unknown {
  return value === undefined ? undefined : value;
}
