import { strict as assert } from 'node:assert';
import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';
import { join } from 'node:path';

const repoRoot = process.cwd().endsWith('apps/desktop')
  ? join(process.cwd(), '..', '..')
  : process.cwd();

async function readRepo(path: string): Promise<string> {
  return readFile(join(repoRoot, path), 'utf8');
}

describe('module main surface contract', () => {
  it('renders Daily Review in the main content pane, not the sidebar list pane', async () => {
    const ui = await readRepo('packages/ui/src/components.tsx');
    const sidebarListBlock = ui.match(/<section className="maka-session-list"[\s\S]*?<footer className="maka-session-panel-footer">/)?.[0] ?? '';
    const dailyReviewModeBlock = ui.match(/if \(props\.mode === 'daily-review'\) \{[\s\S]*?^\s*\}/m)?.[0] ?? '';

    assert.match(dailyReviewModeBlock, /className="maka-main detailPane maka-module-main agents-chat-panel" aria-label="每日回顾"/);
    assert.match(dailyReviewModeBlock, /<DailyReviewPanel/);
    assert.doesNotMatch(sidebarListBlock, /<DailyReviewPanel/);
    assert.doesNotMatch(sidebarListBlock, /title="每日回顾"[\s\S]*body="已在右侧内容栏打开。"/);
    assert.match(sidebarListBlock, /const title = '会话'|aria-label=\{title\}/);
    assert.match(sidebarListBlock, /<SessionListGroups/);
  });

  it('uses range-aware Daily Review empty copy instead of day-only copy for week/month ranges', async () => {
    const ui = await readRepo('packages/ui/src/components.tsx');
    const panelBlock = ui.match(/function DailyReviewPanel[\s\S]*?function PlanReminderPanel/)?.[0] ?? '';

    assert.match(panelBlock, /const emptyActivityBody = range === 1/);
    assert.match(panelBlock, /\$\{dayLabel\}范围内没有发起对话/);
    assert.match(panelBlock, /title=\{emptyActivityTitle\}/);
    assert.match(panelBlock, /body=\{emptyActivityBody\}/);
  });

  it('wires Daily Review retry to a real reload trigger instead of a no-op state write', async () => {
    const ui = await readRepo('packages/ui/src/components.tsx');
    const panelBlock = ui.match(/function DailyReviewPanel[\s\S]*?function PlanReminderPanel/)?.[0] ?? '';

    assert.match(
      panelBlock,
      /const \[reloadToken, setReloadToken\] = useState\(0\)/,
      'Daily Review needs an explicit retry token so retry works when the date/range did not change',
    );
    assert.match(
      panelBlock,
      /\}, \[offsetDays, range, reloadToken, props\.bridge\]\)/,
      'Daily Review fetch effect must depend on the retry token',
    );
    assert.match(
      panelBlock,
      /cta=\{\{ label: '重试', onClick: \(\) => setReloadToken\(\(n\) => n \+ 1\) \}\}/,
      'Retry must mutate the retry token and force a new fetch',
    );
    assert.doesNotMatch(
      panelBlock,
      /cta=\{\{ label: '重试', onClick: \(\) => setOffsetDays\(\(n\) => n\) \}\}/,
      'Retry must not set the same offsetDays value, because React will bail out and skip refetch',
    );
  });

  it('keeps same-scope Daily Review data visible when refresh fails', async () => {
    const ui = await readRepo('packages/ui/src/components.tsx');
    const panelBlock = ui.match(/function DailyReviewPanel[\s\S]*?function PlanReminderPanel/)?.[0] ?? '';

    assert.match(ui, /function dailyReviewScopeKey\(offsetDays: number, range: DailyReviewRange\): string/);
    assert.match(panelBlock, /const \[summaryScopeKey, setSummaryScopeKey\] = useState<string \| null>\(null\)/);
    assert.match(panelBlock, /const summaryScopeKeyRef = useRef<string \| null>\(null\)/);
    assert.match(
      panelBlock,
      /const visibleSummary = summaryScopeKey === currentSummaryScopeKey \? summary : null/,
      'Daily Review must not render a previous date/range summary under the current label',
    );
    assert.match(panelBlock, /summaryScopeKeyRef\.current = scopeKey/);
    assert.match(panelBlock, /setSummaryScopeKey\(scopeKey\)/);
    assert.match(
      panelBlock,
      /if \(summaryScopeKeyRef\.current !== scopeKey\) \{[\s\S]*setSummary\(null\)[\s\S]*setSummaryScopeKey\(null\)/,
      'Only a different-scope load failure may clear the visible summary',
    );
    assert.doesNotMatch(
      panelBlock,
      /\.catch\(\(err: unknown\) => \{[\s\S]*?if \(cancelled\) return;\s*setSummary\(null\);\s*setError/,
      'Same-scope refresh failures should preserve the current Daily Review dashboard',
    );
    assert.match(panelBlock, /<Alert variant="warning" className="maka-daily-review-alert">/);
    assert.match(panelBlock, /每日回顾刷新失败：\{error\}/);
    assert.match(panelBlock, /summary: visibleSummary/);
  });

  it('renders Skills in the main content pane, not as a left-bottom list', async () => {
    const ui = await readRepo('packages/ui/src/components.tsx');
    const sidebarListBlock = ui.match(/<section className="maka-session-list"[\s\S]*?<footer className="maka-session-panel-footer">/)?.[0] ?? '';
    const skillsModeBlock = ui.match(/if \(props\.mode === 'skills'\) \{[\s\S]*?^\s*\}/m)?.[0] ?? '';
    const skillsModuleMain = ui.match(/function SkillsModuleMain\([\s\S]*?function DailyReviewPanel/)?.[0] ?? '';

    assert.match(skillsModeBlock, /<SkillsModuleMain/);
    assert.match(skillsModuleMain, /className="maka-main detailPane maka-module-main agents-chat-panel" aria-label="技能"/);
    assert.match(skillsModuleMain, /className="maka-module-main-actions" role="group" aria-label="技能操作"/);
    assert.match(skillsModuleMain, /<SkillLibraryPanel/);
    assert.doesNotMatch(sidebarListBlock, /<SkillLibraryPanel/);
    assert.doesNotMatch(sidebarListBlock, /maka-skill-examples/);
    assert.doesNotMatch(sidebarListBlock, /title="技能库"[\s\S]*body="已在右侧内容栏打开。"/);
    assert.match(sidebarListBlock, /<SessionListGroups/);
  });

  it('renders Plan reminders in the main content pane, not as a left-bottom form', async () => {
    const ui = await readRepo('packages/ui/src/components.tsx');
    const sidebarListBlock = ui.match(/<section className="maka-session-list"[\s\S]*?<footer className="maka-session-panel-footer">/)?.[0] ?? '';
    const automationsModeBlock = ui.match(/if \(props\.mode === 'automations'\) \{[\s\S]*?^\s*\}/m)?.[0] ?? '';

    assert.match(automationsModeBlock, /className="maka-main detailPane maka-module-main agents-chat-panel" aria-label="计划"/);
    assert.match(automationsModeBlock, /<PlanReminderPanel/);
    assert.doesNotMatch(sidebarListBlock, /<PlanReminderPanel/);
    assert.doesNotMatch(sidebarListBlock, /title="计划"[\s\S]*body="已在右侧内容栏打开。"/);
    assert.match(sidebarListBlock, /<SessionListGroups/);
  });

  it('names Daily Review lists for assistive technology', async () => {
    const ui = await readRepo('packages/ui/src/components.tsx');
    const panelBlock = ui.match(/function DailyReviewPanel[\s\S]*?function PlanReminderPanel/)?.[0] ?? '';
    const topListBlock = ui.match(/function DailyReviewTopList[\s\S]*?function PlanReminderPanel/)?.[0] ?? '';

    assert.match(panelBlock, /<ul className="maka-daily-review-list" aria-label="活跃对话列表">/);
    assert.match(topListBlock, /<ul className="maka-daily-review-list" aria-label=\{`\$\{props\.title\}列表`\}>/);
  });

  it('uses a segmented language control instead of a native select in Settings personalization', async () => {
    const settings = await readRepo('apps/desktop/src/renderer/settings/SettingsModal.tsx');
    const personalizationBlock = settings.match(/function PersonalizationSettingsPage[\s\S]*?function ThemePreviewMock/)?.[0] ?? '';

    assert.match(personalizationBlock, /<Segmented[\s\S]*ariaLabel="界面语言"/);
    assert.doesNotMatch(personalizationBlock, /<select[\s\S]*aria-label="界面语言"/);
    assert.match(settings, /role="radiogroup"[\s\S]*aria-label=\{props\.ariaLabel\}/);
    assert.match(settings, /role="radio"[\s\S]*aria-checked=\{props\.value === value\}/);
  });

  it('keeps visual-smoke scenarios for the main module surfaces', async () => {
    const fixture = await readRepo('apps/desktop/src/main/visual-smoke-fixture.ts');
    const screenshots = await readRepo('scripts/capture-screenshots.mjs');

    assert.match(fixture, /'module-skills'/);
    assert.match(fixture, /'module-daily-review'/);
    assert.match(fixture, /'plan-reminders'/);
    assert.match(screenshots, /'module-skills'/);
    assert.match(screenshots, /'module-daily-review'/);
    assert.match(screenshots, /'plan-reminders'/);
  });

  it('uses an inset accent focus treatment for form fields instead of an exterior grey rectangle', async () => {
    const css = await readRepo('apps/desktop/src/renderer/styles.css');
    const focusRule = css.match(/:where\(input, select, textarea\):focus\s*\{[\s\S]*?\}/)?.[0] ?? '';

    assert.match(focusRule, /outline:\s*none/);
    assert.match(focusRule, /border-color:\s*oklch\(from var\(--accent\)/);
    assert.match(focusRule, /box-shadow:\s*inset 0 0 0 1px oklch\(from var\(--accent\)/);
    assert.match(focusRule, /!important/);
  });
});
