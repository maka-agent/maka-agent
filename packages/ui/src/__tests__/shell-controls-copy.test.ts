import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { getShellControlsCopy } from '../shell-controls-copy.js';

describe('shared shell controls copy', () => {
  it('provides complete navigation and search copy in both locales', () => {
    assert.equal(getShellControlsCopy('zh').navigation.settings, '设置');
    assert.equal(getShellControlsCopy('en').navigation.settings, 'Settings');
    assert.equal(getShellControlsCopy('en').navigation.newTask, 'New task');
    assert.equal(getShellControlsCopy('en').search.placeholder, 'Search conversation titles and content…');
    assert.equal(getShellControlsCopy('en').search.results(2), '2 matches');
  });
});
