import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { lstat, open, readFile, realpath, rename, unlink } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import type { PreparedFileMutationFact, PreparedFileBeforeState } from './tool-recovery-facts.js';
import {
  decidePreparedFileMutation,
  type CurrentFileCheckpointState,
} from './prepared-file-mutation.js';

// Phase 4A prototype only. Production Write/Edit currently use the Git-independent
// LocalFileCheckpointCarrier; this implementation is retained as plumbing evidence for the
// future workspace checkpoint provider and must not be treated as a configured host carrier.

interface PrepareGitFileMutationBaseInput {
  operationId: string;
  workspaceRoot: string;
  targetPath: string;
  transform: {
    id: string;
    version: number;
    argsHash: string;
  };
}

export type PrepareGitFileMutationInput = PrepareGitFileMutationBaseInput &
  (
    | {
        expectedContent: Uint8Array;
        deriveExpectedContent?: never;
      }
    | {
        expectedContent?: never;
        deriveExpectedContent(beforeContent: Uint8Array | undefined): Uint8Array;
      }
  );

export interface PreparedFileMutationCarrier {
  isAvailable?(workspaceRoot: string): Promise<boolean>;
  prepare(input: PrepareGitFileMutationInput): Promise<PreparedFileMutationFact>;
  redo(fact: PreparedFileMutationFact): Promise<void>;
}

export interface GitFileCheckpointCarrierOptions {
  gitBinary?: string;
  failpoint?: (point: GitFileCheckpointFailpoint, detail?: { tempPath?: string }) => void;
}

export type GitFileCheckpointFailpoint =
  | 'before_checkpoint_durable'
  | 'after_checkpoint_durable'
  | 'after_temp_write'
  | 'after_temp_fsync'
  | 'before_replace'
  | 'after_replace'
  | 'after_parent_fsync';

export class GitFileCheckpointCarrier implements PreparedFileMutationCarrier {
  private readonly gitBinary: string;
  private readonly failpoint?: (
    point: GitFileCheckpointFailpoint,
    detail?: { tempPath?: string },
  ) => void;

  constructor(options: GitFileCheckpointCarrierOptions = {}) {
    this.gitBinary = options.gitBinary ?? 'git';
    this.failpoint = options.failpoint;
  }

  async isAvailable(workspaceRoot: string): Promise<boolean> {
    try {
      const canonicalRoot = await realpath(workspaceRoot);
      return (
        (await this.git(canonicalRoot, ['rev-parse', '--is-inside-work-tree'])).trim() === 'true'
      );
    } catch {
      return false;
    }
  }

  async prepare(input: PrepareGitFileMutationInput): Promise<PreparedFileMutationFact> {
    const workspaceRoot = await realpath(input.workspaceRoot);
    const canonicalPath = await resolvePreparedTarget(workspaceRoot, input.targetPath);
    const relativePath = normalizeGitPath(relative(workspaceRoot, canonicalPath));
    if (!relativePath) throw new Error('Prepared file mutation target must be a file path');

    const repositoryCommonDirRaw = await this.git(workspaceRoot, [
      'rev-parse',
      '--path-format=absolute',
      '--git-common-dir',
    ]);
    const repositoryCommonDir = await realpath(repositoryCommonDirRaw.trim());
    const objectFormat = (
      await this.git(workspaceRoot, ['rev-parse', '--show-object-format']).catch(() => 'sha1')
    ).trim();
    if (objectFormat !== 'sha1' && objectFormat !== 'sha256') {
      throw new Error(`Unsupported Git object format: ${objectFormat}`);
    }

    let before: PreparedFileBeforeState;
    let beforeContent: Buffer | undefined;
    let mode = 0o100644;
    try {
      const info = await lstat(canonicalPath);
      if (!info.isFile() || info.isSymbolicLink()) {
        throw new Error('Prepared file mutation target must be a regular non-symlink file');
      }
      const content = await readFile(canonicalPath);
      beforeContent = content;
      mode = info.mode & 0o111 ? 0o100755 : 0o100644;
      before = {
        kind: 'file',
        sha256: sha256(content),
        blobOid: await this.writeBlob(workspaceRoot, content),
        byteLength: content.byteLength,
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
    const expectedAfter = {
      kind: 'file' as const,
      sha256: sha256(expectedContent),
      blobOid: await this.writeBlob(workspaceRoot, expectedContent),
      byteLength: expectedContent.byteLength,
      mode,
    };
    const treeEntries = [
      ...(before.kind === 'file'
        ? [`${before.mode.toString(8)} blob ${before.blobOid}\tbefore`]
        : []),
      `${expectedAfter.mode.toString(8)} blob ${expectedAfter.blobOid}\tafter`,
    ];
    const treeOid = (
      await this.git(workspaceRoot, ['mktree'], Buffer.from(`${treeEntries.join('\n')}\n`))
    ).trim();
    const commitOid = (
      await this.git(
        workspaceRoot,
        ['commit-tree', treeOid],
        Buffer.from(`Maka prepared file mutation ${input.operationId}\n`),
        checkpointIdentityEnv(),
      )
    ).trim();
    const retentionKey = createHash('sha256')
      .update(input.operationId)
      .update('\0')
      .update(canonicalPath)
      .digest('hex');
    const retentionRef = `refs/maka/checkpoints/operations/${retentionKey}`;
    this.failpoint?.('before_checkpoint_durable');
    await this.git(workspaceRoot, ['update-ref', retentionRef, commitOid]);
    const retainedCommit = (
      await this.git(workspaceRoot, ['rev-parse', '--verify', `${retentionRef}^{commit}`])
    ).trim();
    if (retainedCommit !== commitOid) {
      throw new Error('Git checkpoint retention ref did not resolve to the prepared commit');
    }
    this.failpoint?.('after_checkpoint_durable');

    return {
      protocol: 'prepared_file_mutation_v1',
      operationId: input.operationId,
      workspaceRoot,
      canonicalPath,
      relativePath,
      before,
      expectedAfter,
      transform: { ...input.transform },
      carrier: {
        kind: 'git_object_v1',
        repositoryCommonDir,
        retentionRef,
      },
    };
  }

  async inspect(fact: PreparedFileMutationFact): Promise<CurrentFileCheckpointState> {
    const workspaceRoot = await realpath(fact.workspaceRoot);
    const canonicalPath = resolve(fact.canonicalPath);
    if (!isPathWithin(workspaceRoot, canonicalPath)) {
      throw new Error('Prepared file mutation target escapes its recorded workspace');
    }
    await assertCanonicalParent(canonicalPath);
    try {
      const info = await lstat(canonicalPath);
      if (!info.isFile() || info.isSymbolicLink()) {
        throw new Error('Prepared file mutation target is no longer a regular file');
      }
      return { kind: 'file', sha256: sha256(await readFile(canonicalPath)) };
    } catch (error) {
      if (isNodeError(error) && error.code === 'ENOENT') return { kind: 'missing' };
      throw error;
    }
  }

  async redo(fact: PreparedFileMutationFact): Promise<void> {
    const initial = decidePreparedFileMutation(fact, await this.inspect(fact));
    if (initial.disposition === 'finalize') return;
    if (initial.disposition === 'park') {
      throw new PreparedFileMutationConflictError(initial.reasonCode);
    }
    const expectedBlobOid = fact.expectedAfter.blobOid;
    if (!expectedBlobOid) {
      throw new Error('Prepared file mutation has no Git after blob');
    }
    await this.validateCarrier(fact);
    const expectedContent = await runProcessBytes(
      this.gitBinary,
      ['cat-file', 'blob', expectedBlobOid],
      fact.workspaceRoot,
    );
    if (
      expectedContent.byteLength !== fact.expectedAfter.byteLength ||
      sha256(expectedContent) !== fact.expectedAfter.sha256
    ) {
      throw new Error('Prepared after blob does not match its durable identity');
    }

    const targetDir = dirname(fact.canonicalPath);
    const tempPath = join(
      targetDir,
      `.${basename(fact.canonicalPath)}.maka-${fact.operationId}-${randomUUID()}.tmp`,
    );
    let tempExists = false;
    try {
      const temp = await open(tempPath, 'wx', fact.expectedAfter.mode & 0o777);
      tempExists = true;
      try {
        await temp.writeFile(expectedContent);
        this.failpoint?.('after_temp_write', { tempPath });
        const installedTemp = await readFile(tempPath);
        if (
          installedTemp.byteLength !== fact.expectedAfter.byteLength ||
          sha256(installedTemp) !== fact.expectedAfter.sha256
        ) {
          throw new Error('Prepared temporary file does not match its durable after identity');
        }
        await temp.chmod(fact.expectedAfter.mode & 0o777);
        await temp.sync();
        this.failpoint?.('after_temp_fsync');
      } finally {
        await temp.close();
      }

      const revalidated = decidePreparedFileMutation(fact, await this.inspect(fact));
      if (revalidated.disposition === 'finalize') return;
      if (revalidated.disposition !== 'redo') {
        throw new PreparedFileMutationConflictError('prepared_file_drifted_before_replace');
      }
      this.failpoint?.('before_replace');
      await rename(tempPath, fact.canonicalPath);
      tempExists = false;
      this.failpoint?.('after_replace');
      await fsyncDirectory(targetDir);
      this.failpoint?.('after_parent_fsync');
      const installed = decidePreparedFileMutation(fact, await this.inspect(fact));
      if (installed.disposition !== 'finalize') {
        throw new Error('Atomic replace did not install the prepared after image');
      }
    } finally {
      if (tempExists) await unlink(tempPath).catch(() => undefined);
    }
  }

  private async writeBlob(cwd: string, content: Uint8Array): Promise<string> {
    return (
      await this.git(cwd, ['hash-object', '-w', '--no-filters', '--stdin'], Buffer.from(content))
    ).trim();
  }

  private git(
    cwd: string,
    args: string[],
    stdin?: Uint8Array,
    env?: NodeJS.ProcessEnv,
  ): Promise<string> {
    return runProcess(this.gitBinary, args, cwd, stdin, env);
  }

  private async validateCarrier(fact: PreparedFileMutationFact): Promise<void> {
    const carrier = fact.carrier;
    if (!carrier) throw new Error('Prepared file mutation has no Git carrier');
    const commonDir = await realpath(
      (
        await this.git(fact.workspaceRoot, [
          'rev-parse',
          '--path-format=absolute',
          '--git-common-dir',
        ])
      ).trim(),
    );
    if (commonDir !== (await realpath(carrier.repositoryCommonDir))) {
      throw new Error('Prepared file mutation repository identity changed');
    }
    const retained = (
      await this.git(fact.workspaceRoot, [
        'rev-parse',
        '--verify',
        `${carrier.retentionRef}^{commit}`,
      ])
    ).trim();
    if (!retained) throw new Error('Prepared file mutation retention ref is missing');
  }
}

export type { PreparedFileBeforeState };

function runProcess(
  command: string,
  args: string[],
  cwd: string,
  stdin?: Uint8Array,
  extraEnv?: NodeJS.ProcessEnv,
): Promise<string> {
  return runProcessBytes(command, args, cwd, stdin, extraEnv).then((output) =>
    output.toString('utf8'),
  );
}

function runProcessBytes(
  command: string,
  args: string[],
  cwd: string,
  stdin?: Uint8Array,
  extraEnv?: NodeJS.ProcessEnv,
): Promise<Buffer> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: { ...process.env, ...extraEnv },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) {
        resolvePromise(Buffer.concat(stdout));
        return;
      }
      reject(
        new Error(
          `${command} ${args.join(' ')} failed (${code ?? 'signal'}): ${Buffer.concat(stderr).toString('utf8').trim()}`,
        ),
      );
    });
    if (stdin) child.stdin.end(Buffer.from(stdin));
    else child.stdin.end();
  });
}

export class PreparedFileMutationConflictError extends Error {
  readonly name = 'PreparedFileMutationConflictError';

  constructor(readonly reasonCode: string) {
    super(`Prepared file mutation cannot be replayed safely: ${reasonCode}`);
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

function checkpointIdentityEnv(): NodeJS.ProcessEnv {
  return {
    GIT_AUTHOR_NAME: 'Maka Checkpoint',
    GIT_AUTHOR_EMAIL: 'noreply@localhost',
    GIT_COMMITTER_NAME: 'Maka Checkpoint',
    GIT_COMMITTER_EMAIL: 'noreply@localhost',
  };
}

function sha256(content: Uint8Array): string {
  return createHash('sha256').update(content).digest('hex');
}

function normalizeGitPath(path: string): string {
  return path.replaceAll('\\', '/');
}

function isPathWithin(root: string, candidate: string): boolean {
  const pathFromRoot = relative(resolve(root), resolve(candidate));
  return pathFromRoot === '' || (!pathFromRoot.startsWith('..') && !isAbsolute(pathFromRoot));
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
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

async function assertCanonicalParent(target: string): Promise<void> {
  const canonicalParent = await realpath(dirname(target));
  if (join(canonicalParent, basename(target)) !== target) {
    throw new Error('Prepared file mutation target parent identity changed');
  }
}
