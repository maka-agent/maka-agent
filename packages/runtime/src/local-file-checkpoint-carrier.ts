import { createHash, randomUUID } from 'node:crypto';
import { lstat, open, readFile, realpath, rename, unlink } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';

import {
  decidePreparedFileMutation,
  type CurrentFileCheckpointState,
} from './prepared-file-mutation.js';
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
  prepare(input: PrepareFileMutationInput): Promise<PreparedFileMutationFact>;
  inspect(fact: PreparedFileMutationFact): Promise<CurrentFileCheckpointState>;
  readCurrentContent(fact: PreparedFileMutationFact): Promise<Uint8Array | undefined>;
  apply(fact: PreparedFileMutationFact, expectedContent: Uint8Array): Promise<void>;
}

export interface LocalFileCheckpointCarrierOptions {
  failpoint?: (point: LocalFileCheckpointFailpoint, detail?: { tempPath?: string }) => void;
}

export type LocalFileCheckpointFailpoint =
  | 'after_checkpoint_computed'
  | 'after_temp_write'
  | 'after_temp_fsync'
  | 'before_replace'
  | 'after_replace'
  | 'after_parent_fsync';

export class LocalFileCheckpointCarrier implements PreparedFileMutationCarrier {
  constructor(private readonly options: LocalFileCheckpointCarrierOptions = {}) {}

  async supports(workspaceRoot: string, targetPath: string): Promise<boolean> {
    try {
      const canonicalRoot = await realpath(workspaceRoot);
      await resolvePreparedTarget(canonicalRoot, targetPath);
      return true;
    } catch {
      return false;
    }
  }

  async prepare(input: PrepareFileMutationInput): Promise<PreparedFileMutationFact> {
    const workspaceRoot = await realpath(input.workspaceRoot);
    const canonicalPath = await resolvePreparedTarget(workspaceRoot, input.targetPath);
    const relativePath = normalizePath(relative(workspaceRoot, canonicalPath));
    if (!relativePath) throw new Error('Prepared file mutation target must be a file path');

    let before: PreparedFileBeforeState;
    let beforeContent: Buffer | undefined;
    let mode = 0o100644;
    try {
      const info = await lstat(canonicalPath);
      if (!info.isFile() || info.isSymbolicLink()) {
        throw new Error('Prepared file mutation target must be a regular non-symlink file');
      }
      beforeContent = await readFile(canonicalPath);
      mode = info.mode & 0o111 ? 0o100755 : 0o100644;
      before = {
        kind: 'file',
        sha256: sha256(beforeContent),
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
      const info = await lstat(fact.canonicalPath);
      if (!info.isFile() || info.isSymbolicLink()) {
        throw new Error('Prepared file mutation target is no longer a regular file');
      }
      return { kind: 'file', sha256: sha256(await readFile(fact.canonicalPath)) };
    } catch (error) {
      if (isNodeError(error) && error.code === 'ENOENT') return { kind: 'missing' };
      throw error;
    }
  }

  async readCurrentContent(fact: PreparedFileMutationFact): Promise<Uint8Array | undefined> {
    const state = await this.inspect(fact);
    if (state.kind === 'missing') return undefined;
    const content = await readFile(fact.canonicalPath);
    if (sha256(content) !== state.sha256) {
      throw new LocalFileMutationConflictError('prepared_file_changed_while_reading');
    }
    return content;
  }

  async apply(fact: PreparedFileMutationFact, expectedContentInput: Uint8Array): Promise<void> {
    const expectedContent = Buffer.from(expectedContentInput);
    if (
      expectedContent.byteLength !== fact.expectedAfter.byteLength ||
      sha256(expectedContent) !== fact.expectedAfter.sha256
    ) {
      throw new Error('Regenerated after image does not match its durable checkpoint identity');
    }
    const initial = decidePreparedFileMutation(fact, await this.inspect(fact));
    if (initial.disposition === 'finalize') return;
    if (initial.disposition === 'park') {
      throw new LocalFileMutationConflictError(initial.reasonCode);
    }

    const targetDir = dirname(fact.canonicalPath);
    const tempPath = join(
      targetDir,
      `.${basename(fact.canonicalPath)}.maka-${fact.operationId}-${randomUUID()}.tmp`,
    );
    let tempExists = false;
    try {
      const temp = await open(tempPath, 'wx+', fact.expectedAfter.mode & 0o777);
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
        await temp.chmod(fact.expectedAfter.mode & 0o777);
        await temp.sync();
        this.options.failpoint?.('after_temp_fsync', { tempPath });
      } finally {
        await temp.close();
      }

      const revalidated = decidePreparedFileMutation(fact, await this.inspect(fact));
      if (revalidated.disposition === 'finalize') return;
      if (revalidated.disposition !== 'redo') {
        throw new LocalFileMutationConflictError('prepared_file_drifted_before_replace');
      }
      this.options.failpoint?.('before_replace', { tempPath });
      await rename(tempPath, fact.canonicalPath);
      tempExists = false;
      this.options.failpoint?.('after_replace');
      await fsyncDirectory(targetDir);
      this.options.failpoint?.('after_parent_fsync');
      if (decidePreparedFileMutation(fact, await this.inspect(fact)).disposition !== 'finalize') {
        throw new Error('Atomic replace did not install the prepared after image');
      }
    } finally {
      if (tempExists) await unlink(tempPath).catch(() => undefined);
    }
  }
}

export class LocalFileMutationConflictError extends Error {
  readonly name = 'LocalFileMutationConflictError';

  constructor(readonly reasonCode: string) {
    super(`Prepared file mutation cannot be replayed safely: ${reasonCode}`);
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
