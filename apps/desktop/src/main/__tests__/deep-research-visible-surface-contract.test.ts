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
    assert.match(ui, /DEEP_RESEARCH_STARTER_PROMPTS\.map/);
    assert.doesNotMatch(ui, /DEEP_RESEARCH_PROMPT_SUGGESTIONS/);
    assert.match(ui, /固定在 Explore 权限/);
    assert.match(ui, /DEEP_RESEARCH_WORKFLOW_STEPS\.map/);
    assert.match(ui, /aria-label="深度研究流程"/);
    assert.match(ui, /DEEP_RESEARCH_REPORT_SECTIONS\.map/);
    assert.match(ui, /aria-label="深度研究输出结构"/);
    assert.match(ui, /输出必须能直接落地/);
    assert.match(ui, /DEEP_RESEARCH_SCOPE_OPTIONS\.map/);
    assert.match(ui, /aria-label="深度研究范围"/);
    assert.match(ui, /默认按标准深度研究/);
    assert.match(ui, /DEEP_RESEARCH_EVIDENCE_CHECKLIST\.map/);
    assert.match(ui, /aria-label="深度研究证据清单"/);
    assert.match(ui, /每次研究都要留证据/);
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
    const css = await readRepo('apps/desktop/src/renderer/styles.css');

    assert.match(css, /\.maka-chat-header-mode-pill\s*\{/);
    assert.match(css, /white-space:\s*nowrap/);
    assert.match(css, /var\(--info-text\)/);
    assert.match(css, /\.maka-deep-research-workflow\s*\{/);
    assert.match(
      css,
      /\.maka-deep-research-report,\s*\.maka-deep-research-scope,\s*\.maka-deep-research-evidence\s*\{/,
    );
  });
});
