import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import {
  decodeAdmitAutomationFireRequest,
  decodeAutomationDefinition,
  decodeAutomationFire,
  decodeCreateAutomationDefinitionRequest,
  decodeDeleteAutomationDefinitionRequest,
  decodeSetAutomationEnabledRequest,
  decodeSettleAutomationFireRequest,
  decodeUpdateAutomationDefinitionRequest,
  type AdmitAutomationFireRequest,
  type AutomationDefinition,
  type AutomationDefinitionConfig,
  type AutomationFire,
  type CreateAutomationDefinitionRequest,
  type DeleteAutomationDefinitionRequest,
  type SetAutomationEnabledRequest,
  type SettleAutomationFireRequest,
  type UpdateAutomationDefinitionRequest,
} from '@maka/core';
import {
  assertStorageRootLease,
  runWithStorageRootLease,
  StorageRootAuthorityError,
  type StorageRootLease,
} from './root-authority.js';
import { syncDirectoryChain, syncFile } from './stable-storage.js';

export const AUTOMATION_STORE_SCHEMA_VERSION = 1 as const;

export interface AutomationCatalogSnapshot {
  readonly catalogRevision: number;
  readonly definitions: readonly AutomationDefinition[];
  readonly fires: readonly AutomationFire[];
}

export type AutomationDefinitionMutationConflictCode =
  | 'semantic_conflict'
  | 'automation_not_found'
  | 'automation_exists'
  | 'automation_identity_retired'
  | 'revision_mismatch'
  | 'invalid_status'
  | 'fire_budget_exhausted'
  | 'invalid_timestamp'
  | 'non_terminal_fire';

export type AutomationDefinitionMutationResult =
  | {
      readonly status: 'committed';
      readonly replayed: boolean;
      readonly definition: AutomationDefinition;
    }
  | {
      readonly status: 'deleted';
      readonly replayed: boolean;
      readonly automationId: string;
    }
  | {
      readonly status: 'conflict';
      readonly code: AutomationDefinitionMutationConflictCode;
      readonly current?: AutomationDefinition;
    };

export type AutomationDefinitionMutationPrepareRequest =
  | {
      readonly kind: 'create';
      readonly automationId: string;
      readonly config: AutomationDefinitionConfig;
      readonly enabled: boolean;
    }
  | {
      readonly kind: 'update';
      readonly automationId: string;
      readonly expectedRevision: number;
      readonly config: AutomationDefinitionConfig;
    }
  | {
      readonly kind: 'set_enabled';
      readonly automationId: string;
      readonly expectedRevision: number;
      readonly enabled: boolean;
    }
  | {
      readonly kind: 'delete';
      readonly automationId: string;
      readonly expectedRevision: number;
    };

export type AutomationDefinitionMutationReplayResult =
  | {
      readonly status: 'committed';
      readonly replayed: true;
      readonly definition: AutomationDefinition;
    }
  | {
      readonly status: 'deleted';
      readonly replayed: true;
      readonly automationId: string;
    };

/** Advisory only: mutation methods atomically repeat this adjudication before commit. */
export type AutomationDefinitionMutationPrepareResult =
  | {
      readonly status: 'ready';
      readonly identity: 'genuinely_new' | 'active';
      readonly current?: AutomationDefinition;
    }
  | {
      readonly status: 'replay';
      readonly result: AutomationDefinitionMutationReplayResult;
    }
  | {
      readonly status: 'conflict';
      readonly code: AutomationDefinitionMutationConflictCode;
      readonly identity: 'active' | 'retired' | 'absent';
      readonly current?: AutomationDefinition;
    };

export type AutomationFireAdmissionConflictCode =
  | 'fire_id_reused'
  | 'automation_not_found'
  | 'revision_mismatch'
  | 'automation_not_enabled'
  | 'automation_expired'
  | 'scheduled_slot_mismatch'
  | 'invalid_schedule_advance'
  | 'non_terminal_fire'
  | 'fire_budget_exhausted';

export type AutomationFireAdmissionResult =
  | {
      readonly status: 'committed';
      readonly replayed: boolean;
      readonly definition: AutomationDefinition;
      readonly fire: AutomationFire;
    }
  | {
      readonly status: 'conflict';
      readonly code: AutomationFireAdmissionConflictCode;
      readonly current?: AutomationDefinition;
      readonly fire?: AutomationFire;
    };

export type AutomationFireSettlementResult =
  | { readonly status: 'committed'; readonly replayed: boolean; readonly fire: AutomationFire }
  | { readonly status: 'conflict'; readonly code: 'fire_not_found' | 'already_settled' };

export interface AutomationStoreReader {
  readCatalogSnapshot(): Promise<AutomationCatalogSnapshot>;
  getDefinition(automationId: string): Promise<AutomationDefinition | undefined>;
  listDefinitions(): Promise<AutomationDefinition[]>;
  getFire(fireId: string): Promise<AutomationFire | undefined>;
  listNonTerminalFires(): Promise<AutomationFire[]>;
}

export interface AutomationStoreWriter extends AutomationStoreReader {
  readonly lifecycle: 'active' | 'draining' | 'closed';
  prepareDefinitionMutation(
    request: AutomationDefinitionMutationPrepareRequest,
  ): Promise<AutomationDefinitionMutationPrepareResult>;
  createDefinition(
    request: CreateAutomationDefinitionRequest,
  ): Promise<AutomationDefinitionMutationResult>;
  updateDefinition(
    request: UpdateAutomationDefinitionRequest,
  ): Promise<AutomationDefinitionMutationResult>;
  setEnabled(request: SetAutomationEnabledRequest): Promise<AutomationDefinitionMutationResult>;
  deleteDefinition(
    request: DeleteAutomationDefinitionRequest,
  ): Promise<AutomationDefinitionMutationResult>;
  admitFire(request: AdmitAutomationFireRequest): Promise<AutomationFireAdmissionResult>;
  settleFire(request: SettleAutomationFireRequest): Promise<AutomationFireSettlementResult>;
  beginDrain(): Promise<void>;
  close(): Promise<void>;
}

const writerBrand: unique symbol = Symbol('InteractiveAutomationStoreWriter');
const writers = new WeakSet<object>();
const writerByLease = new WeakMap<object, InteractiveAutomationStoreWriterFacade>();
const writerOpeningByLease = new WeakMap<object, Promise<InteractiveAutomationStoreWriterFacade>>();

export interface InteractiveAutomationStoreWriterFacade extends AutomationStoreWriter {
  readonly kind: 'interactive';
  readonly access: 'write';
  readonly [writerBrand]: true;
}

export function authenticateAutomationStoreWriter(
  writer: InteractiveAutomationStoreWriterFacade,
): InteractiveAutomationStoreWriterFacade {
  if (!writers.has(writer)) {
    throw new StorageRootAuthorityError(
      'invalid_lease',
      'Expected an authenticated interactive Automation writer',
    );
  }
  return writer;
}

export async function openInteractiveAutomationStoreForWrite(
  lease: StorageRootLease<'interactive', 'write'>,
): Promise<InteractiveAutomationStoreWriterFacade> {
  await assertStorageRootLease(lease, 'interactive', 'write');
  const existing = writerByLease.get(lease);
  if (existing) return existing;
  const opening = writerOpeningByLease.get(lease);
  if (opening) return opening;

  const pending = Promise.resolve().then(async () => {
    const store = new FileAutomationStore(lease.canonicalPath);
    const runWithLease = <T>(operation: () => Promise<T>) =>
      runWithStorageRootLease(lease, 'interactive', 'write', operation);
    await runWithLease(() => store.open());
    await assertStorageRootLease(lease, 'interactive', 'write');
    const recovered = writerByLease.get(lease);
    if (recovered) return recovered;

    const lifecycle = new WriterLifecycle();
    const run = <T>(operation: () => Promise<T>) => lifecycle.accept(() => runWithLease(operation));
    const facade = {
      kind: 'interactive' as const,
      access: 'write' as const,
      [writerBrand]: true as const,
      get lifecycle() {
        return lifecycle.state;
      },
      readCatalogSnapshot: () => run(() => store.readCatalogSnapshot()),
      getDefinition: (automationId: string) => run(() => store.getDefinition(automationId)),
      listDefinitions: () => run(() => store.listDefinitions()),
      getFire: (fireId: string) => run(() => store.getFire(fireId)),
      listNonTerminalFires: () => run(() => store.listNonTerminalFires()),
      prepareDefinitionMutation: (request: AutomationDefinitionMutationPrepareRequest) =>
        run(() => store.prepareDefinitionMutation(request)),
      createDefinition: (request: CreateAutomationDefinitionRequest) =>
        run(() => store.createDefinition(request)),
      updateDefinition: (request: UpdateAutomationDefinitionRequest) =>
        run(() => store.updateDefinition(request)),
      setEnabled: (request: SetAutomationEnabledRequest) => run(() => store.setEnabled(request)),
      deleteDefinition: (request: DeleteAutomationDefinitionRequest) =>
        run(() => store.deleteDefinition(request)),
      admitFire: (request: AdmitAutomationFireRequest) => run(() => store.admitFire(request)),
      settleFire: (request: SettleAutomationFireRequest) => run(() => store.settleFire(request)),
      beginDrain: () => lifecycle.beginDrain(),
      close: () => lifecycle.close(),
    } satisfies InteractiveAutomationStoreWriterFacade;
    Object.freeze(facade);
    writers.add(facade);
    writerByLease.set(lease, facade);
    return facade;
  });
  writerOpeningByLease.set(lease, pending);
  try {
    return await pending;
  } finally {
    if (writerOpeningByLease.get(lease) === pending) writerOpeningByLease.delete(lease);
  }
}

type DefinitionMutationRequest =
  | CreateAutomationDefinitionRequest
  | UpdateAutomationDefinitionRequest
  | SetAutomationEnabledRequest
  | DeleteAutomationDefinitionRequest;
type DefinitionMutationKind = 'create' | 'update' | 'set_enabled' | 'delete';
type DefinitionMutationReceipt = AutomationDefinitionMutationPrepareRequest;
interface AutomationSnapshot {
  readonly schemaVersion: typeof AUTOMATION_STORE_SCHEMA_VERSION;
  readonly catalogRevision: number;
  readonly definitions: AutomationDefinition[];
  readonly fires: AutomationFire[];
  readonly definitionMutations: DefinitionMutationReceipt[];
}

class FileAutomationStore {
  private readonly filePath: string;
  private readonly root: string;
  private tail: Promise<void> = Promise.resolve();

  constructor(root: string) {
    this.root = root;
    this.filePath = join(root, 'automations.json');
  }

  async open(): Promise<void> {
    try {
      await this.readSnapshot();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      await this.writeSnapshot(emptySnapshot());
    }
  }

  readCatalogSnapshot(): Promise<AutomationCatalogSnapshot> {
    return this.readAfterWrites(async () => {
      const snapshot = await this.readSnapshot();
      return Object.freeze({
        catalogRevision: snapshot.catalogRevision,
        definitions: Object.freeze([...snapshot.definitions]),
        fires: Object.freeze([...snapshot.fires]),
      });
    });
  }

  getDefinition(automationId: string): Promise<AutomationDefinition | undefined> {
    assertLookupId(automationId, 'automationId');
    return this.readAfterWrites(async () =>
      (await this.readSnapshot()).definitions.find((item) => item.automationId === automationId),
    );
  }

  listDefinitions(): Promise<AutomationDefinition[]> {
    return this.readAfterWrites(async () => (await this.readSnapshot()).definitions);
  }

  getFire(fireId: string): Promise<AutomationFire | undefined> {
    assertLookupId(fireId, 'fireId');
    return this.readAfterWrites(async () =>
      (await this.readSnapshot()).fires.find((item) => item.admission.fireId === fireId),
    );
  }

  listNonTerminalFires(): Promise<AutomationFire[]> {
    return this.readAfterWrites(async () =>
      (await this.readSnapshot()).fires.filter((item) => item.outcome === undefined),
    );
  }

  prepareDefinitionMutation(
    input: AutomationDefinitionMutationPrepareRequest,
  ): Promise<AutomationDefinitionMutationPrepareResult> {
    const request = decodePrepareRequest(input);
    return this.readAfterWrites(async () =>
      prepareDefinitionMutation(await this.readSnapshot(), request),
    );
  }

  createDefinition(
    input: CreateAutomationDefinitionRequest,
  ): Promise<AutomationDefinitionMutationResult> {
    const request = decodeCreateAutomationDefinitionRequest(input);
    return this.mutate(async (snapshot) => {
      const prepared = prepareDefinitionMutation(snapshot, semanticRequest('create', request));
      if (prepared.status !== 'ready') return preparedMutationResult(prepared);
      const definition = decodeAutomationDefinition({
        automationId: request.automationId,
        name: request.name,
        prompt: request.prompt,
        target: request.target,
        schedule: request.schedule,
        maxFireCount: request.maxFireCount,
        expiresAt: request.expiresAt,
        status: request.enabled ? 'enabled' : 'disabled',
        revision: 1,
        createdAt: request.createdAt,
        updatedAt: request.createdAt,
        nextFireAt: request.enabled ? request.nextFireAt : null,
        fireCount: 0,
      });
      return commitDefinition(snapshot, 'create', request, definition);
    });
  }

  updateDefinition(
    input: UpdateAutomationDefinitionRequest,
  ): Promise<AutomationDefinitionMutationResult> {
    const request = decodeUpdateAutomationDefinitionRequest(input);
    return this.mutate(async (snapshot) => {
      const prepared = prepareDefinitionMutation(snapshot, semanticRequest('update', request));
      if (prepared.status !== 'ready') return preparedMutationResult(prepared);
      const current = prepared.current;
      if (!current) throw new Error('Prepared active Automation disappeared');
      if ((current.status === 'enabled') !== (request.nextFireAt !== null)) {
        return conflict('invalid_status', current);
      }
      if (
        request.updatedAt < current.updatedAt ||
        (request.nextFireAt !== null && request.nextFireAt < request.updatedAt)
      ) {
        return conflict('invalid_timestamp', current);
      }
      const definition = decodeAutomationDefinition({
        ...current,
        ...definitionConfig(request),
        nextFireAt: request.nextFireAt,
        revision: current.revision + 1,
        updatedAt: request.updatedAt,
      });
      return commitDefinition(snapshot, 'update', request, definition);
    });
  }

  setEnabled(input: SetAutomationEnabledRequest): Promise<AutomationDefinitionMutationResult> {
    const request = decodeSetAutomationEnabledRequest(input);
    return this.mutate(async (snapshot) => {
      const prepared = prepareDefinitionMutation(snapshot, semanticRequest('set_enabled', request));
      if (prepared.status !== 'ready') return preparedMutationResult(prepared);
      const current = prepared.current;
      if (!current) throw new Error('Prepared active Automation disappeared');
      if (
        request.updatedAt < current.updatedAt ||
        (request.nextFireAt !== null && request.nextFireAt < request.updatedAt)
      ) {
        return conflict('invalid_timestamp', current);
      }
      const definition = decodeAutomationDefinition({
        ...current,
        status: request.enabled ? 'enabled' : 'disabled',
        nextFireAt: request.nextFireAt,
        revision: current.revision + 1,
        updatedAt: request.updatedAt,
      });
      return commitDefinition(snapshot, 'set_enabled', request, definition);
    });
  }

  deleteDefinition(
    input: DeleteAutomationDefinitionRequest,
  ): Promise<AutomationDefinitionMutationResult> {
    const request = decodeDeleteAutomationDefinitionRequest(input);
    return this.mutate(async (snapshot) => {
      const prepared = prepareDefinitionMutation(snapshot, semanticRequest('delete', request));
      if (prepared.status !== 'ready') return preparedMutationResult(prepared);
      const current = prepared.current;
      if (!current) throw new Error('Prepared active Automation disappeared');
      if (request.deletedAt < current.updatedAt) {
        return conflict('invalid_timestamp', current);
      }
      snapshot.definitions.splice(snapshot.definitions.indexOf(current), 1);
      replaceDefinitionReceipt(snapshot, semanticRequest('delete', request));
      return {
        status: 'deleted',
        replayed: false,
        automationId: request.automationId,
      };
    });
  }

  admitFire(input: AdmitAutomationFireRequest): Promise<AutomationFireAdmissionResult> {
    const request = decodeAdmitAutomationFireRequest(input);
    return this.mutate(async (snapshot) => {
      const existing = snapshot.fires.find(
        (item) => item.admission.fireId === request.admission.fireId,
      );
      if (existing) {
        if (admissionMatchesRequest(existing, request)) {
          return {
            status: 'committed',
            replayed: true,
            definition: existing.definitionAfterAdmission,
            fire: existing,
          };
        }
        return { status: 'conflict', code: 'fire_id_reused', fire: existing };
      }
      const current = findDefinition(snapshot, request.admission.automationId);
      if (!current) return fireConflict('automation_not_found');
      if (current.revision !== request.expectedAutomationRevision) {
        return fireConflict('revision_mismatch', current);
      }
      if (current.status !== 'enabled') return fireConflict('automation_not_enabled', current);
      if (current.expiresAt !== null && request.admission.admittedAt >= current.expiresAt) {
        return fireConflict('automation_expired', current);
      }
      if (current.nextFireAt !== request.admission.scheduledFor) {
        return fireConflict('scheduled_slot_mismatch', current);
      }
      if (
        request.admission.admittedAt < request.admission.scheduledFor ||
        request.admission.admittedAt < current.updatedAt ||
        (request.nextFireAt !== null && request.nextFireAt <= request.admission.scheduledFor)
      ) {
        return fireConflict('invalid_schedule_advance', current);
      }
      if (hasNonTerminalFire(snapshot, current.automationId)) {
        return fireConflict('non_terminal_fire', current);
      }
      if (current.maxFireCount !== null && current.fireCount >= current.maxFireCount) {
        return fireConflict('fire_budget_exhausted', current);
      }
      const targetSessionId =
        current.target.kind === 'heartbeat'
          ? current.target.sessionId
          : request.admission.targetSessionId;
      if (targetSessionId !== request.admission.targetSessionId) {
        return fireConflict('scheduled_slot_mismatch', current);
      }
      const nextFireCount = current.fireCount + 1;
      const exhausted =
        request.nextFireAt === null ||
        (current.maxFireCount !== null && nextFireCount >= current.maxFireCount);
      if (exhausted !== (request.nextFireAt === null)) {
        return fireConflict('fire_budget_exhausted', current);
      }
      const definition = decodeAutomationDefinition({
        ...current,
        status: exhausted ? 'exhausted' : 'enabled',
        nextFireAt: request.nextFireAt,
        fireCount: nextFireCount,
        revision: current.revision + 1,
        updatedAt: request.admission.admittedAt,
      });
      const fire = decodeAutomationFire({
        admission: {
          ...request.admission,
          definitionRevision: current.revision,
        },
        definitionAfterAdmission: definition,
      });
      replaceDefinition(snapshot, definition);
      snapshot.fires.push(fire);
      return { status: 'committed', replayed: false, definition, fire };
    });
  }

  settleFire(input: SettleAutomationFireRequest): Promise<AutomationFireSettlementResult> {
    const request = decodeSettleAutomationFireRequest(input);
    return this.mutate(async (snapshot) => {
      const index = snapshot.fires.findIndex((item) => item.admission.fireId === request.fireId);
      if (index < 0) return { status: 'conflict', code: 'fire_not_found' };
      const current = snapshot.fires[index];
      if (current.outcome) {
        return isDeepStrictEqual(current.outcome, request.outcome)
          ? { status: 'committed', replayed: true, fire: current }
          : { status: 'conflict', code: 'already_settled' };
      }
      const fire = decodeAutomationFire({ ...current, outcome: request.outcome });
      snapshot.fires[index] = fire;
      snapshot.fires = snapshot.fires.filter(
        (candidate) =>
          candidate === fire ||
          candidate.admission.automationId !== fire.admission.automationId ||
          candidate.outcome === undefined,
      );
      return { status: 'committed', replayed: false, fire };
    });
  }

  private mutate<T>(operation: (snapshot: MutableSnapshot) => Promise<T> | T): Promise<T> {
    const result = this.tail.then(async () => {
      const snapshot = mutableSnapshot(await this.readSnapshot());
      const before = JSON.stringify(snapshot);
      const value = await operation(snapshot);
      if (JSON.stringify(snapshot) !== before) {
        snapshot.catalogRevision += 1;
        await this.writeSnapshot(snapshot);
      }
      return value;
    });
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private async readAfterWrites<T>(operation: () => Promise<T>): Promise<T> {
    await this.tail;
    return operation();
  }

  private async readSnapshot(): Promise<AutomationSnapshot> {
    let text: string;
    try {
      text = await readFile(this.filePath, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw error;
      throw new Error(`[automation-store] failed to read ${this.filePath}`, { cause: error });
    }
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch (error) {
      throw new Error(`[automation-store] ${this.filePath} is not valid JSON`, { cause: error });
    }
    return decodeSnapshot(value, this.filePath);
  }

  private async writeSnapshot(snapshot: AutomationSnapshot): Promise<void> {
    const canonical = canonicalSnapshot(snapshot);
    const tempPath = `${this.filePath}.${process.pid}.${randomUUID()}.tmp`;
    await mkdir(dirname(this.filePath), { recursive: true });
    try {
      await writeFile(tempPath, `${JSON.stringify(canonical, null, 2)}\n`, {
        encoding: 'utf8',
        mode: 0o600,
        flag: 'wx',
      });
      await syncFile(tempPath);
      await rename(tempPath, this.filePath);
      await syncDirectoryChain(dirname(this.filePath), this.root);
    } finally {
      await rm(tempPath, { force: true });
    }
  }
}

type MutableSnapshot = {
  schemaVersion: typeof AUTOMATION_STORE_SCHEMA_VERSION;
  catalogRevision: number;
  definitions: AutomationDefinition[];
  fires: AutomationFire[];
  definitionMutations: DefinitionMutationReceipt[];
};

class WriterLifecycle {
  state: 'active' | 'draining' | 'closed' = 'active';
  private active = 0;
  private readonly waiters = new Set<() => void>();
  private drainPromise?: Promise<void>;
  private closePromise?: Promise<void>;

  async accept<T>(operation: () => Promise<T>): Promise<T> {
    if (this.state !== 'active') throw new Error(`Automation writer is ${this.state}`);
    this.active += 1;
    try {
      return await operation();
    } finally {
      this.active -= 1;
      if (this.active === 0) {
        for (const resolve of this.waiters) resolve();
        this.waiters.clear();
      }
    }
  }

  beginDrain(): Promise<void> {
    if (this.state === 'closed') return this.closePromise ?? Promise.resolve();
    this.state = 'draining';
    this.drainPromise ??=
      this.active === 0 ? Promise.resolve() : new Promise((resolve) => this.waiters.add(resolve));
    return this.drainPromise;
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closePromise = this.beginDrain().then(() => {
      this.state = 'closed';
    });
    return this.closePromise;
  }
}

function decodeSnapshot(value: unknown, path: string): AutomationSnapshot {
  try {
    const item = strictRecord(value, [
      'schemaVersion',
      'catalogRevision',
      'definitions',
      'fires',
      'definitionMutations',
    ]);
    if (item.schemaVersion !== AUTOMATION_STORE_SCHEMA_VERSION) {
      throw new TypeError(`schemaVersion must be ${AUTOMATION_STORE_SCHEMA_VERSION}`);
    }
    if (!Array.isArray(item.definitions) || !Array.isArray(item.fires)) {
      throw new TypeError('definitions and fires must be arrays');
    }
    if (!Array.isArray(item.definitionMutations)) {
      throw new TypeError('definitionMutations must be an array');
    }
    const catalogRevision = nonNegativeInteger(item.catalogRevision, 'catalogRevision');
    const definitions = item.definitions.map(decodeAutomationDefinition);
    const fires = item.fires.map(decodeAutomationFire);
    const definitionMutations = item.definitionMutations.map(decodeReceipt);
    const activeDefinitionIds = new Set(definitions.map((entry) => entry.automationId));
    assertUnique(
      definitions.map((entry) => entry.automationId),
      'automationId',
    );
    assertUnique(
      fires.map((entry) => entry.admission.fireId),
      'fireId',
    );
    assertUnique(
      definitionMutations.map((receipt) => receipt.automationId),
      'definition mutation automationId',
    );
    for (const receipt of definitionMutations) {
      if (receipt.kind === 'delete' && activeDefinitionIds.has(receipt.automationId)) {
        throw new TypeError('retired Automation identity remains active');
      }
      if (receipt.kind !== 'delete' && !activeDefinitionIds.has(receipt.automationId)) {
        throw new TypeError('active Automation mutation receipt has no definition');
      }
    }
    const nonTerminal = new Set<string>();
    const terminal = new Set<string>();
    for (const fire of fires) {
      if (fire.outcome) {
        if (terminal.has(fire.admission.automationId)) {
          throw new TypeError('multiple terminal fires retained for one automation');
        }
        terminal.add(fire.admission.automationId);
        continue;
      }
      if (nonTerminal.has(fire.admission.automationId)) {
        throw new TypeError('multiple non-terminal fires for one automation');
      }
      nonTerminal.add(fire.admission.automationId);
    }
    return canonicalSnapshot({
      schemaVersion: AUTOMATION_STORE_SCHEMA_VERSION,
      catalogRevision,
      definitions,
      fires,
      definitionMutations,
    });
  } catch (error) {
    throw new Error(`[automation-store] ${path} has invalid schema`, { cause: error });
  }
}

function decodeReceipt(value: unknown): DefinitionMutationReceipt {
  return decodePrepareRequest(value);
}

function decodePrepareRequest(value: unknown): AutomationDefinitionMutationPrepareRequest {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('Automation mutation prepare request must be an object');
  }
  const kind = (value as Record<string, unknown>).kind;
  if (kind === 'create') {
    const item = strictRecord(value, ['kind', 'automationId', 'config', 'enabled']);
    const request = decodeCreateAutomationDefinitionRequest({
      automationId: item.automationId,
      ...prepareDefinitionConfig(item.config),
      createdAt: 0,
      nextFireAt: 1,
      enabled: item.enabled,
    });
    return Object.freeze({
      kind,
      automationId: request.automationId,
      config: definitionConfig(request),
      enabled: request.enabled,
    });
  }
  if (kind === 'update') {
    const item = strictRecord(value, ['kind', 'automationId', 'expectedRevision', 'config']);
    const request = decodeUpdateAutomationDefinitionRequest({
      automationId: item.automationId,
      expectedRevision: item.expectedRevision,
      ...prepareDefinitionConfig(item.config),
      updatedAt: 0,
      nextFireAt: null,
    });
    return Object.freeze({
      kind,
      automationId: request.automationId,
      expectedRevision: request.expectedRevision,
      config: definitionConfig(request),
    });
  }
  if (kind === 'set_enabled') {
    const item = strictRecord(value, ['kind', 'automationId', 'expectedRevision', 'enabled']);
    const request = decodeSetAutomationEnabledRequest({
      automationId: item.automationId,
      expectedRevision: item.expectedRevision,
      enabled: item.enabled,
      updatedAt: 0,
      nextFireAt: item.enabled === true ? 1 : null,
    });
    return Object.freeze({
      kind,
      automationId: request.automationId,
      expectedRevision: request.expectedRevision,
      enabled: request.enabled,
    });
  }
  if (kind === 'delete') {
    const item = strictRecord(value, ['kind', 'automationId', 'expectedRevision']);
    const request = decodeDeleteAutomationDefinitionRequest({
      automationId: item.automationId,
      expectedRevision: item.expectedRevision,
      deletedAt: 0,
    });
    return Object.freeze({
      kind,
      automationId: request.automationId,
      expectedRevision: request.expectedRevision,
    });
  }
  throw new TypeError('unknown Automation mutation prepare kind');
}

function prepareDefinitionConfig(value: unknown): AutomationDefinitionConfig {
  const item = strictRecord(value, [
    'name',
    'prompt',
    'target',
    'schedule',
    'maxFireCount',
    'expiresAt',
  ]);
  return item as unknown as AutomationDefinitionConfig;
}

function emptySnapshot(): AutomationSnapshot {
  return {
    schemaVersion: AUTOMATION_STORE_SCHEMA_VERSION,
    catalogRevision: 0,
    definitions: [],
    fires: [],
    definitionMutations: [],
  };
}

function mutableSnapshot(snapshot: AutomationSnapshot): MutableSnapshot {
  return {
    schemaVersion: snapshot.schemaVersion,
    catalogRevision: snapshot.catalogRevision,
    definitions: [...snapshot.definitions],
    fires: [...snapshot.fires],
    definitionMutations: [...snapshot.definitionMutations],
  };
}

function canonicalSnapshot(snapshot: AutomationSnapshot): AutomationSnapshot {
  return {
    schemaVersion: AUTOMATION_STORE_SCHEMA_VERSION,
    catalogRevision: snapshot.catalogRevision,
    definitions: [...snapshot.definitions].sort((a, b) =>
      a.automationId.localeCompare(b.automationId),
    ),
    fires: [...snapshot.fires].sort((a, b) => a.admission.fireId.localeCompare(b.admission.fireId)),
    definitionMutations: [...snapshot.definitionMutations].sort((a, b) =>
      receiptIdentity(a).localeCompare(receiptIdentity(b)),
    ),
  };
}

function definitionConfig(
  value:
    | CreateAutomationDefinitionRequest
    | UpdateAutomationDefinitionRequest
    | AutomationDefinition,
) {
  return {
    name: value.name,
    prompt: value.prompt,
    target: value.target,
    schedule: value.schedule,
    maxFireCount: value.maxFireCount,
    expiresAt: value.expiresAt,
  };
}

function semanticRequest(
  kind: DefinitionMutationKind,
  request: DefinitionMutationRequest,
): AutomationDefinitionMutationPrepareRequest {
  if (kind === 'create') {
    const create = request as CreateAutomationDefinitionRequest;
    return {
      kind,
      automationId: create.automationId,
      config: definitionConfig(create),
      enabled: create.enabled,
    };
  }
  if (kind === 'update') {
    const update = request as UpdateAutomationDefinitionRequest;
    return {
      kind,
      automationId: update.automationId,
      expectedRevision: update.expectedRevision,
      config: definitionConfig(update),
    };
  }
  if (kind === 'set_enabled') {
    const enabled = request as SetAutomationEnabledRequest;
    return {
      kind,
      automationId: enabled.automationId,
      expectedRevision: enabled.expectedRevision,
      enabled: enabled.enabled,
    };
  }
  const deleted = request as DeleteAutomationDefinitionRequest;
  return {
    kind,
    automationId: deleted.automationId,
    expectedRevision: deleted.expectedRevision,
  };
}

function findDefinition(snapshot: AutomationSnapshot, automationId: string) {
  return snapshot.definitions.find((item) => item.automationId === automationId);
}

function replaceDefinition(snapshot: MutableSnapshot, definition: AutomationDefinition) {
  const index = snapshot.definitions.findIndex(
    (item) => item.automationId === definition.automationId,
  );
  if (index < 0) throw new Error('Automation definition disappeared during mutation');
  snapshot.definitions[index] = definition;
}

function commitDefinition(
  snapshot: MutableSnapshot,
  kind: DefinitionMutationKind,
  request: DefinitionMutationRequest,
  definition: AutomationDefinition,
): AutomationDefinitionMutationResult {
  const current = findDefinition(snapshot, definition.automationId);
  if (current) replaceDefinition(snapshot, definition);
  else snapshot.definitions.push(definition);
  replaceDefinitionReceipt(snapshot, semanticRequest(kind, request));
  return { status: 'committed', replayed: false, definition };
}

function prepareDefinitionMutation(
  snapshot: AutomationSnapshot,
  request: AutomationDefinitionMutationPrepareRequest,
): AutomationDefinitionMutationPrepareResult {
  const identity = requestIdentity(request);
  const current = findDefinition(snapshot, request.automationId);
  const receipt = snapshot.definitionMutations.find(
    (item) => item.automationId === request.automationId,
  );
  if (receipt && receiptIdentity(receipt) === identity) {
    if (!semanticRequestMatches(receipt, request)) {
      return prepareConflict('semantic_conflict', current ? 'active' : 'retired', current);
    }
    if (request.kind === 'delete') {
      return {
        status: 'replay',
        result: { status: 'deleted', replayed: true, automationId: request.automationId },
      };
    }
    if (!current) throw new Error('Active Automation receipt has no canonical definition');
    return {
      status: 'replay',
      result: { status: 'committed', replayed: true, definition: current },
    };
  }

  const retired = receipt?.kind === 'delete';
  if (request.kind === 'create') {
    if (current) return prepareConflict('automation_exists', 'active', current);
    if (retired) return prepareConflict('automation_identity_retired', 'retired');
    return { status: 'ready', identity: 'genuinely_new' };
  }
  if (!current) {
    return retired
      ? prepareConflict('automation_identity_retired', 'retired')
      : prepareConflict('automation_not_found', 'absent');
  }
  if (current.revision !== request.expectedRevision) {
    return prepareConflict('revision_mismatch', 'active', current);
  }
  if (current.status !== 'enabled' && current.status !== 'disabled') {
    return prepareConflict('invalid_status', 'active', current);
  }
  if (
    request.kind === 'set_enabled' &&
    request.enabled &&
    current.maxFireCount !== null &&
    current.fireCount >= current.maxFireCount
  ) {
    return prepareConflict('fire_budget_exhausted', 'active', current);
  }
  if (request.kind === 'delete' && hasNonTerminalFire(snapshot, request.automationId)) {
    return prepareConflict('non_terminal_fire', 'active', current);
  }
  return { status: 'ready', identity: 'active', current };
}

function replaceDefinitionReceipt(snapshot: MutableSnapshot, receipt: DefinitionMutationReceipt) {
  snapshot.definitionMutations = snapshot.definitionMutations.filter(
    (item) => item.automationId !== receipt.automationId,
  );
  snapshot.definitionMutations.push(receipt);
}

function semanticRequestMatches(
  left: AutomationDefinitionMutationPrepareRequest,
  right: AutomationDefinitionMutationPrepareRequest,
) {
  if (left.kind !== right.kind) return false;
  switch (left.kind) {
    case 'create': {
      if (right.kind !== 'create') return false;
      return (
        left.automationId === right.automationId &&
        left.enabled === right.enabled &&
        isDeepStrictEqual(left.config, right.config)
      );
    }
    case 'update':
      return (
        right.kind === 'update' &&
        left.automationId === right.automationId &&
        left.expectedRevision === right.expectedRevision &&
        isDeepStrictEqual(left.config, right.config)
      );
    case 'set_enabled':
      return (
        right.kind === 'set_enabled' &&
        left.automationId === right.automationId &&
        left.expectedRevision === right.expectedRevision &&
        left.enabled === right.enabled
      );
    case 'delete':
      return (
        right.kind === 'delete' &&
        left.automationId === right.automationId &&
        left.expectedRevision === right.expectedRevision
      );
  }
}

function receiptIdentity(receipt: DefinitionMutationReceipt) {
  return requestIdentity(receipt);
}

function requestIdentity(request: AutomationDefinitionMutationPrepareRequest) {
  if (request.kind === 'create') return `create:${request.automationId}`;
  return `revision:${request.automationId}:${request.expectedRevision}`;
}

function hasNonTerminalFire(snapshot: AutomationSnapshot, automationId: string) {
  return snapshot.fires.some(
    (fire) => fire.admission.automationId === automationId && fire.outcome === undefined,
  );
}

function admissionMatchesRequest(fire: AutomationFire, request: AdmitAutomationFireRequest) {
  const { definitionRevision: _revision, ...admission } = fire.admission;
  return (
    isDeepStrictEqual(admission, request.admission) &&
    fire.definitionAfterAdmission.revision === request.expectedAutomationRevision + 1 &&
    fire.definitionAfterAdmission.nextFireAt === request.nextFireAt
  );
}

function conflict(
  code: AutomationDefinitionMutationConflictCode,
  current?: AutomationDefinition,
): AutomationDefinitionMutationResult {
  return { status: 'conflict', code, ...(current ? { current } : {}) };
}

function prepareConflict(
  code: AutomationDefinitionMutationConflictCode,
  identity: 'active' | 'retired' | 'absent',
  current?: AutomationDefinition,
): AutomationDefinitionMutationPrepareResult {
  return { status: 'conflict', code, identity, ...(current ? { current } : {}) };
}

function preparedMutationResult(
  prepared: Exclude<AutomationDefinitionMutationPrepareResult, { status: 'ready' }>,
): AutomationDefinitionMutationResult {
  return prepared.status === 'replay' ? prepared.result : conflict(prepared.code, prepared.current);
}
function fireConflict(
  code: AutomationFireAdmissionConflictCode,
  current?: AutomationDefinition,
): AutomationFireAdmissionResult {
  return { status: 'conflict', code, ...(current ? { current } : {}) };
}

function strictRecord(value: unknown, keys: readonly string[]) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('expected object');
  }
  const item = value as Record<string, unknown>;
  if (Object.keys(item).length !== keys.length || keys.some((key) => !Object.hasOwn(item, key))) {
    throw new TypeError('object fields are not canonical');
  }
  return item;
}

function assertUnique(values: readonly string[], label: string) {
  if (new Set(values).size !== values.length) throw new TypeError(`duplicate ${label}`);
}

function assertLookupId(value: string, label: string) {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(value)) {
    throw new TypeError(`Invalid ${label}`);
  }
}

function nonNegativeInteger(value: unknown, label: string) {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new TypeError(`${label} must be a non-negative safe integer`);
  }
  return value as number;
}
