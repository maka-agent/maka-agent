import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createWorkspaceWritePermissionProfile,
  type PermissionProfile,
} from '@maka/core/permission-profile';

import {
  AdditionalPermissionError,
  assertAdditionalPermissionProposal,
  buildAdditionalPermissionProposal,
  normalizeAdditionalPermissionPath,
  normalizeAdditionalPermissionProfile,
  planDeclaredBashAdditionalPermission,
  planFileToolAdditionalPermission,
  revalidateAdditionalPermissionProposal,
} from '../additional-permissions.js';

async function createPlanningFixture(prefix: string): Promise<{
  root: string;
  workspace: string;
  allowedTmp: string;
  outside: string;
}> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  const workspace = join(root, 'workspace');
  const allowedTmp = join(root, 'allowed-tmp');
  const outside = join(root, 'outside');
  await Promise.all([mkdir(workspace), mkdir(allowedTmp), mkdir(outside)]);
  return {
    root,
    workspace: await realpath(workspace),
    allowedTmp: await realpath(allowedTmp),
    outside: await realpath(outside),
  };
}

function workspaceWritePlanningContext(fixture: { workspace: string; allowedTmp: string }) {
  return {
    profile: createWorkspaceWritePermissionProfile(),
    workspaceRoots: [fixture.workspace],
    pathContext: {
      tmpdir: fixture.allowedTmp,
      slashTmp: fixture.allowedTmp,
    },
  };
}

describe('runtime additional permission path normalization', () => {
  test('canonicalizes existing and missing exact paths', async () => {
    const root = await mkdtemp(join(tmpdir(), 'maka-additional-path-'));
    try {
      const canonicalRoot = await realpath(root);
      await mkdir(join(root, 'outside'));
      await writeFile(join(root, 'outside', 'existing.txt'), 'ok');
      const result = await normalizeAdditionalPermissionProfile({
        cwd: root,
        profile: {
          fileSystem: {
            entries: [
              { path: 'outside/existing.txt', access: 'read', scope: 'exact' },
              { path: 'outside/missing.txt', access: 'write', scope: 'exact' },
            ],
          },
        },
      });
      assert.deepEqual(result.profile.fileSystem?.entries, [
        { path: join(canonicalRoot, 'outside', 'existing.txt'), access: 'read', scope: 'exact' },
        { path: join(canonicalRoot, 'outside', 'missing.txt'), access: 'write', scope: 'exact' },
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('requires subtree grants to target an existing directory', async () => {
    const root = await mkdtemp(join(tmpdir(), 'maka-additional-subtree-'));
    try {
      await assert.rejects(
        normalizeAdditionalPermissionPath({
          cwd: root,
          path: 'missing',
          access: 'write',
          scope: 'subtree',
        }),
        (error: unknown) =>
          error instanceof AdditionalPermissionError &&
          error.reason === 'invalid_additional_permissions',
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('detects a symlink target change after approval', async () => {
    const root = await mkdtemp(join(tmpdir(), 'maka-additional-symlink-'));
    try {
      await Promise.all([mkdir(join(root, 'a')), mkdir(join(root, 'b'))]);
      await Promise.all([
        writeFile(join(root, 'a', 'file.txt'), 'a'),
        writeFile(join(root, 'b', 'file.txt'), 'b'),
      ]);
      const link = join(root, 'link.txt');
      await symlink(join(root, 'a', 'file.txt'), link);
      const normalized = await normalizeAdditionalPermissionProfile({
        cwd: root,
        profile: { fileSystem: { entries: [{ path: link, access: 'write', scope: 'exact' }] } },
      });
      const proposal = buildAdditionalPermissionProposal({
        ...normalized,
        justification: 'Update the selected file.',
        toolName: 'Write',
        args: { path: link, content: 'next' },
        workspaceRoots: [root],
      });
      await rm(link);
      await symlink(join(root, 'b', 'file.txt'), link);
      await assert.rejects(
        revalidateAdditionalPermissionProposal({ proposal, cwd: root }),
        (error: unknown) =>
          error instanceof AdditionalPermissionError && error.reason === 'grant_path_changed',
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('detects a target type change after approval', async () => {
    const root = await mkdtemp(join(tmpdir(), 'maka-additional-type-'));
    try {
      const target = join(root, 'target');
      await writeFile(target, 'file');
      const normalized = await normalizeAdditionalPermissionProfile({
        cwd: root,
        profile: { fileSystem: { entries: [{ path: target, access: 'write', scope: 'exact' }] } },
      });
      const proposal = buildAdditionalPermissionProposal({
        ...normalized,
        justification: 'Replace the selected file.',
        toolName: 'Write',
        args: { path: target, content: 'next' },
        workspaceRoots: [root],
      });
      await rm(target);
      await mkdir(target);
      await assert.rejects(
        revalidateAdditionalPermissionProposal({ proposal, cwd: root }),
        (error: unknown) =>
          error instanceof AdditionalPermissionError && error.reason === 'grant_path_changed',
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('runtime additional permission planning', () => {
  test('freezes proposals and validates their intent and permission hashes', () => {
    const args = { path: '/outside/file', content: 'x' };
    const proposal = buildAdditionalPermissionProposal({
      profile: {
        fileSystem: { entries: [{ path: '/outside/file', access: 'write', scope: 'exact' }] },
      },
      normalizedPaths: [
        {
          displayPath: '/outside/file',
          enforcementPath: '/outside/file',
          access: 'write',
          scope: 'exact',
          targetType: 'missing',
        },
      ],
      justification: 'Write the requested output.',
      toolName: 'Write',
      args,
      workspaceRoots: ['/workspace'],
    });

    assert.equal(Object.isFrozen(proposal), true);
    assert.equal(Object.isFrozen(proposal.profile), true);
    assert.equal(Object.isFrozen(proposal.profile.fileSystem?.entries), true);
    assert.equal(Object.isFrozen(proposal.normalizedPaths), true);
    assert.equal(Object.isFrozen(proposal.risk), true);
    assert.doesNotThrow(() =>
      assertAdditionalPermissionProposal({ proposal, toolName: 'Write', args }),
    );
    assert.throws(
      () =>
        assertAdditionalPermissionProposal({
          proposal: { ...proposal, permissionsHash: `sha256:${'0'.repeat(64)}` },
          toolName: 'Write',
          args,
        }),
      AdditionalPermissionError,
    );
    assert.throws(
      () =>
        assertAdditionalPermissionProposal({
          proposal,
          toolName: 'Write',
          args: { ...args, content: 'y' },
        }),
      AdditionalPermissionError,
    );
  });

  test('plans only filesystem permissions missing from the base profile', async () => {
    const fixture = await createPlanningFixture('maka-additional-plan-');
    try {
      const context = workspaceWritePlanningContext(fixture);
      assert.deepEqual(
        await planFileToolAdditionalPermission({
          toolName: 'Write',
          path: 'inside.txt',
          cwd: fixture.workspace,
          mode: 'execute',
          args: {},
          context,
        }),
        { kind: 'not_required' },
      );
      assert.deepEqual(
        await planFileToolAdditionalPermission({
          toolName: 'Write',
          path: join(fixture.allowedTmp, 'temp.txt'),
          cwd: fixture.workspace,
          mode: 'execute',
          args: {},
          context,
        }),
        { kind: 'not_required' },
      );

      const outsidePlan = await planFileToolAdditionalPermission({
        toolName: 'Write',
        path: join(fixture.outside, 'outside.txt'),
        cwd: fixture.workspace,
        mode: 'execute',
        args: {},
        context,
      });
      assert.equal(outsidePlan.kind, 'request');
      if (outsidePlan.kind === 'request') {
        assert.equal(outsidePlan.proposal.risk.outsideWorkspace, true);
        assert.equal(outsidePlan.proposal.profile.fileSystem?.entries[0]?.scope, 'exact');
      }

      const explorePlan = await planFileToolAdditionalPermission({
        toolName: 'Read',
        path: fixture.outside,
        cwd: fixture.workspace,
        mode: 'explore',
        args: {},
        context,
      });
      assert.equal(explorePlan.kind, 'block');
      if (explorePlan.kind === 'block') {
        assert.equal(explorePlan.reason, 'additional_permissions_disallowed_by_mode');
      }
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  test('maps every file tool to its minimal access and scope', async () => {
    const fixture = await createPlanningFixture('maka-additional-tools-');
    try {
      const file = join(fixture.outside, 'file.txt');
      await writeFile(file, 'content');
      const context = workspaceWritePlanningContext(fixture);
      const cases = [
        ['Read', file, 'read', 'exact'],
        ['Write', join(fixture.outside, 'new.txt'), 'write', 'exact'],
        ['Edit', file, 'write', 'exact'],
        ['FormatJson', file, 'write', 'exact'],
        ['Glob', fixture.outside, 'read', 'subtree'],
        ['Grep', fixture.outside, 'read', 'subtree'],
      ] as const;
      for (const [toolName, path, access, scope] of cases) {
        const plan = await planFileToolAdditionalPermission({
          toolName,
          path,
          cwd: fixture.workspace,
          mode: 'execute',
          args: { path },
          context,
        });
        assert.equal(plan.kind, 'request');
        if (plan.kind === 'request') {
          assert.deepEqual(plan.proposal.profile.fileSystem?.entries[0], { path, access, scope });
        }
      }
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  test('blocks additional permissions that conflict with an explicit deny', async () => {
    const fixture = await createPlanningFixture('maka-additional-deny-');
    try {
      const profile: PermissionProfile = {
        type: 'managed',
        name: 'custom',
        fileSystem: {
          kind: 'restricted',
          entries: [
            { kind: 'special', access: 'write', special: ':workspace_roots' },
            { kind: 'path', access: 'deny', path: fixture.outside },
          ],
        },
        network: { kind: 'restricted' },
      };
      const plan = await planFileToolAdditionalPermission({
        toolName: 'Write',
        path: join(fixture.outside, 'blocked.txt'),
        cwd: fixture.workspace,
        mode: 'execute',
        args: {},
        context: { profile, workspaceRoots: [fixture.workspace] },
      });
      assert.equal(plan.kind, 'block');
      if (plan.kind === 'block') {
        assert.equal(plan.reason, 'additional_permissions_conflict_with_deny');
      }
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  test('requires explicit Bash declarations and never infers permissions from command text', async () => {
    const fixture = await createPlanningFixture('maka-additional-bash-');
    try {
      const context = workspaceWritePlanningContext(fixture);
      assert.deepEqual(
        await planDeclaredBashAdditionalPermission({
          declaration: undefined,
          cwd: fixture.workspace,
          mode: 'execute',
          command: `printf blocked > ${join(fixture.outside, 'file.txt')}`,
          args: { command: `printf blocked > ${join(fixture.outside, 'file.txt')}` },
          context,
        }),
        { kind: 'not_required' },
      );

      const declaration = {
        mode: 'with_additional_permissions',
        file_system: {
          entries: [
            {
              path: join(fixture.workspace, 'already-allowed.txt'),
              access: 'write',
              scope: 'exact',
            },
            { path: join(fixture.outside, 'file.txt'), access: 'write', scope: 'exact' },
          ],
        },
        network: true,
        justification: 'Write one output and notify a service.',
      };
      const plan = await planDeclaredBashAdditionalPermission({
        declaration,
        cwd: fixture.workspace,
        mode: 'execute',
        command: `printf ok > ${join(fixture.outside, 'file.txt')}`,
        args: {
          command: `printf ok > ${join(fixture.outside, 'file.txt')}`,
          sandbox_permissions: declaration,
        },
        context,
      });
      assert.equal(plan.kind, 'request');
      if (plan.kind === 'request') {
        assert.equal(plan.proposal.profile.network?.enabled, true);
        assert.deepEqual(plan.proposal.profile.fileSystem?.entries, [
          { path: join(fixture.outside, 'file.txt'), access: 'write', scope: 'exact' },
        ]);
      }
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  test('reports workspace, metadata, and network risk without exposing arguments', () => {
    const proposal = buildAdditionalPermissionProposal({
      profile: {
        fileSystem: {
          entries: [
            { path: '/workspace/.git/config', access: 'write', scope: 'exact' },
            { path: '/outside/output.txt', access: 'write', scope: 'exact' },
          ],
        },
        network: { enabled: true },
      },
      normalizedPaths: [
        {
          displayPath: '/workspace/.git/config',
          enforcementPath: '/workspace/.git/config',
          access: 'write',
          scope: 'exact',
          targetType: 'file',
        },
        {
          displayPath: '/outside/output.txt',
          enforcementPath: '/outside/output.txt',
          access: 'write',
          scope: 'exact',
          targetType: 'missing',
        },
      ],
      justification: 'Update metadata and export a result.',
      toolName: 'Bash',
      args: { command: 'secret command' },
      workspaceRoots: ['/workspace'],
    });
    assert.deepEqual(proposal.risk, {
      outsideWorkspace: true,
      protectedMetadata: true,
      networkEnabled: true,
    });
    assert.equal(JSON.stringify(proposal.risk).includes('secret'), false);
  });
});
