import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';

const REPO_ROOT = resolve(process.cwd(), '..', '..');
const STYLES_PATH = resolve(REPO_ROOT, 'apps', 'desktop', 'src', 'renderer', 'styles.css');

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
      'providerCatalog',
      'settingsCardProviders',
      'settingsFeatureStatusHeroActions',
      'settingsHeader',
    ];

    for (const hook of retiredHooks) {
      assert.doesNotMatch(styles, new RegExp(`\\\\.${hook}\\\\b`), `${hook} is retired and must not remain in styles.css`);
    }
  });
});
