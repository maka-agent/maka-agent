import { createHash } from 'node:crypto';
import { constants as fsConstants, type Stats } from 'node:fs';
import { lstat, open, readFile, realpath, rename, unlink } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import type { PermissionMode, PermissionProfile } from '@maka/core';
import type { AdditionalPermissionGrant } from './additional-permissions.js';

import {
  decidePreparedFileMutation,
  type CurrentFileCheckpointState,
} from './prepared-file-mutation.js';
import { DurableToolExecutionUnsettledError } from './durable-tool-execution.js';
import type { PreparedFileBeforeState, PreparedFileMutationFact } from './tool-recovery-facts.js';

interface PrepareFileMutationBaseInput {
  operationId: string;
  workspaceRoot: string;
  targetPath: string;
  transform: {
    id: string;
    version: number;
    argsHash: string;
  };
}

export type PrepareFileMutationInput = PrepareFileMutationBaseInput &
  (
    | { expectedContent: Uint8Array; deriveExpectedContent?: never }
    | {
        expectedContent?: never;
        deriveExpectedContent(beforeContent: Uint8Array | undefined): Uint8Array;
      }
  );

export interface PreparedFileMutationCarrier {
  supports?(workspaceRoot: string, targetPath: string): Promise<boolean>;
  /** Canonicalize the independently trusted workspace root for recovery binding. */
  resolveWorkspaceIdentity(workspaceRoot: string): Promise<string>;
  /** Resolve a tool argument to the same workspace-bounded identity stored in its checkpoint. */
  resolveTargetIdentity(workspaceRoot: string, targetPath: string): Promise<string>;
  prepare(input: PrepareFileMutationInput): Promise<PreparedFileMutationFact>;
  inspect(fact: PreparedFileMutationFact): Promise<CurrentFileCheckpointState>;
  readCurrentContent(fact: PreparedFileMutationFact): Promise<Uint8Array | undefined>;
  apply(
    fact: PreparedFileMutationFact,
    expectedContent: Uint8Array,
    context?: PreparedFileMutationExecutionContext,
  ): Promise<void>;
  finalize(
    fact: PreparedFileMutationFact,
    context?: PreparedFileMutationExecutionContext,
  ): Promise<void>;
}

export interface PreparedFileMutationExecutionContext {
  cwd: string;
  mode: PermissionMode;
  permissionProfile?: PermissionProfile;
  additionalGrant?: AdditionalPermissionGrant;
  abortSignal?: AbortSignal;
}

export interface LocalFileCheckpointCarrierOptions {
  failpoint?: (point: LocalFileCheckpointFailpoint, detail?: { tempPath?: string }) => void;
  /** Hard safety/performance limit for either side of a prepared file transaction. */
  maxFileBytes?: number;
  /** Test/platform override; production uses the current process platform. */
  platform?: NodeJS.Platform;
  /** Test seam for Windows' replace behavior. */
  replaceFile?: (source: string, target: string) => Promise<void>;
  /** Test seam for parent-directory durability failures. */
  syncDirectory?: (path: string) => Promise<void>;
}

export const DEFAULT_PREPARED_FILE_MAX_BYTES = 32 * 1024 * 1024;

export type LocalFileCheckpointFailpoint =
  | 'after_checkpoint_computed'
  | 'after_temp_write'
  | 'after_temp_fsync'
  | 'before_replace'
  | 'after_replace'
  | 'after_parent_fsync';

export class LocalFileCheckpointCarrier implements PreparedFileMutationCarrier {
  private readonly maxFileBytes: number;
  private readonly platform: NodeJS.Platform;

  constructor(private readonly options: LocalFileCheckpointCarrierOptions = {}) {
    this.maxFileBytes = options.maxFileBytes ?? DEFAULT_PREPARED_FILE_MAX_BYTES;
    this.platform = options.platform ?? process.platform;
    if (!Number.isSafeInteger(this.maxFileBytes) || this.maxFileBytes < 0) {
      throw new TypeError('Prepared file checkpoint maxFileBytes must be a non-negative integer');
    }
  }

  async supports(workspaceRoot: string, targetPath: string): Promise<boolean> {
    try {
      await this.resolveTargetIdentity(workspaceRoot, targetPath);
      return true;
    } catch {
      return false;
    }
  }

  async resolveWorkspaceIdentity(workspaceRoot: string): Promise<string> {
    return await realpath(workspaceRoot);
  }

  async resolveTargetIdentity(workspaceRoot: string, targetPath: string): Promise<string> {
    const canonicalRoot = await this.resolveWorkspaceIdentity(workspaceRoot);
    return await resolvePreparedTargetIdentity(canonicalRoot, targetPath);
  }

  async prepare(input: PrepareFileMutationInput): Promise<PreparedFileMutationFact> {
    if (input.expectedContent !== undefined) {
      this.assertWithinLimit(input.expectedContent.byteLength, 'expected-after');
    }
    const workspaceRoot = await realpath(input.workspaceRoot);
    const canonicalPath = await resolvePreparedTarget(workspaceRoot, input.targetPath);
    const relativePath = normalizePath(relative(workspaceRoot, canonicalPath));
    if (!relativePath) throw new Error('Prepared file mutation target must be a file path');

    let before: PreparedFileBeforeState;
    let beforeContent: Buffer | undefined;
    let mode = this.platform === 'win32' ? 0o666 : 0o666 & ~process.umask();
    try {
      const snapshot = await readBoundedFile(canonicalPath, this.maxFileBytes, 'before');
      if (snapshot.nlink > 1) {
        throw new Error('Prepared file mutation target must not be hard-linked');
      }
      beforeContent = snapshot.content;
      mode = this.platform === 'win32' ? 0o666 : snapshot.mode & 0o7777;
      before = {
        kind: 'file',
        sha256: snapshot.sha256,
        byteLength: beforeContent.byteLength,
        mode,
      };
    } catch (error) {
      if (!isNodeError(error) || error.code !== 'ENOENT') throw error;
      before = { kind: 'missing' };
    }

    const expectedContent = Buffer.from(
      input.expectedContent !== undefined
        ? input.expectedContent
        : input.deriveExpectedContent(beforeContent),
    );
    this.assertWithinLimit(expectedContent.byteLength, 'expected-after');
    const fact: PreparedFileMutationFact = {
      protocol: 'prepared_file_mutation_v1',
      operationId: input.operationId,
      workspaceRoot,
      canonicalPath,
      relativePath,
      before,
      expectedAfter: {
        kind: 'file',
        sha256: sha256(expectedContent),
        byteLength: expectedContent.byteLength,
        mode,
      },
      transform: { ...input.transform },
    };
    // The fact becomes durable only when ToolRuntime commits it in the T1 bundle.
    this.options.failpoint?.('after_checkpoint_computed');
    return fact;
  }

  async inspect(fact: PreparedFileMutationFact): Promise<CurrentFileCheckpointState> {
    await validateFactPath(fact);
    try {
      const snapshot = await readBoundedFile(fact.canonicalPath, this.maxFileBytes, 'current');
      if (snapshot.nlink > 1) {
        throw new LocalFileMutationConflictError('prepared_file_became_hard_linked');
      }
      return {
        kind: 'file',
        sha256: snapshot.sha256,
        ...(this.platform === 'win32' ? {} : { mode: snapshot.mode & 0o7777 }),
      };
    } catch (error) {
      if (isNodeError(error) && error.code === 'ENOENT') {
        return await this.inspectMissingState(fact);
      }
      throw error;
    }
  }

  async readCurrentContent(fact: PreparedFileMutationFact): Promise<Uint8Array | undefined> {
    await validateFactPath(fact);
    try {
      return (await readBoundedFile(fact.canonicalPath, this.maxFileBytes, 'current')).content;
    } catch (error) {
      if (isNodeError(error) && error.code === 'ENOENT') return undefined;
      throw error;
    }
  }

  async apply(fact: PreparedFileMutationFact, expectedContentInput: Uint8Array): Promise<void> {
    const expectedContent = Buffer.from(expectedContentInput);
    this.assertWithinLimit(expectedContent.byteLength, 'expected-after');
    if (
      expectedContent.byteLength !== fact.expectedAfter.byteLength ||
      sha256(expectedContent) !== fact.expectedAfter.sha256
    ) {
      throw new Error('Regenerated after image does not match its durable checkpoint identity');
    }
    const tempPath = operationTempPath(fact);
    const beforeBackupPath = operationBeforeBackupPath(fact);
    // A process crash bypasses finally blocks. A deterministic per-operation name lets the
    // authoritative retry remove exactly its own orphan without scanning or guessing in the
    // user's workspace, and bounds repeated crashes to one temp file per operation.
    await removeIfPresent(tempPath);
    const initialState = await this.inspect(fact);
    const recoveringFromBeforeBackup =
      initialState.kind === 'missing' &&
      fact.before.kind === 'file' &&
      initialState.recoverableBeforeBackupSha256 === fact.before.sha256;
    const initial = decidePreparedFileMutation(fact, initialState);
    if (initial.disposition === 'finalize') {
      await this.finalize(fact);
      return;
    }
    if (initial.disposition === 'park') {
      throw new LocalFileMutationConflictError(initial.reasonCode);
    }

    const targetDir = dirname(fact.canonicalPath);
    let tempExists = false;
    let replaceAttempted = false;
    let replaceCompleted = false;
    try {
      const temp = await open(tempPath, 'wx+', fact.expectedAfter.mode & 0o7777);
      tempExists = true;
      try {
        await temp.writeFile(expectedContent);
        this.options.failpoint?.('after_temp_write', { tempPath });
        const written = await readFile(tempPath);
        if (
          written.byteLength !== fact.expectedAfter.byteLength ||
          sha256(written) !== fact.expectedAfter.sha256
        ) {
          throw new Error('Prepared temporary file does not match its durable after identity');
        }
        await temp.chmod(fact.expectedAfter.mode & 0o7777);
        await temp.sync();
        this.options.failpoint?.('after_temp_fsync', { tempPath });
      } finally {
        await temp.close();
      }

      // This failpoint is intentionally before the last state observation: tests and
      // crash injectors that mutate the target at the replacement boundary must still
      // be covered by the final drift check.
      this.options.failpoint?.('before_replace', { tempPath });
      const revalidated = decidePreparedFileMutation(fact, await this.inspect(fact));
      if (revalidated.disposition === 'finalize') return;
      if (revalidated.disposition !== 'redo') {
        throw new LocalFileMutationConflictError('prepared_file_drifted_before_replace');
      }
      if (this.platform === 'win32' && fact.before.kind === 'file') {
        await this.ensureBeforeBackup(fact, beforeBackupPath);
        const backedUpState = decidePreparedFileMutation(fact, await this.inspect(fact));
        if (backedUpState.disposition !== 'redo') {
          throw new LocalFileMutationConflictError('prepared_file_drifted_after_backup');
        }
      }
      replaceAttempted = true;
      await (this.options.replaceFile ?? rename)(tempPath, fact.canonicalPath);
      replaceCompleted = true;
      tempExists = false;
      this.options.failpoint?.('after_replace');
      await (this.options.syncDirectory ?? fsyncDirectory)(targetDir);
      this.options.failpoint?.('after_parent_fsync');
      await this.finalize(fact);
      // The temp bytes were verified before rename. A successful same-directory rename installs
      // that exact inode; rereading the full target here would add another hash pass without
      // closing the external-writer race that exists after any observation.
    } catch (error) {
      if (replaceAttempted) {
        throw new DurableToolExecutionUnsettledError(
          replaceCompleted ? 'effect_applied_not_durable' : 'effect_may_have_started',
          error,
        );
      }
      if (!recoveringFromBeforeBackup) await removeIfPresent(beforeBackupPath);
      throw error;
    } finally {
      if (tempExists) await unlink(tempPath).catch(() => undefined);
    }
  }

  async finalize(fact: PreparedFileMutationFact): Promise<void> {
    const current = await this.inspect(fact);
    if (decidePreparedFileMutation(fact, current).disposition !== 'finalize') {
      throw new LocalFileMutationConflictError('prepared_file_finalize_target_changed');
    }
    const tempPath = operationTempPath(fact);
    const beforeBackupPath = operationBeforeBackupPath(fact);
    await removeVerifiedAuxiliaryFile(
      tempPath,
      fact.expectedAfter.sha256,
      this.maxFileBytes,
      'prepared_file_temp_cleanup_conflict',
    );
    if (fact.before.kind === 'file') {
      await removeVerifiedAuxiliaryFile(
        beforeBackupPath,
        fact.before.sha256,
        this.maxFileBytes,
        'prepared_file_backup_cleanup_conflict',
      );
    } else {
      await assertAuxiliaryMissing(beforeBackupPath, 'prepared_file_unexpected_backup_conflict');
    }
    await (this.options.syncDirectory ?? fsyncDirectory)(dirname(fact.canonicalPath));
  }

  private assertWithinLimit(
    byteLength: number,
    side: 'before' | 'current' | 'expected-after',
  ): void {
    if (byteLength > this.maxFileBytes) {
      throw new PreparedFileCheckpointLimitError(side, byteLength, this.maxFileBytes);
    }
  }

  private async inspectMissingState(
    fact: PreparedFileMutationFact,
  ): Promise<CurrentFileCheckpointState> {
    if (this.platform !== 'win32' || fact.before.kind !== 'file') return { kind: 'missing' };
    try {
      const backup = await readBoundedFile(
        operationBeforeBackupPath(fact),
        this.maxFileBytes,
        'current',
      );
      return {
        kind: 'missing',
        recoverableBeforeBackupSha256: backup.sha256,
        recoverableBeforeBackupMode: 0o666,
      };
    } catch (error) {
      if (isNodeError(error) && error.code === 'ENOENT') return { kind: 'missing' };
      throw error;
    }
  }

  private async ensureBeforeBackup(
    fact: PreparedFileMutationFact,
    backupPath: string,
  ): Promise<void> {
    if (fact.before.kind !== 'file') return;
    try {
      const current = await readBoundedFile(fact.canonicalPath, this.maxFileBytes, 'current');
      if (current.sha256 !== fact.before.sha256) {
        throw new LocalFileMutationConflictError('prepared_file_drifted_before_backup');
      }
      await removeIfPresent(backupPath);
      const backup = await open(backupPath, 'wx+', 0o600);
      try {
        await backup.writeFile(current.content);
        await backup.sync();
      } finally {
        await backup.close();
      }
      await (this.options.syncDirectory ?? fsyncDirectory)(dirname(backupPath));
    } catch (error) {
      if (isNodeError(error) && error.code === 'ENOENT') {
        const backup = await readBoundedFile(backupPath, this.maxFileBytes, 'current').catch(
          (backupError) => {
            if (isNodeError(backupError) && backupError.code === 'ENOENT') {
              throw new LocalFileMutationConflictError('prepared_file_missing_before_backup');
            }
            throw backupError;
          },
        );
        if (backup.sha256 === fact.before.sha256) return;
        throw new LocalFileMutationConflictError('prepared_file_before_backup_drifted');
      }
      throw error;
    }
  }
}

export class LocalFileMutationConflictError extends Error {
  readonly name = 'LocalFileMutationConflictError';

  constructor(readonly reasonCode: string) {
    super(`Prepared file mutation cannot be replayed safely: ${reasonCode}`);
  }
}

export class PreparedFileCheckpointLimitError extends Error {
  readonly name = 'PreparedFileCheckpointLimitError';
  readonly reasonCode = 'prepared_file_checkpoint_size_limit_exceeded';

  constructor(
    readonly side: 'before' | 'current' | 'expected-after',
    readonly byteLength: number,
    readonly maxFileBytes: number,
  ) {
    super(
      `Prepared file checkpoint ${side} image is ${byteLength} bytes; limit is ${maxFileBytes}`,
    );
  }
}

export function preparedFileMutationAuxiliaryPaths(fact: PreparedFileMutationFact): {
  tempPath: string;
  beforeBackupPath: string;
  parentDirectory: string;
} {
  return {
    tempPath: operationTempPath(fact),
    beforeBackupPath: operationBeforeBackupPath(fact),
    parentDirectory: dirname(fact.canonicalPath),
  };
}

function operationTempPath(fact: PreparedFileMutationFact): string {
  const operationKey = createHash('sha256').update(fact.operationId).digest('hex').slice(0, 32);
  return join(
    dirname(fact.canonicalPath),
    `.${basename(fact.canonicalPath)}.maka-${operationKey}.tmp`,
  );
}

function operationBeforeBackupPath(fact: PreparedFileMutationFact): string {
  const operationKey = createHash('sha256').update(fact.operationId).digest('hex').slice(0, 32);
  return join(
    dirname(fact.canonicalPath),
    `.${basename(fact.canonicalPath)}.maka-before-${operationKey}.bak`,
  );
}

async function removeIfPresent(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch (error) {
    if (!isNodeError(error) || error.code !== 'ENOENT') throw error;
  }
}

async function resolvePreparedTarget(workspaceRoot: string, targetPath: string): Promise<string> {
  const candidate = resolve(workspaceRoot, targetPath);
  if (!isPathWithin(workspaceRoot, candidate)) {
    throw new Error('Prepared file mutation target escapes the workspace');
  }
  try {
    const info = await lstat(candidate);
    if (info.isSymbolicLink()) {
      throw new Error('Prepared file mutation target must not be a symlink');
    }
    const canonical = await realpath(candidate);
    if (!isPathWithin(workspaceRoot, canonical)) {
      throw new Error('Prepared file mutation target escapes the workspace');
    }
    return canonical;
  } catch (error) {
    if (!isNodeError(error) || error.code !== 'ENOENT') throw error;
    const canonicalParent = await realpath(dirname(candidate));
    if (!isPathWithin(workspaceRoot, canonicalParent)) {
      throw new Error('Prepared file mutation target escapes the workspace');
    }
    return join(canonicalParent, basename(candidate));
  }
}

async function resolvePreparedTargetIdentity(
  workspaceRoot: string,
  targetPath: string,
): Promise<string> {
  const candidate = resolve(workspaceRoot, targetPath);
  if (!isPathWithin(workspaceRoot, candidate)) {
    throw new Error('Prepared file mutation target escapes the workspace');
  }
  const canonicalParent = await realpath(dirname(candidate));
  if (!isPathWithin(workspaceRoot, canonicalParent)) {
    throw new Error('Prepared file mutation target escapes the workspace');
  }
  // The durable identity is the canonical parent plus the final path component.
  // Do not dereference the final component here: recovery must keep the prepared
  // target identity stable when that component is replaced by a symlink, then
  // let bounded observation reject the symlink with its explicit diagnostic.
  return join(canonicalParent, basename(candidate));
}

async function validateFactPath(fact: PreparedFileMutationFact): Promise<void> {
  const workspaceRoot = await realpath(fact.workspaceRoot);
  const target = resolve(fact.canonicalPath);
  if (!isPathWithin(workspaceRoot, target)) {
    throw new Error('Prepared file mutation target escapes its recorded workspace');
  }
  const canonicalParent = await realpath(dirname(target));
  if (join(canonicalParent, basename(target)) !== target) {
    throw new Error('Prepared file mutation target parent identity changed');
  }
}

async function fsyncDirectory(path: string): Promise<void> {
  let directory;
  try {
    directory = await open(path, 'r');
    await directory.sync();
  } catch (error) {
    if (
      process.platform === 'win32' &&
      isNodeError(error) &&
      ['EACCES', 'EINVAL', 'EISDIR', 'ENOTSUP', 'EPERM'].includes(error.code ?? '')
    ) {
      return;
    }
    throw error;
  } finally {
    await directory?.close().catch(() => undefined);
  }
}

function sha256(content: Uint8Array): string {
  return createHash('sha256').update(content).digest('hex');
}

async function readBoundedFile(
  path: string,
  maxFileBytes: number,
  side: 'before' | 'current',
): Promise<{
  content: Buffer;
  sha256: string;
  mode: number;
  nlink: number;
  dev: number;
  ino: number;
}> {
  const pathInfoBefore = await lstat(path);
  assertRegularNonSymlink(pathInfoBefore);
  const openFlags =
    fsConstants.O_RDONLY | (process.platform === 'win32' ? 0 : (fsConstants.O_NOFOLLOW ?? 0));
  const file = await open(path, openFlags);
  try {
    const info = await file.stat();
    assertRegularNonSymlink(info);
    if (!sameFileIdentity(pathInfoBefore, info)) {
      throw new LocalFileMutationConflictError('prepared_file_identity_changed_during_observation');
    }
    if (info.size > maxFileBytes) {
      throw new PreparedFileCheckpointLimitError(side, info.size, maxFileBytes);
    }
    const hash = createHash('sha256');
    const chunks: Buffer[] = [];
    let byteLength = 0;
    while (true) {
      const remaining = maxFileBytes - byteLength;
      const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, remaining + 1));
      const { bytesRead } = await file.read(chunk, 0, chunk.length, null);
      if (bytesRead === 0) break;
      byteLength += bytesRead;
      if (byteLength > maxFileBytes) {
        throw new PreparedFileCheckpointLimitError(side, byteLength, maxFileBytes);
      }
      const bytes = chunk.subarray(0, bytesRead);
      hash.update(bytes);
      chunks.push(Buffer.from(bytes));
    }
    const handleInfoAfter = await file.stat();
    let pathInfoAfter: Stats;
    try {
      pathInfoAfter = await lstat(path);
    } catch (error) {
      if (isNodeError(error) && ['ENOENT', 'ENOTDIR'].includes(error.code ?? '')) {
        throw new LocalFileMutationConflictError(
          'prepared_file_identity_changed_during_observation',
        );
      }
      throw error;
    }
    assertRegularNonSymlink(pathInfoAfter);
    if (
      !sameFileIdentity(info, handleInfoAfter) ||
      !sameFileIdentity(handleInfoAfter, pathInfoAfter) ||
      info.size !== handleInfoAfter.size ||
      info.mtimeMs !== handleInfoAfter.mtimeMs ||
      info.ctimeMs !== handleInfoAfter.ctimeMs
    ) {
      throw new LocalFileMutationConflictError('prepared_file_identity_changed_during_observation');
    }
    return {
      content: Buffer.concat(chunks, byteLength),
      sha256: hash.digest('hex'),
      mode: handleInfoAfter.mode,
      nlink: handleInfoAfter.nlink,
      dev: handleInfoAfter.dev,
      ino: handleInfoAfter.ino,
    };
  } finally {
    await file.close();
  }
}

function assertRegularNonSymlink(info: Stats): void {
  if (info.isSymbolicLink()) {
    throw new LocalFileMutationConflictError('prepared_file_became_symbolic_link');
  }
  if (!info.isFile()) {
    throw new Error('Prepared file mutation target must be a regular file');
  }
}

function sameFileIdentity(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

async function removeVerifiedAuxiliaryFile(
  path: string,
  expectedSha256: string,
  maxFileBytes: number,
  conflictReason: string,
): Promise<void> {
  let snapshot: Awaited<ReturnType<typeof readBoundedFile>>;
  try {
    snapshot = await readBoundedFile(path, maxFileBytes, 'current');
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') return;
    if (error instanceof LocalFileMutationConflictError) throw error;
    throw new LocalFileMutationConflictError(conflictReason);
  }
  if (snapshot.sha256 !== expectedSha256) {
    throw new LocalFileMutationConflictError(conflictReason);
  }
  const current = await lstat(path).catch((error) => {
    if (isNodeError(error) && error.code === 'ENOENT') return undefined;
    throw error;
  });
  if (!current) return;
  assertRegularNonSymlink(current);
  if (current.dev !== snapshot.dev || current.ino !== snapshot.ino) {
    throw new LocalFileMutationConflictError(conflictReason);
  }
  await unlink(path);
}

async function assertAuxiliaryMissing(path: string, conflictReason: string): Promise<void> {
  try {
    await lstat(path);
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') return;
    throw error;
  }
  throw new LocalFileMutationConflictError(conflictReason);
}

function normalizePath(path: string): string {
  return path.replaceAll('\\', '/');
}

function isPathWithin(root: string, candidate: string): boolean {
  const pathFromRoot = relative(resolve(root), resolve(candidate));
  return pathFromRoot === '' || (!pathFromRoot.startsWith('..') && !isAbsolute(pathFromRoot));
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}
