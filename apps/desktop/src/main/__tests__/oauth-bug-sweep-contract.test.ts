/**
 * Source-grounded contract tests for PR-BUG-SWEEP-2026-06-02
 * (WAWQAQ msg 605130be). Each test pins one of the bug fixes so a
 * future refactor can't silently regress the patched behavior.
 */

import { strict as assert } from 'node:assert';
import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';
import { resolve } from 'node:path';

const REPO_ROOT = resolve(process.cwd(), '..', '..');
const OAUTH_DIR = resolve(REPO_ROOT, 'apps', 'desktop', 'src', 'main', 'oauth');
const RUNTIME_BOTS_DIR = resolve(REPO_ROOT, 'packages', 'runtime', 'src', 'bots');

const SERVICES_WITH_LOOPBACK_SERVER = [
  'openai-codex-service.ts',
  'antigravity-subscription-service.ts',
];

describe('OAuth callback server: drains sockets + timeout (B-SWEEP-1, B-SWEEP-2)', () => {
  for (const file of SERVICES_WITH_LOOPBACK_SERVER) {
    it(`${file} drops in-flight sockets before close()`, async () => {
      const source = await readFile(resolve(OAUTH_DIR, file), 'utf8');
      // `closeAllConnections` must precede `close()` so a stuck
      // browser tab can't pin the loopback port until OS socket
      // timeout. Optional-chained to stay compatible with older
      // Node runtimes.
      assert.match(source, /closeAllConnections\?\.\(\)/);
      // The order matters — closeAllConnections must come BEFORE
      // the close() call in the same dispose block.
      const closeAllIdx = source.indexOf('closeAllConnections?.()');
      const closeIdx = source.indexOf('pending.server.close()');
      assert.ok(closeAllIdx > 0 && closeIdx > closeAllIdx,
        `closeAllConnections must precede close() in ${file}`);
    });

    it(`${file} sets a request-timeout on the callback server`, async () => {
      const source = await readFile(resolve(OAUTH_DIR, file), 'utf8');
      // Prevents a slow / hung browser tab from binding the port
      // forever. We don't pin the exact ms; just that a timeout is
      // installed with a destroy-on-timeout handler.
      assert.match(source, /server\.setTimeout\(\s*\d+/);
      assert.match(source, /socket\.destroy\(\)/);
    });
  }
});

// B-SWEEP-3 (unlink corrupt token files) is retired: every service
// now persists through the shared CredentialStore (#1125), whose
// reads preserve corrupt entries for recovery — covered by
// shared-oauth-token-persistence.test.ts.

describe('WeChat bridge: streaming loops must not become unhandled rejections (B-SWEEP-4)', () => {
  it('streamIlinkMessages and streamLiveMessages have .catch() on the fire-and-forget', async () => {
    const source = await readFile(resolve(RUNTIME_BOTS_DIR, 'wechat-bridge.ts'), 'utf8');
    // Both `void this.streamIlinkMessages('')` and
    // `void this.streamLiveMessages(...)` must be followed by
    // `.catch(fail)` (or any `.catch(...)`) so a synchronous
    // throw during loop setup degrades the bridge instead of
    // crashing the main process.
    assert.match(source, /void this\.streamIlinkMessages\(''\)\.catch\(/);
    // streamLiveMessages takes `Math.floor(Date.now() / 1000)` — nested
    // parens defeat `[^)]+`. Match anything up to the terminal `.catch(`
    // on the same logical statement.
    assert.match(source, /void this\.streamLiveMessages\(.+\)\.catch\(/);
  });
});

describe('Bot registry: clears listeners before swapping a bridge (B-SWEEP-5)', () => {
  it('reconcileOne calls removeAllListeners on the old bridge', async () => {
    const source = await readFile(resolve(RUNTIME_BOTS_DIR, 'bot-registry.ts'), 'utf8');
    // After the old bridge `stop()`s, lingering Discord-gateway /
    // WeChat-poll tasks can still emit 'message' or 'statusChange'
    // events. removeAllListeners on both events prevents the
    // registry from dispatching ghost events through a stale
    // bridge instance.
    assert.match(source, /removeAllListeners\(['"]message['"]\)/);
    assert.match(source, /removeAllListeners\(['"]statusChange['"]\)/);
    // The listener removal must happen AFTER existing.stop() so
    // we still observe normal stop emissions, but BEFORE the new
    // bridge instance is wired up.
    const stopIdx = source.indexOf('await existing.stop()');
    const removeIdx = source.indexOf("removeAllListeners('message')");
    const wireIdx = source.indexOf('this.wire(bridge)');
    assert.ok(stopIdx > 0 && removeIdx > stopIdx,
      'removeAllListeners must come after existing.stop()');
    assert.ok(removeIdx < wireIdx,
      'removeAllListeners must come before the new bridge is wired');
  });
});
