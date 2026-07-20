import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { readMainProcessCombinedSource } from './main-process-contract-source-helpers.js';

const MAIN_TS = resolve(import.meta.dirname, '../../../../../apps/desktop/src/main/main.ts');

describe('single-instance lock contract', () => {
  it('requests the lock before any workspace/store setup, and exits the losing process immediately', async () => {
    const src = await readFile(MAIN_TS, 'utf8');

    const lockIndex = src.indexOf('app.requestSingleInstanceLock()');
    assert.notEqual(lockIndex, -1, 'requestSingleInstanceLock() call must exist');

    const workspaceRootIndex = src.indexOf('const workspaceRoot =');
    assert.notEqual(workspaceRootIndex, -1, 'workspaceRoot declaration must exist');
    assert.ok(
      lockIndex < workspaceRootIndex,
      'requestSingleInstanceLock() must run before workspaceRoot/store setup, so a losing second process never touches shared state',
    );

    // Astro-Han review (#494): app.exit(0) for the losing instance -- an
    // immediate exit, not app.quit() + process.exit(0) (which routes through
    // the normal event-based quit sequence before force-exiting).
    assert.match(
      src,
      /if \(!app\.requestSingleInstanceLock\(\)\) \{\s*app\.exit\(0\);\s*\}/,
      'the losing instance must call app.exit(0) immediately',
    );
  });

  it('second-instance shares behavior with activate: focus an existing window, or create one if none exists', async () => {
    // R6: the second-instance / activate registrations moved to
    // app-lifecycle.ts (focusOrCreateMainWindow itself stays in main.ts), so
    // read the combined main-process source to follow both across the split.
    const src = await readMainProcessCombinedSource();

    // Regression guard for Astro-Han review (#494) P1: a second launch
    // attempt after all windows were closed (app still alive, e.g. macOS
    // dock) must not be a silent no-op. `focus()` alone is a no-op with no
    // window -- the handler must fall back to createWindow().
    const helperMatch = src.match(
      /function focusOrCreateMainWindow\(\): void \{([\s\S]*?)\n\}/,
    );
    assert.ok(helperMatch, 'a focusOrCreateMainWindow (or equivalently named) helper must exist');
    const helperBody = helperMatch![1];
    assert.match(helperBody, /hasOpenWindows\(\)/, 'helper must branch on whether a window currently exists');
    assert.match(helperBody, /mainWindowController\.focus\(\)/, 'helper must focus the existing window when one exists');
    assert.match(helperBody, /mainWindowController\.createWindow\(\)/, 'helper must create a window when none exists');

    assert.match(
      src,
      /app\.on\('second-instance', focusOrCreateMainWindow\)/,
      'second-instance must be wired to the shared focus-or-create helper, not a bare focus() call',
    );
    assert.match(
      src,
      /app\.on\('activate', focusOrCreateMainWindow\)/,
      'activate should share the exact same behavior as second-instance',
    );
  });

  it('counts only the real main window, not cursor overlays, when deciding whether to focus', async () => {
    const mainWindow = await readFile(
      resolve(import.meta.dirname, '../../../../../apps/desktop/src/main/main-window.ts'),
      'utf8',
    );
    const hasOpenWindows = mainWindow.match(/hasOpenWindows\(\) \{([\s\S]*?)\n    \}/)?.[1] ?? '';
    assert.match(hasOpenWindows, /mainWindow !== null && !mainWindow\.isDestroyed\(\)/);
    assert.doesNotMatch(hasOpenWindows, /BrowserWindow\.getAllWindows/);
  });
});
