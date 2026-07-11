import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createWorkspaceWritePermissionProfile } from '@maka/core/permission-profile';
import { LinuxBubblewrapBackend } from '../sandbox/linux-sandbox.js';
import { detectLinuxSandboxCapability } from '../sandbox/linux-capability.js';
import { runProcessWithBoundedTail } from '../shell-exec.js';

const capability = detectLinuxSandboxCapability();
const skipReason = process.platform !== 'linux'
  ? 'Linux sandbox smoke runs only on Linux'
  : capability.available
    ? false
    : 'bubblewrap is not available';

describe('Linux sandbox smoke', () => {
  test('workspace-write can write workspace files and blocks sibling paths', { skip: skipReason }, async () => {
    if (!capability.available) return;
    const workspace = await mkdtemp(join(tmpdir(), 'maka-linux-sandbox-workspace-'));
    const outside = await mkdtemp(join(tmpdir(), 'maka-linux-sandbox-outside-'));
    const backend = new LinuxBubblewrapBackend({ capability });
    const request = backend.transform({
      platform: 'linux',
      command: {
        program: '/bin/sh',
        args: ['-lc', `echo ok > inside.txt && echo temp-ok > /tmp/maka-sandbox-temp.txt && ! echo nope > ${shellQuote(join(outside, 'outside.txt'))}`],
        cwd: workspace,
        profile: createWorkspaceWritePermissionProfile(),
        pathContext: { workspaceRoots: [workspace], tmpdir: tmpdir(), slashTmp: '/tmp' },
      },
    });
    assert.equal(request.ok, true);
    if (!request.ok) return;

    const result = await runProcessWithBoundedTail(request.exec.argv[0] ?? '', request.exec.argv.slice(1), {
      cwd: workspace,
      timeoutMs: 10_000,
      fdInputs: request.exec.fdInputs,
    });

    assert.equal(result.exitCode, 0, result.stderr);
    assert.equal(await readFile(join(workspace, 'inside.txt'), 'utf8'), 'ok\n');
    await assert.rejects(() => stat(join(outside, 'outside.txt')));
  });

  test('workspace-write blocks protected metadata writes', { skip: skipReason }, async () => {
    if (!capability.available) return;
    const workspace = await mkdtemp(join(tmpdir(), 'maka-linux-sandbox-metadata-'));
    await mkdir(join(workspace, '.git'), { recursive: true });
    await mkdir(join(workspace, 'packages', 'pkg', '.git'), { recursive: true });
    const backend = new LinuxBubblewrapBackend({ capability });
    const request = backend.transform({
      platform: 'linux',
      command: {
        program: '/bin/sh',
        args: ['-lc', '! echo nope > .git/config && ! echo nope > packages/pkg/.git/config'],
        cwd: workspace,
        profile: createWorkspaceWritePermissionProfile(),
        pathContext: { workspaceRoots: [workspace], tmpdir: tmpdir(), slashTmp: '/tmp' },
      },
    });
    assert.equal(request.ok, true);
    if (!request.ok) return;

    const result = await runProcessWithBoundedTail(request.exec.argv[0] ?? '', request.exec.argv.slice(1), {
      cwd: workspace,
      timeoutMs: 10_000,
      fdInputs: request.exec.fdInputs,
    });

    assert.equal(result.exitCode, 0, result.stderr);
    await assert.rejects(() => readFile(join(workspace, '.git', 'config'), 'utf8'));
    await assert.rejects(() => readFile(join(workspace, 'packages', 'pkg', '.git', 'config'), 'utf8'));
  });

  test('network-restricted applies the seccomp socket filter', { skip: skipReason }, async () => {
    if (!capability.available) return;
    const workspace = await mkdtemp(join(tmpdir(), 'maka-linux-sandbox-network-'));
    const backend = new LinuxBubblewrapBackend({ capability });
    const request = backend.transform({
      platform: 'linux',
      command: {
        program: process.execPath,
        args: [
          '-e',
          'const net=require("node:net");const s=net.connect(9,"127.0.0.1");s.on("error",e=>{process.stdout.write(e.code||"");process.exit(e.code==="EPERM"?0:2)})',
        ],
        cwd: workspace,
        profile: createWorkspaceWritePermissionProfile(),
        pathContext: { workspaceRoots: [workspace], tmpdir: tmpdir(), slashTmp: '/tmp' },
      },
    });
    assert.equal(request.ok, true);
    if (!request.ok) return;

    const result = await runProcessWithBoundedTail(request.exec.argv[0] ?? '', request.exec.argv.slice(1), {
      cwd: workspace,
      timeoutMs: 10_000,
      fdInputs: request.exec.fdInputs,
    });

    assert.equal(result.exitCode, 0, result.stderr);
    assert.equal(result.stdout, 'EPERM');
  });
});

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
