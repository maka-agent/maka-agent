import { strict as assert } from 'node:assert';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';
import { readRendererContractCss } from './contract-css-helpers.js';
import { readMainProcessCombinedSource } from './main-process-contract-source-helpers.js';
import { readRendererShellCombinedSource } from './renderer-shell-source-helpers.js';

const REPO_ROOT = resolve(import.meta.dirname, '../../../../..');

describe('Daily Review export-to-file contract (PR-DAILY-REVIEW-EXPORT-FILE-0)', () => {
  it('exposes the save-to-file IPC, preload bridge, and command palette entry', async () => {
    const main = await readMainProcessCombinedSource();
    const preload = await readFile(resolve(REPO_ROOT, 'apps/desktop/src/preload/preload.ts'), 'utf8');
    const palette = await readFile(resolve(REPO_ROOT, 'apps/desktop/src/renderer/command-palette-commands.ts'), 'utf8');
    const catalog = await readFile(resolve(REPO_ROOT, 'apps/desktop/src/renderer/locales/shell-copy.ts'), 'utf8');
    const renderer = await readRendererShellCombinedSource();
    const ui = await readFile(resolve(REPO_ROOT, 'packages/ui/src/daily-review-panel.tsx'), 'utf8');
    const modulePages = await readFile(resolve(REPO_ROOT, 'packages/ui/src/module-pages.tsx'), 'utf8');
    const sessionListPanel = await readFile(resolve(REPO_ROOT, 'packages/ui/src/session-list-panel.tsx'), 'utf8');
    const css = await readRendererContractCss();

    // IPC handler is registered and shape-validates its input before
    // hitting the save dialog or filesystem.
    assert.match(main, /ipcMain\.handle\(\s*['"]daily-review:saveMarkdownToFile['"]/);
    assert.match(main, /reason:\s*['"]invalid_input['"]/);
    assert.match(main, /reason:\s*['"]canceled['"]/);
    assert.match(main, /reason:\s*['"]write_failed['"]/);

    // Preload bridge mirrors the IPC name; renderer never calls
    // `ipcRenderer.invoke` directly with the channel name.
    assert.match(preload, /daily-review:saveMarkdownToFile/);
    assert.match(preload, /saveMarkdownToFile\(input:/);

    // Command palette surfaces the action; it does not require an
    // active session (export should work even on an empty rail).
    assert.match(palette, /onSaveTodayDailyReviewToFile/);
    assert.match(palette, /diag:save-today-daily-review/);
    assert.match(palette, /staticCopy\('diag:save-today-daily-review'\)/);
    assert.match(catalog, /label: '保存今日回顾为 \.md 文件'/);
    assert.match(catalog, /label: "Save today's review as an \.md file"/);

    // Renderer wires the callback to fetch summary, render markdown,
    // invoke IPC, and surface a toast on success/failure.
    assert.match(renderer, /onSaveTodayDailyReviewToFile:\s*async \(\)/);
    assert.match(renderer, /dailyReview\.saveMarkdownToFile\(\{\s*markdown:\s*input\.markdown,\s*defaultName/);
    assert.match(renderer, /toastApi\.success\(\s*copy\.reviewSaved\(input\.label\)/);

    // The main Daily Review panel exposes save next to copy, so export
    // is not hidden behind command palette muscle memory.
    assert.doesNotMatch(sessionListPanel, /onSaveDailyReviewMarkdown\?\(input:\s*DailyReviewMarkdownActionInput\)/);
    assert.match(modulePages, /onSaveMarkdown\?: \(input: DailyReviewMarkdownActionInput\)/);
    assert.match(ui, /maka-daily-review-save[\s\S]*保存/);
    assert.match(css, /\.maka-daily-review-actions/);
  });

  it('clamps the save payload size so a renderer cannot force a large write', async () => {
    const main = await readMainProcessCombinedSource();
    // 1MB cap on markdown body; 200 chars on filename. These are
    // defensive against a misbehaving / hijacked renderer, not product
    // UX constraints — daily reviews are typically well under 100KB.
    assert.match(main, /markdown\.length\s*>\s*1_000_000/);
    assert.match(main, /defaultName\.length\s*>\s*200/);
  });

  it('strips directory separators from the proposed filename', async () => {
    // Defensive: even though the save dialog enforces a destination
    // path, do not let the caller pre-populate the dialog with
    // path-traversal text. The source contains
    // `defaultName.replace(/[\\/]/g, '_')` — escaped backslash + slash
    // inside a character class.
    const main = await readMainProcessCombinedSource();
    assert.equal(
      main.includes("defaultName.replace(/[\\\\/]/g, '_')"),
      true,
      'main.ts must strip backslash and forward-slash from defaultName',
    );
  });
});
