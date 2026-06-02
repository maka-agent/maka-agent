/**
 * Static-analysis contract for `ModelOAuthSection` in
 * `apps/desktop/src/renderer/settings/ProvidersPanel.tsx`
 * (PR-MODEL-OAUTH-ALL-0).
 *
 * Pins the user-visible OAuth login surface: four cards
 * (claude / codex / antigravity / cursor), each marked
 * `status: 'available'`, and each click wires through to its
 * matching `window.maka.<provider>Subscription` bridge namespace.
 *
 * This is a source-grep contract, not a DOM render — we don't
 * pull React into the desktop test runner. Stamp shapes are
 * verified by reading the panel source.
 */

import { strict as assert } from 'node:assert';
import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';
import { resolve } from 'node:path';

const REPO_ROOT = resolve(process.cwd(), '..', '..');
const PROVIDERS_PANEL_SOURCE = resolve(
  REPO_ROOT,
  'apps',
  'desktop',
  'src',
  'renderer',
  'settings',
  'ProvidersPanel.tsx',
);
const PRELOAD_SOURCE = resolve(REPO_ROOT, 'apps', 'desktop', 'src', 'preload', 'preload.ts');

describe('ModelOAuthSection card contract (PR-MODEL-OAUTH-ALL-0 + PR-CLAUDE-CARD-MOVE-0)', () => {
  it('exposes exactly three button cards: codex, antigravity, cursor', async () => {
    // PR-CLAUDE-CARD-MOVE-0 (WAWQAQ msg ddecd729): Claude is no
    // longer a button card — the full ClaudeSubscriptionCard with
    // quota meter renders inline above the 3-card grid. So the
    // grid drops to 3 entries.
    const src = await readFile(PROVIDERS_PANEL_SOURCE, 'utf8');
    const match = src.match(/MODEL_OAUTH_CARDS:\s*ReadonlyArray<ModelOAuthCard>\s*=\s*\[([\s\S]*?)\];/);
    assert.ok(match, 'MODEL_OAUTH_CARDS literal must exist');
    const body = match[1]!;
    const ids = [...body.matchAll(/id:\s*'([a-z]+)'/g)].map((m) => m[1]);
    assert.deepEqual(
      ids.sort(),
      ['antigravity', 'codex', 'cursor'],
      'grid must include exactly codex / antigravity / cursor (claude renders as the full inline card)',
    );
  });

  it('every card declares status: "available" (no more "planned" placeholders)', async () => {
    const src = await readFile(PROVIDERS_PANEL_SOURCE, 'utf8');
    const match = src.match(/MODEL_OAUTH_CARDS:\s*ReadonlyArray<ModelOAuthCard>\s*=\s*\[([\s\S]*?)\];/);
    assert.ok(match, 'MODEL_OAUTH_CARDS literal must exist');
    const body = match[1]!;
    const statuses = [...body.matchAll(/status:\s*'([a-z_]+)'/g)].map((m) => m[1]);
    assert.equal(statuses.length, 3, 'each card must declare a status');
    for (const s of statuses) {
      assert.equal(s, 'available', `card status must be 'available', got '${s}'`);
    }
    assert.doesNotMatch(body, /'planned'/, 'no card may still claim "planned" status');
  });

  it('claude renders as the full inline card above the grid, not as a cross-section jump', async () => {
    const src = await readFile(PROVIDERS_PANEL_SOURCE, 'utf8');
    // Claude is now an inline component within ModelOAuthSection,
    // not a button card that dispatches a cross-section jump.
    assert.match(
      src,
      /<ClaudeSubscriptionCard\s*\/>/,
      'ModelOAuthSection must render ClaudeSubscriptionCard inline',
    );
    assert.doesNotMatch(
      src,
      /maka:jumpToSettingsSection[\s\S]*?'account'/,
      'after the card move, ModelOAuthSection must NOT jump to the account section',
    );
    // The non-claude branches still open the modal.
    assert.match(
      src,
      /setOpenModal\(card\.id\)/,
      'codex/cursor/antigravity cards must open the SubscriptionLoginModal',
    );
  });

  it('AccountSettingsPage no longer renders ClaudeSubscriptionCard', async () => {
    // The 账户 panel used to host the card; PR-CLAUDE-CARD-MOVE-0
    // removed it. Confirm SettingsModal no longer references it.
    const SETTINGS_MODAL = resolve(
      REPO_ROOT, 'apps', 'desktop', 'src', 'renderer', 'settings', 'SettingsModal.tsx',
    );
    const src = await readFile(SETTINGS_MODAL, 'utf8');
    assert.doesNotMatch(
      src,
      /<ClaudeSubscriptionCard\s*\/>/,
      'SettingsModal must not render ClaudeSubscriptionCard — it lives in ProvidersPanel now',
    );
    assert.doesNotMatch(
      src,
      /function ClaudeSubscriptionCard\b/,
      'ClaudeSubscriptionCard definition must be in ProvidersPanel, not SettingsModal',
    );
  });

  it('SubscriptionLoginModal picks the right service bridge per id', async () => {
    const src = await readFile(PROVIDERS_PANEL_SOURCE, 'utf8');
    const fnMatch = src.match(/function pickSubscriptionBridge\(serviceId:[\s\S]*?^\}/m);
    assert.ok(fnMatch, 'pickSubscriptionBridge helper must exist');
    const body = fnMatch[0];
    assert.match(body, /case 'codex'[\s\S]*?window\.maka\.codexSubscription/);
    assert.match(body, /case 'cursor'[\s\S]*?window\.maka\.cursorSubscription/);
    assert.match(body, /case 'antigravity'[\s\S]*?window\.maka\.antigravitySubscription/);
  });

  it('modal flow calls getAuthUrl → openAuthUrl → completeAuthorization on the bridge', async () => {
    const src = await readFile(PROVIDERS_PANEL_SOURCE, 'utf8');
    const fnMatch = src.match(/async function startLogin\(\)[\s\S]*?\n  \}/);
    assert.ok(fnMatch, 'startLogin must exist on SubscriptionLoginModal');
    const body = fnMatch[0];
    assert.match(body, /bridge\.getAuthUrl\(\)/);
    assert.match(body, /bridge\.openAuthUrl\(payload\.authRequestId\)/);
    assert.match(body, /bridge\.completeAuthorization\(payload\.authRequestId\)/);
  });

  it('preload exposes the three new subscription namespaces alongside claudeSubscription', async () => {
    const src = await readFile(PRELOAD_SOURCE, 'utf8');
    assert.match(src, /codexSubscription:\s*\{/, 'preload must expose window.maka.codexSubscription');
    assert.match(src, /cursorSubscription:\s*\{/, 'preload must expose window.maka.cursorSubscription');
    assert.match(
      src,
      /antigravitySubscription:\s*\{/,
      'preload must expose window.maka.antigravitySubscription',
    );
    for (const channel of [
      'codex-subscription:get-auth-url',
      'codex-subscription:complete-authorization',
      'codex-subscription:get-account-state',
      'codex-subscription:logout',
      'cursor-subscription:get-auth-url',
      'cursor-subscription:complete-authorization',
      'cursor-subscription:get-account-state',
      'cursor-subscription:logout',
      'antigravity-subscription:get-auth-url',
      'antigravity-subscription:complete-authorization',
      'antigravity-subscription:get-account-state',
      'antigravity-subscription:logout',
    ]) {
      assert.match(
        src,
        new RegExp(channel.replace(/:/g, ':').replace(/-/g, '-')),
        `preload must invoke '${channel}' on the IPC bus`,
      );
    }
  });
});
