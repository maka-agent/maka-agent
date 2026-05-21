/**
 * Tests for SessionStatus + SessionBlockedReason presentation helpers
 * (PR109b).
 *
 * Lock down the two contracts @kenji called out:
 *  - blocked-reason copy must never expose the enum identifier
 *  - status tone matrix follows the design-system tokens
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { SESSION_BLOCKED_REASONS, SESSION_STATUSES } from '@maka/core';
import {
  describeBlockedReason,
  presentSessionStatus,
  sessionStatusAriaLabel,
} from '../../renderer/session-status-presentation.js';

describe('presentSessionStatus', () => {
  it('covers every SessionStatus enum value', () => {
    for (const status of SESSION_STATUSES) {
      const presentation = presentSessionStatus(status);
      assert.ok(presentation.label, `${status} should have a label`);
      assert.ok(presentation.tone, `${status} should have a tone`);
    }
  });

  it('labels are Chinese (no English fallback)', () => {
    for (const status of SESSION_STATUSES) {
      const presentation = presentSessionStatus(status);
      assert.match(presentation.label, /[一-鿿]/, `${status} label should contain Chinese chars`);
      assert.doesNotMatch(presentation.label, /[a-zA-Z]/, `${status} label should have no Latin letters`);
    }
  });

  it('terminal states (archived, aborted) are not interactive', () => {
    assert.equal(presentSessionStatus('archived').interactive, false);
    assert.equal(presentSessionStatus('aborted').interactive, false);
  });

  it('working states (active, running, etc.) are interactive', () => {
    for (const status of ['active', 'running', 'waiting_for_user', 'blocked', 'review', 'done'] as const) {
      assert.equal(presentSessionStatus(status).interactive, true, `${status} should be interactive`);
    }
  });

  it('tones map to a small closed vocabulary', () => {
    const allowedTones = new Set(['accent', 'warning', 'destructive', 'info', 'success', 'muted', 'neutral']);
    for (const status of SESSION_STATUSES) {
      const tone = presentSessionStatus(status).tone;
      assert.ok(allowedTones.has(tone), `${status} tone ${tone} not in allowed set`);
    }
  });

  it('blocked is destructive', () => {
    assert.equal(presentSessionStatus('blocked').tone, 'destructive');
  });

  it('done is success', () => {
    assert.equal(presentSessionStatus('done').tone, 'success');
  });
});

describe('describeBlockedReason (@kenji generalized copy contract)', () => {
  it('covers every SessionBlockedReason enum value', () => {
    for (const reason of SESSION_BLOCKED_REASONS) {
      const text = describeBlockedReason(reason);
      assert.ok(text, `${reason} should have copy`);
    }
  });

  it('NEVER returns the raw enum identifier as the label', () => {
    for (const reason of SESSION_BLOCKED_REASONS) {
      const text = describeBlockedReason(reason);
      // Each enum identifier must not appear literally in the copy
      assert.doesNotMatch(text, new RegExp(reason), `copy "${text}" leaks enum identifier ${reason}`);
    }
  });

  it('all blocked copy is Chinese', () => {
    for (const reason of SESSION_BLOCKED_REASONS) {
      const text = describeBlockedReason(reason);
      assert.match(text, /[一-鿿]/, `"${text}" should contain Chinese chars`);
      assert.doesNotMatch(text, /[a-zA-Z]/, `"${text}" should have no Latin letters`);
    }
  });

  it('falls back to "unknown" copy when reason is undefined', () => {
    const fallback = describeBlockedReason(undefined);
    assert.equal(fallback, describeBlockedReason('unknown'));
  });

  it('NO_REAL_CONNECTION maps to user-facing model-connection phrasing', () => {
    const text = describeBlockedReason('NO_REAL_CONNECTION');
    assert.match(text, /模型|连接/);
  });

  it('auth maps to re-login phrasing', () => {
    assert.match(describeBlockedReason('auth'), /登录|登陆/);
  });
});

describe('sessionStatusAriaLabel', () => {
  it('non-blocked status returns just the status label', () => {
    assert.equal(sessionStatusAriaLabel('running'), '进行中');
    assert.equal(sessionStatusAriaLabel('active'), '可继续');
  });

  it('blocked status combines status label + blocked reason', () => {
    const text = sessionStatusAriaLabel('blocked', 'auth');
    assert.match(text, /已阻塞/);
    assert.match(text, /登录|登陆/);
    // Separator stays consistent
    assert.match(text, / · /);
  });

  it('blocked without reason falls back to unknown', () => {
    const text = sessionStatusAriaLabel('blocked');
    assert.match(text, /已阻塞/);
    assert.match(text, /未知阻塞/);
  });
});
