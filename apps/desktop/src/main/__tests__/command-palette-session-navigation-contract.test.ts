import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { readRendererShellCombinedSource } from './renderer-shell-source-helpers.js';

describe('command palette session navigation contract', () => {
  it('routes normal session commands back to the chat surface before selecting the session', async () => {
    const main = await readRendererShellCombinedSource();
    const paletteBlock = main.match(/commands=\{buildCommandList\(\{[\s\S]*?onNewChat:/)?.[0] ?? '';

    assert.match(
      paletteBlock,
      /onSelectSession: \(sessionId\) => \{[\s\S]*openSessionInChat\(sessionId\);[\s\S]*\}/,
      'ordinary Command Palette session hits must switch modules back to Chat before selecting the session',
    );
    assert.doesNotMatch(
      paletteBlock,
      /onSelectSession: setActiveId/,
      'passing setActiveId directly makes palette session hits invisible from Plan / Daily Review / Skills modules',
    );
  });
});
