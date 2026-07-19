import { SandboxManager } from './sandbox-manager.js';
import { MacosSeatbeltBackend } from './macos-seatbelt.js';
import { LinuxBubblewrapBackend } from './linux-sandbox.js';
import type { SandboxPlatform } from './types.js';

export function createDefaultSandboxManager(): SandboxManager {
  return new SandboxManager([new MacosSeatbeltBackend(), new LinuxBubblewrapBackend()]);
}

export function createBuiltinSandboxManager(
  platform: SandboxPlatform = process.platform,
): SandboxManager | undefined {
  return platform === 'darwin' || platform === 'linux' ? createDefaultSandboxManager() : undefined;
}
