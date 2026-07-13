import { tmpdir as osTmpdir } from 'node:os';
import { realpathSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
import type { PermissionMode } from '@maka/core/permission';
import type { PermissionProfile } from '@maka/core/permission-profile';
import {
  compilePermissionProfile,
  type CompiledPermissionProfile,
} from '@maka/core/permission-profile-compiler';

import { createDefaultSandboxManager } from './default-sandbox-manager.js';
import type { SandboxManager } from './sandbox-manager.js';
import type {
  SandboxPathContext,
  SandboxPlatform,
  SandboxablePreference,
} from './types.js';

export interface CreatePermissionAwareSandboxContextInput {
  mode: PermissionMode;
  cwd: string;
  workspaceRoots?: readonly string[];
  sandboxManager?: Pick<SandboxManager, 'transform'>;
  preference?: SandboxablePreference;
  platform?: SandboxPlatform;
  pathContext?: Partial<Omit<SandboxPathContext, 'workspaceRoots'>>;
}

export interface PermissionAwareSandboxContext {
  cwd: string;
  profile: PermissionProfile;
  workspaceRoots: readonly string[];
  sandboxManager: Pick<SandboxManager, 'transform'>;
  preference?: SandboxablePreference;
  platform?: SandboxPlatform;
  pathContext: SandboxPathContext;
}

export interface PermissionAwareSandboxContextAssembly {
  context: PermissionAwareSandboxContext;
  compiledProfile: CompiledPermissionProfile;
}

export function createPermissionAwareSandboxContext(
  input: CreatePermissionAwareSandboxContextInput,
): PermissionAwareSandboxContextAssembly {
  const compiledProfile = compilePermissionProfile({
    mode: input.mode,
    cwd: input.cwd,
    ...(input.workspaceRoots ? { workspaceRoots: input.workspaceRoots } : {}),
  });
  const pathContext: SandboxPathContext = {
    tmpdir: canonicalExistingPath(osTmpdir()),
    slashTmp: canonicalExistingPath('/tmp'),
    ...input.pathContext,
    workspaceRoots: compiledProfile.workspaceRoots,
  };

  return {
    compiledProfile,
    context: {
      cwd: input.cwd,
      profile: compiledProfile.profile,
      workspaceRoots: compiledProfile.workspaceRoots,
      sandboxManager: input.sandboxManager ?? createDefaultSandboxManager(),
      ...(input.preference ? { preference: input.preference } : {}),
      ...(input.platform ? { platform: input.platform } : {}),
      pathContext,
    },
  };
}

function canonicalExistingPath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

export function normalizeSandboxMatchPath(
  path: string,
  context: Partial<Omit<SandboxPathContext, 'workspaceRoots'>>,
): string {
  const slashTmp = replacePathRoot(path, '/tmp', context.slashTmp);
  return replacePathRoot(slashTmp, osTmpdir(), context.tmpdir);
}

function replacePathRoot(path: string, alias: string, canonical: string | undefined): string {
  if (!canonical || alias === canonical) return path;
  const rel = relative(alias, path);
  if (rel === '') return canonical;
  if (rel.startsWith('..') || isAbsolute(rel)) return path;
  return resolve(canonical, rel);
}

export type FilesystemWorkerProfileOperation = 'read' | 'search' | 'write' | 'edit';

export function deriveFilesystemWorkerProfile(
  activeProfile: PermissionProfile,
  operation: FilesystemWorkerProfileOperation,
): PermissionProfile {
  if (
    activeProfile.type !== 'managed'
    || activeProfile.fileSystem.kind !== 'restricted'
  ) {
    return activeProfile;
  }

  if (operation === 'write' || operation === 'edit') {
    return {
      ...activeProfile,
      network: { kind: 'restricted' },
    };
  }

  return {
    ...activeProfile,
    name: 'read-only',
    fileSystem: {
      ...activeProfile.fileSystem,
      entries: activeProfile.fileSystem.entries.map((entry) => (
        entry.access === 'write' ? { ...entry, access: 'read' as const } : entry
      )),
    },
    network: { kind: 'restricted' },
  };
}
