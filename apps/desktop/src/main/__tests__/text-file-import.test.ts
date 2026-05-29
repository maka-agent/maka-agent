import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  appendPromptContextDraft,
  navigateComposerHistory,
  readComposerDraft,
  rememberComposerDraft,
  rememberComposerHistoryEntry,
} from '@maka/ui';
import {
  MAX_IMPORTED_TEXT_FILE_BYTES,
  MAX_IMPORTED_TEXT_FILE_CHARS,
  MAX_IMPORTED_TEXT_FILE_COUNT,
  MAX_IMPORTED_TEXT_FILES_CHARS,
  MAX_IMPORTED_FOLDER_COUNT,
  MAX_IMPORTED_FOLDERS_ENTRIES,
  formatImportedTextFilePrompt,
  readDroppedTextFilesForPromptImport,
  readFolderOutlineForPromptImport,
  readFolderOutlinesForPromptImport,
  readTextFileForPromptImport,
  readTextFilesForPromptImport,
} from '../text-file-import.js';

describe('text file context import', () => {
  it('appends imported context without replacing an existing draft', () => {
    assert.equal(appendPromptContextDraft('', '<local-text-file />'), '<local-text-file />');
    assert.equal(
      appendPromptContextDraft('先总结风险。  \n', '<local-folder-outline />'),
      '先总结风险。\n\n<local-folder-outline />',
    );
  });

  it('keeps composer drafts isolated by runtime draft key', () => {
    const store = new Map<string, string>();

    rememberComposerDraft(store, 'session-a', 'A 里的问题');
    rememberComposerDraft(store, 'session-b', 'B 里的问题');

    assert.equal(readComposerDraft(store, 'session-a'), 'A 里的问题');
    assert.equal(readComposerDraft(store, 'session-b'), 'B 里的问题');

    rememberComposerDraft(store, 'session-a', '   ');
    assert.equal(readComposerDraft(store, 'session-a'), '');
    assert.equal(readComposerDraft(store, 'session-b'), 'B 里的问题');
  });

  it('keeps composer prompt history runtime-only and navigable', () => {
    const entries = rememberComposerHistoryEntry(
      rememberComposerHistoryEntry([], '第一条问题'),
      '第二条问题',
    );
    assert.deepEqual(entries, ['第一条问题', '第二条问题']);
    assert.deepEqual(rememberComposerHistoryEntry(entries, '第一条问题'), ['第二条问题', '第一条问题']);

    const previous = navigateComposerHistory({ entries, index: -1, savedDraft: '' }, 'previous', '临时草稿');
    assert.equal(previous.value, '第二条问题');
    assert.equal(previous.state.savedDraft, '临时草稿');

    const older = navigateComposerHistory(previous.state, 'previous', previous.value);
    assert.equal(older.value, '第一条问题');

    const newer = navigateComposerHistory(older.state, 'next', older.value);
    assert.equal(newer.value, '第二条问题');

    const restored = navigateComposerHistory(newer.state, 'next', newer.value);
    assert.equal(restored.value, '临时草稿');
    assert.equal(restored.state.index, -1);
  });

  it('formats a selected text file into a prompt fragment', async () => {
    await withTempDir(async (root) => {
      const filePath = join(root, 'notes.md');
      await writeFile(filePath, '# Notes\nUse the local context.\n', 'utf8');

      const result = await readTextFileForPromptImport(filePath);

      assert.equal(result.ok, true);
      if (!result.ok) return;
      assert.equal(result.name, 'notes.md');
      assert.equal(result.files, 1);
      assert.equal(result.truncated, false);
      assert.match(result.prompt, /<local-text-file name="notes\.md">/);
      assert.match(result.prompt, /Use the local context\./);
    });
  });

  it('formats multiple selected text files into one bounded prompt fragment', async () => {
    await withTempDir(async (root) => {
      await writeFile(join(root, 'a.md'), '# A\nalpha\n', 'utf8');
      await writeFile(join(root, 'b.json'), '{"beta":true}\n', 'utf8');

      const result = await readTextFilesForPromptImport([join(root, 'a.md'), join(root, 'b.json')]);

      assert.equal(result.ok, true);
      if (!result.ok) return;
      assert.equal(result.name, '2 个文本文件');
      assert.equal(result.files, 2);
      assert.equal(result.truncated, false);
      assert.match(result.prompt, /请结合下面导入的 2 个本地文本文件回答。/);
      assert.match(result.prompt, /<local-text-file name="a\.md">/);
      assert.match(result.prompt, /<local-text-file name="b\.json">/);
      assert.doesNotMatch(result.prompt, new RegExp(root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    });
  });

  it('caps multi-file imports by file count and aggregate characters', async () => {
    await withTempDir(async (root) => {
      const many = [];
      for (let index = 0; index < MAX_IMPORTED_TEXT_FILE_COUNT + 1; index += 1) {
        const filePath = join(root, `file-${index}.txt`);
        many.push(filePath);
        await writeFile(filePath, 'x\n', 'utf8');
      }
      assert.deepEqual(await readTextFilesForPromptImport(many), { ok: false, reason: 'too-many-files' });

      const first = join(root, 'first.txt');
      const second = join(root, 'second.txt');
      const third = join(root, 'third.txt');
      await writeFile(first, 'A'.repeat(18_000), 'utf8');
      await writeFile(second, 'B'.repeat(18_000), 'utf8');
      await writeFile(third, 'C'.repeat(MAX_IMPORTED_TEXT_FILES_CHARS), 'utf8');

      const result = await readTextFilesForPromptImport([first, second, third]);

      assert.equal(result.ok, true);
      if (!result.ok) return;
      assert.equal(result.truncated, true);
      assert.match(result.prompt, /文件内容过长/);
      assert.match(result.prompt, /<local-text-file name="third\.txt" truncated="true">/);
    });
  });

  it('formats dropped renderer text files through the same prompt boundary without paths', () => {
    const result = readDroppedTextFilesForPromptImport([
      { name: '/private/tmp/alpha.md', size: 12, text: '# Alpha\nfirst' },
      { name: 'beta.json', size: 13, text: '{"beta":true}' },
    ]);

    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.files, 2);
    assert.equal(result.name, '2 个文本文件');
    assert.match(result.prompt, /<local-text-file name="alpha\.md">/);
    assert.match(result.prompt, /<local-text-file name="beta\.json">/);
    assert.doesNotMatch(result.prompt, /private\/tmp/);
  });

  it('rejects dropped oversize, empty, and too many text files', () => {
    assert.deepEqual(
      readDroppedTextFilesForPromptImport([{ name: 'huge.txt', size: MAX_IMPORTED_TEXT_FILE_BYTES + 1, text: 'x' }]),
      { ok: false, reason: 'too-large' },
    );
    assert.deepEqual(
      readDroppedTextFilesForPromptImport([{ name: 'empty.txt', size: 0, text: '' }]),
      { ok: false, reason: 'binary' },
    );
    assert.deepEqual(
      readDroppedTextFilesForPromptImport(
        Array.from({ length: MAX_IMPORTED_TEXT_FILE_COUNT + 1 }, (_, index) => ({
          name: `file-${index}.txt`,
          size: 1,
          text: 'x',
        })),
      ),
      { ok: false, reason: 'too-many-files' },
    );
  });

  it('rejects oversize and binary-looking files', async () => {
    await withTempDir(async (root) => {
      const huge = join(root, 'huge.txt');
      const binary = join(root, 'binary.dat');
      await writeFile(huge, 'A'.repeat(MAX_IMPORTED_TEXT_FILE_BYTES + 1), 'utf8');
      await writeFile(binary, Buffer.from([0, 1, 2, 3, 4]));

      assert.deepEqual(await readTextFileForPromptImport(huge), { ok: false, reason: 'too-large' });
      assert.deepEqual(await readTextFileForPromptImport(binary), { ok: false, reason: 'binary' });
    });
  });

  it('truncates long text by character count and escapes filenames', () => {
    const prompt = formatImportedTextFilePrompt({
      name: 'a"b<.md',
      text: '你'.repeat(MAX_IMPORTED_TEXT_FILE_CHARS + 5).slice(0, MAX_IMPORTED_TEXT_FILE_CHARS),
      truncated: true,
    });

    assert.match(prompt, /文件内容过长/);
    assert.match(prompt, /name="a&quot;b&lt;\.md"/);
  });

  it('wires the import action into both Composer and first-run Quick Chat', async () => {
    const mainSource = await readFile(join(process.cwd(), 'src/renderer/main.tsx'), 'utf8');
    const mainProcessSource = await readFile(join(process.cwd(), 'src/main/main.ts'), 'utf8');
    const preloadSource = await readFile(join(process.cwd(), 'src/preload/preload.ts'), 'utf8');
    const globalSource = await readFile(join(process.cwd(), 'src/global.d.ts'), 'utf8');
    const onboardingSource = await readFile(join(process.cwd(), 'src/renderer/OnboardingHero.tsx'), 'utf8');
    const uiSource = await readFile(join(process.cwd(), '../../packages/ui/src/components.tsx'), 'utf8');
    const cssSource = await readFile(join(process.cwd(), 'src/renderer/maka-tokens.css'), 'utf8');
    const stylesSource = await readFile(join(process.cwd(), 'src/renderer/styles.css'), 'utf8');

    assert.match(mainSource, /onImportTextFile=\{importTextFilePrompt\}/);
    assert.match(mainSource, /onImportTextFile=\{importTextFileIntoComposer\}/);
    assert.match(mainSource, /onImportDroppedTextFiles=\{importDroppedTextFilesPrompt\}/);
    assert.match(mainSource, /onImportDroppedTextFiles=\{importDroppedTextFilesIntoComposer\}/);
    assert.match(mainSource, /preflightDroppedTextFilesForPromptImport\(files\)/);
    assert.match(mainSource, /window\.maka\.context\.importDroppedTextFiles\(payloads\)/);
    assert.ok(
      mainSource.indexOf('preflightDroppedTextFilesForPromptImport(files)') < mainSource.indexOf('text: await file.text()'),
      'renderer must preflight count/size before reading dropped/pasted file text',
    );
    assert.match(mainSource, /composerRef\.current\?\.appendText\(prompt\)/);
    assert.match(mainSource, /draftKey=\{activeId \?\? 'new-session'\}/);
    assert.match(mainProcessSource, /properties: \['openFile', 'multiSelections'\]/);
    assert.match(mainProcessSource, /context:importDroppedTextFiles/);
    assert.match(preloadSource, /importDroppedTextFiles/);
    assert.match(globalSource, /importDroppedTextFiles/);
    assert.match(mainSource, /onImportFolderOutline=\{importFolderOutlinePrompt\}/);
    assert.match(mainSource, /onImportFolderOutline=\{importFolderOutlineIntoComposer\}/);
    assert.match(mainProcessSource, /properties: \['openDirectory', 'multiSelections'\]/);
    assert.match(onboardingSource, /导入文本文件/);
    assert.match(onboardingSource, /导入文件夹目录/);
    assert.match(onboardingSource, /appendPromptContextDraft\(current, prompt\)/);
    assert.match(onboardingSource, /onImportDroppedTextFiles/);
    assert.match(onboardingSource, /onDrop=\{handleDrop\}/);
    assert.match(onboardingSource, /onPaste=\{handlePaste\}/);
    assert.match(uiSource, /aria-label="导入文本文件"/);
    assert.match(uiSource, /aria-label="导入文件夹目录"/);
    assert.match(uiSource, /onDrop=\{onComposerDrop\}/);
    assert.match(uiSource, /onPaste=\{onTextareaPaste\}/);
    assert.match(uiSource, /event\.clipboardData\.files/);
    assert.match(cssSource, /\.maka-composer\[data-drag-active="true"\]/);
    assert.match(stylesSource, /\.maka-onboarding-quickchat\[data-drag-active="true"\]/);
    assert.match(uiSource, /rememberComposerDraft\(draftStoreRef\.current, previousKey/);
    assert.match(uiSource, /readComposerDraft\(draftStoreRef\.current, nextKey\)/);
    assert.match(uiSource, /rememberComposerHistoryEntry\(promptHistoryRef\.current\.entries, text\)/);
    assert.match(uiSource, /navigateComposerHistory\(/);
    assert.doesNotMatch(uiSource, /localStorage\.setItem\([^)]*draft/i);
  });

  it('appends prompt suggestions instead of replacing existing drafts', async () => {
    const mainSource = await readFile(join(process.cwd(), 'src/renderer/main.tsx'), 'utf8');
    const onboardingSource = await readFile(join(process.cwd(), 'src/renderer/OnboardingHero.tsx'), 'utf8');

    assert.match(mainSource, /onPromptSuggestion=\{\(prompt\) => composerRef\.current\?\.appendText\(prompt\)\}/);
    assert.doesNotMatch(mainSource, /onPromptSuggestion=\{\(prompt\) => composerRef\.current\?\.setText\(prompt\)\}/);
    assert.match(onboardingSource, /const nextDraft = appendPromptContextDraft\(draft, prompt\)/);
    assert.match(onboardingSource, /setDraft\(nextDraft\)/);
  });

  it('formats a selected folder into a bounded prompt outline', async () => {
    await withTempDir(async (root) => {
      await mkdir(join(root, 'src'));
      await mkdir(join(root, 'node_modules'));
      await writeFile(join(root, 'README.md'), '# Demo\n', 'utf8');
      await writeFile(join(root, 'src', 'index.ts'), 'export {};\n', 'utf8');
      await writeFile(join(root, 'node_modules', 'ignored.js'), 'ignored\n', 'utf8');

      const result = await readFolderOutlineForPromptImport(root);

      assert.equal(result.ok, true);
      if (!result.ok) return;
      assert.equal(result.entries, 3);
      assert.equal(result.folders, 1);
      assert.equal(result.truncated, false);
      assert.match(result.prompt, /<local-folder-outline name="maka-text-import-/);
      assert.match(result.prompt, /- src\//);
      assert.match(result.prompt, /- src\/index\.ts/);
      assert.match(result.prompt, /- README\.md/);
      assert.doesNotMatch(result.prompt, /node_modules/);
      assert.doesNotMatch(result.prompt, new RegExp(root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    });
  });

  it('formats multiple selected folders into one bounded outline prompt', async () => {
    await withTempDir(async (root) => {
      const app = join(root, 'app');
      const docs = join(root, 'docs');
      await mkdir(app);
      await mkdir(docs);
      await writeFile(join(app, 'main.ts'), 'export {};\n', 'utf8');
      await writeFile(join(docs, 'readme.md'), '# Readme\n', 'utf8');

      const result = await readFolderOutlinesForPromptImport([app, docs]);

      assert.equal(result.ok, true);
      if (!result.ok) return;
      assert.equal(result.name, '2 个文件夹');
      assert.equal(result.folders, 2);
      assert.equal(result.entries, 2);
      assert.equal(result.truncated, false);
      assert.match(result.prompt, /请结合下面导入的 2 个本地文件夹目录回答。/);
      assert.match(result.prompt, /<local-folder-outline name="app">/);
      assert.match(result.prompt, /<local-folder-outline name="docs">/);
      assert.doesNotMatch(result.prompt, new RegExp(root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    });
  });

  it('caps multi-folder imports by folder count and aggregate entries', async () => {
    await withTempDir(async (root) => {
      const many = [];
      for (let index = 0; index < MAX_IMPORTED_FOLDER_COUNT + 1; index += 1) {
        const folder = join(root, `folder-${index}`);
        many.push(folder);
        await mkdir(folder);
        await writeFile(join(folder, 'index.ts'), 'export {};\n', 'utf8');
      }
      assert.deepEqual(await readFolderOutlinesForPromptImport(many), { ok: false, reason: 'too-many-folders' });

      const first = join(root, 'first');
      const second = join(root, 'second');
      await mkdir(first);
      await mkdir(second);
      for (let index = 0; index < MAX_IMPORTED_FOLDERS_ENTRIES - 1; index += 1) {
        await writeFile(join(first, `file-${index}.txt`), 'x\n', 'utf8');
      }
      await writeFile(join(second, 'extra.txt'), 'x\n', 'utf8');
      await writeFile(join(second, 'omitted.txt'), 'x\n', 'utf8');

      const result = await readFolderOutlinesForPromptImport([first, second]);

      assert.equal(result.ok, true);
      if (!result.ok) return;
      assert.equal(result.truncated, true);
      assert.equal(result.entries, MAX_IMPORTED_FOLDERS_ENTRIES);
      assert.match(result.prompt, /目录较大/);
      assert.match(result.prompt, /<local-folder-outline name="second" truncated="true">/);
    });
  });
});

async function withTempDir(fn: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'maka-text-import-'));
  try {
    await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
