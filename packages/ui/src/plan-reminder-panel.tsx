import { useEffect, useRef, useState, type FormEvent } from 'react';
import {
  ArchiveRestore,
  Check,
  Clock,
  Copy,
  Info,
  MoreHorizontal,
  Pencil,
  Plus,
  RefreshCcw,
  Repeat,
  Trash2,
  X,
} from './icons.js';
import { BotBrandLogo } from './bot-brand-logo.js';
import { SettingsSelect, type SettingsSelectOption } from './primitives/settings-select.js';
import type {
  BotProvider,
  CapabilityAuditReport,
  PlanReminder,
  PlanReminderDeliveryTarget,
  PlanReminderRecurrence,
  PlanReminderStatus,
} from '@maka/core';
import {
  BOT_DELIVERY_PROVIDERS,
  botDisplayLabel,
  deriveCapabilityAuditReport,
  formatPlanReminderDeliveryTarget,
} from '@maka/core';
import {
  PLAN_REMINDER_EXAMPLE_TEMPLATES,
  type PlanReminderExampleTemplate,
  comparePlanReminderBySort,
  duplicatePlanReminderTitle,
  formatPlanDeliveryProviderList,
  formatPlanRecurrence,
  formatReminderCountdown,
  formatReminderTime,
  normalizePlanReminderSearchQuery,
  planReminderEditableRunAt,
  planReminderFormValidationMessage,
  planReminderMatchesSearch,
  planReminderPresetRunAt,
  planReminderRecurrenceValue,
  planReminderRunRangeStart,
  planReminderStatusLabel,
  planReminderTemplateNextRunAt,
  runStatusLabel,
  toPlanReminderDateTimeInputValue,
} from './plan-reminder-helpers.js';
import {
  Button as UiButton,
  DialogClose,
  DialogContent,
  DialogRoot,
  Switch,
  TabsList,
  TabsPanel,
  TabsRoot,
  TabsTrigger,
} from './ui.js';
import { Badge } from './primitives/badge.js';
import { Input } from './primitives/input.js';
import { Textarea as UiTextarea } from './primitives/textarea.js';
import { Alert, AlertTitle } from './primitives/alert.js';
import { Menu, MenuItem, MenuPopup, MenuTrigger } from './primitives/menu.js';
import { EmptyState } from './empty-state.js';
import { CapabilityAuditStrip } from './capability-audit-strip.js';
import type {
  PlanReminderDraftInput,
  PlanReminderUpdatePatch,
} from './module-panel-types.js';

// PR round-AB-shared-select (yuejing 2026-06-25, kenji styles inventory
// task #128): `PlanReminderSelect` is now a thin specialization of the
// shared `SettingsSelect` primitive — `width="full"` to preserve the
// existing edge-to-edge sizing inside `.maka-plan-delivery-grid`.
// Plan Reminder and Settings selects share one component so option
// shape, trigger/popup chrome, and the selected-trigger icon contract
// can't drift apart again.
function PlanReminderSelect<T extends string>(props: {
  value: T;
  options: ReadonlyArray<SettingsSelectOption<T>>;
  onChange(value: T): void;
  ariaLabel: string;
  disabled?: boolean;
}) {
  return <SettingsSelect width="full" {...props} />;
}

export function PlanReminderPanel(props: {
  reminders: PlanReminder[];
  auditReport?: CapabilityAuditReport;
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
  const [title, setTitle] = useState('');
  const [note, setNote] = useState('');
  const [runAtLocal, setRunAtLocal] = useState(() => toPlanReminderDateTimeInputValue(Date.now() + 60 * 60 * 1000));
  const [recurrence, setRecurrence] = useState<PlanReminderRecurrence>('none');
  const [cronExpression, setCronExpression] = useState('0 9 * * 1-5');
  const [deliveryChannel, setDeliveryChannel] = useState<PlanReminderDeliveryTarget['channel']>('local');
  const [deliveryPlatform, setDeliveryPlatform] = useState<BotProvider>('telegram');
  const [deliveryChatId, setDeliveryChatId] = useState('');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [submitPending, setSubmitPending] = useState(false);
  const [pendingActionKeys, setPendingActionKeys] = useState<ReadonlySet<string>>(() => new Set());
  const planReminderMountedRef = useRef(true);
  const submitPendingRef = useRef(false);
  const refreshPendingRef = useRef(false);
  const pendingActionKeysRef = useRef<Set<string>>(new Set());
  const [formDialogOpen, setFormDialogOpen] = useState(false);
  const [planView, setPlanView] = useState<PlanReminderView>('tasks');
  const [runRange, setRunRange] = useState<PlanReminderRunRange>('week');
  const [listFilter, setListFilter] = useState<PlanReminderListFilter>('active');
  const [listSort, setListSort] = useState<PlanReminderSort>('created-desc');
  const [listQuery, setListQuery] = useState('');
  const [refreshPending, setRefreshPending] = useState(false);
  const parsedRunAt = Date.parse(runAtLocal);
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
  const delivery: PlanReminderDeliveryTarget = deliveryChannel === 'bot'
    ? { channel: 'bot', platform: deliveryPlatform, chatId: deliveryChatId.trim() }
    : { channel: 'local' };
  const validationMessage = planReminderFormValidationMessage({
    title,
    parsedRunAt,
    recurrence,
    cronExpression,
    delivery,
    now: Date.now(),
  });
  const canCreate = validationMessage === null;
  const submitDisabled = !canCreate || submitPending;
  const formInteractionDisabled = submitPending;
  const isEditing = editingId !== null;
  const auditReport = props.auditReport ?? deriveCapabilityAuditReport({ planReminders: props.reminders });

  useEffect(() => {
    planReminderMountedRef.current = true;
    return () => {
      planReminderMountedRef.current = false;
      submitPendingRef.current = false;
      refreshPendingRef.current = false;
      pendingActionKeysRef.current = new Set();
    };
  }, []);

  useEffect(() => {
    if (editingId && !props.reminders.some((reminder) => reminder.id === editingId)) resetForm();
  }, [editingId, props.reminders]);

  function resetForm() {
    setTitle('');
    setNote('');
    setRecurrence('none');
    setCronExpression('0 9 * * 1-5');
    setDeliveryChannel('local');
    setDeliveryPlatform('telegram');
    setDeliveryChatId('');
    setRunAtLocal(toPlanReminderDateTimeInputValue(Date.now() + 60 * 60 * 1000));
    setEditingId(null);
  }

  function openCreateReminderDialog() {
    resetForm();
    setFormDialogOpen(true);
  }

  function openPlanReminderTemplate(template: PlanReminderExampleTemplate) {
    setEditingId(null);
    setTitle(template.title);
    setNote(template.note);
    setRecurrence(template.recurrence);
    setCronExpression(template.cronExpression);
    setDeliveryChannel('local');
    setDeliveryPlatform('telegram');
    setDeliveryChatId('');
    setRunAtLocal(toPlanReminderDateTimeInputValue(planReminderTemplateNextRunAt(template)));
    setFormDialogOpen(true);
  }

  function closeReminderDialog() {
    if (submitPendingRef.current) return;
    setFormDialogOpen(false);
    resetForm();
  }

  function editReminder(reminder: PlanReminder) {
    setEditingId(reminder.id);
    setTitle(reminder.title);
    setNote(reminder.note);
    setRunAtLocal(toPlanReminderDateTimeInputValue(planReminderEditableRunAt(reminder)));
    setRecurrence(planReminderRecurrenceValue(reminder));
    setCronExpression(reminder.schedule.kind === 'cron' ? reminder.schedule.expression : '0 9 * * 1-5');
    setDeliveryChannel(reminder.delivery.channel);
    if (reminder.delivery.channel === 'bot') {
      setDeliveryPlatform(reminder.delivery.platform);
      setDeliveryChatId(reminder.delivery.chatId);
    } else {
      setDeliveryPlatform('telegram');
      setDeliveryChatId('');
    }
    setFormDialogOpen(true);
  }

  function duplicateReminder(reminder: PlanReminder) {
    setEditingId(null);
    setTitle(duplicatePlanReminderTitle(reminder.title));
    setNote(reminder.note);
    setRunAtLocal(toPlanReminderDateTimeInputValue(planReminderEditableRunAt(reminder)));
    setRecurrence(planReminderRecurrenceValue(reminder));
    setCronExpression(reminder.schedule.kind === 'cron' ? reminder.schedule.expression : '0 9 * * 1-5');
    setDeliveryChannel(reminder.delivery.channel);
    if (reminder.delivery.channel === 'bot') {
      setDeliveryPlatform(reminder.delivery.platform);
      setDeliveryChatId(reminder.delivery.chatId);
    } else {
      setDeliveryPlatform('telegram');
      setDeliveryChatId('');
    }
    setFormDialogOpen(true);
  }

  function applyRunAtPreset(preset: 'ten-minutes' | 'one-hour' | 'tomorrow-morning' | 'next-monday') {
    setRunAtLocal(toPlanReminderDateTimeInputValue(planReminderPresetRunAt(preset)));
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitDisabled || submitPendingRef.current) return;
    submitPendingRef.current = true;
    const input = {
      title: title.trim(),
      note: note.trim(),
      runAt: parsedRunAt,
      recurrence,
      ...(recurrence === 'cron' ? { cronExpression: cronExpression.trim() } : {}),
      delivery,
    };
    setSubmitPending(true);
    try {
      const result = editingId
        ? await props.onUpdate?.(editingId, input)
        : await props.onCreate?.({
          ...input,
          ...(input.note ? { note: input.note } : {}),
        });
      if (result !== false && planReminderMountedRef.current) {
        resetForm();
        setFormDialogOpen(false);
      }
    } finally {
      submitPendingRef.current = false;
      if (planReminderMountedRef.current) setSubmitPending(false);
    }
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
        <div className="maka-plan-hero">
          <div className="maka-plan-heading">
            <h2>定时任务</h2>
            <p>
              创建和管理周期性任务，让 Maka 按计划执行提醒、复盘和投递。
            </p>
          </div>
          <div className="maka-plan-top-actions" aria-label="计划提醒操作">
            <UiButton
              type="button"
              variant="quiet"
              size="icon-sm"
              className="maka-plan-refresh-button"
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
            <UiButton type="button" className="maka-plan-new-task-button" onClick={openCreateReminderDialog}>
              <Plus size={15} aria-hidden="true" />
              新建定时任务
            </UiButton>
          </div>
        </div>

        {/* PR-UI-ALIGN-1 (2026-06-21): the inline example-template strip
            (每日新闻摘要 / 周末待办整理) cluttered the top of the page and has no
            equivalent in 参考实现, whose 定时任务 page goes straight
            header → info-banner → tabs → card grid. Templates now live only in
            the empty state (quick-start), so the populated/default view matches
            the reference's clean flow. */}

        {/* Designer audit P1-5: the 保持系统唤醒·即将支持 tag was removed —
            unshipped features don't belong in first-screen chrome. Reintroduce
            the control (as a real Switch) when the wake-lock lands. */}
        <Alert variant="info" className="maka-plan-system-alert">
          <div className="maka-plan-system-alert-main">
            <Info aria-hidden="true" />
            <div>
              {/* Designer audit P2-12: one sentence, the one that matters —
                  the queue/run-history mechanics line was engineering trivia. */}
              <AlertTitle>计划提醒只在本机唤醒时运行</AlertTitle>
            </div>
          </div>
        </Alert>

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
                    <UiButton
                      key={template.id}
                      type="button"
                      variant="ghost"
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
                    </UiButton>
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
                              disabled={submitPending || reminderActionPending || reminder.status === 'completed'}
                            >
                              <Pencil size={14} aria-hidden="true" />
                              编辑
                            </MenuItem>
                            <MenuItem
                              onClick={() => duplicateReminder(reminder)}
                              disabled={submitPending || reminderActionPending}
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
                    <div className="maka-plan-run-status" data-status={run.status}>
                      {runStatusLabel(run.status)}
                    </div>
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

      <DialogRoot
        open={formDialogOpen}
        onOpenChange={(open) => {
          if (open) {
            setFormDialogOpen(true);
          } else {
            closeReminderDialog();
          }
        }}
      >
        <DialogContent
          className="maka-plan-dialog w-[min(92vw,680px)] p-0"
          aria-labelledby="maka-plan-dialog-title"
          showClose={false}
        >
          <form className="maka-plan-form" onSubmit={submit} aria-busy={submitPending ? 'true' : undefined}>
            <header className="maka-plan-form-header">
              <div>
                <p className="maka-plan-eyebrow">计划提示词</p>
                <h3 id="maka-plan-dialog-title" className="maka-plan-form-title">{isEditing ? '编辑提醒' : '新建提醒'}</h3>
              </div>
              <DialogClose
                render={<UiButton variant="quiet" size="icon-sm" />}
                type="button"
                onClick={closeReminderDialog}
                disabled={formInteractionDisabled}
                aria-label="关闭计划提醒表单"
              >
                <X size={16} aria-hidden="true" />
              </DialogClose>
            </header>
            <div className="maka-plan-form-grid">
              <label className="maka-plan-field">
                <span>标题</span>
                <Input
                  value={title}
                  onChange={(event) => setTitle(event.currentTarget.value)}
                  maxLength={120}
                  data-maka-plan-title-input="true"
                  placeholder="例如：明天复盘项目进度"
                  disabled={formInteractionDisabled}
                />
              </label>
              <label className="maka-plan-field">
                <span>时间</span>
                <Input
                  value={runAtLocal}
                  onChange={(event) => setRunAtLocal(event.currentTarget.value)}
                  type="text"
                  inputMode="numeric"
                  autoComplete="off"
                  spellCheck={false}
                  placeholder="2026-06-05 13:44"
                  aria-label="提醒时间"
                  disabled={formInteractionDisabled}
                />
              </label>
            </div>
            <div className="maka-plan-presets" aria-label="快速设置提醒时间">
              {[
                ['ten-minutes', '10 分钟后'],
                ['one-hour', '1 小时后'],
                ['tomorrow-morning', '明天 9 点'],
                ['next-monday', '下周一 9 点'],
              ].map(([preset, label]) => (
                <UiButton
                  key={preset}
                  type="button"
                  variant="secondary"
                  className="maka-plan-preset"
                  onClick={() => applyRunAtPreset(preset as 'ten-minutes' | 'one-hour' | 'tomorrow-morning' | 'next-monday')}
                  disabled={formInteractionDisabled}
                >
                  {label}
                </UiButton>
              ))}
            </div>
            <div className="maka-plan-form-grid">
              <label className="maka-plan-field">
                <span>重复</span>
                <PlanReminderSelect
                  value={recurrence}
                  onChange={(value) => setRecurrence(value)}
                  disabled={formInteractionDisabled}
                  ariaLabel="重复"
                  options={[
                    ['none', '不重复'],
                    ['daily', '每天'],
                    ['weekly', '每周'],
                    ['monthly', '每月'],
                    ['cron', 'Cron'],
                  ] satisfies ReadonlyArray<readonly [PlanReminderRecurrence, string]>}
                />
              </label>
              <label className="maka-plan-field">
                <span>投递</span>
                <PlanReminderSelect
                  value={deliveryChannel}
                  onChange={(value) => setDeliveryChannel(value)}
                  disabled={formInteractionDisabled}
                  ariaLabel="投递"
                  options={[
                    ['local', '本地提醒'],
                    ['bot', '机器人聊天'],
                  ] satisfies ReadonlyArray<readonly [PlanReminderDeliveryTarget['channel'], string]>}
                />
              </label>
            </div>
            {recurrence === 'cron' && (
              <label className="maka-plan-field">
                <span>Cron</span>
                <Input
                  value={cronExpression}
                  onChange={(event) => setCronExpression(event.currentTarget.value)}
                  maxLength={80}
                  placeholder="例如 0 9 * * 1-5"
                  disabled={formInteractionDisabled}
                />
              </label>
            )}
            {deliveryChannel === 'bot' && (
              <>
                <div className="maka-plan-delivery-grid">
                  <label className="maka-plan-field">
                    <span>平台</span>
                    <PlanReminderSelect
                      value={deliveryPlatform}
                      onChange={(value) => setDeliveryPlatform(value)}
                      disabled={formInteractionDisabled}
                      ariaLabel="平台"
                      options={BOT_DELIVERY_PROVIDERS.map((provider) => {
                        const icon = (
                          <BotBrandLogo
                            provider={provider}
                            width="100%"
                            height="100%"
                            aria-hidden="true"
                          />
                        );
                        return [provider, botDisplayLabel(provider), icon] as const;
                      })}
                    />
                  </label>
                  <label className="maka-plan-field">
                    <span>Chat ID</span>
                    <Input
                      value={deliveryChatId}
                      onChange={(event) => setDeliveryChatId(event.currentTarget.value)}
                      maxLength={160}
                      placeholder="例如 Telegram chat_id"
                      disabled={formInteractionDisabled}
                    />
                  </label>
                </div>
                <p className="maka-plan-delivery-help">
                  当前可投递到 {formatPlanDeliveryProviderList()}；其它机器人平台不会出现在投递目标里。
                </p>
              </>
            )}
            <label className="maka-plan-field maka-plan-prompt-field">
              <span>备注</span>
              <UiTextarea
                value={note}
                onChange={(event) => setNote(event.currentTarget.value)}
                maxLength={1000}
                rows={5}
                placeholder="可选：补充需要提醒的上下文"
                disabled={formInteractionDisabled}
              />
            </label>
            {validationMessage && (
              <p className="maka-plan-validation" role="status" aria-live="polite">
                {validationMessage}
              </p>
            )}
            <footer className="maka-plan-form-footer">
              <UiButton
                className="maka-button maka-plan-submit"
                variant="secondary"
                type="button"
                onClick={closeReminderDialog}
                disabled={formInteractionDisabled}
              >
                取消
              </UiButton>
              <UiButton className="maka-button maka-plan-submit" type="submit" disabled={submitDisabled}>
                {isEditing ? <Check size={14} aria-hidden="true" /> : <Plus size={14} aria-hidden="true" />}
                <span>{submitPending ? (isEditing ? '保存中…' : '创建中…') : (isEditing ? '保存提醒' : '创建提醒')}</span>
              </UiButton>
            </footer>
          </form>
        </DialogContent>
      </DialogRoot>
    </div>
  );
}
