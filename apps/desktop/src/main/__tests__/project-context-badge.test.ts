import { strict as assert } from 'node:assert';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { describe, it } from 'node:test';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { resolveProjectGitInfo, resolveProjectRoot } from '@maka/runtime';
import { readRendererContractCss } from './contract-css-helpers.js';
import { readMainProcessCombinedSource } from './main-process-contract-source-helpers.js';
import { readRendererShellCombinedSource } from './renderer-shell-source-helpers.js';

const repoRoot = process.cwd().endsWith('apps/desktop')
  ? join(process.cwd(), '..', '..')
  : process.cwd();

async function readRepo(path: string): Promise<string> {
  if (path === 'apps/desktop/src/main/main.ts') return readMainProcessCombinedSource();
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
    assert.match(main, /function registerIpc\(\): void/);
    assert.match(main, /const persistedProjectRootPromise = loadPersistedProjectRoot\(\)/);
    assert.doesNotMatch(main, /async function registerIpc\(\): Promise<void>/);
    assert.doesNotMatch(main, /void registerIpc\(\);/);
    assert.match(preload, /projectPath:\s*string;/);
    assert.match(preload, /projectGit:\s*\{ isGitRepo: boolean; branch\?: string \};/);
    assert.match(globalTypes, /projectPath:\s*string;/);
    assert.match(globalTypes, /projectGit:\s*\{ isGitRepo: boolean; branch\?: string \};/);
  });

  it('lets the composer picker choose a new project directory instead of only opening Finder', async () => {
    const main = await readRepo('apps/desktop/src/main/main.ts');
    const preload = await readRepo('apps/desktop/src/preload/preload.ts');
    const globalTypes = await readRepo('apps/desktop/src/global.d.ts');
    const renderer = await readRendererShellCombinedSource();
    const workspacePickerBlock = renderer.match(/workspacePicker=\{\{[\s\S]*?\n\s*\}\}/)?.[0] ?? '';

    assert.match(main, /let selectedProjectRoot: string \| null = null;/);
    assert.match(main, /if \(selectedProjectRoot\) return selectedProjectRoot;/);
    assert.match(main, /async function resolveExplicitProjectRoot\(projectPath: unknown\): Promise</);
    assert.match(main, /ipcMain\.handle\(\s*'app:selectProjectDirectory'/);
    assert.match(main, /mainWindowController\.showOpenDialog\(\{[\s\S]*title:\s*'选择工作目录'[\s\S]*properties:\s*\['openDirectory'\]/);
    assert.match(main, /dialog\.showOpenDialog\(mainWindow,\s*options\)/);
    assert.match(main, /const projectPath = await resolveProjectRoot\(\[selectedPath\]\)/);
    assert.match(main, /selectedProjectRoot = projectPath;/);
    assert.match(main, /projectGit:\s*await resolveProjectGitInfo\(projectPath\)/);
    assert.match(
      main,
      /'app:resolveProjectGitInfo'[\s\S]*const explicitRoot = await resolveExplicitProjectRoot\(projectPath\);[\s\S]*if \(!explicitRoot\.ok\) return explicitRoot;/,
      'explicit project git lookups must validate the supplied path instead of falling back to process.cwd()',
    );
    assert.match(
      main,
      /async function loadPersistedProjectRoot\(\): Promise<string \| null> \{[\s\S]*await stat\(parsed\.projectPath\)[\s\S]*return await resolveProjectRoot\(\[parsed\.projectPath\]\)/,
      'restored last-project-path must be validated before it becomes currentProjectRoot',
    );
    assert.match(
      main,
      /if \(selectedProjectRoot\) return selectedProjectRoot;[\s\S]*const persistedProjectRoot = await persistedProjectRootPromise;[\s\S]*if \(persistedProjectRoot\) \{[\s\S]*selectedProjectRoot = persistedProjectRoot;[\s\S]*return persistedProjectRoot;/,
      'currentProjectRoot must await the validated persisted project before falling back',
    );
    assert.match(preload, /selectProjectDirectory\(\): Promise</);
    assert.match(preload, /ipcRenderer\.invoke\('app:selectProjectDirectory'\)/);
    assert.match(globalTypes, /selectProjectDirectory\(\): Promise</);
    assert.match(renderer, /async function selectProjectDirectory\(\)/);
    assert.match(renderer, /window\.maka\.app\.selectProjectDirectory\(\)/);
    assert.match(renderer, /const \[projectPickerPending, setProjectPickerPending\] = useState\(false\)/);
    assert.match(renderer, /const rendererMountedRef = useRef\(true\)/);
    assert.match(renderer, /const projectPickerPendingRef = useRef\(false\)/);
    assert.match(renderer, /const projectPickerRequestRef = useRef\(0\)/);
    assert.match(
      renderer,
      /return \(\) => \{[\s\S]*rendererMountedRef\.current = false;[\s\S]*projectPickerRequestRef\.current \+= 1;[\s\S]*projectPickerPendingRef\.current = false;/,
      'project picker must invalidate native-dialog owners when the renderer shell unmounts',
    );
    assert.match(
      renderer,
      /async function selectProjectDirectory\(\) \{[\s\S]*if \(projectPickerPendingRef\.current\) return;[\s\S]*const requestId = projectPickerRequestRef\.current \+ 1;[\s\S]*projectPickerRequestRef\.current = requestId;[\s\S]*projectPickerPendingRef\.current = true;[\s\S]*setProjectPickerPending\(true\);[\s\S]*const isCurrentProjectPickerRequest = \(\) => rendererMountedRef\.current && projectPickerRequestRef\.current === requestId;[\s\S]*window\.maka\.app\.selectProjectDirectory\(\)[\s\S]*if \(!isCurrentProjectPickerRequest\(\)\) return;/,
      'project picker must synchronously reject duplicate native dialog requests before React commits disabled state',
    );
    assert.match(
      renderer,
      /catch \(error\) \{[\s\S]*if \(isCurrentProjectPickerRequest\(\)\) \{[\s\S]*toastApi\.error\('选择工作目录失败'/,
      'project picker failure feedback must stay scoped to the current mounted picker request',
    );
    assert.match(
      renderer,
      /finally \{[\s\S]*if \(projectPickerRequestRef\.current === requestId\) \{[\s\S]*projectPickerPendingRef\.current = false;[\s\S]*if \(rendererMountedRef\.current\) setProjectPickerPending\(false\);/,
      'project picker must release only the matching pending owner after the native dialog resolves or fails',
    );
    assert.match(renderer, /setAppInfo\(\{ projectPath: result\.projectPath, projectGit: result\.projectGit \}\)/);
    assert.match(renderer, /toastApi\.success\('已切换工作目录', basenameFromPath\(result\.projectPath\)\)/);
    assert.match(workspacePickerBlock, /pending:\s*projectPickerPending/);
    assert.match(workspacePickerBlock, /void selectProjectDirectory\(\)/);
    assert.doesNotMatch(workspacePickerBlock, /openProjectFolder\(\)|openWorkspaceFolder\(\)|openPath\(/);
  });

  it('defaults new sessions to the main-owned current project root', async () => {
    const main = await readRepo('apps/desktop/src/main/main.ts');
    const chatActions = await readRepo('apps/desktop/src/renderer/app-shell-chat-actions.ts');

    assert.match(main, /const cwd = input\?\.cwd \?\? \(await currentProjectRoot\(\)\)/);
    assert.match(main, /handleQuickChatStart\(input, currentProjectRoot\)/);
    assert.match(main, /cwd:\s*await getCurrentProjectRoot\(\)/);
    assert.doesNotMatch(main, /const cwd = input\?\.cwd \?\? process\.cwd\(\)/);
    assert.doesNotMatch(main, /cwd:\s*process\.cwd\(\)/);
    assert.doesNotMatch(chatActions, /\.\.\.\(projectPath \? \{ cwd: projectPath \} : \{\}\)/);
  });

  it('resolves workspace instruction files under the selected project root', async () => {
    const main = await readRepo('apps/desktop/src/main/main.ts');

    assert.match(main, /ipcMain\.handle\('workspaceInstructions:getState', async \(\) => getWorkspaceInstructionsState\(await currentProjectRoot\(\)\)\)/);
    assert.match(main, /resolveWorkspaceInstructionFileForOpen\(await currentProjectRoot\(\), typeof file === 'string' \? file : ''\)/);
    assert.match(main, /createWorkspaceInstructionFile\(await currentProjectRoot\(\), typeof file === 'string' \? file : ''\)/);
    assert.doesNotMatch(main, /workspaceInstructions:getState', \(\) => getWorkspaceInstructionsState\(process\.cwd\(\)\)/);
  });

  it('opens project directory by allowlisted key, not renderer-supplied path', async () => {
    const main = await readRepo('apps/desktop/src/main/main.ts');
    const guard = await readRepo('apps/desktop/src/main/open-path-guard.ts');
    const renderer = await readRendererShellCombinedSource();

    assert.match(main, /resolveOpenPath\(\{ key, workspaceRoot, projectRoot:\s*await currentProjectRoot\(\) \}\)/);
    assert.match(guard, /value === 'project'/);
    assert.match(renderer, /window\.maka\.app\.openPath\('project'\)/);
    assert.doesNotMatch(renderer, /openPath\(appInfo\.projectPath\)/);
  });

  it('renders the guarded project picker below the composer', async () => {
    const ui = await readRepo('packages/ui/src/composer.tsx');
    const styles = await readRendererContractCss();
    const renderer = await readRendererShellCombinedSource();

    assert.match(ui, /workspacePicker\?:\s*\{/);
    assert.match(ui, /className="maka-composer-workspace-picker"/);
    assert.match(ui, /branch\?: string \| null;/);
    assert.match(ui, /pending\?: boolean;/);
    assert.match(ui, /disabled=\{wp\.pending === true\}/);
    assert.match(ui, /aria-busy=\{wp\.pending === true \? 'true' : undefined\}/);
    // WAWQAQ msg `28128c9e` (2026-06-20): the "选择工作目录" placeholder
    // is only rendered when no directory has been selected yet. Once
    // a label is set, the picker renders `.maka-composer-workspace-current`
    // alone — no more "选择工作目录 ai ▾" doubled string.
    assert.match(ui, /\? <span className="maka-composer-workspace-current">\{wp\.label\}<\/span>[\s\S]*?: <span>选择工作目录<\/span>/);
    assert.match(ui, /当前分支 \$\{wp\.branch\}/);
    // Workspace picker must track the shared chat/composer measure token,
    // not a bespoke hard-coded width, so future measure updates keep the
    // row aligned with the composer card automatically.
    assert.match(styles, /\.maka-composer-workspace-row\s*\{[\s\S]*?width:\s*min\(var\(--maka-chat-measure\),\s*100%\)/);
    assert.match(styles, /\.maka-composer-workspace-picker\s*\{/);
    assert.match(styles, /-webkit-app-region:\s*no-drag/);
    assert.match(renderer, /basenameFromPath\(appInfo\.projectPath\)/);
    assert.match(renderer, /branch:\s*appInfo\?\.projectGit\.branch/);
    assert.match(renderer, /workspacePicker=\{\{/);
    assert.doesNotMatch(ui, /className="maka-project-badge"/);
  });

  it('adds a command palette action for the same guarded project open path', async () => {
    const palette = await readRepo('apps/desktop/src/renderer/command-palette.tsx');
    const renderer = await readRendererShellCombinedSource();
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
