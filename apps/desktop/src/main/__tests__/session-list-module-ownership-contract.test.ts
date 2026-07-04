import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';
import { SESSION_LIST_SOURCE_REPO_PATHS } from './session-list-source-helpers.js';

const REPO_ROOT = resolve(import.meta.dirname, '../../../../..');

function repoPath(path: string): string {
  return resolve(REPO_ROOT, path);
}

describe('session list module ownership contract', () => {
  it('keeps the sidebar shell, navigation, and session history in separate owners', async () => {
    for (const path of SESSION_LIST_SOURCE_REPO_PATHS) {
      assert.equal(existsSync(repoPath(path)), true, `${path} must exist`);
    }

    const shell = await readFile(repoPath('packages/ui/src/session-list-panel.tsx'), 'utf8');
    const nav = await readFile(repoPath('packages/ui/src/session-sidebar-nav.tsx'), 'utf8');
    const history = await readFile(repoPath('packages/ui/src/session-history-list.tsx'), 'utf8');

    assert.match(shell, /<SessionSidebarNav\b/);
    assert.match(shell, /<SessionHistoryList\b/);
    assert.doesNotMatch(shell, /function SessionRow\b/);
    assert.doesNotMatch(shell, /rowActionVariants/);
    assert.doesNotMatch(shell, /className="maka-sidebar-modules"/);

    assert.match(nav, /export function SessionSidebarNav\b/);
    assert.match(nav, /className="maka-sidebar-modules"/);
    assert.match(nav, /新任务/);
    assert.match(nav, /每日回顾/);
    assert.match(nav, /技能/);
    assert.match(nav, /定时任务/);
    assert.doesNotMatch(nav, /function SessionRow\b/);
    assert.doesNotMatch(nav, /rowActionVariants/);

    assert.match(history, /export function SessionHistoryList\b/);
    assert.match(history, /function SessionRow\b/);
    assert.match(history, /rowActionVariants/);
    assert.match(history, /<OverlayScrollArea\b/);
    assert.doesNotMatch(history, /className="maka-sidebar-modules"/);
  });

  it('keeps module panel callbacks out of the sidebar list contract', async () => {
    const shell = await readFile(repoPath('packages/ui/src/session-list-panel.tsx'), 'utf8');

    for (const prop of [
      'sessionCounts',
      'userLabel',
      'onRefreshSkills',
      'onCreateSkillTemplate',
      'onOpenSkill',
      'onRefreshPlanReminders',
      'onCreatePlanReminder',
      'onUpdatePlanReminder',
      'onTogglePlanReminder',
      'onTriggerPlanReminderNow',
      'onSnoozePlanReminder',
      'onClearPlanReminderRunHistory',
      'onDeletePlanReminder',
      'onCopyDailyReviewMarkdown',
      'onSaveDailyReviewMarkdown',
      'dailyReviewBridge',
    ]) {
      assert.doesNotMatch(shell, new RegExp(`\\b${prop}\\b`), `${prop} belongs to ChatView module panels, not SessionListPanel`);
    }
  });
});
