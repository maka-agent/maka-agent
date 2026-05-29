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

describe('project context badge', () => {
  it('exposes the main-owned project path through app info', async () => {
    const main = await readRepo('apps/desktop/src/main/main.ts');
    const preload = await readRepo('apps/desktop/src/preload/preload.ts');
    const globalTypes = await readRepo('apps/desktop/src/global.d.ts');

    assert.match(main, /projectPath:\s*process\.cwd\(\)/);
    assert.match(preload, /projectPath:\s*string;/);
    assert.match(globalTypes, /projectPath:\s*string;/);
  });

  it('opens project directory by allowlisted key, not renderer-supplied path', async () => {
    const main = await readRepo('apps/desktop/src/main/main.ts');
    const guard = await readRepo('apps/desktop/src/main/open-path-guard.ts');
    const renderer = await readRepo('apps/desktop/src/renderer/main.tsx');

    assert.match(main, /resolveOpenPath\(\{ key, workspaceRoot, projectRoot:\s*process\.cwd\(\) \}\)/);
    assert.match(guard, /value === 'project'/);
    assert.match(renderer, /window\.maka\.app\.openPath\('project'\)/);
    assert.doesNotMatch(renderer, /openPath\(appInfo\.projectPath\)/);
  });

  it('renders a PawWork-style project badge in the sidebar header', async () => {
    const ui = await readRepo('packages/ui/src/components.tsx');
    const styles = await readRepo('apps/desktop/src/renderer/styles.css');
    const renderer = await readRepo('apps/desktop/src/renderer/main.tsx');

    assert.match(ui, /projectBadge\?:\s*\{/);
    assert.match(ui, /className="maka-project-badge"/);
    assert.match(ui, /项目 · \{props\.projectBadge\.label\}/);
    assert.match(ui, /aria-label=\{`打开项目目录：\$\{props\.projectBadge\.label\}`\}/);
    assert.match(styles, /\.maka-project-badge\s*\{/);
    assert.match(styles, /-webkit-app-region:\s*no-drag/);
    assert.match(renderer, /basenameFromPath\(appInfo\.projectPath\)/);
  });
});
