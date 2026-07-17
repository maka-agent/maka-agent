/**
 * Plan-reminder create/edit form dialog (issue #1044).
 *
 * Owns ALL form state + the submit pipeline that used to live inline in
 * `plan-reminder-panel.tsx`: the nine field states, editingId, the
 * submitPending single-flight owner, validation, and the close guard. The
 * panel keeps only list/runs/query state and opens this dialog with a
 * `PlanReminderFormSeed` (remounting per open via `key`, so fields always
 * initialize from the seed — same outcome as the old open-handler setters).
 *
 * Async-owner invariants (pinned by plan-reminder-panel-contract):
 *   - submit rejects re-entry synchronously via submitPendingRef before
 *     React commits the disabled state;
 *   - the dialog refuses to close while a submit is in flight;
 *   - the pending owner is released on unmount without writing React state.
 */

import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useMountedRef } from './use-mounted-ref.js';
import { Check, Plus, X } from './icons.js';
import { BotBrandLogo } from './bot-brand-logo.js';
import type {
  BotProvider,
  PlanReminder,
  PlanReminderDeliveryTarget,
  PlanReminderRecurrence,
} from '@maka/core';
import { BOT_DELIVERY_PROVIDERS, botDisplayLabel } from '@maka/core';
import {
  type PlanReminderFormSeed,
  formatPlanDeliveryProviderList,
  planReminderFormValidationMessage,
  planReminderPresetRunAt,
  toPlanReminderDateTimeInputValue,
} from './plan-reminder-helpers.js';
import { PlanReminderSelect } from './plan-reminder-select.js';
import {
  Button as UiButton,
  DialogClose,
  DialogContent,
  DialogRoot,
} from './ui.js';
import { Input } from './primitives/input.js';
import { Textarea as UiTextarea } from './primitives/textarea.js';
import type {
  PlanReminderDraftInput,
  PlanReminderUpdatePatch,
} from './module-panel-types.js';

export function PlanReminderFormDialog(props: {
  open: boolean;
  seed: PlanReminderFormSeed;
  /** Current reminders, so an open edit form resets if its reminder vanishes. */
  reminders: PlanReminder[];
  onOpenChange(open: boolean): void;
  onCreate?(input: PlanReminderDraftInput): boolean | Promise<boolean> | void | Promise<void>;
  onUpdate?(id: string, patch: PlanReminderUpdatePatch): boolean | Promise<boolean> | void | Promise<void>;
}) {
  const [title, setTitle] = useState(props.seed.title);
  const [note, setNote] = useState(props.seed.note);
  const [runAtLocal, setRunAtLocal] = useState(props.seed.runAtLocal);
  const [recurrence, setRecurrence] = useState<PlanReminderRecurrence>(props.seed.recurrence);
  const [cronExpression, setCronExpression] = useState(props.seed.cronExpression);
  const [deliveryChannel, setDeliveryChannel] = useState<PlanReminderDeliveryTarget['channel']>(props.seed.deliveryChannel);
  const [deliveryPlatform, setDeliveryPlatform] = useState<BotProvider>(props.seed.deliveryPlatform);
  const [deliveryChatId, setDeliveryChatId] = useState(props.seed.deliveryChatId);
  const [editingId, setEditingId] = useState<string | null>(props.seed.editingId);
  const [submitPending, setSubmitPending] = useState(false);
  const planReminderMountedRef = useMountedRef();
  const submitPendingRef = useRef(false);
  const parsedRunAt = Date.parse(runAtLocal);
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

  useEffect(() => {
    return () => {
      submitPendingRef.current = false;
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

  function closeReminderDialog() {
    if (submitPendingRef.current) return;
    props.onOpenChange(false);
    resetForm();
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
        props.onOpenChange(false);
      }
    } finally {
      submitPendingRef.current = false;
      if (planReminderMountedRef.current) setSubmitPending(false);
    }
  }

  return (
    <DialogRoot
      open={props.open}
      onOpenChange={(open) => {
        if (open) {
          props.onOpenChange(true);
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
                size="sm"
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
              variant="secondary"
              type="button"
              onClick={closeReminderDialog}
              disabled={formInteractionDisabled}
            >
              取消
            </UiButton>
            <UiButton type="submit" disabled={submitDisabled}>
              {isEditing ? <Check size={14} aria-hidden="true" /> : <Plus size={14} aria-hidden="true" />}
              <span>{submitPending ? (isEditing ? '保存中…' : '创建中…') : (isEditing ? '保存提醒' : '创建提醒')}</span>
            </UiButton>
          </footer>
        </form>
      </DialogContent>
    </DialogRoot>
  );
}
