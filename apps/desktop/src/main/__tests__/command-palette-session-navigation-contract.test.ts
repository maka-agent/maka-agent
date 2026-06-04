import { strict as assert } from 'node:assert';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';

const REPO_ROOT = resolve(import.meta.dirname, '../../../../..');

describe('command palette session navigation contract', () => {
  it('routes normal session commands back to the chat surface before selecting the session', async () => {
    const main = await readFile(resolve(REPO_ROOT, 'apps/desktop/src/renderer/main.tsx'), 'utf8');
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
