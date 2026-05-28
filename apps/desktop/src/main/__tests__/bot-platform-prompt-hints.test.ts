import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, it } from 'node:test';

const repoRoot = process.cwd().endsWith('apps/desktop')
  ? join(process.cwd(), '..', '..')
  : process.cwd();

const mainSourcePath = join(repoRoot, 'apps/desktop/src/main/main.ts');

describe('bot platform prompt hint wiring', () => {
  it('injects platform hints through the main system prompt path', async () => {
    const source = await readFile(mainSourcePath, 'utf8');

    assert.match(source, /botPlatformFromSessionLabels/);
    assert.match(source, /buildBotPlatformPromptFragment/);
    assert.match(source, /const botPlatform = botPlatformFromSessionLabels\(header\.labels\);/);
    assert.match(source, /const botPlatformHint = botPlatform \? buildBotPlatformPromptFragment\(botPlatform\) : undefined;/);
    assert.match(source, /botPlatformHint,/);
  });
});
