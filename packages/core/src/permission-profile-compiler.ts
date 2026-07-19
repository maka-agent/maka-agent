import type { PermissionMode } from './permission.js';
import type {
  NetworkSandboxPolicy,
  PermissionProfile,
  PermissionProfileManaged,
  PermissionProfileName,
} from './permission-profile.js';
import {
  createDangerFullAccessPermissionProfile,
  createReadOnlyPermissionProfile,
  createWorkspaceWritePermissionProfile,
} from './permission-profile.js';

export interface CompilePermissionProfileInput {
  mode: PermissionMode;
  cwd: string;
  workspaceRoots?: readonly string[];
}

export interface CompiledPermissionProfile {
  mode: PermissionMode;
  profileName: PermissionProfileName;
  profile: PermissionProfile;
  workspaceRoots: readonly string[];
  network: NetworkSandboxPolicy;
}

export function compilePermissionProfile(
  input: CompilePermissionProfileInput,
): CompiledPermissionProfile {
  const workspaceRoots = input.workspaceRoots ?? [input.cwd];

  switch (input.mode) {
    case 'explore':
      return compileManaged(input.mode, createReadOnlyPermissionProfile(), workspaceRoots);
    case 'ask':
    case 'execute':
      return compileManaged(input.mode, createWorkspaceWritePermissionProfile(), workspaceRoots);
    case 'bypass':
      return compileManaged(input.mode, createDangerFullAccessPermissionProfile(), workspaceRoots);
  }
}

function compileManaged(
  mode: PermissionMode,
  profile: PermissionProfileManaged,
  workspaceRoots: readonly string[],
): CompiledPermissionProfile {
  return {
    mode,
    profileName: standardProfileName(profile.name),
    profile,
    workspaceRoots,
    network: profile.network,
  };
}

function standardProfileName(name: PermissionProfileManaged['name']): PermissionProfileName {
  switch (name) {
    case 'read-only':
      return 'read-only';
    case 'workspace-write':
      return 'workspace-write';
    case 'danger-full-access':
      return 'danger-full-access';
    case 'custom':
      return 'custom';
    default:
      return 'custom';
  }
}
