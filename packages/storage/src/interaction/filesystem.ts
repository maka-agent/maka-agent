import { randomUUID } from 'node:crypto';
import { constants, type Dirent } from 'node:fs';
import { link, lstat, mkdir, open, readdir, rmdir, unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { syncDirectoryChain } from '../stable-storage.js';
import { InteractionStoreError, invalidRecord, ioFailed } from './errors.js';

const INTERACTION_DIRECTORY = 'interactions';
const LOCATOR_PATTERN = /^[0-9a-f]{64}$/;
const TEMP_PATTERN =
  /^(?:request|outcome)\.json\.[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.tmp$/;
const READ_CHUNK_BYTES = 64 * 1024;

export type InteractionDocumentName = 'request.json' | 'outcome.json';

export interface InteractionLocatorInspection {
  readonly hasRequest: boolean;
  readonly hasOutcome: boolean;
  readonly temporaryArtifacts: readonly string[];
}

export type InteractionPublicationAttempt =
  | { readonly kind: 'link_not_attempted'; readonly failure: InteractionStoreError }
  | { readonly kind: 'inspect_canonical'; readonly diagnostic?: InteractionStoreError };

export type InteractionLocatorRemoval = 'removed' | 'missing' | 'not_empty';

export class InteractionFilesystem {
  readonly root: string;
  readonly interactionsRoot: string;

  constructor(root: string) {
    this.root = resolve(root);
    this.interactionsRoot = join(this.root, INTERACTION_DIRECTORY);
  }

  async ensureInteractionsRootForWrite(): Promise<boolean> {
    let created = false;
    try {
      await mkdir(this.interactionsRoot, { mode: 0o700 });
      created = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
        throw ioFailed('Interaction directory could not be created', error);
      }
    }
    await assertRealDirectory(this.interactionsRoot, 'Interaction directory');
    return created;
  }

  async prepareLocatorForWrite(locator: string): Promise<void> {
    assertLocator(locator);
    await this.ensureInteractionsRootForWrite();
    const directory = this.locatorDirectory(locator);
    try {
      await mkdir(directory, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
        throw ioFailed(`Interaction locator '${locator}' could not be created`, error);
      }
    }
    await assertRealDirectory(directory, `Interaction locator '${locator}'`);
  }

  async listLocators(): Promise<string[]> {
    if (!(await this.assertInteractionsRootForRead())) return [];
    let entries;
    try {
      entries = await readdir(this.interactionsRoot, { withFileTypes: true });
    } catch (error) {
      throw ioFailed('Interactions could not be listed', error);
    }
    const locators: string[] = [];
    for (const entry of entries) {
      if (!LOCATOR_PATTERN.test(entry.name)) {
        throw invalidRecord(`Interaction directory contains unexpected entry '${entry.name}'`);
      }
      if (!entry.isDirectory() || entry.isSymbolicLink()) {
        throw invalidRecord(`Interaction locator '${entry.name}' must be a real directory`);
      }
      locators.push(entry.name);
    }
    return locators.sort((left, right) => left.localeCompare(right));
  }

  async inspectLocator(locator: string): Promise<InteractionLocatorInspection | undefined> {
    assertLocator(locator);
    if (!(await this.assertInteractionsRootForRead())) return undefined;
    if (!(await this.assertLocatorForRead(locator))) return undefined;
    let artifacts: Dirent[];
    try {
      artifacts = await readdir(this.locatorDirectory(locator), { withFileTypes: true });
    } catch (error) {
      if (isMissing(error)) return undefined;
      throw ioFailed(`Interaction locator '${locator}' could not be listed`, error);
    }

    let hasRequest = false;
    let hasOutcome = false;
    const temporaryArtifacts: string[] = [];
    for (const artifact of artifacts) {
      if (artifact.name === 'request.json' || artifact.name === 'outcome.json') {
        if (!artifact.isFile() || artifact.isSymbolicLink()) {
          throw invalidRecord(`Interaction ${artifact.name} must be a regular file`);
        }
        hasRequest ||= artifact.name === 'request.json';
        hasOutcome ||= artifact.name === 'outcome.json';
        continue;
      }
      if (!TEMP_PATTERN.test(artifact.name)) {
        throw invalidRecord(
          `Interaction locator '${locator}' contains unexpected artifact '${artifact.name}'`,
        );
      }
      if (!artifact.isFile() || artifact.isSymbolicLink()) {
        throw invalidRecord('Interaction temporary artifacts must be regular files');
      }
      temporaryArtifacts.push(artifact.name);
    }
    return {
      hasRequest,
      hasOutcome,
      temporaryArtifacts: temporaryArtifacts.sort((left, right) => left.localeCompare(right)),
    };
  }

  async readDocument(
    locator: string,
    file: InteractionDocumentName,
    maxBytes: number,
  ): Promise<unknown | undefined> {
    assertLocator(locator);
    if (!(await this.assertInteractionsRootForRead())) return undefined;
    if (!(await this.assertLocatorForRead(locator))) return undefined;
    const path = this.documentPath(locator, file);
    if (process.platform === 'win32') {
      const metadata = await lstatIfPresent(path, `Interaction ${file}`);
      if (!metadata) return undefined;
      if (!metadata.isFile() || metadata.isSymbolicLink()) {
        throw invalidRecord(`Interaction ${file} must be a regular file`);
      }
    }
    const flags =
      process.platform === 'win32'
        ? constants.O_RDONLY
        : constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
    let handle;
    try {
      handle = await open(path, flags);
    } catch (error) {
      if (isMissing(error)) return undefined;
      if (process.platform !== 'win32' && (error as NodeJS.ErrnoException).code === 'ELOOP') {
        throw invalidRecord(`Interaction ${file} must not be a symbolic link`, error);
      }
      throw ioFailed(`Interaction ${file} could not be opened`, error);
    }

    let result: unknown | undefined;
    let failure: unknown;
    try {
      const metadata = await handle.stat();
      if (!metadata.isFile()) throw invalidRecord(`Interaction ${file} must be a regular file`);
      if (metadata.size > maxBytes) {
        throw invalidRecord(`Interaction ${file} exceeds its ${maxBytes} byte limit`);
      }
      const chunks: Buffer[] = [];
      let total = 0;
      for (;;) {
        const remaining = maxBytes + 1 - total;
        if (remaining <= 0)
          throw invalidRecord(`Interaction ${file} exceeds its ${maxBytes} byte limit`);
        const buffer = Buffer.allocUnsafe(Math.min(READ_CHUNK_BYTES, remaining));
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, total);
        if (bytesRead === 0) break;
        total += bytesRead;
        chunks.push(buffer.subarray(0, bytesRead));
      }
      let text: string;
      try {
        text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, total));
      } catch (error) {
        throw invalidRecord(`Interaction ${file} is not valid UTF-8`, error);
      }
      try {
        result = JSON.parse(text) as unknown;
      } catch (error) {
        throw invalidRecord(`Interaction ${file} is not valid JSON`, error);
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
      if (failure instanceof InteractionStoreError) throw failure;
      throw ioFailed(`Interaction ${file} could not be read`, failure);
    }
    return result;
  }

  async publishExclusive(
    locator: string,
    file: InteractionDocumentName,
    bytes: Buffer,
  ): Promise<InteractionPublicationAttempt> {
    assertLocator(locator);
    const path = this.documentPath(locator, file);
    const temporaryArtifact = `${file}.${randomUUID()}.tmp`;
    const temporaryPath = join(this.locatorDirectory(locator), temporaryArtifact);
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    let temporaryCreated = false;
    let stageFailure: unknown;
    try {
      handle = await open(temporaryPath, 'wx', 0o600);
      temporaryCreated = true;
      await handle.writeFile(bytes);
      await handle.sync();
    } catch (error) {
      stageFailure = error;
    } finally {
      try {
        await handle?.close();
      } catch (error) {
        stageFailure ??= error;
      }
    }

    if (stageFailure !== undefined) {
      let cleanupFailure: unknown;
      if (temporaryCreated) {
        try {
          await unlink(temporaryPath);
        } catch (error) {
          if (!isMissing(error)) cleanupFailure = error;
        }
      }
      return {
        kind: 'link_not_attempted',
        failure: ioFailed(
          `Interaction ${file} I/O failed before the publication link`,
          combineFailures(stageFailure, cleanupFailure),
        ),
      };
    }

    let diagnostic: InteractionStoreError | undefined;
    try {
      await link(temporaryPath, path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
        diagnostic = ioFailed(`Interaction ${file} link outcome could not be determined`, error);
      }
    }
    try {
      await unlink(temporaryPath);
    } catch (error) {
      if (!isMissing(error)) {
        diagnostic = ioFailed(
          `Interaction ${file} temporary artifact could not be removed`,
          combineFailures(diagnostic, error),
        );
      }
    }
    return diagnostic === undefined
      ? { kind: 'inspect_canonical' }
      : { kind: 'inspect_canonical', diagnostic };
  }

  async removeTemporaryArtifact(locator: string, artifact: string): Promise<void> {
    assertLocator(locator);
    if (!TEMP_PATTERN.test(artifact))
      throw invalidRecord('Interaction temporary artifact is invalid');
    try {
      await unlink(join(this.locatorDirectory(locator), artifact));
    } catch (error) {
      if (isMissing(error)) return;
      throw ioFailed('Interaction temporary artifact could not be removed', error);
    }
  }

  async removeLocator(locator: string): Promise<InteractionLocatorRemoval> {
    assertLocator(locator);
    try {
      await rmdir(this.locatorDirectory(locator));
      return 'removed';
    } catch (error) {
      if (isMissing(error)) return 'missing';
      if (isNotEmpty(error)) return 'not_empty';
      throw ioFailed(`Interaction locator '${locator}' could not be removed`, error);
    }
  }

  async syncLocatorDirectory(locator: string): Promise<void> {
    assertLocator(locator);
    await this.syncDirectory(
      this.locatorDirectory(locator),
      `Interaction locator '${locator}' could not be synchronized`,
    );
  }

  async syncInteractionsDirectory(): Promise<void> {
    await this.syncDirectory(
      this.interactionsRoot,
      'Interaction directory could not be synchronized',
    );
  }

  private locatorDirectory(locator: string): string {
    return join(this.interactionsRoot, locator);
  }

  private documentPath(locator: string, file: InteractionDocumentName): string {
    return join(this.locatorDirectory(locator), file);
  }

  private async assertInteractionsRootForRead(): Promise<boolean> {
    try {
      await assertRealDirectory(this.interactionsRoot, 'Interaction directory');
      return true;
    } catch (error) {
      if (error instanceof InteractionStoreError && error.cause && isMissing(error.cause))
        return false;
      throw error;
    }
  }

  private async assertLocatorForRead(locator: string): Promise<boolean> {
    try {
      await assertRealDirectory(this.locatorDirectory(locator), `Interaction locator '${locator}'`);
      return true;
    } catch (error) {
      if (error instanceof InteractionStoreError && error.cause && isMissing(error.cause))
        return false;
      throw error;
    }
  }

  private async syncDirectory(directory: string, message: string): Promise<void> {
    try {
      await syncDirectoryChain(directory, this.root);
    } catch (error) {
      throw ioFailed(message, error);
    }
  }
}

async function assertRealDirectory(path: string, context: string): Promise<void> {
  let metadata;
  try {
    metadata = await lstat(path);
  } catch (error) {
    throw ioFailed(`${context} could not be inspected`, error);
  }
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw invalidRecord(`${context} must be a real directory`);
  }
}

async function lstatIfPresent(
  path: string,
  context: string,
): Promise<Awaited<ReturnType<typeof lstat>> | undefined> {
  try {
    return await lstat(path);
  } catch (error) {
    if (isMissing(error)) return undefined;
    throw ioFailed(`${context} could not be inspected`, error);
  }
}

function combineFailures(primary: unknown, secondary: unknown): unknown {
  if (secondary === undefined) return primary;
  return new AggregateError(
    [primary, secondary],
    'Multiple Interaction filesystem operations failed',
  );
}

function assertLocator(locator: string): void {
  if (!LOCATOR_PATTERN.test(locator)) throw invalidRecord('Interaction locator is invalid');
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT';
}

function isNotEmpty(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code === 'ENOTEMPTY' || code === 'EEXIST';
}
