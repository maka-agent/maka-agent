/**
 * Source-grounded contract for PR-BOT-RESTART-RACE-0 (WAWQAQ msg
 * 23c079a9 round 6). Pins two restart-flow fixes so future edits
 * can't silently regress them.
 */

import { strict as assert } from 'node:assert';
import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';
import { resolve } from 'node:path';

const REPO_ROOT = resolve(process.cwd(), '..', '..');
const SETTINGS_MODAL = resolve(
  REPO_ROOT, 'apps', 'desktop', 'src', 'renderer', 'settings', 'SettingsModal.tsx',
);

describe('Bot restart flow contract (PR-BOT-RESTART-RACE-0)', () => {
  it('restart button stays mounted while a restart is in-flight', async () => {
    const src = await readFile(SETTINGS_MODAL, 'utf8');
    // The condition gating the restart button must include
    // `restarting` so the button doesn't unmount when the bridge's
    // running flag transiently flips false during reconcileOne.
    // Without this, `disabled={restarting}` does nothing because
    // the whole control is gone before the user sees feedback.
    assert.match(
      src,
      /support === 'runtime' && \(selectedStatus\?\.running\s*\|\|\s*restarting\)/,
      'restart button visibility must OR with `restarting` so it persists through the bridge stop→start cycle',
    );
  });

  it('restart error toast uses Settings scrubber so empty or raw messages fall back safely', async () => {
    const src = await readFile(SETTINGS_MODAL, 'utf8');
    // Some bridges throw `new Error()` with no message, and IPC
    // failures can include raw remote-method/path details. The
    // restart catch must pass through the shared Settings scrubber:
    // it classifies common failures, redacts secrets, and falls
    // back to generic copy for empty / unsafe messages.
    const restartCatch = src.match(/async function restartChannel\(\)[\s\S]*?\n  \}/);
    assert.ok(restartCatch, 'restartChannel must exist');
    assert.match(
      restartCatch[0],
      /const message = settingsActionErrorMessage\(error\);[\s\S]*toast\.error\(`\$\{BOT_LABELS\[selected\]\.label\} 启动失败`, message\)/,
      'restart catch must classify, redact, and fall back through settingsActionErrorMessage',
    );
    assert.doesNotMatch(
      restartCatch[0],
      /error instanceof Error \? error\.message : String\(error\)/,
      'restart catch must not toast raw Error.message',
    );
  });
});
