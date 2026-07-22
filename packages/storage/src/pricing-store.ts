import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { normalizePricingConfig, normalizePricingModelKey } from '@maka/core/usage-stats/pricing';
import type { PricingConfig } from '@maka/core/usage-stats/types';

const PRICING_DOCUMENT_VERSION = 1;
const MAX_PRICING_OVERRIDES = 128;

interface PricingDocument {
  readonly version: 1;
  readonly revision: number;
  readonly overrides: readonly PricingConfig[];
}

export interface PricingSnapshot {
  readonly revision: number;
  readonly overrides: readonly Readonly<PricingConfig>[];
}

export interface PricingMutationResult {
  readonly committed: boolean;
  readonly changed: boolean;
  readonly snapshot: PricingSnapshot;
}

export interface PricingStore {
  snapshot(): PricingSnapshot;
  upsert(expectedRevision: number, pricing: PricingConfig): Promise<PricingMutationResult>;
  delete(expectedRevision: number, modelKey: string): Promise<PricingMutationResult>;
  load(): Promise<void>;
  beginDrain(): Promise<void>;
  close(): Promise<void>;
}

export interface CreatePricingStoreOptions {
  readonly createIfMissing?: boolean;
}

export class PricingStoreClosedError extends Error {
  constructor() {
    super('Pricing store is closed');
    this.name = 'PricingStoreClosedError';
  }
}

export class PricingStoreNotLoadedError extends Error {
  constructor() {
    super('Pricing store has not been loaded');
    this.name = 'PricingStoreNotLoadedError';
  }
}

export class PricingRevisionConflictError extends Error {
  constructor(
    readonly expectedRevision: number,
    readonly actualRevision: number,
  ) {
    super(`Pricing revision conflict: expected ${expectedRevision}, actual ${actualRevision}`);
    this.name = 'PricingRevisionConflictError';
  }
}

export class PricingValidationError extends Error {
  constructor(message: string) {
    super(`Invalid pricing authority: ${message}`);
    this.name = 'PricingValidationError';
  }
}

export class PricingStorePublicationError extends Error {
  readonly domain = 'pricing_authority';

  constructor(options: { cause: unknown }) {
    super('Unable to publish pricing authority', options);
    this.name = 'PricingStorePublicationError';
  }
}

export function createPricingStore(
  workspaceRoot: string,
  options: CreatePricingStoreOptions = {},
): PricingStore {
  return new FilePricingStore(workspaceRoot, options.createIfMissing ?? true);
}

class FilePricingStore implements PricingStore {
  private readonly path: string;
  private document = emptyDocument();
  private loaded = false;
  private queue: Promise<void> = Promise.resolve();
  private state: 'open' | 'draining' | 'closed' = 'open';
  private closePromise: Promise<void> | undefined;
  private tempSequence = 0;

  constructor(
    workspaceRoot: string,
    private readonly createIfMissing: boolean,
  ) {
    this.path = join(workspaceRoot, 'pricing.json');
  }

  async load(): Promise<void> {
    if (this.loaded) return;
    this.assertOpen();
    try {
      this.document = decodeDocument(JSON.parse(await readFile(this.path, 'utf8')));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      const initial = emptyDocument();
      if (this.createIfMissing) {
        try {
          await this.write(initial);
        } catch (cause) {
          throw new PricingStorePublicationError({ cause });
        }
      }
      this.document = initial;
    }
    this.loaded = true;
  }

  snapshot(): PricingSnapshot {
    this.assertReady();
    return cloneSnapshot(this.document);
  }

  upsert(expectedRevision: number, pricing: PricingConfig): Promise<PricingMutationResult> {
    this.assertReady();
    assertRevision(expectedRevision, 'expectedRevision');
    const normalized = normalizePricingConfig(pricing);
    if (!normalized.ok) throw new PricingValidationError(normalized.error);
    const admitted = freezePricing(normalized.value);
    return this.enqueueMutation(expectedRevision, (current) => {
      const existing = current.overrides.find((item) => item.modelKey === admitted.modelKey);
      if (existing && pricingEqual(existing, admitted)) return current.overrides;
      if (!existing && current.overrides.length >= MAX_PRICING_OVERRIDES) {
        throw new PricingValidationError(
          `overrides must contain at most ${MAX_PRICING_OVERRIDES} entries`,
        );
      }
      return Object.freeze(
        [...current.overrides.filter((item) => item.modelKey !== admitted.modelKey), admitted].sort(
          (left, right) => left.modelKey.localeCompare(right.modelKey),
        ),
      );
    });
  }

  delete(expectedRevision: number, modelKey: string): Promise<PricingMutationResult> {
    this.assertReady();
    assertRevision(expectedRevision, 'expectedRevision');
    const normalized = normalizePricingModelKey(modelKey);
    if (!normalized.ok) throw new PricingValidationError(normalized.error);
    return this.enqueueMutation(expectedRevision, (current) =>
      current.overrides.some((item) => item.modelKey === normalized.value)
        ? Object.freeze(current.overrides.filter((item) => item.modelKey !== normalized.value))
        : current.overrides,
    );
  }

  beginDrain(): Promise<void> {
    if (this.state === 'open') this.state = 'draining';
    return this.queue;
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closePromise = this.beginDrain().finally(() => {
      this.state = 'closed';
    });
    return this.closePromise;
  }

  private enqueueMutation(
    expectedRevision: number,
    mutate: (current: PricingDocument) => readonly PricingConfig[],
  ): Promise<PricingMutationResult> {
    this.assertOpen();
    const operation = this.queue.then(async () => {
      const current = this.document;
      if (current.revision !== expectedRevision) {
        throw new PricingRevisionConflictError(expectedRevision, current.revision);
      }
      const overrides = mutate(current);
      if (overrides === current.overrides) {
        return Object.freeze({
          committed: false,
          changed: false,
          snapshot: cloneSnapshot(current),
        });
      }
      if (current.revision === Number.MAX_SAFE_INTEGER) {
        throw new PricingValidationError('revision cannot advance beyond Number.MAX_SAFE_INTEGER');
      }
      const candidate = freezeDocument({
        version: PRICING_DOCUMENT_VERSION,
        revision: current.revision + 1,
        overrides,
      });
      const publishedResult = Object.freeze({
        committed: true,
        changed: true,
        snapshot: cloneSnapshot(candidate),
      });
      try {
        await this.write(candidate);
      } catch (cause) {
        throw new PricingStorePublicationError({ cause });
      }
      this.document = candidate;
      return publishedResult;
    });
    this.queue = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }

  private async write(document: PricingDocument): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    const tempPath = `${this.path}.${process.pid}.${this.tempSequence++}.tmp`;
    try {
      await writeFile(tempPath, JSON.stringify(document, null, 2) + '\n', 'utf8');
      await rename(tempPath, this.path);
    } catch (error) {
      await rm(tempPath, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  private assertOpen(): void {
    if (this.state !== 'open') throw new PricingStoreClosedError();
  }

  private assertReady(): void {
    this.assertOpen();
    if (!this.loaded) throw new PricingStoreNotLoadedError();
  }
}

function decodeDocument(input: unknown): PricingDocument {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new PricingValidationError('expected an object');
  }
  const value = input as Record<string, unknown>;
  assertExactKeys(value, ['version', 'revision', 'overrides'], 'document');
  if (value.version !== PRICING_DOCUMENT_VERSION) {
    throw new PricingValidationError(`expected version ${PRICING_DOCUMENT_VERSION}`);
  }
  assertRevision(value.revision, 'revision');
  if (!Array.isArray(value.overrides)) {
    throw new PricingValidationError('overrides must be an array');
  }
  if (value.overrides.length > MAX_PRICING_OVERRIDES) {
    throw new PricingValidationError(
      `overrides must contain at most ${MAX_PRICING_OVERRIDES} entries`,
    );
  }
  const overrides = value.overrides.map((item, index) => {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) {
      throw new PricingValidationError(`overrides[${index}] must be an object`);
    }
    assertExactPricingKeys(item as Record<string, unknown>, index);
    const normalized = normalizePricingConfig(item);
    if (!normalized.ok)
      throw new PricingValidationError(`overrides[${index}]: ${normalized.error}`);
    return freezePricing(normalized.value);
  });
  const keys = new Set<string>();
  for (const item of overrides) {
    if (keys.has(item.modelKey)) {
      throw new PricingValidationError(`duplicate modelKey: ${item.modelKey}`);
    }
    keys.add(item.modelKey);
  }
  return freezeDocument({
    version: PRICING_DOCUMENT_VERSION,
    revision: value.revision,
    overrides: overrides.sort((left, right) => left.modelKey.localeCompare(right.modelKey)),
  });
}

function assertExactPricingKeys(value: Record<string, unknown>, index: number): void {
  const required = ['modelKey', 'inputUsdPer1M', 'outputUsdPer1M'];
  const optional = ['cacheReadUsdPer1M', 'cacheWriteUsdPer1M'];
  const keys = Object.keys(value);
  if (
    required.some((key) => !(key in value)) ||
    keys.some((key) => !required.includes(key) && !optional.includes(key))
  ) {
    throw new PricingValidationError(`overrides[${index}] has missing or unknown fields`);
  }
}

function assertExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
  label: string,
): void {
  const keys = Object.keys(value);
  if (keys.length !== expected.length || keys.some((key) => !expected.includes(key))) {
    throw new PricingValidationError(`${label} must contain exactly ${expected.join(', ')}`);
  }
}

function assertRevision(value: unknown, label: string): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new PricingValidationError(`${label} must be a nonnegative safe integer`);
  }
}

function emptyDocument(): PricingDocument {
  return freezeDocument({ version: PRICING_DOCUMENT_VERSION, revision: 0, overrides: [] });
}

function freezeDocument(document: PricingDocument): PricingDocument {
  return Object.freeze({
    version: PRICING_DOCUMENT_VERSION,
    revision: document.revision,
    overrides: Object.freeze(document.overrides.map(freezePricing)),
  });
}

function cloneSnapshot(document: PricingDocument): PricingSnapshot {
  return Object.freeze({
    revision: document.revision,
    overrides: Object.freeze(document.overrides.map(freezePricing)),
  });
}

function freezePricing(pricing: PricingConfig): Readonly<PricingConfig> {
  return Object.freeze({
    modelKey: pricing.modelKey,
    inputUsdPer1M: pricing.inputUsdPer1M,
    outputUsdPer1M: pricing.outputUsdPer1M,
    ...(pricing.cacheReadUsdPer1M === undefined
      ? {}
      : { cacheReadUsdPer1M: pricing.cacheReadUsdPer1M }),
    ...(pricing.cacheWriteUsdPer1M === undefined
      ? {}
      : { cacheWriteUsdPer1M: pricing.cacheWriteUsdPer1M }),
  });
}

function pricingEqual(left: PricingConfig, right: PricingConfig): boolean {
  return (
    left.modelKey === right.modelKey &&
    left.inputUsdPer1M === right.inputUsdPer1M &&
    left.outputUsdPer1M === right.outputUsdPer1M &&
    left.cacheReadUsdPer1M === right.cacheReadUsdPer1M &&
    left.cacheWriteUsdPer1M === right.cacheWriteUsdPer1M
  );
}
