import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readMainProcessCombinedSource } from './main-process-contract-source-helpers.js';

describe('bot platform prompt hint wiring', () => {
  it('injects platform hints through the main system prompt path', async () => {
    const source = await readMainProcessCombinedSource();

    assert.match(source, /botPlatformFromSessionLabels/);
    assert.match(source, /buildBotPlatformPromptFragment/);
    assert.match(source, /const botPlatform = botPlatformFromSessionLabels\(header\.labels\);/);
    assert.match(source, /const botPlatformHint = botPlatform \? buildBotPlatformPromptFragment\(botPlatform\) : undefined;/);
    assert.match(source, /botPlatformHint,/);
  });
});
