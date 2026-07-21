import { randomUUID } from 'node:crypto';
import type { AgentRunHeader } from '@maka/core/agent-run';
import { isDeepResearchSession } from '@maka/core/explore-agent';
import { isExpertTeamSession } from '@maka/core/expert-team';
import {
  messageContentsEqual,
  normalizeMessageContent,
  type MessageContent,
  type SessionEvent,
} from '@maka/core/events';
import type { SessionHeader, StoredMessage } from '@maka/core/session';
import {
  type GoalExternalTurnSettler,
  type GoalExternalTurnStart,
  type GoalTurnAdmission,
  type GoalTurnIdentity,
  type GoalTurnOutcome,
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
import {
  type HostMessageRootState,
  type HostMessageSessionHeader,
  type HostMessageStartInput,
  type HostMessageStopClaim,
  HostMessageCoordinator,
  type QueueFenceResult,
  type RootFollowupBatch,
} from './message-coordinator.js';
import type { ConnectionContext, TurnOperationHandlerMap } from './operation-dispatcher.js';
import type { RootAdmissionWriter } from './root-admission-owner.js';
import { type SessionAdmissionLease, SessionAdmissionGate } from './session-admission-gate.js';
import {
  type AcceptedAssistantDeltaEvent,
  type AcceptedToolEvent,
  SessionContinuityCoordinator,
} from './session-continuity-coordinator.js';

interface ActiveRootTurn {
  turnId: string;
  runId: string;
  userMessageId: string;
  started: Deferred;
  done: Deferred;
  ownership: OwnedRootTurn;
  stopRequested: boolean;
  messageTransitionCommitted: boolean;
  externalSettler?: GoalExternalTurnSettler;
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
  session: SessionHeader;
  sessionId: string;
  admissions: readonly RootTurnAdmission[];
  missingMessages: readonly RecoveryUserMessage[];
  unstartedGoalAdmission?: RootTurnAdmission;
}

type RootTurnOrigin = Exclude<RootTurnAdmission['origin'], undefined>;

interface RootTurnExecutionInput {
  readonly sessionId: string;
  readonly turnId: string;
  readonly content: MessageContent;
  readonly origin?: RootTurnOrigin;
  readonly coordinatorOwned?: boolean;
}

export interface HostGoalTurnBoundary {
  beginExternalTurn(sessionId: string, turnId: string): GoalExternalTurnStart;
}

export interface GoalAdmissionDurableCommit {
  readonly sessionId: string;
  readonly turnId: string;
  readonly runId: string;
  readonly goalId: string;
}

export interface RootTurnCoordinatorHooks {
  readonly afterGoalAdmissionDurableCommit?: (
    admission: GoalAdmissionDurableCommit,
  ) => void | Promise<void>;
}

export interface HostAutomationTurnInput {
  readonly sessionId: string;
  readonly turnId: string;
  readonly runId: string;
  readonly userMessageId: string;
  readonly automationId: string;
  readonly fireId: string;
  readonly content: MessageContent;
}

export interface HostAutomationTurnHandle {
  readonly terminal: Promise<TurnSnapshot>;
}

export type HostAutomationTurnStartResult =
  | { readonly kind: 'started'; readonly handle: HostAutomationTurnHandle }
  | {
      readonly kind: 'blocked';
      readonly reason:
        | 'session_not_found'
        | 'session_archived'
        | 'session_busy'
        | 'unsupported_session_mode';
    };

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
    private readonly messages: HostMessageCoordinator,
    private readonly goalTurns: HostGoalTurnBoundary,
    private readonly hooks: RootTurnCoordinatorHooks = {},
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
          if (admission.origin?.kind === 'goal') {
            const recoveredMessage = recoveryUserMessage(admission);
            missingMessages.push(recoveredMessage);
            indexRecoveryMessage(messageIndex, recoveredMessage);
          }
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
            !messageContentsEqual(userMessage, admission.normalizedInput) ||
            !turnOriginsEqual(userMessage.origin, admission.origin)
          ) {
            throw new Error(`Admitted Turn ${admission.turnId} does not match its UserMessage`);
          }
          continue;
        }
        if (messageIdOwner) {
          throw new Error(`Admitted Turn ${admission.turnId} reuses another message identity`);
        }
        const recoveredMessage = recoveryUserMessage(admission);
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
        session,
        sessionId: session.id,
        admissions,
        missingMessages,
        ...(admission?.origin?.kind === 'goal' ? { unstartedGoalAdmission: admission } : {}),
      });
    }

    for (const plan of plans) {
      if (plan.unstartedGoalAdmission) {
        await this.#materializeUnstartedGoalRun(plan.session, plan.unstartedGoalAdmission);
        this.#throwIfPoisoned();
      }
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
        content: normalizeMessageContent(admission.normalizedInput),
        ...(admission.origin ? { origin: admission.origin } : {}),
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

  async readSessionHeader(sessionId: string): Promise<HostMessageSessionHeader | null> {
    this.#throwIfPoisoned();
    try {
      const header = await this.stores.sessionStore.readHeaderSnapshot(sessionId);
      this.#throwIfPoisoned();
      return {
        isArchived: header.isArchived,
        unavailableReason: unsupportedSessionModeReason(header),
      };
    } catch (error) {
      this.#throwIfPoisoned();
      if (isMissingFile(error)) return null;
      throw error;
    }
  }

  readRootState(sessionId: string): HostMessageRootState {
    this.#throwIfPoisoned();
    const active = this.#activeBySession.get(sessionId);
    return active
      ? { kind: 'active', sessionId, turnId: active.turnId, runId: active.runId }
      : { kind: 'idle' };
  }

  async startFromMessage(
    input: HostMessageStartInput,
    admissionLease: SessionAdmissionLease,
  ): Promise<{ readonly turnId: string }> {
    this.#throwIfPoisoned();
    if (input.sourceMessage.disposition !== 'turn_started') {
      throw new RuntimeInteractionInvariantError('Idle message start requires turn_started source');
    }
    const content = normalizeMessageContent(input.content);
    if (!messageContentsEqual(input.sourceMessage.content, content)) {
      throw new RuntimeInteractionInvariantError('Idle message start changed its source content');
    }
    const sourceMessage = { ...input.sourceMessage, content };
    if (this.#activeBySession.has(input.sessionId)) {
      throw new RuntimeInteractionInvariantError(
        'Message coordinator attempted an idle start while a root Turn was active',
      );
    }
    const turnId = randomUUID();
    const previousRootTurnId = this.rootAdmissionWriter.previousRootTurnIdForNextAdmission(
      input.sessionId,
    );
    const admission = await this.stores.agentRunStore.admitRootTurn({
      sessionId: input.sessionId,
      turnId,
      proposedRunId: randomUUID(),
      proposedUserMessageId: sourceMessage.messageId,
      previousRootTurnId,
      normalizedInput: content,
      sourceMessages: [sourceMessage],
      admittedAt: Date.now(),
    });
    this.#throwIfPoisoned();
    if (admission.kind !== 'admitted') {
      throw new RuntimeInteractionInvariantError('Fresh message Turn identity already existed');
    }
    this.rootAdmissionWriter.record(admission.admission);
    let disposition: TurnStartDisposition;
    try {
      disposition = await this.prepareAdmittedTurn(
        { sessionId: input.sessionId, turnId, content },
        admission.admission,
        this.acquireRecoveryResidency,
        admissionLease,
      );
    } catch (error) {
      this.requestHostDrain();
      throw error;
    }
    if (disposition.kind !== 'await_start') {
      this.requestHostDrain();
      throw new RuntimeInteractionInvariantError('Fresh message Turn did not enter execution');
    }
    return { turnId };
  }

  async admitGoalTurn(
    sessionId: string,
    text: string,
    identity: GoalTurnIdentity,
  ): Promise<GoalTurnAdmission> {
    this.#throwIfPoisoned();
    const offered = deferredValue<GoalTurnAdmission>();
    const handshakeFinished = deferredValue<void>();
    const handshake = this.sessionAdmission.run(sessionId, async (lease) => {
      this.#throwIfPoisoned();
      let header: SessionHeader;
      try {
        header = await this.stores.sessionStore.readHeaderSnapshot(sessionId);
        this.#throwIfPoisoned();
      } catch (error) {
        this.#throwIfPoisoned();
        if (isMissingFile(error)) {
          offered.resolve({ kind: 'unavailable', reason: 'Session does not exist.' });
          return;
        }
        throw error;
      }
      if (header.status === 'archived') {
        offered.resolve({ kind: 'unavailable', reason: 'Session is archived.' });
        return;
      }
      const unavailableReason = unsupportedSessionModeReason(header);
      if (unavailableReason) {
        offered.resolve({ kind: 'unavailable', reason: unavailableReason });
        return;
      }

      const active = this.#activeBySession.get(sessionId);
      if (active) {
        offered.resolve({ kind: 'busy', whenIdle: alwaysResolve(active.done.promise) });
        return;
      }

      const turnId = randomUUID();
      const runId = randomUUID();
      const userMessageId = randomUUID();
      const content = normalizeMessageContent({ text });
      const origin = Object.freeze({ kind: 'goal' as const, goalId: identity.goalId });
      const decision = deferredValue<'start' | 'abandon'>();
      const completion = deferredValue<GoalTurnOutcome>();
      let selected: 'start' | 'abandon' | undefined;
      const start = (): Promise<GoalTurnOutcome> => {
        if (!selected) {
          selected = 'start';
          decision.resolve('start');
        }
        return completion.promise;
      };
      const abandon = (): Promise<void> => {
        if (!selected) {
          selected = 'abandon';
          completion.resolve({
            kind: 'errored',
            turnId,
            reason: 'Goal-owned Turn was abandoned before start.',
          });
          decision.resolve('abandon');
        }
        return handshakeFinished.promise;
      };
      const prepared: Extract<GoalTurnAdmission, { kind: 'prepared' }> & {
        abandon: () => Promise<void>;
      } = { kind: 'prepared', turnId, start, abandon };
      offered.resolve(prepared);

      if ((await decision.promise) === 'abandon') return;

      try {
        this.#throwIfPoisoned();
        const previousRootTurnId =
          this.rootAdmissionWriter.previousRootTurnIdForNextAdmission(sessionId);
        const admitted = await this.stores.agentRunStore.admitRootTurn({
          sessionId,
          turnId,
          proposedRunId: runId,
          proposedUserMessageId: userMessageId,
          previousRootTurnId,
          normalizedInput: content,
          sourceMessages: [],
          origin,
          admittedAt: Date.now(),
        });
        this.#throwIfPoisoned();
        if (admitted.kind !== 'admitted') {
          throw new RuntimeInteractionInvariantError('Fresh Goal Turn identity already existed');
        }
        await this.hooks.afterGoalAdmissionDurableCommit?.({
          sessionId: admitted.admission.sessionId,
          turnId: admitted.admission.turnId,
          runId: admitted.admission.runId,
          goalId: origin.goalId,
        });
        this.#throwIfPoisoned();
        this.rootAdmissionWriter.record(admitted.admission);
        const disposition = await this.prepareAdmittedTurn(
          { sessionId, turnId, content, origin, coordinatorOwned: true },
          admitted.admission,
          this.acquireRecoveryResidency,
          lease,
        );
        if (disposition.kind !== 'await_start') {
          throw new RuntimeInteractionInvariantError('Fresh Goal Turn did not enter execution');
        }
        this.#completeGoalTurn(sessionId, disposition.active, completion);
      } catch (error) {
        completion.resolve(erroredGoalOutcome(turnId, error));
        throw error;
      }
    });
    void handshake
      .then(
        () => handshakeFinished.resolve(undefined),
        (error) => {
          handshakeFinished.resolve(undefined);
          offered.reject(error);
          if (!this.#poisoned) this.requestHostDrain();
        },
      )
      .catch(() => undefined);
    return offered.promise;
  }

  async startAutomationTurn(
    input: HostAutomationTurnInput,
    admissionLease: SessionAdmissionLease,
  ): Promise<HostAutomationTurnStartResult> {
    try {
      return await this.sessionAdmission.runAdmitted(input.sessionId, admissionLease, async () => {
        this.#throwIfPoisoned();
        const content = normalizeMessageContent(input.content);
        const origin = Object.freeze({
          kind: 'automation' as const,
          automationId: input.automationId,
          fireId: input.fireId,
        });
        const executionInput: RootTurnExecutionInput = {
          sessionId: input.sessionId,
          turnId: input.turnId,
          content,
          origin,
        };
        let admission = await this.stores.agentRunStore.readRootTurnAdmission(
          input.sessionId,
          input.turnId,
        );
        this.#throwIfPoisoned();
        if (!admission) {
          let header: SessionHeader;
          try {
            header = await this.stores.sessionStore.readHeaderSnapshot(input.sessionId);
            this.#throwIfPoisoned();
          } catch (error) {
            this.#throwIfPoisoned();
            if (isMissingFile(error)) {
              return { kind: 'blocked', reason: 'session_not_found' };
            }
            throw error;
          }
          if (header.status === 'archived') {
            return { kind: 'blocked', reason: 'session_archived' };
          }
          if (unsupportedSessionModeReason(header)) {
            return { kind: 'blocked', reason: 'unsupported_session_mode' };
          }
          if (this.#activeBySession.has(input.sessionId)) {
            return { kind: 'blocked', reason: 'session_busy' };
          }
          const previousRootTurnId = this.rootAdmissionWriter.previousRootTurnIdForNextAdmission(
            input.sessionId,
          );
          const admitted = await this.stores.agentRunStore.admitRootTurn({
            sessionId: input.sessionId,
            turnId: input.turnId,
            proposedRunId: input.runId,
            proposedUserMessageId: input.userMessageId,
            previousRootTurnId,
            normalizedInput: content,
            sourceMessages: [],
            origin,
            admittedAt: Date.now(),
          });
          this.#throwIfPoisoned();
          admission = admitted.admission;
          if (admitted.kind === 'admitted') this.rootAdmissionWriter.record(admission);
        }
        if (
          admission.runId !== input.runId ||
          admission.userMessageId !== input.userMessageId ||
          admission.sourceMessages.length !== 0 ||
          !messageContentsEqual(admission.normalizedInput, content) ||
          !turnOriginsEqual(admission.origin, origin)
        ) {
          throw new RuntimeInteractionInvariantError(
            `Automation fire ${input.fireId} conflicts with its root Turn admission`,
          );
        }
        const disposition = await this.prepareAdmittedTurn(
          executionInput,
          admission,
          this.acquireRecoveryResidency,
          admissionLease,
        );
        this.#throwIfPoisoned();
        if (disposition.kind === 'complete') {
          if (!disposition.outcome.ok) {
            if (disposition.outcome.error.code === 'session_busy') {
              return { kind: 'blocked', reason: 'session_busy' };
            }
            throw new RuntimeInteractionInvariantError(
              `Automation fire ${input.fireId} could not resume its admitted Turn`,
            );
          }
          if (!isTerminalSnapshot(disposition.outcome.result)) {
            throw new RuntimeInteractionInvariantError(
              `Automation fire ${input.fireId} resolved without a terminal Turn`,
            );
          }
          return {
            kind: 'started',
            handle: {
              terminal: Promise.resolve(disposition.outcome.result),
            },
          };
        }
        const terminal = (async () => {
          await disposition.active.started.promise;
          this.#assertTurnUsable(disposition.active.ownership);
          await disposition.active.done.promise;
          this.#throwIfPoisoned();
          const result = await this.readCanonicalSnapshot(
            input.sessionId,
            input.turnId,
            input.runId,
          );
          this.#throwIfPoisoned();
          if (!isTerminalSnapshot(result)) {
            throw new RuntimeInteractionInvariantError(
              `Automation fire ${input.fireId} completed without a terminal Turn`,
            );
          }
          return result;
        })();
        void terminal.catch(() => undefined);
        return { kind: 'started', handle: { terminal } };
      });
    } catch (error) {
      if (!this.#poisoned) this.requestHostDrain();
      throw error;
    }
  }

  claimStop(
    input: Pick<TurnStopInput, 'sessionId' | 'turnId' | 'runId'>,
    admissionLease: SessionAdmissionLease,
    commitQueueFence: () => QueueFenceResult,
  ): Promise<HostMessageStopClaim> {
    return this.sessionAdmission.runAdmitted(input.sessionId, admissionLease, async () => {
      const disposition = await this.#prepareStopDisposition(input, commitQueueFence);
      if (disposition.kind === 'complete') {
        if (!disposition.outcome.ok) {
          throw new RuntimeInteractionInvariantError(
            'Message stop claim no longer matched its admitted root Turn',
          );
        }
        return {
          deliverStop: () => Promise.resolve(),
          terminal: Promise.resolve(disposition.outcome.result),
        };
      }
      return {
        deliverStop: () =>
          disposition.kind === 'request_stop'
            ? this.#deliverRuntimeStop(input.sessionId, disposition.active)
            : Promise.resolve(),
        terminal: disposition.active.done.promise.then(() =>
          this.readCanonicalSnapshot(input.sessionId, input.turnId, input.runId),
        ),
      };
    });
  }

  private startTurn(input: TurnStartInput, context: ConnectionContext): Promise<TurnStartOutcome> {
    return this.runCommand(async () => {
      this.#throwIfPoisoned();
      const content = normalizeMessageContent(input.content);
      const canonicalInput = { ...input, content };
      const disposition = await this.sessionAdmission.run(input.sessionId, async (lease) => {
        this.#throwIfPoisoned();
        const existing = await this.stores.agentRunStore.readRootTurnAdmission(
          input.sessionId,
          input.turnId,
        );
        this.#throwIfPoisoned();
        if (existing) {
          if (
            !messageContentsEqual(existing.normalizedInput, content) ||
            existing.sourceMessages.length !== 0
          ) {
            return completedStart(
              operationConflict('Turn identity was already admitted with a different payload'),
            );
          }
          return this.prepareAdmittedTurn(
            canonicalInput,
            existing,
            context.acquireResidency,
            lease,
          );
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
        const unavailableReason = unsupportedSessionModeReason(header);
        if (unavailableReason) {
          return completedStart({
            ok: false,
            error: {
              code: 'operation_unavailable',
              message: unavailableReason,
            },
          });
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
          normalizedInput: content,
          sourceMessages: [],
          admittedAt: Date.now(),
        });
        this.#throwIfPoisoned();
        if (
          !messageContentsEqual(admission.admission.normalizedInput, content) ||
          admission.admission.sourceMessages.length !== 0
        ) {
          return completedStart(
            operationConflict('Turn identity was already admitted with a different payload'),
          );
        }
        if (admission.kind === 'admitted') {
          this.rootAdmissionWriter.record(admission.admission);
        }
        return this.prepareAdmittedTurn(
          canonicalInput,
          admission.admission,
          context.acquireResidency,
          lease,
        );
      });
      this.#throwIfPoisoned();
      return this.resolveStartDisposition(canonicalInput, disposition);
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
      const disposition = await this.sessionAdmission.run(input.sessionId, (lease) =>
        this.#prepareStopDisposition(input, () => this.messages.commitStopFence(input, lease)),
      );
      this.#throwIfPoisoned();
      if (disposition.kind === 'complete') return disposition.outcome;
      if (disposition.kind === 'request_stop') {
        await this.#deliverRuntimeStop(input.sessionId, disposition.active);
        this.#throwIfPoisoned();
      }
      await disposition.active.done.promise;
      this.#throwIfPoisoned();
      const result = await this.readCanonicalSnapshot(input.sessionId, input.turnId, input.runId);
      this.#throwIfPoisoned();
      return { ok: true, result };
    });
  }

  async #prepareStopDisposition(
    input: Pick<TurnStopInput, 'sessionId' | 'turnId' | 'runId'>,
    commitQueueFence: () => void,
  ): Promise<TurnStopDisposition> {
    this.#throwIfPoisoned();
    const admission = await this.stores.agentRunStore.readRootTurnAdmission(
      input.sessionId,
      input.turnId,
    );
    this.#throwIfPoisoned();
    if (!admission) {
      return { kind: 'complete', outcome: notFound('Turn was not admitted') };
    }
    if (admission.runId !== input.runId) {
      return {
        kind: 'complete',
        outcome: operationConflict('Run identity does not match the admitted Turn'),
      };
    }

    const snapshot = await this.readCanonicalSnapshot(input.sessionId, input.turnId, input.runId);
    this.#throwIfPoisoned();
    const active = this.#activeBySession.get(input.sessionId);
    if (isTerminalSnapshot(snapshot)) {
      if (active?.turnId === input.turnId && active.runId === input.runId) {
        commitQueueFence();
        active.stopRequested = true;
        return { kind: 'await_terminal', active };
      }
      return { kind: 'complete', outcome: { ok: true, result: snapshot } };
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

    commitQueueFence();
    const shouldRequestStop = !active.stopRequested;
    active.stopRequested = true;
    return shouldRequestStop
      ? { kind: 'request_stop', active }
      : { kind: 'await_terminal', active };
  }

  private async prepareAdmittedTurn(
    input: RootTurnExecutionInput,
    admission: RootTurnAdmission,
    acquireResidency: () => RuntimeHostResidency,
    admissionLease: SessionAdmissionLease,
  ): Promise<TurnStartDisposition> {
    this.#throwIfPoisoned();
    if (admission.sessionId !== input.sessionId || admission.turnId !== input.turnId) {
      throw new Error('Root Turn admission identity does not match its input');
    }
    if (!turnOriginsEqual(admission.origin, input.origin)) {
      return completedStart(
        operationConflict('Turn identity was already admitted with a different origin'),
      );
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
    const messageIdentity = { sessionId: input.sessionId, turnId: input.turnId, runId };
    let messageReserved = false;
    try {
      this.#assertTurnUsable(ownership);
      this.messages.reserveRootTurn(messageIdentity);
      messageReserved = true;
      await this.continuity.holdTerminalPublication(
        input.sessionId,
        input.turnId,
        runId,
        admissionLease,
      );
      this.#assertTurnUsable(ownership);
    } catch (error) {
      if (messageReserved) this.messages.abandonRootReservation(messageIdentity);
      this.#releaseOwnedTurn(ownership);
      throw error;
    }

    const started = deferred();
    let externalSettler: GoalExternalTurnSettler | undefined;
    try {
      if (!input.coordinatorOwned) {
        externalSettler = this.#beginExternalTurn(input.sessionId, input.turnId);
      }
    } catch (error) {
      this.messages.abandonRootReservation(messageIdentity);
      this.#releaseOwnedTurn(ownership);
      throw error;
    }
    const entry: ActiveRootTurn = {
      turnId: input.turnId,
      runId,
      userMessageId: admission.userMessageId,
      started,
      done: deferred(),
      ownership,
      stopRequested: false,
      messageTransitionCommitted: false,
      ...(externalSettler ? { externalSettler } : {}),
    };
    this.#assertTurnUsable(ownership);
    this.#activeBySession.set(input.sessionId, entry);
    const execution = this.drainTurn(input, entry);
    void execution.catch(() => undefined);
    return { kind: 'await_start', active: entry };
  }

  private async resolveStartDisposition(
    input: RootTurnExecutionInput,
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

  private async drainTurn(input: RootTurnExecutionInput, active: ActiveRootTurn): Promise<void> {
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
        {
          turnId: input.turnId,
          ...input.content,
          ...(input.origin ? { origin: input.origin } : {}),
        },
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
          if (isToolEvent(event)) {
            await this.continuity.acceptToolEvent(input.sessionId, active.runId, event);
            this.#assertTurnUsable(active.ownership);
          }
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
      this.#settleExternalTurn(active, goalOutcomeFromTerminalSnapshot(snapshot));
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
            this.#settleExternalTurn(active, goalOutcomeFromTerminalSnapshot(snapshot));
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
        if (!active.messageTransitionCommitted) {
          try {
            this.messages.abandonRootReservation({
              sessionId: input.sessionId,
              turnId: active.turnId,
              runId: active.runId,
            });
          } catch (error) {
            active.started.reject(error);
            completion = { kind: 'failed', error };
            this.requestHostDrain();
          }
        }
        if (completion?.kind === 'failed') {
          this.#settleExternalTurn(active, erroredGoalOutcome(active.turnId, completion.error));
        }
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
      const identity = { sessionId, turnId: active.turnId, runId: active.runId };
      await this.interaction.assertRunClosedAndNoPending(identity, lease);
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
      this.#assertTurnUsable(active.ownership);
      const batch = this.messages.beginTerminalTransition(identity, lease);
      if (batch.sources.length === 0) {
        this.messages.completeIdle(batch, lease);
        active.messageTransitionCommitted = true;
        return;
      }
      await this.#startFollowupBatch(batch, active, lease);
    });
  }

  async #startFollowupBatch(
    batch: RootFollowupBatch,
    previous: ActiveRootTurn,
    admissionLease: SessionAdmissionLease,
  ): Promise<void> {
    const previousRootTurnId = this.rootAdmissionWriter.previousRootTurnIdForNextAdmission(
      batch.sessionId,
    );
    if (previousRootTurnId !== batch.previousTurnId) {
      throw new RuntimeInteractionInvariantError('Follow-up batch lost the root admission tip');
    }
    const turnId = randomUUID();
    const runId = randomUUID();
    const admission = await this.stores.agentRunStore.admitRootTurn({
      sessionId: batch.sessionId,
      turnId,
      proposedRunId: runId,
      proposedUserMessageId: randomUUID(),
      previousRootTurnId,
      normalizedInput: batch.content,
      sourceMessages: batch.sources,
      admittedAt: Date.now(),
    });
    this.#throwIfPoisoned();
    if (admission.kind !== 'admitted') {
      throw new RuntimeInteractionInvariantError('Fresh follow-up Turn identity already existed');
    }
    this.rootAdmissionWriter.record(admission.admission);

    const nextIdentity = { sessionId: batch.sessionId, turnId, runId };
    const nextResidency = this.acquireRecoveryResidency();
    let nextRootCommitted = false;
    let residencyTransferred = false;
    try {
      this.messages.commitNextRoot(batch, nextIdentity, admissionLease);
      nextRootCommitted = true;
      previous.messageTransitionCommitted = true;
      const disposition = await this.prepareAdmittedTurn(
        { sessionId: batch.sessionId, turnId, content: batch.content },
        admission.admission,
        () => {
          if (residencyTransferred) {
            throw new RuntimeInteractionInvariantError(
              'Follow-up root residency was acquired twice',
            );
          }
          residencyTransferred = true;
          return nextResidency;
        },
        admissionLease,
      );
      if (disposition.kind !== 'await_start') {
        throw new RuntimeInteractionInvariantError('Fresh follow-up Turn did not enter execution');
      }
    } catch (error) {
      if (!residencyTransferred) {
        nextResidency.release();
        if (nextRootCommitted) this.messages.abandonRootReservation(nextIdentity);
      }
      throw error;
    }
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

  async #materializeUnstartedGoalRun(
    session: SessionHeader,
    admission: RootTurnAdmission,
  ): Promise<void> {
    if (admission.origin?.kind !== 'goal') {
      throw new RuntimeInteractionInvariantError(
        `Unstarted Turn ${admission.turnId} is not Goal-owned`,
      );
    }
    await this.stores.agentRunStore.createRun(
      {
        runId: admission.runId,
        invocationId: admission.runId,
        sessionId: admission.sessionId,
        turnId: admission.turnId,
        status: 'created',
        backendKind: session.backend,
        llmConnectionSlug: session.llmConnectionSlug,
        modelId: session.model,
        cwd: session.cwd,
        permissionMode: session.permissionMode,
        collaborationMode: session.collaborationMode ?? 'agent',
        createdAt: admission.admittedAt,
        updatedAt: admission.admittedAt,
      },
      { durable: true },
    );
  }

  #completeGoalTurn(
    sessionId: string,
    active: ActiveRootTurn,
    completion: DeferredValue<GoalTurnOutcome>,
  ): void {
    const task = (async () => {
      try {
        await active.done.promise;
        this.#throwIfPoisoned();
        const snapshot = await this.readCanonicalSnapshot(sessionId, active.turnId, active.runId);
        if (!isTerminalSnapshot(snapshot)) {
          throw new RuntimeInteractionInvariantError(
            `Goal Turn ${active.turnId} completed without a terminal snapshot`,
          );
        }
        completion.resolve(goalOutcomeFromTerminalSnapshot(snapshot));
      } catch (error) {
        completion.resolve(erroredGoalOutcome(active.turnId, error));
      }
    })();
    void task.catch(() => undefined);
  }

  #beginExternalTurn(sessionId: string, turnId: string): GoalExternalTurnSettler {
    let registration: GoalExternalTurnStart;
    try {
      registration = this.goalTurns.beginExternalTurn(sessionId, turnId);
    } catch (error) {
      throw new RuntimeInteractionInvariantError(
        `Goal boundary threw while registering root Turn ${turnId}`,
        { cause: error },
      );
    }
    if (registration.kind === 'registered') return registration.settle;
    throw new RuntimeInteractionInvariantError(
      `Goal boundary rejected root Turn ${turnId}: ${registration.reason}`,
    );
  }

  #settleExternalTurn(active: ActiveRootTurn, outcome: GoalTurnOutcome): void {
    const settle = active.externalSettler;
    if (!settle) return;
    active.externalSettler = undefined;
    void Promise.resolve()
      .then(() => settle(outcome))
      .catch(() => undefined);
  }

  async #deliverRuntimeStop(sessionId: string, active: ActiveRootTurn): Promise<void> {
    try {
      await active.started.promise;
      await this.manager.claimSessionStop(sessionId, { source: 'stop_button' });
    } catch (error) {
      if (!this.#poisoned && !active.ownership.poisoned) this.requestHostDrain();
      throw error;
    }
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

function recoveryUserMessage(admission: RootTurnAdmission): RecoveryUserMessage {
  return {
    type: 'user',
    id: admission.userMessageId,
    turnId: admission.turnId,
    ts: admission.admittedAt,
    ...normalizeMessageContent(admission.normalizedInput),
    ...(admission.origin ? { origin: admission.origin } : {}),
  };
}

function turnOriginsEqual(
  left: RootTurnOrigin | undefined,
  right: RootTurnOrigin | undefined,
): boolean {
  if (!left || !right) return left === right;
  if (left.kind === 'automation') {
    return (
      right.kind === 'automation' &&
      left.automationId === right.automationId &&
      left.fireId === right.fireId
    );
  }
  return right.kind === 'goal' && left.goalId === right.goalId;
}

function isAssistantDeltaEvent(event: { type: string }): event is AcceptedAssistantDeltaEvent {
  return event.type === 'text_delta' || event.type === 'thinking_delta';
}

function isToolEvent(event: SessionEvent): event is AcceptedToolEvent {
  return event.type === 'tool_start' || event.type === 'tool_result';
}

function isTerminalSessionEvent(event: { type: string }): boolean {
  return event.type === 'complete' || event.type === 'abort';
}

interface RecoveryMessageIndex {
  userMessagesByTurnId: Map<string, RecoveryUserMessage[]>;
  messagesById: Map<string, StoredMessage[]>;
}

interface DeferredValue<T> {
  readonly promise: Promise<T>;
  readonly settled: boolean;
  resolve(value: T): void;
  reject(error: unknown): void;
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

function deferredValue<T>(): DeferredValue<T> {
  let settled = false;
  let resolvePromise!: (value: T) => void;
  let rejectPromise!: (error: unknown) => void;
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  void promise.catch(() => undefined);
  return {
    promise,
    get settled() {
      return settled;
    },
    resolve: (value) => {
      if (settled) return;
      settled = true;
      resolvePromise(value);
    },
    reject: (error) => {
      if (settled) return;
      settled = true;
      rejectPromise(error);
    },
  };
}

function alwaysResolve(promise: Promise<unknown>): Promise<void> {
  return promise.then(
    () => undefined,
    () => undefined,
  );
}

function goalOutcomeFromTerminalSnapshot(snapshot: TurnSnapshot): GoalTurnOutcome {
  switch (snapshot.status) {
    case 'completed':
      return { kind: 'completed', turnId: snapshot.turnId };
    case 'cancelled':
      return { kind: 'aborted', turnId: snapshot.turnId };
    case 'failed':
      return { kind: 'errored', turnId: snapshot.turnId, reason: snapshot.failureClass };
    default:
      throw new RuntimeInteractionInvariantError(
        `Turn ${snapshot.turnId} does not have a terminal Goal outcome`,
      );
  }
}

function erroredGoalOutcome(turnId: string, error: unknown): GoalTurnOutcome {
  return {
    kind: 'errored',
    turnId,
    reason: error instanceof Error ? error.message : String(error),
  };
}

function isMissingFile(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT';
}

function unsupportedSessionModeReason(
  header: Pick<SessionHeader, 'collaborationMode' | 'labels'>,
): string | undefined {
  if (header.collaborationMode === 'plan') {
    return 'Plan sessions are not yet supported by Runtime Host.';
  }
  if (isDeepResearchSession(header.labels)) {
    return 'Deep Research sessions are not yet supported by Runtime Host.';
  }
  if (isExpertTeamSession(header.labels)) {
    return 'Expert Team sessions are not yet supported by Runtime Host.';
  }
  return undefined;
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
