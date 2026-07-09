import { tmpdir as osTmpdir } from 'node:os';
import type { PermissionMode } from '@maka/core/permission';
import {
  compilePermissionProfile,
  type CompiledPermissionProfile,
} from '@maka/core/permission-profile-compiler';
import { buildBuiltinTools, type BuildBuiltinToolsOptions } from './builtin-tools.js';
import { createDefaultSandboxManager, type SandboxPathContext, type SandboxPlatform, type SandboxablePreference } from './sandbox/index.js';
import {
  createLocalWorkspaceExecutor,
  ProfileEnforcedWorkspaceExecutor,
  SandboxedCommandWorkspaceExecutor,
  type WorkspaceCommandRunner,
  type WorkspaceCommandSandboxManager,
  type WorkspaceExecutor,
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
}

export interface PermissionAwareWorkspaceExecutorAssembly {
  executor: WorkspaceExecutor;
  compiledProfile: CompiledPermissionProfile;
  sandboxManager: WorkspaceCommandSandboxManager;
}

export interface BuildPermissionAwareBuiltinToolsInput
  extends CreatePermissionAwareWorkspaceExecutorInput,
    Omit<BuildBuiltinToolsOptions, 'executor'> {}

export interface PermissionAwareBuiltinToolsAssembly extends PermissionAwareWorkspaceExecutorAssembly {
  tools: ReturnType<typeof buildBuiltinTools>;
}

export function createPermissionAwareWorkspaceExecutor(
  input: CreatePermissionAwareWorkspaceExecutorInput,
): PermissionAwareWorkspaceExecutorAssembly {
  const compiledProfile = compilePermissionProfile({
    mode: input.mode,
    cwd: input.cwd,
    ...(input.workspaceRoots ? { workspaceRoots: input.workspaceRoots } : {}),
  });
  const workspaceRoots = compiledProfile.workspaceRoots;
  const sandboxManager = input.sandboxManager ?? createDefaultSandboxManager();
  const pathContext = {
    tmpdir: osTmpdir(),
    slashTmp: '/tmp',
    ...input.pathContext,
  };

  const local = input.inner ?? createLocalWorkspaceExecutor();
  const sandboxedCommands = new SandboxedCommandWorkspaceExecutor({
    inner: local,
    getSandboxContext: () => ({
      profile: compiledProfile.profile,
      workspaceRoots,
      sandboxManager,
      ...(input.sandboxPreference ? { preference: input.sandboxPreference } : {}),
      ...(input.platform ? { platform: input.platform } : {}),
      pathContext,
    }),
    ...(input.runProcess ? { runProcess: input.runProcess } : {}),
  });
  const executor = new ProfileEnforcedWorkspaceExecutor({
    inner: sandboxedCommands,
    getProfileContext: () => ({
      profile: compiledProfile.profile,
      workspaceRoots,
      pathContext,
    }),
  });

  return {
    executor,
    compiledProfile,
    sandboxManager,
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
      executor: assembly.executor,
    }),
  };
}
