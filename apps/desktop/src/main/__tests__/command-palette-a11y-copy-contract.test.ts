import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, it } from 'node:test';

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

  it('keeps the primary command hints in Chinese product copy', async () => {
    const src = await readRepo('apps/desktop/src/renderer/command-palette.tsx');
    assert.match(src, /label: '新建对话',[^\n]*\n\s*hint: '开始新的会话',/);
    assert.doesNotMatch(src, /hint: 'New chat'/, 'visible command palette hints must not leak English fallback copy');
  });

  it('gates command execution so Enter/click cannot run the same palette action twice', async () => {
    const src = await readRepo('apps/desktop/src/renderer/command-palette.tsx');
    const mainSrc = await readRepo('apps/desktop/src/renderer/main.tsx');
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

  it('scrubs thrown command action failures before toast', async () => {
    const main = await readRepo('apps/desktop/src/renderer/main.tsx');
    const commandPaletteBlock = main.match(/commands=\{buildCommandList\(\{[\s\S]*?\n\s*\}\)\}/)?.[0] ?? '';
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
