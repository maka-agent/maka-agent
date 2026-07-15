/**
 * #1032 — session health notice derivation (hard-block only).
 *
 * The notice sits above the composer and must only appear when the user
 * has something to fix before send. Soft "will rebind on send" heads-ups
 * and routine lifecycle / event-stream recovery are intentionally silent.
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import {
  deriveSessionHealthNotice,
  type SessionHealthNoticeInput,
} from '../../renderer/session-health-notice.js';

function input(partial: Partial<SessionHealthNoticeInput>): SessionHealthNoticeInput {
  return {
    backend: 'ai-sdk',
    hasActiveConnection: true,
    defaultConnectionReady: true,
    lastTestStatus: undefined,
    ...partial,
  };
}

describe('deriveSessionHealthNotice', () => {
  it('returns undefined when no active session', () => {
    assert.equal(deriveSessionHealthNotice(input({ backend: undefined })), undefined);
  });

  it('returns undefined when session is healthy + connection present + no test issue', () => {
    assert.equal(deriveSessionHealthNotice(input({})), undefined);
  });

  describe('legacy / stale fake backend', () => {
    it('hides soft rebind heads-up when a default connection is ready', () => {
      assert.equal(
        deriveSessionHealthNotice(input({ backend: 'fake', defaultConnectionReady: true })),
        undefined,
      );
    });

    it('destructive when no default ready — send will still fail', () => {
      const result = deriveSessionHealthNotice(
        input({ backend: 'fake', defaultConnectionReady: false }),
      );
      assert.equal(result?.tone, 'destructive');
      assert.equal(result?.label, '会话已过期 · 请先配置真实模型');
      assert.equal(result?.onClickTarget, 'models');
      assert.match(result?.tooltip ?? '', /设置.*模型/);
      assert.doesNotMatch(result?.label ?? '', /演示版|fake|FakeBackend/i);
      assert.doesNotMatch(result?.tooltip ?? '', /演示版|fake|FakeBackend/i);
    });

    it('takes priority over missing-connection / credential signals', () => {
      const result = deriveSessionHealthNotice(
        input({
          backend: 'fake',
          hasActiveConnection: false,
          lastTestStatus: 'error',
          defaultConnectionReady: false,
        }),
      );
      assert.equal(result?.label, '会话已过期 · 请先配置真实模型');
    });
  });

  describe('missing connection (deleted or legacy slug)', () => {
    it('hides soft rebind heads-up when a default connection is ready', () => {
      assert.equal(
        deriveSessionHealthNotice(
          input({
            backend: 'ai-sdk',
            hasActiveConnection: false,
            defaultConnectionReady: true,
          }),
        ),
        undefined,
      );
    });

    it('destructive when no default ready', () => {
      const result = deriveSessionHealthNotice(
        input({
          backend: 'ai-sdk',
          hasActiveConnection: false,
          defaultConnectionReady: false,
        }),
      );
      assert.equal(result?.tone, 'destructive');
      assert.equal(result?.label, '连接已删除');
      assert.equal(result?.onClickTarget, 'models');
      assert.match(result?.tooltip ?? '', /设置.*模型/);
      assert.match(result?.tooltip ?? '', /当前没有默认连接/);
    });

    it('handles legacy backend (e.g. "claude") missing connection — same notice', () => {
      const result = deriveSessionHealthNotice(
        input({
          backend: 'claude',
          hasActiveConnection: false,
          defaultConnectionReady: false,
        }),
      );
      assert.equal(result?.label, '连接已删除');
    });
  });

  describe('credential lifecycle on a present connection', () => {
    it('needs_reauth → warning · open account', () => {
      const result = deriveSessionHealthNotice(input({ lastTestStatus: 'needs_reauth' }));
      assert.equal(result?.tone, 'warning');
      assert.equal(result?.label, '需要重新登录');
      assert.equal(result?.onClickTarget, 'account');
      assert.match(result?.tooltip ?? '', /401|403|鉴权/);
    });

    it('error → destructive · open account', () => {
      const result = deriveSessionHealthNotice(input({ lastTestStatus: 'error' }));
      assert.equal(result?.tone, 'destructive');
      assert.equal(result?.label, '上次连接失败');
      assert.equal(result?.onClickTarget, 'account');
      assert.match(result?.tooltip ?? '', /5xx|网络|超时|Base URL|代理/);
    });

    it('verified → no notice', () => {
      assert.equal(deriveSessionHealthNotice(input({ lastTestStatus: 'verified' })), undefined);
    });

    it('defaultConnectionReady does not silence credential lifecycle notices', () => {
      const reauth = deriveSessionHealthNotice(
        input({ lastTestStatus: 'needs_reauth', defaultConnectionReady: true }),
      );
      assert.equal(reauth?.label, '需要重新登录');

      const errored = deriveSessionHealthNotice(
        input({ lastTestStatus: 'error', defaultConnectionReady: true }),
      );
      assert.equal(errored?.label, '上次连接失败');
    });
  });

  describe('priority order', () => {
    it('missing connection beats credential status when hard-blocked', () => {
      const result = deriveSessionHealthNotice(
        input({
          backend: 'ai-sdk',
          hasActiveConnection: false,
          lastTestStatus: 'error',
          defaultConnectionReady: false,
        }),
      );
      assert.equal(result?.label, '连接已删除');
    });
  });

  describe('defaultConnectionReady is a display filter, not a send-readiness fact', () => {
    // Still a renderer-side proxy (exists + enabled). When true, soft
    // rebind cases stay silent; send-time requireReadyConnection remains
    // authoritative for missing_api_key / missing_model / etc.
    it('true only suppresses soft rebind cases, never credential faults', () => {
      assert.equal(
        deriveSessionHealthNotice(
          input({
            backend: 'fake',
            hasActiveConnection: false,
            defaultConnectionReady: true,
          }),
        ),
        undefined,
      );
      assert.equal(
        deriveSessionHealthNotice(input({ lastTestStatus: 'needs_reauth', defaultConnectionReady: true }))
          ?.label,
        '需要重新登录',
      );
    });
  });
});
