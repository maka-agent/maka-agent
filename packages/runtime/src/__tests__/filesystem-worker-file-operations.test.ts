import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  createReadOnlyPermissionProfile,
  createWorkspaceWritePermissionProfile,
} from '@maka/core/permission-profile';

import type { FilesystemWorkerExecuteInput } from '../filesystem-worker/client.js';
import {
  ProfileEnforcedFileOperations,
  WorkerBackedWorkspaceFileOperations,
} from '../filesystem-worker/workspace-file-operations.js';
import { serializeSandboxError } from '../sandbox/errors.js';
import type { PermissionAwareSandboxContext } from '../sandbox/permission-aware-context.js';
import {
  WorkspaceProfilePermissionError,
} from '../workspace-executor.js';

describe('WorkerBackedWorkspaceFileOperations', () => {
  test('sends Edit as one compound worker operation', async () => {
    const calls: FilesystemWorkerExecuteInput[] = [];
    const operations = new WorkerBackedWorkspaceFileOperations({
      context: sandboxContext(),
      client: {
        execute: async (input) => {
          calls.push(input);
          return {
            kind: 'edit',
            ok: true,
            path: '/workspace/file.txt',
            replacements: 1,
            matchedVia: 'exact',
            startLine: 1,
            endLine: 1,
          };
        },
      },
    });

    const result = await operations.edit({
      cwd: '/ignored-cwd',
      path: 'file.txt',
      oldString: 'before',
      newString: 'after',
    });

    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0]?.operation, {
      kind: 'edit',
      path: 'file.txt',
      oldString: 'before',
      newString: 'after',
    });
    assert.equal(result.matchedVia, 'exact');
    assert.equal(operations.facts.isolation, 'platform_sandbox');
  });

  test('uses canonical context cwd for write lock candidates', async () => {
    const operations = new WorkerBackedWorkspaceFileOperations({
      context: sandboxContext(),
      client: { execute: async () => ({ kind: 'read', content: '' }) },
    });

    assert.deepEqual(await operations.writeLockKey({ cwd: '/ignored', path: 'a/../file.txt' }), {
      key: '/workspace/file.txt',
    });
    assert.deepEqual(await operations.writeLockKey({ cwd: '/ignored', path: '../outside.txt' }), {
      key: '/outside.txt',
    });
  });
});

describe('ProfileEnforcedFileOperations', () => {
  test('blocks read-only writes before invoking the worker', async () => {
    let calls = 0;
    const inner = new WorkerBackedWorkspaceFileOperations({
      context: sandboxContext(),
      client: {
        execute: async () => {
          calls += 1;
          return { kind: 'write', ok: true, path: '/workspace/file.txt', bytes: 2 };
        },
      },
    });
    const operations = new ProfileEnforcedFileOperations({
      inner,
      getProfileContext: () => ({
        profile: createReadOnlyPermissionProfile(),
        workspaceRoots: ['/workspace'],
      }),
    });

    await assert.rejects(
      operations.write({ cwd: '/workspace', path: 'file.txt', content: 'no' }),
      (error: unknown) => {
        assert.ok(error instanceof WorkspaceProfilePermissionError);
        assert.equal(error.reason, 'write_denied');
        assert.deepEqual(serializeSandboxError(error), {
          domain: 'filesystem',
          stage: 'validation',
          reason: 'write_denied',
          recoverable: false,
          profileName: 'read-only',
        });
        return true;
      },
    );
    assert.equal(calls, 0);
  });

  test('blocks protected metadata and delegates normal writes exactly once', async () => {
    const calls: FilesystemWorkerExecuteInput[] = [];
    const inner = new WorkerBackedWorkspaceFileOperations({
      context: sandboxContext(),
      client: {
        execute: async (input) => {
          calls.push(input);
          return { kind: 'write', ok: true, path: '/workspace/file.txt', bytes: 2 };
        },
      },
    });
    const operations = new ProfileEnforcedFileOperations({
      inner,
      getProfileContext: () => ({
        profile: createWorkspaceWritePermissionProfile(),
        workspaceRoots: ['/workspace'],
      }),
    });

    assert.deepEqual(await operations.writeLockKey({ cwd: '/workspace', path: 'file.txt' }), {
      key: '/workspace/file.txt',
    });
    await operations.write({ cwd: '/workspace', path: 'file.txt', content: 'ok' });
    assert.equal(calls.length, 1);
    await assert.rejects(
      operations.writeLockKey({ cwd: '/workspace', path: '.git/config' }),
      (error: unknown) => {
        assert.ok(error instanceof WorkspaceProfilePermissionError);
        assert.equal(error.reason, 'write_denied');
        assert.deepEqual(serializeSandboxError(error), {
          domain: 'filesystem',
          stage: 'validation',
          reason: 'write_denied',
          recoverable: false,
          profileName: 'workspace-write',
        });
        return true;
      },
    );
    await assert.rejects(
      operations.writeLockKey({ cwd: '/workspace', path: '../outside.txt' }),
      (error: unknown) => error instanceof WorkspaceProfilePermissionError
        && error.reason === 'write_denied',
    );
    assert.equal(calls.length, 1);
  });

  test('matches and locks macOS temporary paths by their canonical aliases', async () => {
    const context = sandboxContext();
    context.pathContext.slashTmp = '/private/tmp';
    const calls: FilesystemWorkerExecuteInput[] = [];
    const operations = new ProfileEnforcedFileOperations({
      inner: new WorkerBackedWorkspaceFileOperations({
        context,
        client: {
          execute: async (input) => {
            calls.push(input);
            return { kind: 'write', ok: true, path: '/private/tmp/file.txt', bytes: 2 };
          },
        },
      }),
      getProfileContext: () => ({
        profile: createWorkspaceWritePermissionProfile(),
        workspaceRoots: ['/workspace'],
        pathContext: { slashTmp: '/private/tmp' },
      }),
    });

    assert.deepEqual(await operations.writeLockKey({ cwd: '/workspace', path: '/tmp/file.txt' }), {
      key: '/private/tmp/file.txt',
    });
    await operations.write({ cwd: '/workspace', path: '/tmp/file.txt', content: 'ok' });
    assert.equal(calls.length, 1);
  });
});

function sandboxContext(): PermissionAwareSandboxContext {
  return {
    cwd: '/workspace',
    profile: createWorkspaceWritePermissionProfile(),
    workspaceRoots: ['/workspace'],
    sandboxManager: {
      transform: () => ({
        ok: false,
        reason: 'backend_not_available',
        requiresSandbox: true,
        platform: 'darwin',
        preference: 'auto',
      }),
    },
    pathContext: { workspaceRoots: ['/workspace'] },
  };
}
