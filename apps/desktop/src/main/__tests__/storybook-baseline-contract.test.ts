import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, it } from 'node:test';

const REPO_ROOT = resolve(process.cwd(), '..', '..');

function readJson(path: string) {
  return JSON.parse(readFileSync(path, 'utf8')) as {
    scripts?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };
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

  it('seeds primitive stories as the isolation acceptance fixture', () => {
    const primitiveStories = join(REPO_ROOT, 'packages', 'ui', 'src', 'primitives', 'storybook-baseline.stories.tsx');
    assert.ok(existsSync(primitiveStories), 'Storybook baseline must include a primitive story fixture');

    const src = readFileSync(primitiveStories, 'utf8');
    assert.match(src, /satisfies\s+Meta/);
    assert.match(src, /Button/);
    assert.match(src, /Empty/);
  });
});
