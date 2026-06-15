import type {
  AgentRunHeader,
  AgentRunStore,
  RuntimeEvent,
  RuntimeEventStore,
  StoredMessage,
  TurnRecord,
} from '@maka/core';
import { deriveTurnRecords, isTerminalRuntimeEvent } from '@maka/core';
import {
  classifyRuntimeEventTerminalFact,
  compareRuntimeReadModelMessages,
  projectRuntimeEventsToStoredMessages,
  type RuntimeEventReadModelDiagnostic,
  type RuntimeEventTerminalFact,
} from './runtime-event-read-model.js';
import { buildRuntimeEventModelReplayPlan, type RuntimeEventModelReplayPlan } from './model-history.js';

export interface RuntimeReadModelProjectionCache {
  readMessages(sessionId: string): Promise<StoredMessage[]>;
}

export interface RuntimeReadModelDeps {
  runStore: AgentRunStore;
  runtimeEventStore: RuntimeEventStore;
  projectionCache?: RuntimeReadModelProjectionCache;
}

export interface RuntimeReadModelSessionView {
  source: 'runtime_events';
  messages: StoredMessage[];
  turns: TurnRecord[];
  events: RuntimeEvent[];
  runs: AgentRunHeader[];
  diagnostics: RuntimeEventReadModelDiagnostic[];
  terminalFacts: RuntimeEventTerminalFact[];
  replayPlan: RuntimeEventModelReplayPlan;
}

export class RuntimeReadModelError extends Error {
  readonly diagnostics: RuntimeEventReadModelDiagnostic[];

  constructor(message: string, diagnostics: RuntimeEventReadModelDiagnostic[]) {
    super(message);
    this.name = 'RuntimeReadModelError';
    this.diagnostics = diagnostics;
  }
}

export class RuntimeReadModel {
  constructor(private readonly deps: RuntimeReadModelDeps) {}

  async getSessionMessages(sessionId: string): Promise<StoredMessage[]> {
    return (await this.getSessionView(sessionId)).messages;
  }

  async getSessionTurns(sessionId: string): Promise<TurnRecord[]> {
    return (await this.getSessionView(sessionId)).turns;
  }

  async getSessionView(sessionId: string): Promise<RuntimeReadModelSessionView> {
    const diagnostics: RuntimeEventReadModelDiagnostic[] = [];
    let runs: AgentRunHeader[];
    try {
      runs = await this.deps.runStore.listSessionRuns(sessionId);
    } catch (error) {
      throw new RuntimeReadModelError('RuntimeReadModel could not list AgentRun headers', [
        readModelDiagnostic('unsupported_event', 'AgentRunStore.listSessionRuns failed', {
          error: errorMessage(error),
        }),
      ]);
    }

    if (runs.length === 0) {
      return this.buildView({ runs, events: [], diagnostics });
    }

    const ordered: Array<{ event: RuntimeEvent; runIndex: number; eventIndex: number }> = [];
    const terminalFacts: RuntimeEventTerminalFact[] = [];
    for (let runIndex = 0; runIndex < runs.length; runIndex += 1) {
      const run = runs[runIndex]!;
      if (!isTerminalRunStatus(run.status)) {
        throw new RuntimeReadModelError('RuntimeEvent ledger is incomplete for an active run', [
          readModelDiagnostic('incomplete_event', 'active run has no stable RuntimeEvent read projection', {
            runId: run.runId,
            turnId: run.turnId,
            status: run.status,
          }),
        ]);
      }

      let runEvents: RuntimeEvent[];
      try {
        runEvents = await this.deps.runtimeEventStore.readRuntimeEvents(sessionId, run.runId);
      } catch (error) {
        throw new RuntimeReadModelError('RuntimeEvent ledger read failed', [
          readModelDiagnostic('unsupported_event', 'RuntimeEventStore.readRuntimeEvents failed', {
            runId: run.runId,
            error: errorMessage(error),
          }),
        ]);
      }

      if (runEvents.length === 0) {
        throw new RuntimeReadModelError('RuntimeEvent ledger is missing for a terminal run', [
          readModelDiagnostic('incomplete_event', 'terminal run has no readable RuntimeEvent ledger', {
            runId: run.runId,
            turnId: run.turnId,
          }),
        ]);
      }
      if (!runEvents.some(isTerminalRuntimeEvent)) {
        throw new RuntimeReadModelError('RuntimeEvent ledger has no terminal fact for a terminal run', [
          readModelDiagnostic('incomplete_event', 'terminal run has no terminal RuntimeEvent', {
            runId: run.runId,
            turnId: run.turnId,
          }),
        ]);
      }

      const terminalFact = classifyRuntimeEventTerminalFact(run, runEvents);
      diagnostics.push(...terminalFact.diagnostics);
      if (terminalFact.fact) terminalFacts.push(terminalFact.fact);

      for (let eventIndex = 0; eventIndex < runEvents.length; eventIndex += 1) {
        ordered.push({ event: runEvents[eventIndex]!, runIndex, eventIndex });
      }
    }

    ordered.sort((a, b) =>
      a.event.ts - b.event.ts ||
      a.runIndex - b.runIndex ||
      a.eventIndex - b.eventIndex ||
      a.event.id.localeCompare(b.event.id)
    );

    return this.buildView({
      runs,
      events: ordered.map((item) => item.event),
      diagnostics,
      terminalFacts,
    });
  }

  private async buildView(input: {
    runs: AgentRunHeader[];
    events: RuntimeEvent[];
    diagnostics: RuntimeEventReadModelDiagnostic[];
    terminalFacts?: RuntimeEventTerminalFact[];
  }): Promise<RuntimeReadModelSessionView> {
    const projected = projectRuntimeEventsToStoredMessages(input.events, { runHeaders: input.runs });
    const diagnostics = [...input.diagnostics, ...projected.diagnostics];
    if (hasHardProjectionDiagnostic(projected.diagnostics)) {
      throw new RuntimeReadModelError('RuntimeEvent read projection is incomplete', diagnostics);
    }

    const cacheDiagnostics = await this.compareProjectionCache(input.runs[0]?.sessionId, projected.messages);
    diagnostics.push(...cacheDiagnostics);

    return {
      source: 'runtime_events',
      messages: projected.messages,
      turns: deriveTurnRecords(projected.messages),
      events: input.events,
      runs: input.runs,
      diagnostics,
      terminalFacts: input.terminalFacts ?? [],
      replayPlan: buildRuntimeEventModelReplayPlan(input.events),
    };
  }

  private async compareProjectionCache(
    sessionId: string | undefined,
    messages: readonly StoredMessage[],
  ): Promise<RuntimeEventReadModelDiagnostic[]> {
    if (!sessionId || !this.deps.projectionCache) return [];
    let cached: StoredMessage[];
    try {
      cached = await this.deps.projectionCache.readMessages(sessionId);
    } catch (error) {
      return [readModelDiagnostic('unsupported_event', 'SessionProjectionCache.readMessages failed', {
        error: errorMessage(error),
      })];
    }
    return compareRuntimeReadModelMessages(messages, cached).diagnostics;
  }
}

function hasHardProjectionDiagnostic(diagnostics: readonly RuntimeEventReadModelDiagnostic[]): boolean {
  return diagnostics.some((diagnostic) =>
    diagnostic.code === 'incomplete_event' ||
    diagnostic.code === 'unsupported_event' ||
    diagnostic.code === 'tool_use_id_mismatch'
  );
}

function readModelDiagnostic(
  code: RuntimeEventReadModelDiagnostic['code'],
  message: string,
  detail?: unknown,
): RuntimeEventReadModelDiagnostic {
  return {
    code,
    message,
    ...(detail !== undefined ? { detail } : {}),
  };
}

function isTerminalRunStatus(status: AgentRunHeader['status']): boolean {
  return status === 'completed' || status === 'failed' || status === 'cancelled';
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
