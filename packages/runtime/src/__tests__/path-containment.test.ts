import { strict as assert } from 'node:assert';
import { win32, posix } from 'node:path';
import { describe, test } from 'node:test';
import { isPathInside } from '../path-containment.js';

describe('isPathInside', () => {
  test('rejects cross-drive Windows targets (different drive is not inside root)', () => {
    // path.win32.relative returns the target unchanged (absolute) when root
    // and target are on different drives; this is the escape vector the helper
    // must close before the `..` check.
    assert.equal(isPathInside('C:\\repo', 'D:\\secret', win32), false);
  });

  test('rejects same-drive Windows targets outside root', () => {
    assert.equal(isPathInside('C:\\repo', 'C:\\other\\secret', win32), false);
  });

  test('allows same-drive Windows targets under root', () => {
    assert.equal(isPathInside('C:\\repo', 'C:\\repo\\sub', win32), true);
    assert.equal(isPathInside('C:\\repo', 'C:\\repo', win32), true);
  });

  test('rejects parent-directory escape on POSIX', () => {
    assert.equal(isPathInside('/repo', '/etc/passwd', posix), false);
  });

  test('allows POSIX targets under root', () => {
    assert.equal(isPathInside('/repo', '/repo/sub', posix), true);
    assert.equal(isPathInside('/repo', '/repo', posix), true);
  });

  test('allows paths whose first segment starts with ".." but is not a parent reference (e.g. ..rules)', () => {
    assert.equal(isPathInside('/repo', '/repo/..rules/AGENTS.md', posix), true);
    assert.equal(isPathInside('C:\\repo', 'C:\\repo\\..rules\\AGENTS.md', win32), true);
  });
});
