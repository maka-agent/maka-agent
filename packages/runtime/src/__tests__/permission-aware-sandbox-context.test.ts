import { describe, test } from 'node:test';
import {
  createDangerFullAccessPermissionProfile,
  createExternalPermissionProfile,
  createWorkspaceWritePermissionProfile,
} from '@maka/core/permission-profile';

import { expect } from '../test-helpers.js';
import {
  createPermissionAwareSandboxContext,
  deriveFilesystemWorkerProfile,
} from '../sandbox/permission-aware-context.js';
import {
  sandboxErrorMetadata,
  serializeSandboxError,
} from '../sandbox/errors.js';

describe('createPermissionAwareSandboxContext', () => {
  test('builds one context from mode, cwd, roots, and runtime path context', () => {
    const manager = { transform: () => { throw new Error('not called'); } };
    const built = createPermissionAwareSandboxContext({
      mode: 'execute',
      cwd: '/workspace',
      workspaceRoots: ['/workspace', '/shared'],
      sandboxManager: manager,
      platform: 'darwin',
      pathContext: { tmpdir: '/private/tmp/runtime' },
    });

    expect(built.compiledProfile.profileName).toBe('workspace-write');
    expect(built.context.cwd).toBe('/workspace');
    expect(built.context.workspaceRoots).toEqual(['/workspace', '/shared']);
    expect(built.context.pathContext.workspaceRoots).toEqual(['/workspace', '/shared']);
    expect(built.context.pathContext.tmpdir).toBe('/private/tmp/runtime');
    expect(built.context.sandboxManager).toBe(manager);
  });
});

describe('deriveFilesystemWorkerProfile', () => {
  test('narrows restricted read operations to read-only and restricted network', () => {
    const derived = deriveFilesystemWorkerProfile(createWorkspaceWritePermissionProfile(), 'read');
    expect(derived.type).toBe('managed');
    if (derived.type !== 'managed') throw new Error('expected managed profile');
    expect(derived.name).toBe('read-only');
    expect(derived.network.kind).toBe('restricted');
    expect(derived.fileSystem.entries.every((entry) => entry.access !== 'write')).toBe(true);
  });

  test('preserves restricted write policy while disabling network', () => {
    const active = createWorkspaceWritePermissionProfile();
    const derived = deriveFilesystemWorkerProfile(active, 'write');
    expect(derived.type).toBe('managed');
    if (derived.type !== 'managed') throw new Error('expected managed profile');
    expect(derived.name).toBe('workspace-write');
    expect(derived.fileSystem).toBe(active.fileSystem);
    expect(derived.network.kind).toBe('restricted');
  });

  test('does not change danger-full-access or external semantics', () => {
    const danger = createDangerFullAccessPermissionProfile();
    const external = createExternalPermissionProfile();
    expect(deriveFilesystemWorkerProfile(danger, 'read')).toBe(danger);
    expect(deriveFilesystemWorkerProfile(external, 'write')).toBe(external);
  });
});

describe('sandbox error metadata', () => {
  test('serializes only the shared safe fields', () => {
    const error = Object.assign(new Error('secret command'), {
      code: 'SANDBOX_COMMAND_BLOCKED',
      domain: 'command',
      stage: 'transform',
      reason: 'backend_not_available',
      backend: 'macos-seatbelt',
      recoverable: false,
      argv: ['secret'],
      env: { TOKEN: 'secret' },
    });

    expect(sandboxErrorMetadata(error)?.reason).toBe('backend_not_available');
    expect(serializeSandboxError(error)).toEqual({
      domain: 'command',
      stage: 'transform',
      reason: 'backend_not_available',
      backend: 'macos-seatbelt',
      recoverable: false,
    });
  });

  test('rejects arbitrary strings disguised as sandbox metadata', () => {
    const error = Object.assign(new Error('failure'), {
      code: 'SANDBOX_COMMAND_BLOCKED',
      domain: 'command',
      stage: 'launch',
      reason: '/private/path leaked from raw error',
      backend: 'macos-seatbelt',
      recoverable: false,
    });

    expect(serializeSandboxError(error)).toBeUndefined();
  });
});
