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
    assert.match(src, /effective\.archivedEntries\.length > 0/);
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
    assert.match(css, /\.settingsMemoryEntryFacts/);
  });

  it('filters memory entries locally across title content origin and tags', async () => {
    const src = await readRepo('apps/desktop/src/renderer/settings/SettingsModal.tsx');

    assert.match(src, /function filterLocalMemoryEntries/);
    assert.match(src, /aria-label="筛选本地记忆"/);
    assert.match(src, /筛选标题、内容或标签/);
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
    assert.match(src, />\s*\{props\.archived \? '恢复' : '归档'\}\s*<\/button>/);
    assert.match(src, /window\.maka\.memory\.save\(result\.draft\)/);
  });

  it('uses stopped-update copy for invalid memory entry ids instead of raw missing-field wording', async () => {
    const src = await readRepo('apps/desktop/src/renderer/settings/SettingsModal.tsx');

    assert.match(src, /这条记忆没有可识别 ID，已停止更新。/);
    assert.doesNotMatch(src, /这条记忆缺少可识别的 ID/);
  });

  it('tells the user when saving MEMORY.md redacted sensitive fields', async () => {
    const src = await readRepo('apps/desktop/src/renderer/settings/SettingsModal.tsx');
    const saveBlock = src.match(/async function save\(\) \{[\s\S]*?\n  \}\n\n  async function reset/)?.[0] ?? '';

    assert.match(saveBlock, /const redacted = next\.content !== draft/);
    assert.match(saveBlock, /已保存并遮蔽敏感字段/);
    assert.match(saveBlock, /token、API key 或密码/);
  });
});
