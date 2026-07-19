/**
 * Astro-Han review (#493) P2: a small regression test for the
 * ThemePreference -> nativeTheme.themeSource bridge. The main-process side
 * (setThemeSource IPC handler, createWindow startup sync) is Electron-coupled
 * and covered by the main-window-safe-send-contract-style source checks;
 * this test covers the pure mapping/validation logic directly.
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { isThemePreference, toNativeThemeSource } from '../theme-source.js';
import { readMainProcessCombinedSource } from './main-process-contract-source-helpers.js';

// Anchored at the repo root, not relative to this test file's own location --
// `npm test` runs the compiled dist/main/__tests__/*.test.js, so a plain
// relative path would resolve into dist/ (no .ts sources there) instead of
// the real src/ file. Same approach as main-process-contract-source-helpers.ts.
const REPO_ROOT = resolve(import.meta.dirname, '../../../../..');
const MAIN_TS = resolve(REPO_ROOT, 'apps/desktop/src/main/main.ts');
const MAIN_WINDOW_TS = resolve(REPO_ROOT, 'apps/desktop/src/main/main-window.ts');
const RENDERER_THEME_TS = resolve(REPO_ROOT, 'apps/desktop/src/renderer/theme.ts');

describe('theme-source', () => {
  describe('toNativeThemeSource', () => {
    it('maps auto to system', () => {
      assert.equal(toNativeThemeSource('auto'), 'system');
    });

    it('passes light and dark through unchanged', () => {
      assert.equal(toNativeThemeSource('light'), 'light');
      assert.equal(toNativeThemeSource('dark'), 'dark');
    });
  });

  describe('isThemePreference', () => {
    it('accepts the three valid preferences', () => {
      assert.equal(isThemePreference('auto'), true);
      assert.equal(isThemePreference('light'), true);
      assert.equal(isThemePreference('dark'), true);
    });

    it('rejects the already-mapped nativeTheme.themeSource value ("system")', () => {
      // Regression guard: the IPC contract now carries the app's own
      // ThemePreference, not the Electron-native themeSource. A caller
      // that still sends the old pre-mapped 'system' value must be
      // rejected, not silently accepted as if it were a no-op 'auto'.
      assert.equal(isThemePreference('system'), false);
    });

    it('rejects garbage / wrong-type values', () => {
      assert.equal(isThemePreference('evil-unknown'), false);
      assert.equal(isThemePreference(undefined), false);
      assert.equal(isThemePreference(null), false);
      assert.equal(isThemePreference(42), false);
      assert.equal(isThemePreference({}), false);
    });
  });

  describe('main-window.ts wiring', () => {
    it('setThemeSource validates the sender is the main window and rejects invalid preferences', async () => {
      const src = await readFile(MAIN_WINDOW_TS, 'utf8');
      const methodMatch = src.match(/setThemeSource\(sender, themePref\) \{([\s\S]*?)\n {4}\},/);
      assert.ok(methodMatch, 'setThemeSource method must exist on the controller');
      const body = methodMatch![1];
      assert.match(body, /target !== mainWindow/, 'must reject senders that are not the tracked main window');
      assert.match(body, /isThemePreference\(themePref\)/, 'must reject values that are not a valid ThemePreference');
      assert.match(body, /nativeTheme\.themeSource = toNativeThemeSource\(themePref\)/, 'must assign via the shared mapping helper');
    });

    it('createWindow syncs nativeTheme.themeSource before creating the BrowserWindow, not only via the later IPC call', async () => {
      const src = await readFile(MAIN_WINDOW_TS, 'utf8');
      // Astro-Han review (#493) P2: on a cold start where the OS appearance
      // disagrees with the persisted preference, the vibrancy material must
      // already be on the right theme before the window is even created --
      // syncing it only after the renderer's later setThemeSource() IPC call
      // would let the first frame or two flash the *system* theme's tint.
      const syncIndex = src.indexOf('nativeTheme.themeSource = toNativeThemeSource(themePref)');
      const newWindowIndex = src.indexOf('new BrowserWindow({');
      assert.notEqual(syncIndex, -1, 'createWindow must sync nativeTheme.themeSource from the resolved themePref');
      assert.notEqual(newWindowIndex, -1, 'new BrowserWindow(...) call must exist');
      assert.ok(syncIndex < newWindowIndex, 'the nativeTheme sync must happen before the BrowserWindow is constructed');
    });

    it('keeps Windows titleBarOverlay height stable at window creation and runtime theme sync', async () => {
      const src = await readFile(MAIN_WINDOW_TS, 'utf8');

      assert.match(
        src,
        /const titleBarOverlayOptions = \([\s\S]*?isDark: boolean,[\s\S]*?color = isDark \? '#1c1d21' : '#ffffff',[\s\S]*?\): \{ color: string; symbolColor: string; height: number \} => \(\{[\s\S]*height: TITLEBAR_OVERLAY_HEIGHT,[\s\S]*\}\);/,
        'one helper should include color, symbolColor, and height',
      );
      assert.match(
        src,
        /titleBarOverlay:\s*titleBarOverlayOptions\(isDark\)/,
        'window creation should use the shared titleBarOverlay options helper',
      );

      const methodMatch = src.match(/setTitleBarOverlayTheme\(sender, theme\) \{([\s\S]*?)\n {4}\},/);
      assert.ok(methodMatch, 'setTitleBarOverlayTheme method must exist on the controller');
      const body = methodMatch![1];
      assert.match(body, /target !== mainWindow/, 'must reject senders that are not the tracked main window');
      assert.match(body, /isTitleBarOverlayTheme\(theme\)/, 'must validate the renderer-provided theme payload');
      assert.match(
        body,
        /mainWindow\.setTitleBarOverlay\(titleBarOverlayOptions\(theme\.isDark, theme\.backgroundColor\)\)/,
        'runtime theme sync should preserve the height and use the renderer surface color',
      );
    });

    it('samples the resolved renderer background again after light/dark and palette changes', async () => {
      const src = await readFile(RENDERER_THEME_TS, 'utf8');
      assert.match(
        src,
        /getComputedStyle\(root\)\.getPropertyValue\('--background'\)/,
        'the native controls should use the actual rendered content-surface color',
      );
      assert.match(
        src,
        /function setDarkClass[\s\S]*?syncTitleBarOverlay\(root\);/,
        'light/dark changes should update the native controls',
      );
      assert.match(
        src,
        /function applyThemePalette[\s\S]*?syncTitleBarOverlay\(root\);/,
        'palette changes should update the native controls',
      );
    });

    it('window:setTitleBarOverlayTheme forwards the sender to the guarded main-window controller', async () => {
      const src = await readMainProcessCombinedSource();
      assert.match(
        src,
        /ipcMain\.handle\('window:setTitleBarOverlayTheme', \(event, theme: unknown\): void => \{\s*mainWindowController\.setTitleBarOverlayTheme\(event\.sender, theme\);\s*\}\);/,
        'the IPC handler should let main-window.ts validate both sender and payload',
      );
    });
  });
});
