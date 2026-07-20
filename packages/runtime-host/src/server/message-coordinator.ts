import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { SteeringLease } from '@maka/core/backend-types';
import type { RuntimeEvent } from '@maka/core/runtime-event';
import {
  RuntimeMessageAuthorityInvariantError,
  type RuntimeMessageAuthority,
  type RuntimeMessageRunIdentity,
  type RuntimeMessageRunOwner,
} from '@maka/runtime';
import type {
  RootTurnSourceMessage,
  RootTurnSourceMessageReceipt,
} from '@maka/storage/execution-stores';
import {
  MESSAGE_QUEUE_MAX_ENTRIES,
  type MessagePlacement,
  type QueueRetractInput,
  type QueueRetractResult,
  type QueuedMessageSnapshot,
  type RetractedMessageSnapshot,
  type SessionMessageQueueProjection,
  type SteeringMessageSnapshot,
  type TurnInterruptInput,
  type TurnInterruptResult,
  type TurnMessageSubmitInput,
  type TurnMessageSubmitResult,
  type TurnSnapshot,
} from '../protocol/index.js';
import type { RuntimeHostResidency } from './host-kernel.js';
import type { MessageOperationHandlerMap } from './operation-dispatcher.js';
import { type SessionAdmissionLease, SessionAdmissionGate } from './session-admission-gate.js';

const MAX_FOLLOWUP_TEXT_BYTES = 64 * 1024;

type MessageOperationErrorCode =
  | 'host_draining'
  | 'not_found'
  | 'session_archived'
  | 'session_busy'
  | 'operation_conflict'
  | 'outcome_unknown';

type MessageOutcome<T> =
  | { readonly ok: true; readonly result: T }
  | {
      readonly ok: false;
      readonly error: { readonly code: MessageOperationErrorCode; readonly message: string };
    };

export interface HostMessageSessionHeader {
  readonly isArchived: boolean;
}

export type HostMessageRootState =
  | { readonly kind: 'idle' }
  | ({ readonly kind: 'active' } & RuntimeMessageRunIdentity);

export interface HostMessageStartInput {
  readonly sessionId: string;
  readonly text: string;
  readonly sourceMessage: RootTurnSourceMessage;
}

export interface HostMessageStopClaim {
  readonly deliverStop: () => Promise<void>;
  readonly terminal: Promise<TurnSnapshot>;
}

/** Root execution operations that must share the message coordinator's Session gate. */
export interface HostMessageRootPort {
  readSessionHeader(sessionId: string): Promise<HostMessageSessionHeader | null>;
  readRootState(sessionId: string): Promise<HostMessageRootState> | HostMessageRootState;
  startFromMessage(
    input: HostMessageStartInput,
    admission: SessionAdmissionLease,
  ): Promise<{ readonly turnId: string }>;
  claimStop(
    input: Omit<TurnInterruptInput, 'originHostEpoch' | 'interruptId'>,
    admission: SessionAdmissionLease,
    commitQueueFence: () => QueueFenceResult,
  ): Promise<HostMessageStopClaim>;
}

/** Existing durable facts used only to prove an earlier Host Epoch's submit disposition. */
export interface HostMessageDurableProofReader {
  readRootTurnSourceMessageReceipt(
    sessionId: string,
    messageId: string,
  ): Promise<RootTurnSourceMessageReceipt | undefined>;
  readSessionRuntimeEvents(sessionId: string): Promise<readonly RuntimeEvent[]>;
}

export interface HostMessageCoordinatorOptions {
  readonly hostEpoch: string;
  readonly root: HostMessageRootPort;
  readonly durableProof: HostMessageDurableProofReader;
  readonly sessionAdmission: SessionAdmissionGate;
  readonly acquireResidency: () => RuntimeHostResidency;
  readonly validateProjectionCapacity: (
    sessionId: string,
    projection: SessionMessageQueueProjection,
  ) => Promise<boolean>;
  readonly onProjectionChanged: (
    sessionId: string,
    projection: SessionMessageQueueProjection,
    admission?: SessionAdmissionLease,
  ) => Promise<void> | void;
  readonly createId?: () => string;
}

interface LiveEntry {
  readonly entryId: string;
  readonly messageId: string;
  readonly text: string;
  readonly placement: MessagePlacement;
  readonly disposition: 'steering' | 'followup';
  readonly generation: number;
  readonly residency: RuntimeHostResidency;
  state: 'queued' | 'in_flight' | 'released';
  leaseId?: string;
}

interface BoundRun extends RuntimeMessageRunIdentity {
  readonly generation: number;
  released: boolean;
}

interface SubmitReceipt {
  readonly payload: TurnMessageSubmitInput;
  readonly result: TurnMessageSubmitResult;
}

interface RetractReceipt {
  readonly payload: QueueRetractInput;
  readonly result: QueueRetractResult;
}

interface InterruptReceipt {
  readonly payload: TurnInterruptInput;
  readonly result: Promise<MessageOutcome<TurnInterruptResult>>;
}

interface TerminalTransition {
  readonly transitionId: string;
  readonly identity: RuntimeMessageRunIdentity;
  readonly entries: readonly LiveEntry[];
}

interface SessionState {
  revision: number;
  generation: number;
  phase: 'open' | 'closed' | 'poisoned';
  steering: LiveEntry[];
  inFlight: Map<string, LiveEntry>;
  followup: LiveEntry[];
  reservedRoot?: RuntimeMessageRunIdentity;
  run?: BoundRun;
  transition?: TerminalTransition;
  stopFence?: {
    readonly identity: RuntimeMessageRunIdentity;
    readonly result: QueueFenceResult;
  };
  submitReceipts: Map<string, SubmitReceipt>;
  retractReceipts: Map<string, RetractReceipt>;
  interruptReceipts: Map<string, InterruptReceipt>;
}

export interface RootFollowupSource {
  readonly messageId: string;
  readonly text: string;
  readonly placement: MessagePlacement;
  readonly disposition: 'steering' | 'followup';
}

export interface RootFollowupBatch {
  readonly transitionId: string;
  readonly sessionId: string;
  readonly previousTurnId: string;
  readonly text: string;
  readonly sources: readonly RootFollowupSource[];
}

export interface QueueFenceResult {
  readonly queueRevision: number;
  readonly retracted: readonly RetractedMessageSnapshot[];
}

/** The sole in-memory message authority for one Runtime Host Epoch. */
export class HostMessageCoordinator implements RuntimeMessageAuthority {
  readonly handlers: MessageOperationHandlerMap = {
    'turn.message.submit': (input) => this.submit(input),
    'queue.retract': (input) => this.retract(input),
    'turn.interrupt': (input) => this.interrupt(input),
  };

  readonly #hostEpoch: string;
  readonly #root: HostMessageRootPort;
  readonly #durableProof: HostMessageDurableProofReader;
  readonly #sessionAdmission: SessionAdmissionGate;
  readonly #acquireResidency: () => RuntimeHostResidency;
  readonly #validateProjectionCapacity: HostMessageCoordinatorOptions['validateProjectionCapacity'];
  readonly #onProjectionChanged: HostMessageCoordinatorOptions['onProjectionChanged'];
  readonly #createId: () => string;
  readonly #sessions = new Map<string, SessionState>();
  readonly #projectionDirty = new Set<string>();
  readonly #projectionRunning = new Set<string>();
  readonly #projectionTasks = new Set<Promise<void>>();
  #draining = false;
  #poisoned = false;
  #reclaimed = false;

  constructor(options: HostMessageCoordinatorOptions) {
    this.#hostEpoch = options.hostEpoch;
    this.#root = options.root;
    this.#durableProof = options.durableProof;
    this.#sessionAdmission = options.sessionAdmission;
    this.#acquireResidency = options.acquireResidency;
    this.#validateProjectionCapacity = options.validateProjectionCapacity;
    this.#onProjectionChanged = options.onProjectionChanged;
    this.#createId = options.createId ?? randomUUID;
  }

  projection(sessionId: string): SessionMessageQueueProjection {
    return this.#project(this.#state(sessionId));
  }

  bindRun(identity: RuntimeMessageRunIdentity): RuntimeMessageRunOwner {
    this.#assertHealthy();
    const state = this.#state(identity.sessionId);
    if (state.phase !== 'open') {
      throw new RuntimeMessageAuthorityInvariantError('Message Run bound while admission was closed');
    }
    if (!state.reservedRoot || !sameRun(state.reservedRoot, identity) || state.run) {
      throw new RuntimeMessageAuthorityInvariantError(
        `Message Run ${identity.runId} was not the exact reserved root identity`,
      );
    }
    const run: BoundRun = { ...identity, generation: state.generation, released: false };
    state.run = run;
    return Object.freeze({
      ...identity,
      pull: () => this.#pull(run),
      ack: (leaseIds: readonly string[]) => this.#ack(run, leaseIds),
      nack: (leaseIds: readonly string[]) => this.#nack(run, leaseIds),
      release: () => this.#releaseRun(run),
    });
  }

  reserveRootTurn(identity: RuntimeMessageRunIdentity): void {
    this.#assertHealthy();
    const state = this.#state(identity.sessionId);
    if (state.reservedRoot) {
      if (sameRun(state.reservedRoot, identity)) return;
      throw new RuntimeMessageAuthorityInvariantError('Session already reserved another root Turn');
    }
    if (state.run || state.transition) {
      throw new RuntimeMessageAuthorityInvariantError('Cannot reserve a root Turn during live ownership');
    }
    state.reservedRoot = { ...identity };
    state.phase = 'open';
  }

  abandonRootReservation(identity: RuntimeMessageRunIdentity): void {
    const state = this.#requireState(identity.sessionId);
    if (!state.reservedRoot || !sameRun(state.reservedRoot, identity) || state.run) {
      throw new RuntimeMessageAuthorityInvariantError('Root reservation cannot be abandoned');
    }
    state.reservedRoot = undefined;
    state.stopFence = undefined;
    state.phase = 'closed';
  }

  beginTerminalTransition(
    identity: RuntimeMessageRunIdentity,
    admission?: SessionAdmissionLease,
  ): RootFollowupBatch {
    this.#assertHealthy();
    const state = this.#requireState(identity.sessionId);
    if (!state.reservedRoot || !sameRun(state.reservedRoot, identity) || state.run) {
      throw new RuntimeMessageAuthorityInvariantError(
        'Terminal transition requires a released exact root owner',
      );
    }
    if (state.inFlight.size !== 0 || state.transition) {
      throw new RuntimeMessageAuthorityInvariantError(
        'Terminal transition began before in-flight steering settled',
      );
    }
    if (state.phase !== 'closed') {
      throw new RuntimeMessageAuthorityInvariantError(
        'Terminal transition began before message admission closed',
      );
    }
    if (this.#draining && !state.stopFence) {
      this.#commitQueueFence(identity, admission);
    }
    state.phase = 'closed';
    const entries = [...state.followup];
    assertFollowupBounds(entries);
    const transition: TerminalTransition = {
      transitionId: this.#createId(),
      identity: { ...identity },
      entries,
    };
    state.transition = transition;
    return {
      transitionId: transition.transitionId,
      sessionId: identity.sessionId,
      previousTurnId: identity.turnId,
      text: entries.map((entry) => entry.text).join('\n\n'),
      sources: entries.map(sourceFromEntry),
    };
  }

  commitNextRoot(
    batch: RootFollowupBatch,
    identity: RuntimeMessageRunIdentity,
    admission?: SessionAdmissionLease,
  ): void {
    const state = this.#requireTransition(batch);
    if (identity.sessionId !== batch.sessionId) {
      throw new RuntimeMessageAuthorityInvariantError('Next root identity changed Session');
    }
    this.#commitTransition(state);
    state.generation += 1;
    state.reservedRoot = { ...identity };
    state.phase = 'open';
    this.#mutated(batch.sessionId, state, admission);
  }

  completeIdle(batch: RootFollowupBatch, admission?: SessionAdmissionLease): void {
    const state = this.#requireTransition(batch);
    if (batch.sources.length !== 0) {
      throw new RuntimeMessageAuthorityInvariantError('Cannot become idle with a follow-up batch');
    }
    this.#commitTransition(state);
    state.generation += 1;
    state.reservedRoot = undefined;
    state.phase = 'open';
    this.#mutated(batch.sessionId, state, admission);
  }

  beginDrain(): void {
    this.#draining = true;
  }

  commitStopFence(
    identity: RuntimeMessageRunIdentity,
    admission?: SessionAdmissionLease,
  ): QueueFenceResult {
    this.#assertHealthy();
    return this.#commitQueueFence(identity, admission);
  }

  prepareFailStopReclaim(): () => void {
    if (!this.#poisoned) {
      this.#poisoned = true;
      this.#draining = true;
      for (const state of this.#sessions.values()) state.phase = 'poisoned';
    }
    return () => this.#reclaimAfterOwnerIsolation();
  }

  #reclaimAfterOwnerIsolation(): void {
    if (this.#reclaimed) return;
    this.#reclaimed = true;
    for (const state of this.#sessions.values()) {
      for (const entry of allLiveEntries(state)) {
        try {
          this.#releaseEntry(entry);
        } catch {
          // Root ownership is already isolated; reclaim must continue through every residency.
        }
      }
      state.steering = [];
      state.inFlight.clear();
      state.followup = [];
      if (state.run) state.run.released = true;
      state.run = undefined;
      state.reservedRoot = undefined;
      state.transition = undefined;
      state.stopFence = undefined;
    }
  }

  async close(): Promise<void> {
    this.beginDrain();
    await Promise.all([...this.#projectionTasks]);
    for (const state of this.#sessions.values()) {
      if (
        state.run ||
        state.reservedRoot ||
        state.transition ||
        allLiveEntries(state).length !== 0
      ) {
        throw new RuntimeMessageAuthorityInvariantError(
          'Message coordinator closed with a live owner, entry, or transition',
        );
      }
    }
    if (this.#projectionTasks.size !== 0 || this.#projectionDirty.size !== 0) {
      throw new RuntimeMessageAuthorityInvariantError(
        'Message coordinator closed with a pending projection refresh',
      );
    }
  }

  private submit(
    input: TurnMessageSubmitInput,
  ): Promise<MessageOutcome<TurnMessageSubmitResult>> {
    return this.#sessionAdmission.run(input.sessionId, async (lease) => {
      if (input.originHostEpoch !== this.#hostEpoch) return this.#proveOldSubmit(input);
      this.#assertHealthy();
      const state = this.#state(input.sessionId);
      const receipt = state.submitReceipts.get(input.messageId);
      if (receipt) {
        return samePayload(receipt.payload, input)
          ? success(receipt.result)
          : failure('operation_conflict', 'Message identity has a different payload');
      }
      const header = await this.#root.readSessionHeader(input.sessionId);
      if (!header) return failure('not_found', 'Session does not exist');
      if (header.isArchived) return failure('session_archived', 'Session is archived');
      const rootState = await this.#root.readRootState(input.sessionId);
      if (rootState.kind === 'idle') {
        if (
          state.reservedRoot ||
          state.run ||
          state.transition ||
          allLiveEntries(state).length !== 0
        ) {
          throw new RuntimeMessageAuthorityInvariantError(
            'Root reported idle while the message authority retained live state',
          );
        }
        const sourceMessage: RootTurnSourceMessage = {
          messageId: input.messageId,
          text: input.text,
          placement: input.placement,
          disposition: 'turn_started',
        };
        const started = await this.#root.startFromMessage(
          { sessionId: input.sessionId, text: input.text, sourceMessage },
          lease,
        );
        const result = { disposition: 'turn_started', turnId: started.turnId } as const;
        state.submitReceipts.set(input.messageId, { payload: input, result });
        return success(result);
      }
      if (state.phase !== 'open') {
        return failure('session_busy', 'Message admission is closed for the active generation');
      }
      if (!state.reservedRoot || !sameRun(state.reservedRoot, rootState)) {
        throw new RuntimeMessageAuthorityInvariantError('Root state does not match message reservation');
      }
      if (allLiveEntries(state).length >= MESSAGE_QUEUE_MAX_ENTRIES) {
        return failure('session_busy', 'Message queue capacity is full');
      }
      const disposition = input.placement === 'current_turn' ? 'steering' : 'followup';
      const candidateRevision = state.revision;
      const candidateGeneration = state.generation;
      const entryId = this.#createId();
      const candidateEntry: QueuedMessageSnapshot = {
        entryId,
        messageId: input.messageId,
        text: input.text,
        placement: input.placement,
        state: 'queued',
      };
      const current = this.#project(state);
      const candidate: SessionMessageQueueProjection = {
        ...current,
        queueRevision: state.revision + 1,
        steering:
          disposition === 'steering'
            ? [
                ...[...state.inFlight.values()].map(inFlightSnapshot),
                ...state.steering.map(queuedSteeringSnapshot),
                { ...candidateEntry, placement: 'current_turn' },
              ]
            : current.steering,
        followup:
          disposition === 'followup'
            ? [...current.followup, candidateEntry]
            : current.followup,
      };
      if (!(await this.#validateProjectionCapacity(input.sessionId, candidate))) {
        return failure('session_busy', 'Message queue projection capacity is full');
      }
      if (
        state.phase !== 'open' ||
        state.revision !== candidateRevision ||
        state.generation !== candidateGeneration ||
        !state.reservedRoot ||
        !sameRun(state.reservedRoot, rootState)
      ) {
        return failure('session_busy', 'Message queue changed during admission');
      }
      const entry: LiveEntry = {
        entryId,
        messageId: input.messageId,
        text: input.text,
        placement: input.placement,
        disposition,
        generation: state.generation,
        residency: this.#acquireResidency(),
        state: 'queued',
      };
      if (disposition === 'steering') state.steering.push(entry);
      else state.followup.push(entry);
      state.revision += 1;
      const result = { disposition, queueRevision: state.revision } as const;
      state.submitReceipts.set(input.messageId, { payload: input, result });
      this.#notifyProjection(input.sessionId, lease);
      return success(result);
    });
  }

  private retract(input: QueueRetractInput): Promise<MessageOutcome<QueueRetractResult>> {
    return this.#sessionAdmission.run(input.sessionId, async (lease) => {
      if (input.originHostEpoch !== this.#hostEpoch) {
        return failure('outcome_unknown', 'Retract outcome is not durable across Host Epochs');
      }
      this.#assertHealthy();
      const state = this.#state(input.sessionId);
      const receipt = state.retractReceipts.get(input.retractId);
      if (receipt) {
        return samePayload(receipt.payload, input)
          ? success(receipt.result)
          : failure('operation_conflict', 'Retract identity has a different payload');
      }
      const header = await this.#root.readSessionHeader(input.sessionId);
      if (!header) return failure('not_found', 'Session does not exist');
      if (header.isArchived) return failure('session_archived', 'Session is archived');
      const retracted = this.#retractQueued(state);
      if (retracted.length > 0) this.#mutated(input.sessionId, state, lease);
      const result = { queueRevision: state.revision, retracted };
      state.retractReceipts.set(input.retractId, { payload: input, result });
      return success(result);
    });
  }

  private interrupt(input: TurnInterruptInput): Promise<MessageOutcome<TurnInterruptResult>> {
    if (input.originHostEpoch !== this.#hostEpoch) {
      return Promise.resolve(
        failure('outcome_unknown', 'Interrupt outcome is not durable across Host Epochs'),
      );
    }
    const state = this.#state(input.sessionId);
    const prior = state.interruptReceipts.get(input.interruptId);
    if (prior) {
      return samePayload(prior.payload, input)
        ? prior.result
        : Promise.resolve(failure('operation_conflict', 'Interrupt identity has a different payload'));
    }
    const task = this.#interruptOnce(input);
    state.interruptReceipts.set(input.interruptId, { payload: input, result: task });
    return task;
  }

  async #interruptOnce(input: TurnInterruptInput): Promise<MessageOutcome<TurnInterruptResult>> {
    const claimed = await this.#sessionAdmission.run(input.sessionId, async (lease) => {
      this.#assertHealthy();
      const header = await this.#root.readSessionHeader(input.sessionId);
      if (!header) return failure('not_found', 'Session does not exist');
      if (header.isArchived) return failure('session_archived', 'Session is archived');
      const rootState = await this.#root.readRootState(input.sessionId);
      if (
        rootState.kind !== 'active' ||
        rootState.sessionId !== input.sessionId ||
        rootState.turnId !== input.turnId ||
        rootState.runId !== input.runId
      ) {
        return failure('operation_conflict', 'Interrupt does not match the active root Turn');
      }
      let fence: QueueFenceResult | undefined;
      const claim = await this.#root.claimStop(
        { sessionId: input.sessionId, turnId: input.turnId, runId: input.runId },
        lease,
        () => {
          if (fence) return fence;
          fence = this.#commitQueueFence(rootState, lease);
          return fence;
        },
      );
      if (!fence) {
        throw new RuntimeMessageAuthorityInvariantError('Root stop claim omitted queue fence commit');
      }
      return { ok: true as const, claim, fence };
    });
    if (!claimed.ok) return claimed;
    await claimed.claim.deliverStop();
    const turn = await claimed.claim.terminal;
    return success({ ...claimed.fence, turn });
  }

  async #proveOldSubmit(
    input: TurnMessageSubmitInput,
  ): Promise<MessageOutcome<TurnMessageSubmitResult>> {
    const receipt = await this.#durableProof.readRootTurnSourceMessageReceipt(
      input.sessionId,
      input.messageId,
    );
    if (receipt) {
      const source = receipt.sourceMessage;
      if (!sameSourcePayload(source, input)) {
        return failure('operation_conflict', 'Durable message receipt has a different payload');
      }
      if (source.disposition === 'turn_started') {
        return success({ disposition: 'turn_started', turnId: receipt.admission.turnId });
      }
      return success({
        disposition: source.disposition,
        queueRevision: this.#state(input.sessionId).revision,
      });
    }
    const events = await this.#durableProof.readSessionRuntimeEvents(input.sessionId);
    const matching = events.filter(
      (event) =>
        event.refs?.providerEventId === input.messageId &&
        event.content?.kind === 'text' &&
        event.content.steering === true,
    );
    if (matching.length > 1) {
      throw new RuntimeMessageAuthorityInvariantError('Durable steering identity is ambiguous');
    }
    const event = matching[0];
    if (event) {
      if (
        input.placement !== 'current_turn' ||
        event.content?.kind !== 'text' ||
        event.content.text !== input.text
      ) {
        return failure('operation_conflict', 'Durable steering fact has a different payload');
      }
      return success({
        disposition: 'steering',
        queueRevision: this.#state(input.sessionId).revision,
      });
    }
    return failure('outcome_unknown', 'Message disposition cannot be proven in this Host Epoch');
  }

  #pull(run: BoundRun): readonly SteeringLease[] {
    this.#assertRun(run);
    const state = this.#requireState(run.sessionId);
    if (state.phase !== 'open' || run.generation !== state.generation) return [];
    const entries = state.steering.splice(0);
    if (entries.length === 0) return [];
    const leases = entries.map((entry): SteeringLease => {
      const leaseId = this.#createId();
      entry.state = 'in_flight';
      entry.leaseId = leaseId;
      state.inFlight.set(leaseId, entry);
      return { id: leaseId, messageId: entry.messageId, text: entry.text };
    });
    this.#mutated(run.sessionId, state);
    return leases;
  }

  #ack(run: BoundRun, leaseIds: readonly string[]): void {
    this.#assertRun(run);
    const state = this.#requireState(run.sessionId);
    let changed = false;
    for (const leaseId of uniqueLeaseIds(leaseIds)) {
      const entry = state.inFlight.get(leaseId);
      if (!entry) continue;
      state.inFlight.delete(leaseId);
      this.#releaseEntry(entry);
      changed = true;
    }
    if (changed) this.#mutated(run.sessionId, state);
  }

  #nack(run: BoundRun, leaseIds: readonly string[]): void {
    this.#assertRun(run);
    const state = this.#requireState(run.sessionId);
    const returned: LiveEntry[] = [];
    let changed = false;
    for (const leaseId of uniqueLeaseIds(leaseIds)) {
      const entry = state.inFlight.get(leaseId);
      if (!entry) continue;
      state.inFlight.delete(leaseId);
      entry.leaseId = undefined;
      if (
        state.phase === 'open' &&
        run.generation === state.generation &&
        entry.generation === state.generation
      ) {
        entry.state = 'queued';
        returned.push(entry);
      } else {
        this.#releaseEntry(entry);
      }
      changed = true;
    }
    if (returned.length > 0) state.steering.unshift(...returned);
    if (changed) this.#mutated(run.sessionId, state);
  }

  #releaseRun(run: BoundRun): void {
    if (this.#poisoned) {
      const state = this.#requireState(run.sessionId);
      if (run.released || state.run !== run) return;
      run.released = true;
      state.run = undefined;
      return;
    }
    this.#assertRun(run);
    const state = this.#requireState(run.sessionId);
    if (state.inFlight.size !== 0) {
      throw new RuntimeMessageAuthorityInvariantError('Message Run released with in-flight steering');
    }
    state.phase = 'closed';
    const folded = state.steering.splice(0);
    for (const entry of folded) {
      entry.state = 'queued';
    }
    if (folded.length > 0) state.followup.unshift(...folded);
    run.released = true;
    state.run = undefined;
    if (folded.length > 0) this.#mutated(run.sessionId, state);
  }

  #commitQueueFence(
    identity: RuntimeMessageRunIdentity,
    admission?: SessionAdmissionLease,
  ): QueueFenceResult {
    const state = this.#requireState(identity.sessionId);
    const existing = state.stopFence;
    if (existing) {
      if (!sameRun(existing.identity, identity)) {
        throw new RuntimeMessageAuthorityInvariantError('Stop fence belongs to another root Turn');
      }
      return existing.result;
    }
    if (!state.reservedRoot || !sameRun(state.reservedRoot, identity)) {
      throw new RuntimeMessageAuthorityInvariantError('Stop fence does not match the reserved root Turn');
    }
    state.phase = 'closed';
    const retracted = this.#retractQueued(state);
    state.generation += 1;
    this.#mutated(identity.sessionId, state, admission);
    const result = { queueRevision: state.revision, retracted };
    state.stopFence = { identity: { ...identity }, result };
    return result;
  }

  #retractQueued(state: SessionState): RetractedMessageSnapshot[] {
    const entries = [...state.steering, ...state.followup];
    state.steering = [];
    state.followup = [];
    for (const entry of entries) this.#releaseEntry(entry);
    return entries.map(retractedSnapshot);
  }

  #commitTransition(state: SessionState): void {
    const transition = state.transition;
    if (!transition) throw new RuntimeMessageAuthorityInvariantError('Missing terminal transition');
    for (const entry of transition.entries) this.#releaseEntry(entry);
    state.followup = [];
    state.transition = undefined;
    state.reservedRoot = undefined;
    state.stopFence = undefined;
  }

  #requireTransition(batch: RootFollowupBatch): SessionState {
    this.#assertHealthy();
    const state = this.#requireState(batch.sessionId);
    const transition = state.transition;
    if (
      !transition ||
      transition.transitionId !== batch.transitionId ||
      transition.identity.turnId !== batch.previousTurnId ||
      !isDeepStrictEqual(transition.entries.map(sourceFromEntry), batch.sources) ||
      transition.entries.map((entry) => entry.text).join('\n\n') !== batch.text
    ) {
      throw new RuntimeMessageAuthorityInvariantError('Follow-up batch does not own the transition');
    }
    return state;
  }

  #assertRun(run: BoundRun): void {
    this.#assertHealthy();
    const state = this.#requireState(run.sessionId);
    if (run.released || state.run !== run) {
      throw new RuntimeMessageAuthorityInvariantError(`Message Run ${run.runId} is not live`);
    }
  }

  #assertHealthy(): void {
    if (this.#poisoned) throw new RuntimeMessageAuthorityInvariantError('Message coordinator is poisoned');
  }

  #state(sessionId: string): SessionState {
    let state = this.#sessions.get(sessionId);
    if (!state) {
      state = {
        revision: 0,
        generation: 0,
        phase: 'open',
        steering: [],
        inFlight: new Map(),
        followup: [],
        submitReceipts: new Map(),
        retractReceipts: new Map(),
        interruptReceipts: new Map(),
      };
      this.#sessions.set(sessionId, state);
    }
    return state;
  }

  #requireState(sessionId: string): SessionState {
    const state = this.#sessions.get(sessionId);
    if (!state) throw new RuntimeMessageAuthorityInvariantError(`Unknown message Session ${sessionId}`);
    return state;
  }

  #mutated(
    sessionId: string,
    state: SessionState,
    admission?: SessionAdmissionLease,
  ): void {
    state.revision += 1;
    this.#notifyProjection(sessionId, admission);
  }

  #project(
    state: SessionState,
    steering: readonly LiveEntry[] = state.steering,
    followup: readonly LiveEntry[] = state.followup,
  ): SessionMessageQueueProjection {
    return {
      hostEpoch: this.#hostEpoch,
      queueRevision: state.revision,
      steering: [
        ...[...state.inFlight.values()].map(inFlightSnapshot),
        ...steering.map(queuedSteeringSnapshot),
      ],
      followup: followup.map(queuedSnapshot),
    };
  }

  #notifyProjection(sessionId: string, admission?: SessionAdmissionLease): void {
    if (admission) {
      let task: Promise<void>;
      try {
        task = Promise.resolve(
          this.#onProjectionChanged(sessionId, this.projection(sessionId), admission),
        );
      } catch (error) {
        task = Promise.reject(error);
      }
      this.#projectionTasks.add(task);
      const settle = () => this.#projectionTasks.delete(task);
      void task.then(settle, settle);
      return;
    }
    this.#projectionDirty.add(sessionId);
    if (this.#projectionRunning.has(sessionId)) return;
    this.#projectionRunning.add(sessionId);
    const task = Promise.resolve().then(async () => {
      while (this.#projectionDirty.delete(sessionId)) {
        await this.#onProjectionChanged(sessionId, this.projection(sessionId));
      }
    });
    this.#projectionTasks.add(task);
    const settle = () => {
      this.#projectionTasks.delete(task);
      this.#projectionRunning.delete(sessionId);
      if (this.#projectionDirty.has(sessionId)) this.#notifyProjection(sessionId);
    };
    void task.then(settle, settle);
  }

  #releaseEntry(entry: LiveEntry): void {
    if (entry.state === 'released') return;
    entry.state = 'released';
    entry.leaseId = undefined;
    entry.residency.release();
  }
}

function success<T>(result: T): MessageOutcome<T> {
  return { ok: true, result };
}

function failure(
  code: MessageOperationErrorCode,
  message: string,
): {
  readonly ok: false;
  readonly error: { readonly code: MessageOperationErrorCode; readonly message: string };
} {
  return { ok: false, error: { code, message } };
}

function samePayload(left: object, right: object): boolean {
  return isDeepStrictEqual(left, right);
}

function sameRun(left: RuntimeMessageRunIdentity, right: RuntimeMessageRunIdentity): boolean {
  return (
    left.sessionId === right.sessionId && left.turnId === right.turnId && left.runId === right.runId
  );
}

function sameSourcePayload(source: RootTurnSourceMessage, input: TurnMessageSubmitInput): boolean {
  return (
    source.messageId === input.messageId &&
    source.text === input.text &&
    source.placement === input.placement
  );
}

function sourceFromEntry(entry: LiveEntry): RootFollowupSource {
  return {
    messageId: entry.messageId,
    text: entry.text,
    placement: entry.placement,
    disposition: entry.disposition,
  };
}

function queuedSnapshot(entry: LiveEntry): QueuedMessageSnapshot {
  return {
    entryId: entry.entryId,
    messageId: entry.messageId,
    text: entry.text,
    placement: entry.placement,
    state: 'queued',
  };
}

function queuedSteeringSnapshot(entry: LiveEntry): SteeringMessageSnapshot {
  if (entry.placement !== 'current_turn') {
    throw new RuntimeMessageAuthorityInvariantError('Steering entry lost current-turn placement');
  }
  return { ...queuedSnapshot(entry), placement: 'current_turn' };
}

function inFlightSnapshot(entry: LiveEntry): SteeringMessageSnapshot {
  if (entry.placement !== 'current_turn') {
    throw new RuntimeMessageAuthorityInvariantError('In-flight entry lost current-turn placement');
  }
  return {
    entryId: entry.entryId,
    messageId: entry.messageId,
    text: entry.text,
    placement: 'current_turn',
    state: 'in_flight',
  };
}

function retractedSnapshot(entry: LiveEntry): RetractedMessageSnapshot {
  return { ...queuedSnapshot(entry), state: 'retracted' };
}

function uniqueLeaseIds(leaseIds: readonly string[]): readonly string[] {
  return [...new Set(leaseIds)];
}

function allLiveEntries(state: SessionState): LiveEntry[] {
  return [...new Set([...state.steering, ...state.inFlight.values(), ...state.followup])].filter(
    (entry) => entry.state !== 'released',
  );
}

function assertFollowupBounds(entries: readonly LiveEntry[]): void {
  if (entries.length > MESSAGE_QUEUE_MAX_ENTRIES) {
    throw new RuntimeMessageAuthorityInvariantError('Follow-up batch exceeds source capacity');
  }
  const bytes = Buffer.byteLength(entries.map((entry) => entry.text).join('\n\n'), 'utf8');
  if (bytes > MAX_FOLLOWUP_TEXT_BYTES) {
    throw new RuntimeMessageAuthorityInvariantError('Follow-up batch exceeds UTF-8 capacity');
  }
}
