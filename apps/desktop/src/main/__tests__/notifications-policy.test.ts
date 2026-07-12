import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  isRunNotificationKind,
  resolveNotificationContent,
  runNotificationCopy,
  shouldRaiseRunNotification,
} from '../notifications-policy.js';

describe('shouldRaiseRunNotification gate', () => {
  const base = { enabled: true, supported: true, windowFocused: false, incognito: false, e2e: false };

  it('raises a notification only when enabled, supported, unfocused, and not incognito', () => {
    assert.equal(shouldRaiseRunNotification(base), true);
  });

  it('suppresses when the product toggle is off', () => {
    assert.equal(shouldRaiseRunNotification({ ...base, enabled: false }), false);
  });

  it('suppresses when the platform does not support notifications', () => {
    assert.equal(shouldRaiseRunNotification({ ...base, supported: false }), false);
  });

  it('suppresses while the window is focused (user is already looking)', () => {
    assert.equal(shouldRaiseRunNotification({ ...base, windowFocused: true }), false);
  });

  it('suppresses in incognito mode (no session name/preview outside the app)', () => {
    assert.equal(shouldRaiseRunNotification({ ...base, incognito: true }), false);
  });

  it('suppresses native notifications during E2E runs', () => {
    assert.equal(shouldRaiseRunNotification({ ...base, e2e: true }), false);
  });
});

describe('isRunNotificationKind guard', () => {
  it('accepts the two terminal kinds', () => {
    assert.equal(isRunNotificationKind('completed'), true);
    assert.equal(isRunNotificationKind('errored'), true);
  });

  it('rejects anything else, including near-misses and non-strings', () => {
    for (const bad of ['complete', 'error', 'aborted', '', undefined, null, 1, {}]) {
      assert.equal(isRunNotificationKind(bad), false);
    }
  });
});

describe('runNotificationCopy', () => {
  it('gives distinct, non-empty copy per kind', () => {
    const completed = runNotificationCopy('completed');
    const errored = runNotificationCopy('errored');
    assert.ok(completed.title.length > 0 && completed.body.length > 0);
    assert.ok(errored.title.length > 0 && errored.body.length > 0);
    assert.notEqual(completed.title, errored.title);
  });
});

describe('resolveNotificationContent', () => {
  it('prefers the renderer session name + reply preview', () => {
    const copy = resolveNotificationContent({
      kind: 'completed',
      title: '重构登录流程',
      body: '好的，我先梳理当前的认证链路，再分三步改造：',
    });
    assert.equal(copy.title, '重构登录流程');
    assert.equal(copy.body, '好的，我先梳理当前的认证链路，再分三步改造：');
  });

  it('collapses whitespace/newlines into a single line', () => {
    const copy = resolveNotificationContent({
      kind: 'completed',
      title: '  会话  A  ',
      body: 'line one\n\nline two\tindented',
    });
    assert.equal(copy.title, '会话 A');
    assert.equal(copy.body, 'line one line two indented');
  });

  it('falls back per-field to generic copy when blank or non-string', () => {
    const fallback = runNotificationCopy('completed');
    for (const bad of ['', '   ', undefined, null, 42, {}]) {
      const copy = resolveNotificationContent({ kind: 'completed', title: bad, body: bad });
      assert.equal(copy.title, fallback.title);
      assert.equal(copy.body, fallback.body);
    }
  });

  it('caps an overlong body with an ellipsis', () => {
    const copy = resolveNotificationContent({ kind: 'completed', title: 'S', body: 'x'.repeat(500) });
    assert.ok(copy.body.length <= 160);
    assert.ok(copy.body.endsWith('…'));
  });

  it('uses the errored fallback body when the error message is blank', () => {
    const fallback = runNotificationCopy('errored');
    const copy = resolveNotificationContent({ kind: 'errored', title: '出错的会话', body: '' });
    assert.equal(copy.title, '出错的会话');
    assert.equal(copy.body, fallback.body);
  });
});
