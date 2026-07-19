import assert from 'node:assert/strict';
import test from 'node:test';
import type { UiLocale } from '@maka/core';
import { getConversationCopy } from '../conversation-copy.js';
import { getToolActivityCopy } from '../tool-activity/copy.js';

test('conversation catalogs are complete and independently selectable', () => {
  const zh = getConversationCopy('zh');
  const en = getConversationCopy('en');

  assert.equal(zh.composer.sendLabel, '发送');
  assert.equal(en.composer.sendLabel, 'Send');
  assert.equal(zh.sessions.status.running, '进行中');
  assert.equal(en.sessions.status.running, 'Running');
  assert.notEqual(en.composer.placeholder, zh.composer.placeholder);
});

test('tool catalogs are complete and independently selectable', () => {
  const zh = getToolActivityCopy('zh');
  const en = getToolActivityCopy('en');

  assert.equal(zh.status.running, '运行中');
  assert.equal(en.status.running, 'Running');
  assert.equal(zh.error.title, '工具调用失败');
  assert.equal(en.error.title, 'Tool call failed');
});

test('selectors accept only resolved UI locales', () => {
  const select = (locale: UiLocale) => getConversationCopy(locale).composer.sendLabel;
  assert.equal(select('zh'), '发送');
  assert.equal(select('en'), 'Send');
});
