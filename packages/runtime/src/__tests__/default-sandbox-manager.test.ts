import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createWorkspaceWritePermissionProfile } from '@maka/core/permission-profile';

import {
  createBuiltinSandboxManager,
  createDefaultSandboxManager,
} from '../sandbox/default-sandbox-manager.js';

describe('createDefaultSandboxManager', () => {
  it('registers platform backends without requiring the host platform at import time', () => {
    const manager = createDefaultSandboxManager();

    const result = manager.selectInitial({
      profile: createWorkspaceWritePermissionProfile(),
      platform: 'darwin',
    });

    assert.equal(result.ok, true);
    if (result.ok) assert.equal(result.sandboxType, 'macos-seatbelt');

    const linux = manager.selectInitial({
      profile: createWorkspaceWritePermissionProfile(),
      platform: 'linux',
    });
    assert.equal(linux.ok, true);
    if (linux.ok) assert.equal(linux.sandboxType, 'linux');
  });
});

describe('createBuiltinSandboxManager', () => {
  it('enables production sandbox backends on macOS and Linux', () => {
    assert.ok(createBuiltinSandboxManager('linux'));
    assert.ok(createBuiltinSandboxManager('darwin'));
    assert.equal(createBuiltinSandboxManager('win32'), undefined);
  });
});
