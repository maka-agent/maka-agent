import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createWorkspaceWritePermissionProfile } from '@maka/core/permission-profile';

import { createDefaultSandboxManager } from '../sandbox/default-sandbox-manager.js';

describe('createDefaultSandboxManager', () => {
  it('registers the macOS Seatbelt backend without requiring macOS at import time', () => {
    const manager = createDefaultSandboxManager();

    const result = manager.selectInitial({
      profile: createWorkspaceWritePermissionProfile(),
      platform: 'darwin',
    });

    assert.equal(result.ok, true);
    if (result.ok) assert.equal(result.sandboxType, 'macos-seatbelt');
  });
});
