/**
 * Source-grounded contract for PR-BOT-RESTART-RACE-0 (WAWQAQ msg
 * 23c079a9 round 6). Pins two restart-flow fixes so future edits
 * can't silently regress them.
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { readSettingsCombinedSource } from './settings-contract-source-helpers.js';


describe('Bot restart flow contract (PR-BOT-RESTART-RACE-0)', () => {
  it('restart button stays mounted while a restart is in-flight', async () => {
    const src = await readSettingsCombinedSource();
    // The condition gating the restart button must include
    // `restarting` so the button doesn't unmount when the bridge's
    // running flag transiently flips false during reconcileOne.
    // Without this, `disabled={restarting}` does nothing because
    // the whole control is gone before the user sees feedback.
    assert.match(
      src,
      /support === 'runtime' && \(status\?\.running\s*\|\|\s*props\.restarting\)/,
      'restart button visibility must OR with `restarting` so it persists through the bridge stop→start cycle',
    );
  });

  it('restart error toast uses Settings scrubber so empty or raw messages fall back safely', async () => {
    const src = await readSettingsCombinedSource();
    // Some bridges throw `new Error()` with no message, and IPC
    // failures can include raw remote-method/path details. The
    // restart catch must pass through the shared Settings scrubber:
    // it classifies common failures, redacts secrets, and falls
    // back to generic copy for empty / unsafe messages.
    const restartCatch = src.match(/async function restartBotProvider\(provider: BotProvider\)[\s\S]*?\n  \}/);
    assert.ok(restartCatch, 'restartBotProvider must exist');
    assert.match(
      restartCatch[0],
      /const message = settingsActionErrorMessage\(error\);[\s\S]*toast\.error\(`\$\{BOT_LABELS\[provider\]\.label\} 启动失败`, message\)/,
      'restart catch must classify, redact, and fall back through settingsActionErrorMessage',
    );
    assert.doesNotMatch(
      restartCatch[0],
      /error instanceof Error \? error\.message : String\(error\)/,
      'restart catch must not toast raw Error.message',
    );
  });
});
