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
      offered.filter((palette) => !allowed.has(palette)),
      [],
      'Storybook palette toolbar must use the same palette ids as @maka/core.',
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
