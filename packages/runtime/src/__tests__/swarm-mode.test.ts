import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { renderSwarmModePrompt } from '../swarm-mode.js';

describe('Swarm Mode shared prompt', () => {
  test('defines bounded dispatch, exclusive use, settlement, and synthesis', () => {
    const prompt = renderSwarmModePrompt();
    assert.match(prompt, /<orchestration_mode>/);
    assert.match(prompt, /meaningful independent items/);
    assert.match(prompt, /only tool in its assistant step/);
    assert.match(prompt, /whole batch to settle/);
    assert.match(prompt, /semantically synthesize/);
    assert.match(prompt, /Do not manufacture fake parallelism/);
  });
});
