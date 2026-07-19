import assert from 'node:assert/strict';
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';

import { hashAdditionalPermissionProfile } from '../additional-permission-hash.js';
import {
  normalizeAdditionalPermissionProfile,
  type AdditionalPermissionGrant,
} from '../additional-permissions.js';
import {
  FilesystemWorkerClient,
  FilesystemWorkerClientError,
} from '../filesystem-worker/client.js';
import { createFilesystemWorkerLaunchSpecProvider } from '../filesystem-worker/launch-spec.js';
import { createDefaultSandboxManager } from '../sandbox/default-sandbox-manager.js';

describe('macOS filesystem worker smoke', { skip: process.platform !== 'darwin' }, () => {
  let workspace: string;
  let outside: string;
  let client: FilesystemWorkerClient;

  before(async () => {
    workspace = await realpath(await mkdtemp(join(tmpdir(), 'maka-worker-smoke-workspace-')));
    outside = await realpath(await mkdtemp(join(homedir(), '.maka-worker-smoke-outside-')));
    client = new FilesystemWorkerClient({
      sandboxManager: createDefaultSandboxManager(),
      platform: 'darwin',
      getLaunchSpec: createFilesystemWorkerLaunchSpecProvider({
        runtime: 'node',
        resourceLocation: { kind: 'runtime' },
      }),
    });
  });

  after(async () => {
    await Promise.all([
      rm(workspace, { recursive: true, force: true }),
      rm(outside, { recursive: true, force: true }),
    ]);
  });

  test('allows workspace writes and fails closed for unapproved outside paths', async () => {
    const insidePath = join(workspace, 'inside.txt');
    const outsidePath = join(outside, 'blocked.txt');
    await client.execute({
      operation: { kind: 'write', path: insidePath, content: 'inside-ok' },
      cwd: workspace,
      mode: 'ask',
    });
    assert.equal(await readFile(insidePath, 'utf8'), 'inside-ok');

    await assert.rejects(
      client.execute({
        operation: { kind: 'write', path: outsidePath, content: 'blocked' },
        cwd: workspace,
        mode: 'ask',
      }),
      (error: unknown) =>
        error instanceof FilesystemWorkerClientError && error.reason === 'path_denied',
    );
  });

  test('applies one exact grant without opening a sibling path', async () => {
    const allowedPath = join(outside, 'allowed.txt');
    const siblingPath = join(outside, 'sibling.txt');
    const grant = await grantFor(allowedPath, workspace);
    await assert.rejects(
      client.execute({
        operation: { kind: 'write', path: siblingPath, content: 'blocked' },
        cwd: workspace,
        mode: 'ask',
        additionalGrant: grant,
      }),
      (error: unknown) =>
        error instanceof FilesystemWorkerClientError && error.reason === 'path_denied',
    );
    await client.execute({
      operation: { kind: 'write', path: allowedPath, content: 'outside-ok' },
      cwd: workspace,
      mode: 'ask',
      additionalGrant: grant,
    });
    assert.equal(await readFile(allowedPath, 'utf8'), 'outside-ok');
  });
});

async function grantFor(path: string, cwd: string): Promise<AdditionalPermissionGrant> {
  const normalized = await normalizeAdditionalPermissionProfile({
    profile: { fileSystem: { entries: [{ path, access: 'write', scope: 'exact' }] } },
    cwd,
  });
  return {
    grantId: 'grant-smoke',
    sessionId: 'session-smoke',
    turnId: 'turn-smoke',
    toolUseId: 'tool-smoke',
    toolName: 'Write',
    intentHash: `sha256:${'1'.repeat(64)}`,
    permissionsHash: hashAdditionalPermissionProfile(normalized.profile),
    profile: normalized.profile,
    normalizedPaths: normalized.normalizedPaths,
    risk: { outsideWorkspace: true, protectedMetadata: false, networkEnabled: false },
    issuedAt: Date.now(),
    expiresAt: Date.now() + 60_000,
  };
}
