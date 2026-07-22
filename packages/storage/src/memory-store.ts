import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, readdir, rename, rm, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { LOCAL_MEMORY_MAX_BYTES } from '@maka/core';
import {
  assertStorageRootLease,
  runWithStorageRootLease,
  StorageRootAuthorityError,
  type StorageRootLease,
} from './root-authority.js';
import { syncDirectory } from './stable-storage.js';

export const MEMORY_DOCUMENT_FILE = 'MEMORY.md';
export const MEMORY_DOCUMENT_MAX_BYTES = LOCAL_MEMORY_MAX_BYTES;

const MEMORY_DOCUMENT_DIRECTORY = 'memory';
const READ_CHUNK_BYTES = 64 * 1024;
const MEMORY_TEMP_PATTERN =
  /^MEMORY\.md\.[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.tmp$/;
const readerBrand: unique symbol = Symbol('InteractiveMemoryStoreReader');
const writerBrand: unique symbol = Symbol('InteractiveMemoryStoreWriter');

export type MemoryDocumentRevision = `sha256:${string}`;

export type MemoryQueryResult =
  | { readonly kind: 'missing'; readonly revision: null }
  | {
      readonly kind: 'document';
      readonly revision: MemoryDocumentRevision;
      readonly bytes: Uint8Array;
    }
  | {
      readonly kind: 'safe_mode';
      readonly reason: 'invalid_utf8' | 'oversize';
      readonly revision: MemoryDocumentRevision;
      readonly byteLength: number;
    };

export interface SaveMemoryDocumentInput {
  readonly expectedRevision: MemoryDocumentRevision | null;
  readonly bytes: Uint8Array;
}

export interface MemoryMutationResult {
  readonly changed: boolean;
  readonly document: Extract<MemoryQueryResult, { kind: 'document' }>;
}

export interface RecoverMemoryStoreOptions {
  readonly defaultDocument?: Uint8Array;
}

export interface InteractiveMemoryStoreReader {
  readonly kind: 'interactive';
  readonly access: 'read';
  readonly [readerBrand]: true;
  query(): Promise<MemoryQueryResult>;
}

export interface InteractiveMemoryStoreWriter {
  readonly kind: 'interactive';
  readonly access: 'write';
  readonly [writerBrand]: true;
  query(): Promise<MemoryQueryResult>;
  save(input: SaveMemoryDocumentInput): Promise<MemoryMutationResult>;
  recover(options?: RecoverMemoryStoreOptions): Promise<MemoryQueryResult>;
  beginDrain(): Promise<void>;
  close(): Promise<void>;
}

export type MemoryStoreErrorCode = 'invalid_document' | 'io_failed' | 'commit_unknown';

export class MemoryStoreError extends Error {
  constructor(
    readonly code: MemoryStoreErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'MemoryStoreError';
  }
}

export class MemoryRevisionConflictError extends Error {
  readonly code = 'revision_conflict';

  constructor(
    readonly expectedRevision: MemoryDocumentRevision | null,
    readonly actualRevision: MemoryDocumentRevision | null,
  ) {
    super(
      `Memory revision conflict: expected ${expectedRevision ?? 'missing'}, actual ${actualRevision ?? 'missing'}`,
    );
    this.name = 'MemoryRevisionConflictError';
  }
}

export class MemoryStoreLifecycleError extends Error {
  constructor(readonly code: 'draining' | 'closed') {
    super(
      code === 'draining' ? 'Memory store writer is draining' : 'Memory store writer is closed',
    );
    this.name = 'MemoryStoreLifecycleError';
  }
}

const readers = new WeakSet<object>();
const writers = new WeakSet<object>();
const writerByLease = new WeakMap<object, InteractiveMemoryStoreWriter>();
const writerOpeningByLease = new WeakMap<object, Promise<InteractiveMemoryStoreWriter>>();

export function authenticateInteractiveMemoryStoreReader(
  store: InteractiveMemoryStoreReader,
): InteractiveMemoryStoreReader {
  if (!readers.has(store)) throw invalidFacade('read');
  return store;
}

export function authenticateInteractiveMemoryStoreWriter(
  store: InteractiveMemoryStoreWriter,
): InteractiveMemoryStoreWriter {
  if (!writers.has(store)) throw invalidFacade('write');
  return store;
}

export async function openInteractiveMemoryStoreForRead(
  lease: StorageRootLease<'interactive', 'read'>,
): Promise<InteractiveMemoryStoreReader> {
  await assertStorageRootLease(lease, 'interactive', 'read');
  const facade: InteractiveMemoryStoreReader = {
    kind: 'interactive',
    access: 'read',
    [readerBrand]: true,
    query: () =>
      runWithStorageRootLease(lease, 'interactive', 'read', (root) => queryMemoryDocument(root)),
  };
  Object.freeze(facade);
  readers.add(facade);
  return facade;
}

export async function openInteractiveMemoryStoreForWrite(
  lease: StorageRootLease<'interactive', 'write'>,
): Promise<InteractiveMemoryStoreWriter> {
  await assertStorageRootLease(lease, 'interactive', 'write');
  const existing = writerByLease.get(lease);
  if (existing) return existing;
  const opening = writerOpeningByLease.get(lease);
  if (opening) return opening;

  const pending = Promise.resolve().then(async () => {
    await assertStorageRootLease(lease, 'interactive', 'write');
    const opened = writerByLease.get(lease);
    if (opened) return opened;
    const facade = createWriterFacade(lease);
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

function createWriterFacade(
  lease: StorageRootLease<'interactive', 'write'>,
): InteractiveMemoryStoreWriter {
  const lifecycle = new MemoryWriterLifecycle();
  const queue = new MemoryMutationQueue();
  const read = () => {
    lifecycle.assertReadable();
    return runWithStorageRootLease(lease, 'interactive', 'write', (root) =>
      queryMemoryDocument(root),
    );
  };
  const mutate = <T>(operation: (root: string) => Promise<T>) =>
    lifecycle.runMutation(() =>
      queue.run(() => runWithStorageRootLease(lease, 'interactive', 'write', operation)),
    );
  const facade: InteractiveMemoryStoreWriter = {
    kind: 'interactive',
    access: 'write',
    [writerBrand]: true,
    query: read,
    save: (input) => {
      const admitted = admitSaveInput(input);
      return mutate((root) => saveMemoryDocument(root, admitted));
    },
    recover: (options) => {
      const admitted =
        options?.defaultDocument === undefined
          ? undefined
          : { defaultDocument: validateDocumentBytes(options.defaultDocument) };
      return mutate((root) => recoverMemoryStore(root, admitted));
    },
    beginDrain: () => lifecycle.beginDrain(),
    close: () => lifecycle.close(),
  };
  return Object.freeze(facade);
}

class MemoryMutationQueue {
  private tail: Promise<void> = Promise.resolve();

  run<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.tail.then(operation, operation);
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

class MemoryWriterLifecycle {
  private state: 'open' | 'draining' | 'closed' = 'open';
  private activeMutations = 0;
  private readonly drainWaiters = new Set<() => void>();
  private closePromise: Promise<void> | undefined;

  assertReadable(): void {
    if (this.state === 'closed') throw new MemoryStoreLifecycleError('closed');
  }

  runMutation<T>(operation: () => Promise<T>): Promise<T> {
    if (this.state !== 'open') return Promise.reject(new MemoryStoreLifecycleError(this.state));
    this.activeMutations += 1;
    return operation().finally(() => {
      this.activeMutations -= 1;
      if (this.activeMutations !== 0) return;
      for (const resolve of this.drainWaiters) resolve();
      this.drainWaiters.clear();
    });
  }

  beginDrain(): Promise<void> {
    if (this.state === 'open') this.state = 'draining';
    return this.waitForMutations();
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closePromise = this.beginDrain().then(() => {
      this.state = 'closed';
    });
    return this.closePromise;
  }

  private waitForMutations(): Promise<void> {
    return this.activeMutations === 0
      ? Promise.resolve()
      : new Promise<void>((resolve) => this.drainWaiters.add(resolve));
  }
}

async function recoverMemoryStore(
  root: string,
  options: RecoverMemoryStoreOptions | undefined,
): Promise<MemoryQueryResult> {
  await cleanupMemoryTemps(root);
  const current = await queryMemoryDocument(root);
  if (current.kind !== 'missing' || options?.defaultDocument === undefined) return current;
  return (
    await saveMemoryDocument(root, {
      expectedRevision: null,
      bytes: options.defaultDocument,
    })
  ).document;
}

async function cleanupMemoryTemps(root: string): Promise<void> {
  const directory = await findMemoryDirectory(root);
  if (directory === undefined) return;
  let removed = false;
  let failure: unknown;
  let entries: string[];
  try {
    entries = await readdir(directory);
  } catch (cause) {
    throw ioFailed('Memory temporary artifacts could not be listed', cause);
  }
  for (const entry of entries) {
    if (!MEMORY_TEMP_PATTERN.test(entry)) continue;
    const path = join(directory, entry);
    try {
      const metadata = await lstat(path);
      if (!metadata.isFile()) {
        throw invalidDocument('Memory temporary artifacts must be regular files');
      }
      await unlink(path);
      removed = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      failure =
        error instanceof MemoryStoreError
          ? error
          : ioFailed('A Memory temporary artifact could not be removed', error);
      break;
    }
  }
  if (removed) {
    try {
      await syncDirectory(directory);
    } catch (cause) {
      failure ??= ioFailed('Memory temporary artifact cleanup could not be synchronized', cause);
    }
  }
  if (failure !== undefined) throw failure;
}

async function saveMemoryDocument(
  root: string,
  input: SaveMemoryDocumentInput,
): Promise<MemoryMutationResult> {
  const bytes = validateDocumentBytes(input.bytes);
  const current = await queryMemoryDocument(root);
  const actualRevision = current.kind === 'missing' ? null : current.revision;
  if (actualRevision !== input.expectedRevision) {
    throw new MemoryRevisionConflictError(input.expectedRevision, actualRevision);
  }
  if (
    current.kind === 'document' &&
    current.bytes.byteLength === bytes.byteLength &&
    Buffer.from(current.bytes).equals(bytes)
  ) {
    return { changed: false, document: current };
  }

  await publishMemoryDocument(root, bytes);
  return {
    changed: true,
    document: documentResult(bytes),
  };
}

async function publishMemoryDocument(root: string, bytes: Buffer): Promise<void> {
  const directory = await prepareMemoryDirectory(root);
  const path = join(directory, MEMORY_DOCUMENT_FILE);
  const temporaryPath = join(directory, `${MEMORY_DOCUMENT_FILE}.${randomUUID()}.tmp`);
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  let temporaryCreated = false;
  let published = false;
  let failure: unknown;
  try {
    handle = await open(temporaryPath, 'wx', 0o600);
    temporaryCreated = true;
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporaryPath, path);
    published = true;
    await syncDirectory(directory);
  } catch (error) {
    failure = error;
  } finally {
    if (handle !== undefined) {
      try {
        await handle.close();
      } catch (error) {
        failure ??= error;
      }
    }
    if (temporaryCreated && !published) {
      try {
        await rm(temporaryPath, { force: true });
      } catch (error) {
        failure ??= error;
      }
    }
  }

  if (failure === undefined) return;
  if (published) {
    throw new MemoryStoreError(
      'commit_unknown',
      'MEMORY.md commit outcome is unknown; query before deciding whether to retry',
      { cause: failure },
    );
  }
  throw ioFailed('MEMORY.md I/O failed before publication', failure);
}

async function queryMemoryDocument(root: string): Promise<MemoryQueryResult> {
  const directory = await findMemoryDirectory(root);
  if (directory === undefined) return { kind: 'missing', revision: null };
  const path = join(directory, MEMORY_DOCUMENT_FILE);
  const flags =
    process.platform === 'win32'
      ? constants.O_RDONLY
      : constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(path, flags);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { kind: 'missing', revision: null };
    }
    if (process.platform !== 'win32' && (error as NodeJS.ErrnoException).code === 'ELOOP') {
      throw invalidDocument('MEMORY.md must not be a symbolic link', error);
    }
    throw ioFailed('MEMORY.md could not be opened', error);
  }

  let result: MemoryQueryResult | undefined;
  let failure: unknown;
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile()) throw invalidDocument('MEMORY.md must be a regular file');

    const hash = createHash('sha256');
    const chunks: Buffer[] = [];
    let total = 0;
    for (;;) {
      const buffer = Buffer.allocUnsafe(READ_CHUNK_BYTES);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, total);
      if (bytesRead === 0) break;
      const chunk = buffer.subarray(0, bytesRead);
      total += bytesRead;
      hash.update(chunk);
      if (total <= MEMORY_DOCUMENT_MAX_BYTES) chunks.push(chunk);
    }
    const revision = `sha256:${hash.digest('hex')}` as const;
    if (total > MEMORY_DOCUMENT_MAX_BYTES) {
      result = { kind: 'safe_mode', reason: 'oversize', revision, byteLength: total };
    } else {
      const bytes = Buffer.concat(chunks, total);
      try {
        new TextDecoder('utf-8', { fatal: true }).decode(bytes);
        result = documentResult(bytes, revision);
      } catch {
        result = { kind: 'safe_mode', reason: 'invalid_utf8', revision, byteLength: total };
      }
    }
  } catch (error) {
    failure = error;
  } finally {
    try {
      await handle.close();
    } catch (error) {
      failure ??= error;
    }
  }
  if (failure !== undefined) {
    if (failure instanceof MemoryStoreError) throw failure;
    throw ioFailed('MEMORY.md could not be read', failure);
  }
  return result!;
}

async function findMemoryDirectory(root: string): Promise<string | undefined> {
  const directory = join(root, MEMORY_DOCUMENT_DIRECTORY);
  let metadata;
  try {
    metadata = await lstat(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw ioFailed('Memory directory could not be inspected', error);
  }
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw invalidDocument('Memory path must be a directory inside the storage root');
  }
  return directory;
}

async function prepareMemoryDirectory(root: string): Promise<string> {
  const existing = await findMemoryDirectory(root);
  if (existing !== undefined) return existing;

  const directory = join(root, MEMORY_DOCUMENT_DIRECTORY);
  try {
    await mkdir(directory, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
      throw ioFailed('Memory directory could not be created', error);
    }
  }
  const prepared = await findMemoryDirectory(root);
  if (prepared === undefined) {
    throw ioFailed(
      'Memory directory disappeared during creation',
      new Error('Memory directory is missing'),
    );
  }
  try {
    await syncDirectory(root);
  } catch (cause) {
    throw ioFailed('Memory directory creation could not be synchronized', cause);
  }
  return prepared;
}

function validateDocumentBytes(input: Uint8Array): Buffer {
  if (!(input instanceof Uint8Array)) throw invalidDocument('MEMORY.md bytes are required');
  const bytes = Buffer.from(input);
  if (bytes.byteLength > MEMORY_DOCUMENT_MAX_BYTES) {
    throw invalidDocument(`MEMORY.md exceeds its ${MEMORY_DOCUMENT_MAX_BYTES} byte limit`);
  }
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch (cause) {
    throw invalidDocument('MEMORY.md is not valid UTF-8', cause);
  }
  return bytes;
}

function admitSaveInput(input: SaveMemoryDocumentInput): SaveMemoryDocumentInput {
  if (input.expectedRevision !== null && !/^sha256:[a-f0-9]{64}$/.test(input.expectedRevision)) {
    throw invalidDocument('Expected Memory revision must be null or a SHA-256 revision');
  }
  return {
    expectedRevision: input.expectedRevision,
    bytes: validateDocumentBytes(input.bytes),
  };
}

function documentResult(
  bytes: Uint8Array,
  revision: MemoryDocumentRevision = `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
): Extract<MemoryQueryResult, { kind: 'document' }> {
  return { kind: 'document', revision, bytes: Uint8Array.from(bytes) };
}

function invalidDocument(message: string, cause?: unknown): MemoryStoreError {
  return new MemoryStoreError(
    'invalid_document',
    message,
    cause === undefined ? undefined : { cause },
  );
}

function ioFailed(message: string, cause: unknown): MemoryStoreError {
  return new MemoryStoreError('io_failed', message, { cause });
}

function invalidFacade(access: 'read' | 'write'): StorageRootAuthorityError {
  return new StorageRootAuthorityError(
    'invalid_lease',
    `Expected authentic interactive ${access} memory store`,
  );
}
