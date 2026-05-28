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
});
