import assert from 'node:assert/strict';
import { realpath } from 'node:fs/promises';
import { test } from 'node:test';

import { createFilesystemWorkerLaunchSpecProvider } from '../filesystem-worker/launch-spec.js';

test('Linux Electron worker launch does not require a macOS Frameworks directory', async () => {
  const getLaunchSpec = createFilesystemWorkerLaunchSpecProvider({
    runtime: 'electron',
    platform: 'linux',
    executable: process.execPath,
    resourceLocation: { kind: 'runtime' },
  });

  const result = await getLaunchSpec();

  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.spec.program, await realpath(process.execPath));
    assert.equal(result.spec.env.ELECTRON_RUN_AS_NODE, '1');
  }
});
