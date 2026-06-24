/**
 * Behavioural tests for the Settings → 模型 connection-status logic that
 * `ProvidersPanel` renders. The helpers are pure (no React, no DOM) so we
 * exercise them directly from the desktop test runner, the same pattern as
 * `connection-status.test.ts`.
 *
 * These cover the P2 fix: a lapsed OAuth subscription is persisted as
 * `enabled:false + lastTestStatus:'needs_reauth'` (main.ts subscription
 * sync keeps the connection but flags it). Before the fix the status copy
 * short-circuited on `!enabled` to "已禁用" and the group rollup only
 * looked at enabled connections, so a group holding nothing but a lapsed
 * login read as idle and hid the "please log back in" signal. Both
 * assertions below are red against that previous behaviour.
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import type { LlmConnection } from '@maka/core';
import {
  chipStatusText,
  rollupForGroup,
} from '../../renderer/settings/provider-connection-status.js';

function conn(input: Partial<LlmConnection> = {}): LlmConnection {
  return {
    slug: 'c1',
    name: '连接 1',
    providerType: 'anthropic',
    defaultModel: 'claude-sonnet-4-5-20250929',
    enabled: true,
    createdAt: 0,
    updatedAt: 0,
    ...input,
  };
}

describe('chipStatusText', () => {
  it('shows "需要重新登录" for a lapsed OAuth login, never "已禁用"', () => {
    const status = chipStatusText(conn({ enabled: false, lastTestStatus: 'needs_reauth' }));
    assert.equal(status, '需要重新登录');
    assert.notEqual(status, '已禁用');
  });

  it('shows "需要重新登录" for a still-enabled connection that needs reauth', () => {
    assert.equal(chipStatusText(conn({ enabled: true, lastTestStatus: 'needs_reauth' })), '需要重新登录');
  });

  it('falls back to a neutral "暂不可用" for a bare disabled connection', () => {
    // Only the legacy V1→V2 migration sets enabled:false without a
    // lastTestStatus; it must not read as a user-killed "已禁用".
    assert.equal(chipStatusText(conn({ enabled: false, lastTestStatus: undefined })), '暂不可用');
  });

  it('reports credential-only verification, last failure, and untested states', () => {
    assert.equal(chipStatusText(conn({ lastTestStatus: 'verified' })), '凭据已验证');
    assert.equal(chipStatusText(conn({ lastTestStatus: 'error' })), '上次连接失败');
    assert.equal(chipStatusText(conn({ lastTestStatus: undefined })), '等待验证');
  });

  it('never labels any connection "已禁用"', () => {
    const cases: Array<Partial<LlmConnection>> = [
      { enabled: false, lastTestStatus: 'needs_reauth' },
      { enabled: false, lastTestStatus: undefined },
      { enabled: false, lastTestStatus: 'error' },
      { enabled: true, lastTestStatus: 'verified' },
    ];
    for (const input of cases) {
      assert.notEqual(chipStatusText(conn(input)), '已禁用');
    }
  });
});

describe('rollupForGroup', () => {
  it('raises a warn for a group holding only a lapsed login (was hidden as idle)', () => {
    assert.equal(
      rollupForGroup([conn({ enabled: false, lastTestStatus: 'needs_reauth' })]),
      'warn',
    );
  });

  it('raises an err for a disabled connection that last errored', () => {
    assert.equal(rollupForGroup([conn({ enabled: false, lastTestStatus: 'error' })]), 'err');
  });

  it('reports ok when a verified connection is present', () => {
    assert.equal(rollupForGroup([conn({ enabled: true, lastTestStatus: 'verified' })]), 'ok');
  });

  it('reports idle for an untested group', () => {
    assert.equal(rollupForGroup([conn({ lastTestStatus: undefined })]), 'idle');
  });

  it('prioritises err over warn over ok across mixed connections', () => {
    const mixed = [
      conn({ slug: 'a', lastTestStatus: 'verified' }),
      conn({ slug: 'b', enabled: false, lastTestStatus: 'needs_reauth' }),
      conn({ slug: 'c', lastTestStatus: 'error' }),
    ];
    assert.equal(rollupForGroup(mixed), 'err');
    assert.equal(
      rollupForGroup(mixed.filter((c) => c.lastTestStatus !== 'error')),
      'warn',
    );
  });
});
