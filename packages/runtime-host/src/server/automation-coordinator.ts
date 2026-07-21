import type { AgentRunHeader } from '@maka/core/agent-run';
import {
  AutomationDomainDecodeError,
  decodeAutomationDefinition,
  type AutomationDefinition,
  type AutomationDefinitionConfig,
  type AutomationFire,
  type AutomationFireTerminalOutcome,
  type AutomationSchedule as CanonicalAutomationSchedule,
} from '@maka/core/automation';
import type { SessionHeader } from '@maka/core/session';
import {
  computeNextCronFire,
  type AutomationSchedule as ToolAutomationSchedule,
  type AutomationToolByIdRequest,
  type AutomationToolCreateRequest,
  type AutomationToolCreateResult,
  type AutomationToolDeleteResult,
  type AutomationToolListRequest,
  type AutomationToolPauseResult,
  type AutomationToolProjection,
  type AutomationToolResumeResult,
  type AutomationToolService,
} from '@maka/runtime';
import type {
  AutomationCatalogSnapshot,
  AutomationDefinitionMutationPrepareRequest,
  AutomationDefinitionMutationResult,
  AutomationStoreWriter,
} from '@maka/storage';
import type { ExecutionStoresWriter } from '@maka/storage/execution-stores';
import {
  AUTOMATION_FIRE_FAILURE_MAX_BYTES,
  AUTOMATION_PAGE_MAX_BYTES,
  AUTOMATION_PAGE_MAX_ITEMS,
  encodeAutomationMutateResult,
  encodeAutomationQueryResult,
  type AutomationDefinitionInput,
  type AutomationExecutionTarget,
  type AutomationMutateInput,
  type AutomationMutateResult,
  type AutomationProjection,
  type AutomationQueryInput,
  type AutomationQueryResult,
  type AutomationSchedule,
  type OperationOutcome,
  type TurnSnapshot,
} from '../protocol/index.js';
import type {
  AutomationOperationHandlerMap,
  OperationResidency,
} from './operation-dispatcher.js';
import { RootTurnCoordinator } from './root-turn-coordinator.js';
import { SessionAdmissionGate } from './session-admission-gate.js';

const DEFAULT_TOOL_EXPIRY_MS = 7 * 24 * 60 * 60 * 1000;
const DUE_RETRY_MS = 5_000;
const MAX_TIMER_DELAY_MS = 2_147_483_647;

interface ActiveFire {
  readonly residency: OperationResidency;
  task: Promise<void>;
  released: boolean;
}

export interface HostAutomationCoordinatorOptions {
  readonly store: AutomationStoreWriter;
  readonly executionStores: ExecutionStoresWriter<'interactive'>;
  readonly root: RootTurnCoordinator;
  readonly sessionAdmission: SessionAdmissionGate;
  readonly acquireResidency: () => OperationResidency;
  readonly requestDrain: () => void;
  readonly newId: () => string;
  readonly now: () => number;
}

/** Canonical Automation owner for Hosted mode. */
export class HostAutomationCoordinator implements AutomationToolService {
  readonly handlers: AutomationOperationHandlerMap = {
    'automation.query': (input) => this.#query(input),
    'automation.mutate': (input) => this.#mutate(input),
  };

  readonly #store: AutomationStoreWriter;
  readonly #executionStores: ExecutionStoresWriter<'interactive'>;
  readonly #root: RootTurnCoordinator;
  readonly #sessionAdmission: SessionAdmissionGate;
  readonly #acquireResidency: () => OperationResidency;
  readonly #requestDrain: () => void;
  readonly #newId: () => string;
  readonly #now: () => number;
  readonly #activeFires = new Map<string, ActiveFire>();
  #timer: ReturnType<typeof setTimeout> | undefined;
  #timerResidency: OperationResidency | undefined;
  #schedulerTask: Promise<void> | undefined;
  #schedulerStarted = false;
  #draining = false;
  #closed = false;
  #failStop = false;
  #failStopReclaimer: (() => void) | undefined;

  constructor(options: HostAutomationCoordinatorOptions) {
    this.#store = options.store;
    this.#executionStores = options.executionStores;
    this.#root = options.root;
    this.#sessionAdmission = options.sessionAdmission;
    this.#acquireResidency = options.acquireResidency;
    this.#requestDrain = options.requestDrain;
    this.#newId = options.newId;
    this.#now = options.now;
  }

  async recover(): Promise<void> {
    this.#assertOpen();
    for (const fire of await this.#store.listNonTerminalFires()) {
      await this.#resumeFire(fire);
    }
  }

  async startScheduler(): Promise<void> {
    this.#assertOpen();
    if (this.#schedulerStarted) return;
    this.#schedulerStarted = true;
    this.#applyTimer(await this.#store.readCatalogSnapshot());
  }

  beginDrain(): void {
    if (this.#draining) return;
    this.#draining = true;
    this.#stopTimer();
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.beginDrain();
    const errors: unknown[] = [];
    await this.#schedulerTask?.catch((error: unknown) => errors.push(error));
    while (this.#activeFires.size > 0) {
      const tasks = [...this.#activeFires.values()].map((active) => active.task);
      const outcomes = await Promise.allSettled(tasks);
      for (const outcome of outcomes) {
        if (outcome.status === 'rejected') errors.push(outcome.reason);
      }
    }
    await this.#store.beginDrain().catch((error: unknown) => errors.push(error));
    await this.#store.close().catch((error: unknown) => errors.push(error));
    this.#closed = true;
    if (errors.length === 1) throw errors[0];
    if (errors.length > 1) {
      throw new AggregateError(errors, 'Automation coordinator did not close cleanly');
    }
  }

  prepareFailStopReclaim(): () => void {
    if (this.#failStopReclaimer) return this.#failStopReclaimer;
    this.#failStop = true;
    this.#draining = true;
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = undefined;
    const timerResidency = this.#timerResidency;
    this.#timerResidency = undefined;
    let reclaimed = false;
    this.#failStopReclaimer = () => {
      if (reclaimed) return;
      reclaimed = true;
      timerResidency?.release();
      for (const fire of this.#activeFires.values()) {
        if (fire.released) continue;
        fire.released = true;
        fire.residency.release();
      }
      this.#activeFires.clear();
    };
    return this.#failStopReclaimer;
  }

  async create(request: AutomationToolCreateRequest): Promise<AutomationToolCreateResult> {
    if (this.#draining) return { outcome: 'rejected', error: 'Runtime Host is draining.' };
    try {
      const now = this.#now();
      const definition = await this.#toolDefinition(request, now);
      const nextFireAt = nextFireAtFor(definition.schedule, now, definition.expiresAt);
      if (nextFireAt === null) {
        return { outcome: 'rejected', error: 'The schedule has no fire before expiry.' };
      }
      const automationId = this.#newId();
      validateProspectiveDefinition({
        automationId,
        ...definition,
        status: 'enabled',
        revision: 1,
        createdAt: now,
        updatedAt: now,
        nextFireAt,
        fireCount: 0,
      });
      const result = await this.#store.createDefinition({
        automationId,
        ...definition,
        createdAt: now,
        nextFireAt,
        enabled: true,
      });
      if (result.status === 'conflict') {
        return { outcome: 'rejected', error: 'Automation could not be created.' };
      }
      if (result.status !== 'committed') {
        return { outcome: 'rejected', error: 'Automation could not be created.' };
      }
      const snapshot = await this.#afterMutation();
      const fires = indexFires(snapshot);
      return {
        outcome: 'created',
        automation: toolProjection(
          result.definition,
          firesFor(fires, result.definition),
          this.#now(),
        ),
      };
    } catch (error) {
      if (error instanceof AutomationRequestError) {
        return { outcome: 'rejected', error: error.message };
      }
      this.#enterDrain();
      throw error;
    }
  }

  async delete(request: AutomationToolByIdRequest): Promise<AutomationToolDeleteResult> {
    if (this.#draining) return { outcome: 'not_found_or_not_owned' };
    try {
      const current = await this.#ownedDefinition(request.id, request.requester.sessionId);
      if (!current) return { outcome: 'not_found_or_not_owned' };
      const result = await this.#store.deleteDefinition({
        automationId: current.automationId,
        expectedRevision: current.revision,
        deletedAt: monotonicNow(this.#now(), current.updatedAt),
      });
      if (result.status !== 'deleted') return { outcome: 'not_found_or_not_owned' };
      await this.#afterMutation();
      return { outcome: 'deleted' };
    } catch (error) {
      this.#enterDrain();
      throw error;
    }
  }

  async list(request: AutomationToolListRequest): Promise<readonly AutomationToolProjection[]> {
    if (this.#draining) return [];
    try {
      const snapshot = await this.#store.readCatalogSnapshot();
      const fires = indexFires(snapshot);
      return snapshot.definitions
        .filter((definition) => isOwnedBy(definition, request.requester.sessionId))
        .map((definition) =>
          toolProjection(definition, firesFor(fires, definition), this.#now()),
        );
    } catch (error) {
      this.#enterDrain();
      throw error;
    }
  }

  async pause(request: AutomationToolByIdRequest): Promise<AutomationToolPauseResult> {
    if (this.#draining) return { outcome: 'not_found_or_invalid' };
    try {
      const current = await this.#ownedDefinition(request.id, request.requester.sessionId);
      if (!current || current.status !== 'enabled') {
        return { outcome: 'not_found_or_invalid' };
      }
      const result = await this.#store.setEnabled({
        automationId: current.automationId,
        expectedRevision: current.revision,
        enabled: false,
        updatedAt: monotonicNow(this.#now(), current.updatedAt),
        nextFireAt: null,
      });
      if (result.status !== 'committed') return { outcome: 'not_found_or_invalid' };
      const snapshot = await this.#afterMutation();
      const fires = indexFires(snapshot);
      return {
        outcome: 'paused',
        automation: toolProjection(
          result.definition,
          firesFor(fires, result.definition),
          this.#now(),
        ),
      };
    } catch (error) {
      this.#enterDrain();
      throw error;
    }
  }

  async resume(request: AutomationToolByIdRequest): Promise<AutomationToolResumeResult> {
    if (this.#draining) return { outcome: 'not_found_or_invalid' };
    try {
      const current = await this.#ownedDefinition(request.id, request.requester.sessionId);
      if (!current) return { outcome: 'not_found_or_invalid' };
      if (
        current.status === 'exhausted' ||
        (current.maxFireCount !== null && current.fireCount >= current.maxFireCount)
      ) {
        const snapshot = await this.#store.readCatalogSnapshot();
        const fires = indexFires(snapshot);
        return {
          outcome: 'fire_budget_exhausted',
          automation: toolProjection(current, firesFor(fires, current), this.#now()),
        };
      }
      if (current.status !== 'disabled') return { outcome: 'not_found_or_invalid' };
      const now = monotonicNow(this.#now(), current.updatedAt);
      const nextFireAt = nextFireAtFor(current.schedule, now, current.expiresAt);
      if (nextFireAt === null) return { outcome: 'not_found_or_invalid' };
      const result = await this.#store.setEnabled({
        automationId: current.automationId,
        expectedRevision: current.revision,
        enabled: true,
        updatedAt: now,
        nextFireAt,
      });
      if (result.status !== 'committed') return { outcome: 'not_found_or_invalid' };
      const snapshot = await this.#afterMutation();
      const fires = indexFires(snapshot);
      return {
        outcome: 'resumed',
        automation: toolProjection(
          result.definition,
          firesFor(fires, result.definition),
          this.#now(),
        ),
      };
    } catch (error) {
      this.#enterDrain();
      throw error;
    }
  }

  async #query(input: AutomationQueryInput): Promise<OperationOutcome<'automation.query'>> {
    if (this.#draining) return failure('host_draining', 'Runtime Host is draining');
    try {
      const snapshot = await this.#store.readCatalogSnapshot();
      if (input.kind === 'get') {
        const definition = snapshot.definitions.find(
          (item) => item.automationId === input.automationId,
        );
        if (!definition) return failure('not_found', 'Automation was not found');
        const fires = indexFires(snapshot);
        return success(
          encodeAutomationQueryResult({
            kind: 'item',
            catalogRevision: snapshot.catalogRevision,
            automation: await this.#projection(definition, firesFor(fires, definition)),
          }),
        );
      }
      if (input.revision !== null && input.revision !== snapshot.catalogRevision) {
        return success({
          kind: 'revision_changed',
          expected: input.revision,
          actual: snapshot.catalogRevision,
        });
      }
      const offset = input.cursor === null ? 0 : decodeCursor(input.cursor);
      if (
        offset === undefined ||
        offset > snapshot.definitions.length ||
        (input.cursor !== null && offset === snapshot.definitions.length)
      ) {
        return failure('invalid_request', 'Automation list cursor is invalid');
      }
      const candidateLimit = Math.min(input.limit, AUTOMATION_PAGE_MAX_ITEMS);
      const candidates = snapshot.definitions.slice(offset, offset + candidateLimit);
      const fires = indexFires(snapshot);
      const projections = await Promise.all(
        candidates.map((definition) => this.#projection(definition, firesFor(fires, definition))),
      );
      return success(
        createPage(snapshot.catalogRevision, projections, offset, snapshot.definitions.length),
      );
    } catch {
      return failure('persistence_failed', 'Automation projection is unavailable');
    }
  }

  async #mutate(input: AutomationMutateInput): Promise<OperationOutcome<'automation.mutate'>> {
    if (this.#draining) return failure('host_draining', 'Runtime Host is draining');
    let result: AutomationDefinitionMutationResult;
    try {
      result = await this.#applyMutation(input);
    } catch (error) {
      if (error instanceof AutomationRequestError || error instanceof AutomationDomainDecodeError) {
        return failure('invalid_request', error.message);
      }
      this.#enterDrain();
      return failure(
        'commit_outcome_unknown',
        'Automation mutation outcome could not be determined',
      );
    }
    if (result.status === 'conflict') {
      return result.code === 'automation_not_found'
        ? failure('not_found', 'Automation was not found')
        : failure('operation_conflict', `Automation mutation conflicted: ${result.code}`);
    }
    try {
      const snapshot = await this.#afterMutation();
      const fires = indexFires(snapshot);
      const mutation = input.mutation;
      if (result.status === 'deleted') {
        return success(
          encodeAutomationMutateResult({
            kind: 'deleted',
            catalogRevision: snapshot.catalogRevision,
            automationId: mutation.automationId,
          }),
        );
      }
      const definition = snapshot.definitions.find(
        (item) => item.automationId === mutation.automationId,
      );
      if (!definition) throw new Error('Committed Automation definition is unavailable');
      return success(
        encodeAutomationMutateResult({
          kind: result.replayed ? 'unchanged' : 'committed',
          catalogRevision: snapshot.catalogRevision,
          automation: await this.#projection(
            definition,
            firesFor(fires, definition),
          ),
        }),
      );
    } catch {
      this.#enterDrain();
      return failure(
        'commit_outcome_unknown',
        'Automation mutation committed but its projection is unavailable',
      );
    }
  }

  async #applyMutation(input: AutomationMutateInput): Promise<AutomationDefinitionMutationResult> {
    const mutation = input.mutation;
    const prepareRequest: AutomationDefinitionMutationPrepareRequest =
      mutation.kind === 'create'
        ? {
            kind: 'create',
            automationId: mutation.automationId,
            config: canonicalDefinitionUnchecked(mutation.definition),
            enabled: true,
          }
        : mutation.kind === 'update'
          ? {
              kind: 'update',
              automationId: mutation.automationId,
              expectedRevision: mutation.expectedRevision,
              config: canonicalDefinitionUnchecked(mutation.definition),
            }
          : mutation;
    const prepared = await this.#store.prepareDefinitionMutation(prepareRequest);
    if (prepared.status === 'replay') return prepared.result;
    if (prepared.status === 'conflict') {
      return {
        status: 'conflict',
        code: prepared.code,
        ...(prepared.current ? { current: prepared.current } : {}),
      };
    }

    if (mutation.kind === 'create') {
      const now = this.#now();
      const definition = await this.#canonicalDefinition(mutation.definition);
      const nextFireAt = nextFireAtFor(definition.schedule, now, definition.expiresAt);
      if (nextFireAt === null) throw new AutomationRequestError('Schedule has no fire before expiry');
      validateProspectiveDefinition({
        automationId: mutation.automationId,
        ...definition,
        status: 'enabled',
        revision: 1,
        createdAt: now,
        updatedAt: now,
        nextFireAt,
        fireCount: 0,
      });
      return this.#store.createDefinition({
        automationId: mutation.automationId,
        ...definition,
        createdAt: now,
        nextFireAt,
        enabled: true,
      });
    }
    const current = prepared.current;
    if (!current) throw new Error('Prepared Automation mutation has no current definition');
    const now = monotonicNow(this.#now(), current.updatedAt);
    if (mutation.kind === 'update') {
      const definition = await this.#canonicalDefinition(mutation.definition);
      const nextFireAt =
        current.status === 'enabled'
          ? nextFireAtFor(definition.schedule, now, definition.expiresAt)
          : null;
      if (current.status === 'enabled' && nextFireAt === null) {
        throw new AutomationRequestError('Schedule has no fire before expiry');
      }
      validateProspectiveDefinition({
        ...current,
        ...definition,
        revision: current.revision + 1,
        updatedAt: now,
        nextFireAt,
      });
      return this.#store.updateDefinition({
        automationId: mutation.automationId,
        expectedRevision: mutation.expectedRevision,
        ...definition,
        updatedAt: now,
        nextFireAt,
      });
    }
    if (mutation.kind === 'set_enabled') {
      const nextFireAt = mutation.enabled
        ? nextFireAtFor(current.schedule, now, current.expiresAt)
        : null;
      if (mutation.enabled && nextFireAt === null) {
        throw new AutomationRequestError('Schedule has no fire before expiry');
      }
      return this.#store.setEnabled({
        automationId: mutation.automationId,
        expectedRevision: mutation.expectedRevision,
        enabled: mutation.enabled,
        updatedAt: now,
        nextFireAt,
      });
    }
    return this.#store.deleteDefinition({
      automationId: mutation.automationId,
      expectedRevision: mutation.expectedRevision,
      deletedAt: now,
    });
  }

  async #canonicalDefinition(
    definition: AutomationDefinitionInput,
  ): Promise<AutomationDefinitionConfig> {
    return {
      name: definition.name,
      prompt: definition.prompt,
      target: await this.#canonicalTarget(definition.executionTarget),
      schedule: canonicalSchedule(definition.schedule),
      maxFireCount: definition.maxFires,
      expiresAt: definition.expiresAt,
    };
  }

  async #canonicalTarget(
    target: AutomationExecutionTarget,
  ): Promise<AutomationDefinitionConfig['target']> {
    if (target.kind === 'existing_session') {
      const header = await this.#readActiveSession(target.sessionId);
      return { kind: 'heartbeat', sessionId: header.id };
    }
    const source = await this.#readActiveSession(target.sourceSessionId);
    if (
      source.cwd !== target.cwd ||
      source.backend !== target.backend ||
      source.llmConnectionSlug !== target.llmConnectionSlug ||
      source.model !== target.model ||
      (source.thinkingLevel ?? null) !== target.thinkingLevel
    ) {
      throw new AutomationRequestError('Fresh-session execution target is stale');
    }
    return {
      kind: 'cron',
      creatorSessionId: source.id,
      freshSession: {
        cwd: source.cwd,
        backend: source.backend,
        llmConnectionSlug: source.llmConnectionSlug,
        model: source.model,
        ...(source.thinkingLevel ? { thinkingLevel: source.thinkingLevel } : {}),
        permissionMode: 'explore',
      },
    };
  }

  async #toolDefinition(
    request: AutomationToolCreateRequest,
    now: number,
  ): Promise<AutomationDefinitionConfig> {
    const source = await this.#readActiveSession(request.requester.sessionId);
    return {
      name: request.name,
      prompt: request.prompt,
      target:
        request.kind === 'heartbeat'
          ? { kind: 'heartbeat', sessionId: source.id }
          : {
              kind: 'cron',
              creatorSessionId: source.id,
              freshSession: {
                cwd: source.cwd,
                backend: source.backend,
                llmConnectionSlug: source.llmConnectionSlug,
                model: source.model,
                ...(source.thinkingLevel ? { thinkingLevel: source.thinkingLevel } : {}),
                permissionMode: 'explore',
              },
            },
      schedule: canonicalSchedule(request.schedule),
      maxFireCount: request.maxFires ?? null,
      expiresAt: now + DEFAULT_TOOL_EXPIRY_MS,
    };
  }

  async #readActiveSession(sessionId: string): Promise<SessionHeader> {
    try {
      const header = await this.#executionStores.sessionStore.readHeaderSnapshot(sessionId);
      if (header.isArchived) throw new AutomationRequestError('Automation target is archived');
      return header;
    } catch (error) {
      if (error instanceof AutomationRequestError) throw error;
      if (isMissingFile(error)) throw new AutomationRequestError('Automation target was not found');
      throw error;
    }
  }

  async #ownedDefinition(
    automationId: string,
    sessionId: string,
  ): Promise<AutomationDefinition | undefined> {
    const definition = await this.#store.getDefinition(automationId);
    return definition && isOwnedBy(definition, sessionId) ? definition : undefined;
  }

  async #afterMutation(): Promise<AutomationCatalogSnapshot> {
    const snapshot = await this.#store.readCatalogSnapshot();
    if (this.#schedulerStarted && !this.#draining) this.#applyTimer(snapshot);
    return snapshot;
  }

  #applyTimer(snapshot: AutomationCatalogSnapshot): void {
    if (!this.#schedulerStarted || this.#draining) return;
    const nextFireAt = snapshot.definitions.reduce<number | null>((earliest, definition) => {
      if (definition.status !== 'enabled' || definition.nextFireAt === null) return earliest;
      return earliest === null ? definition.nextFireAt : Math.min(earliest, definition.nextFireAt);
    }, null);
    if (nextFireAt === null) {
      this.#stopTimer();
      return;
    }
    this.#timerResidency ??= this.#acquireResidency();
    if (this.#timer) clearTimeout(this.#timer);
    const rawDelay = nextFireAt - this.#now();
    const delay = Math.min(
      MAX_TIMER_DELAY_MS,
      rawDelay <= 0 ? DUE_RETRY_MS : Math.max(1, rawDelay),
    );
    this.#timer = setTimeout(() => this.#onTimer(), delay);
    this.#timer.unref?.();
  }

  #stopTimer(): void {
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = undefined;
    this.#timerResidency?.release();
    this.#timerResidency = undefined;
  }

  #onTimer(): void {
    this.#timer = undefined;
    if (this.#draining || this.#schedulerTask) return;
    const task = this.#runDue();
    this.#schedulerTask = task;
    void task.then(
      () => {
        if (this.#schedulerTask === task) this.#schedulerTask = undefined;
      },
      () => {
        if (this.#schedulerTask === task) this.#schedulerTask = undefined;
        this.#enterDrain();
      },
    );
  }

  async #runDue(): Promise<void> {
    const snapshot = await this.#store.readCatalogSnapshot();
    const now = this.#now();
    for (const definition of snapshot.definitions) {
      if (this.#draining) break;
      if (
        definition.status !== 'enabled' ||
        definition.nextFireAt === null ||
        definition.nextFireAt > now
      ) {
        continue;
      }
      if (definition.expiresAt !== null && now >= definition.expiresAt) {
        await this.#disableExpired(definition, now);
        continue;
      }
      await this.#admitDueFire(definition);
    }
    if (!this.#draining) this.#applyTimer(await this.#store.readCatalogSnapshot());
  }

  async #disableExpired(definition: AutomationDefinition, now: number): Promise<void> {
    const result = await this.#store.setEnabled({
      automationId: definition.automationId,
      expectedRevision: definition.revision,
      enabled: false,
      updatedAt: monotonicNow(now, definition.updatedAt),
      nextFireAt: null,
    });
    if (result.status === 'conflict' && result.code !== 'revision_mismatch') {
      throw new Error(`Could not disable expired Automation: ${result.code}`);
    }
  }

  async #admitDueFire(definition: AutomationDefinition): Promise<void> {
    const targetSessionId =
      definition.target.kind === 'heartbeat' ? definition.target.sessionId : this.#newId();
    await this.#sessionAdmission.run(targetSessionId, async (lease) => {
      if (this.#draining) return;
      if (definition.target.kind === 'heartbeat') {
        const header = await this.#readActiveSession(targetSessionId).catch((error) => {
          if (error instanceof AutomationRequestError) return undefined;
          throw error;
        });
        if (!header || this.#root.readRootState(targetSessionId).kind !== 'idle') return;
      }
      const admittedAt = monotonicNow(this.#now(), definition.updatedAt);
      const nextFireAt = nextFireAfterAdmission(definition, admittedAt);
      const residency = this.#acquireResidency();
      let admitted = false;
      try {
        const result = await this.#store.admitFire({
          admission: {
            fireId: this.#newId(),
            automationId: definition.automationId,
            scheduledFor: requireDueTime(definition),
            admittedAt,
            targetSessionId,
            turnId: this.#newId(),
            runId: this.#newId(),
            userMessageId: this.#newId(),
          },
          expectedAutomationRevision: definition.revision,
          nextFireAt,
        });
        if (result.status === 'conflict') {
          if (result.code === 'automation_expired' && result.current) {
            await this.#disableExpired(result.current, admittedAt);
          }
          if (
            result.code !== 'revision_mismatch' &&
            result.code !== 'scheduled_slot_mismatch' &&
            result.code !== 'non_terminal_fire' &&
            result.code !== 'automation_not_enabled' &&
            result.code !== 'automation_expired'
          ) {
            throw new Error(`Automation fire admission conflicted: ${result.code}`);
          }
          return;
        }
        admitted = true;
        const active = this.#registerActiveFire(result.fire.admission.fireId, residency);
        try {
          const handle = await this.#startFire(result.fire, lease);
          if (!handle) {
            this.#releaseActiveFire(result.fire.admission.fireId, active);
            return;
          }
          active.task = this.#settleFromTurn(result.fire, handle.terminal, active);
          observe(active.task);
        } catch (error) {
          active.task = Promise.reject(error);
          observe(active.task);
          this.#releaseActiveFire(result.fire.admission.fireId, active);
          throw error;
        }
      } finally {
        if (!admitted) residency.release();
      }
    });
  }

  async #resumeFire(fire: AutomationFire): Promise<void> {
    if (this.#activeFires.has(fire.admission.fireId)) return;
    const residency = this.#acquireResidency();
    const active = this.#registerActiveFire(fire.admission.fireId, residency);
    try {
      const terminal = await this.#terminalRun(fire);
      if (terminal) {
        active.task = this.#settleOutcome(fire, terminal, active);
        observe(active.task);
        return;
      }
      await this.#sessionAdmission.run(fire.admission.targetSessionId, async (lease) => {
        const handle = await this.#startFire(fire, lease);
        if (!handle) {
          this.#releaseActiveFire(fire.admission.fireId, active);
          return;
        }
        active.task = this.#settleFromTurn(fire, handle.terminal, active);
        observe(active.task);
      });
    } catch (error) {
      active.task = Promise.reject(error);
      observe(active.task);
      this.#releaseActiveFire(fire.admission.fireId, active);
      this.#enterDrain();
      throw error;
    }
  }

  async #terminalRun(fire: AutomationFire): Promise<AutomationFireTerminalOutcome | undefined> {
    let run: AgentRunHeader;
    try {
      run = await this.#executionStores.agentRunStore.readRun(
        fire.admission.targetSessionId,
        fire.admission.runId,
      );
    } catch (error) {
      if (isMissingFile(error)) return undefined;
      throw error;
    }
    if (run.status === 'completed') {
      return { kind: 'succeeded', settledAt: monotonicNow(this.#now(), fire.admission.admittedAt) };
    }
    if (run.status === 'failed') {
      if (run.failureClass === 'app_restarted') {
        return {
          kind: 'outcome_unknown',
          settledAt: monotonicNow(this.#now(), fire.admission.admittedAt),
          phase: 'after_run_start',
        };
      }
      return {
        kind: 'failed',
        settledAt: monotonicNow(this.#now(), fire.admission.admittedAt),
        errorCode: run.failureClass ?? 'unknown',
        message: run.failureClass ?? 'Automation run failed',
      };
    }
    if (run.status === 'cancelled') {
      return {
        kind: 'failed',
        settledAt: monotonicNow(this.#now(), fire.admission.admittedAt),
        errorCode: 'cancelled',
        message: 'Automation run was cancelled',
      };
    }
    return undefined;
  }

  async #startFire(
    fire: AutomationFire,
    lease: Parameters<RootTurnCoordinator['startAutomationTurn']>[1],
  ) {
    await this.#ensureFreshSession(fire);
    const result = await this.#root.startAutomationTurn(
      {
        sessionId: fire.admission.targetSessionId,
        turnId: fire.admission.turnId,
        runId: fire.admission.runId,
        userMessageId: fire.admission.userMessageId,
        automationId: fire.admission.automationId,
        fireId: fire.admission.fireId,
        content: {
          text: `[Automation: ${fire.definitionAfterAdmission.name}]\n\n${fire.definitionAfterAdmission.prompt}`,
        },
      },
      lease,
    );
    if (result.kind === 'started') return result.handle;
    const outcome: AutomationFireTerminalOutcome = {
      kind: 'outcome_unknown',
      settledAt: monotonicNow(this.#now(), fire.admission.admittedAt),
      phase: 'before_run_start',
    };
    await this.#settleFire(fire, outcome);
    return undefined;
  }

  async #ensureFreshSession(fire: AutomationFire): Promise<void> {
    const target = fire.definitionAfterAdmission.target;
    if (target.kind !== 'cron') return;
    const result = await this.#executionStores.sessionStore.createAutomationSession({
      sessionId: fire.admission.targetSessionId,
      origin: {
        kind: 'automation',
        automationId: fire.admission.automationId,
        fireId: fire.admission.fireId,
      },
      execution: target.freshSession,
      presentation: { name: fire.definitionAfterAdmission.name },
    });
    if (result.kind === 'conflict') {
      throw new Error(`Automation target Session ${fire.admission.targetSessionId} conflicts`);
    }
  }

  #settleFromTurn(
    fire: AutomationFire,
    terminal: Promise<TurnSnapshot>,
    active: ActiveFire,
  ): Promise<void> {
    return (async () => {
      try {
        const snapshot = await terminal;
        await this.#settleOutcome(
          fire,
          outcomeFromTurn(snapshot, monotonicNow(this.#now(), fire.admission.admittedAt)),
          active,
        );
      } catch (error) {
        this.#enterDrain();
        this.#releaseActiveFire(fire.admission.fireId, active);
        throw error;
      }
    })();
  }

  async #settleOutcome(
    fire: AutomationFire,
    outcome: AutomationFireTerminalOutcome,
    active: ActiveFire,
  ): Promise<void> {
    try {
      if (!this.#failStop) await this.#settleFire(fire, outcome);
    } catch (error) {
      this.#enterDrain();
      throw error;
    } finally {
      this.#releaseActiveFire(fire.admission.fireId, active);
    }
  }

  async #settleFire(fire: AutomationFire, outcome: AutomationFireTerminalOutcome): Promise<void> {
    const result = await this.#store.settleFire({ fireId: fire.admission.fireId, outcome });
    if (result.status === 'conflict') {
      throw new Error(`Automation fire settlement conflicted: ${result.code}`);
    }
  }

  #registerActiveFire(fireId: string, residency: OperationResidency): ActiveFire {
    if (this.#activeFires.has(fireId)) throw new Error(`Automation fire is already active: ${fireId}`);
    const active: ActiveFire = { residency, task: Promise.resolve(), released: false };
    this.#activeFires.set(fireId, active);
    return active;
  }

  #releaseActiveFire(fireId: string, active: ActiveFire): void {
    if (this.#failStop || active.released) return;
    active.released = true;
    active.residency.release();
    if (this.#activeFires.get(fireId) === active) this.#activeFires.delete(fireId);
  }

  async #projection(
    definition: AutomationDefinition,
    fires: readonly AutomationFire[],
  ): Promise<AutomationProjection> {
    const current = fires.find((fire) => fire.outcome === undefined);
    const terminal = fires.find((fire) => fire.outcome !== undefined);
    let currentStatus: 'admitted' | 'running' = 'admitted';
    if (current) {
      try {
        await this.#executionStores.agentRunStore.readRun(
          current.admission.targetSessionId,
          current.admission.runId,
        );
        currentStatus = 'running';
      } catch (error) {
        if (!isMissingFile(error)) throw error;
      }
    }
    return {
      automationId: definition.automationId,
      revision: definition.revision,
      ...protocolDefinition(definition),
      enabled: definition.status === 'enabled',
      createdAt: definition.createdAt,
      updatedAt: definition.updatedAt,
      nextFireAt: definition.nextFireAt,
      currentFire: current
        ? {
            fireId: current.admission.fireId,
            status: currentStatus,
            admittedAt: current.admission.admittedAt,
            runId: current.admission.runId,
          }
        : null,
      lastFire: terminal ? lastFireProjection(terminal) : null,
    };
  }

  #enterDrain(): void {
    this.beginDrain();
    this.#requestDrain();
  }

  #assertOpen(): void {
    if (this.#closed) throw new Error('Automation coordinator is closed');
    if (this.#draining) throw new Error('Automation coordinator is draining');
  }
}

class AutomationRequestError extends Error {}

function validateProspectiveDefinition(definition: AutomationDefinition): void {
  try {
    decodeAutomationDefinition(definition);
  } catch (error) {
    if (error instanceof AutomationDomainDecodeError) {
      throw new AutomationRequestError(error.message);
    }
    throw error;
  }
}

function canonicalSchedule(
  schedule: AutomationSchedule | ToolAutomationSchedule,
): CanonicalAutomationSchedule {
  if (schedule.type === 'once') return { kind: 'once', delayMs: schedule.delaySeconds * 1000 };
  if (schedule.type === 'interval') return { kind: 'interval', intervalMs: schedule.seconds * 1000 };
  return { kind: 'cron', expression: schedule.expression };
}

function protocolSchedule(schedule: CanonicalAutomationSchedule): AutomationSchedule {
  if (schedule.kind === 'once') return { type: 'once', delaySeconds: schedule.delayMs / 1000 };
  if (schedule.kind === 'interval') return { type: 'interval', seconds: schedule.intervalMs / 1000 };
  return { type: 'cron', expression: schedule.expression };
}

function nextFireAtFor(
  schedule: CanonicalAutomationSchedule,
  from: number,
  expiresAt: number | null,
): number | null {
  const next =
    schedule.kind === 'once'
      ? from + schedule.delayMs
      : schedule.kind === 'interval'
        ? from + schedule.intervalMs
        : computeNextCronFire(schedule.expression, from);
  if (next === null || (expiresAt !== null && next >= expiresAt)) return null;
  return next;
}

function nextFireAfterAdmission(definition: AutomationDefinition, admittedAt: number): number | null {
  if (
    definition.maxFireCount !== null &&
    definition.fireCount + 1 >= definition.maxFireCount
  ) {
    return null;
  }
  if (definition.schedule.kind === 'once') return null;
  return nextFireAtFor(definition.schedule, admittedAt, definition.expiresAt);
}

function protocolDefinition(definition: AutomationDefinition): AutomationDefinitionInput {
  return {
    kind: definition.target.kind === 'heartbeat' ? 'heartbeat' : 'cron',
    name: definition.name,
    prompt: definition.prompt,
    executionTarget:
      definition.target.kind === 'heartbeat'
        ? { kind: 'existing_session', sessionId: definition.target.sessionId }
        : {
            kind: 'fresh_session',
            sourceSessionId: definition.target.creatorSessionId,
            cwd: definition.target.freshSession.cwd,
            backend: definition.target.freshSession.backend,
            llmConnectionSlug: definition.target.freshSession.llmConnectionSlug,
            model: definition.target.freshSession.model,
            thinkingLevel: definition.target.freshSession.thinkingLevel ?? null,
            permissionMode: definition.target.freshSession.permissionMode,
          },
    schedule: protocolSchedule(definition.schedule),
    maxFires: definition.maxFireCount,
    expiresAt: definition.expiresAt,
  };
}

function canonicalTargetUnchecked(
  target: AutomationExecutionTarget,
): AutomationDefinitionConfig['target'] {
  if (target.kind === 'existing_session') {
    return { kind: 'heartbeat', sessionId: target.sessionId };
  }
  return {
    kind: 'cron',
    creatorSessionId: target.sourceSessionId,
    freshSession: {
      cwd: target.cwd,
      backend: target.backend,
      llmConnectionSlug: target.llmConnectionSlug,
      model: target.model,
      ...(target.thinkingLevel ? { thinkingLevel: target.thinkingLevel } : {}),
      permissionMode: target.permissionMode,
    },
  };
}

function canonicalDefinitionUnchecked(
  definition: AutomationDefinitionInput,
): AutomationDefinitionConfig {
  return {
    name: definition.name,
    prompt: definition.prompt,
    target: canonicalTargetUnchecked(definition.executionTarget),
    schedule: canonicalSchedule(definition.schedule),
    maxFireCount: definition.maxFires,
    expiresAt: definition.expiresAt,
  };
}

function indexFires(snapshot: AutomationCatalogSnapshot): Map<string, AutomationFire[]> {
  const index = new Map<string, AutomationFire[]>();
  for (const fire of snapshot.fires) {
    const automationId = fire.admission.automationId;
    const fires = index.get(automationId);
    if (fires) fires.push(fire);
    else index.set(automationId, [fire]);
  }
  return index;
}

function firesFor(
  index: ReadonlyMap<string, readonly AutomationFire[]>,
  definition: AutomationDefinition,
): readonly AutomationFire[] {
  return index.get(definition.automationId) ?? [];
}

function lastFireProjection(fire: AutomationFire): NonNullable<AutomationProjection['lastFire']> {
  const outcome = fire.outcome;
  if (!outcome) throw new Error('Expected terminal Automation fire');
  return {
    fireId: fire.admission.fireId,
    status: outcome.kind,
    admittedAt: fire.admission.admittedAt,
    completedAt: outcome.settledAt,
    runId: fire.admission.runId,
    failure:
      outcome.kind === 'failed'
        ? boundedFailure(`${outcome.errorCode}: ${outcome.message}`)
        : null,
  };
}

function toolProjection(
  definition: AutomationDefinition,
  fires: readonly AutomationFire[],
  now: number,
): AutomationToolProjection {
  const terminal = fires.find((fire) => fire.outcome !== undefined);
  const failed = terminal?.outcome?.kind === 'failed' ? terminal.outcome : undefined;
  return {
    id: definition.automationId,
    kind: definition.target.kind === 'heartbeat' ? 'heartbeat' : 'cron',
    name: definition.name,
    status:
      definition.expiresAt !== null && definition.expiresAt <= now
        ? 'expired'
        : definition.status === 'enabled'
          ? 'active'
          : definition.status === 'disabled'
            ? 'paused'
            : 'completed',
    schedule: protocolSchedule(definition.schedule),
    nextFireAt: definition.nextFireAt,
    lastFireAt: terminal?.admission.admittedAt ?? null,
    fireCount: definition.fireCount,
    maxFires: definition.maxFireCount,
    lastError: failed ? `${failed.errorCode}: ${failed.message}` : null,
    consecutiveFailures: failed ? 1 : 0,
    durable: true,
    deferredFireCount: 0,
  };
}

function isOwnedBy(definition: AutomationDefinition, sessionId: string): boolean {
  return definition.target.kind === 'heartbeat'
    ? definition.target.sessionId === sessionId
    : definition.target.creatorSessionId === sessionId;
}

function outcomeFromTurn(snapshot: TurnSnapshot, now: number): AutomationFireTerminalOutcome {
  if (snapshot.status === 'completed') return { kind: 'succeeded', settledAt: now };
  if (snapshot.status === 'failed') {
    return {
      kind: 'failed',
      settledAt: now,
      errorCode: snapshot.failureClass,
      message: snapshot.failureClass,
    };
  }
  if (snapshot.status === 'cancelled') {
    return {
      kind: 'failed',
      settledAt: now,
      errorCode: 'cancelled',
      message: snapshot.abortSource,
    };
  }
  throw new Error('Automation Turn did not produce a terminal snapshot');
}

function createPage(
  revision: number,
  projections: readonly AutomationProjection[],
  offset: number,
  totalDefinitions: number,
): AutomationQueryResult {
  const items: AutomationProjection[] = [];
  for (let index = 0; index < projections.length; index += 1) {
    const item = projections[index];
    if (!item) break;
    const candidateItems = [...items, item];
    const nextOffset = offset + index + 1;
    const candidate = {
      kind: 'page' as const,
      revision,
      items: candidateItems,
      nextCursor: nextOffset < totalDefinitions ? encodeCursor(nextOffset) : null,
    };
    if (Buffer.byteLength(JSON.stringify(candidate), 'utf8') > AUTOMATION_PAGE_MAX_BYTES) {
      if (items.length === 0) throw new Error('Automation projection cannot fit in one page');
      break;
    }
    items.push(item);
  }
  const nextOffset = offset + items.length;
  return encodeAutomationQueryResult({
    kind: 'page',
    revision,
    items,
    nextCursor: nextOffset < totalDefinitions ? encodeCursor(nextOffset) : null,
  });
}

function encodeCursor(offset: number): string {
  return String(offset);
}

function decodeCursor(cursor: string): number | undefined {
  if (!/^(?:0|[1-9]\d*)$/.test(cursor)) return undefined;
  const offset = Number(cursor);
  return Number.isSafeInteger(offset) ? offset : undefined;
}

function boundedFailure(value: string): string {
  if (Buffer.byteLength(value, 'utf8') <= AUTOMATION_FIRE_FAILURE_MAX_BYTES) return value;
  let result = '';
  for (const character of value) {
    if (Buffer.byteLength(result + character, 'utf8') > AUTOMATION_FIRE_FAILURE_MAX_BYTES) break;
    result += character;
  }
  return result;
}

function requireDueTime(definition: AutomationDefinition): number {
  if (definition.nextFireAt === null) throw new Error('Automation has no due slot');
  return definition.nextFireAt;
}

function monotonicNow(now: number, floor: number): number {
  return Math.max(now, floor);
}

function isMissingFile(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT';
}

function success<K extends 'automation.query' | 'automation.mutate'>(
  result: K extends 'automation.query' ? AutomationQueryResult : AutomationMutateResult,
): OperationOutcome<K> {
  return { ok: true, result } as OperationOutcome<K>;
}

function failure<K extends 'automation.query' | 'automation.mutate'>(
  code: Extract<OperationOutcome<K>, { ok: false }>['error']['code'],
  message: string,
): OperationOutcome<K> {
  return { ok: false, error: { code, message } } as OperationOutcome<K>;
}

function observe(task: Promise<unknown>): void {
  void task.catch(() => undefined);
}
