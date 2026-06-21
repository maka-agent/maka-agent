import { strict as assert } from 'node:assert';
import { readFile, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { describe, it } from 'node:test';

describe('localized main shell contract', () => {
  it('keeps the default app shell Chinese unless the user explicitly chooses English', async () => {
    const components = await readFile(resolve(process.cwd(), '..', '..', 'packages', 'ui', 'src', 'components.tsx'), 'utf8');
    const theme = await readFile(join(process.cwd(), 'src', 'renderer', 'theme.ts'), 'utf8');

    assert.match(components, /export function detectUiLocale\(\): UiLocale \{[\s\S]*return 'zh';\n\}/);
    assert.match(theme, /if \(preference === 'auto'\) \{[\s\S]*root\.setAttribute\('lang', 'zh'\);/);
    assert.doesNotMatch(components, /navigator\.language[\s\S]{0,160}startsWith\('zh'\)[\s\S]{0,80}\?\s*'zh'\s*:\s*'en'/);
  });

  it('does not leak English utility labels into the default chat accessibility tree', async () => {
    const components = await readFile(resolve(process.cwd(), '..', '..', 'packages', 'ui', 'src', 'components.tsx'), 'utf8');
    const relativeTime = await readFile(resolve(process.cwd(), '..', '..', 'packages', 'core', 'src', 'relative-time.ts'), 'utf8');
    const main = await readFile(join(process.cwd(), 'src', 'renderer', 'main.tsx'), 'utf8');
    const settings = await readFile(join(process.cwd(), 'src', 'renderer', 'settings', 'SettingsModal.tsx'), 'utf8');
    const providers = await readFile(join(process.cwd(), 'src', 'renderer', 'settings', 'ProvidersPanel.tsx'), 'utf8');
    const commandPalette = await readFile(join(process.cwd(), 'src', 'renderer', 'command-palette.tsx'), 'utf8');
    const zhComposerBlock = components.match(/zh: \{\n\s*placeholder: '描述任务，\/ 快捷调用，@ 添加上下文，标准模式经济高效'[\s\S]*?\n\s*\},\n\s*en:/)?.[0] ?? '';

    assert.match(components, /aria-label=\{session\.isFlagged \? '取消置顶对话' : '置顶对话'\}/);
    assert.doesNotMatch(components, /aria-label=\{session\.isFlagged \? 'Unpin chat' : 'Pin chat'\}/);
    assert.match(components, /const noMessagesYet = '暂无消息';/);
    assert.match(components, /label: '只读'[\s\S]*label: '确认'[\s\S]*label: '执行'/);
    assert.match(components, /label: '代码审查'/);
    assert.match(zhComposerBlock, /textareaAriaLabel: '消息输入框'/);
    assert.match(zhComposerBlock, /streamingHintInterrupt: '或点停止中断'/);
    assert.match(components, /detectUiLocale\(\) === 'en' \? 'en' : 'zh-CN'/);
    assert.match(relativeTime, /return 'zh-CN';/);
    assert.doesNotMatch(relativeTime, /navigator\.language/);
    assert.match(main, /ask: '所有敏感工具调用前都会停下来征求允许或拒绝。'/);
    assert.match(settings, /新会话默认从确认模式开始；可在对话顶部切到只读或执行。/);
    assert.match(settings, /SettingRow title="启动"[\s\S]*value="已启用"/);
    assert.match(settings, /SettingRow title="新对话模式"[\s\S]*value="确认"/);
    assert.match(settings, /props\.defaultSlug \?\? '未设置'/);
    assert.match(settings, /detail: '设置开关关闭'/);
    assert.doesNotMatch(settings, /Settings 开关关闭/);
    assert.match(providers, /已成功调用供应商接口，但返回 0 个模型/);
    assert.doesNotMatch(providers, /已成功调用 provider/);
    assert.match(commandPalette, /权限 · 只读[\s\S]*权限 · 确认[\s\S]*权限 · 执行/);
  });

  it('does not render idle Composer keyboard shortcut copy in the chat surface', async () => {
    const components = await readFile(resolve(process.cwd(), '..', '..', 'packages', 'ui', 'src', 'components.tsx'), 'utf8');

    assert.match(components, /import \{ Kbd \} from '\.\/primitives\/kbd\.js';/);
    assert.doesNotMatch(components, /maka-composer-shortcut-hint/);
    assert.doesNotMatch(components, /enterHint/);
    assert.doesNotMatch(components, /KbdGroup/);
    assert.match(
      components,
      /copy\.awaitingPermission/,
      'permission waiting status must stay visible to assistive technology',
    );
    assert.match(
      components,
      /copy\.sending/,
      'sending status must stay visible to assistive technology',
    );
    assert.doesNotMatch(components, /aria-keyshortcuts="Meta\+K"/);
    assert.match(
      components,
      /copy\.streamingHintPrefix\} <Kbd className="maka-shortcut-kbd">Esc<\/Kbd> \{copy\.streamingHintInterrupt/,
      'streaming interruption hint should keep Esc visible through shared primitive Kbd',
    );
    assert.doesNotMatch(
      components,
      /<kbd\b/,
      'components.tsx should not reintroduce hand-rolled shortcut glyphs now that shared primitive Kbd is available',
    );
  });

  it('keeps Settings modal landmarks named without visible shortcut filler', async () => {
    const settings = await readFile(join(process.cwd(), 'src', 'renderer', 'settings', 'SettingsModal.tsx'), 'utf8');

    assert.match(
      settings,
      /<main className="settingsSurface" data-modal="true" aria-label="设置内容">/,
      'Settings modal content landmark must be named in the accessibility tree',
    );
    assert.match(
      settings,
      /<aside className="settingsSidebar" aria-label="设置侧栏">/,
      'Settings modal sidebar landmark must be named in the accessibility tree',
    );
    assert.doesNotMatch(
      settings,
      /设置\s*<kbd>⌘<\/kbd><kbd>,<\/kbd>/,
      'Settings modal header should not expose the keyboard shortcut as visible filler copy',
    );
  });

  it('keeps decorative button and nav icons out of the accessibility tree', async () => {
    const components = await readFile(resolve(process.cwd(), '..', '..', 'packages', 'ui', 'src', 'components.tsx'), 'utf8');
    const settings = await readFile(join(process.cwd(), 'src', 'renderer', 'settings', 'SettingsModal.tsx'), 'utf8');

    assert.match(
      components,
      /<Settings className="maka-nav-icon" strokeWidth=\{1\.5\} aria-hidden="true" \/>/,
      'sidebar footer settings icon is decorative; the adjacent button aria-label provides the accessible name',
    );
    assert.match(
      components,
      /<UiButton className="maka-chat-tab-plus"[\s\S]*?<Plus strokeWidth=\{1\.5\} aria-hidden="true" \/>/,
      'New-chat plus buttons already have aria-label and must not expose a redundant icon',
    );
    for (const className of [
      'maka-chat-tab-plus',
      'maka-chat-header-memory-pill',
      'maka-chat-header-alert',
      'maka-chat-jump-bottom',
      'maka-message-copy',
      'maka-code-block-copy',
      'maka-prompt-chip',
      'maka-mode-switcher-option',
      'maka-turn-lineage-badge',
      'maka-session-branch-banner',
      'maka-turn-footer-action',
    ]) {
      assert.doesNotMatch(
        components,
        new RegExp(`<button\\b[^>]*\\bclassName="${className}(?:\\s|")`),
        `${className} should use the shared UiButton primitive instead of a raw button`,
      );
    }
    assert.match(
      components,
      /<UiButton className="maka-button maka-plan-submit"[\s\S]*?<Check size=\{14\} strokeWidth=\{1\.75\} aria-hidden="true" \/>[\s\S]*?<Plus size=\{14\} strokeWidth=\{1\.75\} aria-hidden="true" \/>/,
      'Plan submit icons are decorative because the button text says 保存提醒 / 创建提醒',
    );
    assert.match(
      components,
      /className="maka-button maka-tool-error-copy"[\s\S]*?<Check size=\{14\} aria-hidden="true" \/>[\s\S]*?<Copy size=\{14\} aria-hidden="true" \/>/,
      'Tool-error copy icons are decorative because the button has explicit copy text and aria-label',
    );
    assert.match(
      settings,
      /aria-label="关闭微信扫码登录"[\s\S]*?<X size=\{17\} aria-hidden="true" \/>/,
      'WeChat QR close button has a label; the X icon should stay decorative',
    );
  });

  it('exposes the selected Daily Review range in the segmented control', async () => {
    const components = await readFile(resolve(process.cwd(), '..', '..', 'packages', 'ui', 'src', 'components.tsx'), 'utf8');
    const dailyReviewRange = components.match(/<nav className="maka-daily-review-range"[\s\S]*?\{visibleSummary && visibleSummary\.totals/)?.[0] ?? '';

    assert.match(
      dailyReviewRange,
      /data-active=\{range === option \? 'true' : undefined\}/,
      'Daily Review range buttons must keep their visual selected state',
    );
    assert.match(
      dailyReviewRange,
      /aria-pressed=\{range === option\}/,
      'Daily Review range buttons must expose the selected segment to assistive technology',
    );
  });

  it('clears drag-active composer state when the drag leaves the window', async () => {
    const components = await readFile(resolve(process.cwd(), '..', '..', 'packages', 'ui', 'src', 'components.tsx'), 'utf8');
    const composerBlock = components.match(/export const Composer[\s\S]*?if \(props\.hidden\) return null;/)?.[0] ?? '';

    assert.match(composerBlock, /window\.addEventListener\('blur', clearDragActive\)/);
    assert.match(composerBlock, /window\.addEventListener\('dragend', clearDragActive\)/);
    assert.match(composerBlock, /window\.addEventListener\('drop', clearDragActive\)/);
    assert.match(composerBlock, /window\.removeEventListener\('blur', clearDragActive\)/);
  });

  it('does not force Daily Review Chinese labels into uppercase tracking', async () => {
    const components = await readFile(resolve(process.cwd(), '..', '..', 'packages', 'ui', 'src', 'components.tsx'), 'utf8');
    const styles = await readFile(join(process.cwd(), 'src', 'renderer', 'styles.css'), 'utf8');
    const totalsLabel = styles.match(/\.maka-daily-review-totals-label\s*\{[\s\S]*?\}/)?.[0] ?? '';
    const sectionTitle = styles.match(/\.maka-daily-review-section-title\s*\{[\s\S]*?\}/)?.[0] ?? '';

    assert.match(totalsLabel, /text-transform:\s*none;/);
    assert.match(totalsLabel, /letter-spacing:\s*0;/);
    assert.match(sectionTitle, /text-transform:\s*none;/);
    assert.match(sectionTitle, /letter-spacing:\s*0;/);
    assert.match(components, /<DailyReviewTotalsCell\s+label="Token"/);
    assert.match(components, /lines\.push\(`- Token：/);
    assert.doesNotMatch(components, /DailyReviewTotalsCell\s+label="Tokens"/);
  });

  it('labels Settings switch controls for accessibility', async () => {
    const settings = await readFile(join(process.cwd(), 'src', 'renderer', 'settings', 'SettingsModal.tsx'), 'utf8');
    const switchSignature = settings.match(/function Switch\(props: \{[\s\S]*?\}\) \{/)?.[0] ?? '';
    const switchCalls = [...settings.matchAll(/<Switch\b[\s\S]*?\/>/g)].map((match) => match[0]);

    assert.match(switchSignature, /ariaLabel: string/);
    assert.match(settings, /aria-label=\{props\.ariaLabel\}/);
    assert.ok(switchCalls.length >= 8, 'expected Settings to keep using the shared Switch control');
    for (const call of switchCalls) {
      assert.match(call, /ariaLabel=\{?["`]/, `missing ariaLabel on ${call}`);
    }
    assert.match(settings, /ariaLabel="启用联网搜索"/);
    assert.match(settings, /界面里显式触发的查询/);
    assert.match(settings, /保存在主进程设置中/);
    assert.doesNotMatch(settings, /主进程 settings/);
    assert.doesNotMatch(settings, /Agent 不会自动调用/);
    assert.match(settings, /ariaLabel="启用本地 MEMORY\.md"/);
    assert.match(settings, /ariaLabel="开放本机 API 网关"/);
    assert.match(settings, /ariaLabel=\{`启用\$\{BOT_LABELS\[selected\]\.label\}机器人`\}/);
  });

  it('exposes the active Settings nav item to assistive technology', async () => {
    const settings = await readFile(join(process.cwd(), 'src', 'renderer', 'settings', 'SettingsModal.tsx'), 'utf8');
    const settingsNavButton = settings.match(/className="settingsNavItem"[\s\S]*?onClick=\{\(\) => setSection\(item\.id\)\}/)?.[0] ?? '';

    assert.match(settingsNavButton, /data-active=\{section === item\.id\}/, 'Settings nav must keep its visual active state');
    assert.match(settingsNavButton, /aria-current=\{section === item\.id \? 'page' : undefined\}/, 'Settings nav must expose the current page to accessibility APIs');
  });

  it('restores the target-layout style sidebar module nav without losing the session list label', async () => {
    const components = await readFile(resolve(process.cwd(), '..', '..', 'packages', 'ui', 'src', 'components.tsx'), 'utf8');

    assert.match(
      components,
      /data-maka-search-trigger="true"/,
      'global search must remain reachable from the sidebar header and module nav',
    );
    assert.match(
      components,
      /const MODULE_NAV_LABEL: Record<ModuleNavId, string> = \{[\s\S]*sessions: '会话'[\s\S]*search: '搜索'[\s\S]*automations: '计划'[\s\S]*skills: '技能'[\s\S]*'daily-review': '每日回顾'/,
      'the restored module nav must keep Chinese-first labels for the main target-layout style entries',
    );
    assert.match(
      components,
      /const title = MODULE_NAV_LABEL\[props\.selection\.section\];/,
      'the sidebar content title should follow the active module after restoring the module nav',
    );
    assert.match(
      components,
      /<nav className="maka-sidebar-modules" aria-label="主导航">[\s\S]*className="maka-nav-row"[\s\S]*aria-label=\{MODULE_NAV_LABEL\.sessions\}[\s\S]*className="maka-nav-row"[\s\S]*aria-haspopup="dialog"[\s\S]*aria-label=\{MODULE_NAV_LABEL\.search\}/,
      'module navigation rows must be present and accessible',
    );
    assert.match(
      components,
      /<section className="maka-session-list" aria-label=\{title\}>/,
      'the sidebar content region should keep a single dynamic semantic label',
    );
    assert.doesNotMatch(
      components,
      /const title = '会话';/,
      'the restored module nav must not pin every module surface to the session title',
    );
  });

  it('does not announce the session module heading twice in the sidebar', async () => {
    const components = await readFile(resolve(process.cwd(), '..', '..', 'packages', 'ui', 'src', 'components.tsx'), 'utf8');
    const sessionList = components.match(/<section className="maka-session-list"[\s\S]*?<div className="maka-session-list-title"[\s\S]*?>/)?.[0] ?? '';

    assert.match(
      sessionList,
      /<section className="maka-session-list" aria-label=\{title\}>/,
      'the sidebar module region should keep a single semantic section label',
    );
    assert.match(
      sessionList,
      /className="maka-session-list-title" aria-hidden="true"/,
      'the visible module title is duplicate orientation copy and must not be announced before the group label',
    );
  });

  it('keeps the composer workspace picker concise instead of exposing absolute paths', async () => {
    const components = await readFile(resolve(process.cwd(), '..', '..', 'packages', 'ui', 'src', 'components.tsx'), 'utf8');
    const workspacePicker = components.match(/className="maka-composer-workspace-picker"[\s\S]*?aria-label=\{props\.workspacePicker\.branch[\s\S]*?>/)?.[0] ?? '';

    assert.match(
      workspacePicker,
      /title=\{props\.workspacePicker\.branch \? `选择工作目录 · \$\{props\.workspacePicker\.branch\}` : '选择工作目录'\}/,
      'workspace picker title should stay concise because native title is exposed as Accessibility Help',
    );
    assert.doesNotMatch(
      workspacePicker,
      /workspacePicker\.path|projectPath|title=\{[^}]*path/,
      'composer workspace picker must not expose absolute workspace paths through native title / AX Help',
    );
  });

  it('hides the app shell from the accessibility tree while a top-level modal is open', async () => {
    const main = await readFile(join(process.cwd(), 'src', 'renderer', 'main.tsx'), 'utf8');
    const preload = await readFile(join(process.cwd(), 'src', 'preload', 'preload.ts'), 'utf8');
    const mainProcess = await readFile(join(process.cwd(), 'src', 'main', 'main.ts'), 'utf8');
    const globalTypes = await readFile(join(process.cwd(), 'src', 'global.d.ts'), 'utf8');
    const appShell = main.match(/const hasModalOpen[\s\S]*?<div\s+className="app maka-shell-2col agents-layout-body"[\s\S]*?style=\{\{/)?.[0] ?? '';
    const titlebarControlsEffect = main.match(/const hasModalOpen[\s\S]*?useEffect\(\(\) => \{[\s\S]*?\}, \[hasModalOpen\]\);/)?.[0] ?? '';
    const modalMounts = main.match(/<\/div>\s*\{activePermission && \([\s\S]*?\{settingsOpen && \(/)?.[0] ?? '';

    assert.match(
      appShell,
      /const hasModalOpen = Boolean\(activePermission\) \|\| helpOpen \|\| paletteOpen \|\| searchModalOpen;/,
      'all top-level modal states must contribute to the accessibility background-hide flag; Settings is now an inline page, not a modal',
    );
    assert.match(
      appShell,
      /aria-hidden=\{hasModalOpen \? 'true' : undefined\}/,
      'the background app shell must be hidden from assistive tech while modal siblings are mounted',
    );
    assert.match(
      appShell,
      /inert=\{hasModalOpen \? true : undefined\}/,
      'the background app shell must be inert while modal siblings are mounted so focus and pointer events cannot escape behind the modal',
    );
    assert.match(
      appShell,
      /data-modal-background-hidden=\{hasModalOpen \? 'true' : undefined\}/,
      'the modal background-hidden state should remain inspectable in visual/a11y smoke runs',
    );
    assert.match(
      titlebarControlsEffect,
      /setTitlebarControlsVisible\(!hasModalOpen\)/,
      'top-level modals must hide native macOS titlebar controls so traffic lights do not float above the in-app modal scrim',
    );
    assert.match(
      titlebarControlsEffect,
      /setTitlebarControlsVisible\(true\)/,
      'native titlebar controls must be restored when the modal-owning shell unmounts or closes',
    );
    assert.match(
      preload,
      /setTitlebarControlsVisible\(visible: boolean\): Promise<void> \{\s*return ipcRenderer\.invoke\('window:setTitlebarControlsVisible', visible\);/,
      'preload must expose a typed titlebar controls bridge instead of letting renderer reach Electron directly',
    );
    assert.match(
      globalTypes,
      /setTitlebarControlsVisible\(visible: boolean\): Promise<void>;/,
      'window.maka.appWindow must type the titlebar controls bridge',
    );
    assert.match(
      mainProcess,
      /const MAIN_WINDOW_TRAFFIC_LIGHT_POSITION = \{ x: 14, y: 14 \} as const;[\s\S]*?const HIDDEN_TRAFFIC_LIGHT_POSITION = \{ x: -100, y: -100 \} as const;/,
      'main must keep named visible/hidden traffic-light positions instead of scattering magic coordinates',
    );
    assert.match(
      mainProcess,
      /ipcMain\.handle\('window:setTitlebarControlsVisible'[\s\S]*?BrowserWindow\.fromWebContents\(event\.sender\)[\s\S]*?target !== mainWindow[\s\S]*?process\.platform !== 'darwin'[\s\S]*?setWindowButtonVisibility\(shouldShow\)[\s\S]*?setWindowButtonPosition\(shouldShow \? MAIN_WINDOW_TRAFFIC_LIGHT_POSITION : HIDDEN_TRAFFIC_LIGHT_POSITION\)/,
      'main must own the native window button visibility and position change, scoped to the current main BrowserWindow on macOS',
    );
    assert.match(
      modalMounts,
      /\{activePermission && \([\s\S]*?<PermissionDialog[\s\S]*?\)\}\s*\{settingsOpen && \(/,
      'top-level modals must remain siblings after the hidden/inert app shell, not descendants of it',
    );
  });

  it('focuses the active Settings nav item when the page opens', async () => {
    const settings = await readFile(join(process.cwd(), 'src', 'renderer', 'settings', 'SettingsModal.tsx'), 'utf8');
    const modalBlock = settings.match(/function SettingsModal[\s\S]*?function SettingsSurface/)?.[0] ?? '';
    const navButtonBlock = settings.match(/items\.map\(\(item\) => \([\s\S]*?<\/Button>\s*\)\)/)?.[0] ?? '';

    assert.match(
      modalBlock,
      /const activeNavRef = useRef<HTMLButtonElement>\(null\);/,
      'Settings must nominate the active nav item as the initial focus target',
    );
    assert.match(
      modalBlock,
      /activeNavRef\.current\?\.focus\(\)/,
      'Settings page must focus the active nav ref on mount',
    );
    assert.match(
      modalBlock,
      /initialFocusRef=\{activeNavRef\}/,
      'SettingsSurface must receive the initial focus ref',
    );
    assert.match(
      navButtonBlock,
      /ref=\{section === item\.id \? props\.initialFocusRef : undefined\}/,
      'the active Settings nav item should own the initial focus ref',
    );
  });

  it('keeps Settings close affordance singular and avoids a duplicate bottom CTA', async () => {
    const settings = await readFile(join(process.cwd(), 'src', 'renderer', 'settings', 'SettingsModal.tsx'), 'utf8');
    const styles = await readFile(join(process.cwd(), 'src', 'renderer', 'styles.css'), 'utf8');
    const referenceShell = await readFile(join(process.cwd(), 'src', 'renderer', 'reference-shell.css'), 'utf8');
    const surfaceBlock = settings.match(/function SettingsSurface[\s\S]*?function SettingsPage/)?.[0] ?? '';

    assert.match(
      surfaceBlock,
      /className="settingsCloseButton"[\s\S]*aria-label="关闭设置"/,
      'Settings keeps one fixed header close button as the modal close affordance',
    );
    assert.doesNotMatch(
      surfaceBlock,
      new RegExp('settingsDoneButton|>完成</button>'),
      'Settings must not reintroduce the duplicate bottom-right 完成 button',
    );
    assert.doesNotMatch(
      styles,
      /\\.settingsDoneButton|bottom-right 完成 CTA/,
      'Settings CSS must not keep stale styling or comments for the removed duplicate CTA',
    );
    assert.match(
      styles,
      /\.settingsMainPane \{[\s\S]*?padding:\s*22px 26px 26px;/,
      'main pane should not reserve bottom space for a removed absolute-positioned CTA',
    );
  });

  it('keeps the resizable session-list width as integer pixels for readable splitter values', async () => {
    const main = await readFile(join(process.cwd(), 'src', 'renderer', 'main.tsx'), 'utf8');
    const resizeBlock = main.slice(main.indexOf('function startColumnResize'), main.indexOf('function onResizeHandleKeyDown'));
    const persistBlock = main.slice(main.indexOf("useEffect(() => {\n    try {\n      localStorage.setItem('maka-chat-list-width-v1'"), main.indexOf('// Persist sidebar nav selection'));
    const keyBlock = main.slice(main.indexOf('function onResizeHandleKeyDown'), main.indexOf('const hasModalOpen'));
    const readBlock = main.slice(main.indexOf('function readSessionListWidth'), main.indexOf('function isNoRealConnectionError'));

    assert.match(main, /const SESSION_LIST_EXPANDED_DEFAULT_WIDTH = 210;/);
    assert.match(main, /const SESSION_LIST_EXPANDED_MIN_WIDTH = 210;/);
    assert.match(main, /const SESSION_LIST_EXPANDED_MAX_WIDTH = 280;/);
    assert.match(main, /function clampSessionListWidth\(value: number\): number \{\s*return Math\.round\(clamp\(value, SESSION_LIST_EXPANDED_MIN_WIDTH, SESSION_LIST_EXPANDED_MAX_WIDTH\)\);\s*\}/m);
    assert.match(resizeBlock, /setSessionListWidth\(clampSessionListWidth\(start \+ delta\)\)/);
    assert.match(keyBlock, /setSessionListWidth\(clampSessionListWidth\(next\)\)/);
    assert.match(keyBlock, /next = SESSION_LIST_EXPANDED_MIN_WIDTH;/);
    assert.match(keyBlock, /next = SESSION_LIST_EXPANDED_MAX_WIDTH;/);
    assert.match(readBlock, /return clampSessionListWidth\(stored\);/);
    assert.match(readBlock, /return SESSION_LIST_EXPANDED_DEFAULT_WIDTH;/);
    assert.match(main, /aria-valuenow=\{sessionListWidth\}/, 'splitter aria-valuenow should receive the normalized integer state');
    assert.match(main, /aria-valuemin=\{SESSION_LIST_EXPANDED_MIN_WIDTH\}/);
    assert.match(main, /aria-valuemax=\{SESSION_LIST_EXPANDED_MAX_WIDTH\}/);
    assert.match(persistBlock, /try \{[\s\S]*localStorage\.setItem\('maka-chat-list-width-v1', String\(sessionListWidth\)\);[\s\S]*\} catch \{/, 'width persistence must not crash when localStorage is unavailable');
    assert.match(readBlock, /try \{[\s\S]*localStorage\.getItem\('maka-chat-list-width-v1'\)[\s\S]*\} catch \{/, 'width restore must not crash when localStorage is unavailable');
    assert.match(resizeBlock, /setPointerCapture\(event\.pointerId\)/, 'dragging the splitter should capture pointer events while resizing');
    assert.match(resizeBlock, /window\.addEventListener\('blur', cleanupResize\)/, 'resize cleanup must run if the window loses focus mid-drag');
    assert.match(resizeBlock, /window\.removeEventListener\('blur', cleanupResize\)/, 'resize cleanup must remove the blur listener');
  });

  it('keeps the target-layout like app shell as one canvas with a fully hidden collapsed sidebar', async () => {
    const components = await readFile(resolve(process.cwd(), '..', '..', 'packages', 'ui', 'src', 'components.tsx'), 'utf8');
    const main = await readFile(join(process.cwd(), 'src', 'renderer', 'main.tsx'), 'utf8');
    const styles = await readFile(join(process.cwd(), 'src', 'renderer', 'styles.css'), 'utf8');
    const referenceShell = await readFile(join(process.cwd(), 'src', 'renderer', 'reference-shell.css'), 'utf8');

    assert.match(components, /sidebarCollapsed\?: boolean;/);
    assert.match(components, /onToggleSidebar\?\(\): void;/);
    assert.match(components, /data-collapsed=\{props\.sidebarCollapsed \? 'true' : undefined\}/);
    assert.match(components, /className="maka-sidebar-search-button"[\s\S]*aria-label="搜索对话"[\s\S]*<Search size=\{16\}/);
    assert.match(components, /className="maka-sidebar-toggle"[\s\S]*aria-label=\{props\.sidebarCollapsed \? '展开侧边栏' : '收起侧边栏'\}[\s\S]*aria-expanded=\{!props\.sidebarCollapsed\}/);
    assert.match(components, /className="maka-sidebar-modules" aria-label="主导航"/);
    assert.match(components, /const isModuleActive = \(id: ModuleNavId\) => \{/);
    assert.match(components, /aria-current=\{isModuleActive\('sessions'\) \? 'page' : undefined\}/);
    assert.match(components, /aria-current=\{isModuleActive\('automations'\) \? 'page' : undefined\}/);
    assert.match(components, /aria-current=\{isModuleActive\('skills'\) \? 'page' : undefined\}/);
    assert.doesNotMatch(components, /<span>扩展<\/span>/);
    assert.doesNotMatch(components, /<span>专家套件<\/span>/);
    assert.doesNotMatch(components, /<span>连接器<\/span>/);

    assert.match(main, /const \[sessionListCollapsed, setSessionListCollapsed\] = useState\(\(\) => readSessionListCollapsed\(\)\);/);
    assert.match(main, /localStorage\.setItem\('maka-chat-list-collapsed-v1', sessionListCollapsed \? 'true' : 'false'\)/);
    assert.match(main, /data-sidebar-state=\{sessionListCollapsed \? 'collapsed' : 'expanded'\}/);
    assert.match(main, /const SESSION_LIST_COLLAPSED_WIDTH = 0;/);
    assert.match(main, /const onboardingComposerHidden = showOnboardingHero && onboardingState !== undefined;/);
    assert.match(main, /hidden=\{navSelection\.section !== 'sessions' \|\| onboardingComposerHidden\}/);
    assert.match(main, /'--maka-session-list-width': `\$\{sessionListCollapsed \? SESSION_LIST_COLLAPSED_WIDTH : sessionListWidth\}px`/);
    assert.match(main, /'--maka-resize-handle-width': '0px'/);
    assert.match(main, /className="maka-panel maka-panel-list maka-floating-panel"[\s\S]*aria-hidden=\{sessionListCollapsed \? 'true' : undefined\}[\s\S]*inert=\{sessionListCollapsed \? true : undefined\}/);
    assert.match(main, /className="maka-panel maka-panel-detail maka-floating-panel agents-content-area agents-parchment-paper-surface"[\s\S]*data-sidebar-state=\{sessionListCollapsed \? 'collapsed' : 'expanded'\}/);
    assert.match(main, /data-agents-view=\{[\s\S]*navSelection\.section === 'automations'[\s\S]*\? 'cron'/);
    const collapsedTopbarMarkup = main.match(/className="maka-collapsed-drag-strip" aria-label="侧边栏已收起"[\s\S]*?<MakaUriContext\.Provider/)?.[0] ?? '';
    assert.match(collapsedTopbarMarkup, /aria-label="展开侧边栏"[\s\S]*<PanelLeftOpen size=\{16\}/);
    assert.match(collapsedTopbarMarkup, /onClick=\{\(\) => setSearchModalOpen\(true\)\}[\s\S]*aria-label="搜索对话"[\s\S]*<Search size=\{16\}/);
    // WAWQAQ msg `2690c2e4`: sidebar primary action labeled "新任务" to
    // match reference implementation's home rail. Both the expanded
    // `maka-nav-primary` and this collapsed `maka-collapsed-topbar-button`
    // share the same label.
    assert.match(collapsedTopbarMarkup, /onClick=\{createSession\}[\s\S]*aria-label="新任务"[\s\S]*<SquarePen size=\{16\}/);
    assert.match(main, /className="maka-workspace-top-actions" role="toolbar" aria-label="工作区辅助操作"/);
    assert.match(main, /className="maka-workspace-feedback-action"[\s\S]*onClick=\{\(\) => openSettingsSection\('about'\)\}[\s\S]*问题反馈/);
    assert.match(main, /className="maka-workspace-icon-action"[\s\S]*onClick=\{openPalette\}[\s\S]*aria-label="打开命令面板"[\s\S]*<Grid3X3 size=\{15\}/);
    assert.match(main, /className="maka-workspace-icon-action"[\s\S]*onClick=\{openHelp\}[\s\S]*aria-label="打开帮助"[\s\S]*<HelpCircle size=\{15\}/);
    assert.match(main, /className="maka-workspace-icon-action"[\s\S]*onClick=\{\(\) => openSettingsSection\('health'\)\}[\s\S]*aria-label="打开健康中心"[\s\S]*<CircleGauge size=\{15\}/);
    const workspaceTopActions = extractCssRule(styles, '.maka-workspace-top-actions');
    const workspaceFeedbackAction = extractCssRule(styles, '.maka-workspace-feedback-action');
    assert.ok(workspaceTopActions, '.maka-workspace-top-actions rule must exist');
    assert.ok(workspaceFeedbackAction, '.maka-workspace-feedback-action rule must exist');
    assert.match(workspaceTopActions, /position:\s*absolute/);
    assert.match(workspaceTopActions, /top:\s*11px/);
    assert.match(workspaceTopActions, /right:\s*24px/);
    assert.match(workspaceTopActions, /gap:\s*6px/);
    assert.match(workspaceFeedbackAction, /font-size:\s*11px/);
    assert.match(workspaceFeedbackAction, /font-weight:\s*500/);
    assert.match(workspaceFeedbackAction, /color:\s*var\(--foreground-55\)/);
    assert.match(styles, /\.mainColumn\[data-home-surface="true"\]\s*\{[\s\S]*?grid-template-rows:\s*minmax\(0,\s*1fr\) auto[\s\S]*?align-content:\s*stretch/);
    assert.match(styles, /\.mainColumn\[data-home-surface="true"\] \.maka-chatContent\s*\{[\s\S]*?padding:\s*clamp\(72px,\s*10vh,\s*116px\) 0 clamp\(20px,\s*4vh,\s*42px\)[\s\S]*?display:\s*grid[\s\S]*?align-content:\s*center/);
    assert.match(main, /if \(sessionListCollapsed\) return;[\s\S]*function onResizeHandleKeyDown/);
    assert.match(main, /aria-hidden=\{sessionListCollapsed \? 'true' : undefined\}/);
    assert.match(main, /tabIndex=\{sessionListCollapsed \? -1 : 0\}/);
    assert.match(main, /function readSessionListCollapsed\(\): boolean \{[\s\S]*return true;\n\}/);

    const floatingPanel = extractCssRule(styles, '.maka-floating-panel');
    assert.ok(floatingPanel, '.maka-floating-panel rule must exist');
    assert.match(floatingPanel, /border:\s*0/);
    assert.match(floatingPanel, /border-radius:\s*0/);
    assert.match(floatingPanel, /box-shadow:\s*none/);
    const listPanel = extractCssRule(styles, '.maka-panel-list.maka-floating-panel');
    assert.ok(listPanel, '.maka-panel-list.maka-floating-panel rule must exist');
    assert.match(listPanel, /border-right:\s*0/);
    // WAWQAQ msg ef6b2852: sidebar must read as one flat strip on the shell
    // canvas. The right content surface supplies separation through its
    // own 4px margin + hairline, not a sidebar card or divider.
    assert.match(listPanel, /background:\s*transparent/);
    assert.doesNotMatch(listPanel, /calc\(l - 0\.015\)/);
    assert.match(styles, /\.maka-shell-2col\[data-sidebar-state="collapsed"\] \.maka-panel-list\.maka-floating-panel \{[\s\S]*?border-right:\s*0/);
    const detailPanel = extractCssRule(styles, '.maka-panel-detail.maka-floating-panel');
    assert.ok(detailPanel, '.maka-panel-detail.maka-floating-panel rule must exist');
    // WAWQAQ ef6b2852: bundle-derived values (4px gap + 6px radius), not 12px.
    assert.match(detailPanel, /margin:\s*4px 4px 4px 0/);
    assert.match(detailPanel, /border:\s*1px solid var\(--border\)/);
    assert.match(detailPanel, /border-radius:\s*6px/);
    assert.match(detailPanel, /background:\s*var\(--background\)/);
    assert.match(detailPanel, /box-shadow:\s*none/);
    assert.match(detailPanel, /display:\s*flex/);
    assert.match(detailPanel, /flex-direction:\s*column/);
    assert.doesNotMatch(detailPanel, /background-image:\s*radial-gradient/);
    assert.match(referenceShell, /\.agents-layout-root\s*\{[\s\S]*?height:\s*100dvh/);
    assert.match(referenceShell, /\.agents-layout-root\s*\{[\s\S]*?background:\s*var\(--color-bg-layout\)/);
    assert.match(referenceShell, /--agents-content-area-gap:\s*4px/);
    assert.match(referenceShell, /--agents-content-area-radius:\s*6px/);
    assert.match(referenceShell, /\.agents-sidebar\s*\{[\s\S]*?contain:\s*layout paint style/);
    assert.match(referenceShell, /\.maka-panel-detail\.maka-floating-panel\.agents-content-area\s*\{[\s\S]*?border:\s*1px solid var\(--color-border-tertiary\)/);
    assert.match(referenceShell, /\.agents-parchment-paper-surface\s*\{[\s\S]*?border:\s*1px solid var\(--color-border-tertiary\)/);
    assert.doesNotMatch(referenceShell, /radial-gradient\(circle,\s*#3a2a1c0b/);
    const collapsedTopbar = extractCssRule(styles, '.maka-collapsed-drag-strip');
    assert.ok(collapsedTopbar, '.maka-collapsed-drag-strip rule must exist');
    assert.match(collapsedTopbar, /min-height:\s*38px/);
    assert.match(styles, /--maka-titlebar-control-safe-left:\s*94px/);
    assert.match(collapsedTopbar, /padding:\s*8px 12px 0 var\(--maka-titlebar-control-safe-left\)/);
    assert.match(collapsedTopbar, /-webkit-app-region:\s*drag/);
    const collapsedTopbarButton = extractCssRule(styles, '.maka-collapsed-topbar-button');
    assert.ok(collapsedTopbarButton, '.maka-collapsed-topbar-button rule must exist');
    assert.match(collapsedTopbarButton, /-webkit-app-region:\s*no-drag/);
    const sidebarTopBar = extractCssRule(styles, '.maka-sidebar-drag-strip');
    assert.ok(sidebarTopBar, '.maka-sidebar-drag-strip rule must exist');
    assert.match(sidebarTopBar, /justify-content:\s*space-between/);
    assert.match(sidebarTopBar, /box-sizing:\s*border-box/);
    assert.match(sidebarTopBar, /padding-left:\s*calc\(var\(--maka-titlebar-control-safe-left\) - 10px\)/);
    assert.match(styles, /(?:^|\n)\.maka-nav-icon\s*\{[\s\S]*?width:\s*18px[\s\S]*?height:\s*18px/);
    assert.match(styles, /\.maka-sidebar-modules\b/);
    assert.doesNotMatch(styles, /\.maka-sidebar-module-hint\b/);
    assert.match(styles, /\.maka-nav-row\b/);
    assert.match(styles, /\.maka-sidebar-search-button,\n\.maka-sidebar-toggle \{/);
    const detailWithArtifacts = extractCssRule(styles, '.maka-detail-with-artifacts');
    assert.ok(detailWithArtifacts, '.maka-detail-with-artifacts rule must exist');
    assert.match(detailWithArtifacts, /flex:\s*1 1 auto/);
    assert.match(detailWithArtifacts, /height:\s*auto/);
    // PR-REFERENCE-PIXEL-3 (WAWQAQ msg `f79de85f` round 3): widened to
    // 240 to match reference implementation's `[data-agents-page] { --sidebar-width:
    // 240px }`. Was 210.
    assert.match(styles, /--w-sessionlist:\s*240px;/);
  });

  it('uses the requested neutral gray plate, white content surface, and Maka app icon', async () => {
    const tokens = await readFile(join(process.cwd(), 'src', 'renderer', 'maka-tokens.css'), 'utf8');
    const shell = await readFile(join(process.cwd(), 'src', 'renderer', 'reference-shell.css'), 'utf8');
    const mainProcess = await readFile(join(process.cwd(), 'src', 'main', 'main.ts'), 'utf8');
    const iconPath = join(process.cwd(), 'assets', 'icon.png');
    const icon = await stat(iconPath);
    const iconBuffer = await readFile(iconPath);

    assert.ok(icon.size > 1_400_000, 'the edge-filled user-provided PNG icon must be present as the desktop app icon asset');
    assert.equal(iconBuffer.toString('ascii', 1, 4), 'PNG', 'desktop app icon must remain a PNG asset');
    assert.equal(iconBuffer.readUInt32BE(16), 1254, 'desktop app icon width must match the supplied edge-filled icon');
    assert.equal(iconBuffer.readUInt32BE(20), 1254, 'desktop app icon height must match the supplied edge-filled icon');
    assert.equal(iconBuffer[25], 6, 'desktop app icon must be RGBA so the rounded icon corners stay transparent');
    assert.match(tokens, /--background:\s*oklch\(1\.000 0 0\);/);
    assert.match(tokens, /--surface-canvas:\s*oklch\(0\.935 0 0\);/);
    assert.match(tokens, /--foreground:\s*oklch\(0\.18 0 0\);/);
    assert.match(tokens, /--chat-user-bg:\s*oklch\(0\.935 0 0\);/);
    assert.match(tokens, /\.dark\s*\{[\s\S]*--background:\s*oklch\(0\.21 0 0\);[\s\S]*--surface-canvas:\s*oklch\(0\.13 0 0\);/);
    assert.match(shell, /--color-bg-layout:\s*var\(--surface-canvas\);/);
    assert.match(shell, /--color-bg-container:\s*var\(--background\);/);
    assert.match(mainProcess, /icon:\s*join\(import\.meta\.dirname, '\.\.', '\.\.', 'assets', 'icon\.png'\)/);
    assert.match(mainProcess, /app\.dock\.setIcon\(nativeImage\.createFromPath\(iconPath\)\)/);
  });

  it('keeps the chat composer as the only main card with a target-layout like frame', async () => {
    const components = await readFile(resolve(process.cwd(), '..', '..', 'packages', 'ui', 'src', 'components.tsx'), 'utf8');
    const styles = await readFile(join(process.cwd(), 'src', 'renderer', 'styles.css'), 'utf8');
    const referenceShell = await readFile(join(process.cwd(), 'src', 'renderer', 'reference-shell.css'), 'utf8');
    const emptyHero = components.match(/function EmptyChatHero[\s\S]*?function DeepResearchEmptyHero/)?.[0] ?? '';
    const composerCard = extractCssRule(styles, '.composer .maka-composer-inner');
    const composerFocus = extractCssRule(styles, '.composer .maka-composer-inner:focus-within');
    const composerToolbar = extractCssRule(styles, '.composerActions');
    const composerTextarea = extractCssRule(styles, '.composer textarea');
    const composerShell = extractCssRule(styles, '.composer');
    const heroShell = extractCssRule(styles, '.maka-hero,\n.emptyChat');
    const heroHeadline = extractCssRule(styles, '.maka-hero h1,\n.emptyChat h1');
    const workspaceRow = extractCssRule(styles, '.maka-composer-workspace-row');
    const workspacePicker = extractCssRule(styles, '.maka-composer-workspace-picker');
    const workspacePickerHover = extractCssRule(styles, '.maka-composer-workspace-picker:hover');
    const contextButton = extractCssRule(styles, '.maka-composer-context-plus');
    const micButton = extractCssRule(styles, '.maka-composer-tool-button.maka-composer-mic-button');
    const disabledMicButton = extractCssRule(styles, '.maka-composer-tool-button.maka-composer-mic-button:disabled');
    const noActiveSessionBlock = components.match(/if \(!props\.activeSession\) \{[\s\S]*?\n  \}/)?.[0] ?? '';
    const activeSessionBlock = components.match(/const isLocalSimulationBackend[\s\S]*?<\/header>/)?.[0] ?? '';

    assert.ok(emptyHero, 'EmptyChatHero source must be discoverable');
    assert.ok(noActiveSessionBlock, 'no-active-session chat branch must be discoverable');
    assert.ok(activeSessionBlock, 'active-session chat header branch must be discoverable');
    assert.doesNotMatch(
      noActiveSessionBlock,
      /PermissionModeSwitcher|新建对话后再切换模式/,
      'new-chat empty home should not waste top-bar space on an unavailable mode switcher',
    );
    assert.match(activeSessionBlock, /const isEmptyHome = chat\.length === 0 && !props\.streamingText && !props\.messageLoadError && !deepResearchActive/);
    assert.match(activeSessionBlock, /\{!isEmptyHome && \(\s*<header className="maka-chat-header">/);
    assert.match(
      activeSessionBlock,
      /<PermissionModeSwitcher[\s\S]*mode=\{props\.activeSession\.permissionMode\}/,
      'non-empty active sessions must keep the permission mode switcher available in the chat header',
    );
    assert.doesNotMatch(emptyHero, /maka-prompt-suggestions/);
    assert.doesNotMatch(emptyHero, /maka-prompt-chip/);
    assert.doesNotMatch(emptyHero, /getPromptSuggestions\(locale\)/);
    assert.doesNotMatch(emptyHero, /maka-hero-eyebrow/);
    assert.doesNotMatch(emptyHero, /maka-hero-palette-hint/);
    assert.doesNotMatch(emptyHero, /paletteHint|copy\.eyebrow/);
    assert.match(components, /intro:\s*'本地运行、自主规划、安全可控的 AI 工作搭子。'/);
    assert.doesNotMatch(components, /说一下你要改的、想问的、想查的；直接在下方输入框里描述需求/);
    assert.doesNotMatch(styles, /\.maka-hero-palette-hint/);
    assert.ok(composerShell, '.composer rule must exist');
    assert.match(composerShell, /display:\s*flex/);
    assert.match(composerShell, /align-items:\s*center/);
    assert.ok(heroShell, '.maka-hero rule must exist');
    assert.match(heroShell, /width:\s*min\(750px,\s*80vw\)/);
    assert.match(heroShell, /justify-items:\s*start/);
    assert.match(heroShell, /gap:\s*28px/);
    assert.match(heroShell, /text-align:\s*left/);
    assert.ok(heroHeadline, '.maka-hero h1 rule must exist');
    assert.match(heroHeadline, /font-size:\s*28px/);
    assert.doesNotMatch(heroHeadline, /clamp\(/);
    assert.ok(composerCard, '.composer .maka-composer-inner rule must exist');
    assert.match(composerCard, /--h-composer-min:\s*72px/);
    assert.match(composerCard, /width:\s*min\(680px,\s*80vw\)/);
    assert.match(composerCard, /max-width:\s*680px/);
    assert.match(composerCard, /margin-inline:\s*auto/);
    assert.match(composerCard, /box-sizing:\s*border-box/);
    assert.match(composerCard, /border-radius:\s*10px/);
    assert.match(composerCard, /padding:\s*10px 12px/);
    assert.match(composerCard, /0 0 0 1px oklch\(from var\(--foreground\) l c h \/ 0\.06\)/);
    assert.match(components, /className="maka-composer-inner composerInner agents-parchment-paper-surface"/);
    assert.match(referenceShell, /\.composer \.maka-composer-inner\.agents-parchment-paper-surface\s*\{[\s\S]*?border:\s*1px solid var\(--color-border-tertiary\)[\s\S]*?box-shadow:\s*0 1px 3px rgba\(0, 0, 0, 0\.03\)/);
    assert.doesNotMatch(referenceShell, /0 18px 46px/);
    assert.doesNotMatch(composerCard, /0 2px 8px/);
    assert.doesNotMatch(composerCard, /var\(--shadow-medium\)/);
    assert.ok(composerFocus, '.composer .maka-composer-inner:focus-within rule must exist');
    assert.match(composerFocus, /0 0 0 1px oklch\(from var\(--foreground\) l c h \/ 0\.16\)/);
    assert.doesNotMatch(composerFocus, /var\(--accent\)/);
    assert.doesNotMatch(composerFocus, /0 2px 8px/);
    assert.doesNotMatch(composerFocus, /var\(--shadow-medium\)/);
    assert.ok(composerToolbar, '.composerActions rule must exist');
    assert.match(composerToolbar, /gap:\s*8px/);
    assert.match(composerToolbar, /margin-top:\s*6px/);
    assert.match(composerToolbar, /padding-top:\s*6px/);
    assert.match(composerToolbar, /border-top:\s*1px solid oklch\(from var\(--foreground\) l c h \/ 0\.05\)/);
    assert.ok(composerTextarea, '.composer textarea rule must exist');
    assert.match(composerTextarea, /min-height:\s*var\(--h-composer-min,\s*84px\)/);
    assert.match(styles, /\.maka-composer-left-controls,\n\.maka-composer-right-controls \{[\s\S]*?gap:\s*8px/);
    assert.match(styles, /\.maka-composer-role-chip,\n\.maka-composer-mode-chip,\n\.maka-composer-model-chip \{[\s\S]*?height:\s*24px[\s\S]*?border:\s*1px solid var\(--color-border-tertiary\)[\s\S]*?border-radius:\s*999px/);
    assert.match(components, /className="maka-composer-tool-button maka-composer-context-plus"[\s\S]*aria-label=\{pendingImportAction === 'file' \? '正在添加上下文' : '添加上下文'\}[\s\S]*<Plus size=\{15\}/);
    assert.ok(contextButton, '.maka-composer-context-plus rule must exist');
    assert.match(contextButton, /width:\s*24px/);
    assert.match(contextButton, /height:\s*24px/);
    assert.match(contextButton, /border:\s*1px solid var\(--foreground-20\)/);
    assert.match(contextButton, /border-radius:\s*999px/);
    assert.match(components, /className="maka-composer-role-chip"[\s\S]*aria-label="通用助手"[\s\S]*通用[\s\S]*<ChevronDown size=\{12\}/);
    assert.match(components, /modelLabel\?: string;/);
    assert.match(components, /const modelChipLabel = props\.modelLabel\?\.trim\(\) \|\| '选择模型'/);
    assert.match(components, /className="maka-composer-model-chip"[\s\S]*aria-label=\{`当前模型：\$\{modelChipLabel\}`\}[\s\S]*<span className="maka-composer-model-chip-text">\{modelChipLabel\}<\/span>/);
    assert.match(components, /className="maka-composer-tool-button maka-composer-mic-button"[\s\S]*aria-label="语音输入暂未启用"[\s\S]*<Mic size=\{14\}/);
    assert.ok(micButton, '.maka-composer-tool-button.maka-composer-mic-button rule must exist');
    assert.match(micButton, /width:\s*24px/);
    assert.match(micButton, /height:\s*24px/);
    assert.match(micButton, /border:\s*0/);
    assert.match(micButton, /background:\s*transparent/);
    assert.ok(disabledMicButton, '.maka-composer-mic-button:disabled rule must exist');
    assert.match(disabledMicButton, /border:\s*0/);
    assert.match(disabledMicButton, /background:\s*transparent/);
    assert.match(disabledMicButton, /color:\s*var\(--foreground-55\)/);
    assert.match(disabledMicButton, /opacity:\s*1/);
    assert.doesNotMatch(components, /aria-label=\{pendingImportAction === 'file' \? '正在导入文件内容' : '导入文件内容'\}/);
    assert.doesNotMatch(components, /aria-label=\{pendingImportAction === 'folder' \? '正在导入文件夹目录' : '导入文件夹目录'\}/);
    assert.doesNotMatch(components, /Paperclip/);
    assert.match(components, /import \{[\s\S]*ArrowUp,[\s\S]*\} from 'lucide-react';/);
    assert.match(components, /className="maka-composer-send-button"[\s\S]*size="icon-sm"[\s\S]*aria-label=\{buttonCopy\.sendLabel\}[\s\S]*<ArrowUp size=\{16\} strokeWidth=\{2\.1\} aria-hidden="true" \/>/);
    const sendButton = extractCssRule(styles, '.maka-composer-send-button');
    assert.ok(sendButton, '.maka-composer-send-button rule must exist');
    assert.match(sendButton, /width:\s*28px/);
    assert.match(sendButton, /height:\s*28px/);
    assert.match(sendButton, /border-radius:\s*999px/);
    assert.match(sendButton, /background:\s*#000/);
    assert.match(sendButton, /color:\s*#fff/);
    const disabledSendButton = extractCssRule(styles, '.maka-composer-send-button:disabled');
    assert.ok(disabledSendButton, '.maka-composer-send-button:disabled rule must exist');
    assert.match(disabledSendButton, /background:\s*#000/);
    assert.match(disabledSendButton, /color:\s*#fff/);
    assert.match(disabledSendButton, /opacity:\s*1/);
    assert.match(components, /workspacePicker\?: \{[\s\S]*label\?: string;[\s\S]*branch\?: string \| null;[\s\S]*onOpen\(\): void;[\s\S]*\};/);
    // WAWQAQ msg `28128c9e` (2026-06-20): "选择工作目录" placeholder only
    // when label is missing; once a directory is chosen, the picker
    // shows just `.maka-composer-workspace-current` (no doubled string).
    assert.match(components, /className="maka-composer-workspace-picker"[\s\S]*<FolderOpen size=\{13\}[\s\S]*workspacePicker\.label[\s\S]*<span className="maka-composer-workspace-current">\{props\.workspacePicker\.label\}<\/span>[\s\S]*<span>选择工作目录<\/span>[\s\S]*<ChevronDown size=\{12\}/);
    assert.ok(workspaceRow, '.maka-composer-workspace-row rule must exist');
    // PR-PARCHMENT-HOME-2: composer + workspace-row share the new 680
    // measure to align with reference implementation's hero composer card.
    assert.match(workspaceRow, /width:\s*min\(680px,\s*80vw\)/);
    assert.match(workspaceRow, /margin:\s*8px auto 0/);
    assert.doesNotMatch(workspaceRow, /padding-inline/);
    assert.ok(workspacePicker, '.maka-composer-workspace-picker rule must exist');
    assert.match(workspacePicker, /font-size:\s*12px/);
    assert.match(workspacePicker, /background:\s*transparent/);
    assert.match(workspacePicker, /padding:\s*6px 8px/);
    assert.match(workspacePicker, /line-height:\s*1\.25/);
    assert.match(workspacePicker, /border:\s*0/);
    assert.ok(workspacePickerHover, '.maka-composer-workspace-picker:hover rule must exist');
    // PR-REFERENCE-PIXEL-1 (WAWQAQ msg `f79de85f` round 1): hover bg moved
    // from `--foreground-3` to alpha overlay so it stays visible on
    // the gray plate (same fix kenji's slim-inset nav-row work used).
    assert.match(workspacePickerHover, /background:\s*oklch\(from var\(--foreground\) l c h \/ 0\.06\)/);
  });

  it('keeps first-run Quick Chat helper rows aligned inside the composer card', async () => {
    const styles = await readFile(join(process.cwd(), 'src', 'renderer', 'styles.css'), 'utf8');
    const quickchat = extractCssRule(styles, '.maka-onboarding-quickchat');
    const quickchatInput = extractCssRule(styles, '.maka-onboarding-quickchat-input');
    const quickchatExample = extractCssRule(styles, '.maka-onboarding-quickchat-example');
    const quickchatExamplePending = extractCssRule(styles, '.maka-onboarding-quickchat-example[data-pending="true"]');
    const quickchatMode = extractCssRule(styles, '.maka-onboarding-quickchat-mode');
    const quickchatActions = extractCssRule(styles, '.maka-onboarding-quickchat-actions');

    assert.ok(quickchat, '.maka-onboarding-quickchat rule must exist');
    assert.ok(quickchatInput, '.maka-onboarding-quickchat-input rule must exist');
    assert.ok(quickchatExample, '.maka-onboarding-quickchat-example rule must exist');
    assert.ok(quickchatExamplePending, '.maka-onboarding-quickchat-example[data-pending="true"] rule must exist');
    assert.ok(quickchatMode, '.maka-onboarding-quickchat-mode rule must exist');
    assert.ok(quickchatActions, '.maka-onboarding-quickchat-actions rule must exist');
    assert.match(quickchat, /border-radius:\s*10px/);
    assert.match(quickchatInput, /padding:\s*10px 12px/);
    assert.match(
      quickchatExample,
      /padding-inline:\s*12px/,
      'Quick Chat example copy must align with textarea text instead of touching the card border',
    );
    assert.match(
      quickchatExamplePending,
      /font-style:\s*normal/,
      'Quick Chat import pending status should read as a status line, not as example copy',
    );
    assert.match(quickchatExamplePending, /color:\s*var\(--accent\)/);
    assert.match(
      quickchatMode,
      /margin:\s*6px 16px 0/,
      'Quick Chat mode chip must align with textarea text instead of touching the card border',
    );
    assert.match(
      quickchatMode,
      /max-width:\s*calc\(100% - 32px\)/,
      'Quick Chat mode chip must stay inside the bordered composer card on narrow widths',
    );
    assert.match(quickchatActions, /padding:\s*6px 8px/);
  });

  it('keeps English skill metadata out of the visible skills list copy', async () => {
    const components = await readFile(resolve(process.cwd(), '..', '..', 'packages', 'ui', 'src', 'components.tsx'), 'utf8');
    const skillPanel = components.match(/function SkillLibraryPanel[\s\S]*?function formatSkillLibraryDescription/)?.[0] ?? '';
    const formatter = components.match(/function formatSkillLibraryDescription[\s\S]*?\n\}/)?.[0] ?? '';

    assert.match(skillPanel, /const description = formatSkillLibraryDescription\(skill\);/);
    assert.doesNotMatch(skillPanel, /maka-skill-library-description">\{skill\.description\}/);
    assert.match(formatter, /if \(!raw\) return undefined;/);
    assert.match(formatter, /if \(\/\[\\u3400-\\u9fff\]\/\.test\(raw\)\) return raw;/);
    assert.match(formatter, /创建、编辑、检查文档内容。/);
    assert.match(formatter, /创建、编辑、检查演示文稿。/);
    assert.match(formatter, /创建、编辑、分析表格数据。/);
    assert.match(formatter, /打开技能文件查看适用场景。/);
  });

  it('exposes the Skills module rows as a named list', async () => {
    const components = await readFile(resolve(process.cwd(), '..', '..', 'packages', 'ui', 'src', 'components.tsx'), 'utf8');
    const styles = await readFile(join(process.cwd(), 'src', 'renderer', 'styles.css'), 'utf8');
    const skillPanel = components.match(/function SkillLibraryPanel[\s\S]*?function formatSkillLibraryDescription/)?.[0] ?? '';
    const wrapperStyle = styles.match(/\.maka-skill-library\s*\{[\s\S]*?\n\}/)?.[0] ?? '';
    const listStyle = styles.match(/\.maka-skill-library-list\s*\{[\s\S]*?\n\}/)?.[0] ?? '';

    assert.match(skillPanel, /const templates = \(/);
    assert.doesNotMatch(skillPanel, /maka-skill-workbench-rail/);
    assert.doesNotMatch(skillPanel, /maka-skill-workbench-summary/);
    assert.match(skillPanel, /<div className="maka-skill-library" aria-busy=\{props\.actionBusy \? 'true' : undefined\}>/);
    assert.match(skillPanel, /<ul className="maka-skill-library-list" aria-label="技能列表">/);
    assert.match(skillPanel, /<li key=\{skill\.id\} className="maka-skill-library-item">[\s\S]*?<UiButton[\s\S]*?className="maka-skill-library-row"/);
    assert.match(skillPanel, /<span className="maka-skill-library-status" aria-hidden="true">/);
    assert.match(skillPanel, /<span className="maka-skill-library-action" aria-hidden="true">[\s\S]*打开[\s\S]*<\/span>/);
    assert.match(skillPanel, /<UiButton[\s\S]*variant="ghost"[\s\S]*disabled=\{props\.actionBusy\}[\s\S]*title=\{hoverText\}/);
    assert.doesNotMatch(skillPanel, /<button[\s\S]*?className="maka-skill-library-row"/);
    assert.match(wrapperStyle, /overflow:\s*auto/);
    assert.doesNotMatch(wrapperStyle, /grid-template-columns/);
    assert.match(listStyle, /list-style:\s*none/);
    assert.match(listStyle, /margin:\s*0/);
    assert.match(listStyle, /padding:\s*0/);
    assert.match(listStyle, /border:\s*1px solid var\(--foreground-8\)/);
  });

  it('does not leak absolute skill paths through row hover or accessibility help', async () => {
    const components = await readFile(resolve(process.cwd(), '..', '..', 'packages', 'ui', 'src', 'components.tsx'), 'utf8');
    const skillPanel = components.match(/function SkillLibraryPanel[\s\S]*?function formatSkillLibraryDescription/)?.[0] ?? '';

    assert.doesNotMatch(
      skillPanel,
      /const hoverText[\s\S]{0,240}skill\.path/,
      'Skill row title becomes Accessibility Help, so it must not expose absolute local paths',
    );
    assert.match(skillPanel, /打开技能文件：\$\{skill\.id\}/);
    assert.match(skillPanel, /title=\{hoverText\}/);
  });

  it('surfaces permission denial in Chinese instead of raw English backend text', async () => {
    const components = await readFile(resolve(process.cwd(), '..', '..', 'packages', 'ui', 'src', 'components.tsx'), 'utf8');
    const toolRuntime = await readFile(resolve(process.cwd(), '..', '..', 'packages', 'runtime', 'src', 'tool-runtime.ts'), 'utf8');
    const piAgent = await readFile(resolve(process.cwd(), '..', '..', 'packages', 'runtime', 'src', 'pi-agent-backend.ts'), 'utf8');

    assert.match(components, /formatUserVisibleToolText\(text: string\)[\s\S]*User denied permission[\s\S]*用户已拒绝权限请求/);
    assert.match(components, /function isPermissionDeniedToolResult\(result: ToolActivityItem\['result'\]\): boolean/);
    assert.match(components, /item\.intent && !permissionDenied/);
    assert.match(components, /item\.args !== undefined && !permissionDenied/);
    assert.match(components, /item\.result && !permissionDenied/);
    assert.match(components, /formatUserVisibleToolText\(redactSecrets\(extractErrorText\(props\.result\)\)\)/);
    assert.match(components, /capLines\(formatUserVisibleToolText\(redactSecrets\(content\.text\)\)\)/);
    assert.match(toolRuntime, /const reason = '用户已拒绝权限请求';/);
    assert.match(piAgent, /text: '用户已拒绝权限请求'/);
    assert.doesNotMatch(`${toolRuntime}\n${piAgent}`, /User denied permission/);
  });
});

function extractCssRule(css: string, selector: string): string | undefined {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\\\n/g, '\\s*\\n');
  return css.match(new RegExp(`${escaped}\\s*\\{([\\s\\S]*?)\\}`))?.[1];
}
