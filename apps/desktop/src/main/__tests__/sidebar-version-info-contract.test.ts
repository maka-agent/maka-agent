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
    assert.match(
      ui,
      /onOpenUpdate\(\): void;/,
      'SessionListPanel must require the real version-info action instead of accepting a missing callback',
    );
    assert.doesNotMatch(
      ui,
      /onOpenUpdate\?\(\): void;/,
      'SessionListPanel must not keep the version-info callback optional',
    );
    assert.match(ui, /onClick=\{props\.onOpenUpdate\}/);
    assert.match(ui, /aria-label="版本信息"/);
    assert.match(ui, /<span>版本信息<\/span>/);
    assert.doesNotMatch(
      ui,
      /data-state="coming_soon"|版本信息不可用|maka-nav-row-state-badge|即将推出|版本更新/,
      'footer version action must be a real button, not a coming-soon/unavailable fallback',
    );
  });

  it('does not keep sidebar-only coming-soon CSS for version info', async () => {
    const css = await readRepo('apps/desktop/src/renderer/styles.css');
    assert.doesNotMatch(
      css,
      /\.maka-nav-row\[data-state="coming_soon"\]|\.maka-nav-row-state-badge|版本更新/,
      'sidebar footer CSS must not preserve the removed update placeholder state',
    );
  });

  it('daily review fallback copy is a main-pane bridge-missing state, not a coming-soon product claim', async () => {
    const ui = await readRepo('packages/ui/src/components.tsx');
    const dailyReviewModeBlock = ui.match(/if \(props\.mode === 'daily-review'\) \{[\s\S]*?^\s*\}/m)?.[0] ?? '';

    assert.match(dailyReviewModeBlock, /等待连接每日回顾数据/);
    assert.match(dailyReviewModeBlock, /桌面端数据桥当前未连接/, 'Daily Review main-pane fallback must explain the missing bridge as a current connection state');
    assert.doesNotMatch(dailyReviewModeBlock, /每日回顾未连接|暂不可用|即将推出|入口占位|未接真实数据/);
    assert.doesNotMatch(ui, /占位内容/, 'Daily Review fallback must not describe itself as placeholder content');
  });
});
