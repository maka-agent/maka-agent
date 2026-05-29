import { strict as assert } from 'node:assert';
import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';
import { join } from 'node:path';

const repoRoot = process.cwd().endsWith('apps/desktop')
  ? join(process.cwd(), '..', '..')
  : process.cwd();

async function readRepo(path: string): Promise<string> {
  return readFile(join(repoRoot, path), 'utf8');
}

describe('sidebar version info contract', () => {
  it('wires the footer version action to the real About settings page', async () => {
    const main = await readRepo('apps/desktop/src/renderer/main.tsx');
    assert.match(
      main,
      /onOpenUpdate=\{\(\) => openSettingsSection\('about'\)\}/,
      'sidebar version action must open Settings · 关于 instead of a placeholder/noop',
    );
  });

  it('does not show the update-coming-soon copy in the wired footer action', async () => {
    const ui = await readRepo('packages/ui/src/components.tsx');
    const buttonBranch = ui.match(/\{props\.onOpenUpdate \? \([\s\S]*?\) : \(/)?.[0] ?? '';
    assert.match(buttonBranch, /aria-label="版本信息"/);
    assert.match(buttonBranch, /<span>版本信息<\/span>/);
    assert.doesNotMatch(buttonBranch, /即将推出|版本更新/, 'wired footer action must be version info, not update roadmap copy');
  });

  it('daily review fallback copy is a bridge-missing state, not a coming-soon product claim', async () => {
    const ui = await readRepo('packages/ui/src/components.tsx');
    const dailyReviewStub = ui.match(/'daily-review':\s*\{[\s\S]*?\n\s*\},/)?.[0] ?? '';
    assert.match(dailyReviewStub, /每日回顾未连接/);
    assert.doesNotMatch(dailyReviewStub, /即将推出|入口占位|未接真实数据/);
    assert.match(ui, /每日回顾数据桥未连接/, 'Daily Review detail fallback must explain the missing bridge');
    assert.doesNotMatch(ui, /占位内容/, 'Daily Review fallback must not describe itself as placeholder content');
  });
});
