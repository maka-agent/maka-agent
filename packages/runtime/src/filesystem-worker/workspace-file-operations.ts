import {
  canReadPath,
  canWritePath,
  type PermissionProfile,
  type PermissionProfileMatchContext,
} from '@maka/core/permission-profile';
import { applyAdditionalPermissionProfile } from '@maka/core/additional-permissions';

import type { PermissionAwareSandboxContext } from '../sandbox/permission-aware-context.js';
import { normalizeSandboxMatchPath } from '../sandbox/permission-aware-context.js';
import {
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
import {
  resolveAdditionalPermissionCandidate,
  type ToolExecutionPermissionContext,
} from '../additional-permissions.js';

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
      ...(input.permissionContext?.additionalGrant ? {
        additionalPermissions: input.permissionContext.additionalGrant.profile,
        permissionsHash: input.permissionContext.additionalGrant.permissionsHash,
      } : {}),
    });
    if (result.kind !== 'read') throw new Error('Filesystem worker returned a mismatched Read result.');
    return { content: result.content };
  }

  async write(input: WorkspaceWriteInput): Promise<WorkspaceWriteResult> {
    const result = await this.input.client.execute({
      context: this.input.context,
      operation: { kind: 'write', path: input.path, content: input.content },
      ...(input.permissionContext?.additionalGrant ? {
        additionalPermissions: input.permissionContext.additionalGrant.profile,
        permissionsHash: input.permissionContext.additionalGrant.permissionsHash,
      } : {}),
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
      ...(input.permissionContext?.additionalGrant ? {
        additionalPermissions: input.permissionContext.additionalGrant.profile,
        permissionsHash: input.permissionContext.additionalGrant.permissionsHash,
      } : {}),
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
      ...(input.permissionContext?.additionalGrant ? {
        additionalPermissions: input.permissionContext.additionalGrant.profile,
        permissionsHash: input.permissionContext.additionalGrant.permissionsHash,
      } : {}),
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
      ...(input.permissionContext?.additionalGrant ? {
        additionalPermissions: input.permissionContext.additionalGrant.profile,
        permissionsHash: input.permissionContext.additionalGrant.permissionsHash,
      } : {}),
      ...(input.abortSignal ? { abortSignal: input.abortSignal } : {}),
    });
    if (result.kind !== 'grep') throw new Error('Filesystem worker returned a mismatched Grep result.');
    return { matches: result.matches };
  }

  async writeLockKey(input: WorkspaceWriteLockKeyInput): Promise<WorkspaceWriteLockKeyResult> {
    const candidate = resolveAdditionalPermissionCandidate(
      this.input.context.cwd,
      input.path,
      input.permissionContext,
    );
    return {
      key: normalizeSandboxMatchPath(candidate, this.input.context.pathContext),
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
    this.assertCanRead(input.cwd, input.path, 'read', input.permissionContext);
    return await this.input.inner.read(input);
  }

  async write(input: WorkspaceWriteInput): Promise<WorkspaceWriteResult> {
    this.assertCanWrite(input.cwd, input.path, input.permissionContext);
    return await this.input.inner.write(input);
  }

  async edit(input: WorkspaceEditInput): Promise<WorkspaceEditResult> {
    this.assertCanRead(input.cwd, input.path, 'read', input.permissionContext);
    this.assertCanWrite(input.cwd, input.path, input.permissionContext);
    return await this.input.inner.edit(input);
  }

  async glob(input: WorkspaceGlobOperationInput): Promise<WorkspaceGlobResult> {
    this.assertCanRead(input.cwd, input.path, 'search', input.permissionContext);
    return await this.input.inner.glob(input);
  }

  async grep(input: WorkspaceGrepOperationInput): Promise<WorkspaceGrepResult> {
    this.assertCanRead(input.cwd, input.path, 'search', input.permissionContext);
    return await this.input.inner.grep(input);
  }

  async writeLockKey(input: WorkspaceWriteLockKeyInput): Promise<WorkspaceWriteLockKeyResult> {
    this.assertCanWrite(input.cwd, input.path, input.permissionContext);
    return await this.input.inner.writeLockKey(input);
  }

  private assertCanRead(
    cwd: string,
    path: string,
    operation: 'read' | 'search',
    permissionContext: ToolExecutionPermissionContext | undefined = undefined,
  ): void {
    const { profile, matchContext, candidate } = this.matchInput(cwd, path, operation, permissionContext);
    if (canReadPath(profile, candidate, matchContext)) return;
    throw profileError(profile, operation, candidate, 'read_denied');
  }

  private assertCanWrite(
    cwd: string,
    path: string,
    permissionContext: ToolExecutionPermissionContext | undefined = undefined,
  ): void {
    const { profile, matchContext, candidate } = this.matchInput(cwd, path, 'write', permissionContext);
    if (canWritePath(profile, candidate, matchContext)) return;
    throw profileError(profile, 'write', candidate, 'write_denied');
  }

  private matchInput(
    cwd: string,
    path: string,
    operation: 'read' | 'write' | 'search',
    permissionContext?: ToolExecutionPermissionContext,
  ): {
    profile: PermissionProfile;
    matchContext: PermissionProfileMatchContext;
    candidate: string;
  } {
    const context = this.requireContext(operation, path);
    const canonicalCwd = context.cwd ?? cwd;
    const additional = permissionContext?.additionalGrant?.profile;
    const pathContext = context.pathContext ?? {};
    return {
      profile: additional ? applyAdditionalPermissionProfile(context.profile, additional) : context.profile,
      candidate: normalizeSandboxMatchPath(
        resolveAdditionalPermissionCandidate(canonicalCwd, path, permissionContext),
        pathContext,
      ),
      matchContext: {
        ...pathContext,
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
