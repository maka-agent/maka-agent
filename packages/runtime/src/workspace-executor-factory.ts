import type { PermissionMode } from '@maka/core/permission';
import type { CompiledPermissionProfile } from '@maka/core/permission-profile-compiler';
import { buildBuiltinTools, type BuildBuiltinToolsOptions } from './builtin-tools.js';
import type { SandboxPathContext, SandboxPlatform, SandboxablePreference } from './sandbox/index.js';
import { createPermissionAwareSandboxContext } from './sandbox/permission-aware-context.js';
import type { PermissionAwareSandboxContext } from './sandbox/permission-aware-context.js';
import { FilesystemWorkerClient } from './filesystem-worker/client.js';
import {
  ProfileEnforcedFileOperations,
  WorkerBackedWorkspaceFileOperations,
} from './filesystem-worker/workspace-file-operations.js';
import {
  createLocalWorkspaceExecutor,
  SandboxedCommandWorkspaceExecutor,
  type WorkspaceCommandRunner,
  type WorkspaceCommandSandboxManager,
  type WorkspaceBashExecutor,
  type WorkspaceExecutor,
  type WorkspaceFileOperations,
} from './workspace-executor.js';

export interface CreatePermissionAwareWorkspaceExecutorInput {
  mode: PermissionMode;
  cwd: string;
  workspaceRoots?: readonly string[];
  inner?: WorkspaceExecutor;
  sandboxManager?: WorkspaceCommandSandboxManager;
  sandboxPreference?: SandboxablePreference;
  platform?: SandboxPlatform;
  pathContext?: Partial<Omit<SandboxPathContext, 'workspaceRoots'>>;
  runProcess?: WorkspaceCommandRunner;
  filesystemWorkerClient?: FilesystemWorkerClient;
  fileOperations?: WorkspaceFileOperations;
}

export interface PermissionAwareWorkspaceExecutorAssembly {
  commandExecutor: WorkspaceBashExecutor;
  fileOperations: WorkspaceFileOperations;
  compiledProfile: CompiledPermissionProfile;
  sandboxManager: WorkspaceCommandSandboxManager;
  sandboxContext: PermissionAwareSandboxContext;
}

export interface BuildPermissionAwareBuiltinToolsInput
  extends CreatePermissionAwareWorkspaceExecutorInput,
    Omit<BuildBuiltinToolsOptions, 'executor' | 'commandExecutor' | 'fileOperations'> {}

export interface PermissionAwareBuiltinToolsAssembly extends PermissionAwareWorkspaceExecutorAssembly {
  tools: ReturnType<typeof buildBuiltinTools>;
}

export function createPermissionAwareWorkspaceExecutor(
  input: CreatePermissionAwareWorkspaceExecutorInput,
): PermissionAwareWorkspaceExecutorAssembly {
  const builtContext = createPermissionAwareSandboxContext({
    mode: input.mode,
    cwd: input.cwd,
    ...(input.workspaceRoots ? { workspaceRoots: input.workspaceRoots } : {}),
    ...(input.sandboxManager ? { sandboxManager: input.sandboxManager } : {}),
    ...(input.sandboxPreference ? { preference: input.sandboxPreference } : {}),
    ...(input.platform ? { platform: input.platform } : {}),
    ...(input.pathContext ? { pathContext: input.pathContext } : {}),
  });
  const { compiledProfile, context } = builtContext;
  const workspaceRoots = compiledProfile.workspaceRoots;
  const sandboxManager = context.sandboxManager;
  const pathContext = context.pathContext;

  const local = input.inner ?? createLocalWorkspaceExecutor();
  const sandboxedCommands = new SandboxedCommandWorkspaceExecutor({
    inner: local,
    getSandboxContext: () => ({
      profile: context.profile,
      workspaceRoots,
      sandboxManager,
      ...(context.preference ? { preference: context.preference } : {}),
      ...(context.platform ? { platform: context.platform } : {}),
      pathContext,
    }),
    ...(input.runProcess ? { runProcess: input.runProcess } : {}),
  });
  if (input.filesystemWorkerClient && input.fileOperations) {
    throw new Error('Provide filesystemWorkerClient or fileOperations, not both.');
  }
  const workerOperations = input.filesystemWorkerClient
    ? new WorkerBackedWorkspaceFileOperations({ client: input.filesystemWorkerClient, context })
    : input.fileOperations;
  if (!workerOperations) {
    throw new Error('Permission-aware tools require sandboxed filesystemWorkerClient or explicit fileOperations.');
  }
  const fileOperations = new ProfileEnforcedFileOperations({
    inner: workerOperations,
    getProfileContext: () => ({
      profile: compiledProfile.profile,
      workspaceRoots,
      cwd: context.cwd,
      pathContext,
    }),
  });

  return {
    commandExecutor: sandboxedCommands,
    fileOperations,
    compiledProfile,
    sandboxManager,
    sandboxContext: context,
  };
}

export function buildPermissionAwareBuiltinTools(
  input: BuildPermissionAwareBuiltinToolsInput,
): PermissionAwareBuiltinToolsAssembly {
  const assembly = createPermissionAwareWorkspaceExecutor(input);
  return {
    ...assembly,
    tools: buildBuiltinTools({
      ...(input.shellRuns ? { shellRuns: input.shellRuns } : {}),
      commandExecutor: assembly.commandExecutor,
      fileOperations: assembly.fileOperations,
      additionalPermissionPlanningContext: {
        profile: assembly.compiledProfile.profile,
        workspaceRoots: assembly.compiledProfile.workspaceRoots,
        pathContext: assembly.sandboxContext.pathContext,
      },
    }),
  };
}
