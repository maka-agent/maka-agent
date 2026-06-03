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
    const zhComposerBlock = components.match(/zh: \{\n\s*placeholder: '给 Maka 发消息…'[\s\S]*?\n\s*\},\n\s*en:/)?.[0] ?? '';

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

  it('keeps the idle Composer shortcut hint visual-only in the accessibility tree', async () => {
    const components = await readFile(resolve(process.cwd(), '..', '..', 'packages', 'ui', 'src', 'components.tsx'), 'utf8');

    assert.match(
      components,
      /className="maka-composer-shortcut-hint" aria-hidden="true"/,
      'the idle Enter / Shift+Enter visual shortcut hint should not be announced as scattered text nodes',
    );
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
      /<button className="maka-chat-tab-plus"[\s\S]*?<Plus strokeWidth=\{1\.5\} aria-hidden="true" \/>/,
      'New-chat plus buttons already have aria-label and must not expose a redundant icon',
    );
    assert.match(
      components,
      /<button className="maka-button maka-plan-submit"[\s\S]*?<Check size=\{14\} strokeWidth=\{1\.75\} aria-hidden="true" \/>[\s\S]*?<Plus size=\{14\} strokeWidth=\{1\.75\} aria-hidden="true" \/>/,
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
    const dailyReviewRange = components.match(/<nav className="maka-daily-review-range"[\s\S]*?\{summary && summary\.totals/)?.[0] ?? '';

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

  it('keeps the project badge accessibility help concise instead of exposing the absolute workspace path', async () => {
    const components = await readFile(resolve(process.cwd(), '..', '..', 'packages', 'ui', 'src', 'components.tsx'), 'utf8');
    const projectBadge = components.match(/className="maka-project-badge"[\s\S]*?aria-label=\{props\.projectBadge\.branch[\s\S]*?>/)?.[0] ?? '';

    assert.match(
      projectBadge,
      /title=\{props\.projectBadge\.branch \? `打开项目目录 · \$\{props\.projectBadge\.branch\}` : '打开项目目录'\}/,
      'project badge title should stay concise because native title is exposed as Accessibility Help',
    );
    assert.doesNotMatch(
      projectBadge,
      /title=\{props\.projectBadge\.branch \? `\$\{props\.projectBadge\.path\}/,
      'project badge must not expose absolute workspace paths through native title / AX Help',
    );
  });

  it('hides the app shell from the accessibility tree while a top-level modal is open', async () => {
    const main = await readFile(join(process.cwd(), 'src', 'renderer', 'main.tsx'), 'utf8');
    const appShell = main.match(/const hasModalOpen[\s\S]*?<div\s+className="app maka-shell-2col"[\s\S]*?style=\{\{/)?.[0] ?? '';
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
      modalMounts,
      /\{activePermission && \([\s\S]*?<PermissionDialog[\s\S]*?\)\}\s*\{settingsOpen && \(/,
      'top-level modals must remain siblings after the hidden/inert app shell, not descendants of it',
    );
  });

  it('focuses the active Settings nav item when the modal opens', async () => {
    const settings = await readFile(join(process.cwd(), 'src', 'renderer', 'settings', 'SettingsModal.tsx'), 'utf8');
    const modalBlock = settings.match(/function SettingsModal[\s\S]*?function SettingsSurface/)?.[0] ?? '';
    const navButtonBlock = settings.match(/items\.map\(\(item\) => \([\s\S]*?<\/button>\s*\)\)/)?.[0] ?? '';

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

  it('keeps the resizable session-list width as integer pixels for readable splitter values', async () => {
    const main = await readFile(join(process.cwd(), 'src', 'renderer', 'main.tsx'), 'utf8');
    const resizeBlock = main.slice(main.indexOf('function startColumnResize'), main.indexOf('function onResizeHandleKeyDown'));
    const persistBlock = main.slice(main.indexOf("useEffect(() => {\n    try {\n      localStorage.setItem('maka-chat-list-width-v1'"), main.indexOf('// Persist sidebar nav selection'));
    const keyBlock = main.slice(main.indexOf('function onResizeHandleKeyDown'), main.indexOf('const hasModalOpen'));
    const readBlock = main.slice(main.indexOf('function readSessionListWidth'), main.indexOf('function isNoRealConnectionError'));

    assert.match(main, /function clampSessionListWidth\(value: number\): number \{\s*return Math\.round\(clamp\(value, 240, 420\)\);\s*\}/m);
    assert.match(resizeBlock, /setSessionListWidth\(clampSessionListWidth\(start \+ delta\)\)/);
    assert.match(keyBlock, /setSessionListWidth\(clampSessionListWidth\(next\)\)/);
    assert.match(readBlock, /return clampSessionListWidth\(stored\);/);
    assert.match(main, /aria-valuenow=\{sessionListWidth\}/, 'splitter aria-valuenow should receive the normalized integer state');
    assert.match(persistBlock, /try \{[\s\S]*localStorage\.setItem\('maka-chat-list-width-v1', String\(sessionListWidth\)\);[\s\S]*\} catch \{/, 'width persistence must not crash when localStorage is unavailable');
    assert.match(readBlock, /try \{[\s\S]*localStorage\.getItem\('maka-chat-list-width-v1'\)[\s\S]*\} catch \{/, 'width restore must not crash when localStorage is unavailable');
    assert.match(resizeBlock, /setPointerCapture\(event\.pointerId\)/, 'dragging the splitter should capture pointer events while resizing');
    assert.match(resizeBlock, /window\.addEventListener\('blur', cleanupResize\)/, 'resize cleanup must run if the window loses focus mid-drag');
    assert.match(resizeBlock, /window\.removeEventListener\('blur', cleanupResize\)/, 'resize cleanup must remove the blur listener');
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
    const aiSdk = await readFile(resolve(process.cwd(), '..', '..', 'packages', 'runtime', 'src', 'ai-sdk-backend.ts'), 'utf8');
    const piAgent = await readFile(resolve(process.cwd(), '..', '..', 'packages', 'runtime', 'src', 'pi-agent-backend.ts'), 'utf8');

    assert.match(components, /formatUserVisibleToolText\(text: string\)[\s\S]*User denied permission[\s\S]*用户已拒绝权限请求/);
    assert.match(components, /function isPermissionDeniedToolResult\(result: ToolActivityItem\['result'\]\): boolean/);
    assert.match(components, /item\.intent && !permissionDenied/);
    assert.match(components, /item\.args !== undefined && !permissionDenied/);
    assert.match(components, /item\.result && !permissionDenied/);
    assert.match(components, /formatUserVisibleToolText\(redactSecrets\(extractErrorText\(props\.result\)\)\)/);
    assert.match(components, /capLines\(formatUserVisibleToolText\(redactSecrets\(content\.text\)\)\)/);
    assert.match(aiSdk, /const reason = '用户已拒绝权限请求';/);
    assert.match(piAgent, /text: '用户已拒绝权限请求'/);
    assert.doesNotMatch(`${aiSdk}\n${piAgent}`, /User denied permission/);
  });
});
