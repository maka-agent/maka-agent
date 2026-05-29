import { strict as assert } from 'node:assert';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';

const REPO_ROOT = resolve(import.meta.dirname, '../../../../..');

describe('deep research command entrypoint contract', () => {
  it('command palette exposes a normal action for starting deep research', async () => {
    const src = await readFile(resolve(REPO_ROOT, 'apps/desktop/src/renderer/command-palette.tsx'), 'utf8');

    assert.match(src, /onStartDeepResearch\?\(\): Promise<void> \| void/);
    assert.match(src, /id:\s*'action:new-deep-research'/);
    assert.match(src, /label:\s*'新建深度研究'/);
    assert.match(src, /hint:\s*'只读探索'/);
    assert.match(src, /run:\s*\(\)\s*=>\s*void args\.onStartDeepResearch!\(\)/);
  });

  it('main wires the command to the existing deep_research Quick Chat path', async () => {
    const src = await readFile(resolve(REPO_ROOT, 'apps/desktop/src/renderer/main.tsx'), 'utf8');

    assert.match(
      src,
      /onStartDeepResearch:\s*\(\)\s*=>\s*void handleQuickChatSubmit\('',\s*'deep_research'\)/,
      'deep research palette action must create the same explore-mode session as first-run Quick Chat',
    );
  });
});
