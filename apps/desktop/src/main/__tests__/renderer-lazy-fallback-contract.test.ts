import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';

const REPO_ROOT = resolve(import.meta.dirname, '../../../../..');
const RENDERER_ROOT = resolve(REPO_ROOT, 'apps', 'desktop', 'src', 'renderer');
const APP_SHELL_PATH = resolve(RENDERER_ROOT, 'app-shell.tsx');
const APP_SHELL_OVERLAYS_PATH = resolve(RENDERER_ROOT, 'app-shell-overlays.tsx');
const CHAT_VIEW_PATH = resolve(REPO_ROOT, 'packages', 'ui', 'src', 'chat-view.tsx');

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

  it('keeps module lazy chunks on compact non-null fallbacks', async () => {
    const chatView = await readFile(CHAT_VIEW_PATH, 'utf8');

    assert.match(chatView, /function ModulePageFallback/, 'whole-page modules must reserve a module loading shell');
    assert.match(chatView, /function ModulePanelFallback/, 'daily review content must reserve a panel loading shell');
    assert.match(chatView, /<Suspense fallback=\{<ModulePageFallback label="技能" message="正在加载技能…" \/>\}>/);
    assert.match(chatView, /<Suspense fallback=\{<ModulePageFallback label="定时任务" message="正在加载定时任务…" \/>\}>/);
    assert.match(chatView, /<Suspense fallback=\{<ModulePanelFallback message="正在加载每日回顾…" \/>\}>/);
    assert.doesNotMatch(chatView, /<Suspense fallback=\{null\}>/);
  });
});
