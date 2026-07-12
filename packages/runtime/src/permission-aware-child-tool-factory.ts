import type { MakaTool } from './ai-sdk-backend.js';
import type { FilesystemWorkerClient } from './filesystem-worker/client.js';
import type { ChildToolFactory } from './runtime-kernel.js';
import type { SandboxPlatform, SandboxablePreference } from './sandbox/types.js';
import { buildChildAgentTools } from './subagent-tools.js';
import type { WorkspaceCommandSandboxManager } from './workspace-executor.js';
import { buildPermissionAwareBuiltinTools } from './workspace-executor-factory.js';

export interface CreatePermissionAwareChildToolFactoryInput {
  canonicalizeCwd: (cwd: string) => Promise<string>;
  sandboxManager: WorkspaceCommandSandboxManager;
  filesystemWorkerClient: FilesystemWorkerClient;
  extraTools?: readonly MakaTool[];
  sandboxPreference?: SandboxablePreference;
  platform?: SandboxPlatform;
}

export function createPermissionAwareChildToolFactory(
  input: CreatePermissionAwareChildToolFactoryInput,
): ChildToolFactory {
  return async ({ header }) => {
    const cwd = await input.canonicalizeCwd(header.cwd);
    const permissionAware = buildPermissionAwareBuiltinTools({
      mode: header.permissionMode,
      cwd,
      workspaceRoots: [cwd],
      sandboxManager: input.sandboxManager,
      filesystemWorkerClient: input.filesystemWorkerClient,
      ...(input.sandboxPreference ? { sandboxPreference: input.sandboxPreference } : {}),
      ...(input.platform ? { platform: input.platform } : {}),
    });
    return buildChildAgentTools([
      ...permissionAware.tools,
      ...(input.extraTools ?? []),
    ]);
  };
}
