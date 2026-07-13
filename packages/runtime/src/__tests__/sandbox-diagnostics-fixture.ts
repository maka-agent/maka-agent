import type { SandboxDiagnosticsSnapshot } from '../sandbox/diagnostics.js';

export const TEST_SANDBOX_DIAGNOSTICS_SNAPSHOT: SandboxDiagnosticsSnapshot = {
  schemaVersion: 1,
  profile: {
    name: 'workspace-write',
    type: 'managed',
    fileSystem: 'workspace-write',
    network: 'restricted',
    cwd: '/workspace',
    workspaceRoots: ['/workspace'],
    protectedMetadata: ['.git', '.agents', '.codex'],
  },
  capabilities: {
    command: { status: 'available', backend: 'macos-seatbelt' },
    filesystem: { status: 'available', backend: 'macos-seatbelt' },
  },
};
