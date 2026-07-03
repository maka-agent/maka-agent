import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';

const REPO_ROOT = resolve(import.meta.dirname, '../../../../..');
const RENDERER_ROOT = resolve(REPO_ROOT, 'apps', 'desktop', 'src', 'renderer');
const APP_SHELL_PATH = resolve(RENDERER_ROOT, 'app-shell.tsx');
const APP_SHELL_OVERLAYS_PATH = resolve(RENDERER_ROOT, 'app-shell-overlays.tsx');

describe('renderer lazy fallback contract', () => {
  it('keeps shell lazy chunks on compact non-null fallbacks', async () => {
    const appShell = await readFile(APP_SHELL_PATH, 'utf8');
    const overlays = await readFile(APP_SHELL_OVERLAYS_PATH, 'utf8');

    assert.match(overlays, /function SettingsModalFallback/, 'Settings modal must reserve a loading shell');
    assert.match(overlays, /<Suspense fallback=\{<SettingsModalFallback \/>\}>/);
    assert.doesNotMatch(overlays, /settingsOpen[\s\S]{0,120}<Suspense fallback=\{null\}>/);

    assert.match(appShell, /function BrowserPanelFallback/, 'Browser panel must reserve a loading shell');
    assert.match(appShell, /function ArtifactPaneFallback/, 'Artifact pane must reserve a loading shell');
    assert.match(appShell, /<Suspense fallback=\{<BrowserPanelFallback \/>\}>/);
    assert.match(appShell, /<Suspense fallback=\{<ArtifactPaneFallback \/>\}>/);
    assert.doesNotMatch(appShell, /BrowserPanel[\s\S]{0,160}<Suspense fallback=\{null\}>/);
    assert.doesNotMatch(appShell, /ArtifactPane[\s\S]{0,160}<Suspense fallback=\{null\}>/);
  });
});
