/**
 * session-branch — branch-session creation and runtime-ledger cloning.
 *
 * Owns the mechanics of forking a new session from a point in an existing
 * session's history: copying conversation messages up to (or before) a turn
 * boundary, cloning the corresponding slice of the runtime ledger (AgentRun
 * headers + RuntimeEvents) onto the new session, and creating the child
 * session header itself. `SessionManager.branchFromTurn` / `branchBeforeTurn`
 * call into this module and then translate the result for their own public
 * return shape.
 */

import type { AgentRunHeader, AgentRunStore, RuntimeEvent, RuntimeEventStore } from '@maka/core';
import type { BranchFromTurnInput, CreateSessionInput } from '@maka/core/runtime-inputs';
import type { SessionHeader, StoredMessage } from '@maka/core/session';
import {
  classifyTerminalRuntimeLedger,
  commitTerminalRunWithRuntimeFact,
} from './terminal-run-commit.js';
import type { RuntimeReadModelSessionView } from './runtime-read-model.js';

export interface SessionBranchDeps {
  store: {
    readHeader(sessionId: string): Promise<SessionHeader>;
    create(input: CreateSessionInput): Promise<SessionHeader>;
    appendMessage(sessionId: string, m: StoredMessage): Promise<void>;
    appendMessages(sessionId: string, ms: StoredMessage[]): Promise<void>;
  };
  runStore?: AgentRunStore;
  runtimeEventStore?: RuntimeEventStore;
  newId: () => string;
  now: () => number;
}

export async function createBranchSession(
  deps: SessionBranchDeps,
  sessionId: string,
  sourceView: RuntimeReadModelSessionView,
  copied: StoredMessage[],
  input: BranchFromTurnInput,
): Promise<SessionHeader> {
  const header = await deps.store.readHeader(sessionId);
  const next = await deps.store.create({
    cwd: header.cwd,
    backend: header.backend,
    llmConnectionSlug: header.llmConnectionSlug,
    model: header.model,
    thinkingLevel: header.thinkingLevel,
    permissionMode: header.permissionMode,
    name: input.name ?? `${header.name} · 分支`,
    labels: header.labels,
    parentSessionId: sessionId,
    branchOfTurnId: input.sourceTurnId,
    status: 'active',
  });
  await cloneBranchRuntimeLedger(deps, next.id, sourceView, copied);
  if (copied.length > 0) await deps.store.appendMessages(next.id, copied);
  await deps.store.appendMessage(next.id, {
    type: 'system_note',
    id: deps.newId(),
    ts: deps.now(),
    kind: 'session_start',
    data: { parentSessionId: sessionId, branchOfTurnId: input.sourceTurnId },
  });
  return deps.store.readHeader(next.id);
}

async function cloneBranchRuntimeLedger(
  deps: SessionBranchDeps,
  childSessionId: string,
  sourceView: RuntimeReadModelSessionView,
  copiedMessages: readonly StoredMessage[],
): Promise<void> {
  if (!deps.runStore || !deps.runtimeEventStore) return;
  const copiedTurnIds = new Set<string>();
  for (const message of copiedMessages) {
    if ('turnId' in message && typeof message.turnId === 'string')
      copiedTurnIds.add(message.turnId);
  }
  if (copiedTurnIds.size === 0) return;

  for (const sourceRun of sourceView.runs) {
    if (!copiedTurnIds.has(sourceRun.turnId)) continue;
    const sourceEvents = sourceView.events.filter(
      (event) => event.runId === sourceRun.runId && copiedTurnIds.has(event.turnId),
    );
    if (sourceEvents.length === 0) continue;

    const runId = deps.newId();
    const invocationId = deps.newId();
    const clonedRun = cloneRunHeaderForBranchCreate(sourceRun, childSessionId, runId, invocationId);
    await deps.runStore.createRun(clonedRun);

    const sourceTerminalLedger = classifyTerminalRuntimeLedger(sourceRun, sourceEvents);
    const clonedEventBySourceId = new Map<string, RuntimeEvent>();
    for (const event of sourceEvents) {
      const clonedEvent = cloneRuntimeEventForBranch(event, {
        sessionId: childSessionId,
        runId,
        eventId: deps.newId(),
        invocationId,
      });
      await deps.runtimeEventStore.appendRuntimeEvent(childSessionId, runId, clonedEvent);
      clonedEventBySourceId.set(event.id, clonedEvent);
    }

    if (sourceTerminalLedger.kind === 'fact' && isTerminalRunStatus(sourceRun.status)) {
      const terminalEvent = clonedEventBySourceId.get(sourceTerminalLedger.fact.terminalEvent.id);
      if (!terminalEvent) continue;
      await commitTerminalRunWithRuntimeFact({
        runStore: deps.runStore,
        runtimeEventStore: deps.runtimeEventStore,
        newId: deps.newId,
        sessionId: childSessionId,
        runId,
        turnId: sourceRun.turnId,
        status: sourceTerminalLedger.fact.runStatus,
        ts: terminalEvent.ts,
        terminalEvent,
        ...(sourceTerminalLedger.fact.failureClass
          ? { failureClass: sourceTerminalLedger.fact.failureClass }
          : {}),
        ...(sourceRun.failureMessage ? { failureMessage: sourceRun.failureMessage } : {}),
        ...(sourceTerminalLedger.fact.abortSource
          ? { abortSource: sourceTerminalLedger.fact.abortSource }
          : {}),
        runEventData: {
          recovered: true,
          recoveryReason: 'branch_runtime_ledger_clone',
          sourceSessionId: sourceRun.sessionId,
          sourceRunId: sourceRun.runId,
        },
      });
    }
  }
}

function cloneRuntimeEventForBranch(
  event: RuntimeEvent,
  ids: { sessionId: string; runId: string; eventId: string; invocationId: string },
): RuntimeEvent {
  return {
    ...event,
    id: ids.eventId,
    invocationId: ids.invocationId,
    sessionId: ids.sessionId,
    runId: ids.runId,
  };
}

function cloneRunHeaderForBranchCreate(
  sourceRun: AgentRunHeader,
  childSessionId: string,
  runId: string,
  invocationId: string,
): AgentRunHeader {
  const cloned = { ...sourceRun, invocationId, sessionId: childSessionId, runId };
  if (isTerminalRunStatus(sourceRun.status)) {
    cloned.status = 'running';
    delete cloned.completedAt;
    delete cloned.failureClass;
    delete cloned.failureMessage;
    delete cloned.abortSource;
  }
  return cloned;
}

export function copyMessagesThroughTurnBoundary(
  messages: readonly StoredMessage[],
  turnId: string,
): StoredMessage[] {
  let lastIndex = -1;
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index]!;
    if ((message as { turnId?: string }).turnId === turnId) {
      lastIndex = index;
    }
  }
  if (lastIndex < 0) return [];
  // Branch v1 copies conversation context only. Turn metadata is intentionally
  // not copied into the child session; lineage lives on the child session
  // header (`parentSessionId` + `branchOfTurnId`) and future turns.
  return messages.slice(0, lastIndex + 1).filter((message) => message.type !== 'turn_state');
}

// Exclusive dual of copyMessagesThroughTurnBoundary: every message belonging to
// a turn strictly before the chosen one, dropping it and every later turn.
// Returns null when the turn is absent (so the caller can reject an unknown
// turn), and an empty array when the turn is the first one (a valid branch into
// empty context). Membership, not array position, decides what to keep: the read
// model does not guarantee a turn's messages are contiguous or that a user
// prompt precedes its turn_state in array order, so a positional slice could
// drop an earlier turn's prompt. turn_state is dropped for the same reason as in
// the inclusive copy — lineage lives on the child header, not copied metadata.
export function copyMessagesBeforeTurn(
  messages: readonly StoredMessage[],
  turnId: string,
): StoredMessage[] | null {
  const turnOrder: string[] = [];
  const seen = new Set<string>();
  for (const message of messages) {
    const messageTurnId = (message as { turnId?: string }).turnId;
    if (messageTurnId && !seen.has(messageTurnId)) {
      seen.add(messageTurnId);
      turnOrder.push(messageTurnId);
    }
  }
  const cut = turnOrder.indexOf(turnId);
  if (cut < 0) return null;
  const keep = new Set(turnOrder.slice(0, cut));
  return messages.filter((message) => {
    if (message.type === 'turn_state') return false;
    const messageTurnId = (message as { turnId?: string }).turnId;
    return messageTurnId !== undefined && keep.has(messageTurnId);
  });
}

function isTerminalRunStatus(status: AgentRunHeader['status']): boolean {
  return status === 'completed' || status === 'failed' || status === 'cancelled';
}
