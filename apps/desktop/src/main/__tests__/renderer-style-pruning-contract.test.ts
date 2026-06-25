import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';

const REPO_ROOT = resolve(process.cwd(), '..', '..');
const STYLES_PATH = resolve(REPO_ROOT, 'apps', 'desktop', 'src', 'renderer', 'styles.css');
const SOURCE_ROOTS = [
  resolve(REPO_ROOT, 'apps', 'desktop', 'src', 'renderer'),
  resolve(REPO_ROOT, 'packages', 'ui', 'src'),
];
const SOURCE_EXTENSIONS = new Set(['.html', '.js', '.jsx', '.ts', '.tsx']);
const DYNAMIC_STYLE_HOOKS = new Set([
  // OverlayScrollbars appends these classes under the configured
  // `os-theme-maka` theme at runtime.
  'os-scrollbar-horizontal',
  'os-scrollbar-vertical',
  // ProvidersPanel builds these status modifiers with template strings:
  // `enabledRollup is-${group.rollup}` and
  // `enabledConnStatus is-${connection.lastTestStatus ?? 'untested'}`.
  'is-err',
  'is-error',
  'is-idle',
  'is-needs_reauth',
  'is-ok',
  'is-untested',
  'is-verified',
  'is-warn',
]);

async function readSourceFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = await Promise.all(entries.map(async (entry) => {
    const entryPath = resolve(dir, entry.name);
    if (entry.isDirectory()) return readSourceFiles(entryPath);
    if (!SOURCE_EXTENSIONS.has(entryPath.slice(entryPath.lastIndexOf('.')))) return [];
    return [await readFile(entryPath, 'utf8')];
  }));
  return files.flat();
}

function stripCssComments(styles: string): string {
  return styles.replace(/\/\*[\s\S]*?\*\//g, '');
}

function collectClassSelectors(styles: string): string[] {
  const selectors = new Set<string>();
  for (const match of stripCssComments(styles).matchAll(/\.(-?[_a-zA-Z][_a-zA-Z0-9-]*)/g)) {
    const selector = match[1];
    if (!selector.startsWith('-')) selectors.add(selector);
  }
  return [...selectors].sort();
}

describe('renderer style pruning contract', () => {
  it('does not keep CSS for retired renderer hooks', async () => {
    const styles = await readFile(STYLES_PATH, 'utf8');
    const retiredHooks = [
      'connectionStatus',
      'maka-indeterminate-bar',
      'maka-nav-disclosure',
      'maka-nav-primary',
      'maka-nav-tree',
      'maka-session-archive-link',
      'maka-session-filter',
      'maka-session-panel-help-chip',
      'maka-session-search-clear',
      'maka-sidebar-brand',
      'maka-skill-workbench-rail',
      'maka-streaming-token-fade-in',
      'modePill',
      'providerCatalog',
      'settingsCardProviders',
      'settingsFeatureStatusHeroActions',
      'settingsHeader',
    ];

    for (const hook of retiredHooks) {
      assert.doesNotMatch(styles, new RegExp(`\\\\.${hook}\\\\b`), `${hook} is retired and must not remain in styles.css`);
    }
  });

  it('does not add unaccounted orphan class selectors to styles.css', async () => {
    const [styles, sourceFiles] = await Promise.all([
      readFile(STYLES_PATH, 'utf8'),
      Promise.all(SOURCE_ROOTS.map((root) => readSourceFiles(root))).then((groups) => groups.flat()),
    ]);
    const source = sourceFiles.join('\n');
    const orphanSelectors = collectClassSelectors(styles).filter((selector) => {
      if (DYNAMIC_STYLE_HOOKS.has(selector)) return false;
      return !source.includes(selector);
    });

    assert.deepEqual(
      orphanSelectors,
      [],
      `styles.css contains class selectors with no renderer/@maka/ui source consumer. ` +
        `Delete the style, move it next to the consuming primitive, or add a documented runtime hook allowlist entry: ${orphanSelectors.join(', ')}`,
    );
  });
});
