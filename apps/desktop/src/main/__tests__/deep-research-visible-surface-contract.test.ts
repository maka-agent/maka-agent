import { strict as assert } from 'node:assert';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, it } from 'node:test';

const REPO_ROOT = join(process.cwd(), '..', '..');

async function readRepo(relativePath: string): Promise<string> {
  return readFile(join(REPO_ROOT, relativePath), 'utf8');
}

describe('deep research visible surface contract', () => {
  it('marks deep research sessions in the chat header', async () => {
    const ui = await readRepo('packages/ui/src/components.tsx');

    assert.match(
      ui,
      /isDeepResearchSession\(props\.activeSession\.labels\)/,
      'ChatView must detect the stable mode:deep_research label rather than guessing from the session name',
    );
    assert.match(
      ui,
      /className="maka-chat-header-mode-pill"[\s\S]*深度研究/,
      'deep research sessions need a visible header pill so the mode is not hidden behind the permission switcher',
    );
    assert.match(
      ui,
      /aria-label="深度研究，只读探索"/,
      'the header mode pill must expose the read-only meaning to assistive tech',
    );
  });

  it('uses a research-specific empty state with starter prompts', async () => {
    const ui = await readRepo('packages/ui/src/components.tsx');

    assert.match(
      ui,
      /deepResearchActive\s*\?\s*\(\s*<DeepResearchEmptyHero/,
      'an empty deep-research session must not fall back to the generic blank chat hero',
    );
    assert.match(ui, /研究一个参考项目/);
    assert.match(ui, /对比一个功能实现/);
    assert.match(ui, /安全边界审计/);
    assert.match(ui, /固定在 Explore 权限/);
    assert.match(ui, /DEEP_RESEARCH_WORKFLOW_STEPS\.map/);
    assert.match(ui, /aria-label="深度研究流程"/);
  });

  it('ships styling for the header mode pill', async () => {
    const css = await readRepo('apps/desktop/src/renderer/styles.css');

    assert.match(css, /\.maka-chat-header-mode-pill\s*\{/);
    assert.match(css, /white-space:\s*nowrap/);
    assert.match(css, /var\(--info-text\)/);
    assert.match(css, /\.maka-deep-research-workflow\s*\{/);
  });
});
