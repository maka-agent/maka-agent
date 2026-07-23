import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, realpath, rm } from 'node:fs/promises';
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
import { detectLinuxSandboxCapability } from '../sandbox/linux-capability.js';

const linuxCapability = detectLinuxSandboxCapability();
const skip =
  process.platform !== 'linux'
    ? 'Linux-only filesystem worker smoke'
    : linuxCapability.available
      ? false
      : `bubblewrap unavailable: ${linuxCapability.reason}`;

describe('Linux filesystem worker smoke', { skip }, () => {
  let workspace: string;
  let outside: string;
  let client: FilesystemWorkerClient;

  before(async () => {
    workspace = await realpath(await mkdtemp(join(tmpdir(), 'maka-linux-worker-workspace-')));
    outside = await realpath(await mkdtemp(join(homedir(), '.maka-linux-worker-outside-')));
    client = new FilesystemWorkerClient({
      sandboxManager: createDefaultSandboxManager(),
      platform: 'linux',
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

  test('runs Read, Write, Edit, Glob, and Grep inside bubblewrap', async () => {
    const sourceDirectory = join(workspace, 'src');
    const sourceFile = join(sourceDirectory, 'health.ts');
    await mkdir(sourceDirectory);

    await client.execute({
      operation: {
        kind: 'write',
        path: sourceFile,
        content: 'export const healthSignal = true;\n',
      },
      cwd: workspace,
      mode: 'ask',
    });
    assert.equal(await readFile(sourceFile, 'utf8'), 'export const healthSignal = true;\n');

    const read = await client.execute({
      operation: { kind: 'read', path: sourceFile },
      cwd: workspace,
      mode: 'ask',
    });
    assert.deepEqual(read, {
      kind: 'read',
      content: 'export const healthSignal = true;\n',
    });

    const edit = await client.execute({
      operation: {
        kind: 'edit',
        path: sourceFile,
        oldString: 'healthSignal = true',
        newString: 'healthSignal = "healthy"',
      },
      cwd: workspace,
      mode: 'ask',
    });
    assert.equal(edit.kind, 'edit');
    assert.equal(await readFile(sourceFile, 'utf8'), 'export const healthSignal = "healthy";\n');

    const glob = await client.execute({
      operation: {
        kind: 'glob',
        path: sourceDirectory,
        pattern: '*.ts',
        limit: 20,
      },
      cwd: workspace,
      mode: 'ask',
    });
    assert.deepEqual(glob, { kind: 'glob', files: ['health.ts'] });

    const grep = await client.execute({
      operation: {
        kind: 'grep',
        path: sourceDirectory,
        pattern: 'healthy',
        maxCountPerFile: 50,
        limit: 200,
        timeoutMs: 10_000,
      },
      cwd: workspace,
      mode: 'ask',
    });
    assert.equal(grep.kind, 'grep');
    if (grep.kind === 'grep') {
      assert.equal(grep.matches.length, 1);
      assert.match(grep.matches[0] ?? '', /healthy/);
    }
  });

  test('applies one exact outside grant without opening its sibling', async () => {
    const allowedPath = join(outside, 'allowed.txt');
    const siblingPath = join(outside, 'sibling.txt');
    const grant = await grantFor(allowedPath, workspace);

    await assert.rejects(
      client.execute({
        operation: { kind: 'write', path: allowedPath, content: 'blocked' },
        cwd: workspace,
        mode: 'ask',
      }),
      isPathDenied,
    );
    await assert.rejects(
      client.execute({
        operation: { kind: 'write', path: siblingPath, content: 'blocked' },
        cwd: workspace,
        mode: 'ask',
        additionalGrant: grant,
      }),
      isPathDenied,
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
    grantId: 'grant-linux-smoke',
    sessionId: 'session-linux-smoke',
    turnId: 'turn-linux-smoke',
    toolUseId: 'tool-linux-smoke',
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

function isPathDenied(error: unknown): boolean {
  return error instanceof FilesystemWorkerClientError && error.reason === 'path_denied';
}
