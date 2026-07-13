import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { PermissionMode, SessionHeader } from '@maka/core';

import { FilesystemWorkerClient } from '../filesystem-worker/client.js';
import { createPermissionAwareChildToolFactory } from '../permission-aware-child-tool-factory.js';
import type { SandboxTransformRequest, SandboxTransformResult } from '../sandbox/types.js';

describe('createPermissionAwareChildToolFactory', () => {
  test('builds local-read child tools from the narrowed child mode and inherited cwd', async () => {
    const transforms: SandboxTransformRequest[] = [];
    const requests: Array<{ kind: string; cwd: string; path: string }> = [];
    const sandboxManager = {
      transform(request: SandboxTransformRequest): SandboxTransformResult {
        transforms.push(request);
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
    const filesystemWorkerClient = new FilesystemWorkerClient({
      getLaunchSpec: async () => ({
        ok: true,
        spec: {
          program: '/runtime/node',
          args: ['/runtime/filesystem-worker.js'],
          env: { TMPDIR: '/tmp' },
          runtimeReadableRoots: ['/runtime/filesystem-worker.js'],
          executableRoots: ['/runtime/node'],
        },
      }),
      newId: () => 'request-1',
      runProcess: async (input) => {
        const request = JSON.parse(input.stdin) as {
          requestId: string;
          operation: { kind: string; cwd: string; path: string };
        };
        requests.push(request.operation);
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            version: 1,
            requestId: request.requestId,
            ok: true,
            result: { kind: 'read', content: 'child-read' },
          }),
          stderrTail: '',
          timedOut: false,
          aborted: false,
          responseOverflow: false,
        };
      },
    });
    const factory = createPermissionAwareChildToolFactory({
      canonicalizeCwd: async () => '/workspace/canonical',
      sandboxManager,
      filesystemWorkerClient,
      platform: 'darwin',
    });

    const tools = await factory({
      parentHeader: header('bypass'),
      header: header('explore'),
    });

    assert.deepEqual(tools.map((tool) => tool.name), ['Read', 'Glob', 'Grep']);
    const read = tools.find((tool) => tool.name === 'Read');
    if (!read) throw new Error('Read tool missing');
    const result = await read.impl({ path: 'file.txt' }, {
      sessionId: 'session-1',
      turnId: 'child-turn',
      toolCallId: 'tool-1',
      cwd: '/workspace/link',
      abortSignal: new AbortController().signal,
      emitOutput: () => {},
    }) as { content: string };

    assert.equal(result.content, 'child-read');
    assert.deepEqual(requests, [{
      kind: 'read',
      cwd: '/workspace/canonical',
      path: '/workspace/canonical/file.txt',
    }]);
    assert.equal(transforms[0]?.command.profile.name, 'read-only');
    assert.deepEqual(transforms[0]?.command.pathContext.workspaceRoots, ['/workspace/canonical']);
  });
});

function header(permissionMode: PermissionMode): SessionHeader {
  return {
    id: 'session-1',
    workspaceRoot: '/workspace',
    cwd: '/workspace/link',
    createdAt: 1,
    lastUsedAt: 1,
    name: 'test',
    isFlagged: false,
    labels: [],
    isArchived: false,
    status: 'active',
    statusUpdatedAt: 1,
    hasUnread: false,
    backend: 'fake',
    llmConnectionSlug: 'fake',
    connectionLocked: false,
    model: 'fake-model',
    permissionMode,
    schemaVersion: 1,
  };
}
