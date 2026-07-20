import type { AgentBackend } from '@maka/core/backend-types';
import type { RuntimeEvent } from '@maka/core/runtime-event';
import type { StopSessionInput } from './session-manager.js';
import type { AgentRun } from './agent-run.js';
import {
  RuntimeInteractionAdmissionRejectedError,
  RuntimeInteractionFailStopError,
  RuntimeInteractionInvariantError,
  type RuntimeInteractionAuthority,
  type RuntimeInteractionContinuationAuthority,
  type RuntimeInteractionFatalError,
  type RuntimeInteractionRunFacet,
  type RuntimeInteractionRunIdentity,
  type RuntimeInteractionRunOwner,
  type RuntimeInteractionRunClosureReason,
} from './interaction-authority.js';
import {
  asRuntimeInteractionFailStop,
  classifyRuntimeLifecycleError,
  isRuntimeLifecycleFatal,
  isTypedRuntimeStopClosure,
} from './runtime-lifecycle-errors.js';

export type RuntimeExecutionCapability =
  | { readonly kind: 'embedded' }
  | {
      readonly kind: 'hosted';
      readonly interactionAuthority: RuntimeInteractionAuthority;
    };

export type RuntimeBackendExecutionCapability =
  | { readonly kind: 'embedded' }
  | { readonly kind: 'hosted' };

export const EMBEDDED_RUNTIME_EXECUTION = Object.freeze({
  kind: 'embedded',
} satisfies RuntimeExecutionCapability);

export interface RuntimeHostedRunControl {
  readonly runId: string;
  readonly turnId: string;
  readonly interactions: RuntimeInteractionRunFacet;
  hasStopClaim(): boolean;
  claimFailure(error: unknown): void;
  fail(error: RuntimeInteractionFatalError): void;
  runSuccessorEffect<T>(kind: RuntimeSuccessorEffectKind, operation: () => Promise<T>): Promise<T>;
}

export interface RuntimeHostedBackendRunBinding {
  isolateRegisteredSuccessorEffects(cause: RuntimeSuccessorEffectIsolationCause): Promise<void>;
  revoke(): void;
}

export type RuntimeSuccessorEffectIsolationCause =
  | { readonly kind: 'clean_drain' }
  | {
      readonly kind: 'fail_stop';
      readonly error: RuntimeInteractionFailStopError;
    };

export const RUNTIME_BIND_HOSTED_RUN: unique symbol = Symbol('runtimeBindHostedRun');

export interface RuntimeHostedBackend {
  [RUNTIME_BIND_HOSTED_RUN](control: RuntimeHostedRunControl): RuntimeHostedBackendRunBinding;
}

export interface RuntimeExecutionDrainHandle {
  readonly ownerIsolationDrain: Promise<RuntimeCompositionSuccessorEffectsIsolated>;
  readonly reclaimDrain: Promise<RuntimeExecutionSettled>;
}

export type RuntimeSuccessorEffectKind =
  | 'artifact_persistence'
  | 'backend_activation'
  | 'history_cleanup'
  | 'run_started_callback'
  | 'tool_execution';

export interface RuntimeCompositionSuccessorEffectsIsolated {
  readonly kind: 'composition_successor_effects_isolated';
}

export interface RuntimeExecutionSettled {
  readonly kind: 'runtime_execution_settled';
}

export const COMPOSITION_SUCCESSOR_EFFECTS_ISOLATED: RuntimeCompositionSuccessorEffectsIsolated =
  Object.freeze({
    kind: 'composition_successor_effects_isolated',
  });

export const RUNTIME_EXECUTION_SETTLED: RuntimeExecutionSettled = Object.freeze({
  kind: 'runtime_execution_settled',
});

export interface RuntimeInteractionFailStopHandle extends RuntimeExecutionDrainHandle {
  readonly error: RuntimeInteractionFailStopError;
}

interface Completion<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (error: unknown) => void;
}

interface StopRequest {
  readonly source: StopSessionInput['source'] | undefined;
  readonly reason: 'user_stop' | 'redirect';
  readonly mode: 'immediate' | 'after_step';
}

class SuccessorEffectTracker {
  private state: 'open' | 'closed' = 'open';
  private readonly pending = new Set<Promise<void>>();
  private failure: { error: unknown } | undefined;
  private drain: Promise<void> | undefined;

  run<T>(kind: RuntimeSuccessorEffectKind, operation: () => Promise<T>): Promise<T> {
    if (this.state === 'closed') {
      throw new RuntimeInteractionAdmissionRejectedError(kind, 'authority_draining');
    }
    const slot = completion<void>();
    this.pending.add(slot.promise);
    void slot.promise
      .finally(() => {
        this.pending.delete(slot.promise);
      })
      .catch(() => undefined);
    let task: Promise<T>;
    try {
      task = operation();
    } catch (error) {
      this.failure ??= { error };
      slot.reject(error);
      throw error;
    }
    void task.then(
      () => slot.resolve(undefined),
      (error) => {
        this.failure ??= { error };
        slot.reject(error);
      },
    );
    return task;
  }

  isOpen(): boolean {
    return this.state === 'open';
  }

  closeAndDrain(): Promise<void> {
    if (this.drain) return this.drain;
    this.state = 'closed';
    const admitted = [...this.pending];
    this.drain = settleWithoutErasingFailure(admitted).then(() => {
      if (this.failure) throw this.failure.error;
    });
    return this.drain;
  }
}

class ReclaimTaskTracker {
  private state: 'open' | 'closed' = 'open';
  private readonly pending = new Set<Promise<void>>();
  private failure: { error: unknown } | undefined;
  private drain: Promise<void> | undefined;

  run<T>(operation: () => Promise<T>): Promise<T> {
    if (this.state === 'closed') {
      throw new RuntimeInteractionInvariantError(
        'Execution settlement work was registered after reclaim started',
      );
    }
    const slot = completion<void>();
    this.pending.add(slot.promise);
    void slot.promise
      .finally(() => {
        this.pending.delete(slot.promise);
      })
      .catch(() => undefined);
    let task: Promise<T>;
    try {
      task = operation();
    } catch (error) {
      this.failure ??= { error };
      slot.reject(error);
      throw error;
    }
    void task.then(
      () => slot.resolve(undefined),
      (error) => {
        this.failure ??= { error };
        slot.reject(error);
      },
    );
    return task;
  }

  closeAndDrain(): Promise<void> {
    if (this.drain) return this.drain;
    this.state = 'closed';
    this.drain = settleWithoutErasingFailure([...this.pending]).then(() => {
      if (this.failure) throw this.failure.error;
    });
    return this.drain;
  }
}

type RunFacetState =
  | { kind: 'open' }
  | {
      kind: 'closing' | 'closed';
      reason: RuntimeInteractionRunClosureReason;
      task: Promise<void>;
    }
  | { kind: 'failed'; error: RuntimeInteractionFailStopError }
  | {
      kind: 'released';
      reason?: RuntimeInteractionRunClosureReason;
      error?: RuntimeInteractionFailStopError;
      task?: Promise<void>;
    };

type BackendPublicationState =
  | { kind: 'idle' }
  | { kind: 'activating' }
  | { kind: 'bound'; backend: AgentBackend }
  | { kind: 'unavailable' };

class RunBoundInteractionOwner {
  readonly sessionId: string;
  readonly turnId: string;
  readonly runId: string;
  readonly facet: RuntimeInteractionRunFacet;

  #state: RunFacetState = { kind: 'open' };
  #delegateReleased = false;
  readonly #delegate: RuntimeInteractionRunOwner;

  constructor(identity: RuntimeInteractionRunIdentity, delegate: RuntimeInteractionRunOwner) {
    this.#delegate = delegate;
    this.sessionId = identity.sessionId;
    this.turnId = identity.turnId;
    this.runId = identity.runId;
    if (
      delegate.sessionId !== identity.sessionId ||
      delegate.turnId !== identity.turnId ||
      delegate.runId !== identity.runId
    ) {
      throw new RuntimeInteractionInvariantError(
        `Interaction facet ${delegate.runId}/${delegate.turnId} does not match run ${identity.runId}/${identity.turnId}`,
      );
    }
    this.facet = Object.freeze({
      sessionId: this.sessionId,
      turnId: this.turnId,
      runId: this.runId,
      acceptPermissionRequest: (
        input: Parameters<RuntimeInteractionContinuationAuthority['acceptPermissionRequest']>[0],
      ) => this.acceptPermissionRequest(input),
      commitPermissionAnswer: (
        input: Parameters<RuntimeInteractionContinuationAuthority['commitPermissionAnswer']>[0],
      ) => this.commitPermissionAnswer(input),
      commitPermissionTimeout: (
        input: Parameters<RuntimeInteractionContinuationAuthority['commitPermissionTimeout']>[0],
      ) => this.commitPermissionTimeout(input),
      acceptUserQuestionRequest: (
        input: Parameters<RuntimeInteractionContinuationAuthority['acceptUserQuestionRequest']>[0],
      ) => this.acceptUserQuestionRequest(input),
    });
  }

  acceptPermissionRequest(
    input: Parameters<RuntimeInteractionContinuationAuthority['acceptPermissionRequest']>[0],
  ): ReturnType<RuntimeInteractionContinuationAuthority['acceptPermissionRequest']> {
    this.assertOpen(input.request.requestId);
    this.assertRequestIdentity(input.request.requestId, input.request.turnId, input.continuation);
    return this.#delegate.acceptPermissionRequest(input);
  }

  commitPermissionAnswer(
    input: Parameters<RuntimeInteractionContinuationAuthority['commitPermissionAnswer']>[0],
  ): ReturnType<RuntimeInteractionContinuationAuthority['commitPermissionAnswer']> {
    this.assertOpen(input.continuation.requestId);
    this.assertContinuationIdentity(input.continuation);
    return this.#delegate.commitPermissionAnswer(input);
  }

  commitPermissionTimeout(
    input: Parameters<RuntimeInteractionContinuationAuthority['commitPermissionTimeout']>[0],
  ): ReturnType<RuntimeInteractionContinuationAuthority['commitPermissionTimeout']> {
    this.assertOpen(input.continuation.requestId);
    this.assertContinuationIdentity(input.continuation);
    return this.#delegate.commitPermissionTimeout(input);
  }

  acceptUserQuestionRequest(
    input: Parameters<RuntimeInteractionContinuationAuthority['acceptUserQuestionRequest']>[0],
  ): ReturnType<RuntimeInteractionContinuationAuthority['acceptUserQuestionRequest']> {
    this.assertOpen(input.request.requestId);
    this.assertRequestIdentity(input.request.requestId, input.request.turnId, input.continuation);
    return this.#delegate.acceptUserQuestionRequest(input);
  }

  close(reason: RuntimeInteractionRunClosureReason): Promise<void> {
    const state = this.#state;
    if (state.kind === 'failed') throw state.error;
    if (state.kind === 'released') {
      if (state.error) throw state.error;
      if (state.reason === reason && state.task) return state.task;
      throw new RuntimeInteractionInvariantError(
        `Released Interaction facet for run ${this.runId} cannot change closure`,
      );
    }
    if (state.kind === 'closing' || state.kind === 'closed') {
      if (state.reason !== reason) {
        throw new RuntimeInteractionInvariantError(
          `Run ${this.runId} Interaction closure changed from ${state.reason} to ${reason}`,
        );
      }
      return state.task;
    }
    const closure = completion<void>();
    const task = closure.promise;
    const closing: RunFacetState = { kind: 'closing', reason, task };
    this.#state = closing;
    let delegateTask: Promise<void>;
    try {
      delegateTask = Promise.resolve(this.#delegate.close(reason));
    } catch (error) {
      delegateTask = Promise.reject(error);
    }
    void delegateTask.then(closure.resolve, closure.reject);
    void task.then(
      () => {
        if (this.#state === closing) this.#state = { kind: 'closed', reason, task };
      },
      () => undefined,
    );
    return task;
  }

  fail(error: RuntimeInteractionFailStopError): void {
    if (this.#state.kind === 'released') {
      this.#state = { ...this.#state, error };
      return;
    }
    this.#state = { kind: 'failed', error };
  }

  release(): void {
    if (this.#state.kind === 'released') return;
    const state = this.#state;
    this.#state =
      state.kind === 'failed'
        ? { kind: 'released', error: state.error }
        : state.kind === 'closing' || state.kind === 'closed'
          ? { kind: 'released', reason: state.reason, task: state.task }
          : { kind: 'released' };
    if (this.#delegateReleased) return;
    this.#delegateReleased = true;
    this.#delegate.release();
  }

  private assertRequestIdentity(
    requestId: string,
    turnId: string,
    continuation: { requestId: string; turnId: string; runId: string },
  ): void {
    if (requestId !== continuation.requestId || turnId !== this.turnId) {
      throw new RuntimeInteractionAdmissionRejectedError(requestId, 'invalid_request');
    }
    this.assertContinuationIdentity(continuation);
  }

  private assertContinuationIdentity(continuation: {
    requestId: string;
    turnId: string;
    runId: string;
  }): void {
    if (continuation.turnId !== this.turnId || continuation.runId !== this.runId) {
      throw new RuntimeInteractionAdmissionRejectedError(continuation.requestId, 'invalid_request');
    }
  }

  private assertOpen(requestId: string): void {
    const state = this.#state;
    if (state.kind === 'open') return;
    if (state.kind === 'failed') throw state.error;
    if (state.kind === 'released' && state.error) throw state.error;
    if (state.kind === 'closing' || state.kind === 'closed') {
      throw new RuntimeInteractionAdmissionRejectedError(requestId, 'run_closed', state.reason);
    }
    if (state.reason) {
      throw new RuntimeInteractionAdmissionRejectedError(requestId, 'run_closed', state.reason);
    }
    throw new RuntimeInteractionAdmissionRejectedError(requestId, 'authority_draining');
  }
}

export class RunExecution {
  readonly runId: string;
  readonly turnId: string;
  readonly sessionId: string;
  readonly reclaimDrain: Promise<RuntimeExecutionSettled>;

  private readonly successorEffects = new SuccessorEffectTracker();
  private readonly reclaimTasks = new ReclaimTaskTracker();
  private readonly interrupt: Promise<never>;
  private readonly rejectInterrupt: (error: RuntimeInteractionFailStopError) => void;
  private readonly runReady = completion<AgentRun | undefined>();
  private readonly backendReady = completion<AgentBackend | undefined>();
  private readonly interactionReady = completion<RunBoundInteractionOwner | undefined>();
  private readonly interactionRelease = completion<void>();
  private readonly reclaim = completion<RuntimeExecutionSettled>();
  private readonly failStopCallbacks = new Set<(error: RuntimeInteractionFailStopError) => void>();
  private interactionOwner: RunBoundInteractionOwner | undefined;
  private backendControl: RuntimeHostedRunControl | undefined;
  private interactionInitialized = false;
  private run: AgentRun | undefined;
  private backendPublication: BackendPublicationState = { kind: 'idle' };
  private backendBinding: RuntimeHostedBackendRunBinding | undefined;
  private backendBindingFailure: RuntimeInteractionFailStopError | undefined;
  private backendBindingRevoked = false;
  private stopRequest: StopRequest | undefined;
  private stopTask: Promise<void> | undefined;
  private failureSettlement: Promise<void> | undefined;
  private abandonment: Promise<void> | undefined;
  private failure: RuntimeInteractionFailStopError | undefined;
  private failStopCallbackFailure: { error: unknown } | undefined;
  private hostReleaseFailure: RuntimeInteractionFailStopError | undefined;
  private interactionOwnerReleased = false;
  private released = false;
  private reclaimStarted = false;
  private finalization: Promise<void> | undefined;
  private successorEffectsDrain: Promise<void> | undefined;

  constructor(
    identity: { sessionId: string; turnId: string; runId: string },
    private readonly capability: RuntimeExecutionCapability,
    private readonly installCompositionFailStop: (
      error: RuntimeInteractionFailStopError,
    ) => RuntimeInteractionFailStopHandle,
  ) {
    this.sessionId = identity.sessionId;
    this.turnId = identity.turnId;
    this.runId = identity.runId;
    let rejectInterrupt!: (error: RuntimeInteractionFailStopError) => void;
    this.interrupt = new Promise<never>((_resolve, reject) => {
      rejectInterrupt = reject;
    });
    this.rejectInterrupt = rejectInterrupt;
    void this.interrupt.catch(() => undefined);
    this.reclaimDrain = this.reclaim.promise;
    observeRejection(this.interactionReady.promise);
    observeRejection(this.interactionRelease.promise);
    observeRejection(this.reclaimDrain);
    if (capability.kind === 'embedded') {
      this.interactionOwnerReleased = true;
      this.interactionReady.resolve(undefined);
      this.interactionRelease.resolve(undefined);
    }
  }

  initializeInteraction(): void {
    if (this.interactionInitialized) return;
    this.interactionInitialized = true;
    if (this.capability.kind === 'embedded') return;
    let delegate: RuntimeInteractionRunOwner | undefined;
    let owner: RunBoundInteractionOwner;
    try {
      delegate = this.capability.interactionAuthority.bindRun({
        sessionId: this.sessionId,
        turnId: this.turnId,
        runId: this.runId,
      });
      owner = new RunBoundInteractionOwner(
        {
          sessionId: this.sessionId,
          turnId: this.turnId,
          runId: this.runId,
        },
        delegate,
      );
    } catch (error) {
      let releaseFailure: unknown;
      try {
        delegate?.release();
      } catch (candidate) {
        releaseFailure = candidate;
      }
      const cause =
        releaseFailure === undefined
          ? error
          : new AggregateError([error, releaseFailure], 'Interaction bind cleanup failed');
      const fatal = asRuntimeInteractionFailStop(
        `Could not bind Interaction authority for run ${this.runId}`,
        cause,
      );
      this.interactionReady.reject(fatal);
      this.installCompositionFailStop(fatal);
      throw fatal;
    }
    this.interactionOwner = owner;
    this.backendControl = this.createBackendControl(owner.facet);
    if (this.failure) owner.fail(this.failure);
    this.interactionReady.resolve(owner);
    this.throwIfFailed();
  }

  get canonicalError(): RuntimeInteractionFailStopError | undefined {
    return this.failure;
  }

  get agentRun(): AgentRun | undefined {
    return this.run;
  }

  attachRun(run: AgentRun): void {
    if (this.run && this.run !== run) {
      throw new RuntimeInteractionInvariantError(`Execution ${this.runId} changed AgentRun owner`);
    }
    if (run.runId !== this.runId || run.turnId !== this.turnId) {
      throw new RuntimeInteractionInvariantError(
        `Execution ${this.runId}/${this.turnId} received mismatched AgentRun ${run.runId}/${run.turnId}`,
      );
    }
    if (this.run) return;
    this.run = run;
    this.runReady.resolve(run);
    if (this.stopRequest) run.stop(this.stopRequest.source);
    this.throwIfFailed();
  }

  async begin<T>(run: AgentRun, operation: () => Promise<T>): Promise<T> {
    this.attachRun(run);
    try {
      return await this.wait(operation());
    } catch (error) {
      if (this.failure) throw this.failure;
      if (isRuntimeLifecycleFatal(error)) throw error;
      this.sealBackendUnavailable();
      await this.failRun(error);
      await this.finalize();
      throw error;
    }
  }

  activateBackend<T extends { readonly backend: AgentBackend }>(
    operation: () => Promise<T>,
  ): Promise<T> {
    this.throwIfFailed();
    if (this.released) {
      throw new RuntimeInteractionAdmissionRejectedError(this.runId, 'authority_draining');
    }
    if (this.backendPublication.kind === 'unavailable' && !this.successorEffects.isOpen()) {
      throw new RuntimeInteractionAdmissionRejectedError(this.runId, 'authority_draining');
    }
    if (this.backendPublication.kind !== 'idle') {
      const invariant = new RuntimeInteractionInvariantError(
        `Execution ${this.runId} attempted a second backend activation`,
      );
      this.fail(invariant);
      throw invariant;
    }
    let task: Promise<T>;
    try {
      task = this.successorEffects.run('backend_activation', async () => {
        if (this.released) {
          throw new RuntimeInteractionAdmissionRejectedError(this.runId, 'authority_draining');
        }
        if (this.backendPublication.kind !== 'idle') {
          throw new RuntimeInteractionInvariantError(
            `Execution ${this.runId} backend activation lost its reservation`,
          );
        }
        this.backendPublication = { kind: 'activating' };
        let active: T;
        try {
          active = await operation();
        } catch (error) {
          this.finishBackendUnavailable();
          throw error;
        }
        if (this.released) {
          try {
            await active.backend.dispose();
          } catch (error) {
            const fatal = asRuntimeInteractionFailStop(
              `Could not dispose backend ${active.backend.kind} published after run ${this.runId} released`,
              error,
            );
            this.backendBindingFailure = fatal;
            this.finishBackendUnavailable(active.backend);
            this.installCompositionFailStop(fatal);
            throw fatal;
          }
          this.finishBackendUnavailable();
          throw (
            this.failure ??
            new RuntimeInteractionAdmissionRejectedError(this.runId, 'authority_draining')
          );
        }
        this.bindBackendDuringActivation(active.backend);
        return active;
      });
    } catch (error) {
      this.sealBackendUnavailable();
      const classified = classifyRuntimeLifecycleError(error);
      if (classified.kind === 'invariant') this.fail(classified.error);
      throw error;
    }
    return task;
  }

  runSuccessorEffect<T>(kind: RuntimeSuccessorEffectKind, operation: () => Promise<T>): Promise<T> {
    this.throwIfFailed();
    try {
      return this.successorEffects.run(kind, operation);
    } catch (error) {
      const classified = classifyRuntimeLifecycleError(error);
      if (classified.kind === 'invariant') this.fail(classified.error);
      throw error;
    }
  }

  runReclaim<T>(operation: () => Promise<T>): Promise<T> {
    this.throwIfFailed();
    return this.reclaimTasks.run(operation);
  }

  async wait<T>(task: Promise<T>): Promise<T> {
    observeRejection(task);
    this.throwIfFailed();
    try {
      return await Promise.race([task, this.interrupt]);
    } catch (error) {
      if (this.failure) throw this.failure;
      if (isRuntimeLifecycleFatal(error)) {
        this.fail(error);
        throw this.failure ?? error;
      }
      throw error;
    }
  }

  waitLogical<T>(task: Promise<T>): Promise<T> {
    return this.wait(task);
  }

  onFailStop(callback: (error: RuntimeInteractionFailStopError) => void): void {
    if (this.failure) {
      callback(this.failure);
      return;
    }
    this.failStopCallbacks.add(callback);
  }

  throwIfFailed(): void {
    if (this.failure) throw this.failure;
  }

  claimFailure(error: unknown): void {
    if (isRuntimeLifecycleFatal(error)) return;
    this.run?.claimFailureTerminal(error);
  }

  hasStopClaim(): boolean {
    return this.run?.hasStopClaim() ?? this.stopRequest !== undefined;
  }

  fail(error: RuntimeInteractionFatalError): void {
    const classified = classifyRuntimeLifecycleError(error);
    const canonical =
      classified.kind === 'fail_stop'
        ? classified.error
        : new RuntimeInteractionFailStopError(error.message, error);
    this.installCompositionFailStop(canonical);
  }

  claimTerminalEvent(event: RuntimeEvent): RuntimeInteractionRunClosureReason {
    const run = this.requireRun();
    return run.claimTerminalEvent(event);
  }

  async closeForClaim(reason: RuntimeInteractionRunClosureReason): Promise<void> {
    if (this.capability.kind === 'embedded') return;
    const owner = await this.wait(this.interactionReady.promise);
    if (!owner) return;
    let close: Promise<void>;
    try {
      close = Promise.resolve(owner.close(reason));
    } catch (error) {
      close = Promise.reject(error);
    }
    const promise = close.catch((error: unknown) => {
      const fatal = asRuntimeInteractionFailStop(
        `Could not confirm Interaction closure for run ${this.runId}`,
        error,
      );
      this.fail(fatal);
      throw fatal;
    });
    return await this.wait(promise);
  }

  failRun(error: unknown): Promise<void> {
    if (this.failure) throw this.failure;
    if (isRuntimeLifecycleFatal(error)) throw error;
    if (this.failureSettlement) return this.failureSettlement;
    const run = this.requireRun();
    const reason = run.claimFailureTerminal(error);
    this.failureSettlement = this.settleFailure(run, reason, error);
    observeRejection(this.failureSettlement);
    return this.failureSettlement;
  }

  abandon(
    error: unknown,
    closeConsumer: () => void,
    abortBackend: () => Promise<void>,
  ): Promise<void> {
    if (this.failure) throw this.failure;
    if (isRuntimeLifecycleFatal(error)) throw error;
    if (this.abandonment) return this.abandonment;
    const run = this.requireRun();
    const reason = run.claimFailureTerminal(error);
    if (!this.failureSettlement) {
      const settlement = completion<void>();
      this.failureSettlement = settlement.promise;
      observeRejection(this.failureSettlement);
      this.abandonment = this.settleOwnedAbandonment(
        run,
        reason,
        error,
        closeConsumer,
        abortBackend,
        settlement,
      );
    } else {
      this.abandonment = this.settleAbandonmentAfterFailure(reason, closeConsumer, abortBackend);
    }
    observeRejection(this.abandonment);
    return this.abandonment;
  }

  private async settleAbandonmentAfterFailure(
    reason: RuntimeInteractionRunClosureReason,
    closeConsumer: () => void,
    abortBackend: () => Promise<void>,
  ): Promise<void> {
    let failure: { error: unknown } | undefined;
    await captureFailure(
      () => this.closeForClaim(reason),
      (error) => {
        failure ??= { error };
      },
    );
    await captureFailure(
      () => this.settleAbandonmentCancellation(reason, closeConsumer, abortBackend),
      (error) => {
        failure ??= { error };
      },
    );
    await captureFailure(
      () => this.failureSettlement!,
      (error) => {
        failure ??= { error };
      },
    );
    await captureFailure(
      () => this.finalize(),
      (error) => {
        failure ??= { error };
      },
    );
    if (failure) throw failure.error;
  }

  private async settleOwnedAbandonment(
    run: AgentRun,
    reason: RuntimeInteractionRunClosureReason,
    error: unknown,
    closeConsumer: () => void,
    abortBackend: () => Promise<void>,
    settlement: Completion<void>,
  ): Promise<void> {
    let failure: { error: unknown } | undefined;
    await captureFailure(
      () => this.closeForClaim(reason),
      (candidate) => {
        failure ??= { error: candidate };
      },
    );
    await captureFailure(
      () => this.settleAbandonmentCancellation(reason, closeConsumer, abortBackend),
      (candidate) => {
        failure ??= { error: candidate };
      },
    );
    try {
      if (reason === 'turn_terminal') await this.wait(run.recordFailure(error));
      settlement.resolve(undefined);
    } catch (candidate) {
      settlement.reject(candidate);
      failure ??= { error: candidate };
    }
    await captureFailure(
      () => this.finalize(),
      (candidate) => {
        failure ??= { error: candidate };
      },
    );
    if (failure) throw failure.error;
  }

  private settleAbandonmentCancellation(
    reason: RuntimeInteractionRunClosureReason,
    closeConsumer: () => void,
    abortBackend: () => Promise<void>,
  ): Promise<void> {
    closeConsumer();
    return reason === 'turn_stopped' ? this.deliverStop() : abortBackend();
  }

  private async settleFailure(
    run: AgentRun,
    reason: RuntimeInteractionRunClosureReason,
    error: unknown,
  ): Promise<void> {
    await this.closeForClaim(reason);
    if (reason === 'turn_terminal') await this.wait(run.recordFailure(error));
  }

  isExpectedStop(error: unknown, authorityDraining: boolean): boolean {
    return this.requireRun().hasStopClaim() && isTypedRuntimeStopClosure(error, authorityDraining);
  }

  claimStop(
    source: StopSessionInput['source'] | undefined,
    reason: 'user_stop' | 'redirect' = 'user_stop',
    mode: 'immediate' | 'after_step' = 'immediate',
  ): boolean {
    if (this.stopRequest) return this.run ? this.run.hasStopClaim() : true;
    if (this.run && !this.run.stop(source)) return false;
    this.stopRequest = { source, reason, mode };
    return true;
  }

  async deliverStop(): Promise<void> {
    if (!this.stopRequest) return;
    if (this.stopTask) return await this.stopTask;
    const attempt = this.deliverStopOnce();
    this.stopTask = attempt;
    try {
      await attempt;
    } catch (error) {
      if (this.stopTask === attempt) this.stopTask = undefined;
      throw error;
    }
  }

  completeStop(): void {
    this.run?.completeStop();
  }

  async finalize(): Promise<void> {
    if (this.finalization) return await this.finalization;
    this.finalization = this.finalizeOnce();
    return await this.finalization;
  }

  installFailStop(error: RuntimeInteractionFailStopError): RuntimeExecutionDrainHandle {
    if (!this.failure) {
      this.failure = error;
      this.interactionOwner?.fail(error);
      this.rejectInterrupt(error);
      for (const callback of this.failStopCallbacks) {
        try {
          callback(error);
        } catch (callbackError) {
          this.failStopCallbackFailure ??= { error: callbackError };
        }
      }
      this.failStopCallbacks.clear();
    }
    const successorEffectsDrain = this.closeSuccessorEffectAdmission();
    const backendIsolation = this.beginBackendIsolation({
      kind: 'fail_stop',
      error: this.failure,
    });
    const ownerIsolationDrain = settleWithoutErasingFailure([
      this.failStopCallbackFailure
        ? Promise.reject(this.failStopCallbackFailure.error)
        : Promise.resolve(),
      successorEffectsDrain,
      this.interactionReady.promise,
      backendIsolation,
    ]).then(() => {
      this.releaseInteractionOwner();
      return COMPOSITION_SUCCESSOR_EFFECTS_ISOLATED;
    });
    observeRejection(ownerIsolationDrain);
    this.startReclaim();
    return { ownerIsolationDrain, reclaimDrain: this.reclaimDrain };
  }

  closeSuccessorEffectAdmission(): Promise<void> {
    this.successorEffectsDrain ??= this.successorEffects.closeAndDrain();
    return this.successorEffectsDrain;
  }

  beginCleanIsolation(): Promise<RuntimeCompositionSuccessorEffectsIsolated> {
    const isolation = settleWithoutErasingFailure([
      this.closeSuccessorEffectAdmission(),
      this.interactionReady.promise,
      this.beginBackendIsolation({ kind: 'clean_drain' }),
    ]).then(() => COMPOSITION_SUCCESSOR_EFFECTS_ISOLATED);
    observeRejection(isolation);
    return isolation;
  }

  release(): void {
    if (this.released) {
      if (this.hostReleaseFailure) throw this.failure ?? this.hostReleaseFailure;
      return;
    }
    this.released = true;
    this.sealBackendUnavailable();
    let releaseFailure: RuntimeInteractionFailStopError | undefined;
    const backendRevocationFailure = this.revokeBackendBinding();
    if (backendRevocationFailure) releaseFailure = backendRevocationFailure;
    try {
      this.releaseInteractionOwner();
    } catch (error) {
      releaseFailure ??=
        this.failure ??
        asRuntimeInteractionFailStop(
          `Could not release Runtime owner for run ${this.runId}`,
          error,
        );
    }
    if (!this.run) this.runReady.resolve(undefined);
    if (releaseFailure) {
      this.installCompositionFailStop(releaseFailure);
    }
    this.startReclaim();
    if (releaseFailure) throw this.failure ?? releaseFailure;
  }

  releaseInteractionOwner(deferCompositionFailure = false): void {
    if (this.interactionOwnerReleased) {
      if (this.hostReleaseFailure) {
        if (!deferCompositionFailure && !this.failure) {
          this.installCompositionFailStop(this.hostReleaseFailure);
        }
        throw this.failure ?? this.hostReleaseFailure;
      }
      return;
    }
    this.interactionOwnerReleased = true;
    try {
      this.interactionOwner?.release();
      this.interactionRelease.resolve(undefined);
    } catch (error) {
      const fatal = asRuntimeInteractionFailStop(
        `Could not release Interaction authority for run ${this.runId}`,
        error,
      );
      this.hostReleaseFailure = fatal;
      this.interactionRelease.reject(fatal);
      if (!deferCompositionFailure) this.installCompositionFailStop(fatal);
      throw this.failure ?? fatal;
    }
  }

  private async deliverStopOnce(): Promise<void> {
    const request = this.stopRequest;
    if (!request) return;
    const run = await this.runReady.promise;
    if (!run) return;
    run.stop(request.source);
    await this.closeForClaim('turn_stopped');
    const backend = await this.backendReady.promise;
    if (backend) await backend.stop(request.reason, request.mode);
  }

  private async finalizeOnce(): Promise<void> {
    this.throwIfFailed();
    const run = this.requireRun();
    if (run.hasPendingStop()) await this.wait(run.waitForStopCompletion());
    const reason = run.prepareFinalizationTerminal();
    await this.closeForClaim(reason);
    await this.wait(run.finalize());
    await this.closeSuccessorEffectAdmission();
    const revocationFailure = this.revokeBackendBinding();
    if (revocationFailure) {
      this.fail(revocationFailure);
      throw revocationFailure;
    }
  }

  private beginBackendIsolation(cause: RuntimeSuccessorEffectIsolationCause): Promise<void> {
    if (this.capability.kind === 'embedded') return Promise.resolve();
    this.sealBackendUnavailable();
    if (this.backendBindingFailure) return Promise.reject(this.backendBindingFailure);
    const binding = this.backendBinding;
    if (binding) {
      try {
        return Promise.resolve(binding.isolateRegisteredSuccessorEffects(cause));
      } catch (error) {
        return Promise.reject(error);
      }
    }
    return this.backendReady.promise.then((backend) => {
      if (!backend) return;
      if (this.backendBindingFailure) throw this.backendBindingFailure;
      const lateBinding = this.backendBinding;
      if (!lateBinding) {
        throw new RuntimeInteractionInvariantError(
          `Hosted backend ${backend.kind} escaped fail-stop binding for run ${this.runId}`,
        );
      }
      return lateBinding.isolateRegisteredSuccessorEffects(cause);
    });
  }

  private revokeBackendBinding(): RuntimeInteractionFailStopError | undefined {
    if (this.backendBindingRevoked || !this.backendBinding) return undefined;
    this.backendBindingRevoked = true;
    try {
      this.backendBinding.revoke();
      return undefined;
    } catch (error) {
      return asRuntimeInteractionFailStop(
        `Could not revoke hosted backend binding for run ${this.runId}`,
        error,
      );
    }
  }

  private startReclaim(): void {
    if (this.reclaimStarted || !this.released) return;
    this.reclaimStarted = true;
    void settleWithoutErasingFailure([
      this.closeSuccessorEffectAdmission(),
      this.reclaimTasks.closeAndDrain(),
      this.interactionRelease.promise,
      ...(this.failure ? [Promise.reject(this.failure)] : []),
    ]).then(
      () => this.reclaim.resolve(RUNTIME_EXECUTION_SETTLED),
      (error) => this.reclaim.reject(error),
    );
  }

  private requireRun(): AgentRun {
    if (!this.run) {
      throw new RuntimeInteractionInvariantError(`Execution ${this.runId} has no AgentRun owner`);
    }
    return this.run;
  }

  private createBackendControl(interactions: RuntimeInteractionRunFacet): RuntimeHostedRunControl {
    return Object.freeze({
      runId: this.runId,
      turnId: this.turnId,
      interactions,
      hasStopClaim: () => this.hasStopClaim(),
      claimFailure: (error: unknown) => this.claimFailure(error),
      fail: (error: RuntimeInteractionFatalError) => this.fail(error),
      runSuccessorEffect: <T>(kind: RuntimeSuccessorEffectKind, operation: () => Promise<T>) =>
        this.runSuccessorEffect(kind, operation),
    });
  }

  private bindBackendDuringActivation(backend: AgentBackend): void {
    if (this.backendPublication.kind !== 'activating') {
      throw new RuntimeInteractionInvariantError(
        `Execution ${this.runId} published backend ${backend.kind} outside activation`,
      );
    }
    if (this.released) {
      throw new RuntimeInteractionAdmissionRejectedError(this.runId, 'authority_draining');
    }
    if (this.capability.kind === 'hosted') {
      try {
        const hosted = backend as AgentBackend & Partial<RuntimeHostedBackend>;
        const bind = hosted[RUNTIME_BIND_HOSTED_RUN];
        if (!bind || !this.backendControl) {
          throw new RuntimeInteractionInvariantError(
            `Hosted backend ${backend.kind} cannot bind run ${this.runId}`,
          );
        }
        const binding = bind.call(hosted, this.backendControl);
        if (
          !binding ||
          typeof binding.isolateRegisteredSuccessorEffects !== 'function' ||
          typeof binding.revoke !== 'function'
        ) {
          throw new RuntimeInteractionInvariantError(
            `Hosted backend ${backend.kind} returned an incomplete run binding for ${this.runId}`,
          );
        }
        this.backendBinding = binding;
      } catch (error) {
        const fatal = asRuntimeInteractionFailStop(
          `Could not bind hosted backend ${backend.kind} to run ${this.runId}`,
          error,
        );
        this.backendBindingFailure = fatal;
        this.finishBackendUnavailable(backend);
        this.installCompositionFailStop(fatal);
        throw this.failure ?? fatal;
      }
    }
    this.backendPublication = { kind: 'bound', backend };
    this.backendReady.resolve(backend);
  }

  private sealBackendUnavailable(): void {
    if (this.backendPublication.kind !== 'idle') return;
    this.backendPublication = { kind: 'unavailable' };
    this.backendReady.resolve(undefined);
  }

  private finishBackendUnavailable(backend?: AgentBackend): void {
    if (this.backendPublication.kind === 'bound') {
      throw new RuntimeInteractionInvariantError(
        `Execution ${this.runId} cannot withdraw a bound backend`,
      );
    }
    this.backendPublication = { kind: 'unavailable' };
    this.backendReady.resolve(backend);
  }
}

type CoordinatorState =
  | { kind: 'open' }
  | { kind: 'clean_draining'; executions: readonly RunExecution[] }
  | { kind: 'fail_stop'; handle: RuntimeInteractionFailStopHandle };

export class RuntimeExecutionCoordinator {
  private readonly executions = new Set<RunExecution>();
  private state: CoordinatorState = { kind: 'open' };

  constructor(private readonly capability: RuntimeExecutionCapability) {}

  enter(identity: { sessionId: string; turnId: string; runId: string }): RunExecution {
    if (this.state.kind === 'fail_stop') throw this.state.handle.error;
    if (this.state.kind === 'clean_draining') {
      throw new RuntimeInteractionAdmissionRejectedError(identity.runId, 'authority_draining');
    }
    const execution = new RunExecution(identity, this.capability, (error) =>
      this.installFailStop(error),
    );
    this.executions.add(execution);
    observeRejection(
      execution.reclaimDrain.finally(() => {
        this.executions.delete(execution);
      }),
    );
    try {
      execution.initializeInteraction();
    } catch (error) {
      try {
        execution.release();
      } catch {
        // The composition fail-stop installed by initialization/release is canonical.
      }
      throw execution.canonicalError ?? error;
    }
    return execution;
  }

  beginCleanDrain(): {
    executions: readonly RunExecution[];
    reclaimDrain: Promise<RuntimeExecutionSettled>;
  } {
    if (this.state.kind === 'fail_stop') throw this.state.handle.error;
    if (this.state.kind === 'clean_draining') {
      const reclaimDrain = settleWithoutErasingFailure(
        this.state.executions.map((execution) => execution.reclaimDrain),
      ).then(() => RUNTIME_EXECUTION_SETTLED);
      observeRejection(reclaimDrain);
      return {
        executions: this.state.executions,
        reclaimDrain,
      };
    }
    const executions = [...this.executions];
    this.state = { kind: 'clean_draining', executions };
    for (const execution of executions) execution.claimStop(undefined, 'redirect');
    const reclaimDrain = settleWithoutErasingFailure(
      executions.map((execution) => execution.reclaimDrain),
    ).then(() => RUNTIME_EXECUTION_SETTLED);
    observeRejection(reclaimDrain);
    return {
      executions,
      reclaimDrain,
    };
  }

  installFailStop(error: RuntimeInteractionFailStopError): RuntimeInteractionFailStopHandle {
    if (this.state.kind === 'fail_stop') return this.state.handle;
    const admitted = [...this.executions];
    const ownerIsolation = completion<RuntimeCompositionSuccessorEffectsIsolated>();
    const reclaim = completion<RuntimeExecutionSettled>();
    const handle: RuntimeInteractionFailStopHandle = Object.freeze({
      error,
      ownerIsolationDrain: ownerIsolation.promise,
      reclaimDrain: reclaim.promise,
    });
    observeRejection(handle.ownerIsolationDrain);
    observeRejection(handle.reclaimDrain);
    // Publish the fence before invoking a backend or continuation callback.
    this.state = { kind: 'fail_stop', handle };
    const drains = admitted.map((execution) => execution.installFailStop(error));
    void settleWithoutErasingFailure(drains.map((drain) => drain.ownerIsolationDrain)).then(
      () => ownerIsolation.resolve(COMPOSITION_SUCCESSOR_EFFECTS_ISOLATED),
      ownerIsolation.reject,
    );
    void settleWithoutErasingFailure(drains.map((drain) => drain.reclaimDrain)).then(
      () => reclaim.resolve(RUNTIME_EXECUTION_SETTLED),
      reclaim.reject,
    );
    return handle;
  }

  throwIfClosed(): void {
    if (this.state.kind === 'fail_stop') throw this.state.handle.error;
    if (this.state.kind === 'clean_draining') {
      throw new RuntimeInteractionAdmissionRejectedError('runtime', 'authority_draining');
    }
  }
}

function completion<T>(): Completion<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function observeRejection(task: Promise<unknown>): void {
  void task.catch(() => undefined);
}

async function captureFailure(
  operation: () => Promise<unknown>,
  onFailure: (error: unknown) => void,
): Promise<void> {
  try {
    await operation();
  } catch (error) {
    onFailure(error);
  }
}

async function settleWithoutErasingFailure(tasks: readonly Promise<unknown>[]): Promise<void> {
  const outcomes = await Promise.all(
    tasks.map((task) =>
      task.then(
        () => ({ kind: 'fulfilled' as const }),
        (error: unknown) => ({ kind: 'rejected' as const, error }),
      ),
    ),
  );
  const failure = outcomes.find(
    (outcome): outcome is Extract<typeof outcome, { kind: 'rejected' }> =>
      outcome.kind === 'rejected',
  );
  if (failure) throw failure.error;
}
