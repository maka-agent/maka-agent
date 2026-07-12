import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { PermissionMode } from '@maka/core/permission';

import { createSessionSandboxContextProvider } from '../sandbox/session-context-provider.js';
import type { SandboxTransformRequest, SandboxTransformResult } from '../sandbox/types.js';

describe('createSessionSandboxContextProvider', () => {
  for (const [mode, profileName] of [
    ['explore', 'read-only'],
    ['ask', 'workspace-write'],
    ['execute', 'workspace-write'],
    ['bypass', 'danger-full-access'],
  ] as const) {
    test(`compiles ${mode} into ${profileName} using canonical cwd`, async () => {
      const result = await createProvider({ mode })(shellInput());

      assert.equal(result.ok, true);
      if (!result.ok) return;
      assert.equal(result.context.cwd, '/workspace/canonical');
      assert.deepEqual(result.context.workspaceRoots, ['/workspace/canonical']);
      assert.equal(result.context.profile.name, profileName);
    });
  }

  test('maps header lookup failure without compiling a host fallback context', async () => {
    const provider = createSessionSandboxContextProvider({
      readHeader: async () => { throw new Error('missing'); },
      canonicalizeCwd: async (cwd) => cwd,
      sandboxManager: passthroughSandboxManager,
    });

    assert.deepEqual(await provider(shellInput()), {
      ok: false,
      reason: 'session_not_found',
      message: 'missing',
    });
  });

  test('maps canonical cwd failure without compiling a host fallback context', async () => {
    const provider = createSessionSandboxContextProvider({
      readHeader: async () => ({ cwd: '/missing', permissionMode: 'ask' }),
      canonicalizeCwd: async () => { throw new Error('not a directory'); },
      sandboxManager: passthroughSandboxManager,
    });

    assert.deepEqual(await provider(shellInput()), {
      ok: false,
      reason: 'invalid_cwd',
      message: 'not a directory',
    });
  });
});

function createProvider(input: { mode: PermissionMode }) {
  return createSessionSandboxContextProvider({
    readHeader: async () => ({ cwd: '/workspace/link', permissionMode: input.mode }),
    canonicalizeCwd: async () => '/workspace/canonical',
    sandboxManager: passthroughSandboxManager,
  });
}

const passthroughSandboxManager = {
  transform(request: SandboxTransformRequest): SandboxTransformResult {
    return {
      ok: true,
      exec: {
        argv: [request.command.program, ...request.command.args],
        cwd: request.command.cwd,
        env: request.command.env,
        sandboxType: 'none',
        effectiveProfile: request.command.profile,
      },
      sandboxType: 'none',
      requiresSandbox: false,
      preference: request.preference ?? 'auto',
    };
  },
};

function shellInput() {
  return {
    sessionId: 'session-1',
    sourceTurnId: 'turn-1',
    sourceToolCallId: 'tool-1',
    command: 'echo ok',
    emitOutput: () => {},
  };
}
