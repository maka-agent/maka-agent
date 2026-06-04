import { strict as assert } from 'node:assert';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { describe, it } from 'node:test';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { resolveProjectGitInfo } from '../project-context.js';

const repoRoot = process.cwd().endsWith('apps/desktop')
  ? join(process.cwd(), '..', '..')
  : process.cwd();

async function readRepo(path: string): Promise<string> {
  return readFile(join(repoRoot, path), 'utf8');
}

describe('project context badge', () => {
  it('resolves git branch from normal and worktree-style .git metadata', async () => {
    const root = await mkdtemp(join(tmpdir(), 'maka-project-context-'));
    const worktree = await mkdtemp(join(tmpdir(), 'maka-project-context-worktree-'));
    const gitDir = await mkdtemp(join(tmpdir(), 'maka-project-context-gitdir-'));
    try {
      await mkdir(join(root, '.git'), { recursive: true });
      await writeFile(join(root, '.git', 'HEAD'), 'ref: refs/heads/main\n', 'utf8');
      assert.deepEqual(await resolveProjectGitInfo(root), { isGitRepo: true, branch: 'main' });

      await writeFile(join(worktree, '.git'), `gitdir: ${gitDir}\n`, 'utf8');
      await writeFile(join(gitDir, 'HEAD'), 'ref: refs/heads/feature/sidebar\n', 'utf8');
      assert.deepEqual(await resolveProjectGitInfo(worktree), { isGitRepo: true, branch: 'feature/sidebar' });
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(worktree, { recursive: true, force: true });
      await rm(gitDir, { recursive: true, force: true });
    }
  });

  it('exposes the main-owned project path through app info', async () => {
    const main = await readRepo('apps/desktop/src/main/main.ts');
    const preload = await readRepo('apps/desktop/src/preload/preload.ts');
    const globalTypes = await readRepo('apps/desktop/src/global.d.ts');

    assert.match(main, /projectPath = process\.cwd\(\)/);
    assert.match(main, /projectGit:\s*await resolveProjectGitInfo\(projectPath\)/);
    assert.match(preload, /projectPath:\s*string;/);
    assert.match(preload, /projectGit:\s*\{ isGitRepo: boolean; branch\?: string \};/);
    assert.match(globalTypes, /projectPath:\s*string;/);
    assert.match(globalTypes, /projectGit:\s*\{ isGitRepo: boolean; branch\?: string \};/);
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

  it('renders a project badge in the sidebar header', async () => {
    const ui = await readRepo('packages/ui/src/components.tsx');
    const styles = await readRepo('apps/desktop/src/renderer/styles.css');
    const renderer = await readRepo('apps/desktop/src/renderer/main.tsx');

    assert.match(ui, /projectBadge\?:\s*\{/);
    assert.match(ui, /className="maka-project-badge"/);
    assert.match(ui, /branch\?: string;/);
    assert.match(ui, /项目 · \{props\.projectBadge\.label\}\{props\.projectBadge\.branch \? ` · \$\{props\.projectBadge\.branch\}` : ''\}/);
    assert.match(ui, /当前分支 \$\{props\.projectBadge\.branch\}/);
    assert.match(styles, /\.maka-project-badge\s*\{/);
    assert.match(styles, /-webkit-app-region:\s*no-drag/);
    assert.match(renderer, /basenameFromPath\(appInfo\.projectPath\)/);
    assert.match(renderer, /branch:\s*appInfo\.projectGit\.branch/);
  });

  it('adds a command palette action for the same guarded project open path', async () => {
    const palette = await readRepo('apps/desktop/src/renderer/command-palette.tsx');
    const renderer = await readRepo('apps/desktop/src/renderer/main.tsx');
    const openProjectBlock = renderer.match(/async function openProjectFolder\(\)[\s\S]*?function createSkillFailureCopy/)?.[0] ?? '';
    const openWorkspaceBlock = renderer.match(/onOpenWorkspace: async \(\) => \{[\s\S]*?onOpenProjectFolder:/)?.[0] ?? '';

    assert.match(palette, /onOpenProjectFolder\?\(\): Promise<void> \| void/);
    assert.match(palette, /id:\s*'diag:open-project-folder'/);
    assert.match(palette, /label:\s*'打开项目目录'/);
    assert.match(renderer, /onOpenProjectFolder:\s*\(\) => openProjectFolder\(\)/);
    assert.match(openProjectBlock, /catch \(error\) \{[\s\S]*toastApi\.error\(`无法打开\$\{openPathActionLabel\('project'\)\}`, cleanErrorMessage\(error\)\)/);
    assert.match(openWorkspaceBlock, /catch \(error\) \{[\s\S]*toastApi\.error\(`无法打开\$\{openPathActionLabel\('workspace'\)\}`, cleanErrorMessage\(error\)\)/);
    assert.doesNotMatch(palette, /openPath\('project'\)/);
  });
});
