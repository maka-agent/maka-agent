import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

test('startup onboarding loading slot paints visible skeleton chrome', () => {
  const cwd = process.cwd();
  const desktopRoot = cwd.endsWith(join('apps', 'desktop')) ? cwd : join(cwd, 'apps', 'desktop');
  const css = readFileSync(join(desktopRoot, 'src', 'renderer', 'styles', 'onboarding.css'), 'utf8');
  const block = css.match(/\.maka-onboarding-loading\s*\{[\s\S]*?\n\}/)?.[0] ?? '';

  assert.match(block, /background:\s*var\(--foreground-5\)/);
  assert.match(block, /border:\s*1px solid var\(--border-strong\)/);
  assert.match(block, /box-shadow:/);
  assert.match(css, /var\(--foreground-8\)/);
  assert.match(css, /\.maka-onboarding-loading::before\s*\{/);
  assert.match(css, /\.maka-onboarding-loading::after\s*\{/);
});

test('renderer keeps preload skeleton visible while lazy app shell loads', () => {
  const cwd = process.cwd();
  const desktopRoot = cwd.endsWith(join('apps', 'desktop')) ? cwd : join(cwd, 'apps', 'desktop');
  const appSource = readFileSync(join(desktopRoot, 'src', 'renderer', 'app.tsx'), 'utf8');

  assert.doesNotMatch(appSource, /fallback=\{null\}/);
  assert.match(appSource, /fallback=\{<StartupFallback \/>\}/);
  assert.match(appSource, /className="maka-preload"/);
});
