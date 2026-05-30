import { strict as assert } from 'node:assert';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, it } from 'node:test';

const REPO_ROOT = join(process.cwd(), '..', '..');

async function readRepo(path: string): Promise<string> {
  return readFile(join(REPO_ROOT, path), 'utf8');
}

describe('local MEMORY.md Settings UI contract', () => {
  it('renders active and archived memory entries as separate visible groups', async () => {
    const src = await readRepo('apps/desktop/src/renderer/settings/SettingsModal.tsx');

    assert.match(src, /<MemoryEntryList[\s\S]*title="生效记忆"[\s\S]*entries=\{filteredActiveEntries\}/);
    assert.match(src, /<MemoryEntryList[\s\S]*title="已归档记忆"[\s\S]*entries=\{filteredArchivedEntries\}[\s\S]*archived/);
    assert.match(src, /visibleMemoryEntries\.archivedEntries\.length > 0/);
    assert.ok(src.includes("entry.tags.join(' / ')"));
  });

  it('renders stable entry metadata so local memory stays white-box', async () => {
    const src = await readRepo('apps/desktop/src/renderer/settings/SettingsModal.tsx');
    const css = await readRepo('apps/desktop/src/renderer/styles.css');
    const listBlock = src.match(/function MemoryEntryList\([\s\S]*?function filterLocalMemoryEntries/)?.[0] ?? '';

    assert.match(listBlock, /settingsMemoryEntryFacts/);
    assert.match(listBlock, /ID \{entry\.id\}/);
    assert.match(listBlock, /entry\.createdAt !== undefined/);
    assert.match(listBlock, /创建 <RelativeTime ts=\{entry\.createdAt\}/);
    assert.match(listBlock, /entry\.updatedAt !== undefined/);
    assert.match(listBlock, /更新 <RelativeTime ts=\{entry\.updatedAt\}/);
    assert.match(listBlock, /settingsMemoryPromptScope/);
    assert.match(listBlock, /已归档，不进入 prompt/);
    assert.match(listBlock, /生效条目，会进入本地记忆 prompt/);
    assert.match(css, /\.settingsMemoryEntryFacts/);
    assert.match(css, /\.settingsMemoryPromptScope/);
  });

  it('can copy a stable memory entry reference for audit handoff', async () => {
    const src = await readRepo('apps/desktop/src/renderer/settings/SettingsModal.tsx');
    const pageBlock = src.match(/function MemorySettingsPage\([\s\S]*?function MemoryEntryList/)?.[0] ?? '';
    const listBlock = src.match(/function MemoryEntryList\([\s\S]*?function filterLocalMemoryEntries/)?.[0] ?? '';

    assert.match(pageBlock, /async function copyMemoryEntryReference/);
    assert.match(pageBlock, /Memory entry: \$\{entry\.title\}/);
    assert.match(pageBlock, /ID: \$\{entry\.id\}/);
    assert.match(pageBlock, /Status: \$\{memoryEntryStatusLabel\(entry\.status\)\}/);
    assert.match(pageBlock, /navigator\.clipboard\.writeText\(reference\)/);
    assert.match(pageBlock, /toast\.success\('已复制记忆引用', entry\.id\)/);
    assert.match(listBlock, /onCopyReference/);
    assert.match(listBlock, /复制引用/);
    assert.match(src, /function memoryEntryStatusLabel/);
  });

  it('can focus a memory entry in the visible MEMORY.md draft editor', async () => {
    const src = await readRepo('apps/desktop/src/renderer/settings/SettingsModal.tsx');
    const pageBlock = src.match(/function MemorySettingsPage\([\s\S]*?function MemoryEntryList/)?.[0] ?? '';
    const listBlock = src.match(/function MemoryEntryList\([\s\S]*?function filterLocalMemoryEntries/)?.[0] ?? '';

    assert.match(src, /findLocalMemoryEntryDraftRange/);
    assert.match(pageBlock, /function focusMemoryEntryInDraft/);
    assert.match(pageBlock, /findLocalMemoryEntryDraftRange\(draft, entry\.id\)/);
    assert.match(pageBlock, /editorRef\.current\?\.setSelectionRange\(range\.start, range\.end\)/);
    assert.match(pageBlock, /editorRef\.current\?\.scrollIntoView\(\{ block: 'center', behavior: 'smooth' \}\)/);
    assert.match(pageBlock, /无法定位记忆/);
    assert.match(listBlock, /onFocusDraft/);
    assert.match(listBlock, /定位草稿/);
  });

  it('previews the send-time memory prompt context from the core helper', async () => {
    const src = await readRepo('apps/desktop/src/renderer/settings/SettingsModal.tsx');
    const css = await readRepo('apps/desktop/src/renderer/styles.css');
    const pageBlock = src.match(/function MemorySettingsPage\([\s\S]*?function MemoryEntryList/)?.[0] ?? '';

    assert.match(src, /LOCAL_MEMORY_PROMPT_MAX_CHARS/);
    assert.match(src, /buildLocalMemoryPromptBody/);
    assert.match(pageBlock, /const localMemoryPromptPreview = useMemo\(\(\) => buildLocalMemoryPromptBody\(draft\) \?\? '', \[draft\]\)/);
    assert.match(pageBlock, /localMemoryPromptPreviewBlockedReason\(effective\)/);
    assert.match(pageBlock, /localMemoryPromptPreviewTruncated/);
    assert.match(pageBlock, /localMemoryPromptPreviewBudgetLabel/);
    assert.match(pageBlock, /预览已按 \$\{LOCAL_MEMORY_PROMPT_MAX_CHARS\.toLocaleString\('zh-CN'\)\} 字符上限截断/);
    assert.match(pageBlock, /prompt 上限 \$\{LOCAL_MEMORY_PROMPT_MAX_CHARS\.toLocaleString\('zh-CN'\)\} 字符/);
    assert.match(pageBlock, /模型上下文预览/);
    assert.match(pageBlock, /发送时会注入/);
    assert.match(pageBlock, /当前不会注入/);
    assert.match(pageBlock, /只展示生效记忆会进入 prompt/);
    assert.match(pageBlock, /已归档条目不会注入/);
    assert.match(pageBlock, /疑似密钥会遮蔽/);
    assert.match(pageBlock, /<pre>\{localMemoryPromptPreview\}<\/pre>/);
    assert.match(pageBlock, /async function copyLocalMemoryPromptPreview/);
    assert.match(pageBlock, /navigator\.clipboard\.writeText\(localMemoryPromptPreview\)/);
    assert.match(pageBlock, /已复制模型上下文预览/);
    assert.match(pageBlock, /复制上下文/);
    assert.match(css, /\.settingsMemoryPromptPreview/);
    assert.match(css, /\.settingsMemoryPromptPreviewBudget/);
  });

  it('filters memory entries locally across title content id origin timestamps and tags', async () => {
    const src = await readRepo('apps/desktop/src/renderer/settings/SettingsModal.tsx');
    const css = await readRepo('apps/desktop/src/renderer/styles.css');
    const pageBlock = src.match(/function MemorySettingsPage\([\s\S]*?function MemoryEntryList/)?.[0] ?? '';

    assert.match(src, /function filterLocalMemoryEntries/);
    assert.match(src, /aria-label="筛选本地记忆"/);
    assert.match(src, /筛选标题、内容、ID 或标签/);
    assert.match(src, /setMemoryEntryQuery\(''\)/);
    assert.match(src, /清除/);
    assert.match(pageBlock, /filteredEntryCount === 0/);
    assert.match(pageBlock, /settingsMemoryFilterEmpty/);
    assert.match(pageBlock, /没有匹配的记忆条目/);
    assert.match(pageBlock, /筛选不会修改 MEMORY\.md/);
    assert.match(css, /\.settingsMemoryFilterEmpty/);
    assert.match(pageBlock, /visibleMemoryEntries\.entries\.length === 0 && !memoryEntryPreviewBlockedReason/);
    assert.match(pageBlock, /settingsMemoryListEmpty/);
    assert.match(pageBlock, /等待添加记忆条目/);
    assert.doesNotMatch(pageBlock, /还没有可预览的记忆条目/);
    assert.match(pageBlock, /手动添加会先进入下方草稿；保存后才会写入 MEMORY\.md/);
    assert.match(css, /\.settingsMemoryListEmpty/);
    assert.match(src, /entry\.id/);
    assert.match(src, /String\(entry\.createdAt\)/);
    assert.match(src, /String\(entry\.updatedAt\)/);
    assert.match(src, /\.\.\.entry\.tags/);
    assert.match(src, /memoryOriginLabel\(entry\.origin\)/);
    assert.match(src, /无匹配条目/);
  });

  it('keeps archived entries visually available without using hidden placeholder copy', async () => {
    const css = await readRepo('apps/desktop/src/renderer/styles.css');

    assert.match(css, /\.settingsMemoryEntryGroup\[data-archived="true"\]/);
    assert.doesNotMatch(css, /coming soon|todo|not implemented/i);
  });

  it('describes agent memory reads as a current send-time prompt boundary', async () => {
    const src = await readRepo('apps/desktop/src/renderer/settings/SettingsModal.tsx');
    const memoryPage = src.match(/function MemorySettingsPage\([\s\S]*?function MemoryEntryList/);

    assert.ok(memoryPage, 'Memory settings page block must exist');
    assert.match(memoryPage![0], /发送消息时把本地记忆加入 prompt/);
    assert.match(memoryPage![0], /隐身模式下仍会禁用/);
    assert.doesNotMatch(
      memoryPage![0],
      /后续 prompt 注入|之后会|V0\.|coming soon|not implemented/i,
      'Memory settings read-boundary copy must not sound like a future roadmap or implementation placeholder',
    );
  });

  it('labels the missing MEMORY.md path as an actionable create state', async () => {
    const src = await readRepo('apps/desktop/src/renderer/settings/SettingsModal.tsx');
    const memoryPage = src.match(/function MemorySettingsPage\([\s\S]*?function MemoryEntryList/);

    assert.ok(memoryPage, 'Memory settings page block must exist');
    assert.match(memoryPage![0], /等待创建 MEMORY\.md/);
    assert.doesNotMatch(
      memoryPage![0],
      /MEMORY\.md 尚未创建/,
      'Missing MEMORY.md copy should read as an actionable create state, not unfinished implementation copy',
    );
  });

  it('manual add stays draft-only and routes through the core helper', async () => {
    const src = await readRepo('apps/desktop/src/renderer/settings/SettingsModal.tsx');
    const manualAddBlock = src.match(/function addManualMemoryDraftEntry\(\) \{[\s\S]*?\n  \}\n\n  async function updateMemoryEntryStatus/)?.[0] ?? '';

    assert.match(src, /appendManualLocalMemoryEntryDraft\(draft/);
    assert.match(src, /tags:\s*newMemoryTags\.split\(', '\)|tags:\s*newMemoryTags\.split\(','/);
    assert.match(src, /aria-label="记忆标签"/);
    assert.match(src, /已添加到草稿/);
    assert.match(src, /确认文件内容后点击保存/);
    assert.doesNotMatch(manualAddBlock, /window\.maka\.memory\.save\(result\.draft\)/);
  });

  it('can archive and restore visible memory entries without hand-editing metadata', async () => {
    const src = await readRepo('apps/desktop/src/renderer/settings/SettingsModal.tsx');

    assert.match(src, /setLocalMemoryEntryStatusDraft\(draft/);
    assert.match(src, /onStatusChange=\{updateMemoryEntryStatus\}/);
    assert.match(src, /const statusActionLabel = props\.draftDirty/);
    assert.match(src, /:\s*props\.archived\s*\?\s*'恢复'\s*:\s*'归档';/);
    assert.match(src, /window\.maka\.memory\.save\(result\.draft\)/);
  });

  it('keeps archive and restore draft-only when MEMORY.md has unsaved edits', async () => {
    const src = await readRepo('apps/desktop/src/renderer/settings/SettingsModal.tsx');
    const css = await readRepo('apps/desktop/src/renderer/styles.css');
    const updateBlock = src.match(/async function updateMemoryEntryStatus[\s\S]*?\n  }\n\n  const effective =/)?.[0] ?? '';
    const listBlock = src.match(/function MemoryEntryList\([\s\S]*?function filterLocalMemoryEntries/)?.[0] ?? '';

    assert.match(updateBlock, /if \(memoryDraftDirty\) \{/);
    assert.match(updateBlock, /setDraft\(result\.draft\)/);
    assert.match(updateBlock, /已在草稿中归档记忆/);
    assert.match(updateBlock, /已在草稿中恢复记忆/);
    assert.match(updateBlock, /确认文件内容后点击保存/);
    assert.match(updateBlock, /return;\n    }\n\n    setBusy\(true\)/);
    assert.match(updateBlock, /window\.maka\.memory\.save\(result\.draft\)/);
    assert.match(src, /draftDirty=\{memoryDraftDirty\}/);
    assert.match(listBlock, /draftDirty\?: boolean/);
    assert.match(listBlock, /const statusActionLabel = props\.draftDirty/);
    assert.match(listBlock, /'恢复到草稿'/);
    assert.match(listBlock, /'归档到草稿'/);
    assert.match(listBlock, /const statusActionAriaLabel = props\.draftDirty/);
    assert.match(listBlock, /保存前不会写入 MEMORY\.md/);
    assert.match(listBlock, /aria-label=\{statusActionAriaLabel\}/);
    assert.match(listBlock, /settingsMemoryEntryDraftNotice/);
    assert.match(listBlock, /当前归档\/恢复操作只更新草稿/);
    assert.match(css, /\.settingsMemoryEntryDraftNotice/);
    assert.match(css, /var\(--warning\)/);
  });

  it('uses stopped-update copy for invalid memory entry ids instead of raw missing-field wording', async () => {
    const src = await readRepo('apps/desktop/src/renderer/settings/SettingsModal.tsx');

    assert.match(src, /这条记忆没有可识别 ID，已停止更新。/);
    assert.doesNotMatch(src, /这条记忆缺少可识别的 ID/);
  });

  it('tells the user when saving MEMORY.md redacted sensitive fields', async () => {
    const src = await readRepo('apps/desktop/src/renderer/settings/SettingsModal.tsx');
    const css = await readRepo('apps/desktop/src/renderer/styles.css');
    const saveBlock = src.match(/async function save\(\) \{[\s\S]*?\n  \}\n\n  async function reset/)?.[0] ?? '';
    const pageBlock = src.match(/function MemorySettingsPage\([\s\S]*?function MemoryEntryList/)?.[0] ?? '';

    assert.match(saveBlock, /const redacted = next\.content !== draft/);
    assert.match(saveBlock, /已保存并遮蔽敏感字段/);
    assert.match(saveBlock, /token、API key 或密码/);
    assert.match(pageBlock, /const memoryDraftHasSensitiveFields = useMemo\(\(\) => redactSecrets\(draft\) !== draft, \[draft\]\)/);
    assert.match(pageBlock, /settingsMemoryDraftWarning/);
    assert.match(pageBlock, /role="status"/);
    assert.match(pageBlock, /草稿含疑似敏感字段/);
    assert.match(pageBlock, /保存时会先遮蔽疑似 token、API key 或密码，再写入 MEMORY\.md/);
    assert.match(css, /\.settingsMemoryDraftWarning/);
  });

  it('summarizes parsed memory entry counts after save', async () => {
    const src = await readRepo('apps/desktop/src/renderer/settings/SettingsModal.tsx');
    const css = await readRepo('apps/desktop/src/renderer/styles.css');
    const saveBlock = src.match(/async function save\(\) \{[\s\S]*?\n  \}\n\n  async function reset/)?.[0] ?? '';
    const pageBlock = src.match(/function MemorySettingsPage\([\s\S]*?function MemoryEntryList/)?.[0] ?? '';

    assert.match(src, /function formatLocalMemorySaveSummary\(state: LocalMemoryState\)/);
    assert.match(src, /state\.activeEntryCount/);
    assert.match(src, /state\.archivedEntryCount > 0/);
    assert.match(src, /当前 \$\{state\.activeEntryCount\} 条生效/);
    assert.match(src, /已保留上一版备份/);
    assert.match(saveBlock, /formatLocalMemorySaveSummary\(next\)/);
    assert.match(saveBlock, /已保存并遮蔽敏感字段/);
    assert.match(saveBlock, /savedAt: Date\.now\(\)/);
    assert.match(pageBlock, /lastSaveSummary/);
    assert.match(pageBlock, /setLastSaveSummary\(\{ title: '已保存 MEMORY\.md', detail, savedAt: Date\.now\(\) \}\)/);
    assert.match(pageBlock, /settingsMemorySaveSummary/);
    assert.match(pageBlock, /settingsMemorySaveSummaryTime/);
    assert.match(pageBlock, /保存于 <RelativeTime ts=\{lastSaveSummary\.savedAt\}/);
    assert.match(pageBlock, /lastSaveSummary && !memoryDraftDirty/);
    assert.match(css, /\.settingsMemorySaveSummary/);
    assert.match(css, /\.settingsMemorySaveSummaryTime/);
    assert.match(css, /var\(--success\)/);
  });

  it('shows whether the visible MEMORY.md draft has unsaved changes', async () => {
    const src = await readRepo('apps/desktop/src/renderer/settings/SettingsModal.tsx');
    const css = await readRepo('apps/desktop/src/renderer/styles.css');
    const pageBlock = src.match(/function MemorySettingsPage\([\s\S]*?function MemoryEntryList/)?.[0] ?? '';

    assert.match(pageBlock, /const memoryDraftDirty = draft !== effective\.content/);
    assert.match(pageBlock, /settingsMemoryDirtyState/);
    assert.match(pageBlock, /有未保存修改/);
    assert.match(pageBlock, /草稿已保存/);
    assert.match(pageBlock, /disabled=\{busy \|\| !effective\.enabled \|\| !memoryDraftDirty\}/);
    assert.match(pageBlock, /\{memoryDraftDirty \? '保存' : '已保存'\}/);
    assert.match(css, /\.settingsMemoryDirtyState\[data-dirty="true"\]/);
  });

  it('parses entry cards from the visible MEMORY.md draft while unsaved edits are pending', async () => {
    const src = await readRepo('apps/desktop/src/renderer/settings/SettingsModal.tsx');
    const pageBlock = src.match(/function MemorySettingsPage\([\s\S]*?function MemoryEntryList/)?.[0] ?? '';

    assert.match(src, /parseLocalMemoryMarkdown/);
    assert.match(pageBlock, /const draftMemoryEntries = useMemo\(\(\) => parseLocalMemoryMarkdown\(draft\), \[draft\]\)/);
    assert.match(pageBlock, /const visibleMemoryEntries = memoryDraftDirty \? draftMemoryEntries : effective/);
    assert.match(pageBlock, /visibleMemoryEntries\.activeEntries/);
    assert.match(pageBlock, /visibleMemoryEntries\.archivedEntries/);
    assert.match(pageBlock, /visibleMemoryEntries\.entries\.length > 0/);
    assert.match(pageBlock, /\$\{visibleMemoryEntries\.entries\.length\} 条记忆/);
    assert.match(pageBlock, /memoryDraftDirty \? '草稿 ' : ''/);
  });

  it('shows a clear safe-mode reason when draft entry preview is paused', async () => {
    const src = await readRepo('apps/desktop/src/renderer/settings/SettingsModal.tsx');
    const css = await readRepo('apps/desktop/src/renderer/styles.css');
    const pageBlock = src.match(/function MemorySettingsPage\([\s\S]*?function MemoryEntryList/)?.[0] ?? '';

    assert.match(pageBlock, /const memoryEntryPreviewBlockedReason =/);
    assert.match(pageBlock, /memoryDraftDirty && draftMemoryEntries\.safeMode/);
    assert.match(pageBlock, /草稿过大，条目预览已暂停/);
    assert.match(pageBlock, /settingsMemoryEntryPreviewNotice/);
    assert.match(pageBlock, /role="status"/);
    assert.match(pageBlock, /草稿条目预览暂停/);
    assert.match(css, /\.settingsMemoryEntryPreviewNotice/);
  });

  it('can reload the visible MEMORY.md draft from disk to discard unsaved edits', async () => {
    const src = await readRepo('apps/desktop/src/renderer/settings/SettingsModal.tsx');
    const pageBlock = src.match(/function MemorySettingsPage\([\s\S]*?function MemoryEntryList/)?.[0] ?? '';

    assert.match(pageBlock, /async function reloadDraftFromDisk\(\)/);
    assert.match(pageBlock, /await reload\(\)/);
    assert.match(pageBlock, /已重新载入 MEMORY\.md/);
    assert.match(pageBlock, /未保存的草稿修改已丢弃/);
    assert.match(pageBlock, /onClick=\{\(\) => void reloadDraftFromDisk\(\)\}/);
    assert.match(pageBlock, />\s*重新载入\s*<\/button>/);
  });

  it('can restore the latest MEMORY.md backup through an explicit reversible action', async () => {
    const main = await readRepo('apps/desktop/src/main/main.ts');
    const preload = await readRepo('apps/desktop/src/preload/preload.ts');
    const globalTypes = await readRepo('apps/desktop/src/global.d.ts');
    const service = await readRepo('apps/desktop/src/main/local-memory-service.ts');
    const src = await readRepo('apps/desktop/src/renderer/settings/SettingsModal.tsx');
    const pageBlock = src.match(/function MemorySettingsPage\([\s\S]*?function MemoryEntryList/)?.[0] ?? '';

    assert.match(service, /async restoreLatestBackup/);
    assert.match(service, /\`\$\{this\.file\}\.reset\.bak\`/);
    assert.match(service, /await this\.backup\('restore\.bak'\)/);
    assert.match(service, /copyFile\(backup, this\.file\)/);
    assert.match(service, /没有找到上一版 MEMORY\.md 备份/);
    assert.match(main, /ipcMain\.handle\('memory:restoreLatestBackup'/);
    assert.match(preload, /restoreLatestBackup\(\)/);
    assert.match(preload, /memory:restoreLatestBackup/);
    assert.match(globalTypes, /restoreLatestBackup\(\)/);
    assert.match(pageBlock, /async function restoreLatestBackup/);
    assert.match(pageBlock, /恢复上一版会先备份当前 MEMORY\.md/);
    assert.match(pageBlock, /window\.maka\.memory\.restoreLatestBackup\(\)/);
    assert.match(pageBlock, /已恢复上一版 MEMORY\.md/);
    assert.match(pageBlock, /restore\.bak/);
    assert.match(pageBlock, /恢复上一版/);
  });

  it('shows latest MEMORY.md backup metadata before restore', async () => {
    const core = await readRepo('packages/core/src/local-memory.ts');
    const service = await readRepo('apps/desktop/src/main/local-memory-service.ts');
    const src = await readRepo('apps/desktop/src/renderer/settings/SettingsModal.tsx');
    const css = await readRepo('apps/desktop/src/renderer/styles.css');
    const pageBlock = src.match(/function MemorySettingsPage\([\s\S]*?function MemoryEntryList/)?.[0] ?? '';

    assert.match(core, /interface LocalMemoryBackupInfo/);
    assert.match(core, /readonly kind: 'save' \| 'reset'/);
    assert.match(core, /readonly sizeBytes: number/);
    assert.match(core, /readonly activeEntryCount: number/);
    assert.match(core, /readonly safeMode: boolean/);
    assert.match(core, /readonly latestBackup\?: LocalMemoryBackupInfo/);
    assert.match(core, /readonly backups\?: ReadonlyArray<LocalMemoryBackupInfo>/);
    assert.match(service, /async latestBackupInfo/);
    assert.match(service, /async backupInfos/);
    assert.match(service, /kind: 'save' as const/);
    assert.match(service, /kind: 'reset' as const/);
    assert.match(service, /parseLocalMemoryMarkdown\(await readFile\(backupPath, 'utf8'\)\)/);
    assert.match(pageBlock, /settingsMemoryBackupState/);
    assert.match(pageBlock, /上一版 \{localMemoryBackupKindLabel\(effective\.latestBackup\.kind\)\}/);
    assert.match(pageBlock, /localMemoryBackupSummary\(effective\.latestBackup\)/);
    assert.match(pageBlock, /<RelativeTime ts=\{effective\.latestBackup\.updatedAt\}/);
    assert.match(pageBlock, /等待生成上一版备份/);
    assert.match(pageBlock, /没有可恢复备份/);
    assert.match(pageBlock, /!\s*effective\.latestBackup/);
    assert.match(src, /function localMemoryBackupKindLabel/);
    assert.match(src, /function localMemoryBackupSummary/);
    assert.match(src, /备份过大，无法预览条目/);
    assert.match(src, /\$\{backup\.activeEntryCount\} 条生效/);
    assert.match(src, /重置前备份/);
    assert.match(src, /保存前备份/);
    assert.match(css, /\.settingsMemoryBackupState/);
  });

  it('shows validated MEMORY.md backup candidates as metadata only', async () => {
    const src = await readRepo('apps/desktop/src/renderer/settings/SettingsModal.tsx');
    const css = await readRepo('apps/desktop/src/renderer/styles.css');
    const pageBlock = src.match(/function MemorySettingsPage\([\s\S]*?function MemoryEntryList/)?.[0] ?? '';

    assert.match(pageBlock, /effective\.backups && effective\.backups\.length > 1/);
    assert.match(pageBlock, /settingsMemoryBackupList/);
    assert.match(pageBlock, /备份候选/);
    assert.match(pageBlock, /effective\.backups\.map\(\(backup\) =>/);
    assert.match(pageBlock, /localMemoryBackupKindLabel\(backup\.kind\)/);
    assert.match(pageBlock, /localMemoryBackupSummary\(backup\)/);
    assert.match(pageBlock, /<RelativeTime ts=\{backup\.updatedAt\}/);
    assert.match(pageBlock, /copyBackupReference\(backup\)/);
    assert.match(pageBlock, /复制引用/);
    assert.match(pageBlock, /这里只显示 metadata，不展示备份正文/);
    assert.doesNotMatch(pageBlock, /backup\.content|readFile\(backup/);
    assert.match(css, /\.settingsMemoryBackupList/);
    assert.match(css, /\.settingsMemoryBackupCandidate/);
  });

  it('opens the latest MEMORY.md backup only through a main-process validated path', async () => {
    const main = await readRepo('apps/desktop/src/main/main.ts');
    const preload = await readRepo('apps/desktop/src/preload/preload.ts');
    const globalTypes = await readRepo('apps/desktop/src/global.d.ts');
    const service = await readRepo('apps/desktop/src/main/local-memory-service.ts');
    const src = await readRepo('apps/desktop/src/renderer/settings/SettingsModal.tsx');
    const pageBlock = src.match(/function MemorySettingsPage\([\s\S]*?function MemoryEntryList/)?.[0] ?? '';

    assert.match(service, /async resolveLatestBackupForOpen/);
    assert.match(service, /requireLatestBackupInfo\(\)/);
    assert.match(service, /isInsideOrSamePath\(root, backupPath\)/);
    assert.match(main, /ipcMain\.handle\('memory:openLatestBackup'/);
    assert.match(main, /localMemory\.resolveLatestBackupForOpen\(\)/);
    assert.match(main, /shell\.openPath\(resolved\.path\)/);
    assert.match(main, /localMemoryBackupOpenFailureCopy/);
    assert.match(preload, /openLatestBackup\(\)/);
    assert.match(preload, /memory:openLatestBackup/);
    assert.match(globalTypes, /openLatestBackup\(\)/);
    assert.match(pageBlock, /async function openLatestBackup/);
    assert.match(pageBlock, /window\.maka\.memory\.openLatestBackup\(\)/);
    assert.match(pageBlock, /打开上一版失败/);
    assert.match(pageBlock, />\s*打开上一版\s*<\/button>/);
    assert.match(pageBlock, /!\s*effective\.latestBackup/);
  });

  it('opens a specific MEMORY.md backup candidate by kind without renderer-supplied paths', async () => {
    const main = await readRepo('apps/desktop/src/main/main.ts');
    const preload = await readRepo('apps/desktop/src/preload/preload.ts');
    const globalTypes = await readRepo('apps/desktop/src/global.d.ts');
    const service = await readRepo('apps/desktop/src/main/local-memory-service.ts');
    const src = await readRepo('apps/desktop/src/renderer/settings/SettingsModal.tsx');
    const pageBlock = src.match(/function MemorySettingsPage\([\s\S]*?function MemoryEntryList/)?.[0] ?? '';

    assert.match(service, /async resolveBackupForOpen\(kind: LocalMemoryBackupInfo\['kind'\]\)/);
    assert.match(service, /backupInfos\(\)\)\.find\(\(candidate\) => candidate\.kind === kind\)/);
    assert.match(main, /ipcMain\.handle\('memory:openBackup'/);
    assert.match(main, /kind !== 'save' && kind !== 'reset'/);
    assert.match(main, /localMemory\.resolveBackupForOpen\(kind\)/);
    assert.match(main, /shell\.openPath\(resolved\.path\)/);
    assert.match(preload, /openBackup\(kind: 'save' \| 'reset'\)/);
    assert.match(preload, /memory:openBackup', kind/);
    assert.match(globalTypes, /openBackup\(kind: 'save' \| 'reset'\)/);
    assert.match(pageBlock, /async function openBackupCandidate/);
    assert.match(pageBlock, /window\.maka\.memory\.openBackup\(backup\.kind\)/);
    assert.match(pageBlock, /打开\$\{localMemoryBackupKindLabel\(backup\.kind\)\}失败/);
    assert.match(pageBlock, /openBackupCandidate\(backup\)/);
    assert.match(pageBlock, />\s*打开\s*<\/button>/);
    assert.doesNotMatch(pageBlock, /openBackup\((backup\.path|.*path)/);
  });

  it('can copy a latest MEMORY.md backup reference without exposing backup content', async () => {
    const src = await readRepo('apps/desktop/src/renderer/settings/SettingsModal.tsx');
    const pageBlock = src.match(/function MemorySettingsPage\([\s\S]*?function MemoryEntryList/)?.[0] ?? '';
    const copyBackupBlock = pageBlock.match(/async function copyBackupReference[\s\S]*?\n  }\n\n  async function copyLatestBackupReference/)?.[0] ?? '';

    assert.match(pageBlock, /async function copyBackupReference/);
    assert.match(pageBlock, /async function copyLatestBackupReference/);
    assert.match(pageBlock, /await copyBackupReference\(backup\)/);
    assert.match(copyBackupBlock, /Memory backup: \$\{localMemoryBackupKindLabel\(backup\.kind\)\}/);
    assert.match(copyBackupBlock, /Path: \$\{backup\.path\}/);
    assert.match(copyBackupBlock, /Updated: \$\{new Date\(backup\.updatedAt\)\.toISOString\(\)\}/);
    assert.match(copyBackupBlock, /Entries: \$\{localMemoryBackupSummary\(backup\)\}/);
    assert.match(copyBackupBlock, /Size: \$\{backup\.sizeBytes\} bytes/);
    assert.match(copyBackupBlock, /Safe mode: \$\{backup\.reason \?\? 'oversize'\}/);
    assert.match(copyBackupBlock, /navigator\.clipboard\.writeText\(reference\)/);
    assert.match(copyBackupBlock, /已复制上一版引用/);
    assert.match(pageBlock, />\s*复制上一版引用\s*<\/button>/);
    assert.doesNotMatch(copyBackupBlock, /backup\.content|readFile\(backup/);
  });
});
