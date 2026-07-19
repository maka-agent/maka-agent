import { useEffect, useRef, useState } from 'react';
import { Button as BaseButton } from '@base-ui/react/button';
import { useMountedRef } from './use-mounted-ref.js';
import { useToast } from './toast.js';
import {
  ArchiveRestore,
  Clock,
  Copy,
  Info,
  MoreHorizontal,
  Pencil,
  Plus,
  RefreshCcw,
  Repeat,
  Trash2,
} from './icons.js';
import type {
  CapabilityAuditReport,
  PlanReminder,
  PlanReminderStatus,
} from '@maka/core';
import {
  deriveCapabilityAuditReport,
  formatPlanReminderDeliveryTarget,
  generalizedErrorMessageChinese,
} from '@maka/core';
import {
  PLAN_REMINDER_EXAMPLE_TEMPLATES,
  type PlanReminderExampleTemplate,
  type PlanReminderFormSeed,
  comparePlanReminderBySort,
  createPlanReminderFormSeed,
  formatPlanRecurrence,
  formatReminderCountdown,
  formatReminderTime,
  normalizePlanReminderSearchQuery,
  planReminderDuplicateSeed,
  planReminderEditSeed,
  planReminderMatchesSearch,
  planReminderRunRangeStart,
  planReminderStatusLabel,
  planReminderTemplateSeed,
  runStatusLabel,
} from './plan-reminder-helpers.js';
import { PlanReminderFormDialog } from './plan-reminder-form-dialog.js';
import { PlanReminderSelect } from './plan-reminder-select.js';
import {
  Button as UiButton,
  Switch,
  TabsList,
  TabsPanel,
  TabsRoot,
  TabsTrigger,
} from './ui.js';
import { SettingsSwitch } from './primitives/settings-switch.js';
import { Badge } from './primitives/badge.js';
import { Chip, type ChipProps } from './primitives/chip.js';
import { PageHeader } from './primitives/page-header.js';
import { Input } from './primitives/input.js';
import { Menu, MenuItem, MenuPopup, MenuTrigger } from './primitives/menu.js';
import { EmptyState } from './empty-state.js';
import { CapabilityAuditStrip } from './capability-audit-strip.js';
import type {
  PlanReminderDraftInput,
  PlanReminderUpdatePatch,
} from './module-panel-types.js';

// Run-history status Chip tone. triggered = it fired (info, informational,
// not a health signal), blocked = intentionally skipped (warning), failed =
// delivery error (destructive). Exception-only: no success green for a plain
// "it ran" record.
function planRunStatusChipTone(
  status: NonNullable<PlanReminder['lastRun']>['status'],
): ChipProps['variant'] {
  if (status === 'blocked') return 'warning';
  if (status === 'failed') return 'destructive';
  return 'info';
}

export function PlanReminderPanel(props: {
  reminders: PlanReminder[];
  auditReport?: CapabilityAuditReport;
  /**
   * Current persisted 保持系统唤醒 state. `undefined` means the capability is
   * unavailable (bridge absent / older main) — the row hides entirely.
   */
  keepSystemAwake?: boolean;
  /** Persist a new keep-awake value; rejects on failure so the row reverts. */
  onKeepSystemAwakeChange?: (next: boolean) => Promise<void>;
  onRefresh?(): void | Promise<void>;
  onCreate?(input: PlanReminderDraftInput): boolean | Promise<boolean> | void | Promise<void>;
  onUpdate?(id: string, patch: PlanReminderUpdatePatch): boolean | Promise<boolean> | void | Promise<void>;
  onToggle?(id: string, enabled: boolean): void | Promise<void>;
  onTriggerNow?(id: string): void | Promise<void>;
  onSnooze?(id: string): void | Promise<void>;
  onClearRunHistory?(id: string): void | Promise<void>;
  onDelete?(id: string): void | Promise<void>;
}) {
  // 'active' = scheduled + paused — the default view and the tab badge
  // count, matching the sidebar nav badge (which also excludes completed).
  type PlanReminderListFilter = 'active' | 'all' | PlanReminderStatus;
  type PlanReminderView = 'tasks' | 'runs';
  type PlanReminderRunRange = 'day' | 'week' | 'month' | 'all';
  type PlanReminderSort = 'created-desc' | 'next-run-asc' | 'updated-desc';
  const [pendingActionKeys, setPendingActionKeys] = useState<ReadonlySet<string>>(() => new Set());
  const planReminderMountedRef = useMountedRef();
  const refreshPendingRef = useRef(false);
  const pendingActionKeysRef = useRef<Set<string>>(new Set());
  // Issue #1044: all create/edit form fields + submit moved into
  // PlanReminderFormDialog. The panel only tracks whether the dialog is
  // open and which seed it mounts with; `formNonce` remounts the dialog per
  // open so the form initializes from the seed.
  const [formDialogOpen, setFormDialogOpen] = useState(false);
  const [formSeed, setFormSeed] = useState<PlanReminderFormSeed>(() => createPlanReminderFormSeed());
  const [formNonce, setFormNonce] = useState(0);
  const [planView, setPlanView] = useState<PlanReminderView>('tasks');
  const [runRange, setRunRange] = useState<PlanReminderRunRange>('week');
  const [listFilter, setListFilter] = useState<PlanReminderListFilter>('active');
  const [listSort, setListSort] = useState<PlanReminderSort>('created-desc');
  const [listQuery, setListQuery] = useState('');
  const [refreshPending, setRefreshPending] = useState(false);
  const toast = useToast();
  // 保持系统唤醒 capability control. Available only when the host wires both
  // the current value and the setter (bridge present); otherwise the row
  // hides. Local optimistic state drives the switch, initialized from the
  // persisted snapshot and re-synced when the prop changes (but never while a
  // write is in flight, so a slow snapshot can't clobber the optimistic flip).
  const keepSystemAwakeSupported =
    props.keepSystemAwake !== undefined && typeof props.onKeepSystemAwakeChange === 'function';
  const [keepSystemAwakeChecked, setKeepSystemAwakeChecked] = useState(props.keepSystemAwake ?? false);
  const [keepSystemAwakePending, setKeepSystemAwakePending] = useState(false);
  const keepSystemAwakePendingRef = useRef(false);
  const normalizedListQuery = normalizePlanReminderSearchQuery(listQuery);
  const searchMatchedReminders = normalizedListQuery
    ? props.reminders.filter((reminder) => planReminderMatchesSearch(reminder, normalizedListQuery))
    : props.reminders;
  const visibleReminders = listFilter === 'all'
    ? searchMatchedReminders
    : listFilter === 'active'
      ? searchMatchedReminders.filter((reminder) => reminder.status !== 'completed')
      : searchMatchedReminders.filter((reminder) => reminder.status === listFilter);
  const sortedReminders = [...visibleReminders].sort((a, b) => comparePlanReminderBySort(a, b, listSort));
  const runRangeStart = planReminderRunRangeStart(runRange, Date.now());
  const visibleRunEntries = props.reminders
    .flatMap((reminder) => reminder.runs.map((run) => ({ reminder, run })))
    .filter((entry) => runRangeStart === null || entry.run.at >= runRangeStart)
    .sort((a, b) => b.run.at - a.run.at);
  const filterCounts: Record<PlanReminderListFilter, number> = {
    active: searchMatchedReminders.filter((reminder) => reminder.status !== 'completed').length,
    all: searchMatchedReminders.length,
    scheduled: searchMatchedReminders.filter((reminder) => reminder.status === 'scheduled').length,
    paused: searchMatchedReminders.filter((reminder) => reminder.status === 'paused').length,
    completed: searchMatchedReminders.filter((reminder) => reminder.status === 'completed').length,
  };
  const auditReport = props.auditReport ?? deriveCapabilityAuditReport({ planReminders: props.reminders });

  useEffect(() => {
    return () => {
      refreshPendingRef.current = false;
      pendingActionKeysRef.current = new Set();
      keepSystemAwakePendingRef.current = false;
    };
  }, []);

  // Re-sync the switch to the persisted snapshot when it changes (external
  // edit, relaunch), unless a local write is mid-flight — the optimistic
  // value wins until the write settles.
  useEffect(() => {
    if (keepSystemAwakePendingRef.current) return;
    if (props.keepSystemAwake !== undefined) setKeepSystemAwakeChecked(props.keepSystemAwake);
  }, [props.keepSystemAwake]);

  async function toggleKeepSystemAwake(next: boolean) {
    if (!props.onKeepSystemAwakeChange || keepSystemAwakePendingRef.current) return;
    keepSystemAwakePendingRef.current = true;
    setKeepSystemAwakePending(true);
    setKeepSystemAwakeChecked(next); // optimistic
    try {
      await props.onKeepSystemAwakeChange(next);
    } catch (error) {
      // Revert to reflect REALITY, and surface the failure in Chinese.
      if (planReminderMountedRef.current) setKeepSystemAwakeChecked(!next);
      toast.error(
        '无法更新保持系统唤醒',
        generalizedErrorMessageChinese(error, '更新保持系统唤醒设置失败，请稍后重试。'),
      );
    } finally {
      keepSystemAwakePendingRef.current = false;
      if (planReminderMountedRef.current) setKeepSystemAwakePending(false);
    }
  }

  function openReminderDialog(seed: PlanReminderFormSeed) {
    setFormSeed(seed);
    setFormNonce((nonce) => nonce + 1);
    setFormDialogOpen(true);
  }

  function openCreateReminderDialog() {
    openReminderDialog(createPlanReminderFormSeed());
  }

  function openPlanReminderTemplate(template: PlanReminderExampleTemplate) {
    openReminderDialog(planReminderTemplateSeed(template));
  }

  function editReminder(reminder: PlanReminder) {
    openReminderDialog(planReminderEditSeed(reminder));
  }

  function duplicateReminder(reminder: PlanReminder) {
    openReminderDialog(planReminderDuplicateSeed(reminder));
  }

  async function runPlanReminderAction(
    actionKey: string,
    action: (() => void | Promise<void>) | undefined,
  ) {
    if (!action || pendingActionKeysRef.current.has(actionKey)) return;
    const pendingWithAction = new Set(pendingActionKeysRef.current);
    pendingWithAction.add(actionKey);
    pendingActionKeysRef.current = pendingWithAction;
    setPendingActionKeys(pendingWithAction);
    try {
      await action();
    } finally {
      const pendingWithoutAction = new Set(pendingActionKeysRef.current);
      pendingWithoutAction.delete(actionKey);
      pendingActionKeysRef.current = pendingWithoutAction;
      if (planReminderMountedRef.current) setPendingActionKeys(pendingWithoutAction);
    }
  }

  async function refreshFromPanel() {
    if (!props.onRefresh || refreshPendingRef.current) return;
    refreshPendingRef.current = true;
    setRefreshPending(true);
    try {
      await props.onRefresh();
    } finally {
      refreshPendingRef.current = false;
      if (planReminderMountedRef.current) setRefreshPending(false);
    }
  }

  return (
    <div className="maka-plan-panel">
      <div className="maka-plan-shell agents-inner-view-clamp">
        <PageHeader
          as_wrapper="div"
          className="maka-plan-hero"
          as="h2"
          title="定时任务"
          subtitle="创建和管理周期性任务，让 Maka 按计划执行提醒、复盘和投递。"
          contentClassName="maka-plan-heading"
          actions={
          <div className="maka-plan-top-actions" aria-label="计划提醒操作">
            <UiButton
              type="button"
              variant="quiet"
              size="icon"
              onClick={() => void refreshFromPanel()}
              disabled={!props.onRefresh || refreshPending}
              aria-label={refreshPending ? '正在刷新定时任务' : '刷新定时任务'}
              aria-busy={refreshPending ? 'true' : undefined}
              title={refreshPending ? '正在刷新定时任务' : '刷新定时任务'}
            >
              <RefreshCcw size={15} aria-hidden="true" />
            </UiButton>
            {/* Designer audit P2-14: 通过 Maka 创建 was a second button
                wired to the EXACT same handler as 新建定时任务 — pure
                duplication competing for the primary action. One entry
                point; reintroduce a second button only when a genuinely
                different (chat-driven) flow exists. */}
            <UiButton type="button" onClick={openCreateReminderDialog}>
              <Plus size={15} aria-hidden="true" />
              新建定时任务
            </UiButton>
          </div>
          }
        />

        {/* PR-UI-ALIGN-1 (2026-06-21): the inline example-template strip
            (每日新闻摘要 / 周末待办整理) cluttered the top of the page and has no
            equivalent in 参考实现, whose 定时任务 page goes straight
            header → info-banner → tabs → card grid. Templates now live only in
            the empty state (quick-start), so the populated/default view matches
            the reference's clean flow. */}

        {/* Designer audit P1-5 follow-through: the earlier placeholder tag
            (removed for placeholder honesty) is now shipped as a REAL control.
            Status-color restraint keeps this informational-expected capability
            row neutral (passive surface + switch), not a saturated banner. The
            row hides entirely when the host can't wire the toggle. */}
        {keepSystemAwakeSupported && (
          <div className="maka-plan-system-awake" data-tone="passive">
            <div className="maka-plan-system-awake-main">
              <Info size={15} aria-hidden="true" />
              <span>定时任务仅在电脑保持唤醒时运行</span>
            </div>
            <div className="maka-plan-system-awake-control">
              <span className="maka-plan-system-awake-label">保持系统唤醒</span>
              <SettingsSwitch
                ariaLabel="保持系统唤醒"
                checked={keepSystemAwakeChecked}
                disabled={keepSystemAwakePending}
                onChange={(next) => void toggleKeepSystemAwake(next)}
              />
            </div>
          </div>
        )}

        <CapabilityAuditStrip report={auditReport} />

        <TabsRoot
          className="maka-plan-tabs"
          value={planView}
          onValueChange={(value) => {
            if (value === 'tasks' || value === 'runs') setPlanView(value);
          }}
        >
          <div className="maka-plan-tabs-bar">
            <TabsList variant="underline" className="maka-plan-tabs-list" aria-label="计划提醒视图">
              <TabsTrigger className="maka-plan-tab" value="tasks">
                我的定时任务
                <span>{props.reminders.filter((reminder) => reminder.status !== 'completed').length}</span>
              </TabsTrigger>
              <TabsTrigger className="maka-plan-tab" value="runs">
                执行记录
                <span>{visibleRunEntries.length}</span>
              </TabsTrigger>
            </TabsList>
            {planView === 'tasks' ? (
              <div className="maka-plan-toolbar" aria-label="计划提醒筛选">
                <label className="maka-plan-compact-select maka-plan-sort-select">
                  <span>排序</span>
                  <PlanReminderSelect
                    value={listSort}
                    onChange={(value) => setListSort(value)}
                    ariaLabel="定时任务排序"
                    options={[
                      ['created-desc', '按创建时间倒序'],
                      ['next-run-asc', '按下次触发升序'],
                      ['updated-desc', '按更新时间倒序'],
                    ] satisfies ReadonlyArray<readonly [PlanReminderSort, string]>}
                  />
                </label>
                <label className="maka-plan-search">
                  <span>搜索计划提醒</span>
                  <Input
                    value={listQuery}
                    onChange={(event) => setListQuery(event.currentTarget.value)}
                    maxLength={120}
                    placeholder="搜索标题、备注、投递或执行记录…"
                  />
                </label>
                <label className="maka-plan-compact-select">
                  <span>状态</span>
                  <PlanReminderSelect
                    value={listFilter}
                    onChange={(value) => setListFilter(value)}
                    ariaLabel="计划提醒筛选"
                    options={[
                      ['active', `进行中 ${filterCounts.active}`],
                      ['all', `全部 ${filterCounts.all}`],
                      ['scheduled', `待触发 ${filterCounts.scheduled}`],
                      ['paused', `已暂停 ${filterCounts.paused}`],
                      ['completed', `已完成 ${filterCounts.completed}`],
                    ] satisfies ReadonlyArray<readonly [PlanReminderListFilter, string]>}
                  />
                </label>
              </div>
            ) : (
              <div className="maka-plan-toolbar maka-plan-toolbar-compact" aria-label="执行记录筛选">
                <label className="maka-plan-compact-select">
                  <span>范围</span>
                  <PlanReminderSelect
                    value={runRange}
                    onChange={(value) => setRunRange(value)}
                    ariaLabel="执行记录范围"
                    options={[
                      ['day', '今天'],
                      ['week', '近 7 天'],
                      ['month', '近 30 天'],
                      ['all', '全部记录'],
                    ] satisfies ReadonlyArray<readonly [PlanReminderRunRange, string]>}
                  />
                </label>
              </div>
            )}
          </div>

          <TabsPanel className="maka-plan-tab-panel" value="tasks">
            {normalizedListQuery && (
              <div className="maka-plan-search-summary" role="status" aria-live="polite">
                <span>找到 {searchMatchedReminders.length} 个匹配提醒</span>
                <UiButton type="button" variant="ghost" size="sm" onClick={() => setListQuery('')}>清除搜索</UiButton>
              </div>
            )}
            {props.reminders.length === 0 ? (
              <div className="maka-plan-empty-wrap" data-mode="starter-cards">
                <div className="maka-plan-template-strip" data-layout="cards" aria-label="定时任务示例模板">
                  {PLAN_REMINDER_EXAMPLE_TEMPLATES.map((template) => (
                    <BaseButton
                      key={template.id}
                      type="button"
                      className="maka-plan-template-card"
                      onClick={() => openPlanReminderTemplate(template)}
                    >
                      <span className="maka-plan-template-icon" aria-hidden="true">
                        <span className="maka-plan-template-switch" />
                      </span>
                      <span className="maka-plan-template-main">
                        <span className="maka-plan-template-title">{template.title}</span>
                        <span className="maka-plan-template-note">{template.note}</span>
                      </span>
                      <span className="maka-plan-template-schedule">
                        <Clock size={13} aria-hidden="true" />
                        {template.scheduleLabel}
                      </span>
                    </BaseButton>
                  ))}
                </div>
              </div>
            ) : sortedReminders.length === 0 ? (
              <EmptyState
                Icon={Clock}
                title={normalizedListQuery ? '没有匹配的提醒' : '当前筛选没有提醒'}
                body={normalizedListQuery ? '调整搜索词，或切换状态筛选查看其他提醒。' : '切换筛选查看其他状态，或创建新的计划提醒。'}
                secondaryCta={{ label: '清除搜索', onClick: () => setListQuery(''), disabled: !normalizedListQuery }}
                extraClassName="maka-plan-empty"
              />
            ) : (
              <div className="maka-plan-card-grid agents-dual-card-row" aria-label="计划提醒列表">
                {sortedReminders.map((reminder) => {
                  const reminderActionPrefix = `${reminder.id}:`;
                  const reminderActionPending = Array.from(pendingActionKeys).some((key) => key.startsWith(reminderActionPrefix));
                  return (
                    <article key={reminder.id} className="maka-plan-card" data-status={reminder.status}>
                      <div className="maka-plan-card-chrome">
                        {/* Completed one-shot reminders can never be
                            re-enabled — a disabled OFF switch there read
                            as "paused", not "done". Show the terminal
                            state instead of a dead control. */}
                        {reminder.status === 'completed' ? (
                          <Badge variant="secondary" className="maka-plan-card-done-badge">已完成</Badge>
                        ) : (
                          <Switch
                            checked={reminder.enabled}
                            disabled={reminderActionPending}
                            aria-label={reminder.enabled ? '暂停提醒' : '启用提醒'}
                            onCheckedChange={() => void runPlanReminderAction(`${reminder.id}:toggle`, () => props.onToggle?.(reminder.id, !reminder.enabled))}
                          />
                        )}
                        <Menu>
                          <MenuTrigger
                            className="maka-plan-card-menu-trigger"
                            disabled={reminderActionPending}
                            aria-label="提醒操作"
                          >
                            <MoreHorizontal size={16} aria-hidden="true" />
                          </MenuTrigger>
                          <MenuPopup className="maka-plan-card-menu" align="end">
                            <MenuItem
                              onClick={() => editReminder(reminder)}
                              disabled={reminderActionPending || reminder.status === 'completed'}
                            >
                              <Pencil size={14} aria-hidden="true" />
                              编辑
                            </MenuItem>
                            <MenuItem
                              onClick={() => duplicateReminder(reminder)}
                              disabled={reminderActionPending}
                            >
                              <Copy size={14} aria-hidden="true" />
                              复制
                            </MenuItem>
                            <MenuItem
                              onClick={() => void runPlanReminderAction(`${reminder.id}:trigger`, () => props.onTriggerNow?.(reminder.id))}
                              disabled={reminderActionPending || !reminder.enabled}
                            >
                              <RefreshCcw size={14} aria-hidden="true" />
                              {pendingActionKeys.has(`${reminder.id}:trigger`) ? '触发中…' : '立即触发'}
                            </MenuItem>
                            <MenuItem
                              onClick={() => void runPlanReminderAction(`${reminder.id}:snooze`, () => props.onSnooze?.(reminder.id))}
                              disabled={reminderActionPending || !reminder.enabled || reminder.status !== 'scheduled' || typeof reminder.nextRunAt !== 'number'}
                            >
                              <Clock size={14} aria-hidden="true" />
                              {pendingActionKeys.has(`${reminder.id}:snooze`) ? '延后中…' : '延后 10 分钟'}
                            </MenuItem>
                            <MenuItem
                              onClick={() => void runPlanReminderAction(`${reminder.id}:clear-runs`, () => props.onClearRunHistory?.(reminder.id))}
                              disabled={reminderActionPending || reminder.runs.length === 0 || reminder.status === 'completed'}
                            >
                              <ArchiveRestore size={14} aria-hidden="true" />
                              {pendingActionKeys.has(`${reminder.id}:clear-runs`) ? '清空中…' : '清空记录'}
                            </MenuItem>
                            <MenuItem
                              variant="destructive"
                              onClick={() => void runPlanReminderAction(`${reminder.id}:delete`, () => props.onDelete?.(reminder.id))}
                              disabled={reminderActionPending}
                            >
                              <Trash2 size={14} aria-hidden="true" />
                              {pendingActionKeys.has(`${reminder.id}:delete`) ? '删除中…' : '删除'}
                            </MenuItem>
                          </MenuPopup>
                        </Menu>
                      </div>
                      <div className="maka-plan-card-main">
                        <div className="maka-plan-card-title-row">
                          <h3 className="maka-plan-card-title">{reminder.title}</h3>
                          <Badge variant={reminder.status === 'scheduled' ? 'success' : reminder.status === 'paused' ? 'warning' : 'secondary'}>
                            {planReminderStatusLabel(reminder.status)}
                          </Badge>
                        </div>
                        <p className="maka-plan-card-note">
                          {reminder.note || `触发后投递到：${formatPlanReminderDeliveryTarget(reminder.delivery)}`}
                        </p>
                        {reminder.lastRun && (
                          <div className="maka-plan-card-run">
                            {runStatusLabel(reminder.lastRun.status)}：{reminder.lastRun.message}
                          </div>
                        )}
                      </div>
                      <div className="maka-plan-card-footer">
                        <span className="maka-plan-card-chip">
                          <Clock size={13} aria-hidden="true" />
                          {reminder.nextRunAt ? (
                            <>
                              下次触发：{formatReminderTime(reminder.nextRunAt)}
                              <span className="maka-plan-card-countdown">{formatReminderCountdown(reminder.nextRunAt)}</span>
                            </>
                          ) : reminder.lastRun ? (
                            `最近 ${formatReminderTime(reminder.lastRun.at)}`
                          ) : (
                            '未安排'
                          )}
                        </span>
                        <span className="maka-plan-card-chip">
                          <Repeat size={13} aria-hidden="true" />
                          {formatPlanRecurrence(reminder)}
                        </span>
                      </div>
                    </article>
                  );
                })}
              </div>
            )}
          </TabsPanel>

          <TabsPanel className="maka-plan-tab-panel" value="runs">
            {visibleRunEntries.length === 0 ? (
              <EmptyState
                Icon={Clock}
                title="暂无执行记录"
                body="提醒触发、手动执行或投递失败后，会在这里保留最近记录。"
                extraClassName="maka-plan-empty maka-plan-runs-empty"
              />
            ) : (
              <div className="maka-plan-run-list" aria-label="计划提醒执行记录">
                {visibleRunEntries.map(({ reminder, run }) => (
                  <article key={`${reminder.id}:${run.id}`} className="maka-plan-run-row">
                    <Chip
                      size="sm"
                      variant={planRunStatusChipTone(run.status)}
                      className="maka-plan-run-status"
                      data-status={run.status}
                    >
                      {runStatusLabel(run.status)}
                    </Chip>
                    <div className="maka-plan-run-main">
                      <strong>{reminder.title}</strong>
                      <span>{run.message}</span>
                    </div>
                    <time>{formatReminderTime(run.at)}</time>
                  </article>
                ))}
              </div>
            )}
          </TabsPanel>
        </TabsRoot>
      </div>

      <PlanReminderFormDialog
        key={formNonce}
        open={formDialogOpen}
        seed={formSeed}
        reminders={props.reminders}
        onOpenChange={setFormDialogOpen}
        onCreate={props.onCreate}
        onUpdate={props.onUpdate}
      />
    </div>
  );
}
