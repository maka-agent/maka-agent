/**
 * #1038 — session health notice derivation, aligned with send authority.
 *
 * The notice sits above the composer and answers exactly one question:
 * "will the next send fail for a recoverable connection/session reason,
 * and where should the user go?" The answer comes from the same core
 * projection (`projectSessionSendOutcome`) that the main-process send
 * gate delegates to, fed with renderer-side facts (connection list,
 * default slug, secret presence probe, `connectionLocked` on the
 * session summary). Soft "will rebind on send" cases stay silent.
 *
 * `lastTestStatus` is an intentional pre-send reminder (product contract
 * decided in #1038): it never claims send is blocked — E4 locks that it
 * must not gate send — so it only ever renders as a `warning` with copy
 * that says the send is not intercepted, and only when the projection
 * says the session's own connection will actually serve the next send.
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import type { LlmConnection } from '@maka/core';
import {
  deriveSessionHealthNotice,
  type SessionHealthNoticeInput,
} from '../../renderer/session-health-notice.js';

function connection(overrides: Partial<LlmConnection> = {}): LlmConnection {
  return {
    slug: 'openai-live',
    name: 'OpenAI Live',
    providerType: 'openai',
    defaultModel: 'gpt-4.1',
    enabled: true,
    models: [{ id: 'gpt-4.1', capabilities: { chat: true, functionCalling: true } }],
    modelSource: 'fetched',
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  } as LlmConnection;
}

function input(partial: Partial<SessionHealthNoticeInput> = {}): SessionHealthNoticeInput {
  return {
    locale: 'zh',
    session: {
      backend: 'ai-sdk',
      llmConnectionSlug: 'openai-live',
      model: 'gpt-4.1',
      connectionLocked: false,
    },
    connections: [connection()],
    defaultSlug: 'openai-live',
    hasSecret: () => true,
    lastTestStatus: undefined,
    ...partial,
  };
}

function fakeSession(connectionLocked: boolean): SessionHealthNoticeInput['session'] {
  return { backend: 'fake', llmConnectionSlug: 'fake', model: 'fake-model', connectionLocked };
}

describe('deriveSessionHealthNotice', () => {
  it('returns undefined when no active session', () => {
    assert.equal(deriveSessionHealthNotice(input({ session: undefined })), undefined);
  });

  it('returns undefined when the next send will succeed', () => {
    assert.equal(deriveSessionHealthNotice(input({})), undefined);
  });

  describe('locked sessions — the send cannot silently rebind', () => {
    it('locked fake session warns even when a default connection is ready', () => {
      // #1038 case 1: previously hidden behind "default looks ready".
      const result = deriveSessionHealthNotice(input({ session: fakeSession(true) }));
      assert.equal(result?.tone, 'destructive');
      assert.equal(result?.label, '会话已过期 · 请先配置真实模型');
      assert.equal(result?.onClickTarget, 'models');
    });

    it('locked session with deleted connection warns even when a default is ready', () => {
      const result = deriveSessionHealthNotice(
        input({
          session: {
            backend: 'ai-sdk',
            llmConnectionSlug: 'deleted-slug',
            model: 'gpt-4.1',
            connectionLocked: true,
          },
        }),
      );
      assert.equal(result?.tone, 'destructive');
      assert.equal(result?.label, '连接已删除');
      assert.equal(result?.onClickTarget, 'models');
    });

    it('handles legacy backend (e.g. "claude") with missing connection — same notice', () => {
      const result = deriveSessionHealthNotice(
        input({
          session: {
            backend: 'claude',
            llmConnectionSlug: 'deleted-slug',
            model: 'gpt-4.1',
            connectionLocked: true,
          },
        }),
      );
      assert.equal(result?.label, '连接已删除');
    });
  });

  describe('unlocked sessions — silent when the send path can rebind', () => {
    it('fake session stays silent when a default connection is ready', () => {
      assert.equal(deriveSessionHealthNotice(input({ session: fakeSession(false) })), undefined);
    });

    it('missing connection stays silent when ANOTHER (non-default) connection is ready', () => {
      // #1038 case 3: the send walk tries every persisted connection.
      assert.equal(
        deriveSessionHealthNotice(
          input({
            session: {
              backend: 'ai-sdk',
              llmConnectionSlug: 'deleted-slug',
              model: 'gpt-4.1',
              connectionLocked: false,
            },
            defaultSlug: 'also-broken',
            connections: [connection({ slug: 'second-ready' })],
          }),
        ),
        undefined,
      );
    });

    it('fake session warns when the default is enabled but has no secret', () => {
      // #1038 case 2: "exists && enabled" is not send readiness.
      const result = deriveSessionHealthNotice(
        input({ session: fakeSession(false), hasSecret: () => false }),
      );
      assert.equal(result?.tone, 'destructive');
      assert.equal(result?.label, '会话已过期 · 请先配置真实模型');
      assert.doesNotMatch(result?.label ?? '', /演示版|fake|FakeBackend/i);
      assert.doesNotMatch(result?.tooltip ?? '', /演示版|fake|FakeBackend/i);
    });

    it('missing connection with no ready rebind target → destructive models notice', () => {
      const result = deriveSessionHealthNotice(
        input({
          session: {
            backend: 'ai-sdk',
            llmConnectionSlug: 'deleted-slug',
            model: 'gpt-4.1',
            connectionLocked: false,
          },
          hasSecret: () => false,
        }),
      );
      assert.equal(result?.tone, 'destructive');
      assert.equal(result?.label, '连接已删除');
      assert.equal(result?.onClickTarget, 'models');
      assert.match(result?.tooltip ?? '', /设置.*模型/);
    });

    it('non-rebindable failure (missing key) blocks even when another connection is ready', () => {
      // Mirrors the send path: missing_api_key never silently rebinds,
      // so the notice must say the send will fail.
      const result = deriveSessionHealthNotice(
        input({
          hasSecret: (slug) => slug !== 'openai-live',
          connections: [connection(), connection({ slug: 'second-ready' })],
        }),
      );
      assert.equal(result?.tone, 'destructive');
      assert.equal(result?.label, '连接缺少密钥');
      assert.equal(result?.onClickTarget, 'models');
      assert.match(result?.tooltip ?? '', /OpenAI Live/);
    });
  });

  describe('lastTestStatus — honest pre-send reminder (never claims blocked)', () => {
    it('needs_reauth → warning · open account · does not claim send is blocked', () => {
      const result = deriveSessionHealthNotice(input({ lastTestStatus: 'needs_reauth' }));
      assert.equal(result?.tone, 'warning');
      assert.equal(result?.label, '上次连接测试鉴权失败');
      assert.equal(result?.onClickTarget, 'account');
      assert.match(result?.tooltip ?? '', /401|403|鉴权/);
      assert.match(result?.tooltip ?? '', /不会拦截发送/);
    });

    it('error → warning (not destructive) · open account · does not claim send is blocked', () => {
      const result = deriveSessionHealthNotice(input({ lastTestStatus: 'error' }));
      assert.equal(result?.tone, 'warning');
      assert.equal(result?.label, '上次连接测试失败');
      assert.equal(result?.onClickTarget, 'account');
      assert.match(result?.tooltip ?? '', /5xx|网络|超时|Base URL|代理/);
      assert.match(result?.tooltip ?? '', /不会拦截发送/);
    });

    it('verified → no notice', () => {
      assert.equal(deriveSessionHealthNotice(input({ lastTestStatus: 'verified' })), undefined);
    });

    it('a blocked send beats the reminder', () => {
      const result = deriveSessionHealthNotice(
        input({ session: fakeSession(true), lastTestStatus: 'error' }),
      );
      assert.equal(result?.label, '会话已过期 · 请先配置真实模型');
    });

    it('the reminder stays silent when the send will rebind away from this connection', () => {
      // The session's own connection is broken but rebindable; the next
      // send moves the session to a healthy connection, so nudging the
      // user about the abandoned connection's old test result is noise.
      const result = deriveSessionHealthNotice(
        input({
          session: {
            backend: 'ai-sdk',
            llmConnectionSlug: 'openai-live',
            model: 'gpt-4.1',
            connectionLocked: false,
          },
          connections: [
            connection({ models: [], defaultModel: undefined }),
            connection({ slug: 'second-ready' }),
          ],
          lastTestStatus: 'error',
        }),
      );
      assert.equal(result, undefined);
    });
  });
});
