import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createWorkspaceWritePermissionProfile } from '@maka/core/permission-profile';

import {
  DEFAULT_ADDITIONAL_PERMISSION_GRANT_TTL_MS,
  AdditionalPermissionError,
  buildAdditionalPermissionProposal,
  normalizeAdditionalPermissionProfile,
  planDeclaredBashAdditionalPermission,
  planFileToolAdditionalPermission,
  revalidateAdditionalPermissionProposal,
  resolveAdditionalPermissionCandidate,
} from '../additional-permissions.js';
import { PermissionEngine } from '../permission-engine.js';

describe('runtime additional permission path normalization', () => {
  test('freezes the proposal and all authorization-bearing nested values', () => {
    const proposal = buildAdditionalPermissionProposal({
      profile: { fileSystem: { entries: [{ path: '/outside/file', access: 'write', scope: 'exact' }] } },
      normalizedPaths: [{
        displayPath: '/outside/file', enforcementPath: '/outside/file', access: 'write', scope: 'exact', targetType: 'missing',
      }],
      justification: 'test',
      toolName: 'Write',
      args: { path: '/outside/file', content: 'x' },
      workspaceRoots: ['/workspace'],
    });
    assert.equal(Object.isFrozen(proposal), true);
    assert.equal(Object.isFrozen(proposal.profile), true);
    assert.equal(Object.isFrozen(proposal.profile.fileSystem), true);
    assert.equal(Object.isFrozen(proposal.profile.fileSystem?.entries), true);
    assert.equal(Object.isFrozen(proposal.profile.fileSystem?.entries[0]), true);
    assert.equal(Object.isFrozen(proposal.normalizedPaths), true);
    assert.equal(Object.isFrozen(proposal.normalizedPaths[0]), true);
    assert.equal(Object.isFrozen(proposal.risk), true);
  });

  test('canonicalizes existing and missing exact paths', async () => {
    const root = await mkdtemp(join(tmpdir(), 'maka-additional-path-'));
    try {
      const canonicalRoot = await realpath(root);
      await mkdir(join(root, 'outside'));
      await writeFile(join(root, 'outside', 'existing.txt'), 'ok');
      const result = await normalizeAdditionalPermissionProfile({
        cwd: root,
        profile: {
          fileSystem: { entries: [
            { path: 'outside/existing.txt', access: 'read', scope: 'exact' },
            { path: 'outside/missing.txt', access: 'write', scope: 'exact' },
          ] },
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

  test('detects a symlink target change after approval', async () => {
    const root = await mkdtemp(join(tmpdir(), 'maka-additional-symlink-'));
    try {
      await mkdir(join(root, 'a'));
      await mkdir(join(root, 'b'));
      await writeFile(join(root, 'a', 'file.txt'), 'a');
      await writeFile(join(root, 'b', 'file.txt'), 'b');
      const link = join(root, 'link.txt');
      await symlink(join(root, 'a', 'file.txt'), link);
      const normalized = await normalizeAdditionalPermissionProfile({
        cwd: root,
        profile: { fileSystem: { entries: [{ path: link, access: 'write', scope: 'exact' }] } },
      });
      const proposal = buildAdditionalPermissionProposal({
        ...normalized,
        justification: 'test',
        toolName: 'Write',
        args: { path: link, content: 'next' },
        workspaceRoots: [root],
      });
      await rm(link);
      await symlink(join(root, 'b', 'file.txt'), link);
      await assert.rejects(
        revalidateAdditionalPermissionProposal({ proposal, cwd: root }),
        (error: unknown) => error instanceof AdditionalPermissionError && error.reason === 'grant_path_changed',
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('maps a granted symlink spelling to the approved enforcement path', async () => {
    const root = await mkdtemp(join(tmpdir(), 'maka-additional-map-'));
    try {
      await mkdir(join(root, 'target'));
      await writeFile(join(root, 'target', 'file.txt'), 'ok');
      const link = join(root, 'link.txt');
      await symlink(join(root, 'target', 'file.txt'), link);
      const normalized = await normalizeAdditionalPermissionProfile({
        cwd: root,
        profile: { fileSystem: { entries: [{ path: link, access: 'write', scope: 'exact' }] } },
      });
      const grant = {
        grantId: 'grant', sessionId: 's', turnId: 't', toolUseId: 'tool', toolName: 'Write',
        intentHash: 'intent', permissionsHash: 'permissions', profile: normalized.profile,
        normalizedPaths: normalized.normalizedPaths,
        risk: { outsideWorkspace: false, protectedMetadata: false, networkEnabled: false },
        issuedAt: 1, expiresAt: 2,
      };
      assert.equal(
        resolveAdditionalPermissionCandidate(root, link, { additionalGrant: grant }),
        normalized.profile.fileSystem?.entries[0]?.path,
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
        justification: 'test',
        toolName: 'Write',
        args: { path: target, content: 'next' },
        workspaceRoots: [root],
      });
      await rm(target);
      await mkdir(target);
      await assert.rejects(
        revalidateAdditionalPermissionProposal({ proposal, cwd: root }),
        (error: unknown) => error instanceof AdditionalPermissionError && error.reason === 'grant_path_changed',
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('plans only permissions missing from the base profile', async () => {
    const root = await mkdtemp(join(tmpdir(), 'maka-additional-plan-'));
    const outside = await mkdtemp(join(tmpdir(), 'maka-additional-outside-'));
    try {
      const canonicalRoot = await realpath(root);
      const canonicalOutside = await realpath(outside);
      const context = {
        profile: createWorkspaceWritePermissionProfile(),
        workspaceRoots: [canonicalRoot],
      };
      assert.deepEqual(await planFileToolAdditionalPermission({
        toolName: 'Write', path: 'inside.txt', cwd: canonicalRoot, mode: 'execute', args: {}, context,
      }), { kind: 'not_required' });
      const outsidePlan = await planFileToolAdditionalPermission({
        toolName: 'Write', path: join(canonicalOutside, 'outside.txt'), cwd: canonicalRoot, mode: 'execute', args: {}, context,
      });
      assert.equal(outsidePlan.kind, 'request');
      if (outsidePlan.kind === 'request') {
        assert.equal(outsidePlan.proposal.risk.outsideWorkspace, true);
        assert.equal(outsidePlan.proposal.profile.fileSystem?.entries[0]?.scope, 'exact');
      }
      const explorePlan = await planFileToolAdditionalPermission({
        toolName: 'Read', path: canonicalOutside, cwd: canonicalRoot, mode: 'explore', args: {}, context,
      });
      assert.equal(explorePlan.kind, 'block');
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });

  test('maps every file tool to its minimal access and scope', async () => {
    const root = await mkdtemp(join(tmpdir(), 'maka-additional-tools-'));
    const outside = await mkdtemp(join(tmpdir(), 'maka-additional-tool-targets-'));
    try {
      const canonicalRoot = await realpath(root);
      const canonicalOutside = await realpath(outside);
      const file = join(canonicalOutside, 'file.txt');
      await writeFile(file, 'content');
      const context = {
        profile: createWorkspaceWritePermissionProfile(),
        workspaceRoots: [canonicalRoot],
      };
      const cases = [
        ['Read', file, 'read', 'exact'],
        ['Write', join(canonicalOutside, 'new.txt'), 'write', 'exact'],
        ['Edit', file, 'write', 'exact'],
        ['Glob', canonicalOutside, 'read', 'subtree'],
        ['Grep', canonicalOutside, 'read', 'subtree'],
      ] as const;
      for (const [toolName, path, access, scope] of cases) {
        const plan = await planFileToolAdditionalPermission({
          toolName, path, cwd: canonicalRoot, mode: 'execute', args: { path }, context,
        });
        assert.equal(plan.kind, 'request');
        if (plan.kind === 'request') {
          assert.deepEqual(plan.proposal.profile.fileSystem?.entries[0], { path, access, scope });
        }
      }
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });

  test('requires explicit Bash declarations and never infers permissions from the command string', async () => {
    const root = await mkdtemp(join(tmpdir(), 'maka-additional-bash-'));
    try {
      const canonicalRoot = await realpath(root);
      const context = {
        profile: createWorkspaceWritePermissionProfile(),
        workspaceRoots: [canonicalRoot],
      };
      assert.deepEqual(await planDeclaredBashAdditionalPermission({
        declaration: undefined,
        cwd: canonicalRoot,
        mode: 'execute',
        command: 'printf blocked > /outside/file.txt',
        context,
      }), { kind: 'not_required' });

      const plan = await planDeclaredBashAdditionalPermission({
        declaration: {
          mode: 'with_additional_permissions',
          file_system: { entries: [{ path: '/outside/file.txt', access: 'write', scope: 'exact' }] },
          network: true,
          justification: 'Write one output and notify a service.',
        },
        cwd: canonicalRoot,
        mode: 'execute',
        command: 'printf ok > /outside/file.txt',
        context,
      });
      assert.equal(plan.kind, 'request');
      if (plan.kind === 'request') {
        assert.equal(plan.proposal.profile.network?.enabled, true);
        assert.deepEqual(plan.proposal.profile.fileSystem?.entries, [
          { path: '/outside/file.txt', access: 'write', scope: 'exact' },
        ]);
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('PermissionEngine one-shot additional grants', () => {
  test('blocks a proposal whose permission hash was tampered with', () => {
    let id = 0;
    const engine = new PermissionEngine({ newId: () => `id-${++id}`, now: () => 100 });
    const proposal = buildAdditionalPermissionProposal({
      profile: { network: { enabled: true } }, normalizedPaths: [], justification: 'network',
      toolName: 'Bash', args: { command: 'curl http://127.0.0.1' }, workspaceRoots: ['/workspace'],
    });
    const verdict = engine.evaluate({
      sessionId: 'session-1', turnId: 'turn-1', toolUseId: 'tool-1', toolName: 'Bash',
      args: { command: 'curl http://127.0.0.1' }, mode: 'execute', cwd: '/workspace',
      additionalPermissionProposal: { ...proposal, permissionsHash: `sha256:${'0'.repeat(64)}` },
    });
    assert.equal(verdict.kind, 'block');
    if (verdict.kind === 'block') assert.match(verdict.reason, /integrity validation failed/);
  });

  test('prompts in execute mode and binds a grant to one tool intent', () => {
    let id = 0;
    let now = 100;
    const engine = new PermissionEngine({ newId: () => `id-${++id}`, now: () => now });
    const proposal = buildAdditionalPermissionProposal({
      profile: { network: { enabled: true } },
      normalizedPaths: [],
      justification: 'Download one dependency.',
      toolName: 'Bash',
      args: { command: 'curl https://example.test' },
      workspaceRoots: ['/workspace'],
    });
    const verdict = engine.evaluate({
      sessionId: 'session-1',
      turnId: 'turn-1',
      toolUseId: 'tool-1',
      toolName: 'Bash',
      args: { command: 'curl https://example.test' },
      mode: 'execute',
      cwd: '/workspace',
      additionalPermissionProposal: proposal,
    });
    assert.equal(verdict.kind, 'prompt');
    if (verdict.kind !== 'prompt') return;
    assert.equal(verdict.event.kind, 'additional_permissions');
    assert.equal(verdict.event.alsoApprovesToolExecution, false);
    engine.recordResponse('turn-1', { requestId: verdict.event.requestId, decision: 'allow' });

    assert.throws(
      () => engine.consumeAdditionalPermissionGrant({
        sessionId: 'session-1', turnId: 'turn-1', toolUseId: 'tool-1', toolName: 'Bash', intentHash: 'wrong',
      }),
      (error: unknown) => error instanceof AdditionalPermissionError && error.reason === 'grant_intent_mismatch',
    );
    const grant = engine.consumeAdditionalPermissionGrant({
      sessionId: 'session-1',
      turnId: 'turn-1',
      toolUseId: 'tool-1',
      toolName: 'Bash',
      intentHash: proposal.intentHash,
    });
    assert.equal(grant?.permissionsHash, proposal.permissionsHash);
    assert.throws(
      () => engine.consumeAdditionalPermissionGrant({
        sessionId: 'session-1', turnId: 'turn-1', toolUseId: 'tool-1', toolName: 'Bash', intentHash: proposal.intentHash,
      }),
      (error: unknown) => error instanceof AdditionalPermissionError && error.reason === 'grant_already_consumed',
    );
    now += 1;
  });

  test('combines ask approval and rejects rememberForTurn protocol use', () => {
    let id = 0;
    const engine = new PermissionEngine({ newId: () => `id-${++id}`, now: () => 100 });
    const proposal = buildAdditionalPermissionProposal({
      profile: { fileSystem: { entries: [{ path: '/outside/file', access: 'write', scope: 'exact' }] } },
      normalizedPaths: [{
        displayPath: '/outside/file', enforcementPath: '/outside/file', access: 'write', scope: 'exact', targetType: 'missing',
      }],
      justification: 'Write requested output.',
      toolName: 'Write',
      args: { path: '/outside/file', content: 'x' },
      workspaceRoots: ['/workspace'],
    });
    const verdict = engine.evaluate({
      sessionId: 'session-1', turnId: 'turn-1', toolUseId: 'tool-1', toolName: 'Write',
      args: { path: '/outside/file', content: 'x' }, mode: 'ask', cwd: '/workspace',
      additionalPermissionProposal: proposal,
    });
    assert.equal(verdict.kind, 'prompt');
    if (verdict.kind !== 'prompt') return;
    assert.equal(verdict.event.alsoApprovesToolExecution, true);
    assert.throws(
      () => engine.recordResponse('turn-1', {
        requestId: verdict.event.requestId, decision: 'allow', rememberForTurn: true,
      }),
      /cannot use rememberForTurn/,
    );
  });

  test('expires parked requests and approved grants with stable reasons', async () => {
    let id = 0;
    let now = 100;
    const engine = new PermissionEngine({ newId: () => `id-${++id}`, now: () => now });
    const proposal = buildAdditionalPermissionProposal({
      profile: { network: { enabled: true } },
      normalizedPaths: [],
      justification: 'network',
      toolName: 'Bash',
      args: { command: 'curl http://127.0.0.1' },
      workspaceRoots: ['/workspace'],
    });
    const timedOut = engine.evaluate({
      sessionId: 'session-1', turnId: 'turn-timeout', toolUseId: 'tool-timeout', toolName: 'Bash',
      args: { command: 'curl http://127.0.0.1' }, mode: 'execute', cwd: '/workspace',
      additionalPermissionProposal: proposal,
    });
    assert.equal(timedOut.kind, 'prompt');
    if (timedOut.kind !== 'prompt') return;
    engine.expireRequest('turn-timeout', timedOut.event.requestId, 'timed out');
    await assert.rejects(
      timedOut.parked,
      (error: unknown) => error instanceof AdditionalPermissionError && error.reason === 'additional_permission_timeout',
    );

    const expiring = engine.evaluate({
      sessionId: 'session-1', turnId: 'turn-expiry', toolUseId: 'tool-expiry', toolName: 'Bash',
      args: { command: 'curl http://127.0.0.1' }, mode: 'execute', cwd: '/workspace',
      additionalPermissionProposal: proposal,
    });
    assert.equal(expiring.kind, 'prompt');
    if (expiring.kind !== 'prompt') return;
    engine.recordResponse('turn-expiry', { requestId: expiring.event.requestId, decision: 'allow' });
    now += DEFAULT_ADDITIONAL_PERMISSION_GRANT_TTL_MS + 1;
    assert.throws(
      () => engine.consumeAdditionalPermissionGrant({
        sessionId: 'session-1', turnId: 'turn-expiry', toolUseId: 'tool-expiry', toolName: 'Bash',
        intentHash: proposal.intentHash,
      }),
      (error: unknown) => error instanceof AdditionalPermissionError && error.reason === 'grant_expired',
    );
  });

  test('keeps concurrent grants isolated by tool use id', () => {
    let id = 0;
    const engine = new PermissionEngine({ newId: () => `id-${++id}`, now: () => 100 });
    const proposal = buildAdditionalPermissionProposal({
      profile: { network: { enabled: true } }, normalizedPaths: [], justification: 'network',
      toolName: 'Bash', args: { command: 'curl http://127.0.0.1' }, workspaceRoots: ['/workspace'],
    });
    const verdicts = ['tool-1', 'tool-2'].map((toolUseId) => engine.evaluate({
      sessionId: 'session-1', turnId: 'turn-1', toolUseId, toolName: 'Bash',
      args: { command: 'curl http://127.0.0.1' }, mode: 'execute', cwd: '/workspace',
      additionalPermissionProposal: proposal,
    }));
    for (const verdict of verdicts) {
      assert.equal(verdict.kind, 'prompt');
      if (verdict.kind === 'prompt') {
        engine.recordResponse('turn-1', { requestId: verdict.event.requestId, decision: 'allow' });
      }
    }
    for (const toolUseId of ['tool-1', 'tool-2']) {
      assert.equal(engine.consumeAdditionalPermissionGrant({
        sessionId: 'session-1', turnId: 'turn-1', toolUseId, toolName: 'Bash', intentHash: proposal.intentHash,
      })?.toolUseId, toolUseId);
    }
  });
});
