import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  createDangerFullAccessPermissionProfile,
  createReadOnlyPermissionProfile,
  createWorkspaceWritePermissionProfile,
  type PermissionProfile,
} from '@maka/core/permission-profile';

import {
  MACOS_SEATBELT_EXECUTABLE,
  MacosSeatbeltBackend,
  buildSeatbeltPolicy,
  createSeatbeltExecArgs,
  escapeSeatbeltRegex,
} from '../sandbox/macos-seatbelt.js';
import type { SandboxTransformRequest } from '../sandbox/types.js';

function workspaceCommand(profile: PermissionProfile): SandboxTransformRequest {
  return {
    platform: 'darwin',
    command: {
      program: '/bin/zsh',
      args: ['-lc', 'echo ok'],
      cwd: '/repo',
      profile,
      pathContext: {
        workspaceRoots: ['/repo'],
        tmpdir: '/private/tmp/maka-test',
        slashTmp: '/tmp',
      },
    },
  };
}

function restrictedProfileWithEnabledNetwork(): PermissionProfile {
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
      ],
    },
    network: { kind: 'enabled' },
  };
}

function policyText(profile: PermissionProfile): string {
  return buildSeatbeltPolicy({
    profile,
    pathContext: {
      workspaceRoots: ['/repo'],
      tmpdir: '/private/tmp/maka-test',
      slashTmp: '/tmp',
    },
  }).policy;
}

describe('escapeSeatbeltRegex', () => {
  it('escapes regex metacharacters before inserting paths into SBPL regex literals', () => {
    assert.equal(
      escapeSeatbeltRegex('/tmp/repo.(test)+[x]'),
      '/tmp/repo\\.\\(test\\)\\+\\[x\\]',
    );
  });
});

describe('buildSeatbeltPolicy', () => {
  it('builds read-only policy with readable workspace roots and no writable workspace roots', () => {
    const result = buildSeatbeltPolicy({
      profile: createReadOnlyPermissionProfile(),
      pathContext: { workspaceRoots: ['/repo'] },
    });

    assert.match(result.policy, /\(version 1\)/);
    assert.match(result.policy, /\(deny default\)/);
    assert.match(result.policy, /\(allow file-read\*/);
    assert.match(result.policy, /\(subpath \(param "READABLE_ROOT_0"\)\)/);
    assert.doesNotMatch(result.policy, /WRITABLE_ROOT_0/);
    assert.deepEqual(result.definitionArgs, ['-DREADABLE_ROOT_0=/repo']);
  });

  it('builds workspace-write policy with parameterized workspace and temp roots', () => {
    const result = buildSeatbeltPolicy({
      profile: createWorkspaceWritePermissionProfile(),
      pathContext: {
        workspaceRoots: ['/repo'],
        tmpdir: '/private/tmp/maka-test',
        slashTmp: '/tmp',
      },
    });

    assert.match(result.policy, /\(subpath \(param "READABLE_ROOT_0"\)\)/);
    assert.match(result.policy, /\(subpath \(param "WRITABLE_ROOT_0"\)\)/);
    assert.deepEqual(result.definitionArgs, [
      '-DREADABLE_ROOT_0=/repo',
      '-DREADABLE_ROOT_1=/private/tmp/maka-test',
      '-DREADABLE_ROOT_2=/tmp',
      '-DWRITABLE_ROOT_0=/repo',
      '-DWRITABLE_ROOT_1=/private/tmp/maka-test',
      '-DWRITABLE_ROOT_2=/tmp',
    ]);
  });

  it('protects metadata names with require-not regex under writable workspace roots', () => {
    const policy = policyText(createWorkspaceWritePermissionProfile());

    assert.match(policy, /\(require-all \(subpath \(param "WRITABLE_ROOT_0"\)\)/);
    assert.ok(policy.includes(String.raw`(require-not (regex #"^/repo/(.*/)?\.git(/.*)?$"))`));
    assert.ok(policy.includes(String.raw`(require-not (regex #"^/repo/(.*/)?\.agents(/.*)?$"))`));
    assert.ok(policy.includes(String.raw`(require-not (regex #"^/repo/(.*/)?\.codex(/.*)?$"))`));
  });

  it('escapes workspace root before building protected metadata regex requirements', () => {
    const result = buildSeatbeltPolicy({
      profile: createWorkspaceWritePermissionProfile(),
      pathContext: { workspaceRoots: ['/tmp/repo.(test)+[x]'] },
    });

    assert.match(
      result.policy,
      /\^\/tmp\/repo\\\.\\\(test\\\)\\\+\\\[x\\\]\/\(\.\*\/\)\?\\\.git/,
    );
  });

  it('emits network restricted and enabled policy sections', () => {
    assert.match(policyText(createWorkspaceWritePermissionProfile()), /\(deny network\*\)/);
    assert.match(policyText(restrictedProfileWithEnabledNetwork()), /\(allow network\*\)/);
  });
});

describe('createSeatbeltExecArgs', () => {
  it('creates sandbox-exec arguments using -p policy, -D roots, -- separator, and inner argv', () => {
    const args = createSeatbeltExecArgs({
      profile: createWorkspaceWritePermissionProfile(),
      pathContext: { workspaceRoots: ['/repo'] },
      innerArgv: ['/bin/zsh', '-lc', 'echo ok'],
    });

    assert.equal(args[0], '-p');
    assert.equal(args[2], '-DREADABLE_ROOT_0=/repo');
    assert.ok(args.includes('-DWRITABLE_ROOT_0=/repo'));
    const separator = args.indexOf('--');
    assert.notEqual(separator, -1);
    assert.deepEqual(args.slice(separator + 1), ['/bin/zsh', '-lc', 'echo ok']);
  });
});

describe('MacosSeatbeltBackend', () => {
  it('wraps inner argv with /usr/bin/sandbox-exec', () => {
    const backend = new MacosSeatbeltBackend();
    const result = backend.transform(workspaceCommand(createWorkspaceWritePermissionProfile()));

    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.exec.argv[0], MACOS_SEATBELT_EXECUTABLE);
      assert.equal(result.exec.argv[1], '-p');
      assert.equal(result.exec.sandboxType, 'macos-seatbelt');
      assert.deepEqual(result.exec.argv.slice(-3), ['/bin/zsh', '-lc', 'echo ok']);
    }
  });

  it('returns invalid_request for profiles that should have selected none before reaching backend', () => {
    const backend = new MacosSeatbeltBackend();
    const result = backend.transform(workspaceCommand(createDangerFullAccessPermissionProfile()));

    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.reason, 'invalid_request');
      assert.equal(result.sandboxType, 'macos-seatbelt');
    }
  });
});
