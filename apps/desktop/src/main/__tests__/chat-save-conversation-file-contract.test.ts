import { strict as assert } from 'node:assert';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';
import { readMainProcessCombinedSource } from './main-process-contract-source-helpers.js';
import { readRendererShellCombinedSource } from './renderer-shell-source-helpers.js';

const REPO_ROOT = resolve(import.meta.dirname, '../../../../..');

describe('Chat save-conversation-to-file contract (PR-CMD-PALETTE-SAVE-CONVERSATION-FILE-0)', () => {
  it('exposes the save-conversation IPC, preload bridge, and command palette entry', async () => {
    const main = await readMainProcessCombinedSource();
    const preload = await readFile(resolve(REPO_ROOT, 'apps/desktop/src/preload/preload.ts'), 'utf8');
    const palette = await readFile(resolve(REPO_ROOT, 'apps/desktop/src/renderer/command-palette-commands.ts'), 'utf8');
    const catalog = await readFile(resolve(REPO_ROOT, 'apps/desktop/src/renderer/locales/shell-copy.ts'), 'utf8');
    const renderer = await readRendererShellCombinedSource();
    const globalDts = await readFile(resolve(REPO_ROOT, 'apps/desktop/src/preload/bridge-contract.d.ts'), 'utf8');

    // IPC handler is registered. It delegates to the shared helper, so
    // we pin the channel name + reuse of the shared validation surface.
    assert.match(main, /ipcMain\.handle\(\s*['"]chat:saveConversationToFile['"]/);
    assert.match(main, /saveMarkdownViaDialog\(deps\.mainWindowController,\s*input,\s*['"]保存当前对话['"]\)/);

    // Shared helper exists with the documented failure reasons.
    assert.match(main, /async function saveMarkdownViaDialog/);
    assert.match(main, /reason:\s*['"]invalid_input['"]/);
    assert.match(main, /reason:\s*['"]canceled['"]/);
    assert.match(main, /reason:\s*['"]write_failed['"]/);

    // Preload bridge mirrors the IPC name; renderer never calls
    // `ipcRenderer.invoke` directly with the channel name.
    assert.match(preload, /chat:saveConversationToFile/);
    assert.match(preload, /saveConversationToFile\(input:/);

    // The shared bridge contract declares the renderer-visible session method
    // so type-checking catches drift between preload and renderer.
    assert.match(globalDts, /saveConversationToFile\(input:/);

    // Command palette entry sits under the same 诊断 group as the
    // copy/export siblings and only registers when both the callback
    // and an active session are wired (no session → nothing to save).
    assert.match(palette, /onSaveActiveConversationToFile/);
    assert.match(palette, /diag:save-conversation-file/);
    assert.match(palette, /staticCopy\('diag:save-conversation-file'\)/);
    assert.match(catalog, /label: '保存当前对话为 \.md 文件'/);
    assert.match(catalog, /label: 'Save conversation as an \.md file'/);
    assert.match(palette, /args\.onSaveActiveConversationToFile\s*&&\s*args\.activeSessionId/);

    // Renderer wires the callback to render markdown, build a
    // session-aware default filename, invoke IPC, and surface
    // success / write_failed / invalid_input toasts. `canceled` is silent.
    assert.match(renderer, /onSaveActiveConversationToFile:\s*async \(\)/);
    assert.match(renderer, /sessions\.saveConversationToFile\(\{\s*markdown,\s*defaultName/);
    assert.match(renderer, /toastApi\.success\(copy\.conversationSavedTitle/);
    assert.match(renderer, /maka-\$\{sanitizedSession\}-\$\{yyyy\}-\$\{mm\}-\$\{dd\}\.md/);
  });

  it('reuses the shared save-markdown helper so both export targets get the same caps and sanitize', async () => {
    const main = await readMainProcessCombinedSource();
    // Both daily-review and chat IPCs must go through `saveMarkdownViaDialog`
    // — duplicating the cap / sanitize logic would let the two surfaces
    // drift apart over time.
    const calls = main.match(/saveMarkdownViaDialog\(deps\.mainWindowController,\s*input,/g) ?? [];
    assert.equal(
      calls.length,
      2,
      `expected exactly 2 saveMarkdownViaDialog call sites (daily-review + chat), found ${calls.length}`,
    );
  });
});
