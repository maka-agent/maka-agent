import { strict as assert } from 'node:assert';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';

const REPO_ROOT = resolve(import.meta.dirname, '../../../../..');

describe('Daily Review copy feedback contract', () => {
  it('lets the app shell own clipboard success and failure feedback', async () => {
    const ui = await readFile(resolve(REPO_ROOT, 'packages/ui/src/components.tsx'), 'utf8');
    const main = await readFile(resolve(REPO_ROOT, 'apps/desktop/src/renderer/main.tsx'), 'utf8');

    assert.match(ui, /onCopyDailyReviewMarkdown\?\(input:/);
    assert.match(ui, /onCopyMarkdown\?: \(input:/);
    assert.match(ui, /props\.onCopyMarkdown\?\.\(\{\s*markdown:\s*md,\s*label:\s*dayLabel,\s*summary: visibleSummary\s*\}\)/);
    assert.match(ui, /const hasDailyReviewActions = Boolean\(props\.onCopyMarkdown \|\| props\.onAppendMarkdown \|\| props\.onSaveMarkdown\)/);
    assert.match(ui, /visibleSummary && visibleSummary\.totals\.sessionCount \+ visibleSummary\.totals\.requestCount > 0 && hasDailyReviewActions/);
    assert.doesNotMatch(ui, /navigator\.clipboard\.writeText\(md\)\.catch\(\(\) => \{\}\)/);
    assert.match(main, /onCopyDailyReviewMarkdown=\{async \(\{ markdown, label, summary \}\) => \{/);
    assert.match(main, /await navigator\.clipboard\.writeText\(markdown\)/);
    assert.match(
      main,
      /function isDailyReviewSurfaceActive\(\): boolean \{[\s\S]*return navSelectionRef\.current\.section === 'daily-review';[\s\S]*\}/,
      'Daily Review action feedback must be owned by the active Daily Review surface',
    );
    assert.match(
      main,
      /if \(isDailyReviewSurfaceActive\(\)\) \{[\s\S]*toastApi\.success\(\s*`已复制\$\{label\}回顾`/,
      'Daily Review copy success must not toast after leaving the Daily Review surface',
    );
    assert.match(
      main,
      /if \(isDailyReviewSurfaceActive\(\)\) \{[\s\S]*toastApi\.error\('复制失败', dailyReviewActionErrorMessage\(error, '剪贴板不可用或被系统拒绝'\)\)/,
      'Daily Review copy failure must not toast after leaving the Daily Review surface',
    );
  });

  it('appends Daily Review markdown to the composer instead of replacing the existing draft', async () => {
    const main = await readFile(resolve(REPO_ROOT, 'apps/desktop/src/renderer/main.tsx'), 'utf8');
    const handlerBlock = main.match(/onPasteTodayDailyReviewIntoComposer:\s*async \(\) => \{[\s\S]*?^\s*},/m)?.[0] ?? '';

    assert.match(handlerBlock, /formatDailyReviewMarkdown\(summary,\s*['"]今天['"]\)/);
    assert.match(handlerBlock, /composerRef\.current\?\.appendText\(markdown\)/);
    assert.match(handlerBlock, /toastApi\.success\(\s*['"]已追加今日回顾到输入框['"]/);
    assert.doesNotMatch(handlerBlock, /composerRef\.current\?\.setText\(markdown\)/);
  });

  it('lets the Daily Review main panel append the current range to the composer', async () => {
    const ui = await readFile(resolve(REPO_ROOT, 'packages/ui/src/components.tsx'), 'utf8');
    const main = await readFile(resolve(REPO_ROOT, 'apps/desktop/src/renderer/main.tsx'), 'utf8');
    const panelBlock = ui.match(/function DailyReviewPanel[\s\S]*?function PlanReminderPanel/)?.[0] ?? '';
    const mainPaneBlock = main.match(/onAppendDailyReviewMarkdown=\{\(\{ markdown, label, summary \}\) => \{[\s\S]*?^\s*}\}/m)?.[0] ?? '';

    assert.match(ui, /onAppendDailyReviewMarkdown\?: \(input:/);
    assert.match(panelBlock, /props\.onAppendMarkdown\?\.\(\{\s*markdown:\s*md,\s*label:\s*dayLabel,\s*summary: visibleSummary\s*\}\)/);
    assert.match(panelBlock, /pendingDailyReviewAction === 'append' \? '追加中…' : '粘到输入框'/);
    assert.match(mainPaneBlock, /composerRef\.current\?\.appendText\(markdown\)/);
    assert.match(mainPaneBlock, /toastApi\.success\(\s*`已追加\$\{label\}回顾到输入框`/);
    assert.doesNotMatch(mainPaneBlock, /composerRef\.current\?\.setText\(markdown\)/);
  });

  it('gates Daily Review export actions while async work is pending', async () => {
    const ui = await readFile(resolve(REPO_ROOT, 'packages/ui/src/components.tsx'), 'utf8');
    const main = await readFile(resolve(REPO_ROOT, 'apps/desktop/src/renderer/main.tsx'), 'utf8');
    const panelBlock = ui.match(/function DailyReviewPanel[\s\S]*?function PlanReminderPanel/)?.[0] ?? '';
    const gateBlock = panelBlock.match(/async function runDailyReviewAction[\s\S]*?const dailyReviewActionBusy/)?.[0] ?? '';

    assert.match(panelBlock, /const \[pendingDailyReviewAction, setPendingDailyReviewAction\] = useState<string \| null>\(null\)/);
    assert.match(panelBlock, /const dailyReviewMountedRef = useRef\(true\)/);
    assert.match(panelBlock, /const pendingDailyReviewActionRef = useRef<string \| null>\(null\)/);
    assert.match(
      panelBlock,
      /useEffect\(\(\) => \{\s*dailyReviewMountedRef\.current = true;[\s\S]*?return \(\) => \{\s*dailyReviewMountedRef\.current = false;\s*pendingDailyReviewActionRef\.current = null;\s*\};\s*\}, \[\]\)/,
      'Daily Review export pending ownership must be released when the main panel unmounts or StrictMode replays cleanup',
    );
    assert.match(panelBlock, /const dailyReviewActionBusy = pendingDailyReviewAction !== null/);
    assert.match(panelBlock, /\{props\.onCopyMarkdown && \(/);
    assert.match(
      gateBlock,
      /if \(pendingDailyReviewActionRef\.current !== null\) return;[\s\S]*pendingDailyReviewActionRef\.current = actionKey[\s\S]*setPendingDailyReviewAction\(actionKey\)[\s\S]*await action\(\)[\s\S]*pendingDailyReviewActionRef\.current = null[\s\S]*if \(dailyReviewMountedRef\.current\) setPendingDailyReviewAction\(null\)/,
      'Daily Review export actions must use a ref-backed pending gate so same-frame double clicks cannot run two exports',
    );
    assert.match(panelBlock, /runDailyReviewAction\('copy', async \(\) => \{/);
    assert.match(panelBlock, /runDailyReviewAction\('append', async \(\) => \{/);
    assert.match(panelBlock, /runDailyReviewAction\('save', async \(\) => \{/);
    assert.match(panelBlock, /disabled=\{dailyReviewActionBusy\}/);
    assert.match(panelBlock, /aria-busy=\{pendingDailyReviewAction === 'copy' \? 'true' : undefined\}/);
    assert.match(panelBlock, /复制中…/);
    assert.match(panelBlock, /追加中…/);
    assert.match(panelBlock, /保存中…/);
    assert.doesNotMatch(
      main,
      /onSaveDailyReviewMarkdown=\{\(input\) => void saveDailyReviewMarkdown\(input\)\}/,
      'renderer must return the save Promise to the Daily Review pending gate',
    );
    assert.match(
      main,
      /onSaveDailyReviewMarkdown=\{\(input\) => saveDailyReviewMarkdown\(input, \{ shouldShowFeedback: isDailyReviewSurfaceActive \}\)\}/,
      'Daily Review save feedback must be gated to the active Daily Review surface',
    );
  });

  it('scrubs Daily Review load and action failures before rendering them', async () => {
    const ui = await readFile(resolve(REPO_ROOT, 'packages/ui/src/components.tsx'), 'utf8');
    const main = await readFile(resolve(REPO_ROOT, 'apps/desktop/src/renderer/main.tsx'), 'utf8');
    const panelBlock = ui.match(/function DailyReviewPanel[\s\S]*?function dailyReviewPanelErrorMessage/)?.[0] ?? '';
    const helperBlock = main.match(/function dailyReviewActionErrorMessage\(error: unknown, fallback: string\): string \{[\s\S]*?\n\}/)?.[0] ?? '';
    const saveBlock = main.match(/async function saveDailyReviewMarkdown\([\s\S]*?const activePermission/)?.[0] ?? '';
    const saveTodayBlock = main.match(/onSaveTodayDailyReviewToFile: async \(\) => \{[\s\S]*?onCopyEnvSummary/)?.[0] ?? '';

    assert.match(ui, /generalizedErrorMessageChinese/);
    assert.match(panelBlock, /setError\(dailyReviewPanelErrorMessage\(err\)\)/);
    assert.doesNotMatch(panelBlock, /err instanceof Error \? err\.message : ['"]加载失败['"]/);
    assert.match(ui, /function dailyReviewPanelErrorMessage\(error: unknown\): string \{[\s\S]*generalizedErrorMessageChinese\(error, '每日回顾暂时不可用，请稍后重试。'\)/);

    assert.match(helperBlock, /generalizedErrorMessageChinese\(error, fallback\)/);
    assert.match(saveBlock, /const shouldShowFeedback = options\.shouldShowFeedback \?\? \(\(\) => true\)/);
    assert.match(
      saveBlock,
      /if \(shouldShowFeedback\(\)\) \{[\s\S]*toastApi\.error\('保存失败', dailyReviewActionErrorMessage\(err, '保存每日回顾失败，请稍后重试。'\)\)/,
      'Daily Review save failures must respect the caller feedback owner predicate',
    );
    assert.match(
      saveTodayBlock,
      /await saveDailyReviewMarkdown\(\{ markdown, label: '今天', summary \}\);/,
      'Command Palette daily-review save remains a global command and should keep default visible feedback',
    );
    assert.match(main, /dailyReviewActionErrorMessage\(err, '今日回顾暂时不可用，或剪贴板被系统拒绝。'\)/);
    assert.match(main, /dailyReviewActionErrorMessage\(err, '今日回顾暂时不可用，请稍后重试。'\)/);
    assert.doesNotMatch(main, /保存每日回顾失败'\)|剪贴板或数据不可用|加载今日回顾失败/);
  });
});
