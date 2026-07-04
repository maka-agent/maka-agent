import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';

const REPO_ROOT = resolve(import.meta.dirname, '../../../../..');
const SESSION_LIST_PANEL_PATH = resolve(REPO_ROOT, 'packages', 'ui', 'src', 'session-list-panel.tsx');

describe('session list public contract', () => {
  it('keeps module panel callbacks out of the sidebar list props', async () => {
    const source = await readFile(SESSION_LIST_PANEL_PATH, 'utf8');
    const propsMatch = source.match(/export function SessionListPanel\s*\(\s*props:\s*\{([\s\S]*?)\}\s*\)/);

    assert.ok(propsMatch, 'SessionListPanel must expose an inline public props contract');
    const propBlock = propsMatch[1]!;

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
      assert.doesNotMatch(propBlock, new RegExp(`\\b${prop}\\b`), `${prop} belongs to ChatView module panels, not SessionListPanel`);
    }
  });
});
