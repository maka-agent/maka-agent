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
import {
  buildRuntimeEventModelReplayPlan,
  type RuntimeEventModelReplayPlan,
} from './model-history.js';
import { backfillRuntimeEventsFromStoredMessages } from './runtime-event-backfill.js';
import {
  effectiveRunHeaderFromTerminalFact,
  terminalRunHeaderMatchesFact,
} from './terminal-run-commit.js';

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
    const inFlightTurnIds = new Set<string>();
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

    const topLevelRuns = runs.filter((run) => !run.parentRunId);

    if (topLevelRuns.length === 0) {
      return this.buildView({ runs: topLevelRuns, events: [], diagnostics });
    }

    const ordered: Array<{ event: RuntimeEvent; runIndex: number; eventIndex: number }> = [];
    const terminalFacts: RuntimeEventTerminalFact[] = [];
    for (let runIndex = 0; runIndex < topLevelRuns.length; runIndex += 1) {
      const run = topLevelRuns[runIndex]!;
      if (!isTerminalRunStatus(run.status)) {
        const terminalFactContext = await this.readNonTerminalRunWithTerminalFact(sessionId, run);
        if (terminalFactContext) {
          topLevelRuns[runIndex] = terminalFactContext.run;
          terminalFacts.push(terminalFactContext.fact);
          diagnostics.push(...terminalFactContext.fact.diagnostics);
          for (
            let eventIndex = 0;
            eventIndex < terminalFactContext.events.length;
            eventIndex += 1
          ) {
            ordered.push({ event: terminalFactContext.events[eventIndex]!, runIndex, eventIndex });
          }
          continue;
        }

        const diagnostic = readModelDiagnostic(
          'incomplete_event',
          'active run is using the in-flight projection cache',
          {
            runId: run.runId,
            turnId: run.turnId,
            status: run.status,
          },
        );
        diagnostics.push(diagnostic);
        inFlightTurnIds.add(run.turnId);
        if (!this.deps.projectionCache) {
          throw new RuntimeReadModelError('RuntimeEvent ledger is incomplete for an active run', [
            readModelDiagnostic(
              'incomplete_event',
              'active run has no stable RuntimeEvent read projection',
              {
                runId: run.runId,
                turnId: run.turnId,
                status: run.status,
              },
            ),
          ]);
        }
        continue;
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
        const recovered = await this.backfillMissingRuntimeEvents(sessionId, run);
        if (recovered.length === 0 || !recovered.some(isTerminalRuntimeEvent)) {
          throw new RuntimeReadModelError('RuntimeEvent ledger is missing for a terminal run', [
            readModelDiagnostic(
              'incomplete_event',
              'terminal run has no readable RuntimeEvent ledger',
              {
                runId: run.runId,
                turnId: run.turnId,
              },
            ),
          ]);
        }
        diagnostics.push(
          readModelDiagnostic(
            'incomplete_event',
            'terminal run recovered from legacy projection cache',
            {
              runId: run.runId,
              turnId: run.turnId,
            },
          ),
        );
        runEvents = recovered;
      }
      if (!runEvents.some(isTerminalRuntimeEvent)) {
        throw new RuntimeReadModelError(
          'RuntimeEvent ledger has no terminal fact for a terminal run',
          [
            readModelDiagnostic('incomplete_event', 'terminal run has no terminal RuntimeEvent', {
              runId: run.runId,
              turnId: run.turnId,
            }),
          ],
        );
      }

      const terminalFact = classifyRuntimeEventTerminalFact(run, runEvents);
      diagnostics.push(...terminalFact.diagnostics);
      if (!terminalFact.fact) {
        throw new RuntimeReadModelError(
          'RuntimeEvent ledger has no valid terminal fact for a terminal run',
          diagnostics,
        );
      }
      if (!terminalRunHeaderMatchesFact(run, terminalFact.fact)) {
        diagnostics.push(
          readModelDiagnostic(
            'incomplete_event',
            'terminal run header does not match RuntimeEvent terminal fact',
            {
              runId: run.runId,
              turnId: run.turnId,
              headerStatus: run.status,
              factStatus: terminalFact.fact.runStatus,
              headerFailureClass: run.failureClass,
              factFailureClass: terminalFact.fact.failureClass,
              headerAbortSource: run.abortSource,
              factAbortSource: terminalFact.fact.abortSource,
            },
          ),
        );
      }
      topLevelRuns[runIndex] = effectiveRunHeaderFromTerminalFact(run, terminalFact.fact);
      terminalFacts.push(terminalFact.fact);

      for (let eventIndex = 0; eventIndex < runEvents.length; eventIndex += 1) {
        ordered.push({ event: runEvents[eventIndex]!, runIndex, eventIndex });
      }
    }

    ordered.sort(
      (a, b) =>
        a.event.ts - b.event.ts ||
        a.runIndex - b.runIndex ||
        a.eventIndex - b.eventIndex ||
        a.event.id.localeCompare(b.event.id),
    );

    return this.buildView({
      runs: topLevelRuns,
      events: ordered.map((item) => item.event),
      diagnostics,
      terminalFacts,
      inFlightTurnIds,
    });
  }

  private async readNonTerminalRunWithTerminalFact(
    sessionId: string,
    run: AgentRunHeader,
  ): Promise<
    { events: RuntimeEvent[]; fact: RuntimeEventTerminalFact; run: AgentRunHeader } | undefined
  > {
    let runEvents: RuntimeEvent[];
    try {
      runEvents = await this.deps.runtimeEventStore.readRuntimeEvents(sessionId, run.runId);
    } catch {
      return undefined;
    }
    const fact = classifyRuntimeEventTerminalFact(run, runEvents).fact;
    if (!fact) return undefined;
    return {
      events: runEvents,
      fact,
      run: effectiveRunHeaderFromTerminalFact(run, fact),
    };
  }

  private async backfillMissingRuntimeEvents(
    sessionId: string,
    run: AgentRunHeader,
  ): Promise<RuntimeEvent[]> {
    if (!this.deps.projectionCache) return [];
    let messages: StoredMessage[];
    try {
      messages = await this.deps.projectionCache.readMessages(sessionId);
    } catch {
      return [];
    }
    return backfillRuntimeEventsFromStoredMessages({ run, messages }).events;
  }

  private async buildView(input: {
    runs: AgentRunHeader[];
    events: RuntimeEvent[];
    diagnostics: RuntimeEventReadModelDiagnostic[];
    terminalFacts?: RuntimeEventTerminalFact[];
    inFlightTurnIds?: ReadonlySet<string>;
  }): Promise<RuntimeReadModelSessionView> {
    const projected = projectRuntimeEventsToStoredMessages(input.events, {
      runHeaders: input.runs,
    });
    const diagnostics = [...input.diagnostics, ...projected.diagnostics];
    if (hasHardProjectionDiagnostic(projected.diagnostics)) {
      throw new RuntimeReadModelError('RuntimeEvent read projection is incomplete', diagnostics);
    }

    const sessionId = input.runs[0]?.sessionId;
    let cachedMessages: StoredMessage[] | undefined;
    if (sessionId && this.deps.projectionCache) {
      try {
        cachedMessages = await this.deps.projectionCache.readMessages(sessionId);
      } catch (error) {
        const diagnostic = readModelDiagnostic(
          'unsupported_event',
          'SessionProjectionCache.readMessages failed',
          {
            error: errorMessage(error),
          },
        );
        diagnostics.push(diagnostic);
        if (input.inFlightTurnIds && input.inFlightTurnIds.size > 0) {
          throw new RuntimeReadModelError(
            'RuntimeEvent active projection cache read failed',
            diagnostics,
          );
        }
      }
    }

    const messages =
      input.inFlightTurnIds && input.inFlightTurnIds.size > 0
        ? mergeInFlightProjectionCache(
            projected.messages,
            cachedMessages ?? [],
            input.inFlightTurnIds,
          )
        : projected.messages;

    diagnostics.push(...this.compareProjectionCache(messages, cachedMessages));

    return {
      source: 'runtime_events',
      messages,
      turns: deriveTurnRecords(messages),
      events: input.events,
      runs: input.runs,
      diagnostics,
      terminalFacts: input.terminalFacts ?? [],
      replayPlan: buildRuntimeEventModelReplayPlan(input.events),
    };
  }

  private compareProjectionCache(
    messages: readonly StoredMessage[],
    cached: readonly StoredMessage[] | undefined,
  ): RuntimeEventReadModelDiagnostic[] {
    if (!cached) return [];
    return compareRuntimeReadModelMessages(messages, cached).diagnostics;
  }
}

function mergeInFlightProjectionCache(
  runtimeMessages: readonly StoredMessage[],
  cachedMessages: readonly StoredMessage[],
  inFlightTurnIds: ReadonlySet<string>,
): StoredMessage[] {
  const merged = runtimeMessages.map((message, index) => ({ message, index }));
  const seenIds = new Set(runtimeMessages.map((message) => message.id));
  for (const cached of cachedMessages) {
    const turnId = messageTurnId(cached);
    if (!turnId || !inFlightTurnIds.has(turnId) || seenIds.has(cached.id)) continue;
    seenIds.add(cached.id);
    merged.push({ message: cached, index: merged.length });
  }
  return merged
    .sort((a, b) => a.message.ts - b.message.ts || a.index - b.index)
    .map((entry) => entry.message);
}

function messageTurnId(message: StoredMessage): string | undefined {
  return 'turnId' in message && typeof message.turnId === 'string' ? message.turnId : undefined;
}

function hasHardProjectionDiagnostic(
  diagnostics: readonly RuntimeEventReadModelDiagnostic[],
): boolean {
  return diagnostics.some(
    (diagnostic) =>
      diagnostic.code === 'incomplete_event' ||
      diagnostic.code === 'unsupported_event' ||
      diagnostic.code === 'tool_use_id_mismatch',
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
