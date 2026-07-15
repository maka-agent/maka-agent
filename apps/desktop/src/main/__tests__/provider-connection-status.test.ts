/**
 * Behavioural tests for the Settings → 模型 connection-status logic that
 * `ProvidersPanel` renders. The helper is pure (no React, no DOM) so we
 * exercise it directly from the desktop test runner, the same pattern as
 * `connection-status.test.ts`.
 *
 * These cover the P2 fix: a lapsed OAuth subscription is persisted as
 * `enabled:false + lastTestStatus:'needs_reauth'` (main.ts subscription
 * sync keeps the connection but flags it). Before the fix the status copy
 * short-circuited on `!enabled` to "已禁用", hiding the "please log back in"
 * signal. And the PR #988 review fix: label and tone come from ONE state
 * machine, so a disabled connection that last errored keeps its
 * destructive signal instead of washing out to neutral.
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import type { LlmConnection } from '@maka/core';
import { connectionChipStatus } from '../../renderer/settings/provider-connection-status.js';

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

describe('connectionChipStatus', () => {
  it('shows "需要重新登录" / info for a lapsed OAuth login, never "已禁用"', () => {
    const status = connectionChipStatus(conn({ enabled: false, lastTestStatus: 'needs_reauth' }));
    assert.deepEqual(status, { label: '需要重新登录', tone: 'info' });
    assert.notEqual(status.label, '已禁用');
  });

  it('shows "需要重新登录" / info for a still-enabled connection that needs reauth', () => {
    assert.deepEqual(
      connectionChipStatus(conn({ enabled: true, lastTestStatus: 'needs_reauth' })),
      { label: '需要重新登录', tone: 'info' },
    );
  });

  it('keeps the failure signal for a disabled connection that last errored', () => {
    // oauth-model-connections-main.ts failDiscovery() persists
    // enabled:false + lastTestStatus:'error'. The disabled state must not
    // swallow the failure: the label carries both facts and the tone stays
    // destructive (PR #988 review P1).
    assert.deepEqual(
      connectionChipStatus(conn({ enabled: false, lastTestStatus: 'error' })),
      { label: '暂不可用 · 上次连接失败', tone: 'destructive' },
    );
  });

  it('falls back to a neutral "暂不可用" for a bare disabled connection', () => {
    // Only the legacy V1→V2 migration sets enabled:false without a
    // lastTestStatus; it must not read as a user-killed "已禁用".
    assert.deepEqual(
      connectionChipStatus(conn({ enabled: false, lastTestStatus: undefined })),
      { label: '暂不可用', tone: 'neutral' },
    );
  });

  it('does not paint a stale verified green on a disabled connection', () => {
    // Intentional divergence from the retired is-verified CSS: a disabled
    // connection with an old verified result reads neutral "暂不可用" —
    // green on an unusable connection is misleading.
    assert.deepEqual(
      connectionChipStatus(conn({ enabled: false, lastTestStatus: 'verified' })),
      { label: '暂不可用', tone: 'neutral' },
    );
  });

  it('reports credential-only verification, last failure, and untested states', () => {
    assert.deepEqual(connectionChipStatus(conn({ lastTestStatus: 'verified' })), { label: '凭据已验证', tone: 'success' });
    assert.deepEqual(connectionChipStatus(conn({ lastTestStatus: 'error' })), { label: '上次连接失败', tone: 'destructive' });
    assert.deepEqual(connectionChipStatus(conn({ lastTestStatus: undefined })), { label: '等待验证', tone: 'neutral' });
  });

  it('never labels any connection "已禁用"', () => {
    const cases: Array<Partial<LlmConnection>> = [
      { enabled: false, lastTestStatus: 'needs_reauth' },
      { enabled: false, lastTestStatus: undefined },
      { enabled: false, lastTestStatus: 'error' },
      { enabled: false, lastTestStatus: 'verified' },
      { enabled: true, lastTestStatus: 'verified' },
    ];
    for (const input of cases) {
      assert.notEqual(connectionChipStatus(conn(input)).label, '已禁用');
    }
  });
});
