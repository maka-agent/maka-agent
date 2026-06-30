import { strict as assert } from 'node:assert';
import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';
import { join, resolve } from 'node:path';

const REPO_ROOT = resolve(process.cwd(), '..', '..');
const SETTINGS_MODAL = join(REPO_ROOT, 'apps', 'desktop', 'src', 'renderer', 'settings', 'SettingsModal.tsx');
const MAIN_SOURCE = join(REPO_ROOT, 'apps', 'desktop', 'src', 'main', 'main.ts');
const PRELOAD_SOURCE = join(REPO_ROOT, 'apps', 'desktop', 'src', 'preload', 'preload.ts');
const GLOBAL_DTS = join(REPO_ROOT, 'apps', 'desktop', 'src', 'global.d.ts');

/**
 * PR-GENERAL-DEFAULTS-CONFIGURABLE-0 (WAWQAQ msg `d3ea9a33` 2026-06-26).
 *
 * The General page used to ship three read-only `<SettingRow>` lines —
 * "启动" / "新对话模式" / "默认模型" — that read like settings but had
 * no configurable backing. The fix dropped the two without persisted
 * storage and replaced the third with a real `<SettingsSelect>` wired
 * to `connections.setDefault`. This contract pins both halves so the
 * regression can't drift back in.
 */
describe('General settings configurable contract', () => {
  it('does not ship the three retired read-only SettingRow lines on General', async () => {
    const src = await readFile(SETTINGS_MODAL, 'utf8');
    // Each retired line was: `<SettingRow title="启动" detail="…" value="已启用" />`
    // etc. Test the trio of (title, hardcoded value) pairs.
    assert.doesNotMatch(
      src,
      /<SettingRow\s+title="启动"[\s\S]*?value="已启用"/,
      'General page must not re-introduce the read-only 启动 row — make it real (with a backing AppSettings field + IPC) or leave it out.',
    );
    assert.doesNotMatch(
      src,
      /<SettingRow\s+title="新对话模式"[\s\S]*?value="询问权限"/,
      'General page must not re-introduce the read-only 新对话模式 row — permission mode is per-session in the composer.',
    );
    // The 默认模型 row was: `<SettingRow ... value={props.defaultSlug ?? '未设置'} />`.
    // Block the SettingRow shape specifically; the new real control is a
    // `<SettingsSelect>` inside `<GeneralDefaultsCard>`.
    assert.doesNotMatch(
      src,
      /<SettingRow\s+title="默认模型"[\s\S]*?value=\{props\.defaultSlug/,
      'General page 默认模型 row must use the real <SettingsSelect> inside <GeneralDefaultsCard>, not a read-only <SettingRow>.',
    );
  });

  it('renders a real <GeneralDefaultsCard> that persists the default model via model-level IPC', async () => {
    const src = await readFile(SETTINGS_MODAL, 'utf8');
    // The card must be defined and used.
    assert.match(
      src,
      /function GeneralDefaultsCard\(props: \{[\s\S]*connections:\s*readonly LlmConnection\[\];/,
      '<GeneralDefaultsCard> must accept a readonly LlmConnection[] so the General page can render every enabled connection',
    );
    assert.match(
      src,
      /<GeneralDefaultsCard\s+connections=\{props\.connections\}\s+defaultSlug=\{props\.defaultSlug\}\s+onRefresh=\{props\.onRefreshConnections\}/,
      '<GeneralDefaultsCard> must be mounted by the General-page render branch with connections / defaultSlug / onRefresh wired through',
    );
    // The actual select + persistence must use the shared SettingsSelect
    // and the model-level default IPC. The old connection-only selector used
    // `connection.name`, which can embed OAuth account email; default-model
    // choices are now grouped from safe model catalog choices.
    assert.match(
      src,
      /<SettingsSelect[\s\S]*ariaLabel="默认模型"[\s\S]*optionGroups=\{optionGroups\}[\s\S]*onChange=/,
      'GeneralDefaultsCard must use the shared <SettingsSelect> primitive (not a custom dropdown) so the popup layering, keyboard nav, and chrome match the rest of Settings',
    );
    assert.match(
      src,
      /buildCatalogChatModelChoices\(props\.connections\)[\s\S]*modelMenuGroups\(modelChoices\)[\s\S]*modelChoiceValue\(choice\.connectionSlug, choice\.model\)/,
      'GeneralDefaultsCard must flatten safe model catalog choices into grouped connection/model options',
    );
    assert.doesNotMatch(
      src,
      /opts\.push\(\[connection\.slug, connection\.name\]\)/,
      'GeneralDefaultsCard must not use connection.name as option copy because OAuth connection names can carry account emails',
    );
    assert.match(
      src,
      /window\.maka\.connections\.setDefaultModel\(/,
      'GeneralDefaultsCard must persist the selected connection+model pair through a model-level default IPC',
    );
  });

  it('guards GeneralDefaultsCard with the same mounted-ref + savingRef ownership pattern used elsewhere in SettingsModal', async () => {
    const src = await readFile(SETTINGS_MODAL, 'utf8');
    // Capture the function's body up to the next top-level `function`
    // declaration so per-card guards are checked inside the component.
    const cardBlock =
      src.match(/function GeneralDefaultsCard\(props:[\s\S]*?\n(?=function\s)/)?.[0] ?? '';
    assert.ok(cardBlock.length > 0, 'GeneralDefaultsCard source must be discoverable');
    assert.match(
      cardBlock,
      /const mountedRef = useRef\(true\);/,
      'GeneralDefaultsCard must track page-mounted ownership so a slow IPC write does not call setSaving(false) after Settings closes',
    );
    assert.match(
      cardBlock,
      /const savingRef = useRef\(false\);/,
      'GeneralDefaultsCard must use a synchronous savingRef so rapid duplicate selects do not race a previous in-flight save',
    );
    assert.match(
      cardBlock,
      /if \(savingRef\.current\) return;[\s\S]*savingRef\.current = true;[\s\S]*setSaving\(true\);[\s\S]*await window\.maka\.connections\.setDefaultModel/,
      'GeneralDefaultsCard must take the synchronous savingRef lock before awaiting the IPC; React state alone is not enough to block double-clicks',
    );
    assert.match(
      cardBlock,
      /catch \(error\)[\s\S]*if \(mountedRef\.current\) \{[\s\S]*toast\.error\('保存默认模型失败'/,
      'GeneralDefaultsCard failures must surface a localized toast and only while still mounted — silent unhandled rejection regressed the page before',
    );
  });

  it('exposes a default-model IPC that validates the model against chat-selectable catalog entries', async () => {
    const main = await readFile(MAIN_SOURCE, 'utf8');
    const preload = await readFile(PRELOAD_SOURCE, 'utf8');
    const globalDts = await readFile(GLOBAL_DTS, 'utf8');

    assert.match(preload, /setDefaultModel\(input: \{ slug: string; model: string \} \| null\): Promise<void> \{[\s\S]*ipcRenderer\.invoke\('connections:setDefaultModel', input\)/);
    assert.match(globalDts, /setDefaultModel\(input: \{ slug: string; model: string \} \| null\): Promise<void>;/);
    assert.match(
      main,
      /ipcMain\.handle\('connections:setDefaultModel'[\s\S]*normalizeConnectionSlugForIpc\(input\.slug, 'connection slug'\)[\s\S]*buildConnectionModelCatalogEntries\(\{ connection \}\)[\s\S]*entry\.id === model && entry\.canUseAsChatDefault[\s\S]*connectionStore\.update\(slug, \{ defaultModel: model \}\)[\s\S]*connectionStore\.setDefault\(slug\)/,
      'main process must validate slug/model, reject non-chat defaults, update the connection default model, then set the default connection in one IPC',
    );
  });
});
