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
  function rendererFunctionBlock(source: string, name: string): string {
    const start = source.indexOf(`async function ${name}(`);
    if (start === -1) return '';
    const next = source.indexOf('\n  async function ', start + 1);
    return source.slice(start, next === -1 ? source.length : next);
  }

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

  it('renders the automations module with PlanReminderPanel in the main content pane', async () => {
    const ui = await readRepo('packages/ui/src/components.tsx');
    assert.match(ui, /if \(props\.mode === 'automations'\)[\s\S]*<PlanReminderPanel/, '计划 module must render PlanReminderPanel in ChatView main content');
    assert.match(ui, /props\.selection\.section === 'automations'[\s\S]*<SidebarModuleHint/, 'sidebar Plan section must stay a navigation hint, not the detail form');
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
    assert.match(ui, /BOT_DELIVERY_PROVIDERS\.map/, 'bot delivery platform picker must list only send-capable bot providers');
    assert.doesNotMatch(ui, /BOT_PROVIDERS\.map\(\(provider\)[\s\S]*botDisplayLabel\(provider\)/, 'bot delivery platform picker must not expose every scaffolded bot provider');
    assert.match(ui, /formatPlanDeliveryProviderList/, 'bot delivery help must derive visible support copy from the send-capable provider allowlist');
    assert.match(ui, /其它机器人平台不会出现在投递目标里/, 'bot delivery help must describe the current supported target set without roadmap bridge copy');
    assert.doesNotMatch(ui, /具备发送 bridge|bridge 后|后续进入/, 'bot delivery help must not expose implementation-roadmap bridge copy');
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
    assert.match(ui, /快速设置提醒时间/, 'create/edit form must expose quick time presets');
    assert.match(ui, /10 分钟后/, 'quick presets must include near-term reminder creation');
    assert.match(ui, /下周一 9 点/, 'quick presets must include weekly planning');
    assert.match(ui, /planReminderPresetRunAt/, 'quick presets must centralize time calculation');
    assert.match(ui, /toPlanReminderDateTimeInputValue/, 'plan time field must format a plain local date-time string');
    assert.match(ui, /placeholder="2026-06-05 13:44"/, 'plan time field must show a readable local date-time example');
    assert.match(ui, /aria-label="提醒时间"/, 'plan time field must have a stable accessible name');
    assert.doesNotMatch(ui, /type="datetime-local"/, 'native datetime-local exposes English Chromium picker controls in the AX tree');
    assert.match(ui, /planReminderFormValidationMessage/, 'create/edit form must centralize validation copy');
    assert.match(ui, /填写标题后才能保存提醒/, 'create/edit form must explain missing title');
    assert.match(ui, /Cron 需要 5 段表达式/, 'create/edit form must explain invalid cron shape');
    assert.match(ui, /选择机器人聊天时需要填写 Chat ID/, 'create/edit form must explain missing bot delivery target');
    assert.match(ui, /role="status"/, 'create/edit form must expose validation feedback to assistive tech');
    assert.match(ui, /comparePlanReminderForDisplay/, 'list must sort reminders as an actionable queue, not raw storage order');
    assert.match(ui, /planReminderNextRunSortValue/, 'scheduled reminders must sort by next run time');
    assert.match(ui, /planReminderLastRunSortValue/, 'completed reminders must sort by recent run history');
    assert.match(ui, /搜索计划提醒/, 'list must expose local search for non-trivial reminder sets');
    assert.match(ui, /planReminderMatchesSearch/, 'list search must be centralized instead of ad hoc JSX checks');
    assert.match(ui, /planReminderSearchText/, 'list search must cover title, note, delivery, recurrence, and run history text');
    assert.match(ui, /没有匹配的提醒/, 'list search must have a distinct empty result state');
    assert.match(ui, /searchMatchedReminders/, 'status counts must reflect the active search query');
    assert.match(ui, /找到 \{searchMatchedReminders\.length\} 个匹配提醒/, 'search must expose a visible result count');
    assert.match(ui, /清除搜索/, 'search must provide a one-click clear action');
    assert.match(ui, /planReminderDisplayRows/, 'all-reminders view must group rows by status');
    assert.match(ui, /maka-plan-group-header/, 'plan reminder groups must have visible headers');
    assert.match(ui, /planReminderStatusGroupLabel/, 'group labels must come from a centralized status mapper');
    assert.equal(
      (ui.match(/className="maka-plan-card-note"/g) ?? []).length,
      1,
      'plan reminder note must render once per card, not duplicate the same note line',
    );
  });

  it('keeps reminder drafts until async create or save succeeds', async () => {
    const [ui, renderer] = await Promise.all([
      readRepo('packages/ui/src/components.tsx'),
      readRepo('apps/desktop/src/renderer/main.tsx'),
    ]);

    const panelBlock = ui.match(/function PlanReminderPanel[\s\S]*?function comparePlanReminderForDisplay/)?.[0] ?? '';
    assert.match(panelBlock, /const \[submitPending, setSubmitPending\] = useState\(false\)/, 'plan form must gate duplicate async submits');
    assert.match(panelBlock, /const submitDisabled = !canCreate \|\| submitPending/, 'pending create/save must disable the submit button');
    assert.match(panelBlock, /const formInteractionDisabled = submitPending/, 'pending create/save must also freeze the editable draft controls');
    assert.match(panelBlock, /data-maka-plan-title-input="true"[\s\S]*disabled=\{formInteractionDisabled\}/, 'pending create/save must disable title edits');
    assert.match(panelBlock, /aria-label="提醒时间"[\s\S]*disabled=\{formInteractionDisabled\}/, 'pending create/save must disable time edits');
    assert.match(panelBlock, /className="maka-plan-preset"[\s\S]*disabled=\{formInteractionDisabled\}/, 'pending create/save must disable quick presets');
    assert.match(panelBlock, /<select[\s\S]*value=\{recurrence\}[\s\S]*disabled=\{formInteractionDisabled\}/, 'pending create/save must disable recurrence changes');
    assert.match(panelBlock, /placeholder="可选：补充需要提醒的上下文"[\s\S]*disabled=\{formInteractionDisabled\}/, 'pending create/save must disable note edits');
    assert.match(panelBlock, /onClick=\{resetForm\}[\s\S]*disabled=\{formInteractionDisabled\}/, 'cancel edit must not clear the draft while create/save is pending');
    assert.match(panelBlock, /onClick=\{\(\) => editReminder\(reminder\)\}[\s\S]*disabled=\{submitPending \|\| reminderActionPending \|\| reminder\.status === 'completed'\}/, 'row edit must not overwrite a pending create/save draft');
    assert.match(panelBlock, /onClick=\{\(\) => duplicateReminder\(reminder\)\}[\s\S]*disabled=\{submitPending \|\| reminderActionPending\}/, 'row duplicate must not overwrite a pending create/save draft');
    assert.match(panelBlock, /const result = editingId[\s\S]*await props\.onUpdate\?\.\(editingId, input\)[\s\S]*await props\.onCreate\?\.\(/, 'plan form must await async create/save callbacks');
    assert.match(panelBlock, /if \(result !== false && planReminderMountedRef\.current\) resetForm\(\)/, 'plan form must keep the user draft when the parent reports failure and avoid late reset after unmount');
    assert.match(panelBlock, /if \(planReminderMountedRef\.current\) setSubmitPending\(false\)/, 'plan form must not clear submit state after unmount');
    assert.doesNotMatch(panelBlock, /props\.onCreate\?\([\s\S]*?\);\s*}\s*resetForm\(\)/, 'plan form must not clear fields immediately after firing create');
    assert.match(renderer, /toastApi\.success\('已创建计划提醒'[\s\S]*return true;[\s\S]*toastApi\.error\('创建计划失败'[\s\S]*return false;/, 'createPlanReminder must report success/failure to the form');
    assert.match(renderer, /toastApi\.success\('已保存计划提醒'[\s\S]*return true;[\s\S]*toastApi\.error\('保存计划失败'[\s\S]*return false;/, 'updatePlanReminder must report success/failure to the form');
    assert.match(renderer, /onCreatePlanReminder=\{\(input\) => createPlanReminder\(input\)\}/, 'ChatView must receive the create outcome instead of a voided fire-and-forget wrapper');
    assert.match(renderer, /onUpdatePlanReminder=\{\(id, patch\) => updatePlanReminder\(id, patch\)\}/, 'ChatView must receive the update outcome instead of a voided fire-and-forget wrapper');
    assert.doesNotMatch(renderer, /onCreatePlanReminder=\{\(input\) => void createPlanReminder\(input\)\}/, 'renderer must not discard createPlanReminder failure');
    assert.doesNotMatch(renderer, /onUpdatePlanReminder=\{\(id, patch\) => void updatePlanReminder\(id, patch\)\}/, 'renderer must not discard updatePlanReminder failure');
  });

  it('gates plan row actions while async mutations are pending', async () => {
    const [ui, renderer] = await Promise.all([
      readRepo('packages/ui/src/components.tsx'),
      readRepo('apps/desktop/src/renderer/main.tsx'),
    ]);

    const panelBlock = ui.match(/function PlanReminderPanel[\s\S]*?function comparePlanReminderForDisplay/)?.[0] ?? '';
    assert.match(panelBlock, /const \[pendingActionKeys, setPendingActionKeys\] = useState<ReadonlySet<string>>\(\(\) => new Set\(\)\)/, 'row actions need explicit pending keys');
    assert.match(panelBlock, /const planReminderMountedRef = useRef\(true\)/, 'row action cleanup must know whether the panel is still mounted');
    assert.match(panelBlock, /const pendingActionKeysRef = useRef<Set<string>>\(new Set\(\)\)/, 'the duplicate-click gate must update synchronously through a ref');
    assert.match(
      panelBlock,
      /useEffect\(\(\) => \{[\s\S]*planReminderMountedRef\.current = true;[\s\S]*return \(\) => \{[\s\S]*planReminderMountedRef\.current = false;[\s\S]*pendingActionKeysRef\.current = new Set\(\);[\s\S]*\};[\s\S]*\}, \[\]\)/,
      'plan reminder panel must release pending owners on unmount and restore mounted state during StrictMode replay',
    );
    assert.match(panelBlock, /async function runPlanReminderAction\(/, 'row actions must funnel through one async gate');
    assert.match(panelBlock, /if \(!action \|\| pendingActionKeysRef\.current\.has\(actionKey\)\) return;/, 'the gate must reject duplicate clicks for the same row action');
    assert.match(panelBlock, /pendingWithAction\.add\(actionKey\)/, 'starting an action must publish the pending key');
    assert.match(panelBlock, /await action\(\)/, 'the gate must wait for the renderer IPC action to finish');
    assert.match(panelBlock, /pendingWithoutAction\.delete\(actionKey\)/, 'finishing an action must clear only its own pending key');
    assert.match(panelBlock, /if \(planReminderMountedRef\.current\) setPendingActionKeys\(pendingWithoutAction\)/, 'row action completion must not write state after unmount');
    assert.match(panelBlock, /const reminderActionPending = Array\.from\(pendingActionKeys\)\.some\(\(key\) => key\.startsWith\(reminderActionPrefix\)\)/);
    assert.match(panelBlock, /disabled=\{reminderActionPending \|\| !reminder\.enabled\}/, 'manual trigger must be disabled while the row is mutating');
    assert.match(panelBlock, /disabled=\{reminderActionPending \|\| !reminder\.enabled \|\| reminder\.status !== 'scheduled'/, 'snooze must be disabled while the row is mutating');
    assert.match(panelBlock, /pendingActionKeys\.has\(`\$\{reminder\.id\}:trigger`\) \? '触发中…' : '立即触发'/, 'trigger action must show local progress feedback');
    assert.match(panelBlock, /pendingActionKeys\.has\(`\$\{reminder\.id\}:delete`\) \? '删除中…' : '删除'/, 'delete action must show local progress feedback');
    assert.doesNotMatch(panelBlock, /onClick=\{\(\) => props\.onTriggerNow\?\.\(reminder\.id\)\}/, 'trigger must not remain fire-and-forget from the row');
    assert.doesNotMatch(panelBlock, /onClick=\{\(\) => props\.onSnooze\?\.\(reminder\.id\)\}/, 'snooze must not remain fire-and-forget from the row');

    assert.match(renderer, /onTogglePlanReminder=\{\(id, enabled\) => togglePlanReminder\(id, enabled\)\}/);
    assert.match(renderer, /onTriggerPlanReminderNow=\{\(id\) => triggerPlanReminderNow\(id\)\}/);
    assert.match(renderer, /onSnoozePlanReminder=\{\(id\) => snoozePlanReminder\(id\)\}/);
    assert.match(renderer, /onClearPlanReminderRunHistory=\{\(id\) => clearPlanReminderRunHistory\(id\)\}/);
    assert.match(renderer, /onDeletePlanReminder=\{\(id\) => deletePlanReminder\(id\)\}/);
    assert.doesNotMatch(renderer, /onTriggerPlanReminderNow=\{\(id\) => void triggerPlanReminderNow\(id\)\}/, 'renderer must return the trigger promise to the UI pending gate');
    assert.doesNotMatch(renderer, /onSnoozePlanReminder=\{\(id\) => void snoozePlanReminder\(id\)\}/, 'renderer must return the snooze promise to the UI pending gate');
    assert.doesNotMatch(renderer, /onDeletePlanReminder=\{\(id\) => void deletePlanReminder\(id\)\}/, 'renderer must return the delete promise to the UI pending gate');
  });

  it('scopes plan action toasts to the active Automations surface', async () => {
    const renderer = await readRepo('apps/desktop/src/renderer/main.tsx');

    assert.match(renderer, /const navSelectionRef = useRef<NavSelection>\(navSelection\)/);
    assert.match(
      renderer,
      /function isAutomationsSurfaceActive\(\): boolean \{[\s\S]*return navSelectionRef\.current\.section === 'automations';[\s\S]*\}/,
      'plan action feedback must be owned by the current Automations surface',
    );
    assert.match(
      renderer,
      /useEffect\(\(\) => \{[\s\S]*navSelectionRef\.current = navSelection;[\s\S]*\}, \[navSelection\]\)/,
      'navSelectionRef must track module switches while async plan actions are in flight',
    );
    for (const fn of [
      'createPlanReminder',
      'updatePlanReminder',
      'togglePlanReminder',
      'triggerPlanReminderNow',
      'snoozePlanReminder',
      'clearPlanReminderRunHistory',
      'deletePlanReminder',
    ]) {
      const block = rendererFunctionBlock(renderer, fn);
      assert.match(block, /await refreshPlanReminders\(\{ shouldShowError: isAutomationsSurfaceActive \}\)/, `${fn} must still refresh plan data after mutation`);
      assert.doesNotMatch(
        block,
        /await refreshPlanReminders\(\);\s*toastApi\.(success|error)/,
        `${fn} must not show visible feedback unconditionally after the user leaves Automations`,
      );
      assert.doesNotMatch(
        block,
        /await refreshPlanReminders\(\)/,
        `${fn} refresh error feedback must use the current Automations surface owner`,
      );
      assert.match(
        block,
        /if \(isAutomationsSurfaceActive\(\)\) toastApi\.(success|error)/,
        `${fn} visible feedback must be gated to the active Automations surface`,
      );
    }
  });

  it('scheduler records trigger outcomes and emits due events', async () => {
    const main = await readRepo('apps/desktop/src/main/main.ts');
    assert.match(main, /refreshPlanReminderTimers\(\)/, 'app startup must restore reminder timers');
    assert.match(main, /triggerDuePlanReminders/, 'scheduler must process due reminders');
    assert.match(main, /markTriggered/, 'scheduler must persist triggered run records');
    assert.match(main, /deliverPlanReminder/, 'scheduler must route due reminders through the delivery boundary');
    assert.match(main, /isBotDeliveryProvider\(reminder\.delivery\.platform\)/, 'scheduler must reject bot platforms that are not send-capable');
    assert.match(main, /botRegistry\s*\.\s*sendMessage/, 'bot delivery must use the bot registry send boundary');
    assert.match(main, /bot_delivery_unavailable/, 'bot delivery failure must be recorded as blocked, not triggered');
    assert.doesNotMatch(main, /通道未开放投递/, 'blocked bot delivery copy must describe current delivery eligibility, not platform implementation state');
    assert.match(main, /当前不是可投递目标/, 'blocked bot delivery copy should match the delivery-target contract');
    assert.match(main, /plans:due/, 'scheduler must notify renderer when reminder fires');
    assert.match(main, /incognitoActive/, 'scheduler must keep an incognito gate');
    assert.match(
      main,
      /setTimeout\(\(\) => \{[\s\S]*void refreshPlanReminderTimers\(\);[\s\S]*Math\.min\(delay, 2_147_483_647\)/,
      'long-delay timers must re-arm instead of dropping reminders after the max setTimeout window',
    );
  });
});
