/**
 * Regression contract for Settings → 通用 → 默认权限模式 (chatDefaults.
 * permissionMode).
 *
 * Bug this guards against: the setting persisted correctly (verified via
 * IPC round-trip elsewhere), but the actual "send first message in a new
 * chat" path in app-shell-chat-actions.ts hardcoded `permissionMode:
 * pendingNewChatPermissionMode ?? 'ask'` -- so a configured default other
 * than 询问权限 was silently ignored by the one code path real users
 * actually go through. `window.maka.sessions.create({ backend: 'fake' })`
 * called directly (bypassing the renderer) picked up the setting fine,
 * which is exactly why this slipped through manual/CDP testing the first
 * time -- the regression only shows up in the renderer's own call site.
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { readRendererShellSources } from './renderer-shell-source-helpers.js';
import { readSettingsCombinedSource } from './settings-contract-source-helpers.js';

describe('default permission mode contract', () => {
  it('new-chat send() falls back to the configured default, not a hardcoded "ask"', async () => {
    const src = await readRendererShellSources(['app-shell-chat-actions.ts']);

    assert.doesNotMatch(
      src,
      /permissionMode: pendingNewChatPermissionMode \?\? 'ask'/,
      'the new-chat session:create call must not hardcode \'ask\' -- it must fall back to the injected defaultPermissionMode',
    );
    assert.match(
      src,
      /permissionMode: pendingNewChatPermissionMode \?\? defaultPermissionMode,/,
      'the new-chat session:create call must fall back to defaultPermissionMode when the composer picker was never touched',
    );
    assert.match(
      src,
      /defaultPermissionMode: PermissionMode;/,
      'createAppShellChatActions must accept defaultPermissionMode as an explicit dependency',
    );
  });

  it('app-shell.tsx loads chatDefaults.permissionMode into state and threads it into chat actions', async () => {
    const src = await readRendererShellSources(['app-shell.tsx']);

    assert.match(
      src,
      /const \[defaultPermissionMode, setDefaultPermissionMode\] = useState<PermissionMode>\('ask'\);/,
      'app-shell.tsx must track the configured default in its own state',
    );
    assert.match(
      src,
      /setDefaultPermissionMode\(next\.chatDefaults\?\.permissionMode \?\? 'ask'\)/,
      'refreshShellSettings (mount-time load) must read chatDefaults.permissionMode from the settings snapshot',
    );

    // Regression guard for the second half of the bug: settings-surface.tsx
    // (Settings modal) keeps its own independent AppSettings state and
    // never notifies app-shell.tsx directly. Without a re-read on close,
    // a change made in Settings would only take effect after a full app
    // restart. New-chat creation cannot happen while Settings is open, so
    // a close-time refresh (unlike theme, which needs to be instant) is
    // timely enough.
    const closeSettingsMatch = src.match(/function closeSettings\(\) \{([\s\S]*?)\n {2}\}/);
    assert.ok(closeSettingsMatch, 'closeSettings() must exist');
    assert.match(
      closeSettingsMatch![1],
      /window\.maka\.settings\.get\(\)\.then\(\(next\) => \{\s*setDefaultPermissionMode\(next\.chatDefaults\?\.permissionMode \?\? 'ask'\);/,
      'closing Settings must re-read chatDefaults.permissionMode so a change takes effect for the next new chat',
    );

    assert.match(
      src,
      /defaultPermissionMode,\s*validPendingNewChatModel,/,
      'app-shell.tsx must pass defaultPermissionMode into createAppShellChatActions',
    );
  });
});

describe('General settings page 默认权限模式 picker', () => {
  it('describes the setting itself, not the currently-selected option', async () => {
    const src = await readSettingsCombinedSource();
    const row = src.match(/<strong>默认权限模式<\/strong>([\s\S]*?)<\/div>\s*\{\/\* PR-DEFAULT-PERMISSION-MODE-1/)?.[1] ?? '';
    assert.ok(row, '默认权限模式 row must exist');

    // Regression guard: this line used to read
    // `PERMISSION_MODE_META[props.permissionMode].hint` -- the currently
    // selected option's own explanation, which just duplicated what the
    // dropdown already shows once opened for that option. It must instead
    // be a fixed description of what the *setting* controls, matching the
    // static-copy role the 默认模型 row's <small> already plays above it.
    assert.doesNotMatch(
      row,
      /PERMISSION_MODE_META\[props\.permissionMode\]\.hint/,
      '默认权限模式 row description must not read the selected option\'s own hint text (duplicates the dropdown)',
    );
    assert.match(
      row,
      /<small>新对话默认使用的权限模式；可在对话内随时切换，仅影响新建对话的初始值。<\/small>/,
      '默认权限模式 row must show a fixed description of the setting itself',
    );
  });

  it('shows every option\'s label AND hint in the dropdown, not just the selected one', async () => {
    const src = await readSettingsCombinedSource();

    // Regression guard: a plain <SettingsSelect> only rendered each
    // option's bare label in the popup list -- you had to already select
    // an option before its meaning (the hint text) showed up anywhere
    // (only the then-selected option's hint rendered, in the row's own
    // description line). Replaced with the same rich `Menu` popup pattern
    // the composer's own permission-mode picker uses, so every option's
    // label + hint are visible before picking.
    assert.match(
      src,
      /<MenuPopup className="maka-composer-mode-menu" align="end">[\s\S]*?CHAT_DEFAULT_PERMISSION_MODES\.map/,
      '默认权限模式 must render a rich Menu popup (shared with the composer\'s picker styling), not a bare <SettingsSelect> popup',
    );
    assert.match(
      src,
      /<span className="maka-composer-mode-menu-label">\{meta\.label\}<\/span>\s*<span className="maka-composer-mode-menu-hint">\{meta\.hint\}<\/span>/,
      'every popup item must render both its label and its hint',
    );
  });
});
