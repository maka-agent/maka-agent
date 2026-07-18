import { randomUUID } from 'node:crypto';
import type { AgentRunHeader } from '@maka/core/agent-run';
import type { SessionHeader, StoredMessage } from '@maka/core/session';
import type { SessionManager } from '@maka/runtime';
import {
  authenticateExecutionStoresWriter,
  type ExecutionStoresWriter,
  type RootTurnAdmission,
} from '@maka/storage/execution-stores';
import type {
  OperationOutcome,
  TurnQueryInput,
  TurnSnapshot,
  TurnStartInput,
  TurnStopInput,
} from '../protocol/index.js';
import type { DurableRootAdmissionIndex } from './canonical-session-projection.js';
import { readCanonicalTurnSnapshot } from './canonical-turn-snapshot.js';
import type { RuntimeHostResidency } from './host-kernel.js';
import type { ConnectionContext, TurnOperationHandlerMap } from './operation-dispatcher.js';
import {
  type AcceptedAssistantDeltaEvent,
  SessionContinuityCoordinator,
} from './session-continuity-coordinator.js';

interface ActiveRootTurn {
  turnId: string;
  runId: string;
  userMessageId: string;
  started: Promise<void>;
  done: Promise<void>;
  residency: RuntimeHostResidency;
}

type TurnStartOutcome = OperationOutcome<'turn.start'>;
type TurnQueryOutcome = OperationOutcome<'turn.query'>;
type TurnStopOutcome = OperationOutcome<'turn.stop'>;

type TurnStartDisposition =
  | { kind: 'complete'; outcome: TurnStartOutcome }
  | { kind: 'await_start'; active: ActiveRootTurn };

type TurnStopDisposition =
  | { kind: 'complete'; outcome: TurnStopOutcome }
  | { kind: 'await_terminal'; active: ActiveRootTurn };

type TurnQueryDisposition =
  | { kind: 'complete'; outcome: TurnQueryOutcome }
  | {
      kind: 'await_terminal';
      active: ActiveRootTurn;
      runId: string;
    };

interface Deferred {
  readonly promise: Promise<void>;
  readonly settled: boolean;
  resolve(): void;
  reject(error: unknown): void;
}

interface RecoverySessionPlan {
  sessionId: string;
  admissions: readonly RootTurnAdmission[];
  missingMessages: readonly RecoveryUserMessage[];
}

export class RootTurnCoordinator {
  readonly handlers: TurnOperationHandlerMap = {
    'turn.start': (input, context) => this.startTurn(input, context),
    'turn.query': (input) => this.queryTurn(input),
    'turn.stop': (input) => this.stopTurn(input),
  };

  readonly #activeBySession = new Map<string, ActiveRootTurn>();
  readonly #sessionGateTails = new Map<string, Promise<void>>();
  readonly #recoveryAdmissionsBySession = new Map<string, readonly RootTurnAdmission[]>();
  private readonly stores: ExecutionStoresWriter<'interactive'>;

  constructor(
    private readonly manager: SessionManager,
    stores: ExecutionStoresWriter<'interactive'>,
    private readonly continuity: SessionContinuityCoordinator,
    private readonly rootAdmissions: DurableRootAdmissionIndex,
    private readonly acquireRecoveryResidency: () => RuntimeHostResidency,
    private readonly requestHostDrain: () => void,
  ) {
    this.stores = authenticateExecutionStoresWriter(stores, 'interactive');
  }

  async prepareRecovery(): Promise<void> {
    const sessions = await this.stores.sessionStore.listForRecovery();
    const plans: RecoverySessionPlan[] = [];
    for (const session of sessions) {
      const admissions = await this.stores.agentRunStore.listRootTurnAdmissionsForRecovery(
        session.id,
      );
      this.rootAdmissions.installRecoveryChain(session.id, admissions);
      const messages = await this.stores.sessionStore.readMessagesForRecovery(session.id);
      const runs = await this.stores.agentRunStore.listSessionRunsForRecovery(session.id);
      const runsById = new Map(runs.map((run) => [run.runId, run]));
      for (const run of runs) {
        await this.stores.agentRunStore.readEventsForRecovery(session.id, run.runId);
        await this.stores.runtimeEventStore.readRuntimeEvents(session.id, run.runId);
      }
      const messageIndex = indexRecoveryMessages(messages);
      const pending: RootTurnAdmission[] = [];
      const missingMessages: RecoveryUserMessage[] = [];
      for (const admission of admissions) {
        const run = runsById.get(admission.runId);
        const userMessages = messageIndex.userMessagesByTurnId.get(admission.turnId) ?? [];
        const messageIdOwners = messageIndex.messagesById.get(admission.userMessageId) ?? [];
        if (messageIdOwners.length > 1) {
          throw new Error(
            `Admitted Turn ${admission.turnId} has a duplicated UserMessage identity`,
          );
        }
        const messageIdOwner = messageIdOwners[0];
        if (!run) {
          if (userMessages.length > 0 || messageIdOwner) {
            throw new Error(`Admitted Turn ${admission.turnId} has a UserMessage but no Run`);
          }
          pending.push(admission);
          continue;
        }
        if (run.turnId !== admission.turnId) {
          throw new Error(
            `Admitted Turn ${admission.turnId} does not match Run ${admission.runId}`,
          );
        }
        if (userMessages.length > 1) {
          throw new Error(`Admitted Turn ${admission.turnId} has multiple UserMessages`);
        }
        const userMessage = userMessages[0];
        if (userMessage) {
          if (
            messageIdOwner !== userMessage ||
            userMessage.id !== admission.userMessageId ||
            userMessage.text !== admission.normalizedInput.text
          ) {
            throw new Error(`Admitted Turn ${admission.turnId} does not match its UserMessage`);
          }
          continue;
        }
        if (messageIdOwner) {
          throw new Error(`Admitted Turn ${admission.turnId} reuses another message identity`);
        }
        const recoveredMessage = {
          type: 'user',
          id: admission.userMessageId,
          turnId: admission.turnId,
          ts: admission.admittedAt,
          text: admission.normalizedInput.text,
        } satisfies RecoveryUserMessage;
        missingMessages.push(recoveredMessage);
        indexRecoveryMessage(messageIndex, recoveredMessage);
      }
      if (pending.length > 1) {
        throw new Error(`Session ${session.id} has multiple admitted Turns without Runs`);
      }
      const admission = pending[0];
      if (admission && session.status === 'archived') {
        throw new Error(`Archived Session ${session.id} has an admitted Turn without a Run`);
      }
      plans.push({
        sessionId: session.id,
        admissions,
        missingMessages,
      });
    }

    for (const plan of plans) {
      for (const message of plan.missingMessages) {
        await this.stores.sessionStore.appendMessage(plan.sessionId, message);
      }
      this.#recoveryAdmissionsBySession.set(plan.sessionId, plan.admissions);
    }
  }

  async recover(): Promise<void> {
    for (const [sessionId, admissions] of this.#recoveryAdmissionsBySession) {
      let pending: RootTurnAdmission | undefined;
      for (const admission of admissions) {
        const run = await this.readRunIfPresent(sessionId, admission.runId);
        if (!run) {
          pending = admission;
          continue;
        }
        const snapshot = await this.readCanonicalSnapshot(
          sessionId,
          admission.turnId,
          admission.runId,
          run,
        );
        if (!isTerminalSnapshot(snapshot)) {
          throw new Error(`Startup recovery left Turn ${admission.turnId} non-terminal`);
        }
      }
      const admission = pending;
      if (!admission) continue;
      const input = {
        sessionId,
        turnId: admission.turnId,
        text: admission.normalizedInput.text,
      };
      const disposition = await this.withSessionGate(sessionId, () =>
        this.prepareAdmittedTurn(input, admission, this.acquireRecoveryResidency),
      );
      const outcome = await this.resolveStartDisposition(input, disposition);
      if (!outcome.ok) {
        throw new Error(
          `Unable to recover admitted Turn ${admission.turnId}: ${outcome.error.code}`,
        );
      }
    }
    this.#recoveryAdmissionsBySession.clear();
  }

  async close(): Promise<void> {
    const active = [...this.#activeBySession.entries()];
    const stopResults = await Promise.allSettled(
      active.map(([sessionId]) => this.manager.stopSession(sessionId, { source: 'stop_button' })),
    );
    const drainResults = await Promise.allSettled(active.map(([, turn]) => turn.done));
    const errors = [...stopResults, ...drainResults]
      .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
      .map((result) => result.reason);
    for (const [sessionId, turn] of active) {
      if (this.#activeBySession.get(sessionId) !== turn) continue;
      this.#activeBySession.delete(sessionId);
      turn.residency.release();
    }
    if (this.#activeBySession.size !== 0) {
      errors.push(new Error('Runtime Host execution composition closed with active Turns'));
    }
    if (errors.length > 0)
      throw new AggregateError(errors, 'Unable to close Runtime Host execution composition');
  }

  private startTurn(input: TurnStartInput, context: ConnectionContext): Promise<TurnStartOutcome> {
    return this.runCommand(async () => {
      const disposition = await this.withSessionGate(input.sessionId, async () => {
        const existing = await this.stores.agentRunStore.readRootTurnAdmission(
          input.sessionId,
          input.turnId,
        );
        if (existing) {
          if (existing.normalizedInput.text !== input.text) {
            return completedStart(
              operationConflict('Turn identity was already admitted with a different payload'),
            );
          }
          return this.prepareAdmittedTurn(input, existing, context.acquireResidency);
        }

        let header: SessionHeader;
        try {
          header = await this.stores.sessionStore.readHeaderSnapshot(input.sessionId);
        } catch (error) {
          if (isMissingFile(error)) return completedStart(notFound('Session does not exist'));
          throw error;
        }
        if (header.status === 'archived') {
          return completedStart(sessionArchived('Cannot start a new Turn in an archived Session'));
        }

        if (this.#activeBySession.has(input.sessionId)) {
          return completedStart(sessionBusy('Session already has an active root Turn'));
        }

        const previousRootTurnId = this.rootAdmissions.currentRootTurnId(input.sessionId);
        const admission = await this.stores.agentRunStore.admitRootTurn({
          sessionId: input.sessionId,
          turnId: input.turnId,
          proposedRunId: randomUUID(),
          proposedUserMessageId: randomUUID(),
          previousRootTurnId,
          normalizedInput: { text: input.text },
          admittedAt: Date.now(),
        });
        if (admission.admission.normalizedInput.text !== input.text) {
          return completedStart(
            operationConflict('Turn identity was already admitted with a different payload'),
          );
        }
        if (admission.kind === 'admitted') {
          this.rootAdmissions.record(admission.admission);
        }
        return this.prepareAdmittedTurn(input, admission.admission, context.acquireResidency);
      });
      return this.resolveStartDisposition(input, disposition);
    });
  }

  private async queryTurn(input: TurnQueryInput): Promise<OperationOutcome<'turn.query'>> {
    const disposition = await this.withSessionGate(
      input.sessionId,
      async (): Promise<TurnQueryDisposition> => {
        const admission = await this.stores.agentRunStore.readRootTurnAdmission(
          input.sessionId,
          input.turnId,
        );
        if (!admission) {
          return {
            kind: 'complete',
            outcome: notFound('Turn was not admitted'),
          };
        }
        const snapshot = await this.readCanonicalSnapshot(
          input.sessionId,
          input.turnId,
          admission.runId,
        );
        const active = this.#activeBySession.get(input.sessionId);
        return isTerminalSnapshot(snapshot) &&
          active?.turnId === input.turnId &&
          active.runId === admission.runId
          ? { kind: 'await_terminal', active, runId: admission.runId }
          : {
              kind: 'complete',
              outcome: { ok: true, result: snapshot },
            };
      },
    );
    if (disposition.kind === 'complete') return disposition.outcome;
    await disposition.active.done;
    return {
      ok: true,
      result: await this.readCanonicalSnapshot(input.sessionId, input.turnId, disposition.runId),
    };
  }

  private stopTurn(input: TurnStopInput): Promise<OperationOutcome<'turn.stop'>> {
    return this.runCommand(async () => {
      const disposition = await this.withSessionGate(
        input.sessionId,
        async (): Promise<TurnStopDisposition> => {
          const admission = await this.stores.agentRunStore.readRootTurnAdmission(
            input.sessionId,
            input.turnId,
          );
          if (!admission) {
            return {
              kind: 'complete',
              outcome: notFound('Turn was not admitted'),
            };
          }
          if (admission.runId !== input.runId) {
            return {
              kind: 'complete',
              outcome: operationConflict('Run identity does not match the admitted Turn'),
            };
          }

          const snapshot = await this.readCanonicalSnapshot(
            input.sessionId,
            input.turnId,
            input.runId,
          );
          const active = this.#activeBySession.get(input.sessionId);
          if (isTerminalSnapshot(snapshot)) {
            return active?.turnId === input.turnId && active.runId === input.runId
              ? { kind: 'await_terminal', active }
              : {
                  kind: 'complete',
                  outcome: { ok: true, result: snapshot },
                };
          }
          if (!active) {
            throw new Error('Admitted non-terminal Turn has no active Runtime Host execution');
          }
          if (active.turnId !== input.turnId || active.runId !== input.runId) {
            return {
              kind: 'complete',
              outcome: operationConflict('A different root Turn owns the active Session execution'),
            };
          }

          await this.manager.stopSession(input.sessionId, {
            source: 'stop_button',
          });
          return { kind: 'await_terminal', active };
        },
      );
      if (disposition.kind === 'complete') return disposition.outcome;
      await disposition.active.done;
      return {
        ok: true,
        result: await this.readCanonicalSnapshot(input.sessionId, input.turnId, input.runId),
      };
    });
  }

  private async prepareAdmittedTurn(
    input: TurnStartInput,
    admission: RootTurnAdmission,
    acquireResidency: () => RuntimeHostResidency,
  ): Promise<TurnStartDisposition> {
    if (admission.sessionId !== input.sessionId || admission.turnId !== input.turnId) {
      throw new Error('Root Turn admission identity does not match its input');
    }
    const { runId } = admission;
    const existingRun = await this.readRunIfPresent(input.sessionId, runId);
    if (existingRun) {
      const snapshot = await this.readCanonicalSnapshot(
        input.sessionId,
        input.turnId,
        runId,
        existingRun,
      );
      if (isTerminalSnapshot(snapshot)) {
        const active = this.#activeBySession.get(input.sessionId);
        if (active?.turnId === input.turnId && active.runId === runId) {
          return { kind: 'await_start', active };
        }
        return completedStart({ ok: true, result: snapshot });
      }
      const active = this.#activeBySession.get(input.sessionId);
      if (active?.turnId === input.turnId && active.runId === runId) {
        return { kind: 'await_start', active };
      }
      if (active) {
        return completedStart(sessionBusy('Session already has an active root Turn'));
      }
      await this.continuity.refreshCanonical(input.sessionId);
      throw new Error('Admitted non-terminal Turn has no active Runtime Host execution');
    }

    const active = this.#activeBySession.get(input.sessionId);
    if (active) {
      if (active.turnId === input.turnId && active.runId === runId) {
        return { kind: 'await_start', active };
      }
      return completedStart(sessionBusy('Session already has an active root Turn'));
    }
    const residency = acquireResidency();
    try {
      await this.continuity.holdTerminalPublication(input.sessionId, input.turnId, runId);
    } catch (error) {
      residency.release();
      throw error;
    }

    const started = deferred();
    const entry: ActiveRootTurn = {
      turnId: input.turnId,
      runId,
      userMessageId: admission.userMessageId,
      started: started.promise,
      done: Promise.resolve(),
      residency,
    };
    this.#activeBySession.set(input.sessionId, entry);
    entry.done = this.drainTurn(input, entry, started);
    return { kind: 'await_start', active: entry };
  }

  private async resolveStartDisposition(
    input: TurnStartInput,
    disposition: TurnStartDisposition,
  ): Promise<TurnStartOutcome> {
    if (disposition.kind === 'complete') return disposition.outcome;
    await disposition.active.started;
    let result = await this.readCanonicalSnapshot(
      input.sessionId,
      input.turnId,
      disposition.active.runId,
    );
    if (isTerminalSnapshot(result)) {
      await disposition.active.done;
      result = await this.readCanonicalSnapshot(
        input.sessionId,
        input.turnId,
        disposition.active.runId,
      );
    }
    return {
      ok: true,
      result,
    };
  }

  private async drainTurn(
    input: TurnStartInput,
    active: ActiveRootTurn,
    started: Deferred,
  ): Promise<void> {
    let terminalCutStarted = false;
    try {
      let activeProjectionRefreshed = false;
      let terminalEventObserved = false;
      for await (const event of this.manager.sendMessage(
        input.sessionId,
        { turnId: input.turnId, text: input.text },
        {
          runId: active.runId,
          userMessageId: active.userMessageId,
          durability: 'required',
          onRunStarted: async (startedRunId) => {
            if (startedRunId !== active.runId) {
              throw new Error('Runtime started a different Run than the admitted identity');
            }
            try {
              await this.continuity.refreshCanonical(input.sessionId);
              activeProjectionRefreshed = true;
            } catch (error) {
              started.reject(error);
              throw error;
            }
            started.resolve();
          },
        },
      )) {
        if (terminalEventObserved || isTerminalSessionEvent(event)) {
          terminalEventObserved = true;
        } else if (isAssistantDeltaEvent(event)) {
          if (!activeProjectionRefreshed) {
            await this.continuity.refreshCanonical(input.sessionId);
            activeProjectionRefreshed = true;
          }
          await this.continuity.acceptAssistantDelta(input.sessionId, active.runId, event);
        } else {
          const snapshot = await this.readCanonicalSnapshot(
            input.sessionId,
            input.turnId,
            active.runId,
          );
          if (isTerminalSnapshot(snapshot)) {
            terminalEventObserved = true;
          } else {
            await this.continuity.refreshCanonical(input.sessionId);
            activeProjectionRefreshed = true;
          }
        }
      }
      const snapshot = await this.readCanonicalSnapshot(
        input.sessionId,
        input.turnId,
        active.runId,
      );
      if (!isTerminalSnapshot(snapshot)) {
        throw new Error('Runtime Turn drained without a canonical terminal fact');
      }
      terminalCutStarted = true;
      await this.releaseActiveAndPublishTerminal(input.sessionId, active);
    } catch (error) {
      if (started.settled && !terminalCutStarted) {
        try {
          const snapshot = await this.readCanonicalSnapshot(
            input.sessionId,
            input.turnId,
            active.runId,
          );
          if (isTerminalSnapshot(snapshot)) {
            terminalCutStarted = true;
            await this.releaseActiveAndPublishTerminal(input.sessionId, active);
            return;
          }
        } catch {
          // The original execution error remains the command failure.
        }
      }
      started.reject(error);
      this.requestHostDrain();
    } finally {
      if (!terminalCutStarted && this.#activeBySession.get(input.sessionId) === active) {
        this.#activeBySession.delete(input.sessionId);
      }
      if (this.#activeBySession.get(input.sessionId) !== active) {
        active.residency.release();
      }
    }
  }

  private async releaseActiveAndPublishTerminal(
    sessionId: string,
    active: ActiveRootTurn,
  ): Promise<void> {
    await this.withSessionGate(sessionId, async () => {
      await this.continuity.publishTerminalProjection(
        sessionId,
        active.turnId,
        active.runId,
        () => {
          if (this.#activeBySession.get(sessionId) !== active) {
            throw new Error('Terminal root Turn no longer owns the Session admission gate');
          }
          this.#activeBySession.delete(sessionId);
        },
      );
    });
  }

  private async readCanonicalSnapshot(
    sessionId: string,
    turnId: string,
    runId: string,
    knownRun?: AgentRunHeader,
  ): Promise<TurnSnapshot> {
    return readCanonicalTurnSnapshot(this.stores, sessionId, turnId, runId, knownRun);
  }

  private async readRunIfPresent(
    sessionId: string,
    runId: string,
  ): Promise<AgentRunHeader | undefined> {
    try {
      return await this.stores.agentRunStore.readRun(sessionId, runId);
    } catch (error) {
      if (isMissingFile(error)) return undefined;
      throw error;
    }
  }

  private async withSessionGate<T>(sessionId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.#sessionGateTails.get(sessionId) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => current);
    this.#sessionGateTails.set(sessionId, tail);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (this.#sessionGateTails.get(sessionId) === tail) {
        this.#sessionGateTails.delete(sessionId);
      }
    }
  }

  private async runCommand<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      this.requestHostDrain();
      throw error;
    }
  }
}

type RecoveryUserMessage = Extract<StoredMessage, { type: 'user' }>;

function isAssistantDeltaEvent(event: { type: string }): event is AcceptedAssistantDeltaEvent {
  return event.type === 'text_delta' || event.type === 'thinking_delta';
}

function isTerminalSessionEvent(event: { type: string }): boolean {
  return event.type === 'complete' || event.type === 'abort';
}

interface RecoveryMessageIndex {
  userMessagesByTurnId: Map<string, RecoveryUserMessage[]>;
  messagesById: Map<string, StoredMessage[]>;
}

function indexRecoveryMessages(messages: readonly StoredMessage[]): RecoveryMessageIndex {
  const index: RecoveryMessageIndex = {
    userMessagesByTurnId: new Map(),
    messagesById: new Map(),
  };
  for (const message of messages) indexRecoveryMessage(index, message);
  return index;
}

function indexRecoveryMessage(index: RecoveryMessageIndex, message: StoredMessage): void {
  appendIndexed(index.messagesById, message.id, message);
  if (message.type === 'user') {
    appendIndexed(index.userMessagesByTurnId, message.turnId, message);
  }
}

function appendIndexed<K, V>(index: Map<K, V[]>, key: K, value: V): void {
  const values = index.get(key);
  if (values) values.push(value);
  else index.set(key, [value]);
}

function deferred(): Deferred {
  let settled = false;
  let resolvePromise!: () => void;
  let rejectPromise!: (error: unknown) => void;
  const promise = new Promise<void>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  return {
    promise,
    get settled() {
      return settled;
    },
    resolve: () => {
      if (settled) return;
      settled = true;
      resolvePromise();
    },
    reject: (error) => {
      if (settled) return;
      settled = true;
      rejectPromise(error);
    },
  };
}

function isMissingFile(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT';
}

function isTerminalSnapshot(snapshot: TurnSnapshot): boolean {
  return (
    snapshot.status === 'completed' ||
    snapshot.status === 'failed' ||
    snapshot.status === 'cancelled'
  );
}

function completedStart(outcome: TurnStartOutcome): TurnStartDisposition {
  return { kind: 'complete', outcome };
}

function notFound(message: string) {
  return { ok: false, error: { code: 'not_found', message } } as const;
}

function sessionBusy(message: string) {
  return { ok: false, error: { code: 'session_busy', message } } as const;
}

function sessionArchived(message: string) {
  return { ok: false, error: { code: 'session_archived', message } } as const;
}

function operationConflict(message: string) {
  return { ok: false, error: { code: 'operation_conflict', message } } as const;
}
