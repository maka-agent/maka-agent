import { strict as assert } from 'node:assert';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';
import { readRendererContractCss } from './contract-css-helpers.js';
import { REPO_ROOT } from './css-test-helpers.js';

describe('BrowserPanel workbar layout contract', () => {
  it('only exposes native browser bounds while its active tab is visible', async () => {
    const source = await readFile(resolve(REPO_ROOT, 'apps/desktop/src/renderer/browser-panel.tsx'), 'utf8');
    const workbar = await readFile(resolve(REPO_ROOT, 'apps/desktop/src/renderer/session-workbar.tsx'), 'utf8');

    assert.match(source, /const showView = !hidden && state\.hasPage/);
    assert.match(source, /setViewport\(\{ sessionId, rect: null \}\)/);
    assert.match(workbar, /hidden=\{props\.hidden \|\| props\.activeTab !== 'browser'\}/);
  });

  it('gives the active browser tab a non-zero bounded bottom-workspace height', async () => {
    const css = await readRendererContractCss();

    assert.match(css, /@media\s*\(max-width:\s*990px\)[\s\S]*?\.maka-session-workbar\s*\{[\s\S]*?min-height:\s*min\(220px,\s*42dvh\)[\s\S]*?max-height:\s*min\(42dvh,\s*360px\)/);
    assert.match(css, /\.maka-session-workbar \.maka-browser-panel[\s\S]*?height:\s*100%[\s\S]*?min-height:\s*0/);
  });
});
