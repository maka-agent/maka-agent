import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { once } from 'node:events';
import { applyAdditionalPermissionProfile } from '@maka/core/additional-permissions';

import {
  createWorkspaceWritePermissionProfile,
  type PermissionProfile,
} from '@maka/core/permission-profile';

import {
  MACOS_SEATBELT_EXECUTABLE,
  MacosSeatbeltBackend,
} from '../sandbox/macos-seatbelt.js';
import { createDefaultSandboxManager } from '../sandbox/default-sandbox-manager.js';
import { sandboxEscalationCommandHash } from '../sandbox-escalation.js';
import type { SandboxPathContext } from '../sandbox/types.js';
import { LocalWorkspaceExecutor, SandboxedCommandWorkspaceExecutor } from '../workspace-executor.js';

const canRunSeatbelt = process.platform === 'darwin' && existsSync(MACOS_SEATBELT_EXECUTABLE);

async function makeWorkspace(): Promise<string> {
  return realpath(await mkdtemp(join(tmpdir(), 'maka-seatbelt-workspace-')));
}

function profileWithDeniedChild(workspaceRoot: string): PermissionProfile {
  return {
    type: 'managed',
    name: 'custom',
    fileSystem: {
      kind: 'restricted',
      entries: [
        {
          kind: 'special',
          access: 'write',
          special: ':workspace_roots',
        },
        {
          kind: 'path',
          access: 'deny',
          path: join(workspaceRoot, 'secret'),
        },
      ],
    },
    network: { kind: 'restricted' },
  };
}

function runSeatbeltCommand(
  workspaceRoot: string,
  command: string,
  profile: PermissionProfile = createWorkspaceWritePermissionProfile(),
  pathContext: SandboxPathContext = { workspaceRoots: [workspaceRoot] },
) {
  const backend = new MacosSeatbeltBackend();
  const result = backend.transform({
    platform: 'darwin',
    command: {
      program: '/bin/sh',
      args: ['-c', command],
      cwd: workspaceRoot,
      profile,
      pathContext,
    },
  });

  assert.equal(result.ok, true);
  if (!result.ok) throw new Error('unreachable');

  return spawnSync(result.exec.argv[0], result.exec.argv.slice(1), {
    cwd: result.exec.cwd,
    env: { ...process.env, ...result.exec.env },
    encoding: 'utf8',
  });
}

describe('macOS Seatbelt smoke', { skip: !canRunSeatbelt }, () => {
  const cleanup: string[] = [];

  after(async () => {
    await Promise.all(cleanup.map((path) => rm(path, { recursive: true, force: true })));
  });

  it('allows ordinary writes inside the workspace root', async () => {
    const workspaceRoot = await makeWorkspace();
    cleanup.push(workspaceRoot);

    const child = runSeatbeltCommand(workspaceRoot, 'printf ok > allowed.txt');

    assert.equal(child.status, 0, child.stderr);
    assert.equal(await readFile(join(workspaceRoot, 'allowed.txt'), 'utf8'), 'ok');
  });

  it('allows slash tmp through its canonical macOS path', async () => {
    const workspaceRoot = await makeWorkspace();
    const slashTmpRoot = await mkdtemp('/tmp/maka-seatbelt-slash-');
    cleanup.push(workspaceRoot, slashTmpRoot);
    const target = join(slashTmpRoot, 'allowed.txt');

    const child = runSeatbeltCommand(
      workspaceRoot,
      `printf tmp-ok > ${JSON.stringify(target)}`,
      createWorkspaceWritePermissionProfile(),
      {
        workspaceRoots: [workspaceRoot],
        tmpdir: await realpath(tmpdir()),
        slashTmp: await realpath('/tmp'),
      },
    );

    assert.equal(child.status, 0, child.stderr);
    assert.equal(await readFile(target, 'utf8'), 'tmp-ok');
  });

  it('denies writes outside the workspace root', async () => {
    const workspaceRoot = await makeWorkspace();
    const outsideRoot = await realpath(await mkdtemp(join(tmpdir(), 'maka-seatbelt-outside-')));
    cleanup.push(workspaceRoot, outsideRoot);
    const outsideFile = resolve(outsideRoot, 'denied.txt');

    const child = runSeatbeltCommand(workspaceRoot, `printf nope > ${JSON.stringify(outsideFile)}`);

    assert.notEqual(child.status, 0);
  });

  it('denies writes to protected metadata under the workspace root', async () => {
    const workspaceRoot = await makeWorkspace();
    cleanup.push(workspaceRoot);

    const child = runSeatbeltCommand(workspaceRoot, 'mkdir .codex');

    assert.notEqual(child.status, 0);
  });

  it('denies writes to explicit denied children under a writable workspace root', async () => {
    const workspaceRoot = await makeWorkspace();
    cleanup.push(workspaceRoot);

    const child = runSeatbeltCommand(
      workspaceRoot,
      'mkdir -p secret && printf denied > secret/file.txt',
      profileWithDeniedChild(workspaceRoot),
    );

    assert.notEqual(child.status, 0);
  });

  it('denies direct network access under restricted network policy', async () => {
    const workspaceRoot = await makeWorkspace();
    cleanup.push(workspaceRoot);

    const child = runSeatbeltCommand(
      workspaceRoot,
      '/usr/bin/python3 -c "import socket; socket.create_connection((\\"127.0.0.1\\", 9), 0.2)"',
    );

    assert.notEqual(child.status, 0);
  });

  it('allows one exact outside file without allowing its sibling', async () => {
    const workspaceRoot = await makeWorkspace();
    const outsideRoot = await realpath(await mkdtemp(join(tmpdir(), 'maka-seatbelt-outside-')));
    cleanup.push(workspaceRoot, outsideRoot);
    const allowed = join(outsideRoot, 'allowed.txt');
    const sibling = join(outsideRoot, 'sibling.txt');
    await writeFile(sibling, 'before');
    const profile = applyAdditionalPermissionProfile(createWorkspaceWritePermissionProfile(), {
      fileSystem: { entries: [{ path: allowed, access: 'write', scope: 'exact' }] },
    });

    const allowedChild = runSeatbeltCommand(
      workspaceRoot,
      `printf allowed > ${JSON.stringify(allowed)}`,
      profile,
    );
    const siblingChild = runSeatbeltCommand(
      workspaceRoot,
      `printf blocked > ${JSON.stringify(sibling)}`,
      profile,
    );

    assert.equal(allowedChild.status, 0, allowedChild.stderr);
    assert.equal(await readFile(allowed, 'utf8'), 'allowed');
    assert.notEqual(siblingChild.status, 0);
    assert.equal(await readFile(sibling, 'utf8'), 'before');
  });

  it('allows an outside subtree without allowing an adjacent directory', async () => {
    const workspaceRoot = await makeWorkspace();
    const outsideRoot = await realpath(await mkdtemp(join(tmpdir(), 'maka-seatbelt-outside-')));
    cleanup.push(workspaceRoot, outsideRoot);
    const tree = join(outsideRoot, 'tree');
    const adjacent = join(outsideRoot, 'tree-adjacent');
    await mkdir(tree);
    await mkdir(adjacent);
    const profile = applyAdditionalPermissionProfile(createWorkspaceWritePermissionProfile(), {
      fileSystem: { entries: [{ path: tree, access: 'write', scope: 'subtree' }] },
    });

    const treeChild = runSeatbeltCommand(workspaceRoot, `printf ok > ${JSON.stringify(join(tree, 'file.txt'))}`, profile);
    const adjacentChild = runSeatbeltCommand(
      workspaceRoot,
      `printf blocked > ${JSON.stringify(join(adjacent, 'file.txt'))}`,
      profile,
    );
    assert.equal(treeChild.status, 0, treeChild.stderr);
    assert.notEqual(adjacentChild.status, 0);
  });

  it('allows one protected metadata file without exposing its sibling', async () => {
    const workspaceRoot = await makeWorkspace();
    cleanup.push(workspaceRoot);
    const git = join(workspaceRoot, '.git');
    const config = join(git, 'config');
    const head = join(git, 'HEAD');
    await mkdir(git);
    await writeFile(config, 'before');
    await writeFile(head, 'before');
    const profile = applyAdditionalPermissionProfile(createWorkspaceWritePermissionProfile(), {
      fileSystem: { entries: [{ path: config, access: 'write', scope: 'exact' }] },
    });

    const configChild = runSeatbeltCommand(workspaceRoot, `printf allowed > ${JSON.stringify(config)}`, profile);
    const headChild = runSeatbeltCommand(workspaceRoot, `printf blocked > ${JSON.stringify(head)}`, profile);
    assert.equal(configChild.status, 0, configChild.stderr);
    assert.notEqual(headChild.status, 0);
    assert.equal(await readFile(head, 'utf8'), 'before');
  });

  it('enables loopback network only for the one effective profile', async () => {
    const workspaceRoot = await makeWorkspace();
    cleanup.push(workspaceRoot);
    const server = await startLoopbackServer();
    try {
      const command = `/usr/bin/curl --fail --silent http://127.0.0.1:${server.port}/`;
      const enabledProfile = applyAdditionalPermissionProfile(createWorkspaceWritePermissionProfile(), {
        network: { enabled: true },
      });
      const enabled = runSeatbeltCommand(workspaceRoot, command, enabledProfile);
      const restrictedAgain = runSeatbeltCommand(workspaceRoot, command);
      assert.equal(enabled.status, 0, enabled.stderr);
      assert.equal(enabled.stdout, 'ok');
      assert.notEqual(restrictedAgain.status, 0);
    } finally {
      server.child.kill('SIGTERM');
      await once(server.child, 'exit');
    }
  });

  it('runs only an exact approved retry outside Seatbelt', async () => {
    const workspaceRoot = await makeWorkspace();
    const outsideRoot = await realpath(await mkdtemp(join(tmpdir(), 'maka-seatbelt-escalation-')));
    cleanup.push(workspaceRoot, outsideRoot);
    const outsideFile = join(outsideRoot, 'result.txt');
    const command = `printf approved > ${JSON.stringify(outsideFile)}`;
    const executor = new SandboxedCommandWorkspaceExecutor({
      inner: new LocalWorkspaceExecutor(),
      getSandboxContext: () => ({
        profile: createWorkspaceWritePermissionProfile(),
        workspaceRoots: [workspaceRoot],
        sandboxManager: createDefaultSandboxManager(),
        platform: 'darwin',
      }),
    });

    const denied = await executor.exec({ command, cwd: workspaceRoot, timeoutMs: 5_000 });
    assert.notEqual(denied.exitCode, 0);
    assert.equal(denied.sandboxed, true);

    const approved = await executor.exec({
      command,
      cwd: workspaceRoot,
      timeoutMs: 5_000,
      permissionContext: {
        sandboxEscalationGrant: {
          grantId: 'grant-1', sessionId: 'session-1', turnId: 'turn-1', toolUseId: 'tool-1',
          toolName: 'Bash', intentHash: 'intent',
          commandHash: sandboxEscalationCommandHash(command, workspaceRoot), command, cwd: workspaceRoot,
          risk: {
            unsandboxedExecution: true, unrestrictedFileSystem: true,
            unrestrictedNetwork: true, protectedMetadataExposed: true,
          },
          issuedAt: 1, expiresAt: 2,
        },
      },
    });
    assert.equal(approved.exitCode, 0, approved.stderr);
    assert.equal(approved.sandboxType, 'none');
    assert.equal(await readFile(outsideFile, 'utf8'), 'approved');
  });
});

async function startLoopbackServer() {
  const child = spawn(process.execPath, ['-e', `
    const http = require('node:http');
    const server = http.createServer((_request, response) => response.end('ok'));
    server.listen(0, '127.0.0.1', () => process.stdout.write(String(server.address().port) + '\\n'));
  `], { stdio: ['ignore', 'pipe', 'inherit'] });
  child.stdout.setEncoding('utf8');
  const port = await new Promise<number>((resolvePort, reject) => {
    child.once('error', reject);
    child.stdout.once('data', (chunk: string) => {
      const parsed = Number.parseInt(chunk.trim(), 10);
      if (!Number.isInteger(parsed) || parsed <= 0) reject(new Error('Loopback fixture returned an invalid port.'));
      else resolvePort(parsed);
    });
  });
  return { child, port };
}
