/**
 * Behavioural tests for the Settings → 模型 connection-status logic that
 * `ProvidersPanel` renders. The helpers are pure (no React, no DOM) so we
 * exercise them directly from the desktop test runner, the same pattern as
 * `connection-status.test.ts`.
 *
 * These cover the P2 fix: a lapsed OAuth subscription is persisted as
 * `enabled:false + lastTestStatus:'needs_reauth'` (main.ts subscription
 * sync keeps the connection but flags it). Before the fix the status copy
 * short-circuited on `!enabled` to "已禁用", hiding the "please log back in"
 * signal. `chipStatusTone` colors the same signal and must branch in
 * lockstep with `chipStatusText`.
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import type { LlmConnection } from '@maka/core';
import {
  chipStatusText,
  chipStatusTone,
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

describe('chipStatusTone', () => {
  it('tones a lapsed OAuth login as info even when enabled:false (needs_reauth wins)', () => {
    // Mirrors the chipStatusText priority: needs_reauth must not fall through
    // to the disabled/neutral branch, so the dot reads as actionable info.
    assert.equal(chipStatusTone(conn({ enabled: false, lastTestStatus: 'needs_reauth' })), 'info');
    assert.equal(chipStatusTone(conn({ enabled: true, lastTestStatus: 'needs_reauth' })), 'info');
  });

  it('tones a bare disabled connection as neutral', () => {
    assert.equal(chipStatusTone(conn({ enabled: false, lastTestStatus: undefined })), 'neutral');
  });

  it('tones verified as success, last failure as destructive, untested as neutral', () => {
    assert.equal(chipStatusTone(conn({ lastTestStatus: 'verified' })), 'success');
    assert.equal(chipStatusTone(conn({ lastTestStatus: 'error' })), 'destructive');
    assert.equal(chipStatusTone(conn({ lastTestStatus: undefined })), 'neutral');
  });

  it('tones a disabled+error connection neutral, mirroring the !enabled "暂不可用" copy', () => {
    // !enabled short-circuits before the error branch, exactly like
    // chipStatusText — the tone must never disagree with the visible copy.
    assert.equal(chipStatusTone(conn({ enabled: false, lastTestStatus: 'error' })), 'neutral');
    assert.equal(chipStatusText(conn({ enabled: false, lastTestStatus: 'error' })), '暂不可用');
  });
});
