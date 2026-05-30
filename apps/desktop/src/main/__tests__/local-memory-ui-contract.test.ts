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

    assert.match(src, /function filterLocalMemoryEntries/);
    assert.match(src, /aria-label="筛选本地记忆"/);
    assert.match(src, /筛选标题、内容、ID 或标签/);
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
    assert.match(src, /props\.archived \? '恢复' : '归档'/);
    assert.match(src, /window\.maka\.memory\.save\(result\.draft\)/);
  });

  it('keeps archive and restore draft-only when MEMORY.md has unsaved edits', async () => {
    const src = await readRepo('apps/desktop/src/renderer/settings/SettingsModal.tsx');
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
    assert.match(listBlock, /props\.draftDirty \? \(props\.archived \? '恢复到草稿' : '归档到草稿'\)/);
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
    const saveBlock = src.match(/async function save\(\) \{[\s\S]*?\n  \}\n\n  async function reset/)?.[0] ?? '';

    assert.match(src, /function formatLocalMemorySaveSummary\(state: LocalMemoryState\)/);
    assert.match(src, /state\.activeEntryCount/);
    assert.match(src, /state\.archivedEntryCount > 0/);
    assert.match(src, /当前 \$\{state\.activeEntryCount\} 条生效/);
    assert.match(src, /已保留上一版备份/);
    assert.match(saveBlock, /formatLocalMemorySaveSummary\(next\)/);
    assert.match(saveBlock, /已保存并遮蔽敏感字段/);
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
});
