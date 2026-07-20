import { createArtifactStore } from '@maka/storage';
import type { SynthesisCacheArtifactStore } from '@maka/runtime';
import {
  authenticateExecutionStoresReader,
  authenticateExecutionStoresWriter,
  openHeadlessExecutionStoresForRead,
  openHeadlessExecutionStoresForWrite,
  type ExecutionStoresReader,
  type ExecutionStoresWriter,
} from '@maka/storage/execution-stores';
import {
  createHeadlessRootLease,
  discoverMarkedStorageRoot,
  resolveStorageRoot,
  runWithStorageRootLease,
  StorageRootAuthorityError,
  type DiscoveredStorageRootCapability,
  type StorageRootCapability,
  type StorageRootLease,
} from '@maka/storage/root-authority';
import {
  openHeadlessTaskRunReader,
  openHeadlessTaskRunWriter,
  type TaskRunReader,
  type TaskRunWriter,
} from './task-run-store.js';

const headlessStorageWriterBrand: unique symbol = Symbol('HeadlessStorageWriter');
const headlessStorageReaderBrand: unique symbol = Symbol('HeadlessStorageReader');
const headlessStorageWriters = new WeakSet<object>();
const headlessStorageReaders = new WeakSet<object>();

export interface HeadlessStorageWriter {
  readonly [headlessStorageWriterBrand]: true;
  readonly taskRunStore: Readonly<TaskRunWriter>;
  readonly executionStores: ExecutionStoresWriter<'headless'>;
  readonly synthesisCacheArtifactStore: Readonly<SynthesisCacheArtifactStore>;
}

export interface HeadlessStorageReader {
  readonly [headlessStorageReaderBrand]: true;
  readonly taskRunStore: Readonly<TaskRunReader>;
  readonly executionStores: ExecutionStoresReader<'headless'>;
}

export async function openHeadlessStorageForWrite(
  storageRoot: string,
): Promise<HeadlessStorageWriter> {
  const capability = await resolveStorageRoot({ path: storageRoot, kind: 'headless' });
  const lease = createHeadlessRootLease(capability, 'write');
  const [taskRunStore, executionStores] = await Promise.all([
    openHeadlessTaskRunWriter(lease),
    openHeadlessExecutionStoresForWrite(lease),
  ]);

  const storage: HeadlessStorageWriter = {
    [headlessStorageWriterBrand]: true,
    taskRunStore,
    executionStores,
    synthesisCacheArtifactStore: leaseBoundSynthesisCacheArtifactStore(lease),
  };
  Object.freeze(storage);
  headlessStorageWriters.add(storage);
  return storage;
}

export async function openHeadlessStorageForRead(
  storageRoot: string,
): Promise<HeadlessStorageReader> {
  const discovered = await discoverMarkedStorageRoot({ path: storageRoot });
  const capability = requireHeadlessCapability(discovered);
  const lease = createHeadlessRootLease(capability, 'read');
  const [taskRunStore, executionStores] = await Promise.all([
    openHeadlessTaskRunReader(lease),
    openHeadlessExecutionStoresForRead(lease),
  ]);

  const storage: HeadlessStorageReader = {
    [headlessStorageReaderBrand]: true,
    taskRunStore,
    executionStores,
  };
  Object.freeze(storage);
  headlessStorageReaders.add(storage);
  return storage;
}

export function authenticateHeadlessStorageWriter(
  storage: HeadlessStorageWriter,
): HeadlessStorageWriter {
  if (!headlessStorageWriters.has(storage)) {
    throw new StorageRootAuthorityError(
      'invalid_lease',
      'Expected an authentic Headless storage writer',
    );
  }
  authenticateExecutionStoresWriter(storage.executionStores, 'headless');
  return storage;
}

export function authenticateHeadlessStorageReader(
  storage: HeadlessStorageReader,
): HeadlessStorageReader {
  if (!headlessStorageReaders.has(storage)) {
    throw new StorageRootAuthorityError(
      'invalid_lease',
      'Expected an authentic Headless storage reader',
    );
  }
  authenticateExecutionStoresReader(storage.executionStores, 'headless');
  return storage;
}

export function isStorageRootAuthorityError(error: unknown): error is StorageRootAuthorityError {
  return error instanceof StorageRootAuthorityError;
}

function requireHeadlessCapability(
  capability: DiscoveredStorageRootCapability,
): StorageRootCapability<'headless'> {
  if (capability.kind !== 'headless') {
    throw new StorageRootAuthorityError(
      'root_kind_mismatch',
      `Storage root ${capability.canonicalPath} is ${capability.kind}, not headless`,
    );
  }
  return capability;
}

function leaseBoundSynthesisCacheArtifactStore(
  lease: StorageRootLease<'headless', 'write'>,
): SynthesisCacheArtifactStore {
  const store = createArtifactStore(lease.canonicalPath);
  const run = <T>(operation: () => Promise<T>) =>
    runWithStorageRootLease(lease, 'headless', 'write', operation);
  const facade: SynthesisCacheArtifactStore = {
    create: (input) => run(() => store.create(input)),
    list: (sessionId, options) => run(() => store.list(sessionId, options)),
    readText: (artifactId, options) => run(() => store.readText(artifactId, options)),
  };
  return Object.freeze(facade);
}
