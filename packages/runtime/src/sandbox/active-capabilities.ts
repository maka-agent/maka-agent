import { constants } from 'node:fs';
import { access } from 'node:fs/promises';
import type {
  PreToolUseSandboxContext,
  SandboxCapabilityStatus,
  ToolSandboxRequirement,
} from '@maka/core/permission';

import type { FilesystemWorkerLaunchSpecProvider } from '../filesystem-worker/launch-spec.js';
import { deriveFilesystemWorkerProfile } from './permission-aware-context.js';
import type { PermissionAwareSandboxContext } from './permission-aware-context.js';
import type { SandboxType } from './types.js';

export type SandboxCapabilityUnavailableReason =
  | 'backend_unavailable'
  | 'executable_unavailable'
  | 'filesystem_worker_unavailable'
  | 'capability_probe_failed';

export interface ActiveSandboxCapability {
  status: SandboxCapabilityStatus;
  sandboxType: SandboxType;
  reason?: SandboxCapabilityUnavailableReason;
  message?: string;
}

export interface ActiveSandboxCapabilities {
  command: ActiveSandboxCapability;
  filesystem: ActiveSandboxCapability;
  platform: string;
  profileName: string;
}

export interface ProbeActiveSandboxCapabilitiesInput {
  context: PermissionAwareSandboxContext;
  getFilesystemWorkerLaunchSpec: FilesystemWorkerLaunchSpecProvider;
  isExecutable?: (path: string) => Promise<boolean>;
}

export async function probeActiveSandboxCapabilities(
  input: ProbeActiveSandboxCapabilitiesInput,
): Promise<ActiveSandboxCapabilities> {
  const { context } = input;
  const platform = context.platform ?? process.platform;
  if (context.profile.type === 'external') {
    return createExternalSandboxCapabilities(context.profile.name ?? 'external', platform);
  }

  const isExecutable = input.isExecutable ?? defaultIsExecutable;
  const command = await probeCommandCapability(context, isExecutable);
  const filesystem = await probeFilesystemCapability(
    context,
    input.getFilesystemWorkerLaunchSpec,
    isExecutable,
  );
  return {
    command,
    filesystem,
    platform,
    profileName: context.profile.name ?? context.profile.type,
  };
}

export function createExternalSandboxCapabilities(
  profileName = 'external',
  platform: string = process.platform,
): ActiveSandboxCapabilities {
  const external: ActiveSandboxCapability = {
    status: 'external',
    sandboxType: 'none',
  };
  return {
    command: external,
    filesystem: external,
    platform,
    profileName,
  };
}

export function sandboxContextForTool(
  requirement: ToolSandboxRequirement | undefined,
  capabilities: ActiveSandboxCapabilities | undefined,
): PreToolUseSandboxContext {
  const effectiveRequirement = requirement ?? 'none';
  if (effectiveRequirement === 'none') {
    return { requirement: 'none', status: 'not_required' };
  }
  if (!capabilities) {
    return {
      requirement: effectiveRequirement,
      status: 'unavailable',
      unavailableReason: 'sandbox capability snapshot is missing',
    };
  }
  const capability = effectiveRequirement === 'external'
    ? capabilities.command
    : capabilities[effectiveRequirement];
  return {
    requirement: effectiveRequirement,
    status: capability.status,
    ...(capability.message || capability.reason
      ? { unavailableReason: capability.message ?? capability.reason }
      : {}),
  };
}

async function probeCommandCapability(
  context: PermissionAwareSandboxContext,
  isExecutable: (path: string) => Promise<boolean>,
): Promise<ActiveSandboxCapability> {
  let transformed;
  try {
    transformed = context.sandboxManager.transform({
      command: {
        program: '/bin/sh',
        args: ['-c', 'true'],
        cwd: context.cwd,
        env: {},
        profile: context.profile,
        pathContext: context.pathContext,
      },
      ...(context.preference ? { preference: context.preference } : {}),
      ...(context.platform ? { platform: context.platform } : {}),
    });
  } catch {
    return unavailable('capability_probe_failed', 'Command sandbox capability probe failed.');
  }
  if (!transformed.ok) {
    return unavailable(
      'backend_unavailable',
      transformed.message ?? transformed.reason,
      transformed.sandboxType ?? 'none',
    );
  }
  const executable = transformed.exec.argv[0];
  if (!executable || !await safelyCheckExecutable(executable, isExecutable)) {
    return unavailable(
      'executable_unavailable',
      executable
        ? `Sandbox command executable is unavailable: ${executable}`
        : 'Sandbox transform returned an empty argv.',
      transformed.sandboxType,
    );
  }
  return {
    status: transformed.requiresSandbox ? 'available' : 'not_required',
    sandboxType: transformed.sandboxType,
  };
}

async function probeFilesystemCapability(
  context: PermissionAwareSandboxContext,
  getLaunchSpec: FilesystemWorkerLaunchSpecProvider,
  isExecutable: (path: string) => Promise<boolean>,
): Promise<ActiveSandboxCapability> {
  let launch: Awaited<ReturnType<FilesystemWorkerLaunchSpecProvider>>;
  try {
    launch = await getLaunchSpec();
  } catch {
    return unavailable(
      'capability_probe_failed',
      'Filesystem worker launch-spec probe failed.',
    );
  }
  if (!launch.ok) {
    return unavailable('filesystem_worker_unavailable', launch.message);
  }
  const profile = deriveFilesystemWorkerProfile(context.profile, 'write');
  let transformed;
  try {
    transformed = context.sandboxManager.transform({
      command: {
        program: launch.spec.program,
        args: launch.spec.args,
        cwd: context.cwd,
        env: launch.spec.env,
        profile,
        pathContext: {
          ...context.pathContext,
          runtimeReadableRoots: launch.spec.runtimeReadableRoots,
          executableRoots: launch.spec.executableRoots,
        },
      },
      ...(context.preference ? { preference: context.preference } : {}),
      ...(context.platform ? { platform: context.platform } : {}),
    });
  } catch {
    return unavailable('capability_probe_failed', 'Filesystem sandbox capability probe failed.');
  }
  if (!transformed.ok) {
    return unavailable(
      'backend_unavailable',
      transformed.message ?? transformed.reason,
      transformed.sandboxType ?? 'none',
    );
  }
  const executable = transformed.exec.argv[0];
  if (!executable || !await safelyCheckExecutable(executable, isExecutable)) {
    return unavailable(
      'executable_unavailable',
      executable
        ? `Filesystem worker wrapper executable is unavailable: ${executable}`
        : 'Filesystem worker transform returned an empty argv.',
      transformed.sandboxType,
    );
  }
  return {
    status: transformed.requiresSandbox ? 'available' : 'not_required',
    sandboxType: transformed.sandboxType,
  };
}

function unavailable(
  reason: SandboxCapabilityUnavailableReason,
  message: string,
  sandboxType: SandboxType = 'none',
): ActiveSandboxCapability {
  return { status: 'unavailable', sandboxType, reason, message };
}

async function safelyCheckExecutable(
  path: string,
  isExecutable: (path: string) => Promise<boolean>,
): Promise<boolean> {
  try {
    return await isExecutable(path);
  } catch {
    return false;
  }
}

async function defaultIsExecutable(path: string): Promise<boolean> {
  try {
    await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}
