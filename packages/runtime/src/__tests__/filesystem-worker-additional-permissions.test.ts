import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { hashAdditionalPermissionProfile } from '../additional-permission-hash.js';
import {
  executeFilesystemOperation,
  executeFilesystemWorkerRequest,
} from '../filesystem-worker/operations.js';
import {
  FILESYSTEM_WORKER_PROTOCOL_VERSION,
  parseFilesystemWorkerRequest,
} from '../filesystem-worker/protocol.js';

describe('filesystem worker additional permission validation', () => {
  test('requires a canonical profile and matching hash in the worker protocol', async () => {
    const profile = {
      fileSystem: { entries: [{ path: '/outside/allowed.txt', access: 'write' as const, scope: 'exact' as const }] },
    };
    const request = {
      version: FILESYSTEM_WORKER_PROTOCOL_VERSION,
      requestId: 'request-1',
      operation: { kind: 'write' as const, cwd: '/workspace', path: '/outside/allowed.txt', content: 'ok' },
      additionalPermissions: profile,
      permissionsHash: hashAdditionalPermissionProfile(profile),
    };
    assert.deepEqual(parseFilesystemWorkerRequest(request), request);
    assert.throws(
      () => parseFilesystemWorkerRequest({ ...request, permissionsHash: undefined }),
      /must be provided together/,
    );
    assert.throws(
      () => parseFilesystemWorkerRequest({
        ...request,
        additionalPermissions: {
          fileSystem: { entries: [{ path: '../outside', access: 'write', scope: 'exact' }] },
        },
      }),
      /normalized absolute POSIX path/,
    );

    const mismatch = await executeFilesystemWorkerRequest({
      ...request,
      permissionsHash: `sha256:${'0'.repeat(64)}`,
    });
    assert.equal(mismatch.ok, false);
    if (!mismatch.ok) assert.equal(mismatch.error.code, 'invalid_request');
  });

  test('allows one exact outside write and rejects its sibling', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'maka-worker-workspace-'));
    const outside = await mkdtemp(join(tmpdir(), 'maka-worker-outside-'));
    try {
      const canonicalWorkspace = await realpath(workspace);
      const canonicalOutside = await realpath(outside);
      const allowed = join(canonicalOutside, 'allowed.txt');
      const permissions = {
        fileSystem: { entries: [{ path: allowed, access: 'write' as const, scope: 'exact' as const }] },
      };
      const result = await executeFilesystemOperation({
        kind: 'write', cwd: canonicalWorkspace, path: allowed, content: 'allowed',
      }, {}, permissions);
      assert.equal(result.kind, 'write');
      assert.equal(await readFile(allowed, 'utf8'), 'allowed');

      await assert.rejects(
        executeFilesystemOperation({
          kind: 'write', cwd: canonicalWorkspace, path: join(canonicalOutside, 'sibling.txt'), content: 'blocked',
        }, {}, permissions),
        /not covered by the active permission profile/,
      );
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });

  test('allows an approved outside subtree but not an adjacent directory', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'maka-worker-workspace-'));
    const outside = await mkdtemp(join(tmpdir(), 'maka-worker-outside-'));
    try {
      const canonicalWorkspace = await realpath(workspace);
      const canonicalOutside = await realpath(outside);
      const tree = join(canonicalOutside, 'tree');
      const adjacent = join(canonicalOutside, 'tree-adjacent');
      await mkdir(tree);
      await mkdir(adjacent);
      await writeFile(join(tree, 'read.txt'), 'ok');
      await writeFile(join(adjacent, 'read.txt'), 'blocked');
      const permissions = {
        fileSystem: { entries: [{ path: tree, access: 'read' as const, scope: 'subtree' as const }] },
      };
      const result = await executeFilesystemOperation({
        kind: 'read', cwd: canonicalWorkspace, path: join(tree, 'read.txt'),
      }, {}, permissions);
      assert.deepEqual(result, { kind: 'read', content: 'ok' });
      await assert.rejects(
        executeFilesystemOperation({
          kind: 'read', cwd: canonicalWorkspace, path: join(adjacent, 'read.txt'),
        }, {}, permissions),
        /not covered by the active permission profile/,
      );
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });

  test('checks a symlink real target rather than its workspace spelling', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'maka-worker-workspace-'));
    const outside = await mkdtemp(join(tmpdir(), 'maka-worker-outside-'));
    try {
      const target = join(outside, 'target.txt');
      await writeFile(target, 'secret');
      const link = join(workspace, 'link.txt');
      await symlink(target, link);
      await assert.rejects(
        executeFilesystemOperation({ kind: 'read', cwd: workspace, path: 'link.txt' }),
        /not covered by the active permission profile/,
      );
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });
});
