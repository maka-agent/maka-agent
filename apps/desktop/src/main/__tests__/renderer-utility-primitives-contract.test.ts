import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { readRendererContractCss } from './contract-css-helpers.js';

const repoRoot = join(process.cwd(), '..', '..');

describe('renderer utility surfaces use shared UI primitives', () => {
  it('keeps browser chrome on Button/Input instead of raw form controls', async () => {
    const source = await readFile(join(process.cwd(), 'src/renderer/browser-panel.tsx'), 'utf8');

    assert.match(source, /import \{ normalizeBrowserAddressInput, type BrowserState \} from '@maka\/core';/);
    assert.match(source, /import \{[^}]*\bButton\b[^}]*\bInput\b[^}]*\buseToast\b[^}]*\} from '@maka\/ui';/);
    assert.doesNotMatch(source, /<button\b/, 'BrowserPanel nav controls must use shared Button');
    assert.doesNotMatch(source, /<input\b/, 'BrowserPanel address bar must use shared Input');
    assert.doesNotMatch(source, /const full = \/\^\[a-z\]\+/, 'BrowserPanel must not keep renderer-only address prefix regex');
    assert.match(
      source,
      /const result = normalizeBrowserAddressInput\(address\);[\s\S]*if \(!result\.ok\) \{[\s\S]*toast\.error\('无法打开地址', browserAddressFailureCopy\(result\.reason\)\);[\s\S]*return;[\s\S]*const ownerSessionId = sessionId;[\s\S]*window\.maka\.browser\.navigate\(ownerSessionId, result\.url\)/,
      'BrowserPanel must validate addresses with the shared helper before invoking browser navigation',
    );
    assert.match(source, /const browserPanelMountedRef = useMountedRef\(\)/);
    assert.match(source, /const browserPanelSessionIdRef = useRef\(sessionId\)/);
    assert.match(source, /browserPanelSessionIdRef\.current = sessionId/);
    assert.match(
      source,
      /const isBrowserPanelSessionCurrent = useCallback\(\(ownerSessionId: string\): boolean => \{[\s\S]*return browserPanelMountedRef\.current && browserPanelSessionIdRef\.current === ownerSessionId;[\s\S]*\}, \[\]\);/,
      'BrowserPanel async continuations must be owned by the active mounted session.',
    );
    assert.match(
      source,
      /window\.maka\.browser\.navigate\(ownerSessionId, result\.url\)\.catch\(\(\) => \{[\s\S]*if \(isBrowserPanelSessionCurrent\(ownerSessionId\)\) \{[\s\S]*toast\.error\('浏览器导航失败', '页面暂时无法打开，请稍后重试。'\);[\s\S]*\}/,
      'BrowserPanel must not toast a stale navigation failure after switching sessions or unmounting.',
    );
    assert.match(source, /嵌入式浏览器只支持打开 HTTP\/HTTPS 网页地址。/);
    assert.match(source, /这个地址无法识别，请检查网址后重试。/);
    for (const label of [
      '浏览器后退',
      '浏览器前进',
      '关闭浏览器页面',
    ]) {
      assert.match(
        source,
        new RegExp(`aria-label=\\{?["']${label}["']?\\}?`),
        `BrowserPanel icon-only toolbar action must expose accessible name: ${label}`,
      );
    }
    assert.match(
      source,
      /aria-label=\{state\.loading \? '停止加载页面' : '刷新页面'\}/,
      'BrowserPanel reload/stop icon-only action must expose a state-specific accessible name',
    );
    assert.match(
      source,
      /disabled=\{!state\.hasPage && !state\.loading\}[\s\S]*state\.loading \? void window\.maka\.browser\.stop\(sessionId\) : void window\.maka\.browser\.reload\(sessionId\)/,
      'BrowserPanel reload action must not stay clickable in the empty no-page state',
    );
    assert.match(
      source,
      /useEffect\(\(\) => \{[\s\S]*editingRef\.current = false;[\s\S]*setState\(EMPTY_STATE\);[\s\S]*setAddress\(''\);[\s\S]*window\.maka\.browser[\s\S]*\.getState\(sessionId\)[\s\S]*\.catch\(\(\) => apply\(EMPTY_STATE\)\);[\s\S]*\}, \[sessionId\]\)/,
      'BrowserPanel must clear stale browser chrome synchronously when switching sessions and fail-soft on state-read errors',
    );
  });

  it('keeps unsupported artifact preview CTA on Button without legacy classes', async () => {
    const source = await readFile(join(process.cwd(), 'src/renderer/artifact-preview-registry-shell.tsx'), 'utf8');

    assert.match(source, /import \{ Button, Spinner \} from '@maka\/ui';/);
    assert.doesNotMatch(source, /<button\b/, 'unsupported artifact preview CTA must use shared Button');
    assert.doesNotMatch(source, /className="maka-button/, 'artifact preview CTA must not keep legacy maka-button styling');
    assert.match(source, /<Button[\s\S]*variant="secondary"[\s\S]*className="maka-artifact-preview-unsupported-cta"/);
  });

  it('keeps artifact preview loading indicators on shared primitive Spinner', async () => {
    const legacySource = await readFile(join(process.cwd(), 'src/renderer/artifact-preview.tsx'), 'utf8');
    const registrySource = await readFile(join(process.cwd(), 'src/renderer/artifact-preview-registry-shell.tsx'), 'utf8');
    const styles = await readRendererContractCss();

    for (const [label, source] of [
      ['legacy preview', legacySource],
      ['registry preview', registrySource],
    ] as const) {
      assert.match(source, /import \{[^}]*\bSpinner\b[^}]*\} from '@maka\/ui';/, `${label} must import shared primitive Spinner`);
      assert.match(
        source,
        /<Spinner className="maka-artifact-preview-spinner" aria-hidden="true" role="presentation" \/>/,
        `${label} loading indicator must render shared primitive Spinner as a decorative glyph inside the Chinese status row`,
      );
      assert.doesNotMatch(
        source,
        /<span className="maka-artifact-preview-spinner"/,
        `${label} must not restore the hand-rolled spinner span`,
      );
    }
    assert.doesNotMatch(styles, /@keyframes maka-artifact-spinner/, 'artifact loading must not keep a custom spinner animation');
    assert.doesNotMatch(styles, /border-top-color:\s*var\(--accent\)/, 'artifact loading spinner styling must not hand-draw a border spinner');
  });

  it('keeps artifact pane controls on shared Button primitives', async () => {
    const source = await readFile(join(process.cwd(), 'src/renderer/artifact-pane.tsx'), 'utf8');

    assert.match(source, /import \{[^}]*\bButton\b[^}]*\bToolbar\b[^}]*\bToolbarGroup\b[^}]*\bToolbarSeparator\b[^}]*\buseToast\b[^}]*\} from '@maka\/ui';/);
    assert.doesNotMatch(source, /<button\b/, 'ArtifactPane controls must use shared Button');
    assert.doesNotMatch(source, /role="toolbar"/, 'ArtifactPane toolbar semantics must come from shared primitive Toolbar');
    assert.match(source, /<Toolbar className="maka-artifact-toolbar" aria-label="生成文件操作">/);
    assert.match(source, /<ToolbarSeparator className="maka-artifact-toolbar-separator" orientation="vertical" \/>/);
    for (const className of [
      'maka-artifact-pane-collapse',
      'maka-artifact-error-retry',
      'maka-artifact-row',
    ]) {
      assert.match(source, new RegExp(`<Button[\\s\\S]*className="${className}`));
    }
  });

  it('keeps command palette search and rows on shared primitives', async () => {
    const source = await readFile(join(process.cwd(), 'src/renderer/command-palette.tsx'), 'utf8');

    assert.match(source, /import \{[^}]*\bDialogContent\b[^}]*\bDialogRoot\b[^}]*\bInputGroup\b[^}]*\bInputGroupInput\b[^}]*\bKbd\b[^}]*\bKbdGroup\b[^}]*\} from '@maka\/ui';/);
    assert.match(source, /import \{ Autocomplete \} from '@base-ui\/react\/autocomplete'/, 'CommandPalette must consume Base UI Autocomplete for the result list (#520 PR8)');
    assert.doesNotMatch(source, /<input\b/, 'Command palette search must use shared Input');
    assert.doesNotMatch(source, /<button\b/, 'Command palette rows must use shared Button');
    assert.doesNotMatch(source, /<kbd\b/, 'Command palette shortcut glyphs must use shared primitive Kbd');
    assert.match(source, /<InputGroup[\s\S]*className="maka-palette-input-wrap"[\s\S]*aria-label="命令面板搜索"[\s\S]*onMouseDown=\{\(event\) => \{/);
    assert.match(source, /<InputGroupInput[\s\S]*className="maka-palette-input"/);
    // Detail round 6: shortcut hints live in the palette footer only; the
    // former inline-end addon duplicated ↵/Esc next to the input.
    assert.doesNotMatch(source, /<InputGroupAddon\b/, 'Palette input must not regrow the duplicated shortcut-hint addon');
    assert.match(source, /<Autocomplete.Item[\s\S]*className="maka-palette-item"/, 'Command palette rows must be Autocomplete.Item (#520 PR8)');
    assert.match(source, /<KbdGroup className="maka-shortcut-group">[\s\S]*<Kbd className="maka-shortcut-kbd">↑<\/Kbd>[\s\S]*<Kbd className="maka-shortcut-kbd">↓<\/Kbd>/);
  });

  it('keeps keyboard help on the shared DialogHeader with a single title', async () => {
    const source = await readFile(join(process.cwd(), 'src/renderer/keyboard-help.tsx'), 'utf8');

    // Modal-header unification: keyboard-help consumes the shared DialogHeader
    // primitive (single title row + quiet icon-sm close), not an ad-hoc
    // eyebrow + second-title + boxed close stack.
    assert.match(source, /import \{ DialogContent, DialogHeader, DialogRoot, Kbd \} from '@maka\/ui';/);
    assert.doesNotMatch(source, /<button\b/, 'KeyboardHelpModal close action must use shared Button');
    assert.doesNotMatch(source, /<kbd\b/, 'KeyboardHelpModal shortcut glyphs must use shared primitive Kbd');
    assert.match(
      source,
      /<DialogHeader[\s\S]*title="键盘快捷键"[\s\S]*titleId="maka-help-title"[\s\S]*onClose=\{props\.onClose\}/,
      'KeyboardHelpModal must render the shared DialogHeader with 键盘快捷键 as THE title',
    );
    // The redundant second title and eyebrow are gone.
    assert.doesNotMatch(source, /所有可用快捷键/, 'The redundant second title must be dropped');
    assert.doesNotMatch(source, /maka-help-eyebrow/, 'The eyebrow row must be dropped');
    assert.doesNotMatch(source, /settingsCloseButton/, 'The boxed close-button class must be gone');
    assert.match(source, /<Kbd className="maka-shortcut-kbd">\{key\}<\/Kbd>/);
  });

  it('unifies titled DialogContent modals onto the shared DialogHeader primitive', async () => {
    // Modal-header unification contract: every titled DialogContent modal
    // consumes the shared DialogHeader (single title row + one quiet icon-sm
    // close button) instead of an ad-hoc header. The command palette is
    // intentionally headerless (its input row IS the header) and is excluded.
    const header = await readFile(join(repoRoot, 'packages/ui/src/primitives/dialog-header.tsx'), 'utf8');
    // The shared close button is the SAME form everywhere: quiet icon-sm
    // Button + X, aria-label defaults to 关闭, no border box.
    assert.match(header, /variant="quiet"/, 'DialogHeader close must be the quiet Button variant');
    assert.match(header, /size="icon-sm"/, 'DialogHeader close must be icon-sm');
    assert.match(header, /closeLabel = '关闭'/, 'DialogHeader close aria-label defaults to 关闭');
    assert.match(header, /<X aria-hidden="true" \/>/, 'DialogHeader close renders the X icon');
    assert.match(header, /export function DialogHeader/, 'DialogHeader must be exported');

    // Both titled modals import + render the shared DialogHeader.
    const keyboardHelp = await readFile(join(process.cwd(), 'src/renderer/keyboard-help.tsx'), 'utf8');
    assert.match(keyboardHelp, /import \{[^}]*\bDialogHeader\b[^}]*\} from '@maka\/ui';/);
    assert.match(keyboardHelp, /<DialogHeader\b/);

    const searchModal = await readFile(join(repoRoot, 'packages/ui/src/search-modal.tsx'), 'utf8');
    assert.match(searchModal, /import \{ DialogHeader \} from '\.\/primitives\/dialog-header\.js';/);
    assert.match(searchModal, /<DialogHeader[\s\S]*title="搜索"[\s\S]*titleId="maka-search-modal-title"/);
    // The old ad-hoc header language is gone.
    assert.doesNotMatch(searchModal, /maka-search-modal-header/, 'Search modal must drop the ad-hoc header class');
    assert.doesNotMatch(searchModal, /maka-search-modal-close/, 'Search modal must drop the ad-hoc close class');
  });

  it('keeps toast actions and confirm dialog buttons on shared Button without legacy classes', async () => {
    const source = await readFile(join(repoRoot, 'packages/ui/src/toast.tsx'), 'utf8');

    assert.match(source, /import \{[^}]*\bButton\b[^}]*\} from '.\/ui\.js';/);
    assert.doesNotMatch(source, /<button\b/, 'ToastProvider controls must use shared Button');
    assert.doesNotMatch(source, /className="maka-button/, 'Confirm dialog actions must not keep legacy maka-button styling');
    assert.match(source, /<Button[\s\S]*className="maka-toast-action"/);
    assert.match(source, /<Button[\s\S]*className="maka-toast-close"/);
    assert.match(source, /<Button[\s\S]*variant=\{destructive \? 'destructive' : 'default'\}/);
  });

  it('keeps shared primitive default labels Chinese-first', async () => {
    const spinner = await readFile(join(repoRoot, 'packages/ui/src/primitives/spinner.tsx'), 'utf8');

    assert.doesNotMatch(spinner, /aria-label="Loading"/);
    assert.match(spinner, /aria-label="加载中"/);
  });

  it('keeps multiline prompt suggestions on their semantic Base UI row seam', async () => {
    const source = await readFile(join(repoRoot, 'packages/ui/src/chat-empty-hero.tsx'), 'utf8');

    assert.match(source, /import \{ Button as BaseButton \} from '@base-ui\/react\/button';/);
    assert.match(source, /<BaseButton[\s\S]*className="maka-prompt-chip"/);
    assert.doesNotMatch(source, /<UiButton[\s\S]*className="maka-prompt-chip/);
    assert.doesNotMatch(source, /maka-prompt-chip h-auto/);
  });

  it('expresses clear-input-history semantics through the destructive Button variant', async () => {
    const source = await readFile(join(process.cwd(), 'src/renderer/settings/data-settings-page.tsx'), 'utf8');

    assert.match(
      source,
      /<Button\s+type="button"\s+variant="destructive"\s+onClick=\{\(\) => void clearInputHistory\(\)\}/,
    );
    assert.doesNotMatch(source, /className="[^"]*destructive[^"]*"/);
  });

  it('keeps shared Button geometry and interaction states out of consumer CSS', async () => {
    const consumerPaths = [
      'packages/ui/src/composer.tsx',
      'packages/ui/src/empty-state.tsx',
      'packages/ui/src/plan-reminder-panel.tsx',
      'packages/ui/src/skills-panel.tsx',
      'packages/ui/src/tool-activity.tsx',
      'apps/desktop/src/renderer/artifact-pane.tsx',
      'apps/desktop/src/renderer/settings/ProvidersPanel.tsx',
      'apps/desktop/src/renderer/settings/bot-wechat-login.tsx',
    ];
    const consumers = await Promise.all(
      consumerPaths.map((path) => readFile(join(repoRoot, path), 'utf8')),
    );
    const tokens = await readFile(join(process.cwd(), 'src/renderer/maka-tokens.css'), 'utf8');
    const skillsCss = await readFile(join(process.cwd(), 'src/renderer/styles/module-pages/skills.css'), 'utf8');
    const rendererCss = await readRendererContractCss();

    for (const [index, source] of consumers.entries()) {
      assert.doesNotMatch(source, /className=(?:"[^"]*\bmaka-button\b|\{cn\('maka-button')/, `${consumerPaths[index]} must not restore the legacy Button layer`);
    }
    assert.doesNotMatch(tokens, /\.maka-button(?:\s|:|\[|\{)/, 'renderer tokens must not keep a parallel Button implementation');

    assert.doesNotMatch(skillsCss, /\.maka-skill-filter-pill\b/);
    assert.doesNotMatch(skillsCss, /\.maka-skill-market-install-button\b/);
    assert.doesNotMatch(skillsCss, /\.maka-skill-library-item:(?:hover|focus-within) \.maka-skill-library-open-button/);
    assert.match(skillsCss, /\.maka-skill-library-open-button\s*\{\s*justify-self:\s*end;\s*\}/);

    const skills = consumers[3];
    assert.match(skills, /variant="secondary"\s+size="icon-sm"\s+onClick=\{\(\) => props\.onInstallManagedSkill/);
    assert.match(skills, /variant="secondary"\s+size="icon-sm"\s+className="maka-skill-library-open-button"/);
    assert.doesNotMatch(skills, /className="maka-skill-filter-pill"/);
    assert.doesNotMatch(skills, /className="maka-skill-market-install-button"/);

    const artifactPane = consumers[5];
    assert.doesNotMatch(artifactPane, /className="[^"]*maka-artifact-toolbar-button/);
    assert.match(artifactPane, /variant="destructive" size="icon-sm"/);
    assert.doesNotMatch(rendererCss, /\.maka-artifact-toolbar-button\b/);

    const providers = consumers[6];
    assert.match(providers, /import \{ Button as BaseButton \} from '@base-ui\/react\/button';/);
    assert.match(providers, /<BaseButton className="enabledEmptyChip enabledEmptyAction"/);
    assert.doesNotMatch(providers, /<Button className="enabledEmptyChip enabledEmptyAction"/);

    const wechat = consumers[7];
    assert.doesNotMatch(wechat, /className="settingsWechatQrSecondary"/);
    assert.equal(wechat.match(/<Button type="button" variant="secondary" size="sm" disabled=\{loading\} onClick=\{reloadQrCode\}>/g)?.length, 3);
    assert.doesNotMatch(rendererCss, /\.settingsWechatQrSecondary\b/);
  });
});
