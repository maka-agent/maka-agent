import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { createWorkspaceWritePermissionProfile } from '@maka/core/permission-profile';
import { hashAdditionalPermissionProfile } from '../additional-permission-hash.js';
import {
  normalizeAdditionalPermissionProfile,
  type AdditionalPermissionGrant,
} from '../additional-permissions.js';
import {
  sandboxEscalationCommandHash,
  type SandboxEscalationGrant,
} from '../sandbox-escalation.js';
import { LinuxBubblewrapBackend, linuxExecutableRoots } from '../sandbox/linux-sandbox.js';
import { detectLinuxSandboxCapability } from '../sandbox/linux-capability.js';
import { SandboxManager } from '../sandbox/sandbox-manager.js';
import { runProcessWithBoundedTail } from '../shell-exec.js';
import { buildBuiltinTools } from '../builtin-tools.js';

const capability = detectLinuxSandboxCapability();
const requireLinuxSandboxSmoke = process.env.MAKA_REQUIRE_LINUX_SANDBOX_SMOKE === '1';
const skipReason =
  process.platform !== 'linux'
    ? 'Linux sandbox smoke runs only on Linux'
    : capability.available
      ? false
      : 'bubblewrap is not available';

describe('Linux sandbox smoke', () => {
  test('required Linux sandbox capability is available', {
    skip: !requireLinuxSandboxSmoke,
  }, () => {
    assert.equal(skipReason, false, capabilityFailureMessage());
  });

  test('workspace-write can write workspace files and blocks sibling paths', {
    skip: skipReason,
  }, async () => {
    if (!capability.available) return;
    const workspace = await mkdtemp(join(tmpdir(), 'maka-linux-sandbox-workspace-'));
    const outside = await mkdtemp(join(tmpdir(), 'maka-linux-sandbox-outside-'));
    const backend = new LinuxBubblewrapBackend({ capability });
    const request = backend.transform({
      platform: 'linux',
      command: {
        program: '/bin/sh',
        args: [
          '-lc',
          `echo ok > inside.txt && echo temp-ok > /tmp/maka-sandbox-temp.txt && ! echo nope > ${shellQuote(join(outside, 'outside.txt'))}`,
        ],
        cwd: workspace,
        profile: createWorkspaceWritePermissionProfile(),
        pathContext: { workspaceRoots: [workspace], tmpdir: tmpdir(), slashTmp: '/tmp' },
      },
    });
    assert.equal(request.ok, true);
    if (!request.ok) return;

    const result = await runProcessWithBoundedTail(
      request.exec.argv[0] ?? '',
      request.exec.argv.slice(1),
      {
        cwd: workspace,
        timeoutMs: 10_000,
        fdInputs: request.exec.fdInputs,
      },
    );

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

    const result = await runProcessWithBoundedTail(
      request.exec.argv[0] ?? '',
      request.exec.argv.slice(1),
      {
        cwd: workspace,
        timeoutMs: 10_000,
        fdInputs: request.exec.fdInputs,
      },
    );

    assert.equal(result.exitCode, 0, result.stderr);
    await assert.rejects(() => readFile(join(workspace, '.git', 'config'), 'utf8'));
    await assert.rejects(() =>
      readFile(join(workspace, 'packages', 'pkg', '.git', 'config'), 'utf8'),
    );
  });

  test('shell-launched Node uses runtime roots and the seccomp socket filter', {
    skip: skipReason,
  }, async () => {
    if (!capability.available) return;
    const workspace = await mkdtemp(join(tmpdir(), 'maka-linux-sandbox-network-'));
    const backend = new LinuxBubblewrapBackend({ capability });
    const request = backend.transform({
      platform: 'linux',
      command: {
        program: '/bin/sh',
        args: [
          '-lc',
          `node -e ${shellQuote('const net=require("node:net");const s=net.connect(9,"127.0.0.1");s.on("error",e=>{process.stdout.write(e.code||"");process.exit(e.code==="EPERM"?0:2)})')}`,
        ],
        cwd: workspace,
        env: { ...process.env },
        profile: createWorkspaceWritePermissionProfile(),
        pathContext: {
          workspaceRoots: [workspace],
          tmpdir: tmpdir(),
          slashTmp: '/tmp',
          minimalRoots: linuxExecutableRoots({
            execPath: process.execPath,
            path: process.env.PATH,
          }),
        },
      },
    });
    assert.equal(request.ok, true);
    if (!request.ok) return;

    const result = await runProcessWithBoundedTail(
      request.exec.argv[0] ?? '',
      request.exec.argv.slice(1),
      {
        cwd: workspace,
        timeoutMs: 10_000,
        fdInputs: request.exec.fdInputs,
      },
    );

    assert.equal(result.exitCode, 0, result.stderr);
    assert.equal(result.stdout, 'EPERM');
  });

  test('builtin Bash executes a tool from a nonstandard host PATH inside bubblewrap', {
    skip: skipReason,
  }, async () => {
    if (!capability.available) return;
    const workspace = await mkdtemp(join(tmpdir(), 'maka-linux-sandbox-builtin-'));
    const toolRoot = await mkdtemp(join(homedir(), '.maka-linux-sandbox-tool-'));
    const toolBin = join(toolRoot, 'bin');
    const toolPath = join(toolBin, 'maka-path-probe');
    await mkdir(toolBin);
    await writeFile(toolPath, '#!/bin/sh\nprintf custom-tool-ok\n');
    await chmod(toolPath, 0o755);
    const previousPath = process.env.PATH;
    process.env.PATH = `${toolBin}:${previousPath ?? ''}`;

    try {
      const manager = new SandboxManager([new LinuxBubblewrapBackend({ capability })]);
      const bash = buildBuiltinTools({
        permissionProfile: createWorkspaceWritePermissionProfile(),
        sandboxManager: manager,
        sandboxPlatform: 'linux',
      }).find((candidate) => candidate.name === 'Bash');
      if (!bash) throw new Error('Bash tool missing');

      const result = (await bash.impl(
        { command: 'maka-path-probe' },
        {
          sessionId: 'session-1',
          turnId: 'turn-1',
          toolCallId: 'tool-1',
          cwd: workspace,
          permissionMode: 'execute',
          abortSignal: new AbortController().signal,
          emitOutput: () => {},
        },
      )) as { output: { mode: string; stdout: string; stderr: string } };

      assert.equal(result.output.mode, 'pipes');
      assert.equal(result.output.stdout, 'custom-tool-ok');
      assert.equal(result.output.stderr, '');
    } finally {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
      await rm(toolRoot, { recursive: true, force: true });
    }
  });

  test('builtin Bash enforces exact additional access and explicit unsandboxed escalation', {
    skip: skipReason,
  }, async () => {
    if (!capability.available) return;
    const workspace = await mkdtemp(join(tmpdir(), 'maka-linux-bash-one-shot-workspace-'));
    const outside = await mkdtemp(join(homedir(), '.maka-linux-bash-one-shot-outside-'));
    const allowedPath = join(outside, 'allowed.txt');
    const siblingPath = join(outside, 'sibling.txt');
    const escalatedPath = join(outside, 'escalated.txt');
    await Promise.all([
      writeFile(allowedPath, 'allowed-before'),
      writeFile(siblingPath, 'sibling-before'),
    ]);

    try {
      const manager = new SandboxManager([new LinuxBubblewrapBackend({ capability })]);
      const bash = buildBuiltinTools({
        permissionProfile: createWorkspaceWritePermissionProfile(),
        sandboxManager: manager,
        sandboxPlatform: 'linux',
        enableBashAdditionalPermissions: true,
      }).find((candidate) => candidate.name === 'Bash');
      if (!bash) throw new Error('Bash tool missing');

      const normalized = await normalizeAdditionalPermissionProfile({
        profile: {
          fileSystem: {
            entries: [{ path: allowedPath, access: 'write', scope: 'exact' }],
          },
        },
        cwd: workspace,
      });
      const additionalGrant: AdditionalPermissionGrant = {
        grantId: 'grant-linux-bash-smoke',
        sessionId: 'session-1',
        turnId: 'turn-1',
        toolUseId: 'tool-additional',
        toolName: 'Bash',
        intentHash: `sha256:${'1'.repeat(64)}`,
        permissionsHash: hashAdditionalPermissionProfile(normalized.profile),
        profile: normalized.profile,
        normalizedPaths: normalized.normalizedPaths,
        risk: { outsideWorkspace: true, protectedMetadata: false, networkEnabled: false },
        issuedAt: Date.now(),
        expiresAt: Date.now() + 60_000,
      };
      const siblingAttempt = `printf sibling-changed > ${shellQuote(siblingPath)}`;
      const additionalCommand =
        `printf additional-ok > ${shellQuote(allowedPath)}; ` +
        `/bin/sh -c ${shellQuote(siblingAttempt)} 2>/dev/null || :; exit 0`;
      const additionalResult = (await bash.impl(
        { command: additionalCommand },
        {
          sessionId: 'session-1',
          turnId: 'turn-1',
          toolCallId: 'tool-additional',
          cwd: workspace,
          permissionMode: 'execute',
          permissionContext: { additionalGrant },
          abortSignal: new AbortController().signal,
          emitOutput: () => {},
        },
      )) as { output: { mode: string; stderr: string } };

      assert.equal(additionalResult.output.mode, 'pipes');
      assert.equal(additionalResult.output.stderr, '');
      assert.equal(await readFile(allowedPath, 'utf8'), 'additional-ok');
      assert.equal(await readFile(siblingPath, 'utf8'), 'sibling-before');

      const escalationCommand = `printf escalation-ok > ${shellQuote(escalatedPath)}`;
      const escalationGrant: SandboxEscalationGrant = {
        grantId: 'grant-linux-escalation-smoke',
        sessionId: 'session-1',
        turnId: 'turn-1',
        toolUseId: 'tool-escalation',
        toolName: 'Bash',
        intentHash: `sha256:${'2'.repeat(64)}`,
        commandHash: sandboxEscalationCommandHash(escalationCommand, workspace),
        command: escalationCommand,
        cwd: workspace,
        risk: {
          unsandboxedExecution: true,
          unrestrictedFileSystem: true,
          unrestrictedNetwork: true,
          protectedMetadataExposed: true,
        },
        issuedAt: Date.now(),
        expiresAt: Date.now() + 60_000,
      };
      const escalationResult = (await bash.impl(
        {
          command: escalationCommand,
          sandbox_permissions: {
            mode: 'require_escalated',
            justification: 'Linux smoke verifies explicit unsandboxed execution.',
          },
        },
        {
          sessionId: 'session-1',
          turnId: 'turn-1',
          toolCallId: 'tool-escalation',
          cwd: workspace,
          permissionMode: 'execute',
          permissionContext: { sandboxEscalationGrant: escalationGrant },
          abortSignal: new AbortController().signal,
          emitOutput: () => {},
        },
      )) as { output: { mode: string; stderr: string } };

      assert.equal(escalationResult.output.mode, 'pipes');
      assert.equal(escalationResult.output.stderr, '');
      assert.equal(await readFile(escalatedPath, 'utf8'), 'escalation-ok');
    } finally {
      await Promise.all([
        rm(workspace, { recursive: true, force: true }),
        rm(outside, { recursive: true, force: true }),
      ]);
    }
  });
});

function capabilityFailureMessage(): string {
  if (process.platform !== 'linux') return 'Linux sandbox smoke requires a Linux runner';
  if (capability.available) return '';
  return `Linux sandbox smoke requires usable bubblewrap (${capability.reason})${
    capability.detail ? `: ${capability.detail}` : ''
  }`;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
