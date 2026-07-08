import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { compilePermissionProfile } from '../permission-profile-compiler.js';

describe('compilePermissionProfile', () => {
  it('maps explore to a read-only profile and defaults workspaceRoots to cwd', () => {
    const compiled = compilePermissionProfile({ mode: 'explore', cwd: '/repo' });

    assert.equal(compiled.mode, 'explore');
    assert.equal(compiled.profileName, 'read-only');
    assert.equal(compiled.profile.type, 'managed');
    assert.equal(compiled.profile.name, 'read-only');
    assert.equal(compiled.profile.fileSystem.kind, 'restricted');
    assert.deepEqual(compiled.workspaceRoots, ['/repo']);
    assert.deepEqual(compiled.network, { kind: 'restricted' });
  });

  it('maps ask and execute to the same workspace-write profile while preserving mode', () => {
    const ask = compilePermissionProfile({ mode: 'ask', cwd: '/repo' });
    const execute = compilePermissionProfile({ mode: 'execute', cwd: '/repo' });

    assert.equal(ask.mode, 'ask');
    assert.equal(execute.mode, 'execute');
    assert.equal(ask.profileName, 'workspace-write');
    assert.equal(execute.profileName, 'workspace-write');
    assert.equal(ask.profile.type, 'managed');
    assert.equal(execute.profile.type, 'managed');
    assert.equal(ask.profile.name, 'workspace-write');
    assert.equal(execute.profile.name, 'workspace-write');
    assert.deepEqual(ask.network, { kind: 'restricted' });
    assert.deepEqual(execute.network, { kind: 'restricted' });
  });

  it('maps bypass to danger-full-access', () => {
    const compiled = compilePermissionProfile({ mode: 'bypass', cwd: '/repo' });

    assert.equal(compiled.mode, 'bypass');
    assert.equal(compiled.profileName, 'danger-full-access');
    assert.equal(compiled.profile.type, 'managed');
    assert.equal(compiled.profile.name, 'danger-full-access');
    assert.equal(compiled.profile.fileSystem.kind, 'unrestricted');
    assert.deepEqual(compiled.network, { kind: 'enabled' });
  });

  it('uses explicit workspaceRoots when provided', () => {
    const compiled = compilePermissionProfile({
      mode: 'execute',
      cwd: '/repo',
      workspaceRoots: ['/repo', '/other-repo'],
    });

    assert.deepEqual(compiled.workspaceRoots, ['/repo', '/other-repo']);
  });
});
