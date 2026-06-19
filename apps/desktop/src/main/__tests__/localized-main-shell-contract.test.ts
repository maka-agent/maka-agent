import { strict as assert } from 'node:assert';
import { readFile } from 'node:fs/promises';
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
    const zhComposerBlock = components.match(/zh: \{\n\s*placeholder: '描述任务，\/ 快捷调用，@ 添加上下文…'[\s\S]*?\n\s*\},\n\s*en:/)?.[0] ?? '';

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

    assert.match(components, /import \{ Kbd, KbdGroup \} from '\.\/coss\/kbd\.js';/);
    assert.doesNotMatch(components, /maka-composer-shortcut-hint/);
    assert.doesNotMatch(components, /enterHint/);
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
    assert.match(
      components,
      /aria-keyshortcuts="Meta\+K"[\s\S]*<KbdGroup className="maka-shortcut-group" aria-hidden="true">[\s\S]*<Kbd className="maka-shortcut-kbd">⌘<\/Kbd>[\s\S]*<Kbd className="maka-shortcut-kbd">K<\/Kbd>/,
      'hero command hint must keep semantic aria-keyshortcuts while rendering visual keys through COSS Kbd',
    );
    assert.match(
      components,
      /copy\.streamingHintPrefix\} <Kbd className="maka-shortcut-kbd">Esc<\/Kbd> \{copy\.streamingHintInterrupt/,
      'streaming interruption hint should keep Esc visible through COSS Kbd',
    );
    assert.doesNotMatch(
      components,
      /<kbd\b/,
      'components.tsx should not reintroduce hand-rolled shortcut glyphs now that COSS Kbd is available',
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

    for (const icon of ['MessageSquare', 'Search', 'Clock', 'Sparkles', 'CalendarDays', 'DownloadCloud', 'Settings']) {
      assert.match(
        components,
        new RegExp(`<${icon} className="maka-nav-icon" strokeWidth=\\{1\\.5\\} aria-hidden="true" />`),
        `${icon} sidebar icon is decorative; the adjacent label/aria-current provides the accessible name`,
      );
    }
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

  it('exposes the active main sidebar section to assistive technology', async () => {
    const components = await readFile(resolve(process.cwd(), '..', '..', 'packages', 'ui', 'src', 'components.tsx'), 'utf8');

    assert.match(
      components,
      /data-active=\{isModuleActive\('sessions'\)\}[\s\S]{0,160}aria-current=\{isModuleActive\('sessions'\) \? 'page' : undefined\}/,
      'the active Sessions nav row must expose aria-current, not only data-active styling',
    );
    assert.match(
      components,
      /data-active=\{isModuleActive\('automations'\)\}[\s\S]{0,160}aria-current=\{isModuleActive\('automations'\) \? 'page' : undefined\}/,
      'the active Plans nav row must expose aria-current, not only data-active styling',
    );
    assert.match(
      components,
      /data-active=\{isModuleActive\('skills'\)\}[\s\S]{0,160}aria-current=\{isModuleActive\('skills'\) \? 'page' : undefined\}/,
      'the active Skills nav row must expose aria-current, not only data-active styling',
    );
    assert.match(
      components,
      /data-active=\{isModuleActive\('daily-review'\)\}[\s\S]{0,160}aria-current=\{isModuleActive\('daily-review'\) \? 'page' : undefined\}/,
      'the active Daily Review nav row must expose aria-current, not only data-active styling',
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
    const appShell = main.match(/const hasModalOpen[\s\S]*?<div\s+className="app maka-shell-2col"[\s\S]*?style=\{\{/)?.[0] ?? '';
    const titlebarControlsEffect = main.match(/const hasModalOpen[\s\S]*?useEffect\(\(\) => \{[\s\S]*?\}, \[hasModalOpen\]\);/)?.[0] ?? '';
    const modalMounts = main.match(/<\/div>\s*\{activePermission && \([\s\S]*?\{settingsOpen && \(/)?.[0] ?? '';

    assert.match(
      appShell,
      /const hasModalOpen = Boolean\(activePermission\) \|\| settingsOpen \|\| helpOpen \|\| paletteOpen \|\| searchModalOpen;/,
      'all top-level modal states must contribute to the accessibility background-hide flag',
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
      /const MAIN_WINDOW_TRAFFIC_LIGHT_POSITION = \{ x: 24, y: 24 \} as const;[\s\S]*?const HIDDEN_TRAFFIC_LIGHT_POSITION = \{ x: -100, y: -100 \} as const;/,
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

  it('focuses the active Settings nav item when the modal opens', async () => {
    const settings = await readFile(join(process.cwd(), 'src', 'renderer', 'settings', 'SettingsModal.tsx'), 'utf8');
    const modalBlock = settings.match(/function SettingsModal[\s\S]*?function SettingsSurface/)?.[0] ?? '';
    const navButtonBlock = settings.match(/items\.map\(\(item\) => \([\s\S]*?<\/Button>\s*\)\)/)?.[0] ?? '';

    assert.match(
      modalBlock,
      /const activeNavRef = useRef<HTMLButtonElement>\(null\);/,
      'Settings modal must nominate the active nav item as the initial focus target',
    );
    assert.match(
      modalBlock,
      /useModalA11y\(dialogRef,\s*props\.onClose,\s*activeNavRef\)/,
      'Settings modal focus should not fall back to the first enabled button when a later section is active',
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

  it('keeps the QoderWork-like app shell as one canvas with a collapsible icon sidebar', async () => {
    const components = await readFile(resolve(process.cwd(), '..', '..', 'packages', 'ui', 'src', 'components.tsx'), 'utf8');
    const main = await readFile(join(process.cwd(), 'src', 'renderer', 'main.tsx'), 'utf8');
    const styles = await readFile(join(process.cwd(), 'src', 'renderer', 'styles.css'), 'utf8');

    assert.match(components, /sidebarCollapsed\?: boolean;/);
    assert.match(components, /onToggleSidebar\?\(\): void;/);
    assert.match(components, /data-collapsed=\{props\.sidebarCollapsed \? 'true' : undefined\}/);
    assert.match(components, /className="maka-sidebar-search-button"[\s\S]*aria-label="搜索对话"[\s\S]*<Search size=\{16\}/);
    assert.match(components, /className="maka-sidebar-toggle"[\s\S]*aria-label=\{props\.sidebarCollapsed \? '展开侧边栏' : '收起侧边栏'\}[\s\S]*aria-expanded=\{!props\.sidebarCollapsed\}/);
    assert.match(components, /aria-label=\{MODULE_NAV_LABEL\.sessions\}/);
    assert.match(components, /aria-label=\{MODULE_NAV_LABEL\.search\}/);
    assert.match(components, /aria-label=\{MODULE_NAV_LABEL\.skills\}/);

    assert.match(main, /const \[sessionListCollapsed, setSessionListCollapsed\] = useState\(\(\) => readSessionListCollapsed\(\)\);/);
    assert.match(main, /localStorage\.setItem\('maka-chat-list-collapsed-v1', sessionListCollapsed \? 'true' : 'false'\)/);
    assert.match(main, /data-sidebar-state=\{sessionListCollapsed \? 'collapsed' : 'expanded'\}/);
    assert.match(main, /const SESSION_LIST_COLLAPSED_WIDTH = 60;/);
    assert.match(main, /'--maka-session-list-width': `\$\{sessionListCollapsed \? SESSION_LIST_COLLAPSED_WIDTH : sessionListWidth\}px`/);
    assert.match(main, /'--maka-resize-handle-width': sessionListCollapsed \? '0px' : '8px'/);
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
    assert.match(listPanel, /border-right:\s*1px solid var\(--border\)/);
    assert.match(listPanel, /background:\s*oklch\(from var\(--background\) calc\(l - 0\.015\) c h\)/);
    const sidebarTopBar = extractCssRule(styles, '.maka-sidebar-drag-strip');
    assert.ok(sidebarTopBar, '.maka-sidebar-drag-strip rule must exist');
    assert.match(sidebarTopBar, /justify-content:\s*space-between/);
    assert.match(styles, /\.maka-sidebar-search-button,\n\.maka-sidebar-toggle \{/);
    const collapsedNav = extractCssRule(styles, '.maka-session-panel[data-collapsed="true"] .maka-nav-primary,\n.maka-session-panel[data-collapsed="true"] .maka-nav-row');
    assert.ok(collapsedNav, 'collapsed nav sizing rule must exist');
    assert.match(collapsedNav, /width:\s*34px/);
    assert.match(collapsedNav, /grid-template-columns:\s*1fr/);
    assert.match(styles, /\.maka-session-panel\[data-collapsed="true"\] \.maka-session-list-title,\n\.maka-session-panel\[data-collapsed="true"\] \.maka-list-stack,\n\.maka-session-panel\[data-collapsed="true"\] \.maka-sidebar-module-hint,\n\.maka-session-panel\[data-collapsed="true"\] \.maka-empty-state \{[\s\S]*?display:\s*none/);
    assert.match(styles, /\.maka-session-panel\[data-collapsed="true"\] \.maka-nav-row\[data-active="true"\] \.maka-nav-icon \{[\s\S]*?color:\s*white/);
    assert.match(styles, /--w-sessionlist:\s*210px;/);
  });

  it('keeps the chat composer as the only main card with a narrow QoderWork-like frame', async () => {
    const components = await readFile(resolve(process.cwd(), '..', '..', 'packages', 'ui', 'src', 'components.tsx'), 'utf8');
    const styles = await readFile(join(process.cwd(), 'src', 'renderer', 'styles.css'), 'utf8');
    const emptyHero = components.match(/function EmptyChatHero[\s\S]*?function DeepResearchEmptyHero/)?.[0] ?? '';
    const composerCard = extractCssRule(styles, '.composer .maka-composer-inner');
    const composerFocus = extractCssRule(styles, '.composer .maka-composer-inner:focus-within');
    const composerShell = extractCssRule(styles, '.composer');
    const workspaceRow = extractCssRule(styles, '.maka-composer-workspace-row');
    const workspacePicker = extractCssRule(styles, '.maka-composer-workspace-picker');

    assert.ok(emptyHero, 'EmptyChatHero source must be discoverable');
    assert.doesNotMatch(emptyHero, /maka-prompt-suggestions/);
    assert.doesNotMatch(emptyHero, /maka-prompt-chip/);
    assert.doesNotMatch(emptyHero, /getPromptSuggestions\(locale\)/);
    assert.ok(composerShell, '.composer rule must exist');
    assert.match(composerShell, /display:\s*flex/);
    assert.match(composerShell, /align-items:\s*center/);
    assert.ok(composerCard, '.composer .maka-composer-inner rule must exist');
    assert.match(composerCard, /width:\s*min\(640px,\s*100%\)/);
    assert.match(composerCard, /max-width:\s*640px/);
    assert.match(composerCard, /margin-inline:\s*auto/);
    assert.match(composerCard, /box-sizing:\s*border-box/);
    assert.match(composerCard, /border-radius:\s*14px/);
    assert.match(composerCard, /padding:\s*16px/);
    assert.match(composerCard, /0 0 0 1px oklch\(from var\(--foreground\) l c h \/ 0\.065\)/);
    assert.doesNotMatch(composerCard, /0 2px 8px/);
    assert.doesNotMatch(composerCard, /var\(--shadow-medium\)/);
    assert.ok(composerFocus, '.composer .maka-composer-inner:focus-within rule must exist');
    assert.doesNotMatch(composerFocus, /0 2px 8px/);
    assert.doesNotMatch(composerFocus, /var\(--shadow-medium\)/);
    assert.match(components, /import \{[\s\S]*ArrowUp,[\s\S]*\} from 'lucide-react';/);
    assert.match(components, /className="maka-composer-send-button"[\s\S]*size="icon-sm"[\s\S]*aria-label=\{buttonCopy\.sendLabel\}[\s\S]*<ArrowUp size=\{16\} strokeWidth=\{2\.1\} aria-hidden="true" \/>/);
    const sendButton = extractCssRule(styles, '.maka-composer-send-button');
    assert.ok(sendButton, '.maka-composer-send-button rule must exist');
    assert.match(sendButton, /width:\s*32px/);
    assert.match(sendButton, /height:\s*32px/);
    assert.match(sendButton, /border-radius:\s*999px/);
    assert.match(sendButton, /background:\s*var\(--foreground\)/);
    assert.match(sendButton, /color:\s*var\(--background\)/);
    assert.match(components, /workspacePicker\?: \{[\s\S]*label\?: string;[\s\S]*branch\?: string \| null;[\s\S]*onOpen\(\): void;[\s\S]*\};/);
    assert.match(components, /className="maka-composer-workspace-picker"[\s\S]*<FolderOpen size=\{13\}[\s\S]*<span>选择工作目录<\/span>[\s\S]*<ChevronDown size=\{12\}/);
    assert.ok(workspaceRow, '.maka-composer-workspace-row rule must exist');
    assert.match(workspaceRow, /width:\s*min\(640px,\s*100%\)/);
    assert.match(workspaceRow, /padding-inline:\s*16px/);
    assert.ok(workspacePicker, '.maka-composer-workspace-picker rule must exist');
    assert.match(workspacePicker, /font-size:\s*12px/);
    assert.match(workspacePicker, /background:\s*transparent/);
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
    const listStyle = styles.match(/\.maka-skill-library-list\s*\{[\s\S]*?\n\}/)?.[0] ?? '';

    assert.match(skillPanel, /<ul className="maka-skill-library-list" aria-label="技能列表" aria-busy=\{props\.actionBusy \? 'true' : undefined\}>/);
    assert.match(skillPanel, /<li key=\{skill\.id\} className="maka-skill-library-item">[\s\S]*?<UiButton[\s\S]*?className="maka-skill-library-row"/);
    assert.match(skillPanel, /<UiButton[\s\S]*variant="ghost"[\s\S]*disabled=\{props\.actionBusy\}[\s\S]*title=\{hoverText\}/);
    assert.doesNotMatch(skillPanel, /<button[\s\S]*?className="maka-skill-library-row"/);
    assert.match(listStyle, /list-style:\s*none/);
    assert.match(listStyle, /margin:\s*0/);
    assert.match(listStyle, /padding:\s*0/);
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
