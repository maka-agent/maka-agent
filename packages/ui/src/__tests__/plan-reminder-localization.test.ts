import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import {
  duplicatePlanReminderTitle,
  formatReminderCountdown,
  planReminderFormValidationMessage,
} from '../plan-reminder-helpers.js';
import { getPlanReminderCopy } from '../plan-reminder-copy.js';

describe('plan reminder localization', () => {
  it('provides coherent independent templates in both locales', () => {
    assert.equal(getPlanReminderCopy('zh').templates[0]?.title, '每日下载文件夹清理');
    assert.equal(getPlanReminderCopy('en').templates[0]?.title, 'Clean up Downloads');
    assert.equal(getPlanReminderCopy('en').page.title, 'Scheduled tasks');
  });

  it('formats validation, duplication, and countdowns with the resolved locale', () => {
    const input = {
      title: '',
      parsedRunAt: Date.now() + 60_000,
      recurrence: 'none' as const,
      cronExpression: '',
      delivery: { channel: 'local' as const },
      now: Date.now(),
    };
    assert.equal(planReminderFormValidationMessage(input, 'zh'), '填写标题后才能保存提醒。');
    assert.equal(planReminderFormValidationMessage(input, 'en'), 'Add a title before saving this reminder.');
    assert.equal(duplicatePlanReminderTitle('Review', 'en'), 'Review copy');
    assert.equal(formatReminderCountdown(120_000, 'en', 0), 'in 2 minutes');
    assert.equal(formatReminderCountdown(120_000, 'zh', 0), '2 分钟后');
  });
});
