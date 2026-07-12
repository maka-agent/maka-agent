import assert from 'node:assert/strict';
import test from 'node:test';

import { isOwnedComputerUseFixtureTarget } from '../computer-use/e2e-target-guard.js';

test('accepts only the owned fixture window', () => {
  assert.equal(isOwnedComputerUseFixtureTarget({
    pid: 42,
    title: 'Maka Real Model Computer Use Fixture',
  }, 42), true);
  assert.equal(isOwnedComputerUseFixtureTarget({
    pid: 99,
    title: 'Maka Real Model Computer Use Fixture',
  }, 42), false);
  assert.equal(isOwnedComputerUseFixtureTarget({
    pid: 42,
    title: 'ChatGPT',
  }, 42), false);
  assert.equal(isOwnedComputerUseFixtureTarget(undefined, 42), false);
});
