import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';

import { cuaDriverBinaryPath } from '../cua-driver-path.js';

test('prod path resolves under resourcesPath/bin', () => {
  const resourcesPath = '/Applications/Maka.app/Contents/Resources';
  assert.equal(
    cuaDriverBinaryPath(resourcesPath),
    join(resourcesPath, 'bin', 'cua-driver'),
  );
});

test('dev path (no resourcesPath) points at the repo resources/bin', () => {
  const devPath = cuaDriverBinaryPath('');
  assert.ok(
    devPath.endsWith(join('apps', 'desktop', 'resources', 'bin', 'cua-driver')),
    `expected dev path under apps/desktop/resources/bin, got ${devPath}`,
  );
});
