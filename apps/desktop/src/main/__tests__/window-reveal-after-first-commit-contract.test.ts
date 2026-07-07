/**
 * PR-SHOW-AFTER-FIRST-COMMIT contract.
 *
 * The BrowserWindow is now created `show: false` on every run so the OS never
 * flashes the index.html `.maka-preload` skeleton before React paints. The
 * renderer signals `window:notifyRendererReady` after its first React commit,
 * and a fallback timer reveals the window if that signal never arrives. Under
 * visual-smoke capture the window must stay hidden for its whole life.
 *
 * The reveal decision lives in showWindowOnceReady (window-reveal.ts) precisely
 * so it can be exercised behaviorally here — main-window.ts can't be imported
 * under plain `node --test` because it pulls in `electron`, whose API is only
 * present inside the Electron binary. The timer / IPC / creation wiring around
 * the gate is pinned with source-contract assertions below.
 */

import { strict as assert } from 'node:assert';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';
import { showWindowOnceReady, type RevealableWindow } from '../window-reveal.js';
import { readMainProcessCombinedSource } from './main-process-contract-source-helpers.js';

const REPO_ROOT = resolve(import.meta.dirname, '../../../../..');
const readRepoFile = (repoPath: string): Promise<string> =>
  readFile(resolve(REPO_ROOT, repoPath), 'utf8');

/** Fake window that flips visible on show() and records every show() call. */
function makeFakeWindow(): RevealableWindow & { showCount: number; destroy(): void } {
  let visible = false;
  let destroyed = false;
  let showCount = 0;
  return {
    isVisible: () => visible,
    isDestroyed: () => destroyed,
    show() {
      showCount += 1;
      visible = true;
    },
    destroy() {
      destroyed = true;
    },
    get showCount() {
      return showCount;
    },
  };
}

describe('window reveal gate (PR-SHOW-AFTER-FIRST-COMMIT)', () => {
  it('renderer-ready reveals the hidden window exactly once (idempotent)', () => {
    const win = makeFakeWindow();
    // First commit signal reveals the hidden window.
    showWindowOnceReady(win, false);
    assert.equal(win.showCount, 1);
    assert.equal(win.isVisible(), true);
    // HMR reload re-fires the signal, and the fallback timer may race it — the
    // isVisible() guard makes every later call a no-op so focus is never stolen.
    showWindowOnceReady(win, false);
    showWindowOnceReady(win, false);
    assert.equal(win.showCount, 1);
  });

  it('fallback timer path reveals a window that never signaled', () => {
    // The timer routes through the same gate with keepHidden=false: a wedged
    // renderer still gets a visible window.
    const win = makeFakeWindow();
    showWindowOnceReady(win, false);
    assert.equal(win.showCount, 1);
    assert.equal(win.isVisible(), true);
  });

  it('visual-smoke (keepHidden) never reveals, from either the signal or the timer', () => {
    const win = makeFakeWindow();
    // Renderer-ready path.
    showWindowOnceReady(win, true);
    // Fallback-timer path.
    showWindowOnceReady(win, true);
    assert.equal(win.showCount, 0);
    assert.equal(win.isVisible(), false);
  });

  it('never reveals a null or destroyed window (teardown raced the timer/IPC)', () => {
    assert.doesNotThrow(() => showWindowOnceReady(null, false));
    const win = makeFakeWindow();
    win.destroy();
    showWindowOnceReady(win, false);
    assert.equal(win.showCount, 0);
  });
});

describe('window reveal wiring (PR-SHOW-AFTER-FIRST-COMMIT)', () => {
  it('main-window creates the window hidden and wires the reveal fallback timer', async () => {
    const src = await readRepoFile('apps/desktop/src/main/main-window.ts');
    // Every run now creates hidden — no `!app.isPackaged && startHidden` gate.
    assert.match(
      src,
      /new BrowserWindow\(\{[\s\S]*?\n\s*show: false,/,
      'BrowserWindow must be created with show: false unconditionally',
    );
    assert.doesNotMatch(
      src,
      /\?\?\?|!app\.isPackaged && startHidden \? \{ show: false \} : \{\}/,
      'the old conditional show: false creation gate must be gone',
    );
    // Fallback timer with the documented 4s budget, routed through the gate.
    assert.match(src, /SHOW_FALLBACK_TIMEOUT_MS\s*=\s*4000/);
    assert.match(
      src,
      /setTimeout\([\s\S]*?showWindowOnceReady\(mainWindow, keepHiddenForVisualSmoke\)[\s\S]*?SHOW_FALLBACK_TIMEOUT_MS\)/,
      'the fallback timer must reveal through showWindowOnceReady',
    );
    // Timer must not run for visual-smoke windows, and must clear on close.
    assert.match(src, /if \(!keepHiddenForVisualSmoke\) \{\s*showFallbackTimer = setTimeout/);
    assert.match(
      src,
      /mainWindow\.on\('close', \(\) => \{\s*clearShowFallbackTimer\(\);/,
      'the fallback timer must be cleared when the window closes',
    );
    // Renderer-ready controller method cancels the timer then reveals.
    assert.match(
      src,
      /notifyRendererReady\(\) \{[\s\S]*?clearShowFallbackTimer\(\);[\s\S]*?showWindowOnceReady\(mainWindow, keepHiddenForVisualSmoke\);/,
      'notifyRendererReady must clear the timer and reveal through the gate',
    );
  });

  it('main registers the window:notifyRendererReady IPC handler', async () => {
    const src = await readMainProcessCombinedSource();
    assert.match(
      src,
      /ipcMain\.handle\('window:notifyRendererReady',[\s\S]*?mainWindowController\.notifyRendererReady\(\)/,
      'main must forward window:notifyRendererReady to the controller',
    );
  });

  it('preload exposes appWindow.notifyRendererReady over the same channel', async () => {
    const src = await readRepoFile('apps/desktop/src/preload/preload.ts');
    assert.match(
      src,
      /notifyRendererReady\(\): Promise<void> \{\s*return ipcRenderer\.invoke\('window:notifyRendererReady'\);/,
    );
  });

  it('the renderer signals ready after the first commit, unconditionally', async () => {
    const src = await readRepoFile('apps/desktop/src/renderer/app.tsx');
    // useLayoutEffect fires post-commit; the empty dep array makes it fire once.
    // The guarded chain must not depend on the onboarding snapshot value.
    assert.match(
      src,
      /useLayoutEffect\(\(\) => \{\s*void window\.maka\?\.appWindow\?\.notifyRendererReady\?\.\(\);\s*\}, \[\]\)/,
    );
  });
});
