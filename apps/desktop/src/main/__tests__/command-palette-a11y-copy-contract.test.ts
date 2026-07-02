import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { readRendererContractCss } from './contract-css-helpers.js';
import { readRendererShellCombinedSource } from './renderer-shell-source-helpers.js';

const repoRoot = process.cwd().endsWith('apps/desktop')
  ? join(process.cwd(), '..', '..')
  : process.cwd();

async function readRepo(path: string): Promise<string> {
  return readFile(join(repoRoot, path), 'utf8');
}

describe('Command palette accessibility and visible copy', () => {
  it('names the command results listbox controlled by the search input', async () => {
    const src = await readRepo('apps/desktop/src/renderer/command-palette.tsx');
    assert.match(
      src,
      /aria-controls="maka-palette-list"/,
      'palette input must keep its aria-controls link to the results list',
    );
    assert.match(
      src,
      /<div className="maka-palette-list" id="maka-palette-list" role="listbox" aria-label="命令面板结果">/,
      'palette results listbox must expose a name in the accessibility tree',
    );
  });

  it('uses shared primitive InputGroup for the palette input shell without restoring the old flex wrapper', async () => {
    const src = await readRepo('apps/desktop/src/renderer/command-palette.tsx');
    const styles = await readRendererContractCss();
    const inputWrapStyle = styles.match(/\.maka-palette-input-wrap\s*\{[\s\S]*?\}/)?.[0] ?? '';

    assert.match(
      src,
      /import \{[^}]*\bButton\b[^}]*\bInputGroup\b[^}]*\bInputGroupAddon\b[^}]*\bInputGroupInput\b[^}]*\bKbd\b[^}]*\bKbdGroup\b[^}]*\buseModalA11y\b[^}]*\} from '@maka\/ui';/,
      'CommandPalette must consume shared primitive InputGroup primitives from @maka/ui',
    );
    assert.match(
      src,
      /<InputGroup className="maka-palette-input-wrap" aria-label="命令面板搜索">[\s\S]*<InputGroupInput[\s\S]*aria-label="搜索命令、设置项或会话"[\s\S]*<InputGroupAddon align="inline-end" className="maka-palette-input-hint-addon">/,
      'CommandPalette input shell must be shared primitive InputGroup with an accessible input label and trailing hint addon',
    );
    assert.doesNotMatch(
      src,
      /<div className="maka-palette-input-wrap"/,
      'CommandPalette must not regress to the previous hand-rolled input wrapper',
    );
    assert.doesNotMatch(
      inputWrapStyle,
      /display:\s*flex/,
      'Palette input wrapper styling must not restore the old flex shell over shared primitive InputGroup',
    );
    assert.match(
      inputWrapStyle,
      /margin:\s*8px 10px;/,
      'Palette InputGroup should preserve the compact command-modal inset spacing',
    );
    assert.match(
      styles,
      /@media \(max-width: 560px\) \{[\s\S]*\.maka-palette-input-hint-addon \{[\s\S]*display:\s*none;/,
      'Palette trailing key hint must collapse on narrow widths instead of squeezing the input',
    );
  });

  it('keeps command palette chrome compact, non-selectable, and tactile without blocking text entry', async () => {
    const styles = await readRendererContractCss();
    const modalStyle = styles.match(/\.maka-palette-modal\s*\{[\s\S]*?\}/)?.[0] ?? '';
    const inputStyle = styles.match(/\.maka-palette-input\s*\{[\s\S]*?\}/)?.[0] ?? '';
    const rowStyle = styles.match(/\.maka-palette-item\s*\{[\s\S]*?\}/)?.[0] ?? '';

    assert.match(modalStyle, /width:\s*min\(584px, calc\(100vw - 32px\)\);/);
    assert.match(modalStyle, /border:\s*1px solid var\(--border\);/);
    assert.match(modalStyle, /border-radius:\s*var\(--radius-modal\);/);
    assert.match(
      styles,
      /\.maka-palette-modal,[\s\S]*?\.maka-palette-footer\s*\{[\s\S]*user-select:\s*none;/,
      'Palette modal/list/rows/footer should behave as app chrome, not accidental selectable text',
    );
    assert.match(inputStyle, /user-select:\s*text;/, 'Palette input text must stay selectable/editable');
    assert.match(rowStyle, /min-height:\s*28px;/);
    assert.match(rowStyle, /grid-template-columns:\s*18px minmax\(0, 1fr\) auto;/);
    assert.match(rowStyle, /transform:\s*translateY\(0\);/);
    assert.match(rowStyle, /transform 140ms var\(--ease-out-strong\)/);
    assert.match(
      styles,
      /\.maka-palette-item:hover:not\(\[data-disabled="true"\]\)\s*\{[\s\S]*background:\s*var\(--foreground-5\);/,
      'Palette rows need a hover state independent of keyboard active state',
    );
    assert.match(
      styles,
      /\.maka-palette-item:active:not\(\[data-disabled="true"\]\)\s*\{[\s\S]*transform:\s*translateY\(1px\);/,
      'Palette rows need tactile pressed feedback',
    );
    assert.match(styles, /\.maka-palette-item:focus-visible\s*\{[\s\S]*outline:\s*2px solid var\(--ring\);/);
    assert.match(styles, /\.maka-palette-item\[data-pending="true"\]\s*\{[\s\S]*cursor:\s*progress;/);
    assert.match(styles, /\.maka-palette-item\[data-active="true"\]::before\s*\{[\s\S]*var\(--accent\)/);
    assert.match(styles, /\.maka-palette-icon\s*\{[\s\S]*width:\s*18px;[\s\S]*height:\s*18px;/);
    assert.match(styles, /\.maka-palette-hint\s*\{[\s\S]*font-variant-numeric:\s*tabular-nums;/);
  });

  it('has a visual-smoke opener for the command palette input shell', async () => {
    const main = await readRendererShellCombinedSource();
    const core = await readRepo('packages/core/src/visual-smoke.ts');
    const fixture = await readRepo('apps/desktop/src/main/visual-smoke-fixture.ts');
    const screenshotDriver = await readRepo('scripts/capture-screenshots.mjs');

    assert.match(core, /\| 'command-palette-open'/, 'VisualSmokeScenario must include command-palette-open');
    assert.match(core, /paletteOpen\?: boolean;/, 'VisualSmokeState must expose the paletteOpen hint');
    assert.match(fixture, /'command-palette-open'/, 'visual smoke fixture resolver must accept command-palette-open');
    assert.match(fixture, /case 'command-palette-open':[\s\S]*paletteOpen: true/, 'command-palette-open must auto-open the palette');
    assert.match(main, /if \(state\.paletteOpen\) \{\s*openPalette\(\);\s*\}/, 'renderer must consume paletteOpen and open CommandPalette');
    assert.match(screenshotDriver, /'command-palette-open'/, 'screenshot driver must capture command-palette-open');
  });

  it('keeps the primary command hints in Chinese product copy', async () => {
    const src = await readRepo('apps/desktop/src/renderer/command-palette.tsx');
    assert.match(src, /label: '新建对话',[^\n]*\n\s*hint: '开始新的会话',/);
    assert.doesNotMatch(src, /hint: 'New chat'/, 'visible command palette hints must not leak English fallback copy');
  });

  it('gates command execution so Enter/click cannot run the same palette action twice', async () => {
    const src = await readRepo('apps/desktop/src/renderer/command-palette.tsx');
    const mainSrc = await readRendererShellCombinedSource();
    const commandTypes = await readRepo('apps/desktop/src/renderer/command-palette-types.ts');
    const commandPaletteBlock = src.match(/export function CommandPalette[\s\S]*?function onInputKeyDown/)?.[0] ?? '';
    const commitBlock = src.match(/function commit\(cmd: Command \| undefined\) \{[\s\S]*?\n  \}/)?.[0] ?? '';
    const rowBlock = src.match(/const commandCommitPending = committedCommandId === cmd\.id;[\s\S]*?onClick=\{\(\) => commit\(cmd\)\}/)?.[0] ?? '';

    assert.match(commandTypes, /run\(\): void \| Promise<void>/, 'command actions may be async and must be awaited by commit()');
    assert.match(commandPaletteBlock, /const commitPendingRef = useRef\(false\)/);
    assert.match(commandPaletteBlock, /const \[committedCommandId, setCommittedCommandId\] = useState<string \| null>\(null\)/);
    assert.match(
      commitBlock,
      /if \(!cmd\) return;[\s\S]*if \(commitPendingRef\.current\) return;[\s\S]*if \(cmd\.disabled\) return;[\s\S]*commitPendingRef\.current = true;[\s\S]*setCommittedCommandId\(cmd\.id\);[\s\S]*await cmd\.run\(\);[\s\S]*finally \{[\s\S]*props\.onClose\(\);[\s\S]*\}[\s\S]*\.catch\(\(\) => undefined\)/,
      'CommandPalette commit() must synchronously drop duplicate activations, await async actions, and close from finally',
    );
    assert.doesNotMatch(
      src,
      /run: \(\) => void args\./,
      'buildCommandList must return host callback promises instead of voiding them before commit() can await',
    );
    assert.doesNotMatch(
      mainSrc,
      /on(NewChat|StartDeepResearch|SetPermissionMode):\s*\([^)]*\)\s*=>\s*void /,
      'renderer must pass command palette async owner actions through instead of voiding their promises at the prop boundary',
    );
    assert.match(rowBlock, /aria-busy=\{commandCommitPending \? 'true' : undefined\}/);
    assert.match(rowBlock, /data-pending=\{commandCommitPending \? 'true' : undefined\}/);
  });

  it('resets active command to the first result when the result set changes', async () => {
    const src = await readRepo('apps/desktop/src/renderer/command-palette.tsx');
    const highlightEffect = src.match(/useEffect\(\(\) => \{[\s\S]*?Reset highlight whenever the result set changes\.[\s\S]*?\}, \[combined\]\);/)?.[0] ?? '';

    assert.match(
      highlightEffect,
      /setHighlight\(0\);/,
      'CommandPalette must reset highlight to the first new result after filtering/search results change',
    );
    assert.doesNotMatch(
      highlightEffect,
      /Math\.min\(current,\s*Math\.max\(0,\s*combined\.length - 1\)\)/,
      'CommandPalette must not preserve a stale lower-row highlight across a new result set',
    );
  });

  it('scrubs thrown command action failures before toast', async () => {
    const main = await readRendererShellCombinedSource();
    const commandPaletteBlock = main.match(/return buildCommandList\(\{[\s\S]*?\n\s*\}\);/)?.[0] ?? '';
    const helperBlock = main.match(/function commandPaletteActionErrorMessage\(error: unknown, fallback: string\): string \{[\s\S]*?\n\}/)?.[0] ?? '';
    const connectionTestHelperBlock = main.match(/function commandPaletteConnectionTestFailureMessage\(result: ConnectionTestResult\): string \{[\s\S]*?\n\}/)?.[0] ?? '';
    const connectionTestFallbackBlock = main.match(/function commandPaletteConnectionTestFailureFallback\(result: ConnectionTestResult\): string \{[\s\S]*?\n\}/)?.[0] ?? '';

    assert.match(helperBlock, /generalizedErrorMessageChinese\(error, fallback\)/);
    assert.match(
      connectionTestHelperBlock,
      /generalizedErrorMessageChinese\(new Error\(result\.errorMessage\), fallback\)/,
      'Command palette connection-test failures must classify/redact raw provider messages before toast',
    );
    assert.match(connectionTestFallbackBlock, /statusCode === 429[\s\S]*触发速率限制/);
    assert.match(connectionTestFallbackBlock, /errorClass === 'auth'[\s\S]*鉴权失败/);
    assert.match(connectionTestFallbackBlock, /errorClass === 'network'[\s\S]*网络错误/);
    assert.match(commandPaletteBlock, /toastApi\.error\(`连接测试失败 · \$\{name\}`, commandPaletteConnectionTestFailureMessage\(result\)\)/);
    assert.match(commandPaletteBlock, /commandPaletteActionErrorMessage\(err, '导出当前对话失败，请稍后重试。'\)/);
    assert.match(commandPaletteBlock, /commandPaletteActionErrorMessage\(err, '连接测试暂时不可用，请稍后重试。'\)/);
    assert.match(commandPaletteBlock, /commandPaletteActionErrorMessage\(err, '默认模型暂时无法切换，请稍后重试。'\)/);
    assert.match(commandPaletteBlock, /commandPaletteActionErrorMessage\(err, '无法打开 MEMORY\.md，请稍后重试。'\)/);
    assert.match(commandPaletteBlock, /commandPaletteActionErrorMessage\(err, '无法打开项目指引，请稍后重试。'\)/);
    assert.match(commandPaletteBlock, /commandPaletteActionErrorMessage\(err, '剪贴板不可用或被系统拒绝'\)/);
    assert.match(commandPaletteBlock, /commandPaletteActionErrorMessage\(err, '网络代理测试暂时不可用，请稍后重试。'\)/);
    assert.doesNotMatch(
      commandPaletteBlock,
      /(?:err|error) instanceof Error \? (?:err|error)\.message : (?:String\((?:err|error)\)|'导出当前对话失败'|'路径无效'|'剪贴板不可用'|'网络代理测试异常')/,
      'Command palette actions must not toast raw thrown Error.message',
    );
    assert.doesNotMatch(
      commandPaletteBlock,
      /toastApi\.error\(`连接测试失败 · \$\{name\}`, result\.errorMessage \?\? '未知错误'\)/,
      'Command palette connection test must not echo raw ConnectionTestResult.errorMessage',
    );
  });
});
