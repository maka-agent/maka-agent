import { randomUUID } from 'node:crypto';
import type { AgentRunHeader } from '@maka/core/agent-run';
import type { SessionHeader, StoredMessage } from '@maka/core/session';
import { classifyTerminalRuntimeLedger, type SessionManager } from '@maka/runtime';
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
import type { RuntimeHostResidency } from './host-kernel.js';
import type { ConnectionContext, DomainOperationHandlerMap } from './operation-dispatcher.js';

interface ActiveRootTurn {
  turnId: string;
  runId: string;
  userMessageId: string;
  started: Promise<void>;
  done: Promise<void>;
  residency: RuntimeHostResidency;
}

type TurnStartOutcome = OperationOutcome<'turn.start'>;

type TurnStartDisposition =
  | { kind: 'complete'; outcome: TurnStartOutcome }
  | { kind: 'await_start'; active: ActiveRootTurn };

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
  readonly handlers: DomainOperationHandlerMap = {
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

        const admission = await this.stores.agentRunStore.admitRootTurn({
          sessionId: input.sessionId,
          turnId: input.turnId,
          proposedRunId: randomUUID(),
          proposedUserMessageId: randomUUID(),
          normalizedInput: { text: input.text },
          admittedAt: Date.now(),
        });
        if (admission.admission.normalizedInput.text !== input.text) {
          return completedStart(
            operationConflict('Turn identity was already admitted with a different payload'),
          );
        }
        return this.prepareAdmittedTurn(input, admission.admission, context.acquireResidency);
      });
      return this.resolveStartDisposition(input, disposition);
    });
  }

  private queryTurn(input: TurnQueryInput): Promise<OperationOutcome<'turn.query'>> {
    return this.withSessionGate(input.sessionId, async () => {
      const admission = await this.stores.agentRunStore.readRootTurnAdmission(
        input.sessionId,
        input.turnId,
      );
      if (!admission) return notFound('Turn was not admitted');
      return {
        ok: true,
        result: await this.readCanonicalSnapshot(input.sessionId, input.turnId, admission.runId),
      };
    });
  }

  private stopTurn(input: TurnStopInput): Promise<OperationOutcome<'turn.stop'>> {
    return this.runCommand(() =>
      this.withSessionGate(input.sessionId, async () => {
        const admission = await this.stores.agentRunStore.readRootTurnAdmission(
          input.sessionId,
          input.turnId,
        );
        if (!admission) return notFound('Turn was not admitted');
        if (admission.runId !== input.runId) {
          return operationConflict('Run identity does not match the admitted Turn');
        }

        const snapshot = await this.readCanonicalSnapshot(
          input.sessionId,
          input.turnId,
          input.runId,
        );
        if (isTerminalSnapshot(snapshot)) return { ok: true, result: snapshot };
        const active = this.#activeBySession.get(input.sessionId);
        if (!active) {
          throw new Error('Admitted non-terminal Turn has no active Runtime Host execution');
        }
        if (active.turnId !== input.turnId || active.runId !== input.runId) {
          return operationConflict('A different root Turn owns the active Session execution');
        }

        await this.manager.stopSession(input.sessionId, {
          source: 'stop_button',
        });
        await active.done;
        return {
          ok: true,
          result: await this.readCanonicalSnapshot(input.sessionId, input.turnId, input.runId),
        };
      }),
    );
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
      if (isTerminalSnapshot(snapshot)) return completedStart({ ok: true, result: snapshot });
      const active = this.#activeBySession.get(input.sessionId);
      if (active?.turnId === input.turnId && active.runId === runId) {
        return { kind: 'await_start', active };
      }
      if (active) return completedStart(sessionBusy('Session already has an active root Turn'));
      throw new Error('Admitted non-terminal Turn has no active Runtime Host execution');
    }

    const active = this.#activeBySession.get(input.sessionId);
    if (active) {
      if (active.turnId !== input.turnId || active.runId !== runId) {
        return completedStart(sessionBusy('Session already has an active root Turn'));
      }
      return { kind: 'await_start', active };
    }

    const residency = acquireResidency();
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
    return {
      ok: true,
      result: await this.readCanonicalSnapshot(
        input.sessionId,
        input.turnId,
        disposition.active.runId,
      ),
    };
  }

  private async drainTurn(
    input: TurnStartInput,
    active: ActiveRootTurn,
    started: Deferred,
  ): Promise<void> {
    try {
      for await (const _event of this.manager.sendMessage(
        input.sessionId,
        { turnId: input.turnId, text: input.text },
        {
          runId: active.runId,
          userMessageId: active.userMessageId,
          durability: 'required',
          onRunStarted: (startedRunId) => {
            if (startedRunId !== active.runId) {
              throw new Error('Runtime started a different Run than the admitted identity');
            }
            started.resolve();
          },
        },
      )) {
        // The Host must consume the complete stream so Runtime finalization can commit.
      }
      const snapshot = await this.readCanonicalSnapshot(
        input.sessionId,
        input.turnId,
        active.runId,
      );
      if (!isTerminalSnapshot(snapshot)) {
        throw new Error('Runtime Turn drained without a canonical terminal fact');
      }
    } catch (error) {
      if (started.settled) {
        try {
          const snapshot = await this.readCanonicalSnapshot(
            input.sessionId,
            input.turnId,
            active.runId,
          );
          if (isTerminalSnapshot(snapshot)) return;
        } catch {
          // The original execution error remains the command failure.
        }
      }
      started.reject(error);
      this.requestHostDrain();
    } finally {
      if (this.#activeBySession.get(input.sessionId) === active) {
        this.#activeBySession.delete(input.sessionId);
      }
      active.residency.release();
    }
  }

  private async readCanonicalSnapshot(
    sessionId: string,
    turnId: string,
    runId: string,
    knownRun?: AgentRunHeader,
  ): Promise<TurnSnapshot> {
    const run = knownRun ?? (await this.readRunIfPresent(sessionId, runId));
    if (!run) return { sessionId, turnId, runId, status: 'admitted' };
    if (run.turnId !== turnId) {
      throw new Error('Admitted Turn identity does not match its Run header');
    }

    const [runEvents, runtimeEvents] = await Promise.all([
      this.stores.agentRunStore.readEvents(sessionId, runId),
      this.stores.runtimeEventStore.readImmutableRuntimeEvents(sessionId, runId),
    ]);
    const terminal = classifyTerminalRuntimeLedger(run, runtimeEvents);
    if (terminal.kind === 'fact') {
      const fact = terminal.fact;
      if (fact.runStatus === 'completed') {
        return {
          sessionId,
          turnId,
          runId,
          status: 'completed',
          terminalEventId: fact.terminalEvent.id,
        };
      }
      if (fact.runStatus === 'failed') {
        if (!fact.failureClass) throw new Error('Failed terminal fact has no failure class');
        return {
          sessionId,
          turnId,
          runId,
          status: 'failed',
          terminalEventId: fact.terminalEvent.id,
          failureClass: fact.failureClass,
        };
      }
      if (!fact.abortSource) throw new Error('Cancelled terminal fact has no abort source');
      return {
        sessionId,
        turnId,
        runId,
        status: 'cancelled',
        terminalEventId: fact.terminalEvent.id,
        abortSource: fact.abortSource,
      };
    }
    if (terminal.kind !== 'none') {
      throw new Error('Runtime ledger does not contain one canonical terminal fact');
    }
    if (run.status === 'completed' || run.status === 'failed' || run.status === 'cancelled') {
      throw new Error('Terminal Run header has no canonical terminal RuntimeEvent');
    }
    if (run.status !== 'created' && !runEvents.some((event) => event.type === 'run_started')) {
      throw new Error('Non-created Run has no durable start fact');
    }
    return { sessionId, turnId, runId, status: run.status };
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
