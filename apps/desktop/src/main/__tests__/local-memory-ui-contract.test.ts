import { strict as assert } from 'node:assert';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { readRendererContractCss } from './contract-css-helpers.js';
import { readSettingsCombinedSource } from './settings-contract-source-helpers.js';
import { readMainProcessCombinedSource } from './main-process-contract-source-helpers.js';

const REPO_ROOT = join(process.cwd(), '..', '..');

async function readRepo(path: string): Promise<string> {
  return readFile(join(REPO_ROOT, path), 'utf8');
}

describe('local MEMORY.md Settings UI contract', () => {
  it('wires every behavior-bearing controller output at the page composition root', async () => {
    const page = await readRepo('apps/desktop/src/renderer/settings/memory-settings-page.tsx');

    assert.match(page, /<WorkspaceInstructionsSection[\s\S]*state=\{workspaceInstructions\.state\}[\s\S]*disabled=\{memoryControlsDisabled\}[\s\S]*isActionPending=\{workspaceInstructions\.isActionPending\}[\s\S]*onOpen=\{workspaceInstructions\.openFile\}[\s\S]*onCreate=\{workspaceInstructions\.createFile\}/);
    assert.match(page, /<MemoryPromptPreviewSection[\s\S]*active=\{promptPreviewWillInject\}[\s\S]*preview=\{localMemoryPromptPreview\}[\s\S]*budgetLabel=\{localMemoryPromptPreviewBudgetLabel\}[\s\S]*blockedReason=\{promptPreviewBlockedReason\}[\s\S]*safeMode=\{effective\.status === 'safe_mode'\}[\s\S]*copyPending=\{isMemoryActionPending\('memory:prompt-preview:copy'\)\}[\s\S]*onCopy=\{copyLocalMemoryPromptPreview\}/);

    const entryLists = [...page.matchAll(/<MemoryEntryList[\s\S]*?\/>/g)].map((match) => match[0]);
    assert.equal(entryLists.length, 2, 'active and archived entry lists must both be wired');
    for (const list of entryLists) {
      assert.match(list, /filtered=\{normalizedMemoryEntryQuery\.length > 0\}/);
      assert.match(list, /draftDirty=\{memoryDraftDirty\}/);
      assert.match(list, /busy=\{memoryControlsDisabled \|\| effective\.status === 'incognito_blocked' \|\| !effective\.enabled\}/);
      assert.match(list, /pendingCopyIds=\{pendingMemoryActions\}/);
      assert.match(list, /onCopyReference=\{copyMemoryEntryReference\}/);
      assert.match(list, /onFocusDraft=\{focusMemoryEntryInDraft\}/);
      assert.match(list, /onStatusChange=\{updateMemoryEntryStatus\}/);
    }
    const [activeList, archivedList] = entryLists;
    assert.match(activeList, /title="生效记忆"/);
    assert.match(activeList, /entries=\{filteredActiveEntries\}/);
    assert.doesNotMatch(activeList, /\n\s+archived(?:\s|\n)/);
    assert.match(archivedList, /title="已归档记忆"/);
    assert.match(archivedList, /entries=\{filteredArchivedEntries\}/);
    assert.match(archivedList, /\n\s+archived(?:\s|\n)/);
  });

  it('renders active and archived memory entries as separate visible groups', async () => {
    const src = await readSettingsCombinedSource();

    assert.match(src, /<MemoryEntryList[\s\S]*title="生效记忆"[\s\S]*entries=\{filteredActiveEntries\}/);
    assert.match(src, /<MemoryEntryList[\s\S]*title="已归档记忆"[\s\S]*entries=\{filteredArchivedEntries\}[\s\S]*archived/);
    assert.match(src, /<div className="settingsMemoryManualAdd" role="group" aria-label="手动添加本地记忆">/);
    assert.doesNotMatch(src, /<div className="settingsMemoryManualAdd" aria-label="手动添加本地记忆">/);
    assert.match(src, /visibleMemoryEntries\.archivedEntries\.length > 0/);
    assert.ok(src.includes("entry.tags.join(' / ')"));
  });

  it('renders stable entry metadata so local memory stays white-box', async () => {
    const src = await readSettingsCombinedSource();
    const css = await readRendererContractCss();
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
    const src = await readSettingsCombinedSource();
    const pageBlock = src.match(/function MemorySettingsPage\([\s\S]*?function MemoryEntryList/)?.[0] ?? '';
    const listBlock = src.match(/function MemoryEntryList\([\s\S]*?function filterLocalMemoryEntries/)?.[0] ?? '';

    assert.match(pageBlock, /async function copyMemoryEntryReference/);
    assert.match(pageBlock, /Memory entry: \$\{entry\.title\}/);
    assert.match(pageBlock, /ID: \$\{entry\.id\}/);
    assert.match(pageBlock, /Status: \$\{memoryEntryStatusLabel\(entry\.status\)\}/);
    assert.match(pageBlock, /runMemoryAction\(`entry:\$\{entry\.id\}:copy`/);
    assert.match(pageBlock, /navigator\.clipboard\.writeText\(reference\)/);
    assert.match(pageBlock, /toast\.success\('已复制记忆引用', entry\.id\)/);
    assert.match(pageBlock, /toast\.error\('复制失败', '剪贴板不可用或被系统拒绝。'\)/);
    assert.match(listBlock, /onCopyReference/);
    assert.match(listBlock, /pendingCopyIds\?: ReadonlySet<string>/);
    assert.match(listBlock, /const copyPending = props\.pendingCopyIds\?\.has\(`entry:\$\{entry\.id\}:copy`\) \?\? false/);
    assert.match(listBlock, /disabled=\{copyPending\}/);
    assert.match(listBlock, /copyPending \? '复制中…' : '复制引用'/);
    assert.match(src, /function memoryEntryStatusLabel/);
  });

  it('can focus a memory entry in the visible MEMORY.md draft editor', async () => {
    const src = await readSettingsCombinedSource();
    const pageBlock = src.match(/function MemorySettingsPage\([\s\S]*?function MemoryEntryList/)?.[0] ?? '';
    const listBlock = src.match(/function MemoryEntryList\([\s\S]*?function filterLocalMemoryEntries/)?.[0] ?? '';

    assert.match(src, /findLocalMemoryEntryDraftRange/);
    assert.match(pageBlock, /function focusMemoryEntryInDraft/);
    assert.match(pageBlock, /findLocalMemoryEntryDraftRange\(draft, entry\.id\)/);
    assert.match(pageBlock, /editorRef\.current\?\.setSelectionRange\(range\.start, range\.end\)/);
    assert.match(pageBlock, /editorRef\.current\?\.scrollIntoView\(\{\s*block: 'center',\s*behavior: 'smooth',?\s*\}\)/);
    assert.match(pageBlock, /无法定位记忆/);
    assert.match(listBlock, /onFocusDraft/);
    assert.match(listBlock, /定位草稿/);
  });

  it('previews the send-time memory prompt context from the core helper', async () => {
    const src = await readSettingsCombinedSource();
    const page = await readRepo('apps/desktop/src/renderer/settings/memory-settings-page.tsx');
    const css = await readRendererContractCss();
    const pageBlock = src.match(/function MemorySettingsPage\([\s\S]*?function MemoryEntryList/)?.[0] ?? '';

    assert.match(src, /LOCAL_MEMORY_PROMPT_MAX_CHARS/);
    assert.match(src, /buildLocalMemoryPromptBody/);
    assert.match(pageBlock, /const localMemoryPromptPreview = buildLocalMemoryPromptBody\(input\.draft\) \?\? ''/);
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
    assert.match(pageBlock, /<pre>\{props\.preview\}<\/pre>/);
    assert.match(pageBlock, /async function copyLocalMemoryPromptPreview/);
    assert.match(pageBlock, /runMemoryAction\('memory:prompt-preview:copy'/);
    assert.match(pageBlock, /navigator\.clipboard\.writeText\(localMemoryPromptPreview\)/);
    assert.match(pageBlock, /已复制模型上下文预览/);
    assert.match(pageBlock, /props\.copyPending \? '复制中…' : '复制上下文'/);
    assert.match(pageBlock, /disabled=\{!props\.preview \|\| props\.copyPending\}/);
    assert.match(page, /preview=\{localMemoryPromptPreview\}/);
    assert.match(page, /onCopy=\{copyLocalMemoryPromptPreview\}/);
    assert.match(css, /\.settingsMemoryPromptPreview/);
    assert.match(css, /\.settingsMemoryPromptPreviewBudget/);
  });

  it('filters memory entries locally across title content id origin timestamps and tags', async () => {
    const src = await readSettingsCombinedSource();
    const css = await readRendererContractCss();
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
    // PR-MEMORY-ENTRY-LIST-A11Y-0 (round 18/30): list container
    // switched from `<div role="list">` to semantic `<ul>`; rows
    // wrapped in `<li>` (the inner `<article>` per row stays
    // because articles are valid sectioning content inside list
    // items). aria-label is preserved.
    assert.match(src, /<ul className="settingsMemoryEntryList" aria-label=\{`\$\{props\.title\}列表`\}>/);
    assert.match(src, /<li key=\{entry\.id\}>[\s\S]*?<article className="settingsMemoryEntryCard">/);
    assert.match(src, /<div className="settingsMemoryEntryActions" role="group" aria-label=\{`\$\{entry\.title\}记忆操作`\}>/);
    assert.doesNotMatch(src, /<div className="settingsMemoryEntryActions">\s*\{props\.onCopyReference && \(/);
  });

  it('keeps archived entries visually available without using hidden placeholder copy', async () => {
    const css = await readRendererContractCss();

    assert.match(css, /\.settingsMemoryEntryGroup\[data-archived="true"\]/);
    assert.doesNotMatch(css, /coming soon|todo|not implemented/i);
  });

  it('describes agent memory reads as a current send-time prompt boundary', async () => {
    const src = await readSettingsCombinedSource();
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
    const src = await readSettingsCombinedSource();
    const memoryPage = src.match(/function MemorySettingsPage\([\s\S]*?function MemoryEntryList/);

    assert.ok(memoryPage, 'Memory settings page block must exist');
    assert.match(memoryPage![0], /等待创建 MEMORY\.md/);
    assert.doesNotMatch(
      memoryPage![0],
      /MEMORY\.md 尚未创建/,
      'Missing MEMORY.md copy should read as an actionable create state, not unfinished implementation copy',
    );
  });

  it('gives repeated workspace-instruction row actions file-specific accessible names', async () => {
    const src = await readSettingsCombinedSource();
    const page = await readRepo('apps/desktop/src/renderer/settings/memory-settings-page.tsx');
    const memoryPage = src.match(/function MemorySettingsPage\([\s\S]*?function MemoryEntryList/)?.[0] ?? '';

    assert.match(memoryPage, /aria-label=\{`打开项目指令文件 \$\{file\.file\}`\}/);
    assert.match(memoryPage, /aria-label=\{`创建项目指令文件 \$\{file\.file\}`\}/);
    assert.match(memoryPage, /props\.onOpen\(file\.file\)/);
    assert.match(memoryPage, /props\.onCreate\(file\.file\)/);
    assert.match(page, /onOpen=\{workspaceInstructions\.openFile\}/);
    assert.match(page, /onCreate=\{workspaceInstructions\.createFile\}/);
  });

  it('gates local memory file actions with visible per-action pending feedback', async () => {
    const src = await readSettingsCombinedSource();
    const memoryPage = src.match(/function MemorySettingsPage\([\s\S]*?function MemoryEntryList/)?.[0] ?? '';

    assert.match(memoryPage, /const memoryActionGuard = useKeyedActionGuard<string>\(\)/);
    assert.match(memoryPage, /async function runMemoryAction<T>\([\s\S]*key: string,[\s\S]*action: \(isCurrent: \(\) => boolean\) => Promise<T>,/);
    assert.match(memoryPage, /const release = memoryActionGuard\.begin\(key\);/);
    assert.match(memoryPage, /if \(!release\) return undefined;/);
    assert.match(memoryPage, /finally \{[\s\S]*release\(\);/);
    assert.match(memoryPage, /const isMemoryActionPending = \(key: string\) => pendingMemoryActions\.has\(key\)/);

    assert.match(memoryPage, /runAction\(`instruction:\$\{file\}:open`/);
    assert.match(memoryPage, /runWriteAction\(`instruction:\$\{file\}:create`/);
    assert.match(memoryPage, /runMemoryAction\(`backup:\$\{backup\.kind\}:open`/);
    assert.match(memoryPage, /runMemoryAction\(`backup:\$\{backup\.kind\}:restore`/);
    assert.match(memoryPage, /runMemoryAction\(`backup:\$\{backup\.kind\}:copy`/);
    assert.match(memoryPage, /runMemoryAction\('memory:file:open'/);
    assert.match(memoryPage, /runMemoryAction\('memory:folder:open'/);
    assert.match(memoryPage, /runMemoryAction\('backup:latest:open'/);
    assert.match(memoryPage, /runMemoryAction\('backup:latest:restore'/);
    assert.match(memoryPage, /runMemoryAction\('memory:path:copy'/);
    assert.match(memoryPage, /<div className="settingsActionRow" role="group" aria-label="MEMORY\.md 文件操作">/);
    assert.doesNotMatch(memoryPage, /<div className="settingsActionRow">\s*<button type="button" className="maka-button" disabled=\{memoryControlsDisabled \|\| !effective\.enabled \|\| !memoryDraftDirty\}/);

    assert.match(memoryPage, /disabled=\{props\.disabled \|\| props\.isActionPending\(`instruction:\$\{file\.file\}:open`\)\}/);
    assert.match(memoryPage, /props\.isActionPending\(`instruction:\$\{file\.file\}:open`\) \? '打开中…' : '打开'/);
    assert.match(memoryPage, /props\.isActionPending\(`instruction:\$\{file\.file\}:create`\) \? '创建中…' : '创建'/);
    assert.match(memoryPage, /isMemoryActionPending\(`backup:\$\{backup\.kind\}:open`\) \? '打开中…' : '打开'/);
    assert.match(memoryPage, /isMemoryActionPending\(`backup:\$\{backup\.kind\}:restore`\) \? '恢复中…' : '恢复'/);
    assert.match(memoryPage, /isMemoryActionPending\(`backup:\$\{backup\.kind\}:copy`\) \? '复制中…' : '复制引用'/);
    assert.match(memoryPage, /isMemoryActionPending\('memory:file:open'\) \? '打开中…' : '打开 MEMORY\.md'/);
    assert.match(memoryPage, /isMemoryActionPending\('backup:latest:restore'\) \? '恢复中…' : '恢复上一版'/);
  });

  it('gates local memory write actions with one synchronous busy owner', async () => {
    const src = await readSettingsCombinedSource();
    const memoryPage = src.match(/function MemorySettingsPage\([\s\S]*?function MemoryEntryList/)?.[0] ?? '';

    assert.match(memoryPage, /type MemoryWriteAction =[\s\S]*'save'[\s\S]*'reset'[\s\S]*'restore'[\s\S]*'entry-status'/);
    assert.match(memoryPage, /const \[pendingMemoryWriteAction, setPendingMemoryWriteAction\] = useState<MemoryWriteAction \| null>\(null\)/);
    assert.match(memoryPage, /const memoryActionGuard = useKeyedActionGuard<string>\(\)/);
    assert.match(
      memoryPage,
      /async function runMemoryWriteAction<T>\([\s\S]*action: MemoryWriteAction,[\s\S]*run: \(isCurrent: \(\) => boolean\) => Promise<T>,[\s\S]*const releaseWrite = memoryActionGuard\.begin\('write'\);[\s\S]*if \(!releaseWrite\) return undefined;[\s\S]*setPendingMemoryWriteAction\(action\);[\s\S]*setBusy\(true\);/,
      'local memory writes must set a synchronous busy guard before awaiting file/settings writes',
    );
    assert.match(
      memoryPage,
      /finally \{[\s\S]*releaseWrite\(\);[\s\S]*setPendingMemoryWriteAction\(null\);[\s\S]*setBusy\(false\);[\s\S]*\}/,
      'local memory write guard must always release after success or failure',
    );
    assert.match(memoryPage, /await runMemoryWriteAction\('reload'/);
    assert.match(memoryPage, /await runMemoryWriteAction\('enable'/);
    assert.match(memoryPage, /await runMemoryWriteAction\('agent-read'/);
    assert.match(memoryPage, /await runMemoryWriteAction\('save'/);
    assert.match(memoryPage, /await runMemoryWriteAction\('reset'/);
    assert.match(memoryPage, /await runMemoryWriteAction\('restore'/);
    assert.match(memoryPage, /await runMemoryWriteAction\('entry-status'/);
    assert.match(memoryPage, /useWorkspaceInstructionsController/);
    assert.match(memoryPage, /pendingMemoryWriteAction === 'save' \? '保存中…' : memoryDraftDirty \? '保存' : '已保存'/);
    assert.match(memoryPage, /pendingMemoryWriteAction === 'reload' \? '载入中…' : '重新载入'/);
    assert.match(memoryPage, /pendingMemoryWriteAction === 'reset' \? '重置中…' : '重置并备份'/);
  });

  it('drops late local memory reload and pending cleanup after Settings is closed', async () => {
    const src = await readSettingsCombinedSource();
    const memoryPage = src.match(/function MemorySettingsPage\([\s\S]*?function MemoryEntryList/)?.[0] ?? '';
    const reloadBlock = memoryPage.match(/async function reload\(\)[\s\S]*?async function reloadDraftFromDisk/)?.[0] ?? '';
    const enableBlock = memoryPage.match(/async function setEnabled\(enabled: boolean\)[\s\S]*?async function setAgentReadEnabled/)?.[0] ?? '';
    const agentReadBlock = memoryPage.match(/async function setAgentReadEnabled[\s\S]*?async function save/)?.[0] ?? '';
    const saveBlock = memoryPage.match(/async function save\(\)[\s\S]*?async function reset/)?.[0] ?? '';
    const resetBlock = memoryPage.match(/async function reset\(\)[\s\S]*?async function restoreLatestBackup/)?.[0] ?? '';
    const restoreLatestBlock = memoryPage.match(/async function restoreLatestBackup\(\)[\s\S]*?async function restoreBackupCandidate/)?.[0] ?? '';
    const restoreCandidateBlock = memoryPage.match(/async function restoreBackupCandidate[\s\S]*?async function openFile/)?.[0] ?? '';
    const openFileBlock = memoryPage.match(/async function openFile\(\)[\s\S]*?async function openLatestBackup/)?.[0] ?? '';
    const openLatestBlock = memoryPage.match(/async function openLatestBackup\(\)[\s\S]*?async function openBackupCandidate/)?.[0] ?? '';
    const openCandidateBlock = memoryPage.match(/async function openBackupCandidate[\s\S]*?async function openFolder/)?.[0] ?? '';
    const openFolderBlock = memoryPage.match(/async function openFolder\(\)[\s\S]*?async function copyPath/)?.[0] ?? '';
    const openInstructionBlock = memoryPage.match(/async function openFile\(file: string\)[\s\S]*?async function createFile/)?.[0] ?? '';
    const createInstructionBlock = memoryPage.match(/async function createFile[\s\S]*?return \{/)?.[0] ?? '';
    const copyPathBlock = memoryPage.match(/async function copyPath\(\)[\s\S]*?async function copyBackupReference/)?.[0] ?? '';
    const copyBackupBlock = memoryPage.match(/async function copyBackupReference[\s\S]*?async function copyLatestBackupReference/)?.[0] ?? '';
    const copyEntryBlock = memoryPage.match(/async function copyMemoryEntryReference[\s\S]*?function focusMemoryEntryInDraft/)?.[0] ?? '';
    const updateStatusBlock = memoryPage.match(/async function updateMemoryEntryStatus[\s\S]*?\n  }\n\n  const viewModel =/)?.[0] ?? '';
    const promptPreviewCopyBlock = memoryPage.match(/async function copyLocalMemoryPromptPreview\(\)[\s\S]*?return \{/)?.[0] ?? '';
    const writeActionBlock = memoryPage.match(/async function runMemoryWriteAction<T>[\s\S]*?async function runMemoryAction/)?.[0] ?? '';
    const actionBlock = memoryPage.match(/async function runMemoryAction<T>[\s\S]*?async function reload/)?.[0] ?? '';

    assert.match(memoryPage, /const memoryPageMountedRef = useRef\(false\)/);
    assert.match(memoryPage, /const memoryPageLifecycleRef = useRef\(0\)/);
    assert.match(memoryPage, /const memoryReloadTicketRef = useRef\(0\)/);
    assert.match(
      memoryPage,
      /useEffect\(\(\) => \{[\s\S]*memoryPageLifecycleRef\.current \+= 1;[\s\S]*memoryPageMountedRef\.current = true;[\s\S]*const lifecycle = memoryPageLifecycleRef\.current;[\s\S]*return \(\) => \{[\s\S]*memoryPageMountedRef\.current = false;[\s\S]*memoryReloadTicketRef\.current \+= 1;/,
      'Memory page cleanup must invalidate reloads (the shared keyed guard hook releases pending owners on unmount)',
    );
    assert.match(
      memoryPage,
      /function isMemoryPageCurrent\(lifecycle: number\): boolean \{[\s\S]*return memoryPageMountedRef\.current && memoryPageLifecycleRef\.current === lifecycle;/,
      'Memory page lifecycle checks must be StrictMode-safe, not just a mounted boolean',
    );
    assert.match(
      reloadBlock,
      /const lifecycle = memoryPageLifecycleRef\.current;[\s\S]*const ticket = \+\+memoryReloadTicketRef\.current;[\s\S]*await window\.maka\.memory\.getState\(\);[\s\S]*if \(!isMemoryPageCurrent\(lifecycle\) \|\| ticket !== memoryReloadTicketRef\.current\) return false;[\s\S]*setState\(next\);/,
      'Local memory reload must not write loaded state after unmount or a stale reload ticket',
    );
    assert.match(
      reloadBlock,
      /catch \(error\) \{[\s\S]*if \(isMemoryPageCurrent\(lifecycle\) && ticket === memoryReloadTicketRef\.current\) \{[\s\S]*toast\.error\('载入本地记忆失败', settingsActionErrorMessage\(error\)\);/,
      'Local memory reload errors must not toast after Settings closes',
    );
    assert.match(
      reloadBlock,
      /finally \{[\s\S]*if \(isMemoryPageCurrent\(lifecycle\) && ticket === memoryReloadTicketRef\.current\) \{[\s\S]*setLoadingMemory\(false\);/,
      'Local memory reload must not clear loading state after unmount',
    );
    assert.match(
      writeActionBlock,
      /const lifecycle = memoryPageLifecycleRef\.current;[\s\S]*return await run\(\(\) => isMemoryPageCurrent\(lifecycle\)\);[\s\S]*catch \(error\) \{[\s\S]*if \(!isMemoryPageCurrent\(lifecycle\)\) return undefined;[\s\S]*finally \{[\s\S]*releaseWrite\(\);[\s\S]*if \(isMemoryPageCurrent\(lifecycle\)\) \{[\s\S]*setPendingMemoryWriteAction\(null\);[\s\S]*setBusy\(false\);/,
      'Memory write wrapper must release the guard but not write pending state after unmount',
    );
    assert.match(enableBlock, /await runMemoryWriteAction\('enable', async \(isCurrent\) => \{[\s\S]*await props\.onReloadSettings\(\);[\s\S]*if \(!isCurrent\(\)\) return;[\s\S]*setState\(next\);/);
    assert.match(agentReadBlock, /await runMemoryWriteAction\('agent-read', async \(isCurrent\) => \{[\s\S]*await props\.onReloadSettings\(\);[\s\S]*if \(!isCurrent\(\)\) return;[\s\S]*setState\(next\);/);
    assert.match(saveBlock, /await runMemoryWriteAction\('save', async \(isCurrent\) => \{[\s\S]*const next = await window\.maka\.memory\.save\(draft\);[\s\S]*if \(!isCurrent\(\)\) return;[\s\S]*setState\(next\);/);
    assert.match(resetBlock, /await runMemoryWriteAction\('reset', async \(isCurrent\) => \{[\s\S]*const next = await window\.maka\.memory\.reset\(\);[\s\S]*if \(!isCurrent\(\)\) return;[\s\S]*setState\(next\);/);
    assert.match(restoreLatestBlock, /await runMemoryWriteAction\('restore', async \(isCurrent\) => \{[\s\S]*if \(!isCurrent\(\)\) return;[\s\S]*const result = await window\.maka\.memory\.restoreLatestBackup\(\);[\s\S]*if \(!isCurrent\(\)\) return;[\s\S]*setState\(result\.state\);/);
    assert.match(restoreCandidateBlock, /await runMemoryWriteAction\('restore', async \(isCurrent\) => \{[\s\S]*if \(!isCurrent\(\)\) return;[\s\S]*const result = await window\.maka\.memory\.restoreBackup\(backup\.kind\);[\s\S]*if \(!isCurrent\(\)\) return;[\s\S]*setState\(result\.state\);/);
    assert.match(createInstructionBlock, /await runWriteAction\(`instruction:\$\{file\}:create`, async \(isActionCurrent\) => \{[\s\S]*const result = await window\.maka\.workspaceInstructions\.createFile\(file\);[\s\S]*if \(!isActionCurrent\(\)\) return;[\s\S]*const refreshed = await reload\(\);/);
    assert.match(updateStatusBlock, /await runMemoryWriteAction\('entry-status', async \(isCurrent\) => \{[\s\S]*const next = await window\.maka\.memory\.save\(result\.draft\);[\s\S]*if \(!isCurrent\(\)\) return;[\s\S]*setState\(next\);/);
    assert.match(
      actionBlock,
      /action: \(isCurrent: \(\) => boolean\) => Promise<T>,[\s\S]*const lifecycle = memoryPageLifecycleRef\.current;[\s\S]*return await action\(\(\) => isMemoryPageCurrent\(lifecycle\)\);[\s\S]*catch \(error\) \{[\s\S]*if \(!isMemoryPageCurrent\(lifecycle\)\) return undefined;[\s\S]*finally \{[\s\S]*release\(\);[\s\S]*if \(isMemoryPageCurrent\(lifecycle\)\) \{[\s\S]*setPendingMemoryActions/,
      'Memory file-action wrapper must release the guard but not write pending state after unmount',
    );
    assert.match(openFileBlock, /await runMemoryAction\('memory:file:open', async \(isCurrent\) => \{[\s\S]*const result = await window\.maka\.memory\.openFile\(\);[\s\S]*if \(!isCurrent\(\)\) return;[\s\S]*if \(!result\.ok\) toast\.error/);
    assert.match(openLatestBlock, /await runMemoryAction\('backup:latest:open', async \(isCurrent\) => \{[\s\S]*const result = await window\.maka\.memory\.openLatestBackup\(\);[\s\S]*if \(!isCurrent\(\)\) return;[\s\S]*if \(!result\.ok\) toast\.error/);
    assert.match(openCandidateBlock, /await runMemoryAction\(`backup:\$\{backup\.kind\}:open`, async \(isCurrent\) => \{[\s\S]*const result = await window\.maka\.memory\.openBackup\(backup\.kind\);[\s\S]*if \(!isCurrent\(\)\) return;[\s\S]*if \(!result\.ok\)/);
    assert.match(openFolderBlock, /await runMemoryAction\('memory:folder:open', async \(isCurrent\) => \{[\s\S]*const result = await window\.maka\.app\.openPath\('memory'\);[\s\S]*if \(!isCurrent\(\)\) return;[\s\S]*if \(!result\.ok\)/);
    assert.match(openInstructionBlock, /await runAction\(`instruction:\$\{file\}:open`, async \(isActionCurrent\) => \{[\s\S]*const result = await window\.maka\.workspaceInstructions\.openFile\(file\);[\s\S]*if \(isActionCurrent\(\) && !result\.ok\)/);
    assert.match(createInstructionBlock, /await runWriteAction\(`instruction:\$\{file\}:create`, async \(isActionCurrent\) => \{[\s\S]*catch \(error\) \{[\s\S]*if \(isActionCurrent\(\)\) toast\.error\('创建项目指令失败', settingsActionErrorMessage\(error\)\);/);
    assert.match(copyPathBlock, /await navigator\.clipboard\.writeText\(state\.path\);[\s\S]*if \(isCurrent\(\)\) toast\.success\('已复制路径', state\.path\);[\s\S]*catch \{[\s\S]*if \(isCurrent\(\)\) toast\.error\('复制失败'/);
    assert.match(copyBackupBlock, /await navigator\.clipboard\.writeText\(reference\);[\s\S]*if \(isCurrent\(\)\) toast\.success\('已复制上一版引用'/);
    assert.match(copyEntryBlock, /await navigator\.clipboard\.writeText\(reference\);[\s\S]*if \(isCurrent\(\)\) toast\.success\('已复制记忆引用', entry\.id\);/);
    assert.match(promptPreviewCopyBlock, /await navigator\.clipboard\.writeText\(localMemoryPromptPreview\);[\s\S]*if \(isCurrent\(\)\) toast\.success\('已复制模型上下文预览'/);
  });

  it('manual add stays draft-only and routes through the core helper', async () => {
    const src = await readSettingsCombinedSource();
    const manualAddBlock = src.match(/function addManualMemoryDraftEntry\(\) \{[\s\S]*?\n  \}\n\n  async function updateMemoryEntryStatus/)?.[0] ?? '';

    assert.match(src, /appendManualLocalMemoryEntryDraft\(draft/);
    assert.match(src, /tags:\s*newMemoryTags\.split\(', '\)|tags:\s*newMemoryTags\.split\(','/);
    assert.match(src, /aria-label="记忆标签"/);
    assert.match(src, /已添加到草稿/);
    assert.match(src, /确认文件内容后点击保存/);
    assert.doesNotMatch(manualAddBlock, /window\.maka\.memory\.save\(result\.draft\)/);
  });

  it('can archive and restore visible memory entries without hand-editing metadata', async () => {
    const src = await readSettingsCombinedSource();

    assert.match(src, /setLocalMemoryEntryStatusDraft\(draft/);
    assert.match(src, /onStatusChange=\{updateMemoryEntryStatus\}/);
    assert.match(src, /const statusActionLabel = props\.draftDirty/);
    assert.match(src, /:\s*props\.archived\s*\?\s*'恢复'\s*:\s*'归档';/);
    assert.match(src, /window\.maka\.memory\.save\(result\.draft\)/);
  });

  it('keeps archive and restore draft-only when MEMORY.md has unsaved edits', async () => {
    const src = await readSettingsCombinedSource();
    const css = await readRendererContractCss();
    const updateBlock = src.match(/async function updateMemoryEntryStatus[\s\S]*?\n  }\n\n  const viewModel =/)?.[0] ?? '';
    const listBlock = src.match(/function MemoryEntryList\([\s\S]*?function filterLocalMemoryEntries/)?.[0] ?? '';

    assert.match(updateBlock, /if \(memoryDraftDirty\) \{/);
    assert.match(updateBlock, /setDraft\(result\.draft\)/);
    assert.match(updateBlock, /已在草稿中归档记忆/);
    assert.match(updateBlock, /已在草稿中恢复记忆/);
    assert.match(updateBlock, /确认文件内容后点击保存/);
    assert.match(updateBlock, /return;\n    }\n\n    try \{[\s\S]*await runMemoryWriteAction\('entry-status'/);
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
    const src = await readSettingsCombinedSource();

    assert.match(src, /这条记忆没有可识别 ID，已停止更新。/);
    assert.doesNotMatch(src, /这条记忆缺少可识别的 ID/);
  });

  it('tells the user when saving MEMORY.md redacted sensitive fields', async () => {
    const src = await readSettingsCombinedSource();
    const css = await readRendererContractCss();
    const saveBlock = src.match(/async function save\(\) \{[\s\S]*?\n  \}\n\n  async function reset/)?.[0] ?? '';
    const pageBlock = src.match(/function MemorySettingsPage\([\s\S]*?function MemoryEntryList/)?.[0] ?? '';

    assert.match(saveBlock, /const redacted = next\.content !== draft/);
    assert.match(saveBlock, /已保存并遮蔽敏感字段/);
    assert.match(saveBlock, /token、API key 或密码/);
    assert.match(pageBlock, /memoryDraftHasSensitiveFields: redactSecrets\(input\.draft\) !== input\.draft/);
    assert.match(pageBlock, /settingsMemoryDraftWarning/);
    assert.match(pageBlock, /role="status"/);
    assert.match(pageBlock, /草稿含疑似敏感字段/);
    assert.match(pageBlock, /保存时会先遮蔽疑似 token、API key 或密码，再写入 MEMORY\.md/);
    assert.match(css, /\.settingsMemoryDraftWarning/);
  });

  it('summarizes parsed memory entry counts after save', async () => {
    const src = await readSettingsCombinedSource();
    const css = await readRendererContractCss();
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
    assert.match(pageBlock, /setLastSaveSummary\(\{\s*title: '已保存 MEMORY\.md',\s*detail,\s*savedAt: Date\.now\(\),?\s*\}\)/);
    assert.match(pageBlock, /settingsMemorySaveSummary/);
    assert.match(pageBlock, /settingsMemorySaveSummaryTime/);
    assert.match(pageBlock, /保存于 <RelativeTime ts=\{lastSaveSummary\.savedAt\}/);
    assert.match(pageBlock, /lastSaveSummary && !memoryDraftDirty/);
    assert.match(css, /\.settingsMemorySaveSummary/);
    assert.match(css, /\.settingsMemorySaveSummaryTime/);
    assert.match(css, /var\(--success\)/);
  });

  it('shows whether the visible MEMORY.md draft has unsaved changes', async () => {
    const src = await readSettingsCombinedSource();
    const css = await readRendererContractCss();
    const pageBlock = src.match(/function MemorySettingsPage\([\s\S]*?function MemoryEntryList/)?.[0] ?? '';

    assert.match(pageBlock, /const memoryDraftDirty = input\.draft !== effective\.content/);
    assert.match(pageBlock, /settingsMemoryDirtyState/);
    assert.match(pageBlock, /有未保存修改/);
    assert.match(pageBlock, /草稿已保存/);
    assert.match(pageBlock, /disabled=\{memoryControlsDisabled \|\| !effective\.enabled \|\| !memoryDraftDirty\}/);
    assert.match(pageBlock, /pendingMemoryWriteAction === 'save' \? '保存中…' : memoryDraftDirty \? '保存' : '已保存'/);
    assert.match(css, /\.settingsMemoryDirtyState\[data-dirty="true"\]/);
  });

  it('parses entry cards from the visible MEMORY.md draft while unsaved edits are pending', async () => {
    const src = await readSettingsCombinedSource();
    const pageBlock = src.match(/function MemorySettingsPage\([\s\S]*?function MemoryEntryList/)?.[0] ?? '';

    assert.match(src, /parseLocalMemoryMarkdown/);
    assert.match(pageBlock, /const draftMemoryEntries = parseLocalMemoryMarkdown\(input\.draft\)/);
    assert.match(pageBlock, /const visibleMemoryEntries = memoryDraftDirty \? draftMemoryEntries : effective/);
    assert.match(pageBlock, /visibleMemoryEntries\.activeEntries/);
    assert.match(pageBlock, /visibleMemoryEntries\.archivedEntries/);
    assert.match(pageBlock, /visibleMemoryEntries\.entries\.length > 0/);
    assert.match(pageBlock, /\$\{visibleMemoryEntries\.entries\.length\} 条记忆/);
    assert.match(pageBlock, /memoryDraftDirty \? '草稿 ' : ''/);
  });

  it('shows a clear safe-mode reason when draft entry preview is paused', async () => {
    const src = await readSettingsCombinedSource();
    const css = await readRendererContractCss();
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
    const src = await readSettingsCombinedSource();
    const pageBlock = src.match(/function MemorySettingsPage\([\s\S]*?function MemoryEntryList/)?.[0] ?? '';

    assert.match(pageBlock, /async function reloadDraftFromDisk\(\)/);
    assert.match(pageBlock, /await reload\(\)/);
    assert.match(pageBlock, /已重新载入 MEMORY\.md/);
    assert.match(pageBlock, /未保存的草稿修改已丢弃/);
    assert.match(pageBlock, /onClick=\{\(\) => void reloadDraftFromDisk\(\)\}/);
    assert.match(pageBlock, /pendingMemoryWriteAction === 'reload' \? '载入中…' : '重新载入'/);
  });

  it('keeps MEMORY.md editing disabled until the initial disk state has loaded', async () => {
    const src = await readSettingsCombinedSource();
    const pageBlock = src.match(/function MemorySettingsPage\([\s\S]*?function MemoryEntryList/)?.[0] ?? '';
    const reloadBlock = pageBlock.match(/async function reload\(\)[\s\S]*?async function reloadDraftFromDisk/)?.[0] ?? '';

    assert.match(pageBlock, /const \[loadingMemory, setLoadingMemory\] = useState\(true\)/);
    assert.match(reloadBlock, /finally \{[\s\S]*setLoadingMemory\(false\)/);
    assert.match(pageBlock, /const memoryControlsDisabled = loadingMemory \|\| busy/);
    assert.match(pageBlock, /disabled=\{memoryControlsDisabled \|\| effective\.status === 'incognito_blocked' \|\| !effective\.enabled\}/);
    assert.match(pageBlock, /disabled=\{memoryControlsDisabled \|\| !effective\.enabled \|\| !memoryDraftDirty\}/);
  });

  it('surfaces thrown local memory and workspace instruction action failures', async () => {
    const src = await readSettingsCombinedSource();
    const pageBlock = src.match(/function MemorySettingsPage\([\s\S]*?function MemoryEntryList/)?.[0] ?? '';
    const reloadBlock = pageBlock.match(/async function reload\(\)[\s\S]*?async function reloadDraftFromDisk/)?.[0] ?? '';
    const saveBlock = pageBlock.match(/async function save\(\)[\s\S]*?async function reset/)?.[0] ?? '';
    const resetBlock = pageBlock.match(/async function reset\(\)[\s\S]*?async function restoreLatestBackup/)?.[0] ?? '';
    const restoreLatestBlock = pageBlock.match(/async function restoreLatestBackup\(\)[\s\S]*?async function restoreBackupCandidate/)?.[0] ?? '';
    const restoreCandidateBlock = pageBlock.match(/async function restoreBackupCandidate[\s\S]*?async function openFile/)?.[0] ?? '';
    const openFileBlock = pageBlock.match(/async function openFile\(\)[\s\S]*?async function openLatestBackup/)?.[0] ?? '';
    const openLatestBlock = pageBlock.match(/async function openLatestBackup\(\)[\s\S]*?async function openBackupCandidate/)?.[0] ?? '';
    const openCandidateBlock = pageBlock.match(/async function openBackupCandidate[\s\S]*?async function openFolder/)?.[0] ?? '';
    const openFolderBlock = pageBlock.match(/async function openFolder\(\)[\s\S]*?async function copyPath/)?.[0] ?? '';
    const openInstructionBlock = pageBlock.match(/async function openFile\(file: string\)[\s\S]*?async function createFile/)?.[0] ?? '';
    const createInstructionBlock = pageBlock.match(/async function createFile[\s\S]*?return \{/)?.[0] ?? '';
    const updateStatusBlock = pageBlock.match(/async function updateMemoryEntryStatus[\s\S]*?\n  }\n\n  const viewModel =/)?.[0] ?? '';

    assert.match(src, /function settingsActionErrorMessage\(error: unknown, locale: UiLocale = 'zh'\)/);
    assert.match(reloadBlock, /catch \(error\) \{[\s\S]*toast\.error\('载入本地记忆失败', settingsActionErrorMessage\(error\)\)/);
    assert.match(saveBlock, /catch \(error\) \{[\s\S]*toast\.error\('保存 MEMORY\.md 失败', settingsActionErrorMessage\(error\)\)/);
    assert.match(resetBlock, /catch \(error\) \{[\s\S]*toast\.error\('重置 MEMORY\.md 失败', settingsActionErrorMessage\(error\)\)/);
    assert.match(restoreLatestBlock, /catch \(error\) \{[\s\S]*toast\.error\('恢复上一版失败', settingsActionErrorMessage\(error\)\)/);
    assert.match(restoreCandidateBlock, /catch \(error\) \{[\s\S]*toast\.error\('恢复备份失败', settingsActionErrorMessage\(error\)\)/);
    assert.match(openFileBlock, /catch \(error\) \{[\s\S]*toast\.error\('打开失败', settingsActionErrorMessage\(error\)\)/);
    assert.match(openLatestBlock, /catch \(error\) \{[\s\S]*toast\.error\('打开上一版失败', settingsActionErrorMessage\(error\)\)/);
    assert.match(openCandidateBlock, /catch \(error\) \{[\s\S]*toast\.error\(`打开\$\{localMemoryBackupKindLabel\(backup\.kind\)\}失败`, settingsActionErrorMessage\(error\)\)/);
    assert.match(openFolderBlock, /catch \(error\) \{[\s\S]*toast\.error\(`打开\$\{openPathActionLabel\('memory', locale\)\}失败`, settingsActionErrorMessage\(error\)\)/);
    assert.match(openInstructionBlock, /catch \(error\) \{[\s\S]*toast\.error\('打开项目指令失败', settingsActionErrorMessage\(error\)\)/);
    assert.match(createInstructionBlock, /catch \(error\) \{[\s\S]*toast\.error\('创建项目指令失败', settingsActionErrorMessage\(error\)\)/);
    assert.match(updateStatusBlock, /catch \(error\) \{[\s\S]*toast\.error\(status === 'archived' \? '归档记忆失败' : '恢复记忆失败', settingsActionErrorMessage\(error\)\)/);
  });

  it('does not return raw shell.openPath errors from local memory open IPC', async () => {
    const main = await readMainProcessCombinedSource();
    const memoryOpenRegion = main.match(/ipcMain\.handle\('memory:openFile'[\s\S]*?function normalizeMemoryTextInput/)?.[0] ?? '';

    assert.match(
      main,
      /case 'open-failed':[\s\S]*系统未能打开 MEMORY\.md。/,
      'MEMORY.md open failure copy must have a stable product message',
    );
    assert.match(
      main,
      /case 'open-failed':[\s\S]*系统未能打开 MEMORY\.md 备份。/,
      'MEMORY.md backup open failure copy must have a stable product message',
    );
    assert.match(
      memoryOpenRegion,
      /memory:openFile[\s\S]*shell\.openPath\(resolved\.path\)[\s\S]*localMemoryOpenFailureCopy\('open-failed'\)/,
      'memory:openFile must not return shell.openPath raw error strings',
    );
    assert.match(
      memoryOpenRegion,
      /memory:openLatestBackup[\s\S]*shell\.openPath\(resolved\.path\)[\s\S]*localMemoryBackupOpenFailureCopy\('open-failed'\)/,
      'memory:openLatestBackup must not return shell.openPath raw error strings',
    );
    assert.match(
      memoryOpenRegion,
      /memory:openBackup[\s\S]*shell\.openPath\(resolved\.path\)[\s\S]*localMemoryBackupOpenFailureCopy\('open-failed'\)/,
      'memory:openBackup must not return shell.openPath raw error strings',
    );
    assert.doesNotMatch(
      memoryOpenRegion,
      /return error \? \{ ok: false, message: error \}/,
      'local memory open IPC must never forward raw shell.openPath errors to Settings toasts',
    );
  });

  it('can restore the latest MEMORY.md backup through an explicit reversible action', async () => {
    const main = await readMainProcessCombinedSource();
    const preload = await readRepo('apps/desktop/src/preload/preload.ts');
    const globalTypes = await readRepo('apps/desktop/src/preload/bridge-contract.d.ts');
    const service = await readRepo('apps/desktop/src/main/local-memory-service.ts');
    const src = await readSettingsCombinedSource();
    const pageBlock = src.match(/function MemorySettingsPage\([\s\S]*?function MemoryEntryList/)?.[0] ?? '';

    assert.match(service, /async restoreLatestBackup/);
    assert.match(service, /\`\$\{this\.file\}\.reset\.bak\`/);
    assert.match(service, /await this\.backupRestoreUndo\(\)/);
    assert.match(service, /await this\.backup\('restore\.bak'\)/);
    assert.match(service, /realpath\(backupInfo\.path\)/);
    assert.match(service, /const backupContent = await readFile\(backup\)/);
    assert.match(service, /await writeFile\(this\.file, backupContent, \{ mode: 0o600 \}\)/);
    assert.match(service, /await chmod\(this\.file, 0o600\)/);
    assert.match(service, /没有找到上一版 MEMORY\.md 备份/);
    assert.match(main, /ipcMain\.handle\('memory:restoreLatestBackup'/);
    assert.match(preload, /restoreLatestBackup\(\)/);
    assert.match(preload, /memory:restoreLatestBackup/);
    assert.match(globalTypes, /restoreLatestBackup\(\)/);
    assert.match(pageBlock, /async function restoreLatestBackup/);
    assert.match(pageBlock, /title: '恢复上一版 MEMORY\.md？'/);
    assert.match(pageBlock, /会先备份当前 MEMORY\.md，再用最近一次备份覆盖当前文件/);
    assert.match(pageBlock, /window\.maka\.memory\.restoreLatestBackup\(\)/);
    assert.match(pageBlock, /已恢复上一版 MEMORY\.md/);
    assert.match(pageBlock, /restore\.bak/);
    assert.match(pageBlock, /恢复上一版/);
  });

  it('shows latest MEMORY.md backup metadata before restore', async () => {
    const core = await readRepo('packages/core/src/local-memory.ts');
    const service = await readRepo('apps/desktop/src/main/local-memory-service.ts');
    const src = await readSettingsCombinedSource();
    const css = await readRendererContractCss();
    const pageBlock = src.match(/function MemorySettingsPage\([\s\S]*?function MemoryEntryList/)?.[0] ?? '';

    assert.match(core, /interface LocalMemoryBackupInfo/);
    assert.match(core, /readonly kind: 'save' \| 'reset' \| 'restore'/);
    assert.match(core, /readonly sizeBytes: number/);
    assert.match(core, /readonly activeEntryCount: number/);
    assert.match(core, /readonly safeMode: boolean/);
    assert.match(core, /readonly latestBackup\?: LocalMemoryBackupInfo/);
    assert.match(core, /readonly backups\?: ReadonlyArray<LocalMemoryBackupInfo>/);
    assert.match(service, /async latestBackupInfo/);
    assert.match(service, /async backupInfos/);
    assert.match(service, /kind: 'save' as const/);
    assert.match(service, /kind: 'reset' as const/);
    assert.match(service, /kind: 'restore' as const/);
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
    assert.match(src, /恢复前备份/);
    assert.match(css, /\.settingsMemoryBackupState/);
  });

  it('shows validated MEMORY.md backup candidates as metadata only', async () => {
    const src = await readSettingsCombinedSource();
    const css = await readRendererContractCss();
    const pageBlock = src.match(/function MemorySettingsPage\([\s\S]*?function MemoryEntryList/)?.[0] ?? '';

    assert.match(pageBlock, /effective\.backups && effective\.backups\.length > 1/);
    assert.match(pageBlock, /settingsMemoryBackupList/);
    assert.match(pageBlock, /备份候选/);
    assert.match(pageBlock, /effective\.backups\.map\(\(backup\) =>/);
    assert.match(pageBlock, /localMemoryBackupKindLabel\(backup\.kind\)/);
    assert.match(pageBlock, /localMemoryBackupSummary\(backup\)/);
    assert.match(pageBlock, /const backupCandidateLabel = `\$\{localMemoryBackupKindLabel\(backup\.kind\)\} · \$\{localMemoryBackupSummary\(backup\)\}`/);
    // PR-MEMORY-BACKUP-LIST-A11Y-0 (round 16/30): list container
    // switched from `<div role="list">` + `<span role="listitem">`
    // to semantic <ul>/<li>. The behavioral pins (aria-label on
    // the list, className on each row) are preserved — the
    // assertions now match the semantic markup.
    assert.match(pageBlock, /<ul className="settingsMemoryBackupCandidates" aria-label="本地记忆备份候选列表">/);
    assert.match(pageBlock, /className="settingsMemoryBackupCandidate"/);
    assert.match(pageBlock, /aria-label=\{`打开备份候选 \$\{backupCandidateLabel\}`\}/);
    assert.match(pageBlock, /aria-label=\{`恢复备份候选 \$\{backupCandidateLabel\}`\}/);
    assert.match(pageBlock, /aria-label=\{`复制备份候选引用 \$\{backupCandidateLabel\}`\}/);
    assert.match(pageBlock, /<RelativeTime ts=\{backup\.updatedAt\}/);
    assert.match(pageBlock, /copyBackupReference\(backup\)/);
    assert.match(pageBlock, /复制引用/);
    assert.match(pageBlock, /这里只显示 metadata，不展示备份正文/);
    assert.doesNotMatch(pageBlock, /backup\.content|readFile\(backup/);
    assert.match(css, /\.settingsMemoryBackupList/);
    assert.match(css, /\.settingsMemoryBackupCandidate/);
  });

  it('opens the latest MEMORY.md backup only through a main-process validated path', async () => {
    const main = await readMainProcessCombinedSource();
    const preload = await readRepo('apps/desktop/src/preload/preload.ts');
    const globalTypes = await readRepo('apps/desktop/src/preload/bridge-contract.d.ts');
    const service = await readRepo('apps/desktop/src/main/local-memory-service.ts');
    const src = await readSettingsCombinedSource();
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
    assert.match(pageBlock, /isMemoryActionPending\('backup:latest:open'\) \? '打开中…' : '打开上一版'/);
    assert.match(pageBlock, /!\s*effective\.latestBackup/);
  });

  it('opens a specific MEMORY.md backup candidate by kind without renderer-supplied paths', async () => {
    const main = await readMainProcessCombinedSource();
    const preload = await readRepo('apps/desktop/src/preload/preload.ts');
    const globalTypes = await readRepo('apps/desktop/src/preload/bridge-contract.d.ts');
    const service = await readRepo('apps/desktop/src/main/local-memory-service.ts');
    const src = await readSettingsCombinedSource();
    const pageBlock = src.match(/function MemorySettingsPage\([\s\S]*?function MemoryEntryList/)?.[0] ?? '';

    assert.match(service, /async resolveBackupForOpen\(kind: LocalMemoryBackupInfo\['kind'\]\)/);
    assert.match(service, /backupInfos\(\)\)\.find\(\(candidate\) => candidate\.kind === kind\)/);
    assert.match(main, /ipcMain\.handle\('memory:openBackup'/);
    assert.match(main, /kind !== 'save' && kind !== 'reset' && kind !== 'restore'/);
    assert.match(main, /localMemory\.resolveBackupForOpen\(kind\)/);
    assert.match(main, /shell\.openPath\(resolved\.path\)/);
    assert.match(preload, /openBackup\(kind: 'save' \| 'reset' \| 'restore'\)/);
    assert.match(preload, /memory:openBackup', kind/);
    assert.match(globalTypes, /openBackup\(kind: 'save' \| 'reset' \| 'restore'\)/);
    assert.match(pageBlock, /async function openBackupCandidate/);
    assert.match(pageBlock, /window\.maka\.memory\.openBackup\(backup\.kind\)/);
    assert.match(pageBlock, /打开\$\{localMemoryBackupKindLabel\(backup\.kind\)\}失败/);
    assert.match(pageBlock, /openBackupCandidate\(backup\)/);
    assert.match(pageBlock, /isMemoryActionPending\(`backup:\$\{backup\.kind\}:open`\) \? '打开中…' : '打开'/);
    assert.doesNotMatch(pageBlock, /openBackup\((backup\.path|.*path)/);
  });

  it('restores a specific MEMORY.md backup candidate by kind without renderer-supplied paths', async () => {
    const main = await readMainProcessCombinedSource();
    const preload = await readRepo('apps/desktop/src/preload/preload.ts');
    const globalTypes = await readRepo('apps/desktop/src/preload/bridge-contract.d.ts');
    const service = await readRepo('apps/desktop/src/main/local-memory-service.ts');
    const src = await readSettingsCombinedSource();
    const pageBlock = src.match(/function MemorySettingsPage\([\s\S]*?function MemoryEntryList/)?.[0] ?? '';

    assert.match(service, /async restoreBackup\(kind: LocalMemoryBackupInfo\['kind'\]\)/);
    assert.match(service, /restoreBackupBySelector/);
    assert.match(service, /candidate\.kind === kind/);
    assert.match(main, /ipcMain\.handle\('memory:restoreBackup'/);
    assert.match(main, /kind !== 'save' && kind !== 'reset' && kind !== 'restore'/);
    assert.match(main, /localMemory\.restoreBackup\(kind\)/);
    assert.match(preload, /restoreBackup\(kind: 'save' \| 'reset' \| 'restore'\)/);
    assert.match(preload, /memory:restoreBackup', kind/);
    assert.match(globalTypes, /restoreBackup\(kind: 'save' \| 'reset' \| 'restore'\)/);
    assert.match(pageBlock, /async function restoreBackupCandidate/);
    assert.match(pageBlock, /window\.maka\.memory\.restoreBackup\(backup\.kind\)/);
    assert.match(pageBlock, /title: '恢复这个 MEMORY\.md 备份？'/);
    assert.match(pageBlock, /会先备份当前 MEMORY\.md，再用选中的备份覆盖当前文件/);
    assert.match(pageBlock, /restoreBackupCandidate\(backup\)/);
    assert.match(pageBlock, /isMemoryActionPending\(`backup:\$\{backup\.kind\}:restore`\) \? '恢复中…' : '恢复'/);
    assert.doesNotMatch(pageBlock, /restoreBackup\((backup\.path|.*path)/);
  });

  it('can copy a latest MEMORY.md backup reference without exposing backup content', async () => {
    const src = await readSettingsCombinedSource();
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
    assert.match(pageBlock, /isMemoryActionPending\(`backup:\$\{effective\.latestBackup\.kind\}:copy`\) \? '复制中…' : '复制上一版引用'/);
    assert.doesNotMatch(copyBackupBlock, /backup\.content|readFile\(backup/);
  });
});
