import { isDeepStrictEqual } from 'node:util';
import type { AnyPermissionRequestEvent, UserQuestionRequestEvent } from '@maka/core/events';
import {
  InteractionPermissionProjectionError,
  interactionCanonicalOutcomesEquivalent,
  isInteractionAnswerValidForRequest,
  projectInteractionPermissionRequest,
  projectInteractionQuestionRequest,
  type InteractionAnswer,
  type InteractionCanonicalOutcome,
} from '@maka/core/interaction';
import {
  RuntimeInteractionAdmissionRejectedError,
  RuntimeInteractionFailStopError,
  RuntimeInteractionInvariantError,
  type RuntimeInteractionAuthority,
  type RuntimeInteractionContinuationIdentity,
  type RuntimeInteractionRunClosureReason,
  type RuntimeInteractionRunIdentity,
  type RuntimeInteractionRunOwner,
  type RuntimePermissionAnswer,
  type RuntimePermissionContinuation,
  type RuntimePermissionOutcome,
  type RuntimeUserQuestionContinuation,
} from '@maka/runtime';
import {
  authenticateInteractionStoreWriter,
  type CommitInteractionOutcomeResult,
  type EstablishInteractionRequestResult,
  type InteractionRecord,
  type InteractiveInteractionStoreWriterFacade,
  type StoredInteractionOutcome,
  type StoredInteractionRequest,
} from '@maka/storage';
import {
  decodeSessionInteractionProjection,
  INTERACTION_MAX_PENDING_PER_SESSION,
  type InteractionAnswerInput,
  type InteractionSnapshot,
} from '../protocol/index.js';
import {
  answerOutcome,
  compareStoredInteractionRequests,
  permissionCanonicalOutcome,
  permissionInteractionAnswer,
  projectInteractionRecord,
  projectSessionInteractions,
  runtimePermissionOutcome,
  runtimeQuestionOutcome,
  wireCanonicalOutcome,
} from './interaction-projection.js';
import type { RuntimeHostResidency } from './host-kernel.js';
import type { InteractionOperationHandlerMap } from './operation-dispatcher.js';
import { type SessionAdmissionLease, SessionAdmissionGate } from './session-admission-gate.js';
import type { SessionContinuityCoordinator } from './session-continuity-coordinator.js';

interface InteractionFatalState {
  readonly error: RuntimeInteractionFailStopError;
}

export interface InteractionFailStopSignal {
  readonly error: RuntimeInteractionFailStopError;
}

interface RunClosure {
  readonly reason: RuntimeInteractionRunClosureReason;
  readonly task: Promise<void>;
  settled: boolean;
}

interface BoundRun extends RuntimeInteractionRunIdentity {
  readonly continuations: Set<RuntimeInteractionContinuationIdentity>;
  closure?: RunClosure;
  released: boolean;
}

interface LiveEntryBase {
  readonly run: BoundRun;
  readonly request: StoredInteractionRequest;
  readonly residency: RuntimeHostResidency;
  phase: 'reserved' | 'live' | 'poisoned' | 'released';
}

type LivePermissionEntry = LiveEntryBase & {
  readonly kind: 'permission';
  readonly continuation: RuntimePermissionContinuation;
};

type LiveQuestionEntry = LiveEntryBase & {
  readonly kind: 'question';
  readonly continuation: RuntimeUserQuestionContinuation;
};

type LiveEntry = LivePermissionEntry | LiveQuestionEntry;

interface CommittedEntry {
  readonly entry: LiveEntry;
  readonly outcome: StoredInteractionOutcome;
}

type SafeAcceptRejection = {
  readonly error: RuntimeInteractionAdmissionRejectedError;
};

type AcceptDisposition =
  | { readonly kind: 'accepted' }
  | { readonly kind: 'rejected'; readonly rejection: SafeAcceptRejection };

export class HostInteractionAuthority implements RuntimeInteractionAuthority {
  readonly handlers: InteractionOperationHandlerMap = {
    'interaction.query': (input) => this.query(input.sessionId, input.interactionId),
    'interaction.answer': (input) => this.answer(input),
  };

  readonly fatalSignal: Promise<InteractionFailStopSignal>;
  readonly #store: InteractiveInteractionStoreWriterFacade;
  readonly #live = new Map<string, LiveEntry>();
  readonly #runs = new Map<string, BoundRun>();
  readonly #closedRuns = new Set<string>();
  readonly #resolveFatalSignal: (signal: InteractionFailStopSignal) => void;
  #acceptingCreates = true;
  #fatal: InteractionFatalState | undefined;
  #reclaimed = false;

  constructor(
    store: InteractiveInteractionStoreWriterFacade,
    private readonly continuity: SessionContinuityCoordinator,
    private readonly sessionAdmission: SessionAdmissionGate,
    private readonly acquireResidency: () => RuntimeHostResidency,
    private readonly onFailStop: (error: RuntimeInteractionFailStopError) => void,
    private readonly now: () => number = Date.now,
  ) {
    this.#store = authenticateInteractionStoreWriter(store);
    let resolveFatalSignal!: (signal: InteractionFailStopSignal) => void;
    this.fatalSignal = new Promise((resolve) => {
      resolveFatalSignal = resolve;
    });
    this.#resolveFatalSignal = resolveFatalSignal;
  }

  bindRun(identity: RuntimeInteractionRunIdentity): RuntimeInteractionRunOwner {
    this.#throwIfFatal();
    if (!this.#acceptingCreates) {
      throw new RuntimeInteractionAdmissionRejectedError(identity.runId, 'authority_draining');
    }
    const key = runKey(identity);
    if (this.#runs.has(key) || this.#closedRuns.has(key)) {
      throw this.#tripFailStop(
        new RuntimeInteractionInvariantError(
          `Interaction authority was bound twice for run ${identity.runId}`,
        ),
      );
    }

    const run: BoundRun = {
      ...identity,
      continuations: new Set(),
      released: false,
    };
    const owner = Object.freeze({
      ...identity,
      acceptPermissionRequest: (
        input: Parameters<RuntimeInteractionRunOwner['acceptPermissionRequest']>[0],
      ) => this.#acceptPermissionRequest(run, input),
      commitPermissionAnswer: (
        input: Parameters<RuntimeInteractionRunOwner['commitPermissionAnswer']>[0],
      ) => this.#commitPermissionAnswer(run, input),
      commitPermissionTimeout: (
        input: Parameters<RuntimeInteractionRunOwner['commitPermissionTimeout']>[0],
      ) => this.#commitPermissionTimeout(run, input),
      acceptUserQuestionRequest: (
        input: Parameters<RuntimeInteractionRunOwner['acceptUserQuestionRequest']>[0],
      ) => this.#acceptUserQuestionRequest(run, input),
      close: (reason: RuntimeInteractionRunClosureReason) => this.#closeRun(run, reason),
      release: () => this.#releaseRun(run),
    });
    this.#runs.set(key, run);
    return owner;
  }

  beginDrain(): void {
    this.#acceptingCreates = false;
  }

  recoverPendingAfterHostRestart(): Promise<void> {
    return observeTask(this.#recoverPendingAfterHostRestart());
  }

  async #recoverPendingAfterHostRestart(): Promise<void> {
    this.#throwIfFatal();
    const pending = await this.#readPending();
    const bySession = new Map<string, StoredInteractionRequest[]>();
    for (const request of pending) {
      const session = bySession.get(request.sessionId);
      if (session) session.push(request);
      else bySession.set(request.sessionId, [request]);
    }
    for (const [sessionId, requests] of bySession) {
      if (requests.length > INTERACTION_MAX_PENDING_PER_SESSION) {
        throw this.#tripFailStop(
          new RuntimeInteractionInvariantError(
            `Session ${sessionId} exceeds the pending Interaction limit`,
          ),
        );
      }
      await this.sessionAdmission.run(sessionId, async (lease) => {
        for (const request of requests.sort(compareStoredInteractionRequests)) {
          await this.#commitOutcome(request, {
            kind: 'closure',
            reason: 'host_restarted',
            committedAt: this.now(),
          });
        }
        await this.continuity.refreshCanonical(sessionId, lease);
        this.#throwIfFatal();
      });
    }
  }

  assertRunClosedAndNoPending(
    identity: RuntimeInteractionRunIdentity,
    admission: SessionAdmissionLease,
  ): Promise<void> {
    if (!this.#closedRuns.has(runKey(identity))) {
      throw this.#tripFailStop(
        new RuntimeInteractionInvariantError(
          `Run ${identity.runId} reached terminal publication before Interaction closure`,
        ),
      );
    }
    for (const entry of this.#live.values()) {
      if (entry.request.sessionId === identity.sessionId) {
        throw this.#tripFailStop(
          new RuntimeInteractionInvariantError(
            `Session ${identity.sessionId} reached terminal publication with a live Interaction`,
          ),
        );
      }
    }
    return observeTask(
      this.sessionAdmission.runAdmitted(identity.sessionId, admission, async () => {
        const pending = await this.#readPending({ sessionId: identity.sessionId });
        if (pending.length !== 0) {
          throw this.#tripFailStop(
            new RuntimeInteractionInvariantError(
              `Session ${identity.sessionId} reached terminal publication with durable pending Interactions`,
            ),
          );
        }
      }),
    );
  }

  async close(): Promise<void> {
    this.#throwIfFatal();
    this.beginDrain();
    const pending = await this.#readPending();
    if (pending.length !== 0 || this.#live.size !== 0 || this.#runs.size !== 0) {
      throw this.#tripFailStop(
        new RuntimeInteractionInvariantError(
          'Interaction authority closed before all Run owners and pending requests were released',
        ),
      );
    }
  }

  reclaimAfterOwnerIsolation(): void {
    if (this.#reclaimed) return;
    this.#reclaimed = true;
    for (const entry of [...this.#live.values()]) this.#reclaimEntry(entry);
    for (const run of this.#runs.values()) {
      run.released = true;
      run.continuations.clear();
    }
    this.#runs.clear();
    this.#closedRuns.clear();
  }

  #acceptPermissionRequest(
    run: BoundRun,
    input: Parameters<RuntimeInteractionRunOwner['acceptPermissionRequest']>[0],
  ): Promise<void> {
    try {
      this.#assertRunOpen(run, input.request.requestId);
      this.#assertContinuationIdentity(run, input.request, input.continuation);
      let request: ReturnType<typeof projectInteractionPermissionRequest>;
      try {
        request = projectInteractionPermissionRequest(input.request);
      } catch (error) {
        if (!(error instanceof InteractionPermissionProjectionError)) throw error;
        return rejectedTask(
          new RuntimeInteractionAdmissionRejectedError(
            input.continuation.requestId,
            'invalid_request',
          ),
        );
      }
      return this.#acceptTask(
        this.#accept(run, {
          kind: 'permission',
          request: {
            ...runIdentity(run),
            requestId: input.continuation.requestId,
            createdAt: input.request.ts,
            request,
            ...(input.rememberScopeId === undefined
              ? {}
              : { rememberScopeId: input.rememberScopeId }),
          },
          continuation: input.continuation,
        }),
      );
    } catch (error) {
      return rejectedTask(error);
    }
  }

  #acceptUserQuestionRequest(
    run: BoundRun,
    input: Parameters<RuntimeInteractionRunOwner['acceptUserQuestionRequest']>[0],
  ): Promise<void> {
    try {
      this.#assertRunOpen(run, input.request.requestId);
      this.#assertContinuationIdentity(run, input.request, input.continuation);
      const request = projectInteractionQuestionRequest({
        toolUseId: input.request.toolUseId,
        questions: input.request.questions,
      });
      return this.#acceptTask(
        this.#accept(run, {
          kind: 'question',
          request: {
            ...runIdentity(run),
            requestId: input.continuation.requestId,
            createdAt: input.request.ts,
            request,
          },
          continuation: input.continuation,
        }),
      );
    } catch (error) {
      return rejectedTask(error);
    }
  }

  #commitPermissionAnswer(
    run: BoundRun,
    input: Parameters<RuntimeInteractionRunOwner['commitPermissionAnswer']>[0],
  ): Promise<RuntimePermissionOutcome> {
    return observeTask(
      this.sessionAdmission.run(run.sessionId, async (lease) => {
        const record = await this.#readContinuationRecord(run, input.continuation);
        const answer = permissionInteractionAnswer(input.answer);
        this.#assertAnswerValid(record.request, answer);
        if (record.outcome) return runtimePermissionOutcome(record.outcome.outcome);
        const entry = this.#requirePermissionEntry(run, input.continuation, record.request);
        const winner = await this.#commitAnswer(
          entry,
          permissionCanonicalOutcome(input.answer, this.now()),
          lease,
        );
        return runtimePermissionOutcome(winner.outcome);
      }),
    );
  }

  #commitPermissionTimeout(
    run: BoundRun,
    input: Parameters<RuntimeInteractionRunOwner['commitPermissionTimeout']>[0],
  ): Promise<RuntimePermissionOutcome> {
    return observeTask(
      this.sessionAdmission.run(run.sessionId, async (lease) => {
        const record = await this.#readContinuationRecord(run, input.continuation);
        if (record.outcome) return runtimePermissionOutcome(record.outcome.outcome);
        const entry = this.#requirePermissionEntry(run, input.continuation, record.request);
        const winner = await this.#commitSingle(
          entry,
          { kind: 'closure', reason: 'timed_out', committedAt: this.now() },
          lease,
        );
        return runtimePermissionOutcome(winner.outcome);
      }),
    );
  }

  #closeRun(run: BoundRun, reason: RuntimeInteractionRunClosureReason): Promise<void> {
    try {
      this.#assertOwnedRun(run);
      this.#throwIfFatal();
      if (run.released) {
        throw this.#tripFailStop(
          new RuntimeInteractionInvariantError(
            `Released Interaction owner for run ${run.runId} cannot close`,
          ),
        );
      }
      if (run.closure) {
        if (run.closure.reason !== reason) {
          throw this.#tripFailStop(
            new RuntimeInteractionInvariantError(
              `Run ${run.runId} received conflicting Interaction closure reasons`,
            ),
          );
        }
        return run.closure.task;
      }

      const completion = deferred();
      const closure: RunClosure = { reason, task: completion.promise, settled: false };
      run.closure = closure;
      this.#closedRuns.add(runKey(run));
      const task = this.sessionAdmission.run(run.sessionId, async (lease) => {
        await this.#closeRunAdmitted(run, reason, lease);
        this.#throwIfFatal();
        closure.settled = true;
      });
      void task.then(completion.resolve, (error) => completion.reject(this.#tripFailStop(error)));
      return closure.task;
    } catch (error) {
      return rejectedTask(error);
    }
  }

  #releaseRun(run: BoundRun): void {
    if (run.released) return;
    if (this.#fatal || this.#reclaimed) {
      run.released = true;
      run.continuations.clear();
      if (this.#runs.get(runKey(run)) === run) this.#runs.delete(runKey(run));
      return;
    }
    this.#assertOwnedRun(run);
    for (const entry of this.#live.values()) {
      if (entry.run === run) {
        throw this.#tripFailStop(
          new RuntimeInteractionInvariantError(`Run ${run.runId} released with a live Interaction`),
        );
      }
    }
    if (run.closure && !run.closure.settled) {
      throw this.#tripFailStop(
        new RuntimeInteractionInvariantError(
          `Run ${run.runId} released before Interaction closure settled`,
        ),
      );
    }
    run.released = true;
    run.continuations.clear();
    this.#runs.delete(runKey(run));
  }

  #accept(
    run: BoundRun,
    entry:
      | Omit<LivePermissionEntry, 'run' | 'residency' | 'phase'>
      | Omit<LiveQuestionEntry, 'run' | 'residency' | 'phase'>,
  ): Promise<AcceptDisposition> {
    this.#throwIfFatal();
    this.#assertRunOpen(run, entry.request.requestId);
    if (!this.#acceptingCreates) {
      return Promise.resolve(rejectedAdmission(entry.request.requestId, 'authority_draining'));
    }
    if (this.#live.has(entry.request.requestId)) {
      throw this.#tripFailStop(
        new RuntimeInteractionInvariantError(
          `Interaction ${entry.request.requestId} was admitted twice`,
        ),
      );
    }
    if (run.continuations.has(entry.continuation)) {
      throw this.#tripFailStop(
        new RuntimeInteractionInvariantError(
          `Interaction continuation ${entry.request.requestId} was admitted twice`,
        ),
      );
    }
    if (
      this.#sessionReservationCount(entry.request.sessionId) >= INTERACTION_MAX_PENDING_PER_SESSION
    ) {
      return Promise.resolve(rejectedAdmission(entry.request.requestId, 'capacity_exceeded'));
    }

    const live = {
      ...entry,
      run,
      residency: this.acquireResidency(),
      phase: 'reserved' as const,
    } as LiveEntry;
    run.continuations.add(entry.continuation);
    this.#live.set(live.request.requestId, live);
    return this.sessionAdmission.run(live.request.sessionId, (lease) =>
      this.#createAdmitted(live, lease),
    );
  }

  async #createAdmitted(
    entry: LiveEntry,
    lease: SessionAdmissionLease,
  ): Promise<AcceptDisposition> {
    try {
      this.#throwIfFatal();
      const pending = await this.#readPending({ sessionId: entry.request.sessionId });
      const rejection = this.#prospectiveProjectionRejection(entry.request, pending);
      if (rejection) return this.#rejectProvisional(entry, rejection);
      const established = await this.#establishRequest(entry.request);
      if (established.kind === 'not_published') {
        return this.#rejectProvisional(
          entry,
          rejectedAdmission(entry.request.requestId, 'not_published', established.error).rejection,
        );
      }
      if (established.record.outcome) {
        return this.#rejectProvisional(
          entry,
          rejectedAdmission(entry.request.requestId, 'request_settled').rejection,
        );
      }
      entry.phase = 'live';
      await this.continuity.refreshCanonical(entry.request.sessionId, lease);
      this.#throwIfFatal();
      return { kind: 'accepted' };
    } catch (error) {
      throw this.#tripFailStop(error);
    }
  }

  #prospectiveProjectionRejection(
    candidate: StoredInteractionRequest,
    pending: readonly StoredInteractionRequest[],
  ): SafeAcceptRejection | undefined {
    try {
      decodeSessionInteractionProjection(projectSessionInteractions(pending), candidate.sessionId);
      decodeSessionInteractionProjection(
        projectSessionInteractions([candidate]),
        candidate.sessionId,
      );
    } catch (error) {
      throw this.#tripFailStop(
        new RuntimeInteractionInvariantError(
          `Canonical Interaction projection is invalid for Session ${candidate.sessionId}`,
          { cause: error },
        ),
      );
    }
    if (pending.some((request) => request.requestId === candidate.requestId)) return;
    if (pending.length >= INTERACTION_MAX_PENDING_PER_SESSION) {
      return rejectedAdmission(candidate.requestId, 'capacity_exceeded').rejection;
    }
    try {
      decodeSessionInteractionProjection(
        projectSessionInteractions([...pending, candidate]),
        candidate.sessionId,
      );
    } catch {
      return rejectedAdmission(candidate.requestId, 'capacity_exceeded').rejection;
    }
  }

  #rejectProvisional(entry: LiveEntry, rejection: SafeAcceptRejection): AcceptDisposition {
    entry.run.continuations.delete(entry.continuation);
    this.#releaseEntry(entry);
    return { kind: 'rejected', rejection };
  }

  private query(
    sessionId: string,
    interactionId: string,
  ): ReturnType<InteractionOperationHandlerMap['interaction.query']> {
    return observeTask(
      this.sessionAdmission.run(sessionId, async () => {
        const record = await this.#readInteraction(interactionId);
        return record?.request.sessionId === sessionId
          ? { ok: true, result: projectInteractionRecord(record) }
          : {
              ok: false,
              error: { code: 'not_found', message: 'Interaction was not found' },
            };
      }),
    );
  }

  private answer(
    input: InteractionAnswerInput,
  ): ReturnType<InteractionOperationHandlerMap['interaction.answer']> {
    return observeTask(
      (async () => {
        const routed = await this.#readInteraction(input.interactionId);
        if (!routed) {
          return {
            ok: false,
            error: { code: 'not_found', message: 'Interaction was not found' },
          } as const;
        }
        return this.sessionAdmission.run(routed.request.sessionId, async (lease) => {
          const record = await this.#readInteraction(input.interactionId);
          if (!record) {
            throw this.#tripFailStop(
              new RuntimeInteractionInvariantError(
                `Routed Interaction ${input.interactionId} disappeared before arbitration`,
              ),
            );
          }
          this.#assertExactRequest(routed.request, record.request);
          if (record.outcome) {
            return answerOutcome(
              { request: record.request, outcome: record.outcome },
              input.answer,
            );
          }
          if (!isInteractionAnswerValidForRequest(record.request.request, input.answer)) {
            return {
              ok: false,
              error: {
                code: 'operation_conflict',
                message: 'Interaction answer does not match the pending request',
              },
            } as const;
          }
          const entry = this.#requireLiveEntry(record.request);
          const winner = await this.#commitAnswer(
            entry,
            wireCanonicalOutcome(input.answer, this.now()),
            lease,
          );
          return answerOutcome({ request: record.request, outcome: winner }, input.answer);
        });
      })(),
    );
  }

  async #commitAnswer(
    entry: LiveEntry,
    candidate: Exclude<InteractionCanonicalOutcome, { kind: 'closure' }>,
    lease: SessionAdmissionLease,
  ): Promise<StoredInteractionOutcome> {
    if (
      candidate.kind === 'permission_answer' &&
      candidate.rememberForTurn &&
      entry.request.rememberScopeId === undefined
    ) {
      throw this.#tripFailStop(
        new RuntimeInteractionInvariantError(
          `Remembered permission ${entry.request.requestId} has no sibling scope`,
        ),
      );
    }
    const target = await this.#commitOutcome(entry.request, candidate);
    try {
      const committed: CommittedEntry[] = [{ entry, outcome: target }];
      if (
        candidate.kind === 'permission_answer' &&
        candidate.rememberForTurn &&
        interactionCanonicalOutcomesEquivalent(target.outcome, candidate)
      ) {
        const pending = await this.#readPending({
          sessionId: entry.request.sessionId,
          turnId: entry.request.turnId,
          runId: entry.request.runId,
          kind: 'permission',
        });
        const siblings = pending
          .filter(
            (request) =>
              request.requestId !== entry.request.requestId &&
              request.rememberScopeId !== undefined &&
              request.rememberScopeId === entry.request.rememberScopeId,
          )
          .sort(compareStoredInteractionRequests);
        for (const request of siblings) {
          const sibling = this.#requireLiveEntry(request);
          committed.push({
            entry: sibling,
            outcome: await this.#commitOutcome(request, candidate),
          });
        }
      }
      await this.continuity.refreshCanonical(entry.request.sessionId, lease);
      this.#throwIfFatal();
      for (const item of committed.sort((left, right) =>
        compareStoredInteractionRequests(left.entry.request, right.entry.request),
      )) {
        this.#applyAndRelease(item.entry, item.outcome);
      }
      return target;
    } catch (error) {
      throw this.#tripFailStop(error);
    }
  }

  async #commitSingle(
    entry: LiveEntry,
    candidate: InteractionCanonicalOutcome,
    lease: SessionAdmissionLease,
  ): Promise<StoredInteractionOutcome> {
    const outcome = await this.#commitOutcome(entry.request, candidate);
    try {
      await this.continuity.refreshCanonical(entry.request.sessionId, lease);
      this.#throwIfFatal();
      this.#applyAndRelease(entry, outcome);
      return outcome;
    } catch (error) {
      throw this.#tripFailStop(error);
    }
  }

  async #closeRunAdmitted(
    run: BoundRun,
    reason: RuntimeInteractionRunClosureReason,
    lease: SessionAdmissionLease,
  ): Promise<void> {
    const pending = await this.#readPending(runIdentity(run));
    const committed: CommittedEntry[] = [];
    for (const request of pending.sort(compareStoredInteractionRequests)) {
      const entry = this.#requireLiveEntry(request);
      committed.push({
        entry,
        outcome: await this.#commitOutcome(request, {
          kind: 'closure',
          reason,
          committedAt: this.now(),
        }),
      });
    }
    await this.continuity.refreshCanonical(run.sessionId, lease);
    this.#throwIfFatal();
    for (const item of committed) this.#applyAndRelease(item.entry, item.outcome);
  }

  async #establishRequest(
    candidate: StoredInteractionRequest,
  ): Promise<
    | { readonly kind: 'stable'; readonly record: InteractionRecord }
    | { readonly kind: 'not_published'; readonly error: unknown }
  > {
    this.#throwIfFatal();
    let result: EstablishInteractionRequestResult;
    try {
      result = await this.#store.establishRequest(candidate);
    } catch (error) {
      throw this.#tripFailStop(error);
    }
    this.#throwIfFatal();
    if (result.status === 'stable') return this.#stableRequest(candidate, result);
    if (result.status === 'definitely_not_published') {
      return { kind: 'not_published', error: result.failure };
    }

    const canonical = await this.#readInteraction(candidate.requestId);
    if (!canonical) return { kind: 'not_published', error: result.failure };
    this.#assertExactRequest(candidate, canonical.request);
    let stabilized: EstablishInteractionRequestResult;
    try {
      stabilized = await this.#store.establishRequest(candidate);
    } catch (error) {
      throw this.#tripFailStop(error);
    }
    this.#throwIfFatal();
    if (stabilized.status !== 'stable') throw this.#tripFailStop(stabilized.failure);
    return this.#stableRequest(candidate, stabilized);
  }

  #stableRequest(
    candidate: StoredInteractionRequest,
    result: Extract<EstablishInteractionRequestResult, { status: 'stable' }>,
  ): { readonly kind: 'stable'; readonly record: InteractionRecord } {
    if (!result.matches) {
      throw this.#tripFailStop(
        new RuntimeInteractionInvariantError(
          `Canonical Interaction request conflicts with ${candidate.requestId}`,
        ),
      );
    }
    this.#assertExactRequest(candidate, result.record.request);
    return { kind: 'stable', record: result.record };
  }

  async #commitOutcome(
    request: StoredInteractionRequest,
    candidate: InteractionCanonicalOutcome,
  ): Promise<StoredInteractionOutcome> {
    this.#throwIfFatal();
    let result: CommitInteractionOutcomeResult;
    try {
      result = await this.#store.commitOutcome(request.requestId, candidate);
    } catch (error) {
      throw this.#tripFailStop(error);
    }
    this.#throwIfFatal();
    if (result.status === 'stable') return this.#stableOutcome(request, result);
    if (result.status === 'definitely_not_published') throw result.failure;

    const canonical = await this.#readInteraction(request.requestId);
    if (!canonical) throw this.#tripFailStop(result.failure);
    this.#assertExactRequest(request, canonical.request);
    let stabilized: CommitInteractionOutcomeResult;
    try {
      stabilized = await this.#store.commitOutcome(request.requestId, candidate);
    } catch (error) {
      throw this.#tripFailStop(error);
    }
    this.#throwIfFatal();
    if (stabilized.status !== 'stable') throw this.#tripFailStop(stabilized.failure);
    return this.#stableOutcome(request, stabilized);
  }

  #stableOutcome(
    request: StoredInteractionRequest,
    result: Extract<CommitInteractionOutcomeResult, { status: 'stable' }>,
  ): StoredInteractionOutcome {
    this.#assertExactRequest(request, result.record.request);
    this.#assertOutcomeIdentity(request, result.record.outcome);
    return result.record.outcome;
  }

  async #readContinuationRecord(
    run: BoundRun,
    continuation: RuntimeInteractionContinuationIdentity,
  ): Promise<InteractionRecord> {
    this.#assertRunOpen(run, continuation.requestId);
    if (!run.continuations.has(continuation)) {
      throw this.#tripFailStop(
        new RuntimeInteractionInvariantError(
          `Run ${run.runId} does not own Interaction continuation ${continuation.requestId}`,
        ),
      );
    }
    const record = await this.#readInteraction(continuation.requestId);
    if (!record || !continuationIdentityMatches(record.request, run, continuation)) {
      throw this.#tripFailStop(
        new RuntimeInteractionInvariantError(
          `Interaction continuation identity changed for ${continuation.requestId}`,
        ),
      );
    }
    return record;
  }

  async #readInteraction(requestId: string): Promise<InteractionRecord | undefined> {
    this.#throwIfFatal();
    try {
      const record = await this.#store.readInteraction(requestId);
      this.#throwIfFatal();
      return record;
    } catch (error) {
      throw this.#tripFailStop(error);
    }
  }

  async #readPending(
    filter?: Parameters<InteractiveInteractionStoreWriterFacade['listPending']>[0],
  ): Promise<StoredInteractionRequest[]> {
    this.#throwIfFatal();
    try {
      const pending = await this.#store.listPending(filter);
      this.#throwIfFatal();
      return pending;
    } catch (error) {
      throw this.#tripFailStop(error);
    }
  }

  #applyAndRelease(entry: LiveEntry, outcome: StoredInteractionOutcome): void {
    this.#throwIfFatal();
    try {
      if (entry.kind === 'permission') {
        const projected = runtimePermissionOutcome(outcome.outcome);
        if (projected.kind === 'closure') entry.continuation.applyClosure(projected.reason);
        else entry.continuation.applyAnswer(projected.answer);
      } else {
        const projected = runtimeQuestionOutcome(outcome.outcome);
        if (projected.kind === 'closure') entry.continuation.applyClosure(projected.reason);
        else entry.continuation.applyAnswer(projected.answer);
      }
    } catch (error) {
      throw this.#tripFailStop(error);
    }
    this.#releaseEntry(entry);
  }

  #requirePermissionEntry(
    run: BoundRun,
    continuation: RuntimePermissionContinuation,
    request: StoredInteractionRequest,
  ): LivePermissionEntry {
    const entry = this.#requireLiveEntry(request);
    if (entry.kind !== 'permission' || entry.run !== run || entry.continuation !== continuation) {
      throw this.#tripFailStop(
        new RuntimeInteractionInvariantError(
          `Interaction ${request.requestId} is not the owned permission continuation`,
        ),
      );
    }
    return entry;
  }

  #requireQuestionEntry(
    run: BoundRun,
    continuation: RuntimeUserQuestionContinuation,
    request: StoredInteractionRequest,
  ): LiveQuestionEntry {
    const entry = this.#requireLiveEntry(request);
    if (entry.kind !== 'question' || entry.run !== run || entry.continuation !== continuation) {
      throw this.#tripFailStop(
        new RuntimeInteractionInvariantError(
          `Interaction ${request.requestId} is not the owned question continuation`,
        ),
      );
    }
    return entry;
  }

  #requireLiveEntry(request: StoredInteractionRequest): LiveEntry {
    const entry = this.#live.get(request.requestId);
    if (!entry || entry.phase !== 'live' || !isDeepStrictEqual(entry.request, request)) {
      throw this.#tripFailStop(
        new RuntimeInteractionInvariantError(
          `Pending Interaction ${request.requestId} has no exact live continuation`,
        ),
      );
    }
    return entry;
  }

  #assertAnswerValid(request: StoredInteractionRequest, answer: InteractionAnswer): void {
    if (!isInteractionAnswerValidForRequest(request.request, answer)) {
      throw this.#tripFailStop(
        new RuntimeInteractionInvariantError(
          `Runtime answer does not match Interaction ${request.requestId}`,
        ),
      );
    }
    if (
      answer.kind === 'permission' &&
      answer.rememberForTurn &&
      request.rememberScopeId === undefined
    ) {
      throw this.#tripFailStop(
        new RuntimeInteractionInvariantError(
          `Remembered permission ${request.requestId} has no sibling scope`,
        ),
      );
    }
  }

  #assertContinuationIdentity(
    run: BoundRun,
    request: Pick<AnyPermissionRequestEvent | UserQuestionRequestEvent, 'requestId' | 'turnId'>,
    continuation: RuntimeInteractionContinuationIdentity,
  ): void {
    if (
      request.requestId !== continuation.requestId ||
      request.turnId !== run.turnId ||
      continuation.turnId !== run.turnId ||
      continuation.runId !== run.runId
    ) {
      throw this.#tripFailStop(
        new RuntimeInteractionInvariantError(
          `Interaction continuation identity does not match run ${run.runId}`,
        ),
      );
    }
  }

  #assertRunOpen(run: BoundRun, requestId: string): void {
    this.#assertOwnedRun(run);
    this.#throwIfFatal();
    if (run.released) {
      throw new RuntimeInteractionAdmissionRejectedError(requestId, 'authority_draining');
    }
    if (run.closure) {
      throw new RuntimeInteractionAdmissionRejectedError(
        requestId,
        'run_closed',
        run.closure.reason,
      );
    }
  }

  #assertOwnedRun(run: BoundRun): void {
    if (this.#runs.get(runKey(run)) !== run) {
      throw this.#tripFailStop(
        new RuntimeInteractionInvariantError(
          `Interaction owner identity changed for run ${run.runId}`,
        ),
      );
    }
  }

  #assertExactRequest(expected: StoredInteractionRequest, actual: StoredInteractionRequest): void {
    if (!isDeepStrictEqual(expected, actual)) {
      throw this.#tripFailStop(
        new RuntimeInteractionInvariantError(
          `Canonical Interaction request conflicts with ${expected.requestId}`,
        ),
      );
    }
  }

  #assertOutcomeIdentity(
    request: StoredInteractionRequest,
    outcome: StoredInteractionOutcome,
  ): void {
    if (
      outcome.requestId !== request.requestId ||
      outcome.sessionId !== request.sessionId ||
      outcome.turnId !== request.turnId ||
      outcome.runId !== request.runId
    ) {
      throw this.#tripFailStop(
        new RuntimeInteractionInvariantError(
          `Canonical Interaction outcome identity changed for ${request.requestId}`,
        ),
      );
    }
  }

  #releaseEntry(entry: LiveEntry): void {
    if (this.#fatal || entry.phase === 'poisoned' || entry.phase === 'released') return;
    if (this.#live.get(entry.request.requestId) !== entry) {
      throw this.#tripFailStop(
        new RuntimeInteractionInvariantError(
          `Interaction residency identity changed for ${entry.request.requestId}`,
        ),
      );
    }
    try {
      entry.residency.release();
    } catch (error) {
      throw this.#tripFailStop(error);
    }
    this.#live.delete(entry.request.requestId);
    entry.phase = 'released';
  }

  #reclaimEntry(entry: LiveEntry): void {
    if (entry.phase === 'released') return;
    if (this.#live.get(entry.request.requestId) === entry) {
      this.#live.delete(entry.request.requestId);
    }
    entry.phase = 'released';
    try {
      entry.residency.release();
    } catch {
      // Owner isolation is complete; reclaim cannot perform compensating I/O.
    }
  }

  #sessionReservationCount(sessionId: string): number {
    let count = 0;
    for (const entry of this.#live.values()) {
      if (entry.request.sessionId === sessionId) count += 1;
    }
    return count;
  }

  #acceptTask(task: Promise<AcceptDisposition>): Promise<void> {
    return observeTask(
      task.then((disposition) => {
        if (disposition.kind === 'rejected') throw disposition.rejection.error;
      }),
    );
  }

  #throwIfFatal(): void {
    if (this.#fatal) throw this.#fatal.error;
  }

  #tripFailStop(cause: unknown): RuntimeInteractionFailStopError {
    if (this.#fatal) return this.#fatal.error;
    const error =
      cause instanceof RuntimeInteractionFailStopError
        ? cause
        : new RuntimeInteractionFailStopError(
            'Runtime Host Interaction authority entered fail-stop',
            cause,
          );
    this.#fatal = { error };
    this.#acceptingCreates = false;
    for (const entry of this.#live.values()) entry.phase = 'poisoned';
    this.onFailStop(error);
    this.#resolveFatalSignal({ error });
    return error;
  }
}

function continuationIdentityMatches(
  request: StoredInteractionRequest,
  run: RuntimeInteractionRunIdentity,
  continuation: RuntimeInteractionContinuationIdentity,
): boolean {
  return (
    request.sessionId === run.sessionId &&
    request.turnId === run.turnId &&
    request.runId === run.runId &&
    request.requestId === continuation.requestId &&
    continuation.turnId === run.turnId &&
    continuation.runId === run.runId
  );
}

function runIdentity(run: RuntimeInteractionRunIdentity): RuntimeInteractionRunIdentity {
  return {
    sessionId: run.sessionId,
    turnId: run.turnId,
    runId: run.runId,
  };
}

function runKey(identity: RuntimeInteractionRunIdentity): string {
  return JSON.stringify([identity.sessionId, identity.turnId, identity.runId]);
}

function rejectedAdmission(
  requestId: string,
  reason: 'capacity_exceeded' | 'authority_draining' | 'request_settled',
): Extract<AcceptDisposition, { kind: 'rejected' }>;
function rejectedAdmission(
  requestId: string,
  reason: 'not_published',
  cause: unknown,
): Extract<AcceptDisposition, { kind: 'rejected' }>;
function rejectedAdmission(
  requestId: string,
  reason: 'capacity_exceeded' | 'authority_draining' | 'request_settled' | 'not_published',
  cause?: unknown,
): Extract<AcceptDisposition, { kind: 'rejected' }> {
  let error: RuntimeInteractionAdmissionRejectedError;
  if (reason === 'not_published') {
    error = new RuntimeInteractionAdmissionRejectedError(requestId, reason, cause);
  } else if (reason === 'capacity_exceeded') {
    error = new RuntimeInteractionAdmissionRejectedError(requestId, reason);
  } else {
    error = new RuntimeInteractionAdmissionRejectedError(requestId, reason);
  }
  return { kind: 'rejected', rejection: { error } };
}

interface Deferred {
  readonly promise: Promise<void>;
  readonly resolve: () => void;
  readonly reject: (error: unknown) => void;
}

function deferred(): Deferred {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  observeTask(promise);
  return { promise, resolve, reject };
}

function rejectedTask<T>(error: unknown): Promise<T> {
  return observeTask(Promise.reject(error));
}

function observeTask<T>(task: Promise<T>): Promise<T> {
  void task.then(
    () => undefined,
    () => undefined,
  );
  return task;
}
