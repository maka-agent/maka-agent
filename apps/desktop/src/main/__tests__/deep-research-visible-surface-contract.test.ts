import { strict as assert } from 'node:assert';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { readRendererContractCss } from './contract-css-helpers.js';

const REPO_ROOT = join(process.cwd(), '..', '..');

async function readRepo(relativePath: string): Promise<string> {
  return readFile(join(REPO_ROOT, relativePath), 'utf8');
}

describe('deep research visible surface contract', () => {
  it('marks deep research sessions in the chat header', async () => {
    const ui = await readRepo('packages/ui/src/chat-view.tsx');

    assert.match(
      ui,
      /isDeepResearchSession\(props\.activeSession\.labels\)/,
      'ChatView must detect the stable mode:deep_research label rather than guessing from the session name',
    );
    assert.match(
      ui,
      /className="maka-chat-header-mode-pill"[\s\S]*\{copy\.deepResearch\}/,
      'deep research sessions need a visible header pill so the mode is not hidden behind the permission switcher',
    );
    assert.match(
      ui,
      /aria-label=\{copy\.deepResearchAriaLabel\}/,
      'the header mode pill must expose the read-only meaning to assistive tech',
    );
  });

  it('uses a research-specific empty state with starter prompts', async () => {
    // PR-UI-LIB-EXTRACT-8 (round 9/10): the two chat empty hero
    // components and their DeepResearch sections moved out of
    // `components.tsx` into a sibling `chat-empty-hero.tsx`. The
    // `<DeepResearchEmptyHero>` reference is in `chat-view.tsx`
    // (rendered by ChatView), but the body of the hero lives in
    // `chat-empty-hero.tsx`. Behavioral pins
    // unchanged — just need to read both files.
    const ui = await readRepo('packages/ui/src/chat-view.tsx');
    const hero = await readRepo('packages/ui/src/chat-empty-hero.tsx');

    assert.match(
      ui,
      /deepResearchActive\s*\?\s*\(\s*<DeepResearchEmptyHero/,
      'an empty deep-research session must not fall back to the generic blank chat hero',
    );
    assert.match(hero, /copy\.starters\.map/);
    assert.doesNotMatch(hero, /DEEP_RESEARCH_PROMPT_SUGGESTIONS/);
    assert.match(hero, /copy\.workflow\.map/);
    assert.match(hero, /aria-label=\{copy\.workflowAriaLabel\}/);
    assert.match(hero, /copy\.report\.map/);
    assert.match(hero, /aria-label=\{copy\.reportAriaLabel\}/);
    assert.match(hero, /\{copy\.reportTitle\}/);
    assert.match(hero, /copy\.scope\.map/);
    assert.match(hero, /aria-label=\{copy\.scopeAriaLabel\}/);
    assert.match(hero, /\{copy\.scopeTitle\}/);
    assert.match(hero, /copy\.evidence\.map/);
    assert.match(hero, /aria-label=\{copy\.evidenceAriaLabel\}/);
    assert.match(hero, /\{copy\.evidenceTitle\}/);
    assert.match(hero, /copy\.progress\.map/);
    assert.match(hero, /aria-label=\{copy\.progressAriaLabel\}/);
    assert.match(hero, /\{copy\.progressTitle\}/);
  });

  it('pins deep research starter prompts in the shared core contract', async () => {
    const core = await readRepo('packages/core/src/explore-agent.ts');

    assert.match(core, /DEEP_RESEARCH_STARTER_PROMPTS/);
    assert.match(core, /研究一个参考项目/);
    assert.match(core, /完整读一遍参考项目/);
    assert.match(core, /对比一个功能实现/);
    assert.match(core, /安全边界审计/);
    assert.doesNotMatch(core, /PR 顺序/);
  });

  it('ships styling for the header mode pill', async () => {
    const css = await readRendererContractCss();

    assert.match(css, /\.maka-chat-header-mode-pill\s*\{/);
    assert.match(css, /white-space:\s*nowrap/);
    assert.match(css, /var\(--info-text\)/);
    assert.match(css, /\.maka-deep-research-workflow\s*\{/);
    assert.match(
      css,
      /\.maka-deep-research-report,\s*\.maka-deep-research-scope,\s*\.maka-deep-research-evidence,\s*\.maka-deep-research-progress\s*\{/,
    );
  });
});
