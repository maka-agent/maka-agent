import { strict as assert } from 'node:assert';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { describe, it } from 'node:test';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { resolveProjectGitInfo, resolveProjectRoot } from '../project-context.js';

const repoRoot = process.cwd().endsWith('apps/desktop')
  ? join(process.cwd(), '..', '..')
  : process.cwd();

async function readRepo(path: string): Promise<string> {
  return readFile(join(repoRoot, path), 'utf8');
}

describe('project context workspace picker', () => {
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

  it('resolves the project root by walking upward from nested app paths', async () => {
    const root = await mkdtemp(join(tmpdir(), 'maka-project-root-'));
    const nested = join(root, 'apps', 'desktop');
    const fallback = await mkdtemp(join(tmpdir(), 'maka-project-root-fallback-'));
    try {
      await mkdir(join(root, '.git'), { recursive: true });
      await writeFile(join(root, '.git', 'HEAD'), 'ref: refs/heads/main\n', 'utf8');
      await mkdir(nested, { recursive: true });

      assert.equal(await resolveProjectRoot(['/', nested]), root);
      assert.equal(await resolveProjectRoot([fallback]), fallback);
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(fallback, { recursive: true, force: true });
    }
  });

  it('exposes the main-owned project path through app info', async () => {
    const main = await readRepo('apps/desktop/src/main/main.ts');
    const preload = await readRepo('apps/desktop/src/preload/preload.ts');
    const globalTypes = await readRepo('apps/desktop/src/global.d.ts');

    assert.match(main, /resolveProjectRoot\(\[process\.cwd\(\), app\.getAppPath\(\)\]\)/);
    assert.match(main, /projectGit:\s*await resolveProjectGitInfo\(projectPath\)/);
    assert.match(preload, /projectPath:\s*string;/);
    assert.match(preload, /projectGit:\s*\{ isGitRepo: boolean; branch\?: string \};/);
    assert.match(globalTypes, /projectPath:\s*string;/);
    assert.match(globalTypes, /projectGit:\s*\{ isGitRepo: boolean; branch\?: string \};/);
  });

  it('lets the composer picker choose a new project directory instead of only opening Finder', async () => {
    const main = await readRepo('apps/desktop/src/main/main.ts');
    const preload = await readRepo('apps/desktop/src/preload/preload.ts');
    const globalTypes = await readRepo('apps/desktop/src/global.d.ts');
    const renderer = await readRepo('apps/desktop/src/renderer/main.tsx');
    const workspacePickerBlock = renderer.match(/workspacePicker=\{\{[\s\S]*?\n\s*\}\}/)?.[0] ?? '';

    assert.match(main, /let selectedProjectRoot: string \| null = null;/);
    assert.match(main, /if \(selectedProjectRoot\) return selectedProjectRoot;/);
    assert.match(main, /ipcMain\.handle\(\s*'app:selectProjectDirectory'/);
    assert.match(main, /dialog\.showOpenDialog\(mainWindow,\s*\{[\s\S]*title:\s*'选择工作目录'[\s\S]*properties:\s*\['openDirectory'\]/);
    assert.match(main, /const projectPath = await resolveProjectRoot\(\[selectedPath\]\)/);
    assert.match(main, /selectedProjectRoot = projectPath;/);
    assert.match(main, /projectGit:\s*await resolveProjectGitInfo\(projectPath\)/);
    assert.match(preload, /selectProjectDirectory\(\): Promise</);
    assert.match(preload, /ipcRenderer\.invoke\('app:selectProjectDirectory'\)/);
    assert.match(globalTypes, /selectProjectDirectory\(\): Promise</);
    assert.match(renderer, /async function selectProjectDirectory\(\)/);
    assert.match(renderer, /window\.maka\.app\.selectProjectDirectory\(\)/);
    assert.match(renderer, /const \[projectPickerPending, setProjectPickerPending\] = useState\(false\)/);
    assert.match(renderer, /const projectPickerPendingRef = useRef\(false\)/);
    assert.match(
      renderer,
      /async function selectProjectDirectory\(\) \{[\s\S]*if \(projectPickerPendingRef\.current\) return;[\s\S]*projectPickerPendingRef\.current = true;[\s\S]*setProjectPickerPending\(true\);[\s\S]*window\.maka\.app\.selectProjectDirectory\(\)/,
      'project picker must synchronously reject duplicate native dialog requests before React commits disabled state',
    );
    assert.match(
      renderer,
      /finally \{[\s\S]*projectPickerPendingRef\.current = false;[\s\S]*setProjectPickerPending\(false\);/,
      'project picker must release its pending owner after the native dialog resolves or fails',
    );
    assert.match(renderer, /setAppInfo\(\{ projectPath: result\.projectPath, projectGit: result\.projectGit \}\)/);
    assert.match(renderer, /toastApi\.success\('已切换工作目录', basenameFromPath\(result\.projectPath\)\)/);
    assert.match(workspacePickerBlock, /pending:\s*projectPickerPending/);
    assert.match(workspacePickerBlock, /void selectProjectDirectory\(\)/);
    assert.doesNotMatch(workspacePickerBlock, /openProjectFolder\(\)|openWorkspaceFolder\(\)|openPath\(/);
  });

  it('opens project directory by allowlisted key, not renderer-supplied path', async () => {
    const main = await readRepo('apps/desktop/src/main/main.ts');
    const guard = await readRepo('apps/desktop/src/main/open-path-guard.ts');
    const renderer = await readRepo('apps/desktop/src/renderer/main.tsx');

    assert.match(main, /resolveOpenPath\(\{ key, workspaceRoot, projectRoot:\s*await currentProjectRoot\(\) \}\)/);
    assert.match(guard, /value === 'project'/);
    assert.match(renderer, /window\.maka\.app\.openPath\('project'\)/);
    assert.doesNotMatch(renderer, /openPath\(appInfo\.projectPath\)/);
  });

  it('renders the guarded project picker below the composer', async () => {
    const ui = await readRepo('packages/ui/src/components.tsx');
    const styles = await readRepo('apps/desktop/src/renderer/styles.css');
    const renderer = await readRepo('apps/desktop/src/renderer/main.tsx');

    assert.match(ui, /workspacePicker\?:\s*\{/);
    assert.match(ui, /className="maka-composer-workspace-picker"/);
    assert.match(ui, /branch\?: string \| null;/);
    assert.match(ui, /pending\?: boolean;/);
    assert.match(ui, /disabled=\{props\.workspacePicker\.pending === true\}/);
    assert.match(ui, /aria-busy=\{props\.workspacePicker\.pending === true \? 'true' : undefined\}/);
    // WAWQAQ msg `28128c9e` (2026-06-20): the "选择工作目录" placeholder
    // is only rendered when no directory has been selected yet. Once
    // a label is set, the picker renders `.maka-composer-workspace-current`
    // alone — no more "选择工作目录 ai ▾" doubled string.
    assert.match(ui, /\? <span className="maka-composer-workspace-current">\{props\.workspacePicker\.label\}<\/span>[\s\S]*?: <span>选择工作目录<\/span>/);
    assert.match(ui, /当前分支 \$\{props\.workspacePicker\.branch\}/);
    assert.match(styles, /\.maka-composer-workspace-row\s*\{[\s\S]*?width:\s*min\(var\(--maka-chat-measure,\s*680px\),\s*100%\)/);
    assert.match(styles, /\.maka-composer-workspace-picker\s*\{/);
    assert.match(styles, /-webkit-app-region:\s*no-drag/);
    assert.match(renderer, /basenameFromPath\(appInfo\.projectPath\)/);
    assert.match(renderer, /branch:\s*appInfo\?\.projectGit\.branch/);
    assert.match(renderer, /workspacePicker=\{\{/);
    assert.doesNotMatch(ui, /className="maka-project-badge"/);
  });

  it('adds a command palette action for the same guarded project open path', async () => {
    const palette = await readRepo('apps/desktop/src/renderer/command-palette.tsx');
    const renderer = await readRepo('apps/desktop/src/renderer/main.tsx');
    const openProjectBlock = renderer.match(/async function openProjectFolder\(\)[\s\S]*?async function openWorkspaceFolder/)?.[0] ?? '';
    const openWorkspaceBlock = renderer.match(/async function openWorkspaceFolder\(\)[\s\S]*?function createSkillFailureCopy/)?.[0] ?? '';

    assert.match(palette, /onOpenProjectFolder\?\(\): Promise<void> \| void/);
    assert.match(palette, /id:\s*'diag:open-project-folder'/);
    assert.match(palette, /label:\s*'打开项目目录'/);
    assert.match(renderer, /onOpenProjectFolder:\s*\(\) => openProjectFolder\(\)/);
    assert.match(renderer, /onOpenWorkspace: async \(\) => \{\s*await openWorkspaceFolder\(\);\s*\}/);
    assert.match(renderer, /function openPathActionErrorMessage\(error: unknown, key: 'workspace' \| 'project' \| 'skills'\): string \{[\s\S]*generalizedErrorMessageChinese\(error, `无法打开\$\{openPathActionLabel\(key\)\}，请稍后重试。`\)/);
    assert.match(openProjectBlock, /catch \(error\) \{[\s\S]*toastApi\.error\(`无法打开\$\{openPathActionLabel\('project'\)\}`, openPathActionErrorMessage\(error, 'project'\)\)/);
    assert.match(openWorkspaceBlock, /catch \(error\) \{[\s\S]*toastApi\.error\(`无法打开\$\{openPathActionLabel\('workspace'\)\}`, openPathActionErrorMessage\(error, 'workspace'\)\)/);
    assert.doesNotMatch(openProjectBlock, /cleanErrorMessage\(error\)/);
    assert.doesNotMatch(openWorkspaceBlock, /cleanErrorMessage\(error\)/);
    assert.doesNotMatch(palette, /openPath\('project'\)/);
  });
});
