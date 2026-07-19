import { strict as assert } from 'node:assert';
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, test } from 'node:test';

import { hashAdditionalPermissionProfile } from '../additional-permission-hash.js';
import { executeFilesystemWorkerRequest } from '../filesystem-worker/operations.js';
import {
  FILESYSTEM_WORKER_PROTOCOL_VERSION,
  type FilesystemWorkerOperation,
  type FilesystemWorkerRequest,
  type FilesystemWorkerTarget,
} from '../filesystem-worker/protocol.js';

const cleanup: string[] = [];

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe('filesystem worker operations', () => {
  test('reads a validated image through the approved path capability', async () => {
    const root = await temporaryDirectory('maka-worker-image-');
    const target = join(root, 'image.png');
    const bytes = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    await writeFile(target, bytes);

    const response = await executeFilesystemWorkerRequest(
      requestFor(
        { kind: 'read', cwd: root, path: target, offset: 1, limit: 1 },
        { enforcementPath: target, access: 'read', scope: 'exact', targetType: 'file' },
      ),
    );

    assert.equal(response.ok, true);
    if (response.ok)
      assert.deepEqual(response.result, {
        kind: 'read_image',
        base64: Buffer.from(bytes).toString('base64'),
        mimeType: 'image/png',
      });
  });

  test('classifies symlinks by their canonical target', async () => {
    const root = await temporaryDirectory('maka-worker-image-link-');
    const image = join(root, 'photo.png');
    const imageLink = join(root, 'notes.txt');
    const text = join(root, 'notes.txt.real');
    const textLink = join(root, 'chart.png');
    const bytes = Buffer.from('\x89PNG\r\n\x1a\n', 'latin1');
    await writeFile(image, bytes);
    await writeFile(text, 'notes', 'utf8');
    await symlink(image, imageLink);
    await symlink(text, textLink);

    const imageResponse = await executeFilesystemWorkerRequest(
      requestFor(
        { kind: 'read', cwd: root, path: imageLink },
        { enforcementPath: image, access: 'read', scope: 'exact', targetType: 'file' },
        image,
      ),
    );
    assert.equal(imageResponse.ok, true);
    if (imageResponse.ok) assert.equal(imageResponse.result.kind, 'read_image');

    const textResponse = await executeFilesystemWorkerRequest(
      requestFor(
        { kind: 'read', cwd: root, path: textLink },
        { enforcementPath: text, access: 'read', scope: 'exact', targetType: 'file' },
        text,
      ),
    );
    assert.equal(textResponse.ok, true);
    if (textResponse.ok) assert.deepEqual(textResponse.result, { kind: 'read', content: 'notes' });
  });

  test('reads and writes only the canonical path capability in the request', async () => {
    const root = await temporaryDirectory('maka-worker-root-');
    const outside = await temporaryDirectory('maka-worker-outside-');
    const insidePath = join(root, 'inside.txt');
    const outsidePath = join(outside, 'outside.txt');
    await writeFile(insidePath, 'inside', 'utf8');

    const readResponse = await executeFilesystemWorkerRequest(
      requestFor(
        { kind: 'read', cwd: root, path: insidePath },
        { enforcementPath: insidePath, access: 'read', scope: 'exact', targetType: 'file' },
      ),
    );
    assert.equal(readResponse.ok, true);
    if (readResponse.ok) assert.deepEqual(readResponse.result, { kind: 'read', content: 'inside' });

    const denied = await executeFilesystemWorkerRequest(
      requestFor(
        { kind: 'write', cwd: root, path: outsidePath, content: 'blocked' },
        { enforcementPath: outsidePath, access: 'write', scope: 'exact', targetType: 'missing' },
        insidePath,
      ),
    );
    assert.equal(denied.ok, false);
    if (!denied.ok) assert.equal(denied.error.code, 'path_denied');
    await assert.rejects(readFile(outsidePath, 'utf8'), { code: 'ENOENT' });
  });

  test('fails when an approved target changes type before execution', async () => {
    const root = await temporaryDirectory('maka-worker-type-');
    const target = join(root, 'target');
    await mkdir(target);

    const response = await executeFilesystemWorkerRequest(
      requestFor(
        { kind: 'read', cwd: root, path: target },
        { enforcementPath: target, access: 'read', scope: 'exact', targetType: 'file' },
      ),
    );
    assert.equal(response.ok, false);
    if (!response.ok) assert.equal(response.error.code, 'path_changed');
  });

  test('fails when a symlink no longer resolves to the approved canonical target', async () => {
    const root = await temporaryDirectory('maka-worker-link-root-');
    const outside = await temporaryDirectory('maka-worker-link-outside-');
    const approved = join(outside, 'approved.txt');
    const replacement = join(outside, 'replacement.txt');
    const link = join(root, 'link.txt');
    await writeFile(approved, 'approved', 'utf8');
    await writeFile(replacement, 'replacement', 'utf8');
    await symlink(replacement, link);

    const response = await executeFilesystemWorkerRequest(
      requestFor(
        { kind: 'read', cwd: root, path: link },
        { enforcementPath: approved, access: 'read', scope: 'exact', targetType: 'file' },
        approved,
      ),
    );
    assert.equal(response.ok, false);
    if (!response.ok) assert.equal(response.error.code, 'path_changed');
  });

  test('rejects a request whose operation permission hash was changed', async () => {
    const root = await temporaryDirectory('maka-worker-hash-');
    const target = join(root, 'file.txt');
    await writeFile(target, 'content', 'utf8');
    const request = requestFor(
      { kind: 'read', cwd: root, path: target },
      { enforcementPath: target, access: 'read', scope: 'exact', targetType: 'file' },
    );
    const response = await executeFilesystemWorkerRequest({
      ...request,
      permissionsHash: `sha256:${'0'.repeat(64)}`,
    });
    assert.equal(response.ok, false);
    if (!response.ok) assert.equal(response.error.code, 'invalid_request');
  });
});

function requestFor(
  operation: FilesystemWorkerOperation,
  expectedTarget: FilesystemWorkerTarget,
  permissionPath = operation.path,
): FilesystemWorkerRequest {
  const operationPermission: FilesystemWorkerRequest['operationPermission'] = {
    fileSystem: {
      entries: [
        {
          path: permissionPath,
          access: expectedTarget.access,
          scope: expectedTarget.scope,
        },
      ],
    },
  };
  return {
    version: FILESYSTEM_WORKER_PROTOCOL_VERSION,
    requestId: 'request-1',
    operation,
    operationPermission,
    permissionsHash: hashAdditionalPermissionProfile(operationPermission),
    expectedTarget,
  };
}

async function temporaryDirectory(prefix: string): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), prefix));
  cleanup.push(path);
  return await realpath(path);
}
