// packages/runtime/src/filesystem-executor.ts
// The single authority for where the built-in file tools may reach.
//
// One decision — the active ExecutionBoundary — picks the backend and the path
// scope; the tools carry no policy branch and no executor carries a containment
// rule of its own. Before this seam existed each file tool repeated the same
// worker-versus-executor branch, and the fallback executor hard-coded a session-cwd
// containment that no permission profile actually declares. A bypass boundary
// skipped the worker, so that undeclared rule became the only arbiter and made
// "full access" stricter than ask mode, which grants :slash_tmp outright (#2083).

import { Buffer } from 'node:buffer';
import { randomUUID } from 'node:crypto';
import { lstat, mkdir, open, realpath, rename, unlink } from 'node:fs/promises';
import { basename, dirname, isAbsolute, resolve } from 'node:path';
import type { ExecutionBoundary, PermissionMode, PermissionProfile } from '@maka/core';
import {
  executeApplyPatchWithAdapter,
  type ApplyPatchEngineResult,
  type ApplyPatchFsAdapter,
} from './apply-patch-engine.js';
import { computeEditedSource } from './edit-replace.js';
import { createUnifiedDiff } from './unified-diff.js';
import { withFileWriteLock } from './file-write-lock.js';
import { assertFilesystemEntryRevision, snapshotFilesystemEntry } from './filesystem-revision.js';
import type {
  FilesystemWorkerClient,
  FilesystemWorkerClientOperation,
} from './filesystem-worker/client.js';
import type { ImageMimeType } from './image-file.js';
import type { FilesystemWorkerResult } from './filesystem-worker/protocol.js';
import { normalizeSandboxBoundaryPath } from './sandbox-boundary-path.js';
import { isPathInside, realpathAllowMissing } from './path-containment.js';
import { SandboxCommandError } from './sandbox/errors.js';
import type {
  WorkspaceEditExecutor,
  WorkspacePathScope,
  WorkspaceSearchExecutor,
  WorkspaceWriteExecutor,
} from './workspace-executor.js';

/** A file operation, named the same way on every backend. `cwd` is supplied per call. */
export type FilesystemOperation = FilesystemWorkerClientOperation;

/**
 * The result shape every backend answers with.
 *
 * It is the worker protocol's union with one substitution: image bytes stay
 * bytes. Base64 is how the worker's JSON transport carries them, not part of
 * this contract, so the worker-backed backend decodes once at its own edge and
 * the host-local backend hands its buffer straight through.
 */
export type FilesystemResult =
  | Exclude<FilesystemWorkerResult, { kind: 'read_image' }>
  | { kind: 'read_image'; bytes: Uint8Array; mimeType: ImageMimeType };

export interface FilesystemExecuteInput {
  operation: FilesystemOperation;
  cwd: string;
  executionBoundary?: ExecutionBoundary;
  /** Only consulted when no boundary is present; the boundary always wins. */
  permissionMode?: PermissionMode;
  abortSignal?: AbortSignal;
}

export interface FilesystemApplyPatchInput {
  patch: string;
  cwd: string;
  executionBoundary?: ExecutionBoundary;
  permissionMode?: PermissionMode;
  abortSignal?: AbortSignal;
}

export interface FilesystemExecutor {
  /**
   * Run one operation under the authority of the boundary it carries. A mutating
   * operation holds the target's write lock for its whole read-modify-write, so
   * no caller has to know that a lock exists or how its key is spelled.
   */
  execute(input: FilesystemExecuteInput): Promise<FilesystemResult>;
  applyPatch(input: FilesystemApplyPatchInput): Promise<ApplyPatchEngineResult>;
}

/** The workspace primitives the host-local backend drives. */
export type FilesystemWorkspaceExecutor = WorkspaceWriteExecutor &
  WorkspaceEditExecutor &
  WorkspaceSearchExecutor;

export interface BoundaryFilesystemExecutorInput {
  workspace: FilesystemWorkspaceExecutor;
  worker?: Pick<FilesystemWorkerClient, 'execute'> &
    Partial<Pick<FilesystemWorkerClient, 'preflightApplyPatchWrites'>>;
  /** Explicit embedding policy handed to the worker instead of a mode default. */
  permissionProfile?: PermissionProfile;
}

/**
 * The path scope a boundary authorises.
 *
 * `bypass` is the user asking for no restrictions, and it already means exactly
 * that for Bash, which runs untransformed on the host under the same boundary.
 * Every other boundary — including a missing one, which is an embedder that
 * never opted in — stays workspace-scoped.
 */
function pathScopeForBoundary(boundary: ExecutionBoundary | undefined): WorkspacePathScope {
  return boundary?.kind === 'bypass' ? 'host' : 'workspace';
}

/** Operations that read, modify and write back, and so must hold the target's lock. */
function mutates(operation: FilesystemOperation): boolean {
  return (
    operation.kind === 'write' ||
    operation.kind === 'delete' ||
    operation.kind === 'edit' ||
    operation.kind === 'format_json'
  );
}

function mutatesDirectoryEntry(operation: FilesystemOperation): boolean {
  return (
    operation.kind === 'delete' || (operation.kind === 'write' && operation.mode !== undefined)
  );
}

/**
 * Compose the backends behind one boundary-driven decision.
 *
 * - `managed` → the sandboxed worker, which enforces the boundary's profile.
 * - `bypass` → host-local execution with host path scope.
 * - `external` → the injected workspace executor, whose own workspace is the
 *   whole filesystem it can address; it never falls back to host access.
 * - absent → the worker when one is wired, otherwise workspace-scoped local
 *   execution. This is the embedding default and deliberately the narrow one.
 */
export function createBoundaryFilesystemExecutor(
  input: BoundaryFilesystemExecutorInput,
): FilesystemExecutor {
  const local = createWorkspaceFilesystemExecutor(input.workspace);
  /** The worker that owns this boundary, or undefined when the workspace backend does. */
  const workerFor = (
    boundary: ExecutionBoundary | undefined,
  ):
    | (Pick<FilesystemWorkerClient, 'execute'> &
        Partial<Pick<FilesystemWorkerClient, 'preflightApplyPatchWrites'>>)
    | undefined => {
    if (boundary?.kind === 'bypass' || boundary?.kind === 'external') return undefined;
    if (input.worker) return input.worker;
    if (boundary?.kind !== 'managed') return undefined;
    throw new SandboxCommandError({
      domain: 'filesystem',
      stage: 'capability',
      reason: 'requires_bypass',
      recoverable: false,
      profileName: boundary.profile.name ?? boundary.profile.type,
      message:
        'Managed filesystem execution is unavailable because the sandboxed worker cannot be enforced.',
    });
  };
  async function run(call: FilesystemExecuteInput): Promise<FilesystemResult> {
    const worker = workerFor(call.executionBoundary);
    if (!worker) return await local.execute(call, pathScopeForBoundary(call.executionBoundary));
    const result = await worker.execute({
      operation: call.operation,
      // The worker is host-local by definition, so a session opened through a
      // symlinked cwd must reach it under the real path — otherwise the same
      // file arrives under two identities. The workspace backend is left the cwd
      // it was given: an isolated or remote workspace path is not the host's to
      // rewrite, and its own resolvers canonicalise what they need.
      cwd: await canonicalExistingPath(call.cwd),
      ...(call.executionBoundary ? { executionBoundary: call.executionBoundary } : {}),
      mode: call.permissionMode ?? 'ask',
      ...(input.permissionProfile ? { permissionProfile: input.permissionProfile } : {}),
      ...(call.abortSignal ? { abortSignal: call.abortSignal } : {}),
    });
    if (result.kind === 'read_image') {
      return {
        kind: 'read_image',
        bytes: Buffer.from(result.base64, 'base64'),
        mimeType: result.mimeType,
      };
    }
    return result;
  }
  async function directoryEntryLockKey(
    path: string,
    call: Omit<FilesystemApplyPatchInput, 'patch'>,
  ): Promise<string> {
    const worker = workerFor(call.executionBoundary);
    return await resolveDirectoryEntryPath({
      cwd: worker ? await canonicalExistingPath(call.cwd) : call.cwd,
      path,
      label: 'ApplyPatch lock',
      scope: worker ? 'host' : pathScopeForBoundary(call.executionBoundary),
    });
  }
  return {
    async execute(call) {
      if (!mutates(call.operation)) return await run(call);
      // Canonicalisation without any containment check, so a target the policy
      // goes on to reject still takes the same lock as its other spellings. The
      // key is derived from the same canonicalisation the backend will resolve
      // with, or the lock-key space and the resolved-path space drift apart.
      const worker = workerFor(call.executionBoundary);
      const key = worker
        ? mutatesDirectoryEntry(call.operation)
          ? await resolveDirectoryEntryPath({
              cwd: await canonicalExistingPath(call.cwd),
              path: call.operation.path,
              label: 'ApplyPatch lock',
              scope: 'host',
            })
          : (
              await normalizeSandboxBoundaryPath({
                path: call.operation.path,
                access: 'write',
                scope: 'exact',
                cwd: await canonicalExistingPath(call.cwd),
              })
            ).enforcementPath
        : mutatesDirectoryEntry(call.operation)
          ? await resolveDirectoryEntryPath({
              cwd: call.cwd,
              path: call.operation.path,
              label: 'ApplyPatch lock',
              scope: pathScopeForBoundary(call.executionBoundary),
            })
          : (await input.workspace.writeLockKey({ cwd: call.cwd, path: call.operation.path })).key;
      return await withFileWriteLock(key, () => run(call));
    },
    async applyPatch(call) {
      const common = {
        cwd: call.cwd,
        ...(call.executionBoundary ? { executionBoundary: call.executionBoundary } : {}),
        ...(call.permissionMode ? { permissionMode: call.permissionMode } : {}),
        ...(call.abortSignal ? { abortSignal: call.abortSignal } : {}),
      };
      const adapter: ApplyPatchFsAdapter = {
        lockKey: async (path) => await directoryEntryLockKey(path, common),
        preflightPermissions: async (intents) => {
          const worker = workerFor(call.executionBoundary);
          if (!worker) return;
          if (!worker.preflightApplyPatchWrites) {
            throw new Error('Managed ApplyPatch preflight is unavailable.');
          }
          await worker.preflightApplyPatchWrites({
            cwd: await canonicalExistingPath(call.cwd),
            intents,
            ...(call.executionBoundary ? { executionBoundary: call.executionBoundary } : {}),
            mode: call.permissionMode ?? 'ask',
            ...(input.permissionProfile ? { permissionProfile: input.permissionProfile } : {}),
            ...(call.abortSignal ? { abortSignal: call.abortSignal } : {}),
          });
        },
        snapshot: async (path) => {
          const inspected = await run({ operation: { kind: 'lstat', path }, ...common });
          if (inspected.kind !== 'lstat') throw new Error('ApplyPatch lstat result mismatch');
          if (inspected.targetType !== 'file') {
            return {
              state: {
                kind: inspected.targetType === 'directory' ? 'other' : inspected.targetType,
              },
              token: inspected.token,
            };
          }
          const read = await run({ operation: { kind: 'read', path }, ...common });
          if (read.kind !== 'read') throw new Error('ApplyPatch only supports UTF-8 text files');
          return { state: { kind: 'file', content: read.content }, token: inspected.token };
        },
        writeText: async (path, content, mode, expectedToken) => {
          const written = await run({
            operation: { kind: 'write', path, content, mode, expectedToken },
            ...common,
          });
          if (written.kind !== 'write' || !written.token) {
            throw new Error('ApplyPatch write result mismatch');
          }
          return { path: written.path, bytes: written.bytes, token: written.token };
        },
        deletePath: async (path, expectedToken) => {
          const deleted = await run({
            operation: { kind: 'delete', path, expectedToken },
            ...common,
          });
          if (deleted.kind !== 'delete') throw new Error('ApplyPatch delete result mismatch');
          return { path: deleted.path };
        },
      };
      return await executeApplyPatchWithAdapter(call.patch, adapter, withFileWriteLock);
    },
  };
}

interface WorkspaceFilesystemBackend {
  execute(input: FilesystemExecuteInput, scope: WorkspacePathScope): Promise<FilesystemResult>;
}

/**
 * Run an operation directly against the host (or an isolated workspace), with the
 * path scope the caller derived from the boundary. This backend enforces the
 * scope it is given and decides nothing else.
 */
function createWorkspaceFilesystemExecutor(
  workspace: FilesystemWorkspaceExecutor,
): WorkspaceFilesystemBackend {
  return {
    async execute({ operation, cwd, abortSignal }, scope) {
      switch (operation.kind) {
        case 'lstat': {
          const path = await resolveDirectoryEntryPath({
            cwd,
            path: operation.path,
            label: 'ApplyPatch lstat',
            scope,
          });
          try {
            const snapshot = await snapshotFilesystemEntry(path);
            return { kind: 'lstat', targetType: snapshot.targetType, token: snapshot.token };
          } catch (error) {
            const code = (error as NodeJS.ErrnoException).code;
            if (code === 'ENOENT' || code === 'ENOTDIR') {
              const snapshot = await snapshotFilesystemEntry(path);
              return { kind: 'lstat', targetType: 'missing', token: snapshot.token };
            }
            throw error;
          }
        }
        case 'read': {
          const { path } = await workspace.resolveExistingPath({
            cwd,
            path: operation.path,
            label: 'Read',
            scope,
          });
          const result = await workspace.readFile({
            cwd,
            path,
            ...(operation.offset !== undefined ? { offset: operation.offset } : {}),
            ...(operation.limit !== undefined ? { limit: operation.limit } : {}),
          });
          if ('bytes' in result) {
            return { kind: 'read_image', bytes: result.bytes, mimeType: result.mimeType };
          }
          return { kind: 'read', content: result.content };
        }
        case 'write': {
          const path = operation.mode
            ? await resolveDirectoryEntryPath({
                cwd,
                path: operation.path,
                label: `ApplyPatch ${operation.mode}`,
                scope,
              })
            : (
                await workspace.resolveWritablePath({
                  cwd,
                  path: operation.path,
                  label: 'Write',
                  scope,
                })
              ).path;
          // Read-before-write: an overwrite's diff is what tells the reader
          // what was lost. Only a missing file means the whole content is
          // new — an unreadable or binary existing file leaves the previous
          // state unknown, and claiming `--- /dev/null` would report the
          // file as created.
          let previous: 'new' | 'unknown' | string;
          try {
            const read = await workspace.readFile({ cwd, path });
            previous = 'bytes' in read ? 'unknown' : read.content;
          } catch (error) {
            const code = (error as NodeJS.ErrnoException).code;
            previous = code === 'ENOENT' || code === 'ENOTDIR' ? 'new' : 'unknown';
          }
          const written = operation.mode
            ? await writePatchFile(
                path,
                operation.content,
                operation.mode,
                operation.expectedToken ?? '',
              )
            : await workspace.writeFile({ cwd, path, content: operation.content });
          const diff =
            previous === 'unknown'
              ? undefined
              : createUnifiedDiff(
                  written.path,
                  previous === 'new' ? undefined : previous,
                  operation.content,
                );
          const token = operation.mode ? (await snapshotFilesystemEntry(path)).token : undefined;
          return {
            kind: 'write',
            ok: true,
            path: written.path,
            bytes: written.bytes,
            ...(token ? { token } : {}),
            ...(diff !== undefined ? { diff } : {}),
          };
        }
        case 'delete': {
          const path = await resolveDirectoryEntryPath({
            cwd,
            path: operation.path,
            label: 'ApplyPatch delete',
            scope,
          });
          await assertFilesystemEntryRevision(path, operation.expectedToken);
          await unlink(path);
          return { kind: 'delete', ok: true, path };
        }
        case 'edit': {
          const { path } = await workspace.resolveExistingPath({
            cwd,
            path: operation.path,
            label: 'Edit',
            scope,
          });
          const read = await workspace.readFile({ cwd, path });
          if ('bytes' in read) throw new Error('Edit does not support image files.');
          const edited = computeEditedSource(
            read.content,
            operation.oldString,
            operation.newString,
            operation.path,
          );
          await workspace.writeFile({ cwd, path, content: edited.content });
          const diff = createUnifiedDiff(path, read.content, edited.content);
          return {
            kind: 'edit',
            ok: true,
            path,
            replacements: 1,
            matchedVia: edited.matchedVia,
            startLine: edited.startLine,
            endLine: edited.endLine,
            ...(diff !== undefined ? { diff } : {}),
          };
        }
        case 'format_json': {
          const { path } = await workspace.resolveExistingPath({
            cwd,
            path: operation.path,
            label: 'FormatJson',
            scope,
          });
          const read = await workspace.readFile({ cwd, path });
          if ('bytes' in read) throw new Error('FormatJson does not support image files.');
          const original = read.content;
          const bytesBefore = Buffer.byteLength(original, 'utf8');
          let parsed: unknown;
          try {
            parsed = JSON.parse(original);
          } catch (error) {
            return {
              kind: 'format_json',
              ok: false,
              valid: false,
              error: `FormatJson: invalid JSON: ${(error as Error).message}`,
              path,
              bytesBefore,
              byteDelta: 0,
              changed: false,
            };
          }
          const value = operation.sortKeys ? sortKeysDeep(parsed) : parsed;
          const formatted = JSON.stringify(value, null, 2);
          const { bytes: bytesAfter } = await workspace.writeFile({
            cwd,
            path,
            content: formatted,
          });
          const diff =
            formatted === original ? undefined : createUnifiedDiff(path, original, formatted);
          return {
            kind: 'format_json',
            ok: true,
            valid: true,
            path,
            bytesBefore,
            bytesAfter,
            byteDelta: bytesAfter - bytesBefore,
            changed: formatted !== original,
            ...(diff !== undefined ? { diff } : {}),
          };
        }
        case 'glob': {
          assertGlobPatternInScope(operation.pattern, scope);
          const { path: base } = await workspace.resolveExistingPath({
            cwd,
            path: operation.path,
            label: 'Glob cwd',
            scope,
          });
          const { files } = await workspace.globFiles({
            cwd: base,
            pattern: operation.pattern,
            ...(operation.limit !== undefined ? { limit: operation.limit } : {}),
          });
          return { kind: 'glob', files };
        }
        case 'grep': {
          const { path } = await workspace.resolveExistingPath({
            cwd,
            path: operation.path,
            label: 'Grep',
            scope,
          });
          const { matches } = await workspace.grepFiles({
            cwd,
            pattern: operation.pattern,
            path,
            ...(operation.glob ? { glob: operation.glob } : {}),
            maxCountPerFile: operation.maxCountPerFile,
            limit: operation.limit,
            timeoutMs: operation.timeoutMs,
            ...(abortSignal ? { abortSignal } : {}),
          });
          return { kind: 'grep', matches };
        }
      }
    },
  };
}

/** Resolve a directory entry without following its final symlink. */
async function resolveDirectoryEntryPath(input: {
  cwd: string;
  path: string;
  label: string;
  scope: WorkspacePathScope;
}): Promise<string> {
  const root = await canonicalExistingPath(input.cwd);
  const candidate = isAbsolute(input.path) ? resolve(input.path) : resolve(input.cwd, input.path);
  const parent = await realpathAllowMissing(dirname(candidate));
  if (input.scope === 'workspace' && !isPathInside(root, parent)) {
    throw new Error(`${input.label} path must stay inside session cwd`);
  }
  return resolve(parent, basename(candidate));
}

async function writePatchFile(
  path: string,
  content: string,
  mode: 'create' | 'replace',
  expectedToken: string,
): Promise<{ ok: true; path: string; bytes: number; token: string }> {
  if (!expectedToken) throw new Error('Patch write requires an expected revision');
  await assertFilesystemEntryRevision(path, expectedToken);
  if (mode === 'create') {
    await mkdir(dirname(path), { recursive: true });
    await assertFilesystemEntryRevision(path, expectedToken);
    const handle = await open(path, 'wx');
    try {
      await handle.writeFile(content, 'utf8');
      await handle.sync();
    } catch (error) {
      await handle.close().catch(() => {});
      await unlink(path).catch(() => {});
      throw error;
    }
    await handle.close();
  } else {
    const metadata = await lstat(path);
    if (!metadata.isFile() || metadata.isSymbolicLink()) {
      throw new Error('ApplyPatch replace target is no longer a regular file');
    }
    const temp = resolve(dirname(path), `.maka-apply-patch-${process.pid}-${randomUUID()}.tmp`);
    const handle = await open(temp, 'wx', metadata.mode);
    try {
      await handle.writeFile(content, 'utf8');
      await handle.sync();
      await handle.close();
      await assertFilesystemEntryRevision(path, expectedToken);
      await rename(temp, path);
    } catch (error) {
      await handle.close().catch(() => {});
      await unlink(temp).catch(() => {});
      throw error;
    }
  }
  return {
    ok: true,
    path,
    bytes: Buffer.byteLength(content, 'utf8'),
    token: (await snapshotFilesystemEntry(path)).token,
  };
}

/**
 * A glob pattern is expanded by the walker rather than resolved as a path, so
 * its escapes have to be caught lexically. Under host scope there is nothing to
 * escape from and the pattern is left alone.
 */
function assertGlobPatternInScope(pattern: string, scope: WorkspacePathScope): void {
  if (scope === 'host') return;
  if (isAbsolute(pattern) || pattern.split(/[\\/]+/).includes('..')) {
    throw new Error('Glob pattern must stay inside session cwd');
  }
}

/** The canonical spelling of an existing directory, or the input when it is not resolvable here. */
async function canonicalExistingPath(path: string): Promise<string> {
  return await realpath(path).catch(() => path);
}

// Object.fromEntries creates own data properties, so special keys like
// "__proto__" are preserved instead of triggering the inherited setter.
function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value !== null && typeof value === 'object' && !(value instanceof Date)) {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, sortKeysDeep((value as Record<string, unknown>)[key])]),
    );
  }
  return value;
}
