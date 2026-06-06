import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  FIRST_RUN_TASK_SUGGESTION_MILESTONES,
  FIRST_RUN_TASK_SUGGESTIONS,
  type FirstRunTaskSuggestionId,
} from '../../renderer/first-run-task-suggestions.js';

describe('FIRST_RUN_TASK_SUGGESTIONS', () => {
  it('keeps the first-run task rows small and stable', () => {
    assert.equal(FIRST_RUN_TASK_SUGGESTIONS.length, 4);
    assert.deepEqual(
      FIRST_RUN_TASK_SUGGESTIONS.map((suggestion) => suggestion.id),
      ['workspace-map', 'deep-research', 'file-organize', 'web-research'] satisfies FirstRunTaskSuggestionId[],
    );
  });

  it('maps suggestion dismissal to closed onboarding milestone ids', () => {
    assert.deepEqual(FIRST_RUN_TASK_SUGGESTION_MILESTONES, {
      'workspace-map': 'first_run_suggestion_workspace_map',
      'deep-research': 'first_run_suggestion_deep_research',
      'file-organize': 'first_run_suggestion_file_organize',
      'web-research': 'first_run_suggestion_web_research',
    });
  });

  it('uses concrete prompt copy rather than marketing labels', () => {
    for (const suggestion of FIRST_RUN_TASK_SUGGESTIONS) {
      assert.ok(
        suggestion.prompt.includes(suggestion.label.split('一个')[0].split('一下')[0]),
        `${suggestion.id} prompt should visibly relate to its label`,
      );
      assert.match(suggestion.prompt, /帮我|先/);
      assert.equal(suggestion.prompt.includes('Coming Soon'), false);
      assert.equal(suggestion.prompt.includes('TODO'), false);
    }
  });

  it('marks deep research as an explicit read-only mode', () => {
    const deepResearch = FIRST_RUN_TASK_SUGGESTIONS.find(
      (suggestion) => suggestion.id === 'deep-research',
    );
    assert.ok(deepResearch);
    assert.equal(deepResearch.mode, 'deep_research');
    assert.match(deepResearch.prompt, /只读/);
    assert.match(deepResearch.prompt, /不要修改文件/);
  });

  it('starts project mapping through the read-only research profile', () => {
    const workspaceMap = FIRST_RUN_TASK_SUGGESTIONS.find(
      (suggestion) => suggestion.id === 'workspace-map',
    );
    assert.ok(workspaceMap);
    assert.equal(workspaceMap.mode, 'deep_research');
    assert.match(workspaceMap.prompt, /只读/);
    assert.match(workspaceMap.prompt, /不要修改文件/);
  });

  it('keeps file-management suggestions confirm-before-mutating', () => {
    const fileOrganize = FIRST_RUN_TASK_SUGGESTIONS.find(
      (suggestion) => suggestion.id === 'file-organize',
    );
    assert.ok(fileOrganize);
    assert.match(fileOrganize.prompt, /不要直接移动或删除文件/);
    assert.match(fileOrganize.prompt, /等我确认/);
  });

  it('makes first-run suggestion rows dismissible and restorable without storing prompts', async () => {
    const hero = await readFile(join(process.cwd(), 'src/renderer/OnboardingHero.tsx'), 'utf8');
    const main = await readFile(join(process.cwd(), 'src/renderer/main.tsx'), 'utf8');

    assert.match(hero, /onDismissTaskSuggestion/);
    assert.match(hero, /onRestoreTaskSuggestions/);
    assert.match(hero, /FIRST_RUN_TASK_SUGGESTION_MILESTONES/);
    assert.match(hero, /隐藏任务建议/);
    assert.match(hero, /恢复 \{hiddenSuggestions\.length\} 项/);
    assert.match(main, /window\.maka\.onboarding\.setMilestone\(FIRST_RUN_TASK_SUGGESTION_MILESTONES\[id\], 'skipped'\)/);
    assert.match(main, /window\.maka\.onboarding\.clearMilestone\(FIRST_RUN_TASK_SUGGESTION_MILESTONES\[id\]\)/);
    assert.doesNotMatch(hero, /setMilestone\([^)]*suggestion\.prompt/);
  });

  it('gates first-run import actions so file/folder/drop/paste cannot append concurrently', async () => {
    const hero = await readFile(join(process.cwd(), 'src/renderer/OnboardingHero.tsx'), 'utf8');
    const readyBlock = hero.match(/function ReadyEmptyHero[\s\S]*?interface SetupHeroProps/)?.[0] ?? '';
    const gateBlock = readyBlock.match(/const runImportAction = useCallback[\s\S]*?const importTextFile/)?.[0] ?? '';

    assert.match(readyBlock, /const \[pendingImportAction, setPendingImportAction\] = useState<string \| null>\(null\)/);
    assert.match(readyBlock, /const pendingImportActionRef = useRef<string \| null>\(null\)/);
    assert.match(readyBlock, /const importActionBusy = pendingImportAction !== null/);
    assert.match(
      gateBlock,
      /if \(pendingImportActionRef\.current !== null \|\| props\.quickChatPending\) return;[\s\S]*pendingImportActionRef\.current = actionKey[\s\S]*setPendingImportAction\(actionKey\)[\s\S]*const prompt = await action\(\)[\s\S]*if \(prompt\) appendImportedPrompt\(prompt\)[\s\S]*pendingImportActionRef\.current = null[\s\S]*setPendingImportAction\(null\)/,
      'first-run import actions must use a ref-backed pending gate and append only through one shared path',
    );
    assert.match(readyBlock, /runImportAction\('file', props\.onImportTextFile\)/);
    assert.match(readyBlock, /runImportAction\('folder', props\.onImportFolderOutline\)/);
    assert.match(readyBlock, /runImportAction\('drop', async \(\) => props\.onImportDroppedTextFiles\?\.\(files\)\)/);
    assert.match(readyBlock, /runImportAction\('paste', async \(\) => props\.onImportDroppedTextFiles\?\.\(files\)\)/);
    assert.match(readyBlock, /props\.onImportDroppedTextFiles && !props\.quickChatPending && !importActionBusy/);
    assert.match(readyBlock, /disabled=\{props\.quickChatPending \|\| importActionBusy\}/);
    assert.match(readyBlock, /aria-busy=\{pendingImportAction === 'file' \? 'true' : undefined\}/);
    assert.match(readyBlock, /aria-busy=\{pendingImportAction === 'folder' \? 'true' : undefined\}/);
    assert.match(readyBlock, /pendingImportAction === 'file' \? '导入中…' : '导入文件内容'/);
    assert.match(readyBlock, /pendingImportAction === 'folder' \? '导入中…' : '导入文件夹目录'/);
    assert.doesNotMatch(
      readyBlock,
      /void \(async \(\) => \{[\s\S]*props\.onImportDroppedTextFiles\?\.\(files\)[\s\S]*appendImportedPrompt\(prompt\)/,
      'drop/paste import must not bypass the shared pending gate',
    );
  });

  it('surfaces project instruction creation in the first-run checklist', async () => {
    const source = await readFile(join(process.cwd(), 'src/renderer/FirstRunChecklist.tsx'), 'utf8');

    assert.match(source, /workspaceInstructions\.getState\(\)/);
    assert.match(source, /创建项目指令文件/);
    assert.match(source, /workspaceInstructionCount > 0/);
    assert.match(source, /onOpenSettingsSection\('memory'\)/);
  });

  it('fails soft when first-run checklist status probes reject', async () => {
    const source = await readFile(join(process.cwd(), 'src/renderer/FirstRunChecklist.tsx'), 'utf8');
    const styles = await readFile(join(process.cwd(), 'src/renderer/styles.css'), 'utf8');
    const effectBlock = source.match(/useEffect\(\(\) => \{[\s\S]*?return \(\) => \{[\s\S]*?cancelled = true;[\s\S]*?\};[\s\S]*?\}, \[\]\);/)?.[0] ?? '';

    assert.match(effectBlock, /window\.maka\.settings\.get\(\)\.then\([\s\S]*?\.catch\(\(error\) => \{[\s\S]*setSettingsLoadFailed\(true\);[\s\S]*surfaceProbeFailure\(error\)/);
    assert.match(effectBlock, /window\.maka\.plans\.list\(\)\.then\([\s\S]*?\.catch\(\(error\) => \{[\s\S]*setPlanReminders\(null\);[\s\S]*surfaceProbeFailure\(error\)/);
    assert.match(effectBlock, /workspaceInstructions\.getState\(\)\.then\([\s\S]*?\.catch\(\(error\) => \{[\s\S]*setWorkspaceInstructionCount\(null\);[\s\S]*surfaceProbeFailure\(error\)/);
    assert.doesNotMatch(effectBlock, /catch[\s\S]*setSettings\(null\)|catch[\s\S]*setPlanReminders\(\[\]\)|catch[\s\S]*setWorkspaceInstructionCount\(0\)/);
    assert.match(source, /planReminders,\s*setPlanReminders\] = useState<ReadonlyArray<PlanReminder> \| null>\(null\)/);
    assert.match(source, /workspaceInstructionCount,\s*setWorkspaceInstructionCount\] = useState<number \| null>\(null\)/);
    assert.match(source, /trackCompletion:\s*planStatusKnown/);
    assert.match(source, /trackCompletion:\s*workspaceInstructionStatusKnown/);
    assert.match(source, /部分状态暂时没刷新成功，已避免把未知状态计成未完成/);
    assert.match(source, /role="alert"/);
    assert.match(styles, /\.maka-first-run-checklist-error\s*\{/);
  });

  it('starts the shipped plan reminder form from the first-run checklist', async () => {
    const checklist = await readFile(join(process.cwd(), 'src/renderer/FirstRunChecklist.tsx'), 'utf8');
    const main = await readFile(join(process.cwd(), 'src/renderer/main.tsx'), 'utf8');

    assert.match(checklist, /onStartPlanReminder\?\(\): void/);
    assert.match(checklist, /id:\s*'plan-reminder'/);
    assert.match(checklist, /建一条本地计划提醒/);
    assert.match(
      checklist,
      /onClick:\s*\(\)\s*=>\s*props\.onStartPlanReminder\?\.\(\)\s*\?\?\s*props\.onOpenSidebarModule\('automations'\)/,
    );
    assert.match(main, /function\s+openPlanReminderForm\(\)/);
    assert.match(main, /<FirstRunChecklist[\s\S]*onStartPlanReminder=\{openPlanReminderForm\}/);
  });

  it('does not count exploration-only rows as unfinished setup todos', async () => {
    const source = await readFile(join(process.cwd(), 'src/renderer/FirstRunChecklist.tsx'), 'utf8');

    assert.match(source, /const completableItems = items\.filter\(\(item\) => item\.trackCompletion !== false\)/);
    assert.match(source, /待完成 \$\{remaining\} 项/);
    assert.match(source, /\{remaining\} \/ \{completableItems\.length\} 待完成/);
    assert.match(source, /id:\s*'daily-review'[\s\S]*trackCompletion:\s*false/);
    assert.match(source, /id:\s*'voice-smoke'[\s\S]*trackCompletion:\s*false/);
    assert.match(source, /data-kind=\{item\.trackCompletion === false \? 'explore' : 'setup'\}/);
  });
});
