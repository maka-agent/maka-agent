import { isAbsolute, relative, resolve } from 'node:path';
import {
  canReadPath,
  canWritePath,
  type PermissionProfile,
  type PermissionProfileMatchContext,
} from '@maka/core/permission-profile';

import type { PermissionAwareSandboxContext } from '../sandbox/permission-aware-context.js';
import {
  WorkspaceFilePathValidationError,
  WorkspaceProfilePermissionError,
  type WorkspaceEditInput,
  type WorkspaceEditResult,
  type WorkspaceExecutorFacts,
  type WorkspaceFileOperations,
  type WorkspaceGlobOperationInput,
  type WorkspaceGlobResult,
  type WorkspaceGrepOperationInput,
  type WorkspaceGrepResult,
  type WorkspaceProfileEnforcementContext,
  type WorkspaceProfileEnforcementContextProvider,
  type WorkspaceReadInput,
  type WorkspaceReadResult,
  type WorkspaceWriteInput,
  type WorkspaceWriteLockKeyInput,
  type WorkspaceWriteLockKeyResult,
  type WorkspaceWriteResult,
} from '../workspace-executor.js';
import { FilesystemWorkerClient } from './client.js';

export const SANDBOXED_WORKSPACE_FILE_FACTS: WorkspaceExecutorFacts = {
  isolation: 'platform_sandbox',
  writesAffectHost: true,
  writeBack: 'direct',
  network: 'disabled',
  secrets: 'none',
};

export class WorkerBackedWorkspaceFileOperations implements WorkspaceFileOperations {
  readonly facts = SANDBOXED_WORKSPACE_FILE_FACTS;

  constructor(private readonly input: {
    client: Pick<FilesystemWorkerClient, 'execute'>;
    context: PermissionAwareSandboxContext;
  }) {}

  async read(input: WorkspaceReadInput): Promise<WorkspaceReadResult> {
    const result = await this.input.client.execute({
      context: this.input.context,
      operation: {
        kind: 'read',
        path: input.path,
        ...(input.offset !== undefined ? { offset: input.offset } : {}),
        ...(input.limit !== undefined ? { limit: input.limit } : {}),
      },
    });
    if (result.kind !== 'read') throw new Error('Filesystem worker returned a mismatched Read result.');
    return { content: result.content };
  }

  async write(input: WorkspaceWriteInput): Promise<WorkspaceWriteResult> {
    const result = await this.input.client.execute({
      context: this.input.context,
      operation: { kind: 'write', path: input.path, content: input.content },
    });
    if (result.kind !== 'write') throw new Error('Filesystem worker returned a mismatched Write result.');
    return { ok: result.ok, path: result.path, bytes: result.bytes };
  }

  async edit(input: WorkspaceEditInput): Promise<WorkspaceEditResult> {
    const result = await this.input.client.execute({
      context: this.input.context,
      operation: {
        kind: 'edit',
        path: input.path,
        oldString: input.oldString,
        newString: input.newString,
      },
    });
    if (result.kind !== 'edit') throw new Error('Filesystem worker returned a mismatched Edit result.');
    return {
      ok: result.ok,
      path: result.path,
      replacements: result.replacements,
      matchedVia: result.matchedVia,
      startLine: result.startLine,
      endLine: result.endLine,
    };
  }

  async glob(input: WorkspaceGlobOperationInput): Promise<WorkspaceGlobResult> {
    const result = await this.input.client.execute({
      context: this.input.context,
      operation: {
        kind: 'glob',
        path: input.path,
        pattern: input.pattern,
        ...(input.limit !== undefined ? { limit: input.limit } : {}),
      },
    });
    if (result.kind !== 'glob') throw new Error('Filesystem worker returned a mismatched Glob result.');
    return { files: result.files };
  }

  async grep(input: WorkspaceGrepOperationInput): Promise<WorkspaceGrepResult> {
    const result = await this.input.client.execute({
      context: this.input.context,
      operation: {
        kind: 'grep',
        path: input.path,
        pattern: input.pattern,
        ...(input.glob ? { glob: input.glob } : {}),
        maxCountPerFile: input.maxCountPerFile,
        limit: input.limit,
        timeoutMs: input.timeoutMs,
      },
      ...(input.abortSignal ? { abortSignal: input.abortSignal } : {}),
    });
    if (result.kind !== 'grep') throw new Error('Filesystem worker returned a mismatched Grep result.');
    return { matches: result.matches };
  }

  async writeLockKey(input: WorkspaceWriteLockKeyInput): Promise<WorkspaceWriteLockKeyResult> {
    return {
      key: relativeCandidate({
        cwd: this.input.context.cwd,
        path: input.path,
        label: 'Write lock',
        operation: 'write',
        profileName: this.input.context.profile.name,
      }),
    };
  }
}

export class ProfileEnforcedFileOperations implements WorkspaceFileOperations {
  readonly facts: WorkspaceExecutorFacts;

  constructor(private readonly input: {
    inner: WorkspaceFileOperations;
    getProfileContext: WorkspaceProfileEnforcementContextProvider;
  }) {
    this.facts = input.inner.facts;
  }

  async read(input: WorkspaceReadInput): Promise<WorkspaceReadResult> {
    this.assertCanRead(input.path, 'read');
    return await this.input.inner.read(input);
  }

  async write(input: WorkspaceWriteInput): Promise<WorkspaceWriteResult> {
    this.assertCanWrite(input.path);
    return await this.input.inner.write(input);
  }

  async edit(input: WorkspaceEditInput): Promise<WorkspaceEditResult> {
    this.assertCanRead(input.path, 'read');
    this.assertCanWrite(input.path);
    return await this.input.inner.edit(input);
  }

  async glob(input: WorkspaceGlobOperationInput): Promise<WorkspaceGlobResult> {
    this.assertCanRead(input.path, 'search');
    return await this.input.inner.glob(input);
  }

  async grep(input: WorkspaceGrepOperationInput): Promise<WorkspaceGrepResult> {
    this.assertCanRead(input.path, 'search');
    return await this.input.inner.grep(input);
  }

  async writeLockKey(input: WorkspaceWriteLockKeyInput): Promise<WorkspaceWriteLockKeyResult> {
    this.assertCanWrite(input.path);
    return await this.input.inner.writeLockKey(input);
  }

  private assertCanRead(path: string, operation: 'read' | 'search'): void {
    const { profile, matchContext, candidate } = this.matchInput(path, operation);
    if (canReadPath(profile, candidate, matchContext)) return;
    throw profileError(profile, operation, candidate, 'read_denied');
  }

  private assertCanWrite(path: string): void {
    const { profile, matchContext, candidate } = this.matchInput(path, 'write');
    if (canWritePath(profile, candidate, matchContext)) return;
    throw profileError(profile, 'write', candidate, 'write_denied');
  }

  private matchInput(path: string, operation: 'read' | 'write' | 'search'): {
    profile: PermissionProfile;
    matchContext: PermissionProfileMatchContext;
    candidate: string;
  } {
    const context = this.requireContext(operation, path);
    const cwd = context.workspaceRoots[0]!;
    return {
      profile: context.profile,
      candidate: relativeCandidate({
        cwd,
        path,
        label: operation,
        operation,
        profileName: context.profile.name,
      }),
      matchContext: {
        ...context.pathContext,
        workspaceRoots: context.workspaceRoots,
      },
    };
  }

  private requireContext(
    operation: 'read' | 'write' | 'search',
    path: string,
  ): WorkspaceProfileEnforcementContext {
    const context = this.input.getProfileContext();
    if (!context) {
      throw new WorkspaceProfilePermissionError({ operation, path, reason: 'missing_context' });
    }
    if (context.workspaceRoots.length === 0) {
      throw new WorkspaceProfilePermissionError({
        operation,
        path,
        reason: 'missing_workspace_roots',
        profileName: context.profile.name,
      });
    }
    return context;
  }
}

function relativeCandidate(input: {
  cwd: string;
  path: string;
  label: string;
  operation: 'read' | 'write' | 'search';
  profileName?: string;
}): string {
  const candidate = resolve(input.cwd, input.path);
  if (isAbsolute(input.path)) {
    throw new WorkspaceFilePathValidationError({
      operation: input.operation,
      path: candidate,
      profileName: input.profileName,
      message: `${input.label} path must be relative to session cwd`,
    });
  }
  const rel = relative(input.cwd, candidate);
  if (rel !== '' && (rel.startsWith('..') || isAbsolute(rel))) {
    throw new WorkspaceFilePathValidationError({
      operation: input.operation,
      path: candidate,
      profileName: input.profileName,
      message: `${input.label} path must stay inside session cwd`,
    });
  }
  return candidate;
}

function profileError(
  profile: PermissionProfile,
  operation: 'read' | 'write' | 'search',
  path: string,
  reason: 'read_denied' | 'write_denied',
): WorkspaceProfilePermissionError {
  return new WorkspaceProfilePermissionError({
    operation,
    path,
    reason,
    profileName: profile.name,
  });
}
