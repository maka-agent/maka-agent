import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

const repoRoot = process.cwd().endsWith('apps/desktop')
  ? join(process.cwd(), '..', '..')
  : process.cwd();

async function readRepo(path: string): Promise<string> {
  return readFile(join(repoRoot, path), 'utf8');
}

describe('Plan reminder MVP contract', () => {
  it('exposes real plans IPC through main and preload', async () => {
    const [main, preload, globalTypes] = await Promise.all([
      readRepo('apps/desktop/src/main/main.ts'),
      readRepo('apps/desktop/src/preload/preload.ts'),
      readRepo('apps/desktop/src/global.d.ts'),
    ]);

    for (const channel of ['plans:list', 'plans:create', 'plans:update', 'plans:setEnabled', 'plans:triggerNow', 'plans:snooze', 'plans:clearRunHistory', 'plans:delete']) {
      assert.match(main, new RegExp(`ipcMain\\.handle\\('${channel}'`), `${channel} must be handled in main`);
    }
    assert.match(preload, /plans:\s*\{[\s\S]*list\(\): Promise<PlanReminder\[]>/, 'preload must expose plans.list');
    assert.match(preload, /triggerNow\(id: string\): Promise<PlanReminder>/, 'preload must expose manual trigger');
    assert.match(preload, /snooze\(id: string\): Promise<PlanReminder>/, 'preload must expose snooze');
    assert.match(preload, /clearRunHistory\(id: string\): Promise<PlanReminder>/, 'preload must expose clear run history');
    assert.match(preload, /subscribeDue\(handler: \(reminder: PlanReminder\) => void\)/, 'preload must expose due event');
    assert.match(globalTypes, /triggerNow\(id: string\): Promise<PlanReminder>/, 'global type must expose manual trigger');
    assert.match(globalTypes, /snooze\(id: string\): Promise<PlanReminder>/, 'global type must expose snooze');
    assert.match(globalTypes, /clearRunHistory\(id: string\): Promise<PlanReminder>/, 'global type must expose clear run history');
    assert.match(globalTypes, /plans:\s*\{[\s\S]*create\(input: \{ title: string; note\?: string; runAt: number \| string; recurrence\?: PlanReminderRecurrence; cronExpression\?: string; delivery\?: PlanReminderDeliveryTarget \}\)/, 'global type must include delivery-aware plans API');
  });

  it('replaces the automations placeholder with PlanReminderPanel', async () => {
    const ui = await readRepo('packages/ui/src/components.tsx');
    assert.match(ui, /props\.selection\.section === 'automations'[\s\S]*<PlanReminderPanel/, '计划 module must render PlanReminderPanel');
    assert.doesNotMatch(ui, /title:\s*'计划任务即将推出'/, '计划 must not be the old coming-soon placeholder');
    assert.match(ui, /创建提醒/, '计划 UI must include reminder creation');
    assert.match(ui, /编辑提醒/, '计划 UI must include reminder editing');
    assert.match(ui, /保存提醒/, '计划 edit UI must save through the existing update path');
    assert.match(ui, /onUpdatePlanReminder/, 'renderer must wire PlanReminderPanel edits to plans.update');
    assert.match(ui, /复制/, '计划 UI must support duplicating an existing reminder into the create form');
    assert.match(ui, /duplicateReminder/, 'duplicate action must reuse the create form instead of adding a second persistence path');
    assert.match(ui, /下次触发/, '计划 UI must show next trigger time');
    assert.match(ui, /重复/, '计划 UI must expose recurrence instead of only one-shot reminders');
    assert.match(ui, /Cron/, '计划 UI must expose cron syntax instead of only fixed recurrence presets');
    assert.match(ui, /机器人聊天/, '计划 UI must expose bot delivery instead of hiding platform delivery behind code only');
    assert.match(ui, /Chat ID/, 'bot delivery must require an explicit target chat id');
    assert.match(ui, /立即触发/, '计划 UI must expose a manual trigger path for smoke-testing delivery');
    assert.match(ui, /延后 10 分钟/, '计划 UI must expose a bounded snooze path');
    assert.match(ui, /清空记录/, '计划 UI must clear run history without deleting the reminder');
    assert.match(ui, /onClearRunHistory/, 'clear history action must be wired through PlanReminderPanel');
    assert.match(ui, /计划提醒筛选/, '计划 UI must expose list filtering for non-trivial reminder lists');
    assert.match(ui, /当前筛选没有提醒/, '计划 UI must distinguish empty filters from an empty reminder store');
    assert.match(ui, /filterCounts/, 'filter buttons must show counts per reminder status');
    assert.match(ui, /activePlanReminderCount/, 'sidebar Plan nav must derive an active reminder count');
    assert.match(ui, /maka-nav-count/, 'sidebar Plan nav must surface the active reminder count');
    assert.match(ui, /status !== 'completed'/, 'sidebar Plan nav count must exclude completed history rows');
  });

  it('scheduler records trigger outcomes and emits due events', async () => {
    const main = await readRepo('apps/desktop/src/main/main.ts');
    assert.match(main, /refreshPlanReminderTimers\(\)/, 'app startup must restore reminder timers');
    assert.match(main, /triggerDuePlanReminders/, 'scheduler must process due reminders');
    assert.match(main, /markTriggered/, 'scheduler must persist triggered run records');
    assert.match(main, /deliverPlanReminder/, 'scheduler must route due reminders through the delivery boundary');
    assert.match(main, /botRegistry\s*\.\s*sendMessage/, 'bot delivery must use the bot registry send boundary');
    assert.match(main, /bot_delivery_unavailable/, 'bot delivery failure must be recorded as blocked, not triggered');
    assert.match(main, /plans:due/, 'scheduler must notify renderer when reminder fires');
    assert.match(main, /incognitoActive/, 'scheduler must keep an incognito gate');
    assert.match(
      main,
      /setTimeout\(\(\) => \{[\s\S]*void refreshPlanReminderTimers\(\);[\s\S]*Math\.min\(delay, 2_147_483_647\)/,
      'long-delay timers must re-arm instead of dropping reminders after the max setTimeout window',
    );
  });
});
