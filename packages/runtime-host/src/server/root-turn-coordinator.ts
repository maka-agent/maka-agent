import { randomUUID } from 'node:crypto';
import type { AgentRunHeader } from '@maka/core/agent-run';
import type { SessionHeader, StoredMessage } from '@maka/core/session';
import {
  type RuntimeInteractionFailStopError,
  RuntimeInteractionInvariantError,
  type SessionManager,
} from '@maka/runtime';
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
import { readCanonicalTurnSnapshot } from './canonical-turn-snapshot.js';
import type { RuntimeHostResidency } from './host-kernel.js';
import type { HostInteractionAuthority } from './interaction-coordinator.js';
import type { ConnectionContext, TurnOperationHandlerMap } from './operation-dispatcher.js';
import type { RootAdmissionWriter } from './root-admission-owner.js';
import { type SessionAdmissionLease, SessionAdmissionGate } from './session-admission-gate.js';
import {
  type AcceptedAssistantDeltaEvent,
  SessionContinuityCoordinator,
} from './session-continuity-coordinator.js';

interface ActiveRootTurn {
  turnId: string;
  runId: string;
  userMessageId: string;
  started: Deferred;
  done: Deferred;
  ownership: OwnedRootTurn;
}

interface OwnedRootTurn {
  readonly sessionId: string;
  readonly turnId: string;
  readonly runId: string;
  readonly residency: RuntimeHostResidency;
  poisoned: boolean;
  released: boolean;
}

type TurnStartOutcome = OperationOutcome<'turn.start'>;
type TurnQueryOutcome = OperationOutcome<'turn.query'>;
type TurnStopOutcome = OperationOutcome<'turn.stop'>;

type TurnStartDisposition =
  | { kind: 'complete'; outcome: TurnStartOutcome }
  | { kind: 'await_start'; active: ActiveRootTurn };

type TurnStopDisposition =
  | { kind: 'complete'; outcome: TurnStopOutcome }
  | { kind: 'request_stop'; active: ActiveRootTurn }
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
  readonly #recoveryAdmissionsBySession = new Map<string, readonly RootTurnAdmission[]>();
  readonly #ownedTurns = new Set<OwnedRootTurn>();
  private readonly stores: ExecutionStoresWriter<'interactive'>;
  #poisoned = false;
  #fatal: RuntimeInteractionFailStopError | undefined;
  #failStopReclaimer: (() => void) | undefined;

  constructor(
    private readonly manager: SessionManager,
    stores: ExecutionStoresWriter<'interactive'>,
    private readonly continuity: SessionContinuityCoordinator,
    private readonly rootAdmissionWriter: RootAdmissionWriter,
    private readonly acquireRecoveryResidency: () => RuntimeHostResidency,
    private readonly requestHostDrain: () => void,
    private readonly sessionAdmission: SessionAdmissionGate,
    private readonly interaction: HostInteractionAuthority,
  ) {
    this.stores = authenticateExecutionStoresWriter(stores, 'interactive');
  }

  async prepareRecovery(): Promise<void> {
    this.#throwIfPoisoned();
    const sessions = await this.stores.sessionStore.listForRecovery();
    this.#throwIfPoisoned();
    const plans: RecoverySessionPlan[] = [];
    for (const session of sessions) {
      const admissions = await this.stores.agentRunStore.listRootTurnAdmissionsForRecovery(
        session.id,
      );
      this.#throwIfPoisoned();
      this.rootAdmissionWriter.installRecoveryTip(session.id, admissions.at(-1));
      const messages = await this.stores.sessionStore.readMessagesForRecovery(session.id);
      this.#throwIfPoisoned();
      const runs = await this.stores.agentRunStore.listSessionRunsForRecovery(session.id);
      this.#throwIfPoisoned();
      const runsById = new Map(runs.map((run) => [run.runId, run]));
      for (const run of runs) {
        await this.stores.agentRunStore.readEventsForRecovery(session.id, run.runId);
        this.#throwIfPoisoned();
        await this.stores.runtimeEventStore.readRuntimeEvents(session.id, run.runId);
        this.#throwIfPoisoned();
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
        this.#throwIfPoisoned();
      }
      this.#recoveryAdmissionsBySession.set(plan.sessionId, plan.admissions);
    }
  }

  async recover(): Promise<void> {
    this.#throwIfPoisoned();
    for (const [sessionId, admissions] of this.#recoveryAdmissionsBySession) {
      let pending: RootTurnAdmission | undefined;
      for (const admission of admissions) {
        const run = await this.readRunIfPresent(sessionId, admission.runId);
        this.#throwIfPoisoned();
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
        this.#throwIfPoisoned();
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
      const disposition = await this.sessionAdmission.run(sessionId, (lease) =>
        this.prepareAdmittedTurn(input, admission, this.acquireRecoveryResidency, lease),
      );
      this.#throwIfPoisoned();
      const outcome = await this.resolveStartDisposition(input, disposition);
      this.#throwIfPoisoned();
      if (!outcome.ok) {
        throw new Error(
          `Unable to recover admitted Turn ${admission.turnId}: ${outcome.error.code}`,
        );
      }
    }
    this.#recoveryAdmissionsBySession.clear();
  }

  async close(): Promise<void> {
    this.#throwIfPoisoned();
    const active = [...this.#activeBySession.entries()];
    const drainResults = await Promise.allSettled(active.map(([, turn]) => turn.done.promise));
    this.#throwIfPoisoned();
    const errors = drainResults
      .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
      .map((result) => result.reason);
    for (const [sessionId, turn] of active) {
      if (this.#activeBySession.get(sessionId) !== turn) continue;
      this.#releaseOwnedTurn(turn.ownership, turn);
    }
    if (this.#activeBySession.size !== 0) {
      errors.push(new Error('Runtime Host execution composition closed with active Turns'));
    }
    if (this.#ownedTurns.size !== 0) {
      errors.push(new Error('Runtime Host execution composition closed with owned Turn residency'));
    }
    if (errors.length > 0)
      throw new AggregateError(errors, 'Unable to close Runtime Host execution composition');
  }

  prepareFailStopReclaim(fatal: RuntimeInteractionFailStopError): () => void {
    if (this.#failStopReclaimer) return this.#failStopReclaimer;
    this.#fatal = fatal;
    this.#poisoned = true;
    for (const ownership of this.#ownedTurns) ownership.poisoned = true;
    for (const active of this.#activeBySession.values()) {
      active.started.reject(fatal);
      active.done.reject(fatal);
    }
    let reclaimed = false;
    this.#failStopReclaimer = () => {
      if (reclaimed) return;
      reclaimed = true;
      for (const ownership of [...this.#ownedTurns]) {
        if (ownership.released) continue;
        ownership.released = true;
        this.#ownedTurns.delete(ownership);
        try {
          ownership.residency.release();
        } catch {
          // Post-isolation reclaim is total and cannot compensate with I/O.
        }
      }
      this.#activeBySession.clear();
    };
    return this.#failStopReclaimer;
  }

  private startTurn(input: TurnStartInput, context: ConnectionContext): Promise<TurnStartOutcome> {
    return this.runCommand(async () => {
      this.#throwIfPoisoned();
      const disposition = await this.sessionAdmission.run(input.sessionId, async (lease) => {
        this.#throwIfPoisoned();
        const existing = await this.stores.agentRunStore.readRootTurnAdmission(
          input.sessionId,
          input.turnId,
        );
        this.#throwIfPoisoned();
        if (existing) {
          if (existing.normalizedInput.text !== input.text) {
            return completedStart(
              operationConflict('Turn identity was already admitted with a different payload'),
            );
          }
          return this.prepareAdmittedTurn(input, existing, context.acquireResidency, lease);
        }

        let header: SessionHeader;
        try {
          header = await this.stores.sessionStore.readHeaderSnapshot(input.sessionId);
          this.#throwIfPoisoned();
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

        const previousRootTurnId = this.rootAdmissionWriter.previousRootTurnIdForNextAdmission(
          input.sessionId,
        );
        const admission = await this.stores.agentRunStore.admitRootTurn({
          sessionId: input.sessionId,
          turnId: input.turnId,
          proposedRunId: randomUUID(),
          proposedUserMessageId: randomUUID(),
          previousRootTurnId,
          normalizedInput: { text: input.text },
          admittedAt: Date.now(),
        });
        this.#throwIfPoisoned();
        if (admission.admission.normalizedInput.text !== input.text) {
          return completedStart(
            operationConflict('Turn identity was already admitted with a different payload'),
          );
        }
        if (admission.kind === 'admitted') {
          this.rootAdmissionWriter.record(admission.admission);
        }
        return this.prepareAdmittedTurn(
          input,
          admission.admission,
          context.acquireResidency,
          lease,
        );
      });
      this.#throwIfPoisoned();
      return this.resolveStartDisposition(input, disposition);
    });
  }

  private async queryTurn(input: TurnQueryInput): Promise<OperationOutcome<'turn.query'>> {
    this.#throwIfPoisoned();
    const disposition = await this.sessionAdmission.run(
      input.sessionId,
      async (): Promise<TurnQueryDisposition> => {
        this.#throwIfPoisoned();
        const admission = await this.stores.agentRunStore.readRootTurnAdmission(
          input.sessionId,
          input.turnId,
        );
        this.#throwIfPoisoned();
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
        this.#throwIfPoisoned();
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
    this.#throwIfPoisoned();
    if (disposition.kind === 'complete') return disposition.outcome;
    await disposition.active.done.promise;
    this.#throwIfPoisoned();
    const result = await this.readCanonicalSnapshot(
      input.sessionId,
      input.turnId,
      disposition.runId,
    );
    this.#throwIfPoisoned();
    return { ok: true, result };
  }

  private stopTurn(input: TurnStopInput): Promise<OperationOutcome<'turn.stop'>> {
    return this.runCommand(async () => {
      this.#throwIfPoisoned();
      const disposition = await this.sessionAdmission.run(
        input.sessionId,
        async (): Promise<TurnStopDisposition> => {
          this.#throwIfPoisoned();
          const admission = await this.stores.agentRunStore.readRootTurnAdmission(
            input.sessionId,
            input.turnId,
          );
          this.#throwIfPoisoned();
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
          this.#throwIfPoisoned();
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

          return { kind: 'request_stop', active };
        },
      );
      this.#throwIfPoisoned();
      if (disposition.kind === 'complete') return disposition.outcome;
      if (disposition.kind === 'request_stop') {
        await this.manager.stopSession(input.sessionId, {
          source: 'stop_button',
        });
        this.#throwIfPoisoned();
      }
      await disposition.active.done.promise;
      this.#throwIfPoisoned();
      const result = await this.readCanonicalSnapshot(input.sessionId, input.turnId, input.runId);
      this.#throwIfPoisoned();
      return { ok: true, result };
    });
  }

  private async prepareAdmittedTurn(
    input: TurnStartInput,
    admission: RootTurnAdmission,
    acquireResidency: () => RuntimeHostResidency,
    admissionLease: SessionAdmissionLease,
  ): Promise<TurnStartDisposition> {
    this.#throwIfPoisoned();
    if (admission.sessionId !== input.sessionId || admission.turnId !== input.turnId) {
      throw new Error('Root Turn admission identity does not match its input');
    }
    const { runId } = admission;
    const existingRun = await this.readRunIfPresent(input.sessionId, runId);
    this.#throwIfPoisoned();
    if (existingRun) {
      const snapshot = await this.readCanonicalSnapshot(
        input.sessionId,
        input.turnId,
        runId,
        existingRun,
      );
      this.#throwIfPoisoned();
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
      await this.continuity.refreshCanonical(input.sessionId, admissionLease);
      this.#throwIfPoisoned();
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
    const ownership = this.#ownTurn(input.sessionId, input.turnId, runId, residency);
    try {
      this.#assertTurnUsable(ownership);
      await this.continuity.holdTerminalPublication(
        input.sessionId,
        input.turnId,
        runId,
        admissionLease,
      );
      this.#assertTurnUsable(ownership);
    } catch (error) {
      this.#releaseOwnedTurn(ownership);
      throw error;
    }

    const started = deferred();
    const entry: ActiveRootTurn = {
      turnId: input.turnId,
      runId,
      userMessageId: admission.userMessageId,
      started,
      done: deferred(),
      ownership,
    };
    this.#assertTurnUsable(ownership);
    this.#activeBySession.set(input.sessionId, entry);
    const execution = this.drainTurn(input, entry);
    void execution.catch(() => undefined);
    return { kind: 'await_start', active: entry };
  }

  private async resolveStartDisposition(
    input: TurnStartInput,
    disposition: TurnStartDisposition,
  ): Promise<TurnStartOutcome> {
    if (disposition.kind === 'complete') return disposition.outcome;
    await disposition.active.started.promise;
    this.#assertTurnUsable(disposition.active.ownership);
    let result = await this.readCanonicalSnapshot(
      input.sessionId,
      input.turnId,
      disposition.active.runId,
    );
    this.#assertTurnUsable(disposition.active.ownership);
    if (isTerminalSnapshot(result)) {
      await disposition.active.done.promise;
      this.#throwIfPoisoned();
      result = await this.readCanonicalSnapshot(
        input.sessionId,
        input.turnId,
        disposition.active.runId,
      );
      this.#throwIfPoisoned();
    }
    return {
      ok: true,
      result,
    };
  }

  private async drainTurn(input: TurnStartInput, active: ActiveRootTurn): Promise<void> {
    let terminalCutStarted = false;
    let completion:
      | { readonly kind: 'completed' }
      | { readonly kind: 'failed'; readonly error: unknown }
      | undefined;
    try {
      this.#assertTurnUsable(active.ownership);
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
            this.#assertTurnUsable(active.ownership);
            if (startedRunId !== active.runId) {
              throw new Error('Runtime started a different Run than the admitted identity');
            }
            try {
              await this.continuity.refreshCanonical(input.sessionId);
              this.#assertTurnUsable(active.ownership);
              activeProjectionRefreshed = true;
            } catch (error) {
              if (!active.ownership.poisoned) active.started.reject(error);
              throw error;
            }
            this.#assertTurnUsable(active.ownership);
            active.started.resolve();
          },
        },
      )) {
        this.#assertTurnUsable(active.ownership);
        if (terminalEventObserved || isTerminalSessionEvent(event)) {
          terminalEventObserved = true;
        } else if (isAssistantDeltaEvent(event)) {
          if (!activeProjectionRefreshed) {
            await this.continuity.refreshCanonical(input.sessionId);
            this.#assertTurnUsable(active.ownership);
            activeProjectionRefreshed = true;
          }
          this.#assertTurnUsable(active.ownership);
          await this.continuity.acceptAssistantDelta(input.sessionId, active.runId, event);
          this.#assertTurnUsable(active.ownership);
        } else {
          const snapshot = await this.readCanonicalSnapshot(
            input.sessionId,
            input.turnId,
            active.runId,
          );
          this.#assertTurnUsable(active.ownership);
          if (isTerminalSnapshot(snapshot)) {
            terminalEventObserved = true;
          } else {
            await this.continuity.refreshCanonical(input.sessionId);
            this.#assertTurnUsable(active.ownership);
            activeProjectionRefreshed = true;
          }
        }
      }
      if (!active.started.settled) {
        throw new RuntimeInteractionInvariantError(
          `Root Turn ${active.turnId} drained before its start was published`,
        );
      }
      const snapshot = await this.readCanonicalSnapshot(
        input.sessionId,
        input.turnId,
        active.runId,
      );
      this.#assertTurnUsable(active.ownership);
      if (!isTerminalSnapshot(snapshot)) {
        throw new Error('Runtime Turn drained without a canonical terminal fact');
      }
      terminalCutStarted = true;
      await this.releaseActiveAndPublishTerminal(input.sessionId, active);
      completion = { kind: 'completed' };
    } catch (error) {
      if (active.ownership.poisoned || this.#poisoned) {
        completion = { kind: 'failed', error: this.#requireFatal() };
      } else if (active.started.settled && !terminalCutStarted) {
        try {
          const snapshot = await this.readCanonicalSnapshot(
            input.sessionId,
            input.turnId,
            active.runId,
          );
          this.#assertTurnUsable(active.ownership);
          if (isTerminalSnapshot(snapshot)) {
            terminalCutStarted = true;
            await this.releaseActiveAndPublishTerminal(input.sessionId, active);
            completion = { kind: 'completed' };
          }
        } catch {
          // The original execution error remains the command failure.
        }
      }
      if (!completion) {
        if (active.ownership.poisoned || this.#poisoned) {
          completion = { kind: 'failed', error: this.#requireFatal() };
        } else {
          this.#assertTurnUsable(active.ownership);
          active.started.reject(error);
          completion = { kind: 'failed', error };
          this.requestHostDrain();
        }
      }
    } finally {
      if (active.ownership.poisoned || this.#poisoned) {
        const fatal = this.#requireFatal();
        active.started.reject(fatal);
        active.done.reject(fatal);
        completion = { kind: 'failed', error: fatal };
      } else {
        try {
          this.#releaseOwnedTurn(active.ownership, active);
        } catch (error) {
          active.started.reject(error);
          completion = { kind: 'failed', error };
          this.requestHostDrain();
        }
        if (completion?.kind === 'completed') active.done.resolve();
        else if (completion) active.done.reject(completion.error);
      }
    }
    if (!completion) {
      throw new RuntimeInteractionInvariantError(
        `Root Turn ${active.turnId} drain did not settle its logical result`,
      );
    }
    if (completion.kind === 'failed') throw completion.error;
  }

  private async releaseActiveAndPublishTerminal(
    sessionId: string,
    active: ActiveRootTurn,
  ): Promise<void> {
    await this.sessionAdmission.run(sessionId, async (lease) => {
      this.#assertTurnUsable(active.ownership);
      await this.interaction.assertRunClosedAndNoPending(
        { sessionId, turnId: active.turnId, runId: active.runId },
        lease,
      );
      this.#assertTurnUsable(active.ownership);
      await this.continuity.publishTerminalProjection(
        sessionId,
        active.turnId,
        active.runId,
        () => {
          this.#assertTurnUsable(active.ownership);
          if (this.#activeBySession.get(sessionId) !== active) {
            throw new Error('Terminal root Turn no longer owns the Session admission gate');
          }
          this.#activeBySession.delete(sessionId);
        },
        lease,
      );
    });
  }

  private async readCanonicalSnapshot(
    sessionId: string,
    turnId: string,
    runId: string,
    knownRun?: AgentRunHeader,
  ): Promise<TurnSnapshot> {
    this.#throwIfPoisoned();
    const snapshot = await readCanonicalTurnSnapshot(
      this.stores,
      sessionId,
      turnId,
      runId,
      knownRun,
    );
    this.#throwIfPoisoned();
    return snapshot;
  }

  private async readRunIfPresent(
    sessionId: string,
    runId: string,
  ): Promise<AgentRunHeader | undefined> {
    this.#throwIfPoisoned();
    try {
      const run = await this.stores.agentRunStore.readRun(sessionId, runId);
      this.#throwIfPoisoned();
      return run;
    } catch (error) {
      this.#throwIfPoisoned();
      if (isMissingFile(error)) return undefined;
      throw error;
    }
  }

  #ownTurn(
    sessionId: string,
    turnId: string,
    runId: string,
    residency: RuntimeHostResidency,
  ): OwnedRootTurn {
    this.#throwIfPoisoned();
    const ownership: OwnedRootTurn = {
      sessionId,
      turnId,
      runId,
      residency,
      poisoned: false,
      released: false,
    };
    this.#ownedTurns.add(ownership);
    return ownership;
  }

  #releaseOwnedTurn(ownership: OwnedRootTurn, active?: ActiveRootTurn): void {
    if (ownership.released) return;
    if (this.#poisoned || ownership.poisoned) return;
    if (!this.#ownedTurns.has(ownership)) {
      throw new RuntimeInteractionInvariantError(
        `Root Turn ${ownership.turnId} lost its ownership record`,
      );
    }
    this.#throwIfPoisoned();
    try {
      ownership.residency.release();
    } catch (error) {
      throw new RuntimeInteractionInvariantError(
        `Root Turn ${ownership.turnId} could not release residency`,
        { cause: error },
      );
    }
    this.#throwIfPoisoned();
    if (active && this.#activeBySession.get(ownership.sessionId) === active) {
      this.#activeBySession.delete(ownership.sessionId);
    }
    ownership.released = true;
    this.#ownedTurns.delete(ownership);
  }

  #assertTurnUsable(ownership: OwnedRootTurn): void {
    if (
      this.#poisoned ||
      ownership.poisoned ||
      ownership.released ||
      !this.#ownedTurns.has(ownership)
    ) {
      this.#throwIfPoisoned();
      throw new RuntimeInteractionInvariantError(
        `Root Turn ${ownership.turnId} no longer owns residency`,
      );
    }
  }

  #throwIfPoisoned(): void {
    if (!this.#poisoned) return;
    throw this.#requireFatal();
  }

  #requireFatal(): RuntimeInteractionFailStopError {
    if (this.#fatal) return this.#fatal;
    throw new RuntimeInteractionInvariantError(
      'Root Turn coordinator is poisoned without a canonical fatal',
    );
  }

  private async runCommand<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      if (!this.#poisoned) this.requestHostDrain();
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
  void promise.catch(() => undefined);
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
