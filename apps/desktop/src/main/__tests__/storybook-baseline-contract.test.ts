import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, it } from 'node:test';

function findRepoRoot(start: string): string {
  let dir = resolve(start);
  for (;;) {
    if (
      existsSync(join(dir, 'apps', 'desktop', 'package.json'))
      && existsSync(join(dir, 'packages', 'ui', 'package.json'))
    ) {
      return dir;
    }

    const parent = resolve(dir, '..');
    if (parent === dir) {
      throw new Error(`Unable to locate repo root from ${start}`);
    }
    dir = parent;
  }
}

const REPO_ROOT = findRepoRoot(process.cwd());

function readJson(path: string) {
  return JSON.parse(readFileSync(path, 'utf8')) as {
    scripts?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };
}

function readTypescriptConfig(repoRoot: string, configPath: string) {
  const requireFromRepo = createRequire(join(repoRoot, 'package.json'));
  const tscBin = requireFromRepo.resolve('typescript/bin/tsc');
  return JSON.parse(execFileSync(
    process.execPath,
    [tscBin, '-p', configPath, '--showConfig'],
    { encoding: 'utf8' },
  )) as { files?: string[] };
}

describe('Storybook baseline contract', () => {
  it('keeps Storybook as renderer tooling, not part of mandatory build or test', () => {
    const rootPkg = readJson(join(REPO_ROOT, 'package.json'));
    const desktopPkg = readJson(join(REPO_ROOT, 'apps', 'desktop', 'package.json'));
    const desktopScripts = desktopPkg.scripts ?? {};

    assert.match(desktopScripts.storybook ?? '', /storybook dev\b/);
    assert.match(desktopScripts['build-storybook'] ?? '', /storybook build\b/);

    for (const [name, script] of Object.entries({
      'root build': rootPkg.scripts?.build ?? '',
      'root test': rootPkg.scripts?.test ?? '',
      'desktop build': desktopScripts.build ?? '',
      'desktop test': desktopScripts.test ?? '',
    })) {
      assert.doesNotMatch(script, /storybook/i, `${name} must not run Storybook yet`);
    }
  });

  it('uses the renderer Vite/CSS setup so stories render against the app substrate', () => {
    const storybookDir = join(REPO_ROOT, 'apps', 'desktop', '.storybook');
    const mainPath = join(storybookDir, 'main.ts');
    const previewPath = join(storybookDir, 'preview.tsx');

    assert.ok(existsSync(mainPath), 'desktop Storybook must define .storybook/main.ts');
    assert.ok(existsSync(previewPath), 'desktop Storybook must define .storybook/preview.tsx');

    const main = readFileSync(mainPath, 'utf8');
    const preview = readFileSync(previewPath, 'utf8');

    assert.match(main, /framework:\s*\{\s*name:\s*['"]@storybook\/react-vite['"]/);
    assert.match(main, /@maka\/ui/);
    assert.match(main, /packages\/ui\/src/);
    assert.match(preview, /\.\.\/src\/renderer\/styles\.css/);
    assert.match(preview, /data-maka-theme/);
  });

  it('offers only real Maka theme palettes in the Storybook toolbar', () => {
    const preview = readFileSync(join(REPO_ROOT, 'apps', 'desktop', '.storybook', 'preview.tsx'), 'utf8');
    const settings = readFileSync(join(REPO_ROOT, 'packages', 'core', 'src', 'settings.ts'), 'utf8');
    const paletteSource = settings.match(/export const THEME_PALETTES = \[([\s\S]*?)\] as const;/)?.[1] ?? '';
    const allowed = new Set([...paletteSource.matchAll(/'([^']+)'/g)].map((match) => match[1]));
    const toolbarItems = preview.match(/palette:\s*\{[\s\S]*?items:\s*\[([\s\S]*?)\]/)?.[1] ?? '';
    const offered = [...toolbarItems.matchAll(/value:\s*'([^']+)'/g)].map((match) => match[1]);

    assert.ok(offered.length > 0, 'Storybook palette toolbar must expose at least one palette option');
    assert.deepEqual(
      [...allowed].sort(),
      [...offered].sort(),
      'Storybook palette toolbar must expose every @maka/core palette, no more, no less.',
    );
  });

  it('seeds primitive stories as the isolation acceptance fixture', () => {
    const primitiveStories = join(REPO_ROOT, 'packages', 'ui', 'stories', 'storybook-baseline.stories.tsx');
    assert.ok(existsSync(primitiveStories), 'Storybook baseline must include a primitive story fixture');

    const src = readFileSync(primitiveStories, 'utf8');
    assert.match(src, /satisfies\s+Meta/);
    assert.match(src, /Button/);
    assert.match(src, /Empty/);
    assert.doesNotMatch(src, /className=/, 'Story fixtures must not add story-only Tailwind classes.');
  });

  it('storyboards the sidebar session list states before visual polish', () => {
    const sidebarStories = join(REPO_ROOT, 'packages', 'ui', 'stories', 'session-list-panel.stories.tsx');
    assert.ok(existsSync(sidebarStories), 'Sidebar session-list states must be inspectable in Storybook');

    const src = readFileSync(sidebarStories, 'utf8');
    assert.match(src, /title:\s*['"]Product\/Sidebar Session List['"]/);
    assert.match(src, /SessionListPanel/);
    assert.match(src, /satisfies\s+Meta/);
    for (const storyName of [
      'Empty',
      'LongList',
      'StatusGroups',
      'RowActions',
      'LongTitlesAndNarrow',
      'Collapsed',
    ]) {
      assert.match(src, new RegExp(`export const ${storyName}\\b`));
    }
    assert.match(src, /statusGroups/);
    assert.doesNotMatch(src, /app-shell/, 'Sidebar stories must not import the desktop app shell.');
  });

  it('storyboards ToolActivity result variants before visual polish', () => {
    const storyPath = join(REPO_ROOT, 'packages', 'ui', 'stories', 'tool-activity.stories.tsx');
    const fixturePath = join(REPO_ROOT, 'packages', 'ui', 'stories', 'tool-activity.fixtures.ts');
    assert.ok(existsSync(storyPath), 'ToolActivity must have a surface-scoped Storybook storyboard');
    assert.ok(existsSync(fixturePath), 'ToolActivity stories must keep dense fixture data in a sibling fixture file');

    const story = readFileSync(storyPath, 'utf8');
    const fixtures = readFileSync(fixturePath, 'utf8');

    assert.match(story, /title:\s*'Product\/Tool Activity'/);
    assert.match(story, /satisfies\s+Meta/);
    assert.match(story, /\bToolActivity\b/);

    for (const exportName of [
      'StatusOverview',
      'TerminalAndLiveOutput',
      'FileDiffAndWebSearch',
      'SubagentAndExplore',
      'OfficeDocument',
      'ErrorsAndPermissionDenied',
      'CopyFeedback',
      'DenseMixedResults',
    ]) {
      assert.match(story, new RegExp(`export const ${exportName}: Story`), `${exportName} story must be exported`);
    }

    for (const requiredKind of [
      'terminal',
      'file_diff',
      'web_search',
      'web_search_error',
      'subagent',
      'explore_agent',
      'office_document',
    ]) {
      assert.match(fixtures, new RegExp(`kind:\\s*'${requiredKind}'`), `${requiredKind} fixture must exist`);
    }

    assert.match(fixtures, /outputTruncated:\s*true/, 'stories must cover live-output truncation');
    assert.match(fixtures, /User denied permission/, 'stories must cover permission-denied copy');
    assert.match(story, /expandAll/, 'result preview stories must expose collapsed successful previews for visual review');
    assert.match(story, /autoCopyLabel/, 'stories must expose copy feedback rather than only idle copy buttons');
  });

  it('labels the retained functional motion examples', () => {
    const story = readFileSync(join(REPO_ROOT, 'packages', 'ui', 'stories', 'animation-catalog.stories.tsx'), 'utf8');

    assert.match(story, /title:\s*'Design System\/Animation Catalog'/);
    for (const label of ['Spinner', 'Status pulse', 'Shimmer']) {
      assert.match(story, new RegExp(`>\\s*${label}\\s*<`), `${label} must be visible beside its motion sample`);
    }
  });

  it('tracks every icon export in the Design System Icons story', () => {
    const storyPath = join(REPO_ROOT, 'packages', 'ui', 'stories', 'icons.stories.tsx');
    assert.ok(existsSync(storyPath), 'Design System must include an Icons story');

    const story = readFileSync(storyPath, 'utf8');
    assert.match(story, /title:\s*['"]Design System\/Icons['"]/);
    assert.match(story, /import\s+\*\s+as\s+Icons\s+from\s+['"]\.\.\/src\/icons\.js['"]/);
    assert.match(story, /MakaIcon\(/, 'Icons story must filter makeIcon products by displayName');
    assert.match(story, /MAKA_BOT_ICON_BODIES/);
    assert.match(story, /Object\.keys\(MAKA_BOT_ICON_BODIES\)/);
    assert.match(story, /maka-bot:/);
  });

  it('splits design token examples into focused stories', () => {
    const story = readFileSync(join(REPO_ROOT, 'packages', 'ui', 'stories', 'design-tokens.stories.tsx'), 'utf8');

    assert.match(story, /title:\s*'Design System\/Tokens'/);
    for (const exportName of ['Colors', 'Radius', 'PrimaryActions', 'SemanticColors']) {
      assert.match(story, new RegExp(`export const ${exportName}: Story`), `${exportName} story must be exported`);
    }
    assert.doesNotMatch(story, /export const TokenOverview/);

    const colorSwatches = story.slice(
      story.indexOf('const colorSwatches'),
      story.indexOf('const emphasisAliases'),
    );
    assert.match(colorSwatches, /'--action'/);
    assert.match(colorSwatches, /'--control'/);
    for (const noisyToken of ['--foreground-5', '--foreground-30', '--foreground-50', '--foreground-70', '--link', '--focus-ring', '--status-running', '--nav-active', '--toast-accent']) {
      assert.doesNotMatch(colorSwatches, new RegExp(noisyToken), `${noisyToken} should not render as a separate color swatch`);
    }
  });

  it('storyboards provider settings states before visual polish', () => {
    const main = readFileSync(join(REPO_ROOT, 'apps', 'desktop', '.storybook', 'main.ts'), 'utf8');
    const storyPath = join(REPO_ROOT, 'apps', 'desktop', 'stories', 'settings', 'provider-settings.stories.tsx');
    assert.match(main, /apps\/desktop\/stories\/\*\*\/\*\.stories\.\@\(ts\|tsx\)/);
    assert.ok(existsSync(storyPath), 'Provider settings states must be inspectable in Storybook');

    const story = readFileSync(storyPath, 'utf8');
    assert.match(story, /title:\s*['"]Product\/Settings\/Providers['"]/);
    assert.match(story, /satisfies\s+Meta/);
    assert.match(story, /\bProvidersPanel\b/);
    assert.match(story, /ToastProvider/);
    assert.match(story, /className="settingsSurface"/);

    for (const storyName of [
      'Loading',
      'LoadError',
      'Empty',
      'ConfiguredProviders',
      'ProblemConnections',
      'SelectedDetail',
      'AddProvider',
      'OAuthCards',
    ]) {
      assert.match(story, new RegExp(`export const ${storyName}: Story`), `${storyName} story must be exported`);
    }

    assert.match(story, /ConnectionsBridge/, 'stories must drive ProvidersPanel through its bridge seam');
    assert.match(story, /claudeSubscription/, 'OAuth cards must render against story-local subscription fixtures');
    assert.doesNotMatch(storyPath, /src\/renderer/, 'desktop Storybook stories must stay out of the renderer build tree');
  });

  it('storyboards command palette and content search modal states before visual polish', () => {
    const storybookMain = readFileSync(join(REPO_ROOT, 'apps', 'desktop', '.storybook', 'main.ts'), 'utf8');
    const storyPath = join(REPO_ROOT, 'apps', 'desktop', 'stories', 'command-search.stories.tsx');

    assert.match(
      storybookMain,
      /apps\/desktop\/stories\/\*\*\/\*\.stories\.\@\(ts\|tsx\)/,
      'Desktop renderer stories must be discoverable by Storybook.',
    );
    assert.ok(existsSync(storyPath), 'Command/search modal states must be inspectable in Storybook');

    const story = readFileSync(storyPath, 'utf8');
    assert.match(story, /title:\s*['"]Product\/Command Search['"]/);
    assert.match(story, /satisfies\s+Meta/);
    assert.match(story, /\bCommandPalette\b/);
    assert.match(story, /\bSearchModal\b/);

    for (const storyName of [
      'CommandPaletteGroupedResults',
      'CommandPaletteEmpty',
      'CommandPaletteDisabledCommand',
      'CommandPaletteKeyboardFocusedSelection',
      'CommandPaletteContentSearchLoading',
      'CommandPaletteContentSearchResults',
      'CommandPaletteContentSearchError',
      'CommandPaletteContentSearchBlocked',
      'SearchModalEmpty',
      'SearchModalLoading',
      'SearchModalResults',
      'SearchModalNoResults',
      'SearchModalError',
      'SearchModalBlocked',
    ]) {
      assert.match(story, new RegExp(`export const ${storyName}: Story`), `${storyName} story must be exported`);
    }

    assert.doesNotMatch(storyPath, /src\/renderer/, 'desktop Storybook stories must stay out of the renderer build tree');
    assert.doesNotMatch(story, /window\.maka/, 'Command/search stories must not depend on the preload bridge');
    assert.doesNotMatch(story, /app-shell/, 'Command/search stories must not import the desktop app shell');
  });

  it('keeps Storybook stories out of the regular @maka/ui TypeScript build', () => {
    const config = readTypescriptConfig(REPO_ROOT, join(REPO_ROOT, 'packages', 'ui', 'tsconfig.json'));

    assert.equal(
      (config.files ?? []).some((file) => /\.stories\.tsx?$/.test(file)),
      false,
      '@maka/ui tsc must not compile Storybook stories as part of the package build.',
    );
  });

  it('resolves TypeScript when worktrees borrow parent dependencies', () => {
    const sandbox = mkdtempSync(join(tmpdir(), 'maka-storybook-tsc-'));
    try {
      const parent = join(sandbox, 'repo');
      const repoRoot = join(parent, '.worktree', 'topic');
      const tscPath = join(parent, 'node_modules', 'typescript', 'bin', 'tsc');
      const configPath = join(repoRoot, 'packages', 'ui', 'tsconfig.json');

      mkdirSync(join(repoRoot, 'packages', 'ui'), { recursive: true });
      mkdirSync(join(parent, 'node_modules', 'typescript', 'bin'), { recursive: true });
      writeFileSync(join(repoRoot, 'package.json'), '{"private":true}', 'utf8');
      writeFileSync(configPath, '{}', 'utf8');
      writeFileSync(
        tscPath,
        'console.log(JSON.stringify({ files: ["packages/ui/src/index.ts"] }));\n',
        'utf8',
      );

      const config = readTypescriptConfig(repoRoot, configPath);

      assert.deepEqual(config.files, ['packages/ui/src/index.ts']);
      assert.equal(existsSync(join(repoRoot, 'node_modules', '.bin', 'tsc')), false);
    } finally {
      rmSync(sandbox, { recursive: true, force: true });
    }
  });
});
