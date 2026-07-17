import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { readAllRendererCss } from './css-test-helpers.js';
import { readRendererShellCombinedSource } from './renderer-shell-source-helpers.js';
import {
  FIRST_RUN_TASK_SUGGESTION_MILESTONES,
  getFirstRunTaskSuggestions,
  type FirstRunTaskSuggestionId,
} from '../../renderer/first-run-task-suggestions.js';

const FIRST_RUN_TASK_SUGGESTIONS = getFirstRunTaskSuggestions('zh');

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

  it('provides a complete English suggestion set without CJK', () => {
    const suggestions = getFirstRunTaskSuggestions('en');
    assert.deepEqual(suggestions.map((suggestion) => suggestion.id), FIRST_RUN_TASK_SUGGESTIONS.map((suggestion) => suggestion.id));
    assert.doesNotMatch(JSON.stringify(suggestions), /[\u3400-\u9fff]/);
  });

  it('renders fixed first-run suggestions and replaces the composer draft on click', async () => {
    // PR #190 review: the per-suggestion dismiss + bulk restore flow
    // was removed entirely — the four FIRST_RUN_TASK_SUGGESTIONS are
    // always visible and clicking one REPLACES the composer draft
    // instead of appending to it. Onboarding milestone writes for
    // dismiss/restore are no longer wired from the hero. The test now
    // pins the new shape so future changes still go through review.
    const hero = await readFile(join(process.cwd(), 'src/renderer/OnboardingHero.tsx'), 'utf8');
    const readyBlock = hero.match(/function ReadyEmptyHero[\s\S]*?interface SetupHeroProps/)?.[0] ?? '';

    assert.match(readyBlock, /const suggestions = getFirstRunTaskSuggestions\(locale\)/);
    assert.match(readyBlock, /suggestions\.length > 0/);
    assert.match(readyBlock, /suggestions\.map\(\(suggestion\) =>/);
    assert.match(readyBlock, /const nextDraft = prompt;/);
    assert.match(readyBlock, /setDraft\(nextDraft\)/);
    assert.match(readyBlock, /onClick=\{\(\) => prefillSuggestion\(suggestion\.prompt, suggestion\.mode\)\}/);
    assert.doesNotMatch(hero, /隐藏任务建议/);
    assert.doesNotMatch(hero, /`恢复 \$\{hiddenSuggestions\.length\} 项`/);
    assert.doesNotMatch(readyBlock, /void props\.onRestoreTaskSuggestions\?\./);
    assert.doesNotMatch(readyBlock, /void props\.onDismissTaskSuggestion\?\./);
    assert.doesNotMatch(readyBlock, /appendPromptContextDraft\(draft, prompt\)/);
  });

  it('gates first-run drop/paste imports so they cannot append concurrently', async () => {
    // PR #190 review: the inline `导入文件内容` and `导入文件夹目录`
    // buttons were removed from the first-run composer (the new
    // single-action card pattern only takes user typing). Drag-and-
    // drop and paste imports keep working because they're triggered
    // by the textarea wrapper itself; the ref-backed `runImportAction`
    // gate is still in place. Anchor moved from `const importTextFile`
    // (gone) to `const importActionBusy`.
    const hero = await readFile(join(process.cwd(), 'src/renderer/OnboardingHero.tsx'), 'utf8');
    const readyBlock = hero.match(/function ReadyEmptyHero[\s\S]*?interface SetupHeroProps/)?.[0] ?? '';
    const gateBlock = readyBlock.match(/const runImportAction = useCallback[\s\S]*?const importActionBusy/)?.[0] ?? '';

    assert.match(readyBlock, /const \[pendingImportAction, setPendingImportAction\] = useState<string \| null>\(null\)/);
    assert.match(readyBlock, /const readyHeroMountedRef = useMountedRef\(\)/);
    assert.match(readyBlock, /const importActionOwnerRef = useRef<ChatInputActionOwner<string> \| null>\(null\)/);
    assert.match(readyBlock, /importActionOwnerRef\.current = createChatInputActionOwner/);
    assert.match(readyBlock, /const importActionBusy = pendingImportAction !== null/);
    assert.match(readyBlock, /const appendImportedPrompt = useCallback\(\(prompt: string\) => \{[\s\S]*if \(!readyHeroMountedRef\.current\) return;[\s\S]*setDraft\(/);
    assert.match(
      gateBlock,
      /if \(quickChatBusy\) return;[\s\S]*const prompt = await importActionOwnerRef\.current\?\.run\(actionKey,[\s\S]*const prompt = await action\(\)[\s\S]*if \(prompt && readyHeroMountedRef\.current\) appendImportedPrompt\(prompt\)/,
      'first-run import actions must use the shared synchronous pending owner and append only through one path',
    );
    assert.match(readyBlock, /runImportAction\('drop', async \(\) => props\.onImportDroppedTextFiles\?\.\(files\)\)/);
    assert.match(readyBlock, /runImportAction\('paste', async \(\) => props\.onImportDroppedTextFiles\?\.\(files\)\)/);
    assert.match(readyBlock, /props\.onImportDroppedTextFiles && !quickChatBusy && !importActionBusy/);
    assert.doesNotMatch(
      readyBlock,
      /void \(async \(\) => \{[\s\S]*props\.onImportDroppedTextFiles\?\.\(files\)[\s\S]*appendImportedPrompt\(prompt\)/,
      'drop/paste import must not bypass the shared pending gate',
    );
  });

  it('gates first-run readiness refresh actions so repeated setup CTA clicks cannot race', async () => {
    const hero = await readFile(join(process.cwd(), 'src/renderer/OnboardingHero.tsx'), 'utf8');
    const rootBlock = hero.match(/export function OnboardingHero[\s\S]*?switch \(state\.kind\)/)?.[0] ?? '';
    const setupBlock = hero.match(/interface SetupHeroProps[\s\S]*?function assertNever/)?.[0] ?? '';

    assert.match(rootBlock, /const \[refreshConnectionsPending, setRefreshConnectionsPending\] = useState\(false\)/);
    assert.match(rootBlock, /const onboardingMountedRef = useMountedRef\(\)/);
    assert.match(rootBlock, /const refreshConnectionsPendingRef = useRef\(false\)/);
    assert.match(
      rootBlock,
      /useEffect\(\(\) => \{[\s\S]*return \(\) => \{[\s\S]*refreshConnectionsPendingRef\.current = false;[\s\S]*\};[\s\S]*\}, \[\]\)/,
      'first-run setup refresh must release pending ownership on unmount; the mounted flag is owned by the shared useMountedRef hook',
    );
    assert.match(
      rootBlock,
      /const runRefreshConnections = useCallback\(async \(\) => \{[\s\S]*if \(!props\.onRefreshConnections \|\| refreshConnectionsPendingRef\.current\) return;[\s\S]*refreshConnectionsPendingRef\.current = true[\s\S]*setRefreshConnectionsPending\(true\)[\s\S]*await props\.onRefreshConnections\(\)[\s\S]*refreshConnectionsPendingRef\.current = false[\s\S]*if \(onboardingMountedRef\.current\) setRefreshConnectionsPending\(false\)/,
      'readiness refresh must use a ref-backed pending gate',
    );
    assert.match(hero, /onRefreshConnections=\{props\.onRefreshConnections \? runRefreshConnections : undefined\}/);
    assert.match(hero, /refreshConnectionsPending=\{refreshConnectionsPending\}/);
    assert.match(hero, /refreshConnectionsPending === true \? copy\.refresh\.pending : copy\.refresh\.connection/);
    assert.match(hero, /refreshConnectionsPending === true \? copy\.refresh\.pending : copy\.refresh\.credentials/);
    assert.match(hero, /refreshConnectionsPending === true \? copy\.refresh\.pending : copy\.refresh\.model/);
    assert.match(hero, /refreshConnectionsPending === true \? copy\.refresh\.pending : copy\.refresh\.blocked/);
    assert.match(setupBlock, /secondaryCta\?: \{ label: string; onClick: \(\) => void; disabled\?: boolean; busy\?: boolean \}/);
    assert.match(setupBlock, /disabled=\{props\.secondaryCta\.disabled === true\}/);
    assert.match(setupBlock, /aria-busy=\{props\.secondaryCta\.busy === true \? 'true' : undefined\}/);
    assert.doesNotMatch(
      hero,
      /onClick:\s*\(\) => void props\.onRefreshConnections\?\.\(\)|onClick=\{\(\) => void props\.onRefreshConnections\?\.\(\)\}/,
      'setup refresh CTAs must not bypass the shared pending gate',
    );
  });

  it('surfaces project instruction creation in the first-run checklist', async () => {
    const source = await readFile(join(process.cwd(), 'src/renderer/FirstRunChecklist.tsx'), 'utf8');

    assert.match(source, /workspaceInstructions\.getState\(\)/);
    assert.match(source, /itemCopy\['workspace-instructions'\]\.title/);
    assert.match(source, /workspaceInstructionCount > 0/);
    // PR-SETTINGS-REVIEW-0: memory section is on its own again
    // (the merged memory-review page was too dense). Workspace
    // instructions live there.
    assert.match(source, /onOpenSettingsSection\('memory'\)/);
  });

  it('fails soft when first-run checklist status probes reject', async () => {
    const source = await readFile(join(process.cwd(), 'src/renderer/FirstRunChecklist.tsx'), 'utf8');
    const styles = await readAllRendererCss();
    const refreshBlock = source.match(/const refreshChecklistStatus = useCallback[\s\S]*?useEffect/)?.[0] ?? '';
    const effectBlock = source.match(/useEffect\(\(\) => \{[\s\S]*?return \(\) => \{[\s\S]*?cancelled = true;[\s\S]*?\};[\s\S]*?\}, \[refreshChecklistStatus\]\);/)?.[0] ?? '';

    assert.match(refreshBlock, /window\.maka\.settings\.get\(\)\.then\([\s\S]*?\.catch\(\(error\) => \{[\s\S]*setSettingsLoadFailed\(true\);[\s\S]*handleProbeFailure\(error\)/);
    assert.match(refreshBlock, /window\.maka\.plans\.list\(\)\.then\([\s\S]*?\.catch\(\(error\) => \{[\s\S]*setPlanReminders\(null\);[\s\S]*handleProbeFailure\(error\)/);
    assert.match(refreshBlock, /workspaceInstructions\.getState\(\)\.then\([\s\S]*?\.catch\(\(error\) => \{[\s\S]*setWorkspaceInstructionCount\(null\);[\s\S]*handleProbeFailure\(error\)/);
    assert.doesNotMatch(refreshBlock, /catch[\s\S]*setSettings\(null\)|catch[\s\S]*setPlanReminders\(\[\]\)|catch[\s\S]*setWorkspaceInstructionCount\(0\)/);
    assert.match(source, /const \[statusRefreshPending, setStatusRefreshPending\] = useState\(false\)/);
    assert.match(source, /const checklistMountedRef = useMountedRef\(\)/);
    assert.match(source, /const statusRefreshPendingRef = useRef\(false\)/);
    assert.match(
      source,
      /useEffect\(\(\) => \{[\s\S]*return \(\) => \{[\s\S]*statusRefreshPendingRef\.current = false;[\s\S]*\};[\s\S]*\}, \[\]\)/,
      'first-run checklist must restore mounted state during StrictMode replay and release refresh ownership on unmount',
    );
    assert.match(source, /const isChecklistUnmounted = useCallback\(\(\) => !checklistMountedRef\.current, \[\]\)/);
    assert.match(refreshBlock, /isCancelled: \(\) => boolean = isChecklistUnmounted/);
    assert.doesNotMatch(refreshBlock, /isCancelled: \(\) => boolean = \(\) => false/);
    assert.match(refreshBlock, /let hadFailure = false;[\s\S]*const handleProbeFailure = \(error: unknown\) => \{[\s\S]*hadFailure = true;[\s\S]*surfaceProbeFailure\(error\)/);
    assert.match(refreshBlock, /if \(statusRefreshPendingRef\.current\) return;[\s\S]*statusRefreshPendingRef\.current = true[\s\S]*setStatusRefreshPending\(true\)[\s\S]*await Promise\.all\(\[[\s\S]*statusRefreshPendingRef\.current = false[\s\S]*setStatusRefreshPending\(false\)/);
    assert.match(refreshBlock, /if \(!isCancelled\(\) && !hadFailure\) setStatusError\(null\)/);
    assert.match(effectBlock, /void refreshChecklistStatus\(\(\) => cancelled \|\| !checklistMountedRef\.current\)/);
    assert.match(source, /onClick=\{\(\) => void refreshChecklistStatus\(\)\}/);
    assert.match(source, /disabled=\{statusRefreshPending\}/);
    assert.match(source, /aria-busy=\{statusRefreshPending \? 'true' : undefined\}/);
    assert.match(source, /statusRefreshPending \? copy\.refreshing : copy\.retry/);
    assert.match(source, /planReminders,\s*setPlanReminders\] = useState<ReadonlyArray<PlanReminder> \| null>\(null\)/);
    assert.match(source, /workspaceInstructionCount,\s*setWorkspaceInstructionCount\] = useState<number \| null>\(null\)/);
    assert.match(source, /trackCompletion:\s*planStatusKnown/);
    assert.match(source, /trackCompletion:\s*workspaceInstructionStatusKnown/);
    assert.match(source, /copy\.partialFailureBody/);
    assert.match(source, /role="alert"/);
    assert.match(styles, /\.maka-first-run-checklist-error\s*\{/);
    assert.match(source, /variant="secondary"\s+size="sm"[\s\S]*refreshChecklistStatus/);
    assert.doesNotMatch(source, /className="maka-first-run-checklist-error-action"/);
    assert.doesNotMatch(styles, /\.maka-first-run-checklist-error-action/);
  });

  it('starts the shipped plan reminder form from the first-run checklist', async () => {
    const checklist = await readFile(join(process.cwd(), 'src/renderer/FirstRunChecklist.tsx'), 'utf8');
    const main = await readRendererShellCombinedSource();

    assert.match(checklist, /onStartPlanReminder\?\(\): void/);
    assert.match(checklist, /id:\s*'plan-reminder'/);
    assert.match(checklist, /itemCopy\['plan-reminder'\]\.title/);
    // The old `props.onStartPlanReminder?.() ?? props.onOpenSidebarModule(...)`
    // pattern was a bug: the callback returns void, so `?.()` always yields
    // undefined and the "fallback" fired unconditionally. The contract now
    // pins the explicit branch.
    assert.match(
      checklist,
      /if\s*\(props\.onStartPlanReminder\)\s*props\.onStartPlanReminder\(\);/,
    );
    assert.match(
      checklist,
      /else\s*props\.onOpenSidebarModule\('automations'\);/,
    );
    assert.match(main, /function\s+openPlanReminderForm\(\)/);
    assert.match(main, /<ChatMessageSurface[\s\S]*onStartPlanReminder=\{openPlanReminderForm\}/);
    assert.match(main, /<OnboardingEmptyState[\s\S]*onStartPlanReminder=\{onStartPlanReminder\}/);
    assert.match(main, /<FirstRunChecklist[\s\S]*onStartPlanReminder=\{onStartPlanReminder\}/);
  });

  it('does not count exploration-only rows as unfinished setup todos', async () => {
    const source = await readFile(join(process.cwd(), 'src/renderer/FirstRunChecklist.tsx'), 'utf8');

    assert.match(source, /const completableItems = items\.filter\(\(item\) => item\.trackCompletion !== false\)/);
    assert.match(source, /copy\.remainingAria\(remaining\)/);
    assert.match(source, /copy\.remainingCount\(remaining, completableItems\.length\)/);
    assert.match(source, /id:\s*'daily-review'[\s\S]*trackCompletion:\s*false/);
    assert.match(source, /id:\s*'voice-smoke'[\s\S]*trackCompletion:\s*false/);
    assert.match(source, /data-kind=\{item\.trackCompletion === false \? 'explore' : 'setup'\}/);
  });
});
