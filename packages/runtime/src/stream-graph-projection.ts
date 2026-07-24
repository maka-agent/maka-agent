import type { AgentRunHeader, AgentRunStore, RuntimeEvent, RuntimeEventStore } from '@maka/core';
import { stableHash, stableStringify } from './request-shape.js';

export const AGENT_GRAPH_RECORD_SCHEMA_VERSION = 1 as const;

export const AGENT_GRAPH_RECORD_FACETS = [
  'message',
  'thinking',
  'error',
  'tool_call',
  'tool_dispatch',
  'tool_result',
  'artifact_update',
  'permission_request',
  'permission_decision',
  'user_question_request',
  'transfer',
  'usage',
  'completed',
  'failed',
  'aborted',
  'cancelled',
  'runtime_fact',
] as const;

export type AgentGraphRecordFacet = (typeof AGENT_GRAPH_RECORD_FACETS)[number];

export type AgentGraphActivationStatus =
  | 'running'
  | 'blocked'
  | 'completed'
  | 'failed'
  | 'aborted'
  | 'cancelled';

/**
 * Read-only binding between a graph operator and an existing durable Session.
 *
 * The graph does not own the Session or its RuntimeEvents. Each session-inline
 * AgentRun is projected as one activation while the Session remains the stable
 * operator execution identity across follow-ups and recovery.
 */
export interface AgentGraphOperatorBinding {
  operatorId: string;
  sessionId: string;
}

export interface AgentGraphRuntimeEventSource {
  kind: 'runtime_event';
  runtimeEventId: string;
  sessionId: string;
  runId: string;
  turnId: string;
  ts: number;
}

/**
 * A bounded reference-only record projected from one committed RuntimeEvent.
 *
 * The source RuntimeEvent remains authoritative. The graph record deliberately
 * does not copy message/tool payloads, and `partial: true` events never enter
 * this stream.
 */
export interface AgentGraphRecord {
  schemaVersion: typeof AGENT_GRAPH_RECORD_SCHEMA_VERSION;
  recordId: string;
  graphId: string;
  operatorId: string;
  activationId: string;
  sessionId: string;
  agentRunId: string;
  logicalTime: number;
  previousRecordId?: string;
  type: 'agent_runtime_event';
  facets: AgentGraphRecordFacet[];
  source: AgentGraphRuntimeEventSource;
}

export interface AgentGraphActivationState {
  activationId: string;
  agentRunId: string;
  status: AgentGraphActivationStatus;
  recordCount: number;
  firstLogicalTime: number;
  lastLogicalTime: number;
  lastRecordId: string;
  terminalRecordId?: string;
}

export interface AgentGraphOperatorState {
  operatorId: string;
  sessionId: string;
  status: AgentGraphActivationStatus;
  currentActivationId: string;
  activations: Record<string, AgentGraphActivationState>;
}

/**
 * Deterministic trace state only. It intentionally has no graph-wide
 * completion flag: topology closure and admission closure require a later
 * control protocol and cannot be inferred from observed Agent runs alone.
 */
export interface AgentGraphReplayState {
  graphId: string;
  lastLogicalTime: number;
  appliedRecordIds: string[];
  operators: Record<string, AgentGraphOperatorState>;
}

export interface AgentGraphRunStream {
  operator: AgentGraphOperatorBinding;
  run: AgentRunHeader;
  events: readonly RuntimeEvent[];
}

export interface ProjectAgentGraphRecordsInput {
  graphId: string;
  streams: readonly AgentGraphRunStream[];
}

export interface AgentGraphProjection {
  graphId: string;
  operators: AgentGraphOperatorBinding[];
  ignoredPartialEvents: number;
  records: AgentGraphRecord[];
  state: AgentGraphReplayState;
}

export interface ReadCommittedAgentGraphProjectionInput {
  graphId: string;
  operators: readonly AgentGraphOperatorBinding[];
  runStore: Pick<AgentRunStore, 'listSessionRuns'>;
  runtimeEventStore: Pick<RuntimeEventStore, 'readImmutableRuntimeEvents'>;
}

interface OrderedRuntimeEvent {
  operator: AgentGraphOperatorBinding;
  run: AgentRunHeader;
  event: RuntimeEvent;
  eventIndex: number;
}

export async function readCommittedAgentGraphProjection(
  input: ReadCommittedAgentGraphProjectionInput,
): Promise<AgentGraphProjection> {
  assertGraphIdentity(input.graphId, input.operators);
  const readImmutableRuntimeEvents = input.runtimeEventStore.readImmutableRuntimeEvents;
  if (!readImmutableRuntimeEvents) {
    throw new Error('Committed graph projection requires immutable RuntimeEvent reads');
  }

  const streams = (
    await Promise.all(
      input.operators.map(async (operator) => {
        const runs = await input.runStore.listSessionRuns(operator.sessionId);
        const orderedRuns = [...runs].sort(
          (a, b) => a.createdAt - b.createdAt || a.runId.localeCompare(b.runId),
        );
        return await Promise.all(
          orderedRuns.map(async (run): Promise<AgentGraphRunStream> => {
            if (run.sessionId !== operator.sessionId) {
              throw new Error(
                `Run ${run.runId} belongs to ${run.sessionId}, expected ${operator.sessionId}`,
              );
            }
            return {
              operator,
              run,
              events: await readImmutableRuntimeEvents.call(
                input.runtimeEventStore,
                operator.sessionId,
                run.runId,
              ),
            };
          }),
        );
      }),
    )
  ).flat();

  const projected = projectAgentGraphRecords({ graphId: input.graphId, streams });
  const state =
    projected.records.length > 0
      ? replayAgentGraphRecords(projected.records)
      : { graphId: input.graphId, lastLogicalTime: 0, appliedRecordIds: [], operators: {} };
  return {
    graphId: input.graphId,
    operators: input.operators.map((operator) => ({ ...operator })),
    ignoredPartialEvents: projected.ignoredPartialEvents,
    records: projected.records,
    state,
  };
}

export function projectAgentGraphRecords(input: ProjectAgentGraphRecordsInput): {
  ignoredPartialEvents: number;
  records: AgentGraphRecord[];
} {
  const operators = uniqueBindings(input.streams.map((stream) => stream.operator));
  assertGraphIdentity(input.graphId, operators);

  const ordered: OrderedRuntimeEvent[] = [];
  let ignoredPartialEvents = 0;
  const sourceEventIds = new Set<string>();

  for (const stream of input.streams) {
    assertRunStream(stream);
    let lastCommittedTs: number | undefined;
    for (let eventIndex = 0; eventIndex < stream.events.length; eventIndex += 1) {
      const event = stream.events[eventIndex]!;
      assertRuntimeEventIdentity(stream, event);
      if (event.partial) {
        ignoredPartialEvents += 1;
        continue;
      }
      if (lastCommittedTs !== undefined && event.ts < lastCommittedTs) {
        throw new Error(
          `Committed RuntimeEvents for ${stream.run.runId} are not timestamp-monotonic`,
        );
      }
      lastCommittedTs = event.ts;
      if (sourceEventIds.has(event.id)) {
        throw new Error(
          `RuntimeEvent ${event.id} is bound more than once in graph ${input.graphId}`,
        );
      }
      sourceEventIds.add(event.id);
      ordered.push({ operator: stream.operator, run: stream.run, event, eventIndex });
    }
  }

  ordered.sort(compareOrderedRuntimeEvents);

  const previousByActivation = new Map<string, string>();
  const records = ordered.map((item, index): AgentGraphRecord => {
    const activationId = item.run.runId;
    const activationKey = `${item.operator.operatorId}\0${activationId}`;
    const previousRecordId = previousByActivation.get(activationKey);
    const recordId = graphRecordId({
      graphId: input.graphId,
      operatorId: item.operator.operatorId,
      sessionId: item.operator.sessionId,
      runId: item.run.runId,
      runtimeEventId: item.event.id,
    });
    previousByActivation.set(activationKey, recordId);
    return {
      schemaVersion: AGENT_GRAPH_RECORD_SCHEMA_VERSION,
      recordId,
      graphId: input.graphId,
      operatorId: item.operator.operatorId,
      activationId,
      sessionId: item.operator.sessionId,
      agentRunId: item.run.runId,
      logicalTime: index + 1,
      ...(previousRecordId ? { previousRecordId } : {}),
      type: 'agent_runtime_event',
      facets: runtimeEventFacets(item.event, item.run),
      source: {
        kind: 'runtime_event',
        runtimeEventId: item.event.id,
        sessionId: item.event.sessionId,
        runId: item.event.runId,
        turnId: item.event.turnId,
        ts: item.event.ts,
      },
    };
  });

  return { ignoredPartialEvents, records };
}

export function replayAgentGraphRecords(
  records: readonly AgentGraphRecord[],
): AgentGraphReplayState {
  if (records.length === 0) {
    return { graphId: '', lastLogicalTime: 0, appliedRecordIds: [], operators: {} };
  }

  const uniqueRecords = new Map<string, AgentGraphRecord>();
  for (const record of records) {
    const existing = uniqueRecords.get(record.recordId);
    if (existing) {
      if (stableStringify(existing) !== stableStringify(record)) {
        throw new Error(`Conflicting graph record ${record.recordId}`);
      }
      continue;
    }
    uniqueRecords.set(record.recordId, record);
  }

  const ordered = [...uniqueRecords.values()].sort(
    (a, b) => a.logicalTime - b.logicalTime || a.recordId.localeCompare(b.recordId),
  );
  const graphId = ordered[0]!.graphId;
  const logicalTimes = new Map<number, string>();
  const operators: Record<string, AgentGraphOperatorState> = {};

  for (const record of ordered) {
    assertReplayRecord(record, graphId);
    const logicalTimeOwner = logicalTimes.get(record.logicalTime);
    if (logicalTimeOwner && logicalTimeOwner !== record.recordId) {
      throw new Error(
        `Logical time ${record.logicalTime} is shared by ${logicalTimeOwner} and ${record.recordId}`,
      );
    }
    logicalTimes.set(record.logicalTime, record.recordId);

    let operator = operators[record.operatorId];
    if (!operator) {
      operator = {
        operatorId: record.operatorId,
        sessionId: record.sessionId,
        status: 'running',
        currentActivationId: record.activationId,
        activations: {},
      };
      operators[record.operatorId] = operator;
    } else if (operator.sessionId !== record.sessionId) {
      throw new Error(
        `Operator ${record.operatorId} is bound to both ${operator.sessionId} and ${record.sessionId}`,
      );
    }

    let activation = operator.activations[record.activationId];
    if (!activation) {
      activation = {
        activationId: record.activationId,
        agentRunId: record.agentRunId,
        status: 'running',
        recordCount: 0,
        firstLogicalTime: record.logicalTime,
        lastLogicalTime: record.logicalTime,
        lastRecordId: record.recordId,
      };
      operator.activations[record.activationId] = activation;
    } else {
      if (activation.agentRunId !== record.agentRunId) {
        throw new Error(`Activation ${record.activationId} references multiple AgentRuns`);
      }
      if (activation.terminalRecordId) {
        throw new Error(
          `Graph record ${record.recordId} appears after terminal record ${activation.terminalRecordId}`,
        );
      }
    }

    const status = activationStatusAfterRecord(activation.status, record.facets);
    activation.status = status;
    activation.recordCount += 1;
    activation.lastLogicalTime = record.logicalTime;
    activation.lastRecordId = record.recordId;
    if (isTerminalActivationStatus(status)) {
      activation.terminalRecordId = record.recordId;
    }

    const current = operator.activations[operator.currentActivationId];
    if (!current || activation.lastLogicalTime >= current.lastLogicalTime) {
      operator.currentActivationId = activation.activationId;
      operator.status = activation.status;
    }
  }

  return {
    graphId,
    lastLogicalTime: ordered.at(-1)!.logicalTime,
    appliedRecordIds: ordered.map((record) => record.recordId),
    operators,
  };
}

function runtimeEventFacets(event: RuntimeEvent, run: AgentRunHeader): AgentGraphRecordFacet[] {
  const facets: AgentGraphRecordFacet[] = [];
  switch (event.content?.kind) {
    case 'text':
      facets.push('message');
      break;
    case 'thinking':
      facets.push('thinking');
      break;
    case 'error':
      facets.push('error');
      break;
    case 'function_call':
      facets.push('tool_call');
      break;
    case 'function_response':
      facets.push('tool_result');
      break;
  }

  const actions = event.actions;
  if (actions?.toolDispatch) facets.push('tool_dispatch');
  if (actions?.artifactDelta) facets.push('artifact_update');
  if (actions?.permissionRequest) facets.push('permission_request');
  if (actions?.permissionDecision) facets.push('permission_decision');
  if (actions?.userQuestionRequest) facets.push('user_question_request');
  if (actions?.transferToAgent) facets.push('transfer');
  if (actions?.tokenUsage) facets.push('usage');

  const terminalStatus =
    event.status === 'completed' ||
    event.status === 'failed' ||
    event.status === 'aborted' ||
    event.status === 'cancelled'
      ? event.status
      : actions?.endInvocation
        ? terminalStatusFromRun(run)
        : undefined;
  if (terminalStatus) facets.push(terminalStatus);
  if (facets.length === 0) facets.push('runtime_fact');
  return facets;
}

function terminalStatusFromRun(
  run: AgentRunHeader,
): Extract<AgentGraphRecordFacet, 'completed' | 'failed' | 'cancelled'> {
  switch (run.status) {
    case 'completed':
    case 'failed':
    case 'cancelled':
      return run.status;
    default:
      throw new Error(
        `RuntimeEvent ended invocation ${run.runId} while its AgentRun is ${run.status}`,
      );
  }
}

function activationStatusAfterRecord(
  current: AgentGraphActivationStatus,
  facets: readonly AgentGraphRecordFacet[],
): AgentGraphActivationStatus {
  const terminal = terminalStatusFromFacets(facets);
  if (terminal) return terminal;
  if (facets.includes('permission_request') || facets.includes('user_question_request')) {
    return 'blocked';
  }
  if (facets.includes('permission_decision') && current === 'blocked') return 'running';
  return current;
}

function terminalStatusFromFacets(
  facets: readonly AgentGraphRecordFacet[],
):
  | Extract<AgentGraphActivationStatus, 'completed' | 'failed' | 'aborted' | 'cancelled'>
  | undefined {
  const terminal = facets.filter(
    (
      facet,
    ): facet is Extract<AgentGraphRecordFacet, 'completed' | 'failed' | 'aborted' | 'cancelled'> =>
      facet === 'completed' || facet === 'failed' || facet === 'aborted' || facet === 'cancelled',
  );
  if (terminal.length > 1) {
    throw new Error(`Graph record carries conflicting terminal facets: ${terminal.join(', ')}`);
  }
  return terminal[0];
}

function isTerminalActivationStatus(status: AgentGraphActivationStatus): boolean {
  return (
    status === 'completed' || status === 'failed' || status === 'aborted' || status === 'cancelled'
  );
}

function uniqueBindings(
  operators: readonly AgentGraphOperatorBinding[],
): AgentGraphOperatorBinding[] {
  const byOperator = new Map<string, AgentGraphOperatorBinding>();
  for (const operator of operators) {
    const existing = byOperator.get(operator.operatorId);
    if (existing && existing.sessionId !== operator.sessionId) {
      throw new Error(
        `Operator ${operator.operatorId} is bound to both ${existing.sessionId} and ${operator.sessionId}`,
      );
    }
    byOperator.set(operator.operatorId, operator);
  }
  return [...byOperator.values()];
}

function assertGraphIdentity(
  graphId: string,
  operators: readonly AgentGraphOperatorBinding[],
): void {
  if (!graphId.trim()) throw new Error('Graph id must not be empty');
  const operatorIds = new Set<string>();
  const sessionIds = new Set<string>();
  for (const operator of operators) {
    if (!operator.operatorId.trim()) throw new Error('Operator id must not be empty');
    if (!operator.sessionId.trim()) throw new Error('Operator session id must not be empty');
    if (operatorIds.has(operator.operatorId)) {
      throw new Error(`Duplicate graph operator ${operator.operatorId}`);
    }
    if (sessionIds.has(operator.sessionId)) {
      throw new Error(`Session ${operator.sessionId} is bound to multiple graph operators`);
    }
    operatorIds.add(operator.operatorId);
    sessionIds.add(operator.sessionId);
  }
}

function assertRunStream(stream: AgentGraphRunStream): void {
  if (stream.run.sessionId !== stream.operator.sessionId) {
    throw new Error(
      `Run ${stream.run.runId} belongs to ${stream.run.sessionId}, expected ${stream.operator.sessionId}`,
    );
  }
}

function assertRuntimeEventIdentity(stream: AgentGraphRunStream, event: RuntimeEvent): void {
  if (
    event.sessionId !== stream.operator.sessionId ||
    event.runId !== stream.run.runId ||
    event.turnId !== stream.run.turnId
  ) {
    throw new Error(
      `RuntimeEvent ${event.id} does not belong to ${stream.operator.sessionId}/${stream.run.runId}/${stream.run.turnId}`,
    );
  }
}

function compareOrderedRuntimeEvents(a: OrderedRuntimeEvent, b: OrderedRuntimeEvent): number {
  return (
    a.event.ts - b.event.ts ||
    a.run.createdAt - b.run.createdAt ||
    a.operator.operatorId.localeCompare(b.operator.operatorId) ||
    a.run.runId.localeCompare(b.run.runId) ||
    a.eventIndex - b.eventIndex ||
    a.event.id.localeCompare(b.event.id)
  );
}

function graphRecordId(input: {
  graphId: string;
  operatorId: string;
  sessionId: string;
  runId: string;
  runtimeEventId: string;
}): string {
  return `graph_record_${stableHash(input).slice('sha256:'.length, 'sha256:'.length + 32)}`;
}

function assertReplayRecord(record: AgentGraphRecord, graphId: string): void {
  if (record.schemaVersion !== AGENT_GRAPH_RECORD_SCHEMA_VERSION) {
    throw new Error(`Unsupported graph record schema ${record.schemaVersion}`);
  }
  if (record.graphId !== graphId) {
    throw new Error(`Cannot replay records from graphs ${graphId} and ${record.graphId} together`);
  }
  if (!Number.isSafeInteger(record.logicalTime) || record.logicalTime <= 0) {
    throw new Error(`Invalid logical time on graph record ${record.recordId}`);
  }
  if (
    record.source.sessionId !== record.sessionId ||
    record.source.runId !== record.agentRunId ||
    record.activationId !== record.agentRunId
  ) {
    throw new Error(`Invalid source identity on graph record ${record.recordId}`);
  }
  terminalStatusFromFacets(record.facets);
}
