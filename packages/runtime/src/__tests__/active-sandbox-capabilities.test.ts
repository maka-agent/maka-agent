import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { createWorkspaceWritePermissionProfile } from '@maka/core/permission-profile';
import {
  createExternalSandboxCapabilities,
  probeActiveSandboxCapabilities,
  sandboxContextForTool,
} from '../sandbox/active-capabilities.js';
import { SandboxManager } from '../sandbox/sandbox-manager.js';
import { MacosSeatbeltBackend } from '../sandbox/macos-seatbelt.js';
import type { PermissionAwareSandboxContext } from '../sandbox/permission-aware-context.js';

function context(): PermissionAwareSandboxContext {
  return {
    cwd: '/workspace',
    profile: createWorkspaceWritePermissionProfile(),
    workspaceRoots: ['/workspace'],
    sandboxManager: new SandboxManager([new MacosSeatbeltBackend()]),
    platform: 'darwin',
    pathContext: {
      workspaceRoots: ['/workspace'],
      tmpdir: '/tmp/runtime',
      slashTmp: '/tmp',
    },
  };
}

describe('probeActiveSandboxCapabilities', () => {
  test('probes the command sandbox without starting a login shell', async () => {
    const base = context();
    let shellArgs: readonly string[] | undefined;
    const capabilities = await probeActiveSandboxCapabilities({
      context: {
        ...base,
        sandboxManager: {
          transform: (request) => {
            shellArgs = request.command.args;
            return base.sandboxManager.transform(request);
          },
        },
      },
      getFilesystemWorkerLaunchSpec: async () => ({
        ok: false,
        reason: 'worker_bundle_unavailable',
        message: 'worker bundle missing',
      }),
      isExecutable: async () => true,
    });

    assert.equal(capabilities.command.status, 'available');
    assert.deepEqual(shellArgs, ['-c', 'true']);
  });

  test('reports command available independently from an unavailable filesystem worker', async () => {
    const capabilities = await probeActiveSandboxCapabilities({
      context: context(),
      getFilesystemWorkerLaunchSpec: async () => ({
        ok: false,
        reason: 'worker_bundle_unavailable',
        message: 'worker bundle missing',
      }),
      isExecutable: async () => true,
    });

    assert.equal(capabilities.command.status, 'available');
    assert.equal(capabilities.command.sandboxType, 'macos-seatbelt');
    assert.equal(capabilities.filesystem.status, 'unavailable');
    assert.equal(capabilities.filesystem.reason, 'filesystem_worker_unavailable');
  });

  test('does not treat a registered backend as available when its wrapper is missing', async () => {
    const capabilities = await probeActiveSandboxCapabilities({
      context: context(),
      getFilesystemWorkerLaunchSpec: async () => ({
        ok: true,
        spec: {
          program: '/runtime/node',
          args: ['/runtime/worker.js'],
          env: {},
          runtimeReadableRoots: ['/runtime'],
          executableRoots: ['/runtime'],
        },
      }),
      isExecutable: async () => false,
    });

    assert.equal(capabilities.command.status, 'unavailable');
    assert.equal(capabilities.command.reason, 'executable_unavailable');
    assert.equal(capabilities.filesystem.status, 'unavailable');
  });

  test('maps external capability explicitly and fails closed when a snapshot is missing', () => {
    const external = createExternalSandboxCapabilities();
    assert.deepEqual(sandboxContextForTool('external', external), {
      requirement: 'external',
      status: 'external',
    });
    assert.deepEqual(sandboxContextForTool('command', undefined), {
      requirement: 'command',
      status: 'unavailable',
      unavailableReason: 'sandbox capability snapshot is missing',
    });
  });
});
