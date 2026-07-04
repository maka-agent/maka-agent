/**
 * Regression contract for Settings → 通用 → 默认权限模式 (chatDefaults.
 * permissionMode).
 *
 * Two bug classes this guards:
 *
 * 1. Renderer-side shadow authority. An early draft had the renderer
 *    resolve the default locally and always send an explicit
 *    `permissionMode` to sessions:create -- which made main.ts's
 *    settings-backed fallback unreachable, and silently used a stale
 *    renderer copy of the setting (seeded 'ask', updated only after the
 *    mount-time settings IPC resolved) for e.g. the first send after a
 *    cold start. The contract now is: the renderer sends permissionMode
 *    ONLY when the user explicitly picked one in the composer; otherwise
 *    it omits the field and main.ts resolves the configured default as
 *    the single authority.
 *
 * 2. Settings-store coupling. The pre-feature fallback was a synchronous
 *    `'ask'` literal that could never fail. Reading the configured
 *    default from settingsStore must not change that guarantee: a
 *    corrupted settings.json (get() rethrows anything but ENOENT) must
 *    fall back to 'ask', not reject session creation.
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { readRendererShellSources } from './renderer-shell-source-helpers.js';
import { readSettingsCombinedSource } from './settings-contract-source-helpers.js';
import { readMainProcessCombinedSource } from './main-process-contract-source-helpers.js';

describe('default permission mode contract', () => {
  it('renderer omits permissionMode unless the user explicitly picked one', async () => {
    const src = await readRendererShellSources(['app-shell-chat-actions.ts']);

    assert.match(
      src,
      /\.\.\.\(pendingNewChatPermissionMode \? \{ permissionMode: pendingNewChatPermissionMode \} : \{\}\)/,
      'send() must spread permissionMode conditionally -- omitting it lets main.ts resolve the configured default as the single authority',
    );
    assert.doesNotMatch(
      src,
      /permissionMode: pendingNewChatPermissionMode \?\?/,
      'send() must not fall back to any renderer-side default -- a renderer copy of the setting can be stale (cold-start race) and would shadow the main-process authority',
    );
  });

  it('main.ts resolves the default through a hardened helper that can never reject', async () => {
    const src = await readMainProcessCombinedSource();

    const helperMatch = src.match(
      /async function resolveDefaultPermissionMode\(\): Promise<PermissionMode> \{([\s\S]*?)\n\}/,
    );
    assert.ok(helperMatch, 'resolveDefaultPermissionMode() must exist in main.ts');
    const helperBody = helperMatch![1];
    assert.match(
      helperBody,
      /try \{[\s\S]*settingsStore\.get\(\)[\s\S]*chatDefaults\.permissionMode[\s\S]*\} catch \{[\s\S]*return 'ask';/,
      'the helper must read chatDefaults.permissionMode inside try/catch and fall back to \'ask\' -- session creation must never fail because settings.json is unreadable',
    );

    // Both sessions:create branches + quick chat must use the helper, and no
    // raw (unguarded) settings read for the permission mode may remain.
    const helperUses = src.match(/resolveDefaultPermissionMode\(\)/g) ?? [];
    assert.ok(
      helperUses.length >= 4, // definition + fake branch + ai-sdk branch + quick chat
      `all session-creation fallbacks must route through resolveDefaultPermissionMode() (found ${helperUses.length} references, expected >= 4)`,
    );
    assert.doesNotMatch(
      src,
      /\?\? \(await settingsStore\.get\(\)\)\.chatDefaults\.permissionMode/,
      'no unguarded inline settings read may remain as a permission-mode fallback',
    );
  });

  it('quick chat resolves the default in parallel with the connection check', async () => {
    const src = await readMainProcessCombinedSource();
    assert.match(
      src,
      /await Promise\.all\(\[\s*getReadyConnection\(input\.defaultConnectionSlug, input\.defaultModel\),\s*input\.mode === 'deep_research'/,
      'quick chat must not serialize the settings read behind getReadyConnection -- it sits on the first-message latency path',
    );
  });

  it('app-shell keeps a display-only mirror, loaded on mount and re-synced when Settings closes', async () => {
    const src = await readRendererShellSources(['app-shell.tsx']);

    assert.match(
      src,
      /const \[defaultPermissionMode, setDefaultPermissionMode\] = useState<PermissionMode>\('ask'\);/,
      'app-shell.tsx must track the configured default for composer-chip display',
    );
    assert.match(
      src,
      /setDefaultPermissionMode\(next\.chatDefaults\?\.permissionMode \?\? 'ask'\)/,
      'refreshShellSettings (mount-time load) must read chatDefaults.permissionMode from the settings snapshot',
    );

    // settings-surface.tsx keeps independent AppSettings state and never
    // notifies app-shell.tsx live; without a close-time re-read, a change
    // made in Settings would show a stale composer chip until app restart.
    const closeSettingsMatch = src.match(/function closeSettings\(\) \{([\s\S]*?)\n {2}\}/);
    assert.ok(closeSettingsMatch, 'closeSettings() must exist');
    assert.match(
      closeSettingsMatch![1],
      /setDefaultPermissionMode\(next\.chatDefaults\?\.permissionMode \?\? 'ask'\);/,
      'closing Settings must re-read chatDefaults.permissionMode so the composer chip reflects the change',
    );
  });
});

describe('General settings page 默认权限模式 picker', () => {
  it('describes the setting itself, not the currently-selected option', async () => {
    const src = await readSettingsCombinedSource();
    const row = src.match(/<strong>默认权限模式<\/strong>([\s\S]*?)<\/div>/)?.[1] ?? '';
    assert.ok(row, '默认权限模式 row must exist');

    // Regression guard: this line used to read the SELECTED option's own
    // hint, which just duplicated what the dropdown already shows once
    // opened. It must be a fixed description of what the setting controls.
    assert.doesNotMatch(
      row,
      /PERMISSION_MODE_META\[props\.permissionMode\]\.hint/,
      '默认权限模式 row description must not echo the selected option\'s own hint text (duplicates the dropdown)',
    );
    assert.match(
      row,
      /<small>新对话默认使用的权限模式；可在对话内随时切换，仅影响新建对话的初始值。<\/small>/,
      '默认权限模式 row must show a fixed description of the setting itself',
    );
  });

  it('renders the shared PermissionModeMenuPopup so options and hints cannot drift from the composer picker', async () => {
    const src = await readSettingsCombinedSource();
    assert.match(
      src,
      /<PermissionModeMenuPopup\s+activeMode=\{props\.permissionMode\}/,
      '默认权限模式 must render the shared popup from @maka/ui (label + hint per option, same markup as the composer picker), not a bespoke copy',
    );
  });

  it('persistPermissionMode carries the same re-entrancy guard as persistDefault', async () => {
    const src = await readSettingsCombinedSource();
    const fn = src.match(/async function persistPermissionMode\([\s\S]*?\n {2}\}/)?.[0] ?? '';
    assert.ok(fn, 'persistPermissionMode must exist');
    assert.match(
      fn,
      /if \(savingPermissionModeRef\.current\) return;/,
      'overlapping settings.update calls have no ordering guarantee -- the ref guard must reject re-entrant saves like persistDefault does',
    );
  });
});
