import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { readRendererShellCombinedSource } from './renderer-shell-source-helpers.js';

describe('command palette session navigation contract', () => {
  it('routes normal session commands back to the chat surface before selecting the session', async () => {
    const main = await readRendererShellCombinedSource();
    // #1045: session rows live in buildAppShellSessionCommands (not the frozen
    // base buildCommandList). Same invariant: openSessionInChat, not setActiveId.
    const sessionBlock =
      main.match(/export function buildAppShellSessionCommands\([\s\S]*?\n\}/)?.[0] ?? '';

    assert.match(
      sessionBlock,
      /onSelectSession: \(sessionId\) => \{[\s\S]*openSessionInChat\(sessionId\);[\s\S]*\}/,
      'ordinary Command Palette session hits must switch modules back to Chat before selecting the session',
    );
    assert.doesNotMatch(
      sessionBlock,
      /onSelectSession: setActiveId/,
      'passing setActiveId directly makes palette session hits invisible from Plan / Daily Review / Skills modules',
    );
    assert.match(
      sessionBlock,
      /optionsRef\.current\.openSessionInChat\(sessionId\)/,
      'session select must read openSessionInChat from the live options ref at run time',
    );
  });
});
