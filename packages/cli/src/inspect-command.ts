import { resolve } from 'node:path';
import type { AgentRunHeader, SessionHeader } from '@maka/core';
import {
  createTaskRunStore,
  inspectTaskRun,
  renderTaskRunInspectTree,
  type TaskRunInspectDocument,
  type TaskRunStore,
} from '@maka/headless';
import {
  inspectAgentRunDocument,
  inspectSessionDocument,
  renderAgentRunInspectTree,
  renderSessionInspectTree,
  type AgentRunInspectDocument,
  type SessionInspectDocument,
} from '@maka/runtime';
import {
  createAgentRunStore,
  createRuntimeEventStore,
  createSessionStore,
  type SessionStore,
} from '@maka/storage';
import type { AgentRunStore, RuntimeEventStore } from '@maka/core';
import { resolveMakaWorkspaceRoot } from './workspace-root.js';

export const INSPECT_RESOLUTION_SCHEMA_VERSION = 'maka.inspect_resolution.v1' as const;

export type InspectEntityKind = 'session' | 'agent-run' | 'task-run';

export interface InspectCandidateDescriptor {
  kind: InspectEntityKind;
  id: string;
  sessionId?: string;
}

export interface InspectResolutionDocument {
  schemaVersion: typeof INSPECT_RESOLUTION_SCHEMA_VERSION;
  kind: 'inspect_resolution';
  query: {
    id: string;
    requestedKind?: InspectEntityKind;
    sessionId?: string;
  };
  status: 'not_found' | 'ambiguous';
  candidates: InspectCandidateDescriptor[];
}

export type InspectDocument =
  | SessionInspectDocument
  | AgentRunInspectDocument
  | TaskRunInspectDocument;

export interface InspectCommandStores {
  sessionStore: SessionStore;
  agentRunStore: AgentRunStore;
  runtimeEventStore: RuntimeEventStore;
  taskRunStore: TaskRunStore;
}

interface SessionCandidate extends InspectCandidateDescriptor {
  kind: 'session';
  header: SessionHeader;
}

interface AgentRunCandidate extends InspectCandidateDescriptor {
  kind: 'agent-run';
  sessionId: string;
  header: AgentRunHeader;
}

interface TaskRunCandidate extends InspectCandidateDescriptor {
  kind: 'task-run';
}

type InspectCandidate = SessionCandidate | AgentRunCandidate | TaskRunCandidate;

export type InspectResolution =
  | { status: 'resolved'; candidate: InspectCandidate }
  | { status: 'not_found' | 'ambiguous'; document: InspectResolutionDocument };

export async function resolveInspectTarget(
  stores: InspectCommandStores,
  query: { id: string; requestedKind?: InspectEntityKind; sessionId?: string },
): Promise<InspectResolution> {
  let candidates: InspectCandidate[];
  if (query.requestedKind === 'session') {
    candidates = await findSessionCandidates(stores.sessionStore, query.id);
  } else if (query.requestedKind === 'task-run') {
    candidates = await findTaskRunCandidates(stores.taskRunStore, query.id);
  } else if (query.requestedKind === 'agent-run') {
    candidates = await findAgentRunCandidates(stores, query.id, query.sessionId);
  } else {
    const [sessions, agentRuns, taskRuns] = await Promise.all([
      findSessionCandidates(stores.sessionStore, query.id),
      findAgentRunCandidates(stores, query.id),
      findTaskRunCandidates(stores.taskRunStore, query.id),
    ]);
    candidates = [...sessions, ...agentRuns, ...taskRuns];
  }

  candidates.sort(compareCandidates);
  if (candidates.length === 1) return { status: 'resolved', candidate: candidates[0]! };
  const status = candidates.length === 0 ? 'not_found' : 'ambiguous';
  return {
    status,
    document: {
      schemaVersion: INSPECT_RESOLUTION_SCHEMA_VERSION,
      kind: 'inspect_resolution',
      query: {
        id: query.id,
        ...(query.requestedKind ? { requestedKind: query.requestedKind } : {}),
        ...(query.sessionId ? { sessionId: query.sessionId } : {}),
      },
      status,
      candidates: candidates.map(({ kind, id, sessionId }) => ({
        kind,
        id,
        ...(sessionId ? { sessionId } : {}),
      })),
    },
  };
}

export async function inspectResolvedTarget(
  stores: InspectCommandStores,
  candidate: InspectCandidate,
): Promise<InspectDocument> {
  if (candidate.kind === 'task-run') {
    return inspectTaskRun(
      {
        taskRunStore: stores.taskRunStore,
        agentRunStore: stores.agentRunStore,
        runtimeEventStore: stores.runtimeEventStore,
      },
      candidate.id,
    );
  }
  if (candidate.kind === 'agent-run') {
    return inspectAgentRunDocument(stores.agentRunStore, stores.runtimeEventStore, {
      sessionId: candidate.sessionId,
      agentRunId: candidate.id,
      header: candidate.header,
    });
  }
  return inspectSessionDocument(
    { readHeader: (id) => stores.sessionStore.readHeaderSnapshot(id) },
    stores.agentRunStore,
    stores.runtimeEventStore,
    candidate.id,
    candidate.header,
  );
}

export async function runMakaInspectCli(args: string[]): Promise<number> {
  let parsed: ParsedInspectArgs;
  try {
    parsed = parseInspectArgs(args);
  } catch (error) {
    process.stderr.write(`${errorMessage(error)}\n\n${inspectUsage()}\n`);
    return 2;
  }
  if (parsed.help) {
    process.stdout.write(`${inspectUsage()}\n`);
    return 0;
  }
  if (!parsed.id) {
    process.stderr.write(`${inspectUsage()}\n`);
    return 2;
  }

  const storageRoot = parsed.store ? resolve(parsed.store) : resolveMakaWorkspaceRoot();
  const stores: InspectCommandStores = {
    sessionStore: createSessionStore(storageRoot),
    agentRunStore: createAgentRunStore(storageRoot),
    runtimeEventStore: createRuntimeEventStore(storageRoot),
    taskRunStore: createTaskRunStore(storageRoot),
  };
  const resolution = await resolveInspectTarget(stores, {
    id: parsed.id,
    ...(parsed.kind ? { requestedKind: parsed.kind } : {}),
    ...(parsed.sessionId ? { sessionId: parsed.sessionId } : {}),
  });
  if (resolution.status !== 'resolved') {
    if (parsed.json) {
      process.stdout.write(`${JSON.stringify(resolution.document, null, 2)}\n`);
    } else {
      process.stderr.write(`${renderResolutionFailure(resolution.document)}\n`);
    }
    return resolution.status === 'ambiguous' ? 2 : 1;
  }

  const document = await inspectResolvedTarget(stores, resolution.candidate);
  if (parsed.json) {
    process.stdout.write(`${JSON.stringify(document, null, 2)}\n`);
  } else if (document.kind === 'task_run') {
    process.stdout.write(renderTaskRunInspectTree(document));
  } else if (document.kind === 'agent_run') {
    process.stdout.write(renderAgentRunInspectTree(document));
  } else {
    process.stdout.write(renderSessionInspectTree(document));
  }
  return 0;
}

interface ParsedInspectArgs {
  id?: string;
  store?: string;
  kind?: InspectEntityKind;
  sessionId?: string;
  json: boolean;
  help: boolean;
}

function parseInspectArgs(args: readonly string[]): ParsedInspectArgs {
  const positional: string[] = [];
  let store: string | undefined;
  let kind: InspectEntityKind | undefined;
  let sessionId: string | undefined;
  let json = false;
  let help = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg === '--json') {
      json = true;
    } else if (arg === '--help' || arg === '-h') {
      help = true;
    } else if (arg === '--store' || arg === '--kind' || arg === '--session') {
      const value = args[index + 1];
      if (!value || value.startsWith('--')) throw new Error(`${arg} requires a value`);
      index += 1;
      if (arg === '--store') store = value;
      else if (arg === '--session') sessionId = value;
      else if (isInspectEntityKind(value)) kind = value;
      else throw new Error(`invalid --kind: ${value}`);
    } else if (arg.startsWith('-')) {
      throw new Error(`unknown option: ${arg}`);
    } else {
      positional.push(arg);
    }
  }
  if (positional.length > 1) throw new Error(`unexpected argument: ${positional[1]}`);
  if (sessionId && kind !== 'agent-run') {
    throw new Error('--session requires --kind agent-run');
  }
  return {
    ...(positional[0] ? { id: positional[0] } : {}),
    ...(store ? { store } : {}),
    ...(kind ? { kind } : {}),
    ...(sessionId ? { sessionId } : {}),
    json,
    help,
  };
}

function isInspectEntityKind(value: string): value is InspectEntityKind {
  return value === 'session' || value === 'agent-run' || value === 'task-run';
}

async function findSessionCandidates(store: SessionStore, id: string): Promise<SessionCandidate[]> {
  const summaries = await store.list();
  if (!summaries.some((session) => session.id === id)) return [];
  return [{ kind: 'session', id, header: await store.readHeaderSnapshot(id) }];
}

async function findTaskRunCandidates(store: TaskRunStore, id: string): Promise<TaskRunCandidate[]> {
  const records = await store.readEventRecords(id);
  return records.length > 0 ? [{ kind: 'task-run', id }] : [];
}

async function findAgentRunCandidates(
  stores: Pick<InspectCommandStores, 'sessionStore' | 'agentRunStore'>,
  id: string,
  sessionId?: string,
): Promise<AgentRunCandidate[]> {
  if (sessionId) {
    try {
      const header = await stores.agentRunStore.readRun(sessionId, id);
      return [{ kind: 'agent-run', id, sessionId, header }];
    } catch (error) {
      if (isNotFound(error)) return [];
      throw error;
    }
  }
  const sessions = await stores.sessionStore.list();
  const runLists = await Promise.all(
    sessions.map((session) => stores.agentRunStore.listSessionRuns(session.id)),
  );
  const candidates: AgentRunCandidate[] = [];
  runLists.forEach((runs) => {
    for (const header of runs) {
      if (header.runId === id) {
        candidates.push({ kind: 'agent-run', id, sessionId: header.sessionId, header });
      }
    }
  });
  return candidates;
}

function compareCandidates(a: InspectCandidate, b: InspectCandidate): number {
  return a.kind.localeCompare(b.kind) || (a.sessionId ?? '').localeCompare(b.sessionId ?? '');
}

function renderResolutionFailure(document: InspectResolutionDocument): string {
  if (document.status === 'not_found') {
    return `No Session, AgentRun, or TaskRun found for ${document.query.id}.`;
  }
  const candidates = document.candidates.map((candidate) =>
    candidate.kind === 'agent-run'
      ? `  - agent-run ${candidate.id} in session ${candidate.sessionId}`
      : `  - ${candidate.kind} ${candidate.id}`,
  );
  return [
    `Inspect target ${document.query.id} is ambiguous:`,
    ...candidates,
    'Choose one with --kind session|agent-run|task-run; add --session <id> for a duplicate AgentRun id.',
  ].join('\n');
}

function inspectUsage(): string {
  return [
    'Usage: maka inspect <id> [--store <root>] [--kind session|agent-run|task-run] [--session <sessionId>] [--json]',
    '',
    'Inspects Session, AgentRun, or TaskRun evidence without copying raw model or tool payloads.',
    'The default store is the current Maka desktop workspace.',
  ].join('\n');
}

function isNotFound(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === 'ENOENT';
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
